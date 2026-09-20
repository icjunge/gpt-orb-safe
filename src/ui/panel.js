'use strict';
(() => {
  const $ = id => document.getElementById(id);
  let state = { status: 'starting', bridge: {}, snapshot: null, settings: {} };
  let toastTimer = null;
  let settingsVisible = false;
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const names = { session: '当前时段', weekly: '每周额度', other: '其他额度' };
  const hidden = (id, value) => $(id).classList.toggle('hidden', value);
  const setText = (id, value) => { $(id).textContent = value; };
  const stale = () => !!state.snapshot && Date.now() - state.snapshot.capturedAt > 180000;
  const manual = () => state.snapshot?.source === 'manual-page';
  function windows() {
    return (state.snapshot?.windows || []).filter(window => finite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100)
      .map(window => ({ ...window, remaining: 100 - window.usedPercent }));
  }
  function formatPercent(value) { return String(Math.round(value * 10) / 10); }
  function countdown(timestamp, approximate = false) {
    if (!finite(timestamp)) return '页面未显示';
    const seconds = Math.ceil((timestamp - Date.now()) / 1000);
    if (seconds <= 0) return '等待页面确认';
    const prefix = approximate ? '约 ' : '';
    if (seconds >= 86400) return `${prefix}${Math.floor(seconds / 86400)} 天 ${Math.floor(seconds % 86400 / 3600)} 小时`;
    if (seconds >= 3600) return `${prefix}${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`;
    if (seconds >= 60) return `${prefix}${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
    return `${prefix}${seconds} 秒`;
  }
  function tokenText(value) {
    if (!Number.isSafeInteger(value) || value < 0) return '—';
    if (value >= 1e9) return `${(value / 1e9).toFixed(2)} B`;
    if (value >= 1e6) return `${(value / 1e6).toFixed(2)} M`;
    if (value >= 1e4) return `${(value / 1e3).toFixed(1)} K`;
    return value.toLocaleString('zh-CN');
  }
  function tokenDetail(value) {
    return Number.isSafeInteger(value) && value >= 0 ? `${value.toLocaleString('zh-CN')} tokens · ${manual() ? '人工记录' : '页面数值'}` : '官方页面未显示';
  }
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function renderWindows(items) {
    const list = $('limits-list');
    list.replaceChildren();
    setText('limits-count', items.length ? `${items.length} 个已识别窗口` : '暂无可识别数值');
    if (!items.length) {
      list.append(node('p', 'empty-data', '官方页面未显示可识别的额度百分比。'));
      return;
    }
    const group = node('div', 'limit-group');
    for (const item of items) {
      const row = node('div', 'limit-window');
      row.append(node('span', 'window-name', names[item.kind] || '额度窗口'));
      row.append(node('span', 'window-value', `剩余 ${formatPercent(item.remaining)}%`));
      const track = node('div', 'window-track');
      const fill = node('span', `window-fill${item.remaining <= 10 ? ' danger' : item.remaining <= 25 ? ' warning' : ''}`);
      fill.style.width = `${item.remaining}%`;
      track.append(fill);
      row.append(track);
      const reset = node('span', 'window-reset');
      reset.dataset.resetAt = finite(item.resetAt) ? String(item.resetAt) : '';
      reset.dataset.approximate = String(!!item.resetApproximate);
      reset.textContent = `${finite(item.resetAt) && item.resetAt > Date.now() ? '距离重置 · ' : ''}${countdown(item.resetAt, item.resetApproximate)}`;
      row.append(reset);
      group.append(row);
    }
    list.append(group);
  }
  function renderStatus() {
    const hasSnapshot = !!state.snapshot;
    const isStale = stale();
    const isManual = manual();
    const online = hasSnapshot && state.bridge?.connected && !isStale && !state.error;
    $('connection-dot').classList.toggle('online', !!online);
    $('footer-dot').classList.toggle('online', !!online && !isManual);
    $('footer-dot').classList.toggle('stale', hasSnapshot && (isStale || isManual || !!state.error));
    setText('source-badge', isManual ? '人工记录' : isStale ? '上次记录' : hasSnapshot ? '页面记录' : '待配对');
    setText('source-description', isManual ? '手动录入官方页面所示数值' : hasSnapshot ? '仅同步官方页面明确显示的用量数字' : '登录留在官方网页，用量留在桌面');
    const note = isManual ? '当前是人工记录，不会自动反映账号用量变化。' : isStale ? '超过 3 分钟未读取到页面。当前显示上次记录，请检查浏览器中的官方用量页。' : state.error && hasSnapshot ? '同步遇到问题，当前显示上次页面记录。' : '';
    setText('freshness-note', note);
    hidden('freshness-note', !note);
    let status = state.status === 'starting' ? '正在启动本机同步' : state.error ? '同步异常' : !state.bridge?.listening ? '本机同步尚未启动' : !hasSnapshot ? '等待本机配对' : isManual ? '人工记录 · 请按需更新' : isStale ? '页面读取已超时' : '正在接收页面记录';
    setText('sync-status', status);
    const canPair = !!state.bridge?.listening;
    for (const id of ['pair-button', 'pair-settings-button']) $(id).disabled = !canPair;
  }
  function renderCountdowns() {
    const tightest = windows().sort((a, b) => a.remaining - b.remaining)[0];
    setText('reset-countdown', tightest ? countdown(tightest.resetAt, tightest.resetApproximate) : '—');
    for (const element of document.querySelectorAll('[data-reset-at]')) {
      const timestamp = element.dataset.resetAt === '' ? null : Number(element.dataset.resetAt);
      element.textContent = `${finite(timestamp) && timestamp > Date.now() ? '距离重置 · ' : ''}${countdown(timestamp, element.dataset.approximate === 'true')}`;
    }
    renderStatus();
  }
  function renderUpdates() {
    const updates = state.updates || {};
    const status = updates.status || 'unconfigured';
    const currentVersion = typeof updates.currentVersion === 'string' ? updates.currentVersion : '2.1.2';
    const availableVersion = typeof updates.availableVersion === 'string' ? updates.availableVersion : '';
    const messages = {
      unconfigured: '更新源尚未启用',
      idle: '可检查是否有新版本',
      checking: '正在检查新版本…',
      downloading: '正在下载更新，完成后可重启安装',
      ready: '更新已准备好，重启后生效',
      error: '更新未完成，请稍后重试'
    };
    setText('current-version', currentVersion);
    setText('footer-version', `${currentVersion} · LOCAL`);
    setText('available-version', availableVersion ? `新版 ${availableVersion}` : '');
    hidden('available-version', !availableVersion);
    setText('update-status', status === 'unconfigured' ? messages.unconfigured : typeof updates.message === 'string' && updates.message ? updates.message : messages[status] || messages.idle);
    $('update-status').classList.toggle('error', status === 'error');
    const downloading = status === 'downloading';
    hidden('update-progress-row', !downloading);
    if (finite(updates.progress)) {
      const progress = Math.max(0, Math.min(100, updates.progress));
      $('update-progress').value = progress;
      setText('update-progress-value', `${Math.round(progress)}%`);
    } else {
      $('update-progress').removeAttribute('value');
      setText('update-progress-value', '下载中');
    }
    const checkedAt = updates.lastCheckedAt;
    hidden('update-last-checked', !finite(checkedAt));
    setText('update-last-checked', finite(checkedAt) ? `上次检查 ${new Date(checkedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}` : '');
    $('check-updates-button').disabled = ['unconfigured', 'checking', 'downloading', 'ready'].includes(status);
    setText('check-updates-button', status === 'checking' ? '正在检查…' : status === 'downloading' ? '正在下载…' : '检查更新');
    hidden('install-update-button', status !== 'ready');
    hidden('release-page-button', typeof updates.repository !== 'string' || !updates.repository);
    $('auto-check-updates').checked = state.settings?.autoCheckUpdates !== false;
    const extension = state.extension || {};
    const extensionVersion = typeof extension.version === 'string' && extension.version ? `扩展 ${extension.version} · ` : '';
    const extensionNote = extension.needsReload ? `${extensionVersion}扩展文件已更新。请在浏览器扩展内点「重新加载」，再重新配对。` : `${extensionVersion}首次加载固定扩展文件夹；以后更新后在扩展内点「重新加载」，并重新配对。`;
    const extensionError = typeof extension.error === 'string' ? extension.error : '';
    setText('extension-status', extensionNote);
    $('extension-status').classList.toggle('needs-reload', !!extension.needsReload);
    setText('extension-error', extensionError ? `扩展文件更新异常：${extensionError}` : '');
    hidden('extension-error', !extensionError);
    setText('setup-extension-note', extensionError ? `扩展文件更新异常：${extensionError}` : extensionNote);
    hidden('setup-extension-note', !extensionError && !extension.needsReload);
  }
  function render() {
    const items = windows();
    const tightest = [...items].sort((a, b) => a.remaining - b.remaining)[0];
    hidden('setup-card', !!state.snapshot);
    hidden('data-content', !state.snapshot);
    setText('remaining-number', tightest ? formatPercent(tightest.remaining) : '—');
    hidden('remaining-symbol', !tightest);
    setText('hero-tag', tightest ? names[tightest.kind] || '额度窗口' : '页面记录');
    setText('hero-description', tightest ? `取已识别窗口中剩余额度最低值 · ${manual() ? '人工记录' : '页面数值'}` : '官方页面未显示可识别额度');
    $('hero-progress').style.strokeDashoffset = String(226.195 * (1 - (tightest?.remaining || 0) / 100));
    $('quota-hero').classList.toggle('warning', !!tightest && tightest.remaining > 10 && tightest.remaining <= 25);
    $('quota-hero').classList.toggle('danger', !!tightest && tightest.remaining <= 10);
    renderWindows(items);
    for (const key of ['today', 'total']) {
      const value = state.snapshot?.tokens?.[key];
      setText(`${key}-tokens`, tokenText(value));
      setText(`${key}-detail`, tokenDetail(value));
    }
    hidden('unrecognized-note', !!items.length || manual());
    setText('record-label', manual() ? '人工记录时间' : '页面读取时间');
    const timestamp = state.snapshot?.capturedAt;
    setText('record-time', finite(timestamp) ? new Date(timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—');
    if (finite(timestamp)) $('record-time').dateTime = new Date(timestamp).toISOString();
    else $('record-time').removeAttribute('datetime');
    hidden('error-banner', !state.error);
    setText('error-text', typeof state.error === 'string' ? state.error : '');
    const settings = state.settings || {};
    $('always-on-top').checked = settings.alwaysOnTop !== false;
    $('auto-start').checked = !!settings.autoStart;
    $('notifications').checked = settings.notifications !== false;
    const opacity = finite(settings.opacity) ? Math.round(settings.opacity <= 1 ? settings.opacity * 100 : settings.opacity) : 100;
    $('opacity').value = String(opacity);
    setText('opacity-value', `${opacity}%`);
    renderUpdates();
    renderCountdowns();
  }
  function toast(message, isError = false) {
    clearTimeout(toastTimer);
    setText('toast', message);
    $('toast').classList.toggle('error', isError);
    hidden('toast', false);
    toastTimer = setTimeout(() => hidden('toast', true), 5000);
  }
  async function action(name, payload) {
    try {
      if (!window.orb) throw new Error('桌面连接不可用');
      const result = await window.orb.action(name, payload);
      if (result?.ok === false) throw new Error(result.error || '操作未完成');
      return { ok: true, result };
    } catch (error) {
      toast(typeof error?.message === 'string' ? error.message : '操作未完成，请重试。', true);
      return { ok: false };
    }
  }
  function showSettings(show) {
    settingsVisible = show;
    hidden('settings-view', !show);
    hidden('overview', show);
    $('settings-button').setAttribute('aria-pressed', String(show));
    document.querySelector('.main-scroll').scrollTop = 0;
  }
  $('settings-button').addEventListener('click', () => showSettings(!settingsVisible));
  $('back-button').addEventListener('click', () => showSettings(false));
  $('close-button').addEventListener('click', () => action('hidePanel'));
  for (const id of ['setup-dashboard-button', 'dashboard-button', 'footer-dashboard-button']) $(id).addEventListener('click', () => action('openDashboard'));
  for (const id of ['extension-folder-button', 'folder-settings-button']) $(id).addEventListener('click', () => action('openExtensionFolder'));
  for (const id of ['pair-button', 'pair-settings-button']) $(id).addEventListener('click', async () => {
    if ((await action('copyPairingCode')).ok) toast('本次配对码已复制。在浏览器扩展中粘贴并开始同步；请勿分享此码。');
  });
  $('disconnect-button').addEventListener('click', async () => {
    if ((await action('disconnect')).ok) toast('已断开同步。旧配对码立即失效，需要时可复制新码重新配对。');
  });
  $('help-button').addEventListener('click', () => action('openHelp'));
  $('check-updates-button').addEventListener('click', async () => {
    $('check-updates-button').disabled = true;
    await action('checkUpdates');
    renderUpdates();
  });
  $('install-update-button').addEventListener('click', async () => {
    $('install-update-button').disabled = true;
    if (!(await action('installUpdate')).ok) $('install-update-button').disabled = false;
  });
  $('release-page-button').addEventListener('click', () => action('openReleasePage'));
  $('recovery-folder-button').addEventListener('click', () => action('openRecoveryFolder'));
  $('quit-button').addEventListener('click', () => action('quit'));
  for (const [id, key] of [['always-on-top', 'alwaysOnTop'], ['auto-start', 'autoStart'], ['notifications', 'notifications'], ['auto-check-updates', 'autoCheckUpdates']]) {
    $(id).addEventListener('change', async event => {
      if (!(await action('setSettings', { [key]: event.target.checked })).ok) render();
    });
  }
  $('opacity').addEventListener('input', event => setText('opacity-value', `${event.target.value}%`));
  $('opacity').addEventListener('change', async event => {
    if (!(await action('setSettings', { opacity: Number(event.target.value) / 100 })).ok) render();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') settingsVisible ? showSettings(false) : action('hidePanel');
  });
  let receivedLiveState = false;
  window.orb?.onState(next => { receivedLiveState = true; state = next; render(); });
  window.orb?.getState().then(next => { if (!receivedLiveState) { state = next; render(); } }).catch(() => {
    if (!receivedLiveState) { state.error = '无法读取桌面状态，请重新启动工具。'; render(); }
  });
  render();
  setInterval(renderCountdowns, 1000);
})();
