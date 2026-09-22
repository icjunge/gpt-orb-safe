'use strict';
// Offline renderer acceptance checks. Displayed use data are fixtures, never an account.
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.disableHardwareAcceleration();
const out=process.env.GPT_ORB_RENDER_OUTPUT || path.resolve(__dirname,'../../build/rendered-safe');
const actions=[];
const views=[];
let settingSaveDelay=0;
let panelHeightLimit=660;
let checks=0;
function equal(actual,expected,message){assert.equal(actual,expected,message);checks++;}
function match(actual,expression){assert.match(actual,expression);checks++;}
let state={status:'waiting',bridge:{listening:true,connected:false,lastReceivedAt:null,port:43861},snapshot:null,error:null,
  settings:{alwaysOnTop:true,autoStart:false,notifications:true,opacity:1}};
ipcMain.handle('test:state',()=>state);
ipcMain.handle('test:action',async(event,action)=>{
  if(action.name==='panelResize'){
    const view=views.find(view=>view.w.webContents===event.sender);
    const height=action.payload?.height;
    if(view?.page!=='panel'||!Number.isInteger(height)||height<240||height>660)return {ok:false};
    if(view.autoResize!==false)await resize(view,view.width,Math.min(height,panelHeightLimit));
    return {ok:true};
  }
  actions.push(action);if(action.name==='setSettings'&&settingSaveDelay)await new Promise(resolve=>setTimeout(resolve,settingSaveDelay));return {ok:true};
});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function make(page,width,height){
  const w=new BrowserWindow({width,height,show:false,frame:false,backgroundColor:'#111918',
    webPreferences:{preload:path.join(__dirname,'render-preload.cjs'),offscreen:true,contextIsolation:true,sandbox:true}});
  const errors=[];
  w.webContents.on('console-message',(_e,level,message)=>{if(level>=3)errors.push(message);});
  const view={w,errors,width,height,page,autoResize:true};views.push(view);
  await w.loadFile(path.join(__dirname,'../src/ui',page+'.html'));
  // Ozone headless can report a 1×1 viewport despite the requested native size.
  // Override only the test viewport; production window behavior is unchanged.
  if(await w.webContents.executeJavaScript('innerWidth')!==width){
    w.webContents.debugger.attach('1.3');view.emulated=true;
    await w.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:view.width,height:view.height,deviceScaleFactor:1,mobile:false});
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
// This fixture tests CSS light transmission, not native Windows backdrop support.
// It never ships in the product, samples a screen, or contacts a network.
async function materialIllustration(view){
  const shellHeight=view.height;
  view.autoResize=false;
  await resize(view,420,shellHeight+130);
  await run(view,`(() => {
    const background=document.createElement('div');background.id='test-material-background';
    background.setAttribute('aria-hidden','true');document.body.prepend(background);
    const caption=document.createElement('div');caption.id='test-material-caption';
    caption.textContent='材质示意 · 示例数据 · 非 Windows 实测';document.body.append(caption);
    document.body.classList.add('native-backdrop');
    document.getElementById('panel-title').textContent='Codex';
  })()`);
  const css=await view.w.webContents.insertCSS(`
    body { display:grid;place-items:center;background:#192c30; }
    #test-material-background { position:absolute;inset:0;background:radial-gradient(ellipse at 4% 26%,#bb985b 0%,transparent 54%),radial-gradient(ellipse at 96% 82%,#588575 0%,transparent 64%),linear-gradient(135deg,#594b5f,#142b3c 64%); }
    #test-material-background::after {content:'';position:absolute;inset:0;background:linear-gradient(143deg,transparent 26%,#bdcdd82b 27%,#bdcdd808 38%,transparent 39%,transparent 63%,#cab98826 64%,#cab98810 72%,transparent 73%);}
    .shell { width:340px;height:${shellHeight}px;backdrop-filter:blur(18px) saturate(1.3); }
    #test-material-caption { position:absolute;bottom:21px;left:0;right:0;text-align:center;font-size:12px;letter-spacing:.3px;color:#e8edf0;background:#142129e8;padding:9px; }
  `);
  await shot(view,'native-material-illustration.png');
  await view.w.webContents.removeInsertedCSS(css);
  await run(view,"document.getElementById('test-material-background').remove();document.getElementById('test-material-caption').remove()");
  await resize(view,340,shellHeight);view.autoResize=true;
}
app.whenReady().then(async()=>{
  fs.mkdirSync(out,{recursive:true});
  const panel=await make('panel',340,240);
  equal(await run(panel,"document.getElementById('empty-state').classList.contains('hidden')"),false);
  equal(await run(panel,"document.getElementById('setup-card').getBoundingClientRect().height"),0,'connection instructions are tucked into settings');
  await run(panel,"document.getElementById('configure-button').focus()");
  equal(await run(panel,"document.activeElement.id"),'configure-button');
  panel.w.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});
  panel.w.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});await wait(30);
  equal(await run(panel,"document.getElementById('settings-view').classList.contains('hidden')"),false,'empty-state keyboard action reaches settings');
  await run(panel,"document.getElementById('pair-button').click()");await wait(30);
  equal(actions.at(-1).name,'copyPairingCode');
  equal(await run(panel,"document.querySelectorAll('input[type=password]').length"),0);
  await run(panel,"document.getElementById('toast').classList.add('hidden')");
  await shot(panel,'setup.png');
  await run(panel,"document.getElementById('back-button').click()");
  const now=Date.now();
  const live={...state,status:'ready',bridge:{...state.bridge,connected:true,lastReceivedAt:now},snapshot:{version:1,source:'official-page',capturedAt:now,
    windows:[{kind:'session',usedPercent:24,resetAt:now+8640000,resetApproximate:false},{kind:'weekly',usedPercent:36,resetAt:now+194340000,resetApproximate:true}],tokens:{total:null,today:null}}};
  await change(panel,live);
  equal(await run(panel,"document.querySelectorAll('.window-value')[1].textContent"),'64%');
  equal(await run(panel,"document.getElementById('total-tokens').textContent"),'—');
  equal(await run(panel,"document.querySelectorAll('.limit-window').length"),2);
  match(await run(panel,"document.getElementById('record-time').title"),/读取时间.*非服务器统计更新时间/);
  match(await run(panel,"document.querySelectorAll('.window-reset')[1].textContent"),/^约 /);
  await run(panel,"document.getElementById('panel-title').textContent='预览 · 示例数据'");
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
  equal(await run(panel,"document.getElementById('sync-status').textContent"),'上次记录');
  match(await run(panel,"document.getElementById('freshness-note').textContent"),/超过 3 分钟/);
  const manual={...live,snapshot:{...live.snapshot,source:'manual-page',tokens:{today:0,total:324523}}};
  await change(panel,manual);
  equal(await run(panel,"document.getElementById('sync-status').textContent"),'人工记录');
  equal(await run(panel,"document.getElementById('today-tokens').textContent"),'0');
  match(await run(panel,"document.getElementById('record-time').title"),/^人工记录时间/);
  match(await run(panel,"document.getElementById('freshness-note').textContent"),/手动更新/);
  const expired=structuredClone(live);expired.snapshot.windows[1].resetAt=now-5000;
  await change(panel,expired);
  equal(await run(panel,"document.querySelectorAll('.window-value')[1].textContent"),'64%');
  equal(await run(panel,"document.querySelectorAll('.window-reset')[1].textContent"),'等待页面确认');
  await change(panel,{...live,snapshot:{...live.snapshot,windows:[]}});
  equal(await run(panel,"document.querySelectorAll('.limit-window').length"),0);
  equal(await run(panel,"document.getElementById('unrecognized-note').classList.contains('hidden')"),false);
  const hostile={...live,error:'<img src=x onerror=alert(1)>'};
  await change(panel,hostile);
  equal(await run(panel,"document.querySelectorAll('#error-text img').length"),0);
  equal(await run(panel,"document.getElementById('error-text').textContent"),hostile.error);
  panelHeightLimit=480;await resize(panel,320,480);
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
      {id:'codex-secondary',kind:'cli',label:'Codex · 每周',usedPercent:36,resetAt:now+194340000},
      {id:'spark-weekly',kind:'cli',label:'Spark · 每周',usedPercent:18,resetAt:now+289340000}
    ],tokens:{today:null,total:null},tokenScope:'account',tokenDate:'2026-09-19',resetCredits:null}};
  panelHeightLimit=660;await resize(panel,340,240);await change(panel,native);
  await run(panel,"document.querySelector('.main-scroll').scrollTop=0;document.getElementById('panel-title').textContent='预览 · 示例数据'");
  equal(await run(panel,"document.getElementById('token-section').open"),false);
  equal(await run(panel,"document.getElementById('token-metrics').classList.contains('hidden')"),true);
  equal(await run(panel,"document.getElementById('token-section').getBoundingClientRect().height"),0,'unavailable token module does not occupy the panel');
  equal(await run(panel,"document.getElementById('codex-controls').getBoundingClientRect().height"),0,'refresh configuration does not occupy the overview');
  equal(await run(panel,"document.getElementById('settings-view').classList.contains('hidden')"),true);
  equal(await run(panel,"document.getElementById('quick-refresh-button').disabled"),false);
  await run(panel,"document.getElementById('quick-refresh-button').click()");await wait(30);
  equal(actions.at(-1).name,'refreshCodex');
  await run(panel,"document.getElementById('toast').classList.add('hidden')");
  equal(await run(panel,"document.querySelectorAll('.limit-window').length"),3);
  equal(await run(panel,`(() => { const rows=[...document.querySelectorAll('.limit-window')].map(row=>row.getBoundingClientRect());return rows[0].top===rows[1].top&&rows[2].top>rows[0].top&&rows[2].width>rows[0].width*1.8; })()`),true,'primary quota windows share a row and the third window spans below them');
  equal(await run(panel,"document.querySelector('.main-scroll').scrollHeight<=document.querySelector('.main-scroll').clientHeight"),true,'three quota windows fit the main panel');
  equal(await run(panel,"document.getElementById('reset-credits-row').classList.contains('hidden')"),true,'unknown reset credits do not occupy space');
  equal(await run(panel,"getComputedStyle(document.querySelector('.shell')).backgroundColor"),'rgb(36, 40, 46)','unsupported compositor uses an honest readable fallback');
  await shot(panel,'native-tokens-unavailable.png');
  const threeWindowHeight=panel.height;
  await change(panel,{...native,snapshot:{...native.snapshot,windows:native.snapshot.windows.slice(0,2)}});
  await run(panel,"document.getElementById('panel-title').textContent='预览 · 示例数据'");
  equal(panel.height<threeWindowHeight,true,'two quota windows request a shorter panel than three');
  equal(panel.height>=240&&panel.height<=360,true,'two-window panel keeps a compact usable height');
  await shot(panel,'native-two-windows.png');
  await change(panel,{...native,snapshot:{...native.snapshot,windows:native.snapshot.windows.slice(0,2).map((window,index)=>({...window,usedPercent:index?100:0}))}});
  equal(await run(panel,"[...document.querySelectorAll('.window-value')].map(value=>value.textContent).join(',')"),'100%,0%');
  equal(await run(panel,"[...document.querySelectorAll('.window-value')].every(value=>value.scrollWidth<=value.clientWidth)"),true,'full and empty quota figures fit the compact columns');
  await shot(panel,'native-limits-extremes.png');
  await change(panel,{...native,snapshot:{...native.snapshot,windows:native.snapshot.windows.slice(0,2)}});
  await materialIllustration(panel);
  await change(panel,native);
  const longLabel='<img src=x onerror=alert(1)> ' + '很长的服务端额度窗口名称'.repeat(8);
  await change(panel,{...native,snapshot:{...native.snapshot,windows:[{...native.snapshot.windows[0],label:longLabel}]}});
  equal(await run(panel,"document.querySelector('.window-name').textContent"),longLabel);
  equal(await run(panel,"document.querySelectorAll('.window-name img').length"),0);
  equal(await run(panel,"document.documentElement.scrollWidth<=innerWidth&&document.querySelector('.main-scroll').scrollWidth<=document.querySelector('.main-scroll').clientWidth"),true,'long untrusted labels never overflow horizontally');
  await shot(panel,'native-long-label.png');
  await change(panel,native);
  equal(await run(panel,"document.getElementById('token-section').classList.contains('hidden')"),true);
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
  panelHeightLimit=480;await resize(panel,320,480);
  await run(panel,"document.querySelector('.main-scroll').scrollTop=0");
  equal(await run(panel,"document.documentElement.scrollWidth<=innerWidth&&document.querySelector('.main-scroll').scrollWidth<=document.querySelector('.main-scroll').clientWidth"),true,'compact panel has no horizontal overflow');
  await shot(panel,'native-compact.png');
  panelHeightLimit=660;await resize(panel,340,240);
  await run(panel,"document.getElementById('settings-button').click()");
  await shot(panel,'native-settings.png');
  const tintState={...native,appearance:{nativeBackdrop:true,backdropStatus:'requested'}};
  await change(panel,tintState);
  await run(panel,"document.getElementById('glass-tint').scrollIntoView({block:'center'});document.getElementById('glass-tint').focus();document.getElementById('glass-tint').value='34';document.getElementById('glass-tint').dispatchEvent(new Event('input',{bubbles:true}))");
  equal(await run(panel,"document.getElementById('glass-tint-value').textContent"),'34%');
  await change(panel,{...tintState,settings:{...native.settings,glassTint:16}});
  equal(await run(panel,"document.getElementById('glass-tint').value"),'34','refresh broadcasts preserve an in-progress tint drag');
  equal(await run(panel,"document.body.style.getPropertyValue('--glass-tint')"),'34%');
  settingSaveDelay=150;
  await run(panel,"document.getElementById('glass-tint').dispatchEvent(new Event('change',{bubbles:true}))");await wait(20);
  equal(actions.at(-1).name,'setSettings');equal(actions.at(-1).payload.glassTint,34);
  await run(panel,"document.getElementById('glass-tint').value='41';document.getElementById('glass-tint').dispatchEvent(new Event('input',{bubbles:true}))");
  await wait(170);
  equal(await run(panel,"document.getElementById('glass-tint').value"),'41','earlier save completion never reverts a newer drag');
  await run(panel,"document.getElementById('glass-tint').dispatchEvent(new Event('change',{bubbles:true}))");await wait(170);settingSaveDelay=0;
  equal(actions.at(-1).payload.glassTint,41);
  await change(panel,{...native,appearance:{nativeBackdrop:true,backdropStatus:'requested'},settings:{...native.settings,glassTint:41}});
  match(await run(panel,"document.getElementById('material-status').textContent"),/已请求.*Windows/);
  equal(await run(panel,"getComputedStyle(document.querySelector('.shell')).backgroundColor"),'rgba(16, 20, 25, 0.41)','native request enables a transmissive shell');
  await change(panel,{...native,snapshot:{...native.snapshot,resetCredits:0}});
  equal(await run(panel,"document.getElementById('reset-credits-row').classList.contains('hidden')"),false);
  equal(await run(panel,"document.getElementById('reset-credits').textContent"),'0','zero reset credits are valid');
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
  equal(await run(panel,"document.getElementById('empty-state').classList.contains('hidden')"),false);
  equal(await run(panel,"document.getElementById('codex-controls').getBoundingClientRect().height"),0,'first-use overview stays compact');
  await shot(panel,'native-first-use.png');
  await change(orb,native);
  equal(await run(orb,"document.getElementById('orb-value').textContent"),'64%');
  await shot(orb,'native-orb.png');
  equal(panel.errors.length+orb.errors.length,0,JSON.stringify([...panel.errors,...orb.errors]));
  console.log(`Renderer acceptance: ${checks} checks passed; offline fixture screenshots saved.`);app.quit();
}).catch(error=>{console.error(error.stack);app.exit(1);});
