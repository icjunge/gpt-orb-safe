'use strict';

// CI only. Verify the original packaged .app signature, then use a temporary
// re-signed copy to load its unchanged production ASAR through an isolated test
// bootstrap. Never change Gatekeeper/quarantine settings, log in, or read the
// runner's existing Codex home. This file is excluded from the distributed app.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist', `mac-native-diagnostic-${process.arch}`);
const reportPath = path.join(output, 'diagnostic.json');
const guiReportPath = path.join(output, 'gui.json');
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};

function command(file, args, options = {}) {
  const result = spawnSync(file, args, {encoding:'utf8', timeout:90000, maxBuffer:1024 * 1024, ...options});
  // Tool output is bounded and intentionally not logged: neither private paths
  // nor native component diagnostics belong in the shareable CI report.
  assert(!result.error && result.status === 0, `${path.basename(file)} did not complete successfully.`);
  return result.stdout.trim();
}

async function componentSmoke(temporary) {
  const {createCodexRuntime} = require('../src/codex-runtime.cjs');
  const {prepareManagedDirectories} = require('../src/codex-directories.cjs');
  const {nodeRequest, probeFreshAccount} = require('./windows-codex-managed-smoke.cjs');
  const userDataDir = path.join(temporary, 'component-profile');
  await fsp.mkdir(userDataDir, {mode:0o700});
  const {codexHome, cwd} = await prepareManagedDirectories(userDataDir);
  let requests = 0;
  const runtime = createCodexRuntime({userDataDir, platform:process.platform, arch:process.arch, timeoutMs:6 * 60 * 1000,
    request:options => { requests++; return nodeRequest(options); }});
  assert.equal(await runtime.getVerifiedExecutable(), null);
  assert.equal(requests, 0, 'A passive runtime check initiated a download.');
  const ready = await runtime.ensureReady();
  const executable = typeof ready === 'string' ? ready : ready.path;
  assert(path.isAbsolute(executable));
  assert.equal(path.basename(executable), 'codex');
  await fsp.access(executable, fs.constants.X_OK);
  const firstRequestCount = requests;
  assert.equal(firstRequestCount, 1, 'Preparing the pinned component used unexpected requests.');
  assert.deepEqual(await runtime.getVerifiedExecutable(), ready);
  assert.deepEqual(await runtime.ensureReady(), ready);
  assert.equal(requests, firstRequestCount, 'A cached verified component was downloaded again.');
  const architectures = command('/usr/bin/lipo', ['-archs', executable]).split(/\s+/);
  assert(architectures.includes(process.arch === 'arm64' ? 'arm64' : 'x86_64'), 'Official component architecture mismatch.');
  await probeFreshAccount(executable, codexHome, cwd);
  for (const name of ['auth.json', '.credentials.json']) {
    await assert.rejects(fsp.access(path.join(codexHome, name)), {code:'ENOENT'}, 'Plaintext credential fallback was created.');
  }
  return {verifiedDownload:true, cachedReuse:true, nativeArchitecture:true, isolatedAccountReadAndLogout:true,
    plaintextCredentialsAbsent:true, loginAttempted:false, modelTasksStarted:false,
    limitation:'A fresh signed-out home verifies protocol isolation; it does not prove a real user login or Keychain credential persistence.'};
}

function guiSmoke(originalApp, temporary) {
  const plist = path.join(originalApp, 'Contents', 'Info.plist');
  const executableName = command('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', plist]);
  assert(executableName && path.basename(executableName) === executableName, 'Invalid packaged executable name.');
  const packagedExecutable = path.join(originalApp, 'Contents', 'MacOS', executableName);
  const architectures = command('/usr/bin/lipo', ['-archs', packagedExecutable]).split(/\s+/);
  assert(architectures.includes(process.arch === 'arm64' ? 'arm64' : 'x86_64'), 'Packaged app architecture mismatch.');
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', originalApp]);

  const fixtureApp = path.join(temporary, 'GPT Orb CI.app');
  fs.cpSync(originalApp, fixtureApp, {recursive:true, verbatimSymlinks:true});
  const resources = path.join(fixtureApp, 'Contents', 'Resources');
  const originalArchive = path.join(resources, 'app.asar');
  assert(fs.statSync(originalArchive).isFile(), 'Packaged production ASAR is missing.');
  const fixtureArchive = path.join(resources, 'production.asar');
  fs.renameSync(originalArchive, fixtureArchive);
  const unpacked = `${originalArchive}.unpacked`;
  if (fs.existsSync(unpacked)) fs.renameSync(unpacked, `${fixtureArchive}.unpacked`);
  // An updater feed is irrelevant to this account-free launch fixture. Preserve
  // the original application's untouched signature/feed outside the temp copy.
  fs.rmSync(path.join(resources, 'app-update.yml'), {force:true});
  const fixture = path.join(resources, 'app');
  fs.mkdirSync(fixture, {recursive:true});
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({name:'gpt-orb-mac-native-ci', version:'1.0.0', main:'main.cjs'}));
  fs.writeFileSync(path.join(fixture, 'main.cjs'), `require(${JSON.stringify(__filename)});\n`);
  fs.cpSync(path.join(resources, 'Browser-Extension'), path.join(fixture, 'extension'), {recursive:true});
  fs.copyFileSync(path.join(root, 'update-config.json'), path.join(fixture, 'update-config.json'));
  command('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--options', 'runtime', '--entitlements',
    path.join(root, 'assets', 'entitlements.mac.plist'), fixtureApp]);
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', fixtureApp]);
  fs.rmSync(guiReportPath, {force:true});
  const env = {...process.env, GPT_ORB_MAC_CI_PROFILE:path.join(temporary, 'gui-profile'),
    GPT_ORB_MAC_CI_ARCHIVE:fixtureArchive, GPT_ORB_MAC_CI_OUTPUT:guiReportPath};
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(path.join(fixtureApp, 'Contents', 'MacOS', executableName), ['--startup'], {
    env, encoding:'utf8', timeout:65000, maxBuffer:1024 * 1024, killSignal:'SIGKILL'
  });
  assert(!result.error && result.status === 0, 'Packaged Electron production UI fixture did not exit successfully.');
  const gui = JSON.parse(fs.readFileSync(guiReportPath, 'utf8'));
  assert.equal(gui.status, 'passed', 'Production UI fixture did not pass.');
  return {originalSignatureVerified:true, nativeArchitecture:true, originalAsarLoaded:true,
    fixtureSignatureVerified:true, ...gui};
}

async function run() {
  assert.equal(process.platform, 'darwin', 'This smoke requires a native macOS runner.');
  assert(['arm64', 'x64'].includes(process.arch), 'Unsupported macOS CI architecture.');
  const position = process.argv.indexOf('--app');
  assert(position !== -1 && process.argv[position + 1], 'Pass --app with the packaged .app path.');
  const originalApp = path.resolve(process.argv[position + 1]);
  assert(originalApp.endsWith('.app') && fs.statSync(originalApp).isDirectory(), 'Packaged .app directory missing.');
  // Canonicalize macOS /var -> /private/var before using a path in the isolated
  // CODEX_HOME, whose canonical path defines its separate Keychain entry.
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-orb-mac-ci-')));
  const report = {schema:1, status:'running', platform:process.platform, arch:process.arch,
    scope:'Original package signature; isolated production UI launch; pinned official component download and signed-out account protocol.',
    limitations:['No Gatekeeper/notarization validation: the CI bootstrap is local and ad-hoc signed.',
      'No real account login, credential persistence, live quotas, or desktop-composited blur validation.',
      'Pointer events below are Chromium-injected events, not physical macOS mouse input.']};
  let phase = 'package-and-production-ui';
  try {
    report.gui = guiSmoke(originalApp, temporary);
    phase = 'official-component-download-cache-and-account-protocol';
    report.component = await componentSmoke(temporary);
    report.status = 'passed';
    writeJson(reportPath, report);
    console.log(`macOS ${process.arch}: package signature, isolated production UI, pinned runtime/cache and official signed-out account protocol passed.`);
  } catch {
    report.status = 'failed'; report.phase = phase;
    writeJson(reportPath, report);
    throw new Error(`macOS ${process.arch} native smoke failed during ${phase}. See the sanitized diagnostic artifact.`);
  } finally {
    await fsp.rm(temporary, {recursive:true, force:true, maxRetries:5, retryDelay:250});
  }
}

function runElectronFixture() {
  const {app, BrowserWindow, ipcMain, session} = require('electron');
  const profile = process.env.GPT_ORB_MAC_CI_PROFILE;
  const archive = process.env.GPT_ORB_MAC_CI_ARCHIVE;
  const outputFile = process.env.GPT_ORB_MAC_CI_OUTPUT;
  assert(profile && archive && outputFile, 'CI isolation parameters are required.');
  fs.mkdirSync(profile, {recursive:true, mode:0o700});
  app.setPath('userData', profile);
  const sessionDirectory = path.join(profile, 'session');
  fs.mkdirSync(sessionDirectory, {recursive:true, mode:0o700});
  app.setPath('sessionData', sessionDirectory);
  fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({settings:{usageSource:'codex-cli',
    codexConnection:'managed', codexManagedConnected:false, codexEnabled:false, autoStart:false,
    autoCheckUpdates:false, notifications:false, alwaysOnTop:true, opacity:1}}));
  const report = {status:'running', networkBlocked:0, productionRenderers:false, isolatedProfile:true, pointerActions:[],
    disabled:{codex:true, autoStart:true, updateChecks:true}};
  let finished = false;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const deadline = setTimeout(() => finish(new Error('Production UI deadline exceeded.')), 50000);
  function finish(error) {
    if (finished) return;
    finished = true; clearTimeout(deadline);
    report.status = error ? 'failed' : 'passed';
    if (error) report.failure = String(error.message || 'Production UI check failed.').slice(0, 200);
    writeJson(outputFile, report);
    const forcedExit = setTimeout(() => app.exit(error ? 1 : 0), 1500); forcedExit.unref();
    process.exitCode = error ? 1 : 0;
    app.quit();
  }
  process.on('uncaughtException', () => finish(new Error('Production UI raised an unexpected exception.')));
  process.on('unhandledRejection', () => finish(new Error('Production UI raised an unexpected rejection.')));
  const protectSession = value => value.webRequest.onBeforeRequest((details, callback) => {
    const cancel = !details.url.startsWith('file:') && !details.url.startsWith('data:');
    if (cancel) report.networkBlocked++;
    callback({cancel});
  });
  app.on('session-created', protectSession);
  async function until(check, label, timeout = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const result = await check(); if (result) return result;
      await pause(40);
    }
    throw new Error(`Timed out: ${label}`);
  }
  app.whenReady().then(async () => {
    protectSession(session.defaultSession);
    const fixture = app.getAppPath();
    // Check that the fixture's app.getAppPath() assets match the original ASAR;
    // all fixture mutations occurred before its ad-hoc signature was created.
    for (const name of fs.readdirSync(path.join(archive, 'extension'))) {
      assert(fs.readFileSync(path.join(archive, 'extension', name)).equals(fs.readFileSync(path.join(fixture, 'extension', name))),
        'Bundled extension copies do not match.');
    }
    assert(fs.readFileSync(path.join(archive, 'update-config.json')).equals(fs.readFileSync(path.join(fixture, 'update-config.json'))),
      'Bundled release configuration does not match the fixture.');
    // Observe and forward the unchanged production handler. No test IPC or
    // renderer replacement is introduced into the distributed application.
    const register = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = (channel, handler) => register(channel, async (event, ...args) => {
      const result = await handler(event, ...args);
      if (channel === 'orb:action' && ['orbExpand', 'dragStart', 'dragEnd'].includes(args[0])) {
        report.pointerActions.push({name:args[0], ok:result?.ok, moved:result?.moved});
      }
      return result;
    });
    require(path.join(archive, 'src', 'main.cjs'));
    const orb = await until(() => BrowserWindow.getAllWindows().find(window =>
      window.webContents.getURL().endsWith('/orb.html') && window.isVisible()), 'production orb');
    const panel = await until(() => BrowserWindow.getAllWindows().find(window =>
      window.webContents.getURL().endsWith('/panel.html') && !window.webContents.isLoading()), 'production panel');
    for (const window of [orb, panel]) window.webContents.on('render-process-gone', () => finish(new Error('Production renderer exited.')));
    const state = await orb.webContents.executeJavaScript('window.orb.getState()');
    assert.equal(state.settings.codexEnabled, false);
    assert.equal(state.settings.codexConnection, 'managed');
    assert.equal(state.settings.codexManagedConnected, false);
    assert.equal(state.settings.autoStart, false);
    assert.equal(state.settings.autoCheckUpdates, false);
    assert.equal(state.codex.enabled, false);
    assert.equal(state.codexSetup.status, 'idle');
    const connectReady = await panel.webContents.executeJavaScript(`(() => {
      const button=document.getElementById('configure-button');
      return Boolean(button && !button.disabled && button.textContent.includes('连接'));
    })()`);
    assert(connectReady, 'The first-use connection action is not ready.');
    report.productionRenderers = true;
    report.bridgeListening = state.bridge.listening;
    assert.equal(state.bridge.listening, true, 'Isolated loopback bridge did not start.');
    const {HOST_SIZE} = require(path.join(archive, 'src', 'orb-window.cjs'));
    const baseline = orb.getBounds();
    assert.equal(baseline.width, HOST_SIZE); assert.equal(baseline.height, HOST_SIZE);
    orb.focus();
    orb.webContents.sendInputEvent({type:'mouseMove', x:HOST_SIZE / 2, y:HOST_SIZE / 2});
    await pause(200);
    assert.deepEqual(orb.getBounds(), baseline, 'Hover changed the native orb host geometry.');
    panel.hide();
    orb.webContents.sendInputEvent({type:'mouseDown', x:HOST_SIZE / 2, y:HOST_SIZE / 2, button:'left', clickCount:1});
    await until(() => report.pointerActions.some(item => item.name === 'dragStart' && item.ok), 'production pointer press');
    await pause(500);
    assert.deepEqual(orb.getBounds(), baseline, 'Stationary press changed the native orb host geometry.');
    orb.webContents.sendInputEvent({type:'mouseUp', x:HOST_SIZE / 2, y:HOST_SIZE / 2, button:'left', clickCount:1});
    await until(() => report.pointerActions.some(item => item.name === 'dragEnd' && item.ok && item.moved === false), 'production pointer release');
    await pause(300);
    assert.deepEqual(orb.getBounds(), baseline, 'Release changed the native orb host geometry.');
    report.stationaryHostStable = true;
    // capturePage checks the renderer's transparent corners only; it cannot
    // establish whether the desktop compositor visibly blurs another app.
    const capture = await orb.webContents.capturePage();
    assert(!capture.isEmpty(), 'Production orb could not be captured.');
    const dimensions = capture.getSize(), pixels = capture.toBitmap();
    const corners = [[0, 0], [dimensions.width - 1, 0], [0, dimensions.height - 1], [dimensions.width - 1, dimensions.height - 1]];
    const alpha = corners.map(([x, y]) => pixels[(y * dimensions.width + x) * 4 + 3]);
    assert(alpha.every(value => value === 0), 'Orb renderer corners are not transparent.');
    report.rendererCornerAlpha = alpha;
    assert.equal(report.networkBlocked, 0, 'Startup attempted an unexpected network request.');
    assert(!fs.existsSync(path.join(profile, 'codex-managed-home')), 'Passive startup prepared a managed account home.');
    report.passiveStartupDidNotPrepareAccount = true;
    finish();
  }).catch(error => finish(error));
}

if (require.main === module && !process.versions.electron) {
  run().catch(error => { console.error(error.message); process.exitCode = 1; });
} else if (process.versions.electron) runElectronFixture();

module.exports = {run, componentSmoke, guiSmoke};
