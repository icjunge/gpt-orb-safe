'use strict';

const { compareVersions } = require('../src/update-security.cjs');
const REPOSITORY = 'icjunge/gpt-orb-safe';
const SHA = /^[a-f0-9]{40}$/;
const VERSION = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/;

function releaseContext(env, pkg, config, mode) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== REPOSITORY || config.repository !== REPOSITORY ||
      env.GITHUB_SERVER_URL !== 'https://github.com' || env.GITHUB_API_URL !== 'https://api.github.com' ||
      !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) || env.GITHUB_SHA?.length !== 40 || !SHA.test(env.GITHUB_SHA || '')) {
    throw new Error('Release automation requires the official repository and an exact GitHub Actions commit.');
  }
  if (!VERSION.test(pkg.version || '') || pkg.version !== pkg.version.trim() || pkg.version.split('.').some(part => Number(part) > 65535)) {
    throw new Error('Release version must be a stable Windows-compatible X.Y.Z version.');
  }
  const tag = `v${pkg.version}`;
  const ref = mode === 'prepare' ? 'refs/heads/main' : `refs/tags/${tag}`;
  if (env.GITHUB_REF !== ref) throw new Error('Release workflow is running from an unexpected ref.');
  return Object.freeze({ repository: REPOSITORY, version: pkg.version, tag, sha: env.GITHUB_SHA,
    root: `/repos/${REPOSITORY}` });
}

function githubClient(token, fetcher = globalThis.fetch) {
  if (typeof token !== 'string' || !token.trim()) throw new Error('Missing scoped GitHub Actions token.');
  return async (method, route, body, options = {}) => {
    if (!['GET', 'POST', 'PATCH'].includes(method) || !route.startsWith(`/repos/${REPOSITORY}/`) ||
        route.includes('..') || route.includes('#')) throw new Error('Unexpected GitHub API operation.');
    let response;
    try {
      const timeout = AbortSignal.timeout(60000);
      response = await fetcher(`https://api.github.com${route}`, {
        method, redirect: 'error', signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', 'User-Agent': 'GPT-Orb-Release' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new Error('GitHub API connection failed; no credentials or response body were logged.'); }
    if (method === 'GET' && response.status === 404) return null;
    if (!response.ok) {
      const error = new Error(`GitHub API ${method} failed (HTTP ${response.status}).`);
      error.status = response.status;
      throw error;
    }
    const cancelRequest = method === 'POST' && /^\/repos\/icjunge\/gpt-orb-safe\/actions\/runs\/\d+\/cancel$/.test(route);
    if (cancelRequest && response.status !== 202) throw new Error('GitHub did not accept the ordinary workflow cancellation.');
    if (response.status === 202 && !cancelRequest) throw new Error('Unexpected asynchronous GitHub API response.');
    if (response.status === 204) return null;
    // Cancel is asynchronous and may return an empty 202 response. Do not treat
    // arbitrary accepted responses from other mutation endpoints as success.
    if (response.status === 202 && cancelRequest) return null;
    try { return await response.json(); }
    catch { throw new Error('GitHub API returned invalid JSON.'); }
  };
}

async function tagCommit(api, context) {
  let value = await api('GET', `${context.root}/git/ref/tags/${context.tag}`);
  if (!value) return null;
  let object = value.object;
  for (let depth = 0; depth < 5; depth++) {
    if (object?.sha?.length !== 40 || !SHA.test(object?.sha || '')) throw new Error('Invalid release tag target.');
    if (object.type === 'commit') return object.sha;
    if (object.type !== 'tag') throw new Error('Release tag does not point to a commit.');
    value = await api('GET', `${context.root}/git/tags/${object.sha}`);
    object = value?.object;
  }
  throw new Error('Release tag nesting exceeds the supported limit.');
}

async function requireExactTag(api, context) {
  if (await tagCommit(api, context) !== context.sha) throw new Error('Release tag is missing or moved; refusing to publish.');
}

async function requireNewerRelease(api, context) {
  const latest = await api('GET', `${context.root}/releases/latest`);
  if (!latest) return;
  if (latest.draft || latest.prerelease || !/^v/.test(latest.tag_name || '') ||
      latest.tag_name !== latest.tag_name.trim() || !VERSION.test(latest.tag_name.slice(1))) throw new Error('Cannot validate the current stable release version.');
  if (compareVersions(context.version, latest.tag_name.slice(1)) <= 0) {
    throw new Error('Release must be newer than the published stable version.');
  }
}

module.exports = { REPOSITORY, releaseContext, githubClient, tagCommit, requireExactTag, requireNewerRelease };
