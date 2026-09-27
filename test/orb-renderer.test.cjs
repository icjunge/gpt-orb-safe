'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../src/ui/orb.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../src/ui/orb.js'), 'utf8');
const now = Date.now();

function fixture(remaining = 64, overrides = {}) {
  return {
    status: 'ready', usageSource: 'codex-cli', settings: { usageSource: 'codex-cli' },
    codex: { enabled: true, state: 'ready', lastSuccessAt: now }, staleAfterMs: 390000,
    snapshot: { source: 'codex-cli', capturedAt: now, windows: [
      { kind: 'cli', label: 'Codex · 每周', usedPercent: 100 - remaining, resetAt: now + 86400000 }
    ] }, ...overrides
  };
}
function harness(state = fixture(), actionImpl) {
  const nodes = new Map(), calls = [], timers = new Map(), docListeners = new Map();
  let onState, timer = 0;
  function node() {
    const listeners = new Map(), attributes = new Map(), classes = new Set();
    return {
      textContent: '', dataset: {}, title: '', captured: null,
      classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } },
      addEventListener(name, listener) { listeners.set(name, [...listeners.get(name) || [], listener]); },
      emit(name, data = {}) { for (const listener of listeners.get(name) || []) listener({ preventDefault() {}, ...data }); },
      setAttribute(name, value) { attributes.set(name, value); },
      getAttribute(name) { return attributes.get(name); },
      matches() { return false; },
      setPointerCapture(id) { this.captured = id; },
      hasPointerCapture(id) { return this.captured === id; },
      releasePointerCapture(id) { if (this.captured === id) { this.captured = null; this.emit('lostpointercapture', { pointerId: id }); } }
    };
  }
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) nodes.set(id, node());
  const document = {
    hidden: false, body: node(), getElementById: id => nodes.get(id),
    addEventListener(name, listener) { docListeners.set(name, listener); }
  };
  const window = { orb: {
    onState(listener) { onState = listener; }, getState: async () => state,
    async action(name, payload) {
      calls.push({ name, payload });
      if (actionImpl) return actionImpl(name, payload);
      if (name === 'orbExpand') return { ok: true, expanded: payload.expanded };
      if (name === 'dragEnd') return { ok: true, moved: false, expanded: false };
      return { ok: true };
    }
  } };
  vm.runInNewContext(source, { window, document, Date, setInterval() {},
    setTimeout(fn) { timers.set(++timer, fn); return timer; }, clearTimeout(id) { timers.delete(id); }
  });
  onState(state);
  return {
    orb: nodes.get('orb'), value: nodes.get('orb-value'), level: nodes.get('orb-liquid-level'), calls,
    change(next) { onState(next); },
    visibility(hidden) { document.hidden = hidden; docListeners.get('visibilitychange')(); },
    flushTimers() { const pending = [...timers.values()]; timers.clear(); for (const fn of pending) fn(); }
  };
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
function height(h) {
  const match = /^translate\(0 (-?\d+\.\d+)\)$/.exec(h.level.getAttribute('transform'));
  assert.ok(match, 'water level is a finite SVG presentation transform');
  return Number(match[1]);
}
// Independently integrate horizontal slices of the vessel to assess visible
// fill. The product uses a segment-area inversion rather than this quadrature.
function filledFraction(level) {
  const radius = 43, center = 50, bottom = center + radius;
  const slices = 2000, step = (bottom - level) / slices;
  let area = 0;
  for (let index = 0; index < slices; index++) {
    const y = level + (index + .5) * step - center;
    area += 2 * Math.sqrt(Math.max(0, radius * radius - y * y)) * step;
  }
  return area / (Math.PI * radius * radius);
}

test('water volume represents the tightest valid remaining quota across the circular vessel', () => {
  const h = harness();
  let previous = Infinity;
  for (const remaining of [.01, 1, 10, 25, 49, 50, 64, 90, 99, 99.99]) {
    h.change(fixture(remaining));
    assert.equal(h.orb.dataset.fill, 'partial');
    assert.equal(h.value.textContent, `${Math.round(remaining)}%`);
    const level = height(h);
    assert.ok(level < previous, 'more remaining quota raises the water');
    assert.ok(Math.abs(filledFraction(level) - remaining / 100) < .0001, `${remaining}% is represented by the circular area`);
    previous = level;
  }
  const current = fixture();
  current.snapshot.windows = [
    { usedPercent: -1 }, { usedPercent: 101 }, { usedPercent: NaN }, { usedPercent: '90' },
    { usedPercent: 15 }, { usedPercent: 76 }, { usedPercent: 42 }
  ];
  h.change(current);
  assert.equal(h.value.textContent, '24%');
  assert.ok(Math.abs(filledFraction(height(h)) - .24) < .0001);
});

test('zero, full, unavailable and source-mismatched quotas never fabricate water', () => {
  const h = harness();
  h.change(fixture(0));
  assert.equal(h.orb.dataset.fill, 'empty');
  assert.equal(h.value.textContent, '0%');
  assert.ok(height(h) > 100);
  h.change(fixture(100));
  assert.equal(h.orb.dataset.fill, 'full');
  assert.equal(h.value.textContent, '100%');
  assert.ok(height(h) < 0, 'a full vessel has no decorative air gap');
  for (const state of [fixture(64, { snapshot: null }), fixture(64, { snapshot: { source: 'official-page', windows: [{ usedPercent: 20 }] } }),
    fixture(64, { snapshot: { source: 'codex-cli', capturedAt: now, windows: [{ usedPercent: Infinity }, { usedPercent: null }] } })]) {
    h.change(state);
    assert.equal(h.orb.dataset.fill, 'unknown');
    assert.equal(h.value.textContent, '—');
    assert.ok(height(h) > 100);
  }
});

test('failed, stopped, manual and old readings retain their actual water level as historical data', () => {
  const h = harness(), liveHeight = height(h);
  assert.equal(h.orb.dataset.stale, 'false');
  const original = fixture();
  const historical = [
    fixture(64, { error: 'unavailable' }),
    fixture(64, { codex: { enabled: false, state: 'disabled' } }),
    fixture(64, { codex: { enabled: true, state: 'needs-login' } }),
    fixture(64, { codex: { enabled: true, state: 'reading', lastSuccessAt: null } }),
    fixture(64, { snapshot: { ...original.snapshot, capturedAt: now - 400000 } }),
    fixture(64, { snapshot: { ...original.snapshot, capturedAt: null } }),
    fixture(64, { usageSource: 'browser', snapshot: { ...original.snapshot, source: 'manual-page' } })
  ];
  for (const state of historical) {
    h.change(state);
    assert.equal(h.orb.dataset.stale, 'true');
    assert.equal(height(h), liveHeight);
    assert.equal(h.value.textContent, '64%');
    assert.match(h.orb.getAttribute('aria-label'), /上次记录|人工记录/);
  }
  h.change(fixture());
  assert.equal(h.orb.dataset.stale, 'false');
});

test('expired reset countdown does not refill a quota before an actual new reading', () => {
  const h = harness(fixture(8));
  const current = fixture(8);
  current.snapshot.windows[0].resetAt = now - 1000;
  h.change(current);
  assert.equal(h.value.textContent, '8%');
  assert.ok(Math.abs(filledFraction(height(h)) - .08) < .0001);
  assert.match(h.orb.getAttribute('aria-label'), /等待读取确认/);
});

test('hiding during a press cancels once even when main already cleared the gesture, then restores interaction', async () => {
  const h = harness(fixture(), async (name, payload) => name === 'orbExpand' ? { ok: true, expanded: payload.expanded } :
    name === 'dragEnd' ? { ok: false } : { ok: true });
  await flush();
  h.orb.emit('pointerenter'); await flush();
  h.orb.emit('pointerdown', { button: 0, pointerId: 4 }); await flush();
  h.visibility(true); await flush(); h.flushTimers(); await flush();
  assert.equal(h.orb.dataset.suspended, 'true');
  assert.equal(h.orb.dataset.expanded, 'false');
  assert.equal(h.orb.captured, null);
  assert.equal(h.calls.filter(call => call.name === 'dragEnd').length, 1);
  assert.equal(h.calls.find(call => call.name === 'dragEnd').payload.cancelled, true);
  assert.equal(h.calls.some(call => call.name === 'togglePanel'), false);
  h.visibility(false);
  h.orb.emit('pointerenter'); await flush();
  assert.equal(h.orb.dataset.suspended, 'false');
  assert.equal(h.orb.dataset.expanded, 'true');
  h.orb.emit('pointerdown', { button: 0, pointerId: 5 }); await flush();
  assert.equal(h.calls.filter(call => call.name === 'dragStart').length, 2, 'a hidden press cannot wedge the next gesture');
  h.orb.emit('pointercancel', { pointerId: 5 }); await flush();
});

test('hide revokes a pending successful click even if its native end reply arrives after restore', async () => {
  let completeEnd;
  const h = harness(fixture(), async (name, payload) => name === 'orbExpand' ? { ok: true, expanded: payload.expanded } :
    name === 'dragEnd' ? new Promise(resolve => { completeEnd = resolve; }) : { ok: true });
  h.orb.emit('pointerenter'); await flush();
  h.orb.emit('pointerdown', { button: 0, pointerId: 4 }); await flush();
  h.orb.emit('pointerup', { pointerId: 4 }); await flush();
  assert.equal(typeof completeEnd, 'function');
  h.visibility(true);
  h.visibility(false);
  completeEnd({ ok: true, moved: false, expanded: true });
  await flush(); h.flushTimers(); await flush();
  assert.equal(h.calls.filter(call => call.name === 'dragEnd').length, 1);
  assert.equal(h.calls.some(call => call.name === 'togglePanel'), false, 'a cancelled pending click cannot resurrect the hidden orb');
  assert.equal(h.orb.dataset.expanded, 'false');
});

test('failed drag end resends a collapse invalidated while its older acknowledgement was pending', async () => {
  let completeOldCollapse, collapseRequests = 0;
  const h = harness(fixture(), async (name, payload) => {
    if (name === 'orbExpand') {
      if (!payload.expanded && ++collapseRequests === 1) return new Promise(resolve => { completeOldCollapse = resolve; });
      return { ok: true, expanded: payload.expanded };
    }
    if (name === 'dragEnd') return { ok: false };
    return { ok: true };
  });
  h.orb.emit('pointerenter'); await flush();
  h.orb.emit('pointerleave'); h.flushTimers(); await flush();
  assert.equal(collapseRequests, 1);
  h.orb.emit('pointerdown', { button: 0, pointerId: 7 }); await flush();
  h.orb.emit('pointercancel', { pointerId: 7 }); await flush();
  completeOldCollapse({ ok: true, expanded: false }); await flush();
  assert.equal(h.orb.dataset.expanded, 'true', 'the old acknowledgement was invalidated by the newer drag completion');
  h.flushTimers(); await flush();
  assert.equal(collapseRequests, 2, 'a rejected drag must clear the requested state so its interrupted collapse can retry');
  assert.equal(h.orb.dataset.expanded, 'false');
});
