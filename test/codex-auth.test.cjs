'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {PassThrough, Writable} = require('node:stream');
const {CodexAuthError, MANAGED_CODEX_ARGS, managedCodexEnv, validateAuthUrl, loginManagedCodex, logoutManagedCodex} = require('../src/codex-auth.cjs');

const EXE = path.resolve('fixture-managed', 'codex.exe');
const HOME = path.resolve('fixture-managed', 'private-home');
const CWD = path.resolve('fixture-managed', 'empty-workdir');
const ID = '81464138-451b-44ce-8ce1-bdc5ee0ca7de';
const OTHER_ID = '351542cb-e559-4bf9-af15-e690f5e0f196';
function authUrl() {
  const url = new URL('https://auth.openai.com/oauth/authorize');
  for (const [key, value] of Object.entries({response_type:'code', client_id:'app_EMoamEEZ73f0CkXaXp7hrann', redirect_uri:'http://localhost:1455/auth/callback', scope:'openid profile email offline_access api.connectors.read api.connectors.invoke', code_challenge:'x'.repeat(43), code_challenge_method:'S256', id_token_add_organizations:'true', codex_cli_simplified_flow:'true', state:'s'.repeat(43), originator:'gpt_usage_orb_safe'})) url.searchParams.set(key, value);
  return url.href;
}
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(handler = () => undefined, {onKill} = {}) {
  let child, spawned, connected = false, accountReads = 0;
  const calls = [], opened = [], statuses = [], children = [];
  const emit = message => { if (!child.stdout.destroyed) child.stdout.write(`${JSON.stringify(message)}\n`); };
  function complete({id = ID, success = true, update = true} = {}) {
    connected = success;
    emit({method:'account/login/completed', params:{loginId:id, success, error:success ? null : 'private raw auth token error'}});
    if (update && success) emit({method:'account/updated', params:{authMode:'chatgpt', planType:'pro'}});
  }
  const spawnImpl = (executable, args, options) => {
    spawned = {executable, args, options};
    child = new EventEmitter();
    children.push(child);
    child.calls = [];
    child.index = children.length - 1;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kills = [];
    const current = child;
    child.kill = signal => {
      current.kills.push(signal);
      if (onKill?.({child:current, signal, setConnected:value => { connected = value; }}) !== false) queueMicrotask(() => current.emit('close', 0));
      return true;
    };
    child.stdin = new Writable({write(chunk, encoding, callback) {
      const message = JSON.parse(chunk.toString());
      calls.push(message);
      current.calls.push(message);
      if (message.method === 'account/read') accountReads++;
      let response = handler(message, {child, emit, complete, calls, accountReads});
      if (response === undefined) {
        if (message.method === 'initialize') response = {result:{userAgent:'fixture'}};
        else if (message.method === 'account/login/start') response = {result:{type:'chatgpt', loginId:ID, authUrl:authUrl()}};
        else if (message.method === 'account/login/cancel') response = {result:{status:'canceled'}};
        else if (message.method === 'account/logout') { connected = false; response = {result:{}}; }
        else if (message.method === 'account/read') response = {result:{account:connected ? {type:'chatgpt', email:'private@example.invalid', planType:'pro'} : null, requiresOpenaiAuth:true}};
      }
      if (response && message.id !== undefined) queueMicrotask(() => {
        if (child.stdout.destroyed) return;
        if (response.stderr) child.stderr.write(response.stderr);
        if (response.raw !== undefined) child.stdout.write(response.raw);
        else emit({id:message.id, ...response});
      });
      callback();
    }});
    return child;
  };
  return {calls, opened, statuses, children, emit, complete, spawnImpl, get connected() { return connected; }, get child() { return child; }, get spawned() { return spawned; }};
}
function login(f, options = {}) {
  return loginManagedCodex({executable:EXE, codexHome:HOME, cwd:CWD, spawnImpl:f.spawnImpl, checkPort:async () => {},
    openExternal:async url => { f.opened.push(url); queueMicrotask(() => f.complete()); },
    onStatus:status => f.statuses.push(status), ...options});
}
function logout(f, options = {}) { return logoutManagedCodex({executable:EXE, codexHome:HOME, cwd:CWD, spawnImpl:f.spawnImpl, ...options}); }
const rejectsCode = (promise, code) => assert.rejects(promise, error => error instanceof CodexAuthError && error.code === code && error.message.length < 100 && !/private|secret|Bearer|https:/.test(error.message));

test('managed login opens only official authorization and reports sanitized verified account status', async () => {
  const f = fixture();
  assert.deepEqual(await login(f), {connected:true});
  assert.deepEqual(f.calls.map(x => x.method), ['initialize', 'initialized', 'account/login/start', 'account/read']);
  assert.deepEqual(f.calls.find(x => x.method === 'account/login/start').params, {type:'chatgpt'});
  assert.deepEqual(f.calls.find(x => x.method === 'account/read').params, {refreshToken:false});
  assert.equal(f.opened[0], authUrl());
  assert.deepEqual(f.statuses, [{status:'preparing'}, {status:'waiting'}, {status:'connected'}]);
  assert.equal(f.child.kills[0], 'SIGTERM');
  assert.equal(f.spawned.executable, EXE);
  assert.deepEqual(f.spawned.args, [...MANAGED_CODEX_ARGS]);
  assert.equal(f.spawned.options.shell, false);
  assert.equal(f.spawned.options.windowsHide, true);
  assert.equal(f.spawned.options.env.CODEX_HOME, HOME);
  assert.equal(f.spawned.options.env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED, '1');
  assert.ok(!JSON.stringify(f.statuses).includes('private@example.invalid'));
});

test('keyring mode is mandatory; analytics, history, plugins and hooks are disabled without fallback', async () => {
  const f = fixture(message => message.method === 'initialize' ? {error:{code:-32601, message:'secret keyring issue'}} : undefined);
  await rejectsCode(login(f), 'unsupported');
  assert.equal(f.calls.length, 1);
  assert.ok(MANAGED_CODEX_ARGS.includes('cli_auth_credentials_store="keyring"'));
  assert.ok(MANAGED_CODEX_ARGS.includes('analytics.enabled=false'));
  assert.ok(MANAGED_CODEX_ARGS.includes('history.persistence="none"'));
  assert.ok(MANAGED_CODEX_ARGS.includes('--strict-config'));
  assert.equal(MANAGED_CODEX_ARGS.some(arg => /auto|file|ephemeral/.test(arg)), false);
});

test('managed environment excludes inherited credentials/endpoints/tracing and preserves native proxy settings', () => {
  const env = managedCodexEnv(HOME, {Path:'C:\\Windows', SystemRoot:'C:\\Windows', APPDATA:'C:\\profile\\AppData', HTTPS_PROXY:'http://127.0.0.1:8080', NO_PROXY:'localhost,127.0.0.1', SSL_CERT_FILE:'C:\\cert.pem', CODEX_HOME:'C:\\existing-codex', OPENAI_API_KEY:'secret', openai_api_key:'secret2', CODEX_ACCESS_TOKEN:'secret3', CODEX_API_KEY:'secret4', CODEX_REFRESH_TOKEN_URL_OVERRIDE:'https://evil.invalid', CODEX_REVOKE_TOKEN_URL_OVERRIDE:'https://evil.invalid', OTEL_EXPORTER_OTLP_ENDPOINT:'https://evil.invalid', NODE_OPTIONS:'--require malicious', RUST_LOG:'trace', AWS_SECRET_ACCESS_KEY:'private', UNKNOWN_TOKEN:'private'});
  assert.deepEqual(env, {Path:'C:\\Windows', SystemRoot:'C:\\Windows', APPDATA:'C:\\profile\\AppData', HTTPS_PROXY:'http://127.0.0.1:8080', NO_PROXY:'localhost,127.0.0.1', SSL_CERT_FILE:'C:\\cert.pem', CODEX_HOME:HOME, CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED:'1', RUST_LOG:'off'});
});

test('URL verifier rejects arbitrary hosts, protocols, ports, redirects and OAuth downgrade', () => {
  assert.equal(validateAuthUrl(authUrl()), authUrl());
  const invalid = [undefined, 'file:///C:/secret.exe', 'https://evil.invalid/oauth/authorize', authUrl().replace('auth.openai.com', 'auth.openai.com.evil.invalid'), authUrl().replace('auth.openai.com', 'user:pass@auth.openai.com'), authUrl().replace('auth.openai.com', 'auth.openai.com:444'), authUrl().replace('https:', 'http:'), authUrl().replace('/oauth/authorize', '/evil/../oauth/authorize'), `${authUrl()}#secret`, `${authUrl()}&return_to=https://evil.invalid`, `${authUrl()}&state=other`, authUrl().replace('https://', 'https:\\')];
  for (const [key, value] of [['redirect_uri', 'https://evil.invalid/callback'], ['redirect_uri', 'http://localhost:1455@evil.invalid/auth/callback'], ['redirect_uri', 'http://127.0.0.1:1455/auth/callback'], ['client_id', 'evil-client'], ['code_challenge_method', 'plain'], ['code_challenge', 'short'], ['state', 'short'], ['scope', 'openid offline_access'], ['response_type', 'token']]) { const u = new URL(authUrl()); u.searchParams.set(key, value); invalid.push(u.href); }
  // Dot-segment URLs normalize to the fixed path; explicit raw-path check blocks them.
  for (const url of invalid) assert.throws(() => validateAuthUrl(url), error => error.code === 'protocol', String(url));
  const fallback = new URL(authUrl()); fallback.searchParams.set('redirect_uri', 'http://localhost:1457/auth/callback');
  assert.equal(validateAuthUrl(fallback.href), fallback.href);
});

test('invalid auth URL never opens a browser and closes its own callback login', async () => {
  const f = fixture(message => message.method === 'account/login/start' ? {result:{type:'chatgpt', loginId:ID, authUrl:'https://evil.invalid/private'}} : undefined);
  await rejectsCode(login(f), 'protocol');
  assert.equal(f.opened.length, 0);
  assert.equal(f.children[0].calls.at(-1).method, 'account/login/cancel');
  assert.deepEqual(f.children[1].calls.map(x => x.method), ['initialize', 'initialized', 'account/logout', 'account/read']);
});

test('completion waits for official post-reload account update before reading account', async () => {
  const f = fixture();
  let completion;
  const promise = login(f, {openExternal:async () => { completion = true; f.complete({update:false}); }});
  for (let i = 0; i < 10 && !completion; i++) await tick();
  assert.equal(completion, true);
  assert.equal(f.calls.filter(x => x.method === 'account/read').length, 0);
  f.emit({method:'account/updated', params:{authMode:'chatgpt', planType:'pro'}});
  assert.deepEqual(await promise, {connected:true});
});

test('explicit reconnect performs fresh browser login even when cached account/read would return ChatGPT', async () => {
  const f = fixture(message => message.method === 'account/read' ? {result:{account:{type:'chatgpt', email:'private@example.invalid', planType:'pro'}}} : undefined);
  let checked = false;
  assert.deepEqual(await login(f, {checkPort:async () => { checked = true; }}), {connected:true});
  assert.equal(checked, true);
  assert.equal(f.opened.length, 1);
  assert.deepEqual(f.calls.map(x => x.method), ['initialize', 'initialized', 'account/login/start', 'account/read']);
  assert.deepEqual(f.statuses, [{status:'preparing'}, {status:'waiting'}, {status:'connected'}]);
});

test('same-chunk early completion is correlated and cannot skip account verification', async () => {
  const f = fixture(message => {
    if (message.method === 'account/login/start') return {raw:[{id:message.id, result:{type:'chatgpt', loginId:ID, authUrl:authUrl()}}, {method:'account/login/completed', params:{loginId:ID, success:true}}, {method:'account/updated', params:{authMode:'chatgpt'}}].map(x => JSON.stringify(x)).join('\n') + '\n'};
    if (message.method === 'account/read') return {result:{account:{type:'chatgpt', email:'private@example.invalid', planType:'pro'}}};
  });
  assert.deepEqual(await login(f, {openExternal:async url => f.opened.push(url)}), {connected:true});
  assert.equal(f.calls.at(-1).method, 'account/read');
});

test('wrong, missing or duplicate login IDs and malformed completion fail closed', async () => {
  const paramsList = [{loginId:OTHER_ID, success:true}, {success:true}, {loginId:ID, success:'yes'}, {loginId:ID, success:true}];
  for (const [index, params] of paramsList.entries()) {
    const f = fixture();
    await rejectsCode(login(f, {openExternal:async () => {
      f.emit({method:'account/login/completed', params});
      if (index === 3) f.emit({method:'account/login/completed', params});
    }}), 'protocol');
    assert.equal(f.children[0].calls.filter(x => x.method === 'account/read').length, 0);
  }
});

test('negative completion and non-ChatGPT account cannot report connected', async () => {
  const failed = fixture();
  await rejectsCode(login(failed, {openExternal:async () => failed.complete({success:false})}), 'auth-failed');
  for (const account of [null, {type:'apiKey'}, {type:'chatgpt'}, {type:'chatgpt', email:''}]) {
    const f = fixture((message, {child}) => message.method === 'account/read' && child.index === 0 ? {result:{account}} : undefined);
    await rejectsCode(login(f), 'auth-failed');
    assert.equal(f.statuses.some(x => x.status === 'connected'), false);
  }
});

test('cancel before start never spawns or opens; occupied callback port does not touch another login', async () => {
  const controller = new AbortController(); controller.abort();
  const f = fixture();
  await rejectsCode(login(f, {signal:controller.signal}), 'cancelled');
  assert.equal(f.spawned, undefined);
  const occupied = fixture();
  await rejectsCode(login(occupied, {checkPort:async () => { throw new CodexAuthError('login-busy'); }}), 'login-busy');
  assert.equal(occupied.calls.some(x => x.method === 'account/login/start'), false);
  assert.equal(occupied.child.kills[0], 'SIGTERM');
});

test('cancel while start is pending kills child and cannot open a late URL', async () => {
  const controller = new AbortController();
  const f = fixture(message => { if (message.method === 'account/login/start') { queueMicrotask(() => controller.abort()); return null; } });
  await rejectsCode(login(f, {signal:controller.signal}), 'cancelled');
  assert.equal(f.opened.length, 0);
  assert.equal(f.child.kills[0], 'SIGTERM');
});

test('cancel after browser callback wins over success and clears only managed credentials', async () => {
  const controller = new AbortController();
  const f = fixture();
  await rejectsCode(login(f, {signal:controller.signal, openExternal:async () => { f.complete(); controller.abort(); }}), 'cancelled');
  assert.equal(f.statuses.some(x => x.status === 'connected'), false);
  assert.equal(f.children[0].calls.at(-1).method, 'account/login/cancel');
  assert.deepEqual(f.children[1].calls.map(x => x.method), ['initialize', 'initialized', 'account/logout', 'account/read']);
  assert.deepEqual(f.calls.find(x => x.method === 'account/login/cancel').params, {loginId:ID});
  assert.equal(f.spawned.options.env.CODEX_HOME, HOME);
});

test('late callback writes after cancel RPC are cleaned only after the original process has exited', async () => {
  const controller = new AbortController();
  let originalExited = false;
  const f = fixture((message, {child}) => {
    if (message.method === 'account/logout') {
      assert.equal(child.index, 1);
      assert.equal(originalExited, true);
    }
  }, {onKill({child, setConnected}) {
    if (child.index !== 0) return;
    setTimeout(() => {
      // Mirrors the official callback still inside persist_tokens_async when
      // cancel's notification has not yet been consumed by its outer loop.
      setConnected(true);
      originalExited = true;
      child.emit('exit', 0);
    }, 10);
    return false;
  }});
  await rejectsCode(login(f, {signal:controller.signal, openExternal:async () => controller.abort()}), 'cancelled');
  assert.equal(f.connected, false);
  assert.equal(f.children.length, 2);
  assert.equal(f.children[0].calls.some(x => x.method === 'account/logout'), false);
});

test('cancel before start reply still performs fresh logout after waiting for process termination', async () => {
  const controller = new AbortController();
  let originalExited = false;
  const f = fixture((message, {child}) => {
    if (message.method === 'account/login/start') { queueMicrotask(() => controller.abort()); return null; }
    if (message.method === 'account/logout') { assert.equal(child.index, 1); assert.equal(originalExited, true); }
  }, {onKill({child, setConnected}) {
    if (child.index !== 0) return;
    setTimeout(() => { setConnected(true); originalExited = true; child.emit('exit', 0); }, 10);
    return false;
  }});
  await rejectsCode(login(f, {signal:controller.signal}), 'cancelled');
  assert.equal(f.opened.length, 0);
  assert.equal(f.connected, false);
  assert.equal(f.children[0].calls.some(x => x.method === 'account/login/cancel'), false);
  assert.deepEqual(f.children[1].calls.map(x => x.method), ['initialize', 'initialized', 'account/logout', 'account/read']);
});

test('cancel RPC error cannot skip fresh-process logout and its absence check', async () => {
  const controller = new AbortController();
  const f = fixture(message => message.method === 'account/login/cancel' ? {error:{code:-32603, message:'private token error'}} : undefined);
  await rejectsCode(login(f, {signal:controller.signal, openExternal:async () => { f.complete(); controller.abort(); }}), 'cancelled');
  assert.equal(f.connected, false);
  assert.equal(f.children.length, 2);
  assert.equal(f.calls.at(-1).method, 'account/read');
});

test('unverified cancellation cleanup reports logout-failed instead of cancelled', async () => {
  for (const failRead of [false, true]) {
    const controller = new AbortController();
    const f = fixture((message, {child}) => {
      if (child.index !== 1) return;
      if (!failRead && message.method === 'account/logout') return {error:{code:-32603, message:'private keyring error'}};
      if (failRead && message.method === 'account/read') return {result:{account:{type:'chatgpt', email:'private@example.invalid'}}};
    });
    await rejectsCode(login(f, {signal:controller.signal, openExternal:async () => { f.complete(); controller.abort(); }}), 'logout-failed');
    assert.deepEqual(f.statuses.at(-1), {status:'error', code:'logout-failed'});
  }
});

test('failed termination cannot race a second cleanup process against a still running writer', async () => {
  const controller = new AbortController();
  const f = fixture(undefined, {onKill:() => false});
  await rejectsCode(login(f, {signal:controller.signal, openExternal:async () => controller.abort()}), 'logout-failed');
  assert.equal(f.children.length, 1);
  assert.deepEqual(f.child.kills, ['SIGTERM', 'SIGKILL']);
  await rejectsCode(login(fixture()), 'login-busy');
  f.child.emit('exit', 0);
  await tick();
});

test('cancel while browser-open promise is unresolved ignores its late return and permits a later fresh attempt', async () => {
  const controller = new AbortController();
  const f = fixture();
  let releaseBrowser;
  const promise = login(f, {signal:controller.signal, openExternal:() => new Promise(resolve => { releaseBrowser = resolve; })});
  const result = rejectsCode(promise, 'cancelled');
  for (let i = 0; i < 10 && !releaseBrowser; i++) await tick();
  assert.equal(typeof releaseBrowser, 'function');
  controller.abort();
  await result;
  releaseBrowser();
  await tick();
  assert.equal(f.statuses.some(x => x.status === 'connected'), false);
  assert.deepEqual(await login(fixture()), {connected:true});
});

test('child exit while waiting for browser completion cannot hang or mark connected', async () => {
  const f = fixture();
  await rejectsCode(login(f, {openExternal:async () => { queueMicrotask(() => f.child.emit('exit', 1)); }}), 'error');
  assert.equal(f.statuses.some(x => x.status === 'connected'), false);
});

test('timeout while waiting closes callback listener and clears managed login', async () => {
  const f = fixture();
  await rejectsCode(login(f, {openExternal:async () => {}, timeoutMs:20}), 'timeout');
  assert.equal(f.children[0].calls.at(-1).method, 'account/login/cancel');
  assert.deepEqual(f.children[1].calls.map(x => x.method), ['initialize', 'initialized', 'account/logout', 'account/read']);
  assert.equal(f.child.kills[0], 'SIGTERM');
});

test('browser failure is sanitized and leaves no running login', async () => {
  const f = fixture();
  await rejectsCode(login(f, {openExternal:async () => { throw new Error(`private failure ${authUrl()}`); }}), 'browser-failed');
  assert.deepEqual(f.calls.slice(-2).map(x => x.method), ['account/logout', 'account/read']);
});

test('abort during error cleanup cannot create a second concurrent cleanup process', async () => {
  const controller = new AbortController();
  const f = fixture((message, {child}) => {
    if (child.index === 1 && message.method === 'initialize') controller.abort();
  });
  await rejectsCode(login(f, {signal:controller.signal, openExternal:async () => { throw new Error('private browser error'); }}), 'browser-failed');
  assert.equal(f.children.length, 2);
  assert.equal(f.calls.filter(x => x.method === 'account/logout').length, 1);
});

test('one pending login/logout per managed home, including case variants', async () => {
  const controller = new AbortController();
  const f = fixture();
  let opened = false;
  const first = login(f, {signal:controller.signal, openExternal:async () => { opened = true; }});
  const firstResult = rejectsCode(first, 'cancelled');
  for (let i = 0; i < 10 && !opened; i++) await tick();
  assert.equal(opened, true);
  await rejectsCode(login(fixture(), {codexHome:HOME.toUpperCase()}), 'login-busy');
  await rejectsCode(logout(fixture()), 'login-busy');
  controller.abort();
  await firstResult;
  assert.deepEqual(await login(fixture()), {connected:true});
});

test('server execution, credential-refresh requests, unexpected replies and malformed framing terminate without action', async () => {
  const inputs = ['private token output\n', '{}\n', '[]\n', '{"id":99,"result":{}}\n', '{"id":1,"result":{},"error":{"code":-1}}\n', '{"id":1,"result":{}}\n{"id":1,"result":{}}\n', '{"id":99,"method":"item/commandExecution/requestApproval","params":{"command":"evil"}}\n', '{"id":99,"method":"account/chatgptAuthTokens/refresh","params":{}}\n'];
  for (const raw of inputs) {
    const f = fixture(message => message.method === 'initialize' ? {raw} : undefined);
    await rejectsCode(login(f), 'protocol');
    assert.equal(f.calls.length, 1);
    assert.equal(f.opened.length, 0);
  }
});

test('unexpected bounded notifications are ignored; unbounded lines, stderr and counts stop the child', async () => {
  const f = fixture();
  assert.deepEqual(await login(f, {openExternal:async () => { f.emit({method:'something/new', params:{private:'not renderer data'}}); f.complete(); }}), {connected:true});
  for (const response of [{raw:'s'.repeat(128 * 1024 + 1)}, {stderr:'s'.repeat(128 * 1024 + 1), result:{}}, {raw:'{"method":"test","params":{}}\n'.repeat(257)}, {raw:('{"method":"test","params":{"x":"' + 's'.repeat(100000) + '"}}\n').repeat(11)}]) {
    const flooded = fixture(message => message.method === 'initialize' ? response : undefined);
    await rejectsCode(login(flooded), 'protocol');
    assert.equal(flooded.child.kills[0], 'SIGTERM');
  }
});

test('logout uses official method for managed home and confirms account is absent', async () => {
  const f = fixture();
  assert.deepEqual(await logout(f), {connected:false});
  assert.deepEqual(f.calls.map(x => x.method), ['initialize', 'initialized', 'account/logout', 'account/read']);
  const bad = fixture(message => message.method === 'account/read' ? {result:{account:{type:'chatgpt', email:'private@example.invalid'}}} : undefined);
  await rejectsCode(logout(bad), 'logout-failed');
});

test('cancelled logout waits for its process exit before allowing a new login', async () => {
  const controller = new AbortController();
  let releaseExit;
  const f = fixture(message => {
    if (message.method === 'account/logout') { queueMicrotask(() => controller.abort()); return null; }
  }, {onKill({child}) { releaseExit = () => child.emit('exit', 0); return false; }});
  const promise = logout(f, {signal:controller.signal});
  const result = rejectsCode(promise, 'cancelled');
  for (let i = 0; i < 10 && !releaseExit; i++) await tick();
  assert.equal(typeof releaseExit, 'function');
  await rejectsCode(login(fixture()), 'login-busy');
  releaseExit();
  await result;
  assert.deepEqual(await login(fixture()), {connected:true});
});

test('absolute native .exe and controlled directories are required, and spawn errors are sanitized', async () => {
  for (const executable of ['codex.exe', EXE + '.cmd', EXE + '.js', EXE.replace('.exe', '.ps1')]) {
    const f = fixture();
    await rejectsCode(login(f, {executable}), 'not-found');
    assert.equal(f.spawned, undefined);
  }
  for (const options of [{codexHome:'.codex'}, {cwd:'.'}, {cwd:CWD + '\u0000evil'}]) await rejectsCode(login(fixture(), options), 'not-found');
  await rejectsCode(login(fixture(), {spawnImpl:() => { throw Object.assign(new Error('private file path'), {code:'ENOENT'}); }}), 'not-found');
});
