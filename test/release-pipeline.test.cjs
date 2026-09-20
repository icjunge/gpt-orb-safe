'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
function fixture(t) {
  const project=fs.mkdtempSync(path.join(os.tmpdir(),'orb-release-test-'));
  t.after(()=>fs.rmSync(project,{recursive:true,force:true}));
  fs.mkdirSync(path.join(project,'scripts'));fs.mkdirSync(path.join(project,'dist'));
  for(const name of ['sign-release.cjs','configure-release.cjs','generate-signing-key.cjs']) fs.copyFileSync(path.join(__dirname,'../scripts',name),path.join(project,'scripts',name));
  fs.writeFileSync(path.join(project,'package.json'),JSON.stringify({version:'2.1.0'}));
  const keys=crypto.generateKeyPairSync('ed25519');
  const config={schema:1,repository:'fixture-owner/fixture-repo',publicKey:keys.publicKey.export({type:'spki',format:'pem'}).toString(),channel:'stable'};
  fs.writeFileSync(path.join(project,'update-config.json'),JSON.stringify(config));
  const bytes=Buffer.alloc(1024*1024,0);bytes.write('MZ');
  fs.writeFileSync(path.join(project,'dist/GPT-Orb-Setup-2.1.0-x64.exe'),bytes);
  return {project,keys,config,bytes};
}
function run(fixture,file,env={},args=[]) {
  const clean={...process.env};delete clean.ORB_UPDATE_PRIVATE_KEY;delete clean.GITHUB_REPOSITORY;delete clean.GITHUB_REF_TYPE;delete clean.GITHUB_REF_NAME;
  return spawnSync(process.execPath,[path.join(fixture.project,'scripts',file),...args],{encoding:'utf8',cwd:fixture.project,env:{...clean,...env}});
}
test('release signer binds signature to exact installer size/version/hash and never prints secret',t=>{
 const f=fixture(t),secret=f.keys.privateKey.export({type:'pkcs8',format:'pem'}).toString();
 const r=run(f,'sign-release.cjs',{ORB_UPDATE_PRIVATE_KEY:secret});assert.equal(r.status,0,r.stderr);
 const envelope=JSON.parse(fs.readFileSync(path.join(f.project,'dist/orb-update.json')));
 const payload=Buffer.from(envelope.payload,'base64');assert.ok(crypto.verify(null,payload,f.keys.publicKey,Buffer.from(envelope.signature,'base64')));
 const descriptor=JSON.parse(payload);assert.deepEqual(Object.keys(descriptor),['schema','version','tag','platform','arch','file','size','sha256','sha512','publishedAt']);
 assert.equal(descriptor.tag,'v2.1.0');assert.equal(descriptor.size,f.bytes.length);assert.equal(descriptor.sha256,crypto.createHash('sha256').update(f.bytes).digest('hex'));
 assert.ok(!r.stdout.includes(secret));assert.ok(!r.stderr.includes(secret));
 const changed=Buffer.from(payload);changed[20]^=1;assert.equal(crypto.verify(null,changed,f.keys.publicKey,Buffer.from(envelope.signature,'base64')),false);
});
test('release signing rejects unpinned private keys, wrong repository and wrong tag',t=>{
 const f=fixture(t);const secret=f.keys.privateKey.export({type:'pkcs8',format:'pem'}).toString();
 const bad=crypto.generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}).toString();
 for(const env of [{ORB_UPDATE_PRIVATE_KEY:bad},{ORB_UPDATE_PRIVATE_KEY:secret,GITHUB_REPOSITORY:'other/repo'},{ORB_UPDATE_PRIVATE_KEY:secret,GITHUB_REF_TYPE:'tag',GITHUB_REF_NAME:'v9.0.0'}]) assert.notEqual(run(f,'sign-release.cjs',env).status,0);
 assert.equal(fs.existsSync(path.join(f.project,'dist/orb-update.json')),false);
});
test('release configuration refuses silent trust-root or repository changes',t=>{
 const f=fixture(t);const newKey=crypto.generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}).toString();
 assert.notEqual(run(f,'configure-release.cjs',{GITHUB_REPOSITORY:f.config.repository,ORB_UPDATE_PRIVATE_KEY:newKey}).status,0);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.project,'update-config.json'))),f.config);
});
test('private-key generation refuses paths inside repository and refuses overwrite',t=>{
 const f=fixture(t);
 assert.notEqual(run(f,'generate-signing-key.cjs',{},[path.join(f.project,'private.pem')]).status,0);
 assert.equal(fs.existsSync(path.join(f.project,'private.pem')),false);
 const outside=path.join(os.tmpdir(),'orb-existing-'+crypto.randomUUID()+'.pem');fs.writeFileSync(outside,'preserve');t.after(()=>fs.rmSync(outside,{force:true}));
 assert.notEqual(run(f,'generate-signing-key.cjs',{},[outside]).status,0);assert.equal(fs.readFileSync(outside,'utf8'),'preserve');
});
