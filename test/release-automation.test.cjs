'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { releaseContext, githubClient, tagCommit } = require('../scripts/release-github.cjs');
const { prepareRelease } = require('../scripts/prepare-release.cjs');
const { verifiedAssets, checkRemoteAssets, publishRelease } = require('../scripts/publish-release.cjs');

const SHA = 'a'.repeat(40), OTHER = 'b'.repeat(40), REPO = 'icjunge/gpt-orb-safe';
const context = { repository: REPO, version: '2.5.0', tag: 'v2.5.0', sha: SHA, root: `/repos/${REPO}` };
const commit = sha => ({ object: { type: 'commit', sha } });
const baseEnv = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: REPO, GITHUB_SHA: SHA,
  GITHUB_SERVER_URL: 'https://github.com', GITHUB_API_URL: 'https://api.github.com',
  GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' };

function fixtureApi(options = {}) {
  const calls = [], state = { main: SHA, tag: null, release: null, latest: null,
    runs: [], remoteAssets: [], ...options };
  const api = async (method, route, body) => {
    calls.push({ method, route, body });
    const endpoint = route.slice(context.root.length);
    if (method === 'GET') {
      if (endpoint === '/git/ref/heads/main') return commit(state.main);
      if (endpoint === '/git/ref/tags/v2.5.0') return state.tag ? commit(state.tag) : null;
      if (endpoint === '/releases/tags/v2.5.0') return state.release;
      if (endpoint === '/releases/latest') return state.latest;
      if (endpoint.startsWith('/actions/workflows/release.yml/runs?')) return { workflow_runs: state.runs, total_count: state.runs.length };
      if (endpoint === '/releases/123/assets?per_page=100') return state.remoteAssets;
      if (endpoint === '/releases/123') return state.release;
    }
    if (method === 'POST' && endpoint === '/git/refs') { state.tag = body.sha; return commit(body.sha); }
    if (method === 'POST' && endpoint === '/actions/workflows/release.yml/dispatches') return null;
    if (method === 'POST' && endpoint === '/releases') return (state.release = { id: 123, ...body });
    if (method === 'PATCH' && endpoint === '/releases/123') return (state.release = { ...state.release, ...body });
    throw new Error(`Unexpected test API operation ${method} ${endpoint}`);
  };
  return { api, state, calls, writes: () => calls.filter(call => call.method !== 'GET') };
}

test('release automation binds the official repository, exact commit, event, ref and stable version', () => {
  const pkg = { version: '2.5.0' }, config = { repository: REPO };
  assert.deepEqual(releaseContext(baseEnv, pkg, config, 'prepare'), context);
  assert.deepEqual(releaseContext({ ...baseEnv, GITHUB_REF: 'refs/tags/v2.5.0' }, pkg, config, 'publish'), context);
  for (const patch of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_REPOSITORY: 'attacker/fork' }, { GITHUB_SHA: 'main' },
    { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_SERVER_URL: 'https://example.com' }, { GITHUB_API_URL: 'https://example.com' }]) {
    assert.throws(() => releaseContext({ ...baseEnv, ...patch }, pkg, config, 'prepare'));
  }
  for (const version of ['2.5.0-beta', '02.5.0', '2.5.65536', '2.5.0\n', '2.5.0/../x']) {
    assert.throws(() => releaseContext(baseEnv, { version }, config, 'prepare'));
  }
  assert.throws(() => releaseContext(baseEnv, pkg, { repository: 'other/repo' }, 'prepare'));
});

test('GitHub API client keeps credentials on the fixed origin and sanitizes errors', async () => {
  const calls = [];
  const api = githubClient('test-sensitive-token', async (...args) => {
    calls.push(args); return { status: 403, ok: false, json() { throw new Error('test-sensitive-token'); } };
  });
  await assert.rejects(api('GET', `${context.root}/releases/latest`), error => error.message.includes('HTTP 403') && !error.message.includes('test-sensitive-token'));
  assert.equal(calls[0][0], `https://api.github.com${context.root}/releases/latest`);
  assert.equal(calls[0][1].redirect, 'error');
  await assert.rejects(api('GET', 'https://evil.example/'), /Unexpected/);
  await assert.rejects(api('DELETE', `${context.root}/releases/1`), /Unexpected/);
  assert.equal(calls.length, 1);
  const network = githubClient('test-sensitive-token', async () => { throw new Error('test-sensitive-token'); });
  await assert.rejects(network('GET', `${context.root}/releases/latest`), error => !error.message.includes('test-sensitive-token'));
});

test('preparation creates a non-forced exact-SHA tag then explicitly dispatches the tag workflow', async () => {
  const f = fixtureApi();
  assert.equal((await prepareRelease(f.api, context)).status, 'dispatched');
  assert.deepEqual(f.writes(), [
    { method: 'POST', route: `${context.root}/git/refs`, body: { ref: 'refs/tags/v2.5.0', sha: SHA } },
    { method: 'POST', route: `${context.root}/actions/workflows/release.yml/dispatches`, body: { ref: 'v2.5.0' } },
  ]);
});

test('preparation does not write for stale main, active runs or already published releases', async () => {
  for (const [options, status] of [[{ main: OTHER }, 'superseded'],
    [{ tag: SHA, release: { draft: false } }, 'exists'],
    [{ tag: SHA, runs: [{ head_sha: SHA, head_branch: 'v2.5.0', status: 'waiting' }] }, 'running']]) {
    const f = fixtureApi(options);
    assert.equal((await prepareRelease(f.api, context)).status, status);
    assert.deepEqual(f.writes(), []);
  }
});

test('preparation rejects tag collisions, existing drafts and downgrade attempts without writing', async () => {
  for (const options of [{ tag: OTHER }, { tag: SHA, release: { draft: true } },
    { latest: { tag_name: 'v2.6.0', draft: false, prerelease: false } }]) {
    const f = fixtureApi(options);
    await assert.rejects(prepareRelease(f.api, context));
    assert.deepEqual(f.writes(), []);
  }
});

test('preparation rechecks main immediately before writing and refuses a raced tag', async () => {
  const f = fixtureApi(); let reads = 0;
  const changingMain = async (...args) => {
    if (args[1].endsWith('/git/ref/heads/main') && ++reads === 2) f.state.main = OTHER;
    return f.api(...args);
  };
  assert.equal((await prepareRelease(changingMain, context)).status, 'superseded');
  assert.deepEqual(f.writes(), []);
  const raced = fixtureApi();
  const raceTag = async (method, route, body) => {
    if (method === 'POST' && route.endsWith('/git/refs')) {
      raced.state.tag = OTHER; const error = new Error('Exists'); error.status = 422; throw error;
    }
    return raced.api(method, route, body);
  };
  await assert.rejects(prepareRelease(raceTag, context), /tag is missing or moved/);
  assert.equal(raced.writes().length, 0);
});

test('preparation can resume a failed workflow using the unchanged tag and resolves annotated tags', async () => {
  const f = fixtureApi({ tag: SHA, runs: [{ head_sha: SHA, status: 'completed', conclusion: 'failure' }] });
  assert.equal((await prepareRelease(f.api, context)).status, 'dispatched');
  assert.equal(f.writes().length, 1);
  assert.ok(f.writes()[0].route.endsWith('/dispatches'));
  const api = async (_method, route) => route.includes('/git/ref/') ? { object: { type: 'tag', sha: OTHER } } : commit(SHA);
  assert.equal(await tagCommit(api, context), SHA);
});

const assets = [{ name: 'orb-update.json', filename: '/fixture/orb-update.json', size: 200, digest: `sha256:${'c'.repeat(64)}` }];
const uploaded = () => assets.map(asset => ({ ...asset, state: 'uploaded' }));

test('publication keeps assets in a draft until every uploaded size and digest matches', async () => {
  const f = fixtureApi({ tag: SHA });
  const result = await publishRelease(f.api, context, assets, async () => {
    assert.equal(f.state.release.draft, true);
    assert.equal(f.writes().length, 1);
    f.state.remoteAssets = uploaded();
  });
  assert.match(result, /Published v2.5.0/);
  assert.equal(f.state.release.draft, false);
  assert.equal(f.state.release.make_latest, 'true');
  assert.equal(f.writes().length, 2);
  assert.equal(f.writes()[0].body.target_commitish, SHA);
  assert.equal(f.writes()[1].method, 'PATCH');
});

test('publication never modifies an existing draft or release', async () => {
  for (const draft of [true, false]) {
    const f = fixtureApi({ tag: SHA, release: { draft } });
    await assert.rejects(publishRelease(f.api, context, assets, async () => assert.fail('unexpected upload')), /already exists/);
    assert.deepEqual(f.writes(), []);
  }
});

test('publication leaves a draft when an upload is missing, duplicated, changed or lacks a digest', async () => {
  for (const remote of [[], uploaded().map(asset => ({ ...asset, size: 201 })),
    uploaded().map(asset => ({ ...asset, digest: undefined })), [...uploaded(), ...uploaded()]]) {
    assert.equal(checkRemoteAssets(remote, assets), false);
    const f = fixtureApi({ tag: SHA, remoteAssets: remote });
    await assert.rejects(publishRelease(f.api, context, assets, async () => {}, async () => {}), /hashes or sizes differ/);
    assert.equal(f.state.release.draft, true);
    assert.equal(f.writes().some(call => call.method === 'PATCH'), false);
  }
});

test('publication rechecks the tag and latest release after upload', async () => {
  for (const change of [state => { state.tag = OTHER; }, state => { state.latest = { tag_name: 'v2.6.0', draft: false, prerelease: false }; }]) {
    const f = fixtureApi({ tag: SHA });
    await assert.rejects(publishRelease(f.api, context, assets, async () => {
      f.state.remoteAssets = uploaded(); change(f.state);
    }));
    assert.equal(f.state.release.draft, true);
    assert.equal(f.writes().some(call => call.method === 'PATCH'), false);
  }
});

test('publication verifier accepts the existing signed-update format and rejects metadata tampering', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-publish-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'scripts')); fs.mkdirSync(path.join(directory, 'dist'));
  fs.copyFileSync(path.join(__dirname, '../scripts/sign-release.cjs'), path.join(directory, 'scripts/sign-release.cjs'));
  const keys = crypto.generateKeyPairSync('ed25519');
  const config = { schema: 1, repository: REPO, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), channel: 'stable' };
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: context.version }));
  fs.writeFileSync(path.join(directory, 'update-config.json'), JSON.stringify(config));
  const dist = path.join(directory, 'dist'), installer = Buffer.alloc(1024 * 1024); installer.write('MZ');
  fs.writeFileSync(path.join(dist, 'GPT-Orb-Setup-2.5.0-x64.exe'), installer);
  for (const kind of ['Source', 'Browser-Extension']) fs.writeFileSync(path.join(dist, `GPT-Orb-2.5.0-${kind}.zip`), Buffer.from('PK-fixture'));
  const env = { ...process.env, ORB_UPDATE_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    GITHUB_REPOSITORY: REPO, GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v2.5.0' };
  const result = spawnSync(process.execPath, ['scripts/sign-release.cjs', 'dist'], { cwd: directory, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await verifiedAssets(dist, context, config)).length, 6);
  fs.appendFileSync(path.join(dist, 'latest.yml'), 'unexpected: true\n');
  await assert.rejects(verifiedAssets(dist, context, config), /metadata differs/);
});

test('workflow boundaries keep approval and signing isolated from tag preparation', () => {
  const prepare = fs.readFileSync(path.join(__dirname, '../.github/workflows/prepare-release.yml'), 'utf8');
  const release = fs.readFileSync(path.join(__dirname, '../.github/workflows/release.yml'), 'utf8');
  assert.match(prepare, /needs: validate/);
  assert.match(prepare, /actions: write/);
  assert.doesNotMatch(prepare, /ORB_UPDATE_PRIVATE_KEY|environment: release|secrets\./);
  assert.match(release, /environment: release/);
  assert.match(release, /group: publish-stable-release/);
  assert.match(release, /startsWith\(github.ref, 'refs\/tags\/v'\)/);
  assert.equal((release.match(/ORB_UPDATE_PRIVATE_KEY:/g) || []).length, 1);
  for (const workflow of [prepare, release]) {
    assert.equal((workflow.match(/uses: actions\/checkout@/g) || []).length, 2);
    assert.equal((workflow.match(/ref: \$\{\{ github.sha \}\}/g) || []).length, 2);
    assert.doesNotMatch(workflow, /pull_request_target|secrets: inherit|persist-credentials: true/);
  }
});
