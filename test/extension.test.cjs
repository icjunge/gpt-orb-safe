'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const ID = 'agneegnckfnfbmajknfomclligggnhie';
const PAGE = 'https://chatgpt.com/codex/settings/usage';
const SECRET = 'A'.repeat(43);
const CODE = `GPTORB2.43861.${SECRET}`;
const popup = { id: ID, url: `chrome-extension://${ID}/popup.html` };
const content = { id: ID, url: PAGE, frameId: 0, tab: { id: 7, url: PAGE } };

function snapshot(source = 'official-page') {
  return { version: 1, source, capturedAt: Date.now(),
    windows: [{ kind: 'session', usedPercent: 27.5, resetAt: null, resetApproximate: false }],
    tokens: { total: null, today: 0 } };
}

function harness() {
  let handler;
  const data = {};
  const requests = [];
  const injections = [];
  const stops = [];
  const mutations = [];
  const access = [];
  const state = { tab: { id: 7, url: PAGE }, status: 204 };
  const chrome = {
    runtime: { id: ID, getURL: file => `chrome-extension://${ID}/${file}`,
      onMessage: { addListener: fn => { handler = fn; } } },
    storage: { session: {
      setAccessLevel: async value => { access.push(value); },
      get: async key => ({ [key]: data[key] === undefined ? undefined : structuredClone(data[key]) }),
      set: async values => { mutations.push('set'); Object.assign(data, structuredClone(values)); },
      remove: async keys => { mutations.push('remove'); for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }
    } },
    tabs: { query: async () => state.tab ? [structuredClone(state.tab)] : [], get: async () => structuredClone(state.tab),
      sendMessage: async (...args) => { stops.push(args); },
      onRemoved: { addListener() {} }, onUpdated: { addListener() {} } },
    scripting: { executeScript: async value => { injections.push(value); } }
  };
  const context = vm.createContext({ chrome, URL, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: state.status >= 200 && state.status < 300, status: state.status }; } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/sw.js'), 'utf8'), context);
  const send = (message, sender = popup) => new Promise(resolve => {
    if (!handler(message, sender, resolve)) resolve(undefined);
  });
  return { send, data, requests, injections, stops, mutations, access, state };
}

test('pairing is session-only, restricted to trusted contexts, and targets the isolated main frame', async () => {
  const h = harness();
  assert.equal((await h.send({ type: 'orb:start', code: CODE })).ok, true);
  assert.equal(h.data.bridge.secret, SECRET);
  assert.equal(h.access[0].accessLevel, 'TRUSTED_CONTEXTS');
  assert.equal(h.injections[0].world, 'ISOLATED');
  assert.deepEqual(Array.from(h.injections[0].target.frameIds), [0]);
  assert.deepEqual(Array.from(h.injections[0].files), ['parser.js', 'collector.js']);
  const status = await h.send({ type: 'orb:status' });
  assert.equal(status.paired, true);
  assert.equal(JSON.stringify(status).includes(SECRET), false);
  assert.equal(JSON.stringify(h.injections).includes(SECRET), false);
});

test('only explicit popup pairing on the exact official route is accepted', async () => {
  const h = harness();
  for (const url of ['https://chatgpt.com/c/', 'http://chatgpt.com/codex/settings/usage',
    'https://chatgpt.com.evil.test/codex/settings/usage', 'https://user@chatgpt.com/codex/settings/usage']) {
    h.state.tab.url = url;
    assert.equal((await h.send({ type: 'orb:start', code: CODE })).ok, false, url);
  }
  assert.equal((await h.send({ type: 'orb:start', code: CODE }, content)).ok, false);
  assert.equal(await h.send({ type: 'orb:start', code: CODE }, { ...popup, id: 'foreign' }), undefined);
  assert.equal(h.data.bridge, undefined);
});

test('page diagnostics distinguish missing tabs, unavailable URLs and unsupported pages without exposing URLs', async () => {
  const h = harness();
  const privateURL = 'https://example.test/private?token=not-for-status';
  for (const [tab, expected] of [
    [undefined, 'no-tab'],
    [{ url: PAGE }, 'no-tab'],
    [{ id: 7 }, 'url-unavailable'],
    [{ id: 7, url: '' }, 'url-unavailable'],
    [{ id: 7, url: privateURL }, 'unsupported-page'],
    [{ id: 7, url: PAGE }, 'usage-page']
  ]) {
    h.state.tab = tab;
    const status = await h.send({ type: 'orb:status' });
    assert.equal(status.ok, true);
    assert.equal(status.tabState, expected);
    assert.equal(status.onUsagePage, expected === 'usage-page');
    assert.equal(JSON.stringify(status).includes(privateURL), false);
    assert.equal(JSON.stringify(status).includes('not-for-status'), false);
  }
  assert.equal(h.mutations.length, 0);
  assert.equal(h.stops.length, 0);
  assert.equal(h.injections.length, 0);
  assert.equal(h.requests.length, 0);
});

test('page validation failures preserve an existing pairing without mutations, stops, injections or requests', async () => {
  const h = harness();
  await h.send({ type: 'orb:start', code: CODE });
  const original = structuredClone(h.data);
  h.mutations.length = 0;
  h.injections.length = 0;
  h.stops.length = 0;
  for (const [tab, hint] of [
    [undefined, /未找到当前标签页/],
    [{ id: 9 }, /无法读取当前标签页地址/],
    [{ id: 9, url: 'https://example.test/private?token=not-for-errors' }, /不是支持的官方 Codex 用量页/],
    [{ id: 9, url: popup.url }, /不是支持的官方 Codex 用量页/]
  ]) {
    h.state.tab = tab;
    for (const message of [
      { type: 'orb:start', code: `GPTORB2.43861.${'B'.repeat(43)}` },
      { type: 'orb:refresh' },
      { type: 'orb:manual', snapshot: snapshot('manual-page') }
    ]) {
      const result = await h.send(message);
      assert.equal(result.ok, false);
      assert.match(result.message, hint);
      assert.doesNotMatch(result.message, /not-for-errors|GPTORB2|example\.test/);
      assert.deepEqual(h.data, original);
      assert.equal(h.mutations.length, 0);
      assert.equal(h.stops.length, 0);
      assert.equal(h.injections.length, 0);
      assert.equal(h.requests.length, 0);
    }
  }
});

test('page diagnostics retain the exact official origin and route allowlist', async () => {
  for (const url of [PAGE, `${PAGE}/`, `${PAGE}?view=limits`, `${PAGE}/?view=limits#weekly`]) {
    const h = harness();
    h.state.tab.url = url;
    assert.equal((await h.send({ type: 'orb:status' })).tabState, 'usage-page', url);
    assert.equal((await h.send({ type: 'orb:start', code: CODE })).ok, true, url);
    assert.equal(h.injections.length, 1);
  }
  const h = harness();
  for (const url of [
    'http://chatgpt.com/codex/settings/usage',
    'https://chatgpt.com.evil.test/codex/settings/usage',
    'https://chatgpt.com:444/codex/settings/usage',
    'https://user:password@chatgpt.com/codex/settings/usage',
    `${PAGE}-extra`, `${PAGE}/extra`, 'https://chatgpt.com/codex/settings',
    'https://chatgpt.com/Codex/settings/usage', 'https://chatgpt.com/c/'
  ]) {
    h.state.tab.url = url;
    assert.equal((await h.send({ type: 'orb:status' })).tabState, 'unsupported-page', url);
    assert.equal((await h.send({ type: 'orb:start', code: CODE })).ok, false, url);
  }
  assert.equal(h.mutations.length, 0);
  assert.equal(h.stops.length, 0);
  assert.equal(h.injections.length, 0);
  assert.equal(h.requests.length, 0);
});

test('the trusted popup main frame is recognized even when the browser supplies sender.tab', async () => {
  const h = harness();
  const sender = { ...popup, frameId: 0, tab: { id: 9, url: popup.url } };
  for (const value of [sender, { ...sender, origin: `chrome-extension://${ID}` }]) {
    const result = await h.send({ type: 'orb:status' }, value);
    assert.equal(result.ok, true);
    assert.equal(result.paired, false);
    assert.equal(result.onUsagePage, true);
  }
  assert.equal(h.data.bridge, undefined);
  assert.equal(h.injections.length, 0);
  assert.equal(h.requests.length, 0);
});

test('popup tab support preserves the active official-page requirement for pairing', async () => {
  const h = harness();
  const sender = { ...popup, frameId: 0, origin: `chrome-extension://${ID}`,
    tab: { id: 9, url: popup.url } };
  h.state.tab = sender.tab;
  assert.equal((await h.send({ type: 'orb:start', code: CODE }, sender)).ok, false);
  assert.equal(h.data.bridge, undefined);
  assert.equal(h.injections.length, 0);
  h.state.tab = { id: 7, url: PAGE };
  assert.equal((await h.send({ type: 'orb:start', code: CODE }, sender)).ok, true);
  assert.equal(h.data.bridge.tabId, 7);
  assert.equal(h.injections[0].target.tabId, 7);
  assert.deepEqual(Array.from(h.injections[0].target.frameIds), [0]);
});

test('popup subframes and foreign or opaque origins cannot read status or control pairing', async () => {
  const h = harness();
  const sender = { ...popup, frameId: 0, origin: `chrome-extension://${ID}`,
    tab: { id: 9, url: popup.url } };
  for (const value of [
    { ...sender, frameId: 1 },
    { ...sender, origin: 'https://chatgpt.com' },
    { ...sender, origin: 'null' },
    { ...sender, origin: `chrome-extension://${'b'.repeat(32)}` }
  ]) {
    assert.equal((await h.send({ type: 'orb:status' }, value)).ok, false);
    assert.equal((await h.send({ type: 'orb:start', code: CODE }, value)).ok, false);
  }
  assert.equal(h.data.bridge, undefined);
  assert.equal(h.injections.length, 0);
  assert.equal(h.requests.length, 0);
});

test('invalid pairing code never injects scripts or starts a connection', async () => {
  const h = harness();
  for (const code of ['token', CODE.replace('43861', '43862'), `GPTORB2.43861.${'A'.repeat(42)}`]) {
    assert.equal((await h.send({ type: 'orb:start', code })).ok, false);
  }
  assert.equal(h.injections.length, 0);
  assert.equal(h.requests.length, 0);
});

test('only numeric snapshots are POSTed to fixed loopback URL without cookies or redirects', async () => {
  const h = harness();
  await h.send({ type: 'orb:start', code: CODE });
  const value = snapshot();
  assert.equal((await h.send({ type: 'orb:snapshot', snapshot: value }, content)).ok, true);
  const req = h.requests[0];
  assert.equal(req.url, 'http://127.0.0.1:43861/v1/usage');
  assert.equal(req.options.mode, 'cors');
  assert.equal(req.options.credentials, 'omit');
  assert.equal(req.options.redirect, 'error');
  assert.equal(req.options.referrerPolicy, 'no-referrer');
  assert.equal(req.options.headers['X-Orb-Key'], SECRET);
  assert.deepEqual(JSON.parse(req.options.body), value);
});

test('content sender must be the authorized main frame and still be on the exact page', async () => {
  const h = harness();
  await h.send({ type: 'orb:start', code: CODE });
  for (const sender of [
    { ...content, frameId: 1 },
    { ...content, url: 'https://chatgpt.com/c/' },
    { ...content, tab: { id: 8, url: PAGE } },
    { ...content, tab: { id: 7, url: 'https://chatgpt.com/c/' } }
  ]) assert.equal((await h.send({ type: 'orb:snapshot', snapshot: snapshot() }, sender)).ok, false);
  h.state.tab.url = 'https://chatgpt.com/c/';
  assert.equal((await h.send({ type: 'orb:snapshot', snapshot: snapshot() }, content)).ok, false);
  assert.equal(h.requests.length, 0);
});

test('schema rejects raw text, extra keys, wrong sources, stale timestamps and unsafe numeric values', async () => {
  const h = harness();
  await h.send({ type: 'orb:start', code: CODE });
  const values = [
    { ...snapshot(), rawText: 'private page text' },
    { ...snapshot(), source: 'manual-page' },
    { ...snapshot(), capturedAt: Date.now() - 3600000 },
    { ...snapshot(), tokens: { total: Number.MAX_SAFE_INTEGER + 1, today: null } },
    { ...snapshot(), tokens: { total: '42', today: null } },
    { ...snapshot(), windows: [{ ...snapshot().windows[0], usedPercent: 101 }] },
    { ...snapshot(), windows: [{ ...snapshot().windows[0], rawText: 'secret' }] },
    { ...snapshot(), windows: [snapshot().windows[0], snapshot().windows[0]] }
  ];
  for (const value of values) assert.equal((await h.send({ type: 'orb:snapshot', snapshot: value }, content)).ok, false);
  assert.equal(h.requests.length, 0);
});

test('empty recognized data remains unknown and is not fabricated as zero', async () => {
  const h = harness();
  await h.send({ type: 'orb:start', code: CODE });
  const value = { ...snapshot(), windows: [], tokens: { total: null, today: null } };
  const result = await h.send({ type: 'orb:snapshot', snapshot: value }, content);
  assert.equal(result.ok, true);
  assert.equal(result.hasData, false);
  assert.deepEqual(JSON.parse(h.requests[0].options.body).tokens, { total: null, today: null });
});

test('manual data is explicit and pauses automatic collection', async () => {
  const h = harness();
  await h.send({ type: 'orb:start', code: CODE });
  assert.equal((await h.send({ type: 'orb:manual', snapshot: snapshot('manual-page') })).ok, true);
  assert.equal(h.data.bridge.mode, 'manual');
  assert.equal(h.stops.at(-1)[1].type, 'orb:stop');
  const blocked = await h.send({ type: 'orb:snapshot', snapshot: snapshot() }, content);
  assert.equal(blocked.stop, true);
  assert.equal(h.requests.length, 1);
});

test('stop clears the only pairing secret and rejects subsequent content messages', async () => {
  const h = harness();
  await h.send({ type: 'orb:start', code: CODE });
  assert.equal((await h.send({ type: 'orb:stop' })).ok, true);
  assert.equal(h.data.bridge, undefined);
  assert.equal(h.data.status, undefined);
  assert.equal((await h.send({ type: 'orb:snapshot', snapshot: snapshot() }, content)).stop, true);
  assert.equal(h.requests.length, 0);
});

test('desktop restart or disconnect invalidates the code and halts further transmission', async () => {
  const h = harness();
  await h.send({ type: 'orb:start', code: CODE });
  h.state.status = 401;
  const result = await h.send({ type: 'orb:snapshot', snapshot: snapshot() }, content);
  assert.equal(result.ok, false);
  assert.equal(result.stop, true);
  assert.equal(h.data.bridge, undefined);
  assert.match(h.data.status.error, /配对已失效/);
  assert.equal((await h.send({ type: 'orb:snapshot', snapshot: snapshot() }, content)).stop, true);
  assert.equal(h.requests.length, 1);
});

test('manifest grants no account, cookie, persistent web host or external messaging access', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../extension/manifest.json'), 'utf8'));
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'storage']);
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*']);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.match(manifest.content_security_policy.extension_pages, /connect-src http:\/\/127\.0\.0\.1:43861;/);
  assert.doesNotMatch(manifest.content_security_policy.extension_pages, /unsafe-eval|unsafe-inline/);
});
