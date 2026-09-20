'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(overrides = {}) {
  const now = Date.now();
  return {
    usageSource: 'codex-cli', settings: { usageSource: 'codex-cli', refreshMinutes: 15 },
    staleAfterMs: 990000, status: 'ready', bridge: { listening: true, connected: false }, error: null,
    codex: { enabled: true, running: false, state: 'ready', intervalMinutes: 15, lastSuccessAt: now, nextRunAt: now + 900000 },
    snapshot: { version: 2, source: 'codex-cli', capturedAt: now, windows: [
      { id: 'main-primary', kind: 'cli', label: 'Codex · 5 小时', usedPercent: 30, resetAt: now + 3600000 },
      { id: 'spark-secondary', kind: 'cli', label: 'Spark · 官方窗口', usedPercent: 46, resetAt: now + 86400000 }
    ], tokens: { today: 0, total: 123456 }, tokenScope: 'account', tokenDate: '2026-09-19', resetCredits: 0 },
    ...overrides
  };
}
function harness(page, initial, actionImpl = async () => ({ ok: true })) {
  const html = fs.readFileSync(path.join(__dirname, '../src/ui', `${page}.html`), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '../src/ui', `${page}.js`), 'utf8');
  const nodes = new Map(), created = [], calls = [], intervals = [];
  function element(id = '', attrs = '') {
    const listeners = new Map();
    const node = {
      id, textContent: '', value: /\bvalue="([^"]*)"/.exec(attrs)?.[1] || '', disabled: /\bdisabled\b/.test(attrs),
      className: /\bclass="([^"]*)"/.exec(attrs)?.[1] || '', dataset: {}, style: {}, children: [], checked: false,
      addEventListener(name, fn) { listeners.set(name, [...listeners.get(name) || [], fn]); },
      dispatch(type, extra = {}) { for (const fn of listeners.get(type) || []) fn({ preventDefault() {}, target: this, ...extra }); },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; },
      setPointerCapture() {}
    };
    node.classList = {
      contains(name) { return node.className.split(/\s+/).includes(name); },
      toggle(name, force) {
        const classes = new Set(node.className.split(/\s+/).filter(Boolean));
        const add = force === undefined ? !classes.has(name) : force;
        add ? classes.add(name) : classes.delete(name); node.className = [...classes].join(' '); return add;
      }
    };
    Object.defineProperty(node, 'innerHTML', { set() { throw new Error('Unsafe HTML insertion'); } });
    return node;
  }
  for (const match of html.matchAll(/<[a-z][\w-]*\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) nodes.set(match[2], element(match[2], match[1]));
  const scroll = element();
  const document = {
    activeElement: null,
    getElementById(id) { assert.ok(nodes.has(id), `missing ${id}`); return nodes.get(id); },
    createElement() { const node = element(); created.push(node); return node; },
    querySelector(selector) { assert.equal(selector, '.main-scroll'); return scroll; },
    querySelectorAll(selector) {
      assert.equal(selector, '[data-reset-at]');
      return created.filter(node => node.dataset.resetAt !== undefined);
    }, addEventListener() {}
  };
  let onState;
  const window = { orb: {
    onState(fn) { onState = fn; }, getState: async () => structuredClone(initial),
    async action(name, payload) { calls.push({ name, payload: payload === undefined ? undefined : structuredClone(payload) }); return actionImpl(name, payload); }
  } };
  vm.runInNewContext(source, { window, document, Date, Number, setInterval(fn) { intervals.push(fn); }, setTimeout() { return 1; }, clearTimeout() {} }, { filename: `${page}.js` });
  return { node: id => document.getElementById(id), document, calls,
    change(state) { onState(structuredClone(state)); },
    tick() { for (const fn of intervals) fn(); },
    textTree(node = nodes.get('limits-list')) { return [node.textContent, ...node.children.map(child => this.textTree(child))].join(' '); },
    text() { return [...nodes.values(), ...created].map(n => n.textContent).join('\n'); }
  };
}
async function flush() { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); }

test('native mode requires explicit enable and shows installation without browser pairing', async () => {
  const h = harness('panel', fixture({ snapshot: null, codex: { enabled: false, state: 'disabled' } })); await flush();
  assert.equal(h.node('codex-controls').classList.contains('hidden'), false);
  assert.equal(h.node('codex-setup').classList.contains('hidden'), false);
  assert.equal(h.node('setup-card').classList.contains('hidden'), true);
  assert.equal(h.node('browser-settings').classList.contains('hidden'), true);
  assert.equal(h.node('refresh-codex-button').disabled, true);
  assert.equal(h.calls.length, 0);
  h.node('copy-codex-setup-button').dispatch('click'); await flush();
  assert.equal(h.calls.at(-1).name, 'copyCodexSetup');
  h.node('codex-help-button').dispatch('click'); await flush();
  assert.equal(h.calls.at(-1).name, 'openCodexHelp');
});

test('native labels and service date are literal text and unknown reset credits differ from zero', async () => {
  const state = fixture();
  const hostile = '<img src=x onerror=alert(1)> · Spark';
  state.snapshot.windows[1].label = hostile;
  const h = harness('panel', state); await flush();
  assert.equal(h.node('hero-tag').textContent, hostile);
  assert.ok(h.textTree().includes(hostile));
  assert.equal(h.node('today-token-label').textContent, '最近一日 Token');
  assert.equal(h.node('total-token-label').textContent, '服务端累计 Token');
  assert.equal(h.node('today-tokens').textContent, '0');
  assert.match(h.node('today-detail').textContent, /2026-09-19/);
  assert.match(h.node('scope-description').textContent, /并非本机今日/);
  assert.equal(h.node('reset-credits').textContent, '0');
  h.change({ ...state, snapshot: { ...state.snapshot, resetCredits: null, tokens: { today: null, total: null } } });
  assert.equal(h.node('reset-credits').textContent, '—');
  assert.equal(h.node('today-tokens').textContent, '—');
});

test('native freshness follows configured interval and stop preserves a historical reading', async () => {
  const state = fixture(); state.snapshot.capturedAt = Date.now() - 600000;
  const panel = harness('panel', state), orb = harness('orb', state); await flush();
  assert.equal(panel.node('source-badge').textContent, 'Codex 记录');
  assert.equal(orb.node('orb-unit').textContent, 'Codex 剩余');
  const stopped = { ...state, codex: { ...state.codex, enabled: false, state: 'disabled' } };
  panel.change(stopped); orb.change(stopped);
  assert.equal(panel.node('source-badge').textContent, '上次记录');
  assert.match(panel.node('freshness-note').textContent, /自动读取已停止/);
  assert.equal(panel.node('remaining-number').textContent, '54');
  assert.equal(orb.node('orb-unit').textContent, '上次记录');
  const expired = { ...state, staleAfterMs: 300000 };
  panel.change(expired); orb.change(expired);
  assert.match(panel.node('freshness-note').textContent, /超过预期刷新时间/);
  assert.equal(orb.node('orb-unit').textContent, '上次记录');
});

test('zero reset countdown waits for a new read and never refills the percentage', async () => {
  const state = fixture(); state.snapshot.windows[1].resetAt = Date.now() - 3000;
  const panel = harness('panel', state), orb = harness('orb', state); await flush();
  panel.tick(); orb.tick();
  assert.equal(panel.node('reset-countdown').textContent, '等待读取确认');
  assert.equal(panel.node('remaining-number').textContent, '54');
  assert.equal(orb.node('reset').textContent, '等待读取确认');
  assert.equal(orb.node('orb-value').textContent, '54%');
  assert.equal(panel.calls.length + orb.calls.length, 0);
});

test('interval editing survives state broadcasts and invalid intervals cannot call the main process', async () => {
  const state = fixture(); const h = harness('panel', state); await flush();
  h.node('refresh-minutes').value = '32'; h.node('refresh-minutes').dispatch('input');
  h.change(state);
  assert.equal(h.node('refresh-minutes').value, '32');
  for (const invalid of ['', '0', '1441', '1.5', '-1', 'NaN']) {
    h.node('refresh-minutes').value = invalid; h.node('codex-refresh-form').dispatch('submit'); await flush();
    assert.match(h.node('toast').textContent, /整数分钟/);
  }
  assert.equal(h.calls.length, 0);
  h.node('refresh-minutes').value = '32'; h.node('codex-refresh-form').dispatch('submit'); await flush();
  assert.deepEqual(h.calls.at(-1), { name: 'setSettings', payload: { refreshMinutes: 32 } });
});

test('enable saves the interval first and busy state blocks duplicate operations', async () => {
  let release;
  const state = fixture({ snapshot: null, codex: { enabled: false, state: 'disabled' } });
  const h = harness('panel', state, name => name === 'setSettings' ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ ok: true }));
  await flush();
  h.node('refresh-minutes').value = '9'; h.node('refresh-minutes').dispatch('input');
  h.node('enable-codex-button').dispatch('click');
  h.node('enable-codex-button').dispatch('click');
  assert.equal(h.calls.length, 1);
  assert.equal(h.node('usage-source').disabled, true);
  assert.equal(h.node('save-refresh-button').disabled, true);
  release({ ok: true }); await flush();
  assert.deepEqual(h.calls.map(x => x.name), ['setSettings', 'enableCodex']);
  assert.equal(h.node('usage-source').disabled, false);
});

test('action failure never renders raw errors or launches enable after a failed settings save', async () => {
  const h = harness('panel', fixture({ snapshot: null, codex: { enabled: false, state: 'disabled' } }), async () => { throw new Error('SECRET_ACCESS_TOKEN'); });
  await flush();
  h.node('enable-codex-button').dispatch('click'); await flush();
  assert.deepEqual(h.calls.map(x => x.name), ['setSettings']);
  assert.doesNotMatch(h.text(), /SECRET_ACCESS_TOKEN/);
  assert.match(h.node('toast').textContent, /操作未完成/);
  assert.equal(h.node('enable-codex-button').disabled, false);
});

test('browser fallback and version updates remain usable without relabeling old data as CLI data', async () => {
  const state = fixture({ usageSource: 'browser', settings: { usageSource: 'browser', refreshMinutes: 5 }, snapshot: null });
  const h = harness('panel', state); await flush();
  assert.equal(h.node('setup-card').classList.contains('hidden'), false);
  assert.equal(h.node('browser-settings').classList.contains('hidden'), false);
  assert.equal(h.node('codex-controls').classList.contains('hidden'), true);
  h.node('pair-button').dispatch('click'); await flush();
  assert.equal(h.calls.at(-1).name, 'copyPairingCode');
  const nativeWithOldPage = fixture({ snapshot: { source: 'official-page', capturedAt: Date.now(), windows: [{ kind: 'session', usedPercent: 20 }], tokens: {} } });
  h.change(nativeWithOldPage);
  assert.equal(h.node('data-content').classList.contains('hidden'), true);
  h.change({ ...fixture(), updates: { status: 'ready', currentVersion: '2.3.0', availableVersion: '2.3.1', repository: 'example/orb' } });
  assert.equal(h.node('install-update-button').classList.contains('hidden'), false);
  h.node('install-update-button').dispatch('click'); await flush();
  assert.equal(h.calls.at(-1).name, 'installUpdate');
});
