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
const additional = ['opencode', 'pi', 'openhands'];
const endpoints = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  xai: 'https://api.x.ai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  local: 'http://host.docker.internal:39123/v1',
  custom: 'https://example.invalid/inference/v1',
};
const modelKey = 'fixture-private-key';

test('headless workers install, run, and stop isolated harnesses', {timeout:90_000}, async (t) => {
  assert.ok(binary, 'Set OPEN_HARNESS_RUST_RUNNER to the native runner binary');
  const root=mkdtempSync(join(tmpdir(),'oh-headless-'));
  const state=join(root,'worker'), bin=join(root,'bin'), shared=join(root,'shared-data');
  mkdirSync(bin);mkdirSync(state,{mode:0o700});mkdirSync(shared);
  const fixture=join(bin,'docker');
  mkdirSync(join(state,'rust-inputs'),{mode:0o700});
  writeFileSync(join(state,'rust-inputs','prompt-left-by-previous-worker'),'stale',{mode:0o600});
  copyFileSync(join(import.meta.dirname,'headless-docker.mjs'),fixture);chmodSync(fixture,0o755);
  writeFileSync(join(state,'rust-runner-secrets.json'),JSON.stringify({MODEL_KEY:modelKey,UNRELATED_KEY:'fixture-other-key'}),{mode:0o600});
  const queue=[], completions=new Map(), events=new Map();
  const expectedHarnesses = ['hermes', 'claude-code', 'codex', ...additional].sort();
  let log = '', fixtureError, replayCommand, lostEventId, lostEventAttempts = 0, runner;
  const handle = async(req,res)=>{
    const chunks=[]; for await (const chunk of req) chunks.push(chunk);
    const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
    const send=(v)=>res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(v));
    if(req.url==='/v1/runner/pair') {
      assert.equal(body.capabilities.desktop,false);
      assert.equal(body.capabilities.virtualDesktop,false);
      assert.deepEqual([...body.capabilities.harnesses].sort(), expectedHarnesses);
      return send({machineId:'machine-test',token:'fixture-machine-token'});
    }
    if(req.url==='/internal/task') {
      assert.equal(req.headers.authorization,'Bearer agent-token');assert.equal(req.headers['x-open-harness-agent'],'agent0');
      assert.ok(req.headers['x-open-harness-run']);return send({ok:true});
    }
    assert.equal(req.headers.authorization,'Bearer fixture-machine-token');
    assert.equal(req.headers['x-open-harness-machine'],'machine-test');
    if(req.url==='/v1/runner/heartbeat') {
      assert.deepEqual([...body.capabilities.harnesses].sort(), expectedHarnesses);
      return send({ok:true});
    }
    if(req.url==='/v1/runner/commands') return send({commands:queue.splice(0)});
    const [,id,op]=req.url.match(/^\/v1\/runner\/commands\/([^/]+)\/(complete|events)$/);
    if(op==='complete') {
      completions.set(id,body);
    } else {
      const received = events.get(id) ?? new Map();
      received.set(body.eventId, body.event);
      events.set(id, received);
      if (id === replayCommand && !lostEventId && body.event.type === 'message.delta') {
        lostEventId = body.eventId;
        lostEventAttempts += 1;
        res.destroy();
        return;
      }
      if (body.eventId === lostEventId) lostEventAttempts += 1;
    }
    send({ok:true});
  };
  const server = createServer((req,res) => {
    handle(req,res).catch((error) => {
      fixtureError = error;
      res.writeHead(500).end('{}');
    });
  });
  t.after(async()=>{
    if(runner?.exitCode===null && !runner.signalCode){runner.kill('SIGTERM');await once(runner,'exit');}
    server.closeAllConnections();await new Promise((done)=>server.close(done));rmSync(root,{recursive:true,force:true});
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  runner=spawn(binary,['--coordinator',`http://127.0.0.1:${server.address().port}`,'--pairing-code','fixture'],{
    env:{...process.env,PATH:bin+':'+process.env.PATH,OPEN_HARNESS_RUNNER_STATE_DIR:state,OPEN_HARNESS_MOCK:'0'},stdio:['ignore','pipe','pipe'],
  });
  runner.on('error', (error) => { fixtureError = error; });
  for(const io of [runner.stdout,runner.stderr]) io.on('data',(data)=>{log=(log+data).slice(-4000);});
  const wait=async(read)=>{
    for(let i=0;i<150;i++){
      if (fixtureError) throw fixtureError;
      const value=read();if(value)return value;
      if(runner.exitCode!==null || runner.signalCode) break;
      await delay(100);
    }
    assert.fail('The worker did not deliver. '+log+' '+JSON.stringify([...completions]));
  };
  const recorded = (id) => [...(events.get(id)?.values() ?? [])];
  const containerRecord = (id) => join(state,`open-harness-rust-${id}.json`);
  const run=(agent,harness,prompt,selection={})=>{
    const id=randomUUID(),runId=randomUUID();
    const snapshot={id:agent,revision:2,harness,prompt:{enabled:true,text:'Be brief'},connectors:[],allowedTools:['terminal','read_file','write_file','patch','search_files', ...(harness==='hermes'?['mcp__open_harness__task']:[])],
      effectiveModel:{provider:harness==='claude-code'?'anthropic':'openai',model:'fixture-model',credentialRef:'MODEL_KEY',baseUrl:'',...selection},
      computer:{access:'folders',desktop:'none',folders:[{path:shared,mode:'read'}],resources:{cpu:1,memoryMb:512}}};
    queue.push({id,agentId:agent,kind:'run',payload:{runId,prompt,snapshot,coordinationToken:'agent-token'}});
    return {id,runId,agent,harness};
  };
  const complete = (id) => wait(()=>completions.get(id));
  const checkSuccess = async ({id,agent,harness},expected) => {
    const completed=await complete(id);
    assert.equal(completed.error, undefined, `${harness} failed: ${completed.error ?? ''}\n${log}`);
    assert.equal(completed.result.text,expected);
    assert.ok(recorded(id).some(e=>e.type==='message.delta'));
    assert.ok(!JSON.stringify(recorded(id)).includes(modelKey));
    assert.ok(!recorded(id).filter(e=>e.type==='message.delta').map(e=>e.payload.text).join('').includes(modelKey));
    const record=JSON.parse(readFileSync(containerRecord(id)));
    const {args}=record;
    assert.equal(record.cli,harness);
    const mounts=args.filter(a=>a.startsWith('type=bind'));
    assert.ok(mounts.some(a=>a.includes(`/agents/${agent}/private`)));
    assert.ok(mounts.some(a=>a.includes('target=/workspace/mounts/folder-1,readonly')));
    assert.ok(mounts.every(a=>!a.includes('/agents/') || a.includes('/agents/'+agent+'/')));
    return record;
  };
  const install = (harness) => {
    const id = randomUUID();
    queue.push({id,kind:'install-harness',payload:{harness}});
    return complete(id);
  };

  const installed = await Promise.all(additional.map(install));
  assert.deepEqual(installed[0].result,{harness:'opencode',state:'ready'});
  assert.match(installed[1].error,/failed to build the pi image/i);
  assert.deepEqual(installed[2].result,{harness:'openhands',state:'ready'});
  assert.deepEqual((await install('pi')).result,{harness:'pi',state:'ready'});

  const runs=['hermes','claude-code','codex'].map((h,i)=>run('agent'+i,h,'Answer via stdin only'));
  await Promise.all(runs.map((entry,i)=>checkSuccess(entry,['Hermes reply','Claude reply: [redacted]','Codex reply: [redacted]'][i])));

  for (const [provider, endpoint] of Object.entries(endpoints)) {
    const keyless = ['local', 'custom'].includes(provider);
    const model = provider === 'openrouter' ? 'fixture-org/fixture-model' : 'fixture-model';
    const baseUrl = keyless ? endpoint : '';
    const jobs = additional.map(harness => run(`${harness}-${provider}`,harness,'--answer on stdin\nSecond line with π',{
      provider, model, baseUrl, credentialRef: keyless ? '' : 'MODEL_KEY',
    }));
    if (provider === 'openai') replayCommand = jobs[0].id;
    await Promise.all(jobs.map(async (entry) => {
      const {managed} = await checkSuccess(entry,keyless ? 'Managed reply' : 'Managed reply: [redacted]');
      assert.equal(managed.model,model);
      // Pi's Anthropic SDK appends the complete /v1/messages path.
      const expectedEndpoint = entry.harness === 'pi' && provider === 'anthropic' ? 'https://api.anthropic.com' : endpoint;
      assert.equal(managed.baseUrl,expectedEndpoint);
      assert.equal(managed.keyed,!keyless);
      if (entry.harness === 'openhands') assert.equal(managed.provider,provider);
      assert.ok(recorded(entry.id).some(e=>e.type==='tool.complete' && e.payload.id==='tool-1'));
      if (entry.harness !== 'opencode') assert.ok(recorded(entry.id).some(e=>e.type==='tool.start'));
    }));
  }
  assert.ok(lostEventId, 'the coordinator must receive a replayable event');
  assert.equal(lostEventAttempts,2);

  const custom = run('pi-custom-keyed','pi','--answer on stdin\nSecond line with π',{
    provider:'custom',baseUrl:endpoints.custom,
  });
  assert.equal((await checkSuccess(custom,'Managed reply: [redacted]')).managed.keyed,true);

  const failures = [
    ['Truncate stream',/before confirming completion/],
    ['Provider error',/Provider rejected \[redacted\]/],
    ['Exit failure',/exited with code 17/],
  ];
  for (const [prompt,expected] of failures) {
    const harnesses = prompt === 'Truncate stream' ? ['claude-code','codex',...additional] : additional;
    const jobs = harnesses.map(harness => run(`broken-${harness}`,harness,prompt));
    await Promise.all(jobs.map(async ({id}) => assert.match((await complete(id)).error,expected,log)));
  }
  const missing = additional.map(harness => run(`missing-${harness}`,harness,'--answer on stdin\nSecond line with π',{
    credentialRef:'MISSING_MODEL_KEY',
  }));
  await Promise.all(missing.map(async ({id})=>{
    assert.match((await complete(id)).error,/credential/i);
    assert.ok(!existsSync(containerRecord(id)));
  }));

  const slowJobs = ['codex',...additional].map(harness => run(`slow-${harness}`,harness,'Slow job'));
  await Promise.all(slowJobs.map(async (job)=>{
    const {id,agent,runId} = job;
    await wait(()=>existsSync(join(state,`open-harness-rust-${id}.started`)));
    const stop=randomUUID();
    queue.push({id:stop,agentId:agent,kind:'stop',payload:{runId,commandId:id}});
    assert.equal((await complete(stop)).result.ok,true);
    assert.match((await complete(id)).error,/stopped/);
    assert.ok(readFileSync(join(state,'removed'),'utf8').includes('open-harness-rust-'+id));
  }));
  for (const harness of additional) {
    const builds = readFileSync(join(state,`${harness}.builds`),'utf8');
    assert.equal(builds,harness === 'pi' ? 'build\nbuild\n' : 'build\n');
  }
  assert.deepEqual(readdirSync(join(state,'rust-inputs')),[]);
});
