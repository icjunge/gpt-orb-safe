'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const project = path.resolve(__dirname,'..');
const [repository,visibility = '--private'] = process.argv.slice(2);
if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repository || '') || !['--private','--public'].includes(visibility) || process.argv.length>4) {
  console.error('Usage: node scripts/setup-repository.cjs OWNER/REPOSITORY [--private|--public]');
  console.error('Default: private repository. Anonymous desktop updates require public release assets.');
  process.exit(1);
}
if (!fs.existsSync(path.join(project,'.git'))) throw new Error('Initialize and review the local Git repository first');
const result = spawnSync('gh',['repo','create',repository,visibility,'--source',project,'--remote','origin','--push'],{stdio:'inherit',shell:false,cwd:project});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
