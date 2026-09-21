'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {supportsAcrylic,systemAppearance,applyPanelMaterial}=require('../src/window-material.cjs');

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
