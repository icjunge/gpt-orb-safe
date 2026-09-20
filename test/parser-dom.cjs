'use strict';
// Optional real DOM verification: run with the Electron executable, not plain Node.
// Linux CI without a display can use --ozone-platform=headless and --ozone-override-screen-size=1920,1080.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

function fixtures() {
  const main = document.querySelector('main');
  const parse = html => { main.innerHTML = html; return OrbPageParser.collect(document, 'https://chatgpt.com/settings/usage?tab=overview'); };
  const card = (label, value, extra = '') => '<section><h3>' + label + '</h3><p>' + value + '</p>' + extra + '</section>';
  // This getter makes an accidental full page text scan fail the test immediately.
  Object.defineProperty(document.body, 'innerText', { get() { throw new Error('body.innerText must not be read'); } });
  const normal = parse(card('5 hour usage limit', '80% remaining', '<p>Resets in 3 hours</p>') + card('Weekly usage limit', '40% used') + card('Lifetime tokens', '1,234') + card('Today tokens', '0'));
  const collisions = parse(card('Weekly usage limit', '40% used') + card('Weekly usage limit', '40% used'));
  const generic = parse(card('Usage', '80% remaining') + card('Total tokens', '1234') + card('5 hour usage limit', '80%'));
  const combined = parse('<section><h3>5 hour usage limit</h3><h3>Weekly usage limit</h3><p>40% used</p></section>');
  const hidden = parse(card('5 hour usage limit', '80% remaining', '<p hidden>0% remaining</p><script type="application/json">{"secret":"80% used"}</script>') + '<section style="display:none"><h3>Weekly usage limit</h3><p>40% used</p></section><aside><h3>Weekly usage limit</h3><p>50% used</p></aside>');
  const editable = parse('<section><h3>Weekly usage limit</h3><textarea>80% remaining</textarea><p contenteditable="true">60% used</p></section>');
  const absolute = parse(card('Weekly usage limit', '20% remaining', '<p>Resets <time datetime="' + new Date(Date.now() + 3600000).toISOString() + '">in 1 hour</time></p>'));
  const farFuture = parse(card('Weekly usage limit', '20% remaining', '<p>Resets <time datetime="2099-01-01T00:00:00Z">later</time></p>'));
  const chinese = parse(card('５小时用量', '剩余额度８０％', '<p>将在３小时２０分钟后重置</p>') + card('今日 Token 用量', '１,２３４'));
  const offRoute = OrbPageParser.collect(document, 'https://chatgpt.com/c/private-conversation');
  return { normal, collisions, generic, combined, hidden, editable, absolute, farFuture, chinese, offRoute };
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 800, height: 800, webPreferences: { offscreen: true, sandbox: true, nodeIntegration: false, contextIsolation: true } });
  await window.loadURL('data:text/html,<main></main>');
  await window.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, '../extension/parser.js'), 'utf8'));
  const results = await window.webContents.executeJavaScript('(' + fixtures.toString() + ')()');
  let checks = 0;
  const check = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };
  check(results.normal.windows.length, 2);
  check(results.normal.windows[0].usedPercent, 20);
  check(results.normal.windows[0].resetApproximate, true);
  check(results.normal.windows[1].usedPercent, 40);
  check(results.normal.tokens, { total: 1234, today: 0 });
  check(results.collisions.windows.length, 0);
  check(results.generic.windows.length, 0);
  check(results.generic.tokens, { total: null, today: null });
  check(results.combined.windows.length, 0);
  check(results.hidden.windows.length, 1);
  check(results.hidden.windows[0].usedPercent, 20);
  check(results.editable.windows.length, 0);
  check(results.absolute.windows.length, 1);
  check(results.absolute.windows[0].resetApproximate, false);
  check(typeof results.absolute.windows[0].resetAt, 'number');
  check(results.farFuture.windows[0].resetAt, null);
  check(results.farFuture.windows[0].usedPercent, 80);
  check(results.chinese.windows.length, 1);
  check(results.chinese.windows[0].usedPercent, 20);
  check(results.chinese.windows[0].resetApproximate, true);
  check(results.chinese.tokens, { total: null, today: 1234 });
  check(results.offRoute, null);
  console.log(`DOM parser fixture: ${checks} assertions passed; fixtures are synthetic, not a live account.`);
  window.destroy();
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
