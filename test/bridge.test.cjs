'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { randomBytes } = require('node:crypto');
const { UsageBridge, validateSnapshot } = require('../src/bridge.cjs');
const identity = require('../extension-identity.json');

const origin = `chrome-extension://${identity.id}`;
const valid = () => ({
  version: 1,
  source: 'official-page',
  capturedAt: Date.now(),
  windows: [{ kind: 'session', usedPercent: 32.5, resetAt: Date.now() + 3_600_000, resetApproximate: false }],
  tokens: { total: null, today: 0 },
});

async function fixture(t, callbacks = {}) {
  const received = [];
  const connections = [];
  const bridge = new UsageBridge({
    port: 0,
    onSnapshot: (value) => { received.push(value); },
    onConnection: (value) => { connections.push(value); },
    ...callbacks,
  });
  await bridge.start();
  t.after(() => bridge.close());
  const port = bridge.getStatus().port;
  function send({ method = 'POST', path = '/v1/usage', headers = {}, body = JSON.stringify(valid()), chunked = false } = {}) {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
    return new Promise((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1', port, method, path,
        agent: false,
        headers: {
          Host: `127.0.0.1:${port}`,
          Origin: origin,
          'X-Orb-Key': bridge.getPairingCode()?.split('.')[2],
          'Content-Type': 'application/json',
          ...(chunked ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': payload.length }),
          ...headers,
        },
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
        response.on('error', reject);
      });
      request.on('error', reject);
      request.end(payload);
    });
  }
  return { bridge, port, received, connections, send };
}

test('only the paired extension can write a reconstructed numeric snapshot', async (t) => {
  const { bridge, port, received, send } = await fixture(t);
  assert.match(bridge.getPairingCode(), new RegExp(`^GPTORB2\\.${port}\\.[A-Za-z0-9_-]{43}$`));
  assert.deepEqual(bridge.getStatus(), { listening: true, connected: false, lastReceivedAt: null, port });
  const result = await send();
  assert.equal(result.status, 204);
  assert.equal(result.body, '');
  assert.equal(result.headers['access-control-allow-origin'], origin);
  assert.equal(received.length, 1);
  assert.ok(Object.isFrozen(received[0]));
  assert.ok(Object.isFrozen(received[0].tokens));
  assert.ok(Object.isFrozen(received[0].windows[0]));
  assert.equal(bridge.getStatus().connected, true);
  assert.equal(received[0].windows[0].usedPercent, 32.5);
  assert.equal(received[0].tokens.total, null);
  assert.equal(received[0].tokens.today, 0);
});

test('forged, missing and null origins are forbidden without CORS reflection', async (t) => {
  const { received, send } = await fixture(t);
  for (const wrongOrigin of ['https://chatgpt.com', 'https://example.com', 'null', '', `chrome-extension://${'a'.repeat(32)}`]) {
    const result = await send({ headers: { Origin: wrongOrigin } });
    assert.equal(result.status, 403, wrongOrigin);
    assert.equal(result.headers['access-control-allow-origin'], undefined);
  }
  assert.equal(received.length, 0);
});

test('DNS rebinding hosts, localhost aliases, alternate ports and absolute URLs are rejected', async (t) => {
  const { port, received, send } = await fixture(t);
  for (const host of ['localhost', `localhost:${port}`, `evil.example:${port}`, `127.0.0.1:${port + 1}`, '127.0.0.1', '[::1]']) {
    assert.equal((await send({ headers: { Host: host } })).status, 403, host);
  }
  assert.equal((await send({ path: `http://127.0.0.1:${port}/v1/usage` })).status, 404);
  assert.equal(received.length, 0);
});

test('CORS preflight allows exactly the write contract and optional local-network request', async (t) => {
  const { received, send } = await fixture(t);
  const options = {
    method: 'OPTIONS', body: '',
    headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-orb-key' },
  };
  const accepted = await send(options);
  assert.equal(accepted.status, 204);
  assert.equal(accepted.headers['access-control-allow-origin'], origin);
  assert.equal(accepted.headers['access-control-allow-methods'], 'POST');
  assert.equal(accepted.headers['access-control-allow-headers'], 'content-type, x-orb-key');
  assert.equal(accepted.headers['access-control-allow-private-network'], undefined);
  const privateNetwork = await send({ ...options, headers: { ...options.headers, 'Access-Control-Request-Private-Network': 'true' } });
  assert.equal(privateNetwork.status, 204);
  assert.equal(privateNetwork.headers['access-control-allow-private-network'], 'true');
  for (const changed of [
    { 'Access-Control-Request-Method': 'GET' },
    { 'Access-Control-Request-Headers': '*' },
    { 'Access-Control-Request-Headers': 'content-type,x-orb-key,authorization' },
    { 'Access-Control-Request-Headers': 'x-orb-key' },
    { 'Access-Control-Request-Headers': 'content-type,x-orb-key,x-orb-key' },
    { 'Access-Control-Request-Private-Network': 'false' },
  ]) {
    assert.equal((await send({ ...options, headers: { ...options.headers, ...changed } })).status, 403);
  }
  assert.equal(received.length, 0);
});

test('missing, malformed and incorrect pairing secrets are denied without echoing them', async (t) => {
  const { bridge, received, send } = await fixture(t);
  for (const key of ['', 'x', 'a'.repeat(44), '*'.repeat(43), randomBytes(32).toString('base64url')]) {
    const result = await send({ headers: { 'X-Orb-Key': key } });
    assert.equal(result.status, 401);
    assert.equal(result.body, '{"error":"unauthorized"}');
    assert.ok(!result.body.includes(bridge.getPairingCode()));
  }
  assert.equal(received.length, 0);
});

test('rotation invalidates prior pairing and clears connection status', async (t) => {
  const { bridge, received, send } = await fixture(t);
  const previous = bridge.getPairingCode();
  assert.equal((await send()).status, 204);
  const next = bridge.rotateKey();
  assert.notEqual(previous, next);
  assert.equal(bridge.getStatus().connected, false);
  assert.equal(bridge.getStatus().lastReceivedAt, null);
  assert.equal((await send({ headers: { 'X-Orb-Key': previous.split('.')[2] } })).status, 401);
  assert.equal((await send()).status, 204);
  assert.equal(received.length, 2);
});

test('secret rotation during a partial body invalidates the in-flight write', async (t) => {
  const { bridge, port, received } = await fixture(t);
  const body = JSON.stringify(valid());
  const oldKey = bridge.getPairingCode().split('.')[2];
  const result = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/usage', headers: {
      Host: `127.0.0.1:${port}`, Origin: origin, 'Content-Type': 'application/json',
      'X-Orb-Key': oldKey, 'Content-Length': Buffer.byteLength(body),
    } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.write(body.slice(0, 10));
    setTimeout(() => { bridge.rotateKey(); req.end(body.slice(10)); }, 25);
  });
  assert.equal(result, 401);
  assert.equal(received.length, 0);
});

test('there are no data-read, control, account or arbitrary URL endpoints', async (t) => {
  const { received, send } = await fixture(t);
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
    assert.equal((await send({ method })).status, 405, method);
  }
  for (const path of ['/', '/v1/status', '/v1/pair', '/v1/usage?key=secret', '/v1/logout', '/v1/usage/']) {
    assert.equal((await send({ path })).status, 404, path);
  }
  assert.equal(received.length, 0);
});

test('content types and compression cannot bypass JSON-only parsing', async (t) => {
  const { received, send } = await fixture(t);
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'application/json; charset=latin1', 'application/json; bogus=true', '']) {
    assert.equal((await send({ headers: { 'Content-Type': type } })).status, 415, type);
  }
  assert.equal((await send({ headers: { 'Content-Encoding': 'gzip' } })).status, 415);
  assert.equal((await send({ headers: { 'Content-Type': 'application/json; charset=utf-8' } })).status, 204);
  assert.equal(received.length, 1);
});

test('both declared and chunked oversized bodies are rejected', async (t) => {
  const { received, send } = await fixture(t);
  const body = ' '.repeat(16 * 1024 + 1);
  assert.equal((await send({ body })).status, 413);
  assert.equal((await send({ body, chunked: true })).status, 413);
  assert.equal(received.length, 0);
});

test('malformed JSON, invalid UTF-8 and all account/raw-text extras are rejected', async (t) => {
  const { received, send } = await fixture(t);
  const extra = valid();
  extra.account = { token: 'not-a-real-token' };
  const malicious = JSON.stringify(valid()).replace('"version":1', '"version":1,"__proto__":{"polluted":true}');
  for (const body of ['{', 'null', '[]', '"hello"', JSON.stringify(extra), malicious, Buffer.from([0xff, 0xfe, 0x7b])]) {
    assert.equal((await send({ body })).status, 400);
  }
  assert.equal(received.length, 0);
  assert.equal({}.polluted, undefined);
});

test('numeric schema rejects coercion, unsafe counters, duplicate kinds and implausible times', () => {
  const mutations = [
    (value) => { value.version = 2; },
    (value) => { value.source = 'https://evil.example'; },
    (value) => { value.capturedAt = Date.now() - 601_000; },
    (value) => { value.capturedAt = Date.now() + 61_000; },
    (value) => { value.capturedAt = 'today'; },
    (value) => { value.windows[0].usedPercent = '32'; },
    (value) => { value.windows[0].usedPercent = -1; },
    (value) => { value.windows[0].usedPercent = 101; },
    (value) => { value.windows[0].usedPercent = Infinity; },
    (value) => { value.windows[0].usedPercent = NaN; },
    (value) => { value.windows[0].resetAt = 0; },
    (value) => { value.windows[0].resetAt = Date.now() + 61 * 86_400_000; },
    (value) => { value.windows[0].resetApproximate = 'false'; },
    (value) => { value.windows[0].text = 'private page text'; },
    (value) => { value.windows.push({ ...value.windows[0] }); },
    (value) => { value.windows[0].kind = 'unknown'; },
    (value) => { value.tokens.total = Number.MAX_SAFE_INTEGER + 1; },
    (value) => { value.tokens.today = -1; },
    (value) => { value.tokens.today = 1.5; },
    (value) => { delete value.tokens.total; },
    (value) => { value.tokens.extra = 0; },
  ];
  for (const mutation of mutations) {
    const input = valid();
    mutation(input);
    assert.equal(validateSnapshot(input), null, mutation.toString());
  }
  const empty = valid();
  empty.windows = [];
  empty.tokens = { total: null, today: null };
  assert.ok(validateSnapshot(empty));
  const manual = valid();
  manual.source = 'manual-page';
  manual.windows[0].resetAt = null;
  assert.ok(validateSnapshot(manual));
});

test('duplicate security headers are refused at the HTTP boundary', async (t) => {
  const { bridge, port, received } = await fixture(t);
  const body = JSON.stringify(valid());
  for (const extra of [`Origin: ${origin}`, `Host: 127.0.0.1:${port}`, `X-Orb-Key: ${bridge.getPairingCode().split('.')[2]}`]) {
    const response = await new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      let output = '';
      socket.on('error', reject);
      socket.on('data', (chunk) => { output += chunk; });
      socket.on('end', () => resolve(output));
      socket.on('connect', () => socket.end([
        'POST /v1/usage HTTP/1.1', `Host: 127.0.0.1:${port}`, `Origin: ${origin}`,
        `X-Orb-Key: ${bridge.getPairingCode().split('.')[2]}`, 'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`, extra, '', body,
      ].join('\r\n')));
    });
    assert.match(response, /^HTTP\/1\.1 (400|401|403) /);
  }
  assert.equal(received.length, 0);
});

test('a callback failure is contained and does not claim a connected state', async (t) => {
  const { bridge, send } = await fixture(t, { onSnapshot() { throw new Error('private implementation detail'); } });
  const result = await send();
  assert.equal(result.status, 503);
  assert.equal(result.body, '{"error":"snapshot_unavailable"}');
  assert.equal(bridge.getStatus().connected, false);
});

test('local request bursts are capped', async (t) => {
  const { send } = await fixture(t);
  let last;
  for (let index = 0; index < 121; index += 1) {
    last = await send({ headers: { 'X-Orb-Key': '' } });
  }
  assert.equal(last.status, 429);
});

test('closing removes the listener and invalidates the session secret', async (t) => {
  const { bridge, port, send } = await fixture(t);
  const old = bridge.getPairingCode();
  await bridge.close();
  assert.equal(bridge.getPairingCode(), null);
  assert.deepEqual(bridge.getStatus(), { listening: false, connected: false, lastReceivedAt: null, port });
  await assert.rejects(send(), (error) => error.code === 'ERR_HTTP_INVALID_HEADER_VALUE' || error.code === 'ECONNREFUSED');
  await bridge.start();
  assert.notEqual(bridge.getPairingCode(), old);
  assert.equal((await send({ headers: { 'X-Orb-Key': old.split('.')[2] } })).status, 401);
});
