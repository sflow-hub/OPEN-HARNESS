import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import {answer,holdPrompt,key,modelFixture,serve,send} from './provider-fixture.mjs';

test('pinned headless harnesses run against a local model fixture', {skip:process.env.OPEN_HARNESS_RUST_LIVE!=='1',timeout:1_260_000}, async(t)=>{
  const {seen,base}=await modelFixture(t);
  const pending=[],complete=new Map(),events=new Map();
  const machineId='machine-live-'+randomUUID();
  const coordinator=await serve(t,(req,res,body)=>{
    if(req.url==='/v1/runner/pair') return send(res,{machineId,token:'fixture-machine'});
    assert.equal(req.headers.authorization,'Bearer fixture-machine');
    if(req.url==='/v1/runner/heartbeat')return send(res,{ok:true});
    if(req.url==='/v1/runner/commands')return send(res,{commands:pending.splice(0)});
    const [,id,kind]=req.url.match(/^\/v1\/runner\/commands\/([^/]+)\/(events|complete)$/);
    if(kind==='complete')complete.set(id,body);
    else events.set(id,[...(events.get(id)||[]),body.event]);
    send(res,{ok:true});
  },'127.0.0.1');
  const root=mkdtempSync(join(tmpdir(),'oh-live-'));
  writeFileSync(join(root,'rust-runner-secrets.json'),JSON.stringify({FIXTURE_KEY:key}),{mode:0o600});
  const worker=spawn(process.env.OPEN_HARNESS_RUST_RUNNER,['--coordinator',`http://127.0.0.1:${coordinator}`,'--pairing-code','live'],{env:{...process.env,OPEN_HARNESS_MOCK:'0',OPEN_HARNESS_RUNNER_STATE_DIR:root},stdio:['ignore','pipe','pipe']});
  let log='';
  for(const s of [worker.stdout,worker.stderr])s.on('data',v=>log=(log+v).slice(-2000));
  t.after(async()=>{
    if(worker.exitCode===null&&!worker.signalCode){worker.kill('SIGTERM');await once(worker,'exit');}
    rmSync(root,{recursive:true,force:true});
  });
  const selected=process.env.OPEN_HARNESS_RUST_LIVE_ONLY;
  const added = ['opencode','pi','openhands'];
  const harnesses = [
    ['claude-code','/v1/messages'],
    ['codex','/v1/responses'],
    ['hermes','/v1/chat/completions'],
    ...added.map(harness=>[harness,'/v1/chat/completions']),
  ];
  const wait = async (condition, attempts) => {
    for(let i=0;i<attempts && !condition() && worker.exitCode===null;i++) await delay(200);
    return condition();
  };
  for(const [harness,endpoint] of harnesses) await t.test(harness,{skip:!!selected && harness!==selected},async()=>{
    const agentId='live-'+harness;
    const snapshot={id:agentId,revision:1,harness,prompt:{enabled:true,text:'Answer once.'},connectors:[],
      allowedTools:harness==='codex'?['terminal','read_file','write_file','patch','search_files']:[],
      effectiveModel:{provider:harness==='claude-code'?'anthropic':added.includes(harness)?'custom':'openai',
        model:harness==='claude-code'?'claude-sonnet-4-6':'gpt-4o-mini',credentialRef:'FIXTURE_KEY',baseUrl:harness==='claude-code'?base:base+'/v1'},
      computer:{access:'private',desktop:'none',folders:[],resources:{cpu:2,memoryMb:3072}}};
    const run = (prompt, agent=agentId) => {
      const id=randomUUID(),runId=randomUUID();
      pending.push({id,agentId:agent,kind:'run',payload:{
        runId,prompt,snapshot:{...snapshot,id:agent},coordinationToken:'fixture-agent',
      }});
      return {id,runId};
    };
    const {id}=run('Reply that you confirmed the headless run.');
    const priorRequests=seen.get(endpoint)||0;
    await wait(()=>complete.has(id),2_050);
    const result=complete.get(id);
    const diagnostic=`${harness} ${JSON.stringify(result)} ${JSON.stringify([...seen])} ${JSON.stringify((events.get(id)||[]).map(e=>e.type))} ${log}`;
    assert.ok(result,diagnostic); assert.equal(result.error,undefined,diagnostic);
    assert.equal(result.result.text||result.result.final_response,answer,diagnostic);
    assert.ok((seen.get(endpoint)||0)>priorRequests,diagnostic);
    assert.ok(events.get(id)?.some(e=>['message.delta','message.complete'].includes(e.type)),diagnostic);
    if (added.includes(harness)) {
      const waiting=seen.get('waiting')||0;
      const slowAgent=agentId+'-slow';
      const slow=run(holdPrompt,slowAgent);
      await wait(()=>(seen.get('waiting')||0)>waiting || complete.has(slow.id),2_050);
      assert.ok((seen.get('waiting')||0)>waiting,
        harness+' did not reach the model before cancellation. '+JSON.stringify(complete.get(slow.id))+' '+log);
      const stop=randomUUID();
      pending.push({id:stop,agentId:slowAgent,kind:'stop',payload:{runId:slow.runId,commandId:slow.id}});
      assert.ok(await wait(()=>complete.has(stop)&&complete.has(slow.id),300),harness+' did not acknowledge cancellation. '+log);
      assert.equal(complete.get(stop).result.ok,true);
      assert.match(complete.get(slow.id).error,/stopped/);
    }
    t.diagnostic(harness+' completed via '+endpoint);
  });
});
