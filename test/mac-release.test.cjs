'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const afterPack = require('../scripts/after-pack.cjs');
const { signMacReleases } = require('../scripts/sign-mac-release.cjs');
const { validateConfig, verifyMacEnvelope, verifyInstaller } = require('../src/update-security.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-mac-release-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const keys = crypto.generateKeyPairSync('ed25519'), version = '2.7.0';
  const config = { schema: 1, repository: 'fixture-owner/fixture-repo',
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), channel: 'stable' };
  const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const bytes = Buffer.alloc(1024 * 1024); bytes.write('koly', bytes.length - 512); bytes.writeUInt32BE(512, bytes.length - 504);
  for (const arch of ['arm64', 'x64']) fs.writeFileSync(path.join(directory, `GPT-Orb-Setup-${version}-${arch}.dmg`), bytes);
  return { directory, version, keys, config, privateKey, env: {}, bytes };
}

test('macOS release descriptors authenticate each architecture and the exact DMG bytes', async t => {
  const f = fixture(t);
  const descriptors = await signMacReleases(f);
  assert.equal(descriptors.length, 2);
  for (const arch of ['arm64', 'x64']) {
    const envelope = fs.readFileSync(path.join(f.directory, `orb-update-mac-${arch}.json`));
    const descriptor = verifyMacEnvelope(envelope, validateConfig(f.config), arch);
    assert.equal(descriptor.version, f.version);
    assert.equal(descriptor.platform, 'darwin');
    assert.equal(descriptor.arch, arch);
    assert.equal(descriptor.size, f.bytes.length);
    await verifyInstaller(path.join(f.directory, descriptor.file), descriptor);
    assert.equal(fs.readFileSync(path.join(f.directory, `${descriptor.file}.sha256`), 'utf8'), `${descriptor.sha256}  ${descriptor.file}\n`);
    assert.throws(() => verifyMacEnvelope(envelope, validateConfig(f.config), arch === 'arm64' ? 'x64' : 'arm64'));
    assert.equal(envelope.includes(f.privateKey), false);
  }
  assert.equal(fs.existsSync(path.join(f.directory, 'latest-mac.yml')), false);
  assert.equal(fs.existsSync(path.join(f.directory, 'orb-update.json')), false);
});

test('macOS signing refuses a different trust root, repository, tag and unstable version', async t => {
  const f = fixture(t);
  const other = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  for (const patch of [{ privateKey: other }, { privateKey: 'not a private key' },
    { env: { GITHUB_REPOSITORY: 'other/repo' } }, { env: { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v9.0.0' } },
    { version: '2.7.0-beta' }, { version: '2.7.65536' }, { version: '02.7.0' }]) {
    await assert.rejects(signMacReleases({ ...f, ...patch }));
  }
  assert.equal(fs.existsSync(path.join(f.directory, 'orb-update-mac-arm64.json')), false);
});

test('macOS signer validates both regular UDIF files before creating either manifest', async t => {
  const f = fixture(t), badFile = path.join(f.directory, `GPT-Orb-Setup-${f.version}-x64.dmg`);
  fs.writeFileSync(badFile, Buffer.alloc(1024 * 1024));
  await assert.rejects(signMacReleases(f), /UDIF/);
  assert.equal(fs.existsSync(path.join(f.directory, 'orb-update-mac-arm64.json')), false);
  fs.unlinkSync(badFile);
  await assert.rejects(signMacReleases(f));
  assert.equal(fs.existsSync(path.join(f.directory, 'orb-update-mac-arm64.json')), false);
});

test('macOS signing refuses a symlink to a DMG', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t), target = path.join(f.directory, `GPT-Orb-Setup-${f.version}-x64.dmg`);
  fs.unlinkSync(target); fs.symlinkSync(`GPT-Orb-Setup-${f.version}-arm64.dmg`, target);
  await assert.rejects(signMacReleases(f), /regular/);
});

test('packaging writes update config inside the macOS application and preserves Windows layout', async t => {
  const f = fixture(t);
  for (const electronPlatformName of ['darwin', 'win32']) {
    const appOutDir = path.join(f.directory, electronPlatformName), productFilename = 'GPT Usage Orb Safe';
    const resources = electronPlatformName === 'darwin'
      ? path.join(appOutDir, `${productFilename}.app`, 'Contents', 'Resources') : path.join(appOutDir, 'resources');
    fs.mkdirSync(resources, { recursive: true });
    await afterPack({ appOutDir, electronPlatformName, packager: { appInfo: { productFilename } } });
    const content = fs.readFileSync(path.join(resources, 'app-update.yml'), 'utf8');
    assert.match(content, /url: https:\/\/github\.com\/icjunge\/gpt-orb-safe\/releases\/latest\/download\//);
    if (electronPlatformName === 'darwin') assert.equal(fs.existsSync(path.join(appOutDir, 'resources')), false);
  }
});

test('macOS review builds use only an explicit ad-hoc identity without certificate secrets', () => {
  const project = path.join(__dirname, '..');
  const builder = fs.readFileSync(path.join(project, 'electron-builder.yml'), 'utf8').split('\nmac:\n')[1].split('\ndmg:\n')[0];
  assert.match(builder, /identity: '-'/);
  assert.match(builder, /hardenedRuntime: true/);
  assert.match(builder, /notarize: false/);
  const workflow = fs.readFileSync(path.join(project, '.github/workflows/test.yml'), 'utf8').split('\n  mac:\n')[1];
  assert.match(workflow, /CSC_IDENTITY_AUTO_DISCOVERY: 'false'/);
  assert.match(workflow, /CSC_FOR_PULL_REQUEST: 'true'/);
  assert.doesNotMatch(workflow, /secrets\.|environment:|CSC_LINK:|CSC_KEY_PASSWORD:|APPLE_/);
  // The packaging wrapper carries the existing artwork rather than inventing
  // a new icon or relying on missing high-resolution binary assets.
  const svg = fs.readFileSync(path.join(project, 'assets/orb-mac.svg'), 'utf8');
  assert.match(svg, /width="1024" height="1024"/);
  assert.equal(Buffer.from(svg.match(/base64,([^"']+)/)[1], 'base64').equals(fs.readFileSync(path.join(project, 'assets/orb.png'))), true);
});
