'use strict';

// This module has no Electron dependency. The trust anchor is shipped with the
// application, never read from user preferences or supplied by a renderer.
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const MAX_ENVELOPE = 64 * 1024;
const MAX_INSTALLER = 1024 * 1024 * 1024;
const VERSION = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/;
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

class UpdateSecurityError extends Error {
  constructor(code) { super(code); this.name = 'UpdateSecurityError'; this.code = code; }
}
function fail(code) { throw new UpdateSecurityError(code); }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, keys) {
  return record(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}
function compareVersions(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !VERSION.test(a) || !VERSION.test(b)) fail('VERSION');
  const aa = a.split('.').map(Number), bb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
  return 0;
}
function validateConfig(input) {
  if (!exactKeys(input, ['schema', 'repository', 'publicKey', 'channel']) || input.schema !== 1 || input.channel !== 'stable') fail('CONFIG');
  if (input.repository === null && input.publicKey === null) return null;
  if (typeof input.repository !== 'string' || !REPOSITORY.test(input.repository) ||
      typeof input.publicKey !== 'string' || input.publicKey.length > 4096 ||
      !input.publicKey.startsWith('-----BEGIN PUBLIC KEY-----')) fail('CONFIG');
  let key;
  try { key = crypto.createPublicKey(input.publicKey); } catch { fail('CONFIG'); }
  if (key.asymmetricKeyType !== 'ed25519') fail('CONFIG');
  return Object.freeze({ schema: 1, repository: input.repository, publicKey: input.publicKey, channel: 'stable', key });
}
function base64(value, size) {
  if (typeof value !== 'string' || !value.length || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail('ENCODING');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (size !== undefined && bytes.length !== size)) fail('ENCODING');
  return bytes;
}
function parseUtf8(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('MANIFEST'); }
}
function verifyEnvelope(body, config) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (!bytes.length || bytes.length > MAX_ENVELOPE) fail('MANIFEST_SIZE');
  const envelope = parseUtf8(bytes);
  if (!exactKeys(envelope, ['payload', 'signature'])) fail('MANIFEST');
  const payloadBytes = base64(envelope.payload), signature = base64(envelope.signature, 64);
  // Authenticate the exact published bytes BEFORE interpreting the payload.
  if (!crypto.verify(null, payloadBytes, config.key, signature)) fail('SIGNATURE');
  const p = parseUtf8(payloadBytes);
  if (!exactKeys(p, ['schema', 'version', 'tag', 'platform', 'arch', 'file', 'size', 'sha256', 'sha512', 'publishedAt']) ||
      p.schema !== 1 || typeof p.version !== 'string' || !VERSION.test(p.version) || p.tag !== `v${p.version}` ||
      p.platform !== 'win32' || p.arch !== 'x64' || p.file !== `GPT-Orb-Setup-${p.version}-x64.exe` ||
      !Number.isSafeInteger(p.size) || p.size < 1 || p.size > MAX_INSTALLER ||
      typeof p.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.sha256) ||
      typeof p.publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(p.publishedAt) ||
      !Number.isFinite(Date.parse(p.publishedAt))) fail('MANIFEST');
  base64(p.sha512, 64);
  return Object.freeze({ ...p });
}
// Mac has an intentionally separate schema boundary. Adding it must not allow a
// DMG (or another architecture) through the existing Windows updater verifier.
function verifyMacEnvelope(body, config, arch) {
  if (arch !== 'arm64' && arch !== 'x64') fail('ARCH');
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (!bytes.length || bytes.length > MAX_ENVELOPE) fail('MANIFEST_SIZE');
  const envelope = parseUtf8(bytes);
  if (!exactKeys(envelope, ['payload', 'signature'])) fail('MANIFEST');
  const payloadBytes = base64(envelope.payload), signature = base64(envelope.signature, 64);
  if (!crypto.verify(null, payloadBytes, config.key, signature)) fail('SIGNATURE');
  const p = parseUtf8(payloadBytes);
  if (!exactKeys(p, ['schema', 'version', 'tag', 'platform', 'arch', 'file', 'size', 'sha256', 'sha512', 'publishedAt']) ||
      p.schema !== 1 || typeof p.version !== 'string' || !VERSION.test(p.version) || p.tag !== `v${p.version}` ||
      p.platform !== 'darwin' || p.arch !== arch || p.file !== `GPT-Orb-Setup-${p.version}-${arch}.dmg` ||
      !Number.isSafeInteger(p.size) || p.size < 1 || p.size > MAX_INSTALLER ||
      typeof p.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.sha256) ||
      typeof p.publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(p.publishedAt) ||
      !Number.isFinite(Date.parse(p.publishedAt))) fail('MANIFEST');
  base64(p.sha512, 64);
  return Object.freeze({ ...p });
}
function allowedMacManifestUrl(value, repository, arch, allowAssetHost = false) {
  if (typeof value !== 'string' || !REPOSITORY.test(repository) || !['arm64', 'x64'].includes(arch)) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  const authority = value.match(/^https:\/\/([^/?#]+)/)?.[1];
  if (!authority || authority.includes(':') || authority.includes('@') || /[\s\\]/.test(value) ||
      url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
  if (allowAssetHost && ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)) return true;
  if (url.hostname !== 'github.com' || url.search) return false;
  const prefix = `/${repository}/releases/`, file = `orb-update-mac-${arch}.json`;
  if (!url.pathname.startsWith(prefix)) return false;
  const tail = url.pathname.slice(prefix.length);
  if (tail === `latest/download/${file}`) return true;
  const parts = tail.split('/');
  return parts.length === 3 && parts[0] === 'download' && parts[2] === file &&
    parts[1].startsWith('v') && VERSION.test(parts[1].slice(1));
}
async function fetchMacManifest(url, { repository, arch, signal, request = https.get } = {}) {
  // Unlike the browser opening action, this fetch follows redirects itself and
  // validates every target before making a request. No browser/account cookies.
  const follow = (value, redirects) => new Promise((resolve, reject) => {
    if (redirects > 5 || !allowedMacManifestUrl(value, repository, arch, redirects > 0))
      return reject(new UpdateSecurityError('URL'));
    if (signal?.aborted) return reject(new UpdateSecurityError('CANCELLED'));
    let requestObject, responseObject, timer, settled = false;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const done = (err, data) => {
      if (settled) return;
      settled = true; cleanup();
      err ? reject(err) : resolve(data);
    };
    const abort = () => {
      done(new UpdateSecurityError('CANCELLED'));
      responseObject?.destroy(); requestObject?.destroy();
    };
    try {
      requestObject = request(value, { headers: { Accept: 'application/json', 'Cache-Control': 'no-cache', 'User-Agent': 'GPT-Usage-Orb-Updater' } }, response => {
        responseObject = response;
        response.on('error', () => done(new UpdateSecurityError('NETWORK')));
        response.on('aborted', () => done(new UpdateSecurityError('NETWORK')));
        if (settled) { response.destroy(); return; }
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          const location = response.headers.location;
          response.resume();
          if (typeof location !== 'string') return done(new UpdateSecurityError('URL'));
          let next;
          try { next = new URL(location, value).href; } catch { return done(new UpdateSecurityError('URL')); }
          settled = true; cleanup();
          follow(next, redirects + 1).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) { response.resume(); return done(new UpdateSecurityError('NETWORK')); }
        const length = response.headers['content-length'];
        if (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length) || Number(length) > MAX_ENVELOPE)) {
          done(new UpdateSecurityError('MANIFEST_SIZE')); response.destroy(); return;
        }
        const encoding = response.headers['content-encoding'];
        if (encoding && encoding !== 'identity') { done(new UpdateSecurityError('MANIFEST')); response.destroy(); return; }
        const chunks = []; let total = 0;
        response.on('data', chunk => {
          if (settled) return;
          total += chunk.length;
          if (total > MAX_ENVELOPE) { done(new UpdateSecurityError('MANIFEST_SIZE')); response.destroy(); }
          else chunks.push(chunk);
        });
        response.on('end', () => done(total === 0 || (length !== undefined && total !== Number(length))
          ? new UpdateSecurityError('MANIFEST_SIZE') : null, Buffer.concat(chunks)));
      });
      requestObject.on('error', () => done(new UpdateSecurityError('NETWORK')));
      if (settled) return;
      timer = setTimeout(() => {
        done(new UpdateSecurityError('TIMEOUT')); responseObject?.destroy(); requestObject?.destroy();
      }, 20000);
      timer.unref?.();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    } catch { done(new UpdateSecurityError('NETWORK')); }
  });
  return follow(url, 0);
}
function releaseBase(repository, payload) { return `https://github.com/${repository}/releases/download/${payload.tag}/`; }
function allowedUpdateUrl(value, repository, expectedPath) {
  let url;
  try { url = new URL(value); } catch { return false; }
  // Reject even explicit :443, URL credentials and fragments. Nothing in this
  // updater needs to talk to a private host or to an arbitrary GitHub repository.
  const authority = String(value).match(/^https:\/\/([^/?#]+)/i)?.[1];
  if (url.protocol !== 'https:' || !authority || authority.includes(':') || authority.includes('@') ||
      url.username || url.password || url.port || url.hash) return false;
  if (url.hostname === 'release-assets.githubusercontent.com' || url.hostname === 'objects.githubusercontent.com') return true;
  if (url.hostname !== 'github.com') return false;
  if (expectedPath) return url.pathname === expectedPath;
  const prefix = `/${repository}/releases/`;
  if (!url.pathname.startsWith(prefix)) return false;
  const tail = url.pathname.slice(prefix.length);
  return tail === 'latest/download/orb-update.json' || /^download\/v(?:0|[1-9]\d{0,7})\.(?:0|[1-9]\d{0,7})\.(?:0|[1-9]\d{0,7})\/orb-update\.json$/.test(tail);
}
function assetMatches(value, config, p) {
  return value === p.file || value === `${releaseBase(config.repository, p)}${p.file}`;
}
function validateUpdateInfo(info, config, p) {
  if (!record(info) || info.version !== p.version || Object.hasOwn(info, 'packages') ||
      !Array.isArray(info.files) || info.files.length !== 1 ||
      (Object.hasOwn(info, 'path') && !assetMatches(info.path, config, p)) ||
      (Object.hasOwn(info, 'sha512') && info.sha512 !== p.sha512)) fail('FEED_MISMATCH');
  const file = info.files[0];
  if (!record(file) || !assetMatches(file.url, config, p) || file.sha512 !== p.sha512 || file.size !== p.size ||
      Object.hasOwn(file, 'packageInfo') || file.isAdminRightsRequired === true) fail('FEED_MISMATCH');
  return info;
}
async function fetchManifest(url, { repository, signal, request = https.get } = {}) {
  const follow = (value, redirects) => new Promise((resolve, reject) => {
    if (redirects > 5 || !allowedUpdateUrl(value, repository)) return reject(new UpdateSecurityError('URL'));
    if (signal?.aborted) return reject(new UpdateSecurityError('CANCELLED'));
    let requestObject, timer;
    const done = (err, data) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      err ? reject(err) : resolve(data);
    };
    const abort = () => requestObject?.destroy(new UpdateSecurityError('CANCELLED'));
    try {
      requestObject = request(value, { headers: { Accept: 'application/json', 'Cache-Control': 'no-cache', 'User-Agent': 'GPT-Usage-Orb-Updater' } }, response => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          const location = response.headers.location;
          response.resume();
          if (typeof location !== 'string') return done(new UpdateSecurityError('URL'));
          let next;
          try { next = new URL(location, value).href; } catch { return done(new UpdateSecurityError('URL')); }
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          follow(next, redirects + 1).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) { response.resume(); return done(new UpdateSecurityError('NETWORK')); }
        const length = Number(response.headers['content-length']);
        if (length > MAX_ENVELOPE) { response.destroy(); return done(new UpdateSecurityError('MANIFEST_SIZE')); }
        const chunks = []; let total = 0;
        response.on('data', chunk => {
          total += chunk.length;
          if (total > MAX_ENVELOPE) { response.destroy(); done(new UpdateSecurityError('MANIFEST_SIZE')); }
          else chunks.push(chunk);
        });
        response.on('end', () => done(null, Buffer.concat(chunks)));
        response.on('error', error => done(error));
        response.on('aborted', () => done(new UpdateSecurityError('NETWORK')));
      });
      requestObject.on('error', error => done(error));
      timer = setTimeout(() => requestObject.destroy(new UpdateSecurityError('TIMEOUT')), 20000);
      timer.unref?.();
      signal?.addEventListener('abort', abort, { once: true });
    } catch (error) { done(error); }
  });
  return follow(url, 0);
}
async function verifyInstaller(filename, p) {
  const beforePath = await fs.promises.lstat(filename);
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.size !== p.size) fail('INSTALLER');
  const handle = await fs.promises.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== p.size || before.ino !== beforePath.ino || before.dev !== beforePath.dev) fail('INSTALLER');
    const a = crypto.createHash('sha256'), b = crypto.createHash('sha512');
    const buffer = Buffer.alloc(1024 * 1024); let offset = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      offset += bytesRead;
      if (offset > p.size) fail('INSTALLER');
      a.update(buffer.subarray(0, bytesRead)); b.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat(), afterPath = await fs.promises.lstat(filename);
    if (offset !== p.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        !afterPath.isFile() || afterPath.isSymbolicLink() || afterPath.ino !== before.ino || afterPath.dev !== before.dev ||
        afterPath.size !== before.size || afterPath.mtimeMs !== before.mtimeMs ||
        a.digest('hex') !== p.sha256 || b.digest('base64') !== p.sha512) fail('INSTALLER');
  } finally { await handle.close(); }
  return true;
}
module.exports = { MAX_ENVELOPE, MAX_INSTALLER, UpdateSecurityError, compareVersions, validateConfig, verifyEnvelope,
  releaseBase, allowedUpdateUrl, validateUpdateInfo, fetchManifest, verifyInstaller,
  verifyMacEnvelope, allowedMacManifestUrl, fetchMacManifest };
