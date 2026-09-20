'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ID = 'agneegnckfnfbmajknfomclligggnhie';
const PAGE = 'https://chatgpt.com/settings/usage?tab=overview';
const SECRET = 'A'.repeat(43);
const CODE = `GPTORB2.43861.${SECRET}`;
const POPUP = { id: ID, url: `chrome-extension://${ID}/popup.html` };
const PERIOD = 'orb:auto-refresh';
const TIMEOUT = 'orb:auto-timeout';
const source = fs.readFileSync(path.join(__dirname, '../extension/sw.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(setImmediate); };
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

function harness() {
  const h = { now: Date.now(), data: {}, local: {}, tabs: new Map(), alarms: new Map(), timers: new Map(),
    requests: [], injections: [], created: [], closed: [], stops: [], granted: true, nextTab: 100,
    windows: [{ id: 1, type: 'normal', focused: true, incognito: false }],
    status: 204, tabStatus: 'complete', usedPercent: 25, empty: false, handlers: {} };
  h.tabs.set(7, { id: 7, windowId: 1, active: true, url: 'https://example.test/user-tab', status: 'complete' });
  const event = name => ({ addListener(fn) { h.handlers[name] = fn; } });
  const storage = data => ({
    get: async key => Object.fromEntries((Array.isArray(key) ? key : [key]).map(k => [k, structuredClone(data[k])])),
    set: async values => { Object.assign(data, structuredClone(values)); },
    remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }
  });
  const chrome = {
    runtime: { id: ID, getURL: file => `chrome-extension://${ID}/${file}`, onMessage: event('message') },
    storage: { session: { ...storage(h.data), setAccessLevel: async () => {} }, local: storage(h.local) },
    permissions: { contains: async value => { assert.deepEqual(Array.from(value.origins), ['https://chatgpt.com/*']); return h.granted; }, onRemoved: event('permissionRemoved') },
    alarms: { get: async name => structuredClone(h.alarms.get(name)),
      create: async (name, value) => { h.alarms.set(name, { name, scheduledTime: value.when, periodInMinutes: value.periodInMinutes }); },
      clear: async name => h.alarms.delete(name), onAlarm: event('alarm') },
    windows: { getAll: async options => { assert.deepEqual(Array.from(options.windowTypes), ['normal']); return structuredClone(h.windows); } },
    tabs: {
      query: async () => [...h.tabs.values()].filter(t => t.active).map(t => structuredClone(t)),
      get: async id => { if (!h.tabs.has(id)) throw new Error('No tab'); return structuredClone(h.tabs.get(id)); },
      create: async options => {
        h.created.push(structuredClone(options));
        if (h.createWait) await h.createWait.promise;
        const tab = { id: h.nextTab++, ...options, status: h.tabStatus };
        if (h.initialURL !== undefined) tab.url = h.initialURL;
        if (h.pendingURL !== undefined) tab.pendingUrl = h.pendingURL;
        h.tabs.set(tab.id, tab);
        return structuredClone(tab);
      },
      remove: async id => { h.closed.push(id); h.tabs.delete(id); h.handlers.removed(id); },
      sendMessage: async (...args) => { h.stops.push(args); },
      onRemoved: event('removed'), onUpdated: event('updated'), onActivated: event('activated')
    },
    scripting: { executeScript: async options => {
      h.injections.push(options);
      if (options.files) return [{ frameId: 0, result: undefined }];
      if (h.scriptWait) await h.scriptWait.promise;
      if (h.scriptResult) return [{ frameId: 0, result: structuredClone(h.scriptResult) }];
      return [{ frameId: 0, result: { version: 1, source: 'official-page', capturedAt: h.now,
        windows: h.empty ? [] : [{ kind: 'session', usedPercent: h.usedPercent, resetAt: null, resetApproximate: false }],
        tokens: { total: null, today: null } } }];
    } }
  };
  class Clock extends Date { static now() { return h.now; } }
  let timerId = 0;
  h.restart = () => {
    h.timers.clear();
    const context = vm.createContext({ chrome, URL, AbortController, Date: Clock,
      setTimeout: (fn, delay) => { const id = ++timerId; h.timers.set(id, { fn, at: h.now + delay }); return id; },
      clearTimeout: id => { h.timers.delete(id); },
      fetch: async (url, options) => {
        h.requests.push({ url, options });
        if (h.fetchWait) await Promise.race([h.fetchWait.promise, new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => { const error = new Error('Aborted'); error.name = 'AbortError'; reject(error); }, { once: true });
        })]);
        return { ok: h.status >= 200 && h.status < 300, status: h.status };
      }
    });
    vm.runInContext(source, context);
  };
  h.send = message => new Promise(resolve => { if (!h.handlers.message(message, POPUP, resolve)) resolve(undefined); });
  h.enable = (minutes = 5, code = CODE) => h.send({ type: 'orb:auto-start', minutes, code });
  h.alarm = async name => { h.handlers.alarm({ name }); await flush(); };
  h.advance = async milliseconds => {
    h.now += milliseconds;
    for (const [id, timer] of [...h.timers]) if (timer.at <= h.now) { h.timers.delete(id); timer.fn(); }
    await flush();
  };
  h.restart();
  return h;
}

test('scheduled refresh requires explicit host grant, pairing and a bounded integer interval', async () => {
  const h = harness();
  h.granted = false;
  assert.equal((await h.enable()).ok, false);
  h.granted = true;
  assert.equal(h.created.length, 0);
  assert.equal(h.requests.length, 0);
  for (const message of [{ type: 'orb:auto-start', minutes: 5 },
    { type: 'orb:auto-start', minutes: 5, code: 'invalid' },
    ...[0, 1441, 1.5, '5', null].map(minutes => ({ type: 'orb:auto-start', minutes, code: CODE }))]) {
    assert.equal((await h.send(message)).ok, false);
  }
  await flush();
  assert.equal(h.data.bridge, undefined);
  assert.deepEqual(h.local, {});
  assert.equal(h.created.length, 0);
  assert.equal(h.requests.length, 0);
  assert.equal(JSON.stringify(h.local).includes(SECRET), false);
});

test('background refresh creates only an inactive official tab and posts isolated numeric output without credentials', async () => {
  const h = harness();
  assert.equal((await h.enable(10)).ok, true);
  await flush();
  assert.deepEqual(h.created, [{ windowId: 1, url: PAGE, active: false }]);
  assert.equal(h.tabs.get(7).url, 'https://example.test/user-tab');
  assert.deepEqual(h.closed, [100]);
  assert.equal(h.injections.length, 2);
  assert.deepEqual(Array.from(h.injections[0].files), ['parser.js']);
  assert.equal(typeof h.injections[1].func, 'function');
  for (const injection of h.injections) {
    assert.equal(injection.world, 'ISOLATED');
    assert.deepEqual(Array.from(injection.target.frameIds), [0]);
    assert.equal(injection.target.tabId, 100);
  }
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, 'http://127.0.0.1:43861/v1/usage');
  assert.equal(h.requests[0].options.credentials, 'omit');
  assert.equal(h.requests[0].options.redirect, 'error');
  assert.deepEqual(Object.keys(JSON.parse(h.requests[0].options.body)).sort(), ['capturedAt', 'source', 'tokens', 'version', 'windows']);
  const status = await h.send({ type: 'orb:status' });
  assert.equal(status.autoRefresh.enabled, true);
  assert.equal(status.autoRefresh.minutes, 10);
  assert.equal(status.autoRefresh.running, false);
  assert.equal(status.autoRefresh.nextRunAt, h.now + 600000);
  assert.equal(status.autoRefresh.lastAttemptAt, h.now);
  assert.equal(JSON.stringify(status).includes(SECRET), false);
  assert.equal(JSON.stringify(status).includes(PAGE), false);
  assert.deepEqual(h.local, { autoRefreshMinutes: 10 });
});

test('overlapping alarms and refresh clicks share one pending owned tab', async () => {
  const h = harness(); h.tabStatus = 'loading';
  await h.enable(1); await flush();
  await h.alarm(PERIOD);
  await h.send({ type: 'orb:auto-refresh' }); await flush();
  assert.equal(h.created.length, 1);
  assert.equal(h.requests.length, 0);
  h.tabs.get(100).status = 'complete';
  h.handlers.updated(100, { status: 'complete' }); await flush();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.closed, [100]);
});

test('unknown or unhydrated page data never overwrites the last successful reading', async () => {
  const h = harness();
  await h.enable(); await flush();
  const lastRead = h.data.status.lastReadAt;
  h.empty = true; h.now += 300000;
  await h.alarm(PERIOD);
  assert.equal(h.requests.length, 1);
  assert.ok(h.data.autoRun);
  await h.advance(15001);
  assert.equal(h.requests.length, 1);
  assert.equal(h.data.status.lastReadAt, lastRead);
  assert.match(h.data.autoRefresh.error, /未识别到用量/);
  assert.equal(h.data.autoRun, undefined);
  assert.deepEqual(h.closed, [100, 101]);
});

test('next scheduled load reads changed and reset usage instead of reusing the previous DOM', async () => {
  const h = harness();
  await h.enable(); await flush();
  h.usedPercent = 0; h.now += 300000;
  await h.alarm(PERIOD);
  assert.equal(h.created.length, 2);
  assert.equal(h.requests.length, 2);
  const body = JSON.parse(h.requests[1].options.body);
  assert.equal(body.windows[0].usedPercent, 0);
  assert.equal(body.capturedAt, h.now);
});

test('user navigation away cancels the run and never closes or reads the new page', async () => {
  const h = harness(); h.tabStatus = 'loading';
  await h.enable(); await flush();
  h.tabs.get(100).url = 'https://chatgpt.com/';
  h.handlers.updated(100, { url: 'https://chatgpt.com/' }); await flush();
  assert.equal(h.injections.length, 0);
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.closed, []);
  assert.ok(h.tabs.has(100));
  assert.equal(h.data.autoRun, undefined);
  assert.match(h.data.autoRefresh.error, /离开用量页/);
  assert.equal(h.data.autoRefresh.enabled, false);
  assert.equal(h.alarms.size, 0);
});

test('closing a background tab cancels only the current run while preserving the periodic preference', async () => {
  const h = harness(); h.tabStatus = 'loading';
  await h.enable(); await flush();
  h.tabs.delete(100); h.handlers.removed(100); await flush();
  assert.equal(h.data.autoRun, undefined);
  assert.equal(h.data.autoRefresh.enabled, true);
  assert.ok(h.alarms.has(PERIOD));
  assert.equal(h.requests.length, 0);
  assert.match(h.data.autoRefresh.error, /已关闭/);
});

test('once the user activates an owned tab it is retained even after switching away and restarting the worker', async () => {
  const h = harness(); h.tabStatus = 'loading';
  await h.enable(); await flush();
  h.tabs.get(100).active = true; h.handlers.activated({ tabId: 100 }); await flush();
  assert.equal(h.data.autoRun.claimed, true);
  h.tabs.get(100).active = false;
  h.tabs.get(100).status = 'complete';
  h.restart(); await flush();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.closed, []);
  assert.ok(h.tabs.has(100));
});

test('durable timeout alarm expires an unfinished run after worker termination', async () => {
  const h = harness(); h.tabStatus = 'loading';
  await h.enable(); await flush();
  h.now += 61000;
  h.restart(); await flush();
  assert.equal(h.data.autoRun, undefined);
  assert.match(h.data.autoRefresh.error, /超时/);
  assert.deepEqual(h.closed, [100]);
  assert.equal(h.requests.length, 0);
  assert.ok(h.alarms.has(PERIOD));
  assert.equal(h.alarms.has(TIMEOUT), false);
});

test('a service-worker restart restores a missing periodic alarm without an extra refresh', async () => {
  const h = harness();
  await h.enable(12); await flush();
  const next = h.data.autoRefresh.nextRunAt;
  h.alarms.clear(); h.restart(); await flush();
  assert.equal(h.alarms.get(PERIOD).scheduledTime, next);
  assert.equal(h.alarms.get(PERIOD).periodInMinutes, 12);
  assert.equal(h.created.length, 1);
  assert.equal(h.requests.length, 1);
});

test('browser restart clears orphaned alarms and does not resume from a durable interval alone', async () => {
  const h = harness();
  await h.enable(12); await flush();
  for (const key of Object.keys(h.data)) delete h.data[key];
  h.restart(); await flush();
  assert.equal(h.alarms.size, 0);
  assert.equal(h.created.length, 1);
  const status = await h.send({ type: 'orb:status' });
  assert.equal(status.autoRefresh.enabled, false);
  assert.equal(status.autoRefresh.minutes, 12);
  assert.equal(status.paired, false);
});

test('revoking optional permission cancels pending requests and stops alarms without losing the previous reading', async () => {
  const h = harness();
  await h.enable(); await flush();
  const lastRead = h.data.status.lastReadAt;
  h.fetchWait = deferred(); h.now += 300000;
  await h.alarm(PERIOD);
  assert.equal(h.requests.length, 2);
  h.granted = false; h.handlers.permissionRemoved({ origins: ['https://chatgpt.com/*'] }); await flush();
  assert.equal(h.requests[1].options.signal.aborted, true);
  assert.equal(h.data.autoRefresh.enabled, false);
  assert.equal(h.data.bridge.mode, 'manual');
  assert.equal(h.data.autoRun, undefined);
  assert.equal(h.alarms.size, 0);
  assert.equal(h.data.status.lastReadAt, lastRead);
  assert.match(h.data.autoRefresh.error, /撤回/);
  h.fetchWait.resolve();
});

test('stop is responsive during network wait, keeps pairing, and prevents a late result from mutating new state', async () => {
  const h = harness(); h.fetchWait = deferred();
  await h.enable(); await flush();
  assert.equal(h.requests.length, 1);
  const result = await h.send({ type: 'orb:auto-stop' });
  assert.equal(result.ok, true);
  assert.equal(h.data.bridge.secret, SECRET);
  assert.equal(h.data.bridge.mode, 'manual');
  assert.equal(h.requests[0].options.signal.aborted, true);
  assert.equal(h.data.autoRun, undefined);
  await flush();
  assert.equal(h.data.status, undefined);
  h.fetchWait.resolve();
});

test('changing pairing while a DOM read is pending rejects the old run result', async () => {
  const h = harness(); h.scriptWait = deferred();
  await h.enable(); await flush();
  assert.equal(h.injections.length, 2);
  await h.send({ type: 'orb:stop' });
  h.tabs.get(7).url = PAGE;
  await h.send({ type: 'orb:start', code: `GPTORB2.43861.${'B'.repeat(43)}` });
  h.scriptWait.resolve(); await flush();
  assert.equal(h.requests.length, 0);
  assert.equal(h.data.bridge.secret, 'B'.repeat(43));
  assert.equal(h.data.bridge.mode, 'automatic');
  assert.equal(h.data.status.error, '');
});

test('missing ordinary browser windows does not create a popup, incognito tab or new window', async () => {
  const h = harness();
  h.windows = [{ id: 2, type: 'popup', focused: true }, { id: 3, type: 'normal', incognito: true }];
  await h.enable(); await flush();
  assert.deepEqual(h.created, []);
  assert.equal(h.requests.length, 0);
  assert.match(h.data.autoRefresh.error, /普通浏览器窗口/);
  assert.equal(h.data.autoRefresh.enabled, true);
});

test('desktop rejects expired pairing: scheduler and session secret are removed', async () => {
  const h = harness(); h.status = 401;
  await h.enable(); await flush();
  assert.equal(h.data.bridge, undefined);
  assert.equal(h.data.autoRefresh.enabled, false);
  assert.equal(h.data.autoRun, undefined);
  assert.equal(h.alarms.size, 0);
  assert.match(h.data.status.error, /配对已失效/);
  assert.deepEqual(h.closed, [100]);
});


test('new blank or pending tabs wait for the committed official route before injection', async () => {
  for (const initialURL of ['', 'about:blank']) {
    const h = harness(); h.tabStatus = 'loading'; h.initialURL = initialURL; h.pendingURL = PAGE;
    await h.enable(); await flush();
    assert.equal(h.injections.length, 0);
    assert.equal(h.requests.length, 0);
    assert.ok(h.data.autoRun);
    h.handlers.updated(100, { url: initialURL }); await flush();
    assert.ok(h.data.autoRun);
    Object.assign(h.tabs.get(100), { url: PAGE, status: 'complete' });
    h.handlers.updated(100, { url: PAGE, status: 'complete' }); await flush();
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.closed, [100]);
  }
});

test('navigation away then immediately back relinquishes tab ownership and pauses repeated login tabs', async () => {
  const h = harness(); h.tabStatus = 'loading';
  await h.enable(); await flush();
  h.handlers.updated(100, { url: 'https://chatgpt.com/' });
  h.tabs.get(100).url = PAGE;
  await flush();
  assert.equal(h.data.autoRefresh.enabled, false);
  assert.equal(h.data.bridge.mode, 'manual');
  assert.equal(h.alarms.size, 0);
  assert.deepEqual(h.closed, []);
  assert.ok(h.tabs.has(100));
  await h.alarm(PERIOD);
  assert.equal(h.created.length, 1);
});

test('timeout during POST aborts the request without replacing the actionable timeout error', async () => {
  const h = harness(); h.fetchWait = deferred();
  await h.enable(); await flush();
  h.now += 61000;
  await h.alarm(TIMEOUT);
  assert.equal(h.requests[0].options.signal.aborted, true);
  assert.equal(h.data.autoRun, undefined);
  assert.match(h.data.status.error, /超时/);
  assert.match(h.data.autoRefresh.error, /超时/);
  h.fetchWait.resolve();
});


test('removing permission after an explicit stop preserves the clean disabled state', async () => {
  const h = harness();
  await h.enable(); await flush();
  const lastRead = h.data.status.lastReadAt;
  await h.send({ type: 'orb:auto-stop' });
  h.granted = false; h.handlers.permissionRemoved({ origins: ['https://chatgpt.com/*'] }); await flush();
  assert.equal(h.data.autoRefresh.enabled, false);
  assert.equal(h.data.autoRefresh.error, '');
  assert.equal(h.data.status.lastReadAt, lastRead);
  assert.equal(h.data.bridge.mode, 'manual');
});
