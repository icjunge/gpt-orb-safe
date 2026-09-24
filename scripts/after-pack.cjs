'use strict';
const fs = require('node:fs');
const path = require('node:path');
module.exports = async function afterPack(context) {
  const config = require('../update-config.json');
  if (!config.repository || !config.publicKey) return;
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(config.repository)) throw new Error('Invalid update repository');
  const contents = `provider: generic\nurl: https://github.com/${config.repository}/releases/latest/download/\nupdaterCacheDirName: gpt-usage-orb-safe-updater\n`;
  const resources = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app', 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  fs.writeFileSync(path.join(resources,'app-update.yml'),contents);
};
