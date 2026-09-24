'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const {pathToFileURL} = require('node:url');
const security = require('../src/security.cjs');
const mainFile = path.resolve(__dirname, '../src/main.cjs');
const mainSource = fs.readFileSync(mainFile, 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let count = 0; count < 8; count += 1) await Promise.resolve(); };

// Run the actual main-process controller with isolated in-memory dependencies.
// No Electron process, executable discovery, account file, network or CLI is used.
async function launch({preferences, managedLogin, managedStop, platform='win32', arch='x64', isPackaged=false, loginStatus, bridgeFails = false, release = '10.0.22631', theme = {}, backdropFails = false, orbBackdropFails = false, workArea={x:0,y:0,width:1920,height:1080}} = {}) {
  const handlers = new Map(), windows = [], providers = [], bridges = [], files = new Map();
  const calls = {discover:0, quit:0, external:[], openPath:[], clipboard:[], errors:[], login:[], notifications:[],componentDownloads:0,componentChecks:0,managedLogins:[],managedLogouts:[],menus:[],trayPopups:0,dockHides:0,dialogs:[],shortcuts:[],updaters:[]};
  const userData = '/virtual-orb/user-data';
  const preferencesPath = path.join(userData, 'preferences.json');
  if (preferences) files.set(preferencesPath, JSON.stringify(preferences));
  if(isPackaged){files.set(path.join('/virtual-orb/resources','app-update.yml'),'fixture source marker');
    files.set(path.resolve(__dirname,'../update-config.json'),JSON.stringify(require('../update-config.json')));}
  const timers = new Map();
  let nextTimer = 1;
  const addTimer = (callback, delay) => { const id = nextTimer++; timers.set(id, {callback, delay}); return id; };
  const app = new EventEmitter();
  const nativeTheme=Object.assign(new EventEmitter(),{prefersReducedTransparency:false,shouldUseHighContrastColors:false},theme);
  Object.assign(app, {
    isPackaged,
    setName(){}, setAppUserModelId(){}, requestSingleInstanceLock:()=>true,
    whenReady:()=>Promise.resolve(), getVersion:()=> '2.3.0',
    getName:()=> 'GPT Usage Orb Safe',dock:{hide:()=>{calls.dockHides++;}},
    getGPUFeatureStatus(){assert.fail('orb startup must not depend on GPU feature status');},
    getGPUInfo(){assert.fail('orb startup must not request GPU information');},
    getPath:name => { assert.equal(name, 'userData'); return userData; },
    getAppPath:()=>path.resolve(__dirname, '..'),
    setLoginItemSettings:value => calls.login.push(value),
    getLoginItemSettings:()=>loginStatus||({openAtLogin:calls.login.at(-1)?.openAtLogin || false}),
    quit(){calls.quit += 1; app.emit('before-quit', {preventDefault(){}});}
  });
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options=options; this.visible=false; this.bounds={x:0,y:0,...options}; this.sent=[];
      this.webContents=new EventEmitter();
      Object.assign(this.webContents, {
        mainFrame:{url:''}, isDestroyed:()=>false,
        setWindowOpenHandler(){},
        session:{setPermissionRequestHandler(){},setPermissionCheckHandler(){}},
        send:(channel, value) => { this.lastSent={channel,value:clone(value)}; this.sent.push(this.lastSent); }
      });
      windows.push(this);
    }
    loadFile(file){this.webContents.mainFrame.url=pathToFileURL(file).href;}
    isDestroyed(){return false;}
    setAlwaysOnTop(){} setOpacity(value){(this.opacities||=[]).push(value);} focus(){this.focusCalls=(this.focusCalls||0)+1;}
    setBackgroundMaterial(value){if((backdropFails&&value==='acrylic')||(orbBackdropFails&&windows[0]===this))throw new Error('unavailable compositor');this.material=value;}
    setBackgroundColor(value){this.backgroundColor=value;}
    setVibrancy(value){this.vibrancy=value;}
    setVisibleOnAllWorkspaces(value,options){this.workspaces={value,options};}
    setShape(value){(this.shapes||=[]).push(clone(value));}
    showInactive(){this.visible=true;} show(){this.visible=true;} hide(){this.visible=false;}
    isVisible(){return this.visible;}
    getBounds(){return{...this.bounds};} setBounds(bounds){const before=this.bounds;this.bounds={...this.bounds,...bounds};this.boundUpdates=(this.boundUpdates||0)+1;
      if(before.x!==this.bounds.x||before.y!==this.bounds.y)this.emit('move');
      if(before.width!==this.bounds.width||before.height!==this.bounds.height)this.emit('resize');}
    setPosition(x,y){Object.assign(this.bounds,{x,y});this.emit('move');}
  }
  class Tray extends EventEmitter {
    constructor(){super();calls.tray=this;}
    setToolTip(value){this.tooltip=value;} setContextMenu(value){this.menu=value;}
    isDestroyed(){return false;} destroy(){} displayBalloon(value){calls.notifications.push(value);}
    popUpContextMenu(){calls.trayPopups++;}
  }
  class Provider {
    constructor(options) {
      this.options=options; this.starts=[]; this.stops=0; this.refreshes=0;
      this.status={enabled:false,running:false,state:'disabled',message:'disabled',
        lastSuccessAt:null,nextRunAt:null,intervalMinutes:options.intervalMinutes};
      providers.push(this);
    }
    getStatus(){return {...this.status};}
    start(minutes){this.starts.push(minutes); Object.assign(this.status,{enabled:true,state:'idle',intervalMinutes:minutes}); this.options.onState();}
    stop(){this.stops += 1; Object.assign(this.status,{enabled:false,running:false,state:'disabled'}); this.options.onState();}
    async stopAndWait(){this.stop();await managedStop?.();}
    refresh(){this.refreshes += 1;}
    emitSnapshot(snapshot){this.options.onSnapshot(snapshot);}
    clear(){this.options.onClear();}
    emitStatus(patch){Object.assign(this.status,patch);this.options.onState();}
  }
  class Bridge {
    constructor(options){this.options=options;this.rotations=0;this.closed=0;this.listening=false;bridges.push(this);}
    async start(){if(bridgeFails)throw new Error('port in use');this.listening=true;}
    getStatus(){return {listening:this.listening,connected:false,lastReceivedAt:null,port:43861};}
    getPairingCode(){return 'test-local-pairing-code';}
    rotateKey(){this.rotations += 1;}
    async close(){this.closed += 1;this.listening=false;}
    emitSnapshot(snapshot){this.options.onSnapshot(snapshot);}
  }
  const electron={
    app,BrowserWindow:Window,Tray,nativeTheme,
    session:{fromPartition:(name,options)=>{assert.equal(name,'codex-component-download');assert.equal(options.cache,false);return{};}},
    net:{request:()=>assert.fail('controller tests cannot access network')},
    ipcMain:{handle:(channel, handler)=>handlers.set(channel,handler)},
    screen:Object.assign(new EventEmitter(),{
      getPrimaryDisplay:()=>({workArea}),
      getDisplayNearestPoint:()=>({workArea}),
      getDisplayMatching:()=>({workArea}),getCursorScreenPoint:()=>({x:0,y:0})
    }),
    Menu:{setApplicationMenu:menu=>calls.menus.push(menu),buildFromTemplate:items=>({items,popup(){}})},
    nativeImage:{createFromPath:()=>({resize:()=>({})}),createFromBitmap:()=>({setTemplateImage:value=>{calls.templateImage=value;}})},
    shell:{openExternal:async url=>{calls.external.push(url);},openPath:async value=>{calls.openPath.push(value);return '';}},
    Notification:{isSupported:()=>false},
    globalShortcut:{register:key=>calls.shortcuts.push(key),unregisterAll(){}},
    dialog:{showErrorBox:(...args)=>calls.errors.push(args),showMessageBox:async(...args)=>calls.dialogs.push(args)},
    clipboard:{writeText:value=>calls.clipboard.push(value)}
  };
  const virtualFs={
    readFileSync(file){if(!files.has(file))throw new Error('virtual file does not exist');return files.get(file);},
    writeFileSync:(file, contents)=>files.set(file,String(contents)),
    renameSync(from,to){assert.ok(files.has(from));files.set(to,files.get(from));files.delete(from);},
    mkdirSync(){},existsSync:file=>files.has(file)
  };
  const modules={
    electron,'node:fs':virtualFs,'node:path':path,'node:url':{pathToFileURL},'node:os':{release:()=>release},
    './security.cjs':security,'./bridge.cjs':{UsageBridge:Bridge},
    './extension-store.cjs':{syncExtension:async()=>({path:'/virtual-orb/extension',version:'2.3.0',changed:false})},
    './updater.cjs':{UpdateManager:class {constructor(){throw new Error('not packaged');}}},
    './mac-updater.cjs':{MacUpdateManager:class {
      constructor(options){this.options=options;this.checked=0;this.installed=0;this.stopped=false;calls.updaters.push(this);}
      snapshot(){return{status:'idle',installMode:'manual',currentVersion:this.options.appVersion,repository:this.options.config?.repository};}
      check(){this.checked++;return this.snapshot();}install(){this.installed++;return{ok:true};}stop(){this.stopped=true;}}},
    './codex-provider.cjs':{CodexProvider:Provider},
    './codex-setup.cjs':require('../src/codex-setup.cjs'),
    './codex-directories.cjs':{prepareManagedDirectories:async()=>({codexHome:'/virtual-orb/user-data/codex-managed-home',cwd:'/virtual-orb/user-data/codex-query'})},
    './codex-runtime.cjs':{createCodexRuntime:()=>({
      async ensureReady(){calls.componentDownloads++;return '/virtual-orb/managed/codex.exe';},
      async getVerifiedExecutable(){calls.componentChecks++;return '/virtual-orb/managed/codex.exe';}})},
    './codex-auth.cjs':{
      loginManagedCodex:async options=>{calls.managedLogins.push(options);return managedLogin?managedLogin(options):{connected:true};},
      logoutManagedCodex:async options=>{calls.managedLogouts.push(options);return{connected:false};}},
    './window-material.cjs':require('../src/window-material.cjs'),
    './orb-window.cjs':require('../src/orb-window.cjs'),
    './codex-discovery.cjs':{discoverCodex:()=>{calls.discover += 1;throw new Error('discovery must not execute in controller tests');}}
  };
  vm.runInNewContext(mainSource, {
    require:name=>{assert.ok(Object.hasOwn(modules,name),`Unexpected dependency: ${name}`);return modules[name];},
    __dirname:path.dirname(mainFile),
    process:{platform,arch,argv:[],env:{},execPath:'/virtual-orb/orb.exe',resourcesPath:'/virtual-orb/resources'},Buffer,
    setTimeout:addTimer,setInterval:addTimer,clearTimeout:id=>timers.delete(id),clearInterval:id=>timers.delete(id)
  },{filename:mainFile});
  await settle();
  assert.deepEqual(calls.errors,[],'controller initialization must succeed');
  assert.equal(providers.length,1); assert.equal(bridges.length,1);
  const sender=windows[1].webContents;
  const event={sender,senderFrame:sender.mainFrame};
  const state=()=>clone(handlers.get('orb:state')(event));
  const action=async(name,payload,source=event)=>clone(await handlers.get('orb:action')(source,name,payload));
  return {app,windows,nativeTheme,screen:electron.screen,provider:providers[0],bridge:bridges[0],calls,state,action,event,handlers,timers,
    saved:()=>JSON.parse(files.get(preferencesPath)),
    async quit(){app.quit();await settle();}};
}

test('orb remains a small transparent alpha circle while panel Acrylic and accessibility work independently',async()=>{
  const h=await launch();
  const [orb,panel]=h.windows;
  assert.equal(orb.options.transparent,true);
  assert.equal(orb.options.thickFrame,false);
  assert.equal(orb.options.roundedCorners,false);
  assert.equal(orb.options.width,56);
  assert.equal(orb.options.height,56);
  assert.equal(orb.material,'none');
  assert.equal(orb.backgroundColor,'#00000000');
  assert.equal(orb.shapes.length,1);
  assert.deepEqual(orb.opacities,[1]);
  assert.equal(orb.focusCalls,undefined);
  assert.equal(panel.options.transparent,false);
  assert.equal(panel.options.roundedCorners,true);
  assert.equal(panel.options.width,340);
  assert.equal(panel.options.height,240);
  assert.equal(h.nativeTheme.themeSource,'dark');
  assert.equal(panel.material,'acrylic');
  assert.equal(panel.backgroundColor,'#00000000');
  assert.deepEqual(h.state().appearance,{nativeBackdrop:true,backdropStatus:'requested',reducedTransparency:false,highContrast:false,
    orbNativeHost:false,orbNativeBackdrop:false,orbBackdropStatus:'unavailable'});
  h.nativeTheme.prefersReducedTransparency=true;
  h.nativeTheme.emit('updated');
  assert.equal(panel.material,'none');
  assert.equal(orb.material,'none');
  assert.equal(h.state().appearance.reducedTransparency,true);
  assert.equal(h.state().appearance.nativeBackdrop,false);
  assert.equal(h.state().appearance.orbNativeBackdrop,false);
  h.nativeTheme.prefersReducedTransparency=false;
  h.nativeTheme.shouldUseHighContrastColors=true;
  h.nativeTheme.emit('updated');
  assert.equal(panel.material,'none');
  assert.equal(h.state().appearance.highContrast,true);
  h.nativeTheme.shouldUseHighContrastColors=false;
  h.nativeTheme.emit('updated');
  assert.equal(panel.material,'acrylic');
  assert.equal(orb.material,'none');
  await h.action('setSettings',{opacity:.6});
  assert.equal(orb.opacities.at(-1),.6,'the alpha host retains the existing opacity setting');
  assert.deepEqual([...h.handlers.keys()],['orb:state','orb:action']);
});

test('orb hover accepts only a boolean from its exact main frame and cannot move or resize the panel',async()=>{
  const h=await launch(),[orb,panel]=h.windows;
  const event={sender:orb.webContents,senderFrame:orb.webContents.mainFrame};
  const initial=clone(orb.bounds),panelBounds=clone(panel.bounds);
  for(const payload of [undefined,null,[],{},true,{expanded:1},{expanded:'true'},{expanded:true,width:500},{expanded:true,x:0}]){
    assert.equal((await h.action('orbExpand',payload,event)).ok,false);
    assert.deepEqual(clone(orb.bounds),initial);
  }
  for(const invalid of [h.event,{sender:orb.webContents,senderFrame:{url:orb.webContents.mainFrame.url}},{}]){
    assert.equal((await h.action('orbExpand',{expanded:true},invalid)).ok,false);
    assert.deepEqual(clone(orb.bounds),initial);
  }
  assert.deepEqual(await h.action('orbExpand',{expanded:true},event),{ok:true,expanded:true});
  assert.equal(orb.bounds.width,56);assert.equal(orb.bounds.height,56);
  assert.deepEqual(clone(orb.bounds),initial);assert.equal(orb.boundUpdates,undefined);
  assert.deepEqual(clone(panel.bounds),panelBounds);
  assert.equal(orb.focusCalls,undefined);assert.equal(panel.focusCalls,undefined);
  await h.action('orbExpand',{expanded:false},event);
  assert.equal(orb.bounds.x,initial.x);assert.equal(orb.bounds.y,initial.y);
  assert.equal(orb.bounds.width,56);assert.equal(orb.bounds.height,56);assert.equal(orb.boundUpdates,undefined);
});

test('drag clamps the visible compact orb, applies pending appearance and saves its logical compact position',async()=>{
  const h=await launch(),[orb]=h.windows,event={sender:orb.webContents,senderFrame:orb.webContents.mainFrame};
  await h.action('orbExpand',{expanded:true},event);
  h.screen.getCursorScreenPoint=()=>({x:500,y:500});
  await h.action('dragStart',undefined,event);
  assert.deepEqual(await h.action('orbExpand',{expanded:false},event),{ok:true,expanded:true,queued:true});
  assert.equal(orb.bounds.width,56);
  h.screen.getCursorScreenPoint=()=>({x:4000,y:4000});
  await h.action('dragMove',{x:-9999,y:-9999},event);
  assert.equal(orb.bounds.x,1868);assert.equal(orb.bounds.y,1028);
  await h.action('dragEnd',undefined,event);
  assert.equal(orb.bounds.width,56);assert.equal(orb.bounds.x,1868);assert.equal(orb.bounds.y,1028);
  for(const timer of h.timers.values())if(timer.delay===250)timer.callback();
  assert.deepEqual(h.saved().position,{x:1872,y:1032});
  const shapes=orb.shapes.length;
  h.screen.emit('display-metrics-changed');
  assert.equal(orb.shapes.length,shapes+1,'rebuild the native region even if DIP dimensions do not change');
});

test('stationary press and native DIP jitter never move, save or adopt hover bounds changes',async()=>{
  const h=await launch(),[orb]=h.windows,event={sender:orb.webContents,senderFrame:orb.webContents.mainFrame};
  const compact={x:orb.bounds.x,y:orb.bounds.y};
  h.screen.getCursorScreenPoint=()=>({x:500,y:500});
  for(let cycle=0;cycle<30;cycle++){
    await h.action('orbExpand',{expanded:true},event);
    const expanded={x:orb.bounds.x,y:orb.bounds.y};
    await h.action('dragStart',undefined,event);
    for(const delta of [{x:0,y:0},{x:3,y:0},{x:2,y:2},{x:0,y:4}]){
      h.screen.getCursorScreenPoint=()=>({x:500+delta.x,y:500+delta.y});
      assert.deepEqual(await h.action('dragMove',{screenX:9000,screenY:-9000},event),{ok:true,moved:false});
      assert.deepEqual({x:orb.bounds.x,y:orb.bounds.y},expanded);
    }
    assert.equal([...h.timers.values()].some(timer=>timer.delay===250),false,'jitter must not schedule a saved position');
    // Native resize can report its bounds late; no actual cursor drag occurred.
    orb.bounds.x+=4;orb.bounds.y+=4;
    await h.action('orbExpand',{expanded:false},event);
    assert.deepEqual(await h.action('dragEnd',{cancelled:false},event),{ok:true,moved:false,expanded:false});
    assert.deepEqual({x:orb.bounds.x,y:orb.bounds.y},compact);
    h.screen.getCursorScreenPoint=()=>({x:500,y:500});
  }
  assert.equal([...h.timers.values()].some(timer=>timer.delay===250),false);
});

test('full main flow never writes geometry for stationary presses or one DIP native rounding, and repairs later real offsets',async()=>{
  const position={x:400,y:300},h=await launch({preferences:{position}}),[orb]=h.windows;
  const event={sender:orb.webContents,senderFrame:orb.webContents.mainFrame},initial={x:396,y:296};
  h.screen.getCursorScreenPoint=()=>({x:424,y:324});
  orb.bounds.x+=1;orb.bounds.y+=1;
  for(let count=0;count<20;count++){
    await h.action('orbExpand',{expanded:true},event);await h.action('dragStart',undefined,event);
    await h.action('dragMove',undefined,event);await h.action('dragEnd',{cancelled:false},event);
    await h.action('orbExpand',{expanded:false},event);
  }
  assert.equal(orb.boundUpdates,undefined,'no native resize/reposition for hover/down/up, including fractional DPI feedback');
  assert.deepEqual(h.saved().position,position);
  for(let count=0;count<20;count++){
    await h.action('dragStart',undefined,event);await h.action('dragEnd',{cancelled:false},event);
    orb.bounds.x=initial.x+4;orb.bounds.y=initial.y+4;orb.emit('move');
    assert.deepEqual({x:orb.bounds.x,y:orb.bounds.y},initial,'a late native move is repaired after release');
  }
  assert.equal([...h.timers.values()].some(timer=>timer.delay===250),false);
  assert.deepEqual(h.saved().position,position,'late native reports cannot become saved user positions');
});

test('full main drag commits its trusted cursor target even when the compositor reports a different release position',async()=>{
  const h=await launch({preferences:{position:{x:400,y:300}}}),[orb]=h.windows;
  const event={sender:orb.webContents,senderFrame:orb.webContents.mainFrame};
  let cursor={x:424,y:324};h.screen.getCursorScreenPoint=()=>cursor;
  await h.action('dragStart',undefined,event);cursor={x:484,y:364};await h.action('dragMove',undefined,event);
  orb.bounds.x+=4;orb.bounds.y+=4;
  assert.deepEqual(await h.action('dragEnd',{cancelled:false},event),{ok:true,moved:true,expanded:false});
  assert.deepEqual({x:orb.bounds.x,y:orb.bounds.y},{x:456,y:336});
  for(const timer of h.timers.values())if(timer.delay===250)timer.callback();
  assert.deepEqual(h.saved().position,{x:460,y:340});
  orb.bounds.x+=4;orb.bounds.y+=4;orb.emit('move');
  assert.deepEqual({x:orb.bounds.x,y:orb.bounds.y},{x:456,y:336},'late native movement is restored after a completed real drag');
  assert.deepEqual(h.saved().position,{x:460,y:340},'post-release compositor reports never overwrite the logical saved target');
});

test('outward drags clamped at every corner never shift or save the compact anchor',async()=>{
  for(const position of [{x:0,y:0},{x:1872,y:0},{x:0,y:1032},{x:1872,y:1032}]){
    const h=await launch({preferences:{position}}),[orb]=h.windows,event={sender:orb.webContents,senderFrame:orb.webContents.mainFrame};
    let cursor;h.screen.getCursorScreenPoint=()=>cursor;
    for(let count=0;count<20;count++){
      await h.action('orbExpand',{expanded:true},event);
      const press={x:orb.bounds.x,y:orb.bounds.y};
      cursor={x:press.x+28,y:press.y+28};await h.action('dragStart',undefined,event);
      cursor={x:cursor.x+(position.x?28:-28),y:cursor.y+(position.y?28:-28)};
      assert.deepEqual(await h.action('dragMove',undefined,event),{ok:true,moved:true});
      assert.deepEqual({x:orb.bounds.x,y:orb.bounds.y},press);
      assert.deepEqual(await h.action('dragEnd',{cancelled:false},event),{ok:true,moved:true,expanded:true},'outward drag must not also click');
      await h.action('orbExpand',{expanded:false},event);
      assert.deepEqual({x:orb.bounds.x+4,y:orb.bounds.y+4},position);
      assert.equal([...h.timers.values()].some(timer=>timer.delay===250),false,'clamped drag must not save a fake position');
    }
    assert.deepEqual(h.saved().position,position);
  }
});

test('dragging away from a corner and returning to its press position preserves the original unclamped anchor',async()=>{
  for(const position of [{x:0,y:0},{x:1872,y:0},{x:0,y:1032},{x:1872,y:1032}]){
    const h=await launch({preferences:{position}}),[orb]=h.windows,event={sender:orb.webContents,senderFrame:orb.webContents.mainFrame};
    let cursor;h.screen.getCursorScreenPoint=()=>cursor;
    for(let count=0;count<20;count++){
      await h.action('orbExpand',{expanded:true},event);
      const press={x:orb.bounds.x,y:orb.bounds.y},start={x:press.x+28,y:press.y+28};
      cursor=start;await h.action('dragStart',undefined,event);
      const delta={x:position.x?-80:80,y:position.y?-80:80};
      cursor={x:start.x+delta.x,y:start.y+delta.y};
      assert.deepEqual(await h.action('dragMove',undefined,event),{ok:true,moved:true});
      assert.deepEqual({x:orb.bounds.x,y:orb.bounds.y},{x:press.x+delta.x,y:press.y+delta.y});
      cursor=start;
      assert.deepEqual(await h.action('dragEnd',{cancelled:false},event),{ok:true,moved:true,expanded:true},'returning drag must not also click');
      await h.action('orbExpand',{expanded:false},event);
      assert.deepEqual({x:orb.bounds.x+4,y:orb.bounds.y+4},position);
      assert.equal([...h.timers.values()].some(timer=>timer.delay===250),false,'return to start must not save a shifted anchor');
    }
    assert.deepEqual(h.saved().position,position);
  }
});

test('only native DIP travel beyond the threshold starts a drag, and duplicate starts cannot rebase it',async()=>{
  const h=await launch({preferences:{position:{x:-600,y:-300}},workArea:{x:-1920,y:-500,width:1920,height:1080}}),[orb]=h.windows,event={sender:orb.webContents,senderFrame:orb.webContents.mainFrame};
  let cursor={x:-580,y:-280};h.screen.getCursorScreenPoint=()=>cursor;
  h.screen.getDisplayNearestPoint=()=>({workArea:{x:-1920,y:-500,width:1920,height:1080}});
  h.screen.getDisplayMatching=h.screen.getDisplayNearestPoint;
  h.screen.emit('display-metrics-changed');
  const initial={x:orb.bounds.x,y:orb.bounds.y};
  await h.action('dragStart',undefined,event);
  cursor={x:-577,y:-277};
  assert.deepEqual(await h.action('dragMove',undefined,event),{ok:true,moved:true});
  assert.deepEqual({x:orb.bounds.x,y:orb.bounds.y},{x:initial.x+3,y:initial.y+3});
  assert.deepEqual(await h.action('dragStart',undefined,event),{ok:false});
  cursor={x:-570,y:-265};
  assert.deepEqual(await h.action('dragEnd',{cancelled:false},event),{ok:true,moved:true,expanded:false});
  assert.deepEqual({x:orb.bounds.x,y:orb.bounds.y},{x:initial.x+10,y:initial.y+15});
  assert.deepEqual(await h.action('dragEnd',{cancelled:false},event),{ok:false},'one end per gesture');
});

test('drag gestures reject foreign frames and malformed cancellation without consuming the live gesture',async()=>{
  const h=await launch(),[orb]=h.windows,event={sender:orb.webContents,senderFrame:orb.webContents.mainFrame};
  const initial={x:orb.bounds.x,y:orb.bounds.y};
  for(const source of [h.event,{sender:orb.webContents,senderFrame:{url:orb.webContents.mainFrame.url}}]){
    for(const name of ['dragStart','dragMove','dragEnd'])assert.equal((await h.action(name,undefined,source)).ok,false);
  }
  await h.action('dragStart',undefined,event);
  for(const payload of [null,[],true,{},Object.create({cancelled:false}),{cancelled:0},{cancelled:'false'},{cancelled:false,x:900}]){
    assert.equal((await h.action('dragEnd',payload,event)).ok,false);
    assert.deepEqual({x:orb.bounds.x,y:orb.bounds.y},initial);
  }
  assert.deepEqual(await h.action('dragEnd',{cancelled:false},event),{ok:true,moved:false,expanded:false});
});

test('release samples missing pointermove but cancellation never follows a later outside cursor',async()=>{
  for(const cancelled of [false,true]){
    const h=await launch(),[orb]=h.windows,event={sender:orb.webContents,senderFrame:orb.webContents.mainFrame};
    h.screen.getCursorScreenPoint=()=>({x:500,y:500});
    const initial={x:orb.bounds.x,y:orb.bounds.y};
    await h.action('dragStart',undefined,event);
    h.screen.getCursorScreenPoint=()=>({x:475,y:460});
    assert.deepEqual(await h.action('dragEnd',{cancelled},event),{ok:true,moved:!cancelled,expanded:false});
    assert.deepEqual({x:orb.bounds.x,y:orb.bounds.y},cancelled?initial:{x:initial.x-25,y:initial.y-40});
  }
});

test('orb material failure leaves its host transparent without overwriting the working panel',async()=>{
  const h=await launch({orbBackdropFails:true});
  assert.equal(h.state().appearance.nativeBackdrop,true);
  assert.equal(h.state().appearance.orbNativeBackdrop,false);
  assert.equal(h.state().appearance.orbNativeHost,false);
  assert.equal(h.state().appearance.orbBackdropStatus,'unavailable');
  assert.equal(h.windows[0].options.transparent,true);
  assert.equal(h.windows[0].backgroundColor,'#00000000');
  await h.action('setSettings',{opacity:.55});
  assert.equal(h.windows[0].opacities.at(-1),.55);
});

test('alpha orb startup requires no GPU query, GPU readiness event or startup delay',async()=>{
  const h=await launch(),[orb,panel]=h.windows;
  assert.equal(orb.options.transparent,true);
  assert.equal(orb.material,'none');
  assert.equal(orb.backgroundColor,'#00000000');
  assert.equal(orb.shapes.length,1);
  assert.deepEqual(orb.opacities,[1]);
  assert.equal(h.state().appearance.orbNativeHost,false);
  assert.equal(h.state().appearance.orbNativeBackdrop,false);
  assert.equal(panel.options.transparent,false);
  assert.equal(panel.material,'acrylic');
  assert.equal(h.app.listenerCount('gpu-info-update'),0);
  assert.equal([...h.timers.values()].some(timer=>timer.delay===1200),false);
});

test('accessibility at startup chooses an alpha host with an opaque circular surface and keeps the user opacity preference',async()=>{
  for(const theme of [{prefersReducedTransparency:true},{shouldUseHighContrastColors:true},{inForcedColorsMode:true}]){
    const h=await launch({theme,preferences:{settings:{opacity:.65}}}),[orb]=h.windows;
    assert.equal(orb.options.transparent,true);
    assert.equal(orb.material,'none');
    assert.equal(orb.backgroundColor,'#00000000');
    assert.deepEqual(orb.opacities,[1]);
    assert.equal(h.state().appearance.orbNativeHost,false);
    assert.equal(h.state().appearance.orbBackdropStatus,'reduced-transparency');
    assert.equal(h.state().settings.opacity,.65);
    Object.assign(h.nativeTheme,{prefersReducedTransparency:false,shouldUseHighContrastColors:false,inForcedColorsMode:false});
    h.nativeTheme.emit('updated');
    assert.equal(orb.material,'none','a startup fallback never requests acrylic on its transparent host');
    assert.equal(orb.opacities.at(-1),.65);
    assert.equal(h.state().appearance.orbNativeHost,false);
    h.nativeTheme.shouldUseHighContrastColors=true;h.nativeTheme.emit('updated');
    await h.action('setSettings',{opacity:.55});
    assert.equal(orb.opacities.at(-1),1,'whole-window opacity must not fade high-contrast text');
  }
});

test('panel resize accepts only bounded integer heights from the exact panel main frame',async()=>{
  const h=await launch(),[orb,panel]=h.windows;
  panel.setBounds({x:200,y:180,width:340,height:240});
  const before=clone(panel.getBounds());
  for(const payload of [undefined,null,{},[],{height:'400'},{height:239},{height:661},{height:400.5},
    {height:NaN},{height:Infinity},{height:400,width:900},{height:400,x:0},Object.assign(Object.create({height:400}),{unexpected:true})]){
    assert.equal((await h.action('panelResize',payload)).ok,false);
    assert.deepEqual(clone(panel.getBounds()),before);
  }
  const orbEvent={sender:orb.webContents,senderFrame:orb.webContents.mainFrame};
  const otherFrame={sender:panel.webContents,senderFrame:{url:panel.webContents.mainFrame.url}};
  for(const event of [orbEvent,otherFrame,{}]){
    assert.equal((await h.action('panelResize',{height:600},event)).ok,false);
    assert.deepEqual(clone(panel.getBounds()),before);
  }
  for(const height of [240,280,600,660]){
    assert.equal((await h.action('panelResize',{height})).ok,true);
    assert.equal(panel.getBounds().height,height);
    assert.equal(panel.getBounds().width,340);
    assert.equal(panel.getBounds().x,200);
    assert.equal(panel.getBounds().y,180);
  }
  const changes=panel.boundUpdates;
  await h.action('panelResize',{height:660});
  assert.equal(panel.boundUpdates,changes,'same requested bounds must not resize again');
});

test('content resizing stays on the panel display and clamps within its work area without anchoring to the orb',async()=>{
  const h=await launch(),[orb,panel]=h.windows;
  orb.setBounds({x:500,y:200,width:92,height:104});
  panel.setBounds({x:2920,y:850,width:340,height:240});
  h.screen.getDisplayMatching=b=>({workArea:b.x>=1920?{x:1920,y:0,width:1280,height:1024}:{x:0,y:0,width:1920,height:1080}});
  await h.action('panelResize',{height:600});
  assert.deepEqual({x:panel.bounds.x,y:panel.bounds.y,width:panel.bounds.width,height:panel.bounds.height},{x:2860,y:424,width:340,height:600});
  panel.setBounds({x:-1150,y:-50});
  h.screen.getDisplayMatching=()=>({workArea:{x:-1280,y:-200,width:1280,height:720}});
  await h.action('panelResize',{height:660});
  assert.deepEqual({x:panel.bounds.x,y:panel.bounds.y,width:panel.bounds.width,height:panel.bounds.height},{x:-1150,y:-140,width:340,height:660});
});

test('anchoring restores the desired content height after a small display temporarily limits it',async()=>{
  const h=await launch({preferences:{position:{x:704,y:404}}}),[orb,panel]=h.windows;
  h.screen.getDisplayMatching=()=>({workArea:{x:0,y:0,width:1280,height:300}});
  await h.action('panelResize',{height:660});
  assert.equal(panel.bounds.height,300);
  assert.equal(panel.bounds.y,0);
  h.screen.getDisplayMatching=()=>({workArea:{x:0,y:0,width:1920,height:1080}});
  await h.action('togglePanel');
  assert.equal(panel.bounds.height,660);
  assert.equal(panel.bounds.width,340);
  assert.equal(panel.bounds.x,350);
  assert.equal(panel.bounds.y,340);
});

test('unsupported Windows and compositor failures retain a usable panel and native quota controller',async()=>{
  const legacy=await launch({release:'10.0.19045'});
  assert.equal(legacy.windows[1].options.transparent,true);
  assert.equal(legacy.windows[1].material,undefined);
  assert.equal(legacy.windows[0].options.transparent,true);
  assert.equal(legacy.windows[0].material,undefined);
  assert.deepEqual(legacy.windows[0].opacities,[1]);
  assert.equal(legacy.state().appearance.orbNativeHost,false);
  await legacy.action('setSettings',{opacity:.75});
  assert.deepEqual(legacy.windows[0].opacities,[1,.75]);
  assert.equal(legacy.state().appearance.nativeBackdrop,false);
  const failed=await launch({backdropFails:true});
  assert.equal(failed.windows[1].material,'none');
  assert.equal(failed.windows[1].backgroundColor,'#171b22');
  assert.equal(failed.state().appearance.nativeBackdrop,false);
  assert.equal((await failed.action('enableCodex')).ok,true);
  assert.deepEqual(failed.provider.starts,[5]);
});

function reading(source='codex-cli', usedPercent=30) {
  return {version:1,source,capturedAt:Date.now(),windows:[{kind:'weekly',usedPercent,
    resetAt:Date.now()+86400000,resetApproximate:false}],tokens:{today:null,total:null}};
}

test('legacy display preferences migrate to disabled native mode without discovering or starting a CLI',async()=>{
  const h=await launch({preferences:{settings:{alwaysOnTop:false,opacity:0.8,notifications:false}}});
  assert.equal(h.state().usageSource,'codex-cli');
  assert.equal(h.state().settings.codexEnabled,false);
  assert.equal(h.state().settings.refreshMinutes,5);
  assert.equal(h.state().settings.alwaysOnTop,false);
  assert.equal(h.state().settings.opacity,0.8);
  assert.deepEqual(h.provider.starts,[]);
  assert.equal(h.calls.discover,0);
  assert.equal((await h.action('refreshCodex')).ok,false);
  assert.equal(h.provider.refreshes,0);
  h.bridge.emitSnapshot(reading('official-page'));
  assert.equal(h.state().snapshot,null);
});

test('explicit enable starts the native provider and persists consent; manual refresh is gated by consent',async()=>{
  const h=await launch();
  await h.action('setSettings',{refreshMinutes:12});
  assert.deepEqual(h.provider.starts,[]);
  assert.equal((await h.action('enableCodex')).ok,true);
  assert.deepEqual(h.provider.starts,[12]);
  assert.equal(h.saved().settings.codexEnabled,true);
  assert.equal(h.saved().settings.refreshMinutes,12);
  await h.action('refreshCodex');
  assert.equal(h.provider.refreshes,1);
  assert.equal(h.state().staleAfterMs,12*60000+90000);
});

test('startup restores only previously enabled native mode, not a disabled or browser source',async()=>{
  const enabled=await launch({preferences:{settings:{usageSource:'codex-cli',codexEnabled:true,refreshMinutes:7}}});
  assert.deepEqual(enabled.provider.starts,[7]);
  const disabled=await launch({preferences:{settings:{usageSource:'codex-cli',codexEnabled:false}}});
  assert.deepEqual(disabled.provider.starts,[]);
  const browser=await launch({preferences:{settings:{usageSource:'browser',codexEnabled:true}}});
  assert.deepEqual(browser.provider.starts,[]);
  assert.equal((await browser.action('enableCodex')).ok,false);
});

test('source switching clears account data, revokes browser pairing, and rejects late snapshots from the other source',async()=>{
  const h=await launch();
  await h.action('enableCodex');
  const nativeReading=reading('codex-cli',45);
  h.provider.emitSnapshot(nativeReading);
  h.bridge.emitSnapshot(reading('official-page',90));
  assert.deepEqual(h.state().snapshot,nativeReading);
  const stops=h.provider.stops;
  await h.action('setSettings',{usageSource:'browser'});
  assert.ok(h.provider.stops>stops);
  assert.equal(h.state().snapshot,null);
  assert.equal(h.state().settings.codexEnabled,false);
  assert.equal(h.bridge.rotations,1);
  h.provider.emitSnapshot(nativeReading);
  assert.equal(h.state().snapshot,null);
  const browserReading=reading('official-page',20);
  h.bridge.emitSnapshot(browserReading);
  assert.deepEqual(h.state().snapshot,browserReading);
  h.provider.clear();
  assert.deepEqual(h.state().snapshot,browserReading,'native account-clear cannot remove browser data');
  await h.action('setSettings',{usageSource:'codex-cli',codexEnabled:true});
  assert.equal(h.state().snapshot,null);
  assert.equal(h.state().settings.codexEnabled,false,'changing source is not implicit consent to start');
  assert.equal(h.bridge.rotations,2);
  h.bridge.emitSnapshot(browserReading);
  h.provider.emitSnapshot(nativeReading);
  assert.equal(h.state().snapshot,null);
  assert.deepEqual(h.provider.starts,[5]);
  for(const {value} of h.windows[1].sent){
    if(!value.snapshot)continue;
    assert.equal(value.snapshot.source==='codex-cli',value.usageSource==='codex-cli',
      'all published states, including synchronous stop callbacks, must match the selected source');
  }
});

test('disabling native reads keeps the last valid reading but blocks refresh and late results',async()=>{
  const h=await launch();
  await h.action('enableCodex');
  const previous=reading();h.provider.emitSnapshot(previous);
  await h.action('disableCodex');
  assert.equal(h.state().settings.codexEnabled,false);
  assert.equal(h.state().codex.enabled,false);
  assert.equal(h.saved().settings.codexEnabled,false);
  assert.deepEqual(h.state().snapshot,previous);
  h.provider.emitSnapshot(reading('codex-cli',99));
  assert.deepEqual(h.state().snapshot,previous);
  assert.equal((await h.action('refreshCodex')).ok,false);
  assert.equal(h.provider.refreshes,0);
});

test('main IPC rejects foreign frames, navigated windows and arbitrary commands before invoking native work',async()=>{
  const h=await launch();
  const originalUrl=h.event.senderFrame.url;
  const foreignFrame={sender:h.event.sender,senderFrame:{url:originalUrl}};
  const foreignSender={sender:{mainFrame:h.event.senderFrame,isDestroyed:()=>false},senderFrame:h.event.senderFrame};
  for(const event of [{},foreignFrame,foreignSender]){
    assert.equal((await h.action('enableCodex',undefined,event)).ok,false);
    assert.equal(h.handlers.get('orb:state')(event),null);
  }
  h.event.senderFrame.url='https://chatgpt.com/';
  assert.equal((await h.action('enableCodex')).ok,false);
  h.event.senderFrame.url=originalUrl;
  for(const action of ['spawn','rpc','account/read','turn/start'])assert.equal((await h.action(action,{method:'turn/start',command:'evil'})).ok,false);
  assert.deepEqual(h.provider.starts,[]);
  assert.equal(h.provider.refreshes,0);
  assert.equal(h.calls.discover,0);
});

test('setup action copies a fixed reviewed command without executing, discovering or opening a caller-supplied target',async()=>{
  const h=await launch();
  await h.action('copyCodexSetup',{command:'evil.exe',url:'https://untrusted.invalid',args:['turn/start']});
  assert.deepEqual(h.calls.clipboard,['npm.cmd install -g @openai/codex\r\nif ($LASTEXITCODE -eq 0) { codex.cmd login }']);
  assert.deepEqual(h.provider.starts,[]);
  assert.equal(h.calls.discover,0);
  assert.deepEqual(h.calls.external,[]);
  assert.deepEqual(h.calls.openPath,[]);
  await h.action('openCodexHelp',{url:'https://untrusted.invalid'});
  assert.deepEqual(h.calls.external,['https://developers.openai.com/codex/cli']);
});

test('a busy browser bridge port does not suppress native mode or its successfully retrieved reading',async()=>{
  const h=await launch({bridgeFails:true});
  assert.equal(h.state().bridge.listening,false);
  assert.equal(h.state().error,null);
  await h.action('enableCodex');
  h.provider.emitSnapshot(reading());
  assert.equal(h.state().status,'ready');
  assert.equal(h.state().error,null);
  assert.equal((await h.action('copyPairingCode')).ok,false);
  await h.action('setSettings',{usageSource:'browser'});
  assert.equal(h.state().status,'error');
  assert.match(h.state().error,/43861/);
});

test('native errors retain the last reading, while an explicit account-clear removes it',async()=>{
  const h=await launch();
  await h.action('enableCodex');
  const previous=reading();h.provider.emitSnapshot(previous);
  h.provider.emitStatus({state:'needs-login',message:'Log in to the official CLI'});
  assert.equal(h.state().status,'error');
  assert.equal(h.state().error,'登录已失效，请重新连接。');
  assert.equal(h.state().codexSetup.status,'error');
  assert.deepEqual(h.state().snapshot,previous);
  h.provider.clear();
  assert.equal(h.state().snapshot,null);
});

test('validated interval changes reschedule native mode; invalid values and arbitrary command settings are ignored',async()=>{
  const h=await launch();
  await h.action('enableCodex');
  for(const minutes of [1,1440]){
    await h.action('setSettings',{refreshMinutes:minutes});
    assert.equal(h.provider.starts.at(-1),minutes);
    assert.equal(h.state().settings.refreshMinutes,minutes);
  }
  const starts=h.provider.starts.length;
  for(const refreshMinutes of [0,1441,1.5,'5',null,Infinity])await h.action('setSettings',{refreshMinutes});
  await h.action('setSettings',{executable:'evil.exe',args:['turn/start'],accessToken:'secret',usageSource:'untrusted'});
  assert.equal(h.provider.starts.length,starts);
  assert.equal(h.state().settings.refreshMinutes,1440);
  for(const field of ['executable','args','accessToken'])assert.equal(Object.hasOwn(h.saved().settings,field),false);
});

test('quitting stops the native provider, closes the bridge and cancels timers; late native results are discarded',async()=>{
  const h=await launch();
  await h.action('enableCodex');
  h.provider.emitSnapshot(reading());
  const stops=h.provider.stops;
  await h.quit();
  assert.equal(h.provider.stops,stops+1);
  assert.equal(h.bridge.closed,1);
  assert.equal(h.timers.size,0);
  assert.equal(h.state().snapshot,null);
  h.provider.emitSnapshot(reading('codex-cli',99));
  assert.equal(h.state().snapshot,null);
});

test('first launch has an explicit managed connection with no download, discovery, login or read',async()=>{
  const h=await launch();
  assert.equal(h.state().settings.codexConnection,'managed');
  assert.equal(h.state().codexSetup.status,'idle');
  assert.equal(h.calls.componentDownloads,0);assert.equal(h.calls.componentChecks,0);
  assert.equal(h.calls.managedLogins.length,0);assert.equal(h.calls.discover,0);
  assert.deepEqual(h.provider.starts,[]);
});

test('managed connect is panel-only and accepts no renderer supplied login arguments',async()=>{
  const h=await launch(),orb=h.windows[0].webContents,orbEvent={sender:orb,senderFrame:orb.mainFrame};
  for(const name of ['connectCodex','cancelCodexConnect','logoutCodex']){
    assert.equal((await h.action(name,undefined,orbEvent)).ok,false);
    assert.equal((await h.action(name,{url:'https://untrusted.invalid',codexHome:'/wrong'})).ok,false);
  }
  assert.equal(h.calls.componentDownloads,0);
  assert.equal((await h.action('connectCodex')).ok,true);
  assert.equal(h.calls.componentDownloads,1);assert.equal(h.calls.managedLogins.length,1);
  assert.equal(h.calls.managedLogins[0].codexHome,path.join('/virtual-orb/user-data','codex-managed-home'));
  assert.equal(h.state().settings.codexEnabled,true);assert.equal(h.state().codexSetup.hasLogin,true);
  assert.equal(h.state().codexSetup.status,'connected');assert.deepEqual(h.provider.starts,[5]);
  assert.equal(h.saved().settings.codexManagedConnected,true);
  const target=await h.provider.options.discover();
  assert.equal(target.path,'/virtual-orb/managed/codex.exe');assert.equal(target.codexHome,path.join('/virtual-orb/user-data','codex-managed-home'));
  assert.equal(h.calls.discover,0);
  assert.equal((await h.action('logoutCodex')).ok,true);
  assert.equal(h.calls.managedLogouts.length,1);assert.equal(h.state().codexSetup.hasLogin,false);
  assert.equal(h.state().settings.codexEnabled,false);assert.equal(h.state().snapshot,null);
});

test('old local CLI users, including paused ones, migrate without replacing their account or installing components',async()=>{
  for(const enabled of [false,true]){
    const h=await launch({preferences:{settings:{usageSource:'codex-cli',codexEnabled:enabled}}});
    assert.equal(h.state().settings.codexConnection,'existing');
    assert.equal(h.calls.componentDownloads,0);assert.equal(h.calls.managedLogins.length,0);
    assert.equal((await h.action('connectCodex')).ok,false);
    assert.deepEqual(h.provider.starts,enabled?[5]:[]);
  }
});

test('managed login metadata restores paused logout controls without opening a browser or changing auth',async()=>{
  const h=await launch({preferences:{settings:{usageSource:'codex-cli',codexConnection:'managed',codexEnabled:false,codexManagedConnected:true}}});
  assert.equal(h.state().codexSetup.hasLogin,true);assert.equal(h.state().codexSetup.status,'connected');
  assert.deepEqual(h.provider.starts,[]);assert.equal(h.calls.componentDownloads,0);assert.equal(h.calls.managedLogins.length,0);
  await h.action('setSettings',{codexManagedConnected:false});
  assert.equal(h.state().codexSetup.hasLogin,true,'renderer cannot fabricate or erase authentication metadata');
});

test('managed component damage and expired auth offer repair while keeping logout available',async()=>{
  const h=await launch({preferences:{settings:{usageSource:'codex-cli',codexConnection:'managed',codexEnabled:true,codexManagedConnected:true}}});
  for(const state of ['not-found','needs-login','unsupported']){
    h.provider.emitStatus({state,message:'Old manual CLI instructions'});
    assert.equal(h.state().codexSetup.status,'error');assert.equal(h.state().codexSetup.hasLogin,true);
    assert.match(h.state().codexSetup.message,/重新连接/);
    assert.doesNotMatch(h.state().codexSetup.message,/Old manual/);
  }
  assert.equal(h.calls.componentDownloads,0,'repair requires an explicit click');
});

test('pending login blocks mode changes and refresh; cancellation cannot re-enable a late login',async()=>{
  let finish;
  const h=await launch({managedLogin:()=>new Promise(resolve=>{finish=resolve;})});
  const connecting=h.action('connectCodex');await settle();
  assert.equal((await h.action('setSettings',{codexConnection:'existing'})).ok,false);
  assert.equal((await h.action('setSettings',{usageSource:'browser'})).ok,false);
  assert.equal((await h.action('enableCodex')).ok,false);
  assert.equal((await h.action('refreshCodex')).ok,false);
  const cancelled=h.action('cancelCodexConnect');await settle();
  finish({connected:true});await connecting;await cancelled;
  assert.equal(h.state().settings.codexEnabled,false);assert.equal(h.state().codexSetup.status,'idle');
  assert.equal(h.state().snapshot,null);assert.deepEqual(h.provider.starts,[]);
});

test('managed auth waits for a prior quota child and does not start after a failed drain',async()=>{
  let release;
  const h=await launch({managedStop:()=>new Promise(resolve=>{release=resolve;})});
  const connect=h.action('connectCodex');await settle();
  assert.equal(h.calls.componentDownloads,0);assert.equal(h.calls.managedLogins.length,0);
  release();assert.equal((await connect).ok,true);assert.equal(h.calls.managedLogins.length,1);
  const blocked=await launch({managedStop:async()=>{throw Object.assign(new Error('private child details'),{code:'login-busy'});}});
  assert.equal((await blocked.action('connectCodex')).ok,false);
  assert.equal(blocked.calls.componentDownloads,0);assert.equal(blocked.calls.managedLogins.length,0);
  assert.doesNotMatch(JSON.stringify(blocked.state()),/private child details/);
});

test('Mac shell has native panel vibrancy, alpha orb, menu bar controls and no passive authentication',async()=>{
  const h=await launch({platform:'darwin',arch:'arm64',release:'24.0.0'});
  assert.equal(h.state().platform,'darwin');assert.equal(h.calls.templateImage,true);assert.equal(h.calls.dockHides,1);
  assert.equal(h.calls.tray.menu,undefined,'static menus must not consume left clicks');
  h.calls.tray.emit('click');assert.equal(h.windows[1].visible,true);
  h.calls.tray.emit('click');assert.equal(h.windows[1].visible,false);
  h.calls.tray.emit('right-click');assert.equal(h.calls.trayPopups,1);
  h.app.emit('activate');assert.equal(h.windows[1].visible,true);
  assert.equal(h.windows[1].vibrancy,'under-window');assert.equal(h.windows[1].options.visualEffectState,'active');
  assert.equal(h.windows[0].vibrancy,undefined);assert.equal(h.windows[0].options.transparent,true);
  assert.equal(h.windows[0].shapes,undefined);assert.equal(h.windows[0].workspaces.value,true);
  assert.equal(h.state().appearance.nativeBackdrop,true);
  assert.deepEqual(h.calls.shortcuts,['CommandOrControl+Alt+G']);
  assert.equal(h.calls.componentDownloads,0);assert.deepEqual(h.calls.managedLogins,[]);
  await h.action('copyCodexSetup');assert.match(h.calls.clipboard[0],/npm install -g @openai\/codex/);
  assert.doesNotMatch(h.calls.clipboard[0],/npm\.cmd|codex\.cmd|LASTEXITCODE/);
});

test('packaged Mac uses architecture-specific manual updates and native login-item registration',async()=>{
  for(const arch of ['arm64','x64']){
    const h=await launch({platform:'darwin',arch,isPackaged:true});
    assert.equal(h.calls.updaters.length,1);assert.equal(h.calls.updaters[0].options.arch,arch);
    assert.equal(h.state().updates.installMode,'manual');assert.equal(h.calls.updaters[0].checked,0);
    assert.equal((await h.action('checkUpdates')).ok,true);assert.equal(h.calls.updaters[0].checked,1);
    assert.equal((await h.action('installUpdate')).ok,true);assert.equal(h.calls.updaters[0].installed,1);
    assert.equal((await h.action('setSettings',{autoStart:true})).ok,true);
    assert.deepEqual(clone(h.calls.login.at(-1)),{openAtLogin:true,type:'mainAppService'});
    assert.equal(h.state().settings.autoStart,true);
    await h.quit();assert.equal(h.calls.updaters[0].stopped,true);
  }
});

test('Mac respects OS-disabled startup and login-launched app does not open the panel',async()=>{
  const h=await launch({platform:'darwin',isPackaged:true,preferences:{settings:{autoStart:true}},loginStatus:{openAtLogin:false,wasOpenedAtLogin:true,status:'not-registered'}});
  assert.equal(h.state().settings.autoStart,false);assert.deepEqual(h.calls.login,[]);
  h.windows[1].emit('ready-to-show');assert.equal(h.windows[1].visible,false);
  assert.equal((await h.action('setSettings',{autoStart:true})).ok,false);assert.equal(h.state().settings.autoStart,false);
  const development=await launch({platform:'darwin'});
  assert.equal((await development.action('setSettings',{autoStart:true})).ok,false);
  assert.deepEqual(development.calls.login,[]);
});
