// Reviewed build snapshots have their own identity; they are never presented as committed source.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,isAbsolute,join,resolve} from 'node:path';

const hash=b=>createHash('sha256').update(b).digest('hex');
const digest=v=>assert.match(v??'',/^[a-f0-9]{64}$/);
const absolute=p=>{assert.equal(typeof p,'string');assert.ok(isAbsolute(p)&&resolve(p)===p,'Use a canonical absolute snapshot path');};
const relative=p=>{assert.ok(typeof p==='string'&&p.length&&!p.startsWith('/')&&!/[\\\x00-\x1f]/.test(p)&&!p.split('/').some(n=>!n||n==='.'||n==='..'),'Unsafe snapshot path');};
const pinned=p=>{absolute(p?.path);digest(p.sha256);};
// Everything the nonroot Ubuntu image probe in real-upgrade-smoke.mjs imports or reads from its public copy.
export const UBUNTU_PROBE_INPUTS=['runtime/ubuntu/lock/runtime-inputs.lock.json','runtime/ubuntu/lock/ubuntu-os-packages.txt','runtime/ubuntu/helpers/ohpkg.py','runtime/ubuntu/helpers/check_packages.py','runtime/ubuntu/helpers/debian_origin.py','runtime/ubuntu/helpers/debian_inputs.py'];
export function validateSnapshotConfig(s) {
  assert.ok(s&&typeof s==='object');absolute(s.path);pinned(s.manifest);
  assert.ok(Number.isSafeInteger(s.runtimeContract)&&s.runtimeContract>0,'A reviewed runtime contract is required');
  assert.deepEqual(Object.keys(s.builds??{}).sort(),['coordinator','runtime']);
  for(const b of Object.values(s.builds)){pinned(b.manifest);pinned(b.result);}
  return s;
}
function noLinks(p) {
  absolute(p);let at='/';
  for(const part of p.slice(1).split('/')){at=join(at,part);assert.ok(!fs.lstatSync(at).isSymbolicLink(),'Symlink in snapshot path: '+at);}
}
function read(p) {
  noLinks(p);const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{const a=fs.fstatSync(fd);assert.ok(a.isFile()&&a.nlink===1,'Snapshot inputs must be ordinary unlinked files: '+p);const bytes=fs.readFileSync(fd),b=fs.fstatSync(fd);
    assert.deepEqual([b.dev,b.ino,b.size,b.mtimeMs,b.ctimeMs,b.mode],[a.dev,a.ino,a.size,a.mtimeMs,a.ctimeMs,a.mode],'Snapshot input changed while reading: '+p);
    const now=fs.lstatSync(p);assert.deepEqual([now.dev,now.ino,now.mode],[b.dev,b.ino,b.mode],'Snapshot input replaced: '+p);return {bytes,mode:a.mode&0o7777};
  }finally{fs.closeSync(fd);}
}
function readPinned(p){const b=read(p.path).bytes;assert.equal(hash(b),p.sha256,'Pinned snapshot input changed: '+p.path);return JSON.parse(b);}
export function manifestRows(m) {
  assert.ok(m&&typeof m==='object'&&!Array.isArray(m));const rows=[];
  for(const [path,v]of Object.entries(m)){relative(path);assert.deepEqual(Object.keys(v).sort(),['mode','sha256']);digest(v.sha256);assert.ok(Number.isInteger(v.mode)&&v.mode>=0&&v.mode<=0o777,'Invalid snapshot file mode');rows.push({path,...v});}
  assert.ok(rows.length,'Empty snapshot manifest');return rows.sort((a,b)=>a.path.localeCompare(b.path,'en'));
}
export function verifySnapshotTree(root,rows) {
  noLinks(root);assert.ok(fs.lstatSync(root).isDirectory());const paths=[],dirs=new Set();
  for(const f of rows){relative(f.path);for(let d=dirname(f.path);d!=='.';d=dirname(d))dirs.add(d);}
  const walk=(dir,prefix='')=>{for(const n of fs.readdirSync(dir).sort()){const p=prefix+n,full=join(dir,n),s=fs.lstatSync(full);assert.ok(!s.isSymbolicLink(),'Snapshot symlink: '+p);
    if(s.isDirectory()){assert.ok(dirs.has(p),'Unexpected snapshot directory: '+p);walk(full,p+'/');}else{assert.ok(s.isFile(),'Unexpected snapshot entry: '+p);paths.push(p);}}};walk(root);
  assert.deepEqual(paths.sort(),rows.map(f=>f.path).sort(),'Missing or unexpected snapshot payloads');
  for(const f of rows){const v=read(join(root,f.path));assert.equal(v.mode,f.mode,'Snapshot mode changed: '+f.path);assert.equal(hash(v.bytes),f.sha256,'Snapshot bytes changed: '+f.path);}
}
export function preflightSnapshot(s,images) {
  validateSnapshotConfig(s);const manifest=readPinned(s.manifest),files=manifestRows(manifest);verifySnapshotTree(s.path,files);
  const builds={};
  for(const [name,b]of Object.entries(s.builds)){
    const inputs=readPinned(b.manifest),rows=manifestRows(inputs),result=readPinned(b.result);
    assert.equal(result.buildPassed,true,'Build did not pass');assert.equal(result.returncode,0);assert.equal(result.abort,null);assert.deepEqual(result.changedSourceFiles,[]);
    assert.equal(result.image,images[name].id,'Build image differs from configured image');assert.equal(result.sourceManifestSha256,b.manifest.sha256,'Build input manifest differs from receipt');
    for(const r of rows)assert.deepEqual(manifest[r.path],inputs[r.path],'Snapshot differs from build input: '+r.path);
    if(name==='coordinator')assert.deepEqual(inputs,manifest,'Coordinator build must bind the entire current snapshot');
    builds[name]={imageId:result.image,manifestSha256:b.manifest.sha256,resultSha256:b.result.sha256,files:rows.length};
  }
  for(const p of ['package.json','compose.yaml','Dockerfile.coordinator','runtime/dind-entrypoint.sh','runtime/readiness.ts','runtime/hermes/Dockerfile','tests/helpers/compose-desktop.py',...UBUNTU_PROBE_INPUTS])assert.ok(Object.hasOwn(manifest,p),'Required snapshot input missing: '+p);
  const content=p=>{const v=read(join(s.path,p));assert.equal(hash(v.bytes),manifest[p].sha256,'Snapshot bytes changed: '+p);return v.bytes.toString('utf8');};
  assert.equal(JSON.parse(content('package.json')).version,'0.4.0-beta.1');
  const contracts=[...content('runtime/readiness.ts').matchAll(/export const RUNTIME_CONTRACT = (\d+);/g)];assert.equal(contracts.length,1);assert.equal(Number(contracts[0][1]),s.runtimeContract,'Snapshot runtime contract differs from review');
  const args=[...content('runtime/hermes/Dockerfile').matchAll(/^ARG OPEN_HARNESS_RUNTIME=(\d+)$/gm)];assert.equal(args.length,1);assert.equal(Number(args[0][1]),s.runtimeContract,'Runtime Dockerfile contract differs from review');
  const runtimeInputs=readPinned(s.builds.runtime.manifest);
  for(const f of files.filter(f=>f.path.startsWith('runtime/hermes/')||f.path.startsWith('runtime/ubuntu/')))assert.deepEqual(runtimeInputs[f.path],manifest[f.path],'Runtime build input missing: '+f.path);
  return {kind:'reviewed-build-snapshot',version:'0.4.0-beta.1',manifestSha256:s.manifest.sha256,runtimeContract:s.runtimeContract,builds,files};
}
export function copySnapshot(s,checked,destination) {
  assert.deepEqual(preflightSnapshot(s,Object.fromEntries(Object.entries(checked.builds).map(([k,v])=>[k,{id:v.imageId}]))),checked,'Snapshot review changed before copy');
  assert.ok(!fs.existsSync(destination),'Snapshot destination must be new');fs.mkdirSync(destination,{mode:0o700});
  for(const f of checked.files){const b=read(join(s.path,f.path));assert.equal(hash(b.bytes),f.sha256);assert.equal(b.mode,f.mode);const p=join(destination,f.path);fs.mkdirSync(dirname(p),{recursive:true,mode:0o700});fs.writeFileSync(p,b.bytes,{flag:'wx',mode:f.mode});fs.chmodSync(p,f.mode);}
  verifySnapshotTree(destination,checked.files);verifySnapshotTree(s.path,checked.files);return checked;
}
