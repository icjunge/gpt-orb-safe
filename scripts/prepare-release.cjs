'use strict';

const { releaseContext, githubClient, tagCommit, requireExactTag, requireNewerRelease } = require('./release-github.cjs');
const { retireUnreleased250 } = require('./retire-unreleased-250.cjs');

async function prepareRelease(api, context) {
  const main = await api('GET', `${context.root}/git/ref/heads/main`);
  if (main?.object?.type !== 'commit' || main.object.sha !== context.sha) {
    return { status: 'superseded', message: 'Main has advanced; this older preparation did not create a tag.' };
  }
  const existingTag = await tagCommit(api, context);
  if (existingTag && existingTag !== context.sha) throw new Error('This version tag belongs to another commit; bump the version.');
  const existingRelease = await api('GET', `${context.root}/releases/tags/${context.tag}`);
  if (existingRelease?.draft) throw new Error('A draft already exists for this version; review it manually before retrying. No assets were replaced.');
  if (existingRelease) return { status: 'exists', message: 'This release already exists; it was not changed.' };
  await requireNewerRelease(api, context);

  // Serialized preparation plus a running-workflow check makes re-runs safe.
  // Failed/cancelled completed runs can be dispatched again without moving the tag.
  const runs = await api('GET', `${context.root}/actions/workflows/release.yml/runs?head_sha=${context.sha}&per_page=100`);
  if (!Array.isArray(runs?.workflow_runs) || runs.total_count > 100) throw new Error('Cannot fully inspect existing release workflow runs.');
  if (runs.workflow_runs.some(run => run.head_sha === context.sha && run.status !== 'completed')) {
    return { status: 'running', message: 'This tagged release already has an active workflow run.' };
  }
  const current = await api('GET', `${context.root}/git/ref/heads/main`);
  if (current?.object?.sha !== context.sha) return { status: 'superseded', message: 'Main advanced before tag creation; no tag was written.' };
  if (!existingTag) {
    try { await api('POST', `${context.root}/git/refs`, { ref: `refs/tags/${context.tag}`, sha: context.sha }); }
    catch (error) { if (error.status !== 422) throw error; }
  }
  await requireExactTag(api, context);
  const retirement = await retireUnreleased250(api, context);
  if (retirement.warning) console.warn(`::warning::${retirement.warning}`);
  else if (retirement.message) console.log(retirement.message);
  const beforeDispatch = await api('GET', `${context.root}/git/ref/heads/main`);
  if (beforeDispatch?.object?.sha !== context.sha) return { status: 'superseded', message: 'Main advanced before release dispatch; the prepared tag was not moved.' };
  await requireExactTag(api, context);
  // GITHUB_TOKEN-created tags do not trigger push workflows. Dispatch explicitly
  // at the tag so the existing tag-only protected environment still applies.
  await api('POST', `${context.root}/actions/workflows/release.yml/dispatches`, { ref: context.tag });
  return { status: 'dispatched', message: `Prepared ${context.tag} at ${context.sha}; protected release approval is still required.` };
}

if (require.main === module) {
  Promise.resolve().then(async () => {
    const context = releaseContext(process.env, require('../package.json'), require('../update-config.json'), 'prepare');
    const result = await prepareRelease(githubClient(process.env.GH_TOKEN), context);
    console.log(result.message);
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { prepareRelease };
