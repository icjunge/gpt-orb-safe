'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { MacUpdateManager } = require('../src/mac-updater.cjs');
const {
  validateConfig, verifyEnvelope, verifyMacEnvelope, allowedUpdateUrl, allowedMacManifestUrl,
  fetchMacManifest, MAX_ENVELOPE, MAX_INSTALLER,
} = require('../src/update-security.cjs');

const keys = crypto.generateKeyPairSync('ed25519');
const config = { schema: 1, repository: 'example/gpt-orb',
  publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), channel: 'stable' };
const fixtureBytes = Buffer.from('test fixture only; not a disk image');
function payload(version = '2.7.0', arch = 'arm64', overrides = {}) {
  return { schema: 1, version, tag: `v${version}`, platform: 'darwin', arch,
    file: `GPT-Orb-Setup-${version}-${arch}.dmg`, size: fixtureBytes.length,
    sha256: crypto.createHash('sha256').update(fixtureBytes).digest('hex'),
    sha512: crypto.createHash('sha512').update(fixtureBytes).digest('base64'),
    publishedAt: '2026-09-24T00:00:00Z', ...overrides };
}
function envelope(p, privateKey = keys.privateKey) {
  const bytes = Buffer.from(JSON.stringify(p));
  return Buffer.from(JSON.stringify({ payload: bytes.toString('base64'),
    signature: crypto.sign(null, bytes, privateKey).toString('base64') }));
}
function fixture(overrides = {}) {
  const opens = [], requests = [], states = [];
  const manager = new MacUpdateManager({ appVersion: '2.6.0', config, arch: 'arm64',
    fetchManifest: async (url, options) => { requests.push({ url, options }); return envelope(payload()); },
    openExternal: async url => { opens.push(url); }, onState: state => states.push(state), ...overrides });
  return { manager, opens, requests, states };
}
function fakeTransport(routes) {
  const calls = [];
  const request = (url, options, callback) => {
    calls.push({ url, options });
    const req = new EventEmitter();
    req.destroy = error => { if (error) req.emit('error', error); };
    queueMicrotask(() => {
      const route = routes[calls.length - 1];
      const response = new EventEmitter();
      response.statusCode = route.status ?? 200;
      response.headers = route.headers || {};
      response.resume = () => {};
      response.destroy = () => { response.destroyed = true; };
      callback(response);
      if (response.statusCode === 200 && !response.destroyed) {
        for (const chunk of route.chunks || [route.body || envelope(payload())]) response.emit('data', Buffer.from(chunk));
        response.emit('end');
      }
    });
    return req;
  };
  return { request, calls };
}
const manifestUrl = 'https://github.com/example/gpt-orb/releases/latest/download/orb-update-mac-arm64.json';

test('Mac verifier independently authenticates both architectures without broadening Windows', () => {
  for (const arch of ['arm64', 'x64']) {
    assert.equal(verifyMacEnvelope(envelope(payload('2.7.0', arch)), validateConfig(config), arch).arch, arch);
    assert.throws(() => verifyEnvelope(envelope(payload('2.7.0', arch)), validateConfig(config)), { code: 'MANIFEST' });
  }
  assert.throws(() => verifyMacEnvelope(envelope(payload()), validateConfig(config), 'ia32'), { code: 'ARCH' });
  assert.equal(allowedUpdateUrl(manifestUrl, config.repository), false);
});
test('Mac signed payload rejects another platform, architecture, filename and malformed metadata', () => {
  for (const change of [{ arch: 'x64' }, { platform: 'win32' }, { file: '../unsafe.dmg' },
    { file: 'GPT-Orb-Setup-2.7.0-x64.dmg' }, { file: 'GPT-Orb-Setup-2.7.0-arm64.dmg?redirect=1' },
    { tag: 'main' }, { version: '2.7.0-beta' }, { extra: true }, { size: MAX_INSTALLER + 1 }, { size: 0 },
    { sha256: 'a'.repeat(63) }, { sha512: 'AAAA' }, { publishedAt: 'not-a-date' }])
    assert.throws(() => verifyMacEnvelope(envelope(payload('2.7.0', 'arm64', change)), validateConfig(config), 'arm64'));
});
test('Mac signature binds exact bytes and rejects another publisher or modified payload', () => {
  const wrong = crypto.generateKeyPairSync('ed25519');
  assert.throws(() => verifyMacEnvelope(envelope(payload(), wrong.privateKey), validateConfig(config), 'arm64'), { code: 'SIGNATURE' });
  const changed = JSON.parse(envelope(payload()));
  changed.payload = Buffer.from(JSON.stringify(payload('9.9.9'))).toString('base64');
  assert.throws(() => verifyMacEnvelope(JSON.stringify(changed), validateConfig(config), 'arm64'), { code: 'SIGNATURE' });
  assert.throws(() => verifyMacEnvelope(Buffer.alloc(MAX_ENVELOPE + 1), validateConfig(config), 'arm64'), { code: 'MANIFEST_SIZE' });
});
test('Mac manifest URL fence uses exact repo, filename, architecture and HTTPS without credentials', () => {
  assert.equal(allowedMacManifestUrl(manifestUrl, config.repository, 'arm64'), true);
  assert.equal(allowedMacManifestUrl(manifestUrl.replace('latest/download', 'download/v2.7.0'), config.repository, 'arm64'), true);
  for (const url of [manifestUrl.replace('arm64', 'x64'), manifestUrl.replace('example/', 'attacker/'),
    manifestUrl.replace('https:', 'http:'), manifestUrl.replace('github.com', 'github.com:443'),
    manifestUrl.replace('github.com', 'u:p@github.com'), `${manifestUrl}#fragment`, `${manifestUrl}?next=evil`,
    'https://127.0.0.1/private', 'https://evil.release-assets.githubusercontent.com/a',
    'https://github.com/example/gpt-orb/releases/download/v2.7.0/GPT-Orb-Setup-2.7.0-arm64.dmg',
    'https://github.com\\@attacker.example/evil', ' https://github.com/example/gpt-orb/releases/latest/download/orb-update-mac-arm64.json'])
    assert.equal(allowedMacManifestUrl(url, config.repository, 'arm64', true), false, url);
  assert.equal(allowedMacManifestUrl('https://release-assets.githubusercontent.com/id?sig=x', config.repository, 'arm64'), false);
  assert.equal(allowedMacManifestUrl('https://release-assets.githubusercontent.com/id?sig=x', config.repository, 'arm64', true), true);
});
test('Mac redirect fence rejects forbidden next hop before issuing it', async () => {
  for (const location of ['https://127.0.0.1/private', 'http://github.com/example/gpt-orb/releases/latest/download/orb-update-mac-arm64.json',
    'https://github.com/attacker/gpt-orb/releases/latest/download/orb-update-mac-arm64.json',
    manifestUrl.replace('arm64', 'x64'), 'https://u:p@release-assets.githubusercontent.com/id']) {
    const transport = fakeTransport([{ status: 302, headers: { location } }]);
    await assert.rejects(fetchMacManifest(manifestUrl, { repository: config.repository, arch: 'arm64', request: transport.request }), { code: 'URL' });
    assert.equal(transport.calls.length, 1);
  }
});
test('Mac manifest fetch permits bounded GitHub CDN redirects and never supplies account headers', async () => {
  const transport = fakeTransport([
    { status: 302, headers: { location: '/example/gpt-orb/releases/download/v2.7.0/orb-update-mac-arm64.json' } },
    { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/id?sig=x' } }, { body: envelope(payload()) },
  ]);
  const result = await fetchMacManifest(manifestUrl, { repository: config.repository, arch: 'arm64', request: transport.request });
  assert.equal(verifyMacEnvelope(result, validateConfig(config), 'arm64').version, '2.7.0');
  assert.equal(transport.calls.length, 3);
  for (const call of transport.calls) {
    assert.deepEqual(Object.keys(call.options.headers).sort(), ['Accept', 'Cache-Control', 'User-Agent']);
    assert.equal(new URL(call.url).protocol, 'https:');
  }
});
test('Mac transport rejects redirect loops, oversized or truncated bodies and compressed metadata', async () => {
  const loop = fakeTransport(Array.from({ length: 6 }, () => ({ status: 302, headers: { location: manifestUrl } })));
  await assert.rejects(fetchMacManifest(manifestUrl, { repository: config.repository, arch: 'arm64', request: loop.request }), { code: 'URL' });
  assert.equal(loop.calls.length, 6);
  for (const route of [{ body: Buffer.alloc(MAX_ENVELOPE + 1) }, { headers: { 'content-length': String(MAX_ENVELOPE + 1) } },
    { headers: { 'content-length': '999' }, body: Buffer.from('short') }, { headers: { 'content-encoding': 'gzip' } }]) {
    const transport = fakeTransport([route]);
    await assert.rejects(fetchMacManifest(manifestUrl, { repository: config.repository, arch: 'arm64', request: transport.request }));
  }
});
test('Mac update checks offer manual installation and never download, execute or open automatically', async () => {
  const f = fixture();
  assert.equal(f.requests.length, 0);
  const state = await f.manager.check({ download: true });
  assert.equal(state.status, 'available'); assert.equal(state.installMode, 'manual');
  assert.equal(state.availableVersion, '2.7.0'); assert.equal(state.progress, null);
  assert.equal(f.requests[0].url, manifestUrl); assert.equal(f.opens.length, 0);
  await f.manager.download(); assert.equal(f.opens.length, 0);
  assert.equal(f.states.some(item => ['ready', 'downloading'].includes(item.status)), false);
  assert.equal(JSON.stringify(state).includes('signature'), false);
});
test('Mac explicit action opens only the verified exact version and architecture DMG', async () => {
  for (const arch of ['arm64', 'x64']) {
    const f = fixture({ arch, fetchManifest: async () => envelope(payload('2.7.0', arch)) });
    assert.equal((await f.manager.install()).ok, false);
    await f.manager.check();
    assert.deepEqual(await f.manager.install(), { ok: true, manual: true });
    assert.deepEqual(f.opens, [`https://github.com/example/gpt-orb/releases/download/v2.7.0/GPT-Orb-Setup-2.7.0-${arch}.dmg`]);
    assert.equal(f.manager.snapshot().status, 'available');
    assert.match(f.manager.snapshot().message, /手动|替换/);
  }
});
test('Mac current or older release cannot open a download; unsupported or unconfigured setup cannot fetch', async () => {
  for (const version of ['2.6.0', '2.5.4']) {
    const f = fixture({ fetchManifest: async () => envelope(payload(version)) });
    assert.equal((await f.manager.check()).status, version === '2.6.0' ? 'idle' : 'error');
    assert.equal((await f.manager.install()).ok, false); assert.equal(f.opens.length, 0);
  }
  for (const options of [{ arch: 'ia32' }, { config: { ...config, repository: null, publicKey: null } },
    { config: { ...config, repository: '../attacker' } }]) {
    const f = fixture(options); await f.manager.check(); await f.manager.install();
    assert.equal(f.requests.length, 0); assert.equal(f.opens.length, 0);
  }
});
test('Mac wrong platform, architecture or signature never exposes a download action', async () => {
  for (const body of [envelope(payload('2.7.0', 'x64')), envelope(payload('2.7.0', 'arm64', { platform: 'win32' })),
    envelope(payload(), crypto.generateKeyPairSync('ed25519').privateKey)]) {
    const f = fixture({ fetchManifest: async () => body });
    assert.equal((await f.manager.check()).status, 'error');
    assert.equal(f.manager.snapshot().availableVersion, null);
    assert.equal((await f.manager.install()).ok, false); assert.equal(f.opens.length, 0);
  }
});
test('Mac newer observed signed release cannot be rolled back or silently replaced during the session', async () => {
  const f = fixture();
  await f.manager.check();
  f.manager.fetcher = async () => envelope(payload('2.6.1'));
  assert.equal((await f.manager.check()).status, 'error');
  assert.equal((await f.manager.install()).ok, false);
  f.manager.fetcher = async () => envelope(payload('2.7.0', 'arm64', { sha256: 'a'.repeat(64) }));
  assert.equal((await f.manager.check()).status, 'error'); assert.equal(f.opens.length, 0);
  f.manager.fetcher = async () => envelope(payload('2.8.0'));
  assert.equal((await f.manager.check()).availableVersion, '2.8.0');
});
test('Mac install reauthenticates cached manifest and stores its own copy of fetched bytes', async () => {
  const fetched = envelope(payload());
  const f = fixture({ fetchManifest: async () => fetched });
  await f.manager.check(); fetched.fill(0);
  assert.equal((await f.manager.install()).ok, true);
  f.manager.envelope = envelope(payload('9.9.9'), crypto.generateKeyPairSync('ed25519').privateKey);
  assert.equal((await f.manager.install()).ok, false); assert.equal(f.opens.length, 1);
});
test('Mac browser errors are sanitized and no success or restart is reported', async () => {
  const f = fixture({ openExternal: async () => { throw new Error('secret-path-or-token'); } });
  await f.manager.check();
  const result = await f.manager.install();
  assert.equal(result.ok, false); assert.doesNotMatch(JSON.stringify(result), /secret-path-or-token/);
  assert.equal(f.manager.snapshot().status, 'error');
});
test('Mac stop aborts pending fetch and prevents late responses from restoring an update', async () => {
  let release, signal;
  const f = fixture({ fetchManifest: async (_url, options) => {
    signal = options.signal; return new Promise(resolve => { release = resolve; });
  } });
  const running = f.manager.check();
  f.manager.stop(); assert.equal(signal.aborted, true);
  release(envelope(payload())); await running;
  assert.equal((await f.manager.install()).ok, false); assert.equal(f.opens.length, 0);
  assert.equal(f.manager.payload, null); assert.equal(f.manager.envelope, null);
});
test('Mac concurrent checks and explicit opens are coalesced while in flight', async () => {
  let release;
  const f = fixture({ openExternal: async url => { f.opens.push(url); await new Promise(resolve => { release = resolve; }); } });
  await Promise.all([f.manager.check(), f.manager.check()]); assert.equal(f.requests.length, 1);
  const pending = f.manager.install();
  assert.equal((await f.manager.install()).ok, false); assert.equal(f.opens.length, 1);
  release(); assert.equal((await pending).ok, true);
});
