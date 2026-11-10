import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initialWorkspace } from '../lib/types';

test('authenticated event long polls wake, replay, abort without stopping work and expose measured outcomes', { timeout: 45_000 }, async t => {
  const state = mkdtempSync(join(tmpdir(), 'harness-delivery-service-')), base = 'http://127.0.0.1:14574';
  const child = spawn(process.execPath, ['--import', 'tsx', 'runtime/service.ts'], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, OPEN_HARNESS_MOCK: '1', OPEN_HARNESS_DISABLE_OS_VAULT: '1', OPEN_HARNESS_PORT: '14574', OPEN_HARNESS_STATE_DIR: state }, stdio: ['ignore','pipe','pipe'] });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await stopped; } rmSync(state, { recursive: true, force: true }); });
  const pause = () => new Promise(resolve => setTimeout(resolve, 25)); let token = '';
  for (const end = Date.now() + 25_000; Date.now() < end;) {
    if (child.exitCode !== null) throw new Error(`Fixture coordinator exited: ${output}`);
    try { const response = await fetch(base + '/v1/bootstrap'); if (response.ok) { token = (await response.json()).token; break; } } catch {}
    await pause();
  }
  assert.ok(token, output);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  async function api(path: string, data?: unknown) { const response = await fetch(base + path, { headers, ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) }) }); assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`); return response.json(); }
  await api('/v1/agents/sync', { agents: initialWorkspace.agents });
  const run = await api('/v1/runs', { agentId: 'atlas', prompt: 'MOCK_APPROVAL Wait for the operator before completing.' });
  let snapshot;
  for (const end = Date.now() + 10_000; Date.now() < end;) { snapshot = await api(`/v1/runs/${run.id}/events?after=0`); if (snapshot.run.state === 'waiting_approval') break; await pause(); }
  assert.equal(snapshot.run.state, 'waiting_approval');
  const events = snapshot.events as Array<{ seq: number; type: string; payload: { approvalId?: string } }>;
  const cursor = events.at(-1)!.seq, path = `/v1/runs/${run.id}/events?after=${cursor}&wait=25000`;
  assert.equal((await fetch(base + path)).status, 401);
  assert.equal((await fetch(base + `/v1/runs/${run.id}/events?after=-1`, { headers })).status, 400);
  let settled = false;
  const waiting = fetch(base + path, { headers }).then(response => { settled = true; return response.json(); });
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(settled, false, 'The coordinator should hold an empty event cursor.');
  await api(`/v1/runs/${run.id}/steer`, { text: 'Keep the existing approval pending.' });
  const update = await waiting; assert.ok(update.events.some((item: { type: string }) => item.type === 'run.steered'));
  const replay = await api(`/v1/runs/${run.id}/events?after=${cursor}&wait=0`);
  assert.deepEqual(replay.events.map((item: { seq: number }) => item.seq), update.events.map((item: { seq: number }) => item.seq));
  const controller = new AbortController();
  const aborted = fetch(base + `/v1/runs/${run.id}/events?after=${update.events.at(-1).seq}&wait=25000`, { headers, signal: controller.signal });
  const rejected = assert.rejects(aborted, { name: 'AbortError' }); await new Promise(resolve => setTimeout(resolve, 100)); controller.abort(); await rejected;
  assert.equal((await api(`/v1/runs/${run.id}`)).state, 'waiting_approval', 'Disconnecting a client must not cancel work.');
  const approval = events.find(item => item.type === 'approval.request')!;
  await api(`/v1/runs/${run.id}/approval`, { approvalId: approval.payload.approvalId, decision: 'approve' });
  for (const end = Date.now() + 10_000; Date.now() < end;) { if ((await api(`/v1/runs/${run.id}`)).state === 'completed') break; await pause(); }
  const metrics = await api(`/v1/runs/${run.id}/metrics`);
  assert.equal(metrics.state, 'completed'); assert.equal(metrics.approvals, 1);
  for (const key of ['queueMs','startupMs','firstOutputMs','cleanupMs','totalMs']) assert.ok(typeof metrics[key] === 'number' && metrics[key] >= 0, key);
  assert.equal((await fetch(base + '/v1/metrics')).status, 401);
  assert.equal((await api('/v1/metrics')).outcomes.reviewed, 0);
  await api(`/v1/runs/${run.id}/outcome`, { accepted: true, evidence: 'Checked the scripted fixture result; this is transport acceptance, not paid-model reliability.' });
  const summary = await api('/v1/metrics'); assert.equal(summary.outcomes.reviewed, 1); assert.equal(summary.outcomes.accepted, 1);
  const pairing = await api('/v1/machines', { name: 'Revoked poll fixture', platform: 'linux', coordinatorUrl: base });
  const pairedResponse = await fetch(base + '/v1/runner/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: pairing.code }) });
  assert.equal(pairedResponse.status, 201);
  const paired = await pairedResponse.json(), runnerHeaders = { Authorization: `Bearer ${paired.token}`, 'X-Open-Harness-Machine': paired.machineId };
  let runnerSettled = false;
  const heldRunner = fetch(base + '/v1/runner/commands?wait=25000', { headers: runnerHeaders, signal: AbortSignal.timeout(5000) }).then(response => { runnerSettled = true; return response; });
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(runnerSettled, false);
  await api(`/v1/machines/${paired.machineId}/revoke`, {});
  const db = new DatabaseSync(join(state, 'state.db'));
  try {
    db.prepare('INSERT INTO runner_commands(id,machine_id,agent_id,kind,payload_json,state,created_at) VALUES(?,?,?,?,?,?,?)').run('after-revocation', paired.machineId, 'atlas', 'input', JSON.stringify({ value: 'must remain queued' }), 'queued', new Date().toISOString());
    const denied = await heldRunner; assert.equal(denied.status, 401, await denied.clone().text());
    assert.equal((db.prepare('SELECT state FROM runner_commands WHERE id=?').get('after-revocation') as { state: string }).state, 'queued', 'Revocation must be rechecked before leasing commands during a held poll.');
  } finally { db.close(); }
});
