'use strict';

// Owns only the explicit, user-initiated managed connection lifecycle. Merely
// constructing this object or restoring its display state never downloads,
// opens a browser or reads an account.
const MESSAGES = Object.freeze({
  error:'连接未完成，请稍后重试。',
  unsupported:'当前系统或官方组件暂不支持一键连接。',
  busy:'另一项连接操作正在完成，请稍候。',
  network:'官方组件下载未完成，请检查网络后重试。',
  timeout:'连接等待超时，请重试。',
  integrity:'官方组件校验未通过，请重新连接。',
  storage:'无法安全保存官方组件，请检查应用数据目录。',
  missing:'官方连接组件不可用，请重新连接。',
  'not-found':'官方连接组件不可用，请重新连接。',
  protocol:'官方组件的响应未通过校验，请重新连接。',
  'login-busy':'另一项 Codex 登录正在进行，请完成或关闭后重试。',
  'browser-failed':'未能打开官方登录页，请检查默认浏览器后重试。',
  'auth-failed':'登录未完成，或系统凭据库不可用，请重新连接。',
  'logout-failed':'退出登录未完成，登录信息可能仍在本机，请重试。',
  cancelled:'已取消连接。',
  stopped:'应用正在退出。'
});

const codeOf = error => typeof error?.code === 'string' && Object.hasOwn(MESSAGES, error.code) ? error.code : 'error';
const result = code => code ? {ok:false, error:MESSAGES[code] || MESSAGES.error, code} : {ok:true};
const cancelled = () => Object.assign(new Error(MESSAGES.cancelled), {code:'cancelled'});

class CodexSetup {
  constructor({runtime, login, logout, codexHome, cwd, openExternal, onState = () => {}, onDisconnect = () => {}, onConnected = () => {}} = {}) {
    if (typeof runtime?.ensureReady !== 'function' || typeof runtime?.getVerifiedExecutable !== 'function' ||
        typeof login !== 'function' || typeof logout !== 'function' || typeof openExternal !== 'function' ||
        typeof onState !== 'function' || typeof onDisconnect !== 'function' || typeof onConnected !== 'function') {
      throw new TypeError('Managed Codex connection dependencies required');
    }
    this.runtime = runtime;
    this.login = login;
    this.logoutAdapter = logout;
    this.codexHome = codexHome;
    this.cwd = cwd;
    this.openExternal = openExternal;
    this.onState = onState;
    this.onDisconnect = onDisconnect;
    this.onConnected = onConnected;
    this._status = {status:'idle', progress:null, message:''};
    this._operation = null;
    this._generation = 0;
    this._stopped = false;
  }

  get busy() { return this._operation !== null; }

  getStatus() { return {...this._status}; }

  _setStatus(status, message = '', progress = null) {
    if (this._stopped) return;
    const next = {status, progress, message};
    if (Object.keys(next).every(key => next[key] === this._status[key])) return;
    this._status = next;
    // UI publication must not prevent cleanup or leak an exception's contents.
    try { this.onState(this.getStatus()); } catch {}
  }

  _active(operation) {
    return !this._stopped && this._operation === operation && this._generation === operation.generation && !operation.controller.signal.aborted;
  }

  _assertActive(operation) { if (!this._active(operation)) throw cancelled(); }

  _progress(operation, value) {
    if (!this._active(operation) || !value || typeof value !== 'object') return;
    const messages = {
      checking:'正在检查官方组件…', downloading:'正在下载官方连接组件…',
      verifying:'正在验证官方组件…', installing:'正在准备官方组件…'
    };
    if (!Object.hasOwn(messages, value.phase)) return;
    const percent = value.phase === 'downloading' && Number.isFinite(value.percent)
      ? Math.max(0, Math.min(100, Math.floor(value.percent))) : null;
    this._setStatus('preparing', messages[value.phase], percent);
  }

  _authStatus(operation, value) {
    if (!this._active(operation)) return;
    if (value?.status === 'waiting') this._setStatus('waiting-login', '请在浏览器完成官方登录。');
    else if (value?.status === 'preparing') this._setStatus('preparing', '正在连接 Codex…');
    // A notification alone never confirms success. Await the adapter's result
    // and the final generation check before enabling quota reads.
  }

  _start(kind, action) {
    if (this._stopped) return Promise.resolve(result('stopped'));
    if (this._operation) return this._operation.kind === kind ? this._operation.promise : Promise.resolve(result('busy'));
    const operation = {kind, generation:++this._generation, controller:new AbortController(), cleanupController:null, promise:null, cancelled:false, connectedHookStarted:false, authenticated:false, executable:null};
    this._operation = operation;
    // Schedule work only after storing the shared promise. Duplicate clicks and
    // callbacks which re-enter connect/cancel observe the same operation.
    operation.promise = Promise.resolve().then(async () => {
      try {
        this._assertActive(operation);
        await this.onDisconnect();
        this._assertActive(operation);
        await action(operation);
        this._assertActive(operation);
        return result();
      } catch (error) {
        const aborted = operation.cancelled || operation.controller.signal.aborted || this._stopped;
        const cause = codeOf(error);
        // An aborted login can still fail to remove a racing credential. Keep
        // that actionable outcome instead of reporting a completed Cancel.
        let code = cause === 'logout-failed' ? cause : aborted ? 'cancelled' : kind === 'logout' ? 'logout-failed' : cause;
        if (!this._stopped && this._operation === operation) {
          if (operation.connectedHookStarted) {
            // onConnected is normally synchronous; this also handles an
            // injected asynchronous hook finishing after Cancel was pressed.
            try { await this.onDisconnect(); } catch {}
          }
        }
        if ((operation.cancelled || this._stopped) && operation.authenticated) {
          // The login adapter may already have removed its abort listener when
          // Cancel or Quit races its successful return. Complete managed-only
          // credential cleanup before retrying or finishing shutdown. This
          // bounded adapter call also runs after stop, without UI callbacks.
          try {
            operation.cleanupController = new AbortController();
            const cleared = await this.logoutAdapter({executable:operation.executable, codexHome:this.codexHome, cwd:this.cwd, signal:operation.cleanupController.signal});
            if (cleared?.connected !== false) code = 'logout-failed';
          } catch { code = 'logout-failed'; }
        }
        if (!this._stopped && this._operation === operation) {
          if (code === 'cancelled' && kind === 'connect') this._setStatus('idle', MESSAGES.cancelled);
          else this._setStatus('error', kind === 'logout' ? MESSAGES['logout-failed'] : MESSAGES[code]);
        }
        return result(code);
      } finally {
        if (this._operation === operation) this._operation = null;
      }
    });
    this._setStatus('preparing', kind === 'connect' ? '正在准备连接…' : '正在退出登录…');
    return operation.promise;
  }

  connect() {
    return this._start('connect', async operation => {
      const signal = operation.controller.signal;
      const executable = await this.runtime.ensureReady({signal, onProgress:value => this._progress(operation, value)});
      this._assertActive(operation);
      operation.executable = executable;
      const account = await this.login({executable, codexHome:this.codexHome, cwd:this.cwd, signal,
        openExternal:this.openExternal, onStatus:value => this._authStatus(operation, value)});
      operation.authenticated = account?.connected === true;
      this._assertActive(operation);
      if (account?.connected !== true) throw Object.assign(new Error(MESSAGES['auth-failed']), {code:'auth-failed'});
      operation.connectedHookStarted = true;
      await this.onConnected();
      this._assertActive(operation);
      this._setStatus('connected', '已连接 Codex。');
    });
  }

  cancel() {
    const operation = this._operation;
    if (!operation || this._stopped) return Promise.resolve(result());
    if (!operation.cancelled) {
      operation.cancelled = true;
      ++this._generation;
      this._setStatus('preparing', '正在取消，请稍候…');
      operation.controller.abort();
    }
    // The adapter owns official login cancellation and its managed-only logout
    // race cleanup. Keep busy until that cleanup has finished; do not start a
    // second browser login which the old cleanup might then log out.
    return operation.promise.then(outcome => outcome.code === 'logout-failed' ? outcome : result());
  }

  logout() {
    return this._start('logout', async operation => {
      const signal = operation.controller.signal;
      const executable = await this.runtime.getVerifiedExecutable({signal});
      this._assertActive(operation);
      if (!executable) throw Object.assign(new Error(MESSAGES.missing), {code:'missing'});
      const account = await this.logoutAdapter({executable, codexHome:this.codexHome, cwd:this.cwd, signal});
      this._assertActive(operation);
      if (account?.connected !== false) throw Object.assign(new Error(MESSAGES['logout-failed']), {code:'logout-failed'});
      this._setStatus('idle', '已退出登录。');
    });
  }

  markConnected() {
    if (this._stopped || this.busy) return false;
    this._setStatus('connected', '已连接 Codex。');
    return true;
  }

  stop() {
    if (!this._stopped) {
      this._stopped = true;
      ++this._generation;
      this._operation?.controller.abort();
    }
    // Main waits for official cancellation/child cleanup before quitting.
    // Repeated shutdown calls observe the same outstanding work.
    return this._operation?.promise || Promise.resolve(result());
  }
}

module.exports = {CodexSetup};
