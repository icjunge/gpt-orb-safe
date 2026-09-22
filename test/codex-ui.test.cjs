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
      className: /\bclass="([^"]*)"/.exec(attrs)?.[1] || '', dataset: {}, style: { setProperty(name, value) { this[name] = value; } }, children: [], checked: false, open: /\bopen\b/.test(attrs),
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
  assert.equal(orb.node('orb-unit').textContent, 'Codex 剩余');
  const stopped = { ...state, codex: { ...state.codex, enabled: false, state: 'disabled' } };
  panel.change(stopped); orb.change(stopped);
  assert.equal(panel.node('sync-status').textContent, '已暂停');
  assert.match(panel.node('freshness-note').textContent, /已暂停/);
  assert.match(panel.textTree(), /54%/);
  assert.equal(orb.node('orb-unit').textContent, '上次记录');
  const expired = { ...state, staleAfterMs: 300000 };
  panel.change(expired); orb.change(expired);
  assert.match(panel.node('freshness-note').textContent, /刷新超时/);
  assert.equal(orb.node('orb-unit').textContent, '上次记录');
});

test('zero reset countdown waits for a new read and never refills the percentage', async () => {
  const state = fixture(); state.snapshot.windows[1].resetAt = Date.now() - 3000;
  const panel = harness('panel', state), orb = harness('orb', state); await flush();
  panel.tick(); orb.tick();
  assert.match(panel.textTree(), /等待读取确认/);
  assert.match(panel.textTree(), /54%/);
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
