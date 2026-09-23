'use strict';

const {spawn} = require('node:child_process');
const {createHash} = require('node:crypto');
const path = require('node:path');
const {StringDecoder} = require('node:string_decoder');

// No renderer-controlled method, command, arguments, URL or credentials reach this adapter.
const METHODS = new Set(['initialize', 'account/read', 'account/rateLimits/read', 'account/usage/read']);
const MAX_LINE_BYTES = 512 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
const MAX_MESSAGES = 512;
const MAX_WINDOWS = 32;
const MESSAGES = Object.freeze({
  disabled: '本机 Codex 自动刷新已关闭。',
  reading: '正在通过本机官方 Codex 查询用量…',
  ready: '已从本机 Codex 获取账号用量。',
  'not-found': '未找到官方 Codex CLI。请先安装，再点击立即刷新。',
  'needs-login': '请先在本机 Codex CLI 使用 ChatGPT 账号登录，再点击立即刷新。',
  unsupported: '当前 Codex CLI 不支持所需查询，请更新官方 Codex CLI 后重试。',
  error: '本次查询未成功，已保留上次有效读数；请稍后重试。',
  'account-changed': '检测到 Codex 账号变化，已清除旧账号读数；请重新刷新。',
  'empty-data': '服务暂未返回可识别的用量，已保留上次有效读数。',
  timeout: '本机 Codex 查询超时，已保留上次有效读数。',
  protocol: '本机 Codex 返回了无法验证的响应，已保留上次有效读数。',
  aborted: '本次查询已取消。'
});

class CodexReadError extends Error {
  constructor(code = 'error', {identity = null, accountIdentity = null, clear = false} = {}) {
    super(MESSAGES[code] || MESSAGES.error);
    this.name = 'CodexReadError';
    this.code = code;
    // These fields remain in the main process and are never part of status/snapshot.
    this.identity = identity;
    this.accountIdentity = accountIdentity;
    this.clear = clear;
  }
}

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function count(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function cleanText(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return text || fallback;
}
function timestamp(value) {
  return Number.isSafeInteger(value) && value >= 946684800 && value <= 4102444800 ? value * 1000 : null;
}
function validDate(value) {
  if (typeof value !== 'string' || !/^20\d\d-\d\d-\d\d$/.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? value : null;
}
function identityOf(response) {
  if (!record(response) || !own(response, 'account')) throw new CodexReadError('protocol');
  const account = response.account;
  if (account === null) throw new CodexReadError('needs-login', {clear:true});
  if (!record(account) || account.type !== 'chatgpt') throw new CodexReadError('needs-login', {clear:true});
  // Hash only the identity fields returned by the official read API, never auth files.
  const fields = ['id', 'accountId', 'chatgptAccountId', 'email'].flatMap(key => {
    const value = account[key];
    return typeof value === 'string' && value.length > 0 && value.length <= 512 ? [[key, value]] : [];
  });
  if (!fields.length) throw new CodexReadError('unsupported', {clear:true});
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}
function scopedIdentity(accountIdentity, limits) {
  // Newer CLI versions identify the workspace associated with the usage snapshot.
  const accountId = record(limits) ? limits.accountId : null;
  return typeof accountId === 'string' && accountId.length > 0 && accountId.length <= 512 ?
    createHash('sha256').update(JSON.stringify([accountIdentity, accountId])).digest('hex') : accountIdentity;
}
function windowLabel(name, slot, minutes) {
  const duration = minutes === null ? (slot === 'primary' ? '主窗口' : '次窗口') :
    minutes % 1440 === 0 ? `${minutes / 1440} 天` : minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
  return `${name} · ${duration}`;
}
function normalizeSnapshot(limits, usage, capturedAt) {
  if (!record(limits)) throw new CodexReadError('protocol');
  let buckets;
  if (record(limits.rateLimitsByLimitId) && Object.keys(limits.rateLimitsByLimitId).length) {
    buckets = Object.entries(limits.rateLimitsByLimitId);
    buckets.sort(([a], [b]) => a === 'codex' ? -1 : b === 'codex' ? 1 : a.localeCompare(b));
  } else buckets = [['codex', limits.rateLimits]];
  const windows = [];
  for (const [key, bucket] of buckets) {
    if (!record(bucket)) continue;
    const rawId = typeof bucket.limitId === 'string' ? bucket.limitId : key;
    const limitId = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(rawId) ? rawId : `bucket-${windows.length}`;
    const name = cleanText(bucket.limitName, limitId === 'codex' ? 'Codex' : limitId);
    for (const slot of ['primary', 'secondary']) {
      const window = bucket[slot];
      if (!record(window) || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100) continue;
      const duration = Number.isSafeInteger(window.windowDurationMins) && window.windowDurationMins > 0 && window.windowDurationMins <= 5256000 ? window.windowDurationMins : null;
      windows.push({id:`cli-${limitId}-${slot}`, kind:'cli', label:windowLabel(name, slot, duration), limitId,
        windowDurationMins:duration, usedPercent:window.usedPercent, resetAt:timestamp(window.resetsAt), resetApproximate:false});
      if (windows.length === MAX_WINDOWS) break;
    }
    if (windows.length === MAX_WINDOWS) break;
  }
  const total = record(usage) && record(usage.summary) ? count(usage.summary.lifetimeTokens) : null;
  let today = null;
  let tokenDate = null;
  if (record(usage) && Array.isArray(usage.dailyUsageBuckets)) {
    for (const bucket of usage.dailyUsageBuckets) {
      if (!record(bucket)) continue;
      const date = validDate(bucket.startDate);
      const tokens = count(bucket.tokens);
      if (date !== null && tokens !== null && (tokenDate === null || date > tokenDate)) { tokenDate = date; today = tokens; }
    }
  }
  const resetCredits = record(limits.rateLimitResetCredits) ? count(limits.rateLimitResetCredits.availableCount) : null;
  if (!windows.length && total === null && today === null && resetCredits === null) throw new CodexReadError('empty-data');
  return {version:2, source:'codex-cli', capturedAt, windows, tokens:{total, today}, tokenScope:'account', tokenDate, resetCredits};
}

/** A bounded JSONL connection used for one read, never an agent session. */
function connection({executable, cwd, signal, spawnImpl, timeoutMs}) {
  let child;
  let ended = false;
  let failure = null;
  let pending = null;
  let sequence = 0;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let messages = 0;
  let accountRead = false;
  let buffer = '';
  const decoder = new StringDecoder('utf8');
  let killTimer = null;
  let timeout = null;
  let exited = false;

  function stopChild() {
    if (!child) return;
    try { child.stdin.destroy(); } catch {}
    try { child.stdout.destroy(); } catch {}
    try { child.stderr.destroy(); } catch {}
    if (!exited) {
      try { child.kill('SIGTERM'); } catch {}
      if (!exited) {
        killTimer = setTimeout(() => { try { if (!exited) child.kill('SIGKILL'); } catch {} }, 500);
        killTimer.unref?.();
      }
    }
  }
  function finish(error = null) {
    if (ended) return;
    ended = true;
    failure = error;
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
    if (pending) { clearTimeout(pending.timer); pending.reject(error || new CodexReadError('aborted')); pending = null; }
    buffer = '';
    stopChild();
  }
  function onAbort() { finish(new CodexReadError('aborted')); }
  function fault(code = 'protocol') { finish(new CodexReadError(code)); }
  function receive(line) {
    if (ended) return;
    if (++messages > MAX_MESSAGES || Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) return fault();
    let message;
    try { message = JSON.parse(line); } catch { return fault(); }
    if (!record(message)) return fault();
    if (own(message, 'jsonrpc') && message.jsonrpc !== '2.0') return fault();
    if (own(message, 'method')) {
      // Server requests (approval, token refresh, execution, etc.) are not supported.
      if (own(message, 'id') || typeof message.method !== 'string' || message.method.length > 160 || own(message, 'result') || own(message, 'error')) return fault();
      if (accountRead && message.method === 'account/updated') return finish(new CodexReadError('account-changed', {clear:true}));
      return; // Bounded notifications do not change account identity or numeric data.
    }
    if (!pending || message.id !== pending.id || own(message, 'result') === own(message, 'error')) return fault();
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    if (own(message, 'error')) {
      if (!record(message.error) || !Number.isInteger(message.error.code)) { current.reject(new CodexReadError('protocol')); return fault(); }
      const code = message.error.code;
      const error = new CodexReadError(code === -32601 ? 'unsupported' : code === 401 || code === 403 ? 'needs-login' : 'error', {clear:code === 401 || code === 403});
      current.reject(error);
    } else {
      if (current.method === 'account/read') accountRead = true;
      current.resolve(message.result);
    }
  }
  function data(chunk) {
    if (ended) return;
    stdoutBytes += Buffer.byteLength(chunk);
    if (stdoutBytes > MAX_OUTPUT_BYTES) return fault();
    buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    let newline;
    while (!ended && (newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      receive(line);
    }
    if (Buffer.byteLength(buffer, 'utf8') > MAX_LINE_BYTES) fault();
  }
  function write(message) {
    if (ended) throw failure || new CodexReadError('aborted');
    try { child.stdin.write(`${JSON.stringify(message)}\n`, error => { if (error) fault('error'); }); }
    catch { fault('error'); throw failure; }
  }
  if (signal?.aborted) throw new CodexReadError('aborted');
  try {
    child = spawnImpl(executable, ['--disable', 'plugins', '--disable', 'remote_plugin', '--disable', 'hooks', 'app-server', '--strict-config'], {
      cwd, shell:false, windowsHide:true, stdio:['pipe', 'pipe', 'pipe'],
      // Per-process restrictions only; never overwrite Codex's persisted settings.
      env:{...process.env, CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED:'1'}
    });
  } catch (error) { throw new CodexReadError(error?.code === 'ENOENT' ? 'not-found' : 'error'); }
  if (!child?.stdin || !child?.stdout || !child?.stderr || typeof child.on !== 'function') { stopChild(); throw new CodexReadError('error'); }
  child.on('error', error => fault(error?.code === 'ENOENT' ? 'not-found' : 'error'));
  child.on('close', code => { exited = true; clearTimeout(killTimer); if (!ended) fault(code === 2 ? 'unsupported' : 'error'); });
  child.on('exit', code => { exited = true; clearTimeout(killTimer); if (!ended) fault(code === 2 ? 'unsupported' : 'error'); });
  child.stdin.on('error', () => fault('error'));
  child.stdout.on('error', () => fault('error'));
  child.stderr.on('error', () => fault('error'));
  child.stdout.on('data', data);
  child.stderr.on('data', chunk => { stderrBytes += Buffer.byteLength(chunk); if (stderrBytes > MAX_STDERR_BYTES) fault(); });
  signal?.addEventListener('abort', onAbort, {once:true});
  timeout = setTimeout(() => fault('timeout'), timeoutMs);
  if (signal?.aborted) onAbort();
  return {
    assertOpen() { if (ended) throw failure || new CodexReadError('aborted'); },
    request(method, params) {
      if (!METHODS.has(method)) return Promise.reject(new CodexReadError('protocol'));
      if (ended || pending) return Promise.reject(failure || new CodexReadError('protocol'));
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => fault('timeout'), Math.min(timeoutMs, method === 'account/usage/read' ? 5000 : 10000));
        pending = {id, method, resolve, reject, timer};
        try { write({id, method, ...(params === undefined ? {} : {params})}); }
        catch (error) { reject(error); }
      });
    },
    initialized() { write({method:'initialized', params:{}}); },
    close() { finish(); }
  };
}

async function readCodexUsage({executable, cwd, signal, spawnImpl = spawn, timeoutMs = 30000} = {}) {
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || /\.(?:bat|cmd|ps1|m?js|cjs)$/i.test(executable) || typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new CodexReadError('not-found');
  const channel = connection({executable, cwd, signal, spawnImpl, timeoutMs:Math.max(1, Math.min(60000, Number.isFinite(timeoutMs) ? timeoutMs : 30000))});
  let identity = null;
  let accountIdentity = null;
  try {
    const initialized = await channel.request('initialize', {clientInfo:{name:'gpt_usage_orb_safe', title:'GPT Usage Orb Safe', version:'2.5.2'}});
    channel.assertOpen();
    if (!record(initialized)) throw new CodexReadError('protocol');
    channel.initialized();
    accountIdentity = identityOf(await channel.request('account/read', {refreshToken:false}));
    const limits = await channel.request('account/rateLimits/read');
    identity = scopedIdentity(accountIdentity, limits);
    const quotaIdentity = identityOf(await channel.request('account/read', {refreshToken:false}));
    channel.assertOpen();
    if (quotaIdentity !== accountIdentity) throw new CodexReadError('account-changed', {accountIdentity:quotaIdentity, clear:true});
    let quotaSnapshot = null;
    try { quotaSnapshot = normalizeSnapshot(limits, null, Date.now()); }
    catch (error) { if (!(error instanceof CodexReadError) || error.code !== 'empty-data') throw error; }
    // Core quota is already verified. A slow/unsupported optional Token API must
    // not discard it; its capturedAt remains the earlier successful check time.
    try {
      const usage = await channel.request('account/usage/read');
      const tokenIdentity = identityOf(await channel.request('account/read', {refreshToken:false}));
      channel.assertOpen();
      if (tokenIdentity !== accountIdentity) throw new CodexReadError('account-changed', {accountIdentity:tokenIdentity, clear:true});
      return {snapshot:normalizeSnapshot(limits, usage, Date.now()), identity, accountIdentity};
    } catch (error) {
      if (quotaSnapshot && error instanceof CodexReadError && !error.clear && error.code !== 'aborted' && !signal?.aborted) return {snapshot:quotaSnapshot, identity, accountIdentity};
      throw error;
    }
  } catch (error) {
    const safe = error instanceof CodexReadError ? error : new CodexReadError('error');
    if (!safe.identity) safe.identity = identity;
    if (!safe.accountIdentity) safe.accountIdentity = accountIdentity;
    throw safe;
  } finally { channel.close(); }
}

function validMinutes(value) { return Number.isInteger(value) && value >= 1 && value <= 1440; }
class CodexProvider {
  #identity = null;
  #accountIdentity = null;
  #generation = 0;
  #active = null;
  #timer = null;
  constructor({discover, cwd, onState = () => {}, onSnapshot = () => {}, onClear = () => {}, intervalMinutes = 5, read = readCodexUsage, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
    if (typeof discover !== 'function') throw new TypeError('Codex discovery is required.');
    this.discover = discover;
    this.cwd = cwd;
    this.onState = onState;
    this.onSnapshot = onSnapshot;
    this.onClear = onClear;
    this.read = read;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.status = {enabled:false, running:false, state:'disabled', message:MESSAGES.disabled, lastSuccessAt:null, nextRunAt:null, intervalMinutes:validMinutes(intervalMinutes) ? intervalMinutes : 5};
  }
  getStatus() { return {...this.status}; }
  #emit() { this.onState(this.getStatus()); }
  #unschedule() { if (this.#timer !== null) this.clearTimer(this.#timer); this.#timer = null; this.status.nextRunAt = null; }
  #schedule() {
    this.#unschedule();
    if (!this.status.enabled) return;
    const generation = this.#generation;
    const delay = this.status.intervalMinutes * 60000;
    this.status.nextRunAt = this.now() + delay;
    this.#timer = this.setTimer(() => { this.#timer = null; if (generation === this.#generation && this.status.enabled) void this.refresh(); }, delay);
    this.#timer?.unref?.();
  }
  start(minutes = 5) {
    if (!validMinutes(minutes)) throw new RangeError('刷新间隔须为 1–1440 的整数分钟。');
    this.status.enabled = true;
    this.status.intervalMinutes = minutes;
    this.#unschedule();
    return this.refresh();
  }
  stop() {
    this.#generation++;
    this.status.enabled = false;
    this.#unschedule();
    const active = this.#active;
    this.#active = null;
    active?.controller.abort();
    this.status.running = false;
    this.status.state = 'disabled';
    this.status.message = MESSAGES.disabled;
    this.#emit();
    return this.getStatus();
  }
  refresh() {
    if (!this.status.enabled) return Promise.resolve(this.getStatus());
    if (this.#active) return this.#active.promise;
    const generation = this.#generation;
    const controller = new AbortController();
    const active = {controller, promise:null};
    this.#active = active;
    this.#unschedule();
    this.status.running = true;
    this.status.state = 'reading';
    this.status.message = MESSAGES.reading;
    const current = () => generation === this.#generation && this.#active === active && !controller.signal.aborted;
    active.promise = (async () => {
      // Yield so concurrent refresh() calls always receive the same assigned promise.
      await Promise.resolve();
      try {
        if (!current()) return this.getStatus();
        const executable = await this.discover();
        if (!current()) return this.getStatus();
        if (!executable || typeof executable.path !== 'string') throw new CodexReadError('not-found');
        const result = await this.read({executable:executable.path, cwd:this.cwd, signal:controller.signal});
        if (!current()) return this.getStatus();
        if (!result || !record(result.snapshot) || typeof result.identity !== 'string' || !/^[a-f0-9]{64}$/.test(result.identity)) throw new CodexReadError('protocol');
        if (this.#identity !== null && result.identity !== this.#identity) { this.onClear(); this.status.lastSuccessAt = null; }
        this.#identity = result.identity;
        this.#accountIdentity = typeof result.accountIdentity === 'string' ? result.accountIdentity : result.identity;
        this.onSnapshot(result.snapshot);
        this.status.lastSuccessAt = result.snapshot.capturedAt;
        this.status.state = 'ready';
        this.status.message = MESSAGES.ready;
      } catch (error) {
        if (!current()) return this.getStatus();
        const safe = error instanceof CodexReadError ? error : new CodexReadError('error');
        if (safe.clear || (safe.identity !== null && this.#identity !== null && safe.identity !== this.#identity) ||
          (safe.accountIdentity !== null && this.#accountIdentity !== null && safe.accountIdentity !== this.#accountIdentity)) {
          this.onClear();
          this.#identity = safe.identity;
          this.#accountIdentity = safe.accountIdentity;
          this.status.lastSuccessAt = null;
        }
        this.status.state = ['not-found', 'needs-login', 'unsupported'].includes(safe.code) ? safe.code : 'error';
        this.status.message = safe.message;
      } finally {
        if (current()) {
          this.#active = null;
          this.status.running = false;
          this.#schedule();
          this.#emit();
        }
      }
      return this.getStatus();
    })();
    this.#emit();
    return active.promise;
  }
}

module.exports = {readCodexUsage, CodexProvider};
