'use strict';

const PORT = 43861;
const ENDPOINT = `http://127.0.0.1:${PORT}/v1/usage`;
const POPUP_URL = chrome.runtime.getURL('popup.html');
const CODE = /^GPTORB2\.43861\.([A-Za-z0-9_-]{43})$/;
const ready = chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
const requests = new Set();
let postSequence = 0;
let controls = Promise.resolve();

function isUsagePage(value) {
  try {
    const u = new URL(value);
    return u.origin === 'https://chatgpt.com' && !u.username && !u.password &&
      (u.pathname === '/codex/settings/usage' || u.pathname === '/codex/settings/usage/');
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
  return now && now.secret === bridge.secret && now.tabId === bridge.tabId && now.mode === bridge.mode;
}

async function setStatus(bridge, patch) {
  if (!await sameSession(bridge)) return;
  const old = (await chrome.storage.session.get('status')).status || {};
  await chrome.storage.session.set({ status: { ...old, ...patch } });
}

async function currentUsageTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  switch (usageTabState(tab)) {
    case 'no-tab':
      throw new Error('未找到当前标签页。请切回浏览器中的官方 Codex 用量页，再点击工具栏中的扩展图标。');
    case 'url-unavailable':
      throw new Error('无法读取当前标签页地址。请关闭此面板，在官方 Codex 用量页点击浏览器工具栏中的扩展图标，授予本次页面访问权限。');
    case 'unsupported-page':
      throw new Error('当前标签页不是支持的官方 Codex 用量页。请打开上方的官方用量页链接，再从该标签页点击工具栏中的扩展图标。');
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

async function invalidate(bridge, message) {
  if (!await sameSession(bridge)) return;
  await chrome.storage.session.remove('bridge');
  await chrome.storage.session.set({ status: { error: message, lastSentAt: null,
    lastReadAt: null, hasData: false, source: null } });
  for (const controller of requests) controller.abort();
  await stopCollector(bridge.tabId);
}

async function post(snapshot, bridge) {
  if (!await sameSession(bridge)) return { ok: false, message: '配对已变更，请重新读取。' };
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
        await invalidate(bridge, message);
        return { ok: false, stop: true, message };
      }
      if (response.status === 429) throw new Error('发送过于频繁，请稍后重新读取。');
      throw new Error(`悬浮球未接受这次数据（${response.status}）。`);
    }
    const hasData = snapshot.windows.length > 0 || snapshot.tokens.total !== null || snapshot.tokens.today !== null;
    if (seq === postSequence) await setStatus(bridge, { error: '', lastSentAt: Date.now(),
      lastReadAt: snapshot.capturedAt, hasData, source: snapshot.source });
    return { ok: true, hasData };
  } catch (error) {
    const message = error instanceof TypeError || error?.name === 'AbortError'
      ? '无法连接本机悬浮球。请先启动程序；若浏览器询问本地网络权限，请确认目标为 127.0.0.1。'
      : String(error.message || '同步失败。');
    if (seq === postSequence) await setStatus(bridge, { error: message });
    return { ok: false, message };
  } finally {
    clearTimeout(timeout);
    requests.delete(controller);
  }
}

async function popupMessage(message) {
  if (message.type === 'orb:status') {
    const bridge = await session();
    const status = (await chrome.storage.session.get('status')).status || {};
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabState = usageTabState(tab);
    return { ok: true, paired: Boolean(bridge), mode: bridge?.mode || null,
      tabState, onUsagePage: tabState === 'usage-page', sameTab: Boolean(bridge && bridge.tabId === tab?.id),
      lastSentAt: status.lastSentAt || null, lastReadAt: status.lastReadAt || null,
      hasData: Boolean(status.hasData), source: status.source || null, error: status.error || '' };
  }
  if (message.type === 'orb:start') {
    const match = typeof message.code === 'string' && CODE.exec(message.code.trim());
    if (!match) throw new Error('配对码格式错误，请从悬浮球重新复制。');
    const tab = await currentUsageTab();
    const old = await session();
    await stopCollector(old?.tabId);
    for (const controller of requests) controller.abort();
    const bridge = { secret: match[1], tabId: tab.id, mode: 'automatic' };
    await chrome.storage.session.set({ bridge, status: { error: '', lastSentAt: null,
      lastReadAt: null, hasData: false, source: null } });
    try { await inject(tab.id); }
    catch { await setStatus(bridge, { error: '无法读取该页面。请刷新官方用量页，再点击“重新读取页面”。' }); throw new Error('无法读取该页面，请刷新官方用量页后重试。'); }
    return { ok: true };
  }
  if (message.type === 'orb:stop') {
    const old = await session();
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
    if (tab.id !== bridge.tabId) await stopCollector(bridge.tabId);
    for (const controller of requests) controller.abort();
    const next = { ...bridge, tabId: tab.id, mode: 'automatic' };
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
    await stopCollector(bridge.tabId);
    for (const controller of requests) controller.abort();
    const next = { ...bridge, tabId: tab.id, mode: 'manual' };
    await chrome.storage.session.set({ bridge: next });
    return await post(snapshot, next);
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
    work = controls.then(() => popupMessage(message));
    controls = work.catch(() => {});
  } else {
    work = fromPopup ? popupMessage(message) : contentMessage(message, sender);
  }
  work.then(sendResponse).catch(error => sendResponse({ ok: false, message: String(error.message || '操作失败。') }));
  return true;
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const bridge = await session();
  if (bridge?.tabId === tabId) await setStatus(bridge, { error: '官方用量页已关闭。重新打开后点击“重新读取页面”。' });
});

chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  if (!change.url) return;
  const bridge = await session();
  if (bridge?.tabId !== tabId || isUsagePage(change.url)) return;
  await stopCollector(tabId);
  await setStatus(bridge, { error: '已离开官方用量页，自动读取已停止。' });
});
