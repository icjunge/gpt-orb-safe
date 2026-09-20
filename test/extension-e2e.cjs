'use strict';

/*
 * Real Chromium transport test, with an unmodified unpacked MV3 extension.
 *
 * Chrome: GPT_ORB_CHROME=/path/to/chrome node test/extension-e2e.cjs
 *         Requires Playwright in node_modules or GPT_ORB_PLAYWRIGHT.
 * Electron: electron test/extension-e2e.cjs
 * Linux CI may require: --no-sandbox --ozone-platform=headless --disable-gpu
 *
 * This tests the actual extension service worker and actual loopback bridge.
 * It seeds synthetic numeric data through DevTools, without an account or a
 * remote page. It does NOT certify real Chrome/Edge action-popup permission
 * prompts, activeTab grants, or parsing of a signed-in official dashboard.
 * CORS, Origin, local-network rules and the extension manifest are unmodified.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { UsageBridge } = require('../src/bridge.cjs');
const identity = require('../extension-identity.json');
const extensionPath = path.resolve(__dirname, '../extension');
const popupURL = `chrome-extension://${identity.id}/popup.html`;
const workerURL = `chrome-extension://${identity.id}/sw.js`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-orb-transport-'));
const received = [];
const observedRequests = [];
const bridge = new UsageBridge({ onSnapshot: (snapshot) => { received.push(snapshot); } });
let passed = 0;

function check(label, assertion) {
  assertion();
  passed += 1;
  process.stdout.write(`PASS ${label}\n`);
}

async function verify(evaluate, engine) {
  const runtime = await evaluate(async () => {
    await ready;
    return { id: chrome.runtime.id, manifest: chrome.runtime.getManifest() };
  });
  check('stable extension identity and narrow manifest', () => {
    assert.equal(runtime.id, identity.id);
    assert.deepEqual([...runtime.manifest.permissions].sort(), ['activeTab', 'scripting', 'storage', 'alarms'].sort());
    assert.deepEqual(runtime.manifest.host_permissions, ['http://127.0.0.1/*']);
    assert.deepEqual(runtime.manifest.optional_host_permissions, ['https://chatgpt.com/*']);
    assert.equal(runtime.manifest.externally_connectable, undefined);
  });
  // `ready` resolves only after the real chrome.storage.session API accepts
  // TRUSTED_CONTEXTS. It is not replaced with a test shim.
  check('real storage.session TRUSTED_CONTEXTS initialization completed', () => assert.ok(runtime.id));

  async function seed(secret) {
    return evaluate(async (secretValue) => {
      await ready;
      await chrome.storage.session.set({ bridge: { secret: secretValue, tabId: 9_999_999, mode: 'automatic' }, status: {} });
      return Boolean((await chrome.storage.session.get('bridge')).bridge);
    }, secret);
  }

  async function sendSynthetic(extra = false) {
    return evaluate(async (includeExtra) => {
      const paired = (await chrome.storage.session.get('bridge')).bridge;
      const snapshot = {
        version: 1, source: 'official-page', capturedAt: Date.now(),
        windows: [{ kind: 'session', usedPercent: 37.5, resetAt: Date.now() + 3_600_000, resetApproximate: false }],
        tokens: { total: null, today: 12_345 },
      };
      if (includeExtra) snapshot.rawPageText = 'synthetic forbidden field';
      return post(snapshot, paired);
    }, extra);
  }

  const firstKey = bridge.getPairingCode().split('.')[2];
  await seed(firstKey);
  const accepted = await sendSynthetic();
  check('production service-worker fetch reaches the strict bridge', () => {
    assert.equal(accepted.ok, true);
    assert.equal(received.length, 1);
    assert.equal(received[0].windows[0].usedPercent, 37.5);
    assert.equal(received[0].tokens.total, null);
    assert.equal(received[0].tokens.today, 12_345);
    assert.equal(bridge.getStatus().connected, true);
  });
  check('actual browser request carries the exact extension Origin', () => {
    const posts = observedRequests.filter((request) => request.method === 'POST');
    assert.ok(posts.length > 0, 'Expected a real browser network request');
    assert.ok(posts.every((request) => request.origin === `chrome-extension://${identity.id}`));
    assert.ok(posts.every((request) => request.url === `http://127.0.0.1:${identity.port}/v1/usage`));
  });

  const storage = await evaluate(async () => {
    let syncKeys = null;
    try { syncKeys = Object.keys(await chrome.storage.sync.get(null)); }
    catch { /* Electron does not provide Chrome sync storage. */ }
    return {
      localKeys: Object.keys(await chrome.storage.local.get(null)), syncKeys,
      hasSessionPair: Boolean((await chrome.storage.session.get('bridge')).bridge),
    };
  });
  check('pairing resides in session storage; persistent local storage is empty', () => {
    assert.deepEqual(storage.localKeys, []);
    if (!process.versions.electron || storage.syncKeys !== null) assert.deepEqual(storage.syncKeys, []);
    assert.equal(storage.hasSessionPair, true);
  });
  if (storage.syncKeys === null) process.stdout.write('NOTE Chrome sync storage is unavailable in this Electron test host.\n');

  const extra = await sendSynthetic(true);
  check('real network transport rejects fields outside the numeric schema', () => {
    assert.equal(extra.ok, false);
    assert.equal(received.length, 1);
  });

  bridge.rotateKey();
  const expired = await sendSynthetic();
  const expiredCleared = await evaluate(async () => !(await chrome.storage.session.get('bridge')).bridge);
  check('rotated key is rejected and the extension removes its obsolete secret', () => {
    assert.equal(expired.ok, false);
    assert.equal(expiredCleared, true);
    assert.equal(received.length, 1);
    assert.equal(bridge.getStatus().connected, false);
  });

  await seed(randomBytes(32).toString('base64url'));
  const foreign = await sendSynthetic();
  const foreignCleared = await evaluate(async () => !(await chrome.storage.session.get('bridge')).bridge);
  check('unrelated session secret cannot submit a snapshot', () => {
    assert.equal(foreign.ok, false);
    assert.equal(foreignCleared, true);
    assert.equal(received.length, 1);
  });

  await seed(bridge.getPairingCode().split('.')[2]);
  const repaired = await sendSynthetic();
  check('new session pairing restores transmission after rotation', () => {
    assert.equal(repaired.ok, true);
    assert.equal(received.length, 2);
  });

  await bridge.close();
  const closed = await sendSynthetic();
  check('closed desktop bridge produces a connection error without phantom success', () => {
    assert.equal(closed.ok, false);
    assert.equal(received.length, 2);
  });

  process.stdout.write(`${passed} transport checks passed (${engine}).\n`);
  process.stdout.write('Scope: synthetic data, real MV3 service worker and real HTTP bridge; no account login or authenticated-page UI test.\n');
}

async function chromeRun() {
  const playwrightPath = process.env.GPT_ORB_PLAYWRIGHT || 'playwright';
  const { chromium } = require(playwrightPath);
  const executablePath = process.env.GPT_ORB_CHROME;
  if (!executablePath) throw new Error('Set GPT_ORB_CHROME to a local Chrome for Testing executable.');
  let context;
  try {
    await bridge.start();
    context = await chromium.launchPersistentContext(profile, {
      executablePath, headless: true,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    context.on('request', (request) => {
      if (request.url().startsWith(`http://127.0.0.1:${identity.port}/`)) {
        // Deliberately retain no authentication header or body in test output.
        observedRequests.push({ method: request.method(), url: request.url(), origin: request.headers().origin });
      }
    });
    const worker = context.serviceWorkers().find((item) => item.url() === workerURL)
      || await context.waitForEvent('serviceworker', { predicate: (item) => item.url() === workerURL, timeout: 10_000 });
    await verify((fn, arg) => worker.evaluate(fn, arg), `Chrome ${await context.browser().version()}`);
  } finally {
    await context?.close();
    await bridge.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

function electronRun() {
  const { app, BrowserWindow, session } = require('electron');
  app.setPath('userData', profile);
  app.whenReady().then(async () => {
    let window;
    try {
      await bridge.start();
      const browserSession = session.fromPartition('persist:orb-e2e');
      browserSession.webRequest.onBeforeSendHeaders({ urls: [`http://127.0.0.1:${identity.port}/*`] }, (details, callback) => {
        const header = Object.entries(details.requestHeaders).find(([name]) => name.toLowerCase() === 'origin');
        observedRequests.push({ method: details.method, url: details.url, origin: header?.[1] });
        callback({}); // Observe without rewriting headers or changing CORS behavior.
      });
      const extension = await browserSession.extensions.loadExtension(extensionPath);
      assert.equal(extension.id, identity.id);
      window = new BrowserWindow({ show: false, width: 440, height: 600,
        webPreferences: { session: browserSession, offscreen: true, sandbox: true, contextIsolation: true } });
      await window.loadURL(popupURL);
      const debuggerAPI = window.webContents.debugger;
      debuggerAPI.attach('1.3');
      const { targetInfos } = await debuggerAPI.sendCommand('Target.getTargets');
      const target = targetInfos.find((item) => item.type === 'service_worker' && item.url === workerURL);
      assert.ok(target, 'The actual MV3 service worker must exist');
      const { sessionId } = await debuggerAPI.sendCommand('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      const evaluate = async (fn, arg) => {
        const expression = `(${fn.toString()})(${JSON.stringify(arg) ?? 'undefined'})`;
        const result = await debuggerAPI.sendCommand('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
        if (result.exceptionDetails) throw new Error('Extension worker evaluation failed.');
        return result.result.value;
      };
      await verify(evaluate, `Electron ${process.versions.electron}, Chromium ${process.versions.chrome}`);
    } catch (error) {
      // Never print worker-evaluation source, request headers or a pairing key.
      process.stderr.write(`Transport test failed: ${error.message}\n`);
      process.exitCode = 1;
    } finally {
      await bridge.close();
      window?.destroy();
      app.exit(process.exitCode || 0);
    }
  });
  app.on('quit', () => { fs.rmSync(profile, { recursive: true, force: true }); });
}

if (process.versions.electron) electronRun();
else chromeRun().catch((error) => {
  // Browser startup errors may contain long launch logs; only the first line
  // is needed. There are no real accounts in the disposable test profile.
  process.stderr.write(`Transport test failed: ${String(error.message).split('\n')[0]}\n`);
  process.exitCode = 1;
});
