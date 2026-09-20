'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { syncExtension } = require('../src/extension-store.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orb-extension-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sourceDir = path.join(directory, 'bundle');
  const userData = path.join(directory, 'profile');
  await fs.cp(path.join(__dirname, '../extension'), sourceDir, { recursive: true });
  return { sourceDir, userData, directory, target: path.join(userData, 'Browser-Extension') };
}

async function changeManifest(directory, patch) {
  const file = path.join(directory, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  Object.assign(manifest, patch);
  await fs.writeFile(file, JSON.stringify(manifest));
}

async function bytes(directory) {
  const output = {};
  for (const name of (await fs.readdir(directory)).sort()) output[name] = await fs.readFile(path.join(directory, name), 'utf8');
  return output;
}

test('first setup uses a stable path; a second launch leaves unchanged files untouched', async t => {
  const f = await fixture(t);
  const first = await syncExtension(f);
  assert.equal(first.path, f.target);
  assert.equal(first.changed, true);
  assert.equal(first.error, undefined);
  assert.deepEqual(await bytes(f.target), await bytes(f.sourceDir));
  const before = await fs.stat(path.join(f.target, 'popup.js'));
  const next = await syncExtension(f);
  assert.deepEqual(next, { path: f.target, version: first.version, changed: false });
  assert.equal((await fs.stat(path.join(f.target, 'popup.js'))).mtimeMs, before.mtimeMs);
});

test('a new release swaps complete bundles and keeps one complete previous version', async t => {
  const f = await fixture(t);
  await syncExtension(f);
  const old = await bytes(f.target);
  await changeManifest(f.sourceDir, { version: '2.2.0' });
  await fs.appendFile(path.join(f.sourceDir, 'popup.js'), '\n// synthetic release\n');
  const updated = await syncExtension(f);
  assert.equal(updated.version, '2.2.0');
  assert.equal(updated.changed, true);
  assert.deepEqual(await bytes(f.target), await bytes(f.sourceDir));
  assert.deepEqual(await bytes(path.join(f.userData, 'Browser-Extension.previous')), old);
  await changeManifest(f.sourceDir, { version: '2.3.0' });
  await syncExtension(f);
  assert.deepEqual((await fs.readdir(f.userData)).sort(), ['Browser-Extension', 'Browser-Extension.previous']);
});

test('a browser lock during replacement restores the previous complete extension', async t => {
  const f = await fixture(t);
  const first = await syncExtension(f);
  const old = await bytes(f.target);
  await changeManifest(f.sourceDir, { version: '2.2.0' });
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (from.includes('.Browser-Extension-stage-') && to === f.target) {
      throw Object.assign(new Error('Synthetic browser lock'), { code: 'EPERM' });
    }
    return rename(from, to);
  });
  const result = await syncExtension(f);
  assert.equal(result.changed, false);
  assert.equal(result.version, first.version);
  assert.ok(result.error);
  assert.deepEqual(await bytes(f.target), old);
  assert.deepEqual(await fs.readdir(f.userData), ['Browser-Extension']);
});

test('opening an older app cannot silently downgrade the shared installed extension', async t => {
  const f = await fixture(t);
  await changeManifest(f.sourceDir, { version: '2.3.0' });
  await syncExtension(f);
  const old = await bytes(f.target);
  await changeManifest(f.sourceDir, { version: '2.2.0' });
  const result = await syncExtension(f);
  assert.deepEqual(result, { path: f.target, version: '2.3.0', changed: false });
  assert.deepEqual(await bytes(f.target), old);
});

test('an interrupted directory swap recovers the preserved prior bundle before continuing', async t => {
  const f = await fixture(t);
  const first = await syncExtension(f);
  await fs.rename(f.target, path.join(f.userData, 'Browser-Extension.previous'));
  const result = await syncExtension(f);
  assert.deepEqual(result, { path: f.target, version: first.version, changed: false });
  assert.deepEqual(await bytes(f.target), await bytes(f.sourceDir));
});

for (const [name, patch] of [
  ['broader permissions', { permissions: ['activeTab', 'scripting', 'storage', 'cookies'] }],
  ['remote hosts', { host_permissions: ['https://example.com/*'] }],
  ['different extension identity', { key: 'untrusted' }],
  ['remote update URL', { update_url: 'https://example.com/update.xml' }],
  ['remote script policy', { content_security_policy: { extension_pages: "script-src 'self' https://example.com" } }]
]) {
  test(`unsafe bundled manifest is refused: ${name}`, async t => {
    const f = await fixture(t);
    await syncExtension(f);
    const old = await bytes(f.target);
    await changeManifest(f.sourceDir, patch);
    const result = await syncExtension(f);
    assert.equal(result.changed, false);
    assert.ok(result.error);
    assert.deepEqual(await bytes(f.target), old);
  });
}

test('unexpected bundled files and source symlinks are refused', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.sourceDir, 'unapproved.js'), '');
  assert.ok((await syncExtension(f)).error);
  await fs.rm(path.join(f.sourceDir, 'unapproved.js'));
  await fs.rm(path.join(f.sourceDir, 'popup.js'));
  await fs.symlink(path.join(f.sourceDir, 'sw.js'), path.join(f.sourceDir, 'popup.js'));
  assert.ok((await syncExtension(f)).error);
  assert.deepEqual(await fs.readdir(f.userData), []);
});

test('an installed symlink cannot redirect copying outside the stable extension directory', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.userData);
  const outside = path.join(f.directory, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'keep.txt'), 'unchanged');
  await fs.symlink(outside, f.target, 'dir');
  assert.ok((await syncExtension(f)).error);
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'unchanged');
  assert.deepEqual(await fs.readdir(outside), ['keep.txt']);
});
