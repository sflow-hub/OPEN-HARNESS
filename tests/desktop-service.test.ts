import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { initialWorkspace } from '../lib/types';

test('human desktop ownership and safe task continuation survive coordinator restart without duplicate work', { timeout: 60_000 }, async t => {
  const state = mkdtempSync(join(tmpdir(), 'harness-desktop-service-')), base = 'http://127.0.0.1:14583';
  const pair=await generateKeyPair('EdDSA'),issuer='https://desktop-viewer-fixture.example',publicKey=JSON.stringify(await exportJWK(pair.publicKey));
  let child: ChildProcess | undefined, token = '', output = '',defaultHeaders:Record<string,string>={};
  const pause = () => new Promise(resolve => setTimeout(resolve, 25));
  async function start(relay=false) {
    output = '';
    const instance = spawn(process.execPath, ['--import', 'tsx', 'runtime/service.ts'], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, OPEN_HARNESS_MOCK: '1', OPEN_HARNESS_DISABLE_OS_VAULT: '1', OPEN_HARNESS_PORT: '14583', OPEN_HARNESS_STATE_DIR: state, OPEN_HARNESS_RELAY_PUBLIC_JWK:publicKey, OPEN_HARNESS_RELAY_ISSUER:issuer,OPEN_HARNESS_REQUIRE_RELAY_IDENTITY:relay?'1':'0' }, stdio: ['ignore','pipe','pipe'] });
    child = instance; instance.stdout.on('data', data => { output += data; }); instance.stderr.on('data', data => { output += data; });
    for (const end = Date.now() + 20_000; Date.now() < end;) {
      if (instance.exitCode !== null) throw new Error(`Desktop fixture coordinator exited: ${output}`);
      try { const response = relay?await request('/v1/workspace'):await fetch(base + '/v1/bootstrap'); if (response.ok) { if(!relay)token = (await response.json()).token; return; } } catch {}
      await pause();
    }
    throw new Error(`Desktop fixture coordinator did not start: ${output}`);
  }
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const instance = child, stopped = new Promise<void>(resolve => instance.once('exit', () => resolve()));
    instance.kill('SIGTERM');
    const timeout = setTimeout(() => instance.kill('SIGKILL'), 10_000);
    try { await stopped; } finally { clearTimeout(timeout); }
  }
  t.after(async () => { await stop(); rmSync(state, { recursive: true, force: true }); });
  async function request(path: string, method = 'GET', data?: unknown, headers:Record<string,string>={}) {
    return fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',...defaultHeaders,...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  }
  async function api(path: string, method = 'GET', data?: unknown) {
    const response = await request(path, method, data); assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`); return response.json();
  }
  async function waitState(id: string, expected: string) {
    for (const end = Date.now() + 10_000; Date.now() < end;) { const run = await api(`/v1/runs/${id}`); if (run.state === expected) return run; await pause(); }
    throw new Error(`Task ${id} did not reach ${expected}: ${output}`);
  }
  function continuations() { const db = new DatabaseSync(join(state, 'state.db'), { readOnly: true }); try { return db.prepare('SELECT agent_id,run_id FROM desktop_continuations').all() as Array<{ agent_id: string; run_id: string }>; } finally { db.close(); } }

  await start();
  const agent = initialWorkspace.agents.find(item => item.id === 'atlas')!;
  await api('/v1/agents/sync', 'POST', { agents: [agent] });
  const { profile } = await api('/v1/agents/atlas/profile');
  await api('/v1/agents/atlas/profile', 'PUT', { ...profile, computer: { ...profile.computer, desktop: 'virtual' } });
  const originalPrompt = 'MOCK_APPROVAL Inspect the saved receipt before sending anything else.';
  const original = await api('/v1/runs', 'POST', { agentId: 'atlas', prompt: originalPrompt });
  await waitState(original.id, 'waiting_approval');
  const takeover = await api('/v1/agents/atlas/desktop/take-control', 'POST', { confirm: true });
  assert.equal(takeover.controlled, true); assert.equal(takeover.ready, true); assert.equal(takeover.canContinue, true);
  assert.ok(takeover.leaseId); await waitState(original.id, 'cancelled');
  assert.deepEqual(continuations().map(row => ({ ...row })), [{ agent_id: 'atlas', run_id: original.id }]);
  assert.equal((await api('/v1/runs')).runs.length, 1);


  await stop(); await start();
  const restored = await api('/v1/agents/atlas/desktop/status');
  assert.equal(restored.controlled, true); assert.equal(restored.ready, false); assert.equal(restored.canContinue, true); assert.equal(restored.leaseId, takeover.leaseId);
  assert.deepEqual(continuations().map(row => ({ ...row })), [{ agent_id: 'atlas', run_id: original.id }]);
  assert.equal((await request('/v1/agents/atlas/desktop/input', 'POST', { leaseId: restored.leaseId, input: { type: 'key', key: 'Enter' } })).status, 409);
  assert.equal((await api('/v1/runs')).runs.length, 1, 'Restart must not resume agent work while the human owns the desktop.');

  const releaseInput = { leaseId: restored.leaseId, continueWork: true };
  const released = await api('/v1/agents/atlas/desktop/release', 'POST', releaseInput);
  assert.equal(released.controlled, false);
  const runs = (await api('/v1/runs')).runs as Array<{ id: string; conversation_id: string; prompt: string; state: string }>;
  assert.equal(runs.length, 2);
  const continuation = runs.find(run => run.id !== original.id)!;
  assert.equal(continuation.conversation_id, original.conversation_id);
  assert.ok(continuation.prompt.includes(`Original request:\n${originalPrompt}`));
  assert.match(continuation.prompt,/Saved checkpoints/);
  assert.match(continuation.prompt, /Inspect the current application and saved results before acting/);
  assert.match(continuation.prompt, /do not repeat completed submissions/);
  assert.match(continuation.prompt, /Ask if the outcome of an earlier action is uncertain/);
  assert.deepEqual(continuations(), []);
  await waitState(continuation.id, 'waiting_approval');
  assert.equal((await api(`/v1/runs/${original.id}`)).state, 'cancelled');
  assert.equal((await request('/v1/agents/atlas/desktop/release', 'POST', releaseInput)).status, 409);
  assert.equal((await api('/v1/runs')).runs.length, 2, 'Retrying release must not create another continuation.');
  const status = await api('/v1/agents/atlas/desktop/status'); assert.equal(status.controlled, false); assert.equal(status.canContinue, false);
  await api(`/v1/runs/${continuation.id}/stop`, 'POST', {}); await waitState(continuation.id, 'cancelled');
  await stop(); await start();
  assert.equal((await api('/v1/runs')).runs.length, 2); assert.equal((await api('/v1/agents/atlas/desktop/status')).canContinue, false);
  const workspace=await api('/v1/workspace');await stop();
  const issue=(id:string,role:string)=>new SignJWT({workspaceId:workspace.id,role}).setSubject(id).setIssuer(issuer).setAudience(`open-harness:${workspace.id}`).setIssuedAt().setExpirationTime('60s').setProtectedHeader({alg:'EdDSA'}).sign(pair.privateKey);
  defaultHeaders={'x-open-harness-context':await issue('desktop-owner','owner')};const viewer={'x-open-harness-context':await issue('desktop-viewer','viewer')};await start(true);
  const sharedRun=await api('/v1/runs','POST',{agentId:'atlas',prompt:'MOCK_APPROVAL Hold for viewer metadata checks.'});await waitState(sharedRun.id,'waiting_approval');
  const activeViewerStatus=await request('/v1/agents/atlas/desktop/status','GET',undefined,viewer);assert.equal(activeViewerStatus.status,200);assert.equal((await activeViewerStatus.json()).agentActive,true);
  const sharedTakeover=await api('/v1/agents/atlas/desktop/take-control','POST',{confirm:true});
  const viewerResponse=await request('/v1/agents/atlas/desktop/status','GET',undefined,viewer);assert.equal(viewerResponse.status,200);const viewerStatus=await viewerResponse.json();
  assert.deepEqual(Object.keys(viewerStatus).sort(),['agentActive','available','browserSessionTeamId','canContinue','canRelease','controlled','controllerName','inControlSince','leaseId','machine','ownershipState','readOnly','ready','recording','revision','sharedWith','steps','teams','terminal','youControl']);assert.equal(viewerStatus.readOnly,true);assert.equal(viewerStatus.agentActive,false);assert.equal(viewerStatus.ownershipState,'human');assert.equal(viewerStatus.controllerName,'Workspace operator');assert.equal(viewerStatus.leaseId,'');assert.deepEqual(viewerStatus.terminal,{available:false,ready:false});for(const key of ['ownership','controllerId','draft'])assert.equal(key in viewerStatus,false);for(const key of ['youControl','canRelease','ready','canContinue','recording'])assert.equal((viewerStatus as Record<string,unknown>)[key],false);assert.equal(viewerStatus.revision,0);assert.deepEqual(viewerStatus.teams,[]);assert.deepEqual(viewerStatus.sharedWith,[]);
  for(const [method,path] of [['GET','/v1/agents/atlas/desktop/frame'],['POST','/v1/agents/atlas/desktop/stream'],['POST','/v1/agents/atlas/terminal'],['POST','/v1/agents/atlas/desktop/take-control'],['POST','/v1/agents/atlas/desktop/release'],['POST','/v1/agents/atlas/desktop/input']])assert.equal((await request(path,method,method==='GET'?undefined:{leaseId:sharedTakeover.leaseId},viewer)).status,403,path);
  const permissions=new DatabaseSync(join(state,'state.db'));try{permissions.prepare("UPDATE human_members SET revoked=1 WHERE actor_id='desktop-viewer'").run();}finally{permissions.close();}assert.equal((await request('/v1/agents/atlas/desktop/status','GET',undefined,viewer)).status,401,'Revoked viewers cannot read status.');
});
