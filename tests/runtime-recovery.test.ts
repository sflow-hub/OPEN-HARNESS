/* eslint-disable @typescript-eslint/no-explicit-any */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { generateRunnerKeyPair, decryptRunnerSecret } from '../lib/runner-crypto';
import { processIdentity } from '../runtime/process-identity';
import { assertProcessStopped } from './helpers/process-state';

const pause = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T>, accepts: (value: T) => boolean, label: string) {
  for (let i = 0; i < 250; i++) { const result = await read(); if (accepts(result)) return result; await pause(); }
  throw new Error(`Timed out: ${label}`);
}
async function fixture(mock = true, extraEnv: Record<string, string> = {}) {
  const socket = createServer(); await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port; await new Promise<void>(resolve => socket.close(() => resolve()));
  const state = mkdtempSync(join(tmpdir(), 'harness-recovery-')), base = `http://127.0.0.1:${port}`;
  let child: ChildProcess, token = '', output = '';
  async function start() {
    child = spawn(process.execPath, ['--import', 'tsx', 'runtime/service.ts'], { cwd: join(import.meta.dirname, '..'), env: { NODE_ENV: 'test', PATH: process.env.PATH, HOME: state, TMPDIR: process.env.TMPDIR, SYSTEMROOT: process.env.SYSTEMROOT, OPEN_HARNESS_DISABLE_OS_VAULT: '1', OPEN_HARNESS_MOCK: mock ? '1' : '0', OPEN_HARNESS_PORT: String(port), OPEN_HARNESS_STATE_DIR: state, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.on('data', chunk => output += chunk); child.stderr!.on('data', chunk => output += chunk);
    for (let i = 0; i < 200; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try { const r = await fetch(`${base}/v1/bootstrap`); if (r.ok) { token = (await r.json() as any).token; return; } } catch {}
      await pause(50);
    }
    throw new Error(`Coordinator did not start: ${output}`);
  }
  async function stop(signal: NodeJS.Signals = 'SIGTERM') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill(signal); await exited;
  }
  async function request(path: string, method = 'GET', data?: unknown, extra?: Record<string, string>) {
    const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
    const value = await r.json() as any; if (!r.ok) throw Object.assign(new Error(JSON.stringify(value)), { status: r.status }); return value;
  }
  async function run(agentId: string, prompt: string, conversationId = crypto.randomUUID()) { return request('/v1/runs', 'POST', { agentId, prompt, conversationId }); }
  async function waitRun(id: string, states = ['completed', 'failed', 'cancelled', 'interrupted']) { return until(() => request(`/v1/runs/${id}`), value => states.includes(value.state), `run ${id}: ${states}`); }
  await start();
  await request('/v1/agents/sync', 'POST', { agents: ['atlas', 'scout', 'remote'].map(id => ({ id, name: id, role: 'Assistant', description: '', tone: 0, instructions: 'Help.', memory: [] })) });
  return { base, state, request, start, stop, run, waitRun };
}

test('durable conversations seed follow-ups, pending prompts survive replay, and queues resume on restart', async () => {
  const f = await fixture();
  try {
    const first = await f.run('atlas', 'Remember the project is Bluebird.', 'same-chat');
    assert.equal((await f.waitRun(first.id)).state, 'completed');
    const second = await f.run('atlas', 'MOCK_HISTORY', 'same-chat');
    const history = JSON.parse((await f.waitRun(second.id)).result);
    assert.deepEqual(history, [{ role: 'user', content: 'Remember the project is Bluebird.' }, { role: 'assistant', content: 'Hermes mock completed the task.' }]);
    const other = await f.run('scout', 'MOCK_HISTORY', 'same-chat');
    assert.deepEqual(JSON.parse((await f.waitRun(other.id)).result), []);
    const approval = await f.run('atlas', 'MOCK_APPROVAL');
    const waiting = await f.waitRun(approval.id, ['waiting_approval']);
    const consumed = await f.request(`/v1/runs/${approval.id}/events`);
    const after = consumed.events.at(-1).seq;
    const reloaded = await f.request(`/v1/runs/${approval.id}/events?after=${after}`);
    assert.equal(reloaded.events.length, 0); assert.equal(reloaded.run.pendingApprovals.length, 1);
    await f.request(`/v1/runs/${approval.id}/approval`, 'POST', { approvalId: waiting.pendingApprovals[0].approvalId, decision: 'approve' });
    assert.equal((await f.waitRun(approval.id)).pendingApprovals.length, 0);
    const clarify = await f.run('atlas', 'MOCK_CLARIFY');
    const needsInput = await f.waitRun(clarify.id, ['waiting_input']);
    assert.equal(needsInput.pendingInputs[0].type, 'clarify');
    await f.request(`/v1/runs/${clarify.id}/input`, 'POST', { inputId: needsInput.pendingInputs[0].inputId, value: 'Use Bluebird' });
    assert.match((await f.waitRun(clarify.id)).result, /Use Bluebird/);
    await assert.rejects(f.request(`/v1/runs/${clarify.id}/input`, 'POST', { inputId: needsInput.pendingInputs[0].inputId, value: 'again' }), { status: 409 });
    const active = await f.run('atlas', 'MOCK_APPROVAL'); await f.waitRun(active.id, ['waiting_approval']);
    const queued = await f.run('atlas', 'resume this queued work');
    assert.equal(queued.state, 'queued');
    await f.stop('SIGKILL'); await f.start();
    assert.equal((await f.request(`/v1/runs/${active.id}`)).state, 'interrupted');
    assert.equal((await f.waitRun(queued.id)).state, 'completed');
    const conversations = await f.request('/v1/conversations?agentId=atlas');
    const restored = conversations.conversations.find((row: any) => row.id === 'same-chat');
    assert.equal(restored.runs.length, 2); assert.ok(conversations.conversations.every((row: any) => row.agentId === 'atlas'));
    const one = await f.run('atlas', 'MOCK_APPROVAL'), two = await f.run('scout', 'MOCK_APPROVAL');
    await f.waitRun(one.id, ['waiting_approval']); await f.waitRun(two.id, ['waiting_approval']);
    assert.equal((await f.request('/v1/runs/stop-all', 'POST', {})).stopped, 2);
    assert.equal((await f.waitRun(one.id)).state, 'cancelled'); assert.equal((await f.waitRun(two.id)).state, 'cancelled');
  } finally { await f.stop(); }
});

test('remote ownership survives coordinator restart, encrypted input and late events cannot corrupt completion', async () => {
  const f = await fixture(), keys = await generateRunnerKeyPair();
  try {
    const pairing = await f.request('/v1/machines', 'POST', { name: 'Remote computer', platform: 'linux' });
    const paired = await f.request('/v1/runner/pair', 'POST', { code: pairing.code, name: 'Remote', platform: 'linux', arch: 'x64', capabilities: { container: true, direct: true, desktop: false, virtualDesktop: true }, encryptionPublicKey: keys.publicKey });
    const headers = { Authorization: `Bearer ${paired.token}`, 'X-Open-Harness-Machine': paired.machineId };
    const runner = (path: string, method = 'GET', data?: unknown) => f.request(path, method, data, headers);
    const profile = (await f.request('/v1/agents/remote/profile')).profile;
    await f.request('/v1/agents/remote/profile', 'PUT', { ...profile, computer: { ...profile.computer, machineId: paired.machineId } });
    const importing = await until(() => runner('/v1/runner/commands'), value => value.commands.some((c: any) => c.kind === 'import-agent'), 'transfer');
    for (const command of importing.commands) await runner(`/v1/runner/commands/${command.id}/complete`, 'POST', { result: { checksum: command.payload.bundle.checksum, validated: true } });
    await until(() => f.request('/v1/agents/remote/profile'), value => value.profile.computer.machineId === paired.machineId, 'assigned');
    const first = await f.run('remote', 'Run remotely', 'remote-chat');
    const commands = await until(() => runner('/v1/runner/commands'), value => value.commands.some((c: any) => c.kind === 'run'), 'dispatch');
    const command = commands.commands.find((c: any) => c.kind === 'run');
    const emit = (type: string, payload: unknown) => runner(`/v1/runner/commands/${command.id}/events`, 'POST', { eventId: crypto.randomUUID(), runId: first.id, event: { type, payload } });
    await emit('approval.request', { request_id: 'remote-approval', command: 'Write result' });
    const queued = await f.run('remote', 'Continue remotely', 'remote-chat');
    await f.stop('SIGKILL'); await f.start();
    const resumed = await f.request(`/v1/runs/${first.id}`);
    assert.equal(resumed.state, 'waiting_approval'); assert.equal((await f.request(`/v1/runs/${queued.id}`)).state, 'queued');
    assert.equal((await runner('/v1/runner/commands')).commands.length, 0);
    await f.request(`/v1/runs/${first.id}/approval`, 'POST', { approvalId: resumed.pendingApprovals[0].approvalId, decision: 'approve' });
    assert.equal((await runner('/v1/runner/commands')).commands[0].kind, 'approval');
    await emit('secret.request', { request_id: 'secret-one', name: 'Test private value' });
    const pending = await f.waitRun(first.id, ['waiting_input']);
    await f.request(`/v1/runs/${first.id}/input`, 'POST', { inputId: pending.pendingInputs[0].inputId, value: 'private-response-never-stored' });
    const secret = (await runner('/v1/runner/commands')).commands.find((c: any) => c.kind === 'input');
    assert.equal(await decryptRunnerSecret(keys.privateKey, secret.payload.encrypted), 'private-response-never-stored');
    assert.equal(secret.payload.value, undefined);
    const db = new DatabaseSync(join(f.state, 'state.db'));
    try { assert.doesNotMatch(JSON.stringify(db.prepare('SELECT payload_json FROM runner_commands').all()), /private-response-never-stored/); } finally { db.close(); }
    await runner(`/v1/runner/commands/${command.id}/complete`, 'POST', { result: { final_response: 'Remote result' } });
    assert.equal((await f.waitRun(first.id)).state, 'completed');
    await emit('approval.request', { request_id: 'late-request', command: 'Late' });
    assert.equal((await f.request(`/v1/runs/${first.id}`)).state, 'completed');
    const followup = await until(() => runner('/v1/runner/commands'), value => value.commands.some((c: any) => c.kind === 'run'), 'followup');
    assert.deepEqual(followup.commands.find((c: any) => c.kind === 'run').payload.history, [{ role: 'user', content: 'Run remotely' }, { role: 'assistant', content: 'Remote result' }]);
  } finally { await f.stop(); }
});

test('failed model validation keeps working credentials and successful save uses a separate reference', async () => {
  const provider = createServer(async (req, res) => {
    req.resume(); await new Promise<void>(resolve => req.on('end', resolve));
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== 'Bearer valid-draft') { res.statusCode = 401; res.end(JSON.stringify({ error: { message: 'Rejected draft key' } })); return; }
    res.end(JSON.stringify(req.url === '/v1/models' ? { data: [{ id: 'test-model' }] } : { choices: [{ message: { role: 'assistant', content: 'OK' } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert.ok(address && typeof address !== 'string');
  const f = await fixture(false);
  try {
    await f.request('/v1/secrets', 'POST', { name: 'EXISTING_KEY', value: 'old-working-key' });
    const model = { provider: 'custom', model: 'test-model', baseUrl: `http://127.0.0.1:${address.port}/v1`, credentialRef: 'EXISTING_KEY' };
    await f.request('/v1/workspace/model', 'PUT', { model, revision: 0 });
    const failed = await f.request('/v1/onboarding/model-test', 'POST', { model, apiKey: 'bad-draft', save: true, revision: 1 });
    assert.equal(failed.ok, false); assert.equal((await f.request('/v1/workspace/model')).revision, 1);
    assert.equal(JSON.parse(readFileSync(join(f.state, 'secrets.json'), 'utf8')).EXISTING_KEY, 'old-working-key');
    const saved = await f.request('/v1/onboarding/model-test', 'POST', { model, apiKey: 'valid-draft', save: true, revision: 1 });
    assert.equal(saved.ok, true); assert.equal(saved.revision, 2); assert.match(saved.model.credentialRef, /^MODEL_/);
    const vault = JSON.parse(readFileSync(join(f.state, 'secrets.json'), 'utf8'));
    assert.equal(vault.EXISTING_KEY, 'old-working-key'); assert.equal(vault[saved.model.credentialRef], 'valid-draft');
    assert.equal(JSON.stringify(await f.request('/v1/workspace/model')).includes('valid-draft'), false);
    const savedCredentials = await f.request('/v1/credentials');
    assert.equal(savedCredentials.credentials.find((credential: any) => credential.ref === saved.model.credentialRef)?.present, true);
    assert.equal(JSON.stringify(savedCredentials).includes('valid-draft'), false);
    await assert.rejects(f.request('/v1/onboarding/model-test', 'POST', { model, apiKey: 'valid-draft', save: true, revision: 1 }), { status: 409 });
  } finally { await f.stop(); await new Promise<void>(resolve => provider.close(() => resolve())); }
});


test('upgrade cleans a saved legacy native process and refuses to replay its profile', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture(false);
  const child = spawn(process.execPath, ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise<void>((resolve, reject) => { child.once('error', reject); child.stdout.once('data', () => resolve()); });
  try {
    const current = (await f.request('/v1/agents/atlas/profile')).profile;
    await f.stop();
    const db = new DatabaseSync(join(f.state, 'state.db'));
    const legacy = { ...current, computer: { ...current.computer, access: 'direct', desktop: 'existing' } };
    db.prepare('UPDATE agent_profiles SET json=? WHERE id=?').run(JSON.stringify(legacy), 'atlas');
    db.prepare('INSERT INTO runtime_processes(agent_id,pid,identity) VALUES(?,?,?)').run('atlas', child.pid!, processIdentity(child.pid!)!);
    db.close();
    await f.start();
    assertProcessStopped(child.pid!);
    assert.equal((await f.request('/v1/agents/atlas/profile')).profile.computer.access, 'direct', 'The saved draft remains readable for explicit conversion.');
    await assert.rejects(f.run('atlas', 'must not start'), /not sandboxed and is disabled/);
    await assert.rejects(f.request('/v1/agents/atlas/tools'), /not sandboxed and is disabled/);
    const repaired = await f.request('/v1/agents/atlas/profile', 'PUT', { ...legacy, computer: { ...current.computer, desktop: 'virtual' } });
    assert.equal(repaired.profile.computer.access, 'private');
    assert.equal(repaired.profile.computer.desktop, 'virtual');
  } finally { await f.stop(); try { child.kill('SIGKILL'); } catch {} }
});

test('a second coordinator cannot recover or interrupt work owned by the first', async () => {
  const f = await fixture();
  try {
    const run = await f.run('atlas', 'MOCK_APPROVAL');
    const waiting = await f.waitRun(run.id, ['waiting_approval']);
    for (const port of [new URL(f.base).port, '0']) {
      const child = spawn(process.execPath, ['--import', 'tsx', 'runtime/service.ts'], {
        cwd: join(import.meta.dirname, '..'),
        env: { NODE_ENV: 'test', PATH: process.env.PATH, HOME: f.state, TMPDIR: process.env.TMPDIR, SYSTEMROOT: process.env.SYSTEMROOT,
          OPEN_HARNESS_DISABLE_OS_VAULT: '1', OPEN_HARNESS_MOCK: '1', OPEN_HARNESS_PORT: port, OPEN_HARNESS_STATE_DIR: f.state },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout!.on('data', chunk => output += chunk); child.stderr!.on('data', chunk => output += chunk);
      const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
      try {
        const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
        const unchanged = await f.request(`/v1/runs/${run.id}`);
        assert.equal(unchanged.state, 'waiting_approval');
        assert.equal(unchanged.pendingApprovals[0].approvalId, waiting.pendingApprovals[0].approvalId);
        assert.equal(code, 1, output);
        assert.match(output, /Another coordinator already owns this state directory/);
      } finally { clearTimeout(deadline); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
    }
    await f.request(`/v1/runs/${run.id}/approval`, 'POST', { approvalId: waiting.pendingApprovals[0].approvalId, decision: 'approve' });
    assert.equal((await f.waitRun(run.id)).state, 'completed');
  } finally { await f.stop(); }
});
