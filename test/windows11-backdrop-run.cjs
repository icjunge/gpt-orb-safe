'use strict';

// Test-only launcher for the official unpackaged Electron distribution. A
// packaged GPT-Orb.exe cannot be used as an arbitrary JavaScript CLI launcher.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const output=path.join(root,'dist','windows11-backdrop-diagnostic');
const reportFile=path.join(output,'diagnostic.json');
fs.mkdirSync(output,{recursive:true});

if(process.platform!=='win32'){
  fs.writeFileSync(reportFile,JSON.stringify({status:'unverified',reason:'This diagnostic requires Windows 11 Client.'},null,2)+'\n');
}else{
  if(process.arch!=='x64')throw new Error('The Windows 11 compatibility diagnostic requires x64 Node.');
  const electronPackage=require('../node_modules/electron/package.json');
  if(electronPackage.version!==require('../package.json').devDependencies.electron)throw new Error('The Electron package does not match the pinned application version.');
  const executable=path.join(root,'node_modules','electron','dist','electron.exe');
  if(!fs.existsSync(executable))throw new Error('The official unpackaged Electron runtime is missing.');
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'gpt-orb-win11-backdrop-'));
  try{
    fs.rmSync(reportFile,{force:true});
    const env={...process.env,GPT_ORB_BACKDROP_OUTPUT:output,GPT_ORB_BACKDROP_PROFILE:profile,GPT_ORB_BACKDROP_TIMEOUT_MS:'45000'};
    delete env.ELECTRON_RUN_AS_NODE;
    const result=spawnSync(executable,[path.join(__dirname,'windows-backdrop-smoke.cjs')],
      {env,timeout:48000,shell:false,stdio:'inherit',windowsHide:false});
    if(result.error?.code==='ETIMEDOUT'){
      const report={status:'unverified',reason:'The Windows 11 desktop fixture did not finish within 48 seconds.'};
      fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n');
      console.log(`Native backdrop diagnostic: ${report.status}. ${report.reason}`);
    }else if(result.error){throw result.error;}
    else if(result.status!==0){process.exitCode=result.status||1;}
    else if(!fs.existsSync(reportFile)){throw new Error('The Windows 11 fixture exited without a diagnostic report.');}
  }finally{
    fs.rmSync(profile,{recursive:true,force:true,maxRetries:2,retryDelay:200});
  }
}
