'use strict';

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
  return{nativeBackdrop:false,reducedTransparency:Boolean(theme.prefersReducedTransparency||highContrast),highContrast};
}

function applyPanelMaterial(win,{platform,release,theme}={}){
  const appearance=systemAppearance(theme);
  if(!supportsAcrylic(platform,release)||!win||win.isDestroyed())return appearance;
  try{
    win.setBackgroundMaterial(appearance.reducedTransparency?'none':'acrylic');
    appearance.nativeBackdrop=!appearance.reducedTransparency;
  }catch{
    // A backdrop is cosmetic: an unavailable compositor must never block startup.
    try{win.setBackgroundMaterial('none');}catch{}
  }
  // The native host remains an ordinary rounded window, not a layered transparent
  // window. Its web content is transparent only while DWM supplies the material.
  try{win.setBackgroundColor(appearance.nativeBackdrop?'#00000000':'#f1f4f8');}catch{}
  return appearance;
}

module.exports={supportsAcrylic,systemAppearance,applyPanelMaterial};
