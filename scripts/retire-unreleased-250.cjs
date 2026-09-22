'use strict';

const { compareVersions } = require('../src/update-security.cjs');
const { REPOSITORY } = require('./release-github.cjs');

// One-time maintenance for the known unpublished v2.5.0 visual defect. This is
// deliberately NOT a policy for cancelling arbitrary older release workflows.
// Keep the historical tag and logs; only retire this exact unapproved attempt.
const SUPERSEDED = Object.freeze({
  run: 35752636723, attempt: 1, workflow: 362577111,
  sha: '0a06b7b4ce4035dd4a2aab09d94110d1593c2887', tag: 'v2.5.0', version: '2.5.0',
});
const NOTICE = `The unapproved v2.5.0 run ${SUPERSEDED.run} was not confirmed cancelled; it may still hold the publish queue. Review https://github.com/${REPOSITORY}/actions/runs/${SUPERSEDED.run}. The new build can continue; no deployment was approved.`;

function isExactRun(run) {
  return run?.id === SUPERSEDED.run && run.run_attempt === SUPERSEDED.attempt &&
    run.workflow_id === SUPERSEDED.workflow && run.path === '.github/workflows/release.yml' &&
    run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY &&
    run.head_sha === SUPERSEDED.sha && run.head_branch === SUPERSEDED.tag && run.event === 'workflow_dispatch';
}

function safeWaitingSnapshot(snapshot, context) {
  const { main, run, jobs, pending, tag, release } = snapshot;
  if (main?.object?.type !== 'commit' || main.object.sha !== context.sha ||
      !isExactRun(run) || run.status !== 'waiting' || run.conclusion !== null || release !== null ||
      tag?.object?.type !== 'commit' || tag.object.sha !== SUPERSEDED.sha ||
      !Array.isArray(pending) || pending.length !== 1 || pending[0]?.environment?.name !== 'release' ||
      jobs?.total_count !== 2 || !Array.isArray(jobs.jobs) || jobs.jobs.length !== 2) return false;
  const build = jobs.jobs.find(job => job.name === 'build');
  const publish = jobs.jobs.find(job => job.name === 'publish');
  if (!build || !publish || jobs.jobs.some(job => job.run_id !== SUPERSEDED.run || job.run_attempt !== SUPERSEDED.attempt || job.head_sha !== SUPERSEDED.sha)) return false;
  // GitHub sets started_at even while an environment job is waiting. A runner
  // assignment or any step is the relevant evidence that execution has begun.
  return build.status === 'completed' && build.conclusion === 'success' &&
    publish.status === 'waiting' && publish.conclusion === null && publish.runner_id === null &&
    publish.runner_name === null && Array.isArray(publish.steps) && publish.steps.length === 0;
}

async function retireUnreleased250(api, context, { timeoutMs = 30000, pollIntervalMs = 1000 } = {}) {
  if (context.repository !== REPOSITORY || context.root !== `/repos/${REPOSITORY}` ||
      compareVersions(context.version, SUPERSEDED.version) <= 0 || context.sha === SUPERSEDED.sha) {
    return { status: 'not-applicable' };
  }
  const controller = new AbortController();
  let timer;
  const request = async (method, route, body) => {
    controller.signal.throwIfAborted();
    const value = await api(method, route, body, { signal: controller.signal });
    controller.signal.throwIfAborted();
    return value;
  };
  const runRoute = `${context.root}/actions/runs/${SUPERSEDED.run}`;
  const inspect = async () => {
    const [main, run, jobs, pending, tag, release] = await Promise.all([
      request('GET', `${context.root}/git/ref/heads/main`), request('GET', runRoute),
      request('GET', `${runRoute}/jobs?filter=latest&per_page=100`), request('GET', `${runRoute}/pending_deployments`),
      request('GET', `${context.root}/git/ref/tags/${SUPERSEDED.tag}`), request('GET', `${context.root}/releases/tags/${SUPERSEDED.tag}`),
    ]);
    return { main, run, jobs, pending, tag, release };
  };
  const work = async () => {
    const first = await inspect();
    if (isExactRun(first.run) && first.run.status === 'completed') return { status: 'already-finished' };
    if (!safeWaitingSnapshot(first, context)) return { status: 'skipped', warning: NOTICE };
    // All guards are re-read immediately before the single allowed mutation.
    // GitHub has no conditional cancel API: an approval can still race this
    // final read. Never retry or force-cancel if the ordinary request conflicts.
    if (!safeWaitingSnapshot(await inspect(), context)) return { status: 'skipped', warning: NOTICE };
    await request('POST', `${runRoute}/cancel`);
    while (!controller.signal.aborted) {
      const run = await request('GET', runRoute);
      if (!isExactRun(run)) return { status: 'warning', warning: NOTICE };
      if (run.status === 'completed') return run.conclusion === 'cancelled'
        ? { status: 'cancelled', message: `Retired the superseded unapproved v2.5.0 run ${SUPERSEDED.run}; its tag and logs were preserved.` }
        : { status: 'warning', warning: NOTICE };
      await new Promise(resolve => {
        const delay = setTimeout(done, pollIntervalMs);
        function done() { clearTimeout(delay); controller.signal.removeEventListener('abort', done); resolve(); }
        controller.signal.addEventListener('abort', done, { once: true });
      });
    }
    return { status: 'warning', warning: NOTICE };
  };
  try {
    return await Promise.race([
      work(),
      new Promise(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve({ status: 'warning', warning: NOTICE }); }, timeoutMs);
      }),
    ]);
  } catch {
    // A changed state, denied request or transport failure must not cancel a
    // different run or prevent building the fixed version.
    return { status: 'warning', warning: NOTICE };
  } finally { clearTimeout(timer); controller.abort(); }
}

module.exports = { SUPERSEDED, safeWaitingSnapshot, retireUnreleased250 };
