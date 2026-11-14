import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { coordinationToken } from '../runtime/coordination-auth';
import { sealAgentTransfer } from '../runtime/transfer-crypto';
import { generateRunnerKeyPair } from '../lib/runner-crypto';
import type { ProfileResponse } from '../lib/agent-profile';
import type { PersistentRun } from '../lib/control-client';

test('coordination authority requires a live run on its computer and cannot survive a transfer or runner revocation', async t => {
  const state = mkdtempSync(join(tmpdir(), 'harness-coordination-auth-'));
  const reservation = createServer(); await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const address = reservation.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const base = `http://127.0.0.1:${address.port}`, agentId = 'capability-test';
  const child = spawn(process.execPath, ['--import', 'tsx', 'runtime/service.ts'], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, OPEN_HARNESS_MOCK: '1', OPEN_HARNESS_DISABLE_OS_VAULT: '1', OPEN_HARNESS_PORT: String(address.port), OPEN_HARNESS_STATE_DIR: state }, stdio: ['ignore', 'ignore', 'pipe'] });
  let token = '', errors = '';
  child.stderr.on('data', part => { errors = (errors + part).slice(-2000); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve => child.once('exit', () => resolve())), timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.kill('SIGTERM'); await closed; clearTimeout(timeout);
    }
    rmSync(state, { recursive: true, force: true });
  });
  const pause = () => new Promise(resolve => setTimeout(resolve, 40));
  async function poll<T>(check: () => Promise<T | false>): Promise<T> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) { const found = await check(); if (found !== false) return found; await pause(); }
    throw new Error(`Coordinator did not progress: ${errors}`);
  }
  async function raw(path: string, input?: unknown, headers: Record<string, string> = {}, method = input === undefined ? 'GET' : 'POST') {
    return fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  }
  async function request<T>(path: string, input?: unknown, headers?: Record<string, string>, method?: string): Promise<T> {
    const response = await raw(path, input, headers, method); assert.ok(response.ok, `${path}: ${response.status}`); return response.json() as Promise<T>;
  }
  type Command = { id: string; kind: string; payload: { runId: string; coordinationToken: string; transferId: string; sourceMachineId: string; destinationMachineId: string; transferPublicKey: string; sealedTransfer?: { checksum: string } } };
  const currentProfile = async () => (await request<ProfileResponse>(`/v1/agents/${agentId}/profile`)).profile;
  const waitRun = (id: string, state: string) => poll(async () => { const run = await request<PersistentRun>(`/v1/runs/${id}`); return run.state === state ? run : false; });
  await poll(async () => { try { const response = await raw('/v1/bootstrap'); if (!response.ok) return false; token = (await response.json()).token; return true; } catch { return false; } });
  await request('/v1/agents/sync', { agents: [{ id: agentId, name: 'Capability test', role: 'Assistant', instructions: 'Test run capabilities.', memory: [] }] });
  const profile = await currentProfile();
  await request(`/v1/agents/${agentId}/profile`, { ...profile, terminalConsent: true, allowedTools: ['terminal', 'mcp__open_harness__runs'], model: { inherit: false, provider: 'mock', model: 'mock', credentialRef: '', baseUrl: '' } }, undefined, 'PUT');
  async function pair() {
    const { code } = await request<{ code: string }>('/v1/machines', { name: 'Capability runner', platform: 'linux' }), encryption = await generateRunnerKeyPair();
    const paired = await request<{ machineId: string; token: string }>('/v1/runner/pair', { code, encryptionPublicKey: encryption.publicKey, capabilities: { container: true, virtualDesktop: true, features: ['workspace-tools', 'scoped-tool-review', 'run-leases', 'browser-state-transfer', 'sealed-agent-transfer'] } });
    return { id: paired.machineId, headers: { Authorization: `Bearer ${paired.token}`, 'X-Open-Harness-Machine': paired.machineId } };
  }
  const emptyBundle = { files: [], checksum: createHash('sha256').update('').digest('hex') };
  async function transfer(destination: string, runner: Awaited<ReturnType<typeof pair>>) {
    await request(`/v1/agents/${agentId}/transfer`, { destinationMachineId: destination });
    await poll(async () => {
      const { commands } = await request<{ commands: Command[] }>('/v1/runner/commands', undefined, runner.headers);
      for (const { id, kind, payload } of commands) {
        if (kind === 'import-agent') await request(`/v1/runner/commands/${id}/complete`, { result: { checksum: payload.sealedTransfer?.checksum, validated: true } }, runner.headers);
        if (kind === 'export-agent') await request(`/v1/runner/commands/${id}/complete`, { result: await sealAgentTransfer(emptyBundle, { transferId: payload.transferId, agentId, sourceMachineId: payload.sourceMachineId, destinationMachineId: payload.destinationMachineId }, payload.transferPublicKey) }, runner.headers);
      }
      return (await currentProfile()).computer.machineId === destination ? true : false;
    });
  }
  const remoteRun = async (runner: Awaited<ReturnType<typeof pair>>) => {
    const run = await request<PersistentRun>('/v1/runs', { agentId, prompt: 'Remote capability test' });
    const command = await poll(async () => (await request<{ commands: Command[] }>('/v1/runner/commands', undefined, runner.headers)).commands.find(command => command.kind === 'run' && command.payload.runId === run.id) || false);
    return { run, command, headers: { Authorization: `Bearer ${command.payload.coordinationToken}`, 'X-Open-Harness-Agent': agentId, 'X-Open-Harness-Run': run.id } };
  };
  const runner = await pair(); await transfer(runner.id, runner);
  const original = await remoteRun(runner);
  assert.equal((await raw('/internal/task', { action: 'list' }, original.headers)).status, 200);
  const withoutRun = { Authorization: original.headers.Authorization, 'X-Open-Harness-Agent': agentId };
  assert.equal((await raw('/internal/task', { action: 'list' }, withoutRun)).status, 401);
  assert.equal((await raw('/internal/task', { action: 'list' }, { ...original.headers, 'X-Open-Harness-Run': 'another-run' })).status, 401);
  assert.equal((await raw('/internal/task', { action: 'list' }, { ...original.headers, Authorization: `Bearer ${createHmac('sha256', token).update(`agent:${agentId}`).digest('hex')}` })).status, 401, 'Legacy per-agent tokens must never authenticate.');
  await request(`/v1/runner/commands/${original.command.id}/complete`, { result: { final_response: 'Finished' } }, runner.headers);
  await waitRun(original.run.id, 'completed');
  assert.equal((await raw('/internal/task', { action: 'list' }, original.headers)).status, 401);
  await transfer('local', runner);
  await request(`/v1/machines/${runner.id}/revoke`, {});
  assert.equal((await raw('/v1/runner/heartbeat', {}, runner.headers)).status, 401);
  const later = await request<PersistentRun>('/v1/runs', { agentId, prompt: 'MOCK_APPROVAL later private local work' }); await waitRun(later.id, 'waiting_approval');
  for (const headers of [withoutRun, original.headers, { ...original.headers, 'X-Open-Harness-Run': later.id }]) {
    assert.equal((await raw('/internal/runs', { action: 'list' }, headers)).status, 401);
    assert.equal((await raw('/internal/task', { action: 'create', title: 'Forged work' }, headers)).status, 401);
  }
  const config = JSON.parse(readFileSync(join(state, 'agents', agentId, 'profile/config.yaml'), 'utf8'));
  const localToken = config.mcp_servers.open_harness.env.OPEN_HARNESS_AGENT_TOKEN;
  assert.equal(localToken, coordinationToken(token, agentId, 'local'));
  const localHeaders = { Authorization: `Bearer ${localToken}`, 'X-Open-Harness-Agent': agentId, 'X-Open-Harness-Run': later.id };
  assert.equal((await raw('/internal/runs', { action: 'list' }, localHeaders)).status, 200);
  await request(`/v1/runs/${later.id}/stop`, {});
  assert.equal((await raw('/internal/runs', { action: 'list' }, localHeaders)).status, 401);
  // Revocation must also stop coordination for a still-active run on that computer.
  const activeRunner = await pair(); await transfer(activeRunner.id, activeRunner);
  const activeRemote = await remoteRun(activeRunner);
  assert.equal((await raw('/internal/task', { action: 'list' }, activeRemote.headers)).status, 200);
  await request(`/v1/machines/${activeRunner.id}/revoke`, {});
  assert.equal((await raw('/internal/task', { action: 'list' }, activeRemote.headers)).status, 401);
});
