'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');

const TARGETS = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin'
};
const VERSION = /^\d+\.\d+\.\d+(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/i;

// These checks reduce ambiguous executable lookup; they do not authenticate an
// installation. The user must trust their local Codex installation and PATH.
function safePath(value, windows) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f]/.test(value)) return false;
  if (windows) {
    if (!/^[a-z]:[\\/]/i.test(value) || /[<>:"|?*]/.test(value.slice(2))) return false;
    return value.slice(3).split(/[\\/]/).every(part => !part || (
      part !== '.' && part !== '..' && !/[. ]$/.test(part) &&
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part)
    ));
  }
  return value.startsWith('/') && !value.startsWith('//') &&
    !value.split('/').some(part => part === '.' || part === '..');
}

/**
 * Discover a local native executable without running it, loading package code,
 * inspecting credentials, or scanning arbitrary directories. Options exist for
 * main-process tests only; do not expose them through renderer IPC.
 */
async function discoverCodex(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const target = TARGETS[`${platform}-${arch}`];
  if (!target) return null;
  const io = options.fs || fs;
  const env = options.env || process.env;
  const windows = platform === 'win32';
  const p = windows ? path.win32 : path.posix;
  const filename = windows ? 'codex.exe' : 'codex';
  const same = value => windows ? value.toLowerCase() : value;
  const inside = (root, file) => same(file).startsWith(same(root.endsWith(p.sep) ? root : root + p.sep));
  const environment = name => {
    const key = Object.keys(env).find(key => windows ? key.toLowerCase() === name.toLowerCase() : key === name);
    return key && typeof env[key] === 'string' ? env[key] : '';
  };
  const canonical = async input => {
    if (!safePath(input, windows)) return null;
    try {
      const result = await io.realpath(input);
      return safePath(result, windows) ? result : null;
    } catch { return null; }
  };

  // Bounded reads also reject directories, pipes and unreadable candidates.
  async function read(file, length, position = 0) {
    let handle;
    try {
      handle = await io.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile()) return null;
      const bytes = Buffer.alloc(length);
      const { bytesRead } = await handle.read(bytes, 0, length, position);
      return { bytes: bytes.subarray(0, bytesRead), stat };
    } catch { return null; }
    finally { if (handle) await handle.close().catch(() => {}); }
  }

  async function manifest(root) {
    const file = await canonical(p.join(root, 'package.json'));
    if (!file || !inside(root, file)) return null;
    const result = await read(file, 65537);
    if (!result || result.bytes.length > 65536) return null;
    try {
      const value = JSON.parse(result.bytes.toString('utf8'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch { return null; }
  }

  async function executable(input, root = null) {
    const file = await canonical(input);
    if (!file || (root && !inside(root, file)) || same(p.basename(file)) !== filename) return null;
    const result = await read(file, 64);
    if (!result || result.bytes.length < 4) return null;
    const { bytes, stat } = result;
    if (windows) {
      if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') return null;
      const offset = bytes.readUInt32LE(60);
      if (offset < 64 || offset > 1024 * 1024 || offset + 24 > stat.size) return null;
      const pe = await read(file, 24, offset);
      const machine = arch === 'arm64' ? 0xaa64 : 0x8664;
      if (!pe || pe.bytes.length !== 24 || pe.bytes.readUInt32LE(0) !== 0x00004550 ||
          pe.bytes.readUInt16LE(4) !== machine || !(pe.bytes.readUInt16LE(22) & 0x0002) ||
          (pe.bytes.readUInt16LE(22) & 0x2000)) return null;
    } else {
      if (!(stat.mode & 0o111)) return null;
      const magic = bytes.readUInt32BE(0);
      if (platform === 'linux' ? magic !== 0x7f454c46 :
        ![0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic)) return null;
    }
    return { path: file };
  }

  const entries = environment('PATH').slice(0, 32768).split(windows ? ';' : ':')
    .slice(0, 128).filter(value => safePath(value, windows));
  const packageRoots = [];
  const addPackage = prefix => {
    if (safePath(prefix, windows)) packageRoots.push(p.join(prefix, 'node_modules', '@openai', 'codex'));
  };
  if (windows && safePath(environment('APPDATA'), true)) addPackage(p.join(environment('APPDATA'), 'npm'));
  for (const entry of entries) {
    addPackage(entry);
    if (!windows && p.basename(entry) === 'bin') addPackage(p.join(p.dirname(entry), 'lib'));
  }

  const visited = new Set();
  for (const input of packageRoots) {
    const root = await canonical(input);
    if (!root || visited.has(same(root))) continue;
    visited.add(same(root));
    const main = await manifest(root);
    if (!main || main.name !== '@openai/codex' || !VERSION.test(main.version || '') ||
        main.bin?.codex !== 'bin/codex.js') continue;

    const suffix = `${platform}-${arch}`;
    const dependency = `@openai/codex-${suffix}`;
    const nativeVersion = `${main.version}-${suffix}`;
    const candidates = [];
    if (main.optionalDependencies?.[dependency] === `npm:@openai/codex@${nativeVersion}`) {
      // npm may nest optional dependencies or hoist them next to the main
      // package. A package-root symlink is allowed, as in common npm installs.
      const bases = [root, input];
      const nativeRoots = bases.flatMap(base => [
        p.join(base, 'node_modules', '@openai', `codex-${suffix}`),
        p.join(p.dirname(base), `codex-${suffix}`)
      ]);
      for (const candidate of new Set(nativeRoots)) {
        const nativeRoot = await canonical(candidate);
        if (!nativeRoot) continue;
        const native = await manifest(nativeRoot);
        if (native?.name === '@openai/codex' && native.version === nativeVersion &&
            Array.isArray(native.os) && native.os.includes(platform) &&
            Array.isArray(native.cpu) && native.cpu.includes(arch)) candidates.push(nativeRoot);
      }
    }
    candidates.push(root); // Legacy releases kept vendor inside the main package.
    for (const candidate of candidates) {
      // Current and historical layouts are both defined by OpenAI's launcher.
      // https://github.com/openai/codex/blob/rust-v0.134.0/codex-cli/bin/codex.js
      for (const directory of ['bin', 'codex']) {
        const found = await executable(p.join(candidate, 'vendor', target, directory, filename), candidate);
        if (found) return found;
      }
    }
  }

  // Direct installations are trusted local native files, not verified releases.
  // Never invoke a PATH shell shim (codex.cmd, codex.ps1, codex.js or a shebang).
  for (const entry of new Set(entries)) {
    const found = await executable(p.join(entry, filename));
    if (found) return found;
  }
  return null;
}

module.exports = { discoverCodex };
