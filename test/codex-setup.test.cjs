'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {CodexSetup} = require('../src/codex-setup.cjs');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const failure = (code, message = 'private@example.com C:\\private\\token.pem https://secret.invalid/token') => Object.assign(new Error(message), {code});

function fixture(overrides = {}) {
  const calls = [], states = [];
  const dependencies = {
    runtime:{
      async ensureReady(options) { calls.push(['ensure', options]); return '/app/component/codex.exe'; },
      async getVerifiedExecutable(options) { calls.push(['verify', options]); return '/app/component/codex.exe'; }
    },
    async login(options) { calls.push(['login', options]); options.onStatus({status:'waiting'}); return {connected:true}; },
    async logout(options) { calls.push(['logout', options]); return {connected:false}; },
    codexHome:'/app/managed-home', cwd:'/app/query',
    async openExternal() { calls.push(['browser']); },
    onState(value) { states.push(value); },
    onDisconnect() { calls.push(['disconnect']); },
    onConnected() { calls.push(['connected']); },
    ...overrides
  };
  const setup = new CodexSetup(dependencies);
  return {setup, dependencies, calls, states};
}

test('restoring managed UI is inert and status is an isolated sanitized snapshot', () => {
  const {setup, calls, states} = fixture();
  assert.deepEqual(calls, []);
  assert.equal(setup.busy, false);
  assert.deepEqual(setup.getStatus(), {status:'idle', progress:null, message:''});
  const snapshot = setup.getStatus(); snapshot.status = 'connected';
  assert.equal(setup.getStatus().status, 'idle');
  assert.equal(setup.markConnected(), true);
  assert.equal(setup.getStatus().status, 'connected');
  assert.deepEqual(calls, []);
  assert.equal(states.length, 1);
});

test('explicit connect serializes preparation, official login and quota enablement', async () => {
  const {setup, calls, states, dependencies} = fixture();
  const pending = setup.connect();
  assert.equal(setup.busy, true);
  assert.equal(setup.connect(), pending);
  assert.equal(setup.markConnected(), false);
  assert.deepEqual(await pending, {ok:true});
  assert.deepEqual(calls.map(call => call[0]), ['disconnect', 'ensure', 'login', 'connected']);
  const options = calls.find(call => call[0] === 'login')[1];
  assert.equal(options.executable, '/app/component/codex.exe');
  assert.equal(options.codexHome, dependencies.codexHome);
  assert.equal(options.cwd, dependencies.cwd);
  assert.equal(options.openExternal, dependencies.openExternal);
  assert.equal(options.signal.aborted, false);
  assert.ok(states.some(value => value.status === 'waiting-login'));
  assert.equal(setup.busy, false);
  assert.equal(setup.getStatus().status, 'connected');
});

test('progress accepts only known phases and bounded percentages and ignores private details', async () => {
  const ready = deferred(); let options;
  const {setup, states} = fixture({runtime:{ensureReady(value) { options = value; return ready.promise; }, async getVerifiedExecutable() { return null; }}});
  const pending = setup.connect(); await tick();
  options.onProgress({phase:'downloading', percent:170.8, message:'private@example.com', url:'https://secret.invalid'});
  assert.equal(setup.getStatus().progress, 100);
  options.onProgress({phase:'downloading', percent:-20});
  assert.equal(setup.getStatus().progress, 0);
  options.onProgress({phase:'downloading', percent:NaN});
  assert.equal(setup.getStatus().progress, null);
  const before = setup.getStatus();
  options.onProgress({phase:'private', percent:30});
  assert.deepEqual(setup.getStatus(), before);
  options.onProgress({phase:'verifying', percent:100});
  assert.equal(setup.getStatus().progress, null);
  ready.resolve('/app/component/codex.exe'); await pending;
  assert.doesNotMatch(JSON.stringify(states), /private|secret/);
});

test('cancel during download holds busy until cleanup and never launches a login', async () => {
  const ready = deferred(); let options;
  const {setup, calls} = fixture({runtime:{ensureReady(value) { options = value; return ready.promise; }, async getVerifiedExecutable() { return null; }}});
  const pending = setup.connect(); await tick();
  const cancellation = setup.cancel();
  assert.equal(options.signal.aborted, true);
  assert.equal(setup.busy, true);
  assert.equal(setup.connect(), pending);
  options.onProgress({phase:'downloading', percent:99});
  assert.equal(setup.getStatus().progress, null);
  ready.resolve('/app/component/codex.exe');
  assert.equal((await pending).code, 'cancelled');
  assert.deepEqual(await cancellation, {ok:true});
  assert.equal(setup.busy, false);
  assert.equal(setup.getStatus().status, 'idle');
  assert.deepEqual(calls.map(call => call[0]), ['disconnect']);
});

test('cancel before operation starts performs no auth or download', async () => {
  const {setup, calls} = fixture();
  const pending = setup.connect(); const cancellation = setup.cancel();
  assert.equal((await pending).code, 'cancelled');
  await cancellation;
  assert.deepEqual(calls, []);
  assert.equal(setup.getStatus().status, 'idle');
});

test('cancel during login waits for adapter cleanup and ignores stale status callbacks', async () => {
  const login = deferred(); let options;
  const {setup, calls} = fixture({login(value) { options = value; value.onStatus({status:'waiting'}); return login.promise; }});
  const pending = setup.connect(); await tick();
  const cancellation = setup.cancel();
  assert.equal(options.signal.aborted, true);
  assert.equal(setup.busy, true);
  options.onStatus({status:'connected'});
  options.onStatus({status:'waiting'});
  assert.equal(setup.getStatus().status, 'preparing');
  login.reject(failure('cancelled'));
  assert.equal((await pending).code, 'cancelled');
  await cancellation;
  assert.equal(setup.busy, false);
  assert.equal(setup.getStatus().status, 'idle');
  assert.ok(!calls.some(call => call[0] === 'connected' || call[0] === 'logout'));
});

test('late login success after cancellation clears only the managed account before retry', async () => {
  const login = deferred(), cleanup = deferred(); let logoutOptions;
  const {setup, calls} = fixture({login:() => login.promise, logout(options) { logoutOptions = options; return cleanup.promise; }});
  const pending = setup.connect(); await tick();
  const cancellation = setup.cancel();
  login.resolve({connected:true}); await tick();
  assert.equal(setup.busy, true);
  assert.equal(setup.connect(), pending);
  assert.equal(logoutOptions.codexHome, '/app/managed-home');
  assert.equal(logoutOptions.signal.aborted, false);
  assert.equal(logoutOptions.executable, '/app/component/codex.exe');
  assert.ok(!calls.some(call => call[0] === 'connected'));
  cleanup.resolve({connected:false});
  assert.equal((await pending).code, 'cancelled');
  await cancellation;
  assert.equal(setup.getStatus().status, 'idle');
  assert.equal(setup.busy, false);
});

test('cancellation cleanup failure never claims credentials were removed', async () => {
  const login = deferred();
  const {setup} = fixture({login:() => login.promise, async logout() { throw failure('storage'); }});
  const pending = setup.connect(); await tick();
  const cancellation = setup.cancel(); login.resolve({connected:true});
  assert.equal((await pending).code, 'logout-failed');
  assert.equal((await cancellation).code, 'logout-failed');
  assert.equal(setup.getStatus().status, 'error');
  assert.match(setup.getStatus().message, /可能仍在本机/);
});

test('adapter cleanup failure survives an aborted signal and remains actionable', async () => {
  const login = deferred();
  const {setup, calls} = fixture({login:() => login.promise});
  const pending = setup.connect(); await tick();
  const cancellation = setup.cancel();
  login.reject(failure('logout-failed'));
  const outcome = await pending;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'logout-failed');
  assert.match(outcome.error, /可能仍在本机/);
  assert.deepEqual(await cancellation, outcome);
  assert.equal(setup.getStatus().status, 'error');
  assert.ok(!calls.some(call => call[0] === 'logout'));
});

test('cancel while async enable hook settles pauses it again and cleans managed login', async () => {
  const hook = deferred(); let paused = 0, cleared = 0;
  const {setup} = fixture({onDisconnect() { paused++; }, onConnected:() => hook.promise, async logout() { cleared++; return {connected:false}; }});
  const pending = setup.connect(); await tick();
  const cancellation = setup.cancel(); hook.resolve();
  assert.equal((await pending).code, 'cancelled');
  await cancellation;
  assert.equal(paused, 2);
  assert.equal(cleared, 1);
  assert.equal(setup.getStatus().status, 'idle');
});

test('cancel after successful connection is a no-op; logout is separate', async () => {
  const {setup, calls} = fixture();
  await setup.connect(); const count = calls.length;
  assert.deepEqual(await setup.cancel(), {ok:true});
  assert.equal(calls.length, count);
  assert.equal(setup.getStatus().status, 'connected');
  assert.deepEqual(await setup.logout(), {ok:true});
  assert.deepEqual(calls.slice(count).map(call => call[0]), ['disconnect', 'verify', 'logout']);
  assert.equal(setup.getStatus().status, 'idle');
  assert.match(setup.getStatus().message, /已退出/);
});

test('logout never downloads and a missing component does not imply credentials removed', async () => {
  let downloads = 0, logouts = 0;
  const {setup} = fixture({runtime:{async ensureReady() { downloads++; }, async getVerifiedExecutable() { return null; }}, async logout() { logouts++; }});
  setup.markConnected();
  assert.equal((await setup.logout()).code, 'logout-failed');
  assert.equal(downloads, 0);
  assert.equal(logouts, 0);
  assert.equal(setup.getStatus().status, 'error');
  assert.match(setup.getStatus().message, /可能仍在本机/);
});

test('conflicting operations cannot overlap and repeated logout shares cleanup', async () => {
  const cleanup = deferred();
  const {setup} = fixture({logout:() => cleanup.promise});
  const pending = setup.logout(); await tick();
  assert.equal(setup.logout(), pending);
  assert.equal((await setup.connect()).code, 'busy');
  cleanup.resolve({connected:false}); await pending;
  assert.equal(setup.busy, false);
});

test('adapter notifications and malformed results cannot enable quota reads', async () => {
  const {setup, calls} = fixture({async login(options) { options.onStatus({status:'connected'}); return {email:'private@example.com'}; }});
  assert.equal((await setup.connect()).code, 'auth-failed');
  assert.equal(setup.getStatus().status, 'error');
  assert.ok(!calls.some(call => call[0] === 'connected'));
});

test('errors expose only fixed known codes and localized messages and permit retry', async () => {
  let attempt = 0;
  const {setup, states} = fixture({async login() { if (++attempt === 1) throw failure('network'); if (attempt === 2) throw failure('private@example.com'); return {connected:true}; }});
  const failed = await setup.connect();
  assert.equal(failed.code, 'network');
  assert.equal(failed.ok, false);
  assert.match(failed.error, /检查网络/);
  assert.doesNotMatch(failed.error, /private|secret|token\.pem/);
  assert.match(setup.getStatus().message, /检查网络/);
  assert.equal((await setup.connect()).code, 'error');
  assert.deepEqual(await setup.connect(), {ok:true});
  assert.doesNotMatch(JSON.stringify(states), /private|secret|token\.pem/);
});

test('state publication failure cannot strand a successful operation', async () => {
  const {setup} = fixture({onState() { throw failure('network'); }});
  assert.deepEqual(await setup.connect(), {ok:true});
  assert.equal(setup.busy, false);
  assert.equal(setup.getStatus().status, 'connected');
});

test('stop aborts download, suppresses late progress and prevents later operations', async () => {
  const ready = deferred(); let options;
  const {setup, states, calls} = fixture({runtime:{ensureReady(value) { options = value; return ready.promise; }, async getVerifiedExecutable() { return null; }}});
  const pending = setup.connect(); await tick();
  setup.stop(); setup.stop(); const count = states.length;
  assert.equal(options.signal.aborted, true);
  options.onProgress({phase:'downloading', percent:90});
  ready.resolve('/app/component/codex.exe');
  assert.equal((await pending).code, 'cancelled');
  assert.equal(states.length, count);
  assert.equal(setup.markConnected(), false);
  assert.equal((await setup.connect()).code, 'stopped');
  assert.equal((await setup.logout()).code, 'stopped');
  assert.deepEqual(calls.map(call => call[0]), ['disconnect']);
});

test('stop cleans late login success without UI or enable callbacks', async () => {
  const login = deferred(); let options;
  const {setup, states, calls} = fixture({login(value) { options = value; return login.promise; }});
  const pending = setup.connect(); await tick();
  setup.stop(); const count = states.length;
  assert.equal(options.signal.aborted, true);
  options.onStatus({status:'waiting'});
  login.resolve({connected:true}); await pending;
  assert.equal(states.length, count);
  assert.ok(!calls.some(call => call[0] === 'connected'));
  assert.equal(calls.filter(call => call[0] === 'logout').length, 1);
});

test('stop waits for late-success cancellation cleanup too', async () => {
  const login = deferred(), cleanup = deferred(); let options;
  const {setup, states} = fixture({login:() => login.promise, logout(value) { options = value; return cleanup.promise; }});
  const pending = setup.connect(); await tick();
  setup.cancel(); login.resolve({connected:true}); await tick();
  setup.stop(); const count = states.length;
  assert.equal(options.signal.aborted, false);
  cleanup.resolve({connected:false}); await pending;
  assert.equal(states.length, count);
});

test('shutdown awaits active official cancellation cleanup and stays busy until complete', async () => {
  const cleanup = deferred(); let signal;
  const {setup, states} = fixture({login(options) { signal = options.signal; return cleanup.promise; }});
  const pending = setup.connect(); await tick();
  const stopping = setup.stop();
  assert.equal(stopping, pending);
  assert.equal(setup.stop(), stopping);
  assert.equal(signal.aborted, true);
  assert.equal(setup.busy, true);
  let finished = false; stopping.then(() => { finished = true; });
  const stateCount = states.length;
  await tick(); assert.equal(finished, false);
  cleanup.reject(failure('cancelled'));
  assert.equal((await stopping).code, 'cancelled');
  assert.equal(setup.busy, false);
  assert.equal(states.length, stateCount);
  assert.deepEqual(await setup.stop(), {ok:true});
});
