import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PersistentRun } from '../lib/control-client';
import type { AgentProfile } from '../lib/agent-profile';

async function until<T>(read:()=>Promise<T>,accepts:(value:T)=>boolean){
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){const value=await read();if(accepts(value))return value;await new Promise(resolve=>setTimeout(resolve,30));}
  throw new Error('Latency fixture did not reach its expected state.');
}
async function fixture(ttl=300000){
  const socket=createServer();await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));const address=socket.address();assert.ok(address&&typeof address!=='string');const port=address.port;await new Promise<void>(resolve=>socket.close(()=>resolve()));
  const root=mkdtempSync(join(tmpdir(),'harness-latency-')),base=`http://127.0.0.1:${port}`;
  let child:ChildProcess,token='';
  async function start(){
    child=spawn(process.execPath,['--import','tsx','runtime/service.ts'],{cwd:join(import.meta.dirname,'..'),env:{...process.env,OPEN_HARNESS_MOCK:'1',OPEN_HARNESS_DISABLE_OS_VAULT:'1',OPEN_HARNESS_STATE_DIR:root,OPEN_HARNESS_PORT:String(port),OPEN_HARNESS_PREWARM:'1',OPEN_HARNESS_PREWARM_TTL_MS:String(ttl)},stdio:'pipe'});
    child.stdout?.resume();child.stderr?.resume();
    await until(async()=>{try{const response=await fetch(base+'/v1/bootstrap');if(response.ok){token=(await response.json()).token;return true;}}catch{}return false;},value=>value);
  }
  async function call(path:string,method='GET',body?:unknown){const response=await fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,value:await response.json()};}
  async function api(path:string,method='GET',body?:unknown){const response=await call(path,method,body);assert.ok(response.status<400,JSON.stringify(response));return response.value;}
  async function stop(signal:NodeJS.Signals='SIGTERM'){if(child.exitCode!==null||child.signalCode!==null)return;const exit=new Promise(resolve=>child.once('exit',resolve));child.kill(signal);await exit;}
  async function run(prompt='Reply directly.',extra:Record<string,unknown>={}){return await api('/v1/runs','POST',{agentId:'atlas',prompt,...extra}) as PersistentRun;}
  async function completed(id:string){return until(()=>api(`/v1/runs/${id}`) as Promise<PersistentRun>,run=>['completed','failed','interrupted','cancelled'].includes(run.state));}
  async function ready(id:string){await until(()=>api('/v1/health'),value=>value.preparation.readyAgentIds.includes(id));}
  await start();await api('/v1/agents/sync','POST',{agents:['atlas','scout'].map(id=>({id,name:id,role:'Assistant',description:'',instructions:'Answer direct questions directly. Use tools when the task needs them.',tone:0,memory:[]}))});
  return {root,api,call,run,completed,ready,start,stop};
}

test('prepared runtimes are reused only with matching grants and reply-only tasks preserve profile permissions',async()=>{
  const f=await fixture();try{
    const first=await f.run();assert.equal((await f.completed(first.id)).state,'completed');await f.ready('atlas');
    assert.equal(JSON.parse(readFileSync(join(f.root,'agents/atlas/managed/run-lease.json'),'utf8')).active,false);
    const second=await f.run();await f.completed(second.id);
    assert.equal((await f.api(`/v1/runs/${second.id}/events`)).events.find((event:{type:string;payload:{phase:string}})=>event.type==='run.phase'&&event.payload.phase==='profile-ready').payload.prewarmed,true);
    await f.ready('atlas');
    const {profile}=await f.api('/v1/agents/atlas/profile') as {profile:AgentProfile};
    await f.api('/v1/credentials','POST',{ref:'LATENCY_CONNECTOR',label:'Latency connector',provider:'custom',value:'private-fixture-value'});
    await f.api('/v1/agents/atlas/profile','PUT',{...profile,allowedTools:[...profile.allowedTools,'terminal'],terminalConsent:true,connectors:[{id:'fixture',name:'fixture',enabled:true,command:'fixture',args:[],secretRef:'LATENCY_CONNECTOR'}]});
    const request={agentId:'atlas',conversationId:'reply-only',requestId:'reply-once',prompt:'MOCK_HISTORY',replyOnly:true};
    const reply=await f.api('/v1/runs','POST',request);assert.equal(reply.reply_only,true);assert.equal((await f.completed(reply.id)).state,'completed');
    assert.equal((await f.api('/v1/runs','POST',request)).id,reply.id);
    assert.equal((await f.call('/v1/runs','POST',{...request,replyOnly:false})).status,409);
    assert.equal((await f.call('/v1/runs','POST',{...request,requestId:'invalid-mode',replyOnly:'yes'})).status,400);
    const events=(await f.api(`/v1/runs/${reply.id}/events`)).events,applied=events.find((event:{type:string})=>event.type==='profile.applied').payload;
    assert.deepEqual(applied.allowedTools,[]);assert.equal(applied.replyOnly,true);
    assert.equal(events.find((event:{type:string;payload:{phase:string}})=>event.type==='run.phase'&&event.payload.phase==='profile-ready').payload.prewarmed,false);
    const config=JSON.parse(readFileSync(join(f.root,'agents/atlas/profile/config.yaml'),'utf8'));assert.deepEqual(config.mcp_servers,{});
    assert.doesNotMatch(readFileSync(join(f.root,'agents/atlas/profile/.env'),'utf8'),/private-fixture-value/);
    await f.ready('atlas');
    const continued=await f.run('MOCK_HISTORY',{conversationId:'reply-only',replyOnly:true});
    const result=await f.completed(continued.id);assert.deepEqual(JSON.parse(result.result!),[{role:'user',content:'MOCK_HISTORY'},{role:'assistant',content:'[]'}]);
    assert.equal((await f.api(`/v1/runs/${continued.id}/events`)).events.find((event:{type:string;payload:{phase:string}})=>event.type==='run.phase'&&event.payload.phase==='profile-ready').payload.prewarmed,true);
    await f.ready('atlas');
    const denied=await f.run('MOCK_TOOL:terminal',{replyOnly:true});assert.equal((await f.completed(denied.id)).state,'failed');
    const normal=await f.run('MOCK_TOOL:terminal');assert.equal((await f.completed(normal.id)).state,'completed');await f.ready('atlas');
    const current=(await f.api('/v1/agents/atlas/profile')).profile as AgentProfile;
    assert.ok(current.allowedTools.includes('terminal'));assert.equal(current.connectors.length,1);
    await f.api('/v1/agents/atlas/profile','PUT',{...current,allowedTools:current.allowedTools.filter(tool=>tool!=='terminal')});
    const revoked=await f.run('MOCK_TOOL:terminal');assert.equal((await f.completed(revoked.id)).state,'failed');
    assert.equal((await f.api(`/v1/runs/${revoked.id}/events`)).events.find((event:{type:string;payload:{phase:string}})=>event.type==='run.phase'&&event.payload.phase==='profile-ready').payload.prewarmed,false);
  }finally{await f.stop();}
});

test('idle runtime expiry and replacement cannot stop an admitted task',async()=>{
  const f=await fixture(1000);try{
    const first=await f.run();await f.completed(first.id);await f.ready('atlas');
    await until(()=>f.api('/v1/health'),value=>!value.preparation.preparingAgentId&&!value.preparation.readyAgentIds.length);
    const second=await f.run();await f.completed(second.id);
    assert.equal((await f.api(`/v1/runs/${second.id}/events`)).events.find((event:{type:string;payload:{phase:string}})=>event.type==='run.phase'&&event.payload.phase==='profile-ready').payload.prewarmed,false);
    await f.ready('atlas');const pending=await f.run('MOCK_APPROVAL');
    const waiting=await until(()=>f.api(`/v1/runs/${pending.id}`),value=>value.state==='waiting_approval');
    const scout=await f.run('MOCK_SLOW',{agentId:'scout'});await f.completed(scout.id);await f.ready('scout');
    assert.deepEqual((await f.api('/v1/health')).preparation.readyAgentIds,['scout']);
    await until(()=>f.api('/v1/health'),value=>!value.preparation.preparingAgentId&&!value.preparation.readyAgentIds.length);
    assert.equal((await f.api(`/v1/runs/${pending.id}`)).state,'waiting_approval');
    await f.api(`/v1/runs/${pending.id}/approval`,'POST',{approvalId:waiting.pendingApprovals[0].approvalId,decision:'approve'});
    assert.equal((await f.completed(pending.id)).state,'completed');
  }finally{await f.stop();}
});

test('a queued reply-only task keeps its restriction across coordinator restart',async()=>{
  const f=await fixture();try{
    const first=await f.run('MOCK_APPROVAL');await until(()=>f.api(`/v1/runs/${first.id}`),value=>value.state==='waiting_approval');
    const queued=await f.run('MOCK_TOOL:terminal',{replyOnly:true});assert.equal(queued.state,'queued');
    await f.stop('SIGKILL');await f.start();const result=await f.completed(queued.id);assert.equal(result.reply_only,true);assert.equal(result.state,'failed');assert.match(result.error!,/disabled/);
    const applied=(await f.api(`/v1/runs/${queued.id}/events`)).events.find((event:{type:string})=>event.type==='profile.applied').payload;assert.deepEqual(applied.allowedTools,[]);
  }finally{await f.stop();}
});
