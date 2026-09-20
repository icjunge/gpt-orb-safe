'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {supportsAcrylic,applyPanelMaterial}=require('../src/window-material.cjs');

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
  assert.deepEqual(result,{nativeBackdrop:false,reducedTransparency:true,highContrast:false});
  assert.deepEqual(applyPanelMaterial(win,{platform:'darwin',release:'24.0.0',theme:{inForcedColorsMode:true}}),
    {nativeBackdrop:false,reducedTransparency:true,highContrast:true});
});
