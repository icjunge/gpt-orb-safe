'use strict';

// Explicit local maintenance action: reuse the app's validated, rollback-safe
// bundle sync. No browser profile inspection, network, app launch, or reload.
const path = require('node:path');
const { syncExtension } = require('../src/extension-store.cjs');

function defaultUserData(platform, env) {
  if (platform !== 'win32') throw new Error('此命令仅适用于 Windows；未更新扩展文件。');
  const appData = env.APPDATA;
  if (typeof appData !== 'string' || !/^[A-Za-z]:[\\/]/.test(appData)
    || /[\x00-\x1f<>"|?*]/.test(appData) || appData.slice(2).includes(':')) {
    throw new Error('未找到有效的本机 APPDATA 目录；未更新扩展文件。请在 Windows 当前用户的终端运行。');
  }
  return path.win32.join(appData, 'GPT Usage Orb Safe');
}

async function updateExtension({ platform = process.platform, env = process.env,
  sync = syncExtension, log = console.log } = {}) {
  const userData = defaultUserData(platform, env);
  const result = await sync({ sourceDir: path.join(__dirname, '../extension'), userData });
  if (result.error) throw new Error(result.error);
  log(result.changed ? `扩展文件已更新到 ${result.version}。` : `已保留扩展 ${result.version}，无需替换文件。`);
  log(`固定扩展目录：${result.path}`);
  log('如果浏览器已加载这个目录，请在扩展管理页点击「重新加载」，再打开官方用量页重新配对。');
  log('如果浏览器加载的是 Downloads 等其他目录，本命令不会改变它；请移除旧扩展项，并加载上面的固定目录一次。');
  return result;
}

if (require.main === module) {
  updateExtension().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { defaultUserData, updateExtension };
