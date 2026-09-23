'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {createHash, randomBytes} = require('node:crypto');
const {Transform} = require('node:stream');
const {pipeline} = require('node:stream/promises');
const {createGunzip} = require('node:zlib');

// Reviewed official release metadata, not a remotely replaceable latest manifest.
// GitHub asset IDs: archive 430436498, executable 430436520 (rust-v0.134.0).
const PINNED_CODEX_RUNTIME = Object.freeze({
  version:'0.134.0', platform:'win32', arch:'x64',
  url:'https://github.com/openai/codex/releases/download/rust-v0.134.0/codex-x86_64-pc-windows-msvc.exe.tar.gz',
  archiveBytes:84510636,
  archiveSha256:'4bbcd30139d026fde8b52f8a70c1bce9149fe09c7c19eab47ac3f491d54af26e',
  member:'codex-x86_64-pc-windows-msvc.exe',
  executableBytes:240159536,
  executableSha256:'1766ac7dfbf4c7ddb26380e55f52c6c83847a9724294d88902ea3c5650fec134'
});
const MESSAGES = Object.freeze({
  unsupported:'一键连接目前支持 Windows 64 位。',
  cancelled:'已取消准备连接组件。',
  busy:'连接组件正在准备中。',
  network:'连接组件下载未完成，请检查网络后重试。',
  timeout:'连接组件下载超时，请稍后重试。',
  integrity:'连接组件校验未通过，请重试下载。',
  storage:'无法安全保存连接组件，请检查应用数据目录。',
  missing:'请先点击连接，准备官方连接组件。'
});
class CodexRuntimeError extends Error {
  constructor(code) { super(MESSAGES[code] || MESSAGES.storage); this.name = 'CodexRuntimeError'; this.code = code; }
}
function fail(code) { throw new CodexRuntimeError(code); }
function cancelled(signal) { if (signal?.aborted) fail('cancelled'); }
function translate(error, signal) {
  if (signal?.aborted || error?.name === 'AbortError') return new CodexRuntimeError('cancelled');
  return error instanceof CodexRuntimeError ? error : new CodexRuntimeError('storage');
}
function report(onProgress, phase, receivedBytes, totalBytes) {
  // Progress carries no URL, credentials, user profile or raw exception text.
  try { onProgress?.({phase, receivedBytes, totalBytes, percent:totalBytes ? Math.floor(receivedBytes / totalBytes * 100) : 0}); } catch {}
}
function plainFile(stat) { return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1; }
async function statOrNull(file) {
  try { return await fsp.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function safeDirectory(root, parts, create) {
  // userData is chosen by Electron, never by the renderer. Reject links/junctions
  // in the component subtree and refuse to adopt an existing file as a directory.
  const initial = await statOrNull(root);
  if (!initial || !initial.isDirectory() || initial.isSymbolicLink()) fail('storage');
  const realRoot = await fsp.realpath(root);
  let directory = root;
  for (const part of parts) {
    directory = path.join(directory, part);
    if (create) { try { await fsp.mkdir(directory, {mode:0o700}); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
    const stat = await statOrNull(directory);
    if (!stat) return null;
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('storage');
    const relative = path.relative(realRoot, await fsp.realpath(directory));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('storage');
  }
  return directory;
}
async function hashFile(file, size, signal) {
  cancelled(signal);
  const before = await statOrNull(file);
  if (!before) return null;
  if (!plainFile(before)) fail('storage');
  if (before.size !== size) return null;
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let stream;
  try {
    const opened = await handle.stat();
    if (!plainFile(opened) || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== size) fail('storage');
    const digest = createHash('sha256');
    let bytes = 0;
    stream = handle.createReadStream({autoClose:false});
    for await (const chunk of stream) {
      cancelled(signal); bytes += chunk.length;
      if (bytes > size) fail('integrity');
      digest.update(chunk);
    }
    const after = await handle.stat();
    const current = await fsp.lstat(file);
    if (!plainFile(current) || current.dev !== before.dev || current.ino !== before.ino || after.size !== size ||
      after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) fail('storage');
    return bytes === size ? digest.digest('hex') : null;
  } finally { stream?.destroy(); await handle.close(); }
}
function allowedRedirect(raw, initial) {
  let url;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
  if (url.href === initial) return true;
  return ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname) &&
    /^\/github-production-release-asset\/\d+\/[A-Za-z0-9-]+$/.test(url.pathname);
}

async function downloadArchive({request, artifact, destination, signal, onProgress, timeoutMs, idleTimeoutMs}) {
  cancelled(signal);
  const handle = await fsp.open(destination, 'wx', 0o600);
  let requestHandle, responseStream, sink, finished = false, timeout, idle;
  try {
    await new Promise((resolve, reject) => {
      const finish = error => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout); clearTimeout(idle);
        signal?.removeEventListener('abort', onAbort);
        if (error) {
          try { requestHandle?.abort(); } catch {}
          responseStream?.destroy(); sink?.destroy();
          reject(error instanceof CodexRuntimeError ? error : new CodexRuntimeError('network'));
        } else resolve();
      };
      const onAbort = () => finish(new CodexRuntimeError('cancelled'));
      const touch = () => { clearTimeout(idle); idle = setTimeout(() => finish(new CodexRuntimeError('timeout')), idleTimeoutMs); };
      timeout = setTimeout(() => finish(new CodexRuntimeError('timeout')), timeoutMs);
      touch();
      signal?.addEventListener('abort', onAbort, {once:true});
      if (signal?.aborted) return onAbort();
      let redirects = 0;
      try {
        // Electron's network stack honors the user's system proxy. Credentials and
        // cookies are explicitly omitted, including on the CDN redirect request.
        requestHandle = request({url:artifact.url, method:'GET', redirect:'manual', credentials:'omit', useSessionCookies:false});
        requestHandle.setHeader('Accept', 'application/octet-stream');
        requestHandle.on('error', () => finish(new CodexRuntimeError('network')));
        requestHandle.on('abort', () => finish(new CodexRuntimeError('network')));
        requestHandle.on('login', (_info, callback) => { callback(); finish(new CodexRuntimeError('network')); });
        requestHandle.on('redirect', (_status, method, redirectUrl) => {
          if (finished) return;
          if (++redirects > 4 || method !== 'GET' || !allowedRedirect(redirectUrl, artifact.url)) return finish(new CodexRuntimeError('integrity'));
          touch(); requestHandle.followRedirect();
        });
        requestHandle.on('response', response => {
          if (finished) { response.destroy(); return; }
          responseStream = response;
          const header = response.headers?.['content-length'];
          const length = Array.isArray(header) ? (header.length === 1 ? header[0] : 'invalid') : header;
          if (response.statusCode !== 200 || (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) !== artifact.archiveBytes))) {
            finish(new CodexRuntimeError('integrity')); return;
          }
          let bytes = 0;
          const hash = createHash('sha256');
          let lastProgress = 0;
          const verify = new Transform({transform(chunk, _encoding, callback) {
            if (finished || signal?.aborted) return callback(new CodexRuntimeError('cancelled'));
            bytes += chunk.length;
            if (bytes > artifact.archiveBytes) return callback(new CodexRuntimeError('integrity'));
            hash.update(chunk); touch();
            if (Date.now() - lastProgress >= 150 || bytes === artifact.archiveBytes) {
              lastProgress = Date.now(); report(onProgress, 'downloading', bytes, artifact.archiveBytes);
            }
            callback(null, chunk);
          }});
          sink = handle.createWriteStream({autoClose:false});
          pipeline(response, verify, sink).then(() => {
            if (bytes !== artifact.archiveBytes || hash.digest('hex') !== artifact.archiveSha256) finish(new CodexRuntimeError('integrity'));
            else finish();
          }, finish);
        });
        requestHandle.end();
      } catch { finish(new CodexRuntimeError('network')); }
    });
    await handle.sync();
  } finally { sink?.destroy(); await handle.close(); }
}

function octal(field) {
  const value = field.toString('ascii').replace(/\0.*$/, '').trim();
  return /^[0-7]+$/.test(value) ? Number.parseInt(value, 8) : NaN;
}
function singleFileTar(artifact) {
  let header = Buffer.alloc(0), dataLeft = artifact.executableBytes, padding = 0, tailBytes = 0, total = 0;
  const maximum = artifact.executableBytes + 64 * 1024;
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        total += chunk.length;
        if (total > maximum) fail('integrity');
        let offset = 0;
        if (header.length < 512) {
          const take = Math.min(512 - header.length, chunk.length);
          header = Buffer.concat([header, chunk.subarray(0, take)]); offset += take;
          if (header.length < 512) return callback();
          const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
          let sum = 0;
          for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
          if (name !== artifact.member || header.subarray(257, 262).toString('ascii') !== 'ustar' ||
              !header.subarray(345, 500).every(byte => byte === 0) ||
              !header.subarray(157, 257).every(byte => byte === 0) || ![0, 48].includes(header[156]) ||
              octal(header.subarray(124, 136)) !== artifact.executableBytes || octal(header.subarray(148, 156)) !== sum) fail('integrity');
          padding = (512 - artifact.executableBytes % 512) % 512;
        }
        if (dataLeft) {
          const take = Math.min(dataLeft, chunk.length - offset);
          if (take) this.push(chunk.subarray(offset, offset + take));
          dataLeft -= take; offset += take;
        }
        if (!dataLeft && offset < chunk.length) {
          const remainder = chunk.subarray(offset);
          if (!remainder.every(byte => byte === 0)) fail('integrity');
          tailBytes += remainder.length;
        }
        callback();
      } catch (error) { callback(error); }
    },
    flush(callback) {
      callback(header.length === 512 && dataLeft === 0 && tailBytes >= padding + 1024 && total % 512 === 0 ? null : new CodexRuntimeError('integrity'));
    }
  });
}
async function extractExecutable(archive, destination, artifact, signal) {
  cancelled(signal);
  const handle = await fsp.open(destination, 'wx', 0o700);
  let sink;
  try {
    const hash = createHash('sha256');
    let bytes = 0;
    const verify = new Transform({transform(chunk, _encoding, callback) {
      bytes += chunk.length; hash.update(chunk); callback(null, chunk);
    }});
    try {
      sink = handle.createWriteStream({autoClose:false});
      await pipeline(fs.createReadStream(archive), createGunzip(), singleFileTar(artifact), verify, sink, {signal});
    } catch (error) { if (signal?.aborted) fail('cancelled'); if (error?.code === 'ENOSPC') fail('storage'); fail('integrity'); }
    if (bytes !== artifact.executableBytes || hash.digest('hex') !== artifact.executableSha256) fail('integrity');
    await handle.sync();
  } finally { sink?.destroy(); await handle.close(); }
}

/** Main-process API. Constructing/probing never downloads or invokes a process.
 * The second argument is an immutable fixture seam for tests, never renderer data.
 */
function createCodexRuntime({userDataDir, request, platform = process.platform, arch = process.arch,
  timeoutMs = 10 * 60 * 1000, idleTimeoutMs = 45 * 1000} = {}, artifact = PINNED_CODEX_RUNTIME) {
  if (typeof userDataDir !== 'string' || !path.isAbsolute(userDataDir)) throw new TypeError('Absolute userDataDir required');
  if (!/^\d+\.\d+\.\d+$/.test(artifact.version) || artifact.platform !== 'win32' || artifact.arch !== 'x64' ||
      !/^[A-Za-z0-9_.-]+\.exe$/.test(artifact.member) || !/^https:\/\/github\.com\/openai\/codex\/releases\/download\/rust-v[0-9.]+\/[A-Za-z0-9_.-]+\.tar\.gz$/.test(artifact.url) ||
      !['archiveSha256', 'executableSha256'].every(key => /^[a-f0-9]{64}$/.test(artifact[key])) ||
      !['archiveBytes', 'executableBytes'].every(key => Number.isSafeInteger(artifact[key]) && artifact[key] > 0 && artifact[key] < 512 * 1024 * 1024)) throw new TypeError('Invalid pinned component');
  artifact = Object.freeze({...artifact});
  const parts = ['components', 'codex', artifact.version, 'win32-x64'];
  const filename = 'codex.exe';
  let active = false;
  function supported() { if (platform !== artifact.platform || arch !== artifact.arch) fail('unsupported'); }
  async function getVerifiedExecutable({signal} = {}) {
    supported(); cancelled(signal);
    try {
      const directory = await safeDirectory(userDataDir, parts, false);
      if (!directory) return null;
      const executable = path.join(directory, filename);
      return await hashFile(executable, artifact.executableBytes, signal) === artifact.executableSha256 ? executable : null;
    } catch (error) { throw translate(error, signal); }
  }
  async function ensureReady({signal, onProgress} = {}) {
    supported(); cancelled(signal);
    if (active) fail('busy');
    active = true;
    let directory, archive, temporary;
    try {
      report(onProgress, 'checking', 0, artifact.archiveBytes);
      const cached = await getVerifiedExecutable({signal});
      if (cached) return cached;
      if (typeof request !== 'function') fail('network');
      directory = await safeDirectory(userDataDir, parts, true);
      const nonce = randomBytes(16).toString('hex');
      archive = path.join(directory, `.download-${nonce}.tmp`);
      temporary = path.join(directory, `.executable-${nonce}.tmp`);
      report(onProgress, 'downloading', 0, artifact.archiveBytes);
      await downloadArchive({request, artifact, destination:archive, signal, onProgress, timeoutMs, idleTimeoutMs});
      cancelled(signal);
      await safeDirectory(userDataDir, parts, false);
      report(onProgress, 'verifying', artifact.archiveBytes, artifact.archiveBytes);
      await extractExecutable(archive, temporary, artifact, signal);
      cancelled(signal);
      await safeDirectory(userDataDir, parts, false);
      const destination = path.join(directory, filename);
      const old = await statOrNull(destination);
      if (old && !plainFile(old)) fail('storage');
      report(onProgress, 'installing', artifact.archiveBytes, artifact.archiveBytes);
      cancelled(signal);
      await fsp.rename(temporary, destination);
      temporary = null;
      return destination;
    } catch (error) { throw translate(error, signal); }
    finally {
      // Never follow a substituted directory while removing partial files.
      if (directory) {
        try {
          if (await safeDirectory(userDataDir, parts, false) === directory) {
            for (const file of [archive, temporary]) if (file) { const stat = await statOrNull(file); if (stat && plainFile(stat)) await fsp.unlink(file); }
          }
        } catch {}
      }
      active = false;
    }
  }
  return Object.freeze({version:artifact.version, downloadBytes:artifact.archiveBytes, getVerifiedExecutable, ensureReady});
}

module.exports = {PINNED_CODEX_RUNTIME, CodexRuntimeError, createCodexRuntime};
