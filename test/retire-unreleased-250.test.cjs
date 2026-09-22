'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { githubClient } = require('../scripts/release-github.cjs');
const { prepareRelease } = require('../scripts/prepare-release.cjs');
const { SUPERSEDED, safeWaitingSnapshot, retireUnreleased250 } = require('../scripts/retire-unreleased-250.cjs');
const REPO = 'icjunge/gpt-orb-safe', SHA = 'b'.repeat(40);
const context = { repository: REPO, root: `/repos/${REPO}`, sha: SHA, tag: 'v2.5.1', version: '2.5.1' };
const runRoute = `${context.root}/actions/runs/35752636723`;
const commit = sha => ({ object: { type: 'commit', sha } });

function fixture() {
  const job = { run_id: SUPERSEDED.run, run_attempt: 1, head_sha: SUPERSEDED.sha };
  const snapshot = {
    main: commit(SHA), tag: commit(SUPERSEDED.sha), release: null,
    run: { id: SUPERSEDED.run, run_attempt: 1, workflow_id: SUPERSEDED.workflow,
      path: '.github/workflows/release.yml', repository: { full_name: REPO }, head_repository: { full_name: REPO },
      head_sha: SUPERSEDED.sha, head_branch: 'v2.5.0', event: 'workflow_dispatch', status: 'waiting', conclusion: null },
    jobs: { total_count: 2, jobs: [
      { ...job, name: 'build', status: 'completed', conclusion: 'success' },
      { ...job, name: 'publish', status: 'waiting', conclusion: null, runner_id: null, runner_name: null,
        steps: [], started_at: '2026-09-22T16:14:59Z' },
    ] },
    pending: [{ environment: { name: 'release', id: 22329944808 } }],
  };
  const calls = [], state = { snapshot, completeCancellation: true, cancelled: false, newTag: null };
  const api = async (method, route, body, options) => {
    calls.push({ method, route, body, signal: options?.signal });
    if (method === 'POST' && route === `${runRoute}/cancel`) { state.cancelled = true; return null; }
    if (method === 'POST' && route === `${context.root}/git/refs`) { state.newTag = body.sha; return commit(body.sha); }
    if (method === 'POST' && route.endsWith('/dispatches')) return null;
    assert.equal(method, 'GET');
    if (route === `${context.root}/git/ref/tags/v2.5.1`) return state.newTag ? commit(state.newTag) : null;
    if (route === `${context.root}/releases/tags/v2.5.1` || route.endsWith('/releases/latest')) return null;
    if (route.includes('/actions/workflows/release.yml/runs?')) return { total_count: 0, workflow_runs: [] };
    const fields = new Map([
      [`${context.root}/git/ref/heads/main`, 'main'], [runRoute, 'run'],
      [`${runRoute}/jobs?filter=latest&per_page=100`, 'jobs'], [`${runRoute}/pending_deployments`, 'pending'],
      [`${context.root}/git/ref/tags/v2.5.0`, 'tag'], [`${context.root}/releases/tags/v2.5.0`, 'release'],
    ]);
    assert.ok(fields.has(route), `Unexpected route: ${route}`);
    if (route === runRoute && state.cancelled && state.completeCancellation) {
      return { ...snapshot.run, status: 'completed', conclusion: 'cancelled' };
    }
    return structuredClone(snapshot[fields.get(route)]);
  };
  return { snapshot, state, calls, api, writes: () => calls.filter(call => call.method !== 'GET') };
}

test('retirement is limited to the exact known unreleased run and performs two complete read snapshots', async () => {
  const f = fixture();
  assert.equal(safeWaitingSnapshot(f.snapshot, context), true);
  const result = await retireUnreleased250(f.api, context);
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(f.writes().map(({ method, route, body }) => ({ method, route, body })), [
    { method: 'POST', route: `${runRoute}/cancel`, body: undefined },
  ]);
  const cancelIndex = f.calls.findIndex(call => call.method === 'POST');
  assert.equal(cancelIndex, 12);
  for (const route of [...new Set(f.calls.slice(0, cancelIndex).map(call => call.route))]) {
    assert.equal(f.calls.slice(0, cancelIndex).filter(call => call.route === route).length, 2);
  }
  assert.ok(f.calls.every(call => call.signal instanceof AbortSignal));
  assert.match(result.message, /tag and logs were preserved/);
});

test('retirement is not applicable to older/equal versions, the old SHA or another repository', async () => {
  for (const patch of [{ version: '2.4.1' }, { version: '2.5.0' }, { sha: SUPERSEDED.sha },
    { repository: 'other/repo' }, { root: '/repos/other/repo' }]) {
    const f = fixture();
    assert.equal((await retireUnreleased250(f.api, { ...context, ...patch })).status, 'not-applicable');
    assert.equal(f.calls.length, 0);
  }
});

const unsafeChanges = [
  s => { s.main.object.sha = 'c'.repeat(40); },
  s => { s.run.id++; }, s => { s.run.run_attempt++; }, s => { s.run.workflow_id++; },
  s => { s.run.path = '.github/workflows/test.yml'; },
  s => { s.run.repository.full_name = 'other/repo'; }, s => { s.run.head_repository.full_name = 'other/repo'; },
  s => { s.run.head_sha = SHA; }, s => { s.run.head_branch = 'v2.4.1'; }, s => { s.run.event = 'push'; },
  s => { s.run.status = 'in_progress'; }, s => { s.run.conclusion = 'success'; },
  s => { s.tag.object.sha = SHA; }, s => { s.tag.object.type = 'tag'; },
  s => { s.release = { draft: true }; }, s => { s.release = { draft: false }; },
  s => { s.pending = []; }, s => { s.pending.push(s.pending[0]); }, s => { s.pending[0].environment.name = 'other'; },
  s => { s.jobs.total_count = 3; }, s => { s.jobs.jobs.push({}); },
  s => { s.jobs.jobs[0].conclusion = 'failure'; }, s => { s.jobs.jobs[0].status = 'in_progress'; },
  s => { s.jobs.jobs[1].run_id++; }, s => { s.jobs.jobs[1].run_attempt++; }, s => { s.jobs.jobs[1].head_sha = SHA; },
  s => { s.jobs.jobs[1].status = 'in_progress'; }, s => { s.jobs.jobs[1].runner_id = 1; },
  s => { s.jobs.jobs[1].runner_name = 'runner'; }, s => { s.jobs.jobs[1].steps = [{ status: 'queued' }]; },
];

test('retirement refuses every identity, main, tag, draft, approval and job-execution guard mismatch', async () => {
  for (const change of unsafeChanges) {
    const f = fixture(); change(f.snapshot);
    assert.equal((await retireUnreleased250(f.api, context)).status, 'skipped');
    assert.equal(f.writes().length, 0);
  }
});

test('retirement rechecks every guard and does not cancel a run that changes after the first snapshot', async () => {
  for (const change of unsafeChanges) {
    const f = fixture(); let reads = 0;
    const racingApi = async (...args) => {
      if (++reads === 7) change(f.snapshot);
      return f.api(...args);
    };
    const result = await retireUnreleased250(racingApi, context);
    assert.equal(result.status, 'skipped');
    assert.match(result.warning, /may still hold the publish queue/);
    assert.equal(f.writes().length, 0);
  }
});

test('retirement does nothing after the known run has already completed', async () => {
  const f = fixture(); f.snapshot.run.status = 'completed'; f.snapshot.run.conclusion = 'cancelled';
  assert.equal((await retireUnreleased250(f.api, context)).status, 'already-finished');
  assert.equal(f.writes().length, 0);
});

test('retirement never retries or force-cancels after a conflict', async () => {
  const f = fixture(); let cancellations = 0;
  const conflictApi = async (...args) => {
    if (args[0] === 'POST') { cancellations++; const error = new Error('Conflict'); error.status = 409; throw error; }
    return f.api(...args);
  };
  assert.equal((await retireUnreleased250(conflictApi, context)).status, 'warning');
  assert.equal(cancellations, 1);
  assert.equal(f.calls.some(call => call.route.includes('force-cancel')), false);
});

test('retirement has an overall timeout for stalled reads and never cancels after timeout', async () => {
  const f = fixture(); let releaseRead;
  const stalledApi = async (...args) => {
    if (args[1] === runRoute) await new Promise(resolve => { releaseRead = resolve; });
    return f.api(...args);
  };
  const result = await retireUnreleased250(stalledApi, context, { timeoutMs: 10 });
  assert.equal(result.status, 'warning');
  releaseRead(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.writes().length, 0);
  assert.ok(f.calls.every(call => call.signal.aborted));
});

test('retirement times out cancellation confirmation without a second cancel request', async () => {
  const f = fixture(); f.state.completeCancellation = false;
  const result = await retireUnreleased250(f.api, context, { timeoutMs: 20, pollIntervalMs: 2 });
  assert.equal(result.status, 'warning');
  assert.equal(f.writes().length, 1);
  assert.ok(f.calls.every(call => call.signal.aborted));
});

test('GitHub client accepts an empty cancel 202, rejects unexpected success statuses, and propagates abort', async () => {
  const controller = new AbortController(); let signal;
  const api = githubClient('fixture-token', async (_url, options) => {
    signal = options.signal;
    return { ok: true, status: 202, json: () => assert.fail('cancel 202 has no JSON body') };
  });
  assert.equal(await api('POST', `${runRoute}/cancel`, undefined, { signal: controller.signal }), null);
  controller.abort(); assert.equal(signal.aborted, true);
  for (const status of [200, 201, 204]) {
    const invalid = githubClient('fixture-token', async () => ({ ok: true, status, json: async () => ({}) }));
    await assert.rejects(invalid('POST', `${runRoute}/cancel`), /did not accept/);
  }
  const unexpected202 = githubClient('fixture-token', async () => ({ ok: true, status: 202, json: async () => ({ accepted: true }) }));
  for (const route of [`${context.root}/git/refs`, `${context.root}/actions/workflows/release.yml/dispatches`, `${runRoute}/force-cancel`]) {
    await assert.rejects(unexpected202('POST', route), /Unexpected asynchronous/);
  }
});

test('a changed old run does not block tagging and dispatching the fixed version', async t => {
  const warning = t.mock.method(console, 'warn', () => {});
  const f = fixture(); f.snapshot.jobs.jobs[1].runner_id = 123;
  const result = await prepareRelease(f.api, context);
  assert.equal(result.status, 'dispatched');
  assert.equal(warning.mock.calls.length, 1);
  assert.match(warning.mock.calls[0].arguments[0], /may still hold the publish queue/);
  assert.deepEqual(f.writes().map(call => call.route), [`${context.root}/git/refs`, `${context.root}/actions/workflows/release.yml/dispatches`]);
});

test('preparation rechecks the new tag after retirement and refuses dispatch if it moved', async t => {
  t.mock.method(console, 'log', () => {});
  const f = fixture();
  const raceApi = async (...args) => {
    const result = await f.api(...args);
    if (args[0] === 'POST' && args[1] === `${runRoute}/cancel`) f.state.newTag = 'c'.repeat(40);
    return result;
  };
  await assert.rejects(prepareRelease(raceApi, context), /tag is missing or moved/);
  assert.equal(f.writes().some(call => call.route.endsWith('/dispatches')), false);
});
