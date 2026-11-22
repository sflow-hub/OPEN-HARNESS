import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import {answer,key,modelFixture,serve,send} from './provider-fixture.mjs';

test('pinned Hermes, Claude Code and Codex binaries each finish a headless turn using only a local model', {skip:process.env.OPEN_HARNESS_RUST_LIVE!=='1',timeout:1_260_000}, async(t)=>{
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
  for(const [harness,endpoint] of [['claude-code','/v1/messages'],['codex','/v1/responses'],['hermes','/v1/chat/completions']]) await t.test(harness,{skip:!!selected && harness!==selected},async()=>{
    const id=randomUUID(), agentId='live-'+harness;
    const snapshot={id:agentId,revision:1,harness,prompt:{enabled:true,text:'Answer once.'},connectors:[],
      allowedTools:harness==='codex'?['terminal','read_file','write_file','patch','search_files']:[],
      effectiveModel:{provider:harness==='claude-code'?'anthropic':'openai',model:harness==='claude-code'?'claude-sonnet-4-6':'gpt-4o-mini',credentialRef:'FIXTURE_KEY',baseUrl:harness==='claude-code'?base:base+'/v1'},
      computer:{access:'private',desktop:'none',folders:[],resources:{cpu:2,memoryMb:3072}}};
    pending.push({id,agentId,kind:'run',payload:{runId:randomUUID(),prompt:'Reply that you confirmed the headless run.',snapshot,coordinationToken:'fixture-agent'}});
    for(let i=0;i<2_050&&!complete.has(id)&&worker.exitCode===null;i++)await delay(200);
    const result=complete.get(id);
    const diagnostic=`${harness} ${JSON.stringify(result)} ${JSON.stringify([...seen])} ${JSON.stringify((events.get(id)||[]).map(e=>e.type))} ${log}`;
    assert.ok(result,diagnostic); assert.equal(result.error,undefined,diagnostic);
    assert.equal(result.result.text||result.result.final_response,answer,diagnostic);
    assert.ok(seen.has(endpoint),diagnostic);
    assert.ok(events.get(id)?.some(e=>['message.delta','message.complete'].includes(e.type)),diagnostic);
    t.diagnostic(harness+' completed via '+endpoint);
  });
});
