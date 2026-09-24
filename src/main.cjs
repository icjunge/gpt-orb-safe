'use strict';
const {app,BrowserWindow,ipcMain,screen,Tray,Menu,nativeImage,shell,Notification,
  globalShortcut,dialog,clipboard,nativeTheme,net,session} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {pathToFileURL} = require('node:url');
const {UsageBridge} = require('./bridge.cjs');
const {syncExtension} = require('./extension-store.cjs');
const {UpdateManager} = require('./updater.cjs');
const {MacUpdateManager} = require('./mac-updater.cjs');
const {validSettings,allowedSender} = require('./security.cjs');
const {CodexProvider} = require('./codex-provider.cjs');
const {discoverCodex} = require('./codex-discovery.cjs');
const {createCodexRuntime} = require('./codex-runtime.cjs');
const {loginManagedCodex,logoutManagedCodex} = require('./codex-auth.cjs');
const {CodexSetup} = require('./codex-setup.cjs');
const {prepareManagedDirectories} = require('./codex-directories.cjs');
const {supportsAcrylic,systemAppearance,applyPanelMaterial,applyOrbMaterial} = require('./window-material.cjs');
const {COMPACT_SIZE,HOST_SIZE,HOST_INSET,createOrbController} = require('./orb-window.cjs');
app.setName('GPT Usage Orb Safe');
if(process.platform==='win32')app.setAppUserModelId('GPTUsageOrb.Safe.Desktop');
// App-local material scheme; does not change the Windows system theme.
nativeTheme.themeSource='dark';
let orbWindow,panelWindow,tray,bridge,tick,drag=null,saveTimer,quitting=false;
let updateManager=null,updateTimer=null,firstUpdateTimer=null,extensionInfo=null;
let codexProvider=null,codexRuntime=null,codexSetup=null;
let orbController=null;
let panelHeight=240;
let appearance=systemAppearance(nativeTheme);
const unavailableUpdates=()=>({status:'unconfigured',currentVersion:app.getVersion(),availableVersion:null,progress:null,
  message:'请使用支持更新的安装版，并启用发布源。',lastCheckedAt:null,repository:null});
let settings=validSettings({}),savedPosition=null,snapshot=null,error=null,notified=new Set();
const trustedWindows=new Map();
const settingsPath=()=>path.join(app.getPath('userData'),'preferences.json');
function loadSettings(){
  try{const data=JSON.parse(fs.readFileSync(settingsPath(),'utf8'));settings=validSettings(data.settings);
    // Existing and paused local-CLI users keep their normal Codex home/account.
    // A fresh install uses the app's isolated, explicit-click connection flow.
    if(!Object.hasOwn(data.settings||{},'codexConnection')&&
      (data.settings?.usageSource==='codex-cli'||data.settings?.codexEnabled===true))settings.codexConnection='existing';
    settings.codexManagedConnected=data.settings?.codexManagedConnected===true;
    if(Number.isFinite(data.position?.x)&&Number.isFinite(data.position?.y))savedPosition=data.position;
  }catch{}
}
function saveSettings(){
  try{fs.mkdirSync(app.getPath('userData'),{recursive:true});const temporary=settingsPath()+'.tmp';
    fs.writeFileSync(temporary,JSON.stringify({settings,position:savedPosition},null,2));fs.renameSync(temporary,settingsPath());
  }catch{}
}
function nativeStatus(){const value=codexProvider?.getStatus()||{enabled:false,running:false,state:'disabled',message:'点击开启本机读取。',
  lastSuccessAt:null,nextRunAt:null,intervalMinutes:settings.refreshMinutes};
  if(settings.codexConnection==='managed'){
    const messages={'not-found':'连接组件暂不可用，请点击重新连接。','needs-login':'登录已失效，请重新连接。',
      unsupported:'连接组件不支持当前查询，请检查程序更新后重新连接。'};
    if(messages[value.state])return{...value,message:messages[value.state]};
  }return value;}
function setupStatus(){const value=codexSetup?.getStatus()||{status:'idle',progress:null,message:''};
  const native=nativeStatus();
  if(settings.codexConnection==='managed'&&!codexSetup?.busy&&['not-found','needs-login','unsupported'].includes(native.state))
    return{...value,status:'error',message:native.message};
  return value;}
function staleAfterMs(){return settings.usageSource==='codex-cli'?settings.refreshMinutes*60000+90000:180000;}
function currentError(){const status=nativeStatus();return settings.usageSource==='codex-cli'
  ?(['not-found','needs-login','unsupported','error'].includes(status.state)?status.message:null):error;}
function state(){const status=bridge?.getStatus()||{listening:false,connected:false,lastReceivedAt:null,port:43861};
  const activeError=currentError();
  return {status:activeError?'error':snapshot?'ready':settings.usageSource==='codex-cli'||status.listening?'waiting':'starting',
    platform:process.platform,bridge:status,snapshot,settings,appearance,error:activeError,codex:nativeStatus(),usageSource:settings.usageSource,staleAfterMs:staleAfterMs(),
    codexSetup:{...setupStatus(),
      mode:settings.codexConnection,hasLogin:settings.codexManagedConnected},
    updates:updateManager?.snapshot()||unavailableUpdates(),
    extension:extensionInfo?{version:extensionInfo.version,changed:extensionInfo.changed,needsReload:extensionInfo.changed,error:extensionInfo.error||null}:null};}
function clampPosition(position,width=COMPACT_SIZE,height=COMPACT_SIZE){
  const display=position?screen.getDisplayNearestPoint({x:Math.round(position.x),y:Math.round(position.y)}):screen.getPrimaryDisplay();
  const a=display.workArea;return{x:Math.round(Math.max(a.x,Math.min(position?.x??a.x+a.width-width-24,a.x+a.width-width))),
    y:Math.round(Math.max(a.y,Math.min(position?.y??a.y+a.height/2-height/2,a.y+a.height-height)))};
}
function clampOrbHost(position){
  const compact=clampPosition(position?{x:position.x+HOST_INSET,y:position.y+HOST_INSET}:undefined);
  return{x:compact.x-HOST_INSET,y:compact.y-HOST_INSET};
}
function moveOrbDrag(){
  if(!drag)return false;
  const cursor=screen.getCursorScreenPoint(),dx=cursor.x-drag.cursor.x,dy=cursor.y-drag.cursor.y;
  // Threshold and movement use the same trusted DIP coordinate system. Browser
  // pointer screen coordinates can jump after hover resize or across DPI scales.
  if(!drag.moved&&Math.hypot(dx,dy)<=4)return false;
  drag.moved=true;
  const point=clampOrbHost({x:drag.bounds.x+dx,y:drag.bounds.y+dy});
  // A pointer can cross the threshold while the work-area clamp prevents any
  // window travel, or return to its press position after a real drag. Keep the
  // last requested DIP position separate from the gesture's moved verdict.
  drag.position=point;
  const before=orbWindow.getBounds();
  orbController.moveDrag(point);
  if(point.x!==before.x||point.y!==before.y)anchorPanel();
  return true;
}
function anchorPanel(){if(!panelWindow||panelWindow.isDestroyed()||!orbWindow)return;
  const b=orbWindow.getBounds(),a=screen.getDisplayMatching(b).workArea,width=Math.min(340,a.width),height=Math.min(panelHeight,a.height);
  let x=b.x-width-10;if(x<a.x)x=b.x+b.width+10;x=Math.max(a.x,Math.min(x,a.x+a.width-width));
  panelWindow.setBounds({x,y:Math.max(a.y,Math.min(b.y-60,a.y+a.height-height)),width,height});
}
function resizePanel(payload){
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).length!==1||!Object.hasOwn(payload,'height')||
    !Number.isInteger(payload.height)||payload.height<240||payload.height>660||!panelWindow||panelWindow.isDestroyed())return{ok:false};
  panelHeight=payload.height;
  // Content changes resize in place; only an explicit open or orb drag anchors
  // to the orb. The renderer cannot choose a position, width or display.
  const b=panelWindow.getBounds(),a=screen.getDisplayMatching(b).workArea;
  const width=Math.min(340,a.width),height=Math.min(panelHeight,a.height);
  const x=Math.max(a.x,Math.min(b.x,a.x+a.width-width));
  const y=Math.max(a.y,Math.min(b.y,a.y+a.height-height));
  if(b.x!==x||b.y!==y||b.width!==width||b.height!==height)panelWindow.setBounds({x,y,width,height});
  return{ok:true};
}
function showPanel(){if(quitting||!panelWindow||panelWindow.isDestroyed())return;orbWindow.showInactive();anchorPanel();panelWindow.show();panelWindow.focus();}
function togglePanel(){if(panelWindow?.isVisible())panelWindow.hide();else showPanel();}
function harden(win,file){
  const contents=win.webContents;
  trustedWindows.set(contents,pathToFileURL(file).href);
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',e=>e.preventDefault());
  win.webContents.on('will-frame-navigate',e=>e.preventDefault());
  win.webContents.on('will-attach-webview',e=>e.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_wc,_permission,cb)=>cb(false));
  win.webContents.session.setPermissionCheckHandler(()=>false);
  win.on('closed',()=>trustedWindows.delete(contents));
}
function applyOrbOpacity(){
  // The alpha host keeps the user's existing opacity preference. Accessibility
  // modes keep text fully opaque and let CSS fill only the circular surface.
  orbWindow.setOpacity(systemAppearance(nativeTheme).reducedTransparency?1:settings.opacity);
}
function createWindows(){
  const common={frame:false,transparent:true,backgroundColor:'#00000000',resizable:false,maximizable:false,
    minimizable:false,fullscreenable:false,show:false,skipTaskbar:true,icon:path.join(__dirname,'../assets/orb.png'),
    ...(process.platform==='darwin'?{hiddenInMissionControl:true}:{}),
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,
      webSecurity:true,webviewTag:false,backgroundThrottling:true,spellcheck:false}};
  // A transparent, shaped host avoids DWM's rectangular Acrylic fallback.
  // This choice is independent of GPU feature status and never delays startup.
  const compactPosition=clampPosition(savedPosition);
  orbWindow=new BrowserWindow({...common,width:HOST_SIZE,height:HOST_SIZE,x:compactPosition.x-HOST_INSET,y:compactPosition.y-HOST_INSET,
    thickFrame:false,roundedCorners:false,hasShadow:false});
  orbController=createOrbController(orbWindow,screen,{platform:process.platform});
  // Crossing displays can change HWND DPI even though the DIP size is unchanged.
  for(const event of['move','resize'])orbWindow.on(event,()=>orbController.reconcileNativeBounds());
  const nativePanel=supportsAcrylic(process.platform,os.release());
  panelWindow=new BrowserWindow({...common,width:340,height:panelHeight,hasShadow:true,roundedCorners:true,
    transparent:!nativePanel,...(process.platform==='darwin'?{visualEffectState:'active',vibrancy:nativeTheme.prefersReducedTransparency?undefined:'under-window'}:{})});
  const updateAppearance=()=>{
    const options={platform:process.platform,release:os.release(),theme:nativeTheme};
    appearance={...applyPanelMaterial(panelWindow,options),...applyOrbMaterial(orbWindow,options)};
    applyOrbOpacity();
    publish();
  };
  updateAppearance();
  nativeTheme.on('updated',updateAppearance);
  panelWindow.once('closed',()=>nativeTheme.removeListener('updated',updateAppearance));
  for(const [win,name]of[[orbWindow,'orb'],[panelWindow,'panel']]){
    const file=path.join(__dirname,'ui',name+'.html');harden(win,file);win.setAlwaysOnTop(settings.alwaysOnTop,'floating');
    if(process.platform==='darwin')win.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true,skipTransformProcessType:true});
    win.on('close',e=>{if(!quitting){e.preventDefault();win.hide();}});win.loadFile(file);
  }
  orbWindow.once('ready-to-show',()=>orbWindow.showInactive());
  panelWindow.once('ready-to-show',()=>{if(!process.argv.includes('--startup')&&!openedAtMacLogin())showPanel();});
  orbWindow.webContents.on('context-menu',()=>trayMenu().popup({window:orbWindow}));
}
function trayMenu(){return Menu.buildFromTemplate([
  {label:'显示用量面板',click:showPanel},
  {label:'显示 / 隐藏悬浮球',click:()=>{if(orbWindow.isVisible()){orbWindow.hide();panelWindow.hide();}else orbWindow.showInactive();}},
  {type:'separator'},
  {label:'始终置顶',type:'checkbox',checked:settings.alwaysOnTop,click:item=>applySettings({alwaysOnTop:item.checked})},
  {label:'开机启动',type:'checkbox',checked:settings.autoStart,click:item=>applySettings({autoStart:item.checked})},
  {label:'立即刷新 Codex 额度',enabled:settings.usageSource==='codex-cli'&&settings.codexEnabled,click:()=>void codexProvider?.refresh()},
  {label:'检查程序更新',click:()=>void updateManager?.check({download:true})},
  {label:'打开官方用量页面',click:()=>void shell.openExternal('https://chatgpt.com/settings/usage?tab=overview')},
  {label:'断开本机同步',click:disconnect},{type:'separator'},{label:'退出 GPT 悬浮球',click:()=>app.quit()}
]);}
function trayImage(){
  if(process.platform!=='darwin')return nativeImage.createFromPath(path.join(__dirname,'../assets/orb.png')).resize({width:32,height:32});
  // An 18 pt, double-resolution monochrome template follows the menu bar's
  // light/dark appearance. Rasterize locally; no image download or SVG runtime.
  const size=36,bitmap=Buffer.alloc(size*size*4);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const radius=Math.hypot(x+.5-size/2,y+.5-size/2);
    const coverage=Math.max(0,Math.min(1,1.8-Math.abs(radius-12.5)))+Math.max(0,Math.min(1,3.5-radius));
    bitmap[(y*size+x)*4+3]=Math.round(Math.min(1,coverage)*255);
  }
  const icon=nativeImage.createFromBitmap(bitmap,{width:size,height:size,scaleFactor:2});
  icon.setTemplateImage(true);return icon;
}
function refreshTrayMenu(){if(process.platform!=='darwin')tray?.setContextMenu(trayMenu());}
function createTray(){tray=new Tray(trayImage());
  tray.setToolTip('GPT 悬浮球 · 本机额度查询');refreshTrayMenu();
  tray.on('click',togglePanel);tray.on('double-click',showPanel);tray.on('balloon-click',showPanel);
  if(process.platform==='darwin'){
    // A persistent macOS context menu takes over left-clicks. Open it only on
    // right-click so the normal click can continue to toggle the usage panel.
    tray.on('right-click',()=>tray.popUpContextMenu(trayMenu()));
    void app.dock?.hide();
  }
}
function openedAtMacLogin(){
  if(process.platform!=='darwin')return false;
  try{return app.getLoginItemSettings({type:'mainAppService'}).wasOpenedAtLogin===true;}catch{return false;}
}
function applySettings(input){
  const next=validSettings(input,settings);
  const sourceChanged=next.usageSource!==settings.usageSource;
  const modeChanged=next.codexConnection!==settings.codexConnection;
  if(codexSetup?.busy&&(sourceChanged||modeChanged||next.codexEnabled!==settings.codexEnabled||next.refreshMinutes!==settings.refreshMinutes))
    return{ok:false,error:'请先完成或取消当前连接。'};
  if(sourceChanged||modeChanged||next.usageSource!=='codex-cli')next.codexEnabled=false;
  const nativeChanged=sourceChanged||modeChanged||next.codexEnabled!==settings.codexEnabled||next.refreshMinutes!==settings.refreshMinutes;
  if(next.autoStart!==settings.autoStart){
    try{
      if(process.platform==='win32'){
        app.setLoginItemSettings({openAtLogin:next.autoStart,path:process.execPath,args:['--startup']});
        next.autoStart=app.getLoginItemSettings({path:process.execPath,args:['--startup']}).openAtLogin;
      }else if(process.platform==='darwin'){
        if(!app.isPackaged)return{ok:false,error:'请从应用程序文件夹运行安装版，再设置登录时启动。'};
        const requested=next.autoStart;
        app.setLoginItemSettings({openAtLogin:requested,type:'mainAppService'});
        const login=app.getLoginItemSettings({type:'mainAppService'});
        next.autoStart=login.openAtLogin===true||login.status==='requires-approval';
        if(next.autoStart!==requested)return{ok:false,error:'系统未能修改登录时启动，请在系统设置的登录项中检查。'};
        if(requested&&login.status==='requires-approval')void dialog.showMessageBox(panelWindow,{type:'info',title:'允许登录时启动',
          message:'启动项需要系统允许',detail:'请在系统设置的「登录项」中允许 GPT Usage Orb Safe。',buttons:['知道了']});
      }
    }catch{return{ok:false,error:'系统未能修改启动项，请在系统设置的登录项中检查。'};}
  }
  const newlyEnabled=next.autoCheckUpdates&&!settings.autoCheckUpdates;
  settings=next;if(newlyEnabled)void updateManager?.check({download:true});
  if(sourceChanged||modeChanged){snapshot=null;notified.clear();bridge?.rotateKey();}
  if(nativeChanged&&codexProvider){
    if(settings.usageSource==='codex-cli'&&settings.codexEnabled)void codexProvider.start(settings.refreshMinutes);
    else codexProvider.stop();
  }
  orbWindow.setAlwaysOnTop(settings.alwaysOnTop,'floating');panelWindow.setAlwaysOnTop(settings.alwaysOnTop,'floating');
  applyOrbOpacity();
  saveSettings();refreshTrayMenu();publish();return{ok:true};
}
function disconnect(){void codexSetup?.cancel();codexProvider?.stop();settings.codexEnabled=false;saveSettings();snapshot=null;notified.clear();bridge?.rotateKey();refreshTrayMenu();publish();}
function notifyLow(){
  if(!settings.notifications||!['official-page','codex-cli'].includes(snapshot?.source)||Date.now()-snapshot.capturedAt>staleAfterMs())return;
  if(snapshot.source==='codex-cli'&&!nativeStatus().enabled)return;
  for(const w of snapshot.windows){const remaining=100-w.usedPercent;
    if(remaining>20||!w.resetAt||w.resetAt<=Date.now())continue;
    const threshold=remaining<=5?5:20,id=`${w.id||w.kind}:${Math.floor(w.resetAt/60000)}:${threshold}`;
    if(notified.has(id))continue;notified.add(id);
    const body=`${snapshot.source==='codex-cli'?'Codex 查询的':'官方页面读取的'}额度剩余 ${Math.round(remaining)}%。以官方实际额度为准。`;
    if(process.platform==='win32'&&tray&&!tray.isDestroyed())tray.displayBalloon({title:'GPT 额度提醒',content:body,iconType:'info',noSound:true,respectQuietTime:true});
    else if(Notification.isSupported()){const n=new Notification({title:'GPT 额度提醒',body,silent:true});n.on('click',showPanel);n.show();}
  }
  if(notified.size>300)notified=new Set([...notified].slice(-100));
}
function publish(){if(quitting)return;const next=state();for(const win of[orbWindow,panelWindow])if(win&&!win.isDestroyed())win.webContents.send('orb:state',next);
  const most=snapshot?.windows?.slice().sort((a,b)=>b.usedPercent-a.usedPercent)[0];
  const stale=snapshot&&(Date.now()-snapshot.capturedAt>staleAfterMs()||currentError()||(snapshot.source==='codex-cli'&&!nativeStatus().enabled));
  tray?.setToolTip(most?`GPT 悬浮球 · ${snapshot.source==='manual-page'?'手动记录':stale?'上次记录':snapshot.source==='codex-cli'?'Codex 剩余':'页面剩余'} ${Math.round(100-most.usedPercent)}%`:'GPT 悬浮球 · 本机额度查询');
}
function registerIpc(){
  ipcMain.handle('orb:state',event=>allowedSender(event,trustedWindows)?state():null);
  ipcMain.handle('orb:action',async(event,name,payload)=>{
    if(!allowedSender(event,trustedWindows))return{ok:false,error:'来源无效'};
    try{switch(name){
      case'togglePanel':togglePanel();break;
      case'hidePanel':panelWindow.hide();break;
      case'panelResize':if(event.sender!==panelWindow?.webContents)return{ok:false};return resizePanel(payload);
      case'orbExpand':if(event.sender!==orbWindow?.webContents)return{ok:false};return orbController.request(payload);
      case'copyPairingCode':if(!bridge?.getStatus().listening)return{ok:false,error:'本机同步尚未启动'};clipboard.writeText(bridge.getPairingCode());break;
      case'disconnect':disconnect();break;
      case'connectCodex':
      case'cancelCodexConnect':
      case'logoutCodex':{
        if(event.sender!==panelWindow?.webContents||payload!==undefined)return{ok:false,error:'来源无效'};
        if(settings.usageSource!=='codex-cli'||settings.codexConnection!=='managed'||!codexSetup)return{ok:false,error:'请先选择自动连接。'};
        const result=await (name==='connectCodex'?codexSetup.connect():name==='cancelCodexConnect'?codexSetup.cancel():codexSetup.logout());
        if(name==='logoutCodex'&&result.ok)settings.codexManagedConnected=false;
        if(result.code==='logout-failed')settings.codexManagedConnected=true;
        saveSettings();publish();
        return result;}
      case'enableCodex':
        if(settings.usageSource!=='codex-cli')return{ok:false,error:'请先选择本机 Codex 数据来源。'};
        if(!codexProvider)return{ok:false,error:'本机读取尚未准备好，请稍后重试。'};
        return applySettings({codexEnabled:true});
      case'disableCodex':return applySettings({codexEnabled:false});
      case'refreshCodex':
        if(codexSetup?.busy)return{ok:false,error:'请先完成或取消当前连接。'};
        if(settings.usageSource!=='codex-cli'||!settings.codexEnabled||!codexProvider)return{ok:false,error:'请先开启本机 Codex 读取。'};
        void codexProvider.refresh();break;
      case'copyCodexSetup':clipboard.writeText(process.platform==='darwin'?'npm install -g @openai/codex && codex login':'npm.cmd install -g @openai/codex\r\nif ($LASTEXITCODE -eq 0) { codex.cmd login }');break;
      case'openCodexHelp':await shell.openExternal('https://developers.openai.com/codex/cli');break;
      case'openDashboard':await shell.openExternal('https://chatgpt.com/settings/usage?tab=overview');break;
      case'openExtensionFolder':{
        if(!extensionInfo?.path||extensionInfo.error)return{ok:false,error:extensionInfo?.error||'扩展文件尚未准备好，请重新启动程序。'};
        if(await shell.openPath(extensionInfo.path))return{ok:false,error:'无法打开扩展目录，请检查文件访问权限。'};break;}
      case'openHelp':if(await shell.openPath(path.join(app.isPackaged?process.resourcesPath:app.getAppPath(),'README.html')))return{ok:false,error:'无法打开使用说明，请查看程序目录中的 resources/README.html。'};break;
      case'checkUpdates':if(!updateManager)return{ok:false,error:'请先使用支持更新的安装版。'};await updateManager.check({download:true});break;
      case'installUpdate':if(!updateManager)return{ok:false,error:'更新尚未准备好。'};saveSettings();return await updateManager.install();
      case'openRecoveryFolder':{
        const folder=path.join(app.getPath('userData'),'recovery');fs.mkdirSync(folder,{recursive:true});
        if(await shell.openPath(folder))return{ok:false,error:'无法打开配置备份目录。'};break;}
      case'openReleasePage':{
        const repository=updateManager?.snapshot().repository;
        if(typeof repository!=='string'||!/^[-A-Za-z0-9_]+\/[-A-Za-z0-9_.]+$/.test(repository))return{ok:false,error:'发布仓库尚未配置。'};
        await shell.openExternal('https://github.com/'+repository+'/releases');break;}
      case'setSettings':return applySettings(payload);
      case'dragStart':{
        if(event.sender!==orbWindow.webContents||drag)return{ok:false};
        const bounds=orbController.beginDrag();
        drag={cursor:screen.getCursorScreenPoint(),bounds,position:{x:bounds.x,y:bounds.y},moved:false};return{ok:true};}
      case'dragMove':
        if(event.sender!==orbWindow.webContents||!drag)return{ok:false};
        moveOrbDrag();return{ok:true,moved:drag.moved};
      case'dragEnd':{
        if(event.sender!==orbWindow.webContents||!drag)return{ok:false};
        if(payload!==undefined&&(!payload||typeof payload!=='object'||Array.isArray(payload)||
          Reflect.ownKeys(payload).length!==1||!Object.hasOwn(payload,'cancelled')||typeof payload.cancelled!=='boolean'))return{ok:false};
        // A release can be the first event after actual cursor travel. Sampling
        // it here prevents a drag from also toggling the panel; cancellation
        // never adopts a later cursor position outside this gesture.
        if(!payload?.cancelled)moveOrbDrag();
        const moved=drag.moved,positionChanged=moved&&(drag.position.x!==drag.bounds.x||drag.position.y!==drag.bounds.y);
        const position=drag.position;drag=null;
        const result=orbController.endDrag({position});
        if(positionChanged){savedPosition=orbController.compactPosition();clearTimeout(saveTimer);saveTimer=setTimeout(saveSettings,250);}
        return{ok:true,moved,expanded:result.expanded};}
      case'quit':app.quit();break;
      default:return{ok:false,error:'未知操作'};
    }return{ok:true};}catch{return{ok:false,error:'操作未完成，请稍后重试。'};}
  });
}
if(!app.requestSingleInstanceLock())app.quit();
else{
  app.on('second-instance',showPanel);
  app.on('activate',showPanel);
  app.whenReady().then(async()=>{
    Menu.setApplicationMenu(process.platform==='darwin'?Menu.buildFromTemplate([
      {label:app.getName(),submenu:[{label:'显示用量面板',click:showPanel},{type:'separator'},{role:'hide'},{role:'hideOthers'},
        {role:'unhide'},{type:'separator'},{label:'退出 GPT 悬浮球',role:'quit'}]},
      {label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]}
    ]):null);loadSettings();
    // Respect changes made in System Settings rather than re-registering a
    // disabled Mac login item at every launch. Windows migration is separate.
    if(process.platform==='darwin'&&app.isPackaged)try{
      const login=app.getLoginItemSettings({type:'mainAppService'});
      settings.autoStart=login.openAtLogin===true||login.status==='requires-approval';
    }catch{settings.autoStart=false;}
    fs.mkdirSync(app.getPath('userData'),{recursive:true});
    extensionInfo=await syncExtension({sourceDir:path.join(app.getAppPath(),'extension'),userData:app.getPath('userData')});
    if(quitting)return;
    registerIpc();createWindows();createTray();
    const codexWorkingDirectory=path.join(app.getPath('userData'),'codex-query');
    fs.mkdirSync(codexWorkingDirectory,{recursive:true});
    const codexHome=path.join(app.getPath('userData'),'codex-managed-home');
    // A non-persistent, cookie-free session is used only on explicit Connect.
    const componentSession=session.fromPartition('codex-component-download',{cache:false});
    const runtime=createCodexRuntime({userDataDir:app.getPath('userData'),platform:process.platform,arch:process.arch,
      request:options=>net.request({...options,session:componentSession,credentials:'omit',useSessionCookies:false,redirect:'manual'})});
    codexRuntime={
      async ensureReady(options){await prepareManagedDirectories(app.getPath('userData'),{create:true});
        const executable=await runtime.ensureReady(options);
        if(!await prepareManagedDirectories(app.getPath('userData'),{create:false}))throw Object.assign(new Error('连接目录不可用。'),{code:'storage'});
        return executable;},
      async getVerifiedExecutable(options){const directories=await prepareManagedDirectories(app.getPath('userData'),{create:false});
        return directories?runtime.getVerifiedExecutable(options):null;}};
    codexSetup=new CodexSetup({runtime:codexRuntime,login:loginManagedCodex,logout:logoutManagedCodex,codexHome,cwd:codexWorkingDirectory,
      openExternal:url=>shell.openExternal(url),onState:publish,
      onDisconnect:async()=>{const stopped=codexProvider?.stopAndWait();settings.codexEnabled=false;snapshot=null;notified.clear();saveSettings();refreshTrayMenu();publish();await stopped;},
      onConnected:()=>{if(quitting||settings.usageSource!=='codex-cli'||settings.codexConnection!=='managed')return;
        settings.codexManagedConnected=true;settings.codexEnabled=true;saveSettings();
        void codexProvider?.start(settings.refreshMinutes);refreshTrayMenu();publish();}});
    if(settings.codexManagedConnected)codexSetup.markConnected();
    codexProvider=new CodexProvider({discover:async({signal}={})=>{
      if(settings.codexConnection==='existing')return discoverCodex();
      const executable=await codexRuntime.getVerifiedExecutable({signal});
      return executable?{path:executable,codexHome}:null;},cwd:codexWorkingDirectory,
      intervalMinutes:settings.refreshMinutes,onState:publish,
      onSnapshot:value=>{if(!quitting&&settings.usageSource==='codex-cli'&&settings.codexEnabled){
        if(settings.codexConnection==='managed'){settings.codexManagedConnected=true;codexSetup.markConnected();saveSettings();}
        snapshot=value;publish();notifyLow();}},
      onClear:()=>{if(settings.usageSource==='codex-cli'){snapshot=null;notified.clear();publish();}}});
    // Packaged apps supply this reviewed source marker. macOS uses a separate
    // signed-metadata/manual-download flow until Developer ID distribution is set up.
    // Legacy portable Windows copies cannot fall back to an unsigned updater.
    if(['win32','darwin'].includes(process.platform)&&app.isPackaged&&!process.env.PORTABLE_EXECUTABLE_FILE&&
      fs.existsSync(path.join(process.resourcesPath,'app-update.yml'))){
      let config;try{config=JSON.parse(fs.readFileSync(path.join(app.getAppPath(),'update-config.json'),'utf8'));}catch{config=null;}
      updateManager=process.platform==='darwin'
        ?new MacUpdateManager({appVersion:app.getVersion(),config,arch:process.arch,onState:publish,openExternal:url=>shell.openExternal(url)})
        :new UpdateManager({appVersion:app.getVersion(),config,userData:app.getPath('userData'),onState:publish});
      const check=()=>{if(settings.autoCheckUpdates&&!quitting)void updateManager.check({download:true});};
      firstUpdateTimer=setTimeout(check,10000);updateTimer=setInterval(check,6*60*60*1000);
    }
    // Re-register the preserved preference with the new stable install path when
    // migrating from the portable release; only when startup was already enabled.
    if(settings.autoStart&&process.platform==='win32')app.setLoginItemSettings({openAtLogin:true,path:process.execPath,args:['--startup']});
    bridge=new UsageBridge({onSnapshot:value=>{if(settings.usageSource==='browser'){snapshot=value;publish();notifyLow();}},onConnection:()=>publish()});
    try{await bridge.start();}catch{error='本机同步端口 43861 无法启动。请关闭其他新版悬浮球后重新打开。';}publish();
    if(settings.usageSource==='codex-cli'&&settings.codexEnabled)void codexProvider.start(settings.refreshMinutes);
    globalShortcut.register('CommandOrControl+Alt+G',togglePanel);
    for(const event of['display-metrics-changed','display-removed'])screen.on(event,()=>{orbController.syncDisplay();anchorPanel();});
    tick=setInterval(publish,30000);
  }).catch(()=>{dialog.showErrorBox('GPT 悬浮球启动失败','请重新打开程序；若仍无法启动，请使用完整安装包修复。');app.quit();});
  app.on('window-all-closed',()=>{});
  app.on('before-quit',event=>{if(quitting)return;event.preventDefault();quitting=true;
    clearInterval(tick);clearInterval(updateTimer);clearTimeout(firstUpdateTimer);clearTimeout(saveTimer);updateManager?.stop();saveSettings();snapshot=null;globalShortcut.unregisterAll();tray?.destroy();
    Promise.allSettled([codexSetup?.stop(),codexProvider?.stopAndWait(),bridge?.close()]).finally(()=>app.quit());
  });
}
