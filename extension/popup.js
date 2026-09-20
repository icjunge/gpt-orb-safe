'use strict';
const $ = id => document.getElementById(id);
let busy = false;
let reloadRequested = false;
let renderSequence = 0;
let statusRequests = 0;

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
  renderReload();
  ++statusRequests;
  try {
    const state = await send({ type: 'orb:status' });
    if (sequence !== renderSequence || reloadRequested) return;
    if (!runtimeAvailable()) { showEnvironmentProblem(); return; }
    $('setup-help').hidden = true;
    document.querySelectorAll('input').forEach(element => {
      if (element.id !== 'code') element.disabled = busy || !state.onUsagePage;
    });
    renderPairingControls();
    $('refresh').disabled = busy || !state.paired || !state.onUsagePage;
    $('stop').disabled = busy || !state.paired;
    $('manual-send').disabled = busy || !state.paired || !state.onUsagePage;
    $('light').className = '';
    if (!state.onUsagePage) {
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
