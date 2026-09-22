'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {supportsAcrylic,systemAppearance,applyPanelMaterial,applyOrbMaterial,compositingMode,observeGpuCompositing}=require('../src/window-material.cjs');

test('the system backdrop gate excludes Windows 10 and Windows 11 before 22H2',()=>{
  for(const release of ['10.0.19045','10.0.22000','10.0.22620','6.3.9600','unknown','',undefined])
    assert.equal(supportsAcrylic('win32',release),false,String(release));
  for(const release of ['10.0.22621','10.0.26100','11.0.1000'])
    assert.equal(supportsAcrylic('win32',release),true,release);
  for(const platform of ['darwin','linux'])assert.equal(supportsAcrylic(platform,'10.0.26100'),false);
});

test('unsupported platforms never invoke native window APIs, while accessibility state still reaches CSS',()=>{
  const win={isDestroyed:()=>false,setBackgroundMaterial(){assert.fail('unsupported native call');}};
  const result=applyPanelMaterial(win,{platform:'linux',release:'6.8.0',theme:{prefersReducedTransparency:true}});
  assert.deepEqual(result,{nativeBackdrop:false,reducedTransparency:true,highContrast:false,backdropStatus:'reduced-transparency'});
  assert.deepEqual(applyPanelMaterial(win,{platform:'darwin',release:'24.0.0',theme:{inForcedColorsMode:true}}),
    {nativeBackdrop:false,reducedTransparency:true,highContrast:true,backdropStatus:'reduced-transparency'});
});

const supported={platform:'win32',release:'10.0.26100',theme:{}};
function host(overrides={}){
  const calls=[];
  const win={isDestroyed:()=>false,
    setBackgroundMaterial:value=>calls.push(['material',value]),
    setBackgroundColor:value=>calls.push(['color',value]),
    setOpacity:()=>assert.fail('glass must not fade text or make a layered native host'),...overrides};
  return{win,calls};
}

test('native material only requests acrylic and uncovers the compositor without claiming visual confirmation',()=>{
  const {win,calls}=host();
  assert.deepEqual(applyPanelMaterial(win,supported),{
    nativeBackdrop:true,reducedTransparency:false,highContrast:false,backdropStatus:'requested'});
  assert.deepEqual(calls,[['material','acrylic'],['color','#00000000']]);
  assert.deepEqual(systemAppearance(),{
    nativeBackdrop:false,reducedTransparency:false,highContrast:false,backdropStatus:'unavailable'});
});

test('live accessibility changes disable acrylic and restore a readable solid host',()=>{
  const {win,calls}=host();
  applyPanelMaterial(win,supported);
  for(const theme of [{prefersReducedTransparency:true},{shouldUseHighContrastColors:true},{inForcedColorsMode:true}]){
    const appearance=applyPanelMaterial(win,{...supported,theme});
    assert.equal(appearance.nativeBackdrop,false);
    assert.equal(appearance.reducedTransparency,true);
    assert.equal(appearance.backdropStatus,'reduced-transparency');
    assert.deepEqual(calls.slice(-2),[['material','none'],['color','#171b22']]);
  }
  assert.equal(applyPanelMaterial(win,supported).backdropStatus,'requested');
  assert.deepEqual(calls.slice(-2),[['material','acrylic'],['color','#00000000']]);
});

test('unsupported Windows is distinguishable from unavailable supported material',()=>{
  const {win,calls}=host();
  assert.equal(applyPanelMaterial(win,{...supported,release:'10.0.19045'}).backdropStatus,'unsupported');
  assert.deepEqual(calls,[]);
  assert.equal(applyPanelMaterial(null,supported).backdropStatus,'unavailable');
  assert.equal(applyPanelMaterial({...win,isDestroyed:()=>true},supported).backdropStatus,'unavailable');
  assert.deepEqual(calls,[]);
});

test('material and page-color failures both withdraw the paint hint and attempt a solid fallback',()=>{
  for(const failingStep of ['material','color']){
    const calls=[];
    const {win}=host({
      setBackgroundMaterial(value){calls.push(['material',value]);if(failingStep==='material'&&value==='acrylic')throw Error('unavailable');},
      setBackgroundColor(value){calls.push(['color',value]);if(failingStep==='color'&&value==='#00000000')throw Error('unavailable');}
    });
    const result=applyPanelMaterial(win,supported);
    assert.equal(result.nativeBackdrop,false);
    assert.equal(result.backdropStatus,'unavailable');
    assert.deepEqual(calls.slice(-2),[['material','none'],['color','#171b22']]);
  }
});

test('even a destroyed native compositor cannot throw through the cosmetic fallback',()=>{
  const {win}=host({setBackgroundMaterial(){throw Error('destroyed');},setBackgroundColor(){throw Error('destroyed');}});
  assert.equal(applyPanelMaterial(win,supported).nativeBackdrop,false);
});

test('only explicit hardware compositor states are hardware; disabled and unknown features cannot opt in',()=>{
  for(const value of ['enabled','enabled_on','enabled_force','enabled_force_on','enabled_readback'])assert.equal(compositingMode(value),'hardware');
  for(const value of ['disabled_software','disabled_off','disabled_off_ok','unavailable_software','unavailable_off','unavailable_off_ok'])assert.equal(compositingMode(value),'software');
  for(const value of [undefined,null,'','enabled_future','unavailable',true,{},[]])assert.equal(compositingMode(value),'unknown');
});

function gpuHost({request=()=>new Promise(()=>{}),timeoutMs=1200}={}){
  const app=new EventEmitter(),timers=new Map();
  let feature,seen=false,reads=0,requests=0,nextTimer=0;
  app.getGPUFeatureStatus=()=>{assert.equal(seen,true,'the app ready event is not GPU readiness');reads++;return{gpu_compositing:feature};};
  app.getGPUInfo=type=>{assert.equal(type,'basic');requests++;return request(app);};
  const probe=observeGpuCompositing(app,{timeoutMs,setTimer:(fn,delay)=>{const id=++nextTimer;timers.set(id,{fn,delay});return id;},clearTimer:id=>timers.delete(id)});
  return{app,probe,timers,reads:()=>reads,requests:()=>requests,
    emit(value){feature=value;seen=true;app.emit('gpu-info-update');},
    expire(){const timer=[...timers.values()][0];assert.ok(timer);timer.fn();}};
}

test('GPU events before app readiness are retained without making an unnecessary GPU request',async()=>{
  const h=gpuHost();
  assert.equal(h.reads(),0);
  h.emit('enabled');
  assert.equal(await h.probe.wait(),'hardware');
  assert.equal(h.requests(),0);
  assert.equal(h.timers.size,0);assert.equal(h.app.listenerCount('gpu-info-update'),0);
});

test('GPU status waits for its event even when the basic-info request resolves, and stops on a known update',async()=>{
  const h=gpuHost({request:()=>Promise.resolve({gpuDevice:[{vendorId:1234}]})});
  let done=false;const result=h.probe.wait().then(mode=>{done=true;return mode;});
  await Promise.resolve();await Promise.resolve();
  assert.equal(done,false);assert.equal(h.reads(),0);
  h.emit('disabled_software');
  assert.equal(await result,'software');
  assert.equal(h.timers.size,0);assert.equal(h.app.listenerCount('gpu-info-update'),0);
});

test('early and in-flight unknown GPU updates retain the bounded opportunity for a later hardware update',async()=>{
  for(const early of [true,false]){
    const h=gpuHost({request:()=>Promise.resolve({})});
    if(early)h.emit(undefined);
    let done=false;const result=h.probe.wait().then(mode=>{done=true;return mode;});
    if(!early)h.emit('future-unrecognized-status');
    await Promise.resolve();await Promise.resolve();
    assert.equal(done,false);assert.equal(h.requests(),1);assert.equal(h.timers.size,1);
    h.emit('enabled');
    assert.equal(await result,'hardware');assert.equal(h.timers.size,0);
  }
});

test('GPU timeouts, failed requests and unavailable status reads fall back without leaking event listeners',async()=>{
  const timeout=gpuHost({timeoutMs:99999});
  const pending=timeout.probe.wait();
  assert.equal([...timeout.timers.values()][0].delay,1500,'startup can never wait longer than 1.5 seconds');
  timeout.expire();assert.equal(await pending,'unknown');
  assert.equal(timeout.app.listenerCount('gpu-info-update'),0);
  for(const request of [()=>{throw Error('unavailable');},()=>Promise.reject(Error('unavailable'))]){
    const h=gpuHost({request});
    assert.equal(await h.probe.wait(),'unknown');assert.equal(h.timers.size,0);
    assert.equal(h.app.listenerCount('gpu-info-update'),0);
  }
  const missing=gpuHost();missing.app.getGPUFeatureStatus=()=>{throw Error('not ready');};
  const wait=missing.probe.wait();missing.emit('enabled');missing.expire();
  assert.equal(await wait,'unknown');
  const stopped=gpuHost();const stoppedWait=stopped.probe.wait();stopped.probe.stop();
  assert.equal(await stoppedWait,'unknown');assert.equal(stopped.timers.size,0);
});

test('orb material reflects the actual host choice and explicitly clears native backgrounds on an alpha host',()=>{
  const {win,calls}=host();
  assert.deepEqual(applyOrbMaterial(win,{...supported,nativeHost:false}),{
    orbNativeHost:false,orbNativeBackdrop:false,orbBackdropStatus:'unavailable'});
  assert.deepEqual(calls,[['material','none'],['color','#00000000']]);
  assert.deepEqual(applyOrbMaterial(win,{...supported,nativeHost:false,theme:{shouldUseHighContrastColors:true}}),{
    orbNativeHost:false,orbNativeBackdrop:false,orbBackdropStatus:'reduced-transparency'});
  assert.deepEqual(calls.slice(-2),[['material','none'],['color','#00000000']]);
  assert.deepEqual(applyOrbMaterial(win,{...supported,nativeHost:true}),{
    orbNativeHost:true,orbNativeBackdrop:true,orbBackdropStatus:'requested'});
  assert.deepEqual(calls.slice(-2),[['material','acrylic'],['color','#00000000']]);
});
