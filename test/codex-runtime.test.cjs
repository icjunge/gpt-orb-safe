'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {EventEmitter} = require('node:events');
const {Readable} = require('node:stream');
const {gzipSync} = require('node:zlib');
const {createHash} = require('node:crypto');
const {PINNED_CODEX_RUNTIME, createCodexRuntime} = require('../src/codex-runtime.cjs');

const digest = data => createHash('sha256').update(data).digest('hex');
const EXE = Buffer.from('MZ-test-official-component-content');
function tar(bytes = EXE, {name = PINNED_CODEX_RUNTIME.member, type = 48, size = bytes.length, suffix = null, checksum = true} = {}) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000755\0', 100, 8, 'ascii');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.fill(32, 148, 156); header[156] = type; header.write('ustar  \0', 257, 8, 'ascii');
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  if (!checksum) header[148] ^= 1;
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512), suffix || Buffer.alloc(1024)]);
}
function fixture(archive = gzipSync(tar()), executable = EXE) {
  return {...PINNED_CODEX_RUNTIME, archiveBytes:archive.length, archiveSha256:digest(archive),
    executableBytes:executable.length, executableSha256:digest(executable)};
}
const CDN = 'https://release-assets.githubusercontent.com/github-production-release-asset/965415649/aabb-ccdd?sp=r&sig=fixture';
function fakeNetwork({body = gzipSync(tar()), redirect = CDN, statusCode = 200, headers, stall = false, responseError = false, parts = 1} = {}) {
  const calls = [];
  const request = options => {
    const req = new EventEmitter();
    const call = {options, headers:{}, followed:0, aborted:0}; calls.push(call);
    req.setHeader = (key, value) => { call.headers[key] = value; };
    req.abort = () => { call.aborted++; req.emit('abort'); };
    const respond = () => {
      if (stall) return;
      const chunks = Array.from({length:parts}, (_, i) => body.subarray(Math.floor(i * body.length / parts), Math.floor((i + 1) * body.length / parts)));
      const response = Readable.from(chunks);
      response.statusCode = statusCode;
      response.headers = headers || {'content-length':String(body.length)};
      if (responseError) response._read = () => { response.destroy(new Error('sensitive-url-or-system-text')); };
      req.emit('response', response);
    };
    req.followRedirect = () => { call.followed++; if (!call.aborted) queueMicrotask(respond); };
    req.end = () => queueMicrotask(() => { if (redirect) req.emit('redirect', 302, 'GET', redirect, {}); else respond(); });
    return req;
  };
  return {request, calls};
}
async function setup(t, options = {}, artifact = fixture(), network = fakeNetwork()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orb-codex-component-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const runtime = createCodexRuntime({userDataDir:root, request:network.request, platform:'win32', arch:'x64', ...options}, artifact);
  const directory = path.join(root, 'components', 'codex', artifact.version, 'win32-x64');
  return {runtime, root, directory, executable:path.join(directory, 'codex.exe'), ...network};
}
async function noPartials(directory) {
  try { assert.deepEqual((await fs.readdir(directory)).filter(name => name.endsWith('.tmp')), []); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const code = expected => error => error?.name === 'CodexRuntimeError' && error.code === expected &&
  !/sensitive-url|sig=|https:\/\//.test(error.message);

test('production pin fixes official archive and executable independently', () => {
  assert.equal(PINNED_CODEX_RUNTIME.version, '0.134.0');
  assert.equal(PINNED_CODEX_RUNTIME.archiveBytes, 84510636);
  assert.equal(PINNED_CODEX_RUNTIME.executableBytes, 240159536);
  assert.match(PINNED_CODEX_RUNTIME.url, /^https:\/\/github.com\/openai\/codex\/releases\/download\/rust-v0.134.0\//);
  assert(Object.isFrozen(PINNED_CODEX_RUNTIME));
});
test('construction and missing-cache probes cause no download or directory creation', async t => {
  const s = await setup(t);
  assert.equal(await s.runtime.getVerifiedExecutable(), null);
  assert.equal(s.calls.length, 0);
  assert.deepEqual(await fs.readdir(s.root), []);
});
test('single official-shaped tar is streamed, checked and atomically cached without global installs', async t => {
  const s = await setup(t, {}, fixture(), fakeNetwork({parts:17}));
  const progress = [];
  assert.equal(await s.runtime.ensureReady({onProgress:state => progress.push(state)}), s.executable);
  assert.deepEqual(await fs.readFile(s.executable), EXE);
  assert.deepEqual(await fs.readdir(s.directory), ['codex.exe']);
  assert.equal(await s.runtime.getVerifiedExecutable(), s.executable);
  assert.equal(await s.runtime.ensureReady(), s.executable);
  assert.equal(s.calls.length, 1);
  assert.deepEqual([...new Set(progress.map(value => value.phase))], ['checking', 'downloading', 'verifying', 'installing']);
  const request = s.calls[0];
  assert.equal(request.followed, 1);
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.useSessionCookies, false);
  assert.equal(request.options.redirect, 'manual');
  assert.deepEqual(request.headers, {Accept:'application/octet-stream'});
});
test('same-size cache tampering is detected on every use and repaired only on explicit ensure', async t => {
  const s = await setup(t);
  await s.runtime.ensureReady();
  await fs.writeFile(s.executable, Buffer.alloc(EXE.length, 65));
  assert.equal(await s.runtime.getVerifiedExecutable(), null);
  assert.equal(s.calls.length, 1);
  await s.runtime.ensureReady();
  assert.equal(s.calls.length, 2);
  assert.deepEqual(await fs.readFile(s.executable), EXE);
});
test('a failed repair keeps the previous bytes and removes partial downloads', async t => {
  const good = gzipSync(tar());
  const bad = Buffer.from(good); bad[20] ^= 1;
  const s = await setup(t, {}, fixture(good), fakeNetwork({body:bad}));
  await fs.mkdir(s.directory, {recursive:true});
  await fs.writeFile(s.executable, 'previous-invalid-cache');
  await assert.rejects(s.runtime.ensureReady(), code('integrity'));
  assert.equal(await fs.readFile(s.executable, 'utf8'), 'previous-invalid-cache');
  await noPartials(s.directory);
});
for (const redirect of ['http://release-assets.githubusercontent.com/github-production-release-asset/1/abc',
  'https://github.com.attacker.example/openai/codex', 'https://github.com/attacker/codex/releases/download/1/x',
  'https://user:password@release-assets.githubusercontent.com/github-production-release-asset/1/abc',
  'https://release-assets.githubusercontent.com:444/github-production-release-asset/1/abc',
  'https://release-assets.githubusercontent.com/arbitrary', 'https://example.com/asset',
  'file:///tmp/asset', 'https://release-assets.githubusercontent.com/github-production-release-asset/1/abc#fragment']) {
  test(`refuses untrusted redirect ${redirect.split('?')[0]}`, async t => {
    const s = await setup(t, {}, fixture(), fakeNetwork({redirect}));
    await assert.rejects(s.runtime.ensureReady(), code('integrity'));
    assert.equal(s.calls[0].followed, 0);
    await noPartials(s.directory);
  });
}
test('redirect loops stop before a fifth follow', async t => {
  const network = fakeNetwork();
  const original = network.request;
  network.request = options => {
    const req = original(options);
    req.followRedirect = () => { network.calls[0].followed++; queueMicrotask(() => req.emit('redirect', 302, 'GET', CDN)); };
    return req;
  };
  const s = await setup(t, {}, fixture(), network);
  await assert.rejects(s.runtime.ensureReady(), code('integrity'));
  assert.equal(s.calls[0].followed, 4);
});
for (const [name, body, headers] of [
  ['too much streamed data without Content-Length', Buffer.concat([gzipSync(tar()), Buffer.from('extra')]), {}],
  ['short streamed data without Content-Length', gzipSync(tar()).subarray(0, 20), {}],
  ['dishonest Content-Length', gzipSync(tar()), {'content-length':'999'}],
  ['duplicate Content-Length', gzipSync(tar()), {'content-length':['1', '2']}]
]) test(`bounds and rejects ${name}`, async t => {
  const s = await setup(t, {}, fixture(), fakeNetwork({body, headers}));
  await assert.rejects(s.runtime.ensureReady(), code('integrity'));
  await noPartials(s.directory);
});
for (const [name, raw] of [
  ['path traversal', tar(EXE, {name:'../codex.exe'})],
  ['absolute path', tar(EXE, {name:'/codex.exe'})],
  ['Windows traversal', tar(EXE, {name:'..\\codex.exe'})],
  ['symlink member', tar(EXE, {type:50})],
  ['hardlink member', tar(EXE, {type:49})],
  ['directory member', tar(EXE, {type:53})],
  ['PAX member', tar(EXE, {type:120})],
  ['mismatched expanded size', tar(EXE, {size:EXE.length + 1})],
  ['invalid header checksum', tar(EXE, {checksum:false})],
  ['second file', tar(EXE, {suffix:tar(Buffer.from('second'))})],
  ['truncated archive', tar().subarray(0, 900)],
  ['excessive decompression padding', Buffer.concat([tar(), Buffer.alloc(128 * 1024)])]
]) test(`rejects archive ${name} even with matching compressed hash`, async t => {
  const archive = gzipSync(raw);
  const s = await setup(t, {}, fixture(archive), fakeNetwork({body:archive}));
  await assert.rejects(s.runtime.ensureReady(), code('integrity'));
  assert.equal(await s.runtime.getVerifiedExecutable(), null);
  await noPartials(s.directory);
});
test('rejects additional gzip member containing an extra executable', async t => {
  const archive = Buffer.concat([gzipSync(tar()), gzipSync(tar())]);
  const s = await setup(t, {}, fixture(archive), fakeNetwork({body:archive}));
  await assert.rejects(s.runtime.ensureReady(), code('integrity'));
  await noPartials(s.directory);
});
test('expanded executable has its own hash check after a valid archive hash', async t => {
  const wrong = Buffer.alloc(EXE.length, 88);
  const archive = gzipSync(tar(wrong));
  const s = await setup(t, {}, fixture(archive), fakeNetwork({body:archive}));
  await assert.rejects(s.runtime.ensureReady(), code('integrity'));
  await noPartials(s.directory);
});
test('pre-cancelled requests make no connection', async t => {
  const s = await setup(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(s.runtime.ensureReady({signal:controller.signal}), code('cancelled'));
  assert.equal(s.calls.length, 0);
});
test('cancellation during streaming removes partial bytes and never installs', async t => {
  const s = await setup(t, {}, fixture(), fakeNetwork({parts:32}));
  const controller = new AbortController();
  await assert.rejects(s.runtime.ensureReady({signal:controller.signal, onProgress:value => {
    if (value.phase === 'downloading' && value.receivedBytes) controller.abort();
  }}), code('cancelled'));
  assert.equal(await s.runtime.getVerifiedExecutable(), null);
  await noPartials(s.directory);
});
test('cancel after verified download but before extraction never installs', async t => {
  const s = await setup(t);
  const controller = new AbortController();
  await assert.rejects(s.runtime.ensureReady({signal:controller.signal, onProgress:value => {
    if (value.phase === 'verifying') controller.abort();
  }}), code('cancelled'));
  assert.equal(await s.runtime.getVerifiedExecutable(), null);
  await noPartials(s.directory);
});
test('stalled network is bounded and concurrent preparation is refused', async t => {
  const s = await setup(t, {idleTimeoutMs:20}, fixture(), fakeNetwork({stall:true}));
  const pending = s.runtime.ensureReady();
  await assert.rejects(s.runtime.ensureReady(), code('busy'));
  await assert.rejects(pending, code('timeout'));
  await noPartials(s.directory);
});
test('network failures are reduced to fixed messages and remove partial files', async t => {
  const s = await setup(t, {}, fixture(), fakeNetwork({responseError:true}));
  await assert.rejects(s.runtime.ensureReady(), code('network'));
  await noPartials(s.directory);
});
test('unsupported architecture never downloads', async t => {
  const s = await setup(t, {arch:'arm64'});
  await assert.rejects(s.runtime.ensureReady(), code('unsupported'));
  assert.equal(s.calls.length, 0);
});
test('component directory cannot be a symlink to another profile', async t => {
  const s = await setup(t);
  const external = await fs.mkdtemp(path.join(os.tmpdir(), 'orb-codex-other-'));
  t.after(() => fs.rm(external, {recursive:true, force:true}));
  await fs.symlink(external, path.join(s.root, 'components'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(s.runtime.ensureReady(), code('storage'));
  assert.equal(s.calls.length, 0);
  assert.deepEqual(await fs.readdir(external), []);
});
test('cache executable cannot be a hardlink to another file', async t => {
  const s = await setup(t);
  await fs.mkdir(s.directory, {recursive:true});
  const external = path.join(s.root, 'shared.exe'); await fs.writeFile(external, EXE);
  await fs.link(external, s.executable);
  await assert.rejects(s.runtime.getVerifiedExecutable(), code('storage'));
  await assert.rejects(s.runtime.ensureReady(), code('storage'));
  assert.equal(s.calls.length, 0);
  assert.deepEqual(await fs.readFile(external), EXE);
});
test('manifest can never choose a path, untrusted host or unbounded executable', () => {
  for (const artifact of [{...fixture(), version:'../../escape'}, {...fixture(), member:'../x.exe'},
    {...fixture(), url:'https://example.com/component.tar.gz'}, {...fixture(), executableBytes:Infinity}]) {
    assert.throws(() => createCodexRuntime({userDataDir:os.tmpdir()}, artifact), /Invalid pinned component/);
  }
});
