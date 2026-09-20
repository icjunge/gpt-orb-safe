'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ID = 'agneegnckfnfbmajknfomclligggnhie';
const EXTENSION_URL = `chrome-extension://${ID}/popup.html`;
const PAIRING_CODE = `GPTORB2.43861.${'A'.repeat(43)}`;
const html = fs.readFileSync(path.join(__dirname, '../extension/popup.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../extension/popup.js'), 'utf8');
const controls = ['code', 'start', 'refresh', 'stop', 'manual-send', 'session-used',
  'weekly-used', 'session-reset', 'weekly-reset', 'total-tokens', 'today-tokens', 'reload-extension',
  'auto-minutes', 'auto-enable', 'auto-now', 'auto-disable'];

function healthy(overrides = {}) {
  return { ok: true, paired: true, onUsagePage: true, sameTab: true, mode: 'automatic',
    lastSentAt: Date.now(), lastReadAt: Date.now(), hasData: true, error: '', ...overrides };
}

function harness(options = {}) {
  const nodes = new Map();
  function element(id, tag = 'div', attributes = '') {
    const listeners = new Map();
    return { id, tagName: tag.toUpperCase(), value: '', textContent: '', className: '',
      disabled: /\bdisabled\b/.test(attributes), hidden: /\bhidden\b/.test(attributes),
      addEventListener(type, fn) {
        const list = listeners.get(type) || [];
        list.push(fn); listeners.set(type, list);
      },
      setAttribute(name, value) { this[name] = value; },
      removeAttribute(name) { if (name === 'disabled' || name === 'hidden') this[name] = false; },
      focus() {},
      dispatch(type) {
        for (const fn of listeners.get(type) || []) fn({ preventDefault() {}, target: this });
      }
    };
  }
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    nodes.set(match[3], element(match[3], match[1], match[2]));
  }
  // The recovery panel is static markup; this also permits running against the old
  // release to demonstrate that these regressions fail before the implementation fix.
  if (!nodes.has('setup-help')) nodes.set('setup-help', element('setup-help', 'section', 'hidden'));
  const calls = [];
  const permissionCalls = [];
  const events = [];
  let reloadCalls = 0;
  const intervals = new Map();
  const timeouts = new Map();
  let nextInterval = 0;
  let nextTimeout = 0;
  let transport = options.transport || (async () => healthy());
  const runtime = { id: ID, reload() { reloadCalls++; }, async sendMessage(message) {
    events.push(message.type);
    calls.push(structuredClone(message));
    return transport(message);
  } };
  const permissions = {
    request(value) {
      events.push('permission-request');
      permissionCalls.push({ type: 'request', value: structuredClone(value) });
      return options.requestPermission ? options.requestPermission(value) : Promise.resolve(true);
    },
    remove(value) {
      events.push('permission-remove');
      permissionCalls.push({ type: 'remove', value: structuredClone(value) });
      return options.removePermission ? options.removePermission(value) : Promise.resolve(true);
    }
  };
  const chrome = Object.hasOwn(options, 'chrome') ? options.chrome : { runtime, permissions };
  const document = {
    getElementById(id) {
      assert.ok(nodes.has(id), `Unexpected element requested: ${id}`);
      return nodes.get(id);
    },
    querySelectorAll(selector) {
      if (selector === 'input, button') return [...nodes.values()].filter(n => ['INPUT', 'BUTTON'].includes(n.tagName));
      if (selector === 'input') return [...nodes.values()].filter(n => n.tagName === 'INPUT');
      if (selector === 'button') return [...nodes.values()].filter(n => n.tagName === 'BUTTON');
      throw new Error(`Unexpected DOM selector: ${selector}`);
    }
  };
  const context = vm.createContext({ chrome, document,
    location: new URL(options.url || EXTENSION_URL), URL,
    setInterval(fn, delay) { const id = ++nextInterval; intervals.set(id, { fn, delay }); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(fn, delay) { const id = ++nextTimeout; timeouts.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timeouts.delete(id); }
  });
  vm.runInContext(source, context, { filename: 'popup.js' });
  return { context, calls, permissionCalls, events, intervals, node: id => document.getElementById(id),
    reloadCalls: () => reloadCalls,
    setTransport(fn) { transport = fn; },
    async expireTimers(delay) {
      for (const [id, timer] of [...timeouts]) {
        if (timer.delay === delay) { timeouts.delete(id); timer.fn(); }
      }
      await flush();
    },
    async poll() { for (const timer of [...intervals.values()]) timer.fn(); await flush(); },
    async submit() { document.getElementById('pair-form').dispatch('submit'); await flush(); },
    visibleText() { return [...nodes.values()].map(n => n.textContent).join('\n'); }
  };
}

async function flush() {
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
}

function assertDisabled(h) {
  for (const id of controls) assert.equal(h.node(id).disabled, true, `${id} must be disabled`);
}

for (const [name, chrome] of [['chrome exists without runtime', {}], ['chrome is undefined', undefined]]) {
  test(`opening popup.html as a file cannot pair when ${name}`, async () => {
    const h = harness({ url: 'file:///C:/GPT-Orb/Browser-Extension/popup.html', chrome });
    await flush();
    assert.match(h.node('status').textContent, /浏览器扩展图标/);
    assert.equal(h.node('setup-help').hidden, false);
    assertDisabled(h);
    assert.equal(h.intervals.size, 0, 'An ordinary page must not repeatedly retry extension APIs');
    h.node('code').value = PAIRING_CODE;
    await h.submit();
    assert.equal(h.calls.length, 0);
    assert.doesNotMatch(h.visibleText(), /Cannot read properties|sendMessage|GPTORB2\./);
  });
}

test('an extension URL with no runtime fails closed with recovery instructions', async () => {
  const h = harness({ chrome: {} });
  await flush();
  assert.match(h.node('status').textContent, /扩展运行环境不可用/);
  assert.equal(h.node('setup-help').hidden, false);
  assertDisabled(h);
  assert.equal(h.intervals.size, 0);
  await h.submit();
  assert.equal(h.calls.length, 0);
});

for (const [name, runtime] of [
  ['missing extension identity', { sendMessage() { throw new Error('Must not be called'); } }],
  ['non-callable messaging API', { id: ID, sendMessage: true }]
]) {
  test(`an incomplete runtime fails closed: ${name}`, async () => {
    const h = harness({ chrome: { runtime } });
    await flush();
    assertDisabled(h);
    assert.equal(h.node('setup-help').hidden, false);
    assert.equal(h.intervals.size, 0);
    await h.submit();
    assert.doesNotMatch(h.visibleText(), /Must not be called|sendMessage|not a function/);
  });
}

test('an ordinary website cannot use a provided runtime object to bypass the context guard', async () => {
  const h = harness({ url: 'https://example.test/popup.html' });
  await flush();
  assertDisabled(h);
  assert.equal(h.node('setup-help').hidden, false);
  assert.equal(h.intervals.size, 0);
  await h.submit();
  assert.equal(h.calls.length, 0);
});

test('an extension URL must match the runtime extension identity', async () => {
  const h = harness({ url: `chrome-extension://${'b'.repeat(32)}/popup.html` });
  await flush();
  assertDisabled(h);
  assert.equal(h.node('setup-help').hidden, false);
  assert.equal(h.calls.length, 0);
  assert.equal(h.intervals.size, 0);
});

test('a healthy extension enables pairing, sends the code once, and clears the input', async () => {
  const h = harness();
  await flush();
  assert.match(h.node('status').textContent, /同步/);
  assert.equal(h.node('setup-help').hidden, true);
  for (const id of ['code', 'start', 'refresh', 'stop', 'manual-send']) {
    assert.equal(h.node(id).disabled, false, `${id} should be available after the worker responds`);
  }
  assert.ok(h.intervals.size > 0);
  h.node('code').value = PAIRING_CODE;
  await h.submit();
  const starts = h.calls.filter(message => message.type === 'orb:start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].code, PAIRING_CODE);
  assert.equal(h.node('code').value, '');
  assert.equal(h.node('message').textContent, '');
  assert.equal(h.visibleText().includes(PAIRING_CODE), false);
});

test('an unavailable service worker leaves pairing editable and can recover on the next status poll', async () => {
  const h = harness({ transport: async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); } });
  await flush();
  assert.match(h.node('status').textContent, /扩展后台.*无法响应/);
  for (const id of ['code', 'start']) assert.equal(h.node(id).disabled, false);
  for (const id of ['refresh', 'manual-send']) assert.equal(h.node(id).disabled, true);
  assert.equal(h.node('reload-extension').disabled, false, 'Local recovery remains available without the service worker');
  assert.doesNotMatch(h.visibleText(), /Receiving end does not exist|Could not establish/);
  assert.ok(h.intervals.size > 0, 'Valid extension contexts should be able to recover');
  h.setTransport(async () => healthy());
  await h.poll();
  assert.match(h.node('status').textContent, /同步/);
  for (const id of ['code', 'start', 'refresh', 'manual-send']) assert.equal(h.node(id).disabled, false);
});

for (const [tabState, expected] of [
  ['no-tab', /未找到当前标签页/],
  ['url-unavailable', /尚未获得当前页授权/],
  ['unsupported-page', /请打开官方用量页/]
]) {
  test(`pairing stays editable with a useful explanation for ${tabState}`, async () => {
    const h = harness({ transport: async message => message.type === 'orb:start'
      ? { ok: false, message: '请从官方用量页的工具栏打开扩展后重试。' }
      : healthy({ paired: false, onUsagePage: false, tabState }) });
    await flush();
    assert.match(h.node('status').textContent, expected);
    assert.equal(h.node('code').disabled, false);
    assert.equal(h.node('start').disabled, false);
    h.node('code').value = PAIRING_CODE;
    await h.poll();
    assert.equal(h.node('code').value, PAIRING_CODE, 'Status polling preserves user input');
    assert.equal(h.node('code').disabled, false);
    assert.equal(h.node('manual-send').disabled, true);
    await h.submit();
    assert.equal(h.calls.filter(m => m.type === 'orb:start').length, 1);
    assert.match(h.node('message').textContent, /官方用量页/);
    assert.equal(h.node('code').value, '');
    assert.equal(h.node('code').disabled, false, 'A rejected pairing can be corrected');
    assert.equal(h.visibleText().includes(PAIRING_CODE), false);
  });
}

test('a hung status cannot block typing, start an unbounded poll queue, or prevent pairing', async () => {
  const h = harness({ transport: message => message.type === 'orb:status'
    ? new Promise(() => {}) : Promise.resolve({ ok: true }) });
  await flush();
  assert.equal(h.node('code').disabled, false, 'Typing is available before the first status response');
  for (let i = 0; i < 5; i++) await h.poll();
  assert.equal(h.calls.length, 1, 'Do not overlap automatic status requests');
  await h.expireTimers(5000);
  assert.match(h.node('status').textContent, /扩展后台.*无法响应/);
  assert.equal(h.node('code').disabled, false);
  assert.equal(h.node('reload-extension').disabled, false);
  await h.poll(); // Another status now hangs while the user submits.
  h.node('code').value = PAIRING_CODE;
  await h.submit();
  assert.equal(h.calls.filter(m => m.type === 'orb:start').length, 1,
    'Pairing does not wait for a status request');
  assert.equal(h.node('code').disabled, false, 'Completed action releases busy before its status query');
  await h.expireTimers(5000);
  assert.equal(h.node('code').disabled, false);
});

test('a hung pairing releases the input after timeout without automatic resubmission', async () => {
  let finish;
  const h = harness({ transport: message => message.type === 'orb:start'
    ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(healthy({ paired: false })) });
  await flush();
  h.node('code').value = PAIRING_CODE;
  await h.submit();
  assert.equal(h.node('code').disabled, true);
  assert.equal(h.node('reload-extension').disabled, false);
  await h.expireTimers(10000);
  assert.equal(h.node('code').disabled, false);
  assert.equal(h.node('start').disabled, false);
  assert.match(h.node('message').textContent, /响应超时.*尚未确认操作结果/);
  assert.equal(h.calls.filter(m => m.type === 'orb:start').length, 1);
  finish({ ok: true });
  await flush();
  assert.match(h.node('message').textContent, /尚未确认操作结果/,
    'A late command response cannot claim confirmed success');
  assert.equal(h.node('code').value, '');
});

test('a stale status response cannot overwrite a newer pairing result or entered code', async () => {
  let oldStatus;
  const h = harness({ transport: () => new Promise(resolve => { oldStatus = resolve; }) });
  await flush();
  h.setTransport(async message => message.type === 'orb:status' ? healthy() : { ok: true });
  h.node('code').value = PAIRING_CODE;
  await h.submit();
  assert.match(h.node('status').textContent, /正在同步/);
  h.node('code').value = 'NEW_LOCAL_INPUT';
  oldStatus(healthy({ onUsagePage: false, tabState: 'unsupported-page' }));
  await flush();
  assert.match(h.node('status').textContent, /正在同步/);
  assert.equal(h.node('code').value, 'NEW_LOCAL_INPUT');
  assert.equal(h.node('code').disabled, false);
});

test('background refresh requests only the official origin in the gesture, then passes the code once', async () => {
  let grant;
  const h = harness({ requestPermission: () => new Promise(resolve => { grant = resolve; }),
    transport: async message => message.type === 'orb:status'
      ? healthy({ paired: false, onUsagePage: false, autoRefresh: { enabled: false, minutes: 5 } })
      : { ok: true } });
  await flush();
  assert.equal(h.permissionCalls.length, 0, 'Opening or polling the popup cannot request permissions');
  assert.equal(h.node('auto-minutes').disabled, false);
  h.node('auto-minutes').value = '17';
  h.node('code').value = PAIRING_CODE;
  const count = h.calls.length;
  h.node('auto-form').dispatch('submit');
  assert.deepEqual(h.permissionCalls, [{ type: 'request', value: { origins: ['https://chatgpt.com/*'] } }]);
  assert.equal(h.calls.length, count, 'No worker await or request before the permission prompt');
  assert.equal(h.node('code').value, '');
  grant(true);
  await flush();
  assert.deepEqual(h.calls.filter(m => m.type === 'orb:auto-start'), [
    { type: 'orb:auto-start', minutes: 17, code: PAIRING_CODE }
  ]);
  assert.equal(h.visibleText().includes(PAIRING_CODE), false);
});

test('denied optional permission leaves the current-page mode available and does not enable a schedule', async () => {
  const h = harness({ requestPermission: async () => false });
  await flush();
  h.node('auto-form').dispatch('submit');
  await flush();
  assert.equal(h.calls.some(m => m.type.startsWith('orb:auto-')), false);
  assert.match(h.node('message').textContent, /未授予.*未开启/);
  assert.equal(h.node('code').disabled, false);
  assert.equal(h.node('start').disabled, false);
});

test('invalid interval, malformed code or missing pairing are rejected before requesting permissions', async () => {
  const h = harness({ transport: async () => healthy({ paired: false }) });
  await flush();
  h.node('code').value = PAIRING_CODE;
  for (const value of ['', '0', '-1', '1.5', '1441', 'not-a-number']) {
    h.node('auto-minutes').value = value;
    h.node('auto-form').dispatch('submit');
    await flush();
    assert.match(h.node('message').textContent, /整数分钟/);
  }
  h.node('auto-minutes').value = '5';
  h.node('code').value = 'an-account-token-is-not-a-pairing-code';
  h.node('auto-form').dispatch('submit');
  await flush();
  assert.match(h.node('message').textContent, /配对码格式错误/);
  h.node('code').value = '';
  h.node('auto-form').dispatch('submit');
  await flush();
  assert.match(h.node('message').textContent, /先在上方粘贴/);
  assert.equal(h.permissionCalls.length, 0);
  assert.equal(h.calls.some(m => m.type.startsWith('orb:auto-')), false);
});

test('scheduled status remains meaningful with the usage tab closed and does not overwrite interval edits', async () => {
  const h = harness({ transport: async () => healthy({ onUsagePage: false,
    autoRefresh: { enabled: true, minutes: 30, nextRunAt: Date.now() + 1800000, running: false, error: '' } }) });
  await flush();
  assert.equal(h.node('status').textContent, '后台定时刷新已开启');
  assert.match(h.node('auto-status').textContent, /每 30 分钟刷新.*下次约.*上次成功读取/);
  assert.equal(h.node('auto-minutes').value, '30');
  assert.equal(h.node('auto-now').disabled, false);
  h.node('auto-minutes').value = '45';
  h.node('auto-minutes').dispatch('input');
  await h.poll();
  assert.equal(h.node('auto-minutes').value, '45');
  h.node('auto-now').dispatch('click');
  await flush();
  assert.equal(h.calls.filter(m => m.type === 'orb:auto-refresh').length, 1);
  assert.equal(h.permissionCalls.length, 0);
});

test('explicit disable revokes background site access even if the worker cannot confirm stopping', async () => {
  for (const failStop of [false, true]) {
    const h = harness({ transport: async message => {
      if (message.type === 'orb:auto-stop') {
        if (failStop) throw new Error('Worker unavailable');
        return { ok: true };
      }
      return healthy();
    } });
    await flush();
    h.node('auto-disable').dispatch('click');
    await flush();
    assert.equal(h.calls.filter(m => m.type === 'orb:auto-stop').length, 1);
    assert.deepEqual(h.permissionCalls, [{ type: 'remove', value: { origins: ['https://chatgpt.com/*'] } }]);
    assert.match(h.node('message').textContent, failStop ? /已撤销.*状态未能确认/ : /刷新已关闭.*撤销/);
  }
});

test('runtime invalidation or reload during the permission prompt cannot start background reading', async () => {
  for (const invalidate of [false, true]) {
    let grant;
    const h = harness({ requestPermission: () => new Promise(resolve => { grant = resolve; }) });
    await flush();
    h.node('auto-form').dispatch('submit');
    if (invalidate) delete h.context.chrome.runtime;
    else h.node('reload-extension').dispatch('click');
    grant(true);
    await flush();
    assert.equal(h.calls.some(m => m.type === 'orb:auto-start'), false);
    assert.equal(h.node('code').value, '');
  }
});

test('ordinary file pages cannot request background permission even with a supplied runtime', async () => {
  const h = harness({ url: 'file:///C:/Browser-Extension/popup.html' });
  await flush();
  h.node('auto-minutes').value = '5';
  h.node('code').value = PAIRING_CODE;
  h.node('auto-form').dispatch('submit');
  await flush();
  assert.equal(h.permissionCalls.length, 0);
  assert.equal(h.calls.length, 0);
  assertDisabled(h);
});

test('explicit reload works while unpaired and does not send a command or persist a pairing code', async () => {
  const h = harness({ transport: async () => healthy({ paired: false, onUsagePage: false }) });
  await flush();
  assert.equal(h.reloadCalls(), 0, 'Opening the popup never reloads it automatically');
  assert.equal(h.node('reload-extension').disabled, false);
  h.node('code').value = PAIRING_CODE;
  const before = h.calls.length;
  h.node('reload-extension').dispatch('click');
  h.node('reload-extension').dispatch('click');
  assert.equal(h.reloadCalls(), 1);
  assert.equal(h.calls.length, before, 'Reload has no worker or desktop bridge message');
  assert.equal(h.node('code').value, '');
  assert.equal(h.node('reload-extension').disabled, true);
  await h.poll();
  assert.equal(h.reloadCalls(), 1);
  assert.equal(h.node('reload-extension').disabled, true, 'Polling cannot create a reload loop');
});

test('explicit reload recovers a failed worker, while an ordinary web page cannot reload the extension', async () => {
  const h = harness({ transport: async () => { throw new Error('Worker stopped'); } });
  await flush();
  h.node('reload-extension').dispatch('click');
  assert.equal(h.reloadCalls(), 1);
  const web = harness({ url: 'https://example.test/popup.html' });
  await flush();
  web.node('reload-extension').dispatch('click');
  assert.equal(web.reloadCalls(), 0);
});

test('runtime invalidation after a successful status cannot leave pairing controls enabled', async () => {
  const h = harness();
  await flush();
  const previousCalls = h.calls.length;
  delete h.context.chrome.runtime;
  await h.poll();
  assertDisabled(h);
  assert.equal(h.node('setup-help').hidden, false);
  assert.match(h.node('status').textContent, /扩展运行环境不可用/);
  h.node('code').value = PAIRING_CODE;
  await h.submit();
  assert.equal(h.calls.length, previousCalls);
  assert.doesNotMatch(h.visibleText(), /Cannot read properties|sendMessage|GPTORB2\./);
});

for (const errorPrefix of ["Cannot read properties of undefined (reading 'sendMessage')", 'Unexpected worker failure']) {
  test(`transport errors do not copy pairing secrets or raw exception text into the interface: ${errorPrefix}`, async () => {
    const h = harness({ transport: async message => {
      if (message.type === 'orb:start') throw new Error(`${errorPrefix}: ${PAIRING_CODE}`);
      return healthy();
    } });
    await flush();
    h.node('code').value = PAIRING_CODE;
    await h.submit();
    assert.equal(h.calls.filter(message => message.type === 'orb:start').length, 1);
    assert.equal(h.node('code').value, '');
    assert.ok(h.node('message').textContent.length > 0, 'Failed pairing needs an actionable message');
    assert.equal(h.visibleText().includes(errorPrefix), false);
    assert.equal(h.visibleText().includes(PAIRING_CODE), false);
  });
}
