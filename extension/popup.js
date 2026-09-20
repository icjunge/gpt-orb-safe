'use strict';
const $ = id => document.getElementById(id);
let busy = false;
let reloadRequested = false;
let renderSequence = 0;
let statusRequests = 0;
let lastState = null;
let minutesInitialized = false;
let minutesEdited = false;
const AUTO_ORIGINS = { origins: ['https://chatgpt.com/*'] };

function runtimeAvailable() {
  try {
    const runtime = globalThis.chrome?.runtime;
    return location.protocol === 'chrome-extension:' && !!runtime?.id &&
      location.hostname === runtime.id && typeof runtime.sendMessage === 'function';
  } catch { return false; }
}

function disableControls() {
  document.querySelectorAll('input, button').forEach(element => { element.disabled = true; });
}

function renderPairingControls() {
  // Typing is local. The worker validates the current page before pairing or
  // injecting anything; a status failure must not prevent entering a fresh code.
  const disabled = busy || reloadRequested || !runtimeAvailable();
  $('code').disabled = disabled;
  $('start').disabled = disabled;
  $('start').textContent = busy ? '正在处理…' : '连接并开始读取';
}

function renderAutoControls(state = lastState) {
  const disabled = busy || reloadRequested || !runtimeAvailable();
  const settings = state?.autoRefresh;
  const permissionAPI = typeof globalThis.chrome?.permissions?.request === 'function';
  $('auto-minutes').disabled = disabled;
  $('auto-enable').disabled = disabled || !permissionAPI;
  $('auto-enable').textContent = settings?.enabled ? '保存刷新间隔' : '开启后台刷新';
  $('auto-now').disabled = disabled || !settings?.enabled || !!settings?.running;
  // Keep revocation available even if an earlier enable failed after the grant.
  $('auto-disable').disabled = disabled || typeof globalThis.chrome?.permissions?.remove !== 'function';
  if (state && !minutesInitialized && !minutesEdited) {
    $('auto-minutes').value = String(Number.isInteger(settings?.minutes) ? settings.minutes : 5);
    minutesInitialized = true;
  }
  if (!settings?.enabled) {
    $('auto-status').textContent = settings?.error || '尚未开启。后台刷新需要浏览器的网站访问授权。';
  } else {
    const parts = [`每 ${settings.minutes} 分钟刷新`];
    if (settings.running) parts.push('正在读取后台用量页');
    if (settings.nextRunAt) parts.push(`下次约 ${time(settings.nextRunAt)}`);
    if (state.lastReadAt) parts.push(`上次成功读取 ${time(state.lastReadAt)}`);
    if (settings.error) parts.push(settings.error);
    $('auto-status').textContent = parts.join(' · ');
  }
}

function reloadAvailable() {
  return runtimeAvailable() && location.pathname === '/popup.html'
    && typeof globalThis.chrome.runtime.reload === 'function';
}

function renderReload() {
  $('reload-extension').disabled = reloadRequested || !reloadAvailable();
}

function showEnvironmentProblem() {
  disableControls();
  $('code').value = '';
  $('setup-help').hidden = false;
  $('light').className = 'warn';
  $('message').textContent = '';
  const extensionPage = location.protocol === 'chrome-extension:';
  $('status').textContent = extensionPage ? '扩展运行环境不可用' : '请从浏览器扩展图标打开';
  $('detail').textContent = extensionPage
    ? '请在浏览器的扩展管理页重新加载本扩展，再回到官方用量页点击工具栏中的扩展图标。'
    : '当前打开方式没有扩展消息接口。请加载整个扩展文件夹；直接打开 popup.html 不能启动同步。';
}

const backgroundHint = '扩展后台暂时无法响应。请在浏览器扩展管理页重新加载本扩展，再回到官方用量页点击扩展图标。';

async function send(message) {
  if (!runtimeAvailable()) {
    showEnvironmentProblem();
    throw new Error('请按上方说明加载扩展，再从浏览器工具栏打开。');
  }
  let response;
  let timer;
  let timedOut = false;
  try {
    response = await Promise.race([
      globalThis.chrome.runtime.sendMessage(message),
      new Promise((_, reject) => {
        timer = setTimeout(() => { timedOut = true; reject(new Error('timeout')); },
          message.type === 'orb:status' ? 5000 : 10000);
      })
    ]);
  } catch {
    throw new Error(timedOut
      ? '扩展后台响应超时，尚未确认操作结果。请检查同步状态；若仍无响应，点击“重新加载扩展”后重试。'
      : backgroundHint);
  } finally { clearTimeout(timer); }
  if (!response || typeof response.ok !== 'boolean') throw new Error(backgroundHint);
  if (!response.ok) throw new Error(response.message || '操作未完成，请重试。');
  return response;
}

function time(ms) { return new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }

async function render() {
  const sequence = ++renderSequence;
  if (!runtimeAvailable()) { showEnvironmentProblem(); return; }
  renderPairingControls();
  renderAutoControls();
  renderReload();
  ++statusRequests;
  try {
    const state = await send({ type: 'orb:status' });
    if (sequence !== renderSequence || reloadRequested) return;
    if (!runtimeAvailable()) { showEnvironmentProblem(); return; }
    lastState = state;
    $('setup-help').hidden = true;
    document.querySelectorAll('input').forEach(element => {
      if (element.id !== 'code' && element.id !== 'auto-minutes') element.disabled = busy || !state.onUsagePage;
    });
    renderPairingControls();
    renderAutoControls(state);
    $('refresh').disabled = busy || !state.paired || !state.onUsagePage;
    $('stop').disabled = busy || !state.paired;
    $('manual-send').disabled = busy || !state.paired || !state.onUsagePage;
    $('light').className = '';
    if (state.autoRefresh?.enabled) {
      const problem = state.autoRefresh.error || state.error;
      $('status').textContent = problem ? '后台刷新需要处理' : state.autoRefresh.running ? '正在后台刷新' : '后台定时刷新已开启';
      $('light').className = problem ? 'warn' : state.lastSentAt ? 'live' : '';
      $('detail').textContent = problem || '无需保持用量页打开。扩展会按间隔临时打开用量页，读取后关闭；登录由浏览器保管。';
    } else if (state.autoRefresh?.error) {
      $('status').textContent = '后台刷新已暂停';
      $('light').className = 'warn';
      $('detail').textContent = state.autoRefresh.error;
    } else if (state.paired && state.mode === 'manual' && state.source !== 'manual-page') {
      $('status').textContent = '自动读取已暂停';
      $('detail').textContent = '上次读数已保留。可以重新开启后台刷新，或回到用量页点击“重新读取页面”。';
    } else if (!state.onUsagePage) {
      if (state.tabState === 'url-unavailable') {
        $('status').textContent = '尚未获得当前页授权';
        $('detail').textContent = '可以输入配对码。请在官方用量页点击浏览器工具栏的扩展图标，再连接；单独打开扩展页面不会授予读取权限。';
      } else if (state.tabState === 'no-tab') {
        $('status').textContent = '未找到当前标签页';
        $('detail').textContent = '可以输入配对码。请打开浏览器中的官方用量页，再从该窗口的工具栏打开扩展。';
      } else {
        $('status').textContent = '请打开官方用量页';
        $('detail').textContent = '可以输入配对码。开始读取前，请切换到官方用量页，并在该标签页点击工具栏中的扩展图标。';
      }
    } else if (!state.paired) {
      $('status').textContent = state.error ? '配对已失效' : '等待本机配对';
      $('detail').textContent = state.error || '配对码仅授予发送数字的权限，不是账号登录凭据。';
      if (state.error) $('light').className = 'warn';
    } else if (state.error) {
      $('status').textContent = '同步需要处理'; $('light').className = 'warn';
      $('detail').textContent = state.error;
    } else if (!state.sameTab) {
      $('status').textContent = '当前标签页尚未启用';
      $('detail').textContent = '点击“重新读取页面”，将同步切换到当前用量页。';
    } else if (!state.lastSentAt) {
      $('status').textContent = '正在等待首次同步';
      $('detail').textContent = '已在本会话保存配对码，尚未确认悬浮球收到数据。';
    } else if (state.mode === 'manual') {
      $('status').textContent = '手动数据已发送'; $('light').className = 'live';
      $('detail').textContent = `${time(state.lastSentAt)} · 不会自动更新。点击“重新读取页面”恢复自动读取。`;
    } else if (!state.hasData) {
      $('status').textContent = '已连接 · 未识别到用量'; $('light').className = 'warn';
      $('detail').textContent = '请确认页面已加载。无法识别的数值保持未知，也可手动填写。';
    } else {
      $('status').textContent = '正在同步页面数值'; $('light').className = 'live';
      $('detail').textContent = `${time(state.lastReadAt)} 读取 · 保持用量页打开，约每 60 秒读取一次。`;
    }
  } catch {
    if (sequence !== renderSequence || reloadRequested) return;
    if (!runtimeAvailable()) { showEnvironmentProblem(); return; }
    disableControls();
    renderPairingControls();
    renderAutoControls();
    renderReload();
    $('setup-help').hidden = false;
    $('light').className = 'warn';
    $('status').textContent = '扩展后台暂时无法响应';
    $('detail').textContent = '配对码仍可输入。请点击下方“重新加载扩展”，再回到官方用量页点击扩展图标。';
  } finally { --statusRequests; }
}

async function act(work) {
  if (!runtimeAvailable()) { showEnvironmentProblem(); return; }
  if (busy || reloadRequested) return;
  busy = true;
  ++renderSequence; // Ignore status responses from before this action.
  $('message').textContent = '';
  disableControls();
  renderPairingControls();
  renderAutoControls();
  renderReload();
  try { await work(); }
  catch (error) { $('message').textContent = String(error.message || '操作失败。'); }
  finally { busy = false; await render(); }
}

$('pair-form').addEventListener('submit', event => {
  event.preventDefault();
  act(async () => {
    const code = $('code').value;
    $('code').value = '';
    await send({ type: 'orb:start', code });
  });
});
$('refresh').addEventListener('click', () => act(() => send({ type: 'orb:refresh' })));
$('stop').addEventListener('click', () => act(async () => {
  $('code').value = '';
  await send({ type: 'orb:stop' });
}));

$('auto-minutes').addEventListener('input', () => { minutesEdited = true; });
$('auto-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!runtimeAvailable()) { showEnvironmentProblem(); return; }
  if (busy || reloadRequested) return;
  const minutes = Number($('auto-minutes').value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    $('message').textContent = '刷新间隔请输入 1–1440 的整数分钟。';
    return;
  }
  const code = $('code').value.trim();
  if (code && !/^GPTORB2\.43861\.[A-Za-z0-9_-]{43}$/.test(code)) {
    $('message').textContent = '配对码格式错误，请从悬浮球重新复制。';
    return;
  }
  if (!code && !lastState?.paired) {
    $('message').textContent = '请先在上方粘贴悬浮球的当前配对码，再开启后台刷新。';
    return;
  }
  if (typeof globalThis.chrome.permissions?.request !== 'function') {
    $('message').textContent = '浏览器的网站授权接口不可用，请在扩展管理页重新加载后重试。';
    return;
  }
  let grant;
  try {
    // Request directly in the submit gesture, before any await or worker call.
    grant = globalThis.chrome.permissions.request(AUTO_ORIGINS);
  } catch {
    $('message').textContent = '无法申请后台网站访问权限，请重新点击开启。';
    return;
  }
  $('code').value = '';
  act(async () => {
    let allowed;
    try { allowed = await grant; }
    catch { throw new Error('网站访问授权未完成，后台刷新未开启。'); }
    if (!allowed) throw new Error('未授予网站访问权限，后台刷新未开启。仍可使用当前页面同步。');
    if (reloadRequested || !runtimeAvailable()) return;
    await send({ type: 'orb:auto-start', minutes, ...(code ? { code } : {}) });
    $('message').textContent = '已开启后台刷新，正在尝试首次读取。可以关闭原来的用量页。';
  });
});
$('auto-now').addEventListener('click', () => act(async () => {
  await send({ type: 'orb:auto-refresh' });
  $('message').textContent = '已请求后台刷新，请查看上次成功读取时间。';
}));
$('auto-disable').addEventListener('click', () => act(async () => {
  let stopFailed = false;
  try { await send({ type: 'orb:auto-stop' }); }
  catch { stopFailed = true; }
  let removed;
  try { removed = await globalThis.chrome.permissions.remove(AUTO_ORIGINS); }
  catch { throw new Error('撤销网站授权失败。请在浏览器扩展管理页取消网站访问权限，并重新加载扩展。'); }
  if (!removed) throw new Error('未能确认网站授权已撤销。请在扩展管理页检查网站访问权限。');
  if (stopFailed) throw new Error('已撤销后台网站授权，但后台状态未能确认，请重新加载扩展。');
  $('message').textContent = '后台刷新已关闭，已撤销后台网站授权。上次读数仍会保留。';
}));

// This local user gesture is the only reload trigger. The desktop bridge and
// content scripts cannot request updates or execute newly fetched JavaScript.
$('reload-extension').addEventListener('click', () => {
  if (!reloadAvailable() || reloadRequested) return;
  reloadRequested = true;
  ++renderSequence;
  $('code').value = '';
  disableControls();
  renderReload();
  try { globalThis.chrome.runtime.reload(); }
  catch {
    reloadRequested = false;
    renderPairingControls();
    renderAutoControls();
    renderReload();
    $('message').textContent = '无法重新加载，请在浏览器扩展管理页点击“重新加载”。';
  }
});

function numeric(id, integer = false) {
  const value = $(id).value.trim();
  if (value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || (integer && !Number.isSafeInteger(n)) || (!integer && n > 100)) {
    throw new Error('请检查数值：比例为 0–100，Token 为非负整数。');
  }
  return n;
}

$('manual-form').addEventListener('submit', event => {
  event.preventDefault();
  act(async () => {
    const windows = [];
    for (const kind of ['session', 'weekly']) {
      const usedPercent = numeric(`${kind}-used`);
      const dateText = $(`${kind}-reset`).value;
      if (usedPercent === null && dateText) throw new Error('填写重置时间时，也需要填写对应的已用比例。');
      if (usedPercent === null) continue;
      const resetAt = dateText ? new Date(dateText).getTime() : null;
      if (resetAt !== null && (!Number.isSafeInteger(resetAt) || resetAt <= 0)) throw new Error('重置时间无效。');
      windows.push({ kind, usedPercent, resetAt, resetApproximate: true });
    }
    await send({ type: 'orb:manual', snapshot: { version: 1, source: 'manual-page', capturedAt: Date.now(),
      windows, tokens: { total: numeric('total-tokens', true), today: numeric('today-tokens', true) } } });
    $('message').textContent = '已发送手动数据；自动读取已暂停。';
  });
});

render();
if (runtimeAvailable()) setInterval(() => {
  if (!busy && !reloadRequested && statusRequests === 0) render();
}, 1500);
