'use strict';
// Run on the maintainer's own computer. This module never creates a repository,
// publishes a release, commits code, or configures a global Git credential helper.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const ENVIRONMENT = 'release';
const SECRET = 'ORB_UPDATE_PRIVATE_KEY';
class SetupError extends Error {}
function stop(message) { throw new SetupError(message); }
function defaultRun(command,args,options) {
  return spawnSync(command,args,{cwd:options.cwd,input:options.input,encoding:'utf8',shell:false,timeout:60000,maxBuffer:2*1024*1024,windowsHide:true,
    env:{...process.env,GH_HOST:'github.com',GH_DEBUG:'',DEBUG:'',GIT_TRACE:'0',GIT_TRACE_CURL:'0',GIT_CURL_VERBOSE:'0'}});
}
function parseOrigin(value) {
  const match=/^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}?)(?:\.git)?$/.exec(value);
  if(!match) stop('origin 必须是 github.com 的普通 HTTPS 或 SSH 地址，且不能带账号密码。');
  return match[1];
}
function parseArgs(argv) {
  let repository=null,keyFile=null,dryRun=false;
  for(let i=0;i<argv.length;i++) {
    const value=argv[i];
    if(value==='--dry-run') dryRun=true;
    else if(value==='--key-file' && argv[i+1]) keyFile=argv[++i];
    else if(!value.startsWith('-') && !repository) repository=value;
    else stop('用法：npm run release:setup -- [OWNER/REPO] [--dry-run] [--key-file 绝对路径]');
  }
  if(repository && !REPOSITORY.test(repository)) stop('仓库名必须是 OWNER/REPO。');
  if(keyFile && !path.isAbsolute(keyFile)) stop('--key-file 必须使用仓库外的绝对路径。');
  return {repository,keyFile,dryRun};
}
function inside(file,directory) { const relative=path.relative(directory,file);return relative==='' || (!relative.startsWith('..'+path.sep) && relative!=='..' && !path.isAbsolute(relative)); }
function assertNoLinks(file) {
  const absolute=path.resolve(file),root=path.parse(absolute).root;
  let current=root;
  for(const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current=path.join(current,part);
    try { if(fs.lstatSync(current).isSymbolicLink()) stop('密钥路径不能经过符号链接或目录联接。'); }
    catch(error) { if(error.code==='ENOENT') return;throw error; }
  }
}
function keyAt(file) {
  if(!fs.existsSync(file)) return null;
  assertNoLinks(file);
  const stat=fs.lstatSync(file);
  if(!stat.isFile() || stat.nlink!==1 || stat.size>16384 || (process.platform!=='win32' && (stat.mode&0o077)!==0)) stop('现有密钥文件的类型或访问权限不安全；请先检查，不会覆盖它。');
  let key;
  try {key=crypto.createPrivateKey(fs.readFileSync(file));} catch {stop('现有密钥无法读取；不会重新生成或覆盖。');}
  if(key.asymmetricKeyType!=='ed25519') stop('现有密钥不是 Ed25519；不会覆盖。');
  return key;
}
function publicPem(key) {return crypto.createPublicKey(key).export({type:'spki',format:'pem'}).toString();}
function canonicalPublic(value) {
  try {const key=crypto.createPublicKey(value);if(key.asymmetricKeyType!=='ed25519') stop('固定公钥不是 Ed25519。');return key.export({type:'spki',format:'pem'}).toString();}
  catch(error) {if(error instanceof SetupError)throw error;stop('update-config.json 公钥无效。');}
}
function readConfig(file) {
  let config;
  try {config=JSON.parse(fs.readFileSync(file,'utf8'));} catch {stop('无法读取 update-config.json。');}
  if(!config || Object.keys(config).sort().join(',')!=='channel,publicKey,repository,schema' || config.schema!==1 || config.channel!=='stable'
    || !((config.repository===null&&config.publicKey===null)||(REPOSITORY.test(config.repository||'')&&typeof config.publicKey==='string'))) stop('更新配置格式无效。');
  if(config.publicKey) canonicalPublic(config.publicKey);
  return config;
}
function environmentMatches(env,user) {
  if(!env || env.name!==ENVIRONMENT
    || env.deployment_branch_policy?.protected_branches!==false || env.deployment_branch_policy?.custom_branch_policies!==true
    || !Array.isArray(env.protection_rules)) return false;
  const reviews=env.protection_rules.filter(rule=>rule.type==='required_reviewers');
  const branches=env.protection_rules.filter(rule=>rule.type==='branch_policy');
  return reviews.length===1 && branches.length===1 && reviews[0].prevent_self_review===false
    && Array.isArray(reviews[0].reviewers) && reviews[0].reviewers.length===1
    && reviews[0].reviewers[0].type==='User' && reviews[0].reviewers[0].reviewer?.id===user.id
    && env.protection_rules.every(rule=>['required_reviewers','branch_policy'].includes(rule.type)||(rule.type==='wait_timer'&&rule.wait_timer===0));
}
function policiesMatch(value,allowEmpty=false) {
  if(!value || !Array.isArray(value.branch_policies) || value.total_count!==value.branch_policies.length) return false;
  return (allowEmpty && value.total_count===0) || (value.total_count===1 && value.branch_policies[0].name==='v*' && value.branch_policies[0].type==='tag');
}
// mode 0600 protects POSIX files. Windows inherits the existing user-profile ACL.
function writeExclusive(file,contents) {const handle=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(handle,contents);fs.fsyncSync(handle);}finally{fs.closeSync(handle);}}
// Classify captured output, but only return fixed labels: subprocess output may contain credentials.
function failureKind(result,remoteCheck) {
  const code=result.error?.code,stderr=typeof result.stderr==='string'?result.stderr:'';
  if(code==='ENOENT') return {label:'未找到所需命令',retry:false};
  if(code==='EACCES'||code==='EPERM') return {label:'本机执行权限不足',retry:false};
  if(/permission denied\s*\(publickey\)/i.test(stderr)) return {label:'SSH 公钥认证失败',retry:false};
  if(/authentication failed|authentication required|authorization failed|could not read (?:username|password)|terminal prompts disabled|invalid (?:username|password|token)|permission denied|access denied|forbidden|repository not found|HTTP(?:\/[0-9.]+)?\s+(?:401|403)\b|(?:returned error|status(?: code)?):?\s*(?:401|403)\b/i.test(stderr)) return {label:'认证或访问权限检查失败',retry:false};
  if(/SSL certificate problem|certificate verify failed|unable to get local issuer certificate|self[- ]signed certificate|server certificate verification failed/i.test(stderr)) return {label:'证书校验失败',retry:false};
  if(code==='ETIMEDOUT') return {label:'子命令超时（等待超过 60 秒，可能是网络或凭据等待）',retry:false};
  if(remoteCheck && !result.error && result.status===2) return {label:'main 引用未返回或未匹配',retry:false};
  if(/could not resolve (?:host|proxy)|temporary failure in name resolution|failed to connect|connection timed out|operation timed out|connection reset|connection was reset|TLS connection was non-properly terminated/i.test(stderr)) return {label:'网络连接失败',retry:true};
  return {label:'子命令未成功完成',retry:false};
}
function operationName(command,args) {
  if(command==='git') return ['rev-parse','remote','symbolic-ref','status','ls-remote'].includes(args[0])?'git '+args[0]:'git';
  if(command==='gh') return args[0]==='api'?'gh api':args[0]==='secret'&&args[1]==='set'?'gh secret set':'gh';
  return '子命令';
}
function setupRelease({project=path.resolve(__dirname,'..'),argv=process.argv.slice(2),home=os.homedir(),run=defaultRun,log=console.log}={}) {
  project=fs.realpathSync(project);
  const options=parseArgs(argv);
  if(process.platform==='win32') {
    if(options.keyFile) stop('Windows 版本不支持 --key-file；私钥只能保存到当前用户主目录的默认位置。');
    if(!/^[A-Za-z]:[\\/]/.test(home) || /^[/\\]{2}/.test(home)) stop('Windows 私钥不能使用 UNC 或设备形式的主目录；请使用本地用户主目录。');
  }
  let version;
  try {version=JSON.parse(fs.readFileSync(path.join(project,'package.json'),'utf8')).version;} catch {stop('无法读取 package.json 中的版本。');}
  if(typeof version!=='string' || !/^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/.test(version) || version.split('.').some(part=>Number(part)>65535)) stop('发布版本必须是规范的稳定 X.Y.Z，且每段不超过 65535。');
  let phase='初始预检';
  function setPhase(value) {phase=value;log('阶段：'+phase+'。');}
  function call(command,args,input,allow404=false) {
    const remoteCheck=command==='git'&&args.length===4&&args[0]==='ls-remote'&&args[1]==='--exit-code'&&args[2]==='origin'&&args[3]==='refs/heads/main';
    for(let attempt=0;attempt<2;attempt++) {
      const result=run(command,args,{cwd:project,input});
      if(!result.error && result.status===0) return result.stdout||'';
      if(allow404 && !result.error && /\(HTTP 404\)/.test(result.stderr||'')) return null;
      const kind=failureKind(result,remoteCheck),operation=operationName(command,args);
      if(remoteCheck && attempt===0 && kind.retry) {
        log('阶段：'+phase+'；'+operation+' '+kind.label+'，正在重试（仅此一次）。');
        continue;
      }
      const status=Number.isSafeInteger(result.status)?'退出码 '+result.status:'未返回退出码';
      // Never print child stdout/stderr or arbitrary error text, including for failed secret uploads.
      stop('阶段：'+phase+'；'+operation+' 失败：'+kind.label+'（'+status+'）。'+(command==='gh'?'请检查 gh 登录、仓库权限和网络。':'请检查本机 Git 状态、访问权限和网络。')+'底层输出已隐藏。');
    }
  }
  const git=(...args)=>call('git',args).trim();
  function api(endpoint,method='GET',body,allow404=false) {
    const args=['api','--hostname','github.com','--method',method,'-H','Accept: application/vnd.github+json','-H','X-GitHub-Api-Version: 2022-11-28',endpoint];
    if(body!==undefined) args.push('--input','-');
    const value=call('gh',args,body===undefined?undefined:JSON.stringify(body),allow404);
    if(value===null) return null;
    try{return JSON.parse(value);}catch{stop('GitHub 返回了无法核验的数据，已停止。');}
  }
  setPhase('初始预检');
  if(fs.realpathSync(git('rev-parse','--show-toplevel'))!==project) stop('请在此仓库根目录运行。');
  const repository=options.repository||parseOrigin(git('remote','get-url','origin'));
  if(parseOrigin(git('remote','get-url','origin')).toLowerCase()!==repository.toLowerCase()) stop('指定仓库与 origin 不一致。');
  const pushOrigins=git('remote','get-url','--push','--all','origin').split(/\r?\n/);
  if(pushOrigins.length!==1 || parseOrigin(pushOrigins[0]).toLowerCase()!==repository.toLowerCase()) stop('origin 推送地址与目标仓库不一致或存在多个地址；请先检查远端配置。');
  function verifyGit(stage) {
    setPhase(stage);
    if(git('symbolic-ref','--short','HEAD')!=='main') stop('请先切换到 main 分支。');
    if(git('status','--porcelain=v1','--untracked-files=all')) stop('工作区必须干净；请先提交或另行保存现有修改。');
    const local=git('rev-parse','HEAD');
    const remote=git('ls-remote','--exit-code','origin','refs/heads/main');
    const match=/^([a-f0-9]{40,64})\s+refs\/heads\/main$/.exec(remote);
    if(!match || local!==match[1]) stop('本地 main 与远端不同；请先 git pull --ff-only 或处理未推送提交。');
    return local;
  }
  const initialHead=verifyGit('初始 Git 核验');
  const configPath=path.join(project,'update-config.json');
  assertNoLinks(configPath);
  const original=fs.readFileSync(configPath,'utf8'),config=readConfig(configPath);
  if(config.repository && config.repository!==repository) stop('配置已固定其他仓库；不会自动迁移或覆盖。');
  const file=path.resolve(options.keyFile||path.join(home,'.gpt-orb-release-keys',repository.replace('/','--'),'private.pem'));
  if(inside(file,project)) stop('私钥必须保存在仓库目录之外。');
  assertNoLinks(file);
  let key=keyAt(file);
  if(config.publicKey && (!key || publicPem(key)!==canonicalPublic(config.publicKey))) stop('本机密钥与已固定公钥不一致。请恢复原私钥；不会轮换密钥。');
  const receiptFile=file+'.setup.json';
  assertNoLinks(receiptFile);
  let receipt=null;
  if(fs.existsSync(receiptFile)) {try{receipt=JSON.parse(fs.readFileSync(receiptFile,'utf8'));}catch{stop('本地设置恢复记录损坏；请先检查。');}}
  if(receipt && (!key || receipt.schema!==1 || receipt.repository!==repository || receipt.publicKey!==publicPem(key))) stop('本地设置恢复记录与当前仓库/密钥不一致。');
  setPhase('GitHub 权限与发布配置预检');
  const user=api('/user');
  if(!Number.isSafeInteger(user.id) || user.id<=0 || typeof user.login!=='string' || user.type!=='User') stop('需要真实 GitHub 用户登录，不能使用机器人或安装令牌。');
  const repo=api('/repos/'+repository);
  if(repo.full_name?.toLowerCase()!==repository.toLowerCase() || repo.private!==false || repo.visibility!=='public' || repo.archived || repo.disabled || repo.permissions?.admin!==true || repo.default_branch!=='main') stop('需要 main 为默认分支的公开仓库及当前账号的管理权限。');
  const endpoint='/repos/'+repository+'/environments/'+ENVIRONMENT;
  let env=api(endpoint,'GET',undefined,true),policies=null;
  if(env) {
    if(!environmentMatches(env,user)) stop('release 环境已有不同保护规则；不会覆盖。请在 GitHub 设置中检查审核人与保护规则。');
    policies=api(endpoint+'/deployment-branch-policies?per_page=100');
    if(!policiesMatch(policies,true)) stop('release 环境已有不同分支/标签规则；不会覆盖。仅支持标签 v*。');
  }
  const existingSecret=env?api(endpoint+'/secrets/'+SECRET,'GET',undefined,true):null;
  if(existingSecret && !config.publicKey && !receipt) stop('远端已有签名 Secret，但没有可核验的本地固定公钥或恢复记录；不会覆盖。');
  log('只读检查通过：'+repository+'，main 已同步，账号 '+user.login+' 具有管理权限。');
  if(process.platform==='win32') log('Windows 私钥依赖当前用户主目录的既有 ACL；脚本不会设置或核验 ACL，请勿使用共享主目录。');
  if(options.dryRun) {log('预检完成，未创建密钥、修改环境、写入 Secret 或修改文件。');return {dryRun:true,repository,keyExists:!!key,environmentExists:!!env};}
  let secretWriteAttempted=false,secretWriteConfirmed=false;
  try {
    if(verifyGit('写入前 Git 复核')!==initialHead || fs.readFileSync(configPath,'utf8')!==original) stop('检查过程中仓库发生变化；未继续设置。');
    setPhase('准备受保护的发布环境');
    // No secret is generated or uploaded until the environment protections can be read back.
    if(!env) {
      api(endpoint,'PUT',{wait_timer:0,prevent_self_review:false,reviewers:[{type:'User',id:user.id}],deployment_branch_policy:{protected_branches:false,custom_branch_policies:true}});
      env=api(endpoint);
      if(!environmentMatches(env,user)) stop('GitHub 未确认预期环境保护，未创建或上传密钥。');
      policies=api(endpoint+'/deployment-branch-policies?per_page=100');
    }
    if(!policiesMatch(policies,true)) stop('环境标签策略发生变化；未创建或上传密钥。');
    if(policies.total_count===0) api(endpoint+'/deployment-branch-policies','POST',{name:'v*',type:'tag'});
    function verifyEnvironment() {
      if(!environmentMatches(api(endpoint),user)||!policiesMatch(api(endpoint+'/deployment-branch-policies?per_page=100'))) stop('环境保护未通过再次核验；不会继续写入签名配置。');
    }
    verifyEnvironment();
    setPhase('准备本机签名密钥');
    assertNoLinks(file);
    if(!key) {
      fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});assertNoLinks(file);
      key=crypto.generateKeyPairSync('ed25519').privateKey;
      writeExclusive(file,key.export({type:'pkcs8',format:'pem'}));
    }
    const publicKey=publicPem(key);
    if(config.publicKey && canonicalPublic(config.publicKey)!==publicKey) stop('公钥不一致；未上传 Secret。');
    if(!receipt) writeExclusive(receiptFile,JSON.stringify({schema:1,repository,publicKey},null,2)+'\n');
    verifyEnvironment();
    // gh encrypts stdin locally. The key is never an argument, shell command, log, or repository file.
    setPhase('写入 GitHub 签名 Secret');
    secretWriteAttempted=true;
    call('gh',['secret','set',SECRET,'--env',ENVIRONMENT,'--repo','https://github.com/'+repository],key.export({type:'pkcs8',format:'pem'}).toString());
    secretWriteConfirmed=true;
    verifyEnvironment();
    const uploaded=api(endpoint+'/secrets/'+SECRET);
    if(uploaded.name!==SECRET) stop('无法确认环境 Secret 已写入；本地私钥已保留，可重试。');
    if(verifyGit('最终 Git 复核')!==initialHead || fs.readFileSync(configPath,'utf8')!==original) stop('设置过程中仓库发生变化；Secret 已写入，公钥配置未覆盖，可恢复后重试。');
    const next=JSON.stringify({schema:1,repository,publicKey,channel:'stable'},null,2)+'\n';
    assertNoLinks(configPath);
    const temporary=path.join(project,'.update-config.setup-'+crypto.randomBytes(8).toString('hex'));
    writeExclusive(temporary,next);
    try {fs.renameSync(temporary,configPath);} catch(error) {try{fs.unlinkSync(temporary);}catch{}throw error;}
    const fingerprint=crypto.createHash('sha256').update(crypto.createPublicKey(key).export({type:'spki',format:'der'})).digest('hex');
    log('已配置受保护的 release 环境；私钥保存在本机仓库外，并写入 GitHub 环境 Secret 供发布签名使用。');
    log('请在 GitHub → Settings → Environments → release 检查管理员绕过保护的开关；本脚本未设置或核验该开关。');
    log('请备份私钥文件：'+file);log('公钥 SHA256：'+fingerprint);
    log('仅 update-config.json 待提交。检查后依次执行：');
    log('git add -- update-config.json');
    log('git commit --only -m "Configure signed updates" -- update-config.json');
    log('git push origin main');
    log('确认上述提交已成功推送后，再执行：');
    log('git tag v'+version);
    log('git push origin v'+version);
    log('在 Actions 审批 release： https://github.com/'+repository+'/actions/workflows/release.yml');
    log('审批后签名并核验资产，通过后自动正式发布： https://github.com/'+repository+'/releases');
    log('本脚本没有执行这些 Git 命令，也没有发布安装包。');
    return {dryRun:false,repository,fingerprint,keyFile:file};
  } catch(error) {
    if(secretWriteConfirmed) log('恢复提示：GitHub CLI 已报告签名 Secret 上传成功，但后续步骤未完成。请保留原私钥、恢复记录及现有配置，解决错误后使用同一密钥重试；本脚本未提交代码或发布版本。');
    else if(secretWriteAttempted) log('恢复提示：本次已尝试写入签名 Secret，但结果尚未确认。请保留原私钥和恢复记录，解决错误后使用同一密钥重试；不要重新生成密钥。本脚本未提交代码或发布版本。');
    else log('恢复提示：本次尚未尝试写入签名 Secret。发布环境或本机密钥可能已准备，请保留已有内容；本脚本未提交代码或发布版本。');
    throw error;
  }
}
if(require.main===module) {
  try{setupRelease();}catch(error){console.error(error instanceof SetupError?error.message:'设置未完成。未回显底层输出；请检查本机文件权限、gh 登录和 Git 状态后重试。');process.exitCode=1;}
}
module.exports={setupRelease,parseOrigin,environmentMatches,policiesMatch,SetupError};
