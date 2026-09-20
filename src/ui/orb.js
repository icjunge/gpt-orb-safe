'use strict';
(() => {
  const orb = document.getElementById('orb');
  const value = document.getElementById('orb-value');
  const unit = document.getElementById('orb-unit');
  const reset = document.getElementById('reset');
  const progress = document.getElementById('progress');
  let state = { status: 'starting', bridge: {}, snapshot: null, settings: { usageSource: 'codex-cli' } };
  let dragging = null;
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
    if (seconds >= 60) return `${Math.floor(seconds / 60)}分 ${Math.floor(seconds % 60)}秒`;
    return `${Math.ceil(seconds)}秒`;
  }
  function render() {
    const tightest = windows()[0];
    const native = nativeMode();
    const current = snapshot();
    const threshold = finite(state.staleAfterMs) && state.staleAfterMs > 0 ? state.staleAfterMs : 180000;
    const stale = !!current && Date.now() - current.capturedAt > threshold;
    const manual = current?.source === 'manual-page';
    const failed = !!state.error || (native && ['error', 'not-found', 'needs-login', 'unsupported'].includes(state.codex?.state));
    const stopped = native && !state.codex?.enabled;
    const unconfirmed = native && state.codex?.state === 'reading' && !finite(state.codex?.lastSuccessAt);
    orb.dataset.status = state.status || 'starting';
    orb.dataset.stale = String(stale || failed || manual || stopped || unconfirmed);
    if (tightest) {
      const remaining = tightest.remaining;
      value.textContent = `${Math.round(remaining)}%`;
      unit.textContent = manual ? '人工记录' : stale || failed || stopped || unconfirmed ? '上次记录' : native ? 'Codex 剩余' : '页面剩余';
      progress.style.strokeDashoffset = String(232.478 * (1 - remaining / 100));
      orb.dataset.tone = remaining <= 10 ? 'danger' : remaining <= 25 ? 'warning' : 'normal';
      const delta = finite(tightest.resetAt) ? (tightest.resetAt - Date.now()) / 1000 : null;
      reset.textContent = delta === null ? '重置时间未知' : delta <= 0 ? native ? '等待读取确认' : '等待页面确认' : `${tightest.resetApproximate ? '约' : ''}${countdown(delta)}重置`;
      const names = { session: '当前时段', weekly: '每周额度', other: '其他额度' };
      orb.title = `${native && typeof tightest.label === 'string' && tightest.label ? tightest.label : names[tightest.kind] || '额度窗口'}：剩余 ${Math.round(remaining)}%（${unit.textContent}）\n${reset.textContent}\n点击查看 · 拖动移动`;
    } else {
      value.textContent = '—';
      progress.style.strokeDashoffset = '232.478';
      orb.dataset.tone = 'muted';
      const cliLabels = { disabled: '本机 Codex', reading: '正在读取', ready: '额度未知', 'not-found': '待安装 CLI', 'needs-login': 'CLI 待登录', unsupported: 'CLI 待更新', error: '读取异常' };
      unit.textContent = native ? cliLabels[state.codex?.state || 'disabled'] || '本机 Codex' : failed ? '同步异常' : state.status === 'starting' ? '正在启动' : current ? '额度未知' : '浏览器同步';
      reset.textContent = current ? '点击查看详情' : native ? '点击查看设置' : state.status === 'starting' ? '正在启动' : '点击开始配对';
      orb.title = `${unit.textContent} · 点击打开 GPT 用量面板`;
    }
  }
  async function action(name, payload) {
    try { return await window.orb?.action(name, payload); } catch { return null; }
  }
  orb.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    dragging = { pointerId: event.pointerId, x: event.screenX, y: event.screenY, moved: false };
    orb.setPointerCapture(event.pointerId);
    action('dragStart', { screenX: event.screenX, screenY: event.screenY });
  });
  orb.addEventListener('pointermove', event => {
    if (!dragging || event.pointerId !== dragging.pointerId) return;
    if (Math.hypot(event.screenX - dragging.x, event.screenY - dragging.y) > 4) dragging.moved = true;
    if (dragging.moved) action('dragMove', { screenX: event.screenX, screenY: event.screenY });
  });
  orb.addEventListener('pointerup', event => {
    if (!dragging || event.pointerId !== dragging.pointerId) return;
    const moved = dragging.moved;
    dragging = null;
    action('dragEnd');
    if (!moved) action('togglePanel');
  });
  orb.addEventListener('pointercancel', () => { dragging = null; action('dragEnd'); });
  orb.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); action('togglePanel'); }
  });
  let receivedLiveState = false;
  window.orb?.onState(next => { receivedLiveState = true; state = next; render(); });
  window.orb?.getState().then(next => { if (!receivedLiveState) { state = next; render(); } }).catch(() => { if (!receivedLiveState) { state = { status: 'error', error: '状态不可用' }; render(); } });
  render();
  setInterval(render, 1000);
})();
