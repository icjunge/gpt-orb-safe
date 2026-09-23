'use strict';

// CI only: use the pinned official Windows component with a fresh private home.
// Never start a browser login, model task, or read the runner's existing account.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const {EventEmitter} = require('node:events');
const {spawn} = require('node:child_process');
const {StringDecoder} = require('node:string_decoder');
const {createCodexRuntime, PINNED_CODEX_RUNTIME} = require('../src/codex-runtime.cjs');
const {MANAGED_CODEX_ARGS, managedCodexEnv} = require('../src/codex-auth.cjs');

// A small Node transport adapter for the production downloader's Electron
// request interface. Redirect acceptance stays in the production downloader.
function nodeRequest(options) {
  assert.equal(options.credentials, 'omit');
  assert.equal(options.useSessionCookies, false);
  assert.equal(options.redirect, 'manual');
  assert.equal(options.method, 'GET');
  const events = new EventEmitter();
  const headers = {'User-Agent':'gpt-orb-managed-component-ci'};
  let active, redirected, aborted = false, started = false;
  function begin(url) {
    if (aborted) return;
    active = https.request(url, {method:'GET', headers}, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        if (typeof response.headers.location !== 'string') {
          response.destroy(); events.emit('error', new Error('Redirect has no destination.')); return;
        }
        redirected = new URL(response.headers.location, url).href;
        response.resume();
        events.emit('redirect', response.statusCode, 'GET', redirected, response.headers);
      } else events.emit('response', response);
    });
    active.on('error', () => { if (!aborted) events.emit('error', new Error('Component request failed.')); });
    active.end();
  }
  events.setHeader = (name, value) => {
    assert.equal(started, false);
    assert(!/^(authorization|cookie|proxy-authorization)$/i.test(name));
    headers[name] = value;
  };
  events.end = () => { assert.equal(started, false); started = true; begin(options.url); };
  events.followRedirect = () => {
    assert.equal(typeof redirected, 'string');
    const next = redirected; redirected = undefined; begin(next);
  };
  events.abort = () => { if (aborted) return; aborted = true; active?.destroy(); events.emit('abort'); };
  return events;
}

async function probeFreshAccount(executable, codexHome, cwd) {
  const env = managedCodexEnv(codexHome, {...process.env,
    OPENAI_API_KEY:'ci-must-not-inherit', CODEX_API_KEY:'ci-must-not-inherit',
    CODEX_ACCESS_TOKEN:'ci-must-not-inherit', OPENAI_BASE_URL:'https://invalid.example',
    CODEX_HOME:path.join(cwd, 'must-not-use')});
  assert.equal(env.CODEX_HOME, codexHome);
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL']) assert(!Object.hasOwn(env, key));
  assert(MANAGED_CODEX_ARGS.includes('cli_auth_credentials_store="keyring"'));
  const child = spawn(executable, [...MANAGED_CODEX_ARGS], {
    cwd, env, shell:false, windowsHide:true, stdio:['pipe', 'pipe', 'pipe']
  });
  const pending = new Map();
  const decoder = new StringDecoder('utf8');
  let buffer = '', stdoutBytes = 0, stderrBytes = 0, sequence = 0, closing = false, failure;
  const stopped = new Promise(resolve => child.once('close', resolve));
  function fail(message) {
    if (failure) return;
    failure = new Error(message);
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(failure); }
    pending.clear();
    child.kill();
  }
  child.on('error', () => fail('Official component could not start.'));
  child.on('exit', () => { if (!closing) fail('Official component exited before the protocol check completed.'); });
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', () => { if (!closing) fail('Official component pipe failed.'); });
  child.stderr.on('data', chunk => {
    // Never print raw component output, which could contain private paths.
    stderrBytes += chunk.length;
    if (stderrBytes > 128 * 1024) fail('Official component exceeded the stderr bound.');
  });
  child.stdout.on('data', chunk => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > 1024 * 1024) return fail('Official component exceeded the output bound.');
    buffer += decoder.write(chunk);
    let newline;
    while (!failure && (newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > 128 * 1024) return fail('Official component exceeded the line bound.');
      let message;
      try { message = JSON.parse(line); } catch { return fail('Official component returned invalid JSON.'); }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return fail('Official component returned an invalid message.');
      if (Object.hasOwn(message, 'method')) {
        if (Object.hasOwn(message, 'id') || typeof message.method !== 'string') return fail('Official component requested an unexpected client action.');
        continue;
      }
      const item = pending.get(message.id);
      if (!item || !Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')) return fail('Official component rejected a fixed account request.');
      pending.delete(message.id); clearTimeout(item.timer); item.resolve(message.result);
    }
    if (Buffer.byteLength(buffer) > 128 * 1024) fail('Official component exceeded the line bound.');
  });
  function send(method, params) {
    assert(['initialize', 'account/read', 'account/logout'].includes(method));
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => fail('Official component account request timed out.'), 15000);
      pending.set(id, {resolve, reject, timer});
      child.stdin.write(JSON.stringify({id, method, ...(params === undefined ? {} : {params})}) + '\n');
    });
  }
  try {
    const initialized = await send('initialize', {clientInfo:{name:'gpt_orb_managed_ci', title:'GPT Orb managed component CI', version:'1.0.0'}});
    assert(initialized && typeof initialized === 'object', 'Official initialize result missing.');
    child.stdin.write(JSON.stringify({method:'initialized', params:{}}) + '\n');
    assert.equal((await send('account/read', {refreshToken:false})).account, null, 'Isolated managed home inherited an account.');
    const loggedOut = await send('account/logout');
    assert(loggedOut && typeof loggedOut === 'object', 'Official logout result missing.');
    assert.equal((await send('account/read', {refreshToken:false})).account, null, 'Isolated managed home did not stay signed out.');
  } finally {
    closing = true;
    for (const item of pending.values()) clearTimeout(item.timer);
    child.stdin.end();
    const force = setTimeout(() => child.kill(), 3000);
    const hardLimit = setTimeout(() => child.kill('SIGKILL'), 5000);
    await stopped;
    clearTimeout(force); clearTimeout(hardLimit);
  }
}

async function run() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    console.log('Managed Codex component smoke requires Windows x64.'); return;
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-orb-managed-ci-'));
  let phase = 'prepare';
  try {
    const userDataDir = path.join(temporary, 'profile');
    const codexHome = path.join(userDataDir, 'codex-managed-home');
    const cwd = path.join(userDataDir, 'codex-query');
    await fs.mkdir(codexHome, {recursive:true});
    await fs.mkdir(cwd, {recursive:true});
    let requests = 0;
    const runtime = createCodexRuntime({userDataDir, timeoutMs:6 * 60 * 1000,
      request:options => { requests++; return nodeRequest(options); }});
    assert.equal(await runtime.getVerifiedExecutable(), null);
    assert.equal(requests, 0, 'A passive runtime probe downloaded a component.');
    phase = 'download-and-verify';
    const ready = await runtime.ensureReady();
    const executable = typeof ready === 'string' ? ready : ready.path;
    assert(path.isAbsolute(executable), 'Verified executable path missing.');
    assert.equal(requests, 1);
    assert.deepEqual(await runtime.getVerifiedExecutable(), ready);
    assert.deepEqual(await runtime.ensureReady(), ready);
    assert.equal(requests, 1, 'Cached component was downloaded again.');
    phase = 'official-account-protocol';
    await probeFreshAccount(executable, codexHome, cwd);
    phase = 'credential-isolation';
    for (const name of ['auth.json', '.credentials.json']) {
      await assert.rejects(fs.access(path.join(codexHome, name)), {code:'ENOENT'}, 'Managed component created a plaintext credential fallback.');
    }
    console.log(`Managed component ${PINNED_CODEX_RUNTIME.version}: verified download, cached reuse, isolated official account protocol, and no plaintext credential file passed.`);
  } catch {
    // Keep raw child/request output and user profile paths out of CI logs.
    throw new Error(`Managed Codex Windows smoke failed during ${phase}.`);
  } finally {
    await fs.rm(temporary, {recursive:true, force:true, maxRetries:5, retryDelay:250});
  }
}

if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = {nodeRequest, probeFreshAccount, run};
