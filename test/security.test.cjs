'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {allowedSender,validSettings}=require('../src/security.cjs');
test('IPC requires registered webContents, its exact main frame and canonical local URL',()=>{
  const mainFrame={url:'file:///app/ui/panel.html'},sender={mainFrame,isDestroyed:()=>false},trusted=new Map([[sender,mainFrame.url]]);
  assert.equal(allowedSender({sender,senderFrame:mainFrame},trusted),true);
  assert.equal(allowedSender({sender,senderFrame:{url:mainFrame.url}},trusted),false);
  mainFrame.url='https://chatgpt.com/';assert.equal(allowedSender({sender,senderFrame:mainFrame},trusted),false);
  assert.equal(allowedSender({sender:{...sender},senderFrame:mainFrame},trusted),false);
  assert.equal(allowedSender({},trusted),false);
});
test('preferences accept only typed display settings and never arbitrary data',()=>{
  const result=validSettings({alwaysOnTop:'false',opacity:Infinity,token:'secret',autoStart:true});
  assert.deepEqual(result,{alwaysOnTop:true,autoStart:true,notifications:true,opacity:1,autoCheckUpdates:true});
  assert.equal(validSettings({opacity:0}).opacity,.55);
  assert.equal(validSettings({opacity:5}).opacity,1);
});
