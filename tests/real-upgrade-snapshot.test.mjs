// Offline snapshot admission checks. No Docker, browser, provider or image build is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {manifestRows,preflightSnapshot,copySnapshot,verifySnapshotTree} from './helpers/upgrade-snapshot.mjs';
import {HISTORICAL,CURRENT,validateConfig,runFixture} from './real-upgrade-smoke.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
// What the nonroot Ubuntu image probe in real-upgrade-smoke.mjs imports or reads from its public /inputs copy.
const PROBE_INPUTS=['runtime/ubuntu/lock/runtime-inputs.lock.json','runtime/ubuntu/lock/ubuntu-os-packages.txt','runtime/ubuntu/helpers/ohpkg.py','runtime/ubuntu/helpers/check_packages.py','runtime/ubuntu/helpers/debian_origin.py','runtime/ubuntu/helpers/debian_inputs.py'];
function fixture(t){
  const root=fs.mkdtempSync(join(fs.realpathSync(tmpdir()),'oh-upgrade-source-')),source=join(root,'source');fs.mkdirSync(source);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const payloads={'package.json':'{"version":"0.4.0-beta.1"}','compose.yaml':'services: {}','Dockerfile.coordinator':'COPY . .','runtime/dind-entrypoint.sh':'#!/bin/sh\n','runtime/readiness.ts':'export const RUNTIME_CONTRACT = 7;\n','runtime/hermes/Dockerfile':'ARG OPEN_HARNESS_RUNTIME=7\n','runtime/ubuntu/lock/runtime-inputs.lock.json':'{}','tests/helpers/compose-desktop.py':'print("fixture")\n'};
  for(const p of PROBE_INPUTS)payloads[p]??=`# ${p}\n`;
  const manifest={};for(const[p,content]of Object.entries(payloads)){const full=join(source,p);fs.mkdirSync(dirname(full),{recursive:true});fs.writeFileSync(full,content);fs.chmodSync(full,p.endsWith('.sh')?0o711:0o600);manifest[p]={sha256:hash(content),mode:fs.statSync(full).mode&0o777};}
  const write=(name,value)=>{const path=join(root,name),b=JSON.stringify(value,null,2)+'\n';fs.writeFileSync(path,b);return {path,sha256:hash(b)};};
  const images=Object.fromEntries(['coordinator','engine','historical','oldEngine','runtime'].map((k,i)=>[k,{id:'sha256:'+String(i).repeat(64),...(['historical','runtime'].includes(k)?{tag:`fixture/${k}:1`}:{})}]));
  const runtime=Object.fromEntries(Object.entries(manifest).filter(([p])=>p.startsWith('runtime/hermes/')||p.startsWith('runtime/ubuntu/')));
  const s={path:source,manifest:write('snapshot.json',manifest),runtimeContract:7,builds:{}};
  for(const [name,m]of [['coordinator',manifest],['runtime',runtime]]){const pin=write(name+'-manifest.json',m),result={buildPassed:true,returncode:0,abort:null,changedSourceFiles:[],image:images[name].id,sourceManifestSha256:pin.sha256};s.builds[name]={manifest:pin,result:write(name+'-result.json',result)};}
  const c={rootReviewed:true,acknowledgeMissingHistoricalBuildAttestation:true,historicalCommit:HISTORICAL,currentSnapshot:s,repository:'/srv/repository.git',workParent:'/srv/evidence',chromiumExecutable:'/opt/chrome/chrome',floors:{initial:15,build:12,engine:12,stop:4},deadlines:{build:1200,engine:180,transfer:600,browser:660,total:3600},images};
  const rewrite=(pin,change)=>{const v=JSON.parse(fs.readFileSync(pin.path));change(v);Object.assign(pin,write(pin.path.slice(root.length+1),v));};
  return {root,source,manifest,s,c,images,write,rewrite};
}
test('reviewed snapshot retains exact modes and unambiguous build identity; legacy selection still works',t=>{
  const f=fixture(t);validateConfig(f.c);const checked=preflightSnapshot(f.s,f.images);
  assert.equal(checked.kind,'reviewed-build-snapshot');assert.equal(checked.commit,undefined);assert.equal(checked.runtimeContract,7);assert.equal(checked.builds.coordinator.imageId,f.images.coordinator.id);
  const dest=join(f.root,'export');copySnapshot(f.s,checked,dest);verifySnapshotTree(dest,checked.files);assert.equal(fs.statSync(join(dest,'runtime/dind-entrypoint.sh')).mode&0o777,0o711);
  assert.throws(()=>copySnapshot(f.s,checked,dest),/destination must be new/);
  const legacy={...f.c,currentCommit:CURRENT};delete legacy.currentSnapshot;validateConfig(legacy);
  assert.throws(()=>validateConfig({...f.c,currentCommit:CURRENT}),/not a Git commit/);
  assert.throws(()=>validateConfig({...f.c,currentSnapshot:{...f.s,runtimeContract:undefined}}),/reviewed runtime contract/);
});
for(const kind of ['bytes','mode','special-mode','missing','extra','directory','symlink','parent-symlink','hardlink'])test('snapshot rejects '+kind,t=>{
  const f=fixture(t),p=join(f.source,'compose.yaml');
  if(kind==='bytes')fs.appendFileSync(p,'changed');
  if(kind==='mode')fs.chmodSync(p,0o644);
  if(kind==='special-mode')fs.chmodSync(p,0o2600);
  if(kind==='missing')fs.unlinkSync(p);
  if(kind==='extra')fs.writeFileSync(join(f.source,'unexpected.txt'),'extra');
  if(kind==='directory')fs.mkdirSync(join(f.source,'unexpected-directory'));
  if(kind==='symlink'){fs.renameSync(p,join(f.root,'outside'));fs.symlinkSync(join(f.root,'outside'),p);}
  if(kind==='parent-symlink'){fs.renameSync(join(f.source,'runtime'),join(f.root,'outside'));fs.symlinkSync(join(f.root,'outside'),join(f.source,'runtime'));}
  if(kind==='hardlink')fs.linkSync(p,join(f.root,'linked'));
  assert.throws(()=>preflightSnapshot(f.s,f.images));
});
test('every path and pinned metadata input is validated',t=>{
  const f=fixture(t),v={sha256:'a'.repeat(64),mode:0o600};
  for(const p of ['/abs','../escape','a/../escape','a//b','./a','a\\b','a\nb'])assert.throws(()=>manifestRows({[p]:v}),/Unsafe snapshot path/);
  for(const mode of [0o100644,-1,0o1000,1.5])assert.throws(()=>manifestRows({safe:{...v,mode}}));
  assert.throws(()=>manifestRows({safe:{...v,unknown:true}}));assert.throws(()=>manifestRows({}));
  f.s.manifest.sha256='b'.repeat(64);assert.throws(()=>preflightSnapshot(f.s,f.images),/Pinned snapshot input changed/);
});
test('symlinked manifest and ancestor directory are rejected even with the expected bytes',t=>{
  const f=fixture(t),m=f.s.manifest;fs.renameSync(m.path,m.path+'.real');fs.symlinkSync(m.path+'.real',m.path);assert.throws(()=>preflightSnapshot(f.s,f.images),/Symlink/);
  fs.unlinkSync(m.path);fs.renameSync(m.path+'.real',m.path);fs.symlinkSync(f.root,f.root+'-link');t.after(()=>fs.unlinkSync(f.root+'-link'));f.s.path=f.root+'-link/source';assert.throws(()=>preflightSnapshot(f.s,f.images),/Symlink/);
});
for(const kind of ['image','manifest','failed','abort','changed-source','returncode'])test('build receipt rejects '+kind,t=>{
  const f=fixture(t);f.rewrite(f.s.builds.runtime.result,r=>{if(kind==='image')r.image=f.images.engine.id;if(kind==='manifest')r.sourceManifestSha256='a'.repeat(64);if(kind==='failed')r.buildPassed=false;if(kind==='abort')r.abort='timeout';if(kind==='changed-source')r.changedSourceFiles=['Dockerfile'];if(kind==='returncode')r.returncode=1;});assert.throws(()=>preflightSnapshot(f.s,f.images));
});
test('a snapshot cannot omit coordinator inputs or runtime inputs',t=>{
  const f=fixture(t);f.rewrite(f.s.builds.coordinator.manifest,m=>{delete m['compose.yaml'];});f.rewrite(f.s.builds.coordinator.result,r=>{r.sourceManifestSha256=f.s.builds.coordinator.manifest.sha256;});assert.throws(()=>preflightSnapshot(f.s,f.images),/entire current snapshot/);
  const g=fixture(t);g.rewrite(g.s.builds.runtime.manifest,m=>{delete m['runtime/ubuntu/lock/runtime-inputs.lock.json'];});g.rewrite(g.s.builds.runtime.result,r=>{r.sourceManifestSha256=g.s.builds.runtime.manifest.sha256;});assert.throws(()=>preflightSnapshot(g.s,g.images),/Runtime build input missing/);
});
test('a snapshot must carry every Ubuntu input the nonroot image probe uses',t=>{
  for(const p of PROBE_INPUTS){
    const f=fixture(t);fs.unlinkSync(join(f.source,p));
    for(const pin of [f.s.manifest,f.s.builds.runtime.manifest,f.s.builds.coordinator.manifest])f.rewrite(pin,m=>{delete m[p];});
    for(const name of ['runtime','coordinator'])f.rewrite(f.s.builds[name].result,r=>{r.sourceManifestSha256=f.s.builds[name].manifest.sha256;});
    assert.throws(()=>preflightSnapshot(f.s,f.images),new RegExp('Required snapshot input missing: '+p.replace(/[.]/g,'\\.')));
  }
});
test('image probes run isolated interpreters, so image PYTHON* settings cannot drop their assert checks',()=>{
  const smoke=fs.readFileSync(new URL('./real-upgrade-smoke.mjs',import.meta.url),'utf8');
  assert.match(smoke,/'--entrypoint','python',c\.images\.runtime\.id,'-I','-B','-c',script\],\{user:'10001'\}/);
  assert.match(smoke,/'--entrypoint','python',c\.images\[key\]\.id,'-I','-B','-c',code\]/);
  assert.doesNotMatch(smoke,/'--entrypoint','python',[^\]]*?id,'-c',/);
});
test('reviewed contract must agree with both source and runtime Dockerfile',t=>{
  const f=fixture(t);f.s.runtimeContract=6;assert.throws(()=>preflightSnapshot(f.s,f.images),/contract differs/);
  const g=fixture(t),p='runtime/hermes/Dockerfile',b='ARG OPEN_HARNESS_RUNTIME=8\n';fs.writeFileSync(join(g.source,p),b);
  for(const pin of [g.s.manifest,g.s.builds.runtime.manifest,g.s.builds.coordinator.manifest])g.rewrite(pin,m=>{m[p].sha256=hash(b);});
  for(const name of ['runtime','coordinator'])g.rewrite(g.s.builds[name].result,r=>{r.sourceManifestSha256=g.s.builds[name].manifest.sha256;});assert.throws(()=>preflightSnapshot(g.s,g.images),/Dockerfile contract differs/);
});
test('source changes between review and copy are rejected before destination creation',t=>{
  const f=fixture(t),checked=preflightSnapshot(f.s,f.images),dest=join(f.root,'never-created');fs.appendFileSync(join(f.source,'compose.yaml'),'changed');assert.throws(()=>copySnapshot(f.s,checked,dest),/bytes changed/);assert.equal(fs.existsSync(dest),false);
});
test('bad snapshot fails before platform checks, work directories or any Docker command',async t=>{
  const f=fixture(t);f.c.workParent=join(f.root,'never-created');f.s.manifest.sha256='f'.repeat(64);
  // Keep the Unix-socket path guard satisfied on hosts with longer temporary roots.
  f.c.workParent='/srv/oh-snapshot-preflight-'+process.pid;assert.equal(fs.existsSync(f.c.workParent),false);
  await assert.rejects(runFixture(f.c),/Pinned snapshot input changed/);assert.equal(fs.existsSync(f.c.workParent),false);assert.equal(fs.existsSync(join(f.root,'never-created')),false);
});
