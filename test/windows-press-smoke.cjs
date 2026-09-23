'use strict';

// CI only. Real SendInput/SetCursorPos events run the unchanged production main,
// preload and renderer. A temporary profile disables account reads, updates and
// startup registration; the app's normal loopback bridge is isolated to CI.
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');
const readline=require('node:readline');
const root=path.resolve(__dirname,'..');
const output=path.join(root,'dist','windows-press-diagnostic');
const writeReport=report=>{fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'diagnostic.json'),JSON.stringify(report,null,2)+'\n');};

if(!process.versions.electron){
  if(process.platform!=='win32'){
    console.log('Real Windows mouse regression requires Windows.');
  }else{
    const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'gpt-orb-press-ci-'));
    try{
      const runtime=path.join(root,'dist','win-unpacked');
      for(const entry of fs.readdirSync(runtime))if(entry!=='resources')fs.cpSync(path.join(runtime,entry),path.join(temporary,entry),{recursive:true});
      const fixture=path.join(temporary,'resources','app');
      fs.mkdirSync(fixture,{recursive:true});
      fs.writeFileSync(path.join(fixture,'package.json'),JSON.stringify({name:'orb-real-press-ci',version:'1.0.0',main:'main.cjs'}));
      fs.writeFileSync(path.join(fixture,'main.cjs'),`require(${JSON.stringify(__filename)});\n`);
      fs.cpSync(path.join(root,'extension'),path.join(fixture,'extension'),{recursive:true});
      const env={...process.env,GPT_ORB_PRESS_PROFILE:path.join(temporary,'profile')};
      delete env.ELECTRON_RUN_AS_NODE;
      // Deliberately no app-update.yml: the production updater cannot initialize.
      const result=spawnSync(path.join(temporary,'GPT-Orb.exe'),['--startup'],{env,stdio:'inherit',timeout:70000,windowsHide:false});
      if(result.error)throw result.error;
      if(result.status!==0)process.exitCode=result.status||1;
      else{
        const report=JSON.parse(fs.readFileSync(path.join(output,'diagnostic.json'),'utf8'));
        assert.equal(report.status,'passed','Native input did not establish a passing result.');
      }
    }catch(error){
      writeReport({status:'failed',reason:error.message});
      console.error('Real Windows press test failed:',error.message);process.exitCode=1;
    }finally{fs.rmSync(temporary,{recursive:true,force:true,maxRetries:3,retryDelay:200});}
  }
}else{
  const {app,BrowserWindow,ipcMain,screen,session}=require('electron');
  const {HOST_SIZE,HOST_INSET,COMPACT_SIZE,EXPANDED_SIZE}=require('../src/orb-window.cjs');
  const report={schema:1,status:'running',scope:'Real Windows mouse events through production main/preload/orb.js',
    scaleCoverage:'Current native Windows display scale only; no forced device scale.',
    stationary:[],drag:null,actions:[],events:[],geometryEvents:[],samples:[],networkBlocked:0};
  const profile=process.env.GPT_ORB_PRESS_PROFILE;
  assert(profile,'Missing isolated profile.');fs.mkdirSync(profile,{recursive:true});app.setPath('userData',profile);
  const preferences=path.join(profile,'preferences.json');
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  let orb,helper,stationaryBounds=null,finished=false;
  const deadline=setTimeout(()=>void finish(new Error('Real mouse test exceeded 60 seconds.')),60000);

  async function finish(error){
    if(finished)return;finished=true;clearTimeout(deadline);
    try{await helper?.stop();}catch{}
    report.status=error?'failed':'passed';
    if(error)report.reason=String(error.message||error);
    writeReport(report);console.log(`Real Windows press report: ${JSON.stringify(report)}`);
    process.exitCode=error?1:0;
    // Production before-quit closes the loopback bridge and saves the isolated
    // profile. Bound cleanup even when a native renderer has failed.
    const exitTimer=setTimeout(()=>app.exit(error?1:0),1500);exitTimer.unref();
    app.quit();
  }
  process.on('uncaughtException',error=>void finish(error));
  process.on('unhandledRejection',error=>void finish(error));
  async function until(check,label,timeout=5000){
    const started=Date.now();
    while(Date.now()-started<timeout){const value=await check();if(value)return value;await pause(25);}
    throw new Error(`Timed out: ${label}`);
  }
  const actionCount=name=>report.actions.filter(value=>value.name===name).length;
  const lastAction=name=>report.actions.filter(value=>value.name===name).at(-1);
  const equalBounds=(actual,expected,label)=>assert.deepEqual(actual,expected,label);

  async function startHelper(){
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(__dirname,'windows-press-native.ps1')],
      {env:{...process.env,GPT_ORB_PRESS_PID:String(process.pid)},stdio:['pipe','pipe','pipe'],windowsHide:true});
    const pending=new Map();let sequence=0,stderr='',stopped=false;
    const wait=(label,budget=5000)=>new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(label);reject(new Error(`Native input timed out: ${label}`));},budget);
      pending.set(label,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
    });
    const ready=wait('ready',15000);
    const fail=error=>{for(const item of pending.values())item.reject(error);pending.clear();};
    child.on('error',fail);child.on('exit',code=>{if(!stopped)fail(new Error(`Native input helper exited ${code}: ${stderr.slice(-500)}`));});
    child.stderr.on('data',data=>{stderr=(stderr+data).slice(-1000);});
    readline.createInterface({input:child.stdout}).on('line',line=>{
      try{
        const value=JSON.parse(line.replace(/^\uFEFF/,'')),label=value.kind==='ready'?'ready':value.label;
        const item=pending.get(label);if(!item)throw new Error('Unexpected native input response.');
        pending.delete(label);if(value.error)item.reject(new Error(value.error));else item.resolve(value);
      }catch(error){fail(error);}
    });
    const handle=orb.getNativeWindowHandle(),handleHex=(handle.length===8?handle.readBigUInt64LE():BigInt(handle.readUInt32LE())).toString(16);
    const api={
      async query(operation,point){
        const label=`${++sequence}-${operation}`,result=wait(label);
        child.stdin.write(JSON.stringify({label,handleHex,operation,...point})+'\n');return result;
      },
      async move(point){
        const physical=screen.dipToScreenPoint(point),value=await api.query('move',physical);
        assert.deepEqual(value.cursor,physical,'Native cursor did not reach requested physical point.');return value;
      },
      async stop(){
        if(stopped)return;stopped=true;
        // EOF invokes PowerShell finally to release the button and restore cursor.
        child.stdin.end();await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(1000)]);
        if(child.exitCode===null)child.kill();
      }
    };
    helper=api;await ready;return api;
  }

  async function dom(){return orb.webContents.executeJavaScript(`(() => {
    const orb=document.getElementById('orb'),r=orb.getBoundingClientRect();
    return{expanded:orb.dataset.expanded,rect:{x:r.x,y:r.y,width:r.width,height:r.height},events:window.__pressEvents.slice()};
  })()`);}
  async function sample(label,expected,{cursor}={}){
    const native=await helper.query('sample'),dip=orb.getBounds();
    const value={label,dip,native:native.bounds,cursor:native.cursor};report.samples.push(value);
    if(expected){equalBounds(dip,expected.dip,`${label}: DIP host drift`);equalBounds(native.bounds,expected.native,`${label}: native HWND drift`);}
    if(cursor)assert.deepEqual(native.cursor,cursor,`${label}: system cursor unexpectedly moved`);
    return value;
  }
  async function expanded(value){
    const expected=value?EXPANDED_SIZE:COMPACT_SIZE,inset=value?0:HOST_INSET;
    return until(async()=>{
      const valueNow=await dom();if(valueNow.expanded!==String(value))return false;
      if(Math.abs(valueNow.rect.width-expected)>.01||Math.abs(valueNow.rect.height-expected)>.01)return false;
      assert.equal(valueNow.rect.x,inset);assert.equal(valueNow.rect.y,inset);return valueNow;
    },`visual size ${expected}`);
  }

  app.whenReady().then(async()=>{
    const display=screen.getPrimaryDisplay(),area=display.workArea;
    assert(area.width>600&&area.height>450,'CI desktop too small for bounded input fixture.');
    report.display={scaleFactor:display.scaleFactor,width:area.width,height:area.height};
    const position={x:area.x+220,y:area.y+170};
    fs.writeFileSync(preferences,JSON.stringify({settings:{usageSource:'codex-cli',codexEnabled:false,autoStart:false,
      autoCheckUpdates:false,notifications:false,alwaysOnTop:true,opacity:1},position}));
    session.defaultSession.webRequest.onBeforeRequest((details,callback)=>{
      const cancel=!details.url.startsWith('file:')&&!details.url.startsWith('data:');if(cancel)report.networkBlocked++;callback({cancel});
    });
    // Record invocations but forward the actual sender, payload and result
    // unchanged. No synthetic IPC handlers or renderer API replacements.
    const register=ipcMain.handle.bind(ipcMain);
    ipcMain.handle=(channel,handler)=>register(channel,async(event,...args)=>{
      const result=await handler(event,...args);
      if(channel==='orb:action'&&['orbExpand','dragStart','dragMove','dragEnd','togglePanel'].includes(args[0])){
        report.actions.push({name:args[0],result});
      }
      return result;
    });
    require('../src/main.cjs');
    orb=await until(()=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().endsWith('/orb.html')&&window.isVisible()),'production orb loaded');
    const panel=BrowserWindow.getAllWindows().find(window=>window!==orb);
    orb.webContents.on('render-process-gone',()=>void finish(new Error('Production renderer exited.')));
    const state=await orb.webContents.executeJavaScript('window.orb.getState()');
    assert.equal(state.settings.codexEnabled,false);assert.equal(state.settings.autoStart,false);assert.equal(state.settings.autoCheckUpdates,false);
    assert.equal(state.codex.enabled,false);assert.equal(state.updates.status,'unconfigured');
    await orb.webContents.executeJavaScript(`(() => {
      window.__pressEvents=[];const orb=document.getElementById('orb');
      for(const type of ['pointerenter','pointerleave','pointerdown','pointerup','pointercancel','gotpointercapture','lostpointercapture'])
        orb.addEventListener(type,event=>window.__pressEvents.push({type,trusted:event.isTrusted,button:event.button}),true);
    })()`);
    await startHelper();
    const away={x:area.x+80,y:area.y+70};await helper.move(away);await expanded(false);
    const baseline=await sample('initial-compact');
    assert.equal(baseline.dip.width,HOST_SIZE);assert.equal(baseline.dip.height,HOST_SIZE);
    stationaryBounds=baseline.dip;
    for(const event of ['move','resize'])orb.on(event,()=>{
      if(finished)return;
      const bounds=orb.getBounds();report.geometryEvents.push({event,bounds});
      if(stationaryBounds)try{equalBounds(bounds,stationaryBounds,`Native ${event} changed the host during stationary press/hover.`);}catch(error){void finish(error);}
    });
    const center={x:baseline.dip.x+HOST_SIZE/2,y:baseline.dip.y+HOST_SIZE/2};
    for(let iteration=1;iteration<=3;iteration++){
      panel.hide();await helper.move(center);await expanded(true);
      const hovered=await sample(`hold-${iteration}-hover`,baseline);
      const starts=actionCount('dragStart'),ends=actionCount('dragEnd');
      await helper.query('down');await until(()=>actionCount('dragStart')===starts+1,'trusted dragStart');
      assert.equal(lastAction('dragStart').result.ok,true);
      for(let part=0;part<6;part++){await pause(200);await sample(`hold-${iteration}-${part}`,baseline,{cursor:hovered.cursor});}
      await helper.query('up');await until(()=>actionCount('dragEnd')===ends+1,'trusted dragEnd');
      assert.equal(lastAction('dragEnd').result.ok,true);assert.equal(lastAction('dragEnd').result.moved,false);
      await pause(350);await sample(`hold-${iteration}-released`,baseline,{cursor:hovered.cursor});
      panel.hide();await helper.move(away);await expanded(false);await sample(`hold-${iteration}-left`,baseline);
      const stored=JSON.parse(fs.readFileSync(preferences,'utf8'));assert.deepEqual(stored.position,position,'Stationary press changed persisted position.');
      report.stationary.push({iteration,holdMs:1200,moved:false});
    }
    // Exercise actual movement so a disconnected/no-op input path cannot pass.
    await helper.move(center);await expanded(true);
    stationaryBounds=null;
    const starts=actionCount('dragStart'),ends=actionCount('dragEnd');
    await helper.query('down');await until(()=>actionCount('dragStart')===starts+1,'moving dragStart');
    for(let step=1;step<=3;step++){await helper.move({x:center.x+20*step,y:center.y+12*step});await pause(120);}
    await helper.query('up');await until(()=>actionCount('dragEnd')===ends+1,'moving dragEnd');
    assert.equal(lastAction('dragEnd').result.ok,true);assert.equal(lastAction('dragEnd').result.moved,true);
    await pause(400);
    const final=await sample('drag-released');
    stationaryBounds=final.dip;
    assert.equal(final.dip.x,baseline.dip.x+60);assert.equal(final.dip.y,baseline.dip.y+36);
    assert.equal(final.dip.width,HOST_SIZE);assert.equal(final.dip.height,HOST_SIZE);
    const saved=JSON.parse(fs.readFileSync(preferences,'utf8')).position;
    assert.deepEqual(saved,{x:final.dip.x+HOST_INSET,y:final.dip.y+HOST_INSET},'Drag did not save visible compact position.');
    await helper.move(away);await expanded(false);await sample('drag-left',final);
    const events=(await dom()).events;
    for(const type of ['pointerdown','pointerup'])assert.equal(events.filter(event=>event.type===type&&event.trusted).length,4,`Missing real ${type} events.`);
    assert.equal(events.filter(event=>event.type==='pointercancel').length,0,'Unexpected native pointer cancellation.');
    report.events=Object.fromEntries([...new Set(events.map(event=>event.type))].map(type=>[type,{count:events.filter(event=>event.type===type).length,trusted:events.filter(event=>event.type===type).every(event=>event.trusted)}]));
    report.drag={delta:{x:60,y:36},savedDelta:{x:saved.x-position.x,y:saved.y-position.y},moved:true};
    report.isolation={codexDisabled:true,autoStartDisabled:true,updaterUnconfigured:true,temporaryProfile:true};
    await finish();
  }).catch(error=>void finish(error));
}
