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
async function launch({preferences, bridgeFails = false, release = '10.0.22631', theme = {}, backdropFails = false} = {}) {
  const handlers = new Map(), windows = [], providers = [], bridges = [], files = new Map();
  const calls = {discover:0, quit:0, external:[], openPath:[], clipboard:[], errors:[], login:[], notifications:[]};
  const userData = '/virtual-orb/user-data';
  const preferencesPath = path.join(userData, 'preferences.json');
  if (preferences) files.set(preferencesPath, JSON.stringify(preferences));
  const timers = new Map();
  let nextTimer = 1;
  const addTimer = (callback, delay) => { const id = nextTimer++; timers.set(id, {callback, delay}); return id; };
  const app = new EventEmitter();
  const nativeTheme=Object.assign(new EventEmitter(),{prefersReducedTransparency:false,shouldUseHighContrastColors:false},theme);
  Object.assign(app, {
    isPackaged:false,
    setName(){}, setAppUserModelId(){}, requestSingleInstanceLock:()=>true,
    whenReady:()=>Promise.resolve(), getVersion:()=> '2.3.0',
    getPath:name => { assert.equal(name, 'userData'); return userData; },
    getAppPath:()=>path.resolve(__dirname, '..'),
    setLoginItemSettings:value => calls.login.push(value),
    getLoginItemSettings:()=>({openAtLogin:calls.login.at(-1)?.openAtLogin || false}),
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
    setAlwaysOnTop(){} setOpacity(){} focus(){}
    setBackgroundMaterial(value){if(backdropFails&&value==='acrylic')throw new Error('unavailable compositor');this.material=value;}
    setBackgroundColor(value){this.backgroundColor=value;}
    showInactive(){this.visible=true;} show(){this.visible=true;} hide(){this.visible=false;}
    isVisible(){return this.visible;}
    getBounds(){return this.bounds;} setBounds(bounds){this.bounds={...this.bounds,...bounds};}
    setPosition(x,y){Object.assign(this.bounds,{x,y});}
  }
  class Tray extends EventEmitter {
    setToolTip(value){this.tooltip=value;} setContextMenu(value){this.menu=value;}
    isDestroyed(){return false;} destroy(){} displayBalloon(value){calls.notifications.push(value);}
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
    ipcMain:{handle:(channel, handler)=>handlers.set(channel,handler)},
    screen:Object.assign(new EventEmitter(),{
      getPrimaryDisplay:()=>({workArea:{x:0,y:0,width:1920,height:1080}}),
      getDisplayNearestPoint:()=>({workArea:{x:0,y:0,width:1920,height:1080}}),
      getDisplayMatching:()=>({workArea:{x:0,y:0,width:1920,height:1080}}),getCursorScreenPoint:()=>({x:0,y:0})
    }),
    Menu:{setApplicationMenu(){},buildFromTemplate:items=>({items,popup(){}})},
    nativeImage:{createFromPath:()=>({resize:()=>({})})},
    shell:{openExternal:async url=>{calls.external.push(url);},openPath:async value=>{calls.openPath.push(value);return '';}},
    Notification:{isSupported:()=>false},
    globalShortcut:{register(){},unregisterAll(){}},
    dialog:{showErrorBox:(...args)=>calls.errors.push(args)},
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
    './codex-provider.cjs':{CodexProvider:Provider},
    './window-material.cjs':require('../src/window-material.cjs'),
    './codex-discovery.cjs':{discoverCodex:()=>{calls.discover += 1;throw new Error('discovery must not execute in controller tests');}}
  };
  vm.runInNewContext(mainSource, {
    require:name=>{assert.ok(Object.hasOwn(modules,name),`Unexpected dependency: ${name}`);return modules[name];},
    __dirname:path.dirname(mainFile),
    process:{platform:'win32',argv:[],env:{},execPath:'/virtual-orb/orb.exe',resourcesPath:'/virtual-orb/resources'},
    setTimeout:addTimer,setInterval:addTimer,clearTimeout:id=>timers.delete(id),clearInterval:id=>timers.delete(id)
  },{filename:mainFile});
  await settle();
  assert.deepEqual(calls.errors,[],'controller initialization must succeed');
  assert.equal(providers.length,1); assert.equal(bridges.length,1);
  const sender=windows[1].webContents;
  const event={sender,senderFrame:sender.mainFrame};
  const state=()=>clone(handlers.get('orb:state')(event));
  const action=async(name,payload,source=event)=>clone(await handlers.get('orb:action')(source,name,payload));
  return {app,windows,nativeTheme,provider:providers[0],bridge:bridges[0],calls,state,action,event,handlers,timers,
    saved:()=>JSON.parse(files.get(preferencesPath)),
    async quit(){app.quit();await settle();}};
}

test('native acrylic applies only to the panel and follows accessibility changes without widening IPC',async()=>{
  const h=await launch();
  const [orb,panel]=h.windows;
  assert.equal(orb.options.transparent,true);
  assert.equal(orb.material,undefined);
  assert.equal(panel.options.transparent,false);
  assert.equal(panel.options.roundedCorners,true);
  assert.equal(panel.material,'acrylic');
  assert.equal(panel.backgroundColor,'#00000000');
  assert.deepEqual(h.state().appearance,{nativeBackdrop:true,reducedTransparency:false,highContrast:false});
  h.nativeTheme.prefersReducedTransparency=true;
  h.nativeTheme.emit('updated');
  assert.equal(panel.material,'none');
  assert.equal(h.state().appearance.reducedTransparency,true);
  assert.equal(h.state().appearance.nativeBackdrop,false);
  h.nativeTheme.prefersReducedTransparency=false;
  h.nativeTheme.shouldUseHighContrastColors=true;
  h.nativeTheme.emit('updated');
  assert.equal(panel.material,'none');
  assert.equal(h.state().appearance.highContrast,true);
  h.nativeTheme.shouldUseHighContrastColors=false;
  h.nativeTheme.emit('updated');
  assert.equal(panel.material,'acrylic');
  assert.deepEqual([...h.handlers.keys()],['orb:state','orb:action']);
});

test('unsupported Windows and compositor failures retain a usable panel and native quota controller',async()=>{
  const legacy=await launch({release:'10.0.19045'});
  assert.equal(legacy.windows[1].options.transparent,true);
  assert.equal(legacy.windows[1].material,undefined);
  assert.equal(legacy.state().appearance.nativeBackdrop,false);
  const failed=await launch({backdropFails:true});
  assert.equal(failed.windows[1].material,'none');
  assert.equal(failed.windows[1].backgroundColor,'#f1f4f8');
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
  assert.equal(h.state().error,'Log in to the official CLI');
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
