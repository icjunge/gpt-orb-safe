'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('orb',{
  getState:()=>ipcRenderer.invoke('test:state'),
  onState:callback=>{ipcRenderer.on('test:update',(_event,state)=>callback(state));},
  action:(name,payload)=>ipcRenderer.invoke('test:action',{name,payload})
});
