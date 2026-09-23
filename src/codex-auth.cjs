'use strict';

const {spawn} = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const {StringDecoder} = require('node:string_decoder');

// Protocol and OAuth shape checked against openai/codex tag rust-v0.134.0.
// This adapter has no agent/thread/tool methods and receives no renderer-supplied
// executable, arguments, home, RPC method, OAuth URL, password or token.
const METHODS = new Set(['initialize', 'account/read', 'account/login/start', 'account/login/cancel', 'account/logout']);
const MANAGED_CODEX_ARGS = Object.freeze([
  '-c', 'cli_auth_credentials_store="keyring"',
  '-c', 'analytics.enabled=false', '-c', 'history.persistence="none"',
  '-c', 'otel.exporter="none"', '-c', 'otel.trace_exporter="none"', '-c', 'otel.metrics_exporter="none"',
  '--disable', 'plugins', '--disable', 'remote_plugin', '--disable', 'hooks', 'app-server', '--strict-config'
]);
const ALLOWED_ENV = new Set([
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'TEMP', 'TMP', 'TMPDIR',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432', 'OS', 'NUMBER_OF_PROCESSORS',
  'USERNAME', 'USERDOMAIN', 'LOGONSERVER', 'SESSIONNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE'
]);
const MAX_LINE_BYTES = 128 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 128 * 1024;
const MAX_MESSAGES = 256;
const activeHomes = new Set();
const LOGIN_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MESSAGES = Object.freeze({
  error:'连接未完成，请稍后重试。', protocol:'官方组件的登录响应未通过校验，请重新连接。',
  'not-found':'官方连接组件暂不可用，请重试。', unsupported:'官方组件不支持当前连接方式。',
  'login-busy':'另一项 Codex 登录正在进行，请完成或关闭后重试。',
  'browser-failed':'未能打开官方登录页，请检查默认浏览器后重试。',
  'auth-failed':'登录未完成，或系统凭据库不可用，请重新连接。',
  'logout-failed':'退出登录未完成，请重试。', timeout:'登录等待超时，请重新连接。',
  cancelled:'已取消连接。'
});

class CodexAuthError extends Error {
  constructor(code = 'error') {
    super(MESSAGES[code] || MESSAGES.error);
    this.name = 'CodexAuthError';
    this.code = Object.hasOwn(MESSAGES, code) ? code : 'error';
  }
}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const safeError = error => error instanceof CodexAuthError ? error : new CodexAuthError();
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // A terminal child failure can occur before the flow starts awaiting this.
  promise.catch(() => {});
  return {promise, resolve, reject};
}

function managedCodexEnv(codexHome, baseEnv = process.env) {
  if (typeof codexHome !== 'string' || !path.isAbsolute(codexHome)) throw new CodexAuthError('not-found');
  const result = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (ALLOWED_ENV.has(key.toUpperCase()) && typeof value === 'string') result[key] = value;
  }
  // Do not inherit endpoint overrides, API keys, external tokens, tracing
  // exporters or another Codex installation's home/configuration.
  return {...result, CODEX_HOME:codexHome, CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED:'1', RUST_LOG:'off'};
}

function validateAuthUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(value)) throw new CodexAuthError('protocol');
  if (!value.startsWith('https://auth.openai.com/oauth/authorize?')) throw new CodexAuthError('protocol');
  let url;
  try { url = new URL(value); } catch { throw new CodexAuthError('protocol'); }
  // Pin the browser destination and the registered loopback redirect. Never
  // accept arbitrary URLs, custom protocols, credentials, fragments or ports.
  if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com' || url.port || url.username || url.password || url.hash || url.pathname !== '/oauth/authorize') throw new CodexAuthError('protocol');
  const allowed = new Set(['response_type', 'client_id', 'redirect_uri', 'scope', 'code_challenge', 'code_challenge_method', 'id_token_add_organizations', 'codex_cli_simplified_flow', 'state', 'originator', 'allowed_workspace_id']);
  for (const key of url.searchParams.keys()) if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) throw new CodexAuthError('protocol');
  const param = key => url.searchParams.get(key);
  if (param('response_type') !== 'code' || param('client_id') !== 'app_EMoamEEZ73f0CkXaXp7hrann' ||
      !['http://localhost:1455/auth/callback', 'http://localhost:1457/auth/callback'].includes(param('redirect_uri')) ||
      param('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(param('code_challenge') || '') ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(param('state') || '') ||
      param('scope') !== 'openid profile email offline_access api.connectors.read api.connectors.invoke' ||
      param('id_token_add_organizations') !== 'true' || param('codex_cli_simplified_flow') !== 'true' ||
      !/^[A-Za-z0-9_.-]{1,160}$/.test(param('originator') || '')) throw new CodexAuthError('protocol');
  return url.href;
}

// The pinned official login server attempts to cancel an existing callback
// listener on 1455. Refuse an already occupied port instead. This is a local
// occupancy preflight, not a security boundary against another local process
// racing to bind after this check; the OAuth server remains the official binary.
function checkLoginPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    const timer = setTimeout(() => { try { server.close(); } catch {} reject(new CodexAuthError('login-busy')); }, 1500);
    server.once('error', () => { clearTimeout(timer); reject(new CodexAuthError('login-busy')); });
    server.listen({host:'127.0.0.1', port:1455, exclusive:true}, () => {
      server.close(error => { clearTimeout(timer); error ? reject(new CodexAuthError('login-busy')) : resolve(); });
    });
  });
}

/** Bounded JSONL transport. Raw child output is never logged or returned. */
function connection({executable, cwd, codexHome, spawnImpl, onNotification, baseEnv}) {
  let child, failure = null, ended = false, exited = false, sequence = 0;
  let stdoutBytes = 0, stderrBytes = 0, messages = 0, buffer = '', killTimer = null;
  const pending = new Map();
  const fatal = deferred();
  const terminated = deferred();
  const decoder = new StringDecoder('utf8');
  function finish(error = new CodexAuthError('cancelled')) {
    if (ended) return;
    ended = true;
    failure = error;
    fatal.reject(error);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
    buffer = '';
    if (!child) return;
    for (const stream of [child.stdin, child.stdout, child.stderr]) try { stream?.destroy(); } catch {}
    if (!exited) {
      try { child.kill('SIGTERM'); } catch {}
      if (!exited) {
        killTimer = setTimeout(() => { try { if (!exited) child.kill('SIGKILL'); } catch {} }, 500);
        killTimer.unref?.();
      }
    }
  }
  const fault = (code = 'protocol') => finish(new CodexAuthError(code));
  function receive(line) {
    if (ended) return;
    if (++messages > MAX_MESSAGES || Buffer.byteLength(line) > MAX_LINE_BYTES) return fault();
    let message;
    try { message = JSON.parse(line); } catch { return fault(); }
    if (!record(message) || own(message, 'jsonrpc') && message.jsonrpc !== '2.0') return fault();
    if (own(message, 'method')) {
      // No server requests: reject execution/approval/refresh-token requests.
      if (own(message, 'id') || own(message, 'result') || own(message, 'error') || typeof message.method !== 'string' || message.method.length > 160) return fault();
      try { onNotification(message.method, message.params); } catch { fault(); }
      return;
    }
    const request = pending.get(message.id);
    if (!request || own(message, 'result') === own(message, 'error')) return fault();
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (own(message, 'error')) {
      if (!record(message.error) || !Number.isInteger(message.error.code)) { request.reject(new CodexAuthError('protocol')); return fault(); }
      request.reject(new CodexAuthError(message.error.code === -32601 ? 'unsupported' : 'auth-failed'));
    } else request.resolve(message.result);
  }
  function data(chunk) {
    if (ended) return;
    stdoutBytes += Buffer.byteLength(chunk);
    if (stdoutBytes > MAX_OUTPUT_BYTES) return fault();
    buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    let newline;
    while (!ended && (newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      receive(line);
    }
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) fault();
  }
  function write(message) {
    if (ended) throw failure;
    try { child.stdin.write(`${JSON.stringify(message)}\n`, error => { if (error) fault('error'); }); }
    catch { fault('error'); throw failure; }
  }
  try {
    child = spawnImpl(executable, [...MANAGED_CODEX_ARGS], {cwd, env:managedCodexEnv(codexHome, baseEnv), shell:false, windowsHide:true, stdio:['pipe', 'pipe', 'pipe']});
  } catch (error) { throw new CodexAuthError(error?.code === 'ENOENT' ? 'not-found' : 'error'); }
  if (!child?.stdin || !child?.stdout || !child?.stderr || typeof child.on !== 'function') { finish(); throw new CodexAuthError(); }
  child.on('error', error => fault(error?.code === 'ENOENT' ? 'not-found' : 'error'));
  const onExit = code => { exited = true; terminated.resolve(); clearTimeout(killTimer); if (!ended) fault(code === 2 ? 'unsupported' : 'error'); };
  child.on('exit', onExit);
  child.on('close', onExit);
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', () => fault('error'));
  child.stdout.on('data', data);
  child.stderr.on('data', chunk => { stderrBytes += Buffer.byteLength(chunk); if (stderrBytes > MAX_STDERR_BYTES) fault(); });
  return {
    fatal: fatal.promise,
    terminated:terminated.promise,
    get hasExited() { return exited; },
    assertOpen() { if (ended) throw failure; },
    request(method, params, timeoutMs = 10000) {
      if (!METHODS.has(method) || pending.size >= 3) return Promise.reject(new CodexAuthError('protocol'));
      if (ended) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => fault('timeout'), timeoutMs);
        pending.set(id, {resolve, reject, timer});
        try { write({id, method, ...(params === undefined ? {} : {params})}); } catch (error) { reject(error); }
      });
    },
    initialized() { write({method:'initialized', params:{}}); },
    close:finish,
    async stopAndWait() {
      finish();
      if (exited) return;
      let timer;
      try {
        await Promise.race([terminated.promise, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new CodexAuthError('logout-failed')), 2000);
        })]);
      } finally { clearTimeout(timer); }
    }
  };
}

function validateOptions({executable, codexHome, cwd}) {
  for (const value of [executable, codexHome, cwd]) if (typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000-\u001f]/.test(value)) throw new CodexAuthError('not-found');
  if (!/\.exe$/i.test(executable)) throw new CodexAuthError('not-found');
  // Root owns directory creation and integrity verification. Never discover PATH
  // shims or silently fall back to the user's existing Codex home here.
  return path.resolve(codexHome).toLowerCase();
}
function accountConnected(value) {
  return record(value) && record(value.account) && value.account.type === 'chatgpt' &&
    typeof value.account.email === 'string' && value.account.email.length > 0 && value.account.email.length <= 512;
}
function notify(callback, status, code) {
  try { callback?.({status, ...(code ? {code} : {})}); } catch {}
}
function releaseHomeWhenStopped(key, ...channels) {
  // A failed SIGKILL/exit wait must not permit a new login while an old
  // credential writer/deleter could still be alive. A later actual exit unlocks.
  const running = channels.filter(channel => channel && !channel.hasExited);
  if (!running.length) activeHomes.delete(key);
  else Promise.all(running.map(channel => channel.terminated)).then(() => activeHomes.delete(key));
}
async function initialize(channel, timeoutMs = 10000) {
  const result = await channel.request('initialize', {clientInfo:{name:'gpt_usage_orb_safe', title:'GPT Usage Orb Safe', version:require('../package.json').version}}, timeoutMs);
  channel.assertOpen();
  if (!record(result)) throw new CodexAuthError('protocol');
  channel.initialized();
}

async function loginManagedCodex({executable, codexHome, cwd, signal, openExternal, onStatus, spawnImpl = spawn, timeoutMs = 180000, checkPort = checkLoginPort, baseEnv = process.env} = {}) {
  const key = validateOptions({executable, codexHome, cwd});
  if (typeof openExternal !== 'function') throw new CodexAuthError('browser-failed');
  if (signal?.aborted) throw new CodexAuthError('cancelled');
  if (activeHomes.has(key)) throw new CodexAuthError('login-busy');
  activeHomes.add(key);
  let channel, cleanupChannel, loginId = null, startIssued = false, cancelled = false, finished = false, timer, cleanup = null;
  let completed = null, accountUpdated = false, earlyCompletion = null;
  const interrupt = deferred(), signedIn = deferred();
  const duration = Math.max(1, Math.min(300000, Number.isFinite(timeoutMs) ? timeoutMs : 180000));
  function assertActive() { if (cancelled || signal?.aborted) throw new CodexAuthError('cancelled'); channel?.assertOpen(); }
  function settleLogin() { if (completed === true && accountUpdated) signedIn.resolve(); }
  function notification(method, params) {
    if (cancelled || finished) return;
    if (method === 'account/login/completed') {
      if (!record(params) || !LOGIN_ID.test(params.loginId || '') || typeof params.success !== 'boolean') throw new CodexAuthError('protocol');
      // Notification may be queued in the same stdout chunk as the start reply.
      if (!loginId) { if (earlyCompletion) throw new CodexAuthError('protocol'); earlyCompletion = {loginId:params.loginId, success:params.success}; return; }
      if (params.loginId !== loginId || completed !== null) throw new CodexAuthError('protocol');
      completed = params.success;
      if (!completed) signedIn.reject(new CodexAuthError('auth-failed')); else settleLogin();
    } else if (method === 'account/updated') {
      if (!record(params)) throw new CodexAuthError('protocol');
      // This notification follows the official auth manager's reload. Waiting
      // for it avoids accepting a cached old account or racing account/read.
      if (completed === true || earlyCompletion?.success === true) {
        if (params.authMode !== 'chatgpt') throw new CodexAuthError('protocol');
        accountUpdated = true;
        settleLogin();
      }
    }
  }
  async function cancelSession() {
    if (!channel) return true;
    if (loginId) {
      try { await channel.request('account/login/cancel', {loginId}, 1000); } catch {}
    }
    // The official cancel RPC signals the listener but does not join a callback
    // already exchanging/persisting credentials. Stop and await the old process
    // before cleanup, so it cannot write credentials after logout completes.
    try { await channel.stopAndWait(); } catch { return false; }
    if (!startIssued) return true;
    // Also covers cancellation while login/start's response/loginId is pending.
    // No cached-account fast path is used on this independent cleanup process.
    let cleaner, cleared = false;
    try {
      cleaner = connection({executable, codexHome, cwd, spawnImpl, onNotification:() => {}, baseEnv});
      cleanupChannel = cleaner;
      await initialize(cleaner, 5000);
      // Official revocation times out after 10 s, then removes local keyring
      // data. Leave time for that local deletion even when the network is down.
      const result = await cleaner.request('account/logout', undefined, 12000);
      if (!record(result)) throw new CodexAuthError('protocol');
      const account = await cleaner.request('account/read', {refreshToken:false}, 1000);
      cleaner.assertOpen();
      cleared = record(account) && account.account === null;
    } catch {}
    finally { try { await cleaner?.stopAndWait(); } catch { cleared = false; } }
    return cleared;
  }
  function cancel(code = 'cancelled') {
    if (cancelled || finished) return;
    cancelled = true;
    interrupt.reject(new CodexAuthError(code));
    cleanup = cancelSession();
  }
  const onAbort = () => cancel();
  try {
    notify(onStatus, 'preparing');
    signal?.addEventListener('abort', onAbort, {once:true});
    timer = setTimeout(() => cancel('timeout'), duration);
    if (signal?.aborted) onAbort();
    const operation = (async () => {
      assertActive();
      channel = connection({executable, codexHome, cwd, spawnImpl, onNotification:notification, baseEnv});
      // Fatal transport errors also stop waits between RPC requests.
      channel.fatal.catch(error => signedIn.reject(error));
      await initialize(channel);
      assertActive();
      // An explicit Connect/Reconnect must perform fresh official login.
      // account/read(refreshToken:false) can report cached claims even when the
      // credential is expired; normal app startup resumes the read-only provider.
      await checkPort();
      assertActive();
      startIssued = true;
      const result = await channel.request('account/login/start', {type:'chatgpt'});
      assertActive();
      if (!record(result) || result.type !== 'chatgpt' || !LOGIN_ID.test(result.loginId || '')) throw new CodexAuthError('protocol');
      loginId = result.loginId;
      const authUrl = validateAuthUrl(result.authUrl);
      if (earlyCompletion) {
        if (earlyCompletion.loginId !== loginId) throw new CodexAuthError('protocol');
        completed = earlyCompletion.success;
        if (!completed) throw new CodexAuthError('auth-failed');
        settleLogin();
      }
      assertActive();
      try { await openExternal(authUrl); } catch { throw new CodexAuthError('browser-failed'); }
      assertActive();
      notify(onStatus, 'waiting');
      await signedIn.promise;
      assertActive();
      const account = await channel.request('account/read', {refreshToken:false});
      assertActive();
      if (!accountConnected(account)) throw new CodexAuthError('auth-failed');
      return {connected:true};
    })();
    const result = await Promise.race([operation, interrupt.promise]);
    assertActive();
    await channel.stopAndWait();
    if (cancelled || signal?.aborted) throw new CodexAuthError('cancelled');
    finished = true;
    notify(onStatus, 'connected');
    return result;
  } catch (error) {
    let safe = safeError(error);
    // Cleanup is one operation even if the user presses Cancel or the overall
    // login deadline expires while a failed browser/auth attempt is cleaning up.
    cancelled = true;
    clearTimeout(timer);
    // Browser launch/validation errors also cancel the callback listener.
    if (!cleanup) cleanup = cancelSession();
    if (!await cleanup) safe = new CodexAuthError('logout-failed');
    notify(onStatus, safe.code === 'cancelled' ? 'cancelled' : 'error', safe.code);
    throw safe;
  } finally {
    finished = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    channel?.close();
    releaseHomeWhenStopped(key, channel, cleanupChannel);
  }
}

async function logoutManagedCodex({executable, codexHome, cwd, signal, onStatus, spawnImpl = spawn, baseEnv = process.env} = {}) {
  const key = validateOptions({executable, codexHome, cwd});
  if (signal?.aborted) throw new CodexAuthError('cancelled');
  if (activeHomes.has(key)) throw new CodexAuthError('login-busy');
  activeHomes.add(key);
  let channel;
  const onAbort = () => channel?.close(new CodexAuthError('cancelled'));
  try {
    channel = connection({executable, codexHome, cwd, spawnImpl, onNotification:() => {}, baseEnv});
    signal?.addEventListener('abort', onAbort, {once:true});
    if (signal?.aborted) onAbort();
    await initialize(channel);
    const result = await channel.request('account/logout', undefined, 12000);
    if (!record(result)) throw new CodexAuthError('protocol');
    const account = await channel.request('account/read', {refreshToken:false});
    channel.assertOpen();
    if (!record(account) || account.account !== null) throw new CodexAuthError('logout-failed');
    await channel.stopAndWait();
    if (signal?.aborted) throw new CodexAuthError('cancelled');
    notify(onStatus, 'disconnected');
    return {connected:false};
  } catch (error) { throw safeError(error); }
  finally {
    signal?.removeEventListener('abort', onAbort);
    try { await channel?.stopAndWait(); }
    catch { throw new CodexAuthError('logout-failed'); }
    finally { releaseHomeWhenStopped(key, channel); }
  }
}

module.exports = {CodexAuthError, MANAGED_CODEX_ARGS, managedCodexEnv, validateAuthUrl, loginManagedCodex, logoutManagedCodex};
