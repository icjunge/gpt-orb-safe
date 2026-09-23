'use strict';

const COMPACT_SIZE=48;
const EXPANDED_SIZE=56;
const HOST_SIZE=EXPANDED_SIZE;
const HOST_INSET=(HOST_SIZE-COMPACT_SIZE)/2;

function clampBounds(bounds,area){
  return{...bounds,
    x:Math.round(Math.max(area.x,Math.min(bounds.x,area.x+area.width-bounds.width))),
    y:Math.round(Math.max(area.y,Math.min(bounds.y,area.y+area.height-bounds.height)))};
}

function centeredBounds(center,size,area){
  return clampBounds({x:Math.round(center.x-size/2),y:Math.round(center.y-size/2),width:size,height:size},area);
}

// Electron accepts a union of DIP rectangles and converts the region to the
// current HWND DPI. Merge equal scanlines to keep the native region small. The
// region clips both paint and hit testing, including the square window corners.
function circleShape(size,offset=0){
  if(!Number.isInteger(size)||size<1||size>HOST_SIZE||!Number.isInteger(offset)||offset<0||size+offset*2>HOST_SIZE)throw new RangeError('Invalid orb size');
  const radius=size/2,rectangles=[];
  for(let y=0;y<size;y++){
    const halfWidth=Math.sqrt(radius*radius-(y+.5-radius)**2);
    const x=Math.max(0,Math.ceil(radius-halfWidth-.5));
    const width=size-2*x;
    if(width<=0)continue;
    const last=rectangles.at(-1),left=x+offset,top=y+offset;
    if(last&&last.x===left&&last.width===width&&last.y+last.height===top)last.height++;
    else rectangles.push({x:left,y:top,width,height:1});
  }
  return rectangles;
}

function validExpansion(payload){
  return Boolean(payload&&typeof payload==='object'&&!Array.isArray(payload)&&
    Reflect.ownKeys(payload).length===1&&Object.hasOwn(payload,'expanded')&&typeof payload.expanded==='boolean');
}

function createOrbController(win,screen,{platform=process.platform}={}){
  const initial=win.getBounds();
  let expanded=false,requested=false,dragging=false,displayPending=false,position={x:initial.x,y:initial.y},displayKey=null;
  let restoring=false,correctionsLeft=2;
  const alive=()=>win&&!win.isDestroyed();
  const bounds=()=>({...position,width:HOST_SIZE,height:HOST_SIZE});
  function restoreBounds({exact=false}={}){
    if(restoring||correctionsLeft<=0)return;
    const before=win.getBounds(),next=bounds();
    // Hover never changes HWND geometry. Correct an unexpected native change
    // against the logical position; never adopt it as a new user drag anchor.
    if(['x','y','width','height'].some(key=>Math.abs(before[key]-next[key])>(exact?0:1))){
      correctionsLeft--;restoring=true;
      try{win.setBounds(next);}finally{restoring=false;}
    }
  }
  function clampToDisplay(){
    const area=screen.getDisplayMatching(bounds()).workArea;
    const compact=clampBounds({x:position.x+HOST_INSET,y:position.y+HOST_INSET,width:COMPACT_SIZE,height:COMPACT_SIZE},area);
    position={x:compact.x-HOST_INSET,y:compact.y-HOST_INSET};
  }
  function refreshShape(force=false){
    if(!alive()||!['win32','linux'].includes(platform))return;
    const display=screen.getDisplayMatching(bounds());
    const key=`${display.id}:${display.scaleFactor}:${expanded}`;
    if(!force&&key===displayKey)return;
    displayKey=key;
    try{win.setShape(circleShape(expanded?EXPANDED_SIZE:COMPACT_SIZE,expanded?0:HOST_INSET));}catch{
      // A native region is cosmetic. Unsupported compositors must not make the
      // usage monitor fail to start; a later display change can retry the shape.
      displayKey=null;
    }
  }
  function applyAppearance(){
    if(!alive())return{ok:false};
    restoreBounds();
    expanded=requested;refreshShape();
    return{ok:true,expanded};
  }
  refreshShape(true);
  return{
    request(payload){
      if(!validExpansion(payload)||!alive())return{ok:false};
      requested=payload.expanded;
      if(dragging)return{ok:true,expanded,queued:true};
      return applyAppearance();
    },
    beginDrag(){if(!alive())return;correctionsLeft=2;restoreBounds();dragging=true;return bounds();},
    moveDrag(target){
      if(!alive()||!dragging||!target||!Number.isInteger(target.x)||!Number.isInteger(target.y))return false;
      const changed=target.x!==position.x||target.y!==position.y;
      position={x:target.x,y:target.y};
      if(changed)correctionsLeft=2;
      restoreBounds({exact:changed});refreshShape();return true;
    },
    endDrag({position:target}={}){
      if(!alive())return{ok:false};
      // The main process supplies its native-cursor-derived target. getBounds()
      // is only an observation to repair, never evidence that a user dragged.
      if(dragging&&target&&Number.isInteger(target.x)&&Number.isInteger(target.y)){
        if(target.x!==position.x||target.y!==position.y)correctionsLeft=2;
        position={x:target.x,y:target.y};
      }
      dragging=false;
      correctionsLeft=2;
      if(displayPending){displayPending=false;clampToDisplay();}
      return applyAppearance();
    },
    compactPosition(){
      return{x:position.x+HOST_INSET,y:position.y+HOST_INSET};
    },
    refreshShape,
    reconcileNativeBounds(){
      if(!alive()||restoring)return;
      const observed=win.getBounds(),expected=bounds();
      // Fractional display scales can round native DIP observations by one.
      // Never feed that rounding back into the logical anchor or oscillate.
      if(['x','y','width','height'].some(key=>Math.abs(observed[key]-expected[key])>1))restoreBounds();
      refreshShape();
    },
    syncDisplay(){
      if(!alive())return;
      if(dragging){displayPending=true;refreshShape(true);return;}
      clampToDisplay();correctionsLeft=2;restoreBounds();refreshShape(true);
    }
  };
}

module.exports={COMPACT_SIZE,EXPANDED_SIZE,HOST_SIZE,HOST_INSET,clampBounds,centeredBounds,circleShape,validExpansion,createOrbController};
