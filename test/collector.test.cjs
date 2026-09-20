'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = name => fs.readFileSync(path.join(__dirname, '../extension', name), 'utf8');
const PAGE = 'https://chatgpt.com/settings/usage?tab=overview';
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness(url, withParser = true) {
  const messages = [], observations = [], listeners = new Set(), intervals = new Map();
  const state = { reads: 0, disconnects: 0 };
  let timerId = 0;
  const document = {
    documentElement: {},
    querySelector(selector) {
      assert.equal(selector, 'main,[role="main"]');
      state.reads++;
      return null;
    },
    get body() { throw new Error('full-page text must not be read'); }
  };
  const context = vm.createContext({
    URL, location: new URL(url), document,
    chrome: { runtime: { id: 'extension-test',
      onMessage: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
      sendMessage: async message => { messages.push(JSON.parse(JSON.stringify(message))); return { ok: true }; }
    } },
    MutationObserver: class {
      observe(target, options) { observations.push({ target, options }); }
      disconnect() { state.disconnects++; }
    },
    setInterval: fn => { const id = ++timerId; intervals.set(id, fn); return id; },
    clearInterval: id => intervals.delete(id),
    setTimeout: () => ++timerId, clearTimeout() {}
  });
  if (withParser) vm.runInContext(source('parser.js'), context);
  const inject = () => vm.runInContext(source('collector.js'), context);
  inject();
  const poll = async () => { await settle(); await Promise.all([...intervals.values()].map(fn => fn())); };
  return { context, state, messages, observations, listeners, intervals, inject, poll };
}

test('collector and real parser recognize both official routes and preserve unknown fields', async () => {
  for (const url of [PAGE, 'https://chatgpt.com/settings/usage/?tab=overview',
    'https://chatgpt.com/codex/settings/usage', 'https://chatgpt.com/codex/settings/usage/?view=limits']) {
    const h = harness(url);
    await settle();
    assert.equal(h.observations.length, 1, url);
    assert.equal(h.listeners.size, 1);
    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0].type, 'orb:snapshot');
    assert.equal(h.messages[0].snapshot.source, 'official-page');
    assert.deepEqual(h.messages[0].snapshot.windows, []);
    assert.deepEqual(h.messages[0].snapshot.tokens, { total: null, today: null });
    assert.equal(JSON.stringify(h.messages).includes('tab=overview'), false);
    h.context.__orbCollector.stop();
    assert.equal(h.intervals.size, 0);
    assert.equal(h.listeners.size, 0);
  }
});

test('collector fails closed on unsupported routes or absent parser without observing or reading the page', () => {
  const rejected = ['https://chatgpt.com/', 'https://chatgpt.com/settings/usage/extra',
    'https://chatgpt.com/settings/usage-extra', 'https://chatgpt.com/settings/%75sage',
    'https://chatgpt.com/Settings/usage', 'https://chatgpt.com.evil.test/settings/usage',
    'http://chatgpt.com/settings/usage', 'https://chatgpt.com:444/settings/usage',
    'https://user:password@chatgpt.com/settings/usage'];
  for (const [url, withParser] of [...rejected.map(url => [url, true]), [PAGE, false]]) {
    const h = harness(url, withParser);
    assert.equal(h.state.reads, 0, url);
    assert.equal(h.messages.length, 0, url);
    assert.equal(h.observations.length, 0, url);
    assert.equal(h.listeners.size, 0, url);
    assert.equal(h.intervals.size, 0, url);
  }
});

test('collector stops after navigation off the official usage route without a further read or message', async () => {
  const h = harness(PAGE);
  await settle();
  assert.equal(h.messages.length, 1);
  h.context.location = new URL('https://chatgpt.com/');
  await h.poll();
  assert.equal(h.state.reads, 1);
  assert.equal(h.messages.length, 1);
  assert.equal(h.state.disconnects, 1);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.intervals.size, 0);
});

test('collector refresh replaces the previous observer and timer instead of duplicating collection', async () => {
  const h = harness(PAGE);
  await settle();
  h.inject();
  await settle();
  assert.equal(h.state.disconnects, 1);
  assert.equal(h.observations.length, 2);
  assert.equal(h.listeners.size, 1);
  assert.equal(h.intervals.size, 1);
  assert.equal(h.messages.length, 2);
  await h.poll();
  assert.equal(h.messages.length, 3);
});
