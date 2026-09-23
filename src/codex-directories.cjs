'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

class CodexDirectoriesError extends Error {
  constructor() {
    super('无法安全使用本机连接目录，请检查应用数据目录。');
    this.name = 'CodexDirectoriesError';
    this.code = 'storage';
  }
}
const fail = () => { throw new CodexDirectoriesError(); };
const samePath = (left, right) => path.relative(left, right) === '';
async function directory(file) {
  let stat;
  try { stat = await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  // Windows junctions are links too. In particular, never allow the managed
  // home to resolve to an existing CLI home and share its keyring namespace.
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
  return {stat, real:await fs.realpath(file)};
}
async function childDirectory(root, name) {
  const value = await directory(path.join(root.file, name));
  if (!value) return null;
  const relative = path.relative(root.real, value.real);
  if (path.dirname(relative) !== '.' ||
      (process.platform === 'win32' ? relative.toLowerCase() !== name.toLowerCase() : relative !== name)) fail();
  return value;
}
async function unchangedRoot(root) {
  const current = await directory(root.file);
  if (!current || current.stat.dev !== root.stat.dev || current.stat.ino !== root.stat.ino || !samePath(current.real, root.real)) fail();
}

/** Validate app-owned directories before any managed child is spawned.
 * A read-only probe never creates directories. Creation is reserved for the
 * explicit Connect path; this module performs no work merely by being loaded.
 */
async function prepareManagedDirectories(userDataDir, options = {}) {
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) fail();
    const create = options.create === undefined ? true : options.create;
    if (typeof userDataDir !== 'string' || !path.isAbsolute(userDataDir) || /[\u0000-\u001f]/.test(userDataDir) || typeof create !== 'boolean') fail();
    const initial = await directory(userDataDir);
    if (!initial) fail();
    const root = {...initial, file:userDataDir};
    const names = ['codex-managed-home', 'codex-query'];
    // Inspect both existing entries before creating either missing entry. An
    // unsafe sibling must not cause changes in the old CLI's directory.
    const existing = await Promise.all(names.map(name => childDirectory(root, name)));
    if (!create && existing.some(value => value === null)) return null;
    for (let index = 0; index < names.length; index++) {
      if (existing[index]) continue;
      await unchangedRoot(root);
      try { await fs.mkdir(path.join(userDataDir, names[index]), {mode:0o700}); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      if (!await childDirectory(root, names[index])) fail();
    }
    await unchangedRoot(root);
    for (const name of names) if (!await childDirectory(root, name)) fail();
    return {codexHome:path.join(userDataDir, names[0]), cwd:path.join(userDataDir, names[1])};
  } catch { throw new CodexDirectoriesError(); }
}

module.exports = {CodexDirectoriesError, prepareManagedDirectories};
