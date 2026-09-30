/* eslint-disable @typescript-eslint/no-explicit-any */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { draftProfile } from '../lib/agent-profile';
import { decryptRunnerSecret, generateRunnerKeyPair } from '../lib/runner-crypto';

let child: ChildProcess, stateDir: string, base: string, port: number, token: string;
let db: DatabaseSync, runner: any, run: any, command: any;
const capabilities = { container: true, direct: true, desktop: false, virtualDesktop: false };
let keys: Awaited<ReturnType<typeof generateRunnerKeyPair>>;
async function start() {
  child = spawn(process.execPath, ['--import', 'tsx', 'runtime/service.ts'], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, OPEN_HARNESS_MOCK: '1', OPEN_HARNESS_DISABLE_OS_VAULT: '1', OPEN_HARNESS_PORT: String(port), OPEN_HARNESS_STATE_DIR: stateDir }, stdio: 'pipe' });
  let diagnostics = ''; child.stderr?.on('data', data => { diagnostics += String(data); });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { const response = await fetch(`${base}/v1/bootstrap`); if (response.ok) { token = (await response.json() as any).token; return; } } catch { /* Wait for startup. */ }
    if (child.exitCode !== null) throw new Error(`Service exited: ${diagnostics}`);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Service did not start: ${diagnostics}`);
}
async function call(path: string, body?: unknown, headers?: Record<string, string>, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
}
async function request(path: string, body?: unknown, headers?: Record<string, string>) {
  const result = await call(path, body, headers); assert.ok(result.status < 400, `${result.status}: ${JSON.stringify(result.body)}`); return result.body;
}
async function emit(type: string, payload: unknown) {
  return request(`/v1/runner/commands/${command.id}/events`, { runId: run.id, eventId: crypto.randomUUID(), event: { type, payload } }, runner.headers);
}
async function commands(kind: string) { return (await request('/v1/runner/commands', undefined, runner.headers)).commands.filter((command: any) => command.kind === kind); }
async function complete(command: any, error?: string) { return request(`/v1/runner/commands/${command.id}/complete`, error ? { error } : { result: { ok: true } }, runner.headers); }

test.before(async () => {
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening'); port = (listener.address() as { port: number }).port; await new Promise<void>(resolve => listener.close(() => resolve()));
  base = `http://127.0.0.1:${port}`; stateDir = mkdtempSync(join(tmpdir(), 'open-harness-input-delivery-')); keys = await generateRunnerKeyPair(); await start();
  db = new DatabaseSync(join(stateDir, 'state.db'));
  const pairing = await request('/v1/machines', { name: 'Test runner', platform: 'linux', coordinatorUrl: base });
  runner = await request('/v1/runner/pair', { code: pairing.code, capabilities, encryptionPublicKey: keys.publicKey });
  runner.headers = { Authorization: `Bearer ${runner.token}`, 'x-open-harness-machine': runner.machineId };
  const agent = { id: 'delivery', name: 'Delivery', role: 'Tester', description: '', tone: 0, instructions: 'Test delivery.', memory: [] };
  const profile = draftProfile(agent); profile.computer.machineId = runner.machineId;
  await request('/v1/agents/sync', { agents: [{ ...agent, profile }] });
  run = await request('/v1/runs', { agentId: agent.id, prompt: 'Wait for test input' });
  command = (await commands('run'))[0]; assert.ok(command);
});
test.after(async () => { db?.close(); if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; } });

test('remote private input claims one reply, retries failure, and persists ciphertext only', async () => {
  await emit('secret.request', { request_id: 'secret-1', label: 'Enter token' });
  const pending = (await request(`/v1/runs/${run.id}`)).pendingInputs[0];
  const values = ['private-token', 'duplicate-token'];
  const answers = await Promise.all(values.map(value => call(`/v1/runs/${run.id}/input`, { inputId: pending.inputId, value })));
  assert.deepEqual(answers.map(answer => answer.status).sort(), [200, 409]);
  const replies = await commands('input'); assert.equal(replies.length, 1);
  assert.equal(replies[0].payload.inputId, pending.inputId);
  assert.equal(await decryptRunnerSecret(keys.privateKey, replies[0].payload.encrypted), values[answers.findIndex(answer => answer.status === 200)]);
  const persisted = JSON.stringify(db.prepare("SELECT payload_json FROM runner_commands WHERE kind='input'").all());
  for (const value of values) assert.ok(!persisted.includes(value));
  await complete(replies[0], 'Gateway rejected delivery');
  assert.equal((await request(`/v1/runs/${run.id}`)).pendingInputs[0].inputId, pending.inputId);
  await request(`/v1/runs/${run.id}/input`, { inputId: pending.inputId, value: 'retry-token' });
  await complete((await commands('input'))[0]);
  assert.equal((await request(`/v1/runs/${run.id}`)).pendingInputs.length, 0);
  await complete(replies[0], 'Duplicate old failure');
  assert.equal((await request(`/v1/runs/${run.id}`)).pendingInputs.length, 0);
});

test('remote approval failure restores the pending approval without duplicate delivery', async () => {
  await emit('approval.request', { request_id: 'approval-1', command: 'publish report' });
  const approval = (await request(`/v1/runs/${run.id}`)).pendingApprovals[0];
  const answers = await Promise.all([call(`/v1/runs/${run.id}/approval`, { approvalId: approval.approvalId, decision: 'approve' }), call(`/v1/runs/${run.id}/approval`, { approvalId: approval.approvalId, decision: 'deny' })]);
  assert.deepEqual(answers.map(answer => answer.status).sort(), [200, 409]);
  const replies = await commands('approval'); assert.equal(replies.length, 1);
  await complete(replies[0], 'Gateway rejected approval');
  assert.equal((await request(`/v1/runs/${run.id}`)).pendingApprovals[0].approvalId, approval.approvalId);
  await request(`/v1/runs/${run.id}/approval`, { approvalId: approval.approvalId, decision: 'deny' });
  await complete((await commands('approval'))[0]);
  assert.equal((await request(`/v1/runs/${run.id}`)).pendingApprovals.length, 0);
});

test('restart recovers response claims interrupted before or after command completion', async () => {
  await emit('clarify.request', { request_id: 'clarify-crash', question: 'Which option?' });
  const abandoned = (await request(`/v1/runs/${run.id}`)).pendingInputs[0];
  db.prepare("UPDATE run_inputs SET state='submitting' WHERE id=?").run(abandoned.inputId);
  await emit('secret.request', { request_id: 'secret-crash', label: 'Token' });
  const awaiting = (await request(`/v1/runs/${run.id}`)).pendingInputs[0];
  await request(`/v1/runs/${run.id}/input`, { inputId: awaiting.inputId, value: 'restart-secret' });
  const reply = (await commands('input'))[0];
  db.prepare("UPDATE runner_commands SET state='failed',result_json=? WHERE id=?").run(JSON.stringify({ error: 'Disconnected before ACK' }), reply.id);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; await start();
  const recovered = await request(`/v1/runs/${run.id}`);
  assert.equal(recovered.state, 'waiting_input');
  assert.deepEqual(recovered.pendingInputs.map((input: any) => input.inputId).sort(), [abandoned.inputId, awaiting.inputId].sort());
  await emit('clarify.expire', { request_id: 'clarify-crash' });
  await emit('secret.expire', { request_id: 'secret-crash' });
  assert.equal((await request(`/v1/runs/${run.id}`)).pendingInputs.length, 0);
});

test('board tools retain their run permissions when the saved profile changes', async () => {
  const board = (await request('/v1/tasks')).boards[0];
  const own = await request('/v1/tasks', { boardId: board.id, title: 'Own card', ownerAgentId: 'delivery' });
  const other = await request('/v1/tasks', { boardId: board.id, title: 'Other card', ownerAgentId: 'another-agent' });
  const headers = { Authorization: `Bearer ${command.payload.coordinationToken}`, 'x-open-harness-agent': 'delivery', 'x-open-harness-run': run.id };
  const profile = (await request('/v1/agents/delivery/profile')).profile;
  assert.equal((await call('/v1/agents/delivery/profile', { ...profile, board: { assignOthers: true, dispatch: true } }, undefined, 'PUT')).status, 200);
  assert.equal((await call('/internal/task', { action: 'get', taskId: other.id }, headers)).status, 403);
  assert.equal((await call('/internal/task', { action: 'update', taskId: own.id, input: { ownerAgentId: 'another-agent' } }, headers)).status, 403);
  assert.equal((await call('/internal/task', { action: 'create', boardId: board.id, input: { title: 'Assigned elsewhere', ownerAgentId: 'another-agent' } }, headers)).status, 403);
  const listed = await request('/internal/task', { action: 'list' }, headers);
  assert.ok(listed.tasks.some((task: any) => task.id === own.id));
  assert.ok(!listed.tasks.some((task: any) => task.id === other.id));
});
