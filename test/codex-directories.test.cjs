'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {CodexDirectoriesError, prepareManagedDirectories} = require('../src/codex-directories.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orb-managed-directories-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const userData = path.join(root, 'orb');
  await fs.mkdir(userData);
  return {root, userData};
}
function storage(error) {
  return error instanceof CodexDirectoriesError && error.code === 'storage' &&
    error.message === '无法安全使用本机连接目录，请检查应用数据目录。' && !error.cause;
}
async function linkDirectory(target, link) { await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }

test('read-only managed directory probe creates nothing on first use', async t => {
  const {userData} = await fixture(t);
  assert.equal(await prepareManagedDirectories(userData, {create:false}), null);
  assert.deepEqual(await fs.readdir(userData), []);
});

test('explicit preparation creates only the two app directories and later probes preserve existing state', async t => {
  const {userData} = await fixture(t);
  const directories = await prepareManagedDirectories(userData);
  assert.deepEqual(directories, {codexHome:path.join(userData, 'codex-managed-home'), cwd:path.join(userData, 'codex-query')});
  await fs.writeFile(path.join(directories.codexHome, 'existing-local-state'), 'preserve');
  assert.deepEqual(await prepareManagedDirectories(userData, {create:false}), directories);
  assert.equal(await fs.readFile(path.join(directories.codexHome, 'existing-local-state'), 'utf8'), 'preserve');
  assert.deepEqual((await fs.readdir(userData)).sort(), ['codex-managed-home', 'codex-query']);
});

for (const name of ['codex-managed-home', 'codex-query']) {
  test(`refuses ${name} junction to an existing CLI home without changing that home or creating siblings`, async t => {
    const {root, userData} = await fixture(t);
    const existing = path.join(root, 'existing-cli');
    await fs.mkdir(existing);
    await fs.writeFile(path.join(existing, 'auth.json'), 'unchanged-fixture');
    await linkDirectory(existing, path.join(userData, name));
    for (const create of [false, true]) await assert.rejects(prepareManagedDirectories(userData, {create}), storage);
    assert.deepEqual(await fs.readdir(userData), [name]);
    assert.deepEqual(await fs.readdir(existing), ['auth.json']);
    assert.equal(await fs.readFile(path.join(existing, 'auth.json'), 'utf8'), 'unchanged-fixture');
  });

  test(`refuses a file in place of ${name}`, async t => {
    const {userData} = await fixture(t);
    await fs.writeFile(path.join(userData, name), 'unchanged');
    await assert.rejects(prepareManagedDirectories(userData), storage);
    assert.deepEqual(await fs.readdir(userData), [name]);
    assert.equal(await fs.readFile(path.join(userData, name), 'utf8'), 'unchanged');
  });
}

test('refuses a linked application data root and does not populate its target', async t => {
  const {root, userData} = await fixture(t);
  const linkedRoot = path.join(root, 'linked-orb');
  await linkDirectory(userData, linkedRoot);
  await assert.rejects(prepareManagedDirectories(linkedRoot), storage);
  assert.deepEqual(await fs.readdir(userData), []);
});

test('read-only probe with one missing child neither creates it nor changes the other', async t => {
  const {userData} = await fixture(t);
  await fs.mkdir(path.join(userData, 'codex-query'));
  assert.equal(await prepareManagedDirectories(userData, {create:false}), null);
  assert.deepEqual(await fs.readdir(userData), ['codex-query']);
});

test('invalid or missing roots return only a fixed storage error', async t => {
  const {root, userData} = await fixture(t);
  for (const value of [undefined, null, 7, '', 'relative', `${userData}\u0000private`, path.join(root, 'missing')]) {
    await assert.rejects(prepareManagedDirectories(value), storage);
  }
  await assert.rejects(prepareManagedDirectories(userData, {create:'yes'}), storage);
  await assert.rejects(prepareManagedDirectories(userData, null), storage);
  assert.deepEqual(await fs.readdir(userData), []);
});
