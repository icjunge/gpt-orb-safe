'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { UpdateManager } = require('../src/updater.cjs');
const { validateConfig, verifyEnvelope, compareVersions, allowedUpdateUrl, validateUpdateInfo, fetchManifest,
  verifyInstaller, MAX_INSTALLER } = require('../src/update-security.cjs');

const keys = crypto.generateKeyPairSync('ed25519');
const config = { schema: 1, repository: 'example/gpt-orb',
  publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), channel: 'stable' };
const installer = Buffer.from('TEST FIXTURE ONLY: not an executable installer\n');
function payload(version = '2.2.0', overrides = {}) {
  return { schema: 1, version, tag: `v${version}`, platform: 'win32', arch: 'x64',
    file: `GPT-Orb-Setup-${version}-x64.exe`, size: installer.length,
    sha256: crypto.createHash('sha256').update(installer).digest('hex'),
    sha512: crypto.createHash('sha512').update(installer).digest('base64'),
    publishedAt: '2026-09-20T00:00:00Z', ...overrides };
}
function envelope(p, privateKey = keys.privateKey) {
  const bytes = Buffer.from(JSON.stringify(p));
  return Buffer.from(JSON.stringify({ payload: bytes.toString('base64'), signature: crypto.sign(null, bytes, privateKey).toString('base64') }));
}
function info(p) { return { version: p.version, files: [{ url: p.file, size: p.size, sha512: p.sha512 }], path: p.file, sha512: p.sha512 }; }
class FakeUpdater extends EventEmitter {
  constructor(filename, p) {
    super(); this.installerPath = filename; this.info = info(p); this.downloads = 0; this.checks = 0; this.installs = 0;
    this.netSession = { webRequest: {
      onBeforeRequest: callback => { this.requestGuard = callback; },
      onBeforeSendHeaders: callback => { this.headerGuard = callback; },
      onHeadersReceived: callback => { this.responseGuard = callback; },
    } };
  }
  setFeedURL(feed) { this.feed = feed; }
  async checkForUpdates() { this.checks++; return { updateInfo: this.info, cancellationToken: { cancel() {} } }; }
  async downloadUpdate() { this.downloads++; this.emit('download-progress', { percent: 50 }); return [this.installerPath]; }
  quitAndInstall(...args) { this.installs++; this.installArgs = args; }
}
async function fixture(t, p = payload()) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orb-updater-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, p.file);
  await fs.writeFile(filename, installer);
  const updater = new FakeUpdater(filename, p);
  const states = [];
  const manager = new UpdateManager({ appVersion: '2.1.0', config, userData: directory, updater,
    onState: state => states.push(state), fetchManifest: async () => envelope(p) });
  return { directory, filename, updater, manager, states, p };
}

test('unconfigured release never invokes a network request or updater', async () => {
  let calls = 0;
  const manager = new UpdateManager({ appVersion: '2.1.0', config: { schema: 1, repository: null, publicKey: null, channel: 'stable' },
    userData: '/unused', fetchManifest: async () => { calls++; throw Error(); } });
  await manager.check(); await manager.download(); await manager.install();
  assert.equal(manager.snapshot().status, 'unconfigured'); assert.equal(calls, 0);
});
test('only a pinned Ed25519 public key and an explicit safe repository enable updates', () => {
  assert.equal(validateConfig(config).repository, config.repository);
  for (const bad of [{ ...config, repository: '../bad' }, { ...config, publicKey: null }, { ...config, channel: 'beta' },
    { ...config, extra: true }, { ...config, publicKey: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }) }])
    assert.throws(() => validateConfig(bad), { code: 'CONFIG' });
});
test('Ed25519 authenticates exact payload bytes; wrong keys or tampering fail closed', () => {
  assert.equal(verifyEnvelope(envelope(payload()), validateConfig(config)).version, '2.2.0');
  const wrong = crypto.generateKeyPairSync('ed25519');
  assert.throws(() => verifyEnvelope(envelope(payload(), wrong.privateKey), validateConfig(config)), { code: 'SIGNATURE' });
  const tampered = JSON.parse(envelope(payload()));
  tampered.payload = Buffer.from(JSON.stringify(payload('9.9.9'))).toString('base64');
  assert.throws(() => verifyEnvelope(JSON.stringify(tampered), validateConfig(config)), { code: 'SIGNATURE' });
});
test('signed manifest rejects path traversal, oversized binaries, unknown fields and wrong architecture', () => {
  for (const override of [{ file: '../../evil.exe' }, { arch: 'arm64' }, { platform: 'linux' }, { size: MAX_INSTALLER + 1 },
    { size: 0 }, { extra: true }, { version: '2.2.0-beta' }, { tag: 'main' }, { sha512: 'AAAA' }])
    assert.throws(() => verifyEnvelope(envelope(payload('2.2.0', override)), validateConfig(config)));
});
test('strict version comparison handles numeric ordering and rejects alternate semver spellings', () => {
  assert.equal(compareVersions('2.10.0', '2.9.9'), 1);
  assert.equal(compareVersions('2.1.0', '2.1.0'), 0);
  for (const v of ['v2.1.0', '2.01.0', '2.1', '2.1.0+test', '2.1.0-beta']) assert.throws(() => compareVersions(v, '2.1.0'));
});
test('manifest URLs reject credentials, insecure transport, other repos, private hosts and arbitrary GitHub paths', () => {
  for (const url of ['http://github.com/example/gpt-orb/releases/latest/download/orb-update.json',
    'https://github.com:443/example/gpt-orb/releases/latest/download/orb-update.json',
    'https://user:secret@github.com/example/gpt-orb/releases/latest/download/orb-update.json',
    'https://github.com/attacker/gpt-orb/releases/latest/download/orb-update.json',
    'https://github.com/example/gpt-orb/issues', 'https://127.0.0.1/a', 'https://evil.release-assets.githubusercontent.com/a'])
    assert.equal(allowedUpdateUrl(url, config.repository), false, url);
  for (const url of ['https://github.com/example/gpt-orb/releases/latest/download/orb-update.json',
    'https://github.com/example/gpt-orb/releases/download/v2.2.0/orb-update.json',
    'https://release-assets.githubusercontent.com/abc?signature=test', 'https://objects.githubusercontent.com/abc'])
    assert.equal(allowedUpdateUrl(url, config.repository), true, url);
});
test('redirect is checked before a forbidden request is made', async () => {
  const requested = [];
  const request = (url, options, callback) => {
    requested.push(url);
    const req = new EventEmitter(); req.destroy = error => req.emit('error', error);
    queueMicrotask(() => {
      const response = new EventEmitter(); response.statusCode = 302; response.headers = { location: 'https://127.0.0.1/private' };
      response.resume = () => {}; callback(response);
    });
    return req;
  };
  await assert.rejects(fetchManifest(`https://github.com/${config.repository}/releases/latest/download/orb-update.json`, { repository: config.repository, request }), { code: 'URL' });
  assert.equal(requested.length, 1);
});
test('unsigned generic feed must match every security field in signed payload', () => {
  const p = payload(); assert.equal(validateUpdateInfo(info(p), config, p).version, p.version);
  const variants = [ { ...info(p), packages: {} }, { ...info(p), version: '9.9.9' }, { ...info(p), path: 'evil.exe' },
    { ...info(p), files: [...info(p).files, info(p).files[0]] },
    ...[{ url: 'https://evil.test/a.exe' }, { size: p.size + 1 }, { sha512: 'AAAA' }, { packageInfo: {} }, { isAdminRightsRequired: true }]
      .map(change => ({ ...info(p), files: [{ ...info(p).files[0], ...change }] })) ];
  for (const item of variants) assert.throws(() => validateUpdateInfo(item, config, p), { code: 'FEED_MISMATCH' });
});
test('valid update requires signed manifest, fixed tag feed and complete installer verification', async t => {
  const f = await fixture(t);
  const result = await f.manager.check();
  assert.equal(result.status, 'ready'); assert.equal(result.availableVersion, '2.2.0');
  assert.equal(f.updater.downloads, 1); assert.equal(f.updater.installs, 0);
  assert.equal(f.updater.feed.url, 'https://github.com/example/gpt-orb/releases/download/v2.2.0/');
  assert.equal(f.updater.autoDownload, false); assert.equal(f.updater.autoInstallOnAppQuit, false);
  assert.equal(f.updater.autoInstallEvent, 'manual'); assert.equal(f.updater.disableWebInstaller, true);
  assert.equal(f.updater.disableDifferentialDownload, true); assert.equal(f.updater.allowDowngrade, false);
  assert.ok(f.states.some(s => s.status === 'downloading' && s.progress === 50));
});
test('manual check does not download until requested', async t => {
  const f = await fixture(t);
  assert.equal((await f.manager.check({ download: false })).status, 'idle'); assert.equal(f.updater.downloads, 0);
  assert.equal((await f.manager.download()).status, 'ready'); assert.equal(f.updater.downloads, 1);
});
test('same release reports current; an older signed release never reaches updater', async t => {
  const same = await fixture(t, payload('2.1.0')); await same.manager.check();
  assert.equal(same.manager.snapshot().status, 'idle'); assert.equal(same.updater.checks, 0);
  const old = await fixture(t, payload('2.0.9')); await old.manager.check();
  assert.equal(old.manager.snapshot().status, 'error'); assert.equal(old.updater.checks, 0);
});
test('incorrect signature never fetches generic feed or downloads', async t => {
  const f = await fixture(t); f.manager.fetcher = async () => envelope(payload(), crypto.generateKeyPairSync('ed25519').privateKey);
  assert.equal((await f.manager.check()).status, 'error'); assert.equal(f.updater.checks, 0); assert.equal(f.updater.downloads, 0);
});
test('feed mismatch stops before installer download', async t => {
  const f = await fixture(t); f.updater.info.files[0].url = 'https://evil.test/malware.exe';
  assert.equal((await f.manager.check()).status, 'error'); assert.equal(f.updater.downloads, 0);
});
test('corrupt download never becomes installable even if electron-updater reports downloaded', async t => {
  const f = await fixture(t); await fs.writeFile(f.filename, Buffer.alloc(installer.length, 88));
  assert.equal((await f.manager.check()).status, 'error');
  await f.manager.install(); assert.equal(f.updater.installs, 0);
});
test('replacement of cached installer after ready is detected before install', async t => {
  const f = await fixture(t); await f.manager.check();
  await fs.writeFile(f.filename, Buffer.alloc(installer.length, 89));
  assert.equal((await f.manager.install()).ok, false); assert.equal(f.updater.installs, 0);
});
test('updater switching to a different cached path is rejected before install', async t => {
  const f = await fixture(t); await f.manager.check();
  f.updater.installerPath = path.join(f.directory, 'replacement.exe');
  assert.equal((await f.manager.install()).ok, false); assert.equal(f.updater.installs, 0);
});
test('successful install explicitly restarts only after rehash and preferences-only backup', async t => {
  const f = await fixture(t); const preferences = JSON.stringify({ opacity: .75, orbPosition: { x: 100, y: 100 } });
  await fs.writeFile(path.join(f.directory, 'preferences.json'), preferences);
  await fs.writeFile(path.join(f.directory, 'unrelated-secret.txt'), 'not copied');
  await f.manager.check(); await f.manager.install();
  assert.equal(f.updater.installs, 1); assert.deepEqual(f.updater.installArgs, [false, true]);
  const files = await fs.readdir(path.join(f.directory, 'recovery'));
  assert.equal(files.length, 1); assert.match(files[0], /^preferences-before-2\.1\.0-to-2\.2\.0-/);
  assert.equal(await fs.readFile(path.join(f.directory, 'recovery', files[0]), 'utf8'), preferences);
});
test('failed backup stops installation', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.directory, 'preferences.json'), 'invalid json');
  await f.manager.check(); assert.equal((await f.manager.install()).ok, false); assert.equal(f.updater.installs, 0);
});
test('updater network guard restricts redirects and strips account headers', async t => {
  const f = await fixture(t); await f.manager.check({ download: false });
  const allowed = url => { let result; f.updater.requestGuard({ url }, value => { result = !value.cancel; }); return result; };
  assert.equal(allowed('https://github.com/example/gpt-orb/releases/download/v2.2.0/latest.yml?noCache=1'), true);
  assert.equal(allowed('https://github.com/example/gpt-orb/releases/download/v2.2.0/GPT-Orb-Setup-2.2.0-x64.exe'), true);
  assert.equal(allowed('https://release-assets.githubusercontent.com/test?sig=test'), true);
  for (const url of ['https://github.com/attacker/repo/releases/download/v2.2.0/latest.yml',
    'http://127.0.0.1/', 'https://example.com/installer.exe', 'https://github.com/example/gpt-orb/releases/download/v2.1.0/latest.yml'])
    assert.equal(allowed(url), false);
  let headers;
  f.updater.headerGuard({ requestHeaders: { Cookie: 'account', Authorization: 'secret', 'Proxy-Authorization': 'secret', 'X-User-Staging-Id': 'id', Accept: '*/*' } },
    value => { headers = value.requestHeaders; });
  assert.deepEqual(headers, { Accept: '*/*' });
  f.manager.stop(); assert.equal(allowed('https://release-assets.githubusercontent.com/test'), false);
});
test('response fence rejects unknown, compressed and oversized download lengths', async t => {
  const f = await fixture(t); await f.manager.check({ download: false });
  f.manager.state.status = 'downloading';
  const allowed = (headers, statusCode = 200) => {
    let result;
    f.updater.responseGuard({ statusCode, responseHeaders: headers }, value => { result = !value.cancel; });
    return result;
  };
  assert.equal(allowed({ 'Content-Length': [String(installer.length)] }), true);
  assert.equal(allowed({}, 302), true);
  for (const headers of [{}, { 'Content-Length': [String(installer.length + 1)] }, { 'Content-Length': ['100000000000'] },
    { 'Content-Length': [String(installer.length)], 'Transfer-Encoding': ['chunked'] },
    { 'Content-Length': [String(installer.length)], 'Content-Encoding': ['gzip'] }]) assert.equal(allowed(headers), false);
});
test('stop cancels a pending metadata read and prevents future installation', async t => {
  const f = await fixture(t); let signal;
  f.manager.fetcher = (_url, options) => { signal = options.signal; return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error(), { code: 'CANCELLED' })), { once: true });
  }); };
  const running = f.manager.check(); f.manager.stop(); await running;
  assert.equal(signal.aborted, true); await f.manager.install(); assert.equal(f.updater.installs, 0);
});
test('installer symlink does not satisfy the signed artifact check', async t => {
  const f = await fixture(t); const link = path.join(f.directory, 'linked.exe');
  try { await fs.symlink(f.filename, link); } catch (error) { if (error.code === 'EPERM') return t.skip('symlink privilege unavailable'); throw error; }
  await assert.rejects(verifyInstaller(link, f.p), { code: 'INSTALLER' });
});

test('pinned real NsisUpdater provider and cache return the same verified installer path', async t => {
  // Exercise the dependency's real YAML parser, provider, NSIS cache and events.
  // Only transport and process launch are faked; no installer is executed.
  const { NsisUpdater } = require('electron-updater/out/NsisUpdater');
  const yaml = require('js-yaml');
  const f = await fixture(t);
  const configPath = path.join(f.directory, 'app-update.yml');
  await fs.writeFile(configPath, yaml.dump({ provider: 'generic', url: 'https://github.com/example/gpt-orb/releases/latest/download/', updaterCacheDirName: 'test-cache' }));
  const app = { version: '2.1.0', name: 'orb-updater-integration-test', isPackaged: true,
    appUpdateConfigPath: configPath, userDataPath: f.directory, baseCachePath: f.directory,
    whenReady: async () => {}, onQuit: () => { throw Error('must not register quit installer'); },
    quit: () => { throw Error('must not quit real process'); }, relaunch: () => {} };
  const updater = new NsisUpdater(null, app);
  updater._testOnlyOptions = { platform: 'win32' };
  const requests = [], downloads = [];
  const network = { webRequest: { onBeforeRequest: callback => { network.guard = callback; }, onBeforeSendHeaders: callback => { network.headers = callback; }, onHeadersReceived: callback => { network.response = callback; } } };
  Object.defineProperty(updater, 'netSession', { value: network });
  updater.httpExecutor = {
    request: async options => { requests.push(options); return yaml.dump(info(f.p)); },
    download: async (url, destination, options) => { downloads.push(url.href); assert.equal(options.sha512, f.p.sha512); await fs.writeFile(destination, installer); },
  };
  let installs = 0;
  updater.quitAndInstall = () => { installs++; };
  const manager = new UpdateManager({ appVersion: '2.1.0', config, userData: f.directory, updater, fetchManifest: async () => envelope(f.p) });
  const result = await manager.check();
  assert.equal(result.status, 'ready', result.message);
  assert.equal(requests.length, 1); assert.match(requests[0].path, /^\/example\/gpt-orb\/releases\/download\/v2\.2\.0\/latest\.yml(?:\?|$)/);
  assert.deepEqual(downloads, ['https://github.com/example/gpt-orb/releases/download/v2.2.0/GPT-Orb-Setup-2.2.0-x64.exe']);
  assert.equal(updater.installerPath, manager.downloadedFile);
  assert.equal((await manager.install()).ok, true); assert.equal(installs, 1);
  manager.stop();
});
