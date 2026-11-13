// Offline checks for the historical upgrade fixture: fake child processes, the scripted provider, the parent
// handshake, and the browser helper driven through a fake @playwright/test against a fake coordinator.
// node --test tests/real-upgrade-fixture.test.mjs  (no Docker, network, build or real browser)
import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import fs from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {Readable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {HISTORICAL,REPAIRED_HISTORICAL,CURRENT,HERMES,NATIVE_DOCKER_HOST,GRANTED,validateConfig,assertHistoricalBuildReceipt,assertHistoricalQuiescent,assertImageDefaults,sourcePaths,compareManifests,missingObject,command,operatorDocker,fixtureEnvironments,environmentFor,upgradedToolIds,assertRetained,assertUpgradedProfile,assertUpgradedHistory,assertRevisionsAfterUpgrade,assertAdvertised,browserHandshake} from './real-upgrade-smoke.mjs';
import {TASK_TOOL,completion,serve} from './helpers/upgrade-provider.mjs';
import {KINDS,awaitParent,redact} from './helpers/upgrade-browser.mjs';

const HERE=dirname(fileURLToPath(import.meta.url)),HELPER=join(HERE,'helpers/upgrade-browser.mjs');
const temp=prefix=>fs.mkdtempSync(join(tmpdir(),prefix));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const alive=pid=>{try{if(process.platform==='linux')return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`,'utf8'));process.kill(pid,0);return true;}catch(e){if(process.platform==='linux'||e.code==='ESRCH')return false;throw e;}};
const node=(script,opts={})=>command(process.execPath,['-e',script],{env:{PATH:process.env.PATH},...opts});
const config=()=>({rootReviewed:true,acknowledgeMissingHistoricalBuildAttestation:true,historicalCommit:HISTORICAL,currentCommit:CURRENT,repository:'/srv/open-harness',workParent:'/srv/evidence',chromiumExecutable:'/opt/chrome/chrome',floors:{initial:15,build:12,engine:12,stop:4},deadlines:{build:1200,engine:180,transfer:600,browser:660,total:3600},images:Object.fromEntries(['coordinator','engine','historical','oldEngine','runtime'].map((k,i)=>[k,{id:'sha256:'+String(i).repeat(64),...(['historical','runtime'].includes(k)?{tag:`fixture/${k}:1`}:{})}]))});

test('reviewed configuration: pinned commits, durable evidence and explicit cached images', () => {
  assert.equal(validateConfig(config()).currentCommit,CURRENT);
  assert.equal(HERMES,'939e45c91d751fadd94dcd1b873ac3cb44846213');
  const refuse=(change,pattern)=>{const c=config();change(c);assert.throws(()=>validateConfig(c),pattern);};
  refuse(c=>{c.rootReviewed=false;},/separately reviewed/);
  refuse(c=>{delete c.acknowledgeMissingHistoricalBuildAttestation;},/not recovered build attestation/);
  refuse(c=>{c.currentCommit='0'.repeat(40);},/reviewed current commit/);
  refuse(c=>{c.historicalCommit=CURRENT;},/reviewed historical checkpoints/);
  for(const parent of ['/tmp/evidence','/private/tmp/x','/tmp'])refuse(c=>{c.workParent=parent;},/durable/);
  refuse(c=>{c.workParent='/';},/Expected "actual" to be strictly unequal/);
  refuse(c=>{c.workParent='/srv/'+ 'x'.repeat(100);},/too long for the historical Docker Unix socket/);
  refuse(c=>{c.workParent='/srv/'+ 'é'.repeat(40);},/too long for the historical Docker Unix socket/);
  refuse(c=>{c.repository='relative/repo';},/repository/);
  refuse(c=>{c.chromiumExecutable='/opt/../chrome';},/chromiumExecutable/);
  refuse(c=>{c.floors.stop=1;},/deep-equal/);
  refuse(c=>{c.deadlines.total=7200;},/deep-equal/);
  refuse(c=>{delete c.images.oldEngine;},/deep-equal/);
  refuse(c=>{c.images.engine.id='engine:latest';},/match the regular expression/);
  refuse(c=>{delete c.images.runtime.tag;},/match the regular expression/);
  refuse(c=>{delete c.images;},/deep-equal/);
});

test('separate repaired historical checkpoint requires a successful build bound to its exact source and image',()=>{
  const c={...config(),historicalCommit:REPAIRED_HISTORICAL};delete c.acknowledgeMissingHistoricalBuildAttestation;
  assert.throws(()=>validateConfig(c),/fresh build receipt/);
  c.historicalBuildReceipt={path:'/srv/evidence/build.json',sha256:'a'.repeat(64)};validateConfig(c);
  const receipt={sourceCommit:REPAIRED_HISTORICAL,ok:true,returncode:0,abort:null,imageId:c.images.historical.id,iidFile:c.images.historical.id,tag:c.images.historical.tag,sourceFilesUnchanged:130,sourceManifestSha256:'b'.repeat(64),controllerSha256:'c'.repeat(64),sourceArchiveSha256:'d'.repeat(64),imageInspectSha256:'e'.repeat(64)};
  assertHistoricalBuildReceipt(receipt,c);
  for(const patch of [{sourceCommit:HISTORICAL},{imageId:c.images.runtime.id},{iidFile:c.images.runtime.id},{tag:'other:tag'},{ok:false},{returncode:1},{abort:'deadline'},{sourceFilesUnchanged:0},{sourceManifestSha256:''}])assert.throws(()=>assertHistoricalBuildReceipt({...receipt,...patch},c));
  assert.throws(()=>assertHistoricalBuildReceipt(receipt,config()),'A receipt for another checkpoint must not legitimize the failed baseline');
});

test('original backup requires terminal work before graceful shutdown',()=>{
  assertHistoricalQuiescent(['completed','failed','cancelled','interrupted'].map(state=>({state})));
  for(const state of ['queued','running','waiting_approval','waiting_input','unknown',undefined])assert.throws(()=>assertHistoricalQuiescent([{state:'completed'},{state}]),/terminal before graceful shutdown/);
});

test('Compose null defaults preserve the image command; empty and explicit overrides are refused',()=>{
  for(const service of [{},{command:null,entrypoint:null},{command:undefined,entrypoint:null}])assertImageDefaults(service);
  for(const key of ['command','entrypoint'])for(const value of ['',[],['sh'],'sleep infinity',false,0])assert.throws(()=>assertImageDefaults({[key]:value}),/image default/);
});

test('source export accepts only regular committed blobs and keeps their identity', () => {
  const blob='a'.repeat(40),row=(mode,path,type='blob')=>`${mode} ${type} ${blob}\t${path}`;
  assert.deepEqual(sourcePaths([row('100644','package.json'),row('100755','Start Open Harness.command'),''].join('\0')),[{path:'package.json',mode:0o644,blob},{path:'Start Open Harness.command',mode:0o755,blob}]);
  for(const bad of [row('120000','link'),row('160000','module','commit'),row('100644','/abs'),row('100644','a/../b'),row('100644','a//b')])assert.throws(()=>sourcePaths(bad));
  assert.throws(()=>sourcePaths(''));
});

test('state manifests compare exactly, and migration changes only ownership', () => {
  const rows=[{path:'',mode:0o40700,uid:1000,gid:1000,kind:'directory'},{path:'/state.db',mode:0o100600,uid:0,gid:0,kind:'file',sha256:'x'}];
  compareManifests(structuredClone(rows),rows);
  compareManifests(rows.map(r=>({...r,uid:1000,gid:1000})),rows,{migrated:true});
  assert.throws(()=>compareManifests([rows[0],{...rows[1],sha256:'y'}],rows));
  assert.throws(()=>compareManifests([rows[0],{...rows[1],mode:0o100644,uid:1000,gid:1000}],rows,{migrated:true}));
});

test('cleanup absence classifier: whole message, exact target, exit status 1', () => {
  const id='oh-upgrade-1234.runtime',e=(stderr,code=1)=>({code,stderr});
  for(const message of [`Error: No such object: ${id}`,`Error: No such container: ${id}`,`Error response from daemon: No such container: ${id}`,`Error: No such volume: ${id}`,`Error response from daemon: get ${id}: no such volume`,`Error: No such network: ${id}`,`Error response from daemon: network ${id} not found`,`error response from daemon: NO SUCH CONTAINER: ${id}\n`])assert.equal(missingObject(e(message),id),true,message);
  assert.equal(missingObject(e(`Error: No such container: oh-upgrade-1234xruntime`),id),false,'dots are literal');
  assert.equal(missingObject(e(`Error: No such container: ${id}-other`),id),false);
  assert.equal(missingObject(e(`Error: No such container: ${id}`,125),id),false);
  assert.equal(missingObject(e(`Error: No such container: ${id}\nError response from daemon: removal of container ${id} is already in progress`),id),false,'mixed errors are real failures');
  assert.equal(missingObject(e(`Error response from daemon: remove ${id}: volume is in use`),id),false);
  assert.equal(missingObject(undefined,id),false);
});

test('command returns trimmed output and reports exit status with bounded stderr', async () => {
  assert.equal(await node(`process.stdout.write('  ready\\n')`),'ready');
  await assert.rejects(node(`process.stderr.write('x'.repeat(70000)+'TAIL',()=>process.exit(3))`),e=>e.code===3&&e.stderr.length===64000&&e.stderr.endsWith('TAIL')&&/Command exited 3/.test(e.message));
  await assert.rejects(command('/nonexistent/upgrade-fixture-binary',[],{env:{}}),e=>e.cause?.code==='ENOENT');
  assert.equal(await node(`let s='';process.stdin.on('data',b=>s+=b).on('end',()=>console.log(s.toUpperCase()))`,{input:'from parent'}),'FROM PARENT');
  assert.equal(await node(`let s='';process.stdin.on('data',b=>s+=b).on('end',()=>console.log(s.length))`,{input:Readable.from(['a'.repeat(100000),'b'])}),'100001');
  await assert.rejects(node(`process.stdout.write('x'.repeat(5000));setInterval(()=>{},1000)`,{maxBytes:1000}),/Output bound exceeded/);
});

test('command passes only the explicit environment', async () => {
  const seen=JSON.parse(await command(process.execPath,['-e','console.log(JSON.stringify(process.env))'],{env:{PATH:'/usr/bin:/bin',ONLY:'1'}}));
  // macOS adds this CoreFoundation variable during child startup; inherited application values stay absent.
  if(process.platform==='darwin')delete seen.__CF_USER_TEXT_ENCODING;
  assert.deepEqual(seen,{PATH:'/usr/bin:/bin',ONLY:'1'});
});

test('deadline kills the whole process group, including a grandchild', async () => {
  let grandchild;const started=Date.now();
  await assert.rejects(node(`const {spawn}=require('child_process');const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(g.pid);setInterval(()=>{},1000)`,{timeout:700,onLine:line=>{grandchild=Number(line);}}),/Command deadline exceeded/);
  assert.ok(Date.now()-started<5000);assert.ok(grandchild>0);
  for(let i=0;i<40&&alive(grandchild);i++)await sleep(50);
  assert.equal(alive(grandchild),false,'The grandchild must not outlive the deadline');
});

test('a deadline or abort can never pass as success, even when the child exits 0', async () => {
  await assert.rejects(node(`process.on('SIGTERM',()=>process.exit(0));console.log('armed');setInterval(()=>{},1000)`,{timeout:500,grace:2000}),e=>/Command deadline exceeded/.test(e.message)&&e.code===0);
  const started=Date.now();
  await assert.rejects(node(`process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`,{timeout:300,grace:600}),/Command deadline exceeded/);
  assert.ok(Date.now()-started>=850,'SIGKILL follows only after the grace period');
  const controller=new AbortController();setTimeout(()=>controller.abort(new Error('fixture aborted')),200);
  await assert.rejects(node(`setInterval(()=>{},1000)`,{signal:controller.signal}),e=>e.message==='fixture aborted'&&e.cause?.message==='fixture aborted');
});

test('an already aborted signal rejects without spawning or throwing synchronously', async () => {
  const controller=new AbortController(),children=new Set();controller.abort(new Error('stopped before start'));
  let promise;assert.doesNotThrow(()=>{promise=command(process.execPath,['-e','0'],{signal:controller.signal,children});});
  await assert.rejects(promise,/stopped before start/);assert.equal(children.size,0);
  // A rejected promise is subscribed by Promise.all: a sibling rejecting later is not an unhandled rejection.
  const sibling=new Promise((_,reject)=>setTimeout(()=>reject(new Error('late sibling')),50));
  await assert.rejects(Promise.all([sibling,command(process.execPath,['-e','0'],{signal:controller.signal})]),/stopped before start/);
  await sleep(100);
});

test('line handlers run in order, include a trailing partial line, and are awaited', async () => {
  const lines=[];
  await node(`process.stdout.write('one\\ntwo\\n');setTimeout(()=>process.stdout.write('thr'),50);setTimeout(()=>process.stdout.write('ee'),100)`,{onLine:async line=>{await sleep(line==='one'?80:0);lines.push(line);}});
  assert.deepEqual(lines,['one','two','three']);
});

test('a failing line handler stops the child and skips later lines', async () => {
  const lines=[];const started=Date.now();
  await assert.rejects(node(`console.log('first');console.log('second');setInterval(()=>console.log('later'),20)`,{timeout:10000,onLine:line=>{lines.push(line);if(line==='first')throw new Error('parent check failed');}}),/parent check failed/);
  assert.deepEqual(lines,['first']);assert.ok(Date.now()-started<5000);
});

test('a pending line handler cannot hang past the deadline after the child exits', async () => {
  const started=Date.now();
  await assert.rejects(node(`console.log('hang')`,{timeout:500,onLine:()=>new Promise(()=>{})}),/Command deadline exceeded/);
  assert.ok(Date.now()-started<5000);
});

test('Docker keeps the operator client configuration against the explicit native daemon; tools get a private HOME', () => {
  const inherited={HOME:'/home/operator',PATH:'/usr/bin',HTTP_PROXY:'http://proxy.invalid:3128',HTTPS_PROXY:'http://proxy.invalid:3128',NO_PROXY:'*',GITHUB_TOKEN:'secret',npm_config_registry:'http://registry.invalid'};
  const operator=operatorDocker(inherited);assert.deepEqual(operator,{home:'/home/operator',config:'/home/operator/.docker'});
  assert.deepEqual(operatorDocker({...inherited,DOCKER_CONFIG:'/etc/operator-docker',DOCKER_HOST:NATIVE_DOCKER_HOST,DOCKER_CONTEXT:'default'}).config,'/etc/operator-docker');
  assert.throws(()=>operatorDocker({...inherited,DOCKER_HOST:'tcp://10.0.0.1:2376'}),/Refusing inherited DOCKER_HOST/);
  assert.throws(()=>operatorDocker({...inherited,DOCKER_CONTEXT:'rootless'}),/DOCKER_CONTEXT/);
  assert.throws(()=>operatorDocker({...inherited,DOCKER_CONFIG:'relative/.docker'}),/DOCKER_CONFIG must be absolute/);
  for(const HOME of [undefined,'','home/operator'])assert.throws(()=>operatorDocker({...inherited,HOME}),/operator HOME/);
  const envs=fixtureEnvironments({operator,privateHome:'/srv/run/private/home',privateTmp:'/srv/run/private/tmp',execPath:'/opt/node/bin/node'});
  assert.deepEqual(envs.docker,{PATH:'/opt/node/bin:/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',TMPDIR:'/srv/run/private/tmp',HOME:'/home/operator',DOCKER_CONFIG:'/home/operator/.docker',DOCKER_HOST:NATIVE_DOCKER_HOST});
  assert.deepEqual(envs.tool,{PATH:'/opt/node/bin:/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',TMPDIR:'/srv/run/private/tmp',HOME:'/srv/run/private/home'});
  assert.equal(environmentFor('docker',envs),envs.docker);for(const binary of ['git','tar','npm','/opt/node/bin/node'])assert.equal(environmentFor(binary,envs),envs.tool);
  assert.doesNotMatch(JSON.stringify(envs),/proxy\.invalid|secret|registry\.invalid/);
});

const oldProfile={id:'upgrade-alpha',revision:3,name:'Upgrade Alpha',role:'Writer',description:'Historical revision three',tone:0,prompt:{enabled:true,text:'Work only on the synthetic upgrade fixture.'},model:{provider:'local',model:'upgrade-fixture',credentialRef:'UPGRADE_FIXTURE_KEY',baseUrl:'http://172.18.0.2:3131/v1',inherit:false},allowedTools:['write_file','terminal','mcp_open_harness_task'],board:{assignOthers:false,dispatch:false},connectors:[],computer:{machineId:'local',access:'private',desktop:'none',reserveMachine:false,folders:[],resources:{cpu:2,memoryMb:4096,concurrency:4}}};
const upgradedProfile=()=>({...structuredClone(oldProfile),allowedTools:['write_file','terminal',TASK_TOOL],board:{assignOthers:false,dispatch:false,manageProjects:false}});

test('upgraded profiles keep every original field and only rename documented legacy grants', () => {
  assert.deepEqual(upgradedToolIds(oldProfile.allowedTools),['write_file','terminal',TASK_TOOL]);
  assert.deepEqual(upgradedToolIds(['mcp_open_harness_delegate_named_agent','mcp_open_harness_create_open_harness_routine']),['mcp__open_harness__delegate_named_agent','mcp__open_harness__create_open_harness_routine',TASK_TOOL]);
  assert.deepEqual([...GRANTED.historical].sort(),GRANTED.historical);assert.deepEqual([...GRANTED.upgraded].sort(),GRANTED.upgraded);
  assert.ok(!GRANTED.historical.includes(TASK_TOOL),'Pinned Hermes never registers the original grant name');
  assertUpgradedProfile(upgradedProfile(),oldProfile);
  const refuse=(change,pattern)=>{const p=upgradedProfile();change(p);assert.throws(()=>assertUpgradedProfile(p,oldProfile),pattern);};
  refuse(p=>{p.board.manageProjects=true;},/must not widen board access/);
  refuse(p=>{p.allowedTools.push('computer_use');},/length changed/);
  refuse(p=>{p.allowedTools=['write_file','terminal','mcp_open_harness_task'];},/allowedTools\[2\] changed/);
  refuse(p=>{delete p.description;},/description was dropped/);
  refuse(p=>{p.model.baseUrl='http://127.0.0.1:3131/v1';},/model\.baseUrl changed/);
  refuse(p=>{p.computer.resources.cpu=4;},/computer\.resources\.cpu changed/);
  assertRetained({a:[{b:1,c:2}],d:3},{a:[{b:1}]});assert.throws(()=>assertRetained({a:{}},{a:[]}),/must remain a list/);assert.throws(()=>assertRetained({a:[]},{a:{}}),/must remain an object/);
});

test('upgraded run history keeps exact events, retained run fields and nothing pending', () => {
  const old={run:{id:'r1',agent_id:'upgrade-alpha',state:'completed',result:'REAL_UPGRADE_MAIN_BASELINE_COMPLETE',machine_id:'local',machine_connection:'online'},events:[{seq:1,id:'e1',runId:'r1',type:'run.completed',payload:{result:'x'},createdAt:'2026-09-28T00:00:00.000Z'}]};
  const found=()=>({run:{...old.run,pendingApprovals:[],pendingInputs:[]},events:structuredClone(old.events)});
  assertUpgradedHistory(found(),old);
  const refuse=(change,pattern)=>{const f=found();change(f);assert.throws(()=>assertUpgradedHistory(f,old),pattern);};
  refuse(f=>{f.events[0].payload.result='y';},/events must survive unchanged/);
  refuse(f=>{f.events.push({...f.events[0],seq:2});},/events must survive unchanged/);
  refuse(f=>{f.run.state='interrupted';},/run r1\.state changed/);
  refuse(f=>{f.run.pendingInputs=[{inputId:'i'}];},/nothing pending/);
  refuse(f=>{delete f.run.pendingApprovals;},/nothing pending/);
});

test('original revisions stay byte-identical and only the reviewed edits are added', () => {
  const row=(agent_id,revision,json)=>({agent_id,revision,json});
  const old=[row('atlas',1,'{"id":"atlas"}'),row('upgrade-alpha',1,'{"r":1}'),row('upgrade-alpha',2,'{"r":2}'),row('upgrade-alpha',3,'{"r":3}'),row('upgrade-beta',3,'{"b":3}')];
  const saved={'upgrade-alpha':{id:'upgrade-alpha',revision:4},'upgrade-beta':{id:'upgrade-beta',revision:4}};
  const rows=()=>[...old.map(r=>({...r})),row('upgrade-alpha',4,JSON.stringify(saved['upgrade-alpha'])),row('upgrade-beta',4,JSON.stringify(saved['upgrade-beta']))];
  assertRevisionsAfterUpgrade(rows(),old,saved);
  const refuse=(change,pattern)=>{const r=rows();change(r);assert.throws(()=>assertRevisionsAfterUpgrade(r,old,saved),pattern);};
  refuse(r=>{r[1].json='{"r": 1}';},/must stay byte-identical/);
  refuse(r=>{r.splice(2,1);},/must stay byte-identical/);
  refuse(r=>{r.push(row('atlas',2,'{}'));},/Only the reviewed profile edits/);
  refuse(r=>{r.push(row('upgrade-alpha',5,'{}'));},/Only the reviewed profile edits/);
  refuse(r=>{r[5].revision=5;},/Expected values to be strictly equal/);
  refuse(r=>{r[6].json=JSON.stringify({id:'upgrade-beta',revision:4,extra:true});},/deep-equal/);
});

test('model-visible tools, required tools and the saved credential are checked per job', () => {
  const turn=(extra={})=>({auxiliary:false,kind:'MAIN',stage:'UPGRADED',credential:'original',advertised:['clarify',TASK_TOOL,'write_file'],tools:[],finished:false,...extra});
  const records=[{auxiliary:true,kind:null,stage:null,credential:'original',advertised:[],tools:[],finished:true},turn(),turn({finished:true})];
  const spec={kind:'MAIN',stage:'UPGRADED',granted:GRANTED.upgraded,required:['write_file','clarify',TASK_TOOL],credential:'original'};
  assert.equal(assertAdvertised(records,spec),2);
  assert.throws(()=>assertAdvertised([...records,{failure:'Unknown synthetic job'}],spec),/contract failure/);
  assert.throws(()=>assertAdvertised([...records,{rejected:'credential'}],spec),/rejected credential/);
  assert.throws(()=>assertAdvertised([turn({advertised:['write_file','clarify',TASK_TOOL,'patch']}),turn({finished:true})],spec),/Only granted tools may be model-visible: patch/);
  assert.throws(()=>assertAdvertised([turn({advertised:['write_file','clarify'],finished:true})],spec),/Required tool missing/);
  assert.throws(()=>assertAdvertised([turn({credential:'rotated',finished:true})],spec),/original saved credential/);
  assert.throws(()=>assertAdvertised([turn()],spec),/never finished/);
  assert.throws(()=>assertAdvertised(records,{...spec,kind:'DENY'}),/No agent requests/);
  assert.equal(assertAdvertised([turn({kind:'HOLD',advertised:['clarify'],credential:'rotated'})],{kind:'HOLD',stage:'UPGRADED',granted:GRANTED.upgraded,required:['clarify'],credential:'rotated',finished:false}),1);
  assert.throws(()=>assertAdvertised([turn({stage:'BASELINE',advertised:['write_file',TASK_TOOL],finished:true})],{kind:'MAIN',stage:'BASELINE',granted:GRANTED.historical,required:['write_file']}),/Only granted tools may be model-visible/);
});

const tools=names=>names.map(name=>({type:'function',function:{name,parameters:{type:'object'}}}));
const call=(name,id='x')=>({role:'assistant',content:null,tool_calls:[{id,type:'function',function:{name,arguments:'{}'}}]});
const step=(prompt,called,available)=>completion({messages:[{role:'system',content:'fixture'},{role:'user',content:prompt},...called.flatMap(name=>[call(name),{role:'tool',tool_call_id:'x',content:'ok'}])],tools:tools(available)});

test('scripted provider: original stages never ask for the renamed task tool or clarify', () => {
  const available=['terminal','write_file'];
  for(const stage of ['BASELINE','ROLLBACK']) {
    const first=step(`UPGRADE_MAIN_${stage}: Perform only this synthetic fixture job.`,[],available);
    assert.equal(first.auxiliary,false);assert.equal(first.finishReason,'tool_calls');
    const writeCall=first.message.tool_calls[0];assert.equal(writeCall.function.name,'write_file');
    assert.deepEqual(JSON.parse(writeCall.function.arguments),{path:`/workspace/shared/upgrade-${stage.toLowerCase()}.txt`,content:`UPGRADE_FILE_${stage}\n`});
    const done=step(`UPGRADE_MAIN_${stage}: go`,['write_file'],available);
    assert.deepEqual([done.finishReason,done.message.content],['stop',`REAL_UPGRADE_MAIN_${stage}_COMPLETE`]);
    for(const kind of ['DENY','APPROVE']) {
      const flagged=step(`UPGRADE_${kind}_${stage}: go`,[],available).message.tool_calls[0];
      assert.deepEqual([flagged.function.name,JSON.parse(flagged.function.arguments).command],['terminal','chmod 666 /workspace/private/approval-proof.txt']);
      assert.equal(step(`UPGRADE_${kind}_${stage}: go`,['terminal'],available).message.content,`REAL_UPGRADE_${kind}_${stage}_COMPLETE`);
    }
  }
});

test('scripted provider: current main job writes, clarifies, lists tasks, then finishes', () => {
  const available=['clarify','computer_use',TASK_TOOL,'terminal','write_file'],prompt='UPGRADE_MAIN_UPGRADED: go',sequence=[];
  for(const called of [[],['write_file'],['write_file','clarify'],['write_file','clarify',TASK_TOOL]]) {const r=step(prompt,called,available);sequence.push(r.message.tool_calls?.[0].function.name??r.message.content);}
  assert.deepEqual(sequence,['write_file','clarify',TASK_TOOL,'REAL_UPGRADE_MAIN_UPGRADED_COMPLETE']);
  assert.deepEqual(JSON.parse(step(prompt,['write_file','clarify'],available).message.tool_calls[0].function.arguments),{action:'list'});
  const ids=[[],['write_file']].map(called=>step(prompt,called,available).message.tool_calls[0].id);assert.notEqual(ids[0],ids[1]);
  assert.throws(()=>step(prompt,['write_file','clarify'],['clarify','write_file']),/Required tool missing: mcp__open_harness__task/);
  assert.equal(step('UPGRADE_HOLD_UPGRADED: keep',[],['clarify']).message.tool_calls[0].function.name,'clarify');
  assert.equal(step('UPGRADE_HOLD_UPGRADED: keep',['clarify'],['clarify']).message.tool_calls[0].function.name,'clarify','A held desktop keeps waiting for input');
});

test('scripted provider: auxiliary requests are inert, unknown work is a contract failure, latest job wins', () => {
  for(const body of [{messages:[{role:'user',content:'Generate a short title'}]},{messages:[],tools:[]},{messages:[{role:'user',content:'UPGRADE_MAIN_UPGRADED'}],tools:'not-a-list'}]) {
    const r=completion(body);assert.deepEqual([r.auxiliary,r.message.content,r.finishReason],[true,'UPGRADE_FIXTURE_AUXILIARY_RESPONSE','stop']);
  }
  assert.throws(()=>completion({messages:[{role:'user',content:'Do something else'}],tools:tools(['terminal'])}),/Unknown synthetic job/);
  assert.throws(()=>completion({messages:[{role:'user',content:'UPGRADE_MAIN_LATER: x'}],tools:tools(['write_file'])}),/Unknown synthetic job/);
  const r=completion({messages:[{role:'user',content:'UPGRADE_MAIN_BASELINE: old'},{role:'assistant',content:'REAL_UPGRADE_MAIN_BASELINE_COMPLETE'},{role:'user',content:'UPGRADE_DENY_UPGRADED: new'}],tools:tools(['terminal'])});
  assert.deepEqual([r.kind,r.stage,r.message.tool_calls[0].function.name],['DENY','UPGRADED','terminal']);
});

test('scripted provider server: credentials, JSON and streamed tool calls, label-only records', async () => {
  const {server,records}=serve({port:0,host:'127.0.0.1'});await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=(credential,body)=>fetch(base+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',...(credential?{Authorization:`Bearer ${credential}`}:{})},body:JSON.stringify(body)});
  try {
    assert.deepEqual((await (await fetch(base+'/v1/models')).json()).data.map(m=>m.id),['upgrade-fixture']);
    const body={model:'upgrade-fixture',messages:[{role:'user',content:'UPGRADE_MAIN_BASELINE: private prompt text'}],tools:tools(['terminal','write_file'])};
    for(const credential of [undefined,'wrong-key'])assert.equal((await post(credential,body)).status,401);
    const json=await (await post('upgrade-original-synthetic',body)).json();
    assert.equal(json.choices[0].finish_reason,'tool_calls');assert.equal(json.choices[0].message.tool_calls[0].function.name,'write_file');
    const streamed=await post('upgrade-rotated-synthetic',{...body,stream:true,messages:[{role:'user',content:'UPGRADE_HOLD_UPGRADED: x'}],tools:tools(['clarify'])});
    assert.match(streamed.headers.get('content-type'),/text\/event-stream/);
    const chunks=(await streamed.text()).split('\n\n').filter(Boolean);assert.equal(chunks.at(-1),'data: [DONE]');
    const first=JSON.parse(chunks[0].slice(6)),last=JSON.parse(chunks[1].slice(6));
    assert.equal(first.choices[0].delta.tool_calls[0].index,0);assert.equal(first.choices[0].delta.tool_calls[0].function.name,'clarify');assert.equal(last.choices[0].finish_reason,'tool_calls');
    assert.equal((await post('upgrade-original-synthetic',{messages:[{role:'user',content:'unscripted'}],tools:tools(['terminal'])})).status,500);
    await post('upgrade-original-synthetic',{messages:[{role:'user',content:'Name this chat'}]});
    const listed=await (await fetch(base+'/__fixture/requests')).json();
    assert.deepEqual(listed,records);
    assert.deepEqual(listed.map(r=>r.rejected??r.failure??`${r.kind}/${r.stage}/${r.credential}/${r.auxiliary}`),['credential','credential','MAIN/BASELINE/original/false','HOLD/UPGRADED/rotated/false','Unknown synthetic job','null/null/original/true']);
    assert.deepEqual(listed[2].advertised,['terminal','write_file']);assert.deepEqual(listed[2].tools,['write_file']);assert.equal(listed[2].finished,false);
    assert.doesNotMatch(JSON.stringify(listed),/upgrade-original-synthetic|upgrade-rotated-synthetic|wrong-key|private prompt text/);
  } finally {server.close();server.closeAllConnections();}
});

test('parent handshake enforces job order, pending approval acknowledgement and a single result', async () => {
  const handshake=temp('oh-upgrade-handshake-'),calls=[];
  const protocol=browserHandshake({stage:'UPGRADED',handshake,prepare:async kind=>{calls.push(`prepare:${kind}`);},confirmPending:async(kind,runId)=>{calls.push(`pending:${kind}:${runId}`);},verify:async(kind,runId,pending)=>{calls.push(`verify:${kind}:${runId}:${pending}`);}});
  const send=value=>protocol.onLine(JSON.stringify({stage:'UPGRADED',...value}));
  await protocol.onLine('');
  await send({event:'before-job',kind:'MAIN'});await send({event:'after-job',kind:'MAIN',runId:'m'});
  for(const kind of ['DENY','APPROVE']){await send({event:'before-job',kind});await send({event:'approval-pending',kind,runId:kind});await send({event:'after-job',kind,runId:kind});}
  await send({event:'result',result:{ok:true,stage:'UPGRADED'}});
  assert.deepEqual(calls,['verify:MAIN:m:false','prepare:DENY','pending:DENY:DENY','verify:DENY:DENY:true','prepare:APPROVE','pending:APPROVE:APPROVE','verify:APPROVE:APPROVE:true']);
  assert.deepEqual(protocol.result(),{ok:true,stage:'UPGRADED'});
  for(const name of ['DENY.ready','DENY.pending','DENY.checked','APPROVE.ready','APPROVE.pending','APPROVE.checked','MAIN.checked'])assert.equal(fs.statSync(join(handshake,name)).mode&0o777,0o600);
  assert.ok(!fs.existsSync(join(handshake,'MAIN.ready')),'MAIN needs no proof reset');
  await assert.rejects(send({event:'result',result:{ok:true,stage:'UPGRADED'}}),/Duplicate browser result/);
  const fresh=()=>browserHandshake({stage:'BASELINE',handshake:temp('oh-upgrade-handshake-'),prepare:async()=>{},confirmPending:async()=>{},verify:async()=>{}});
  const reject=async(lines,pattern)=>{const p=fresh();let error;try{for(const line of lines)await p.onLine(JSON.stringify({stage:'BASELINE',...line}));}catch(e){error=e;}assert.match(String(error?.message),pattern);};
  await reject([{event:'before-job',kind:'DENY'}],/Unexpected browser job order/);
  await reject([{event:'after-job',kind:'MAIN'}],/not active/);
  await reject([{event:'before-job',kind:'MAIN'},{event:'approval-pending',kind:'MAIN'}],/Unexpected approval handshake/);
  await reject([{event:'before-job',kind:'MAIN'},{event:'after-job',kind:'MAIN'},{event:'before-job',kind:'DENY'},{event:'approval-pending',kind:'DENY'},{event:'approval-pending',kind:'DENY'}],/Unexpected approval handshake/);
  await reject([{event:'result',result:{ok:true,stage:'BASELINE'}}],/before every job was checked/);
  await reject([{event:'before-job',kind:'MAIN'},{event:'screenshot',kind:'MAIN'}],/Unknown browser event/);
  await reject([{event:'before-job',kind:'MAIN',stage:'UPGRADED'}],/stage mismatch/);
  const failing=browserHandshake({stage:'BASELINE',handshake:temp('oh-upgrade-handshake-'),prepare:async()=>{throw new Error('proof reset failed');},confirmPending:async()=>{},verify:async()=>{}});
  await failing.onLine(JSON.stringify({stage:'BASELINE',event:'before-job',kind:'MAIN'}));await failing.onLine(JSON.stringify({stage:'BASELINE',event:'after-job',kind:'MAIN'}));
  await assert.rejects(failing.onLine(JSON.stringify({stage:'BASELINE',event:'before-job',kind:'DENY'})),/proof reset failed/);
});

test('browser helper waits are bounded and diagnostics are redacted', async () => {
  const handshake=temp('oh-upgrade-wait-');setTimeout(()=>fs.writeFileSync(join(handshake,'DENY.ready'),'ok'),100);
  await awaitParent(handshake,'DENY.ready',2000);
  await assert.rejects(awaitParent(handshake,'APPROVE.ready',200),/Parent did not acknowledge APPROVE.ready/);
  assert.equal(redact('open http://127.0.0.1:3000/#pair=abc123 then "#pair=x" done'),'open http://127.0.0.1:3000/#pair=[redacted] then "#pair=[redacted]" done');
  assert.equal(redact('x'.repeat(5000)).length,2000);
});

// A minimal @playwright/test stand-in: every page action goes to the fake coordinator the way the product UI would.
const FAKE_PLAYWRIGHT=String.raw`'use strict';
const fs=require('fs');const sleep=ms=>new Promise(r=>setTimeout(r,ms));const cap=t=>Math.min(t??5000,Number(process.env.FAKE_PW_CAP||3000));
const match=(e,q)=>{if(q.css){if(e.css!==q.css)return false;if(q.has&&e.heading!==q.has.name)return false;return !q.hasText||String(e.text||'').includes(q.hasText);}
  if(e.role!==q.role||(q.scope==='dialog'&&e.scope!=='dialog'))return false;return q.name instanceof RegExp?q.name.test(e.name):q.exact?e.name===q.name:String(e.name).includes(q.name);};
class Locator{constructor(page,q){this.page=page;this.q=q;}
  getByRole(role,o={}){return new Locator(this.page,{...o,role,scope:'dialog'});}
  filter(f){return new Locator(this.page,{...this.q,...(f.has?{has:f.has.q}:{}),...(f.hasText?{hasText:f.hasText}:{})});}
  first(){return this;}last(){return new Locator(this.page,{...this.q,last:true});}
  async all(){return (await this.page.elements()).filter(e=>e.visible!==false&&match(e,this.q));}
  async count(){return (await this.all()).length;}async isVisible(){return (await this.count())>0;}
  async one(timeout){const end=Date.now()+cap(timeout);for(;;){const list=await this.all();if(list.length)return this.q.last?list.at(-1):list[0];if(Date.now()>end)throw new Error('fake locator timeout '+JSON.stringify(this.q,(k,v)=>v instanceof RegExp?String(v):v));await sleep(20);}}
  async click(o={}){await (await this.one(o.timeout)).click();}async fill(v){(await this.one()).fill(v);}async press(k){await (await this.one()).press(k);}
  async ariaSnapshot(){return '- document "'+this.page.url()+'#pair=SECRET-FROM-SNAPSHOT"';}}
class Page{constructor(context){this.context=context;this.s={url:'about:blank',closed:false,dialog:null,tab:'profile',view:'home',conversation:null,draft:'',answer:''};}
  async api(path,o={}){const r=await fetch(this.context.origin+path,{...o,headers:{'Content-Type':'application/json',Authorization:'Bearer '+this.context.token}});if(!r.ok)throw new Error('fake UI '+path+' '+r.status);return r.json();}
  async goto(url){const u=new URL(url),ctx=this.context;ctx.origin=u.origin;this.s={...this.s,url,view:'home',conversation:null,dialog:null};
    const pair=/^#pair=([^&#]+)$/.exec(u.hash);if(pair){this.s.url=url.slice(0,url.indexOf('#'));const r=await fetch(u.origin+'/v1/browser/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:decodeURIComponent(pair[1])})});if(r.ok)ctx.token=(await r.json()).token;}
    if(!ctx.token){const r=await fetch(u.origin+'/v1/bootstrap');if(r.ok)ctx.token=(await r.json()).token;}
    ctx.version=(await (await fetch(u.origin+'/__ui/version')).json()).version;
    if(ctx.version==='current'&&ctx.token){for(const c of (await this.api('/v1/conversations')).conversations)if(!ctx.storage.some(x=>x.id===c.id))ctx.storage.push({id:c.id,agentId:c.agentId,title:c.title,runIds:c.runs.map(r=>r.id),updatedAt:c.updatedAt});ctx.storage.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));}}
  async elements(){const s=this.s,ctx=this.context,els=[];if(s.closed||!ctx.token)return els;const name='Upgrade Alpha',id='upgrade-alpha';
    els.push({role:'button',name:'Edit '+name+' profile',click:async()=>{s.dialog=(await this.api('/v1/agents/'+id+'/profile')).profile;s.tab='profile';}});
    els.push({css:'button.agent-card',heading:name,visible:s.view==='home',click:async()=>{s.view='chat';s.dialog=null;s.conversation=ctx.storage.find(c=>c.agentId===id)?.id||null;}});
    if(s.dialog){const p=s.dialog;els.push({role:'dialog',name:'Agent settings'},{scope:'dialog',role:'textbox',name:'Name',value:p.name,visible:s.tab==='profile'},{scope:'dialog',role:'textbox',name:'Short description',value:p.description,visible:s.tab==='profile'},{scope:'dialog',role:'tab',name:'System prompt',click:async()=>{s.tab='prompt';}},{scope:'dialog',role:'textbox',name:'System prompt / agent instructions',value:p.prompt.text,visible:s.tab==='prompt'},{scope:'dialog',role:'button',name:'Close agent settings',click:async()=>{s.dialog=null;}});}
    for(const c of ctx.storage.slice(0,12))els.push({role:'button',name:c.title,click:async()=>{s.view='chat';s.conversation=c.id;}});
    if(s.view!=='chat')return els;
    els.push({role:'button',name:'New conversation',click:async()=>{s.conversation=null;}});
    els.push({role:'textbox',name:'Message '+name,fill:v=>{s.draft=v;},press:async key=>{if(key!=='Enter')return;let c=ctx.storage.find(x=>x.id===s.conversation);if(!c){c={id:'conv-'+Math.random().toString(16).slice(2),agentId:id,title:s.draft.slice(0,52),runIds:[],updatedAt:new Date().toISOString()};ctx.storage.unshift(c);s.conversation=c.id;}const run=await this.api('/v1/runs',{method:'POST',body:JSON.stringify({agentId:id,conversationId:c.id,prompt:s.draft})});c.runIds.push(run.id);s.draft='';}});
    const c=ctx.storage.find(x=>x.id===s.conversation);
    for(const runId of c?.runIds||[]){const {run,events}=await this.api('/v1/runs/'+runId+'/events?after=0');els.push({css:'.message.assistant',text:run.result||run.error||''});
      const approval=run.pendingApprovals?.[0]||(run.state==='waiting_approval'?events.findLast(e=>e.type==='approval.request')?.payload:undefined),input=run.pendingInputs?.[0];
      if(approval)for(const [label,decision] of [['Deny','deny'],['Approve once','approve']])els.push({role:'button',name:label,click:()=>this.api('/v1/runs/'+runId+'/approval',{method:'POST',body:JSON.stringify({approvalId:approval.approvalId,decision})})});
      if(input)els.push({role:'textbox',name:'Your answer',fill:v=>{s.answer=v;}},{role:'button',name:'Send answer',click:()=>this.api('/v1/runs/'+runId+'/input',{method:'POST',body:JSON.stringify({inputId:input.inputId,value:s.answer})})});}
    return els;}
  getByRole(role,o={}){return new Locator(this,{...o,role});}locator(css){return new Locator(this,{css});}url(){return this.s.url;}
  isClosed(){return this.s.closed;}async close(){this.s.closed=true;}async reload(){await this.goto(this.s.url);}
  async screenshot({path}){fs.writeFileSync(path,Buffer.from('89504e470d0a1a0a','hex'));}}
class Context{constructor(){this.storage=[];this.token=null;}async addInitScript(fn){this.init=String(fn);}async newPage(){return new Page(this);}async close(){}}
const expect=target=>{const poll=async(test,timeout,message)=>{const end=Date.now()+cap(timeout);for(;;){if(await test())return;if(Date.now()>end)throw new Error(message);await sleep(20);}};
  return {toHaveValue:(v,o={})=>poll(async()=>(await target.all())[0]?.value===v,o.timeout,'fake expected value '+v),toBeVisible:(o={})=>poll(()=>target.isVisible(),o.timeout,'fake expected visible '+(target.q?.hasText||String(target.q?.name))),not:{toHaveURL:(re,o={})=>poll(async()=>!re.test(target.url()),o.timeout,'fake expected URL change')}};};
exports.chromium={launch:async o=>{if(o?.executablePath==='/opt/fake/launch-fails')throw new Error('Synthetic launch failed #pair=SECRET-LAUNCH');if(!o?.executablePath||o.headless!==true)throw new Error('fake launch contract');return {newContext:async o=>{if(!o?.viewport)throw new Error('fake viewport contract');return new Context();},version:()=>'fake-chromium',close:async()=>{}};}};
exports.expect=expect;`;

function fakePlaywright() {
  const dir=temp('oh-upgrade-deps-'),pkg=join(dir,'node_modules','@playwright','test');fs.mkdirSync(pkg,{recursive:true});
  fs.writeFileSync(join(dir,'package.json'),'{"private":true}');fs.writeFileSync(join(pkg,'package.json'),'{"name":"@playwright/test","main":"index.js"}');fs.writeFileSync(join(pkg,'index.js'),FAKE_PLAYWRIGHT);return dir;
}
// Fake coordinator: original0.3 has no pending lists or conversation route; current pairs, asks and waits.
async function fakeCoordinator({version,stage,handshake,failKind,approvalInOriginal=true,pairCode}) {
  const token='fixture-token',ui='ui-token',runs=[],events=new Map(),record={decisions:[],inputs:[],pairs:[]};let seq=0,paired=false,pairUsed=false;
  const add=(run,type,payload={})=>events.get(run.id).push({seq:++seq,id:'e'+seq,runId:run.id,type,payload,createdAt:new Date().toISOString()});
  const finish=run=>{run.state='completed';run.result=`REAL_UPGRADE_${run.kind}_${run.stage}_COMPLETE`;run.pendingApprovals=[];run.pendingInputs=[];add(run,'run.completed',{result:run.result});};
  const create=(input,at=new Date().toISOString())=>{const [,kind,jobStage]=/UPGRADE_(MAIN|DENY|APPROVE)_(BASELINE|UPGRADED|ROLLBACK)/.exec(input.prompt);const run={id:'run-'+(runs.length+1),agent_id:input.agentId,conversation_id:input.conversationId,prompt:input.prompt,state:'running',result:null,error:null,created_at:at,updated_at:at,kind,stage:jobStage,pendingApprovals:[],pendingInputs:[]};runs.push(run);events.set(run.id,[]);add(run,'run.started');return run;};
  if(version==='current')for(const [i,kind] of KINDS.entries()){const run=create({agentId:'upgrade-alpha',conversationId:'baseline-'+kind,prompt:`UPGRADE_${kind}_BASELINE: Perform only this synthetic fixture job.`},`2026-09-2${i+1}T00:00:00.000Z`);finish(run);}
  const view=run=>{const {kind,stage:_s,pendingApprovals,pendingInputs,...row}=run;return version==='current'?{...row,pendingApprovals,pendingInputs}:row;};
  const progress=run=>setTimeout(()=>{
    if(run.kind===failKind){run.state='failed';run.error='Model endpoint refused http://127.0.0.1:3000/#pair=SECRETPAIRCODE';add(run,'run.failed',{error:run.error});return;}
    if(version==='current'&&run.kind==='MAIN'){run.state='waiting_input';run.pendingInputs=[{inputId:'input-'+run.id,type:'clarify'}];add(run,'clarify.request',{inputId:'input-'+run.id});return;}
    if(run.kind!=='MAIN'&&(version==='current'||approvalInOriginal)){run.state='waiting_approval';run.pendingApprovals=[{approvalId:'approval-'+run.id}];add(run,'approval.request',{approvalId:'approval-'+run.id});return;}
    finish(run);},20);
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://fake'),send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{};
    if(url.pathname==='/__ui/version')return send(200,{version});
    if(url.pathname==='/v1/bootstrap')return version==='original'?send(200,{token:ui}):paired?send(200,{token:ui}):send(401,{pairingRequired:true});
    if(url.pathname==='/v1/browser/pair'){record.pairs.push(body.code);if(version==='current'&&body.code===pairCode&&!pairUsed){pairUsed=paired=true;return send(200,{token:ui});}return send(401,{error:'invalid'});}
    if(![`Bearer ${token}`,`Bearer ${ui}`].includes(req.headers.authorization)||(req.headers.authorization===`Bearer ${ui}`&&version==='current'&&!paired))return send(401,{error:'unauthorized'});
    if(url.pathname==='/v1/agents/upgrade-alpha/profile')return send(200,{profile:{id:'upgrade-alpha',name:'Upgrade Alpha',description:'Historical revision three',prompt:{enabled:true,text:'Work only on the synthetic upgrade fixture.'}}});
    if(url.pathname==='/v1/conversations'&&version==='current'){const map=new Map();for(const run of runs){const c=map.get(run.conversation_id)||{id:run.conversation_id,agentId:run.agent_id,title:run.prompt.slice(0,52),updatedAt:run.updated_at,runs:[]};c.runs.push(view(run));map.set(run.conversation_id,c);}return send(200,{conversations:[...map.values()].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))});}
    if(url.pathname==='/v1/runs'&&req.method==='GET')return send(200,{runs:runs.map(view)});
    if(url.pathname==='/v1/runs'&&req.method==='POST'){const run=create(body);progress(run);return send(202,view(run));}
    const m=url.pathname.match(/^\/v1\/runs\/([^/]+)\/(events|approval|input)$/),run=m&&runs.find(r=>r.id===m[1]);if(!run)return send(404,{error:'not found'});
    if(m[2]==='events')return send(200,{run:view(run),events:events.get(run.id)});
    if(m[2]==='approval'&&run.pendingApprovals[0]?.approvalId===body.approvalId){record.decisions.push({kind:run.kind,decision:body.decision,afterParentAck:fs.existsSync(join(handshake,`${run.kind}.pending`))});add(run,'approval.resolved',{approvalId:body.approvalId,decision:body.decision});finish(run);return send(200,{ok:true});}
    if(m[2]==='input'&&run.pendingInputs[0]?.inputId===body.inputId){record.inputs.push(body.value);add(run,'input.resolved',{inputId:body.inputId});finish(run);return send(200,{ok:true});}
    return send(409,{error:'nothing pending'});
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return {server,runs,record,token,url:`http://127.0.0.1:${server.address().port}`,close:()=>{server.close();server.closeAllConnections();}};
}
async function runBrowser({version,stage,failKind,approvalInOriginal,verify,launchFails=false}) {
  const handshake=temp('oh-upgrade-browser-'),pairCode=version==='current'?'pair-code-1':undefined,backend=await fakeCoordinator({version,stage,handshake,failKind,approvalInOriginal,pairCode}),calls=[];
  const protocol=browserHandshake({stage,handshake,
    prepare:async kind=>{calls.push(`prepare:${kind}`);},
    confirmPending:async(kind,runId)=>{const run=backend.runs.find(r=>r.id===runId);calls.push(`pending:${kind}`);assert.equal(run.state,'waiting_approval','The approval is still pending while the parent inspects it');assert.equal(backend.record.decisions.filter(d=>d.kind===kind).length,0,'No UI decision before the parent acknowledgement');},
    verify:async(kind,runId,pending)=>{calls.push(`verify:${kind}`);assert.equal(backend.runs.find(r=>r.id===runId).state,'completed');await verify?.(kind);}});
  const spec={dependencies:fakePlaywright(),chromiumExecutable:launchFails?'/opt/fake/launch-fails':'/opt/fake/chrome',url:backend.url,api:backend.url,token:backend.token,stage,pairCode,handshake};
  let error;try{await command(process.execPath,[HELPER],{env:{PATH:process.env.PATH,FAKE_PW_CAP:'3000'},input:JSON.stringify(spec),timeout:60000,onLine:protocol.onLine});}catch(e){error=e;}finally{backend.close();}
  return {error,calls,record:backend.record,result:protocol.result(),handshake,runs:backend.runs};
}

test('browser helper, original stages: real composer jobs and event-based approvals, persistence after close/reload', async () => {
  for(const stage of ['BASELINE','ROLLBACK']) {
    const {error,calls,record,result,handshake}=await runBrowser({version:'original',stage});
    assert.equal(error,undefined,String(error?.stderr||error));
    assert.deepEqual(calls,['verify:MAIN','prepare:DENY','pending:DENY','verify:DENY','prepare:APPROVE','pending:APPROVE','verify:APPROVE']);
    assert.deepEqual(record.decisions,[{kind:'DENY',decision:'deny',afterParentAck:true},{kind:'APPROVE',decision:'approve',afterParentAck:true}]);assert.deepEqual([record.inputs,record.pairs],[[],[]]);
    assert.equal(result.ok,true);assert.equal(result.pairing,false);assert.equal(result.browserCloseAndReloadPersistence,true);
    assert.deepEqual(result.results.map(r=>[r.kind,r.inputIds,r.approvalIds]),[['MAIN',0,0],['DENY',0,1],['APPROVE',0,1]]);
    assert.match(result.history,stage==='ROLLBACK'?/not asserted in the UI/:/first stage/);
    for(const name of ['DENY.ready','APPROVE.ready','MAIN.checked','DENY.checked','APPROVE.checked'])assert.equal(fs.statSync(join(handshake,name)).mode&0o777,0o600);
    assert.ok(!fs.readdirSync(handshake).some(n=>n.startsWith('failure-')));
  }
});

test('browser helper, current Compose: pairing link, baseline history, UI answer and approvals only after parent checks', async () => {
  const {error,calls,record,result}=await runBrowser({version:'current',stage:'UPGRADED'});
  assert.equal(error,undefined,String(error?.stderr||error));
  assert.deepEqual(calls,['verify:MAIN','prepare:DENY','pending:DENY','verify:DENY','prepare:APPROVE','pending:APPROVE','verify:APPROVE']);
  assert.deepEqual(record.pairs,['pair-code-1'],'The one-use code is exchanged once, from the first load');
  assert.deepEqual(record.inputs,['upgrade-answer']);
  assert.deepEqual(record.decisions,[{kind:'DENY',decision:'deny',afterParentAck:true},{kind:'APPROVE',decision:'approve',afterParentAck:true}]);
  assert.equal(result.pairing,true);assert.match(result.history,/every baseline conversation reopened/);
  assert.deepEqual(result.results.map(r=>[r.kind,r.inputIds,r.approvalIds]),[['MAIN',1,0],['DENY',0,1],['APPROVE',0,1]]);
});

test('browser helper failure: a failed job exits 1 with private, redacted diagnostics and no later protocol', async () => {
  const {error,calls,handshake}=await runBrowser({version:'original',stage:'BASELINE',failKind:'DENY'});
  assert.equal(error?.code,1);assert.match(error.stderr,/browser phase failed/);assert.doesNotMatch(error.stderr,/SECRET/);
  assert.deepEqual(calls,['verify:MAIN','prepare:DENY']);
  const failure=JSON.parse(fs.readFileSync(join(handshake,'failure-baseline.json'),'utf8'));
  assert.equal(failure.step,'job:DENY');assert.match(failure.message,/The DENY job ended failed: .*#pair=\[redacted\]/);assert.doesNotMatch(JSON.stringify(failure),/SECRETPAIRCODE/);
  assert.doesNotMatch(fs.readFileSync(join(handshake,'failure-baseline.aria.txt'),'utf8'),/SECRET-FROM-SNAPSHOT/);
  for(const name of ['failure-baseline.json','failure-baseline.aria.txt','failure-baseline.png'])assert.equal(fs.statSync(join(handshake,name)).mode&0o777,0o600);
});

test('browser helper failure: a missing original approval cannot silently pass', async () => {
  const {error,calls,record,handshake}=await runBrowser({version:'original',stage:'ROLLBACK',approvalInOriginal:false});
  assert.equal(error?.code,1);assert.deepEqual(record.decisions,[]);assert.deepEqual(calls,['verify:MAIN','prepare:DENY']);
  assert.match(JSON.parse(fs.readFileSync(join(handshake,'failure-rollback.json'),'utf8')).message,/must resolve exactly its own approval through the UI/);
});

test('browser helper failure: a parent verification failure stops the helper promptly', async () => {
  const started=Date.now();
  const {error,calls}=await runBrowser({version:'original',stage:'BASELINE',verify:async kind=>{if(kind==='MAIN')throw new Error('parent found the wrong file');}});
  assert.match(error?.message,/parent found the wrong file/);assert.deepEqual(calls,['verify:MAIN']);assert.ok(Date.now()-started<30000);
});

test('the command line refuses to run without an explicit reviewed configuration, before any side effect', async () => {
  const main=join(HERE,'real-upgrade-smoke.mjs'),dir=temp('oh-upgrade-cli-'),file=join(dir,'config.json');
  await assert.rejects(command(process.execPath,[main],{env:{PATH:process.env.PATH}}),e=>e.code===1&&/explicit reviewed config/.test(e.stderr));
  fs.writeFileSync(file,JSON.stringify({...config(),rootReviewed:false,workParent:dir}));
  await assert.rejects(command(process.execPath,[main,'--config',file],{env:{PATH:process.env.PATH}}),e=>e.code===1);
  await assert.rejects(command(process.execPath,[main,'--config',file,'--execute-reviewed'],{env:{PATH:process.env.PATH}}),e=>e.code===1&&/upgrade fixture failed/.test(e.stderr));
  assert.deepEqual(fs.readdirSync(dir),['config.json']);
});


test('browser launch failures retain private diagnostics before any page or job exists', async () => {
  const {error,calls,record,handshake}=await runBrowser({version:'original',stage:'BASELINE',launchFails:true});
  assert.equal(error?.code,1);assert.match(error.stderr,/browser phase failed/);assert.doesNotMatch(error.stderr,/SECRET-LAUNCH/);
  assert.deepEqual(calls,[]);assert.deepEqual(record.decisions,[]);
  assert.deepEqual(fs.readdirSync(handshake),['failure-baseline.json']);
  const file=join(handshake,'failure-baseline.json'),diagnostic=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(diagnostic.step,'launch');assert.match(diagnostic.message,/Synthetic launch failed #pair=\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(diagnostic),/SECRET-LAUNCH/);assert.equal(fs.statSync(file).mode&0o777,0o600);
});
