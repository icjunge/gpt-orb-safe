'use strict';
const {app,BrowserWindow,ipcMain,screen,Tray,Menu,nativeImage,shell,Notification,
  globalShortcut,dialog,clipboard,nativeTheme} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {pathToFileURL} = require('node:url');
const {UsageBridge} = require('./bridge.cjs');
const {syncExtension} = require('./extension-store.cjs');
const {UpdateManager} = require('./updater.cjs');
const {validSettings,allowedSender} = require('./security.cjs');
const {CodexProvider} = require('./codex-provider.cjs');
const {discoverCodex} = require('./codex-discovery.cjs');
const {supportsAcrylic,systemAppearance,applyPanelMaterial} = require('./window-material.cjs');
app.setName('GPT Usage Orb Safe');
app.setAppUserModelId('GPTUsageOrb.Safe.Desktop');
let orbWindow,panelWindow,tray,bridge,tick,drag=null,saveTimer,quitting=false;
let updateManager=null,updateTimer=null,firstUpdateTimer=null,extensionInfo=null;
let codexProvider=null;
let appearance=systemAppearance(nativeTheme);
const unavailableUpdates=()=>({status:'unconfigured',currentVersion:app.getVersion(),availableVersion:null,progress:null,
  message:'请使用支持更新的安装版，并启用发布源。',lastCheckedAt:null,repository:null});
let settings=validSettings({}),savedPosition=null,snapshot=null,error=null,notified=new Set();
const trustedWindows=new Map();
const settingsPath=()=>path.join(app.getPath('userData'),'preferences.json');
function loadSettings(){
  try{const data=JSON.parse(fs.readFileSync(settingsPath(),'utf8'));settings=validSettings(data.settings);
    if(Number.isFinite(data.position?.x)&&Number.isFinite(data.position?.y))savedPosition=data.position;
  }catch{}
}
function saveSettings(){
  try{fs.mkdirSync(app.getPath('userData'),{recursive:true});const temporary=settingsPath()+'.tmp';
    fs.writeFileSync(temporary,JSON.stringify({settings,position:savedPosition},null,2));fs.renameSync(temporary,settingsPath());
  }catch{}
}
function nativeStatus(){return codexProvider?.getStatus()||{enabled:false,running:false,state:'disabled',message:'点击开启本机读取。',
  lastSuccessAt:null,nextRunAt:null,intervalMinutes:settings.refreshMinutes};}
function staleAfterMs(){return settings.usageSource==='codex-cli'?settings.refreshMinutes*60000+90000:180000;}
function currentError(){const status=nativeStatus();return settings.usageSource==='codex-cli'
  ?(['not-found','needs-login','unsupported','error'].includes(status.state)?status.message:null):error;}
function state(){const status=bridge?.getStatus()||{listening:false,connected:false,lastReceivedAt:null,port:43861};
  const activeError=currentError();
  return {status:activeError?'error':snapshot?'ready':settings.usageSource==='codex-cli'||status.listening?'waiting':'starting',
    bridge:status,snapshot,settings,appearance,error:activeError,codex:nativeStatus(),usageSource:settings.usageSource,staleAfterMs:staleAfterMs(),
    updates:updateManager?.snapshot()||unavailableUpdates(),
    extension:extensionInfo?{version:extensionInfo.version,changed:extensionInfo.changed,needsReload:extensionInfo.changed,error:extensionInfo.error||null}:null};}
function clampPosition(position,width=92,height=104){
  const display=position?screen.getDisplayNearestPoint({x:Math.round(position.x),y:Math.round(position.y)}):screen.getPrimaryDisplay();
  const a=display.workArea;return{x:Math.round(Math.max(a.x,Math.min(position?.x??a.x+a.width-width-24,a.x+a.width-width))),
    y:Math.round(Math.max(a.y,Math.min(position?.y??a.y+a.height/2-height/2,a.y+a.height-height)))};
}
function anchorPanel(){if(!panelWindow||panelWindow.isDestroyed()||!orbWindow)return;
  const b=orbWindow.getBounds(),a=screen.getDisplayMatching(b).workArea,width=Math.min(440,a.width),height=Math.min(780,a.height);
  let x=b.x-width-10;if(x<a.x)x=b.x+b.width+10;x=Math.max(a.x,Math.min(x,a.x+a.width-width));
  panelWindow.setBounds({x,y:Math.max(a.y,Math.min(b.y-60,a.y+a.height-height)),width,height});
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
function createWindows(){
  const common={frame:false,transparent:true,backgroundColor:'#00000000',resizable:false,maximizable:false,
    minimizable:false,fullscreenable:false,show:false,skipTaskbar:true,icon:path.join(__dirname,'../assets/orb.png'),
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,
      webSecurity:true,webviewTag:false,backgroundThrottling:true,spellcheck:false}};
  orbWindow=new BrowserWindow({...common,width:92,height:104,...clampPosition(savedPosition),hasShadow:false});
  const nativePanel=supportsAcrylic(process.platform,os.release());
  panelWindow=new BrowserWindow({...common,width:440,height:780,hasShadow:true,roundedCorners:true,
    transparent:!nativePanel});
  const updateAppearance=()=>{
    appearance=applyPanelMaterial(panelWindow,{platform:process.platform,release:os.release(),theme:nativeTheme});
    publish();
  };
  updateAppearance();
  nativeTheme.on('updated',updateAppearance);
  panelWindow.once('closed',()=>nativeTheme.removeListener('updated',updateAppearance));
  for(const [win,name]of[[orbWindow,'orb'],[panelWindow,'panel']]){
    const file=path.join(__dirname,'ui',name+'.html');harden(win,file);win.setAlwaysOnTop(settings.alwaysOnTop,'floating');
    win.on('close',e=>{if(!quitting){e.preventDefault();win.hide();}});win.loadFile(file);
  }
  orbWindow.setOpacity(settings.opacity);
  orbWindow.once('ready-to-show',()=>orbWindow.showInactive());
  panelWindow.once('ready-to-show',()=>{if(!process.argv.includes('--startup'))showPanel();});
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
function createTray(){tray=new Tray(nativeImage.createFromPath(path.join(__dirname,'../assets/orb.png')).resize({width:32,height:32}));
  tray.setToolTip('GPT 悬浮球 · 本机额度查询');tray.setContextMenu(trayMenu());
  tray.on('click',togglePanel);tray.on('double-click',showPanel);tray.on('balloon-click',showPanel);
}
function applySettings(input){
  const next=validSettings(input,settings);
  const sourceChanged=next.usageSource!==settings.usageSource;
  if(sourceChanged||next.usageSource!=='codex-cli')next.codexEnabled=false;
  const nativeChanged=sourceChanged||next.codexEnabled!==settings.codexEnabled||next.refreshMinutes!==settings.refreshMinutes;
  if(next.autoStart!==settings.autoStart&&process.platform==='win32'){
    app.setLoginItemSettings({openAtLogin:next.autoStart,path:process.execPath,args:['--startup']});
    next.autoStart=app.getLoginItemSettings({path:process.execPath,args:['--startup']}).openAtLogin;
  }
  const newlyEnabled=next.autoCheckUpdates&&!settings.autoCheckUpdates;
  settings=next;if(newlyEnabled)void updateManager?.check({download:true});
  if(sourceChanged){snapshot=null;notified.clear();bridge?.rotateKey();}
  if(nativeChanged&&codexProvider){
    if(settings.usageSource==='codex-cli'&&settings.codexEnabled)void codexProvider.start(settings.refreshMinutes);
    else codexProvider.stop();
  }
  orbWindow.setAlwaysOnTop(settings.alwaysOnTop,'floating');panelWindow.setAlwaysOnTop(settings.alwaysOnTop,'floating');
  orbWindow.setOpacity(settings.opacity);saveSettings();tray?.setContextMenu(trayMenu());publish();return{ok:true};
}
function disconnect(){codexProvider?.stop();settings.codexEnabled=false;saveSettings();snapshot=null;notified.clear();bridge?.rotateKey();tray?.setContextMenu(trayMenu());publish();}
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
      case'copyPairingCode':if(!bridge?.getStatus().listening)return{ok:false,error:'本机同步尚未启动'};clipboard.writeText(bridge.getPairingCode());break;
      case'disconnect':disconnect();break;
      case'enableCodex':
        if(settings.usageSource!=='codex-cli')return{ok:false,error:'请先选择本机 Codex 数据来源。'};
        if(!codexProvider)return{ok:false,error:'本机读取尚未准备好，请稍后重试。'};
        return applySettings({codexEnabled:true});
      case'disableCodex':return applySettings({codexEnabled:false});
      case'refreshCodex':
        if(settings.usageSource!=='codex-cli'||!settings.codexEnabled||!codexProvider)return{ok:false,error:'请先开启本机 Codex 读取。'};
        void codexProvider.refresh();break;
      case'copyCodexSetup':clipboard.writeText('npm.cmd install -g @openai/codex\r\nif ($LASTEXITCODE -eq 0) { codex.cmd login }');break;
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
      case'dragStart':if(event.sender!==orbWindow.webContents)return{ok:false};drag={cursor:screen.getCursorScreenPoint(),bounds:orbWindow.getBounds()};break;
      case'dragMove':if(event.sender!==orbWindow.webContents||!drag)return{ok:false};{
        const p=screen.getCursorScreenPoint(),point=clampPosition({x:drag.bounds.x+p.x-drag.cursor.x,y:drag.bounds.y+p.y-drag.cursor.y});
        orbWindow.setPosition(point.x,point.y);anchorPanel();break;}
      case'dragEnd':if(event.sender!==orbWindow.webContents)return{ok:false};drag=null;savedPosition={x:orbWindow.getBounds().x,y:orbWindow.getBounds().y};clearTimeout(saveTimer);saveTimer=setTimeout(saveSettings,250);break;
      case'quit':app.quit();break;
      default:return{ok:false,error:'未知操作'};
    }return{ok:true};}catch{return{ok:false,error:'操作未完成，请稍后重试。'};}
  });
}
if(!app.requestSingleInstanceLock())app.quit();
else{
  app.on('second-instance',showPanel);
  app.whenReady().then(async()=>{
    Menu.setApplicationMenu(null);loadSettings();
    fs.mkdirSync(app.getPath('userData'),{recursive:true});
    extensionInfo=await syncExtension({sourceDir:path.join(app.getAppPath(),'extension'),userData:app.getPath('userData')});
    registerIpc();createWindows();createTray();
    const codexWorkingDirectory=path.join(app.getPath('userData'),'codex-query');
    fs.mkdirSync(codexWorkingDirectory,{recursive:true});
    codexProvider=new CodexProvider({discover:()=>discoverCodex(),cwd:codexWorkingDirectory,
      intervalMinutes:settings.refreshMinutes,onState:publish,
      onSnapshot:value=>{if(!quitting&&settings.usageSource==='codex-cli'&&settings.codexEnabled){snapshot=value;publish();notifyLow();}},
      onClear:()=>{if(settings.usageSource==='codex-cli'){snapshot=null;notified.clear();publish();}}});
    // NSIS installs supply app-update.yml. Legacy portable packages cannot safely
    // use this updater and never fall back to an unsigned download-and-run path.
    if(process.platform==='win32'&&app.isPackaged&&!process.env.PORTABLE_EXECUTABLE_FILE&&
      fs.existsSync(path.join(process.resourcesPath,'app-update.yml'))){
      let config;try{config=JSON.parse(fs.readFileSync(path.join(app.getAppPath(),'update-config.json'),'utf8'));}catch{config=null;}
      updateManager=new UpdateManager({appVersion:app.getVersion(),config,userData:app.getPath('userData'),onState:publish});
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
    for(const event of['display-metrics-changed','display-removed'])screen.on(event,()=>{const p=clampPosition(orbWindow.getBounds());orbWindow.setPosition(p.x,p.y);anchorPanel();});
    tick=setInterval(publish,30000);
  }).catch(()=>{dialog.showErrorBox('GPT 悬浮球启动失败','请重新打开程序；若仍无法启动，请使用完整安装包修复。官方账号凭据不由悬浮球保存。');app.quit();});
  app.on('window-all-closed',()=>{});
  app.on('before-quit',event=>{if(quitting)return;event.preventDefault();quitting=true;
    clearInterval(tick);clearInterval(updateTimer);clearTimeout(firstUpdateTimer);clearTimeout(saveTimer);updateManager?.stop();codexProvider?.stop();saveSettings();snapshot=null;globalShortcut.unregisterAll();tray?.destroy();
    Promise.resolve(bridge?.close()).finally(()=>app.quit());
  });
}
