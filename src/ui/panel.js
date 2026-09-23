'use strict';
(() => {
  const $ = id => document.getElementById(id);
  let state = { status: 'starting', bridge: {}, snapshot: null, settings: { usageSource: 'codex-cli' } };
  let toastTimer = null;
  let settingsVisible = false;
  let codexBusy = false;
  let intervalDirty = false;
  let glassTintDirty = false;
  let glassTintRevision = 0;
  let resizeTimer = null;
  let requestedHeight = null;
  const canMeasureLayout = typeof ResizeObserver === 'function' && typeof window.getComputedStyle === 'function';
  let tokenView = null;
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const validToken = value => Number.isSafeInteger(value) && value >= 0;
  const names = { session: '当前时段', weekly: '每周额度', other: '其他额度' };
  const hidden = (id, value) => $(id).classList.toggle('hidden', value);
  const setText = (id, value) => { $(id).textContent = value; };
  const selectedSource = () => state.usageSource || state.settings?.usageSource || (state.codex || state.snapshot?.source === 'codex-cli' ? 'codex-cli' : 'browser');
  const nativeMode = () => selectedSource() === 'codex-cli';
  const snapshot = () => state.snapshot && ((state.snapshot.source === 'codex-cli') === nativeMode()) ? state.snapshot : null;
  const stale = () => !!snapshot() && Date.now() - snapshot().capturedAt > (finite(state.staleAfterMs) && state.staleAfterMs > 0 ? state.staleAfterMs : 180000);
  const manual = () => snapshot()?.source === 'manual-page';
  const history = () => stale() || !!state.error || (nativeMode() && (!state.codex?.enabled || (state.codex?.state === 'reading' && !finite(state.codex?.lastSuccessAt)) || ['error', 'not-found', 'needs-login', 'unsupported'].includes(state.codex?.state)));
  const windowName = item => nativeMode() && typeof item.label === 'string' && item.label ? item.label.replace(/^Codex\s*·\s*/, '') || item.label : names[item.kind] || '额度窗口';
  const localTime = timestamp => finite(timestamp) ? new Date(timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
  const validGlassTint = value => Number.isInteger(value) && value >= 0 && value <= 70;
  function windows() {
    return (snapshot()?.windows || []).filter(window => finite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100)
      .map(window => ({ ...window, remaining: 100 - window.usedPercent }));
  }
  function formatPercent(value) { return String(Math.round(value * 10) / 10); }
  function countdown(timestamp, approximate = false) {
    if (!finite(timestamp)) return '重置时间未知';
    const seconds = Math.ceil((timestamp - Date.now()) / 1000);
    if (seconds <= 0) return nativeMode() ? '等待读取确认' : '等待页面确认';
    const prefix = approximate ? '约 ' : '';
    if (seconds >= 86400) return `${prefix}${Math.floor(seconds / 86400)} 天 ${Math.floor(seconds % 86400 / 3600)} 小时`;
    if (seconds >= 3600) return `${prefix}${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`;
    if (seconds >= 60) return `${prefix}${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
    return `${prefix}${seconds} 秒`;
  }
  function tokenText(value) {
    if (!validToken(value)) return '—';
    if (value >= 1e9) return `${(value / 1e9).toFixed(2)} B`;
    if (value >= 1e6) return `${(value / 1e6).toFixed(2)} M`;
    if (value >= 1e4) return `${(value / 1e3).toFixed(1)} K`;
    return value.toLocaleString('zh-CN');
  }
  function tokenDetail(value, key) {
    if (!validToken(value)) return '';
    const date = typeof snapshot()?.tokenDate === 'string' ? snapshot().tokenDate : '';
    return nativeMode() ? key === 'today' ? date ? `服务端日期 ${date}` : '服务端统计' : '账号累计' : manual() ? '人工记录' : '页面数值';
  }
  function renderTokens(current) {
    const source = `${selectedSource()}:${current?.source || ''}`;
    const available = ['today', 'total'].filter(key => validToken(current?.tokens?.[key]));
    const hasData = available.length > 0;
    hidden('token-section', !hasData);
    // Repeated refreshes must not undo a user's disclosure choice. New data or a
    // source/availability transition gets the appropriate automatic default.
    if (!tokenView || tokenView.source !== source || tokenView.hasData !== hasData) {
      $('token-section').open = hasData;
    }
    tokenView = { source, hasData };
    hidden('token-metrics', !hasData);
    for (const key of ['today', 'total']) {
      const value = current?.tokens?.[key];
      hidden(`${key}-token-metric`, !validToken(value));
      setText(`${key}-tokens`, tokenText(value));
      $(`${key}-tokens`).title = validToken(value) ? `${value.toLocaleString('zh-CN')} tokens` : '';
      setText(`${key}-detail`, tokenDetail(value, key));
    }
    setText('token-availability', !hasData ? '未提供' : available.length === 1 ? '部分数据' : nativeMode() ? '账号统计' : '页面统计');
    setText('today-token-label', nativeMode() ? '最近一日' : '今日');
    setText('total-token-label', '累计');
    setText('tokens-scope', !hasData
      ? nativeMode() ? '官方暂未提供 Token 统计。' : '用量页暂未提供 Token 统计。'
      : nativeMode() ? 'Codex 服务端统计' : '仅显示页面数值');
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
    if (!items.length) {
      return;
    }
    const group = node('div', 'limit-group');
    for (const item of items) {
      const row = node('div', 'limit-window');
      row.append(node('span', 'window-name', windowName(item)));
      const value = node('span', 'window-value', `${formatPercent(item.remaining)}%`);
      value.setAttribute('aria-label', `剩余额度 ${formatPercent(item.remaining)}%`);
      value.title = `剩余额度 ${formatPercent(item.remaining)}%`;
      row.append(value);
      const track = node('div', 'window-track');
      const fill = node('span', `window-fill${item.remaining <= 10 ? ' danger' : item.remaining <= 25 ? ' warning' : ''}`);
      fill.style.width = `${item.remaining}%`;
      track.append(fill);
      row.append(track);
      const reset = node('span', 'window-reset');
      reset.dataset.resetAt = finite(item.resetAt) ? String(item.resetAt) : '';
      reset.dataset.approximate = String(!!item.resetApproximate);
      reset.textContent = `${countdown(item.resetAt, item.resetApproximate)}${finite(item.resetAt) && item.resetAt > Date.now() ? '后重置' : ''}`;
      if (finite(item.resetAt)) reset.title = `${item.resetApproximate ? '预计' : ''}重置时间：${localTime(item.resetAt)}`;
      row.append(reset);
      group.append(row);
    }
    list.append(group);
  }
  function renderCodexControls() {
    const native = nativeMode();
    const codex = state.codex || {};
    const enabled = !!codex.enabled;
    const current = codex.state || 'disabled';
    const labels = { disabled: '尚未开启', reading: '正在读取', ready: '已连接', 'not-found': '未找到 Codex CLI', 'needs-login': '需要登录', unsupported: '请更新 Codex CLI', error: '读取未完成' };
    const messages = {
      disabled: '开启后自动刷新。',
      reading: '正在查询用量…',
      ready: '按设定间隔自动刷新。',
      'not-found': '请先安装官方 Codex CLI，完成登录后重新开启；若刚安装，可退出并重新启动悬浮球。',
      'needs-login': '请在 PowerShell 运行 codex.cmd login，登录同一个 ChatGPT 账号后重新开启。',
      unsupported: '当前 Codex CLI 不支持所需查询，请用下方安装命令更新后重试。',
      error: '此次读取未完成。请检查网络和官方 Codex 登录状态后重试。'
    };
    hidden('codex-controls', !native);
    hidden('browser-settings', native);
    if (!codexBusy) $('usage-source').value = selectedSource();
    $('usage-source').disabled = codexBusy;
    if (!intervalDirty && document.activeElement !== $('refresh-minutes')) {
      const interval = state.settings?.refreshMinutes ?? codex.intervalMinutes;
      $('refresh-minutes').value = String(Number.isInteger(interval) && interval >= 1 && interval <= 1440 ? interval : 5);
    }
    for (const id of ['refresh-minutes', 'save-refresh-button', 'enable-codex-button']) $(id).disabled = codexBusy;
    hidden('enable-codex-button', enabled);
    $('disable-codex-button').disabled = codexBusy || !enabled;
    $('refresh-codex-button').disabled = codexBusy || !enabled || !!codex.running;
    setText('refresh-codex-button', codex.running ? '读取中…' : '立即刷新');
    hidden('quick-refresh-button', !native);
    $('quick-refresh-button').disabled = codexBusy || !enabled || !!codex.running;
    $('quick-refresh-button').classList.toggle('is-refreshing', codexBusy || !!codex.running);
    $('quick-refresh-button').setAttribute('aria-busy', String(codexBusy || !!codex.running));
    $('quick-refresh-button').title = codexBusy || codex.running ? '正在刷新' : !enabled ? '请先在设置中开启读取' : '立即刷新';
    setText('codex-state-label', !enabled && snapshot() && current === 'disabled' ? '已停止' : labels[current] || labels.error);
    const routine = ['disabled', 'reading', 'ready'].includes(current);
    const status = !routine && typeof codex.message === 'string' && codex.message ? codex.message : messages[current] || messages.error;
    setText('codex-status', !enabled && snapshot() && current === 'disabled' ? '已停止刷新，保留上次记录。' : status);
    const pieces = [];
    if (enabled && finite(codex.nextRunAt)) pieces.push(`下次约 ${localTime(codex.nextRunAt)}`);
    if (finite(codex.lastSuccessAt)) pieces.push(`上次 ${localTime(codex.lastSuccessAt)}`);
    setText('codex-schedule', pieces.join(' · '));
    hidden('codex-setup', !!snapshot() && !['not-found', 'needs-login', 'unsupported', 'error'].includes(current));
    setText('scope-description', native ? '仅代表 Codex 服务统计，非全部 ChatGPT Token。「最近一日」采用服务端日期，并非本机今日。读取时间不代表统计更新时间。' : '仅显示官方页面已提供的指标，非全部 ChatGPT Token。读取时间不代表统计更新时间。');
    setText('settings-source-note', native ? '停止刷新不会退出 Codex 账号。切换来源后需重新开启。Ctrl + Alt + G 展开或收起面板。' : '配对仅同步数值，不授予账号操作权限。退出后需重新配对。Ctrl + Alt + G 展开或收起面板。');
  }
  function renderStatus() {
    const hasSnapshot = !!snapshot();
    const native = nativeMode();
    const isStale = stale();
    const isManual = manual();
    const historic = history();
    const online = hasSnapshot && !historic && !isManual && (native ? !!state.codex?.enabled : !!state.bridge?.connected);
    $('connection-dot').classList.toggle('online', online);
    $('connection-dot').classList.toggle('stale', hasSnapshot && (historic || isManual));
    setText('panel-title', native ? 'Codex' : '浏览器用量');
    let note = '';
    if (isManual) note = '人工记录，需手动更新。';
    else if (native && hasSnapshot && !state.codex?.enabled) note = '已暂停，保留上次读数。';
    else if (native && isStale) note = '刷新超时，保留上次读数。';
    else if (native && historic && hasSnapshot) note = '刷新未完成，保留上次读数。';
    else if (isStale) note = '超过 3 分钟未同步，保留上次读数。';
    else if (state.error && hasSnapshot) note = '同步异常，保留上次读数。';
    setText('freshness-note', note);
    hidden('freshness-note', !note);
    const codexStatuses = { disabled: hasSnapshot ? '已暂停' : '未连接', reading: hasSnapshot ? '刷新中…' : '连接中…', ready: historic ? '上次记录' : '自动刷新', 'not-found': '待安装 CLI', 'needs-login': '待登录', unsupported: 'CLI 待更新', error: '读取失败' };
    const status = native ? codexStatuses[state.codex?.state || 'disabled'] || codexStatuses.error : state.status === 'starting' ? '启动中…' : state.error ? '同步异常' : !state.bridge?.listening ? '同步未启动' : !hasSnapshot ? '待配对' : isManual ? '人工记录' : isStale || !state.bridge?.connected ? '上次记录' : '浏览器同步';
    setText('sync-status', status);
    const canPair = !native && !!state.bridge?.listening;
    for (const id of ['pair-button', 'pair-settings-button']) $(id).disabled = !canPair;
  }
  function renderCountdowns() {
    for (const element of document.querySelectorAll('[data-reset-at]')) {
      const timestamp = element.dataset.resetAt === '' ? null : Number(element.dataset.resetAt);
      element.textContent = `${countdown(timestamp, element.dataset.approximate === 'true')}${finite(timestamp) && timestamp > Date.now() ? '后重置' : ''}`;
    }
    renderStatus();
  }
  function renderUpdates() {
    const updates = state.updates || {};
    const status = updates.status || 'unconfigured';
    const currentVersion = typeof updates.currentVersion === 'string' ? updates.currentVersion : '2.5.4';
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
  function previewGlassTint(value) {
    document.body.style.setProperty('--glass-tint', `${value}%`);
    setText('glass-tint-value', `${value}%`);
  }
  function renderAppearance() {
    for (const [name, key] of [['native-backdrop', 'nativeBackdrop'], ['reduced-transparency', 'reducedTransparency'], ['high-contrast', 'highContrast']]) {
      document.body.classList.toggle(name, state.appearance?.[key] === true);
    }
    if (!glassTintDirty) {
      const tint = validGlassTint(state.settings?.glassTint) ? state.settings.glassTint : 16;
      $('glass-tint').value = String(tint);
      previewGlassTint(tint);
    }
    const appearance = state.appearance || {};
    hidden('orb-opacity-row', appearance.orbNativeHost === true);
    $('opacity').disabled = appearance.orbNativeHost === true;
    const backdropStatus = appearance.backdropStatus || (appearance.nativeBackdrop === true ? 'requested' : 'unavailable');
    $('glass-tint').disabled = backdropStatus !== 'requested' || appearance.nativeBackdrop !== true || appearance.reducedTransparency === true || appearance.highContrast === true;
    const messages = {
      requested: '已请求系统毛玻璃；实际效果由 Windows 透明效果设置决定。',
      unsupported: '此系统不支持原生毛玻璃，使用清晰背景。',
      'reduced-transparency': '系统已关闭透明效果，使用清晰背景。',
      unavailable: '系统毛玻璃未启用，使用清晰背景。'
    };
    setText('material-status', appearance.highContrast === true ? '高对比度已开启，使用清晰背景。' : appearance.reducedTransparency === true ? messages['reduced-transparency'] : messages[backdropStatus] || messages.unavailable);
  }
  function renderEmptyState(current) {
    hidden('empty-state', !!current);
    const native = nativeMode();
    const messages = {
      disabled: ['连接 Codex', '在设置中开启自动读取。'],
      reading: ['正在读取额度', '首次连接可能需要几秒。'],
      ready: ['暂未收到用量', '稍后刷新，或检查连接设置。'],
      'not-found': ['未找到 Codex', '在设置中查看安装方式。'],
      'needs-login': ['Codex 尚未登录', '完成官方登录后重试。'],
      unsupported: ['Codex 需要更新', '在设置中查看更新方式。'],
      error: ['暂时无法读取', '检查连接后重试。']
    };
    const copy = native ? messages[state.codex?.state || 'disabled'] || messages.error : state.error ? ['同步暂不可用', '在设置中检查浏览器连接。'] : ['连接浏览器', '在设置中完成扩展配对。'];
    setText('empty-title', copy[0]);
    setText('empty-description', copy[1]);
    setText('configure-button', native && (!state.codex?.state || state.codex.state === 'disabled') ? '连接设置' : '查看设置');
  }
  function render() {
    renderAppearance();
    const items = windows();
    const current = snapshot();
    const native = nativeMode();
    renderCodexControls();
    renderEmptyState(current);
    hidden('setup-card', native || !!current);
    hidden('data-content', !current);
    renderWindows(items);
    renderTokens(current);
    const hasResetCredits = native && Number.isSafeInteger(current?.resetCredits) && current.resetCredits >= 0;
    hidden('reset-credits-row', !hasResetCredits);
    setText('reset-credits', hasResetCredits ? String(current.resetCredits) : '');
    setText('unrecognized-note', native ? '官方暂未提供可识别的额度窗口。' : '页面布局暂未识别，可在扩展中手动记录官方页面数值。');
    hidden('unrecognized-note', !!items.length || manual());
    const timestamp = current?.capturedAt;
    setText('record-time', finite(timestamp) ? new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '');
    $('record-time').title = finite(timestamp) ? `${manual() ? '人工记录' : '读取'}时间：${localTime(timestamp)}${manual() ? '' : '（非服务器统计更新时间）'}` : '';
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
    schedulePanelResize();
  }
  function schedulePanelResize() {
    if (!canMeasureLayout || !window.orb) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(async () => {
      const shell = document.querySelector('.shell');
      const scroll = document.querySelector('.main-scroll');
      const style = window.getComputedStyle(scroll);
      const chrome = shell.getBoundingClientRect().height - scroll.getBoundingClientRect().height +
        (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
      const natural = settingsVisible ? 600 : Math.ceil($('overview').getBoundingClientRect().height + chrome);
      if (!finite(natural)) return;
      const height = Math.max(240, Math.min(660, natural));
      if (height === requestedHeight) return;
      requestedHeight = height;
      try {
        const result = await window.orb.action('panelResize', { height });
        if (result?.ok === false && requestedHeight === height) requestedHeight = null;
      } catch { if (requestedHeight === height) requestedHeight = null; }
    }, 80);
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
    } catch {
      toast('操作未完成，请查看连接状态后重试。', true);
      return { ok: false };
    }
  }
  function showSettings(show) {
    settingsVisible = show;
    hidden('settings-view', !show);
    hidden('overview', show);
    $('settings-button').setAttribute('aria-pressed', String(show));
    document.querySelector('.main-scroll').scrollTop = 0;
    schedulePanelResize();
  }
  async function codexAction(work) {
    if (codexBusy) return;
    codexBusy = true;
    renderCodexControls();
    try { await work(); } finally { codexBusy = false; render(); }
  }
  function refreshMinutes() {
    const raw = $('refresh-minutes').value.trim();
    const minutes = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      toast('刷新间隔请填写 1–1440 的整数分钟。', true);
      return null;
    }
    return minutes;
  }
  async function saveMinutes(minutes) {
    if (!(await action('setSettings', { refreshMinutes: minutes })).ok) return false;
    state = { ...state, settings: { ...state.settings, refreshMinutes: minutes } };
    intervalDirty = false;
    return true;
  }
  $('refresh-minutes').addEventListener('input', () => { intervalDirty = true; });
  $('usage-source').addEventListener('change', event => {
    const source = event.target.value;
    if (!['codex-cli', 'browser'].includes(source)) return;
    codexAction(async () => {
      if ((await action('setSettings', { usageSource: source })).ok) {
        state = { ...state, usageSource: source, settings: { ...state.settings, usageSource: source } };
      }
    });
  });
  $('codex-refresh-form').addEventListener('submit', event => {
    event.preventDefault();
    if (codexBusy) return;
    const minutes = refreshMinutes();
    if (minutes === null) return;
    codexAction(async () => { if (await saveMinutes(minutes)) toast('刷新间隔已保存。'); });
  });
  $('enable-codex-button').addEventListener('click', () => {
    if (codexBusy || !nativeMode()) return;
    const minutes = refreshMinutes();
    if (minutes === null) return;
    codexAction(async () => { if (await saveMinutes(minutes)) await action('enableCodex'); });
  });
  $('disable-codex-button').addEventListener('click', () => {
    if (!nativeMode() || !state.codex?.enabled) return;
    codexAction(async () => { if ((await action('disableCodex')).ok) toast('已停止悬浮球查询，官方 Codex 的登录状态不受影响。'); });
  });
  for (const id of ['refresh-codex-button', 'quick-refresh-button']) $(id).addEventListener('click', () => {
    if (!nativeMode() || !state.codex?.enabled || state.codex?.running) return;
    codexAction(() => action('refreshCodex'));
  });
  $('copy-codex-setup-button').addEventListener('click', async () => {
    if ((await action('copyCodexSetup')).ok) toast('两条命令已复制。请在 PowerShell 依次执行，并用同一个 ChatGPT 账号登录。');
  });
  $('codex-help-button').addEventListener('click', () => action('openCodexHelp'));
  $('settings-button').addEventListener('click', () => showSettings(!settingsVisible));
  $('configure-button').addEventListener('click', () => showSettings(true));
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
  $('glass-tint').addEventListener('input', event => {
    if ($('glass-tint').disabled) return;
    const tint = Number(event.target.value);
    if (!validGlassTint(tint)) return;
    glassTintDirty = true;
    glassTintRevision++;
    previewGlassTint(tint);
  });
  $('glass-tint').addEventListener('change', async event => {
    if ($('glass-tint').disabled) { glassTintDirty = false; renderAppearance(); return; }
    const tint = Number(event.target.value);
    const revision = ++glassTintRevision;
    if (!validGlassTint(tint)) { glassTintDirty = false; renderAppearance(); return; }
    glassTintDirty = true;
    const saved = (await action('setSettings', { glassTint: tint })).ok;
    // A newer drag must survive broadcasts and completion of an earlier save.
    if (revision !== glassTintRevision) return;
    if (saved) state = { ...state, settings: { ...state.settings, glassTint: tint } };
    glassTintDirty = false;
    renderAppearance();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') settingsVisible ? showSettings(false) : action('hidePanel');
  });
  if (canMeasureLayout) {
    const layoutObserver = new ResizeObserver(schedulePanelResize);
    layoutObserver.observe($('overview'));
    layoutObserver.observe(document.querySelector('.main-scroll'));
  }
  let receivedLiveState = false;
  window.orb?.onState(next => { receivedLiveState = true; state = next; render(); });
  window.orb?.getState().then(next => { if (!receivedLiveState) { state = next; render(); } }).catch(() => {
    if (!receivedLiveState) { state.error = '无法读取桌面状态，请重新启动工具。'; render(); }
  });
  render();
  setInterval(renderCountdowns, 1000);
})();
