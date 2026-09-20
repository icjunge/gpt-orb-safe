'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { defaultUserData, updateExtension } = require('../scripts/update-extension.cjs');

test('unsupported platforms and invalid APPDATA stop before any bundle sync', async () => {
  for (const options of [
    { platform: 'linux', env: { APPDATA: 'C:\\Users\\user\\AppData\\Roaming' } },
    { platform: 'win32', env: {} },
    { platform: 'win32', env: { APPDATA: 'relative' } },
    { platform: 'win32', env: { APPDATA: '\\Users\\user\\AppData\\Roaming' } },
    { platform: 'win32', env: { APPDATA: '\\\\server\\share' } },
    { platform: 'win32', env: { APPDATA: 'C:\\bad\npath' } },
    { platform: 'win32', env: { APPDATA: 'C:\\file:stream' } }
  ]) {
    let called = false;
    await assert.rejects(updateExtension({ ...options, sync: async () => { called = true; } }));
    assert.equal(called, false);
  }
});

test('the local helper sends only the bundled extension and stable app directory to sync', async () => {
  const env = { APPDATA: 'C:\\Users\\测试 用户\\AppData\\Roaming' };
  const target = path.win32.join(defaultUserData('win32', env), 'Browser-Extension');
  const messages = [];
  const result = await updateExtension({ platform: 'win32', env,
    log: message => messages.push(message),
    sync: async args => {
      assert.deepEqual(args, { sourceDir: path.join(__dirname, '../extension'),
        userData: 'C:\\Users\\测试 用户\\AppData\\Roaming\\GPT Usage Orb Safe' });
      return { path: target, version: '2.1.2', changed: true };
    }
  });
  assert.equal(result.path, target);
  assert.ok(messages.some(message => message.includes(target)));
  assert.ok(messages.some(message => message.includes('重新加载')));
  assert.ok(messages.some(message => message.includes('Downloads')));
});

test('sync failure surfaces its recovery instructions without a success message', async () => {
  const messages = [];
  await assert.rejects(updateExtension({ platform: 'win32',
    env: { APPDATA: 'C:\\Users\\user\\AppData\\Roaming' },
    log: message => messages.push(message),
    sync: async () => ({ error: '扩展目录无法安全更新，未替换原有文件。' })
  }), /未替换原有文件/);
  assert.deepEqual(messages, []);
});
