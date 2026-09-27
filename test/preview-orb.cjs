'use strict';
// Offline art-review sheet made from the production orb HTML/CSS/JS.
// Fixture data/backgrounds only; this is not a desktop-compositor capture.
// Run with Electron. Output stays outside the application package.
const {app, BrowserWindow, ipcMain} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = process.env.GPT_ORB_PREVIEW_OUTPUT || path.join(root, 'dist', 'orb-preview');
const ui = path.join(root, 'src', 'ui');
const read = name => fs.readFileSync(path.join(ui, name), 'utf8');
const font = fs.readFileSync(path.join(root, 'assets/fonts/InterVariable.woff2')).toString('base64');
const chinese = process.env.GPT_ORB_PREVIEW_FONT;
const fontCss = `@font-face{font-family:Inter;src:url(data:font/woff2;base64,${font})} ` +
  (chinese ? `@font-face{font-family:PreviewChinese;src:url(file://${chinese})}` : '') +
  ':root{--font-ui:Inter,PreviewChinese,"PingFang SC","Microsoft YaHei UI",sans-serif}';
const escape = text => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
function orb(remaining, scale, expanded = false, id = '') {
  const state = {status:'ready',usageSource:'codex-cli',settings:{usageSource:'codex-cli'},
    appearance:{},codex:{state:'ready',enabled:true,lastSuccessAt:Date.now()},
    snapshot:remaining === null ? null : {source:'codex-cli',capturedAt:Date.now(),windows:[
      {kind:'session',label:'当前时段',usedPercent:100-remaining,resetAt:Date.now()+7200000}]}};
  const fixture = `window.orb={getState:async()=>(${JSON.stringify(state)}),onState:()=>{},action:async(name,payload)=>({ok:true,expanded:payload?.expanded,moved:false})};`;
  let html = read('orb.html').replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
    .replace('<link rel="stylesheet" href="fonts.css">', `<style>${fontCss}</style>`)
    .replace('<link rel="stylesheet" href="orb.css">', `<style>${read('orb.css')}</style>`)
    .replace('<script src="orb.js"></script>', `<script>${fixture}\n${read('orb.js')}\nPromise.resolve().then(()=>document.getElementById('orb').dataset.expanded='${expanded}');</script>`);
  return `<div class="orb-stage" style="width:${56*scale}px;height:${56*scale}px"><iframe ${id?`id="${id}"`:''} title="示例剩余 ${remaining===null?'未知':remaining+'%'}" style="transform:scale(${scale})" srcdoc="${escape(html)}"></iframe></div>`;
}
function documentHtml(motion = false) {
  const design = `
    *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}
    body{font-family:var(--font-ui);color:#18202d;background:#f2f3f5;font-weight:400}
    iframe{color-scheme:dark;border:0;background:transparent;width:56px;height:56px;transform-origin:0 0;display:block;pointer-events:none}
    .orb-stage{position:relative;flex-shrink:0}.eyebrow{font-size:13px;letter-spacing:3px;color:#727987;font-weight:500}
    header{padding:48px 64px 32px;display:flex;align-items:end;justify-content:space-between}
    h1{font-size:38px;letter-spacing:-1px;line-height:1.35;margin:12px 0 0;font-weight:500}
    .meta{font-size:14px;color:#838997;line-height:1.8;text-align:right}
    .layout{margin:0 64px;display:grid;grid-template-columns:1.36fr 1fr;gap:24px}
    .scene{position:relative;overflow:hidden;border-radius:36px;background:#223344;height:565px;color:#fff}
    .scene:before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse at 75% 82%,#bc8e7766,transparent 58%),radial-gradient(ellipse at 10% 10%,#92b9c975,transparent 60%),linear-gradient(135deg,#263d4e,#403c4a 60%,#182831)}
    .scene-label{position:absolute;top:30px;left:32px;font-size:13px;letter-spacing:2px;color:#f4f7fb9c}
    .hero{position:absolute;inset:70px 0 45px;display:grid;place-items:center}
    .scene-bottom{position:absolute;bottom:29px;left:32px;right:32px;display:flex;justify-content:space-between;font-size:14px;color:#e6ebf2bf}
    .subtle-line{position:absolute;left:0;right:0;top:55%;height:1px;background:#d2dce215}
    .right{display:flex;flex-direction:column;gap:22px}.states,.actual{background:#fff;border-radius:30px;padding:28px 30px}
    h2{font-size:20px;font-weight:500;letter-spacing:-.3px;margin:0}p{font-size:14px;color:#7a8390;line-height:1.7;margin:9px 0 0}
    .state-row{display:flex;justify-content:space-between;margin-top:28px;gap:14px}
    .sample{text-align:center;flex:1}.sample-well{height:139px;border-radius:22px;display:grid;place-items:center;background:linear-gradient(140deg,#6a788a,#344d63 65%,#273a4d)}
    .sample:nth-child(2) .sample-well{background:linear-gradient(145deg,#807c8c,#596c7f 58%,#354c5e)}
    .sample:nth-child(3) .sample-well{background:linear-gradient(145deg,#948e84,#827977 54%,#535769)}
    .sample-label{font-size:13px;color:#7c8490;margin-top:13px}.states{height:307px}
    .actual{flex:1}.actual-row{display:flex;align-items:center;gap:27px;margin-top:22px}
    .desktop-strip{border-radius:20px;background:linear-gradient(125deg,#d3d0cd,#a7b6c0 58%,#849aaf);height:99px;width:188px;display:flex;gap:27px;justify-content:center;align-items:center}
    .actual-copy{font-size:14px;line-height:1.95;color:#707987}.actual-copy strong{font-weight:500;color:#303a48}
    .notes{margin:30px 64px 0;display:grid;grid-template-columns:repeat(3,1fr);gap:32px}
    .note{border-top:1px solid #dcdfe5;padding-top:20px}.note-num{font-size:11px;letter-spacing:1px;color:#89909c;margin-right:10px}
    h3{font-size:17px;font-weight:500;margin:0}.note p{font-size:13px;margin-top:9px;max-width:370px}
    footer{margin:28px 64px 0;font-size:11px;color:#9298a2;letter-spacing:.2px}
    .motion{background:linear-gradient(145deg,#637b90,#273c50 66%,#5b525b);display:grid;place-items:center;color:#fff}
    .motion .motion-title{position:absolute;top:34px;left:38px;font-size:16px;font-weight:500;letter-spacing:.5px}
    .motion .motion-caption{position:absolute;bottom:32px;left:38px;right:38px;font-size:12px;color:#c9d3dd;display:flex;justify-content:space-between}
  `;
  const content = motion ? `<body class="motion"><div class="motion-title">玻璃水位 · 动效预览</div>${orb(64,5,true,'motion-orb')}<div class="motion-caption"><span>轻微起伏，数字保持稳定</span><span>64% · 示例数据</span></div></body>` :
  `<body><header><div><div class="eyebrow">GPT ORB / LIQUID GLASS STUDY</div><h1>玻璃的边缘，流动的余量。</h1></div><div class="meta">界面预览 · 示例数据<br>保留轻量的 48 / 56 px 悬浮球</div></header>
    <div class="layout"><section class="scene"><div class="subtle-line"></div><div class="scene-label">材质放大 · 64% 剩余</div><div class="hero">${orb(64,5.8,true,'hero-orb')}</div><div class="scene-bottom"><span>局部色散 · 弧面高光 · 透光中心</span><span>慢速水波</span></div></section>
    <div class="right"><section class="states"><h2>余量决定水位</h2><p>颜色轻微变化，读数始终清晰。</p><div class="state-row">${[[85,'余量充足'],[38,'持续使用'],[12,'额度偏低']].map(([p,label])=>`<div class="sample"><div class="sample-well">${orb(p,1.8,true)}</div><div class="sample-label">${label}</div></div>`).join('')}</div></section>
    <section class="actual"><h2>回到桌面，依然克制</h2><div class="actual-row"><div class="desktop-strip">${orb(64,1,false)}${orb(64,1,true)}</div><div class="actual-copy"><strong>48 px</strong> 默认 · <strong>56 px</strong> 悬停<br>球内只保留剩余百分比</div></div></section></div></div>
    <div class="notes"><div class="note"><h3><span class="note-num">01</span>弧形折射边缘</h3><p>冷暖色集中在少量弧段，以明暗和厚度勾勒玻璃。</p></div><div class="note"><h3><span class="note-num">02</span>缓慢的水面</h3><p>两层轻微起伏；按剩余比例调整水位，数字不晃动。</p></div><div class="note"><h3><span class="note-num">03</span>安静地常驻</h3><p>隐藏或减少动态时停止运动；没有用量时显示「—」。</p></div></div>
    <footer>实际 HTML / CSS 渲染 · 放大图用于观察材质，48 / 56 px 区域为 1× 排版 · 背景为模拟场景，非 Windows 跨应用折射实测</footer></body>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>GPT Orb Glass Preview</title><style>${fontCss}${design}</style></head>${content}</html>`;
}
async function frameWindow(file,width,height) {
  const w = new BrowserWindow({width,height,show:false,frame:false,webPreferences:{offscreen:true,contextIsolation:true,sandbox:true}});
  await w.loadFile(file);
  w.webContents.debugger.attach('1.3');
  await w.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  await w.webContents.executeJavaScript(`Promise.all([document.fonts.ready,...Array.from(document.querySelectorAll('iframe'),f=>f.contentDocument.fonts.ready)]).then(()=>true)`);
  return w;
}
async function checkProductionPaint() {
  // Load the actual document with its original CSP and preload, separately
  // from the composed art sheet. Never loosen CSP in the distributed app.
  let state;
  ipcMain.handle('test:state',()=>state);
  ipcMain.handle('test:action',(_event,action)=>({ok:true,expanded:action.payload?.expanded,moved:false}));
  const w=new BrowserWindow({width:56,height:56,show:false,frame:false,transparent:true,backgroundColor:'#00000000',
    webPreferences:{offscreen:true,preload:path.join(__dirname,'render-preload.cjs'),contextIsolation:true,sandbox:true}});
  const errors=[];
  w.webContents.on('console-message',(_event,level,message)=>{if(level>=3)errors.push(message);});
  await w.loadFile(path.join(ui,'orb.html'));
  w.webContents.debugger.attach('1.3');
  await w.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:56,height:56,deviceScaleFactor:1,mobile:false});
  const samples=[];
  for(const remaining of [100,64,12,0,null]){
    state={status:'ready',settings:{usageSource:'codex-cli'},codex:{enabled:true,state:'ready',lastSuccessAt:Date.now()},
      snapshot:remaining===null?null:{source:'codex-cli',capturedAt:Date.now(),windows:[{usedPercent:100-remaining}]}};
    w.webContents.send('test:update',state);
    await new Promise(r=>setTimeout(r,80));
    assert.equal(await w.webContents.executeJavaScript("document.getElementById('orb-value').textContent"),remaining===null?'—':`${remaining}%`);
    const shot=await w.webContents.capturePage({x:0,y:0,width:56,height:56});
    const {width,height}=shot.getSize(),pixels=shot.toBitmap();
    assert.equal(width,56);assert.equal(height,56);
    const corners=[[0,0],[55,0],[0,55],[55,55]].map(([x,y])=>pixels[(y*width+x)*4+3]);
    assert(corners.every(alpha=>alpha===0),'Actual orb document has an opaque corner.');
    const fillAlpha=pixels[(15*width+28)*4+3];
    assert(fillAlpha>0&&fillAlpha<180,'Actual glass fill must transmit the background.');
    samples.push({remaining,corners,fillAlpha});
  }
  await w.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  assert.equal(await w.webContents.executeJavaScript("getComputedStyle(document.querySelector('.orb-wave')).animationName"),'none');
  await w.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'forced-colors',value:'active'}]});
  assert.equal(await w.webContents.executeJavaScript("getComputedStyle(document.querySelector('.orb-optics')).display"),'none');
  assert.deepEqual(errors,[],'Production orb emitted renderer/CSP errors.');
  w.destroy();ipcMain.removeHandler('test:state');ipcMain.removeHandler('test:action');
  return {originalCsp:true,cornerAlpha:samples,reducedMotion:true,forcedColors:true,rendererErrors:errors};
}
app.disableHardwareAcceleration();
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
  fs.mkdirSync(output,{recursive:true});
  const productionPaint=await checkProductionPaint();
  const board = path.join(output,'orb-glass-preview.html'), motion = path.join(output,'orb-wave-preview.html');
  fs.writeFileSync(board,documentHtml());fs.writeFileSync(motion,documentHtml(true));
  const w = await frameWindow(board,1540,990);
  await new Promise(r=>setTimeout(r,700));
  const checks = await w.webContents.executeJavaScript(`Array.from(document.querySelectorAll('iframe'),f=>({value:f.contentDocument.getElementById('orb-value').textContent,width:f.contentDocument.getElementById('orb').getBoundingClientRect().width}))`);
  assert.deepEqual(checks.map(x=>x.value),['64%','85%','38%','12%','64%','64%']);
  assert.deepEqual(checks.map(x=>x.width),[56,56,56,56,48,56]);
  fs.writeFileSync(path.join(output,'GPT-Orb-Glass-Preview.png'),(await w.webContents.capturePage()).toPNG());
  w.destroy();
  const m = await frameWindow(motion,640,530);
  await new Promise(r=>setTimeout(r,400));
  const frames = path.join(output,'frames');fs.mkdirSync(frames,{recursive:true});
  const animations = await m.webContents.executeJavaScript(`document.querySelector('iframe').contentDocument.getAnimations().length`);
  assert(animations>0,'The real orb must have wave animations.');
  for(let n=0;n<72;n++){
    await m.webContents.executeJavaScript(`document.querySelector('iframe').contentDocument.getAnimations().forEach(a=>{a.pause();a.currentTime=${n*1000/12};})`);
    m.webContents.invalidate();
    await new Promise(r=>setTimeout(r,20));
    fs.writeFileSync(path.join(frames,`${String(n).padStart(3,'0')}.png`),(await m.webContents.capturePage()).toPNG());
  }
  fs.writeFileSync(path.join(output,'preview-checks.json'),JSON.stringify({scope:'Production orb renderer with offline fixture data and simulated background',productionPaint,checks,animations,frames:72},null,2));
  console.log('Orb preview: production values and 48/56 geometry verified; board and 72 wave frames captured.');
  m.destroy();app.quit();
}).catch(error=>{console.error(error.stack);app.exit(1);});
