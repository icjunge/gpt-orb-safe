'use strict';

const COMPACT_SIZE=48;
const EXPANDED_SIZE=56;

function clampBounds(bounds,area){
  return{...bounds,
    x:Math.round(Math.max(area.x,Math.min(bounds.x,area.x+area.width-bounds.width))),
    y:Math.round(Math.max(area.y,Math.min(bounds.y,area.y+area.height-bounds.height)))};
}

function centeredBounds(center,size,area){
  return clampBounds({x:Math.round(center.x-size/2),y:Math.round(center.y-size/2),width:size,height:size},area);
}

function centerOf(bounds){return{x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2};}

// Electron accepts a union of DIP rectangles and converts the region to the
// current HWND DPI. Merge equal scanlines to keep the native region small. The
// region clips both paint and hit testing, including the square window corners.
function circleShape(size){
  if(!Number.isInteger(size)||size<1||size>EXPANDED_SIZE)throw new RangeError('Invalid orb size');
  const radius=size/2,rectangles=[];
  for(let y=0;y<size;y++){
    const halfWidth=Math.sqrt(radius*radius-(y+.5-radius)**2);
    const x=Math.max(0,Math.ceil(radius-halfWidth-.5));
    const width=size-2*x;
    if(width<=0)continue;
    const last=rectangles.at(-1);
    if(last&&last.x===x&&last.width===width&&last.y+last.height===y)last.height++;
    else rectangles.push({x,y,width,height:1});
  }
  return rectangles;
}

function validExpansion(payload){
  return Boolean(payload&&typeof payload==='object'&&!Array.isArray(payload)&&
    Reflect.ownKeys(payload).length===1&&Object.hasOwn(payload,'expanded')&&typeof payload.expanded==='boolean');
}

function createOrbController(win,screen,{platform=process.platform}={}){
  let expanded=false,requested=false,dragging=false,dragBounds=null,center=centerOf(win.getBounds()),displayKey=null;
  const alive=()=>win&&!win.isDestroyed();
  function refreshShape(force=false){
    if(!alive()||!['win32','linux'].includes(platform))return;
    const bounds=win.getBounds(),display=screen.getDisplayMatching(bounds);
    const key=`${display.id}:${display.scaleFactor}:${bounds.width}:${bounds.height}`;
    if(!force&&key===displayKey)return;
    try{win.setShape(circleShape(bounds.width));displayKey=key;}catch{
      // A native region is cosmetic. Unsupported compositors must not make the
      // usage monitor fail to start; a later display change can retry the shape.
      displayKey=null;
    }
  }
  function resize(){
    if(!alive())return{ok:false};
    const before=win.getBounds(),area=screen.getDisplayMatching(before).workArea;
    const next=centeredBounds(center,requested?EXPANDED_SIZE:COMPACT_SIZE,area);
    if(['x','y','width','height'].some(key=>before[key]!==next[key]))win.setBounds(next);
    expanded=requested;refreshShape();
    return{ok:true,expanded};
  }
  refreshShape(true);
  return{
    request(payload){
      if(!validExpansion(payload)||!alive())return{ok:false};
      requested=payload.expanded;
      if(dragging)return{ok:true,expanded,queued:true};
      return resize();
    },
    beginDrag(){if(!alive())return;dragging=true;dragBounds=win.getBounds();},
    endDrag({moved=false}={}){
      if(!alive())return{ok:false};
      // Only a gesture that crossed the native DIP threshold may commit a new
      // anchor. Hover resize / compositor bounds changes during a stationary
      // press are not evidence of dragging. A clamped drag or a drag returning
      // to its start also retains the original, potentially unclamped anchor.
      const bounds=win.getBounds();
      if(dragging&&moved&&(bounds.x!==dragBounds.x||bounds.y!==dragBounds.y))center=centerOf(bounds);
      dragging=false;dragBounds=null;return resize();
    },
    compactPosition(){
      const bounds=win.getBounds(),area=screen.getDisplayMatching(bounds).workArea;
      const {x,y}=centeredBounds(center,COMPACT_SIZE,area);return{x,y};
    },
    refreshShape,
    syncDisplay(){
      if(!alive())return;
      const before=win.getBounds(),area=screen.getDisplayMatching(before).workArea;
      const next=clampBounds(before,area);
      if(next.x!==before.x||next.y!==before.y)win.setBounds(next);
      center=centerOf(next);refreshShape(true);
    }
  };
}

module.exports={COMPACT_SIZE,EXPANDED_SIZE,clampBounds,centeredBounds,circleShape,validExpansion,createOrbController};
