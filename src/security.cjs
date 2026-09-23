'use strict';
function validSettings(input,base={alwaysOnTop:true,autoStart:false,notifications:true,opacity:1,autoCheckUpdates:true,
  usageSource:'codex-cli',codexEnabled:false,codexConnection:'managed',codexManagedConnected:false,refreshMinutes:5,glassTint:16}){
  const out={...base};if(!input||typeof input!=='object'||Array.isArray(input))return out;
  for(const k of['alwaysOnTop','autoStart','notifications','autoCheckUpdates','codexEnabled'])if(typeof input[k]==='boolean')out[k]=input[k];
  if(['codex-cli','browser'].includes(input.usageSource))out.usageSource=input.usageSource;
  if(['managed','existing'].includes(input.codexConnection))out.codexConnection=input.codexConnection;
  if(Number.isInteger(input.refreshMinutes)&&input.refreshMinutes>=1&&input.refreshMinutes<=1440)out.refreshMinutes=input.refreshMinutes;
  if(typeof input.opacity==='number'&&Number.isFinite(input.opacity))out.opacity=Math.min(1,Math.max(.55,input.opacity));
  if(Number.isInteger(input.glassTint)&&input.glassTint>=0&&input.glassTint<=70)out.glassTint=input.glassTint;
  return out;
}
function allowedSender(event,trusted){
  try{return trusted.has(event.sender)&&event.senderFrame===event.sender.mainFrame&&
    event.senderFrame.url===trusted.get(event.sender)&&!event.sender.isDestroyed();}catch{return false;}
}
module.exports={validSettings,allowedSender};
