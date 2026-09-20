'use strict';
// Real Chromium DOM regression: opening extension HTML as a local file must
// explain installation and refuse pairing, even for programmatic submission.
const {app,BrowserWindow,session}=require('electron');
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),os=require('node:os');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'orb-popup-dom-'));
app.setPath('userData',profile);app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
  const window=new BrowserWindow({width:372,height:900,show:false,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true}});
  await window.loadFile(path.join(__dirname,'../extension/popup.html'));
  await new Promise(resolve=>setTimeout(resolve,150));
  const result=await window.webContents.executeJavaScript(`(() => {
    const form=document.querySelector('#pair-form');
    document.querySelector('#code').value='SYNTHETIC_TEST_VALUE';
    form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
    return {status:document.querySelector('#status').textContent,
      helpVisible:!document.querySelector('#setup-help').hidden,
      allDisabled:[...document.querySelectorAll('input,button')].every(el=>el.disabled),
      noCode:document.querySelector('#code').value==='',
      noRawError:!document.body.textContent.includes('Cannot read properties'),
      noHorizontalOverflow:document.documentElement.scrollWidth<=innerWidth};
  })()`);
  assert.match(result.status,/请从浏览器扩展图标打开/);
  for(const key of['helpVisible','allDisabled','noCode','noRawError','noHorizontalOverflow'])assert.equal(result[key],true,key);
  const extension=await session.defaultSession.extensions.loadExtension(path.join(__dirname,'../extension'));
  await window.loadURL(`chrome-extension://${extension.id}/popup.html`);
  await window.webContents.executeJavaScript('render()');
  const installed=await window.webContents.executeJavaScript(`({valid:runtimeAvailable(),helpHidden:document.querySelector('#setup-help').hidden,status:document.querySelector('#status').textContent})`);
  assert.equal(installed.valid,true);
  assert.equal(installed.helpHidden,true);
  assert.equal(installed.status,'请打开官方用量页');
  console.log('Popup Chromium regression: 9 checks passed for plain-file failure and real MV3 popup messaging; no account or browser credentials used.');
  window.destroy();app.quit();
}).catch(error=>{console.error(error.message);app.exit(1);});
app.on('quit',()=>fs.rmSync(profile,{recursive:true,force:true}));
