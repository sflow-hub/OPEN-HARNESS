import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const binary=process.env.OPEN_HARNESS_RUST_RUNNER;
test('all headless adapters use isolated non-TTY processes, retain per-agent state, reject truncation and stop on request', {timeout:60_000}, async (t) => {
  assert.ok(binary, 'Set OPEN_HARNESS_RUST_RUNNER to the native runner binary');
  const root=mkdtempSync(join(tmpdir(),'oh-headless-'));
  const state=join(root,'worker'), bin=join(root,'bin'), shared=join(root,'shared-data');
  mkdirSync(bin);mkdirSync(state,{mode:0o700});mkdirSync(shared);
  const fixture=join(bin,'docker');
  mkdirSync(join(state,'rust-inputs'),{mode:0o700});
  writeFileSync(join(state,'rust-inputs','prompt-left-by-previous-worker'),'stale',{mode:0o600});
  copyFileSync(join(import.meta.dirname,'headless-docker.mjs'),fixture);chmodSync(fixture,0o755);
  writeFileSync(join(state,'rust-runner-secrets.json'),JSON.stringify({MODEL_KEY:'fixture-private-key'}),{mode:0o600});
  const queue=[], completions=new Map(), events=new Map();
  const server=createServer(async(req,res)=>{
    const chunks=[]; for await (const chunk of req) chunks.push(chunk);
    const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
    const send=(v)=>res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(v));
    if(req.url==='/v1/runner/pair') {
      assert.equal(body.capabilities.desktop,false);
      assert.equal(body.capabilities.virtualDesktop,false);
      return send({machineId:'machine-test',token:'fixture-machine-token'});
    }
    if(req.url==='/internal/task') {
      assert.equal(req.headers.authorization,'Bearer agent-token');assert.equal(req.headers['x-open-harness-agent'],'agent0');
      assert.ok(req.headers['x-open-harness-run']);return send({ok:true});
    }
    assert.equal(req.headers.authorization,'Bearer fixture-machine-token');
    assert.equal(req.headers['x-open-harness-machine'],'machine-test');
    if(req.url==='/v1/runner/heartbeat') return send({ok:true});
    if(req.url==='/v1/runner/commands') return send({commands:queue.splice(0)});
    const [,id,op]=req.url.match(/^\/v1\/runner\/commands\/([^/]+)\/(complete|events)$/);
    if(op==='complete') {completions.set(id,body);} else {events.set(id,[...(events.get(id)||[]),body.event]);}
    send({ok:true});
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  let log='';
  const runner=spawn(binary,['--coordinator',`http://127.0.0.1:${server.address().port}`,'--pairing-code','fixture'],{
    env:{...process.env,PATH:bin+':'+process.env.PATH,OPEN_HARNESS_RUNNER_STATE_DIR:state,OPEN_HARNESS_MOCK:'0'},stdio:['ignore','pipe','pipe'],
  });
  for(const io of [runner.stdout,runner.stderr]) io.on('data',(data)=>{log=(log+data).slice(-4000);});
  t.after(async()=>{
    if(runner.exitCode===null && !runner.signalCode){runner.kill('SIGTERM');await once(runner,'exit');}
    server.closeAllConnections();await new Promise((done)=>server.close(done));rmSync(root,{recursive:true,force:true});
  });
  const wait=async(read)=>{
    for(let i=0;i<100;i++){const value=read();if(value)return value; if(runner.exitCode!==null) break; await delay(100);}
    assert.fail('The worker did not deliver. '+log+' '+JSON.stringify([...completions]));
  };
  const run=(agent,harness,prompt)=>{
    const id=randomUUID(),runId=randomUUID();
    const snapshot={id:agent,revision:2,harness,prompt:{enabled:true,text:'Be brief'},connectors:[],allowedTools:['terminal','read_file','write_file','patch','search_files', ...(harness==='hermes'?['mcp__open_harness__task']:[])],
      effectiveModel:{provider:harness==='claude-code'?'anthropic':'openai',model:'fixture-model',credentialRef:'MODEL_KEY',baseUrl:''},
      computer:{access:'folders',desktop:'none',folders:[{path:shared,mode:'read'}],resources:{cpu:1,memoryMb:512}}};
    queue.push({id,agentId:agent,kind:'run',payload:{runId,prompt,snapshot,coordinationToken:'agent-token'}});
    return {id,runId,agent};
  };
  const runs=['hermes','claude-code','codex'].map((h,i)=>run('agent'+i,h,'Answer via stdin only'));
  await Promise.all(runs.map(async ({id,agent},i)=>{
    const completed=await wait(()=>completions.get(id));
    assert.deepEqual(completed.result.text,['Hermes reply','Claude reply: [redacted]','Codex reply: [redacted]'][i]);
    assert.ok(events.get(id).some(e=>e.type==='message.delta'));
    assert.ok(!JSON.stringify(events.get(id)).includes('fixture-private-key'));
    const {args}=JSON.parse(readFileSync(join(state,`open-harness-rust-${id}.json`)));
    const mounts=args.filter(a=>a.startsWith('type=bind'));
    assert.ok(mounts.some(a=>a.includes(`/agents/${agent}/private`)));
    assert.ok(mounts.some(a=>a.includes('target=/workspace/mounts/folder-1,readonly')));
    assert.ok(mounts.every(a=>!a.includes('/agents/') || a.includes('/agents/'+agent+'/')));
  }));
  for(const h of ['claude-code','codex']) {
    const {id}=run('broken',h,'Truncate stream');
    assert.match((await wait(()=>completions.get(id))).error,/before confirming completion/);
  }
  const slow=run('slow','codex','Slow job');
  await wait(()=>events.get(slow.id)?.some(e=>e.type==='gateway.ready'));
  const stop=randomUUID();
  queue.push({id:stop,agentId:slow.agent,kind:'stop',payload:{runId:slow.runId,commandId:slow.id}});
  assert.equal((await wait(()=>completions.get(stop))).result.ok,true);
  assert.match((await wait(()=>completions.get(slow.id))).error,/stopped/);
  assert.ok(existsSync(join(state,'removed')));
  assert.ok(readFileSync(join(state,'removed'),'utf8').includes('open-harness-rust-'+slow.id));
  assert.deepEqual(readdirSync(join(state,'rust-inputs')),[]);
});
