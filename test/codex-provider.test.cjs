'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {PassThrough, Writable} = require('node:stream');
const {readCodexUsage, CodexProvider} = require('../src/codex-provider.cjs');

const EXE = require('node:path').resolve('fixture-codex');
const CWD = require('node:path').resolve('fixture-empty-workdir');
const account = email => ({account:{type:'chatgpt', email, planType:'pro'}, requiresOpenaiAuth:true});
const defaultLimits = () => ({rateLimits:{limitId:'codex', primary:{usedPercent:25, windowDurationMins:300, resetsAt:1790000000}, secondary:null}, rateLimitResetCredits:{availableCount:2}});
const defaultUsage = () => ({summary:{lifetimeTokens:123456}, dailyUsageBuckets:[{startDate:'2026-09-18', tokens:40}, {startDate:'2026-09-20', tokens:70}, {startDate:'2026-09-19', tokens:50}]});

function fixture(handler = () => undefined) {
  const calls = [];
  let child;
  let spawned;
  let accountReads = 0;
  const spawnImpl = (executable, args, options) => {
    spawned = {executable, args, options};
    child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kills = [];
    child.kill = signal => { child.kills.push(signal); queueMicrotask(() => child.emit('close', 0)); return true; };
    child.stdin = new Writable({write(chunk, encoding, callback) {
      const message = JSON.parse(chunk.toString());
      calls.push(message);
      if (message.method === 'account/read') accountReads++;
      let response = handler(message, {child, accountReads, calls});
      if (response === undefined) {
        if (message.method === 'initialize') response = {result:{userAgent:'fixture'}};
        else if (message.method === 'account/read') response = {result:account('first@example.invalid')};
        else if (message.method === 'account/rateLimits/read') response = {result:defaultLimits()};
        else if (message.method === 'account/usage/read') response = {result:defaultUsage()};
      }
      if (response && message.id !== undefined) queueMicrotask(() => {
        if (response.stderr) child.stderr.write(response.stderr);
        if (response.raw !== undefined) child.stdout.write(response.raw);
        else child.stdout.write(`${JSON.stringify({id:message.id, ...response})}\n`);
      });
      callback();
    }});
    return child;
  };
  return {calls, spawnImpl, get child() { return child; }, get spawned() { return spawned; }};
}
function readWith(f, options = {}) { return readCodexUsage({executable:EXE, cwd:CWD, spawnImpl:f.spawnImpl, ...options}); }

test('only the fixed read RPCs run, with native executable, no shell, and per-process feature restrictions', async () => {
  const f = fixture();
  const {snapshot, identity} = await readWith(f);
  assert.deepEqual(f.calls.map(call => call.method), ['initialize', 'initialized', 'account/read', 'account/rateLimits/read', 'account/read', 'account/usage/read', 'account/read']);
  for (const call of f.calls.filter(call => call.method === 'account/read')) assert.deepEqual(call.params, {refreshToken:false});
  assert.equal(f.spawned.executable, EXE);
  assert.deepEqual(f.spawned.args, ['--disable', 'plugins', '--disable', 'remote_plugin', '--disable', 'hooks', 'app-server', '--strict-config']);
  assert.equal(f.spawned.options.shell, false);
  assert.equal(f.spawned.options.windowsHide, true);
  assert.equal(f.spawned.options.cwd, CWD);
  assert.equal(f.spawned.options.env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED, '1');
  assert.equal(f.child.kills[0], 'SIGTERM');
  assert.match(identity, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(snapshot).includes('example.invalid'));
  assert.equal(snapshot.source, 'codex-cli');
  assert.equal(snapshot.windows[0].usedPercent, 25);
  assert.equal(snapshot.windows[0].resetAt, 1790000000000);
  assert.equal(snapshot.windows[0].windowDurationMins, 300);
  assert.deepEqual(snapshot.tokens, {total:123456, today:70});
  assert.equal(snapshot.tokenDate, '2026-09-20');
  assert.equal(snapshot.tokenScope, 'account');
  assert.equal(snapshot.resetCredits, 2);
});

test('native limit map prioritizes Codex, preserves additional buckets, and does not hard-code Spark', async () => {
  const f = fixture(message => message.method === 'account/rateLimits/read' ? {result:{
    rateLimits:{primary:{usedPercent:99}},
    rateLimitsByLimitId:{
      'codex-spark':{limitId:'codex-spark', limitName:'Spark\u202e\u0000', secondary:{usedPercent:10.5, windowDurationMins:10080, resetsAt:1790000000}},
      codex:{limitId:'codex', primary:{usedPercent:0, windowDurationMins:300}, secondary:{usedPercent:100, windowDurationMins:10080}},
      new_bucket:{primary:{usedPercent:88, windowDurationMins:15}}
    }
  }} : undefined);
  const {snapshot} = await readWith(f);
  assert.deepEqual(snapshot.windows.map(window => window.usedPercent), [0, 100, 10.5, 88]);
  assert.equal(snapshot.windows[0].limitId, 'codex');
  assert.equal(snapshot.windows[0].resetAt, null);
  assert.equal(snapshot.windows[2].label, 'Spark · 7 天');
  assert.equal(snapshot.resetCredits, null);
});

test('invalid numeric metrics remain unknown and explicit zero remains valid', async () => {
  const f = fixture(message => {
    if (message.method === 'account/rateLimits/read') return {result:{rateLimitsByLimitId:{
      codex:{primary:{usedPercent:-1}, secondary:{usedPercent:'45'}},
      other:{primary:{usedPercent:101}, secondary:{usedPercent:0, windowDurationMins:'300', resetsAt:1790000000000}}
    }, rateLimitResetCredits:{availableCount:0}}};
    if (message.method === 'account/usage/read') return {result:{summary:{lifetimeTokens:'9000'}, dailyUsageBuckets:[
      {startDate:'2026-02-30', tokens:5}, {startDate:'2026-09-30', tokens:-1}, {startDate:'2026-09-20', tokens:0}, {startDate:'2026-09-29', tokens:'44'}
    ]}};
  });
  const {snapshot} = await readWith(f);
  assert.equal(snapshot.windows.length, 1);
  assert.equal(snapshot.windows[0].usedPercent, 0);
  assert.equal(snapshot.windows[0].windowDurationMins, null);
  assert.equal(snapshot.windows[0].resetAt, null);
  assert.deepEqual(snapshot.tokens, {total:null, today:0});
  assert.equal(snapshot.tokenDate, '2026-09-20');
  assert.equal(snapshot.resetCredits, 0);
});

test('empty service data does not manufacture a success with zero usage', async () => {
  const f = fixture(message => ['account/rateLimits/read', 'account/usage/read'].includes(message.method) ? {result:{}} : undefined);
  await assert.rejects(readWith(f), error => error.code === 'empty-data');
});

test('unsupported optional Token API still returns verified quota with unknown tokens', async () => {
  const f = fixture(message => message.method === 'account/usage/read' ? {error:{code:-32601, message:'secret error should never escape'}} : undefined);
  const {snapshot} = await readWith(f);
  assert.equal(snapshot.windows[0].usedPercent, 25);
  assert.deepEqual(snapshot.tokens, {total:null, today:null});
  assert.equal(snapshot.tokenDate, null);
  assert.equal(f.calls.filter(call => call.method === 'account/read').length, 2);
});

test('optional Token timeout or malformed response keeps already verified quota and ends the child', async () => {
  for (const response of [null, {raw:'not-json\n'}]) {
    const f = fixture(message => message.method === 'account/usage/read' ? response : undefined);
    const {snapshot} = await readWith(f, {timeoutMs:25});
    assert.equal(snapshot.windows[0].usedPercent, 25);
    assert.deepEqual(snapshot.tokens, {total:null, today:null});
    assert.equal(f.child.kills[0], 'SIGTERM');
  }
});

test('account changes during quota or optional Token query invalidate every old-account metric', async () => {
  for (const changeAt of [2, 3]) {
    const f = fixture((message, context) => message.method === 'account/read' && context.accountReads >= changeAt ? {result:account('other@example.invalid')} : undefined);
    await assert.rejects(readWith(f), error => error.code === 'account-changed' && error.clear === true && !error.message.includes('example.invalid'));
  }
});

test('an account-change notification after the first identity response cancels the read and clears stale data', async () => {
  for (const during of ['account/read', 'account/usage/read']) {
    const f = fixture(message => message.method === during ? {raw:
      `${JSON.stringify({id:message.id, result:during === 'account/read' ? account('first@example.invalid') : defaultUsage()})}\n` +
      '{"method":"account/updated","params":{"authMode":"chatgpt","planType":"pro"}}\n'
    } : undefined);
    await assert.rejects(readWith(f), error => error.code === 'account-changed' && error.clear === true);
  }
});

test('logged-out and API-key-only accounts cannot query subscription usage', async () => {
  for (const value of [null, {type:'apiKey'}, {type:'amazonBedrock'}]) {
    const f = fixture(message => message.method === 'account/read' ? {result:{account:value}} : undefined);
    await assert.rejects(readWith(f), error => error.code === 'needs-login' && error.clear === true);
    assert.equal(f.calls.some(call => call.method === 'account/rateLimits/read'), false);
  }
});

test('authentication failures from optional usage clear old-account data instead of falling back', async () => {
  const f = fixture(message => message.method === 'account/usage/read' ? {error:{code:401, message:'Bearer secret'}} : undefined);
  await assert.rejects(readWith(f), error => error.code === 'needs-login' && error.clear === true && !error.message.includes('Bearer'));
});

test('invalid framing, duplicate replies, unmatched IDs and server requests terminate safely', async () => {
  const inputs = [
    'plain stdout secret\n',
    '{}\n',
    '[{"id":1,"result":{}}]\n',
    '{"id":99,"result":{}}\n',
    '{"id":1,"result":{},"error":{"code":-1}}\n',
    '{"id":1,"result":{}}\n{"id":1,"result":{}}\n',
    '{"id":100,"method":"item/commandExecution/requestApproval","params":{"command":"danger"}}\n',
    '{"id":100,"method":"account/chatgptAuthTokens/refresh","params":{}}\n'
  ];
  for (const raw of inputs) {
    const f = fixture(message => message.method === 'initialize' ? {raw} : undefined);
    await assert.rejects(readWith(f), error => error.code === 'protocol' && !error.message.includes('secret'));
    assert.equal(f.calls.length, 1);
    assert.equal(f.child.kills[0], 'SIGTERM');
  }
});

test('stdout lines and stderr are bounded without leaking raw process output', async () => {
  for (const response of [{raw:'s'.repeat(512 * 1024 + 1)}, {stderr:'s'.repeat(256 * 1024 + 1), result:{}}]) {
    const f = fixture(message => message.method === 'initialize' ? response : undefined);
    await assert.rejects(readWith(f), error => error.code === 'protocol' && error.message.length < 100);
    assert.equal(f.child.kills[0], 'SIGTERM');
  }
});

test('output notifications are bounded and never used as numeric snapshots', async () => {
  const f = fixture(message => message.method === 'initialize' ? {raw:'{"method":"account/rateLimits/updated","params":{"secret":"do not expose"}}\n'.repeat(513)} : undefined);
  await assert.rejects(readWith(f), error => error.code === 'protocol');
});

test('absolute native executable validation, spawn failures and timeouts are sanitized', async () => {
  let spawned = 0;
  for (const executable of ['codex', EXE + '.cmd', EXE + '.js']) {
    await assert.rejects(readCodexUsage({executable, cwd:CWD, spawnImpl:() => { spawned++; }}), error => error.code === 'not-found');
  }
  assert.equal(spawned, 0);
  await assert.rejects(readCodexUsage({executable:EXE, cwd:CWD, spawnImpl:() => { throw Object.assign(new Error('private path'), {code:'ENOENT'}); }}), error => error.code === 'not-found' && !error.message.includes('private'));
  const f = fixture(() => null);
  await assert.rejects(readWith(f, {timeoutMs:10}), error => error.code === 'timeout');
  assert.equal(f.child.kills[0], 'SIGTERM');
});

test('abort kills a waiting process and never returns a stale quota fallback', async () => {
  const controller = new AbortController();
  const f = fixture(message => {
    if (message.method === 'account/usage/read') { queueMicrotask(() => controller.abort()); return null; }
  });
  await assert.rejects(readWith(f, {signal:controller.signal}), error => error.code === 'aborted');
  assert.equal(f.child.kills[0], 'SIGTERM');
  const stopped = new AbortController();
  stopped.abort();
  let started = false;
  await assert.rejects(readCodexUsage({executable:EXE, cwd:CWD, signal:stopped.signal, spawnImpl:() => { started = true; }}), error => error.code === 'aborted');
  assert.equal(started, false);
});

test('unsupported CLI arguments fail closed without retrying weaker startup flags', async () => {
  const f = fixture((message, {child}) => { queueMicrotask(() => child.emit('exit', 2)); return null; });
  await assert.rejects(readWith(f), error => error.code === 'unsupported');
  assert.equal(f.calls.length, 1);
});

test('at most 32 native windows reach the UI', async () => {
  const map = Object.fromEntries(Array.from({length:40}, (_, index) => [`quota${index}`, {primary:{usedPercent:index}, secondary:{usedPercent:index}}]));
  const f = fixture(message => message.method === 'account/rateLimits/read' ? {result:{rateLimitsByLimitId:map}} : undefined);
  const {snapshot} = await readWith(f);
  assert.equal(snapshot.windows.length, 32);
});

function providerHarness({read, discover = async () => ({path:EXE})} = {}) {
  const snapshots = [], states = [], clears = [], timers = [];
  const provider = new CodexProvider({discover, cwd:CWD, read, now:() => 100000, onSnapshot:snapshot => snapshots.push(snapshot), onState:state => states.push(state), onClear:() => clears.push(true),
    setTimer:(fn, delay) => { const timer = {fn, delay, cleared:false, unref(){}}; timers.push(timer); return timer; },
    clearTimer:timer => { timer.cleared = true; }
  });
  return {provider, snapshots, states, clears, timers};
}
const result = (identity = 'a'.repeat(64), capturedAt = 100000) => ({identity, snapshot:{version:2, source:'codex-cli', capturedAt, windows:[], tokens:{total:100, today:null}, tokenScope:'account', tokenDate:null, resetCredits:null}});

test('provider requires enable, starts immediately, coalesces requests and schedules the chosen interval', async () => {
  let calls = 0, finish;
  const h = providerHarness({read:() => { calls++; return new Promise(resolve => { finish = resolve; }); }});
  await h.provider.refresh();
  assert.equal(calls, 0);
  const first = h.provider.start(7);
  assert.equal(h.provider.refresh(), first);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(h.provider.getStatus().running, true);
  finish(result());
  await first;
  assert.equal(h.provider.getStatus().state, 'ready');
  assert.equal(h.provider.getStatus().intervalMinutes, 7);
  assert.equal(h.provider.getStatus().nextRunAt, 520000);
  assert.equal(h.timers.at(-1).delay, 420000);
  assert.equal(h.snapshots.length, 1);
  assert.ok(!JSON.stringify(h.states).includes('a'.repeat(64)));
  h.provider.stop();
});

test('stop aborts active work, ignores late completion, and keeps the last valid reading time', async () => {
  let call = 0, finish, signal;
  const h = providerHarness({read:options => {
    signal = options.signal;
    return ++call === 1 ? Promise.resolve(result()) : new Promise(resolve => { finish = resolve; });
  }});
  await h.provider.start(5);
  const pending = h.provider.refresh();
  await new Promise(resolve => setImmediate(resolve));
  h.provider.stop();
  assert.equal(signal.aborted, true);
  finish(result('b'.repeat(64), 200000));
  await pending;
  assert.equal(h.snapshots.length, 1);
  assert.equal(h.provider.getStatus().enabled, false);
  assert.equal(h.provider.getStatus().state, 'disabled');
  assert.equal(h.provider.getStatus().lastSuccessAt, 100000);
  assert.equal(h.provider.getStatus().nextRunAt, null);
  assert.equal(h.clears.length, 0);
});

test('restart cannot publish a prior generation after a newer result', async () => {
  let calls = 0, oldFinish;
  const h = providerHarness({read:() => ++calls === 1 ? new Promise(resolve => { oldFinish = resolve; }) : Promise.resolve(result('b'.repeat(64), 200000))});
  const old = h.provider.start(5);
  await new Promise(resolve => setImmediate(resolve));
  h.provider.stop();
  await h.provider.start(3);
  oldFinish(result('a'.repeat(64), 100000));
  await old;
  assert.equal(h.snapshots.length, 1);
  assert.equal(h.provider.getStatus().lastSuccessAt, 200000);
  assert.equal(h.provider.getStatus().intervalMinutes, 3);
  h.provider.stop();
});

test('ordinary refresh/discovery failure preserves readings and never exposes raw errors', async () => {
  let fail = false;
  const h = providerHarness({read:async () => { if (fail) throw new Error('secret token raw path'); return result(); }});
  await h.provider.start(5);
  fail = true;
  await h.provider.refresh();
  assert.equal(h.snapshots.length, 1);
  assert.equal(h.clears.length, 0);
  assert.equal(h.provider.getStatus().lastSuccessAt, 100000);
  assert.equal(h.provider.getStatus().state, 'error');
  assert.ok(!h.provider.getStatus().message.includes('secret'));
  h.provider.stop();
  const missing = providerHarness({discover:async () => null});
  await missing.provider.start(5);
  assert.equal(missing.provider.getStatus().state, 'not-found');
  assert.equal(missing.provider.getStatus().running, false);
  missing.provider.stop();
});

test('changed account with a failed rate query clears prior data, as does logout', async () => {
  for (const kind of ['changed', 'logout']) {
    let calls = 0;
    const h = providerHarness({read:async options => {
      const round = ++calls;
      const f = fixture(message => {
        if (round === 2 && message.method === 'account/read') return {result:kind === 'logout' ? {account:null} : account('different@example.invalid')};
        if (round === 2 && message.method === 'account/rateLimits/read') return {error:{code:500, message:'account secret'}};
      });
      return readWith(f, {signal:options.signal});
    }});
    await h.provider.start(5);
    assert.equal(h.snapshots.length, 1);
    await h.provider.refresh();
    assert.equal(h.snapshots.length, 1);
    assert.equal(h.clears.length, 1);
    assert.equal(h.provider.getStatus().lastSuccessAt, null);
    h.provider.stop();
  }
});

test('changing account between successful reads clears the old snapshot before publishing the new one', async () => {
  let call = 0;
  const order = [];
  const provider = new CodexProvider({discover:async () => ({path:EXE}), cwd:CWD, read:async () => result((++call === 1 ? 'a' : 'b').repeat(64)), onSnapshot:() => order.push('snapshot'), onClear:() => order.push('clear')});
  await provider.start(5);
  await provider.refresh();
  assert.deepEqual(order, ['snapshot', 'clear', 'snapshot']);
  provider.stop();
});

test('same-email workspace changes clear prior snapshots, but ordinary errors in that workspace retain them', async () => {
  let round = 0;
  const h = providerHarness({read:async options => {
    const current = ++round;
    return readWith(fixture(message => {
      if (message.method === 'account/rateLimits/read') return current === 2 ? {error:{code:500, message:'private workspace error'}} : {result:{...defaultLimits(), accountId:current === 1 ? 'workspace-one' : 'workspace-two'}};
    }), {signal:options.signal});
  }});
  await h.provider.start(5);
  await h.provider.refresh();
  assert.equal(h.clears.length, 0);
  assert.equal(h.snapshots.length, 1);
  await h.provider.refresh();
  assert.equal(h.clears.length, 1);
  assert.equal(h.snapshots.length, 2);
  assert.ok(!JSON.stringify(h.states).includes('workspace'));
  assert.ok(!JSON.stringify(h.snapshots).includes('workspace'));
  h.provider.stop();
});

test('invalid intervals never enable a schedule', () => {
  const h = providerHarness();
  for (const value of [0, 1441, 1.5, NaN, '5']) assert.throws(() => h.provider.start(value), RangeError);
  assert.equal(h.provider.getStatus().enabled, false);
  assert.equal(h.timers.length, 0);
});
