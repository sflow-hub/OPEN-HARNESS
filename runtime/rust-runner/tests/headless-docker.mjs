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
const modelKey = 'fixture-private-key';
const imagePins = { opencode: '1.19.6', pi: '1.6.0', openhands: '1.63.1' };
const additionalImage = /^open-harness-(opencode|pi|openhands):/;

function readonlyBindSource(containerArgs, target) {
  const suffix = `,target=${target},readonly`;
  const mount = containerArgs.find((arg) => arg.startsWith('type=bind,') && arg.endsWith(suffix));
  assert.ok(mount, `${target} must be a read-only bind mount`);
  const [source] = mount.slice('type=bind,'.length, -suffix.length).match(/^(?:source|src)=(.+)$/).slice(1);
  return source;
}

function managedOptions(cli) {
  const directory = readonlyBindSource(args, '/run/open-harness');
  assert.equal(statSync(directory).mode & 0o077, 0);
  const config = (file) => {
    const value = readFileSync(join(directory, file), 'utf8');
    assert.ok(!value.includes(modelKey));
    return JSON.parse(value);
  };
  if (cli === 'opencode') {
    assert.equal(after('--workdir'), '/workspace');
    assert.equal(after('--format'), 'json');
    const provider = config('opencode.json').provider['open-harness-model'];
    const [model] = Object.keys(provider.models);
    assert.equal(after('--model'), `open-harness-model/${model}`);
    return { baseUrl: provider.options.baseURL, model };
  }
  if (cli === 'pi') {
    assert.equal(after('--workdir'), '/workspace/shared');
    assert.equal(after('--mode'), 'json');
    assert.ok(args.includes('--no-mcp') && args.includes('--no-extensions'));
    const provider = config('models.json').providers['open-harness-model'];
    assert.equal(after('--model'), provider.models[0].id);
    return { baseUrl: provider.baseUrl, model: provider.models[0].id };
  }
  assert.equal(after('--workdir'), '/workspace');
  const { baseUrl, model, provider } = config('config.json');
  return { baseUrl, model, provider };
}

function emitAdditional(cli, prompt, keyed) {
  const expected = prompt === 'Truncate stream' || prompt === 'Exit failure' || prompt === 'Provider error';
  assert.ok(expected || prompt === '--answer on stdin\nSecond line with π');
  const reply = `Managed reply${keyed ? ': ' + modelKey : ''}`;
  const failure = `Provider rejected ${modelKey}`;
  if (prompt === 'Provider error') {
    if (cli === 'opencode') emit({type:'error',error:{name:'APIError',data:{message:failure}}});
    if (cli === 'pi') {
      emit({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:failure,content:[]}});
      emit({type:'agent_settled',aborted:false});
    }
    if (cli === 'openhands') emit({type:'error',message:failure});
    return;
  }
  const completed = prompt !== 'Truncate stream';
  if (cli === 'opencode') {
    emit({type:'step_start',part:{type:'step-start'}});
    emit({type:'tool_use',part:{type:'tool',callID:'tool-1',tool:'bash',state:{status:'completed',input:{command:'pwd'},output:reply}}});
    emit({type:'step_finish',part:{type:'step-finish',reason:'tool-calls'}});
    emit({type:'step_start',part:{type:'step-start'}});
    const chunks = keyed ? [reply.slice(0, -4), reply.slice(-4)] : [reply];
    for (const text of chunks) emit({type:'text',part:{type:'text',text}});
    if (completed) emit({type:'step_finish',part:{type:'step-finish',reason:'stop'}});
  } else if (cli === 'pi') {
    emit({type:'tool_execution_start',toolCallId:'tool-1',toolName:'bash',args:{command:'pwd'}});
    emit({type:'tool_execution_end',toolCallId:'tool-1',toolName:'bash',result:{content:[{type:'text',text:reply}]},isError:false});
    // A key split across two text blocks still needs redaction in the assembled reply.
    const parts = keyed ? [reply.slice(0, -4), reply.slice(-4)] : [reply];
    const message = {role:'assistant',stopReason:'stop',content:parts.map(text=>({type:'text',text}))};
    emit({type:'message_end',message});
    emit({type:'agent_end',messages:[message],willRetry:false});
    if (completed) emit({type:'agent_settled',aborted:false});
  } else {
    emit({type:'tool.start',id:'tool-1',name:'terminal',preview:'pwd'});
    emit({type:'tool.complete',id:'tool-1',name:'terminal',result:reply,error:false});
    emit({type:'message',text:reply});
    if (completed) emit({type:'result',text:reply});
  }
  if (prompt === 'Exit failure') process.exitCode = 17;
}

switch (command) {
  case 'info': console.log('28.0.0'); break;
  case 'image': {
    const tag = args.at(-1);
    const harness = tag.match(additionalImage)?.[1];
    if (harness && !existsSync(join(state, `${harness}.image`))) process.exit(1);
    if (harness) assert.equal(readFileSync(join(state, `${harness}.image`), 'utf8'), tag);
    console.log(tag.includes('hermes') ? image + ' 3' : image);
    break;
  }
  case 'build': {
    const tag = after('--tag');
    const harness = tag.match(additionalImage)?.[1];
    assert.ok(harness, 'build a recognized named image');
    const version = imagePins[harness];
    assert.ok(tag.startsWith(`open-harness-${harness}:${version}`));
    assert.ok(readFileSync(after('--file'), 'utf8').includes(version));
    const attempts = join(state, `${harness}.builds`);
    const first = !existsSync(attempts);
    appendFileSync(attempts, 'build\n');
    if (harness === 'pi' && first) process.exit(1);
    writeFileSync(join(state, `${harness}.image`), tag);
    break;
  }
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
    const cli = args.slice(args.indexOf(image) + 1).map((arg) => ({
      codex:'codex',claude:'claude-code',opencode:'opencode',pi:'pi','/opt/open-harness/openhands.py':'openhands',
    })[arg]).find(Boolean) || 'hermes';
    if (cli === 'openhands') {
      assert.deepEqual(args.slice(args.indexOf('python3')), ['python3', '-P', '/opt/open-harness/openhands.py']);
    }
    let managed;
    if (cli !== 'hermes') {
      assert.ok(!args.includes('-i') && !args.includes('--interactive'));
      assert.equal(after('--entrypoint'), '/bin/sh');
      assert.ok(args.includes('exec "$@" < /run/open-harness-prompt'));
      const env = after('--env-file');
      assert.equal(statSync(env).mode & 0o777, 0o600);
      const vars = readFileSync(env, 'utf8').trim().split('\n');
      assert.ok(!vars.some((variable) => variable.includes('fixture-other-key')));
      assert.ok(!args.some((arg) => arg.includes(modelKey)));
      if (Object.hasOwn(imagePins, cli)) {
        const modelVar = vars.find((variable) => variable.startsWith('OPEN_HARNESS_MODEL_API_KEY='));
        assert.ok(!modelVar || modelVar === `OPEN_HARNESS_MODEL_API_KEY=${modelKey}`);
        assert.equal(vars.filter((variable) => variable.includes(modelKey)).length, Number(Boolean(modelVar)));
        assert.ok(args.some((arg, index) => args[index - 1] === '--tmpfs' && /^\/home\/agent(?::|$)/.test(arg)));
        assert.ok(!args.some((arg) => arg.includes('target=/home/agent')));
        managed = { ...managedOptions(cli), keyed: Boolean(modelVar) };
      } else {
        assert.ok(args.includes(cli === 'codex' ? '--json' : '--print'));
        assert.ok(vars.some((variable) => variable.includes(modelKey)));
      }
    }
    writeFileSync(join(state, name + '.json'), JSON.stringify({cli, args, managed}));
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
    const promptPath = readonlyBindSource(config.args, '/run/open-harness-prompt');
    assert.equal(statSync(promptPath).mode & 0o777, 0o600);
    const prompt = readFileSync(promptPath, 'utf8');
    assert.ok(!config.args.some((arg) => arg.includes(prompt)), 'the prompt must stay out of Docker argv');
    if (prompt === 'Slow job') {
      writeFileSync(join(state, `${name}.started`), 'started');
      await delay(30_000);
      break;
    }
    if (config.managed) {
      emitAdditional(config.cli, prompt, config.managed.keyed);
      break;
    }
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
