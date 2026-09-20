'use strict';
(() => {
  const $ = id => document.getElementById(id);
  let state = { status: 'starting', bridge: {}, snapshot: null, settings: { usageSource: 'codex-cli' } };
  let toastTimer = null;
  let settingsVisible = false;
  let codexBusy = false;
  let intervalDirty = false;
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
  const windowName = item => nativeMode() && typeof item.label === 'string' && item.label ? item.label : names[item.kind] || '额度窗口';
  const localTime = timestamp => finite(timestamp) ? new Date(timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
  function windows() {
    return (snapshot()?.windows || []).filter(window => finite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100)
      .map(window => ({ ...window, remaining: 100 - window.usedPercent }));
  }
  function formatPercent(value) { return String(Math.round(value * 10) / 10); }
  function countdown(timestamp, approximate = false) {
    if (!finite(timestamp)) return nativeMode() ? '官方未返回重置时间' : '页面未显示';
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
    const source = nativeMode() ? key === 'today' && date ? `服务端日期 ${date}` : 'Codex 服务端统计' : manual() ? '人工记录' : '页面数值';
    return `${value.toLocaleString('zh-CN')} tokens · ${source}`;
  }
  function renderTokens(current) {
    const source = `${selectedSource()}:${current?.source || ''}`;
    const available = ['today', 'total'].filter(key => validToken(current?.tokens?.[key]));
    const hasData = available.length > 0;
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
      setText(`${key}-detail`, tokenDetail(value, key));
    }
    setText('token-availability', !hasData ? '未提供' : available.length === 1 ? '部分数据' : nativeMode() ? '账号统计' : '页面统计');
    setText('today-token-label', nativeMode() ? '最近一日 Token' : '今日 Token');
    setText('total-token-label', nativeMode() ? '服务端累计 Token' : '累计 Token');
    setText('tokens-scope', !hasData
      ? nativeMode() ? '官方暂未提供 Token 统计，额度百分比仍可正常查看。' : '用量页暂未提供 Token 统计，额度百分比仍可正常查看。'
      : nativeMode() ? 'Codex 服务端统计' : '仅显示页面提供的数值');
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
    setText('limits-count', items.length ? `${items.length} 个窗口` : '暂无数据');
    if (!items.length) {
      list.append(node('p', 'empty-data', nativeMode() ? '官方未返回可识别的额度百分比。' : '官方页面未显示可识别的额度百分比。'));
      return;
    }
    const group = node('div', 'limit-group');
    for (const item of items) {
      const row = node('div', 'limit-window');
      row.append(node('span', 'window-name', windowName(item)));
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
      if (nativeMode() && finite(item.resetAt)) row.append(node('span', 'window-reset', `重置时间 · ${localTime(item.resetAt)}`));
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
      disabled: '开启后自动刷新，无需打开网页。',
      reading: '正在查询 Codex 用量…',
      ready: '已连接，按设定间隔自动刷新。',
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
    setText('codex-state-label', !enabled && snapshot() && current === 'disabled' ? '已停止' : labels[current] || labels.error);
    const routine = ['disabled', 'reading', 'ready'].includes(current);
    const status = !routine && typeof codex.message === 'string' && codex.message ? codex.message : messages[current] || messages.error;
    setText('codex-status', !enabled && snapshot() && current === 'disabled' ? '已停止刷新，保留上次记录。' : status);
    const pieces = [];
    if (enabled && finite(codex.nextRunAt)) pieces.push(`下次约 ${localTime(codex.nextRunAt)}`);
    if (finite(codex.lastSuccessAt)) pieces.push(`上次 ${localTime(codex.lastSuccessAt)}`);
    setText('codex-schedule', pieces.join(' · '));
    hidden('codex-setup', !!snapshot() && !['not-found', 'needs-login', 'unsupported', 'error'].includes(current));
    setText('source-title', native ? 'Codex · 实验性' : '浏览器同步');
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
    $('footer-dot').classList.toggle('online', online);
    $('footer-dot').classList.toggle('stale', hasSnapshot && (historic || isManual));
    setText('source-badge', isManual ? '人工记录' : hasSnapshot && historic ? '上次记录' : hasSnapshot ? native ? 'Codex 记录' : '页面记录' : native ? '待连接' : '待配对');
    setText('source-description', native ? '官方 CLI 登录 · 无需网页' : isManual ? '手动录入官方页面数值' : hasSnapshot ? '同步官方用量页' : '通过本机扩展连接');
    let note = '';
    if (isManual) note = '人工记录，不会自动更新。';
    else if (native && hasSnapshot && !state.codex?.enabled) note = '自动读取已停止，显示上次记录。';
    else if (native && isStale) note = '超过预期刷新时间，显示上次记录。';
    else if (native && historic && hasSnapshot) note = '本次未能更新，保留上次记录。';
    else if (isStale) note = '读取已超过 3 分钟，显示上次记录。';
    else if (state.error && hasSnapshot) note = '同步异常，保留上次记录。';
    setText('freshness-note', note);
    hidden('freshness-note', !note);
    const codexStatuses = { disabled: hasSnapshot ? '已停止 · 显示上次记录' : '等待开启 Codex 查询', reading: hasSnapshot ? '正在刷新 Codex 记录' : '正在连接本机 Codex', ready: historic ? '显示上次读取记录' : 'Codex 自动读取已开启', 'not-found': '请安装官方 Codex CLI', 'needs-login': '请在官方 Codex CLI 登录', unsupported: '请更新官方 Codex CLI', error: 'Codex 读取异常' };
    const status = native ? codexStatuses[state.codex?.state || 'disabled'] || codexStatuses.error : state.status === 'starting' ? '正在启动本机同步' : state.error ? '同步异常' : !state.bridge?.listening ? '本机同步尚未启动' : !hasSnapshot ? '等待本机配对' : isManual ? '人工记录 · 请按需更新' : isStale ? '显示上次读取记录' : '正在接收页面记录';
    setText('sync-status', status);
    const canPair = !native && !!state.bridge?.listening;
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
    const currentVersion = typeof updates.currentVersion === 'string' ? updates.currentVersion : '2.3.1';
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
    for (const [name, key] of [['native-backdrop', 'nativeBackdrop'], ['reduced-transparency', 'reducedTransparency'], ['high-contrast', 'highContrast']]) {
      document.body.classList.toggle(name, state.appearance?.[key] === true);
    }
    const items = windows();
    const tightest = [...items].sort((a, b) => a.remaining - b.remaining)[0];
    const current = snapshot();
    const native = nativeMode();
    renderCodexControls();
    hidden('setup-card', native || !!current);
    hidden('data-content', !current);
    setText('remaining-number', tightest ? formatPercent(tightest.remaining) : '—');
    hidden('remaining-symbol', !tightest);
    setText('hero-tag', tightest ? windowName(tightest) : native ? 'Codex 记录' : '页面记录');
    setText('hero-description', tightest ? '各窗口中剩余额度最少' : native ? '官方暂未提供额度' : '页面暂未显示额度');
    setText('reset-label', '距离重置');
    $('hero-progress').style.strokeDashoffset = String(226.195 * (1 - (tightest?.remaining || 0) / 100));
    $('quota-hero').classList.toggle('warning', !!tightest && tightest.remaining > 10 && tightest.remaining <= 25);
    $('quota-hero').classList.toggle('danger', !!tightest && tightest.remaining <= 10);
    renderWindows(items);
    renderTokens(current);
    hidden('reset-credits-row', !native);
    setText('reset-credits', Number.isSafeInteger(current?.resetCredits) && current.resetCredits >= 0 ? String(current.resetCredits) : '—');
    setText('unrecognized-note', native ? '官方暂未提供可识别的额度窗口。' : '页面布局暂未识别，可在扩展中手动记录官方页面数值。');
    hidden('unrecognized-note', !!items.length || manual());
    setText('record-label', native ? 'Codex 读取时间' : manual() ? '人工记录时间' : '页面读取时间');
    const timestamp = current?.capturedAt;
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
  $('refresh-codex-button').addEventListener('click', () => {
    if (!nativeMode() || !state.codex?.enabled || state.codex?.running) return;
    codexAction(() => action('refreshCodex'));
  });
  $('copy-codex-setup-button').addEventListener('click', async () => {
    if ((await action('copyCodexSetup')).ok) toast('两条命令已复制。请在 PowerShell 依次执行，并用同一个 ChatGPT 账号登录。');
  });
  $('codex-help-button').addEventListener('click', () => action('openCodexHelp'));
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
