'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const project = path.resolve(__dirname, '..');
const output = process.argv[2];
if (!output || process.argv.length !== 3 || !path.isAbsolute(output)) {
  console.error('Usage: node scripts/generate-signing-key.cjs /absolute/path/OUTSIDE-repository/orb-update-private.pem');
  process.exit(1);
}
const target = path.resolve(output);
const parent = fs.realpathSync(path.dirname(target));
const realTarget = path.join(parent, path.basename(target));
if (realTarget === project || realTarget.startsWith(project + path.sep)) throw new Error('Private key must be outside the repository');
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const descriptor = fs.openSync(realTarget, 'wx', 0o600);
try {
  fs.writeFileSync(descriptor, privateKey.export({type:'pkcs8',format:'pem'}));
  fs.fsyncSync(descriptor);
} finally { fs.closeSync(descriptor); }
console.log('Private signing key created outside the repository. Store it securely; never commit or share it.');
console.log(publicKey.export({type:'spki',format:'pem'}).toString());
console.log('Public-key SHA256: ' + crypto.createHash('sha256').update(publicKey.export({type:'spki',format:'der'})).digest('hex'));
