'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  UpdateSecurityError, compareVersions, validateConfig, verifyEnvelope,
  releaseBase, allowedUpdateUrl, validateUpdateInfo, fetchManifest, verifyInstaller,
  MAX_ENVELOPE,
} = require('./update-security.cjs');

const MESSAGES = {
  CONFIG: '更新发布源配置无效，已停止更新。', SIGNATURE: '更新签名不匹配，已拒绝下载。',
  VERSION: '更新版本格式无效，已停止更新。', DOWNGRADE: '检测到旧版本更新描述，已拒绝降级。',
  MANIFEST: '更新描述格式无效，已停止更新。', ENCODING: '更新签名编码无效，已停止更新。',
  MANIFEST_SIZE: '更新描述超出大小限制，已停止更新。', URL: '更新来源不在允许范围，已停止更新。',
  FEED_MISMATCH: '安装包信息与签名不一致，已拒绝更新。', INSTALLER: '安装包校验失败，已拒绝安装。',
  BACKUP: '无法备份本地设置，更新尚未安装。', CANCELLED: '更新检查已停止。',
  NETWORK: '无法获取更新，请检查网络后重试。', TIMEOUT: '更新请求超时，请稍后重试。',
};

class UpdateManager {
  constructor({ appVersion, config, userData, onState = () => {}, updater = null, fetchManifest: fetcher = fetchManifest }) {
    compareVersions(appVersion, appVersion);
    this.appVersion = appVersion;
    this.userData = userData;
    this.onState = onState;
    this.updater = updater;
    this.fetcher = fetcher;
    this.payload = null;
    this.downloadedFile = null;
    this.busy = null;
    this.stopped = false;
    this.installing = false;
    this.prepared = false;
    this.abort = null;
    this.cancellation = null;
    this.listeners = [];
    this.config = null;
    this.state = { status: 'unconfigured', currentVersion: appVersion, availableVersion: null,
      progress: null, message: '发布者尚未配置更新仓库和签名公钥。', lastCheckedAt: null, repository: null };
    try {
      this.config = validateConfig(config);
      if (this.config) Object.assign(this.state, { status: 'idle', repository: this.config.repository, message: '可检查程序更新。' });
    } catch { Object.assign(this.state, { status: 'error', message: MESSAGES.CONFIG }); }
  }
  snapshot() { return { ...this.state }; }
  _emit(patch) {
    if (this.stopped) return;
    Object.assign(this.state, patch);
    try { this.onState(this.snapshot()); } catch { /* A closed UI must not alter trust checks. */ }
  }
  _error(error) {
    this.downloadedFile = null;
    this.payload = null;
    this._emit({ status: 'error', progress: null, availableVersion: null,
      message: MESSAGES[error?.code] || '更新未完成，请稍后重试；当前版本仍可继续使用。' });
    return this.snapshot();
  }
  _assertRunning() {
    if (this.stopped || this.abort?.signal.aborted) throw new UpdateSecurityError('CANCELLED');
  }
  _prepareUpdater() {
    if (!this.updater) this.updater = require('electron-updater').autoUpdater;
    const updater = this.updater;
    // Pin both generations of the API. Never call checkForUpdatesAndNotify or
    // installPendingUpdateIfAvailable: they can install outside this verifier.
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.autoInstallEvent = 'manual';
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.disableWebInstaller = true;
    updater.disableDifferentialDownload = true;
    updater.autoRunAppAfterInstall = true;
    updater.requestHeaders = null;
    updater.logger = null;
    if (this.prepared) return updater;
    const progress = value => {
      if (this.payload && (value?.transferred > this.payload.size || value?.total > this.payload.size)) {
        this.cancellation?.cancel?.();
        return;
      }
      if (this.state.status === 'downloading' && Number.isFinite(value?.percent))
        this._emit({ progress: Math.max(0, Math.min(100, value.percent)) });
    };
    // electron-updater emits an error as well as rejecting operations. Keep an
    // error listener, but only our awaited operation may change trust state.
    const error = value => { if (this.installing && !this.stopped) { this.installing = false; this._error(value); } };
    updater.on('download-progress', progress);
    updater.on('error', error);
    this.listeners.push(['download-progress', progress], ['error', error]);
    // electron-updater owns this isolated network session. Apply the same host
    // fence to its YAML and installer requests, including every redirect.
    const webRequest = updater.netSession?.webRequest;
    if (webRequest) {
      webRequest.onBeforeRequest((details, callback) => {
        const p = this.payload;
        let allowed = false;
        if (!this.stopped && p) {
          const prefix = `/${this.config.repository}/releases/download/${p.tag}/`;
          allowed = allowedUpdateUrl(details.url, this.config.repository, `${prefix}latest.yml`) ||
            allowedUpdateUrl(details.url, this.config.repository, `${prefix}${p.file}`);
        }
        callback({ cancel: !allowed });
      });
      webRequest.onBeforeSendHeaders((details, callback) => {
        const headers = { ...details.requestHeaders };
        for (const name of Object.keys(headers))
          if (['cookie', 'authorization', 'proxy-authorization', 'x-user-staging-id'].includes(name.toLowerCase())) delete headers[name];
        callback({ requestHeaders: headers });
      });
      webRequest.onHeadersReceived((details, callback) => {
        // GitHub release assets have an explicit length. Fail closed if a
        // response could stream an unbounded body before the hash is checked.
        if ([301, 302, 303, 307, 308].includes(details.statusCode)) return callback({ cancel: false });
        const headers = Object.fromEntries(Object.entries(details.responseHeaders || {}).map(([k, v]) => [k.toLowerCase(), v]));
        const raw = headers['content-length'];
        const value = Array.isArray(raw) && raw.length === 1 ? raw[0] : typeof raw === 'string' ? raw : '';
        const size = /^\d+$/.test(value) ? Number(value) : NaN;
        const encoding = headers['content-encoding'];
        const plain = !encoding || (Array.isArray(encoding) && encoding.length === 1 && encoding[0] === 'identity');
        const validSize = this.state.status === 'downloading' ? size === this.payload?.size : size > 0 && size <= MAX_ENVELOPE;
        callback({ cancel: this.stopped || details.statusCode !== 200 || !Number.isSafeInteger(size) ||
          !validSize || !plain || Boolean(headers['transfer-encoding']) });
      });
    } else {
      throw new UpdateSecurityError('CONFIG');
    }
    this.prepared = true;
    return updater;
  }
  async check({ download = true } = {}) {
    if (!this.config || this.stopped || this.installing) return this.snapshot();
    if (this.busy) return this.busy;
    if (this.state.status === 'ready') return this.snapshot();
    this.busy = (async () => {
      this.abort = new AbortController();
      this.payload = null; this.downloadedFile = null;
      this._emit({ status: 'checking', message: '正在验证更新签名…', progress: null, availableVersion: null, lastCheckedAt: Date.now() });
      try {
        const body = await this.fetcher(`https://github.com/${this.config.repository}/releases/latest/download/orb-update.json`,
          { repository: this.config.repository, signal: this.abort.signal });
        this._assertRunning();
        const payload = verifyEnvelope(body, this.config);
        const relation = compareVersions(payload.version, this.appVersion);
        if (relation < 0) throw new UpdateSecurityError('DOWNGRADE');
        if (relation === 0) {
          this._emit({ status: 'idle', message: '当前已是最新版本。' });
          return this.snapshot();
        }
        this.payload = payload;
        const updater = this._prepareUpdater();
        updater.setFeedURL({ provider: 'generic', url: releaseBase(this.config.repository, payload), channel: 'latest', useMultipleRangeRequest: false });
        // Setting an updater channel may turn downgrades on internally.
        updater.allowDowngrade = false;
        const result = await updater.checkForUpdates();
        this._assertRunning();
        validateUpdateInfo(result?.updateInfo, this.config, payload);
        this.cancellation = result?.cancellationToken || null;
        this._emit({ status: 'idle', availableVersion: payload.version, message: `发现 ${payload.version}，更新签名已验证。` });
        if (download) return await this._download();
        return this.snapshot();
      } catch (error) { return this._error(error); }
      finally { this.abort = null; }
    })();
    try { return await this.busy; } finally { this.busy = null; }
  }
  async _download() {
    this._assertRunning();
    if (!this.payload) return this.snapshot();
    const payload = this.payload;
    const updater = this._prepareUpdater();
    this._emit({ status: 'downloading', progress: 0, message: `正在下载 ${payload.version}…` });
    const files = await updater.downloadUpdate(this.cancellation || undefined);
    this._assertRunning();
    if (!Array.isArray(files) || files.length !== 1 || typeof files[0] !== 'string' || !path.isAbsolute(files[0]) ||
        typeof updater.installerPath !== 'string' || path.resolve(updater.installerPath) !== path.resolve(files[0]))
      throw new UpdateSecurityError('INSTALLER');
    const filename = path.resolve(files[0]);
    await verifyInstaller(filename, payload);
    this._assertRunning();
    this.downloadedFile = filename;
    this._emit({ status: 'ready', progress: 100, message: `${payload.version} 已下载并通过完整性校验，点击重启更新。` });
    return this.snapshot();
  }
  async download() {
    if (!this.config || this.stopped || this.installing) return this.snapshot();
    if (this.busy) return this.busy;
    if (this.state.status === 'ready') return this.snapshot();
    if (!this.payload) return this.check({ download: true });
    this.busy = this._download().catch(error => this._error(error));
    try { return await this.busy; } finally { this.busy = null; }
  }
  async _backupSettings(version) {
    if (typeof this.userData !== 'string' || !path.isAbsolute(this.userData)) throw new UpdateSecurityError('BACKUP');
    const filename = path.join(this.userData, 'preferences.json');
    let info;
    try { info = await fs.promises.lstat(filename); }
    catch (error) { if (error.code === 'ENOENT') return; throw new UpdateSecurityError('BACKUP'); }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new UpdateSecurityError('BACKUP');
    try {
      const contents = await fs.promises.readFile(filename);
      if (contents.length > 64 * 1024) throw new Error('large');
      JSON.parse(contents.toString('utf8'));
      const directory = path.join(this.userData, 'recovery');
      await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
      const directoryInfo = await fs.promises.lstat(directory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('directory');
      const backup = path.join(directory, `preferences-before-${this.appVersion}-to-${version}-${Date.now()}.json`);
      const handle = await fs.promises.open(backup, 'wx', 0o600);
      try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
    } catch { throw new UpdateSecurityError('BACKUP'); }
  }
  async install() {
    if (this.stopped || this.busy || this.installing || this.state.status !== 'ready' || !this.payload || !this.downloadedFile)
      return { ok: false, error: '更新尚未完成下载与验证。' };
    this.installing = true;
    try {
      const updater = this._prepareUpdater();
      if (typeof updater.installerPath !== 'string' || path.resolve(updater.installerPath) !== this.downloadedFile)
        throw new UpdateSecurityError('INSTALLER');
      await this._backupSettings(this.payload.version);
      // Cache contents may have changed after download. The install action
      // authenticates the exact file again; a cached checksum is insufficient.
      await verifyInstaller(this.downloadedFile, this.payload);
      this._assertRunning();
      if (path.resolve(updater.installerPath) !== this.downloadedFile) throw new UpdateSecurityError('INSTALLER');
      this._emit({ message: '设置已备份，正在启动更新安装…' });
      updater.quitAndInstall(false, true);
      return this.state.status === 'error' ? { ok: false, error: this.state.message } : { ok: true };
    } catch (error) { this.installing = false; this._error(error); return { ok: false, error: this.state.message }; }
  }
  stop() {
    this.stopped = true;
    this.abort?.abort();
    this.cancellation?.cancel?.();
    if (this.updater) {
      this.updater.autoDownload = false;
      this.updater.autoInstallOnAppQuit = false;
      this.updater.autoInstallEvent = 'manual';
      for (const [event, handler] of this.listeners) this.updater.removeListener(event, handler);
      // Leave a harmless error sink while an aborted updater request unwinds.
      this.updater.on('error', () => {});
    }
    this.payload = null;
    this.downloadedFile = null;
  }
}
module.exports = { UpdateManager };
