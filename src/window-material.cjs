'use strict';

const FALLBACK_COLOR='#171b22';
const HARDWARE_COMPOSITING=new Set(['enabled','enabled_on','enabled_force','enabled_force_on','enabled_readback']);
const SOFTWARE_COMPOSITING=new Set(['disabled_software','disabled_off','disabled_off_ok',
  'unavailable_software','unavailable_off','unavailable_off_ok']);

function compositingMode(status){
  if(HARDWARE_COMPOSITING.has(status))return'hardware';
  if(SOFTWARE_COMPOSITING.has(status))return'software';
  return'unknown';
}

// Register before app readiness so an early GPU event cannot be missed. Electron
// documents feature status as usable only after gpu-info-update. Neither ready
// nor a resolved basic-info request alone establishes the compositor state.
// https://www.electronjs.org/docs/latest/api/app#appgetgpufeaturestatus
function observeGpuCompositing(app,{timeoutMs=1200,setTimer=setTimeout,clearTimer=clearTimeout}={}){
  let seenUpdate=false,mode='unknown',finished=false,timer=null,resolveWait=null,promise=null;
  function read(){
    seenUpdate=true;
    try{mode=compositingMode(app.getGPUFeatureStatus()?.gpu_compositing);}catch{mode='unknown';}
    if(resolveWait&&mode!=='unknown')finish(mode);
  }
  function finish(value){
    if(finished)return;finished=true;mode=value;
    app.removeListener('gpu-info-update',read);
    if(timer!==null)clearTimer(timer);
    if(resolveWait){const resolve=resolveWait;resolveWait=null;resolve(value);}
  }
  app.on('gpu-info-update',read);
  return{
    wait(){
      if(promise)return promise;
      if(finished)return Promise.resolve(mode);
      if(seenUpdate&&mode!=='unknown'){finish(mode);return Promise.resolve(mode);}
      promise=new Promise(resolve=>{
        resolveWait=resolve;
        const boundedTimeout=Number.isFinite(timeoutMs)?Math.min(1500,Math.max(0,timeoutMs)):1200;
        timer=setTimer(()=>finish('unknown'),boundedTimeout);
        try{Promise.resolve(app.getGPUInfo('basic')).catch(()=>finish('unknown'));}catch{finish('unknown');}
      });
      return promise;
    },
    stop(){finish('unknown');}
  };
}

// Electron's system backdrop API requires Windows 11 22H2 (build 22621).
// Do not send unsupported DWM requests to Windows 10 or other platforms.
function supportsAcrylic(platform,release){
  if(platform!=='win32'||typeof release!=='string')return false;
  const version=/^(\d+)\.(\d+)\.(\d+)(?:\.\d+)?$/.exec(release);
  if(!version)return false;
  const major=Number(version[1]),minor=Number(version[2]),build=Number(version[3]);
  return major>10||(major===10&&(minor>0||build>=22621));
}

function systemAppearance(theme={}){
  const highContrast=Boolean(theme.shouldUseHighContrastColors||theme.inForcedColorsMode);
  const reducedTransparency=Boolean(theme.prefersReducedTransparency||highContrast);
  return{nativeBackdrop:false,reducedTransparency,highContrast,
    backdropStatus:reducedTransparency?'reduced-transparency':'unavailable'};
}

function applyPanelMaterial(win,{platform,release,theme}={}){
  const appearance=systemAppearance(theme);
  if(!supportsAcrylic(platform,release)){
    if(!appearance.reducedTransparency)appearance.backdropStatus='unsupported';
    return appearance;
  }
  if(!win||win.isDestroyed())return appearance;
  try{
    win.setBackgroundMaterial(appearance.reducedTransparency?'none':'acrylic');
    // Electron 44 applies the DWM backdrop, extends the frameless client area and
    // updates Chromium's native compositor. Its JS API returns void: DWM failures
    // are logged internally, not returned to us. This flag is only a renderer
    // paint hint to uncover the requested backdrop, never proof of visible blur.
    // OS transparency, battery saver and hardware policy may still make it solid.
    // https://github.com/electron/electron/blob/v44.4.3/shell/browser/native_window_views.cc
    win.setBackgroundColor(appearance.reducedTransparency?FALLBACK_COLOR:'#00000000');
    appearance.nativeBackdrop=!appearance.reducedTransparency;
    if(appearance.nativeBackdrop)appearance.backdropStatus='requested';
  }catch{
    // A backdrop is cosmetic: an unavailable compositor must never block startup.
    appearance.nativeBackdrop=false;
    if(!appearance.reducedTransparency)appearance.backdropStatus='unavailable';
    try{win.setBackgroundMaterial('none');}catch{}
    try{win.setBackgroundColor(FALLBACK_COLOR);}catch{}
  }
  // The native host remains an ordinary window, not a layered transparent
  // window. Never use whole-window opacity here: it fades text and can switch the
  // host to a layered window. Tint belongs to the renderer's single surface.
  return appearance;
}

function applyOrbMaterial(win,options={}){
  const nativeHost=options.nativeHost===true;
  const material=nativeHost?applyPanelMaterial(win,options):systemAppearance(options.theme);
  if(!nativeHost){
    const supported=supportsAcrylic(options.platform,options.release);
    if(!material.reducedTransparency)material.backdropStatus=supported?'unavailable':'unsupported';
    if(win&&!win.isDestroyed()){
      // An alpha host must explicitly opt out of Windows' default backdrop.
      // Otherwise even a correct circular region can paint an opaque rectangle.
      try{if(supported)win.setBackgroundMaterial('none');}catch{}
      try{win.setBackgroundColor('#00000000');}catch{}
    }
  }
  // Keep the orb and panel paint hints independent. A successful void API call
  // does not confirm how DWM composites a shaped, inactive, always-on-top HWND.
  // In particular, do not activate the window or repeatedly reapply the material
  // to defeat system fallback decisions when another application has focus.
  return{orbNativeHost:nativeHost,
    orbNativeBackdrop:material.nativeBackdrop,orbBackdropStatus:material.backdropStatus};
}

module.exports={supportsAcrylic,systemAppearance,applyPanelMaterial,applyOrbMaterial,compositingMode,observeGpuCompositing};
