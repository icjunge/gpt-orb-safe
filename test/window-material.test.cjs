'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {supportsAcrylic,systemAppearance,applyPanelMaterial,applyOrbMaterial}=require('../src/window-material.cjs');

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
  assert.deepEqual(applyPanelMaterial(win,{platform:'linux',release:'6.8.0',theme:{inForcedColorsMode:true}}),
    {nativeBackdrop:false,reducedTransparency:true,highContrast:true,backdropStatus:'reduced-transparency'});
});

test('macOS requests native under-window vibrancy and responds to accessibility changes',()=>{
  const calls=[];
  const {win}=host({setVibrancy:value=>calls.push(['vibrancy',value]),setBackgroundColor:value=>calls.push(['color',value]),
    setBackgroundMaterial(){assert.fail('macOS must never call the DWM API');}});
  const options={platform:'darwin',release:'25.0.0',theme:{}};
  assert.deepEqual(applyPanelMaterial(win,options),{
    nativeBackdrop:true,reducedTransparency:false,highContrast:false,backdropStatus:'requested'});
  assert.deepEqual(calls,[['vibrancy','under-window'],['color','#00000000']]);
  for(const theme of [{prefersReducedTransparency:true},{shouldUseHighContrastColors:true},{inForcedColorsMode:true}]){
    const appearance=applyPanelMaterial(win,{...options,theme});
    assert.equal(appearance.nativeBackdrop,false);
    assert.equal(appearance.backdropStatus,'reduced-transparency');
    assert.deepEqual(calls.slice(-2),[['vibrancy',null],['color','#171b22']]);
  }
  assert.equal(applyPanelMaterial(win,options).nativeBackdrop,true);
  assert.deepEqual(calls.slice(-2),[['vibrancy','under-window'],['color','#00000000']]);
});

test('unavailable macOS compositor falls back without crashing or claiming visible blur',()=>{
  for(const failure of ['vibrancy','color']){
    const calls=[];
    const {win}=host({setVibrancy(value){calls.push(['vibrancy',value]);if(failure==='vibrancy'&&value)throw Error('unavailable');},
      setBackgroundColor(value){calls.push(['color',value]);if(failure==='color'&&value==='#00000000')throw Error('unavailable');}});
    assert.equal(applyPanelMaterial(win,{platform:'darwin'}).nativeBackdrop,false);
    assert.deepEqual(calls.slice(-2),[['vibrancy',null],['color','#171b22']]);
  }
  assert.equal(applyPanelMaterial(null,{platform:'darwin'}).backdropStatus,'unavailable');
  const destroyed=host({isDestroyed:()=>true,setVibrancy(){assert.fail('destroyed host');}});
  applyPanelMaterial(destroyed.win,{platform:'darwin'});assert.deepEqual(destroyed.calls,[]);
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

test('orb always uses a transparent alpha host and never requests Acrylic, even with a legacy nativeHost option',()=>{
  for(const nativeHost of [undefined,false,true]){
    const {win,calls}=host();
    assert.deepEqual(applyOrbMaterial(win,{...supported,nativeHost}),{
      orbNativeHost:false,orbNativeBackdrop:false,orbBackdropStatus:'unavailable'});
    assert.deepEqual(calls,[['material','none'],['color','#00000000']]);
    assert.deepEqual(applyOrbMaterial(win,{...supported,nativeHost,theme:{shouldUseHighContrastColors:true}}),{
      orbNativeHost:false,orbNativeBackdrop:false,orbBackdropStatus:'reduced-transparency'});
    assert.deepEqual(calls.slice(-2),[['material','none'],['color','#00000000']]);
  }
});

test('orb transparency survives unavailable backdrop APIs without making a solid rectangular fallback',()=>{
  const {win,calls}=host({setBackgroundMaterial(){throw Error('DWM unavailable');}});
  assert.equal(applyOrbMaterial(win,supported).orbNativeBackdrop,false);
  assert.deepEqual(calls,[['color','#00000000']]);
  for(const platform of ['linux','darwin']){
    const {win,calls}=host({setBackgroundMaterial(){assert.fail('unsupported native API');}});
    assert.equal(applyOrbMaterial(win,{...supported,platform}).orbBackdropStatus,'unsupported');
    assert.deepEqual(calls,[['color','#00000000']]);
  }
  assert.doesNotThrow(()=>applyOrbMaterial(null,supported));
  const destroyed=host({isDestroyed:()=>true});
  applyOrbMaterial(destroyed.win,supported);assert.deepEqual(destroyed.calls,[]);
});
