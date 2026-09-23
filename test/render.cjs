'use strict';
// Offline renderer acceptance checks. Displayed use data are fixtures, never an account.
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.disableHardwareAcceleration();
const out=process.env.GPT_ORB_RENDER_OUTPUT || path.resolve(__dirname,'../../build/rendered-safe');
const actions=[];
const views=[];
const orbMeasurements=[];
let settingSaveDelay=0;
let panelHeightLimit=660;
let checks=0;
function equal(actual,expected,message){assert.equal(actual,expected,message);checks++;}
function match(actual,expression){assert.match(actual,expression);checks++;}
let state={status:'waiting',bridge:{listening:true,connected:false,lastReceivedAt:null,port:43861},snapshot:null,error:null,
  settings:{alwaysOnTop:true,autoStart:false,notifications:true,opacity:1}};
ipcMain.handle('test:state',()=>state);
ipcMain.handle('test:action',async(event,action)=>{
  if(action.name==='orbExpand'){
    const view=views.find(view=>view.w.webContents===event.sender);
    if(view?.page!=='orb'||typeof action.payload?.expanded!=='boolean')return {ok:false};
    actions.push(action);
    view.requestedExpanded=action.payload.expanded;
    if(view.gesture)return {ok:true,expanded:view.expanded,queued:true};
    view.expanded=view.requestedExpanded;
    return {ok:true,expanded:view.expanded};
  }
  if(action.name==='panelResize'){
    const view=views.find(view=>view.w.webContents===event.sender);
    const height=action.payload?.height;
    if(view?.page!=='panel'||!Number.isInteger(height)||height<240||height>660)return {ok:false};
    if(view.autoResize!==false)await resize(view,view.width,Math.min(height,panelHeightLimit));
    return {ok:true};
  }
  actions.push(action);
  // Deterministic stand-in for the trusted host's cursor verdict. These fixture
  // coordinates exercise the renderer/IPC contract, not native Windows movement.
  const view=views.find(view=>view.w.webContents===event.sender);
  if(view?.page==='orb'){
    if(action.name==='dragStart')view.gesture={start:{...view.pointer},moved:false};
    if(view.gesture&&['dragMove','dragEnd'].includes(action.name)){
      if(action.payload?.cancelled!==true&&Math.hypot(view.pointer.x-view.gesture.start.x,view.pointer.y-view.gesture.start.y)>4)view.gesture.moved=true;
      if(action.name==='dragMove'&&view.gesture.moved)view.nativeMoveCount++;
      if(action.name==='dragEnd'){
        const moved=view.gesture.moved;view.gesture=null;view.expanded=view.requestedExpanded;
        return {ok:true,moved,expanded:view.expanded};
      }
    }
  }
  if(action.name==='setSettings'&&settingSaveDelay)await new Promise(resolve=>setTimeout(resolve,settingSaveDelay));return {ok:true};
});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function make(page,width,height){
  const w=new BrowserWindow({width,height,show:false,frame:false,transparent:page==='orb',backgroundColor:page==='orb'?'#00000000':'#111918',
    webPreferences:{preload:path.join(__dirname,'render-preload.cjs'),offscreen:true,contextIsolation:true,sandbox:true}});
  const errors=[];
  w.webContents.on('console-message',(_e,level,message)=>{if(level>=3)errors.push(message);});
  const view={w,errors,width,height,page,autoResize:true,pointer:{x:0,y:0},nativeMoveCount:0,expanded:false,requestedExpanded:false};views.push(view);
  await w.loadFile(path.join(__dirname,'../src/ui',page+'.html'));
  await w.webContents.executeJavaScript('document.fonts.ready.then(()=>true)');
  // Ozone headless can report a 1×1 viewport despite the requested native size.
  // Override only the test viewport; production window behavior is unchanged.
  if(await w.webContents.executeJavaScript('innerWidth')!==width){
    w.webContents.debugger.attach('1.3');view.emulated=true;
    await w.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:view.width,height:view.height,deviceScaleFactor:1,mobile:false});
  }
  await wait(300);return view;
}
async function resize(view,width,height){
  if(view.page==='orb')assert.fail('The orb native host must never resize after creation.');
  view.w.setSize(width,height);view.width=width;view.height=height;
  if(view.emulated)await view.w.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  await wait(100);
}
async function change(view,newState){state=newState;view.w.webContents.send('test:update',state);await wait(100);}
async function run(view,code){return view.w.webContents.executeJavaScript(code);}
async function orbSize(view){
  equal(view.width,56,'native orb viewport remains 56 DIP');
  equal(view.height,56,'native orb viewport remains 56 DIP');
  return run(view,"(() => {const rect=document.getElementById('orb').getBoundingClientRect();if(rect.x+rect.width/2!==28||rect.y+rect.height/2!==28)throw Error('Orb visual centre moved');return rect.width;})()");
}
async function input(view,event,delay=40){if(event.type==='mouseMove')view.pointer={x:event.x,y:event.y};await view.w.webContents.sendInputEvent(event);await wait(delay);}
async function shot(view,name){view.w.webContents.invalidate();await wait(250);const image=await view.w.webContents.capturePage({x:0,y:0,width:view.width,height:view.height});equal(image.getSize().width,view.width);equal(image.getSize().height,view.height);fs.writeFileSync(path.join(out,name),image.toPNG());}
// Assert the captured compositor pixels, not merely a transparent CSS declaration.
// This checks renderer alpha only; Windows DWM composition is a separate concern.
async function orbAlpha(view,name){
  view.w.webContents.invalidate();await wait(100);
  const size=await orbSize(view),inset=(56-size)/2;
  const png=(await view.w.webContents.capturePage({x:0,y:0,width:view.width,height:view.height})).toPNG();
  const samples=await run(view,`new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>{const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;const context=canvas.getContext('2d');context.drawImage(img,0,0);resolve([[0,0],[img.width-1,0],[0,img.height-1],[img.width-1,img.height-1],[Math.floor(img.width/2),${inset+8}],[Math.floor(img.width/2),${inset+1}]].map(([x,y])=>[...context.getImageData(x,y,1,1).data]));};img.onerror=()=>reject(new Error('Screenshot PNG could not be decoded'));img.src='data:image/png;base64,${png.toString('base64')}';})`);
  equal(samples.slice(0,4).every(pixel=>pixel[3]===0),true,`${name}: all four captured corners have zero alpha`);
  equal(samples[4][3]>0&&samples[4][3]<128,true,`${name}: the circular fill transmits the background`);
  equal(samples[5][3]>=samples[4][3]+25,true,`${name}: the glass edge is visibly stronger than the transmissive center`);
  orbMeasurements.push({name,size,hostSize:view.width,pixels:{corners:samples.slice(0,4),fill:samples[4],rim:samples[5]}});
  return samples;
}
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
  const orb=await make('orb',56,56);
  equal(await run(orb,"[...document.fonts].some(face=>face.family==='Inter'&&face.status==='loaded')&&document.fonts.check('500 20px Inter','100%')"),true,'bundled Inter loads before measuring the percentage');
  match(await run(orb,"getComputedStyle(document.getElementById('orb-value')).fontFamily"),/Inter/);
  equal(await run(orb,"document.getElementById('orb-value').textContent"),'64%');
  await shot(orb,'orb-demo.png');
  equal(await run(orb,"document.getElementById('orb').innerText.trim()==='64%'"),true,'resting orb shows only its percentage');
  equal(await run(orb,"document.documentElement.scrollWidth===56&&document.documentElement.scrollHeight===56"),true,'compact orb is drawn inside a fixed 56 DIP transparent host without scroll content');
  await shot(orb,'orb-compact.png');
  await orbAlpha(orb,'compact orb');
  match(await run(orb,"document.getElementById('orb').title"),/每周额度.*剩余 64%.*页面剩余/);
  match(await run(orb,"document.getElementById('orb').title"),/重置/);
  equal(await run(orb,"document.getElementById('orb').getAttribute('aria-label')"),await run(orb,"document.getElementById('orb').title.replace(/\\n/g,'；')"),'screen-reader description includes the same hover details');
  const interactionStart=actions.length;
  await input(orb,{type:'mouseMove',x:24,y:24},220);
  equal(await orbSize(orb),56,'real pointer entry expands the inner circle without resizing its native host');
  equal(orb.height,56);
  equal(await run(orb,"document.getElementById('orb').innerText.trim()==='64%'"),true,'hover keeps the circle percentage-only');
  await shot(orb,'orb-expanded.png');
  await orbAlpha(orb,'hover orb');
  await input(orb,{type:'mouseMove',x:0,y:0},50);
  equal(await orbSize(orb),56,'brief pointer exit waits before shrinking');
  await input(orb,{type:'mouseMove',x:28,y:28},220);
  equal(await orbSize(orb),56,'pointer reentry cancels the pending shrink');
  equal(actions.slice(interactionStart).filter(action=>action.name==='orbExpand'&&!action.payload.expanded).length,0,'reentry does not repeat the native hit-region request');
  await input(orb,{type:'mouseMove',x:0,y:0},320);
  equal(await orbSize(orb),48,'sustained pointer exit restores the small orb');
  equal(actions.slice(interactionStart).some(action=>action.name==='togglePanel'),false,'hover never opens the panel');
  await input(orb,{type:'mouseMove',x:24,y:24},220);
  await input(orb,{type:'mouseMove',x:28,y:28});
  const clickStart=actions.length;
  await input(orb,{type:'mouseDown',button:'left',clickCount:1});
  await input(orb,{type:'mouseUp',button:'left',clickCount:1});
  equal(actions.slice(clickStart).filter(action=>action.name==='togglePanel').length,1,'one actual pointer click toggles the panel once');
  equal(actions.slice(clickStart).filter(action=>action.name==='dragEnd').length,1,'normal pointer release cleans up capture only once');
  for(const jitter of [false,true]){
    const heldStart=actions.length;
    const moveCount=orb.nativeMoveCount;
    await input(orb,{type:'mouseDown',button:'left',clickCount:1},1100);
    if(jitter){
      for(const [x,y] of [[29,28],[29,29],[27,28],[28,28]])await input(orb,{type:'mouseMove',x,y});
    }
    equal(orb.nativeMoveCount,moveCount,`${jitter?'slight jitter':'stationary long press'} respects the host's unmoved verdict`);
    equal(actions.slice(heldStart).filter(action=>action.name==='orbExpand').length,0,`${jitter?'slight jitter':'stationary long press'} freezes the hover size while held`);
    equal(actions.slice(heldStart).filter(action=>action.name==='togglePanel').length,0,'holding a press never opens the panel before release');
    await input(orb,{type:'mouseUp',button:'left',clickCount:1});
    equal(actions.slice(heldStart).filter(action=>action.name==='togglePanel').length,1,'an unmoved long press releases as one click');
    equal(actions.slice(heldStart).filter(action=>action.name==='dragEnd').length,1,'an unmoved long press cleans up once');
  }
  await run(orb,"document.getElementById('orb').addEventListener('pointerdown',event=>{window.__testPointerId=event.pointerId},{once:true})");
  const coordinateChangeStart=actions.length,coordinateMoveCount=orb.nativeMoveCount;
  await input(orb,{type:'mouseDown',button:'left',clickCount:1});
  // Deliberately disagree with the fixture's unchanged native cursor, as browser
  // screen coordinates can change when a native window is resized or changes DPI.
  await run(orb,"document.getElementById('orb').dispatchEvent(new PointerEvent('pointermove',{pointerId:window.__testPointerId,clientX:28,clientY:28,screenX:10000,screenY:10000,buttons:1,bubbles:true}))");
  await input(orb,{type:'mouseUp',button:'left',clickCount:1});
  equal(orb.nativeMoveCount,coordinateMoveCount,'browser screen-coordinate changes do not override the host cursor verdict');
  equal(actions.slice(coordinateChangeStart).filter(action=>action.name==='togglePanel').length,1,'native unmoved verdict remains a click despite changed browser screen coordinates');
  await input(orb,{type:'mouseMove',x:0,y:0},320);
  equal(await orbSize(orb),48,'mouse-created focus does not keep a departed orb expanded');
  await input(orb,{type:'mouseMove',x:24,y:24},220);
  await input(orb,{type:'mouseMove',x:28,y:28});
  const dragStart=actions.length;
  await input(orb,{type:'mouseDown',button:'left',clickCount:1});
  await input(orb,{type:'mouseMove',x:44,y:28});
  await input(orb,{type:'mouseMove',x:0,y:0},220);
  equal(await orbSize(orb),56,'pointer capture keeps the expanded inner circle stable during dragging');
  await input(orb,{type:'mouseUp',button:'left',clickCount:1},320);
  equal(actions.slice(dragStart).filter(action=>action.name==='togglePanel').length,0,'drag release never opens the panel');
  equal(actions.slice(dragStart).some(action=>action.name==='dragMove'),true,'movement passes through the drag action');
  equal(await orbSize(orb),48,'drag release outside restores the compact inner circle');
  for(const ending of ['pointercancel','lostpointercapture']){
    await input(orb,{type:'mouseMove',x:24,y:24},220);
    await input(orb,{type:'mouseMove',x:28,y:28});
    await run(orb,"document.getElementById('orb').addEventListener('pointerdown',event=>{window.__testPointerId=event.pointerId},{once:true})");
    const cancellationStart=actions.length;
    await input(orb,{type:'mouseDown',button:'left',clickCount:1});
    // Activate the pending capture before simulating its external loss.
    await input(orb,{type:'mouseMove',x:29,y:28});
    await run(orb,ending==='pointercancel'
      ? "document.getElementById('orb').dispatchEvent(new PointerEvent('pointercancel',{pointerId:window.__testPointerId,bubbles:true}))"
      : "document.getElementById('orb').releasePointerCapture(window.__testPointerId)");
    // A subsequent real input flushes the browser's pending lost-capture event.
    await input(orb,{type:'mouseMove',x:30,y:28});
    await input(orb,{type:'mouseUp',button:'left',clickCount:1});
    equal(actions.slice(cancellationStart).filter(action=>action.name==='togglePanel').length,0,`${ending} cannot turn an interrupted gesture into a click`);
    equal(actions.slice(cancellationStart).filter(action=>action.name==='dragEnd').length,1,`${ending} ends the gesture exactly once`);
    await input(orb,{type:'mouseMove',x:0,y:0},320);
    equal(await orbSize(orb),48,`${ending} does not leave hover locked open`);
  }
  await run(orb,"document.body.tabIndex=-1;document.body.focus();document.body.removeAttribute('tabindex')");
  await input(orb,{type:'keyDown',keyCode:'Tab'});
  await input(orb,{type:'keyUp',keyCode:'Tab'},220);
  equal(await run(orb,"document.activeElement.id"),'orb','keyboard navigation can reach the compact orb');
  equal(await orbSize(orb),56,'keyboard-visible focus uses the same small enlargement as hover');
  const keyboardStart=actions.length;
  await input(orb,{type:'keyDown',keyCode:'Return'});
  await input(orb,{type:'keyDown',keyCode:'Return'});
  await input(orb,{type:'keyUp',keyCode:'Return'});
  equal(actions.slice(keyboardStart).filter(action=>action.name==='togglePanel').length,1,'held keyboard activation opens the panel only once');
  await run(orb,"document.getElementById('orb').blur()");await wait(320);
  equal(await orbSize(orb),48,'blur restores compact size after keyboard use');
  await change(orb,stale);match(await run(orb,"document.getElementById('orb').title"),/上次记录/);
  equal(await run(orb,"document.getElementById('orb').innerText.trim()"),'64%','stale detail stays out of the visible circle');
  await change(orb,manual);match(await run(orb,"document.getElementById('orb').title"),/人工记录/);
  await change(orb,expired);match(await run(orb,"document.getElementById('orb').title"),/等待页面确认/);
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
  // The resize crosses the asynchronous renderer/host boundary after a debounce.
  for(let attempts=0;panel.height>=threeWindowHeight&&attempts<20;attempts++)await wait(25);
  equal(panel.height<threeWindowHeight,true,`two quota windows request a shorter panel than three (${panel.height} vs ${threeWindowHeight})`);
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
  await change(panel,{...tintState,appearance:{...tintState.appearance,orbNativeHost:true}});
  equal(await run(panel,"document.getElementById('orb-opacity-row').getBoundingClientRect().height"),0,'native orb host hides the incompatible whole-window opacity setting');
  equal(await run(panel,"document.getElementById('opacity').disabled"),true);
  await change(panel,tintState);
  equal(await run(panel,"document.getElementById('orb-opacity-row').getBoundingClientRect().height>0"),true,'fallback orb retains its opacity setting');
  equal(await run(panel,"document.getElementById('opacity').disabled"),false);
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
  const managedFirst={...native,snapshot:null,error:null,codex:{enabled:false,running:false,state:'disabled'},
    settings:{...native.settings,codexEnabled:false,codexConnection:'managed'},
    codexSetup:{mode:'managed',status:'idle',progress:null,message:''}};
  await change(panel,managedFirst);
  equal(await run(panel,"document.getElementById('configure-button').textContent"),'连接 Codex');
  equal(await run(panel,"document.getElementById('codex-advanced').open"),false,'manual setup stays collapsed');
  equal(await run(panel,"document.getElementById('codex-setup').getBoundingClientRect().height"),0,'managed setup needs no visible command line');
  equal(await run(panel,"document.querySelectorAll('input[type=password]').length"),0,'the orb never asks for the account password');
  equal(await run(panel,"document.querySelector('.main-scroll').scrollWidth<=document.querySelector('.main-scroll').clientWidth"),true,'onboarding fits the compact panel width');
  await shot(panel,'managed-first-use.png');
  await run(panel,"document.getElementById('configure-button').click()");await wait(30);
  equal(actions.at(-1).name,'connectCodex','first-use action starts connection directly');
  equal(await run(panel,"document.getElementById('settings-view').classList.contains('hidden')"),true,'connecting does not send a new user into settings');
  await change(panel,{...managedFirst,codexSetup:{mode:'managed',status:'preparing',progress:62,message:'正在准备官方组件…'}});
  equal(await run(panel,"document.getElementById('configure-button').disabled&&document.getElementById('usage-source').disabled&&document.getElementById('codex-connection').disabled"),true,'connection serializes conflicting actions');
  equal(await run(panel,"document.getElementById('empty-component-progress').value"),62);
  equal(await run(panel,"document.getElementById('empty-cancel-connect-button').disabled"),false);
  await shot(panel,'managed-preparing.png');
  await change(panel,{...managedFirst,codexSetup:{mode:'managed',status:'waiting-login',progress:null,message:''}});
  equal(await run(panel,"document.getElementById('empty-setup-progress').getBoundingClientRect().height"),0,'browser login has no misleading component percentage');
  equal(await run(panel,"document.getElementById('empty-description').textContent"),'请在官方页面登录，完成后自动读取。');
  await shot(panel,'managed-waiting-login.png');
  await run(panel,"document.getElementById('empty-cancel-connect-button').click()");await wait(30);
  equal(actions.at(-1).name,'cancelCodexConnect','the overview can cancel a pending browser login');
  await change(panel,{...managedFirst,codexSetup:{mode:'managed',status:'error',progress:null,message:'<img src=x onerror=alert(1)> 网络连接未完成，请重试。'}});
  equal(await run(panel,"document.querySelectorAll('#empty-description img, #codex-status img').length"),0,'connection errors remain plain text');
  equal(await run(panel,"document.getElementById('configure-button').textContent"),'重新连接');
  equal(await run(panel,"document.getElementById('configure-button').disabled"),false);
  await shot(panel,'managed-error.png');
  await change(panel,{...native,settings:{...native.settings,codexConnection:'managed'},codexSetup:{mode:'managed',status:'connected',progress:null,message:''}});
  equal(await run(panel,"document.getElementById('empty-state').getBoundingClientRect().height"),0,'successful connection returns to quota automatically');
  await run(panel,"document.getElementById('settings-button').click()");
  equal(await run(panel,"document.getElementById('logout-codex-button').getBoundingClientRect().height>0"),true);
  equal(await run(panel,"document.getElementById('connect-codex-button').getBoundingClientRect().height"),0);
  await shot(panel,'managed-connected-settings.png');
  await run(panel,"document.getElementById('codex-advanced').open=true");
  equal(await run(panel,"document.querySelector('.main-scroll').scrollWidth<=document.querySelector('.main-scroll').clientWidth"),true,'advanced mode selector fits without horizontal clipping');
  await run(panel,"document.getElementById('logout-codex-button').click()");await wait(30);
  equal(actions.at(-1).name,'logoutCodex');
  await run(panel,"document.getElementById('back-button').click()");
  await change(orb,native);
  equal(await run(orb,"document.getElementById('orb-value').textContent"),'64%');
  await shot(orb,'native-orb.png');
  const alphaOrb={...native,appearance:{nativeBackdrop:true,orbNativeBackdrop:false,orbNativeHost:false,orbBackdropStatus:'transparent'}};
  await change(orb,alphaOrb);
  equal(await run(orb,"document.body.classList.contains('native-backdrop')"),false,'panel material status cannot enable an orb native backdrop');
  equal(await run(orb,"getComputedStyle(document.getElementById('orb')).backgroundColor"),'rgba(18, 22, 27, 0.22)','percentage orb has a light transparent fill');
  equal(await run(orb,"getComputedStyle(document.getElementById('orb-value')).opacity"),'1','transparent fill keeps the percentage text opaque');
  for(const size of [48,56]){
    await input(orb,{type:'mouseMove',x:size===48?0:24,y:size===48?0:24},320);
    equal(await orbSize(orb),size);
    for(const usedPercent of [0,36,100,null]){
      await change(orb,{...alphaOrb,snapshot:usedPercent===null?null:{...native.snapshot,windows:[{...native.snapshot.windows[0],usedPercent}]}});
      const expected=usedPercent===null?'—':`${100-usedPercent}%`;
      equal(await run(orb,"document.getElementById('orb-value').textContent"),expected);
      const measurement=await run(orb,"(() => {const value=document.getElementById('orb-value'),rect=value.getBoundingClientRect(),circle=document.getElementById('orb').getBoundingClientRect(),style=getComputedStyle(value);return {value:value.textContent,left:rect.left-circle.left,right:circle.right-rect.right,top:rect.top-circle.top,bottom:circle.bottom-rect.bottom,fontSize:style.fontSize};})()");
      equal(Math.min(measurement.left,measurement.right)>=6.5,true,`${expected} leaves at least 6.5 DIP on each side at ${size} DIP (${JSON.stringify(measurement)})`);
      orbMeasurements.push({size,...measurement});
      await shot(orb,`orb-${size===48?'compact':'hover'}-${usedPercent===null?'unknown':usedPercent===0?'full':usedPercent===100?'zero':'64'}.png`);
    }
  }
  await input(orb,{type:'mouseMove',x:0,y:0},320);
  await change(orb,{...alphaOrb,snapshot:null});
  equal(await run(orb,"document.getElementById('orb').innerText.trim()"),'—','unavailable quota displays no misleading percentage');
  match(await run(orb,"document.getElementById('orb').title"),/额度未知/);
  await shot(orb,'orb-compact-unknown.png');
  await change(orb,alphaOrb);
  await shot(orb,'orb-alpha-compact.png');
  await input(orb,{type:'mouseMove',x:24,y:24},220);
  equal(await run(orb,"(() => {const rect=document.getElementById('orb-value').getBoundingClientRect();return rect.left>=4&&rect.right<=52&&rect.top>=8&&rect.bottom<=48;})()"),true,'hover percentage fits within the 56 DIP circle');
  equal(await run(orb,"document.getElementById('orb').innerText.trim()"),'64%','hover does not add visible labels');
  await shot(orb,'orb-alpha-hover.png');
  await orbAlpha(orb,'Codex hover orb');
  await change(orb,{...alphaOrb,appearance:{...alphaOrb.appearance,reducedTransparency:true}});
  equal(await run(orb,"getComputedStyle(document.getElementById('orb')).backgroundColor"),'rgb(23, 27, 34)','reduced transparency overrides the translucent fill');
  await change(orb,{...alphaOrb,appearance:{...alphaOrb.appearance,highContrast:true,reducedTransparency:true}});
  equal(await run(orb,"document.body.classList.contains('high-contrast')"),true);
  await shot(orb,'orb-high-contrast.png');
  await change(panel,{...native,updates:{...updates,status:'ready',currentVersion:'2.4.1',availableVersion:version,lastCheckedAt:now}});
  const updatePreview=await make('panel',340,240);
  await run(updatePreview,"document.getElementById('settings-button').click();document.querySelector('.updates-group').scrollIntoView({block:'start'})");
  equal(await run(updatePreview,"document.getElementById('install-update-button').disabled"),false,'a freshly opened ready update can be installed');
  await shot(updatePreview,'updates-next-ready-demo.png');
  const rendererErrors=views.flatMap(view=>view.errors);
  equal(rendererErrors.length,0,JSON.stringify(rendererErrors));
  fs.writeFileSync(path.join(out,'orb-renderer-evidence.json'),JSON.stringify({scope:'Real Chromium or Electron renderer only; no Windows desktop composition claim',orbMeasurements,rendererErrors},null,2)+'\n');
  console.log(`Renderer acceptance: ${checks} checks passed; offline fixture screenshots saved.`);app.quit();
}).catch(error=>{console.error(error.stack);app.exit(1);});
