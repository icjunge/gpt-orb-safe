'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { validateConfig, verifyEnvelope, verifyInstaller } = require('../src/update-security.cjs');
const { releaseContext, githubClient, requireExactTag, requireNewerRelease } = require('./release-github.cjs');

async function verifiedAssets(directory, context, config) {
  const names = [`GPT-Orb-Setup-${context.version}-x64.exe`, `GPT-Orb-${context.version}-Source.zip`,
    `GPT-Orb-${context.version}-Browser-Extension.zip`, 'orb-update.json', 'latest.yml',
    `GPT-Orb-Setup-${context.version}-x64.exe.sha256`];
  const assets = [];
  for (const name of names) {
    const filename = path.join(directory, name), stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw new Error('Release asset is missing, empty or not a regular file.');
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
    assets.push({ name, filename, size: stat.size, digest: `sha256:${hash.digest('hex')}` });
  }
  const descriptor = verifyEnvelope(fs.readFileSync(path.join(directory, 'orb-update.json')), validateConfig(config));
  if (descriptor.version !== context.version || descriptor.tag !== context.tag) throw new Error('Signed update version differs from the release.');
  await verifyInstaller(path.join(directory, descriptor.file), descriptor);
  const expectedYaml = `version: ${descriptor.version}\nfiles:\n  - url: ${descriptor.file}\n    sha512: ${descriptor.sha512}\n    size: ${descriptor.size}\npath: ${descriptor.file}\nsha512: ${descriptor.sha512}\nreleaseDate: '${descriptor.publishedAt}'\n`;
  if (fs.readFileSync(path.join(directory, 'latest.yml'), 'utf8') !== expectedYaml ||
      fs.readFileSync(path.join(directory, `${descriptor.file}.sha256`), 'utf8') !== `${descriptor.sha256}  ${descriptor.file}\n`) {
    throw new Error('Update metadata differs from the signed installer descriptor.');
  }
  return assets;
}

function checkRemoteAssets(remote, assets) {
  return Array.isArray(remote) && remote.length === assets.length && assets.every(local => {
    const matches = remote.filter(item => item.name === local.name);
    return matches.length === 1 && matches[0].state === 'uploaded' &&
      matches[0].size === local.size && matches[0].digest === local.digest;
  });
}

async function publishRelease(api, context, assets, upload, wait = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  await requireExactTag(api, context);
  if (await api('GET', `${context.root}/releases/tags/${context.tag}`)) {
    throw new Error('A release or draft already exists for this version; it will not be replaced.');
  }
  await requireNewerRelease(api, context);
  // The protected release environment has already been approved before this
  // process starts. Keep assets private until every upload digest is verified.
  const draft = await api('POST', `${context.root}/releases`, {
    tag_name: context.tag, target_commitish: context.sha, name: context.tag,
    draft: true, prerelease: false, generate_release_notes: true, make_latest: 'false',
  });
  if (!Number.isSafeInteger(draft?.id) || draft.id <= 0 || draft.tag_name !== context.tag || draft.draft !== true) {
    throw new Error('GitHub did not create the expected draft release.');
  }
  await upload(context, assets);
  let verified = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const uploaded = await api('GET', `${context.root}/releases/${draft.id}/assets?per_page=100`);
    if (checkRemoteAssets(uploaded, assets)) { verified = true; break; }
    if (attempt < 2) await wait(1000);
  }
  if (!verified) throw new Error('Uploaded asset hashes or sizes differ; the release remains a draft.');
  // Approval for an older version may arrive after a newer release. Never make
  // that older build latest, and never publish after somebody moves its tag.
  await requireExactTag(api, context);
  await requireNewerRelease(api, context);
  const current = await api('GET', `${context.root}/releases/${draft.id}`);
  if (!current?.draft || current.tag_name !== context.tag) throw new Error('Draft changed during publication; refusing to modify it.');
  const published = await api('PATCH', `${context.root}/releases/${draft.id}`, {
    draft: false, prerelease: false, make_latest: 'true',
  });
  if (published?.draft !== false || published.prerelease !== false || published.tag_name !== context.tag) {
    throw new Error('GitHub did not confirm the expected stable release publication.');
  }
  return `Published ${context.tag}; the existing application can now verify and download the signed update.`;
}

if (require.main === module) {
  Promise.resolve().then(async () => {
    const config = require('../update-config.json');
    const context = releaseContext(process.env, require('../package.json'), config, 'publish');
    const directory = path.resolve(process.argv[2] || 'dist');
    const assets = await verifiedAssets(directory, context, config);
    const result = await publishRelease(githubClient(process.env.GH_TOKEN), context, assets, async (release, files) => {
      try {
        execFileSync('gh', ['release', 'upload', release.tag, ...files.map(file => file.filename), '--repo', release.repository],
          { env: { ...process.env, GH_HOST: 'github.com' }, stdio: ['ignore', 'ignore', 'ignore'], timeout: 600000 });
      } catch { throw new Error('Release asset upload failed; the release remains a draft for review.'); }
    });
    console.log(result);
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { verifiedAssets, checkRemoteAssets, publishRelease };
