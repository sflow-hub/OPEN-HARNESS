import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { modelProxy } from './model-proxy.mjs';

const profile = process.env.HERMES_HOME || '/home/hermes/.hermes';
const config = JSON.parse(readFileSync(`${profile}/config.yaml`,'utf8'));
const policy = JSON.parse(readFileSync('/run/open-harness/policy.json','utf8'));
let proxy;
if (policy.modelProvider === 'openai-codex') {
  proxy = await modelProxy(policy.coordination);
  const endpoint = `http://127.0.0.1:${proxy.address().port}/v1`;
  // The native OAuth credential pool pins a legacy endpoint. Hermes's supported
  // custom Responses transport keeps this connection on the local scoped bridge.
  config.model.base_url = endpoint; config.providers['open-harness-chatgpt'].base_url = endpoint;
  writeFileSync(`${profile}/config.yaml`,JSON.stringify(config,null,2),{mode:0o600});
}
const child = spawn('python',['/opt/open-harness/managed_entry.py'], { stdio:['pipe','inherit','inherit'], env:process.env });
process.stdin.pipe(child.stdin); child.stdin.on('error',()=>{});
for (const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>child.kill(signal));
child.on('error',()=>{proxy?.closeAllConnections();proxy?.close();process.exit(1);});
child.on('exit',(code,signal)=>{proxy?.closeAllConnections();proxy?.close();process.exit(code ?? (signal ? 1 : 0));});
