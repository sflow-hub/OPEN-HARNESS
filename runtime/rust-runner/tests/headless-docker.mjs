#!/usr/bin/env node
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const [command, ...args] = process.argv.slice(2);
const state = process.env.OPEN_HARNESS_RUNNER_STATE_DIR;
const emit = (v) => process.stdout.write(JSON.stringify(v) + '\n');
const after = (k) => args[args.indexOf(k) + 1];
const image = 'sha256:' + 'd'.repeat(64);
const previous = (name) => JSON.parse(readFileSync(join(state, name + '.json')));
const name = args.includes('--name') ? after('--name') : args.at(-1);
switch (command) {
  case 'info': console.log('28.0.0'); break;
  case 'image': console.log(args.at(-1).includes('hermes') ? image + ' 3' : image); break;
  case 'ps': {
    const filter=after('--filter');
    const container=filter?.match(/^name=\^\/(open-harness-rust-[a-f0-9-]+)\$$/)?.[1];
    if(container && existsSync(join(state,container+'.removal-retry')))console.log('d'.repeat(64));
    break;
  }
  case 'create':
  case 'run': {
    assert.ok(!args.some((arg) => ['-t','--tty','-it','--privileged'].includes(arg)));
    assert.equal(after('--label'), 'dev.openharness.rust-runner=machine-test');
    assert.equal(after('--cap-drop'), 'ALL');
    assert.equal(after('--security-opt'), 'no-new-privileges');
    assert.ok(!args.some((arg) => arg.includes('DISPLAY') || arg.includes('docker.sock')));
    assert.ok(args.includes(image));
    const cli = args.includes('codex') ? 'codex' : args.includes('claude') ? 'claude-code' : 'hermes';
    if (cli !== 'hermes') {
      assert.ok(args.includes(cli === 'codex' ? '--json' : '--print'));
      assert.equal(after('--entrypoint'),'/bin/sh');
      assert.ok(args.includes('exec "$@" < /run/open-harness-prompt'));
      assert.ok(!args.includes('Answer via stdin only'));
      const env = after('--env-file');
      assert.equal(statSync(env).mode & 0o777, 0o600);
      assert.equal(readFileSync(env, 'utf8').includes('fixture-private-key'),true);
      assert.ok(!args.some((arg) => arg.includes('fixture-private-key')));
    }
    writeFileSync(join(state, name + '.json'), JSON.stringify({cli, args}));
    break;
  }
  case 'rm': {
    const retry=join(state,name+'.removal-retry');
    if(existsSync(join(state,name+'.json')) && previous(name).cli==='codex' && !existsSync(retry)) {
      writeFileSync(retry,'once');process.exit(1);
    }
    appendFileSync(join(state, 'removed'), name + '\n'); break;
  }
  case 'exec': {
    assert.ok(args.includes('-i'));
    assert.ok(!args.includes('-t'));
    const name = args[args.indexOf('python') - 1];
    const config=previous(name);
    assert.equal(config.cli, 'hermes');
    const agent='agent0';
    const managed=join(state,'agents',agent,'managed');
    const profile=JSON.parse(readFileSync(join(state,'agents',agent,'profile','config.yaml')));
    const sessionEnv=profile.mcp_servers.open_harness.env;
    // The container connects through its short mount path even when the host workspace is deep.
    const alias = mkdtempSync('/tmp/oh-fixture-socket-');
    try {
      const mount = join(alias, 'managed');
      symlinkSync(managed, mount, 'dir');
      const socketPath = join(mount, 'coord.sock');
      const post=(path,token) => new Promise((resolve,reject)=>{
        const options={socketPath,method:'POST',path,headers:{
          authorization:'Bearer '+token,'x-open-harness-agent':agent,'x-open-harness-run':sessionEnv.OPEN_HARNESS_RUN_ID,'content-type':'application/json'}};
        const r=request(options,res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
        r.on('error',reject);r.end('{}');
      });
      assert.equal(await post('/v1/bootstrap',sessionEnv.OPEN_HARNESS_AGENT_TOKEN),404);
      assert.equal(await post('/internal/task','wrong-token'),403);
      assert.equal(await post('/internal/task',sessionEnv.OPEN_HARNESS_AGENT_TOKEN),200);
    } finally {
      rmSync(alias, { recursive: true, force: true });
    }
    const session = 'hermes-test-session';
    const event=(type,payload)=>emit({method:'event',params:{type,session_id:session,payload}});
    event('gateway.ready',{});
    for await (const line of createInterface({input:process.stdin})) {
      const rpc=JSON.parse(line);
      if (rpc.method==='session.create') emit({id:rpc.id,result:{session_id:session}});
      if (rpc.method==='prompt.submit') {
        assert.equal(rpc.params.text,'Answer via stdin only');
        event('message.delta',{text:'Hermes reply'});
        event('message.complete',{text:'Hermes reply',status:'complete'});
      }
    }
    break;
  }
  case 'start': {
    assert.ok(args.includes('--attach') && !args.includes('-i') && !args.includes('-t'));
    const config = previous(name);
    assert.equal(existsSync(config.args[config.args.indexOf('--env-file') + 1]), false);
    const mount = config.args.find(arg=>arg.endsWith(',target=/run/open-harness-prompt,readonly'));
    const path = mount.match(/,src=([^,]+),|,source=([^,]+),/);
    assert.equal(statSync(path[1]||path[2]).mode & 0o777,0o600);
    const prompt = readFileSync(path[1]||path[2], 'utf8');
    if (prompt === 'Slow job') {console.log('{"type":"thread.started"}');await delay(30_000);}
    if (prompt === 'Truncate stream') break;
    assert.equal(prompt,'Answer via stdin only');
    if(config.cli==='claude-code'){
      emit({type:'assistant',message:{content:[{type:'text',text:'Claude reply: fixture-private-key'}]}});
      emit({type:'result',subtype:'success',result:'Claude reply: fixture-private-key'});
    }else{
      emit({type:'item.completed',item:{type:'agent_message',text:'Codex reply: fixture-private-key'}});
      emit({type:'turn.completed'});
    }
    break;
  }
  default: process.exit(1);
}
