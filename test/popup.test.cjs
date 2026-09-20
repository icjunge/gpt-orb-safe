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
  'weekly-used', 'session-reset', 'weekly-reset', 'total-tokens', 'today-tokens', 'reload-extension'];

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
  let reloadCalls = 0;
  const intervals = new Map();
  let nextInterval = 0;
  let transport = options.transport || (async () => healthy());
  const runtime = { id: ID, reload() { reloadCalls++; }, async sendMessage(message) {
    calls.push(structuredClone(message));
    return transport(message);
  } };
  const chrome = Object.hasOwn(options, 'chrome') ? options.chrome : { runtime };
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
    setTimeout, clearTimeout
  });
  vm.runInContext(source, context, { filename: 'popup.js' });
  return { context, calls, intervals, node: id => document.getElementById(id),
    reloadCalls: () => reloadCalls,
    setTransport(fn) { transport = fn; },
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

test('an unavailable service worker disables actions and can recover on the next status poll', async () => {
  const h = harness({ transport: async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); } });
  await flush();
  assert.match(h.node('status').textContent, /扩展后台.*无法响应/);
  for (const id of ['code', 'start', 'refresh', 'manual-send']) assert.equal(h.node(id).disabled, true);
  assert.equal(h.node('reload-extension').disabled, false, 'Local recovery remains available without the service worker');
  assert.doesNotMatch(h.visibleText(), /Receiving end does not exist|Could not establish/);
  assert.ok(h.intervals.size > 0, 'Valid extension contexts should be able to recover');
  h.setTransport(async () => healthy());
  await h.poll();
  assert.match(h.node('status').textContent, /同步/);
  for (const id of ['code', 'start', 'refresh', 'manual-send']) assert.equal(h.node(id).disabled, false);
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
