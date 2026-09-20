'use strict';

const PORT = 43861;
const ENDPOINT = `http://127.0.0.1:${PORT}/v1/usage`;
const POPUP_URL = chrome.runtime.getURL('popup.html');
const USAGE_URL = 'https://chatgpt.com/settings/usage?tab=overview';
const HOST_PERMISSION = { origins: ['https://chatgpt.com/*'] };
const PERIOD_ALARM = 'orb:auto-refresh';
const TIMEOUT_ALARM = 'orb:auto-timeout';
const RUN_TIMEOUT = 60000;
const HYDRATION_TIMEOUT = 15000;
const CODE = /^GPTORB2\.43861\.([A-Za-z0-9_-]{43})$/;
const ready = chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
const requests = new Set();
let postSequence = 0;
let controls = Promise.resolve();
let activeTask = null;
let hydrationTimer = null;
const activatedTabs = new Set();

function serial(work) {
  const result = controls.then(work);
  controls = result.catch(() => {});
  return result;
}

function generation() { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function hasMetrics(value) {
  return value.windows.length > 0 || value.tokens.total !== null || value.tokens.today !== null;
}
function validMinutes(value) { return Number.isInteger(value) && value >= 1 && value <= 1440; }
function validBridge(bridge) {
  return Boolean(bridge && typeof bridge.secret === 'string' && /^[A-Za-z0-9_-]{43}$/.test(bridge.secret));
}

function isUsagePage(value) {
  try {
    const u = new URL(value);
    return u.origin === 'https://chatgpt.com' && !u.username && !u.password &&
      /^\/(?:codex\/)?settings\/usage\/?$/.test(u.pathname);
  } catch { return false; }
}

function usageTabState(tab) {
  if (!tab || !Number.isInteger(tab.id)) return 'no-tab';
  if (typeof tab.url !== 'string' || !tab.url) return 'url-unavailable';
  return isUsagePage(tab.url) ? 'usage-page' : 'unsupported-page';
}

function sameKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function cleanSnapshot(value, source) {
  if (!sameKeys(value, ['version', 'source', 'capturedAt', 'windows', 'tokens']) ||
      value.version !== 1 || value.source !== source || !Number.isSafeInteger(value.capturedAt) ||
      Math.abs(Date.now() - value.capturedAt) > 300000 || !Array.isArray(value.windows) ||
      value.windows.length > 3 || !sameKeys(value.tokens, ['total', 'today'])) {
    throw new Error('页面数据格式不符合要求，已停止发送。');
  }
  const kinds = new Set();
  const windows = value.windows.map(item => {
    if (!sameKeys(item, ['kind', 'usedPercent', 'resetAt', 'resetApproximate']) ||
        !['session', 'weekly', 'other'].includes(item.kind) || kinds.has(item.kind) ||
        !Number.isFinite(item.usedPercent) || item.usedPercent < 0 || item.usedPercent > 100 ||
        !(item.resetAt === null || (Number.isSafeInteger(item.resetAt) && item.resetAt > 0 && item.resetAt < 4102444800000)) ||
        typeof item.resetApproximate !== 'boolean') {
      throw new Error('用量字段无效，已停止发送。');
    }
    kinds.add(item.kind);
    return { kind: item.kind, usedPercent: item.usedPercent, resetAt: item.resetAt,
      resetApproximate: item.resetApproximate };
  });
  for (const key of ['total', 'today']) {
    const n = value.tokens[key];
    if (!(n === null || (Number.isSafeInteger(n) && n >= 0))) throw new Error('Token 数值无效。');
  }
  return { version: 1, source, capturedAt: value.capturedAt, windows,
    tokens: { total: value.tokens.total, today: value.tokens.today } };
}

async function session() {
  await ready;
  return (await chrome.storage.session.get('bridge')).bridge || null;
}

async function sameSession(bridge) {
  const now = await session();
  return now && now.secret === bridge.secret && now.tabId === bridge.tabId && now.mode === bridge.mode && now.generation === bridge.generation;
}

async function patchStatus(bridge, patch) {
  if (!await sameSession(bridge)) return;
  const old = (await chrome.storage.session.get('status')).status || {};
  await chrome.storage.session.set({ status: { ...old, ...patch } });
}

function setStatus(bridge, patch) { return serial(() => patchStatus(bridge, patch)); }

async function currentUsageTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  switch (usageTabState(tab)) {
    case 'no-tab':
      throw new Error('未找到当前标签页。请切回浏览器中的官方用量页，再点击工具栏中的扩展图标。');
    case 'url-unavailable':
      throw new Error('无法读取当前标签页地址。请关闭此面板，在官方用量页点击浏览器工具栏中的扩展图标，授予本次页面访问权限。');
    case 'unsupported-page':
      throw new Error('当前标签页不是支持的官方用量页。请打开上方的官方用量页链接，再从该标签页点击工具栏中的扩展图标。');
  }
  return tab;
}

async function inject(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!isUsagePage(tab.url)) throw new Error('页面已离开官方用量页，未读取。');
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] },
    world: 'ISOLATED', files: ['parser.js', 'collector.js'] });
}

async function stopCollector(tabId) {
  if (!Number.isInteger(tabId)) return;
  try { await chrome.tabs.sendMessage(tabId, { type: 'orb:stop' }, { frameId: 0 }); } catch {}
}

async function invalidate(bridge, message, runId = null) {
  await serial(async () => {
    if (!await sameSession(bridge) || (runId && !await runContext(runId))) return;
    await cancelScheduled();
    await chrome.storage.session.remove('bridge');
    await chrome.storage.session.set({ status: { error: message, lastSentAt: null,
      lastReadAt: null, hasData: false, source: null } });
    for (const controller of requests) controller.abort();
    await stopCollector(bridge.tabId);
  });
}

async function post(snapshot, bridge, runId = null) {
  const status = patch => serial(async () => {
    if (!runId || await runContext(runId)) await patchStatus(bridge, patch);
  });
  if (!await sameSession(bridge) || (runId && !await runContext(runId))) return { ok: false, message: '配对已变更，请重新读取。' };
  const controller = new AbortController();
  requests.add(controller);
  const seq = ++postSequence;
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST', mode: 'cors', credentials: 'omit', redirect: 'error',
      cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Orb-Key': bridge.secret },
      body: JSON.stringify(snapshot)
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        const message = '配对已失效，已停止读取并清除配对码。请从悬浮球复制新码。';
        await invalidate(bridge, message, runId);
        return { ok: false, stop: true, message };
      }
      if (response.status === 429) throw new Error('发送过于频繁，请稍后重新读取。');
      throw new Error(`悬浮球未接受这次数据（${response.status}）。`);
    }
    const hasData = hasMetrics(snapshot);
    if (seq === postSequence) await status({ error: '', lastSentAt: Date.now(),
      lastReadAt: snapshot.capturedAt, hasData, source: snapshot.source });
    return { ok: true, hasData };
  } catch (error) {
    const message = error instanceof TypeError || error?.name === 'AbortError'
      ? '无法连接本机悬浮球。请先启动程序；若浏览器询问本地网络权限，请确认目标为 127.0.0.1。'
      : String(error.message || '同步失败。');
    if (seq === postSequence) await status({ error: message });
    return { ok: false, message };
  } finally {
    clearTimeout(timeout);
    requests.delete(controller);
  }
}

// Only numeric preferences are durable. Pairing, enabled state and owned tabs live
// in storage.session, so a browser restart cannot silently resume account access.
async function autoState() {
  return (await chrome.storage.session.get('autoRefresh')).autoRefresh || null;
}

async function closeOwnedTab(run) {
  if (!run || !Number.isInteger(run.tabId) || run.claimed || activatedTabs.has(run.tabId)) return;
  try {
    const tab = await chrome.tabs.get(run.tabId);
    // Recheck at cleanup time. Never close a user's active or navigated tab.
    if (tab.active === false && isUsagePage(tab.url) && !activatedTabs.has(run.tabId)) {
      await chrome.tabs.remove(run.tabId);
    }
  } catch {}
}

async function cancelScheduled(error = '') {
  clearTimeout(hydrationTimer);
  hydrationTimer = null;
  activeTask = null;
  const run = (await chrome.storage.session.get('autoRun')).autoRun;
  const state = await autoState();
  await chrome.alarms.clear(PERIOD_ALARM);
  await chrome.alarms.clear(TIMEOUT_ALARM);
  if (run) await chrome.storage.session.remove('autoRun');
  if (state) await chrome.storage.session.set({ autoRefresh: { ...state, enabled: false,
    nextRunAt: null, error } });
  for (const controller of requests) controller.abort();
  await closeOwnedTab(run);
}

async function runContext(id) {
  const bridge = await session();
  const state = await autoState();
  const run = (await chrome.storage.session.get('autoRun')).autoRun;
  if (!validBridge(bridge) || bridge.mode !== 'scheduled' || !state?.enabled ||
      !run || run.id !== id || run.generation !== bridge.generation) return null;
  return { bridge, state, run };
}

async function updateRun(id, patch) {
  return serial(async () => {
    const context = await runContext(id);
    if (!context) return false;
    await chrome.storage.session.set({ autoRun: { ...context.run, ...patch } });
    return true;
  });
}

async function finishRun(id, error = '') {
  await serial(async () => {
    const context = await runContext(id);
    if (!context) return;
    clearTimeout(hydrationTimer);
    hydrationTimer = null;
    await chrome.storage.session.remove('autoRun');
    await chrome.alarms.clear(TIMEOUT_ALARM);
    for (const controller of requests) controller.abort();
    await chrome.storage.session.set({ autoRefresh: { ...context.state, error } });
    if (error) await patchStatus(context.bridge, { error });
    await closeOwnedTab(context.run);
  });
}

async function pauseRun(id, error) {
  await serial(async () => {
    const context = await runContext(id);
    if (!context) return;
    // Login redirects and user navigation can leave a useful page behind. Stop
    // the schedule instead of producing a new login/home tab every interval.
    await chrome.storage.session.set({ autoRun: { ...context.run, claimed: true } });
    await cancelScheduled(error);
    const next = { ...context.bridge, mode: 'manual', tabId: null, generation: generation() };
    await chrome.storage.session.set({ bridge: next });
    await patchStatus(next, { error });
  });
}

async function permitted() { return chrome.permissions.contains(HOST_PERMISSION); }

async function revokeSchedule() {
  await serial(async () => {
    const bridge = await session();
    const state = await autoState();
    const run = (await chrome.storage.session.get('autoRun')).autoRun;
    // An explicit stop may deliberately remove the grant immediately after it
    // stops the schedule. Do not turn that successful action into an error.
    if (!state?.enabled && bridge?.mode !== 'scheduled' && !run) return;
    await cancelScheduled('官方网页权限已撤回，定时刷新已停止。');
    if (bridge?.mode === 'scheduled') await chrome.storage.session.set({
      bridge: { ...bridge, mode: 'manual', tabId: null, generation: generation() }
    });
  });
}

async function beginRun() {
  // Called in the control queue, but page and network waits run outside it.
  const bridge = await session();
  const state = await autoState();
  if (!validBridge(bridge) || bridge.mode !== 'scheduled' || !state?.enabled) return;
  if (!await permitted()) {
    await cancelScheduled('请重新允许访问官方网页，再启用定时刷新。');
    await chrome.storage.session.set({ bridge: { ...bridge, mode: 'manual', generation: generation() } });
    return;
  }
  if ((await chrome.storage.session.get('autoRun')).autoRun) return;
  const now = Date.now();
  const run = { id: generation(), generation: bridge.generation, tabId: null,
    claimed: false, phase: 'creating', deadline: now + RUN_TIMEOUT, hydrationUntil: null };
  await chrome.storage.session.set({ autoRun: run,
    autoRefresh: { ...state, lastAttemptAt: now, error: '' } });
  await chrome.alarms.create(TIMEOUT_ALARM, { when: run.deadline });
  launchRun(run.id, true);
}

function launchRun(id, allowCreate = false) {
  if (activeTask?.id === id) return;
  const task = { id };
  activeTask = task;
  // A microtask starts after the queued state mutation has completed.
  Promise.resolve().then(() => collectRun(id, allowCreate)).catch(() =>
    finishRun(id, '本轮刷新未完成，已保留上次读数；稍后将按设定间隔重试。')
  ).finally(() => { if (activeTask === task) activeTask = null; });
}

function initialNavigation(run, tab) {
  return run.phase === 'loading' && !run.sawUsagePage && tab.status !== 'complete' &&
    (!tab.url || tab.url === 'about:blank') && (!tab.pendingUrl || isUsagePage(tab.pendingUrl));
}

function retryRun(id) {
  clearTimeout(hydrationTimer);
  hydrationTimer = setTimeout(() => { hydrationTimer = null; launchRun(id); }, 1000);
}

async function collectRun(id, allowCreate) {
  let context = await runContext(id);
  if (!context) return;
  if (!await permitted()) { await revokeSchedule(); return; }
  if (Date.now() >= context.run.deadline) {
    await finishRun(id, '本轮读取超时，已保留上次读数；请检查官方页面是否需要登录。'); return;
  }
  if (!Number.isInteger(context.run.tabId)) {
    if (!allowCreate) { await finishRun(id, '上次刷新被中断，已保留上次读数；下个周期将重试。'); return; }
    const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    if (!await runContext(id)) return;
    const normal = windows.filter(window => window.type === 'normal' && !window.incognito && Number.isInteger(window.id));
    const window = normal.find(item => item.focused) || normal[0];
    if (!window) { await finishRun(id, '没有可用的普通浏览器窗口。请打开浏览器后再刷新。'); return; }
    const tab = await chrome.tabs.create({ windowId: window.id, url: USAGE_URL, active: false });
    if (!Number.isInteger(tab?.id)) { await finishRun(id, '无法打开后台用量页，已保留上次读数。'); return; }
    if (!await updateRun(id, { tabId: tab.id, phase: 'loading',
      claimed: tab.active !== false || activatedTabs.has(tab.id) })) {
      await closeOwnedTab({ tabId: tab.id, claimed: tab.active !== false }); return;
    }
    context = await runContext(id);
    if (!context) return;
  }
  let tab;
  try { tab = await chrome.tabs.get(context.run.tabId); }
  catch { await finishRun(id, '后台用量页已关闭，本轮读取已取消。'); return; }
  if (!await runContext(id)) return;
  if (initialNavigation(context.run, tab)) { retryRun(id); return; }
  if (!isUsagePage(tab.url)) {
    await pauseRun(id, '后台页面已离开用量页，定时刷新已暂停。请在官网完成登录后重新启用。'); return;
  }
  if (!context.run.sawUsagePage && !await updateRun(id, { sawUsagePage: true })) return;
  if (tab.status !== 'complete') {
    // The alarm is the durable deadline; this short poll also covers an onUpdated
    // event racing the final microtask of the preceding attempt.
    retryRun(id);
    return;
  }
  if (!context.run.hydrationUntil) {
    if (!await updateRun(id, { phase: 'collecting', hydrationUntil: Date.now() + HYDRATION_TIMEOUT })) return;
  }
  if (!await runContext(id) || !await permitted()) return;
  await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] },
    world: 'ISOLATED', files: ['parser.js'] });
  if (!await runContext(id)) return;
  tab = await chrome.tabs.get(tab.id);
  if (!isUsagePage(tab.url)) { await pauseRun(id, '页面已离开官方用量页，定时刷新已暂停；请确认登录后重新启用。'); return; }
  const results = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] },
    world: 'ISOLATED', func: () => {
      const parser = globalThis.OrbPageParser;
      if (!parser?.allowedLocation(location)) return null;
      return parser.collect(document, location);
    } });
  context = await runContext(id);
  if (!context || !await permitted()) return;
  tab = await chrome.tabs.get(tab.id);
  if (!isUsagePage(tab.url) || !await runContext(id)) {
    await pauseRun(id, '页面已离开官方用量页，定时刷新已暂停；请确认登录后重新启用。'); return;
  }
  const result = results?.find(item => item.frameId === 0)?.result;
  const snapshot = result ? cleanSnapshot(result, 'official-page') : null;
  if (!snapshot || !hasMetrics(snapshot)) {
    if (Date.now() >= context.run.hydrationUntil) {
      await finishRun(id, '未识别到用量数值，已保留上次读数。请检查登录状态或页面布局。'); return;
    }
    retryRun(id);
    return;
  }
  if (!await updateRun(id, { phase: 'posting' }) || !await runContext(id)) return;
  const response = await post(snapshot, context.bridge, id);
  await finishRun(id, response.ok ? '' : response.message || '本轮同步失败，已保留上次读数。');
}

async function reconcileSchedule() {
  await ready;
  const bridge = await session();
  const state = await autoState();
  const run = (await chrome.storage.session.get('autoRun')).autoRun;
  if (!validBridge(bridge) || bridge.mode !== 'scheduled' || !state?.enabled || !validMinutes(state.minutes)) {
    if (state?.enabled || run) await cancelScheduled();
    else {
      for (const name of [PERIOD_ALARM, TIMEOUT_ALARM]) if (await chrome.alarms.get(name)) await chrome.alarms.clear(name);
    }
    return;
  }
  if (!await permitted()) {
    await cancelScheduled('官方网页权限已撤回，定时刷新已停止。');
    await chrome.storage.session.set({ bridge: { ...bridge, mode: 'manual', tabId: null, generation: generation() } });
    return;
  }
  let alarm = await chrome.alarms.get(PERIOD_ALARM);
  if (!alarm || alarm.periodInMinutes !== state.minutes) {
    const nextRunAt = Number.isFinite(state.nextRunAt) && state.nextRunAt > Date.now()
      ? state.nextRunAt : Date.now() + state.minutes * 60000;
    await chrome.alarms.create(PERIOD_ALARM, { when: nextRunAt, periodInMinutes: state.minutes });
    alarm = { scheduledTime: nextRunAt };
  }
  if (state.nextRunAt !== alarm.scheduledTime) await chrome.storage.session.set({
    autoRefresh: { ...state, nextRunAt: alarm.scheduledTime }
  });
  if (run && run.generation === bridge.generation && Number.isFinite(run.deadline)) {
    await chrome.alarms.create(TIMEOUT_ALARM, { when: Math.max(Date.now() + 1000, run.deadline) });
    launchRun(run.id);
  } else if (run) {
    await chrome.storage.session.remove('autoRun');
    await chrome.alarms.clear(TIMEOUT_ALARM);
    await closeOwnedTab(run);
  } else if (await chrome.alarms.get(TIMEOUT_ALARM)) await chrome.alarms.clear(TIMEOUT_ALARM);
}

async function popupMessage(message) {
  if (message.type === 'orb:status') {
    const bridge = await session();
    const status = (await chrome.storage.session.get('status')).status || {};
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabState = usageTabState(tab);
    const state = await autoState();
    const local = await chrome.storage.local.get('autoRefreshMinutes');
    const run = (await chrome.storage.session.get('autoRun')).autoRun;
    return { ok: true, paired: Boolean(bridge), mode: bridge?.mode || null,
      autoRefresh: { enabled: Boolean(state?.enabled && bridge?.mode === 'scheduled'),
        minutes: validMinutes(state?.minutes) ? state.minutes : validMinutes(local.autoRefreshMinutes) ? local.autoRefreshMinutes : 5,
        nextRunAt: state?.nextRunAt || null, lastAttemptAt: state?.lastAttemptAt || null,
        running: Boolean(run && state?.enabled), error: state?.error || '' },
      tabState, onUsagePage: tabState === 'usage-page', sameTab: Boolean(bridge && bridge.tabId === tab?.id),
      lastSentAt: status.lastSentAt || null, lastReadAt: status.lastReadAt || null,
      hasData: Boolean(status.hasData), source: status.source || null, error: status.error || '' };
  }
  if (message.type === 'orb:auto-start') {
    if (!validMinutes(message.minutes)) throw new Error('刷新间隔应为 1 至 1440 的整数分钟。');
    const old = await session();
    let secret = old?.secret;
    if (message.code !== undefined && message.code !== '') {
      const match = typeof message.code === 'string' && CODE.exec(message.code.trim());
      if (!match) throw new Error('配对码格式错误，请从悬浮球重新复制。');
      secret = match[1];
    }
    if (!validBridge({ secret })) throw new Error('请先输入悬浮球的配对码。');
    if (!await permitted()) throw new Error('请先允许扩展访问官方网页，才能在后台定时刷新。');
    await cancelScheduled();
    await stopCollector(old?.tabId);
    const now = Date.now();
    const bridge = { secret, tabId: null, mode: 'scheduled', generation: generation() };
    await chrome.storage.local.set({ autoRefreshMinutes: message.minutes });
    await chrome.storage.session.set({ bridge, autoRefresh: { enabled: true, minutes: message.minutes,
      nextRunAt: now + message.minutes * 60000, lastAttemptAt: null, error: '' } });
    await chrome.alarms.create(PERIOD_ALARM, { when: now + message.minutes * 60000, periodInMinutes: message.minutes });
    await beginRun();
    return { ok: true };
  }
  if (message.type === 'orb:auto-stop') {
    const old = await session();
    await cancelScheduled();
    if (old?.mode === 'scheduled') await chrome.storage.session.set({
      bridge: { ...old, mode: 'manual', tabId: null, generation: generation() }
    });
    return { ok: true };
  }
  if (message.type === 'orb:auto-refresh') {
    const bridge = await session();
    if (!validBridge(bridge) || bridge.mode !== 'scheduled' || !(await autoState())?.enabled) {
      throw new Error('请先启用定时刷新。');
    }
    await beginRun();
    return { ok: true };
  }
  if (message.type === 'orb:start') {
    const match = typeof message.code === 'string' && CODE.exec(message.code.trim());
    if (!match) throw new Error('配对码格式错误，请从悬浮球重新复制。');
    const tab = await currentUsageTab();
    const old = await session();
    await cancelScheduled();
    await stopCollector(old?.tabId);
    const bridge = { secret: match[1], tabId: tab.id, mode: 'automatic', generation: generation() };
    await chrome.storage.session.set({ bridge, status: { error: '', lastSentAt: null,
      lastReadAt: null, hasData: false, source: null } });
    try { await inject(tab.id); }
    catch { await patchStatus(bridge, { error: '无法读取该页面。请刷新官方用量页，再点击“重新读取页面”。' }); throw new Error('无法读取该页面，请刷新官方用量页后重试。'); }
    return { ok: true };
  }
  if (message.type === 'orb:stop') {
    const old = await session();
    await cancelScheduled();
    await chrome.storage.session.remove(['bridge', 'status']);
    ++postSequence;
    for (const controller of requests) controller.abort();
    await stopCollector(old?.tabId);
    return { ok: true };
  }
  if (message.type === 'orb:refresh') {
    const bridge = await session();
    if (!bridge) throw new Error('请先输入悬浮球的配对码。');
    const tab = await currentUsageTab();
    await cancelScheduled();
    if (tab.id !== bridge.tabId) await stopCollector(bridge.tabId);
    for (const controller of requests) controller.abort();
    const next = { ...bridge, tabId: tab.id, mode: 'automatic', generation: generation() };
    await chrome.storage.session.set({ bridge: next });
    await inject(tab.id);
    return { ok: true };
  }
  if (message.type === 'orb:manual') {
    const bridge = await session();
    if (!bridge) throw new Error('请先输入悬浮球的配对码。');
    const tab = await currentUsageTab();
    const snapshot = cleanSnapshot(message.snapshot, 'manual-page');
    if (!snapshot.windows.length && snapshot.tokens.total === null && snapshot.tokens.today === null) {
      throw new Error('请至少输入一个页面显示的数值。');
    }
    await cancelScheduled();
    await stopCollector(bridge.tabId);
    const next = { ...bridge, tabId: tab.id, mode: 'manual', generation: generation() };
    await chrome.storage.session.set({ bridge: next });
    return { deferred: () => post(snapshot, next) };
  }
  throw new Error('不支持的操作。');
}

async function contentMessage(message, sender) {
  if (sender.frameId !== 0 || !sender.tab || !isUsagePage(sender.url) || !isUsagePage(sender.tab.url)) {
    throw new Error('页面来源不符合要求。');
  }
  const bridge = await session();
  if (!bridge || bridge.mode !== 'automatic' || bridge.tabId !== sender.tab.id) return { ok: false, stop: true };
  // Recheck live tab URL; a queued message must not survive navigation to another route.
  const tab = await chrome.tabs.get(sender.tab.id);
  if (!isUsagePage(tab.url)) return { ok: false, stop: true };
  if (message.type === 'orb:page-left') {
    await setStatus(bridge, { error: '已离开官方用量页，自动读取已停止。' });
    return { ok: true, stop: true };
  }
  if (message.type !== 'orb:snapshot') throw new Error('不支持的页面消息。');
  return post(cleanSnapshot(message.snapshot, 'official-page'), bridge);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message.type !== 'string') return false;
  const fromPopup = sender.url === POPUP_URL && (sender.frameId === undefined || sender.frameId === 0) &&
    (sender.origin === undefined || sender.origin === `chrome-extension://${chrome.runtime.id}`);
  let work;
  if (fromPopup && message.type !== 'orb:status') {
    work = serial(() => popupMessage(message));
  } else {
    work = controls.then(() => fromPopup ? popupMessage(message) : contentMessage(message, sender));
  }
  work.then(result => result?.deferred ? result.deferred() : result).then(sendResponse).catch(error => sendResponse({ ok: false, message: String(error.message || '操作失败。') }));
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
  serial(async () => {
    const run = (await chrome.storage.session.get('autoRun')).autoRun;
    if (run?.tabId === tabId) return { runId: run.id };
    const bridge = await session();
    if (bridge?.tabId === tabId) await patchStatus(bridge, { error: '官方用量页已关闭。重新打开后点击“重新读取页面”。' });
  }).then(result => { if (result) return finishRun(result.runId, '后台用量页已关闭，本轮读取已取消。'); }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  serial(async () => {
    const run = (await chrome.storage.session.get('autoRun')).autoRun;
    if (run?.tabId === tabId) {
      if (change.url && !isUsagePage(change.url)) {
        let tab;
        try { tab = await chrome.tabs.get(tabId); } catch { return { cancel: run.id }; }
        if (initialNavigation(run, tab)) return;
        // A navigation event permanently relinquishes ownership, even if the
        // user immediately returns to the usage route before cleanup runs.
        await chrome.storage.session.set({ autoRun: { ...run, claimed: true } });
        for (const controller of requests) controller.abort();
        return { pause: run.id };
      }
      if (change.status === 'complete') return { resume: run.id };
    }
    if (!change.url) return;
    const bridge = await session();
    if (bridge?.tabId !== tabId || isUsagePage(change.url)) return;
    await stopCollector(tabId);
    await patchStatus(bridge, { error: '已离开官方用量页，自动读取已停止。' });
  }).then(result => {
    if (result?.pause) return pauseRun(result.pause, '后台页面已离开用量页，定时刷新已暂停。请在官网完成登录后重新启用。');
    if (result?.cancel) return finishRun(result.cancel, '后台用量页已关闭，本轮读取已取消。');
    if (result?.resume) launchRun(result.resume);
  }).catch(() => {});
});

chrome.tabs.onActivated.addListener(info => {
  activatedTabs.add(info.tabId);
  // Only a currently owned tab can become relevant to cleanup. Retain a small
  // recent set to cover activation between tabs.create and its session write.
  if (activatedTabs.size > 256) activatedTabs.delete(activatedTabs.values().next().value);
  serial(async () => {
    const run = (await chrome.storage.session.get('autoRun')).autoRun;
    if (run?.tabId === info.tabId) await chrome.storage.session.set({ autoRun: { ...run, claimed: true } });
  }).catch(() => {});
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === PERIOD_ALARM) {
    serial(async () => {
      const state = await autoState();
      if (!state?.enabled) { await chrome.alarms.clear(PERIOD_ALARM); return; }
      const nextRunAt = Date.now() + state.minutes * 60000;
      await chrome.storage.session.set({ autoRefresh: { ...state, nextRunAt } });
      await beginRun();
    }).catch(() => {});
  } else if (alarm.name === TIMEOUT_ALARM) {
    serial(async () => (await chrome.storage.session.get('autoRun')).autoRun).then(run => {
      if (!run) return;
      if (Date.now() >= run.deadline) return finishRun(run.id, '本轮读取超时，已保留上次读数；请检查官方页面是否需要登录。');
      launchRun(run.id);
    }).catch(() => {});
  }
});

chrome.permissions.onRemoved.addListener(() => {
  permitted().then(granted => { if (!granted) return revokeSchedule(); }).catch(() => {});
});

// Reconcile on every service-worker load, including after an idle termination.
// A browser restart empties storage.session; persisted alarms are then removed.
serial(reconcileSchedule).catch(() => {});
