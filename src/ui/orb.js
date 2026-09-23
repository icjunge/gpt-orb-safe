'use strict';
(() => {
  const orb = document.getElementById('orb');
  const value = document.getElementById('orb-value');
  let state = { status: 'starting', bridge: {}, snapshot: null, settings: { usageSource: 'codex-cli' } };
  let dragging = null;
  let pointerWithin = false;
  let keyboardFocus = false;
  let collapseTimer = null;
  let requestedExpanded = false;
  let expandRevision = 0;
  orb.dataset.expanded = 'false';
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const nativeMode = () => (state.usageSource || state.settings?.usageSource || (state.codex || state.snapshot?.source === 'codex-cli' ? 'codex-cli' : 'browser')) === 'codex-cli';
  const snapshot = () => state.snapshot && ((state.snapshot.source === 'codex-cli') === nativeMode()) ? state.snapshot : null;
  function windows() {
    return (snapshot()?.windows || []).filter(window => finite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100)
      .map(window => ({ ...window, remaining: 100 - window.usedPercent })).sort((a, b) => a.remaining - b.remaining);
  }
  function countdown(seconds) {
    if (seconds <= 0) return nativeMode() ? '等待读取确认' : '等待页面确认';
    if (seconds >= 86400) return `${Math.floor(seconds / 86400)}天 ${Math.floor(seconds % 86400 / 3600)}时`;
    if (seconds >= 3600) return `${Math.floor(seconds / 3600)}时 ${Math.floor(seconds % 3600 / 60)}分`;
    if (seconds >= 60) return `${Math.ceil(seconds / 60)}分`;
    return '不足1分';
  }
  function render() {
    for (const [name, key] of [['reduced-transparency', 'reducedTransparency'], ['high-contrast', 'highContrast']]) {
      document.body.classList.toggle(name, state.appearance?.[key] === true);
    }
    const tightest = windows()[0];
    const native = nativeMode();
    const current = snapshot();
    const threshold = finite(state.staleAfterMs) && state.staleAfterMs > 0 ? state.staleAfterMs : 180000;
    const stale = !!current && Date.now() - current.capturedAt > threshold;
    const manual = current?.source === 'manual-page';
    const failed = !!state.error || (native && ['error', 'not-found', 'needs-login', 'unsupported'].includes(state.codex?.state));
    const stopped = native && !state.codex?.enabled;
    const unconfirmed = native && state.codex?.state === 'reading' && !finite(state.codex?.lastSuccessAt);
    let description;
    orb.dataset.status = state.status || 'starting';
    orb.dataset.stale = String(stale || failed || manual || stopped || unconfirmed);
    if (tightest) {
      const remaining = tightest.remaining;
      value.textContent = `${Math.round(remaining)}%`;
      const sourceLabel = manual ? '人工记录' : stale || failed || stopped || unconfirmed ? '上次记录' : native ? 'Codex 剩余' : '页面剩余';
      orb.dataset.tone = remaining <= 10 ? 'danger' : remaining <= 25 ? 'warning' : 'normal';
      const delta = finite(tightest.resetAt) ? (tightest.resetAt - Date.now()) / 1000 : null;
      const resetLabel = delta === null ? '重置时间未知' : delta <= 0 ? native ? '等待读取确认' : '等待页面确认' : `${tightest.resetApproximate ? '约' : ''}${countdown(delta)}重置`;
      const names = { session: '当前时段', weekly: '每周额度', other: '其他额度' };
      const fullLabel = native && typeof tightest.label === 'string' && tightest.label ? tightest.label : names[tightest.kind] || '额度窗口';
      description = `${fullLabel}：剩余 ${Math.round(remaining)}%（${sourceLabel}）\n${resetLabel}\n点击查看 · 拖动移动`;
    } else {
      value.textContent = '—';
      orb.dataset.tone = 'muted';
      const cliLabels = { disabled: '本机 Codex', reading: '正在读取', ready: '额度未知', 'not-found': '待安装 CLI', 'needs-login': 'CLI 待登录', unsupported: 'CLI 待更新', error: '读取异常' };
      const statusLabel = native ? cliLabels[state.codex?.state || 'disabled'] || '本机 Codex' : failed ? '同步异常' : state.status === 'starting' ? '正在启动' : current ? '额度未知' : '浏览器同步';
      description = `${statusLabel}\n点击查看 · 拖动移动`;
    }
    orb.dataset.wideValue = String(value.textContent.length > 3);
    if (orb.title !== description) {
      orb.title = description;
      orb.setAttribute('aria-label', description.replace(/\n/g, '；'));
    }
  }
  async function action(name, payload) {
    try { return await window.orb?.action(name, payload); } catch { return null; }
  }
  function clearCollapse() {
    if (collapseTimer !== null) clearTimeout(collapseTimer);
    collapseTimer = null;
  }
  function expand(expanded) {
    if (dragging || requestedExpanded === expanded) return;
    requestedExpanded = expanded;
    const revision = ++expandRevision;
    action('orbExpand', { expanded }).then(result => {
      if (revision !== expandRevision) return;
      if (result?.ok !== true) { requestedExpanded = null; return; }
      if (typeof result.expanded === 'boolean') orb.dataset.expanded = String(result.expanded);
    });
  }
  function settleHover() {
    clearCollapse();
    if (dragging) return;
    if (pointerWithin || keyboardFocus) { expand(true); return; }
    collapseTimer = setTimeout(() => {
      collapseTimer = null;
      if (!dragging && !pointerWithin && !keyboardFocus) expand(false);
    }, 160);
  }
  orb.addEventListener('pointerenter', () => { pointerWithin = true; settleHover(); });
  orb.addEventListener('pointerleave', () => { pointerWithin = false; settleHover(); });
  orb.addEventListener('focus', () => {
    keyboardFocus = orb.matches(':focus-visible');
    settleHover();
  });
  orb.addEventListener('blur', () => { keyboardFocus = false; settleHover(); });
  async function finishDrag(pointerId, cancelled) {
    const gesture = dragging;
    if (!gesture || gesture.ending || pointerId !== gesture.pointerId) return;
    gesture.ending = true;
    try { if (orb.hasPointerCapture(pointerId)) orb.releasePointerCapture(pointerId); } catch {}
    // The main process owns both the drag threshold and DIP cursor coordinates.
    // Keep the gesture locked until its reply so a late end cannot click or
    // resize a newer gesture. Releasing capture can synchronously fire lostcapture.
    const result = await action('dragEnd', { cancelled });
    if (dragging !== gesture) return;
    // The release is newer than every hover request made before the press.
    // A delayed hover reply must not repaint an obsolete native hit region.
    ++expandRevision;
    if (result?.ok === true && typeof result.expanded === 'boolean') {
      requestedExpanded = result.expanded;
      orb.dataset.expanded = String(result.expanded);
    }
    dragging = null;
    if (!cancelled && result?.ok === true && result.moved === false) action('togglePanel');
    settleHover();
  }
  orb.addEventListener('pointerdown', event => {
    if (event.button !== 0 || dragging) return;
    // Mouse pressing should not activate the button's default focus behavior.
    // Tab focus and keyboard activation remain available through their handlers.
    event.preventDefault();
    clearCollapse();
    const gesture = dragging = { pointerId: event.pointerId, ending: false };
    try { orb.setPointerCapture(event.pointerId); } catch { dragging = null; settleHover(); return; }
    action('dragStart').then(result => {
      if (dragging === gesture && !gesture.ending && result?.ok !== true) finishDrag(event.pointerId, true);
    });
  });
  orb.addEventListener('pointermove', event => {
    if (!dragging || dragging.ending || event.pointerId !== dragging.pointerId) return;
    // Browser screenX/screenY may change during native resize or DPI changes;
    // they must never decide whether a stationary press becomes a real drag.
    action('dragMove');
  });
  orb.addEventListener('pointerup', event => finishDrag(event.pointerId, false));
  orb.addEventListener('pointercancel', event => finishDrag(event.pointerId, true));
  orb.addEventListener('lostpointercapture', event => finishDrag(event.pointerId, true));
  orb.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      keyboardFocus = true;
      settleHover();
      if (!event.repeat) action('togglePanel');
    }
  });
  let receivedLiveState = false;
  window.orb?.onState(next => { receivedLiveState = true; state = next; render(); });
  window.orb?.getState().then(next => { if (!receivedLiveState) { state = next; render(); } }).catch(() => { if (!receivedLiveState) { state = { status: 'error', error: '状态不可用' }; render(); } });
  render();
  setInterval(render, 1000);
})();
