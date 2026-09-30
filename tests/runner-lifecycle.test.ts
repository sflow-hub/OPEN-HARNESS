import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_COMPUTER, DEFAULT_MODEL } from '../lib/agent-profile';
import { encryptRunnerSecret, generateRunnerKeyPair } from '../lib/runner-crypto';
import { assertProcessStopped } from './helpers/process-state';
import { RUNTIME_CONTRACT } from '../runtime/readiness';

type Command = { id: string; agentId: string; kind: string; payload: Record<string, unknown> };
type Delivery = { result?: { final_response?: string; text?: string; ok?: boolean; status?: number; value?: { memory?: string; user?: string; skills?: string[]; content?: string } }; error?: string };
const pause = () => new Promise(resolve => setTimeout(resolve, 25));
async function until<T>(get: () => T | undefined, label: string) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) { const value = get(); if (value !== undefined) return value; await pause(); }
  throw new Error(`Timed out waiting for ${label}.`);
}

test('runner cleans gateways, protects active profiles, seeds history, and decrypts input without persisting it', { skip: process.platform === 'win32' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'open-harness-runner-lifecycle-'));
  const log = join(dir, 'gateway.jsonl'), executable = join(dir, 'docker');
  const completions = new Map<string, Delivery>(), events: Array<{ runId: string; event: { type: string } }> = [];
  const batches: Command[][] = [];
  let runnerOutput = '';
  let testedKey = false;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (req.url === '/models' || req.url === '/chat/completions') {
      testedKey = req.headers.authorization === 'Bearer candidate-provider-key';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.url === '/models' ? { data: [{ id: 'test-model' }] } : { choices: [{ message: { content: 'OK' } }] })); return;
    }
    const complete = req.url?.match(/\/commands\/([^/]+)\/complete$/);
    if (complete) completions.set(complete[1], body);
    if (req.url?.endsWith('/events')) events.push(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.method === 'GET' ? { commands: batches.shift() || [] } : { ok: true }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number }, encryption = await generateRunnerKeyPair();
  writeFileSync(join(dir, 'connection.json'), JSON.stringify({ coordinator: `http://127.0.0.1:${address.port}`, machineId: 'test-runner', token: 'test-token', encryptionPublicKey: encryption.publicKey, encryptionPrivateKey: encryption.privateKey }), { mode: 0o600 });
  writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'image') { console.log(args.includes('{{.Id}}') ? 'sha256:test' : '${RUNTIME_CONTRACT}'); process.exit(0); }
if (args[0] === 'version') { console.log('29.0'); process.exit(0); }
if (args[0] === 'inspect') { console.error('Error: No such object'); process.exit(1); }
if (args[0] === 'run') {
 if (args.includes('--rm')) { const mount = args[args.indexOf('-v')+1]; console.log(fs.readFileSync(mount.slice(0,-':/probe:ro'.length)+'/canary','utf8')); }
 process.exit(0);
}
if (args[0] === 'stop') {
 if (fs.existsSync(process.env.FAKE_GATEWAY_LOG)) for (const line of fs.readFileSync(process.env.FAKE_GATEWAY_LOG,'utf8').trim().split('\\n').filter(Boolean)) {
  const row=JSON.parse(line); if (row.type==='started') { try { process.kill(row.pid,'SIGTERM'); } catch {} }
 }
 process.exit(0);
}
if (args[0] !== 'exec') process.exit(0);
const log = value => fs.appendFileSync(process.env.FAKE_GATEWAY_LOG, JSON.stringify(value) + '\\n');
const send = value => console.log(JSON.stringify(value));
log({type:'started',pid:process.pid});
setTimeout(() => send({method:'event',params:{type:'gateway.ready'}}), 300);
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const {id, method, params} = JSON.parse(line);
 if (method === 'session.create') { log({type:'history',messages:params.messages}); send({id,result:{session_id:'test-session'}}); }
 else if (method === 'prompt.submit') {
   if (params.text === 'FAIL') send({id,error:{message:'Expected provider failure'}});
   else if (params.text === 'HOLD') { send({id,result:{status:'streaming'}}); send({method:'event',params:{type:'secret.request',session_id:'test-session',payload:{request_id:'secret-1'}}}); }
   else send({id,result:{final_response:'Completed fake task'}});
 } else if (method === 'secret.respond') {
   log({type:'input',accepted:params.value === process.env.EXPECTED_SECRET});
   send({id,result:{ok:true}});
   send({method:'event',params:{type:'message.complete',session_id:'test-session',payload:{status:'complete',text:'Accepted input'}}});
 } else send({id,result:{ok:true}});
});
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  const runner = spawn(process.execPath, ['--import', 'tsx', 'runtime/runner.ts'], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, OPEN_HARNESS_MOCK: '0', OPEN_HARNESS_DISABLE_OS_VAULT: '1', OPEN_HARNESS_RUNNER_STATE_DIR: dir, PATH: `${dir}:${process.env.PATH || ''}`, FAKE_GATEWAY_LOG: log, EXPECTED_SECRET: 'never-persist-this-password' }, stdio: ['ignore', 'pipe', 'pipe'] });
  runner.stdout.on('data', chunk => { runnerOutput += chunk; }); runner.stderr.on('data', chunk => { runnerOutput += chunk; });
  const records = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) as Array<{ type: string; pid?: number; messages?: unknown; accepted?: boolean }> : [];
  t.after(async () => {
    runner.kill('SIGTERM');
    if (runner.exitCode === null && runner.signalCode === null) await new Promise(resolve => runner.once('exit', resolve));
    for (const row of records()) if (row.pid) { try { process.kill(row.pid, 'SIGKILL'); } catch {} }
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  await until(() => runnerOutput.includes('connected to') ? true : undefined, `runner startup: ${runnerOutput}`);
  const profile = { id: 'atlas', name: 'Atlas', role: 'Assistant', description: '', tone: 0, revision: 1, prompt: { enabled: true, text: 'Help.' }, model: { ...DEFAULT_MODEL, inherit: true }, effectiveModel: DEFAULT_MODEL, allowedTools: [], connectors: [], board: { assignOthers: false, dispatch: false }, computer: { ...DEFAULT_COMPUTER } };
  const run = (id: string, prompt: string, extra: Record<string, unknown> = {}): Command => ({ id, agentId: 'atlas', kind: 'run', payload: { runId: id, prompt, snapshot: profile, encryptedSecrets: {}, coordinationToken: '', ...extra } });
  const completion = (id: string) => until(() => completions.get(id), `completion of ${id}; ${runnerOutput}`);

  const context = async (id: string, payload: Record<string, unknown>) => {
    batches.push([{ id, agentId: 'atlas', kind: 'agent-context', payload }]);
    return completion(id);
  };
  assert.equal((await context('memory-save', { operation: 'set-memory', memory: 'Runner memory survives runs.' })).result?.status, 200);
  assert.equal(readFileSync(join(dir, 'agents/atlas/profile/memories/MEMORY.md'), 'utf8'), 'Runner memory survives runs.');
  assert.equal((await context('skill-save', { operation: 'put-skill', name: 'reporter', content: '# Report skill' })).result?.status, 200);
  const savedContext = await context('context-read', { operation: 'get' });
  assert.equal(savedContext.result?.value?.memory, 'Runner memory survives runs.');
  assert.deepEqual(savedContext.result?.value?.skills, ['reporter']);
  assert.equal((await context('skill-read', { operation: 'get-skill', name: 'reporter' })).result?.value?.content, '# Report skill');
  assert.equal((await context('skill-delete', { operation: 'delete-skill', name: 'reporter' })).result?.status, 200);
  assert.equal((await context('skill-missing', { operation: 'get-skill', name: 'reporter' })).result?.status, 404);
  assert.equal(records().length, 0, 'Context operations do not start or recompile an agent runtime.');

  const legacy = { ...profile, computer: { ...profile.computer, access: 'direct', desktop: 'existing' } };
  for (const kind of ['run', 'probe-runtime', 'probe-tools', 'probe-models', 'import-agent']) {
    const id = `blocked-${kind}`;
    batches.push([{ id, agentId: 'atlas', kind, payload: kind === 'run' ? { runId: id, prompt: 'MUST NOT RUN', snapshot: legacy } : { profile: legacy, input: { action: 'catalog' } } }]);
    assert.match((await completion(id)).error || '', /not sandboxed and is disabled/);
  }
  assert.equal(records().length, 0, 'Unsafe payloads never start a runtime or probe.');

  const history = [{ role: 'user', content: 'The project color is blue.' }, { role: 'assistant', content: 'Remembered.' }];
  const selectedKey = 'selected-encrypted-runtime-key';
  const withCredential = { ...profile, effectiveModel: { ...DEFAULT_MODEL, credentialRef: 'TEST_KEY' } };
  batches.push([run('success', 'SUCCESS', { history, snapshot: withCredential, encryptedSecrets: { TEST_KEY: await encryptRunnerSecret(encryption.publicKey, selectedKey) } })]);
  const completed = await completion('success');
  assert.equal(completed.error, undefined);
  assert.equal(completed.result?.final_response, 'Completed fake task');
  assert.deepEqual(records().find(row => row.type === 'history')?.messages, history);
  assert.ok(readFileSync(join(dir, 'agents/atlas/profile/.env'), 'utf8').includes(selectedKey));
  assert.ok(!readFileSync(join(dir, 'secrets.json'), 'utf8').includes(selectedKey));
  assert.ok(events.some(item => item.runId === 'success' && item.event.type === 'session.started'));
  assert.ok(!JSON.stringify([...completions.values(), ...events]).includes(selectedKey));
  assertProcessStopped(records().find(row => row.type === 'started')!.pid!);

  batches.push([run('failure', 'FAIL')]);
  assert.match((await completion('failure')).error || '', /Expected provider failure/);
  const failedPid = records().filter(row => row.type === 'started').at(-1)!.pid!;
  assertProcessStopped(failedPid);

  const probe: Command = { id: 'probe-during-start', agentId: 'atlas', kind: 'probe-models', payload: { profile: { ...profile, revision: 99 } } };
  batches.push([run('holding', 'HOLD'), probe]);
  assert.match((await completion(probe.id)).error || '', /busy/);
  await until(() => events.some(item => item.runId === 'holding' && item.event.type === 'secret.request') ? true : undefined, 'live input request');
  assert.match((await context('memory-while-running', { operation: 'set-memory', memory: 'Must not replace active memory.' })).error || '', /busy/);
  assert.equal(readFileSync(join(dir, 'agents/atlas/profile/memories/MEMORY.md'), 'utf8'), 'Runner memory survives runs.');
  assert.equal(JSON.parse(readFileSync(join(dir, 'agents/atlas/managed/policy.json'), 'utf8')).runId, 'holding');
  const heldPid = records().filter(row => row.type === 'started').at(-1)!.pid!;
  process.kill(heldPid, 0);
  batches.push([{ id: 'answer', agentId: 'atlas', kind: 'input', payload: { runId: 'holding', type: 'secret', requestId: 'secret-1', encrypted: await encryptRunnerSecret(encryption.publicKey, 'never-persist-this-password') } }]);
  assert.equal((await completion('answer')).result?.ok, true);
  assert.equal((await completion('holding')).result?.text, 'Accepted input');
  assert.equal(records().find(row => row.type === 'input')?.accepted, true);
  assertProcessStopped(heldPid);
  for (const name of readdirSync(join(dir, 'spool'))) assert.ok(!readFileSync(join(dir, 'spool', name), 'utf8').includes('never-persist-this-password'));
  assert.ok(!JSON.stringify([...completions.values(), ...events]).includes('never-persist-this-password'));

  batches.push([{ id: 'model-test', agentId: 'atlas', kind: 'probe-runtime', payload: {
    profile, input: { action: 'model-test', model: { ...DEFAULT_MODEL, provider: 'custom', model: 'test-model', baseUrl: `http://127.0.0.1:${address.port}` } },
    encryptedApiKey: await encryptRunnerSecret(encryption.publicKey, 'candidate-provider-key'),
  } }]);
  assert.equal((await completion('model-test')).result?.ok, true);
  assert.equal(testedKey, true);
  assert.equal(JSON.parse(readFileSync(join(dir, 'agents/atlas/managed/policy.json'), 'utf8')).runId, 'holding');
  assert.ok(!readFileSync(join(dir, 'agents/atlas/profile/.env'), 'utf8').includes('candidate-provider-key'));
  assert.ok(!JSON.stringify([...completions.values(), ...events]).includes('candidate-provider-key'));

  const processesBeforeQueuedStop = records().filter(row => row.type === 'started').length;
  batches.push([
    { id: 'probe-before-run', agentId: 'atlas', kind: 'probe-runtime', payload: { profile, input: { action: 'model-test', model: { ...DEFAULT_MODEL, provider: 'custom', model: 'test-model', baseUrl: `http://127.0.0.1:${address.port}` } } } },
    run('stop-queued', 'HOLD'),
    { id: 'stop-queued-command', agentId: 'atlas', kind: 'stop', payload: { runId: 'stop-queued' } },
  ]);
  assert.equal((await completion('stop-queued-command')).result?.ok, true);
  assert.match((await completion('stop-queued')).error || '', /stopped before/);
  assert.equal(records().filter(row => row.type === 'started').length, processesBeforeQueuedStop);

  batches.push([run('stop-starting', 'HOLD'), { id: 'stop', agentId: 'atlas', kind: 'stop', payload: { runId: 'stop-starting' } }]);
  assert.equal((await completion('stop')).result?.ok, true);
  assert.match((await completion('stop-starting')).error || '', /stopped|exited/);
});
