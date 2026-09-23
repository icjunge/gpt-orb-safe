'use strict';

// CI-only visual diagnostic. This file is excluded from the installed app.
// A synthetic background window stands in for another app; no account is read,
// no network is used and only its cropped desktop-composited pixels are saved.
// capturePage cannot see a native backdrop and is deliberately not used here.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn,spawnSync}=require('node:child_process');
const readline=require('node:readline');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const output=path.resolve(process.env.GPT_ORB_BACKDROP_OUTPUT||path.join(root,'dist','windows-backdrop-diagnostic'));

function writeReport(report){
  fs.mkdirSync(output,{recursive:true});
  fs.writeFileSync(path.join(output,'diagnostic.json'),JSON.stringify(report,null,2)+'\n');
}

if(!process.versions.electron){
  fs.mkdirSync(output,{recursive:true});
  if(process.platform!=='win32'){
    writeReport({status:'unverified',reason:'This compositor diagnostic requires Windows.'});
  }else{
    // Reuse the runtime just built by electron-builder. Do not edit the tested
    // app.asar/installer and do not fetch a second Electron distribution.
    const startedAt=Date.now();
    const source=path.join(root,'dist','win-unpacked');
    const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'gpt-orb-backdrop-ci-'));
    try{
      for(const entry of fs.readdirSync(source)){
        if(entry==='resources')continue;
        fs.cpSync(path.join(source,entry),path.join(temporary,entry),{recursive:true});
      }
      const fixture=path.join(temporary,'resources','app');
      fs.mkdirSync(fixture,{recursive:true});
      fs.writeFileSync(path.join(fixture,'package.json'),JSON.stringify({name:'orb-native-backdrop-ci',version:'1.0.0',main:'main.cjs'}));
      fs.writeFileSync(path.join(fixture,'main.cjs'),`require(${JSON.stringify(__filename)});\n`);
      const remainingMs=Math.max(1000,48000-(Date.now()-startedAt));
      const env={...process.env,GPT_ORB_BACKDROP_OUTPUT:output,GPT_ORB_BACKDROP_PROFILE:path.join(temporary,'profile'),
        GPT_ORB_BACKDROP_TIMEOUT_MS:String(Math.max(1000,remainingMs-1000))};
      delete env.ELECTRON_RUN_AS_NODE;
      const result=spawnSync(path.join(temporary,'GPT-Orb.exe'),[],{env,stdio:'inherit',timeout:remainingMs,windowsHide:false});
      if(result.error?.code==='ETIMEDOUT'){
        writeReport({status:'unverified',reason:'The CI desktop/compositor did not complete within 48 seconds.'});
      }else if(result.error){throw result.error;}
      else if(result.status!==0){process.exitCode=result.status||1;}
      else if(!fs.existsSync(path.join(output,'diagnostic.json'))){
        throw new Error('The compositor fixture exited without its diagnostic report.');
      }
    }finally{
      fs.rmSync(temporary,{recursive:true,force:true,maxRetries:2,retryDelay:200});
    }
  }
}else{
  const {app,BrowserWindow,desktopCapturer,ipcMain,nativeTheme,screen,session}=require('electron');
  const {COMPACT_SIZE,EXPANDED_SIZE,circleShape,createOrbController}=require('../src/orb-window.cjs');
  const {applyOrbMaterial}=require('../src/window-material.cjs');
  const report={
    schema:3,status:'unverified',environment:'Windows CI virtual machine, not the user’s hardware',
    scope:'Inactive, always-on-top shaped HWND over a separate synthetic background window',
    limitation:'Checks visible alpha transparency and circular clipping only. Alpha transparency does not diffuse or blur the background.',
    captureLimitation:'Unavailable or incomplete VM desktop capture remains unverified. Captured pixels are not a guarantee for another device.',
    os:{platform:process.platform,release:os.release()},versions:{electron:process.versions.electron,chrome:process.versions.chrome},
    windows:[],captures:[],evidence:[],controls:[]
  };
  app.setPath('userData',process.env.GPT_ORB_BACKDROP_PROFILE);
  nativeTheme.themeSource='dark';
  const desktopBudget=Math.min(46000,Number(process.env.GPT_ORB_BACKDROP_TIMEOUT_MS)||46000);
  const timer=setTimeout(()=>finish('unverified','The fixture exceeded its bounded desktop deadline.'),desktopBudget);
  let background,orb,controller,nativeProbe,finished=false;
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  function finish(status,reason,error){
    if(finished)return;finished=true;clearTimeout(timer);
    Object.assign(report,{status,reason});
    if(error)report.error=String(error.stack||error);
    report.gpuFeatureStatus=app.isReady()?app.getGPUFeatureStatus():{status:'not-ready'};
    nativeProbe?.stop();
    writeReport(report);
    // Synthetic fixture metadata stays inspectable when artifact transfers are unavailable.
    console.log(`Native backdrop report: ${JSON.stringify(report)}`);
    console.log(`Native backdrop diagnostic: ${status}. ${reason}`);
    app.exit(error?1:0);
  }
  process.on('uncaughtException',error=>finish('error','Unexpected fixture error.',error));
  process.on('unhandledRejection',error=>finish('error','Unexpected fixture rejection.',error));
  class CaptureUnavailable extends Error{}

  async function startNativeProbe(){
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(__dirname,'windows-backdrop-native.ps1')],
      {env:{...process.env,GPT_ORB_BACKDROP_PID:String(process.pid)},stdio:['pipe','pipe','pipe'],windowsHide:true});
    const waiting=new Map();let stderr='',sequence=0,stopped=false;
    const pending=(key,timeoutMs=6500)=>new Promise((resolve,reject)=>{
      const deadline=setTimeout(()=>{waiting.delete(key);reject(new Error(`Native metadata query timed out: ${key}`));},timeoutMs);
      waiting.set(key,{resolve:value=>{clearTimeout(deadline);resolve(value);},reject:error=>{clearTimeout(deadline);reject(error);}});
    });
    // Cold .NET/PowerShell startup under Windows ARM x64 emulation can exceed
    // the normal per-window query budget. The outer desktop deadline is unchanged.
    const system=pending('system',15000);
    const fail=error=>{for(const value of waiting.values())value.reject(error);waiting.clear();};
    child.on('error',fail);
    child.on('exit',code=>{if(!stopped)fail(new Error(`Native metadata helper exited ${code}: ${stderr.slice(0,1200)}`));});
    child.stderr.on('data',bytes=>{stderr=(stderr+bytes.toString()).slice(-3000);});
    readline.createInterface({input:child.stdout}).on('line',line=>{
      try{
        const value=JSON.parse(line.replace(/^\uFEFF/,'')),key=value.kind==='system'?'system':value.label;
        if(value.kind==='error'||value.error)throw new Error(value.error||value.message||'Native metadata helper failed');
        const request=waiting.get(key);if(!request)throw new Error('Unexpected native metadata response');
        waiting.delete(key);request.resolve(value);
      }catch(error){fail(error);}
    });
    const api={
      query:async(window,label)=>{
        const key=`${++sequence}-${label}`,handle=window.getNativeWindowHandle();
        const handleHex=(handle.length===8?handle.readBigUInt64LE():BigInt(handle.readUInt32LE())).toString(16);
        const response=pending(key);
        child.stdin.write(JSON.stringify({label:key,handleHex})+'\n');
        return response;
      },
      stop(){stopped=true;child.stdin.end();child.kill();}
    };
    nativeProbe=api;
    report.nativeSystem=await system;
    report.dwm=report.nativeSystem.dwm;
    return api;
  }

  const html='<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>html,body{margin:0;overflow:hidden}canvas{display:block}</style><canvas width="480" height="360"></canvas>';
  async function paint(phase,focusWindow=background){
    // The independent background keeps fine stripes while broad colors change.
    // Alpha should attenuate both similarly; a solid fill must not respond.
    await background.webContents.executeJavaScript(`(() => {
      const c=document.querySelector('canvas'),g=c.getContext('2d');
      g.fillStyle=${JSON.stringify(phase?'rgb(38,106,222)':'rgb(216,64,56)')};g.fillRect(0,0,480,360);
      for(let x=0;x<480;x+=4){g.fillStyle='rgba(255,255,255,.50)';g.fillRect(x,0,2,360);}
      g.fillStyle='#24b978';g.fillRect(400,0,80,360);g.fillStyle='#e19a35';g.fillRect(0,300,400,60);
      g.fillStyle='#ffffff';g.font='16px Segoe UI';g.fillText('CI fixture · synthetic background · phase ${phase}',18,333);
    })()`);
    focusWindow.focus();
    await pause(300);
  }

  async function capture(name,view=orb,{logImage=false}={}){
    const display=screen.getDisplayMatching(background.getBounds());
    const size={width:Math.round(display.bounds.width*display.scaleFactor),height:Math.round(display.bounds.height*display.scaleFactor)};
    let sources;
    try{sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:size,fetchWindowIcons:false});}
    catch(error){throw new CaptureUnavailable(`Desktop capture unavailable: ${String(error.message||error)}`);}
    const source=sources.find(source=>source.display_id===String(display.id));
    if(!source||source.thumbnail.isEmpty())throw new CaptureUnavailable('The CI desktop returned no matching screen pixels.');
    const actual=source.thumbnail.getSize();
    const scaleX=actual.width/display.bounds.width,scaleY=actual.height/display.bounds.height;
    if(actual.width<display.bounds.width/2||actual.height<display.bounds.height/2)throw new CaptureUnavailable('The CI desktop thumbnail is too small for a transparency diagnostic.');
    const bounds=background.getContentBounds();
    const crop={x:Math.round((bounds.x-display.bounds.x)*scaleX),y:Math.round((bounds.y-display.bounds.y)*scaleY),
      width:Math.round(bounds.width*scaleX),height:Math.round(bounds.height*scaleY)};
    if(crop.x<0||crop.y<0||crop.x+crop.width>actual.width||crop.y+crop.height>actual.height)throw new CaptureUnavailable('The fixture is outside the captured display.');
    const image=source.thumbnail.crop(crop);
    fs.writeFileSync(path.join(output,`${name}.png`),image.toPNG());
    const state={name,backgroundFocused:background.isFocused(),orbFocused:view.isFocused(),orbVisible:view.isVisible(),
      orbBounds:view.getBounds(),contentBounds:view.getContentBounds(),backgroundBounds:bounds,imageSize:image.getSize(),screenScaleFactor:display.scaleFactor};
    report.captures.push(state);
    if(logImage){
      const center={x:(state.orbBounds.x-bounds.x+state.orbBounds.width/2)*scaleX,y:(state.orbBounds.y-bounds.y+state.orbBounds.height/2)*scaleY};
      const width=Math.min(image.getSize().width,Math.round(168*scaleX)),height=Math.min(image.getSize().height,Math.round(168*scaleY));
      const preview=image.crop({x:Math.max(0,Math.min(image.getSize().width-width,Math.round(center.x-width/2))),
        y:Math.max(0,Math.min(image.getSize().height-height,Math.round(center.y-height/2))),width,height}).toPNG();
      const encoded=preview.toString('base64'),chunks=Math.ceil(encoded.length/4096);
      console.log(`Native backdrop image: ${JSON.stringify({name,width,height,bytes:preview.length,sha256:crypto.createHash('sha256').update(preview).digest('hex'),chunks})}`);
      for(let i=0;i<chunks;i++)console.log(`Native backdrop png ${name} ${i+1}/${chunks}: ${encoded.slice(i*4096,(i+1)*4096)}`);
    }
    return{state,bitmap:image.toBitmap(),width:image.getSize().width,height:image.getSize().height,scaleX,scaleY};
  }

  function pixel(image,x,y){
    const index=(Math.max(0,Math.min(image.height-1,Math.round(y*image.scaleY)))*image.width+
      Math.max(0,Math.min(image.width-1,Math.round(x*image.scaleX))))*4;
    return[image.bitmap[index+2],image.bitmap[index+1],image.bitmap[index]];
  }
  function patch(image,size){
    const {orbBounds,backgroundBounds}=image.state;
    const center={x:orbBounds.x-backgroundBounds.x+orbBounds.width/2,y:orbBounds.y-backgroundBounds.y+orbBounds.height/2};
    // Sample a patch inside the circle's upper arc, clear of its border and
    // centered percentage. Scaled offsets work for both 48px and 56px windows.
    const radius=size/2;
    const rows=[...new Set([-.76,-.72,-.68].map(ratio=>Math.round(radius*ratio)))];
    const half=Math.max(3,Math.floor(radius*.38));
    const values=[];let difference=0,pairs=0;
    for(const row of rows){let previous;
      for(let x=-half;x<=half;x++){
        const value=pixel(image,center.x+x,center.y+row);values.push(value);
        if(previous){difference+=value.reduce((sum,channel,i)=>sum+Math.abs(channel-previous[i]),0)/3;pairs++;}
        previous=value;
      }
    }
    return{mean:[0,1,2].map(channel=>values.reduce((sum,value)=>sum+value[channel],0)/values.length),fineContrast:difference/pairs};
  }
  const distance=(a,b)=>a.reduce((sum,value,i)=>sum+Math.abs(value-b[i]),0)/3;
  function compare(size,a,b,baseA,baseB){
    // Baseline samples use the same size's bounds even though the orb is hidden.
    const baseFor=(base,view)=>({...base,state:{...base.state,orbBounds:view.state.orbBounds}});
    const observed=[patch(a,size),patch(b,size)],baseline=[patch(baseFor(baseA,a),size),patch(baseFor(baseB,b),size)];
    const backgroundColorChange=distance(baseline[0].mean,baseline[1].mean);
    const observedColorChange=distance(observed[0].mean,observed[1].mean);
    const fineTransfer=(observed[0].fineContrast+observed[1].fineContrast)/Math.max(1,baseline[0].fineContrast+baseline[1].fineContrast);
    const colorTransfer=observedColorChange/Math.max(1,backgroundColorChange);
    const stripeToColorTransfer=fineTransfer/Math.max(.01,colorTransfer);
    const focusCorrect=[a,b].every(view=>view.state.backgroundFocused&&!view.state.orbFocused&&view.state.orbVisible);
    const cornerDifferences=(view,base)=>{
      const left=view.state.orbBounds.x-view.state.backgroundBounds.x,top=view.state.orbBounds.y-view.state.backgroundBounds.y;
      const {width,height}=view.state.orbBounds;
      // Every sample is within the outermost 2 DIP of its square window corner,
      // safely outside the 48/56px circle, including its antialiased border.
      return[[1,1],[width-2,1],[1,height-2],[width-2,height-2]].map(([x,y])=>
        distance(pixel(view,left+x,top+y),pixel(base,left+x,top+y)));
    };
    const clippedCornerDifferences=[cornerDifferences(a,baseA),cornerDifferences(b,baseB)];
    const baselineValid=backgroundColorChange>35&&baseline.every(value=>value.fineContrast>5);
    const orbPixelsObserved=baselineValid&&observed.every((value,index)=>
      distance(value.mean,baseline[index].mean)>5||Math.abs(value.fineContrast-baseline[index].fineContrast)>3);
    // Unchanged desktop pixels cannot establish clipping: the entire fixture
    // can be absent from the capture on a hosted Windows 11 session.
    const shapeClipObserved=baselineValid&&orbPixelsObserved?clippedCornerDifferences.flat().every(value=>value<5):null;
    const alphaResponseObserved=baselineValid&&orbPixelsObserved&&observedColorChange>5&&
      colorTransfer>.1&&colorTransfer<.98&&stripeToColorTransfer>.75&&stripeToColorTransfer<1.25;
    return{size,focusCorrect,baselineValid,orbPixelsObserved,shapeClipObserved,alphaResponseObserved,
      baseline,observed,backgroundColorChange,observedColorChange,fineTransfer,colorTransfer,stripeToColorTransfer,clippedCornerDifferences};
  }

  function nativeCircleObserved(native){
    const contains=native?.region?.contains;
    return native?.region?.result===3&&contains?.center===true&&
      ['topLeft','topRight','bottomLeft','bottomRight'].every(key=>contains[key]===false);
  }

  function nativeAlphaHostObserved(native){
    return native?.systemBackdrop?.hresult===0&&native.systemBackdrop.value===1&&native.styles?.layered===true;
  }

  function watch(window){
    window.webContents.on('render-process-gone',(_event,details)=>finish('error','Fixture renderer crashed.',new Error(details.reason)));
    window.webContents.on('console-message',details=>{if(details.level==='error')finish('error','Fixture renderer reported an error.',new Error(details.message));});
  }

  async function makeControl({solid=false}={}){
    const center={x:background.getBounds().x+240,y:background.getBounds().y+170};
    const size=EXPANDED_SIZE;
    const window=new BrowserWindow({x:center.x-size/2,y:center.y-size/2,width:size,height:size,show:false,frame:false,
      transparent:true,backgroundColor:'#00000000',thickFrame:false,roundedCorners:false,hasShadow:false,
      resizable:false,maximizable:false,minimizable:false,fullscreenable:false,skipTaskbar:true,
      webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
    watch(window);
    window.setShape(circleShape(size));
    applyOrbMaterial(window,{platform:process.platform,release:os.release(),theme:nativeTheme});
    window.setOpacity(1);
    window.setAlwaysOnTop(true,'floating');
    const fill=solid?'#171b22':'rgba(18,22,27,.22)';
    const page=`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>html,body{width:100%;height:100%;margin:0;overflow:hidden;background:transparent}.surface{width:100%;height:100%;background:${fill};border-radius:50%}</style><div class="surface"></div>`;
    await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(page));
    return window;
  }

  async function runControl(name,view,baseA,baseB){
    const focusBefore=background.isFocused();
    view.showInactive();await pause(200);
    const showInactivePreservedFocus=focusBefore&&background.isFocused()&&!view.isFocused();
    const native=await nativeProbe.query(view,name);
    await paint(0);const a=await capture(`${name}-a`,view,{logImage:true});
    await paint(1);const b=await capture(`${name}-b`,view,{logImage:true});
    const metrics=compare(EXPANDED_SIZE,a,b,baseA,baseB);
    const result={name,showInactivePreservedFocus,native,nativeCircleObserved:nativeCircleObserved(native),
      nativeAlphaHostObserved:nativeAlphaHostObserved(native),metrics};
    report.controls.push(result);
    console.log(`Native backdrop control: ${JSON.stringify(result)}`);
    view.hide();view.destroy();
    return result;
  }

  app.whenReady().then(async()=>{
    fs.mkdirSync(output,{recursive:true});
    await startNativeProbe();
    report.appearance={reducedTransparency:Boolean(nativeTheme.prefersReducedTransparency),highContrast:Boolean(nativeTheme.shouldUseHighContrastColors)};
    session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!details.url.startsWith('file:')&&!details.url.startsWith('data:')}));
    session.defaultSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    const display=screen.getPrimaryDisplay(),area=display.workArea;
    if(area.width<520||area.height<400)throw new CaptureUnavailable('The CI desktop work area cannot fit the fixture.');
    report.display={bounds:display.bounds,workArea:area,scaleFactor:display.scaleFactor};
    const position={x:area.x+20,y:area.y+20};
    background=new BrowserWindow({...position,width:480,height:360,show:false,frame:false,resizable:false,backgroundColor:'#242424',
      webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
    orb=new BrowserWindow({x:position.x+240-COMPACT_SIZE/2,y:position.y+170-COMPACT_SIZE/2,width:COMPACT_SIZE,height:COMPACT_SIZE,
      show:false,frame:false,transparent:true,backgroundColor:'#00000000',thickFrame:false,roundedCorners:false,
      resizable:false,maximizable:false,minimizable:false,fullscreenable:false,hasShadow:false,skipTaskbar:true,
      webPreferences:{preload:path.join(__dirname,'render-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
    controller=createOrbController(orb,screen,{platform:process.platform});
    const appearance=applyOrbMaterial(orb,{platform:process.platform,release:os.release(),theme:nativeTheme});
    orb.setOpacity(1);
    report.material=appearance;
    report.windows={transparent:true,alwaysOnTop:true,showMethod:'showInactive',setOpacityCalled:true,opacity:1,
      compactShapeRectangles:circleShape(COMPACT_SIZE).length,expandedShapeRectangles:circleShape(EXPANDED_SIZE).length};
    orb.setAlwaysOnTop(true,'floating');
    const now=Date.now();
    const state={status:'ready',usageSource:'codex-cli',appearance,settings:{usageSource:'codex-cli',glassTint:16},
      codex:{enabled:true,state:'ready',lastSuccessAt:now},snapshot:{source:'codex-cli',capturedAt:now,
        windows:[{kind:'weekly',label:'每周额度',usedPercent:36,resetAt:now+86400000}]}};
    ipcMain.handle('test:state',()=>state);
    // Hold each diagnostic size steady despite a CI cursor possibly resting on
    // the fixture. Production IPC/hover security is covered by its own tests.
    ipcMain.handle('test:action',()=>({ok:true}));
    for(const window of[background,orb])watch(window);
    await background.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
    await orb.loadFile(path.join(root,'src','ui','orb.html'));
    report.fonts=await orb.webContents.executeJavaScript(`(async()=>{
      const value=document.querySelector('.orb-value');
      for(let attempt=0;attempt<40&&value.textContent!=='64%';attempt++)await new Promise(resolve=>setTimeout(resolve,25));
      await document.fonts.ready;
      return{status:document.fonts.status,family:getComputedStyle(value).fontFamily,percentage:value.textContent};
    })()`);
    background.show();background.focus();
    await paint(0);const baselineA=await capture('background-a');
    const focusBefore=background.isFocused();
    orb.showInactive();await pause(450);
    report.showInactivePreservedFocus=focusBefore&&background.isFocused()&&!orb.isFocused();
    report.productionCompactNative=await nativeProbe.query(orb,'production-compact');
    const compactA=await capture('compact-a',orb,{logImage:true});
    controller.request({expanded:true});await pause(450);
    report.productionExpandedNative=await nativeProbe.query(orb,'production-expanded');
    const expandedA=await capture('expanded-a',orb,{logImage:true});
    await paint(1);const expandedB=await capture('expanded-b',orb,{logImage:true});
    controller.request({expanded:false});await pause(450);const compactB=await capture('compact-b',orb,{logImage:true});
    orb.hide();await pause(350);const baselineB=await capture('background-b');
    report.evidence=[
      {...compare(COMPACT_SIZE,compactA,compactB,baselineA,baselineB),nativeCircleObserved:nativeCircleObserved(report.productionCompactNative),
        nativeAlphaHostObserved:nativeAlphaHostObserved(report.productionCompactNative)},
      {...compare(EXPANDED_SIZE,expandedA,expandedB,baselineA,baselineB),nativeCircleObserved:nativeCircleObserved(report.productionExpandedNative),
        nativeAlphaHostObserved:nativeAlphaHostObserved(report.productionExpandedNative)}
    ];
    const solid=await runControl('opaque-circle',await makeControl({solid:true}),baselineA,baselineB);
    const alpha=await runControl('alpha-circle',await makeControl(),baselineA,baselineB);
    const controlValid=control=>control.showInactivePreservedFocus&&control.nativeCircleObserved&&control.nativeAlphaHostObserved&&
      control.metrics.baselineValid&&control.metrics.focusCorrect&&control.metrics.orbPixelsObserved&&control.metrics.shapeClipObserved===true;
    report.validation={
      backgroundCalibrationValid:report.evidence.every(item=>item.baselineValid),
      opaqueNegativeControlValid:controlValid(solid)&&solid.metrics.observedColorChange<2&&solid.metrics.colorTransfer<.03,
      alphaPositiveControlValid:controlValid(alpha)&&alpha.metrics.alphaResponseObserved
    };
    if(!Object.values(report.validation).every(Boolean)){
      finish('unverified','Synthetic background, opaque-circle or alpha-circle controls were not established; transparent clipping cannot be inferred from this capture.');
      return;
    }
    const observed=report.showInactivePreservedFocus&&report.fonts.status==='loaded'&&report.fonts.percentage==='64%'&&
      report.evidence.every(item=>item.focusCorrect&&item.orbPixelsObserved&&item.shapeClipObserved===true&&
        item.nativeCircleObserved&&item.nativeAlphaHostObserved&&item.alphaResponseObserved);
    finish(observed?'observed-on-ci':'unverified',observed?
      'Both production orb sizes showed background-responsive alpha pixels and clear square corners, with circular native hit regions and no focus activation. This verifies transparency on CI, not blur.':
      'CI did not establish transparent, square-free inactive production orbs at both sizes. Inspect captured pixels, native region and calibration metrics.');
  }).catch(error=>error instanceof CaptureUnavailable?finish('unverified',error.message):finish('error','Unexpected fixture failure.',error));
}
