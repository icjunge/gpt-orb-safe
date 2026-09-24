'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { discoverCodex } = require('../src/codex-discovery.cjs');

function pe(machine = 0x8664, characteristics = 0x0002) {
  const bytes = Buffer.alloc(128);
  bytes.write('MZ');
  bytes.writeUInt32LE(64, 60);
  bytes.writeUInt32LE(0x00004550, 64);
  bytes.writeUInt16LE(machine, 68);
  bytes.writeUInt16LE(characteristics, 86);
  return bytes;
}

function windowsFixture(arch = 'x64') {
  const p = path.win32;
  const files = new Map();
  const links = new Map();
  const calls = [];
  const appdata = 'C:\\Users\\Orb User\\AppData\\Roaming';
  const prefix = p.join(appdata, 'npm');
  const root = p.join(prefix, 'node_modules', '@openai', 'codex');
  const version = '0.155.1';
  const suffix = `win32-${arch}`;
  const target = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const normalize = value => p.normalize(value).toLowerCase();
  const put = (file, value) => files.set(normalize(file), Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)));
  const linked = value => {
    let current = value;
    for (let i = 0; i < 8; i++) {
      const key = [...links.keys()].find(key => normalize(current) === normalize(key) || normalize(current).startsWith(normalize(key) + '\\'));
      if (!key) return current;
      current = links.get(key) + current.slice(key.length);
    }
    throw new Error('link loop');
  };
  const missing = () => { throw Object.assign(new Error('fixture missing'), { code: 'ENOENT' }); };
  const io = {
    async realpath(value) {
      calls.push(['realpath', value]);
      const resolved = linked(value);
      const key = normalize(resolved);
      if (files.has(key) || [...files.keys()].some(file => file.startsWith(key + '\\'))) return resolved;
      return missing();
    },
    async open(value) {
      calls.push(['open', value]);
      const bytes = files.get(normalize(linked(value)));
      if (!bytes) return missing();
      return {
        async stat() { return { isFile: () => true, size: bytes.length, mode: 0o755 }; },
        async read(buffer, offset, length, position) {
          const count = Math.max(0, Math.min(length, bytes.length - position));
          bytes.copy(buffer, offset, position, position + count);
          return { bytesRead: count };
        },
        async close() {}
      };
    }
  };
  const main = {
    name: '@openai/codex', version, bin: { codex: 'bin/codex.js' },
    optionalDependencies: { [`@openai/codex-${suffix}`]: `npm:@openai/codex@${version}-${suffix}` }
  };
  function install(base = root, layout = 'nested', directory = 'bin') {
    put(p.join(base, 'package.json'), main);
    const native = layout === 'legacy' ? base : layout === 'hoisted' ?
      p.join(p.dirname(base), `codex-${suffix}`) : p.join(base, 'node_modules', '@openai', `codex-${suffix}`);
    if (layout !== 'legacy') put(p.join(native, 'package.json'), {
      name: '@openai/codex', version: `${version}-${suffix}`, os: ['win32'], cpu: [arch]
    });
    const executable = p.join(native, 'vendor', target, directory, 'codex.exe');
    put(executable, pe(arch === 'arm64' ? 0xaa64 : 0x8664));
    return { native, executable };
  }
  return { p, put, links, calls, io, appdata, prefix, root, main, install,
    options: { platform: 'win32', arch, fs: io, env: { APPDATA: appdata, Path: prefix } } };
}

test('discovers official npm alias layout under APPDATA without running a shell shim', async () => {
  const f = windowsFixture();
  const installed = f.install();
  f.put(f.p.join(f.prefix, 'codex.cmd'), Buffer.from('@echo secret'));
  f.put(f.p.join(f.prefix, 'codex.ps1'), Buffer.from('throw secret'));
  assert.deepEqual(await discoverCodex(f.options), { path: installed.executable });
  assert.ok(f.calls.filter(([method]) => method === 'open').every(([, file]) => /(?:package\.json|codex\.exe)$/.test(file)));
  assert.ok(!f.calls.some(([, file]) => /auth\.json|codex\.(?:cmd|ps1|js)$/.test(file)));
});

test('supports npm hoisting and custom absolute prefixes on PATH', async () => {
  const f = windowsFixture();
  const prefix = 'D:\\Developer Tools\\npm';
  const installed = f.install(f.p.join(prefix, 'node_modules', '@openai', 'codex'), 'hoisted');
  f.options.env = { PATH: prefix };
  assert.deepEqual(await discoverCodex(f.options), { path: installed.executable });
});

test('supports historical embedded vendor layout and ARM64 native binaries', async () => {
  const f = windowsFixture('arm64');
  const installed = f.install(f.root, 'legacy', 'codex');
  assert.deepEqual(await discoverCodex(f.options), { path: installed.executable });
});

test('follows a package manager root symlink to its canonical installed package', async () => {
  const f = windowsFixture();
  const store = 'D:\\Package Store\\codex-install';
  const installed = f.install(store);
  f.links.set(f.root, store);
  assert.deepEqual(await discoverCodex(f.options), { path: installed.executable });
});

test('rejects relative, empty, traversing, UNC, device and drive-relative PATH entries', async () => {
  const f = windowsFixture();
  f.options.env = { APPDATA: '..\\profile', PATH: ';.;bin;C:bin;C:\\safe\\..\\evil;\\\\host\\share;\\\\?\\C:\\tools;\\tools;C:\\nul;C:\\trailing.\\bin' };
  assert.equal(await discoverCodex(f.options), null);
  assert.deepEqual(f.calls, []);
});

test('rejects canonical symlink targets on a network share or outside a package vendor tree', async () => {
  const f = windowsFixture();
  const installed = f.install();
  const outside = 'D:\\unrelated\\codex.exe';
  f.put(outside, pe());
  f.links.set(installed.executable, outside);
  assert.equal(await discoverCodex(f.options), null);
  f.links.set(installed.executable, '\\\\server\\share\\codex.exe');
  f.put('\\\\server\\share\\codex.exe', pe());
  assert.equal(await discoverCodex(f.options), null);
});

test('does not resolve packages from manifest-controlled paths or mismatched versions', async () => {
  for (const patch of [
    { name: '@other/codex' },
    { bin: { codex: '../../cmd.exe' } },
    { optionalDependencies: { '@openai/codex-win32-x64': 'file:../../evil' } },
    { optionalDependencies: { '@openai/codex-win32-x64': 'npm:@openai/codex@0.999.0-win32-x64' } }
  ]) {
    const f = windowsFixture();
    f.install();
    f.put(f.p.join(f.root, 'package.json'), { ...f.main, ...patch });
    assert.equal(await discoverCodex(f.options), null);
    assert.ok(!f.calls.some(([, file]) => file.includes('evil') || file.includes('cmd.exe')));
  }
});

test('optional package metadata must match the declared native version and architecture', async () => {
  const f = windowsFixture();
  const installed = f.install();
  f.put(f.p.join(installed.native, 'package.json'), {
    name: '@openai/codex', version: '0.1.0-win32-x64', os: ['win32'], cpu: ['x64']
  });
  assert.equal(await discoverCodex(f.options), null);
});

test('prefers a valid npm installation over a bare executable on PATH', async () => {
  const f = windowsFixture();
  const installed = f.install();
  const directory = 'D:\\tools';
  f.put(f.p.join(directory, 'codex.exe'), pe());
  f.options.env.PATH = directory;
  assert.deepEqual(await discoverCodex(f.options), { path: installed.executable });
});

test('accepts a bare native executable but refuses scripts, renamed shell targets, DLLs and wrong architectures', async () => {
  const f = windowsFixture();
  const executable = f.p.join(f.prefix, 'codex.exe');
  f.put(executable, pe());
  assert.deepEqual(await discoverCodex(f.options), { path: executable });
  for (const bytes of [Buffer.from('#!/bin/sh\necho hi'), pe(0xaa64), pe(0x8664, 0x2002), Buffer.from('MZ' + 'x'.repeat(126))]) {
    f.put(executable, bytes);
    assert.equal(await discoverCodex(f.options), null);
  }
  const command = 'C:\\Windows\\System32\\cmd.exe';
  f.put(command, pe());
  f.links.set(executable, command);
  assert.equal(await discoverCodex(f.options), null);
});

test('unreadable and oversized package manifests fail closed without scanning other directories', async () => {
  const f = windowsFixture();
  f.install();
  f.put(f.p.join(f.root, 'package.json'), Buffer.alloc(65537, 32));
  assert.equal(await discoverCodex(f.options), null);
  f.io.open = async () => { throw new Error('denied'); };
  assert.equal(await discoverCodex(f.options), null);
});

test('unsupported architectures return unavailable without file access', async () => {
  const f = windowsFixture();
  assert.equal(await discoverCodex({ ...f.options, arch: 'ia32' }), null);
  assert.deepEqual(f.calls, []);
});

test('Linux development accepts an executable native file and rejects script shims and non-executable files', { skip: process.platform === 'win32' }, async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orb-codex-discovery-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'codex');
  const options = { platform: 'linux', arch: 'x64', env: { PATH: directory } };
  await fs.writeFile(executable, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o755 });
  assert.deepEqual(await discoverCodex(options), { path: executable });
  await fs.chmod(executable, 0o644);
  assert.equal(await discoverCodex(options), null);
  await fs.chmod(executable, 0o755);
  await fs.writeFile(executable, '#!/usr/bin/env node\nconsole.log("no execution");');
  assert.equal(await discoverCodex(options), null);
  assert.equal(await discoverCodex({ ...options, env: { PATH: '.::relative:/tmp/../evil' } }), null);
});

test('Finder launch probes fixed Mac prefixes and accepts official Homebrew native target names without a shell',async()=>{
  for(const arch of ['arm64','x64']){
    const bin=arch==='arm64'?'/opt/homebrew/bin/codex':'/usr/local/bin/codex';
    const target=`/opt/fixture-cask/codex-${arch==='arm64'?'aarch64':'x86_64'}-apple-darwin`;
    const calls=[],bytes=Buffer.alloc(64);bytes.writeUInt32BE(0xcffaedfe,0);
    let content=bytes;
    const missing=()=>{throw Object.assign(new Error('fixture missing'),{code:'ENOENT'});};
    const io={
      async realpath(value){calls.push(value);return value===bin?target:missing();},
      async open(value){assert.equal(value,target);return{async stat(){return{isFile:()=>true,size:content.length,mode:0o755};},
        async read(buffer,offset,length,position){const n=Math.min(length,Math.max(0,content.length-position));content.copy(buffer,offset,position,position+n);return{bytesRead:n};},async close(){}};}};
    const options={platform:'darwin',arch,env:{PATH:'/usr/bin:/bin',HOME:'/Users/Fixture'},fs:io};
    assert.deepEqual(await discoverCodex(options),{path:target});
    assert.ok(!calls.some(value=>/auth\.json|\.zshrc|\.bash_profile|\.codex\//.test(value)));
    content=Buffer.from('#!/bin/sh\necho untrusted');assert.equal(await discoverCodex(options),null);
  }
});
