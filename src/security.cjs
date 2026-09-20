'use strict';
function validSettings(input,base={alwaysOnTop:true,autoStart:false,notifications:true,opacity:1,autoCheckUpdates:true}){
  const out={...base};if(!input||typeof input!=='object'||Array.isArray(input))return out;
  for(const k of['alwaysOnTop','autoStart','notifications','autoCheckUpdates'])if(typeof input[k]==='boolean')out[k]=input[k];
  if(typeof input.opacity==='number'&&Number.isFinite(input.opacity))out.opacity=Math.min(1,Math.max(.55,input.opacity));
  return out;
}
function allowedSender(event,trusted){
  try{return trusted.has(event.sender)&&event.senderFrame===event.sender.mainFrame&&
    event.senderFrame.url===trusted.get(event.sender)&&!event.sender.isDestroyed();}catch{return false;}
}
module.exports={validSettings,allowedSender};
