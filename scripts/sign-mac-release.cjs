'use strict';

// These Ed25519 envelopes authenticate our release files. They are deliberately
// separate from Apple Developer ID signing and do not imply notarization.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateConfig, compareVersions } = require('../src/update-security.cjs');

const ARCHES = Object.freeze(['arm64', 'x64']);

async function describeDmg(directory, version, arch, publishedAt) {
  const file = `GPT-Orb-Setup-${version}-${arch}.dmg`;
  const filename = path.join(directory, file);
  const beforePath = await fs.promises.lstat(filename);
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.size < 1024 * 1024 || beforePath.size > 1024 * 1024 * 1024) {
    throw new Error('DMG is missing or is not a regular supported-size disk image.');
  }
  const handle = await fs.promises.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.ino !== beforePath.ino || before.dev !== beforePath.dev || before.size !== beforePath.size) {
      throw new Error('DMG changed before signing.');
    }
    const trailer = Buffer.alloc(512);
    const trailerRead = await handle.read(trailer, 0, trailer.length, before.size - trailer.length);
    if (trailerRead.bytesRead !== 512 || trailer.subarray(0, 4).toString('ascii') !== 'koly' || trailer.readUInt32BE(8) !== 512) {
      throw new Error('DMG does not have a valid UDIF disk-image trailer.');
    }
    const a = crypto.createHash('sha256'), b = crypto.createHash('sha512'), buffer = Buffer.alloc(1024 * 1024);
    let offset = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      offset += bytesRead;
      if (offset > before.size) throw new Error('DMG changed while signing.');
      a.update(buffer.subarray(0, bytesRead)); b.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat(), afterPath = await fs.promises.lstat(filename);
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        !afterPath.isFile() || afterPath.isSymbolicLink() || afterPath.ino !== before.ino || afterPath.dev !== before.dev ||
        afterPath.size !== before.size || afterPath.mtimeMs !== before.mtimeMs) throw new Error('DMG changed while signing.');
    return { schema: 1, version, tag: `v${version}`, platform: 'darwin', arch, file, size: offset,
      sha256: a.digest('hex'), sha512: b.digest('base64'), publishedAt };
  } finally { await handle.close(); }
}

async function signMacReleases({ directory, version, config, privateKey, env = process.env }) {
  compareVersions(version, version);
  if (version.split('.').some(part => Number(part) > 65535)) throw new Error('Stable releases require an exact X.Y.Z version.');
  const trusted = validateConfig(config);
  if (!trusted) throw new Error('Configure repository and verification public key before signing.');
  if (env.GITHUB_REPOSITORY && env.GITHUB_REPOSITORY !== trusted.repository) throw new Error('Workflow repository does not match pinned repository.');
  if (env.GITHUB_REF_TYPE === 'tag' && env.GITHUB_REF_NAME !== `v${version}`) throw new Error('Release tag does not match package version.');
  let key;
  try { key = crypto.createPrivateKey(privateKey || ''); } catch { throw new Error('An Ed25519 release signing key is required.'); }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('An Ed25519 release signing key is required.');
  const expected = trusted.key.export({ format: 'der', type: 'spki' });
  const actual = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' });
  if (!expected.equals(actual)) throw new Error('Protected signing key does not match pinned public key.');
  const publishedAt = new Date().toISOString();
  // Validate both architectures before producing either signed manifest.
  const descriptors = [];
  for (const arch of ARCHES) descriptors.push(await describeDmg(directory, version, arch, publishedAt));
  for (const descriptor of descriptors) {
    const payload = Buffer.from(JSON.stringify(descriptor), 'utf8');
    const envelope = { payload: payload.toString('base64'), signature: crypto.sign(null, payload, key).toString('base64') };
    fs.writeFileSync(path.join(directory, `orb-update-mac-${descriptor.arch}.json`), JSON.stringify(envelope, null, 2) + '\n');
    fs.writeFileSync(path.join(directory, `${descriptor.file}.sha256`), `${descriptor.sha256}  ${descriptor.file}\n`);
  }
  return descriptors;
}

if (require.main === module) {
  signMacReleases({ directory: path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist')),
    version: require('../package.json').version, config: require('../update-config.json'), privateKey: process.env.ORB_UPDATE_PRIVATE_KEY,
  }).then(descriptors => {
    console.log(`Signed ${descriptors.length} macOS release descriptors. These signatures are not Apple notarization.`);
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { ARCHES, describeDmg, signMacReleases };
