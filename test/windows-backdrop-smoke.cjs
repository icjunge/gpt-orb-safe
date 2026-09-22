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
        writeReport({status:'unverified',reason:'The CI desktop/compositor did not complete within 50 seconds.'});
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
  const {supportsAcrylic,applyOrbMaterial}=require('../src/window-material.cjs');
  const report={
    schema:2,status:'unverified',environment:'Windows CI virtual machine, not the user’s hardware',
    scope:'Inactive, always-on-top shaped HWND over a separate synthetic background window',
    limitation:'A requested acrylic API call is not proof of blur; desktop pixels, focus and background response are checked separately.',
    captureLimitation:'Screen capture or VM policies may affect system materials. Negative evidence here does not establish appearance on an uncaptured physical desktop.',
    layeredControlLimitation:'SetOpacity(1) requests WS_EX_LAYERED but does not remove WS_EX_NOREDIRECTIONBITMAP or prove Chromium changed its compositor backend; native style bits are recorded.',
    os:{platform:process.platform,release:os.release()},versions:{electron:process.versions.electron,chrome:process.versions.chrome},
    windows:[],captures:[],evidence:[],controls:[]
  };
  app.setPath('userData',process.env.GPT_ORB_BACKDROP_PROFILE);
  nativeTheme.themeSource='dark';
  const desktopBudget=Math.min(46000,Number(process.env.GPT_ORB_BACKDROP_TIMEOUT_MS)||46000);
  const desktopDeadline=Date.now()+desktopBudget;
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
      query:async(window,label,{experimentAccentBlur=false,experimentAccentAcrylic=false}={})=>{
        const key=`${++sequence}-${label}`,handle=window.getNativeWindowHandle();
        const handleHex=(handle.length===8?handle.readBigUInt64LE():BigInt(handle.readUInt32LE())).toString(16);
        const response=pending(key);
        child.stdin.write(JSON.stringify({label:key,handleHex,...(experimentAccentBlur?{experimentAccentBlur:true}:{}),
          ...(experimentAccentAcrylic?{experimentAccentAcrylic:true}:{})})+'\n');
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
    // The two backgrounds have the same fine stripes but very different broad
    // colors. Alpha alone attenuates both; blur suppresses stripes more strongly.
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
    if(actual.width<display.bounds.width/2||actual.height<display.bounds.height/2)throw new CaptureUnavailable('The CI desktop thumbnail is too small for a blur diagnostic.');
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
    const rows=size===COMPACT_SIZE?[-21,-20,-19]:[-40,-39,-38];
    const half=size===COMPACT_SIZE?15:21;
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
  function compare(size,a,b,baseA,baseB,{active=false,expectShape=true}={}){
    // Baseline samples use the same size's bounds even though the orb is hidden.
    const baseFor=(base,view)=>({...base,state:{...base.state,orbBounds:view.state.orbBounds}});
    const observed=[patch(a,size),patch(b,size)],baseline=[patch(baseFor(baseA,a),size),patch(baseFor(baseB,b),size)];
    const backgroundColorChange=distance(baseline[0].mean,baseline[1].mean);
    const observedColorChange=distance(observed[0].mean,observed[1].mean);
    const fineTransfer=(observed[0].fineContrast+observed[1].fineContrast)/Math.max(1,baseline[0].fineContrast+baseline[1].fineContrast);
    const colorTransfer=observedColorChange/Math.max(1,backgroundColorChange);
    const blurRelativeToTint=fineTransfer/Math.max(.01,colorTransfer);
    const focusCorrect=[a,b].every(view=>active?!view.state.backgroundFocused&&view.state.orbFocused:view.state.backgroundFocused&&!view.state.orbFocused);
    const cornerDifference=(view,base)=>{
      const left=view.state.orbBounds.x-view.state.backgroundBounds.x,top=view.state.orbBounds.y-view.state.backgroundBounds.y;
      const {width,height}=view.state.orbBounds;
      return[[4,4],[width-5,4],[4,height-5],[width-5,height-5]].reduce((sum,[x,y])=>
        sum+distance(pixel(view,left+x,top+y),pixel(base,left+x,top+y)),0)/4;
    };
    const clippedCornerDifference=[cornerDifference(a,baseA),cornerDifference(b,baseB)];
    const baselineValid=backgroundColorChange>35&&baseline.every(value=>value.fineContrast>5);
    const orbPixelsObserved=baselineValid&&observed.every((value,index)=>
      distance(value.mean,baseline[index].mean)>5||Math.abs(value.fineContrast-baseline[index].fineContrast)>3);
    // Unchanged desktop pixels cannot establish a clipped circle: the entire
    // fixture might be absent from capture, as on the Windows 11 hosted runner.
    const shapeClipObserved=baselineValid&&orbPixelsObserved?clippedCornerDifference.every(value=>value<5):null;
    const evidence=baselineValid&&focusCorrect&&(!expectShape||shapeClipObserved===true)&&observedColorChange>5&&blurRelativeToTint<.45;
    return{size,focusCorrect,baselineValid,orbPixelsObserved,shapeClipObserved,baseline,observed,backgroundColorChange,observedColorChange,fineTransfer,colorTransfer,blurRelativeToTint,clippedCornerDifference,
      result:evidence?'diffused-background-response-observed':'unverified',
      note:'Heuristic evidence from synthetic desktop pixels, not a guarantee for another Windows device or system policy.'};
  }

  function watch(window){
    window.webContents.on('render-process-gone',(_event,details)=>finish('error','Fixture renderer crashed.',new Error(details.reason)));
    window.webContents.on('console-message',details=>{if(details.level==='error')finish('error','Fixture renderer reported an error.',new Error(details.message));});
  }

  async function makeControl({panel=false,layered=false,legacyLayered=false,shape=false,solid=false}={}){
    const center={x:background.getBounds().x+240,y:background.getBounds().y+170};
    const width=panel?340:EXPANDED_SIZE,height=panel?240:EXPANDED_SIZE;
    const window=new BrowserWindow({x:center.x-width/2,y:center.y-height/2,width,height,show:false,frame:false,
      transparent:layered,backgroundColor:solid?'#171b22':'#00000000',
      ...(panel?{roundedCorners:true,hasShadow:true}:{thickFrame:false,roundedCorners:false,hasShadow:false}),
      resizable:false,maximizable:false,minimizable:false,fullscreenable:false,skipTaskbar:true,
      webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
    watch(window);
    if(shape)window.setShape(circleShape(EXPANDED_SIZE));
    let material={orbNativeBackdrop:false,orbBackdropStatus:'none'};
    if(!layered&&!solid)material=applyOrbMaterial(window,{platform:process.platform,release:os.release(),theme:nativeTheme,nativeHost:!layered});
    else{
      // The constructor's default is not DWMSBT_NONE; query must confirm value 1.
      window.setBackgroundMaterial('none');
      window.setBackgroundColor(solid?'#171b22':'#00000000');
    }
    // Electron 44 transparent:true uses DirectComposition without WS_EX_LAYERED.
    // Only this explicit test control requests the legacy layered HWND path.
    if(legacyLayered)window.setOpacity(1);
    window.setAlwaysOnTop(true,'floating');
    const fill=solid?'#171b22':'rgba(18,22,27,.16)';
    const radius=shape||layered?'50%':panel?'8px':'0';
    const page=`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>html,body{width:100%;height:100%;margin:0;overflow:hidden;background:transparent}.surface{width:100%;height:100%;display:grid;place-items:center;background:${fill};border-radius:${radius};color:white;font:26px 'Segoe UI';box-sizing:border-box}</style><div class="surface">64%</div>`;
    await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(page));
    return{window,material};
  }

  async function runControl(name,view,baseA,baseB,{active=false,shape=false,forceShape=false,experimentAccentBlur=false,
    experimentAccentAcrylic=false,requireNone=false,requireLayered=false,material}={}){
    view.showInactive();
    (active?view:background).focus();
    await pause(300);
    const before=await nativeProbe.query(view,`${name}-before`);
    if((requireNone&&(before.systemBackdrop?.hresult!==0||before.systemBackdrop?.value!==1))||
       (requireLayered&&before.styles?.layered!==true)){
      const result={name,status:'not-measured',reason:'The required native NONE/layered control state was not established.',nativeBefore:before};
      report.controls.push(result);console.log(`Native backdrop control: ${JSON.stringify(result)}`);
      view.hide();background.focus();return result;
    }
    if(forceShape)view.setShape(circleShape(view.getBounds().width));
    const native=forceShape||experimentAccentBlur||experimentAccentAcrylic?await nativeProbe.query(view,`${name}-after`,
      {experimentAccentBlur,experimentAccentAcrylic}):before;
    await pause(180);
    await paint(0,active?view:background);const a=await capture(`${name}-a`,view,{logImage:true});
    await paint(1,active?view:background);const b=await capture(`${name}-b`,view,{logImage:true});
    const metrics=compare(view.getBounds().width===COMPACT_SIZE?COMPACT_SIZE:EXPANDED_SIZE,a,b,baseA,baseB,{active,expectShape:shape});
    const result={name,active,shape,forceShape,experimental:experimentAccentBlur||experimentAccentAcrylic,requireNone,requireLayered,
      material,nativeBefore:before,nativeAfter:native,metrics};
    report.controls.push(result);
    console.log(`Native backdrop control: ${JSON.stringify(result)}`);
    view.hide();background.focus();
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
      show:false,frame:false,transparent:!supportsAcrylic(process.platform,os.release()),backgroundColor:'#00000000',thickFrame:false,roundedCorners:false,
      resizable:false,maximizable:false,minimizable:false,fullscreenable:false,hasShadow:false,skipTaskbar:true,
      webPreferences:{preload:path.join(__dirname,'render-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
    controller=createOrbController(orb,screen,{platform:process.platform});
    const appearance=applyOrbMaterial(orb,{platform:process.platform,release:os.release(),theme:nativeTheme,
      nativeHost:supportsAcrylic(process.platform,os.release())});
    report.material=appearance;
    report.windows={transparent:!appearance.orbNativeHost,alwaysOnTop:true,showMethod:'showInactive',setOpacityCalled:false,
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
    background.show();background.focus();
    await paint(0);const baselineA=await capture('background-a');
    orb.showInactive();background.focus();await pause(450);
    report.productionCompactNative=await nativeProbe.query(orb,'production-compact');
    const compactA=await capture('compact-a',orb,{logImage:true});
    controller.request({expanded:true});await pause(450);
    report.productionExpandedNative=await nativeProbe.query(orb,'production-expanded');
    const expandedA=await capture('expanded-a',orb,{logImage:true});
    await paint(1);const expandedB=await capture('expanded-b');
    controller.request({expanded:false});await pause(450);const compactB=await capture('compact-b',orb,{logImage:true});
    orb.hide();await pause(350);const baselineB=await capture('background-b');
    report.evidence=[compare(COMPACT_SIZE,compactA,compactB,baselineA,baselineB),compare(EXPANDED_SIZE,expandedA,expandedB,baselineA,baselineB)];
    await runControl('force-region-after-show',orb,baselineA,baselineB,{shape:true,forceShape:true,material:appearance});
    const plain=await makeControl();
    await runControl('plain-acrylic-inactive',plain.window,baselineA,baselineB,{material:plain.material});
    await runControl('plain-acrylic-active',plain.window,baselineA,baselineB,{active:true,material:plain.material});
    plain.window.destroy();
    const panel=await makeControl({panel:true});
    await runControl('panel-acrylic-inactive',panel.window,baselineA,baselineB,{material:panel.material});
    panel.window.destroy();
    const solid=await makeControl({shape:true,solid:true});
    await runControl('shape-none-solid',solid.window,baselineA,baselineB,{shape:true,forceShape:true,requireNone:true,material:solid.material});
    solid.window.destroy();
    const layered=await makeControl({layered:true});
    await runControl('transparent-dcomp-css-alpha',layered.window,baselineA,baselineB,{shape:true,requireNone:true,material:layered.material});
    layered.window.destroy();
    const legacy=await makeControl({layered:true,legacyLayered:true,shape:true});
    await runControl('legacy-layered-css-alpha',legacy.window,baselineA,baselineB,
      {shape:true,forceShape:true,requireNone:true,requireLayered:true,material:legacy.material});
    // This optional fixed SWCA experiment changes only this synthetic HWND.
    // Its return value is recorded, never treated as evidence of visible blur.
    await runControl('experimental-layered-accent-blur',legacy.window,baselineA,baselineB,
      {shape:true,forceShape:true,requireNone:true,requireLayered:true,experimentAccentBlur:true,material:legacy.material});
    legacy.window.destroy();
    if(desktopDeadline-Date.now()>5500){
      const acrylic=await makeControl({layered:true,legacyLayered:true,shape:true});
      await runControl('experimental-layered-accent-acrylic',acrylic.window,baselineA,baselineB,
        {shape:true,forceShape:true,requireNone:true,requireLayered:true,experimentAccentAcrylic:true,material:acrylic.material});
      acrylic.window.destroy();
    }else{
      const result={name:'experimental-layered-accent-acrylic',status:'not-measured',reason:'Insufficient remaining desktop diagnostic budget.'};
      report.controls.push(result);console.log(`Native backdrop control: ${JSON.stringify(result)}`);
    }
    report.validation={
      backgroundCalibrationValid:report.evidence.every(item=>item.baselineValid),
      alphaPositiveControlValid:report.controls.some(control=>
        ['transparent-dcomp-css-alpha','legacy-layered-css-alpha'].includes(control.name)&&
        control.metrics?.baselineValid&&control.metrics.focusCorrect&&control.metrics.shapeClipObserved===true&&
        control.metrics.observedColorChange>5&&control.metrics.blurRelativeToTint>.75)
    };
    if(!report.validation.backgroundCalibrationValid||!report.validation.alphaPositiveControlValid){
      finish('unverified','Synthetic background or alpha controls were not established in captured pixels; neither blur nor visual clipping can be inferred.');
      return;
    }
    const observed=appearance.orbNativeBackdrop&&report.dwm.hresult===0&&report.dwm.enabled===true&&report.evidence.every(item=>item.result==='diffused-background-response-observed');
    finish(observed?'observed-on-ci':'unverified',observed?
      'Synthetic background color response and selective stripe suppression were observed while the orb remained inactive on this CI desktop.':
      'CI did not establish inactive native background blur. Inspect the captures and metrics; requested acrylic alone is not visual verification.');
  }).catch(error=>error instanceof CaptureUnavailable?finish('unverified',error.message):finish('error','Unexpected fixture failure.',error));
}
