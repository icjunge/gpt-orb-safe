'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {COMPACT_SIZE,EXPANDED_SIZE,HOST_SIZE,HOST_INSET,circleShape,createOrbController}=require('../src/orb-window.cjs');

function host({bounds={x:396,y:296,width:HOST_SIZE,height:HOST_SIZE},platform='win32',shapeFails=false}={}){
  const calls={bounds:[],shapes:[]};
  const win={bounds:{...bounds},destroyed:false,isDestroyed(){return this.destroyed;},
    getBounds(){return{...this.bounds};},setBounds(value){this.bounds={...value};calls.bounds.push(value);},
    setShape(value){calls.shapes.push(value);if(shapeFails)throw Error('region unavailable');},
    focus(){assert.fail('hover must not focus the orb');},show(){assert.fail('hover must not activate the orb');}};
  const display={id:1,scaleFactor:1,workArea:{x:0,y:0,width:1920,height:1080}};
  const screen={getDisplayMatching:()=>display};
  return{win,display,calls,controller:createOrbController(win,screen,{platform})};
}
const cornerPositions=[{x:0,y:0},{x:1872,y:0},{x:0,y:1032},{x:1872,y:1032}];
const hostBounds=position=>({x:position.x-HOST_INSET,y:position.y-HOST_INSET,width:HOST_SIZE,height:HOST_SIZE});

test('circle hit regions cover the visible circle at its host offset and merge identical rows',()=>{
  for(const [size,offset] of [[COMPACT_SIZE,HOST_INSET],[EXPANDED_SIZE,0]]){
    const rects=circleShape(size,offset),occupied=new Set();
    assert.ok(rects.length<size);
    for(const rect of rects)for(let y=rect.y;y<rect.y+rect.height;y++)for(let x=rect.x;x<rect.x+rect.width;x++){
      assert.ok(x>=0&&x<HOST_SIZE&&y>=0&&y<HOST_SIZE);
      assert.equal(occupied.has(`${x},${y}`),false);occupied.add(`${x},${y}`);
    }
    for(let y=0;y<HOST_SIZE;y++)for(let x=0;x<HOST_SIZE;x++){
      const inside=(x+.5-offset-size/2)**2+(y+.5-offset-size/2)**2<=(size/2)**2;
      assert.equal(occupied.has(`${x},${y}`),inside,`${size}+${offset}: ${x},${y}`);
    }
    assert.equal(occupied.has('0,0'),false,'square corners must pass through to the underlying app');
    if(offset)assert.equal(occupied.has('28,1'),false,'compact transparent padding must also pass through');
  }
  for(const invalid of [0,-1,57,Infinity,48.5,'48'])assert.throws(()=>circleShape(invalid),RangeError);
  for(const invalid of [-1,.5,5,Infinity,'4'])assert.throws(()=>circleShape(COMPACT_SIZE,invalid),RangeError);
});

test('hover switches only the native hit region and never changes the 56 DIP host geometry',()=>{
  const {win,calls,controller}=host(),initial=win.getBounds();
  assert.deepEqual(calls.shapes[0],circleShape(COMPACT_SIZE,HOST_INSET));
  assert.deepEqual(controller.request({expanded:true}),{ok:true,expanded:true});
  assert.deepEqual(calls.shapes.at(-1),circleShape(EXPANDED_SIZE));
  for(let i=0;i<10;i++)controller.request({expanded:true});
  assert.equal(calls.shapes.length,2);
  controller.request({expanded:false});
  assert.deepEqual(win.bounds,initial);assert.equal(calls.bounds.length,0);
  assert.deepEqual(controller.compactPosition(),{x:400,y:300});
});

test('Mac hover and stationary press preserve the alpha host without unsupported shape calls',()=>{
  const {win,display,calls,controller}=host({platform:'darwin',bounds:hostBounds({x:-900,y:40})});
  display.workArea={x:-1440,y:25,width:1440,height:875};display.scaleFactor=2;
  const initial=win.getBounds();
  for(let i=0;i<20;i++){
    controller.request({expanded:true});controller.beginDrag();
    controller.request({expanded:false});controller.endDrag();
    assert.deepEqual(win.getBounds(),initial);
  }
  assert.equal(calls.bounds.length,0);assert.equal(calls.shapes.length,0);
  controller.beginDrag();controller.moveDrag({x:-600,y:50});controller.endDrag({position:{x:-600,y:50}});
  assert.deepEqual(controller.compactPosition(),{x:-596,y:54});
  assert.deepEqual(win.getBounds(),{x:-600,y:50,width:HOST_SIZE,height:HOST_SIZE});
  assert.equal(calls.shapes.length,0);
});

test('all edge hover and stationary press cycles keep the original visible anchor including negative displays',()=>{
  for(const original of cornerPositions){
    const {win,calls,controller}=host({bounds:hostBounds(original)}),initial=win.getBounds();
    for(let i=0;i<40;i++){
      controller.request({expanded:true});controller.beginDrag();controller.endDrag();controller.request({expanded:false});
      assert.deepEqual(win.bounds,initial);assert.deepEqual(controller.compactPosition(),original);
    }
    assert.equal(calls.bounds.length,0,'transparent padding may extend 4 DIP outside the work area');
  }
  const {win,display,calls,controller}=host({bounds:hostBounds({x:-1920,y:-100})}),initial=win.getBounds();
  display.workArea={x:-1920,y:-200,width:1920,height:1080};
  controller.request({expanded:true});controller.request({expanded:false});
  assert.deepEqual(win.bounds,initial);assert.equal(calls.bounds.length,0);
});

test('press freezes the visible region and release applies only its final request without resizing',()=>{
  const {win,calls,controller}=host();
  controller.request({expanded:true});controller.beginDrag();
  const shapeCount=calls.shapes.length;
  assert.deepEqual(controller.request({expanded:false}),{ok:true,expanded:true,queued:true});
  controller.request({expanded:true});controller.request({expanded:false});
  assert.equal(calls.bounds.length,0);assert.equal(calls.shapes.length,shapeCount);
  controller.moveDrag({x:700,y:500});
  const boundCount=calls.bounds.length;
  assert.deepEqual(controller.endDrag({position:{x:700,y:500}}),{ok:true,expanded:false});
  assert.deepEqual(win.bounds,{x:700,y:500,width:56,height:56});assert.equal(calls.bounds.length,boundCount);
  assert.deepEqual(controller.compactPosition(),{x:704,y:504});
});

test('stationary press and release repair native offsets without ever adopting them as a user position',()=>{
  for(const original of [{x:400,y:300},...cornerPositions]){
    const {win,controller}=host({bounds:hostBounds(original)}),initial=win.getBounds();
    for(let count=0;count<30;count++){
      controller.request({expanded:true});controller.beginDrag();
      win.bounds.x+=4;win.bounds.y+=4;
      controller.request({expanded:false});controller.endDrag();
      assert.deepEqual(win.bounds,initial);assert.deepEqual(controller.compactPosition(),original);
    }
  }
});

test('a real drag commits the explicit native-cursor target even when release bounds disagree',()=>{
  const {win,controller}=host();controller.beginDrag();controller.moveDrag({x:700,y:500});
  win.bounds.x+=4;win.bounds.y+=4;
  controller.endDrag({position:{x:700,y:500}});
  assert.deepEqual(win.bounds,{x:700,y:500,width:56,height:56});
  assert.deepEqual(controller.compactPosition(),{x:704,y:504});
});

test('clamped outer drags and returning drags preserve every original corner anchor',()=>{
  for(const original of cornerPositions){
    const {win,controller}=host({bounds:hostBounds(original)}),initial=win.getBounds();
    for(let count=0;count<30;count++){
      controller.request({expanded:true});controller.beginDrag();
      if(count%2)controller.moveDrag({x:initial.x+(original.x?-80:80),y:initial.y+(original.y?-80:80)});
      controller.moveDrag(initial);controller.endDrag({position:initial});controller.request({expanded:false});
      assert.deepEqual(win.bounds,initial);assert.deepEqual(controller.compactPosition(),original);
    }
  }
});

test('late native movement is repaired, while rounding and a rejecting compositor cannot form a feedback loop',()=>{
  const {win,calls,controller}=host(),initial=win.getBounds();
  controller.beginDrag();controller.endDrag();
  win.bounds.x+=4;win.bounds.y+=4;controller.reconcileNativeBounds();assert.deepEqual(win.bounds,initial);
  win.bounds.x+=1;
  for(let i=0;i<20;i++){
    controller.reconcileNativeBounds();controller.request({expanded:true});controller.beginDrag();controller.endDrag();controller.request({expanded:false});
  }
  assert.equal(calls.bounds.length,1,'one DIP observation rounding never moves the host during hover/down/up');
  assert.deepEqual(controller.compactPosition(),{x:400,y:300});
  controller.beginDrag();
  let attempts=0;
  win.setBounds=()=>{attempts++;controller.reconcileNativeBounds();};
  win.bounds.x+=8;
  for(let i=0;i<20;i++)controller.reconcileNativeBounds();
  assert.ok(attempts<=2,'bounded retries even with synchronous and later native move events');
});

test('a one DIP real drag step remains responsive after the drag threshold was crossed',()=>{
  const {win,controller}=host();controller.beginDrag();controller.moveDrag({x:410,y:310});controller.moveDrag({x:411,y:311});
  assert.equal(win.bounds.x,411);assert.equal(win.bounds.y,311);
});

test('DPI changes reapply the hit region, display removal clamps the visible orb, and active presses defer relocation',()=>{
  const {win,display,calls,controller}=host();
  controller.refreshShape();assert.equal(calls.shapes.length,1);
  display.scaleFactor=1.5;controller.refreshShape();assert.equal(calls.shapes.length,2);assert.equal(calls.bounds.length,0);
  controller.request({expanded:true});controller.beginDrag();
  display.id=2;display.workArea={x:-1280,y:0,width:1280,height:720};
  controller.syncDisplay();assert.equal(calls.bounds.length,0,'do not reposition during a press');
  controller.endDrag();assert.deepEqual(win.bounds,{x:-52,y:296,width:56,height:56});
  controller.request({expanded:false});assert.deepEqual(controller.compactPosition(),{x:-48,y:300});
});

test('invalid expansion payloads cannot choose geometry, and native region failures remain cosmetic',()=>{
  const {win,controller,calls}=host({shapeFails:true}),before=win.getBounds();
  for(const payload of [undefined,null,[],{},true,{expanded:1},{expanded:'true'},{expanded:true,width:999},
    Object.create({expanded:true}),Object.assign({expanded:true},{[Symbol('size')]:999})]){
    assert.deepEqual(controller.request(payload),{ok:false});assert.deepEqual(win.bounds,before);
  }
  assert.deepEqual(controller.request({expanded:true}),{ok:true,expanded:true});
  assert.deepEqual(win.bounds,before);assert.equal(calls.bounds.length,0);assert.ok(calls.shapes.length>=2);
  win.destroyed=true;assert.deepEqual(controller.request({expanded:false}),{ok:false});
  assert.doesNotThrow(()=>controller.syncDisplay());assert.doesNotThrow(()=>controller.reconcileNativeBounds());
  const other=host({platform:'darwin'});other.controller.request({expanded:true});assert.equal(other.calls.shapes.length,0);
});
