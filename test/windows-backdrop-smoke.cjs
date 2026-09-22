'use strict';

// CI-only visual diagnostic. This file is excluded from the installed app.
// A synthetic background window stands in for another app; no account is read,
// no network is used and only its cropped desktop-composited pixels are saved.
// capturePage cannot see a native backdrop and is deliberately not used here.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
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
      const env={...process.env,GPT_ORB_BACKDROP_OUTPUT:output,GPT_ORB_BACKDROP_PROFILE:path.join(temporary,'profile')};
      delete env.ELECTRON_RUN_AS_NODE;
      const result=spawnSync(path.join(temporary,'GPT-Orb.exe'),[],{env,stdio:'inherit',timeout:30000,windowsHide:false});
      if(result.error?.code==='ETIMEDOUT'){
        writeReport({status:'unverified',reason:'The CI desktop/compositor did not complete within 30 seconds.'});
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
    schema:1,status:'unverified',environment:'Windows CI virtual machine, not the user’s hardware',
    scope:'Inactive, always-on-top shaped HWND over a separate synthetic background window',
    limitation:'A requested acrylic API call is not proof of blur; desktop pixels, focus and background response are checked separately.',
    os:{platform:process.platform,release:os.release()},versions:{electron:process.versions.electron,chrome:process.versions.chrome},
    windows:[],captures:[],evidence:[]
  };
  app.setPath('userData',process.env.GPT_ORB_BACKDROP_PROFILE);
  nativeTheme.themeSource='dark';
  const timer=setTimeout(()=>finish('unverified','The fixture exceeded its 27-second desktop deadline.'),27000);
  let background,orb,controller,finished=false;
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  function finish(status,reason,error){
    if(finished)return;finished=true;clearTimeout(timer);
    Object.assign(report,{status,reason});
    if(error)report.error=String(error.stack||error);
    writeReport(report);
    console.log(`Native backdrop diagnostic: ${status}. ${reason}`);
    app.exit(error?1:0);
  }
  process.on('uncaughtException',error=>finish('error','Unexpected fixture error.',error));
  process.on('unhandledRejection',error=>finish('error','Unexpected fixture rejection.',error));
  class CaptureUnavailable extends Error{}

  function compositionStatus(){
    const code='Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class OrbDwmProbe { [DllImport("dwmapi.dll")] public static extern int DwmIsCompositionEnabled(out bool enabled); }\'; $enabled=$false; $result=[OrbDwmProbe]::DwmIsCompositionEnabled([ref]$enabled); @{hresult=$result;enabled=$enabled} | ConvertTo-Json -Compress';
    const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{encoding:'utf8',timeout:3500,windowsHide:true});
    if(result.error||result.status!==0)return{status:'unavailable',reason:result.error?.code||'DWM query failed'};
    try{return{status:'queried',...JSON.parse(result.stdout.trim())};}catch{return{status:'unavailable',reason:'DWM query produced no JSON'};}
  }

  const html='<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>html,body{margin:0;overflow:hidden}canvas{display:block}</style><canvas width="480" height="360"></canvas>';
  async function paint(phase){
    // The two backgrounds have the same fine stripes but very different broad
    // colors. Alpha alone attenuates both; blur suppresses stripes more strongly.
    await background.webContents.executeJavaScript(`(() => {
      const c=document.querySelector('canvas'),g=c.getContext('2d');
      g.fillStyle=${JSON.stringify(phase?'rgb(38,106,222)':'rgb(216,64,56)')};g.fillRect(0,0,480,360);
      for(let x=0;x<480;x+=4){g.fillStyle='rgba(255,255,255,.50)';g.fillRect(x,0,2,360);}
      g.fillStyle='#24b978';g.fillRect(400,0,80,360);g.fillStyle='#e19a35';g.fillRect(0,300,400,60);
      g.fillStyle='#ffffff';g.font='16px Segoe UI';g.fillText('CI fixture · synthetic background · phase ${phase}',18,333);
    })()`);
    background.focus();
    await pause(400);
  }

  async function capture(name){
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
    const state={name,backgroundFocused:background.isFocused(),orbFocused:orb.isFocused(),orbVisible:orb.isVisible(),
      orbBounds:orb.getBounds(),backgroundBounds:bounds,imageSize:image.getSize(),screenScaleFactor:display.scaleFactor};
    report.captures.push(state);
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
  function compare(size,a,b,baseA,baseB){
    // Baseline samples use the same size's bounds even though the orb is hidden.
    const baseFor=(base,view)=>({...base,state:{...base.state,orbBounds:view.state.orbBounds}});
    const observed=[patch(a,size),patch(b,size)],baseline=[patch(baseFor(baseA,a),size),patch(baseFor(baseB,b),size)];
    const backgroundColorChange=distance(baseline[0].mean,baseline[1].mean);
    const observedColorChange=distance(observed[0].mean,observed[1].mean);
    const fineTransfer=(observed[0].fineContrast+observed[1].fineContrast)/Math.max(1,baseline[0].fineContrast+baseline[1].fineContrast);
    const colorTransfer=observedColorChange/Math.max(1,backgroundColorChange);
    const blurRelativeToTint=fineTransfer/Math.max(.01,colorTransfer);
    const focusCorrect=[a,b].every(view=>view.state.backgroundFocused&&!view.state.orbFocused);
    const cornerDifference=(view,base)=>{
      const left=view.state.orbBounds.x-view.state.backgroundBounds.x,top=view.state.orbBounds.y-view.state.backgroundBounds.y;
      return[[4,4],[size-5,4],[4,size-5],[size-5,size-5]].reduce((sum,[x,y])=>
        sum+distance(pixel(view,left+x,top+y),pixel(base,left+x,top+y)),0)/4;
    };
    const clippedCornerDifference=[cornerDifference(a,baseA),cornerDifference(b,baseB)];
    const shapeClipObserved=clippedCornerDifference.every(value=>value<5);
    const evidence=focusCorrect&&shapeClipObserved&&backgroundColorChange>35&&observedColorChange>5&&blurRelativeToTint<.45;
    return{size,focusCorrect,shapeClipObserved,baseline,observed,backgroundColorChange,observedColorChange,fineTransfer,colorTransfer,blurRelativeToTint,clippedCornerDifference,
      result:evidence?'diffused-background-response-observed':'unverified',
      note:'Heuristic evidence from synthetic desktop pixels, not a guarantee for another Windows device or system policy.'};
  }

  app.whenReady().then(async()=>{
    fs.mkdirSync(output,{recursive:true});
    report.dwm=compositionStatus();
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
    const appearance=applyOrbMaterial(orb,{platform:process.platform,release:os.release(),theme:nativeTheme});
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
    for(const window of[background,orb]){
      window.webContents.on('render-process-gone',(_event,details)=>finish('error','Fixture renderer crashed.',new Error(details.reason)));
      window.webContents.on('console-message',details=>{if(details.level==='error')finish('error','Fixture renderer reported an error.',new Error(details.message));});
    }
    await background.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
    await orb.loadFile(path.join(root,'src','ui','orb.html'));
    background.show();background.focus();
    await paint(0);const baselineA=await capture('background-a');
    orb.showInactive();background.focus();await pause(550);const compactA=await capture('compact-a');
    controller.request({expanded:true});await pause(550);const expandedA=await capture('expanded-a');
    await paint(1);const expandedB=await capture('expanded-b');
    controller.request({expanded:false});await pause(550);const compactB=await capture('compact-b');
    orb.hide();await pause(350);const baselineB=await capture('background-b');
    report.evidence=[compare(COMPACT_SIZE,compactA,compactB,baselineA,baselineB),compare(EXPANDED_SIZE,expandedA,expandedB,baselineA,baselineB)];
    const observed=appearance.orbNativeBackdrop&&report.dwm.hresult===0&&report.dwm.enabled===true&&report.evidence.every(item=>item.result==='diffused-background-response-observed');
    finish(observed?'observed-on-ci':'unverified',observed?
      'Synthetic background color response and selective stripe suppression were observed while the orb remained inactive on this CI desktop.':
      'CI did not establish inactive native background blur. Inspect the captures and metrics; requested acrylic alone is not visual verification.');
  }).catch(error=>error instanceof CaptureUnavailable?finish('unverified',error.message):finish('error','Unexpected fixture failure.',error));
}
