'use strict';
// Offline renderer acceptance checks. Displayed use data are fixtures, never an account.
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.disableHardwareAcceleration();
const out=process.env.GPT_ORB_RENDER_OUTPUT || path.resolve(__dirname,'../../build/rendered-safe');
const actions=[];
let checks=0;
function equal(actual,expected,message){assert.equal(actual,expected,message);checks++;}
function match(actual,expression){assert.match(actual,expression);checks++;}
let state={status:'waiting',bridge:{listening:true,connected:false,lastReceivedAt:null,port:43861},snapshot:null,error:null,
  settings:{alwaysOnTop:true,autoStart:false,notifications:true,opacity:1}};
ipcMain.handle('test:state',()=>state);
ipcMain.handle('test:action',(_event,action)=>{actions.push(action);return {ok:true};});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function make(page,width,height){
  const w=new BrowserWindow({width,height,show:false,frame:false,backgroundColor:'#111918',
    webPreferences:{preload:path.join(__dirname,'render-preload.cjs'),offscreen:true,contextIsolation:true,sandbox:true}});
  const errors=[];
  w.webContents.on('console-message',(_e,level,message)=>{if(level>=3)errors.push(message);});
  await w.loadFile(path.join(__dirname,'../src/ui',page+'.html'));
  const view={w,errors,width,height};
  // Ozone headless can report a 1×1 viewport despite the requested native size.
  // Override only the test viewport; production window behavior is unchanged.
  if(await w.webContents.executeJavaScript('innerWidth')!==width){
    w.webContents.debugger.attach('1.3');view.emulated=true;
    await w.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  }
  await wait(300);return view;
}
async function resize(view,width,height){
  view.w.setSize(width,height);view.width=width;view.height=height;
  if(view.emulated)await view.w.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  await wait(100);
}
async function change(view,newState){state=newState;view.w.webContents.send('test:update',state);await wait(100);}
async function run(view,code){return view.w.webContents.executeJavaScript(code);}
async function shot(view,name){view.w.webContents.invalidate();await wait(250);const image=await view.w.webContents.capturePage({x:0,y:0,width:view.width,height:view.height});equal(image.getSize().width,view.width);equal(image.getSize().height,view.height);fs.writeFileSync(path.join(out,name),image.toPNG());}
app.whenReady().then(async()=>{
  fs.mkdirSync(out,{recursive:true});
  const panel=await make('panel',440,780);
  equal(await run(panel,"document.getElementById('setup-card').classList.contains('hidden')"),false);
  await run(panel,"document.getElementById('pair-button').click()");await wait(30);
  equal(actions.at(-1).name,'copyPairingCode');
  equal(await run(panel,"document.querySelectorAll('input[type=password]').length"),0);
  await run(panel,"document.getElementById('toast').classList.add('hidden')");
  await shot(panel,'setup.png');
  const now=Date.now();
  const live={...state,status:'ready',bridge:{...state.bridge,connected:true,lastReceivedAt:now},snapshot:{version:1,source:'official-page',capturedAt:now,
    windows:[{kind:'session',usedPercent:24,resetAt:now+8640000,resetApproximate:false},{kind:'weekly',usedPercent:36,resetAt:now+194340000,resetApproximate:true}],tokens:{total:null,today:null}}};
  await change(panel,live);
  equal(await run(panel,"document.getElementById('remaining-number').textContent"),'64');
  equal(await run(panel,"document.getElementById('total-tokens').textContent"),'—');
  equal(await run(panel,"document.querySelectorAll('.limit-window').length"),2);
  equal(await run(panel,"document.getElementById('record-label').textContent"),'页面读取时间');
  match(await run(panel,"document.getElementById('reset-countdown').textContent"),/^约 /);
  await run(panel,"document.querySelector('.brand-caption').textContent='界面预览 · 额度为示例数据'");
  await shot(panel,'panel-demo.png');
  equal(await run(panel,"document.documentElement.scrollWidth<=innerWidth"),true);
  await run(panel,"document.getElementById('settings-button').click()");
  equal(await run(panel,"document.getElementById('settings-view').classList.contains('hidden')"),false);
  await run(panel,"document.getElementById('auto-start').click()");await wait(20);
  equal(actions.at(-1).name,'setSettings');equal(actions.at(-1).payload.autoStart,true);
  await run(panel,"document.getElementById('disconnect-button').click()");await wait(20);
  equal(actions.at(-1).name,'disconnect');
  await run(panel,"document.getElementById('toast').classList.add('hidden')");
  await shot(panel,'settings.png');
  // Older state snapshots must leave updates visibly unavailable rather than suggesting they work.
  equal(await run(panel,"document.getElementById('update-status').textContent"),'更新源尚未启用');
  equal(await run(panel,"document.getElementById('check-updates-button').disabled"),true);
  equal(await run(panel,"document.getElementById('install-update-button').classList.contains('hidden')"),true);
  equal(await run(panel,"document.getElementById('release-page-button').classList.contains('hidden')"),true);
  const beforeDisabled=actions.length;
  await run(panel,"document.getElementById('check-updates-button').click()");await wait(20);
  equal(actions.length,beforeDisabled,'unconfigured update button cannot start a check');
  const updates={status:'idle',currentVersion:'2.1.0',availableVersion:null,progress:null,message:'',lastCheckedAt:null,repository:'example/gpt-orb'};
  const configured={...live,updates,extension:{version:'2.1.0',needsReload:false}};
  await change(panel,configured);
  equal(await run(panel,"document.getElementById('current-version').textContent"),'2.1.0');
  equal(await run(panel,"document.getElementById('check-updates-button').disabled"),false);
  equal(await run(panel,"document.getElementById('install-update-button').classList.contains('hidden')"),true);
  equal(await run(panel,"document.getElementById('release-page-button').classList.contains('hidden')"),false);
  await run(panel,"document.getElementById('check-updates-button').click()");await wait(20);
  equal(actions.at(-1).name,'checkUpdates');
  await run(panel,"document.getElementById('release-page-button').click()");await wait(20);
  equal(actions.at(-1).name,'openReleasePage');
  await run(panel,"document.getElementById('recovery-folder-button').click()");await wait(20);
  equal(actions.at(-1).name,'openRecoveryFolder');
  await change(panel,{...configured,updates:{...updates,status:'checking'}});
  equal(await run(panel,"document.getElementById('check-updates-button').disabled"),true);
  equal(await run(panel,"document.getElementById('check-updates-button').textContent"),'正在检查…');
  equal(await run(panel,"document.getElementById('install-update-button').classList.contains('hidden')"),true);
  const downloading={...configured,updates:{...updates,status:'downloading',availableVersion:'2.1.1',progress:73.5,lastCheckedAt:now}};
  await change(panel,downloading);
  equal(await run(panel,"document.getElementById('check-updates-button').disabled"),true);
  equal(await run(panel,"document.getElementById('install-update-button').classList.contains('hidden')"),true);
  equal(await run(panel,"document.getElementById('update-progress-row').classList.contains('hidden')"),false);
  equal(await run(panel,"document.getElementById('update-progress').value"),73.5);
  equal(await run(panel,"document.getElementById('update-progress-value').textContent"),'74%');
  equal(await run(panel,"document.getElementById('update-last-checked').classList.contains('hidden')"),false);
  await change(panel,{...downloading,updates:{...downloading.updates,progress:null}});
  equal(await run(panel,"document.getElementById('update-progress').hasAttribute('value')"),false);
  equal(await run(panel,"document.getElementById('update-progress-value').textContent"),'下载中');
  const ready={...configured,updates:{...updates,status:'ready',availableVersion:'2.1.1',lastCheckedAt:now},extension:{version:'2.1.0',needsReload:true}};
  await change(panel,ready);
  equal(await run(panel,"document.getElementById('install-update-button').classList.contains('hidden')"),false);
  equal(await run(panel,"document.getElementById('install-update-button').disabled"),false);
  match(await run(panel,"document.getElementById('install-update-button').textContent"),/重启并更新/);
  equal(await run(panel,"document.getElementById('check-updates-button').disabled"),true);
  equal(await run(panel,"document.getElementById('update-progress-row').classList.contains('hidden')"),true);
  equal(await run(panel,"document.getElementById('available-version').textContent"),'新版 2.1.1');
  match(await run(panel,"document.getElementById('extension-status').textContent"),/重新加载.*重新配对/);
  equal(await run(panel,"document.getElementById('extension-status').classList.contains('needs-reload')"),true);
  equal(await run(panel,"document.getElementById('setup-extension-note').classList.contains('hidden')"),false);
  await run(panel,"document.getElementById('extension-status').parentElement.scrollIntoView({block:'start'})");
  await shot(panel,'extensions-reload.png');
  await run(panel,"document.querySelector('.updates-group').scrollIntoView({block:'start'})");
  await shot(panel,'updates-ready.png');
  equal(await run(panel,"document.documentElement.scrollWidth<=innerWidth"),true);
  await run(panel,"document.getElementById('install-update-button').click()");await wait(20);
  equal(actions.at(-1).name,'installUpdate');
  equal(await run(panel,"document.getElementById('install-update-button').disabled"),true,'accepted restart cannot be submitted twice');
  const hostileUpdate='<img src=x onerror=alert(1)> 更新失败';
  const failed={...configured,updates:{...updates,status:'error',message:hostileUpdate},extension:{version:'2.1.0',needsReload:false,error:'<img src=x onerror=alert(2)> 扩展目录不可写'}};
  await change(panel,failed);
  equal(await run(panel,"document.getElementById('update-status').textContent"),hostileUpdate);
  equal(await run(panel,"document.querySelectorAll('#update-status img, #extension-error img, #setup-extension-note img').length"),0);
  equal(await run(panel,"document.getElementById('update-status').classList.contains('error')"),true);
  equal(await run(panel,"document.getElementById('check-updates-button').disabled"),false);
  equal(await run(panel,"document.getElementById('install-update-button').classList.contains('hidden')"),true);
  equal(await run(panel,"document.getElementById('extension-error').classList.contains('hidden')"),false);
  match(await run(panel,"document.getElementById('extension-error').textContent"),/扩展目录不可写/);
  equal(await run(panel,"document.getElementById('auto-check-updates').checked"),true);
  await run(panel,"document.getElementById('auto-check-updates').click()");await wait(20);
  equal(actions.at(-1).name,'setSettings');
  equal(actions.at(-1).payload.autoCheckUpdates,false);
  await change(panel,{...configured,settings:{...configured.settings,autoCheckUpdates:false}});
  equal(await run(panel,"document.getElementById('auto-check-updates').checked"),false);
  await change(panel,{...failed,updates:{...failed.updates,message:'更新下载未完成，请检查网络后重试。'},extension:{...failed.extension,error:'固定扩展目录暂时不可写，请关闭占用该目录的程序后重试。'}});
  await run(panel,"document.getElementById('extension-status').parentElement.scrollIntoView({block:'start'})");
  await shot(panel,'extensions-error.png');
  await change(panel,live);
  await run(panel,"document.getElementById('back-button').click()");
  const stale={...live,snapshot:{...live.snapshot,capturedAt:now-181000}};
  await change(panel,stale);
  equal(await run(panel,"document.getElementById('source-badge').textContent"),'上次记录');
  match(await run(panel,"document.getElementById('freshness-note').textContent"),/超过 3 分钟/);
  const manual={...live,snapshot:{...live.snapshot,source:'manual-page',tokens:{today:0,total:324523}}};
  await change(panel,manual);
  equal(await run(panel,"document.getElementById('source-badge').textContent"),'人工记录');
  equal(await run(panel,"document.getElementById('today-tokens').textContent"),'0');
  equal(await run(panel,"document.getElementById('record-label').textContent"),'人工记录时间');
  match(await run(panel,"document.getElementById('freshness-note').textContent"),/不会自动/);
  const expired=structuredClone(live);expired.snapshot.windows[1].resetAt=now-5000;
  await change(panel,expired);
  equal(await run(panel,"document.getElementById('remaining-number').textContent"),'64');
  equal(await run(panel,"document.getElementById('reset-countdown').textContent"),'等待页面确认');
  await change(panel,{...live,snapshot:{...live.snapshot,windows:[]}});
  equal(await run(panel,"document.getElementById('remaining-number').textContent"),'—');
  equal(await run(panel,"document.getElementById('unrecognized-note').classList.contains('hidden')"),false);
  const hostile={...live,error:'<img src=x onerror=alert(1)>'};
  await change(panel,hostile);
  equal(await run(panel,"document.querySelectorAll('#error-text img').length"),0);
  equal(await run(panel,"document.getElementById('error-text').textContent"),hostile.error);
  await resize(panel,380,600);
  equal(await run(panel,"document.documentElement.scrollWidth<=innerWidth"),true);
  await change(panel,live);
  const orb=await make('orb',92,104);
  equal(await run(orb,"document.getElementById('orb-value').textContent"),'64%');
  await shot(orb,'orb-demo.png');
  await change(orb,stale);equal(await run(orb,"document.getElementById('orb-unit').textContent"),'上次记录');
  await change(orb,manual);equal(await run(orb,"document.getElementById('orb-unit').textContent"),'人工记录');
  await change(orb,expired);equal(await run(orb,"document.getElementById('reset').textContent"),'等待页面确认');
  // Native Codex fixtures exercise disclosure behavior in the real renderer.
  // All numbers below are examples; no account, credentials, or network is used.
  const version=require('../package.json').version;
  const native={...configured,updates:{...updates,currentVersion:version},extension:{version,needsReload:false},usageSource:'codex-cli',settings:{...configured.settings,usageSource:'codex-cli',refreshMinutes:5,codexEnabled:true},
    staleAfterMs:390000,codex:{enabled:true,running:false,state:'ready',intervalMinutes:5,lastSuccessAt:now,nextRunAt:now+300000},
    snapshot:{version:2,source:'codex-cli',capturedAt:now,windows:[
      {id:'codex-primary',kind:'cli',label:'Codex · 5 小时',usedPercent:24,resetAt:now+8640000},
      {id:'codex-secondary',kind:'cli',label:'Codex · 每周',usedPercent:36,resetAt:now+194340000}
    ],tokens:{today:null,total:null},tokenScope:'account',tokenDate:'2026-09-19',resetCredits:2}};
  await resize(panel,440,780);await change(panel,native);
  await run(panel,"document.querySelector('.main-scroll').scrollTop=0;document.querySelector('.brand-caption').textContent='界面预览 · 示例数据'");
  equal(await run(panel,"document.getElementById('token-section').open"),false);
  equal(await run(panel,"document.getElementById('token-metrics').classList.contains('hidden')"),true);
  equal(await run(panel,"document.getElementById('token-section').getBoundingClientRect().height<70"),true,'unavailable token module occupies only its summary');
  equal(await run(panel,"document.getElementById('quota-hero').getBoundingClientRect().top<document.getElementById('codex-controls').getBoundingClientRect().top"),true,'usage appears before refresh configuration');
  await shot(panel,'native-tokens-unavailable.png');
  await run(panel,"document.querySelector('#token-section summary').click();document.getElementById('token-section').scrollIntoView({block:'center'})");
  equal(await run(panel,"document.getElementById('token-section').open"),true);
  equal(await run(panel,"document.getElementById('token-metrics').classList.contains('hidden')"),true);
  await shot(panel,'native-tokens-unavailable-expanded.png');
  await run(panel,"document.querySelector('#token-section summary').click()");
  await change(panel,native);
  equal(await run(panel,"document.getElementById('token-section').open"),false,'refresh retains a manual collapse');
  const partial={...native,snapshot:{...native.snapshot,tokens:{today:0,total:null}}};
  await change(panel,partial);
  equal(await run(panel,"document.getElementById('token-section').open"),true,'new token availability expands the module');
  equal(await run(panel,"document.getElementById('today-tokens').textContent"),'0');
  equal(await run(panel,"document.getElementById('today-token-metric').classList.contains('hidden')"),false);
  equal(await run(panel,"document.getElementById('total-token-metric').classList.contains('hidden')"),true);
  await run(panel,"document.getElementById('token-section').scrollIntoView({block:'center'})");
  await shot(panel,'native-tokens-partial.png');
  await run(panel,"document.querySelector('#token-section summary').click()");
  await change(panel,partial);
  equal(await run(panel,"document.getElementById('token-section').open"),false,'valid-token refresh retains a manual collapse');
  const complete={...native,snapshot:{...native.snapshot,tokens:{today:12450,total:1234567}}};
  await change(panel,complete);
  await run(panel,"document.querySelector('#token-section summary').click();document.getElementById('token-section').scrollIntoView({block:'center'})");
  await shot(panel,'native-tokens-available.png');
  await change(panel,native);
  equal(await run(panel,"document.getElementById('token-section').open"),false,'lost token availability automatically collapses the module');
  await resize(panel,380,600);
  await run(panel,"document.querySelector('.main-scroll').scrollTop=0");
  equal(await run(panel,"document.documentElement.scrollWidth<=innerWidth&&document.querySelector('.main-scroll').scrollWidth<=document.querySelector('.main-scroll').clientWidth"),true,'compact panel has no horizontal overflow');
  await shot(panel,'native-compact.png');
  await resize(panel,440,780);
  await run(panel,"document.getElementById('settings-button').click()");
  await shot(panel,'native-settings.png');
  await run(panel,"document.getElementById('back-button').click()");
  await change(panel,{...native,appearance:{nativeBackdrop:false,reducedTransparency:true,highContrast:true}});
  equal(await run(panel,"document.body.classList.contains('high-contrast')&&document.body.classList.contains('reduced-transparency')"),true);
  await shot(panel,'native-high-contrast.png');
  await change(panel,{...native,appearance:{nativeBackdrop:false,reducedTransparency:true,highContrast:false}});
  equal(await run(panel,"document.body.classList.contains('high-contrast')"),false);
  equal(await run(panel,"document.body.classList.contains('reduced-transparency')"),true);
  await shot(panel,'native-reduced-transparency.png');
  await change(panel,{...native,snapshot:null,codex:{enabled:false,running:false,state:'disabled'},settings:{...native.settings,codexEnabled:false}});
  equal(await run(panel,"document.getElementById('codex-setup').classList.contains('hidden')"),false);
  await shot(panel,'native-first-use.png');
  await change(orb,native);
  equal(await run(orb,"document.getElementById('orb-value').textContent"),'64%');
  await shot(orb,'native-orb.png');
  equal(panel.errors.length+orb.errors.length,0,JSON.stringify([...panel.errors,...orb.errors]));
  console.log(`Renderer acceptance: ${checks} checks passed; offline fixture screenshots saved.`);app.quit();
}).catch(error=>{console.error(error.stack);app.exit(1);});
