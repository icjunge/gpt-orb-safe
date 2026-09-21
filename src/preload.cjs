'use strict';
const {contextBridge,ipcRenderer}=require('electron');
const allowed=new Set(['togglePanel','hidePanel','openDashboard','openHelp','openExtensionFolder','copyPairingCode',
  'checkUpdates','installUpdate','openRecoveryFolder','openReleasePage','disconnect','setSettings','dragStart','dragMove','dragEnd','quit',
  'enableCodex','disableCodex','refreshCodex','copyCodexSetup','openCodexHelp','panelResize']);
contextBridge.exposeInMainWorld('orb',Object.freeze({
  getState:()=>ipcRenderer.invoke('orb:state'),
  onState:callback=>{if(typeof callback!=='function')return()=>{};const listener=(_event,state)=>callback(state);
    ipcRenderer.on('orb:state',listener);return()=>ipcRenderer.removeListener('orb:state',listener);},
  action:(name,payload)=>allowed.has(name)?ipcRenderer.invoke('orb:action',name,payload):Promise.resolve({ok:false,error:'未知操作'})
}));
