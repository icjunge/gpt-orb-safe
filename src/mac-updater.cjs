'use strict';

const {
  UpdateSecurityError, compareVersions, validateConfig, verifyMacEnvelope, fetchMacManifest, releaseBase,
} = require('./update-security.cjs');

const MESSAGES = {
  CONFIG: '更新发布源配置无效，已停止检查。', ARCH: '当前 Mac 架构暂不支持更新。',
  SIGNATURE: '更新描述签名不匹配，已拒绝打开下载链接。',
  VERSION: '更新版本格式无效，已停止检查。', DOWNGRADE: '检测到旧版本更新描述，已拒绝降级。',
  MANIFEST: '更新描述格式无效，已停止检查。', ENCODING: '更新签名编码无效，已停止检查。',
  MANIFEST_SIZE: '更新描述超出大小限制，已停止检查。', URL: '更新来源不在允许范围，已停止检查。',
  FEED_MISMATCH: '同一版本的更新信息发生变化，已停止检查。', CANCELLED: '更新检查已停止。',
  NETWORK: '无法获取更新，请检查网络后重试。', TIMEOUT: '更新请求超时，请稍后重试。',
  OPEN: '无法打开浏览器，请稍后重试。',
};

// This first macOS distribution has no Developer ID identity. Squirrel.Mac is
// deliberately never instantiated: it requires signed apps for native updates.
// We authenticate metadata and offer the exact release DMG on explicit click.
// The browser owns that download; no downloaded bytes or install are claimed to
// have been verified or performed by this class.
class MacUpdateManager {
  constructor({ appVersion, config, arch = process.arch, onState = () => {},
    fetchManifest: fetcher = fetchMacManifest, openExternal = null }) {
    compareVersions(appVersion, appVersion);
    this.appVersion = appVersion;
    this.arch = arch;
    this.onState = onState;
    this.fetcher = fetcher;
    this.openExternal = openExternal;
    this.config = null;
    this.envelope = null;
    this.payload = null;
    this.highestVersion = appVersion;
    this.highestPayload = null;
    this.busy = null;
    this.opening = false;
    this.stopped = false;
    this.abort = null;
    this.state = { status: 'unconfigured', currentVersion: appVersion, availableVersion: null,
      progress: null, message: '发布者尚未配置更新仓库和签名公钥。', lastCheckedAt: null,
      repository: null, installMode: 'manual', platform: 'darwin', arch };
    try {
      if (!['arm64', 'x64'].includes(arch)) throw new UpdateSecurityError('ARCH');
      this.config = validateConfig(config);
      if (this.config) Object.assign(this.state, { status: 'idle', repository: this.config.repository,
        message: '可检查 Mac 更新；新版需下载后手动替换应用。' });
    } catch (error) {
      this.config = null;
      Object.assign(this.state, { status: 'error', message: MESSAGES[error?.code] || MESSAGES.CONFIG });
    }
  }
  snapshot() { return { ...this.state }; }
  _emit(patch) {
    if (this.stopped) return;
    Object.assign(this.state, patch);
    try { this.onState(this.snapshot()); } catch { /* A closed UI cannot change verification. */ }
  }
  _assertRunning() {
    if (this.stopped || this.abort?.signal.aborted) throw new UpdateSecurityError('CANCELLED');
  }
  _error(error) {
    this.envelope = null;
    this.payload = null;
    this._emit({ status: 'error', progress: null, availableVersion: null,
      message: MESSAGES[error?.code] || '更新检查未完成，请稍后重试；当前版本仍可继续使用。' });
    return this.snapshot();
  }
  _verify(body) {
    const payload = verifyMacEnvelope(body, this.config, this.arch);
    if (compareVersions(payload.version, this.appVersion) < 0 ||
        compareVersions(payload.version, this.highestVersion) < 0) throw new UpdateSecurityError('DOWNGRADE');
    if (this.highestPayload && payload.version === this.highestPayload.version &&
        ['file', 'size', 'sha256', 'sha512', 'publishedAt'].some(field => payload[field] !== this.highestPayload[field]))
      throw new UpdateSecurityError('FEED_MISMATCH');
    return payload;
  }
  async check() {
    if (!this.config || this.stopped || this.opening) return this.snapshot();
    if (this.busy) return this.busy;
    this.busy = (async () => {
      this.abort = new AbortController();
      this.envelope = null; this.payload = null;
      this._emit({ status: 'checking', message: '正在验证 Mac 更新描述…', progress: null,
        availableVersion: null, lastCheckedAt: Date.now() });
      try {
        const body = await this.fetcher(`https://github.com/${this.config.repository}/releases/latest/download/orb-update-mac-${this.arch}.json`,
          { repository: this.config.repository, arch: this.arch, signal: this.abort.signal });
        this._assertRunning();
        const bytes = Buffer.from(body);
        const payload = this._verify(bytes);
        this.highestVersion = payload.version;
        this.highestPayload = payload;
        if (compareVersions(payload.version, this.appVersion) === 0) {
          this._emit({ status: 'idle', message: '当前已是最新版本。' });
          return this.snapshot();
        }
        this.envelope = bytes;
        this.payload = payload;
        this._emit({ status: 'available', availableVersion: payload.version,
          message: `发现 ${payload.version}。更新描述签名已验证，下载后需手动替换应用。` });
        return this.snapshot();
      } catch (error) { return this._error(error); }
      finally { this.abort = null; }
    })();
    try { return await this.busy; } finally { this.busy = null; }
  }
  // Compatibility with the Windows update controls. This must not cause a
  // scheduled check (or a generic "download" call) to open a browser implicitly.
  async download() { return this.check(); }
  async install() {
    if (!this.config || this.stopped || this.busy || this.opening || this.state.status !== 'available' || !this.envelope)
      return { ok: false, error: '尚无已验证的 Mac 新版下载。' };
    this.opening = true;
    try {
      const payload = this._verify(this.envelope);
      if (compareVersions(payload.version, this.appVersion) <= 0 || payload.version !== this.state.availableVersion)
        throw new UpdateSecurityError('DOWNGRADE');
      this._assertRunning();
      if (typeof this.openExternal !== 'function') throw new UpdateSecurityError('OPEN');
      // Construct from pinned repository + fully verified schema. Never accept a
      // renderer URL, unsigned feed URL or CDN location as a browser destination.
      const url = `${releaseBase(this.config.repository, payload)}${payload.file}`;
      try { await this.openExternal(url); }
      catch { throw new UpdateSecurityError('OPEN'); }
      this._assertRunning();
      this._emit({ message: '已在浏览器打开新版下载。下载后退出应用，将新版拖入“应用程序”并替换。' });
      return { ok: true, manual: true };
    } catch (error) {
      this._error(error);
      return { ok: false, error: this.stopped ? MESSAGES.CANCELLED : this.state.message };
    } finally { this.opening = false; }
  }
  stop() {
    this.stopped = true;
    this.abort?.abort();
    this.envelope = null;
    this.payload = null;
  }
}

module.exports = { MacUpdateManager };
