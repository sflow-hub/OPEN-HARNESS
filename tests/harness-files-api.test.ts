/* eslint-disable @typescript-eslint/no-explicit-any */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { AgentProfile } from '../lib/agent-profile';
import type { UploadRecord } from '../runtime/agent-files';

const live=process.env.OPEN_HARNESS_REAL_HARNESSES==='1',parent=process.env.OPEN_HARNESS_ACCEPTANCE_STATE||tmpdir();
const root=mkdtempSync(join(parent,'oh-files-api-')),remote=mkdtempSync(join(parent,'oh-files-runner-')),port=14581,base=`http://127.0.0.1:${port}`;
const provider=createServer(async(req,res)=>{for await(const _chunk of req)void _chunk;res.writeHead(200,{'Content-Type':'text/event-stream'});for(const delta of [{role:'assistant',content:'REAL_REMOTE_OPENCODE_OK'},{}])res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:0,model:'fixture',choices:[{index:0,delta,finish_reason:Object.keys(delta).length?null:'stop'}]})+'\n\n');res.end('data: [DONE]\n\n');});
let providerUrl='';
let service:ChildProcess,runner:ChildProcess,token='',machineId='',logs='';
const hash=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
async function request(path:string,method='GET',data?:unknown){const r=await fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(data!==undefined?{body:JSON.stringify(data)}:{})});const value=await r.json() as Record<string,any>;if(!r.ok)throw Object.assign(new Error(JSON.stringify(value)),{status:r.status});return value;}
async function until<T>(fn:()=>Promise<T>,done:(v:T)=>boolean){const deadline=Date.now()+30000;while(Date.now()<deadline){const value=await fn();if(done(value))return value;await new Promise(r=>setTimeout(r,50));}throw new Error(`Timed out. ${logs.slice(-3000)}`);}
async function profile(id='atlas'){return(await request(`/v1/agents/${id}/profile`)).profile as AgentProfile;}
async function stop(child:ChildProcess|undefined){if(!child||child.exitCode!==null)return;const exit=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await exit;}
async function upload(path:string,bytes:Buffer,destination='work'){const u=await request('/v1/agents/atlas/uploads','POST',{path,destination,size:bytes.length,checksum:hash(bytes)}) as UploadRecord;for(let i=0;i<Math.ceil(bytes.length/1048576);i++){const b=bytes.subarray(i*1048576,(i+1)*1048576);await request(`/v1/agents/atlas/uploads/${u.id}/chunks/${i}`,'PUT',{data:b.toString('base64'),checksum:hash(b)});}await request(`/v1/agents/atlas/uploads/${u.id}/finalize`,'POST',{});const state=await until(()=>request(`/v1/agents/atlas/uploads/${u.id}`),u=>['ready','failed'].includes(u.state));assert.equal(state.state,'ready',state.detail);return u;}
test.before(async()=>{
  if(live){await new Promise<void>(resolve=>provider.listen(0,'0.0.0.0',resolve));providerUrl=`http://host.docker.internal:${(provider.address() as {port:number}).port}/v1`;}

  service=spawn(process.execPath,['--import','tsx','runtime/service.ts'],{env:{...process.env,OPEN_HARNESS_MOCK:live?'0':'1',OPEN_HARNESS_STATE_DIR:root,OPEN_HARNESS_PORT:String(port)},stdio:'pipe'});service.stderr?.on('data',chunk=>logs+=chunk);
  await until(async()=>{try{const r=await fetch(base+'/v1/bootstrap');if(r.ok){token=((await r.json()) as {token:string}).token;return true;}}catch{}return false;},Boolean);
  await request('/v1/agents/sync','POST',{agents:['atlas','scout'].map(id=>({id,name:id,role:'Assistant',description:'',tone:0,instructions:'',memory:[]}))});
  const p=await profile();await request('/v1/agents/atlas/profile','PUT',{...p,allowedTools:[],model:{inherit:false,provider:live?'custom':'mock',model:'fixture',credentialRef:'',baseUrl:providerUrl}});
});
test.after(async()=>{await stop(runner);await stop(service);if(live)await new Promise<void>(resolve=>provider.close(()=>resolve()));rmSync(root,{recursive:true,force:true});rmSync(remote,{recursive:true,force:true});});
test('real coordinator persists harness selection and dispatches the selected adapter',async()=>{
  const initial=await request('/v1/harnesses?machineId=local');assert.equal(initial.harnesses.find((h:{kind:string})=>h.kind==='opencode').available,false);
  const job=await request('/v1/machines/local/harnesses/install','POST',{agentId:'atlas',kind:'opencode'});const installed=await until(()=>request(`/v1/harness-jobs/${job.id}`),j=>['completed','failed'].includes(j.state));assert.equal(installed.state,'completed',installed.detail);
  const p=await profile();const saved=await request('/v1/agents/atlas/profile','PUT',{...p,harness:{kind:'opencode'}});assert.equal(saved.profile.harness.kind,'opencode');assert.ok(saved.profile.harness.version);
  const run=await request('/v1/runs','POST',{agentId:'atlas',prompt:'Hello from OpenCode'});const done=await until(()=>request(`/v1/runs/${run.id}`),r=>['completed','failed'].includes(r.state));assert.equal(done.state,'completed',done.error);assert.match(done.result,live?/REAL_REMOTE_OPENCODE_OK/:/opencode mock/);
  await assert.rejects(request('/v1/agents/atlas/uploads','POST',{path:'wrong-target.bin',destination:'work',size:0,checksum:hash(Buffer.alloc(0)),machineId:'wrong-computer'}),{status:409});
  const bytes=randomBytes(1048600),file=await upload('nested/data.bin',bytes);assert.deepEqual(readFileSync(join(root,'agents/atlas/files/work/nested/data.bin')),bytes);const chunk=await request(`/v1/agents/atlas/files/${file.id}/chunks/1`);assert.deepEqual(Buffer.from(chunk.data,'base64'),bytes.subarray(1048576));await assert.rejects(request(`/v1/agents/scout/files/${file.id}`),{status:404});
});
test('paired runner receives encrypted files, runs OpenCode, and moves edited uploads back to local',async()=>{
  const pairing=await request('/v1/machines','POST',{name:'Files runner',platform:'linux',...(live?{coordinatorUrl:'https://paired-runner-acceptance.invalid'}:{})});
  runner=spawn(process.execPath,['--import','tsx','runtime/runner.ts','--coordinator',base,'--pairing-code',pairing.code],{env:{...process.env,OPEN_HARNESS_MOCK:live?'0':'1',OPEN_HARNESS_RUNNER_STATE_DIR:remote},stdio:'pipe'});runner.stderr?.on('data',chunk=>logs+=chunk);
  await until(async()=>existsSync(join(remote,'connection.json')),Boolean);machineId=JSON.parse(readFileSync(join(remote,'connection.json'),'utf8')).machineId;
  // Existing data moves through encrypted chunks before assignment changes.
  const p=await profile();await request('/v1/agents/atlas/profile','PUT',{...p,computer:{...p.computer,machineId}});
  const moved=await until(()=>request('/v1/agents/atlas/profile'),p=>['completed','failed'].includes(p.transfer?.state));assert.equal(moved.transfer.state,'completed',moved.transfer.detail);assert.equal(moved.profile.computer.machineId,machineId);
  const bytes=randomBytes(2048),u=await upload('remote.dat',bytes);assert.deepEqual(readFileSync(join(remote,'agents/atlas/files/work/remote.dat')),bytes);
  const run=await request('/v1/runs','POST',{agentId:'atlas',prompt:'Remote OpenCode'});const done=await until(()=>request(`/v1/runs/${run.id}`),r=>['completed','failed'].includes(r.state));assert.equal(done.state,'completed',done.error);assert.match(done.result,live?/REAL_REMOTE_OPENCODE_OK/:/opencode mock/);
  const edited=Buffer.from('Working file edited on the runner');writeFileSync(join(remote,'agents/atlas/files/work/remote.dat'),edited);
  const current=await profile();await request('/v1/agents/atlas/profile','PUT',{...current,computer:{...current.computer,machineId:'local'}});
  const returned=await until(()=>request('/v1/agents/atlas/profile'),p=>['completed','failed'].includes(p.transfer?.state));assert.equal(returned.transfer.state,'completed',returned.transfer.detail);assert.equal(returned.profile.computer.machineId,'local');assert.deepEqual(readFileSync(join(root,'agents/atlas/files/work/remote.dat')),edited);
  assert.ok((await request('/v1/agents/atlas/files')).files.some((f:{path:string})=>f.path==='remote.dat'));assert.ok(u.id);
});
