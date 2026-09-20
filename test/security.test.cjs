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
  assert.deepEqual(result,{alwaysOnTop:true,autoStart:true,notifications:true,opacity:1,autoCheckUpdates:true,
    usageSource:'codex-cli',codexEnabled:false,refreshMinutes:5});
  assert.equal(validSettings({opacity:0}).opacity,.55);
  assert.equal(validSettings({opacity:5}).opacity,1);
});
test('native preferences reject commands, credentials, arbitrary sources and invalid intervals',()=>{
  const defaults=validSettings({});
  for(const input of [{usageSource:'file:///evil'}, {refreshMinutes:0}, {refreshMinutes:1441},
    {refreshMinutes:1.5}, {refreshMinutes:'5'}, {codexEnabled:'true'},
    {executable:'evil.exe',args:['turn/start'],accessToken:'secret'}])assert.deepEqual(validSettings(input),defaults);
  assert.equal(validSettings({usageSource:'browser'}).usageSource,'browser');
  assert.equal(validSettings({refreshMinutes:1440}).refreshMinutes,1440);
  assert.equal(validSettings({codexEnabled:true}).codexEnabled,true);
});
