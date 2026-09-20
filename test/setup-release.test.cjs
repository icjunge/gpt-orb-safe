'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {setupRelease,parseOrigin}=require('../scripts/setup-release.cjs');
const REPO='icjunge/gpt-orb-safe',HEAD='a'.repeat(40),USER={id:123,login:'icjunge',type:'User'};
function environment(){return {name:'release',deployment_branch_policy:{protected_branches:false,custom_branch_policies:true},protection_rules:[{type:'required_reviewers',prevent_self_review:false,reviewers:[{type:'User',reviewer:USER}]},{type:'branch_policy'}]};}
function fixture(t,changes={}) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'orb-setup-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const project=path.join(root,'project'),home=path.join(root,'home');fs.mkdirSync(project);fs.mkdirSync(home);
 fs.writeFileSync(path.join(project,'package.json'),JSON.stringify({version:'2.1.0'}));
 const config={schema:1,repository:null,publicKey:null,channel:'stable'};fs.writeFileSync(path.join(project,'update-config.json'),JSON.stringify(config,null,2)+'\n');
 const state={branch:'main',status:'',head:HEAD,remoteHead:HEAD,origin:'https://github.com/'+REPO+'.git',user:USER,repo:{full_name:REPO,private:false,visibility:'public',archived:false,disabled:false,permissions:{admin:true},default_branch:'main'},environment:null,policies:{total_count:0,branch_policies:[]},secret:false,failSecret:false,calls:[],logs:[],secretInput:null,...changes};
 const ok=value=>({status:0,stdout:typeof value==='string'?value:JSON.stringify(value),stderr:''});
 function run(command,args,options) {
  const secret=command==='gh'&&args[0]==='secret';state.calls.push({command,args:[...args],input:secret?'[redacted]':options.input});
  if(command==='git') {
   if(args.join(' ')==='rev-parse --show-toplevel')return ok(project);
   if(args.join(' ')==='remote get-url origin')return ok(state.origin);
   if(args.join(' ')==='remote get-url --push --all origin')return ok(state.pushOrigin||state.origin);
   if(args.join(' ')==='symbolic-ref --short HEAD')return ok(state.branch);
   if(args[0]==='status')return ok(state.status);
   if(args.join(' ')==='rev-parse HEAD')return ok(state.head);
   if(args[0]==='ls-remote')return ok(state.remoteHead+'\trefs/heads/main');
   assert.fail('Unexpected Git mutation or command: '+args.join(' '));
  }
  assert.equal(command,'gh');
  if(secret) {
   assert.deepEqual(args,['secret','set','ORB_UPDATE_PRIVATE_KEY','--env','release','--repo','https://github.com/'+REPO]);
   assert.equal(state.policies.branch_policies[0].type,'tag');
   state.secretInput=options.input;state.secret=true;
   if(state.failSecret)return {status:1,stdout:options.input,stderr:options.input};
   return ok('');
  }
  assert.equal(args[args.indexOf('--hostname')+1],'github.com');
  const endpoint=args.find(v=>v.startsWith('/')),method=args[args.indexOf('--method')+1];
  const body=options.input?JSON.parse(options.input):undefined;
  if(endpoint==='/user')return ok(state.user);
  if(endpoint==='/repos/'+REPO)return ok(state.repo);
  const base='/repos/'+REPO+'/environments/release';
  if(endpoint===base) {
   if(method==='GET')return state.environment?ok(state.environment):{status:1,stdout:'',stderr:'gh: Not Found (HTTP 404)'};
   assert.equal(method,'PUT');assert.deepEqual(body,{wait_timer:0,prevent_self_review:false,reviewers:[{type:'User',id:123}],deployment_branch_policy:{protected_branches:false,custom_branch_policies:true}});state.environment=environment();state.afterEnvironmentPut?.();return ok(state.environment);
  }
  if(endpoint===base+'/deployment-branch-policies?per_page=100')return ok(state.policies);
  if(endpoint===base+'/deployment-branch-policies') {assert.equal(method,'POST');assert.deepEqual(body,{name:'v*',type:'tag'});state.policies={total_count:1,branch_policies:[{id:9,...body}]};return ok(state.policies.branch_policies[0]);}
  if(endpoint===base+'/secrets/ORB_UPDATE_PRIVATE_KEY')return state.secret?ok({name:'ORB_UPDATE_PRIVATE_KEY'}):{status:1,stdout:'',stderr:'gh: Not Found (HTTP 404)'};
  assert.fail('Unexpected API request: '+endpoint);
 }
 function execute(argv=[]) {return setupRelease({project,home,argv,run,log:value=>state.logs.push(value)});}
 const keyFile=path.join(home,'.gpt-orb-release-keys','icjunge--gpt-orb-safe','private.pem');
 return {root,project,home,state,execute,keyFile,configPath:path.join(project,'update-config.json')};
}
function mutations(state){return state.calls.filter(c=>c.command==='gh'&&(c.args[0]==='secret'||['PUT','POST','DELETE','PATCH'].includes(c.args[c.args.indexOf('--method')+1])));}
test('dry run checks public repository and clean synchronized main with zero writes',t=>{
 const f=fixture(t);const before=fs.readFileSync(f.configPath,'utf8');const result=f.execute(['--dry-run']);assert.equal(result.dryRun,true);assert.equal(mutations(f.state).length,0);assert.equal(fs.existsSync(f.keyFile),false);assert.equal(fs.readFileSync(f.configPath,'utf8'),before);
});
test('setup protects environment before stdin-only secret upload and pins matching public key',t=>{
 const f=fixture(t);f.execute();const secret=fs.readFileSync(f.keyFile,'utf8');const config=JSON.parse(fs.readFileSync(f.configPath));
 assert.equal(config.repository,REPO);assert.equal(config.publicKey,crypto.createPublicKey(secret).export({type:'spki',format:'pem'}).toString());assert.equal(f.state.secretInput,secret);
 assert.equal(mutations(f.state).map(c=>c.args[0]==='secret'?'secret':c.args[c.args.indexOf('--method')+1]).join(','),'PUT,POST,secret');
 assert(!f.state.logs.join('\n').includes('BEGIN PRIVATE KEY'));assert(!f.state.calls.some(c=>c.args.some(arg=>arg.includes('BEGIN PRIVATE KEY'))));
 if(process.platform!=='win32')assert.equal(fs.statSync(f.keyFile).mode&0o077,0);
 assert.equal(fs.existsSync(path.join(f.project,'private.pem')),false);
 assert(f.state.logs.includes('git tag v2.1.0'));assert(f.state.logs.includes('git push origin v2.1.0'));
 const beforeKey=secret;f.state.calls=[];f.execute();assert.equal(fs.readFileSync(f.keyFile,'utf8'),beforeKey);assert.equal(mutations(f.state).length,1);
});
test('different existing environment rules or broader tag policy stop without overwrite',t=>{
 for(const variant of ['reviewer','self-review','branch-policy','extra-rule']) {
  const f=fixture(t,{environment:environment(),policies:{total_count:1,branch_policies:[{name:'v*',type:'tag'}]}});
  if(variant==='reviewer')f.state.environment.protection_rules[0].reviewers=[{type:'User',reviewer:{id:999}}];
  if(variant==='self-review')f.state.environment.protection_rules[0].prevent_self_review=true;
  if(variant==='branch-policy')f.state.policies.branch_policies[0].type='branch';
  if(variant==='extra-rule')f.state.environment.protection_rules.push({type:'custom'});
  assert.throws(()=>f.execute(),/不会覆盖/);assert.equal(mutations(f.state).length,0);assert.equal(fs.existsSync(f.keyFile),false);
 }
});
test('dirty tree, wrong branch, diverged main, wrong origin, private repo and non-admin fail preflight',t=>{
 const cases=[{status:' M README.md'},{branch:'topic'},{remoteHead:'b'.repeat(40)},{origin:'https://evil.example/icjunge/gpt-orb-safe.git'},{pushOrigin:'https://github.com/other/repo.git'},{repo:{full_name:REPO,private:true,visibility:'private',permissions:{admin:true},default_branch:'main'}},{repo:{full_name:REPO,private:false,visibility:'public',permissions:{admin:false},default_branch:'main'}}];
 for(const scenario of cases){const f=fixture(t,scenario);assert.throws(()=>f.execute());assert.equal(mutations(f.state).length,0);assert.equal(fs.existsSync(f.keyFile),false);}
});
test('mismatched pinned public key cannot change environment or overwrite existing key',t=>{
 const f=fixture(t);fs.mkdirSync(path.dirname(f.keyFile),{recursive:true});const old=crypto.generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'});fs.writeFileSync(f.keyFile,old,{mode:0o600});
 const different=crypto.generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}).toString();fs.writeFileSync(f.configPath,JSON.stringify({schema:1,repository:REPO,publicKey:different,channel:'stable'}));
 assert.throws(()=>f.execute(),/恢复原私钥/);assert.equal(mutations(f.state).length,0);assert.equal(fs.readFileSync(f.keyFile,'utf8'),old.toString());
});
test('an existing unpinned remote secret is never overwritten',t=>{
 const f=fixture(t,{environment:environment(),policies:{total_count:1,branch_policies:[{name:'v*',type:'tag'}]},secret:true});assert.throws(()=>f.execute(),/不会覆盖/);assert.equal(mutations(f.state).length,0);assert.equal(fs.existsSync(f.keyFile),false);
});
test('interrupted secret upload hides child output and safely retries with the same local key',t=>{
 const f=fixture(t,{failSecret:true});const configBefore=fs.readFileSync(f.configPath,'utf8');assert.throws(()=>f.execute(),error=>{assert(!error.message.includes('PRIVATE KEY'));return /输出已隐藏/.test(error.message);});
 const originalKey=fs.readFileSync(f.keyFile,'utf8');assert.equal(fs.readFileSync(f.configPath,'utf8'),configBefore);assert.equal(fs.existsSync(f.keyFile+'.setup.json'),true);assert.equal(f.state.secret,true);
 f.state.failSecret=false;f.execute();assert.equal(fs.readFileSync(f.keyFile,'utf8'),originalKey);assert(!f.state.logs.join('\n').includes(originalKey));
});
test('default key directory cannot traverse a symlink or Windows directory junction',t=>{
 const f=fixture(t),outside=path.join(f.root,'outside');fs.mkdirSync(outside);
 fs.symlinkSync(outside,path.join(f.home,'.gpt-orb-release-keys'),process.platform==='win32'?'junction':'dir');
 assert.throws(()=>f.execute(),/符号链接/);assert.equal(mutations(f.state).length,0);assert.equal(fs.readdirSync(outside).length,0);
});
test('POSIX custom key paths reject repository paths, symlinks and unsafe permissions',{skip:process.platform==='win32'},t=>{
 const f=fixture(t);assert.throws(()=>f.execute(['--key-file',path.join(f.project,'private.pem')]),/仓库目录之外/);assert.equal(mutations(f.state).length,0);
 const outside=path.join(f.root,'outside');fs.mkdirSync(outside);const linked=path.join(f.home,'linked');fs.symlinkSync(outside,linked,'dir');assert.throws(()=>f.execute(['--key-file',path.join(linked,'private.pem')]),/符号链接/);
 fs.mkdirSync(path.dirname(f.keyFile),{recursive:true});fs.writeFileSync(f.keyFile,crypto.generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o644});assert.throws(()=>f.execute(),/访问权限不安全/);
});
test('Windows forbids every custom key path and UNC or device home before any command',{skip:process.platform!=='win32'},t=>{
 const f=fixture(t);
 for(const file of [path.join(f.project,'private.pem'),path.join(f.root,'shared','private.pem'),f.keyFile]) assert.throws(()=>f.execute(['--key-file',file]),/不支持 --key-file/);
 for(const home of ['\\\\server\\share\\user','//server/share/user','\\\\?\\C:\\Users\\owner','C:relative-home']) {
  assert.throws(()=>setupRelease({project:f.project,argv:[],home,run:()=>assert.fail('Must not run commands for a network home'),log:()=>{}}),/主目录/);
 }
 assert.equal(f.state.calls.length,0);assert.equal(fs.existsSync(f.keyFile),false);
});
test('origin parser accepts only exact GitHub origins and never credential-bearing URLs',()=>{
 assert.equal(parseOrigin('https://github.com/'+REPO+'.git'),REPO);assert.equal(parseOrigin('git@github.com:'+REPO+'.git'),REPO);
 for(const value of ['https://token@github.com/'+REPO,'https://github.com.evil/'+REPO,'https://github.com/'+REPO+'?x=1','ssh://git@github.com/'+REPO])assert.throws(()=>parseOrigin(value));
});

test('environment creation must read back the promised reviewer before any key is generated',t=>{
 const f=fixture(t);f.state.afterEnvironmentPut=()=>{f.state.environment.protection_rules[0].reviewers=[];};
 assert.throws(()=>f.execute(),/未确认预期环境保护/);assert.equal(fs.existsSync(f.keyFile),false);assert.equal(f.state.secret,false);assert.equal(mutations(f.state).length,1);
});

test('tag instructions require a canonical bounded stable package version before any command',t=>{
 for(const version of ['2.1.0-beta.1','02.1.0','2.1.0; echo bad','65536.0.0',null]){
  const f=fixture(t);fs.writeFileSync(path.join(f.project,'package.json'),JSON.stringify({version}));
  assert.throws(()=>f.execute(),/发布版本/);assert.equal(f.state.calls.length,0);assert.equal(fs.existsSync(f.keyFile),false);
 }
});
