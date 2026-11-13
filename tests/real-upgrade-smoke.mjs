// NEW opt-in acceptance: original0.3 source -> production Compose -> original backup rollback.
// node tests/real-upgrade-smoke.mjs --config /durable/private/reviewed.json --execute-reviewed
// Requires explicit cached image IDs/tags and existing Chromium. Never pulls/builds images.
// Docker CLI calls keep the operator's own client configuration (HOME/DOCKER_CONFIG, including any
// proxy settings) but always target the explicit local native daemon. Builds, git, browsers and the
// original app get a private HOME, like the containerized current coordinator.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {join,resolve,dirname,isAbsolute,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as pause} from 'node:timers/promises';
import {KINDS} from './helpers/upgrade-browser.mjs';
import {TASK_TOOL} from './helpers/upgrade-provider.mjs';
import {validateSnapshotConfig,preflightSnapshot,copySnapshot,verifySnapshotTree} from './helpers/upgrade-snapshot.mjs';

export const HISTORICAL='cafc0a4655d00bc9bc45269378a92dd357b5e9fe',CURRENT='3a8f5341a7a1e42451b8448de8a50a121e68e7fb',HERMES='939e45c91d751fadd94dcd1b873ac3cb44846213';
// cafc remains a recorded startup regression. This separate, unchanged0.3 checkpoint contains
// the documented plugin/provider fixes; selecting it requires a fresh observed build receipt.
export const REPAIRED_HISTORICAL='603b19b917fd9753f52599cf4d93a91728d67c0b';
export const NATIVE_DOCKER_HOST='unix:///var/run/docker.sock';
// Original0.3 stores its own single-underscore coordination grant, which pinned Hermes never registers.
// Current renames it on read (never widening access); these are the only names each stage may show the model.
export const GRANTED={historical:['mcp_open_harness_task','terminal','write_file'],upgraded:['clarify','computer_use',TASK_TOOL,'terminal','write_file']};
const REQUIRED={historical:{MAIN:['write_file'],DENY:['terminal'],APPROVE:['terminal']},upgraded:{MAIN:['write_file','clarify',TASK_TOOL],DENY:['terminal'],APPROVE:['terminal'],HOLD:['clarify']}};
const LEGACY={mcp_open_harness_task:TASK_TOOL,mcp_open_harness_delegate_named_agent:'mcp__open_harness__delegate_named_agent',mcp_open_harness_create_open_harness_routine:'mcp__open_harness__create_open_harness_routine'};
const HERE=dirname(fileURLToPath(import.meta.url)),LABEL='io.openharness.upgrade.owner',AGENT='upgrade-alpha',PEER='upgrade-beta',CREDENTIAL='UPGRADE_FIXTURE_KEY',ORIGINAL='upgrade-original-synthetic',ROTATED='upgrade-rotated-synthetic';
const hash=b=>createHash('sha256').update(b).digest('hex'),gitBlob=b=>createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
const TEMPORARY=/^\/(?:private\/)?tmp(?:\/|$)/;
export function validateSocketParent(parent){assert.ok(Buffer.byteLength(join(parent,'oh-upgrade-XXXXXX','baseline-control','docker.sock'))<108,'The durable work parent is too long for the historical Docker Unix socket');}
export function validateConfig(c) {
  assert.equal(c.rootReviewed,true,'A separately reviewed configuration is required');
  assert.ok([HISTORICAL,REPAIRED_HISTORICAL].includes(c.historicalCommit),'Only separately reviewed historical checkpoints are in scope');
  if(c.historicalCommit===HISTORICAL)assert.equal(c.acknowledgeMissingHistoricalBuildAttestation,true,'Cached content inspection is not recovered build attestation');
  else {assert.ok(isAbsolute(c.historicalBuildReceipt?.path??''),'The repaired checkpoint requires its fresh build receipt');assert.match(c.historicalBuildReceipt?.sha256??'',/^[a-f0-9]{64}$/);}
  if(c.currentSnapshot!==undefined){assert.equal(c.currentCommit,undefined,'A snapshot is not a Git commit');validateSnapshotConfig(c.currentSnapshot);}
  else assert.equal(c.currentCommit,CURRENT,'Only the reviewed current commit is in scope');
  for(const key of ['repository','workParent','chromiumExecutable']) {assert.equal(typeof c[key],'string',key);assert.ok(isAbsolute(c[key]),key);assert.ok(!c[key].split('/').some(p=>p==='..'||p==='.'),key);}
  assert.ok(!TEMPORARY.test(c.workParent),'Evidence must be durable');assert.notEqual(c.workParent,'/');
  validateSocketParent(c.workParent);
  assert.deepEqual(c.floors,{initial:15,build:12,engine:12,stop:4});
  assert.deepEqual(c.deadlines,{build:1200,engine:180,transfer:600,browser:660,total:3600});
  assert.deepEqual(Object.keys(c.images||{}).sort(),['coordinator','engine','historical','oldEngine','runtime']);
  for(const value of Object.values(c.images))assert.match(value?.id??'',/^sha256:[a-f0-9]{64}$/);
  for(const name of ['historical','runtime'])assert.match(c.images[name].tag??'',/^[a-zA-Z0-9][a-zA-Z0-9._:/-]+$/);
  return c;
}
export function assertHistoricalBuildReceipt(receipt,c) {
  assert.equal(c.historicalCommit,REPAIRED_HISTORICAL);assert.equal(receipt.sourceCommit,c.historicalCommit);
  assert.equal(receipt.ok,true);assert.equal(receipt.returncode,0);assert.equal(receipt.abort,null);
  assert.equal(receipt.imageId,c.images.historical.id);assert.equal(receipt.iidFile,receipt.imageId);
  assert.equal(receipt.tag,c.images.historical.tag);assert.equal(receipt.sourceFilesUnchanged,130);
  for(const key of ['sourceManifestSha256','controllerSha256','sourceArchiveSha256','imageInspectSha256'])assert.match(receipt[key]??'',/^[a-f0-9]{64}$/);
}
export function assertHistoricalQuiescent(runs) {
  for(const run of runs)assert.ok(['completed','failed','cancelled','interrupted'].includes(run.state),'All original runs must be terminal before graceful shutdown and backup');
}
export function assertImageDefaults(service) {
  // Compose config normalizes omitted image defaults to null. Empty arrays/strings override them.
  for(const key of ['command','entrypoint'])assert.ok(service[key]===undefined||service[key]===null,`Production ${key} must use the image default`);
}
export function sourcePaths(list) {
  const out=[];
  for(const row of list.split('\0').filter(Boolean)) {
    const m=row.match(/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/s);assert.ok(m,'Only reviewed regular Git source files are exported');
    const p=m[3];assert.ok(!p.startsWith('/')&&!p.split('/').some(n=>n==='..'||n===''));
    out.push({path:p,mode:m[1]==='100755'?0o755:0o644,blob:m[2]});
  }
  assert.ok(out.length);return out;
}
export function compareManifests(actual,expected,{migrated=false}={}) {
  assert.deepEqual(actual,expected.map(e=>migrated?{...e,uid:1000,gid:1000}:e));
}
// Whole-message absence diagnostics only, for the exact target and exit status 1: mixed errors are real failures.
export function missingObject(error,target) {
  const t=String(target).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return error?.code===1&&new RegExp(`^(?:Error: |Error response from daemon: )?(?:No such (?:object|container|volume|network): ${t}|get ${t}: no such volume|network ${t} not found)$`,'i').test(String(error.stderr??'').trim());
}
// Bounded subprocesses are also used by offline fake-child tests. Timeout/abort cannot pass on exit0.
// grace sends SIGTERM first (a browser helper then closes its detached Chromium), then SIGKILL.
export function command(binary,args,{cwd,env,timeout=30000,signal,input,onLine,maxBytes=16*1024*1024,grace=0,children=new Set()}={}) {
  if(signal?.aborted)return Promise.reject(signal.reason??new Error('Aborted'));
  return new Promise((accept,reject)=>{
    const child=spawn(binary,args,{cwd,env,detached:true,stdio:['pipe','pipe','pipe']});children.add(child);
    let out='',err='',line='',failure,killed=false,closed=false,graceTimer,work=Promise.resolve(),expire;const expired=new Promise(r=>{expire=r;});
    // No signals once the command has closed: an empty group's ID may later belong to someone else.
    const group=sig=>{if(closed)return;try{process.kill(-child.pid,sig);}catch{}};
    const stop=e=>{failure ||= e;expire();if(killed)return;killed=true;if(grace>0){group('SIGTERM');graceTimer=setTimeout(()=>group('SIGKILL'),grace);}else group('SIGKILL');};
    const deliver=value=>{work=work.then(()=>failure?undefined:onLine(value)).catch(stop);};
    const abort=()=>stop(signal.reason??new Error('Aborted'));
    const timer=setTimeout(()=>stop(new Error(`Command deadline exceeded: ${basename(String(binary))}`)),timeout);
    signal?.addEventListener('abort',abort,{once:true});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',b=>{out+=b;if(out.length>maxBytes)return stop(new Error('Output bound exceeded'));if(onLine){line+=b;let n;while((n=line.indexOf('\n'))>=0){const value=line.slice(0,n);line=line.slice(n+1);deliver(value);}}});
    child.stderr.on('data',b=>{err=(err+b).slice(-64000);});
    child.stdin.on('error',e=>{if(e.code!=='EPIPE')stop(e);});
    child.once('error',e=>{failure ||= e;});
    // Members a killed leader left behind get one immediate SIGKILL (a group with members keeps its ID).
    // The deadline and abort stay armed until pending line handlers settle, so a parent check cannot hang either.
    child.once('close',async(code,sig)=>{clearTimeout(graceTimer);if(killed)group('SIGKILL');closed=true;children.delete(child);
      if(onLine&&line){deliver(line);line='';}
      await Promise.race([work,expired]);clearTimeout(timer);signal?.removeEventListener('abort',abort);
      if(failure||code!==0){const e=failure?Object.assign(new Error(String(failure?.message??failure),{cause:failure}),{name:failure?.name||'Error'}):new Error(`Command exited ${code??sig}`);e.code=code;e.stderr=err;reject(e);}else accept(out.trim());});
    if(input&&typeof input.pipe==='function')input.pipe(child.stdin);else child.stdin.end(input);
  });
}
// Explicit native daemon: an inherited host or context is refused rather than silently replaced.
export function operatorDocker(env=process.env) {
  assert.ok(env.HOME&&isAbsolute(env.HOME),'The operator HOME must be absolute so its Docker client configuration is kept');
  const config=env.DOCKER_CONFIG||join(env.HOME,'.docker');assert.ok(isAbsolute(config),'DOCKER_CONFIG must be absolute');
  assert.ok(!env.DOCKER_HOST||env.DOCKER_HOST===NATIVE_DOCKER_HOST,`Refusing inherited DOCKER_HOST; this fixture targets only ${NATIVE_DOCKER_HOST}`);
  assert.ok(!env.DOCKER_CONTEXT||env.DOCKER_CONTEXT==='default','Refusing an inherited non-default DOCKER_CONTEXT');
  return {home:env.HOME,config};
}
export function fixtureEnvironments({operator,privateHome,privateTmp,execPath=process.execPath}) {
  const base={PATH:`${dirname(execPath)}:/usr/local/bin:/usr/bin:/bin`,LANG:'C.UTF-8',TMPDIR:privateTmp};
  return {tool:{...base,HOME:privateHome},docker:{...base,HOME:operator.home,DOCKER_CONFIG:operator.config,DOCKER_HOST:NATIVE_DOCKER_HOST}};
}
export const environmentFor=(binary,envs)=>binary==='docker'?envs.docker:envs.tool;
export const upgradedToolIds=ids=>[...new Set([...ids.map(id=>LEGACY[id]||id),TASK_TOOL])];
// Upgrade may add fields; every original field and value must remain. Lists stay exact.
export function assertRetained(found,expected,at='value') {
  if(Array.isArray(expected)) {assert.ok(Array.isArray(found),`${at} must remain a list`);assert.equal(found.length,expected.length,`${at} length changed`);expected.forEach((v,i)=>assertRetained(found[i],v,`${at}[${i}]`));return;}
  if(expected&&typeof expected==='object') {assert.ok(found&&typeof found==='object'&&!Array.isArray(found),`${at} must remain an object`);for(const [k,v] of Object.entries(expected)){assert.ok(Object.hasOwn(found,k),`${at}.${k} was dropped`);assertRetained(found[k],v,`${at}.${k}`);}return;}
  assert.equal(found,expected,`${at} changed`);
}
export function assertUpgradedProfile(found,old) {
  assertRetained(found,{...old,allowedTools:upgradedToolIds(old.allowedTools)},`profile ${old.id}`);
  assert.equal(found.board?.manageProjects,false,'An upgrade must not widen board access');
}
export function assertUpgradedHistory(found,old) {
  assert.deepEqual(found.events,old.events,'Completed run events must survive unchanged');
  assertRetained(found.run,old.run,`run ${old.run.id}`);
  assert.deepEqual([found.run.pendingApprovals,found.run.pendingInputs],[[],[]],'Completed historical work has nothing pending');
}
export function assertRevisionsAfterUpgrade(rows,old,saved) {
  const key=r=>`${r.agent_id}\0${r.revision}`,before=new Set(old.map(key));
  for(const r of old)assert.deepEqual(rows.find(x=>key(x)===key(r)),r,`Revision ${r.agent_id}@${r.revision} must stay byte-identical`);
  const added=rows.filter(r=>!before.has(key(r)));
  assert.deepEqual(added.map(r=>r.agent_id).sort(),Object.keys(saved).sort(),'Only the reviewed profile edits may add revisions');
  for(const r of added){assert.equal(r.revision,Math.max(...old.filter(x=>x.agent_id===r.agent_id).map(x=>x.revision))+1);assert.deepEqual(JSON.parse(r.json),saved[r.agent_id]);}
}
export function assertAdvertised(records,{kind,stage,granted,required=[],credential,finished=true}) {
  assert.ok(!records.some(r=>r.failure||r.rejected),'The scripted provider recorded a contract failure or a rejected credential');
  const turns=records.filter(r=>!r.auxiliary&&r.kind===kind&&r.stage===stage);assert.ok(turns.length,`No agent requests for ${kind} ${stage}`);
  for(const r of turns) {
    for(const name of r.advertised)assert.ok(granted.includes(name),`Only granted tools may be model-visible: ${name}`);
    for(const name of required)assert.ok(r.advertised.includes(name),`Required tool missing: ${name}`);
    if(credential)assert.equal(r.credential,credential,`${kind} ${stage} must use the ${credential} saved credential`);
  }
  if(finished)assert.ok(turns.some(r=>r.finished),`${kind} ${stage} never finished`);
  return turns.length;
}
// Parent side of the browser helper's private line protocol; jobs run strictly in KINDS order.
export function browserHandshake({stage,handshake,prepare,confirmPending,verify}) {
  let index=0,active=null,pending=false,result;const mark=name=>fs.writeFileSync(join(handshake,name),'ok',{mode:0o600});
  const onLine=async line=>{
    if(!line.trim())return;const e=JSON.parse(line);
    if(e.event==='result'){assert.equal(result,undefined,'Duplicate browser result');assert.equal(index,KINDS.length,'Browser result before every job was checked');assert.equal(e.result?.stage,stage);result=e.result;return;}
    assert.equal(e.stage,stage,'Browser stage mismatch');
    if(e.event==='before-job'){assert.equal(active,null);assert.equal(e.kind,KINDS[index],'Unexpected browser job order');active=e.kind;pending=false;if(e.kind!=='MAIN'){await prepare(e.kind);mark(`${e.kind}.ready`);}return;}
    assert.equal(e.kind,active,'Browser event for a job that is not active');
    if(e.event==='approval-pending'){assert.ok(active!=='MAIN'&&!pending,'Unexpected approval handshake');pending=true;await confirmPending(e.kind,e.runId);mark(`${e.kind}.pending`);return;}
    if(e.event==='after-job'){await verify(e.kind,e.runId,pending);mark(`${e.kind}.checked`);active=null;index++;return;}
    throw new Error(`Unknown browser event ${e.event}`);
  };
  return {onLine,result:()=>result};
}
const manifestScript=`const fs=require('fs'),crypto=require('crypto');const rows=[];function walk(p,n=''){const s=fs.lstatSync(p);if(s.isSocket())return;const r={path:n,mode:s.mode,uid:s.uid,gid:s.gid,kind:s.isDirectory()?'directory':s.isSymbolicLink()?'symlink':'file'};if(s.isFile())r.sha256=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');else if(s.isSymbolicLink())r.target=fs.readlinkSync(p);else if(!s.isDirectory())throw Error('Unexpected state file type');rows.push(r);if(s.isDirectory())for(const f of fs.readdirSync(p).sort())walk(p+'/'+f,n+'/'+f);}walk('/state');console.log(JSON.stringify(rows));`;
// Reads a private copy (database plus WAL, never the shared-memory index) so live state is never opened.
const revisionsScript=`const fs=require('fs'),{DatabaseSync}=require('node:sqlite');const d=fs.mkdtempSync('/tmp/revisions-');for(const n of ['state.db','state.db-wal'])if(fs.existsSync('/state/'+n))fs.copyFileSync('/state/'+n,d+'/'+n);const db=new DatabaseSync(d+'/state.db');const rows=db.prepare('SELECT agent_id,revision,json FROM profile_revisions ORDER BY agent_id,revision').all();db.close();console.log(JSON.stringify(rows));`;
export async function runFixture(c) {
  validateConfig(c);
  // Source validation happens before creating durable directories or asking Docker to do anything.
  const snapshotSource=c.currentSnapshot?preflightSnapshot(c.currentSnapshot,c.images):undefined;
  assert.equal(process.platform,'linux');assert.equal(process.arch,'arm64');assert.equal(process.getuid(),1000);assert.equal(process.getgid(),1000);
  let historicalBuild;
  if(c.historicalCommit===REPAIRED_HISTORICAL){const bytes=fs.readFileSync(c.historicalBuildReceipt.path);assert.equal(hash(bytes),c.historicalBuildReceipt.sha256,'Fresh historical build receipt changed');historicalBuild=JSON.parse(bytes);assertHistoricalBuildReceipt(historicalBuild,c);}
  const [major,minor]=process.versions.node.split('.').map(Number);assert.ok(major>22||(major===22&&minor>=13),'Node 22.13+ is required');
  const operator=operatorDocker(),parent=fs.realpathSync(c.workParent);
  // The resolved parent, not only its spelling, must be durable storage.
  assert.ok(!TEMPORARY.test(parent),'Evidence must be durable');assert.ok(fs.statSync(parent).isDirectory());
  validateSocketParent(parent);
  assert.ok(fs.statSync(c.chromiumExecutable).isFile());fs.accessSync(c.chromiumExecutable,fs.constants.X_OK);
  assert.ok(fs.statSync(NATIVE_DOCKER_HOST.slice('unix://'.length)).isSocket(),'The explicit local native Docker socket is required');
  const root=fs.mkdtempSync(join(parent,'oh-upgrade-'));fs.chmodSync(root,0o700);
  const privateDir=join(root,'private'),evidenceDir=join(root,'evidence'),privateHome=join(privateDir,'home'),privateTmp=join(privateDir,'tmp');for(const p of [privateDir,evidenceDir,privateHome,privateTmp])fs.mkdirSync(p,{mode:0o700});
  const envs=fixtureEnvironments({operator,privateHome,privateTmp});
  const owner='oh-upgrade-'+randomUUID().slice(0,12),project=owner+'-current',controller=new AbortController(),children=new Set(),apps=new Set();
  const evidence={ok:false,owner,project,root,mode:'New real historical-source / production-Compose / original-backup rollback; scripted provider, not model reasoning',historicalSourceCommit:c.historicalCommit,historicalBuildAttestation:historicalBuild?{kind:'Fresh observed build from an unchanged source checkpoint; not an official release artifact or recovered original attestation',receiptSha256:c.historicalBuildReceipt.sha256,imageId:historicalBuild.imageId}:'missing; new source-content and Hermes-pin checks only',environment:{dockerHost:NATIVE_DOCKER_HOST,dockerClientConfig:operator.config,dockerClientHome:'operator',toolHome:'private'},phases:[],checks:[],observations:{}};
  let engine,endpoint,apiBase,token,current=false,state,network,provider,providerUrl,providerBase,baselineSnapshot,beforeManifest,oldRevisions,backup,seeded;
  const durable=(dir,n,value)=>fs.writeFileSync(join(dir,n),JSON.stringify(value,null,2)+'\n',{mode:0o600});
  const save=(n,v)=>durable(evidenceDir,n,v),privateSave=(n,v)=>durable(privateDir,n,v);
  const check=(name,condition)=>{assert.ok(condition,name);evidence.checks.push(name);};
  const disk=n=>{const v=fs.statfsSync(root),free=v.bavail*v.bsize;assert.ok(free>=n*1024**3,`Disk floor ${n}GiB reached`);return free;};
  const run=async(b,args,opts={})=>{try{return await command(b,args,{env:environmentFor(b,envs),signal:controller.signal,children,...opts});}catch(e){privateSave(`command-failure-${randomUUID()}.json`,{binary:b,args,code:e.code??null,message:e.message,stderr:e.stderr??''});throw e;}};
  const docker=(...args)=>run('docker',args);
  const image=async ref=>{const rows=JSON.parse(await docker('image','inspect',ref));assert.equal(rows.length,1);return rows[0];};
  const owned=(info,kind)=>assert.equal((kind==='container'?info.Config.Labels:info.Labels)?.[LABEL],owner,'Refuse foreign resource');
  const inspect=async(kind,id)=>JSON.parse(await docker(kind,'inspect',id))[0];
  const remove=async(kind,id)=>{const info=await inspect(kind,id);owned(info,kind);await docker(kind,'rm',...(kind==='container'?['-f']:[]),kind==='volume'?info.Name:info.Id);};
  const volume=async name=>{assert.ok(!(await docker('volume','ls','-q')).split('\n').includes(name),'Refuse an existing volume');await docker('volume','create','--label',`${LABEL}=${owner}`,name);owned(await inspect('volume',name),'volume');return name;};
  const container=async(name,args)=>{const id=await docker('run','-d','--pull','never','--name',name,'--label',`${LABEL}=${owner}`,...args);assert.match(id,/^[a-f0-9]{64}$/);return id;};
  const helper=async(args,{input,timeout=120000,user='0'}={})=>run('docker',['run','--rm','--pull','never','--name',owner+'-helper-'+randomUUID().slice(0,8),'--label',`${LABEL}=${owner}`,'--network','none','--user',user,...args],{input,timeout});
  const stateMount=(target='/state',ro=false)=>`type=${current?'volume':'bind'},source=${state},target=${target}${ro?',readonly':''}`;
  const nodeState=async(script,ro=true)=>JSON.parse(await helper(['--mount',stateMount('/state',ro),'--entrypoint','node',c.images.coordinator.id,'-e',script]));
  const stateManifest=()=>nodeState(manifestScript);
  const proof=`/state/agents/${AGENT}/private/approval-proof.txt`;
  const setMode=()=>nodeState(`require('fs').chmodSync('${proof}',0o600);console.log('true')`,false);
  const mode=()=>nodeState(`console.log(require('fs').statSync('${proof}').mode&511)`);
  const bounded=()=>AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]);
  const request=(path,method='GET',data)=>fetch(apiBase+path,{method,signal:bounded(),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});
  const api=async(path,method='GET',data)=>{const r=await request(path,method,data);assert.ok(r.ok,`${method} ${path}: ${r.status}`);return r.json();};
  const providerRecords=async()=>{const r=await fetch(providerBase+'/__fixture/requests',{signal:bounded()});assert.ok(r.ok,'Scripted provider records are unavailable');return r.json();};
  const until=async(fn,ms=60000)=>{const end=Date.now()+ms;let error;while(Date.now()<end){controller.signal.throwIfAborted();try{return await fn();}catch(e){error=e;await pause(250,undefined,{signal:controller.signal});}}throw error||new Error('Readiness deadline');};
  // Relative Compose paths (the DinD entrypoint bind) resolve against the extracted current source.
  const dcArgs=['compose','--project-name',project,'--project-directory',join(root,'current'),'--env-file',join(root,'compose.env'),'-f',join(root,'current','compose.yaml'),'-f',join(root,'override.yaml')];
  const dc=(...args)=>run('docker',[...dcArgs,...args],{timeout:240000});
  const inner=(...args)=>docker('exec',engine,'docker',...args);
  const nested=(agent,...args)=>docker('exec',engine,'docker','exec','open-harness-'+agent,...args);
  const live=()=>[...apps].filter(p=>p.exitCode===null&&p.signalCode===null);
  const stopApps=async()=>{for(const app of apps){app.expectedExit=true;try{process.kill(-app.pid,'SIGTERM');}catch{}}let end=Date.now()+25000;while(live().length&&Date.now()<end)await pause(100);for(const app of live()){try{process.kill(-app.pid,'SIGKILL');}catch{}}end=Date.now()+5000;while(live().length&&Date.now()<end)await pause(100);const left=live().length;apps.clear();assert.equal(left,0,'Original app processes must exit');};
  const startApp=(entry,cwd,extra,log)=>{const fd=fs.openSync(join(privateDir,log),'a',0o600);let app;try{app=spawn(process.execPath,entry,{cwd,env:{...envs.tool,...extra},detached:true,stdio:['ignore',fd,fd]});}finally{fs.closeSync(fd);}app.expectedExit=false;apps.add(app);app.once('error',e=>controller.abort(e));app.once('exit',(code,sig)=>{if(!app.expectedExit)controller.abort(new Error(`${log} exited unexpectedly (${code??sig})`));});return app;};
  const bindImage=async key=>{const ref=c.images[key],a=await image(ref.id);assert.equal(a.Id,ref.id);assert.equal(a.Os,'linux');assert.equal(a.Architecture,'arm64');if(ref.tag)assert.equal((await image(ref.tag)).Id,ref.id);return {requestedReference:ref.id,imageInspectId:a.Id,tag:ref.tag||null,os:a.Os,architecture:a.Architecture,size:a.Size};};
  const transfer=async key=>{
    await bindImage(key);disk(c.floors.engine);
    const saveProcess=spawn('docker',['image','save',c.images[key].tag],{env:envs.docker,detached:true,stdio:['ignore','pipe','pipe']});children.add(saveProcess);
    let saveError='';saveProcess.stderr.on('data',b=>{saveError=(saveError+b).slice(-4000);});
    const saved=new Promise((resolve,reject)=>{saveProcess.once('error',reject);saveProcess.once('close',code=>{children.delete(saveProcess);code===0?resolve():reject(new Error(`Image save exited ${code}`));});});
    saved.catch(()=>{});// Awaited below; a failed load must not leave an unhandled rejection behind.
    const kill=()=>{if(saveProcess.exitCode===null&&saveProcess.signalCode===null){try{process.kill(-saveProcess.pid,'SIGKILL');}catch{}}};controller.signal.addEventListener('abort',kill,{once:true});
    try{await Promise.all([saved,run('docker',['exec','-i',engine,'docker','load'],{input:saveProcess.stdout,timeout:c.deadlines.transfer*1000})]);}
    finally{kill();controller.signal.removeEventListener('abort',kill);fs.writeFileSync(join(privateDir,`image-save-${key}-stderr.log`),saveError,{mode:0o600});}
    const data=JSON.parse(await inner('image','inspect',c.images[key].tag))[0];save(`${current?'current':'old'}-nested-image-${randomUUID().slice(0,6)}.json`,{requestedReference:c.images[key].tag,outerImageInspectId:c.images[key].id,innerImageInspectId:data.Id,comparison:'Different Docker stores may expose different index/config identities; equality is not asserted.'});
  };
  const freshPort=async()=>{const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;};
  const oldEngine=async stage=>{
    disk(c.floors.engine);assert.equal(engine,undefined);const cache=await volume(owner+'-'+stage+'-cache'),control=join(root,stage+'-control');fs.mkdirSync(control,{mode:0o700});
    engine=await container(owner+'-'+stage,['--privileged','--network',network,'-e','DOCKER_TLS_CERTDIR=','--mount',`type=volume,source=${cache},target=/var/lib/docker`,'--mount',`type=bind,source=${state},target=${state}`,'--mount',`type=bind,source=${control},target=/run/fixture`,c.images.oldEngine.id,'dockerd','--host=unix:///run/fixture/docker.sock','--group=1000']);
    await until(()=>docker('exec',engine,'docker','-H','unix:///run/fixture/docker.sock','info'),c.deadlines.engine*1000);
    // Inner CLI uses the same socket; the engine has no published TCP listener.
    await docker('exec',engine,'sh','-c','ln -s /run/fixture/docker.sock /var/run/docker.sock');
    await transfer('historical');return {cache,host:'unix://'+join(control,'docker.sock')};
  };
  const native=async stage=>{
    current=false;const {cache,host}=await oldEngine(stage);const port=await freshPort(),uiPort=await freshPort();
    const common={DOCKER_HOST:host,OPEN_HARNESS_HERMES_IMAGE:c.images.historical.tag,OPEN_HARNESS_STATE_DIR:state,OPEN_HARNESS_DISABLE_OS_VAULT:'1',OPEN_HARNESS_MOCK:'0',OPEN_HARNESS_PORT:String(port),OPEN_HARNESS_INTERNAL_CONTROL_URL:`http://127.0.0.1:${port}`};
    const source=join(root,'historical');startApp(['--import','tsx','runtime/service.ts'],source,common,stage+'-coordinator.log');
    // Original0.3's browser defaults to4317; its existing controlPort option selects this isolated coordinator.
    endpoint=`http://127.0.0.1:${uiPort}?controlPort=${port}`;apiBase=`http://127.0.0.1:${port}`;
    token=await until(async()=>{const r=await fetch(apiBase+'/v1/bootstrap',{signal:AbortSignal.timeout(3000)});assert.ok(r.ok);const b=await r.json();assert.ok(b.token);return b.token;});
    startApp(['dist/standalone/server.js'],source,{...common,PORT:String(uiPort),HOST:'127.0.0.1'},stage+'-ui.log');
    await until(async()=>assert.equal((await fetch(endpoint,{signal:AbortSignal.timeout(3000)})).status,200));
    // Original0.3 routes /runs/stop-all as run ID "stop-all" and returns404. Its supported
    // SIGTERM shutdown stops every retained gateway; verify terminal work first and containers afterward.
    return async()=>{assertHistoricalQuiescent((await api('/v1/runs')).runs);await stopApps();assert.equal(await inner('ps','-q'),'');await remove('container',engine);engine=undefined;await remove('volume',cache);};
  };
  const seed=async()=>{
    await api('/v1/secrets','POST',{name:CREDENTIAL,value:ORIGINAL});
    await api('/v1/agents/sync','POST',{agents:[{id:AGENT,name:'Upgrade Alpha',role:'Writer',description:'Historical revision three',instructions:'Work only on the synthetic upgrade fixture.',tone:0,memory:[]},{id:PEER,name:'Upgrade Beta',role:'Observer',instructions:'Synthetic fixture only.',memory:[]}]});
    for(const id of [AGENT,PEER]) {
      let p=(await api(`/v1/agents/${id}/profile`)).profile;
      // Exactly what original0.3 itself stores: its own coordination grant name, no clarify and no desktop.
      while(p.revision<3)p=(await api(`/v1/agents/${id}/profile`,'PUT',{...p,description:'Historical revision three',prompt:{enabled:true,text:'Work only on the synthetic upgrade fixture.'},model:{inherit:false,provider:'local',model:'upgrade-fixture',baseUrl:providerUrl,credentialRef:CREDENTIAL},allowedTools:['write_file','terminal','mcp_open_harness_task'],computer:{...p.computer,access:'private',desktop:'none',folders:[]}})).profile;
      assert.equal(p.revision,3);assert.deepEqual([...p.allowedTools].sort(),GRANTED.historical);
    }
    await api(`/v1/agents/${AGENT}/context`,'PUT',{memory:'UPGRADE_MEMORY_RETAINED\n'});
    await api(`/v1/agents/${AGENT}/context/skills/upgrade-proof`,'PUT',{content:'---\nname: upgrade-proof\ndescription: Synthetic upgrade retention\n---\nUPGRADE_SKILL_RETAINED\n'});
    for(const [name,content] of [['private-proof.txt','UPGRADE_PRIVATE_RETAINED'],['approval-proof.txt','UPGRADE_APPROVAL_ONLY']])await api(`/v1/files?scope=private&agentId=${AGENT}`,'POST',{name,content});
    await api('/v1/files?scope=shared','POST',{name:'shared-proof.txt',content:'UPGRADE_SHARED_RETAINED'});
    const board=await api('/v1/boards','POST',{name:'Upgrade acceptance board'});
    const task=await api('/v1/tasks','POST',{boardId:board.id,stageId:board.stages[0].id,title:'Upgrade retained task',ownerAgentId:AGENT});
    return {boardId:board.id,taskId:task.id};
  };
  const snapshot=async()=>{
    const runs=(await api('/v1/runs')).runs.filter(r=>r.agent_id===AGENT),history=[];
    for(const r of runs)history.push({runId:r.id,snapshot:await api(`/v1/runs/${r.id}/events?after=0`)});
    return {profiles:await Promise.all([AGENT,PEER].map(async id=>(await api(`/v1/agents/${id}/profile`)).profile)),context:(await api(`/v1/agents/${AGENT}/context`)).memory,skill:(await api(`/v1/agents/${AGENT}/context/skills/upgrade-proof`)).content,privateFile:(await api(`/v1/files?scope=private&agentId=${AGENT}&name=private-proof.txt`)).content,sharedFile:(await api('/v1/files?scope=shared&name=shared-proof.txt')).content,task:await api(`/v1/tasks/${seeded.taskId}`),history};
  };
  // exact: the same release reads the same data. upgraded: every original field kept, documented renames only.
  const preserve=async mode=>{
    const found=await snapshot();
    assert.deepEqual(found.history.map(h=>h.runId).sort(),baselineSnapshot.history.map(h=>h.runId).sort(),'Exactly the original completed runs must be present');
    for(const key of ['context','skill','privateFile','sharedFile'])assert.deepEqual(found[key],baselineSnapshot[key],`Retain ${key}`);
    if(mode==='exact') {
      for(const key of ['profiles','task'])assert.deepEqual(found[key],baselineSnapshot[key],`Retain ${key}`);
      for(const old of baselineSnapshot.history)assert.deepEqual(found.history.find(h=>h.runId===old.runId),old,'Completed run and full event history must survive');
    } else {
      baselineSnapshot.profiles.forEach((old,i)=>assertUpgradedProfile(found.profiles[i],old));assertRetained(found.task,baselineSnapshot.task,'task');
      for(const old of baselineSnapshot.history)assertUpgradedHistory(found.history.find(h=>h.runId===old.runId).snapshot,old.snapshot);
    }
    return {mode,retainedHistory:baselineSnapshot.history.length,profiles:found.profiles.map(p=>({id:p.id,revision:p.revision})),privateSharedContextTask:true};
  };
  const verifyJob=async(kind,stage,runId)=>{
    const value=await api(`/v1/runs/${runId}/events?after=0`),upgraded=stage==='UPGRADED',events=value.events,tool=name=>events.find(e=>e.type==='tool.complete'&&e.payload?.name===name);
    assert.equal(value.run.state,'completed');assert.equal(value.run.agent_id,AGENT);assert.match(value.run.result,new RegExp(`REAL_UPGRADE_${kind}_${stage}_COMPLETE`));
    assertAdvertised(await providerRecords(),{kind,stage,granted:GRANTED[upgraded?'upgraded':'historical'],required:REQUIRED[upgraded?'upgraded':'historical'][kind],credential:'original'});
    if(kind==='MAIN') {
      assert.ok(tool('write_file'),'write_file must complete');
      assert.equal((await api(`/v1/files?scope=shared&name=upgrade-${stage.toLowerCase()}.txt`)).content,`UPGRADE_FILE_${stage}\n`);
      if(upgraded) {
        for(const t of ['clarify.request','input.resolved'])assert.ok(events.some(e=>e.type===t),t);
        const task=tool(TASK_TOOL);assert.ok(task,'The renamed coordination grant must reach the coordinator');assert.match(JSON.stringify(task.payload.result),/Upgrade acceptance board/);assert.doesNotMatch(JSON.stringify(task.payload.result),/ECONNREFUSED|disabled|authentication/i);
      } else assert.ok(!events.some(e=>e.type==='clarify.request'),'Original0.3 profiles never grant clarify');
    } else if(upgraded) {
      const decision=kind==='DENY'?'deny':'approve';assert.equal(events.filter(e=>e.type==='approval.request').length,1);
      assert.ok(events.some(e=>e.type==='approval.resolved'&&e.payload.decision===decision));assert.equal(await mode(),decision==='approve'?0o666:0o600,`Actual terminal effect must match ${decision}`);
    } else {
      // Real603 acceptance showed an approval prompt. Its coordinator sends decision, while the
      // pinned gateway reads choice with default deny: both original UI choices must have no effect.
      assert.equal(events.filter(e=>e.type==='approval.request').length,1);
      assert.ok(events.some(e=>e.type==='approval.resolved'&&e.payload.decision===(kind==='DENY'?'deny':'approve')));
      assert.ok(tool('terminal'),'The flagged fixture command must be dispatched');assert.equal(await mode(),0o600,'Original gateway defaults both UI choices to deny');
      const observed=(await mode()).toString(8),seen=evidence.observations.originalApprovalProofMode ||= {};seen[`${stage}/${kind}`]=observed;
      if(stage==='ROLLBACK')assert.equal(observed,seen[`BASELINE/${kind}`],'The restored original must behave as before the upgrade');
    }
    const running=await inner('inspect','-f','{{.State.Running}}','open-harness-'+AGENT);
    if(upgraded)assert.equal(running,'false','Completed agent container must stop');else (evidence.observations.originalAgentContainerRunningAfterJob ||= {})[`${stage}/${kind}`]=running;
  };
  const browserPhase=async(stage,pairCode)=>{
    const handshake=join(privateDir,stage.toLowerCase()+'-handshake');fs.mkdirSync(handshake,{mode:0o700});
    const protocol=browserHandshake({stage,handshake,
      prepare:async()=>{await setMode();assert.equal(await mode(),0o600);},
      confirmPending:async(kind,runId)=>{const s=await api(`/v1/runs/${runId}/events?after=0`);assert.equal(s.run.state,'waiting_approval');const pending=s.events.filter(e=>e.type==='approval.request'&&!s.events.some(r=>r.type==='approval.resolved'&&r.payload.approvalId===e.payload.approvalId));assert.equal(pending.length,1);if(stage==='UPGRADED')assert.equal(s.run.pendingApprovals.length,1);assert.equal(await mode(),0o600,'No flagged command before approval');},
      verify:(kind,runId)=>verifyJob(kind,stage,runId)});
    const input={dependencies:join(root,'historical'),chromiumExecutable:c.chromiumExecutable,url:endpoint,api:apiBase,token,stage,pairCode,handshake};
    // Chromium's singleton Unix socket cannot fit under the durable evidence directory.
    // Only browser scratch is temporary; failure diagnostics stay in the private handshake directory.
    const browserTmp=fs.mkdtempSync('/tmp/oh-upgrade-browser-');fs.chmodSync(browserTmp,0o700);
    try{await run(process.execPath,[join(HERE,'helpers/upgrade-browser.mjs')],{env:{...envs.tool,TMPDIR:browserTmp},input:JSON.stringify(input),timeout:c.deadlines.browser*1000,grace:15000,onLine:protocol.onLine});}
    finally{fs.rmSync(browserTmp,{recursive:true,force:true});}
    const result=protocol.result();assert.equal(result?.ok,true);assert.deepEqual(result.results.map(r=>r.kind),[...KINDS]);await setMode();save(stage.toLowerCase()+'-browser.json',result);return result;
  };
  const archiveState=async destination=>helper(['--mount',stateMount('/source',true),'--mount',`type=bind,source=${privateDir},target=/backup`,'--entrypoint','tar',c.images.coordinator.id,'-czpf','/backup/'+destination,'-C','/source','.']);
  const restoreState=async()=>{
    const empty=await stateManifest();assert.equal(empty.length,1);assert.equal(empty[0].kind,'directory');
    await helper(['--mount',stateMount('/target'),'--mount',`type=bind,source=${privateDir},target=/backup,readonly`,'--entrypoint','tar',c.images.coordinator.id,'-xzpf','/backup/'+backup,'-C','/target']);
    compareManifests(await stateManifest(),beforeManifest);save(`${current?'current':'rollback'}-empty-restore.json`,{destination:state,wasEmpty:true,entries:beforeManifest.length,fileHashesModesOwnersEqual:true});
  };
  const ownershipMigration=async()=>{
    const changed=beforeManifest.filter(e=>e.uid!==1000||e.gid!==1000).length;
    await helper(['--mount',stateMount('/data'),'--entrypoint','chown',c.images.coordinator.id,'-R','1000:1000','/data']);
    compareManifests(await stateManifest(),beforeManifest,{migrated:true});save('ownership-migration.json',{documentedOperation:'chown -R 1000:1000 /data',entriesNotAlready1000:changed,contentModesPathsPreserved:true,uid:1000,gid:1000});
  };
  const desktop=async()=>{
    const holds=[];
    for(const id of [AGENT,PEER]){const run=await api('/v1/runs','POST',{agentId:id,prompt:'UPGRADE_HOLD_UPGRADED: retain private desktop for actual input checks.'});holds.push(run);await until(async()=>{const s=await api(`/v1/runs/${run.id}/events?after=0`);assert.equal(s.run.state,'waiting_input');assert.equal(s.run.pendingInputs.length,1);},180000);}
    assertAdvertised(await providerRecords(),{kind:'HOLD',stage:'UPGRADED',granted:GRANTED.upgraded,required:REQUIRED.upgraded.HOLD,credential:'rotated',finished:false});
    for(const [id,other] of [[AGENT,PEER],[PEER,AGENT]]) {
      const isolation=JSON.parse(await nested(id,'python','-c',`import json,os\nfrom pathlib import Path\nassert os.environ['DISPLAY']==':99'\nassert os.environ['DBUS_SESSION_BUS_ADDRESS']=='unix:path=/tmp/open-harness-session-bus'\nfor path in ['/data','/var/run/docker.sock','/run/open-harness-docker/docker.sock','/home/node','/data/agents/${other}']:\n assert not Path(path).exists(),path\nPath('/workspace/private/desktop-owner.txt').write_text('${id}')\nprint(json.dumps({'privateOwner':'${id}'}))`));
      assert.equal(isolation.privateOwner,id);
    }
    for(const id of [AGENT,PEER])assert.equal((await api(`/v1/files?scope=private&agentId=${id}&name=desktop-owner.txt`)).content,id);
    await api('/v1/files?scope=shared','POST',{name:'compose-desktop.py',content:fs.readFileSync(join(root,'current/tests/helpers/compose-desktop.py'),'utf8')});
    const output=await run('docker',['exec',engine,'docker','exec','open-harness-'+AGENT,'python','/workspace/shared/compose-desktop.py'],{timeout:150000});
    const d=JSON.parse(output.split('\n').findLast(l=>l.startsWith('{')&&l.includes('screenshotBytes')));assert.equal(d.clickReadback,'CLICK_CONFIRMED_729');assert.equal(d.typeReadback,'COMPOSE_DESKTOP_729');
    const screenshot=Buffer.from((await api('/v1/files?scope=shared&name=compose-desktop.png')).content,'base64');assert.equal(screenshot.length,d.screenshotBytes);assert.equal(screenshot.subarray(0,8).toString('hex'),'89504e470d0a1a0a');fs.writeFileSync(join(evidenceDir,'current-desktop.png'),screenshot,{mode:0o600});
    assert.match(await nested(AGENT,'xwininfo','-root','-tree'),/Compose private desktop proof/);
    assert.doesNotMatch(await nested(PEER,'xwininfo','-root','-tree'),/Compose private desktop proof/);
    for(const run of holds)await api(`/v1/runs/${run.id}/stop`,'POST',{});
    await until(async()=>{for(const run of holds)assert.equal((await api(`/v1/runs/${run.id}/events?after=0`)).run.state,'cancelled');assert.equal(await inner('ps','-q'),'');});
    save('current-desktop.json',{...d,twoAgentIsolation:true,currentRuntimeOnly:true});
  };
  let failure,monitor,deadline;
  const onSignal=name=>controller.abort(new Error('Signal '+name));const signals=new Map(['SIGINT','SIGTERM','SIGHUP'].map(n=>[n,()=>onSignal(n)]));
  try {
    for(const [n,fn]of signals)process.on(n,fn);
    disk(c.floors.initial);const mem=Number(fs.readFileSync('/proc/meminfo','utf8').match(/^MemAvailable:\s+(\d+)/m)[1])*1024;assert.ok(mem>=4*1024**3);
    const daemon=JSON.parse(await docker('info','--format','{{json .}}'));assert.equal(daemon.OSType,'linux');assert.equal(daemon.Architecture,'aarch64');
    assert.equal(fs.statSync(root).dev,fs.statSync(daemon.DockerRootDir).dev,'Disk guard must observe Docker storage filesystem');
    evidence.environment.daemon={serverVersion:daemon.ServerVersion,osType:daemon.OSType,architecture:daemon.Architecture,rootDir:daemon.DockerRootDir,securityOptions:daemon.SecurityOptions};
    monitor=setInterval(()=>{try{disk(c.floors.stop);}catch(e){controller.abort(e);}},5000);deadline=setTimeout(()=>controller.abort(new Error('Fixture total deadline')),c.deadlines.total*1000);
    save('config.json',{...c,rootReviewed:true});const fixtureFiles=['real-upgrade-smoke.mjs','helpers/upgrade-browser.mjs','helpers/upgrade-provider.mjs','helpers/upgrade-snapshot.mjs'];
    const fixtureSources=Object.fromEntries(fixtureFiles.map(n=>[n,{sha256:hash(fs.readFileSync(join(HERE,n))),mode:fs.statSync(join(HERE,n)).mode&0o777}]));save('fixture-source.json',fixtureSources);
    const sources={};
    for(const [name,ref,version]of [['historical',c.historicalCommit,'0.3.0'],['current',c.currentCommit,'0.4.0-beta.1']]){
      if(name==='current'&&snapshotSource){sources.current=copySnapshot(c.currentSnapshot,snapshotSource,join(root,'current'));assert.ok(fs.readFileSync(join(root,'current/runtime/hermes/Dockerfile'),'utf8').includes(HERMES));continue;}
      const source=join(root,name);fs.mkdirSync(source,{mode:0o700});const paths=sourcePaths(await run('git',['-C',c.repository,'ls-tree','-rz',ref]));
      await run('git',['-C',c.repository,'archive','--format=tar',`--output=${join(privateDir,name+'.tar')}`,ref]);await run('tar',['-xf',join(privateDir,name+'.tar'),'-C',source]);
      assert.equal(JSON.parse(fs.readFileSync(join(source,'package.json'))).version,version);
      // Every extracted file must be the committed blob itself: no archive filter or line-ending conversion.
      sources[name]={commit:ref,version,archiveSha256:hash(fs.readFileSync(join(privateDir,name+'.tar'))),files:paths.map(p=>{const b=fs.readFileSync(join(source,p.path));assert.equal(gitBlob(b),p.blob,'Extracted source differs from commit: '+p.path);return {...p,sha256:hash(b)};})};
      assert.ok(fs.readFileSync(join(source,'runtime/hermes/Dockerfile'),'utf8').includes(HERMES));
    }
    privateSave('source-manifests.json',sources);save('source-identities.json',Object.fromEntries(Object.entries(sources).map(([n,v])=>[n,{kind:v.kind??'git-archive',commit:v.commit,version:v.version,archiveSha256:v.archiveSha256,manifestSha256:v.manifestSha256,runtimeContract:v.runtimeContract,builds:v.builds,files:v.files.length}])));
    const identities={};for(const name of Object.keys(c.images))identities[name]=await bindImage(name);save('images.json',identities);
    assert.equal((await image(c.images.runtime.id)).Config.Labels?.['dev.openharness.runtime'],String(snapshotSource?.runtimeContract??6));
    const coor=await image(c.images.coordinator.id);assert.equal(coor.Config.User,'node');assert.deepEqual(coor.Config.Cmd,['node','/opt/open-harness/supervisor.mjs']);
    // New read-only byte inspection inside explicitly reviewed cached images. Not a recovered build attestation.
    for(const [name,key,prefix]of [['historical','historical','/opt/open-harness'],['current','runtime','/opt/open-harness'],['coordinator','coordinator','/opt/open-harness/runtime/hermes']]){
      const src=sources[name==='historical'?'historical':'current'];const expanded=key==='coordinator'&&snapshotSource;
      const actualPrefix=expanded?'/opt/open-harness':prefix;
      const expected=src.files.filter(f=>f.path.startsWith('runtime/hermes/')||(expanded&&(f.path.startsWith('runtime/ubuntu/')||f.path.startsWith('runtime/installers/')))).map(f=>({path:expanded?f.path:f.path.slice('runtime/hermes/'.length),sha256:f.sha256}));
      const code=`import json,hashlib,pathlib,sys\ne=json.load(sys.stdin)\nfor x in e:\n p=pathlib.Path('${prefix}')/x['path'];assert hashlib.sha256(p.read_bytes()).hexdigest()==x['sha256'],x['path']\n${key==='coordinator'?'':"h=pathlib.Path('/opt/hermes-agent/.git/HEAD').read_text().strip();assert h=='"+HERMES+"',h\n"}print(json.dumps({'files':len(e),'allMatched':True}))`;
      // Coordinator carries Node rather than Python; compare its copied runtime files with Node.
      const script=key==='coordinator'?['--entrypoint','node',c.images[key].id,'-e',`let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{const fs=require('fs'),h=require('crypto');const rows=JSON.parse(s);for(const r of rows)if(h.createHash('sha256').update(fs.readFileSync('${actualPrefix}/'+r.path)).digest('hex')!==r.sha256)throw Error(r.path);console.log(JSON.stringify({files:rows.length,allMatched:true}));});`]:['--entrypoint','python',c.images[key].id,'-I','-B','-c',code];
      const inspected=JSON.parse(await helper(['--read-only','-i',...script],{input:JSON.stringify(expected)}));save(name+'-source-content.json',{...inspected,sourceCommit:src.commit,sourceManifestSha256:src.manifestSha256,imageId:c.images[key].id,buildAttestationRecovered:false,...(key==='coordinator'?{}:{hermesCommit:HERMES})});
    }
    if(snapshotSource){
      // Build-only Ubuntu inputs are deliberately absent from the image. Re-run their checks
      // against actual dpkg state, retained archives and installed bytes using a public copy.
      const inputs=join(root,'ubuntu-probe');fs.mkdirSync(inputs,{mode:0o755});
      for(const f of snapshotSource.files.filter(f=>f.path.startsWith('runtime/ubuntu/'))){const p=join(inputs,f.path.slice('runtime/ubuntu/'.length));fs.mkdirSync(dirname(p),{recursive:true,mode:0o755});fs.writeFileSync(p,fs.readFileSync(join(root,'current',f.path)),{mode:0o644});assert.equal(hash(fs.readFileSync(p)),f.sha256);}
      const readable=p=>{const s=fs.lstatSync(p);fs.chmodSync(p,s.isDirectory()?0o755:0o644);if(s.isDirectory())for(const n of fs.readdirSync(p))readable(join(p,n));};readable(inputs);
      const script=`import json,sys,tempfile\nfrom pathlib import Path\nsys.path.insert(0,'/inputs/helpers')\nimport ohpkg,check_packages,debian_origin\np=Path('/inputs/lock/runtime-inputs.lock.json');lock=ohpkg.load_lock(p,'arm64')\nr=check_packages.check(lock,'arm64','/var/lib/dpkg/status','/inputs/lock/ubuntu-os-packages.txt')\nassert not any(r[k] for k in ('missing','unexpected','different')),r\nstored=json.loads(Path('/opt/open-harness/verification/packages.json').read_text())\nassert stored['lockSha256']==ohpkg.sha256_file(p) and stored['architecture']=='arm64'\nassert all(stored[k]==v for k,v in r.items())\ninventory=debian_origin.load_inventory('/opt/open-harness/verification/debian-origin-inventory.json',lock,'arm64')\nwith tempfile.TemporaryDirectory() as d:\n a=Path(d)/'os-release';b=Path(d)/'debian_version';a.write_text(inventory['debianOsRelease']);b.write_text(inventory['debianVersion'])\n actual=debian_origin.record(lock,'arm64','/','/opt/open-harness/debian-browser/packages',a,b)\n assert actual==inventory,'Actual Debian files or archives differ from build inventory'\nassert Path('/opt/open-harness/runtime-contract').read_text().strip()=='${snapshotSource.runtimeContract}'\nprint(json.dumps({'lockSha256':ohpkg.sha256_file(p),'packages':r['installed'],'debianInventoryDigest':inventory['digest'],'debianFiles':len(inventory['files']),'debianLinks':len(inventory['links']),'runtimeContract':${snapshotSource.runtimeContract},'actualFilesAndArchivesMatched':True}))`;
      const checked=JSON.parse(await helper(['--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=16m','--mount',`type=bind,source=${inputs},target=/inputs,readonly`,'-e','PYTHONDONTWRITEBYTECODE=1','--entrypoint','python',c.images.runtime.id,'-I','-B','-c',script],{user:'10001'}));save('current-ubuntu-content.json',{...checked,imageId:c.images.runtime.id,sourceManifestSha256:snapshotSource.manifestSha256});
      verifySnapshotTree(join(root,'current'),snapshotSource.files);
    }
    disk(c.floors.build);evidence.phases.push('historical-production-ui-build');save('progress.json',evidence);
    await run('npm',['ci','--cache',join(privateDir,'npm-cache')],{cwd:join(root,'historical'),timeout:c.deadlines.build*1000});
    await run('npm',['run','build'],{cwd:join(root,'historical'),timeout:c.deadlines.build*1000});
    network=owner+'-runtime';await docker('network','create','--label',`${LABEL}=${owner}`,network);
    provider=await container(owner+'-provider',['--network',network,'--mount',`type=bind,source=${join(HERE,'helpers/upgrade-provider.mjs')},target=/fixture.mjs,readonly`,'--entrypoint','node',c.images.coordinator.id,'/fixture.mjs']);
    const ip=(await inspect('container',provider)).NetworkSettings.Networks[network].IPAddress;assert.match(ip,/^\d+\.\d+\.\d+\.\d+$/);providerBase=`http://${ip}:3131`;providerUrl=providerBase+'/v1';
    await until(async()=>assert.equal((await fetch(providerUrl+'/models',{signal:AbortSignal.timeout(3000)})).status,200));
    state=join(root,'baseline-state');fs.mkdirSync(state,{mode:0o700});let stop=await native('baseline');seeded=await seed();
    evidence.phases.push('historical-ui-and-hermes');save('progress.json',evidence);await browserPhase('BASELINE');
    baselineSnapshot=await snapshot();privateSave('baseline-snapshot.json',baselineSnapshot);await stop();oldRevisions=await nodeState(revisionsScript);beforeManifest=await stateManifest();privateSave('baseline-file-manifest.json',beforeManifest);
    backup='before-upgrade.tgz';await archiveState(backup);save('backup.json',{writersStopped:true,sha256:hash(fs.readFileSync(join(privateDir,backup))),entries:beforeManifest.length,rawArchivePrivate:true});
    current=true;state=await volume(owner+'-data');await restoreState();await ownershipMigration();
    const cache=await volume(owner+'-current-cache'),control=await volume(owner+'-control');
    const environment={OPEN_HARNESS_HERMES_IMAGE:c.images.runtime.tag,OPEN_HARNESS_HERMES_PULL:'0',OPEN_HARNESS_DISABLE_OS_VAULT:'1',OPEN_HARNESS_REQUIRE_BROWSER_PAIRING:'1',OPEN_HARNESS_MOCK:'0'};
    // Compose !override is required for ports, otherwise its source default3000 mapping remains.
    fs.writeFileSync(join(root,'override.yaml'),`services:\n  docker:\n    image: ${c.images.engine.id}\n    labels: ${JSON.stringify({[LABEL]:owner})}\n  open-harness:\n    image: ${c.images.coordinator.id}\n    labels: ${JSON.stringify({[LABEL]:owner})}\n    ports: !override ["127.0.0.1::3000"]\n    environment: ${JSON.stringify(environment)}\nvolumes: ${JSON.stringify({'harness-data':{external:true,name:state},'harness-docker':{external:true,name:cache},'harness-control':{external:true,name:control}})}\nnetworks: ${JSON.stringify({runtime:{external:true,name:network},default:{labels:{[LABEL]:owner}}})}\n`,{mode:0o600});fs.writeFileSync(join(root,'compose.env'),'',{mode:0o600});
    const config=JSON.parse(await dc('config','--format','json')),service=config.services['open-harness'];
    assert.equal(service.image,c.images.coordinator.id);assert.equal(config.services.docker.image,c.images.engine.id);assert.equal(service.environment.OPEN_HARNESS_DEPLOYMENT,'compose');for(const [k,v] of Object.entries(environment))assert.equal(service.environment[k],v);
    assert.deepEqual(Object.keys(config.services.docker.networks),['runtime']);assert.deepEqual(Object.keys(service.networks),['default']);assert.equal(service.ports.length,1);assert.equal(service.ports[0].host_ip,'127.0.0.1');assert.deepEqual(config.services.docker.ports||[],[]);assertImageDefaults(service);
    const entry=config.services.docker.volumes.find(v=>v.target==='/usr/local/bin/open-harness-dind.sh');assert.equal(entry?.source,join(root,'current','runtime','dind-entrypoint.sh'));assert.equal(entry.read_only,true);
    save('production-compose-config.json',config);
    disk(c.floors.engine);await dc('up','-d','--no-build','--pull','never','--wait','--wait-timeout','180','docker');engine=await dc('ps','-q','docker');assert.match(engine,/^[a-f0-9]{64}$/);owned(await inspect('container',engine),'container');await transfer('runtime');
    await dc('up','-d','--no-build','--pull','never','--wait','--wait-timeout','180','open-harness');
    const published=await dc('port','open-harness','3000');assert.match(published,/^127\.0\.0\.1:\d+$/);endpoint='http://'+published;apiBase=endpoint+'/api/local';
    const coorId=await dc('ps','-q','open-harness');const running=await inspect('container',coorId);owned(running,'container');assert.equal(running.Image,c.images.coordinator.id);assert.equal(running.Config.User,'node');assert.deepEqual(running.Config.Cmd,coor.Config.Cmd);assert.ok(running.Mounts.some(m=>m.Type==='volume'&&m.Name===state&&m.Destination==='/data'));
    const unpaired=await fetch(apiBase+'/v1/bootstrap',{signal:bounded()});assert.equal(unpaired.status,401);assert.equal((await unpaired.json()).pairingRequired,true);
    const mint=async()=>JSON.parse(await dc('exec','-T','open-harness','node','/opt/open-harness/runtime/browser-pair.mjs'));
    const pair=async code=>fetch(apiBase+'/v1/browser/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code}),signal:bounded()});
    const first=await mint(),paired=await pair(first.code);assert.equal(paired.status,200);token=(await paired.json()).token;assert.ok(token);assert.equal((await pair(first.code)).status,401);
    save('current-restored-state.json',await preserve('upgraded'));
    const credential=await api('/v1/credentials/'+CREDENTIAL);assert.equal(credential.present,true);assert.ok(credential.fingerprint);assert.equal(credential.length,ORIGINAL.length,'The original write-only secret must be adopted, not recreated');
    const saved={};
    for(const id of [AGENT,PEER]){const p=(await api(`/v1/agents/${id}/profile`)).profile;const s=(await api(`/v1/agents/${id}/profile`,'PUT',{...p,allowedTools:[...p.allowedTools,'clarify','computer_use'],computer:{...p.computer,desktop:'virtual'}})).profile;assert.equal(s.revision,p.revision+1);assert.deepEqual([...s.allowedTools].sort(),GRANTED.upgraded);saved[id]=s;}
    evidence.phases.push('production-compose-paired-ui-and-hermes');save('progress.json',evidence);const browserCode=await mint();await browserPhase('UPGRADED',browserCode.code);assert.equal((await pair(browserCode.code)).status,401);
    const rotated=await api(`/v1/credentials/${CREDENTIAL}/value`,'POST',{value:ROTATED});assert.notEqual(rotated.fingerprint,credential.fingerprint);assert.equal(rotated.length,ROTATED.length);await desktop();
    const preRestart=await snapshot();assert.equal((await api('/v1/credentials/'+CREDENTIAL)).fingerprint,rotated.fingerprint);
    await dc('restart','open-harness');const publishedAgain=await dc('port','open-harness','3000');assert.match(publishedAgain,/^127\.0\.0\.1:\d+$/);endpoint='http://'+publishedAgain;apiBase=endpoint+'/api/local';await until(()=>api('/v1/agents'));assert.deepEqual(await snapshot(),preRestart);assert.equal((await api('/v1/credentials/'+CREDENTIAL)).fingerprint,rotated.fingerprint);
    const upgradedRecords=await providerRecords();check('restored original credential used after upgrade and rotated credential after rotation',upgradedRecords.some(r=>r.stage==='UPGRADED'&&r.credential==='original')&&upgradedRecords.some(r=>r.stage==='UPGRADED'&&r.credential==='rotated'));
    await api('/v1/runs/stop-all','POST',{});await dc('stop','open-harness');assert.equal(await inner('ps','-q'),'');
    // Quiescent read: original revisions stay byte-identical and only the reviewed edits were added.
    assertRevisionsAfterUpgrade(await nodeState(revisionsScript),oldRevisions,saved);check('original profile revisions retained byte-identical; only reviewed edits added',true);
    await dc('stop','docker');await dc('rm','-f','docker','open-harness');engine=undefined;await remove('volume',cache);await remove('volume',control);
    current=false;state=join(root,'rollback-state');fs.mkdirSync(state,{mode:0o700});await restoreState();assert.deepEqual(await nodeState(revisionsScript),oldRevisions);stop=await native('rollback');save('rollback-restored-state.json',await preserve('exact'));
    const upgradedWork=await request('/v1/files?scope=shared&name=upgrade-upgraded.txt');await upgradedWork.text();assert.equal(upgradedWork.status,404,'Rollback must restore the pre-upgrade original, not upgraded work');
    evidence.phases.push('original-backup-rollback-ui-and-hermes');save('progress.json',evidence);await browserPhase('ROLLBACK');await stop();
    const records=await providerRecords();save('provider-summary.json',records);
    check('no scripted-provider contract failure or rejected credential',records.every(r=>!r.failure&&!r.rejected));
    check('original credential used before upgrade and after rollback',records.filter(r=>['BASELINE','ROLLBACK'].includes(r.stage)).every(r=>r.credential==='original'));
    for(const[name,src]of Object.entries(sources))for(const f of src.files)assert.equal(hash(fs.readFileSync(join(root,name,f.path))),f.sha256,'Original source changed: '+f.path);
    if(snapshotSource){assert.deepEqual(preflightSnapshot(c.currentSnapshot,c.images),snapshotSource);verifySnapshotTree(join(root,'current'),snapshotSource.files);}
    for(const[n,v]of Object.entries(fixtureSources)){assert.equal(hash(fs.readFileSync(join(HERE,n))),v.sha256,'Fixture changed: '+n);assert.equal(fs.statSync(join(HERE,n)).mode&0o777,v.mode,'Fixture mode changed: '+n);}
    check('all original source files preserved',true);check('historical and current UI work plus original-backup rollback usable',true);
    evidence.oldCapabilityLimits={clarificationResponse:'Not implemented in original0.3 source and not granted to its profiles; required and exercised in current Compose',approvals:'Actual603 original UI offers approvals, but sends decision while pinned Hermes reads choice with default deny. Both original choices must leave proof mode0600; rollback must match. Current UI denial leaves0600 and approval must change0666.',taskTool:'Original0.3 grants mcp_open_harness_task, which pinned Hermes never registers: asserted never model-visible in original stages; the renamed grant is exercised in current',agentContainerAfterRun:'Original0.3 keeps the agent container after a run; recorded, and required stopped only in current',browserHistory:'Original0.3 keeps conversations in browser storage, so a new browser shows none; rollback history is asserted through the API',credentialStore:'Original write-only secret adopted and used; current metadata/rotation exercised',desktop:'Original0.3 init lacks current DBus/accessibility contract; no old desktop pass claimed. Actual current desktop required.'};
    controller.signal.throwIfAborted();
  } catch(e) {failure=e;evidence.failure={name:e?.name,message:String(e?.message??e).slice(0,400)};try{privateSave('fixture-failure.json',{name:e?.name,stack:String(e?.stack??e)});}catch{}}
  finally {
    clearInterval(monitor);clearTimeout(deadline);for(const[n,fn]of signals)process.off(n,fn);
    if(controller.signal.aborted)failure ||= controller.signal.reason;
    const cleanup={complete:false,errors:[],remaining:{},childProcessesClosed:false};
    try{await stopApps();}catch(e){cleanup.errors.push(`original app shutdown: ${e.message}`);}
    for(const child of children){try{process.kill(-child.pid,'SIGTERM');}catch{}}
    let untilClosed=Date.now()+5000;while(children.size&&Date.now()<untilClosed)await pause(100);
    for(const child of children){try{process.kill(-child.pid,'SIGKILL');}catch{}}
    untilClosed=Date.now()+10000;while(children.size&&Date.now()<untilClosed)await pause(100);cleanup.childProcessesClosed=children.size===0;
    const clean=args=>command('docker',args,{env:envs.docker,timeout:45000});
    const gone=async(kind,id)=>{try{await clean([kind,'inspect',id]);return false;}catch(e){if(missingObject(e,id))return true;throw e;}};
    // Listing uses exact ownership; inspect then remove exact ID, never a mutable name. An --rm helper or
    // concurrent removal can briefly refuse removal, so absence is polled before anything is reported.
    for(const [kind,list]of [['container',['ps','-aq','--no-trunc']],['volume',['volume','ls','-q']],['network',['network','ls','-q','--no-trunc']]]){
      try{
        for(const id of (await clean([...list,'--filter',`label=${LABEL}=${owner}`])).split('\n').filter(Boolean)){
          try{
            const row=JSON.parse(await clean([kind,'inspect',id]))[0];owned(row,kind);const target=kind==='volume'?row.Name:row.Id,end=Date.now()+15000;
            for(;;){try{await clean([kind,'rm',...(kind==='container'?['-f']:[]),target]);break;}catch(e){if(missingObject(e,target)||await gone(kind,target))break;if(Date.now()>end)throw e;await pause(500);}}
          }catch(e){if(!missingObject(e,id))cleanup.errors.push(`${kind} ${id}: ${e.name}: ${String(e.stderr||e.message).trim().slice(0,200)}`);}
        }
        cleanup.remaining[kind]=(await clean([...list,'--filter',`label=${LABEL}=${owner}`])).split('\n').filter(Boolean);
      }catch(e){cleanup.errors.push(`${kind} discovery: ${e.name}`);}
    }
    // A closed Docker client plus bounded discovery cannot guarantee arbitrary future server-side creation.
    cleanup.complete=cleanup.childProcessesClosed&&!cleanup.errors.length&&Object.values(cleanup.remaining).every(a=>a.length===0);
    evidence.cleanup=cleanup;evidence.ok=!failure&&cleanup.complete;
    try{save('cleanup.json',cleanup);save('evidence.json',evidence);}catch(e){evidence.ok=false;failure ||= e;}
    console.log(JSON.stringify({ok:evidence.ok,root,owner,phases:evidence.phases,cleanupComplete:cleanup.complete}));
  }
  if(!evidence.ok)throw failure||new Error('Scoped cleanup incomplete');return evidence;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const at=process.argv.indexOf('--config');assert.ok(at>=0&&process.argv[at+1]&&process.argv.includes('--execute-reviewed'),'Use an explicit reviewed config and --execute-reviewed');
  const config=JSON.parse(fs.readFileSync(process.argv[at+1]));try{await runFixture(config);}catch(e){console.error(`${e.name}: upgrade fixture failed; inspect its private durable evidence`);process.exitCode=1;}
}
