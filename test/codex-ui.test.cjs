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
function harness(page, initial, actionImpl = async (name, payload) => name === 'dragEnd' ? { ok: true, moved: false } : name === 'orbExpand' ? { ok: true, expanded: payload.expanded } : { ok: true }) {
  const html = fs.readFileSync(path.join(__dirname, '../src/ui', `${page}.html`), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '../src/ui', `${page}.js`), 'utf8');
  const nodes = new Map(), created = [], calls = [], intervals = [], timeouts = new Map();
  let timerSequence = 0, clock = 0;
  function element(id = '', attrs = '') {
    const listeners = new Map();
    const node = {
      id, textContent: '', value: /\bvalue="([^"]*)"/.exec(attrs)?.[1] || '', disabled: /\bdisabled\b/.test(attrs),
      className: /\bclass="([^"]*)"/.exec(attrs)?.[1] || '', dataset: {}, style: { setProperty(name, value) { this[name] = value; } }, children: [], checked: false, open: /\bopen\b/.test(attrs),
      addEventListener(name, fn) { listeners.set(name, [...listeners.get(name) || [], fn]); },
      dispatch(type, extra = {}) { for (const fn of listeners.get(type) || []) fn({ preventDefault() {}, target: this, ...extra }); },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; },
      matching: new Set(), capturedPointer: null,
      matches(selector) { return this.matching.has(selector); },
      setPointerCapture(pointerId) { this.capturedPointer = pointerId; },
      hasPointerCapture(pointerId) { return this.capturedPointer === pointerId; },
      releasePointerCapture(pointerId) {
        if (this.hasPointerCapture(pointerId)) { this.capturedPointer = null; this.dispatch('lostpointercapture', { pointerId }); }
      }
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
    activeElement: null, body: element('body'),
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
  vm.runInNewContext(source, { window, document, Date, Number, setInterval(fn) { intervals.push(fn); },
    setTimeout(fn, delay) { const id = ++timerSequence; timeouts.set(id, { fn, at: clock + delay }); return id; },
    clearTimeout(id) { timeouts.delete(id); }
  }, { filename: `${page}.js` });
  return { node: id => document.getElementById(id), document, calls,
    change(state) { onState(structuredClone(state)); },
    tick() { for (const fn of intervals) fn(); },
    advance(milliseconds) {
      const until = clock + milliseconds;
      for (;;) {
        const next = [...timeouts].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next; clock = timer.at; timeouts.delete(id); timer.fn();
      }
      clock = until;
    },
    textTree(node = nodes.get('limits-list')) { return [node.textContent, ...node.children.map(child => this.textTree(child))].join(' '); },
    text() { return [...nodes.values(), ...created].map(n => n.textContent).join('\n'); }
  };
}
async function flush() { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); }

function managedFixture(overrides = {}) {
  return fixture({ snapshot: null, settings: { usageSource: 'codex-cli', codexConnection: 'managed', refreshMinutes: 5 },
    codex: { enabled: false, state: 'disabled' }, codexSetup: { status: 'idle', mode: 'managed', progress: null, message: '' }, ...overrides });
}

test('managed first use connects only after a click and keeps manual commands out of the main flow', async () => {
  const h = harness('panel', managedFixture()); await flush();
  assert.equal(h.calls.length, 0);
  assert.equal(h.node('configure-button').textContent, '连接 Codex');
  assert.equal(h.node('codex-setup').classList.contains('hidden'), true);
  assert.equal(h.node('codex-advanced').open, false);
  assert.equal(h.node('empty-privacy').classList.contains('hidden'), false);
  assert.equal(h.node('codex-refresh-form').classList.contains('hidden'), true);
  h.node('configure-button').dispatch('click'); await flush();
  assert.deepEqual(h.calls.map(call => call.name), ['connectCodex']);
  assert.equal(h.node('settings-view').classList.contains('hidden'), true);
  assert.equal(h.node('enable-codex-button').classList.contains('hidden'), true);
});

test('pending managed connection blocks duplicate connects and setting mutations while cancellation remains available', async () => {
  let completeConnect;
  const h = harness('panel', managedFixture(), async name => name === 'connectCodex' ? new Promise(resolve => { completeConnect = resolve; }) : { ok: true }); await flush();
  h.node('configure-button').dispatch('click');
  h.node('configure-button').dispatch('click');
  h.node('connect-codex-button').dispatch('click');
  assert.deepEqual(h.calls.map(call => call.name), ['connectCodex']);
  assert.equal(h.node('usage-source').disabled, true);
  assert.equal(h.node('codex-connection').disabled, true);
  assert.equal(h.node('refresh-minutes').disabled, true);
  assert.equal(h.node('empty-cancel-connect-button').disabled, false);
  h.node('usage-source').dispatch('change', { target: { value: 'browser' } });
  h.node('codex-connection').dispatch('change', { target: { value: 'existing' } });
  h.node('enable-codex-button').dispatch('click');
  h.node('codex-refresh-form').dispatch('submit');
  assert.equal(h.calls.length, 1);
  h.node('empty-cancel-connect-button').dispatch('click');
  h.node('cancel-connect-button').dispatch('click'); await flush();
  assert.deepEqual(h.calls.map(call => call.name), ['connectCodex', 'cancelCodexConnect']);
  completeConnect({ ok: true }); await flush();
  h.change(managedFixture());
  assert.equal(h.node('configure-button').disabled, false);
  assert.equal(h.node('usage-source').disabled, false);
  assert.equal(h.node('empty-cancel-connect-button').classList.contains('hidden'), true);
});

test('managed progress, browser login, error retry, and logout use literal safe status text', async () => {
  const start = managedFixture(); const h = harness('panel', start); await flush();
  h.change({ ...start, codexSetup: { status: 'preparing', mode: 'managed', progress: 47.8, message: '正在下载组件' } });
  assert.equal(h.node('empty-component-progress').value, 47.8);
  assert.equal(h.node('component-progress-value').textContent, '48%');
  assert.equal(h.node('empty-setup-progress').classList.contains('hidden'), false);
  assert.equal(h.node('configure-button').disabled, true);
  assert.equal(h.node('sync-status').textContent, '准备组件…');
  h.change({ ...start, codexSetup: { status: 'preparing', mode: 'managed', progress: null } });
  assert.equal(Object.hasOwn(h.node('empty-component-progress'), 'value'), false);
  h.change({ ...start, codexSetup: { status: 'waiting-login', mode: 'managed' } });
  assert.equal(h.node('empty-setup-progress').classList.contains('hidden'), true);
  assert.equal(h.node('configure-button').textContent, '请在浏览器完成登录');
  assert.equal(h.node('sync-status').textContent, '等待登录');
  const hostile = '<img src=x onerror=alert(1)> 连接未完成';
  h.change({ ...start, codexSetup: { status: 'error', mode: 'managed', message: hostile } });
  assert.equal(h.node('empty-description').textContent, hostile);
  assert.equal(h.node('codex-status').textContent, hostile);
  assert.equal(h.node('configure-button').textContent, '重新连接');
  assert.equal(h.node('configure-button').disabled, false);
  h.node('configure-button').dispatch('click'); await flush();
  assert.equal(h.calls.at(-1).name, 'connectCodex');
  const ready = fixture({ settings: start.settings, codexSetup: { status: 'connected', mode: 'managed' } });
  h.change(ready);
  assert.equal(h.node('empty-state').classList.contains('hidden'), true);
  assert.equal(h.node('connect-codex-button').classList.contains('hidden'), true);
  assert.equal(h.node('logout-codex-button').classList.contains('hidden'), false);
  assert.equal(h.node('refresh-codex-button').disabled, false);
  h.node('logout-codex-button').dispatch('click'); await flush();
  assert.equal(h.calls.at(-1).name, 'logoutCodex');
});

test('managed paused login resumes reading, expired login reconnects, and existing account never gets logout', async () => {
  const start = managedFixture({ codexSetup: { status: 'connected', mode: 'managed' } });
  const h = harness('panel', start); await flush();
  assert.equal(h.node('enable-codex-button').classList.contains('hidden'), false);
  assert.equal(h.node('connect-codex-button').classList.contains('hidden'), true);
  h.node('enable-codex-button').dispatch('click'); await flush();
  assert.deepEqual(h.calls.map(call => call.name), ['setSettings', 'enableCodex']);
  h.change({ ...start, codex: { enabled: true, state: 'needs-login' } });
  assert.equal(h.node('configure-button').textContent, '重新连接');
  assert.equal(h.node('enable-codex-button').classList.contains('hidden'), true);
  h.node('configure-button').dispatch('click'); await flush();
  assert.equal(h.calls.at(-1).name, 'connectCodex');
  h.change({ ...start, settings: { ...start.settings, codexConnection: 'existing' }, codexSetup: { status: 'idle', mode: 'existing' } });
  assert.equal(h.node('codex-managed-controls').classList.contains('hidden'), true);
  assert.equal(h.node('codex-setup').classList.contains('hidden'), false);
  const count = h.calls.length;
  h.node('logout-codex-button').dispatch('click'); await flush();
  assert.equal(h.calls.length, count);
  h.node('codex-connection').dispatch('change', { target: { value: 'managed' } }); await flush();
  assert.deepEqual(h.calls.at(-1), { name: 'setSettings', payload: { codexConnection: 'managed' } });
  assert.equal(h.node('configure-button').textContent, '连接 Codex');
});

test('previous managed login stays removable after restart, expiry, or a failed logout', async () => {
  const start = managedFixture({ codexSetup: { status: 'idle', mode: 'managed', hasLogin: true } });
  const h = harness('panel', start, async name => name === 'logoutCodex' ? { ok: false } : { ok: true }); await flush();
  for (const status of ['idle', 'connected', 'error']) {
    h.change({ ...start, codex: { enabled: false, state: 'needs-login' }, codexSetup: { status, mode: 'managed', hasLogin: true } });
    assert.equal(h.node('logout-codex-button').classList.contains('hidden'), false);
    assert.equal(h.node('logout-codex-button').disabled, false);
    const calls = h.calls.length;
    h.node('logout-codex-button').dispatch('click'); await flush();
    assert.equal(h.calls.length, calls + 1);
    assert.equal(h.calls.at(-1).name, 'logoutCodex');
    assert.equal(h.node('logout-codex-button').classList.contains('hidden'), false, 'a failed logout does not pretend to remove login');
    assert.equal(h.node('logout-codex-button').disabled, false);
  }
  h.change({ ...start, codexSetup: { status: 'waiting-login', mode: 'managed', hasLogin: true } });
  assert.equal(h.node('logout-codex-button').classList.contains('hidden'), false);
  assert.equal(h.node('logout-codex-button').disabled, true);
  const calls = h.calls.length;
  h.node('logout-codex-button').dispatch('click'); await flush();
  assert.equal(h.calls.length, calls);
  h.change({ ...start, codexSetup: { status: 'idle', mode: 'managed', hasLogin: false } });
  assert.equal(h.node('logout-codex-button').classList.contains('hidden'), true);
});

test('native mode requires explicit enable and shows installation without browser pairing', async () => {
  const h = harness('panel', fixture({ snapshot: null, codex: { enabled: false, state: 'disabled' } })); await flush();
  assert.equal(h.node('empty-state').classList.contains('hidden'), false);
  assert.equal(h.node('empty-title').textContent, '连接 Codex');
  assert.equal(h.node('settings-view').classList.contains('hidden'), true);
  assert.equal(h.node('codex-controls').classList.contains('hidden'), false);
  assert.equal(h.node('codex-setup').classList.contains('hidden'), false);
  assert.equal(h.node('setup-card').classList.contains('hidden'), true);
  assert.equal(h.node('browser-settings').classList.contains('hidden'), true);
  assert.equal(h.node('refresh-codex-button').disabled, true);
  assert.equal(h.node('quick-refresh-button').disabled, true);
  assert.equal(h.calls.length, 0);
  h.node('configure-button').dispatch('click');
  assert.equal(h.node('settings-view').classList.contains('hidden'), false);
  assert.equal(h.node('overview').classList.contains('hidden'), true);
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
  assert.ok(h.textTree().includes(hostile));
  assert.equal(h.node('today-token-label').textContent, '最近一日');
  assert.equal(h.node('total-token-label').textContent, '累计');
  assert.equal(h.node('today-tokens').textContent, '0');
  assert.match(h.node('today-detail').textContent, /2026-09-19/);
  assert.match(h.node('scope-description').textContent, /并非本机今日/);
  assert.equal(h.node('reset-credits').textContent, '0');
  assert.equal(h.node('reset-credits-row').classList.contains('hidden'), false);
  h.change({ ...state, snapshot: { ...state.snapshot, resetCredits: null, tokens: { today: null, total: null } } });
  assert.equal(h.node('reset-credits-row').classList.contains('hidden'), true);
  assert.equal(h.node('reset-credits').textContent, '');
  assert.equal(h.node('today-tokens').textContent, '—');
});

test('each quota is shown once with one countdown and the precise reset time on hover', async () => {
  const h = harness('panel', fixture()); await flush();
  const rows = h.node('limits-list').children[0].children;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].children[0].textContent, '5 小时');
  assert.equal(rows[1].children[0].textContent, 'Spark · 官方窗口');
  for (const [index, row] of rows.entries()) {
    assert.deepEqual(row.children.map(child => child.className), ['window-name', 'window-value', 'window-track', 'window-reset']);
    assert.equal(row.children[1].textContent, index === 0 ? '70%' : '54%');
    assert.match(row.children[1]['aria-label'], /剩余额度/);
    assert.match(row.children[3].textContent, /后重置$/);
    assert.match(row.children[3].title, /重置时间：/);
  }
  assert.match(h.node('record-time').textContent, /^\d{2}:\d{2}$/);
  assert.match(h.node('record-time').title, /非服务器统计更新时间/);
});

test('additional quota windows and percentage boundaries remain visible in the compact overview', async () => {
  const state = fixture();
  state.snapshot.windows = [
    { id: 'main-primary', kind: 'cli', label: 'Codex · 5 小时', usedPercent: 0, resetAt: Date.now() + 3600000 },
    { id: 'main-secondary', kind: 'cli', label: 'Codex · 每周', usedPercent: 100, resetAt: Date.now() + 86400000 },
    { id: 'spark', kind: 'cli', label: 'Spark · 每周', usedPercent: 20, resetAt: Date.now() + 86400000 },
    { id: 'invalid', kind: 'cli', label: '无效数值', usedPercent: NaN }
  ];
  const h = harness('panel', state); await flush();
  const rows = h.node('limits-list').children[0].children;
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => row.children[0].textContent), ['5 小时', '每周', 'Spark · 每周']);
  assert.deepEqual(rows.map(row => row.children[1].textContent), ['100%', '0%', '80%']);
  assert.equal(rows[1].children[2].children[0].className, 'window-fill danger');
  assert.doesNotMatch(h.textTree(), /无效数值/);
});

test('compact footer retains error states and full timestamp meaning without repeating the read label', async () => {
  const state = fixture();
  const h = harness('panel', state); await flush();
  assert.equal(h.node('sync-status').textContent, '自动刷新');
  assert.match(h.node('record-time').textContent, /^\d{2}:\d{2}$/);
  assert.match(h.node('record-time').title, /^读取时间：/);
  h.change({ ...state, error: '查询未完成', codex: { ...state.codex, state: 'error', message: '查询未完成' } });
  assert.equal(h.node('sync-status').textContent, '读取失败');
  assert.equal(h.node('freshness-note').classList.contains('hidden'), false);
  assert.match(h.node('freshness-note').textContent, /保留上次读数/);
  assert.equal(h.node('data-content').classList.contains('hidden'), false);
  assert.match(h.textTree(), /54%/);
  h.change({ ...state, usageSource: 'browser', settings: { usageSource: 'browser' }, snapshot: { ...state.snapshot, source: 'manual-page' } });
  assert.equal(h.node('sync-status').textContent, '人工记录');
  assert.match(h.node('record-time').textContent, /^\d{2}:\d{2}$/);
  assert.match(h.node('record-time').title, /^人工记录时间：/);
});

test('missing or invalid reset credits stay hidden while zero remains visible', async () => {
  const state = fixture(); const h = harness('panel', state); await flush();
  for (const resetCredits of [undefined, null, -1, 1.5, NaN, Infinity, '0', Number.MAX_SAFE_INTEGER + 1]) {
    h.change({ ...state, snapshot: { ...state.snapshot, resetCredits } });
    assert.equal(h.node('reset-credits-row').classList.contains('hidden'), true);
    assert.equal(h.node('reset-credits').textContent, '');
  }
  h.change({ ...state, snapshot: { ...state.snapshot, resetCredits: 0 } });
  assert.equal(h.node('reset-credits-row').classList.contains('hidden'), false);
  assert.equal(h.node('reset-credits').textContent, '0');
  h.change({ ...state, usageSource: 'browser', settings: { usageSource: 'browser' }, snapshot: { ...state.snapshot, source: 'official-page' } });
  assert.equal(h.node('reset-credits-row').classList.contains('hidden'), true);
});

test('empty state makes recovery available without automatically switching the active view', async () => {
  const state = fixture({ snapshot: null, codex: { enabled: true, state: 'not-found' } });
  const h = harness('panel', state); await flush();
  assert.equal(h.node('empty-title').textContent, '未找到 Codex');
  assert.equal(h.node('settings-view').classList.contains('hidden'), true);
  h.node('configure-button').dispatch('click');
  h.change(fixture());
  assert.equal(h.node('empty-state').classList.contains('hidden'), true);
  assert.equal(h.node('settings-view').classList.contains('hidden'), false);
  assert.equal(h.node('overview').classList.contains('hidden'), true);
  h.node('back-button').dispatch('click');
  h.change(state);
  assert.equal(h.node('empty-state').classList.contains('hidden'), false);
  assert.equal(h.node('settings-view').classList.contains('hidden'), true);
  assert.equal(h.node('overview').classList.contains('hidden'), false);
});

test('quick refresh calls the native provider once and is unavailable when stopped or in browser mode', async () => {
  let release;
  const state = fixture();
  const h = harness('panel', state, () => new Promise(resolve => { release = resolve; })); await flush();
  h.node('quick-refresh-button').dispatch('click');
  h.node('quick-refresh-button').dispatch('click');
  h.node('refresh-codex-button').dispatch('click');
  assert.deepEqual(h.calls.map(call => call.name), ['refreshCodex']);
  assert.equal(h.node('quick-refresh-button').disabled, true);
  assert.equal(h.node('quick-refresh-button')['aria-busy'], 'true');
  assert.equal(h.node('refresh-codex-button').disabled, true);
  release({ ok: true }); await flush();
  assert.equal(h.node('quick-refresh-button').disabled, false);
  h.change({ ...state, codex: { ...state.codex, enabled: false, state: 'disabled' } });
  h.node('quick-refresh-button').dispatch('click');
  assert.equal(h.node('quick-refresh-button').disabled, true);
  assert.equal(h.calls.length, 1);
  h.change({ ...state, usageSource: 'browser', settings: { usageSource: 'browser' }, snapshot: null });
  assert.equal(h.node('quick-refresh-button').classList.contains('hidden'), true);
  h.node('quick-refresh-button').dispatch('click');
  assert.equal(h.calls.length, 1);
});

test('unavailable or invalid Token values hide the module without showing an empty placeholder', async () => {
  const state = fixture();
  const h = harness('panel', state); await flush();
  for (const tokens of [undefined, {}, { today: null, total: null }, { today: -1, total: '123' },
    { today: NaN, total: Infinity }, { today: 1.5, total: Number.MAX_SAFE_INTEGER + 1 }]) {
    h.change({ ...state, snapshot: { ...state.snapshot, tokens } });
    assert.equal(h.node('token-section').classList.contains('hidden'), true);
    assert.equal(h.node('token-section').open, false);
    assert.equal(h.node('token-availability').textContent, '未提供');
    assert.equal(h.node('token-metrics').classList.contains('hidden'), true);
    assert.equal(h.node('today-token-metric').classList.contains('hidden'), true);
    assert.equal(h.node('total-token-metric').classList.contains('hidden'), true);
    assert.match(h.node('tokens-scope').textContent, /暂未提供 Token 统计/);
  }
});

test('zero Token totals remain valid and partial Token data hides only the unavailable metric', async () => {
  const state = fixture();
  const h = harness('panel', { ...state, snapshot: { ...state.snapshot, tokens: { today: 0, total: 0 } } }); await flush();
  assert.equal(h.node('token-section').classList.contains('hidden'), false);
  assert.equal(h.node('token-section').open, true);
  assert.equal(h.node('token-availability').textContent, '账号统计');
  assert.equal(h.node('today-tokens').textContent, '0');
  assert.equal(h.node('total-tokens').textContent, '0');
  for (const key of ['today', 'total']) assert.equal(h.node(`${key}-token-metric`).classList.contains('hidden'), false);
  for (const key of ['today', 'total']) {
    h.change({ ...state, snapshot: { ...state.snapshot, tokens: { [key]: 0 } } });
    assert.equal(h.node('token-section').open, true);
    assert.equal(h.node('token-metrics').classList.contains('hidden'), false);
    assert.equal(h.node('token-availability').textContent, '部分数据');
    assert.equal(h.node(`${key}-token-metric`).classList.contains('hidden'), false);
    assert.equal(h.node(`${key === 'today' ? 'total' : 'today'}-token-metric`).classList.contains('hidden'), true);
  }
});

test('Token disclosure follows availability transitions while preserving manual choices on refresh', async () => {
  const state = fixture(); const h = harness('panel', state); await flush();
  assert.equal(h.node('token-section').open, true);
  h.node('token-section').open = false;
  h.change(state);
  h.tick();
  assert.equal(h.node('token-section').open, false, 'a manual collapse survives repeated refreshes');
  h.change({ ...state, snapshot: { ...state.snapshot, tokens: { today: 5 } } });
  assert.equal(h.node('token-section').open, false, 'partial values do not undo a manual collapse');
  const missing = { ...state, snapshot: { ...state.snapshot, tokens: null } };
  h.change(missing);
  assert.equal(h.node('token-section').open, false);
  assert.equal(h.node('token-section').classList.contains('hidden'), true);
  h.change(missing);
  assert.equal(h.node('token-section').classList.contains('hidden'), true, 'an unavailable module stays out of the overview');
  h.change(state);
  assert.equal(h.node('token-section').classList.contains('hidden'), false);
  assert.equal(h.node('token-section').open, true, 'newly available data expands automatically');
  h.change(missing);
  assert.equal(h.node('token-section').open, false, 'loss of data collapses an open module');
  h.change(state);
  h.node('token-section').open = false;
  h.change({ ...state, usageSource: 'browser', settings: { usageSource: 'browser' }, snapshot: { ...state.snapshot, source: 'official-page' } });
  assert.equal(h.node('token-section').open, true, 'switching sources restores the availability default');
  assert.equal(h.node('token-availability').textContent, '页面统计');
});

test('native appearance flags update body classes and legacy state keeps the fallback', async () => {
  const state = fixture();
  for (const page of ['panel', 'orb']) {
    const h = harness(page, state); await flush();
    for (const name of ['native-backdrop', 'reduced-transparency', 'high-contrast']) assert.equal(h.document.body.classList.contains(name), false);
    h.change({ ...state, appearance: { nativeBackdrop: true, reducedTransparency: true, highContrast: true } });
    assert.equal(h.document.body.classList.contains('native-backdrop'), page === 'panel');
    for (const name of ['reduced-transparency', 'high-contrast']) assert.equal(h.document.body.classList.contains(name), true);
    h.change({ ...state, appearance: { nativeBackdrop: 'yes', reducedTransparency: false, highContrast: false } });
    for (const name of ['native-backdrop', 'reduced-transparency', 'high-contrast']) assert.equal(h.document.body.classList.contains(name), false);
  }
});

test('material status distinguishes a compositor request from verified effect and accessible fallbacks', async () => {
  const state = fixture(); const h = harness('panel', state); await flush();
  assert.match(h.node('material-status').textContent, /未启用/);
  assert.equal(h.node('glass-tint').disabled, true);
  h.change({ ...state, appearance: { nativeBackdrop: true, backdropStatus: 'requested' } });
  assert.match(h.node('material-status').textContent, /已请求系统毛玻璃/);
  assert.match(h.node('material-status').textContent, /实际效果由 Windows/);
  assert.equal(h.node('glass-tint').disabled, false);
  for (const [backdropStatus, expected] of [['unsupported', /不支持/], ['reduced-transparency', /已关闭透明效果/], ['unavailable', /未启用/]]) {
    h.change({ ...state, appearance: { nativeBackdrop: false, backdropStatus } });
    assert.match(h.node('material-status').textContent, expected);
    assert.equal(h.node('glass-tint').disabled, true);
  }
  h.change({ ...state, appearance: { nativeBackdrop: true, backdropStatus: 'requested', highContrast: true } });
  assert.match(h.node('material-status').textContent, /高对比度已开启/);
  assert.equal(h.node('glass-tint').disabled, true);
  h.node('glass-tint').value = '30'; h.node('glass-tint').dispatch('input'); h.node('glass-tint').dispatch('change'); await flush();
  assert.equal(h.calls.length, 0);
});

test('glass tint previews locally, saves only on change, and retains an in-progress drag across broadcasts', async () => {
  const state = fixture({ appearance: { nativeBackdrop: true, backdropStatus: 'requested' } }); const h = harness('panel', state); await flush();
  assert.equal(h.node('glass-tint').value, '16');
  assert.equal(h.document.body.style['--glass-tint'], '16%');
  h.node('glass-tint').value = '34'; h.node('glass-tint').dispatch('input');
  assert.equal(h.node('glass-tint-value').textContent, '34%');
  assert.equal(h.document.body.style['--glass-tint'], '34%');
  assert.equal(h.calls.length, 0);
  h.change({ ...state, settings: { ...state.settings, glassTint: 22 } });
  assert.equal(h.node('glass-tint').value, '34');
  assert.equal(h.document.body.style['--glass-tint'], '34%');
  h.node('glass-tint').dispatch('change'); await flush();
  assert.deepEqual(h.calls, [{ name: 'setSettings', payload: { glassTint: 34 } }]);
  for (const glassTint of [0, 70]) {
    h.change({ ...state, settings: { ...state.settings, glassTint } });
    assert.equal(h.node('glass-tint').value, String(glassTint));
    assert.equal(h.document.body.style['--glass-tint'], `${glassTint}%`);
  }
  for (const glassTint of [-1, 71, 1.5, '20', NaN]) {
    h.change({ ...state, settings: { ...state.settings, glassTint } });
    assert.equal(h.document.body.style['--glass-tint'], '16%');
  }
});

test('an earlier tint save cannot overwrite a newer drag and failed saves restore the confirmed setting', async () => {
  const pending = [];
  const state = fixture({ appearance: { nativeBackdrop: true, backdropStatus: 'requested' } });
  const h = harness('panel', state, () => new Promise(resolve => pending.push(resolve))); await flush();
  h.node('glass-tint').value = '34'; h.node('glass-tint').dispatch('input'); h.node('glass-tint').dispatch('change');
  h.node('glass-tint').value = '48'; h.node('glass-tint').dispatch('input');
  h.change({ ...state, settings: { ...state.settings, glassTint: 34 } });
  pending.shift()({ ok: true }); await flush();
  assert.equal(h.node('glass-tint').value, '48');
  assert.equal(h.document.body.style['--glass-tint'], '48%');
  h.node('glass-tint').dispatch('change');
  pending.shift()({ ok: false, error: 'Do not render raw failures' }); await flush();
  assert.equal(h.node('glass-tint').value, '34');
  assert.equal(h.document.body.style['--glass-tint'], '34%');
  assert.doesNotMatch(h.text(), /Do not render raw failures/);
});

test('native freshness follows configured interval and stop preserves a historical reading', async () => {
  const state = fixture(); state.snapshot.capturedAt = Date.now() - 600000;
  const panel = harness('panel', state), orb = harness('orb', state); await flush();
  assert.equal(panel.node('sync-status').textContent, '自动刷新');
  assert.match(orb.node('orb').title, /Codex 剩余/);
  const stopped = { ...state, codex: { ...state.codex, enabled: false, state: 'disabled' } };
  panel.change(stopped); orb.change(stopped);
  assert.equal(panel.node('sync-status').textContent, '已暂停');
  assert.match(panel.node('freshness-note').textContent, /已暂停/);
  assert.match(panel.textTree(), /54%/);
  assert.match(orb.node('orb').title, /上次记录/);
  const expired = { ...state, staleAfterMs: 300000 };
  panel.change(expired); orb.change(expired);
  assert.match(panel.node('freshness-note').textContent, /刷新超时/);
  assert.match(orb.node('orb').title, /上次记录/);
});

test('zero reset countdown waits for a new read and never refills the percentage', async () => {
  const state = fixture(); state.snapshot.windows[1].resetAt = Date.now() - 3000;
  const panel = harness('panel', state), orb = harness('orb', state); await flush();
  panel.tick(); orb.tick();
  assert.match(panel.textTree(), /等待读取确认/);
  assert.match(panel.textTree(), /54%/);
  assert.match(orb.node('orb').title, /等待读取确认/);
  assert.equal(orb.node('orb-value').textContent, '54%');
  assert.equal(panel.calls.length + orb.calls.length, 0);
});

test('orb hover expands once and delayed collapse is cancelled by re-entry or keyboard focus', async () => {
  const h = harness('orb', fixture()); await flush();
  const orb = h.node('orb');
  orb.dispatch('pointerenter'); orb.dispatch('pointerenter');
  assert.deepEqual(h.calls, [{ name: 'orbExpand', payload: { expanded: true } }]);
  orb.dispatch('pointerleave'); h.advance(159);
  assert.equal(h.calls.length, 1);
  orb.dispatch('pointerenter'); h.advance(1000);
  assert.equal(h.calls.length, 1);
  orb.matching.add(':focus-visible'); orb.dispatch('focus');
  orb.dispatch('pointerleave'); h.advance(1000);
  assert.equal(h.calls.length, 1);
  orb.dispatch('blur'); h.advance(159);
  assert.equal(h.calls.length, 1);
  h.advance(1);
  assert.deepEqual(h.calls.at(-1), { name: 'orbExpand', payload: { expanded: false } });
  orb.matching.delete(':focus-visible'); orb.dispatch('focus'); h.advance(200);
  assert.equal(h.calls.length, 2, 'mouse focus must not keep the orb enlarged');
});

test('orb draws only the latest acknowledged size in its fixed host', async () => {
  const replies = [];
  const h = harness('orb', fixture(), (name, payload) => name === 'orbExpand'
    ? new Promise(resolve => replies.push({ expanded: payload.expanded, resolve })) : Promise.resolve({ ok: true }));
  await flush(); const orb = h.node('orb');
  assert.equal(orb.dataset.expanded, 'false');
  orb.dispatch('pointerenter');
  assert.equal(orb.dataset.expanded, 'false', 'drawing waits for the native hit-region acknowledgement');
  orb.dispatch('pointerleave'); h.advance(160);
  assert.deepEqual(replies.map(reply => reply.expanded), [true, false]);
  replies[1].resolve({ ok: true, expanded: false }); await flush();
  replies[0].resolve({ ok: true, expanded: true }); await flush();
  assert.equal(orb.dataset.expanded, 'false', 'an older expansion cannot repaint a newer compact region');
  orb.dispatch('pointerenter'); replies[2].resolve({ ok: true, expanded: true }); await flush();
  assert.equal(orb.dataset.expanded, 'true');
});

test('a queued hover keeps its acknowledged region until release commits the final size', async () => {
  let hoverReply;
  const h = harness('orb', fixture(), name => name === 'orbExpand' ? new Promise(resolve => { hoverReply = resolve; })
    : Promise.resolve(name === 'dragEnd' ? { ok: true, moved: false, expanded: true } : { ok: true }));
  await flush(); const orb = h.node('orb'), pointer = { pointerId: 8, button: 0 };
  orb.dispatch('pointerenter'); orb.dispatch('pointerdown', pointer);
  hoverReply({ ok: true, expanded: false, queued: true }); await flush();
  assert.equal(orb.dataset.expanded, 'false', 'queued hover does not paint outside the frozen compact hit region');
  h.advance(10000); assert.equal(orb.dataset.expanded, 'false');
  orb.dispatch('pointerup', pointer); await flush();
  assert.equal(orb.dataset.expanded, 'true', 'release paints the final native region without resizing its host');
  assert.equal(h.calls.filter(call => call.name === 'togglePanel').length, 1);
});

test('late hover acknowledgements cannot change the size after a stationary press has ended', async () => {
  let hoverReply;
  const h = harness('orb', fixture(), name => name === 'orbExpand' ? new Promise(resolve => { hoverReply = resolve; })
    : Promise.resolve(name === 'dragEnd' ? { ok: true, moved: false, expanded: false } : { ok: true }));
  await flush(); const orb = h.node('orb'), pointer = { pointerId: 9, button: 0 };
  orb.dispatch('pointerenter'); orb.dispatch('pointerdown', pointer); orb.dispatch('pointerleave');
  h.advance(10000); orb.dispatch('pointerup', pointer); await flush();
  assert.equal(orb.dataset.expanded, 'false');
  hoverReply({ ok: true, expanded: true }); await flush(); h.advance(500);
  assert.equal(orb.dataset.expanded, 'false', 'release invalidates pre-press hover replies');
  assert.equal(h.calls.filter(call => call.name === 'dragEnd').length, 1);
});

test('mouse pressing prevents default focus while keyboard navigation still expands', async () => {
  const h = harness('orb', fixture()); await flush(); const orb = h.node('orb');
  let prevented = 0;
  orb.dispatch('pointerdown', { pointerId: 10, button: 0, preventDefault() { prevented++; } });
  assert.equal(prevented, 1);
  orb.dispatch('pointerup', { pointerId: 10 }); await flush();
  orb.matching.add(':focus-visible'); orb.dispatch('focus'); await flush();
  assert.equal(orb.dataset.expanded, 'true', 'keyboard focus retains its expansion path');
});

test('dragging freezes orb size and trusts the native end result rather than browser screen coordinates', async () => {
  const h = harness('orb', fixture(), async name => name === 'dragEnd' ? { ok: true, moved: true } : { ok: true }); await flush();
  const orb = h.node('orb'), pointer = { pointerId: 7, button: 0, screenX: 100, screenY: 100 };
  orb.dispatch('pointerenter');
  orb.dispatch('pointerdown', pointer);
  orb.dispatch('pointerleave'); h.advance(1000);
  assert.deepEqual(h.calls.map(call => call.name), ['orbExpand', 'dragStart']);
  orb.dispatch('pointermove', { ...pointer, pointerId: 8, screenX: 200 });
  orb.dispatch('pointerup', { ...pointer, pointerId: 8 });
  assert.equal(h.calls.length, 2, 'unrelated pointers cannot finish the drag');
  orb.dispatch('pointermove', { ...pointer, screenX: 103 });
  orb.dispatch('pointermove', { ...pointer, screenX: 111 });
  orb.dispatch('pointerup', { ...pointer, screenX: 100 }); await flush();
  assert.deepEqual(h.calls.map(call => call.name), ['orbExpand', 'dragStart', 'dragMove', 'dragMove', 'dragEnd']);
  assert.equal(orb.capturedPointer, null);
  assert.ok(h.calls.filter(call => call.name === 'dragMove').every(call => call.payload === undefined), 'only main reads real cursor coordinates');
  assert.deepEqual(h.calls.at(-1).payload, { cancelled: false });
  h.advance(160);
  assert.deepEqual(h.calls.at(-1), { name: 'orbExpand', payload: { expanded: false } });
});

test('stationary long press tolerates resize-generated screen coordinates and small native jitter', async () => {
  let finish;
  const h = harness('orb', fixture(), name => name === 'dragEnd' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true })); await flush();
  const orb = h.node('orb'), pointer = { pointerId: 7, button: 0, screenX: 100, screenY: 100 };
  orb.dispatch('pointerenter'); orb.dispatch('pointerdown', pointer);
  h.advance(60000);
  orb.dispatch('pointermove', { ...pointer, screenX: 4000, screenY: -2500 });
  orb.dispatch('pointerleave'); orb.dispatch('pointerenter'); h.advance(1000);
  orb.dispatch('pointerup', { ...pointer, screenX: -900, screenY: 800 });
  assert.equal(h.calls.filter(call => call.name === 'togglePanel').length, 0, 'click waits for authoritative native result');
  orb.dispatch('lostpointercapture', pointer); orb.dispatch('pointerup', pointer);
  orb.dispatch('pointerdown', { ...pointer, pointerId: 8 });
  assert.equal(h.calls.filter(call => call.name === 'dragStart').length, 1, 'pending end reply cannot race a new gesture');
  assert.equal(h.calls.filter(call => call.name === 'dragEnd').length, 1);
  assert.equal(h.calls.filter(call => call.name === 'orbExpand').length, 1, 'hover resize stays frozen during press');
  finish({ ok: true, moved: false }); await flush();
  assert.equal(h.calls.filter(call => call.name === 'togglePanel').length, 1, 'browser screen coordinates cannot invent a drag');
});

test('cancelled or lost pointer capture cannot turn into a click and each drag ends once', async () => {
  for (const eventName of ['pointercancel', 'lostpointercapture']) {
    let moved = false;
    const h = harness('orb', fixture(), async name => name === 'dragEnd' ? { ok: true, moved } : { ok: true }); await flush();
    const orb = h.node('orb'), pointer = { pointerId: 1, button: 0, screenX: 5, screenY: 5 };
    orb.dispatch('pointerdown', pointer);
    orb.dispatch(eventName, pointer);
    orb.dispatch('pointerup', pointer);
    orb.dispatch(eventName, pointer); await flush();
    assert.deepEqual(h.calls.map(call => call.name), ['dragStart', 'dragEnd'], eventName);
    assert.deepEqual(h.calls.at(-1).payload, { cancelled: true });
    moved = true;
    orb.dispatch('pointerdown', pointer);
    orb.dispatch('pointerup', pointer); await flush();
    assert.equal(h.calls.some(call => call.name === 'togglePanel'), false, 'native moved release cannot click even without browser pointermove');
    moved = false;
    orb.dispatch('pointerdown', pointer);
    orb.dispatch('pointerup', { ...pointer, screenX: 1200 }); await flush();
    assert.equal(h.calls.filter(call => call.name === 'togglePanel').length, 1, 'a subsequent normal native click still works');
  }
});

test('failed drag replies never toggle and release the gesture for the next press', async () => {
  let working = false;
  const h = harness('orb', fixture(), async name => name === 'dragEnd' ? working ? { ok: true, moved: false } : { ok: false } : { ok: true }); await flush();
  const orb = h.node('orb'), pointer = { pointerId: 1, button: 0 };
  orb.dispatch('pointerdown', pointer); orb.dispatch('pointerup', pointer); await flush();
  assert.equal(h.calls.some(call => call.name === 'togglePanel'), false);
  working = true;
  orb.dispatch('pointerdown', pointer); orb.dispatch('pointerup', pointer); await flush();
  assert.equal(h.calls.filter(call => call.name === 'togglePanel').length, 1);
});

test('rejected drag start releases capture without opening the panel or freezing later hover', async () => {
  const h = harness('orb', fixture(), async () => ({ ok: false })); await flush();
  const orb = h.node('orb'), pointer = { pointerId: 1, button: 0 };
  orb.dispatch('pointerdown', pointer); await flush();
  assert.equal(orb.capturedPointer, null);
  assert.deepEqual(h.calls.map(call => call.name), ['dragStart', 'dragEnd']);
  assert.deepEqual(h.calls.at(-1).payload, { cancelled: true });
  orb.dispatch('pointerup', pointer); orb.dispatch('pointerenter'); await flush();
  assert.deepEqual(h.calls.map(call => call.name), ['dragStart', 'dragEnd', 'orbExpand']);
});

test('orb keyboard activation expands without repeated keydown toggles', async () => {
  const h = harness('orb', fixture()); await flush();
  const orb = h.node('orb');
  orb.dispatch('keydown', { key: 'Enter', repeat: false });
  orb.dispatch('keydown', { key: 'Enter', repeat: true });
  orb.dispatch('pointerleave'); h.advance(500);
  assert.deepEqual(h.calls.map(call => call.name), ['orbExpand', 'togglePanel']);
  orb.dispatch('blur'); h.advance(160);
  assert.deepEqual(h.calls.at(-1), { name: 'orbExpand', payload: { expanded: false } });
});

test('orb fits the rounded 100 percent reading without shrinking ordinary values', async () => {
  const state = fixture(), h = harness('orb', state); await flush();
  for (const [usedPercent, expected, wide] of [[0, '100%', 'true'], [0.4, '100%', 'true'], [1, '99%', 'false'], [100, '0%', 'false']]) {
    h.change({ ...state, snapshot: { ...state.snapshot, windows: [{ usedPercent, kind: 'cli', label: 'Codex' }] } });
    assert.equal(h.node('orb-value').textContent, expected);
    assert.equal(h.node('orb').dataset.wideValue, wide);
  }
  h.change({ ...state, snapshot: null });
  assert.equal(h.node('orb-value').textContent, '—');
  assert.equal(h.node('orb').dataset.wideValue, 'false');
});

test('orb keeps only the percentage visible and exposes quota details through hover and accessibility', async () => {
  const h = harness('orb', fixture()); await flush();
  assert.equal(h.text().trim(), '54%');
  assert.match(h.node('orb').title, /Spark · 官方窗口：剩余 54%（Codex 剩余）\n.*重置\n点击查看 · 拖动移动/);
  assert.equal(h.node('orb')['aria-label'], h.node('orb').title.replace(/\n/g, '；'));
  h.node('orb').dispatch('pointerenter');
  assert.equal(h.text().trim(), '54%', 'hover never inserts labels or a countdown into the circle');
});

test('orb ignores native material and panel tint hints while unknown or stale quota stays accessible', async () => {
  const state = fixture({ appearance: { nativeBackdrop: true, orbNativeBackdrop: false } });
  const h = harness('orb', state); await flush();
  assert.equal(h.document.body.classList.contains('native-backdrop'), false, 'panel acrylic is not orb acrylic');
  h.change({ ...state, appearance: { orbNativeBackdrop: true }, settings: { ...state.settings, glassTint: 0 } });
  assert.equal(h.document.body.classList.contains('native-backdrop'), false);
  assert.equal(h.document.body.style['--glass-tint'], undefined);
  h.change({ ...state, error: 'failed', appearance: { highContrast: true, reducedTransparency: true } });
  assert.equal(h.node('orb-value').textContent, '54%');
  assert.match(h.node('orb')['aria-label'], /Spark.*剩余 54%.*上次记录/);
  assert.equal(h.document.body.classList.contains('high-contrast'), true);
  assert.equal(h.document.body.classList.contains('reduced-transparency'), true);
  h.change({ ...state, snapshot: null });
  assert.equal(h.node('orb-value').textContent, '—');
  assert.match(h.node('orb')['aria-label'], /额度未知/);
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
