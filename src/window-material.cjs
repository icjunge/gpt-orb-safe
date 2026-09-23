'use strict';

const FALLBACK_COLOR='#171b22';
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
  const material=systemAppearance(options.theme);
  const supported=supportsAcrylic(options.platform,options.release);
  if(!material.reducedTransparency)material.backdropStatus=supported?'unavailable':'unsupported';
  if(win&&!win.isDestroyed()){
    // The orb always uses an alpha host. Explicitly opt out of Windows' default
    // backdrop: Acrylic can paint an opaque rectangle outside a circular region,
    // even when the GPU reports hardware composition. Keep the host transparent;
    // accessibility fills belong to the clipped circular surface in the renderer.
    try{if(supported)win.setBackgroundMaterial('none');}catch{}
    try{win.setBackgroundColor('#00000000');}catch{}
  }
  return{orbNativeHost:false,orbNativeBackdrop:false,orbBackdropStatus:material.backdropStatus};
}

module.exports={supportsAcrylic,systemAppearance,applyPanelMaterial,applyOrbMaterial};
