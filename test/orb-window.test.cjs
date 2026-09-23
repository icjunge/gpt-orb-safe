'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {COMPACT_SIZE,EXPANDED_SIZE,circleShape,createOrbController}=require('../src/orb-window.cjs');

function host({bounds={x:400,y:300,width:48,height:48},platform='win32',shapeFails=false}={}){
  const calls={bounds:[],shapes:[]};
  const win={bounds:{...bounds},destroyed:false,isDestroyed(){return this.destroyed;},
    getBounds(){return{...this.bounds};},setBounds(value){this.bounds={...value};calls.bounds.push(value);},
    setShape(value){calls.shapes.push(value);if(shapeFails)throw Error('region unavailable');},
    focus(){assert.fail('hover must not focus the orb');},show(){assert.fail('hover must not activate the orb');}};
  const display={id:1,scaleFactor:1,workArea:{x:0,y:0,width:1920,height:1080}};
  const screen={getDisplayMatching:()=>display};
  return{win,display,calls,controller:createOrbController(win,screen,{platform})};
}

test('circle hit regions cover precisely the circular pixel centers and merge identical rows',()=>{
  for(const size of [COMPACT_SIZE,EXPANDED_SIZE]){
    const rects=circleShape(size),occupied=new Set();
    assert.ok(rects.length<size,'equal scanlines should share one native rectangle');
    for(const rect of rects){
      for(let y=rect.y;y<rect.y+rect.height;y++)for(let x=rect.x;x<rect.x+rect.width;x++){
        assert.ok(x>=0&&x<size&&y>=0&&y<size);
        assert.equal(occupied.has(`${x},${y}`),false,'regions must not overlap');
        occupied.add(`${x},${y}`);
      }
    }
    for(let y=0;y<size;y++)for(let x=0;x<size;x++){
      const inside=(x+.5-size/2)**2+(y+.5-size/2)**2<=(size/2)**2;
      assert.equal(occupied.has(`${x},${y}`),inside,`${size}: ${x},${y}`);
    }
    assert.equal(occupied.has('0,0'),false,'square corners must pass through to the underlying app');
  }
  for(const invalid of [0,-1,57,Infinity,48.5,'48'])assert.throws(()=>circleShape(invalid),RangeError);
});

test('hover requests use only fixed sizes, preserve the center and ignore repeated requests',()=>{
  const {win,calls,controller}=host();
  assert.deepEqual(controller.request({expanded:true}),{ok:true,expanded:true});
  assert.deepEqual(win.bounds,{x:396,y:296,width:56,height:56});
  assert.equal(calls.shapes.length,2);
  for(let i=0;i<10;i++)controller.request({expanded:true});
  assert.equal(calls.bounds.length,1);
  assert.equal(calls.shapes.length,2,'no repeated region work at the same size and display DPI');
  controller.request({expanded:false});
  assert.deepEqual(win.bounds,{x:400,y:300,width:48,height:48});
});

test('screen edges do not make repeated hover cycles drift, including negative display coordinates',()=>{
  for(const original of [{x:0,y:0,width:48,height:48},{x:1872,y:1032,width:48,height:48}]){
    const {win,controller}=host({bounds:original});
    for(let i=0;i<40;i++){
      controller.request({expanded:true});
      assert.ok(win.bounds.x>=0&&win.bounds.y>=0&&win.bounds.x+56<=1920&&win.bounds.y+56<=1080);
      controller.beginDrag();controller.endDrag();
      controller.request({expanded:false});
      assert.deepEqual(win.bounds,original);
    }
  }
  const {win,display,controller}=host({bounds:{x:-1920,y:-100,width:48,height:48}});
  display.workArea={x:-1920,y:-200,width:1920,height:1080};
  controller.request({expanded:true});
  assert.deepEqual(win.bounds,{x:-1920,y:-104,width:56,height:56});
  controller.request({expanded:false});
  assert.deepEqual(win.bounds,{x:-1920,y:-100,width:48,height:48});
});

test('dragging freezes native size and applies only the last hover request at the new center',()=>{
  const {win,calls,controller}=host();
  controller.request({expanded:true});controller.beginDrag();
  const changes=calls.bounds.length;
  assert.deepEqual(controller.request({expanded:false}),{ok:true,expanded:true,queued:true});
  controller.request({expanded:true});controller.request({expanded:false});
  assert.equal(calls.bounds.length,changes);
  win.bounds={x:700,y:500,width:56,height:56};
  assert.deepEqual(controller.endDrag({moved:true}),{ok:true,expanded:false});
  assert.deepEqual(win.bounds,{x:704,y:504,width:48,height:48});
  assert.deepEqual(controller.compactPosition(),{x:704,y:504});
  controller.request({expanded:true});
  assert.deepEqual(controller.compactPosition(),{x:704,y:504},'saving an expanded drag must restore the compact center next launch');
});

test('a stationary press never adopts a delayed native bounds change as its anchor',()=>{
  for(const bounds of [{x:400,y:300,width:48,height:48},{x:0,y:0,width:48,height:48},{x:1872,y:1032,width:48,height:48}]){
    const {win,controller}=host({bounds});
    for(let count=0;count<30;count++){
      controller.request({expanded:true});controller.beginDrag();
      // A compositor/DPI report changes bounds without a native drag crossing
      // its threshold. It must not be mistaken for intentional pointer travel.
      win.bounds.x+=4;win.bounds.y+=4;
      controller.request({expanded:false});controller.endDrag({moved:false});
      assert.deepEqual(win.bounds,bounds);
      assert.deepEqual(controller.compactPosition(),{x:bounds.x,y:bounds.y});
    }
  }
});

test('clamped outer drags and returning drags preserve every original corner anchor',()=>{
  for(const original of [{x:0,y:0,width:48,height:48},{x:1872,y:0,width:48,height:48},
    {x:0,y:1032,width:48,height:48},{x:1872,y:1032,width:48,height:48}]){
    const {win,controller}=host({bounds:original});
    for(let count=0;count<30;count++){
      controller.request({expanded:true});controller.beginDrag();
      const pressBounds={...win.bounds};
      if(count%2){win.bounds.x+=original.x? -80:80;win.bounds.y+=original.y? -80:80;win.bounds={...pressBounds};}
      // Pointer travel exceeded the threshold, but the final native position is
      // unchanged. Never adopt the clamped expanded centre as a new anchor.
      controller.endDrag({moved:true});controller.request({expanded:false});
      assert.deepEqual(win.bounds,original);
      assert.deepEqual(controller.compactPosition(),{x:original.x,y:original.y});
    }
  }
});

test('display DPI changes reapply the region without a resize and disconnected displays clamp the full orb',()=>{
  const {win,display,calls,controller}=host();
  controller.refreshShape();assert.equal(calls.shapes.length,1);
  display.scaleFactor=1.5;controller.refreshShape();assert.equal(calls.shapes.length,2);
  assert.equal(calls.bounds.length,0);
  controller.request({expanded:true});
  display.id=2;display.workArea={x:-1280,y:0,width:1280,height:720};
  controller.syncDisplay();
  assert.deepEqual(win.bounds,{x:-56,y:296,width:56,height:56});
  controller.request({expanded:false});
  assert.deepEqual(win.bounds,{x:-52,y:300,width:48,height:48});
});

test('invalid expansion payloads cannot choose bounds, and native region failures remain cosmetic',()=>{
  const {win,controller,calls}=host({shapeFails:true});
  const before=win.getBounds();
  for(const payload of [undefined,null,[],{},true,{expanded:1},{expanded:'true'},{expanded:true,width:999},
    Object.create({expanded:true}),Object.assign({expanded:true},{[Symbol('size')]:999})]){
    assert.deepEqual(controller.request(payload),{ok:false});assert.deepEqual(win.bounds,before);
  }
  assert.deepEqual(controller.request({expanded:true}),{ok:true,expanded:true});
  assert.equal(win.bounds.width,56);assert.ok(calls.shapes.length>=2);
  win.destroyed=true;
  assert.deepEqual(controller.request({expanded:false}),{ok:false});
  assert.doesNotThrow(()=>controller.syncDisplay());
  const other=host({platform:'darwin'});
  other.controller.request({expanded:true});assert.equal(other.calls.shapes.length,0);
});
