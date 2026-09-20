'use strict';

// The browser loads this stable directory once. Updating it never executes code
// or reloads the browser: the user explicitly reloads their installed extension.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const identity = require('../extension-identity.json');

const FILES = Object.freeze(['collector.js', 'manifest.json', 'parser.js', 'popup.css', 'popup.html', 'popup.js', 'sw.js']);
const CSP = "default-src 'self'; script-src 'self'; object-src 'none'; connect-src http://127.0.0.1:43861; img-src 'self'; style-src 'self'; base-uri 'none'; frame-src 'none'; form-action 'none'";

function sameKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
}

function validateManifest(manifest) {
  const baseKeys = ['manifest_version', 'name', 'version', 'minimum_chrome_version',
    'description', 'key', 'permissions', 'host_permissions', 'background', 'action', 'content_security_policy'];
  // Both complete schemas are intentional: an existing legacy bundle must be
  // readable to preserve it during migration. Mixed or broader grants fail.
  const legacy = sameKeys(manifest, baseKeys)
    && JSON.stringify(manifest.permissions) === JSON.stringify(['activeTab', 'scripting', 'storage']);
  const scheduled = sameKeys(manifest, [...baseKeys, 'optional_host_permissions'])
    && JSON.stringify(manifest.permissions) === JSON.stringify(['activeTab', 'scripting', 'storage', 'alarms'])
    && JSON.stringify(manifest.optional_host_permissions) === JSON.stringify(['https://chatgpt.com/*']);
  if ((!legacy && !scheduled)
    || manifest.manifest_version !== 3 || manifest.key !== identity.publicKey
    || !/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(manifest.version)
    || manifest.version.split('.').some(part => Number(part) > 65535)
    || JSON.stringify(manifest.host_permissions) !== JSON.stringify(['http://127.0.0.1/*'])
    || !sameKeys(manifest.background, ['service_worker']) || manifest.background.service_worker !== 'sw.js'
    || !sameKeys(manifest.action, ['default_popup', 'default_title']) || manifest.action.default_popup !== 'popup.html'
    || !sameKeys(manifest.content_security_policy, ['extension_pages']) || manifest.content_security_policy.extension_pages !== CSP) {
    throw new Error('INVALID_EXTENSION');
  }
  return manifest;
}

async function directoryExists(directory) {
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('UNSAFE_DIRECTORY');
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function readBundle(directory) {
  if (!await directoryExists(directory)) throw new Error('MISSING_EXTENSION');
  const entries = await fs.readdir(directory, { withFileTypes: true });
  if (entries.length !== FILES.length || entries.some(entry => !FILES.includes(entry.name)
    || !entry.isFile() || entry.isSymbolicLink())) throw new Error('UNSAFE_BUNDLE');
  const files = new Map();
  for (const name of FILES) {
    const file = path.join(directory, name);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('UNSAFE_BUNDLE');
    files.set(name, await fs.readFile(file));
  }
  const manifest = validateManifest(JSON.parse(files.get('manifest.json').toString('utf8')));
  return { version: manifest.version, files };
}

async function writeBundle(directory, files) {
  await fs.mkdir(directory, { mode: 0o700 });
  for (const [name, bytes] of files) {
    const file = await fs.open(path.join(directory, name), 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
  }
  // Windows does not support fsync on all directory handles.
  let handle;
  try { handle = await fs.open(directory, 'r'); await handle.sync(); }
  catch (error) { if (!['EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM', 'EACCES'].includes(error.code)) throw error; }
  finally { await handle?.close(); }
}

function newerThan(left, right) {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

async function syncExtension({ sourceDir, userData }) {
  const root = path.resolve(userData);
  const target = path.join(root, 'Browser-Extension');
  const backup = path.join(root, 'Browser-Extension.previous');
  const stage = path.join(root, `.Browser-Extension-stage-${randomBytes(10).toString('hex')}`);
  let previous = null;
  let movedOld = false;
  let installed = false;
  let createdStage = false;
  try {
    if (!await directoryExists(root)) await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const hasTarget = await directoryExists(target);
    // An interrupted prior rename may have left only the complete backup.
    if (!hasTarget && await directoryExists(backup)) await fs.rename(backup, target);
    if (await directoryExists(target)) previous = await readBundle(target);
    const source = await readBundle(path.resolve(sourceDir));
    if (previous) {
      // Opening an older portable desktop copy must not silently roll back an
      // already updated extension shared by all copies of the app.
      if (newerThan(previous.version, source.version)) {
        return { path: target, version: previous.version, changed: false };
      }
      if (previous.version === source.version && FILES.every(name => previous.files.get(name).equals(source.files.get(name)))) {
        return { path: target, version: previous.version, changed: false };
      }
    }
    await writeBundle(stage, source.files);
    createdStage = true;
    await readBundle(stage);
    if (await directoryExists(backup)) await fs.rm(backup, { recursive: true });
    if (previous) { await fs.rename(target, backup); movedOld = true; }
    await fs.rename(stage, target);
    installed = true;
    return { path: target, version: source.version, changed: true };
  } catch {
    if (movedOld && !installed) {
      try { await fs.rename(backup, target); }
      catch {
        return { path: target, version: null, changed: false,
          error: '扩展目录更新未完成，旧版仍保留在 Browser-Extension.previous。请关闭浏览器后重新启动悬浮球以恢复。' };
      }
    }
    return { path: target, version: previous?.version || null, changed: false,
      error: '扩展目录无法安全更新，未替换原有文件。请关闭浏览器后重新启动悬浮球；若仍失败，请检查目录权限。' };
  } finally {
    // Clean only our random staging directory; never follow an existing link.
    if (!installed) {
      try {
        if (createdStage || await directoryExists(stage)) await fs.rm(stage, { recursive: true, force: true });
      } catch {}
    }
  }
}

module.exports = { syncExtension };
