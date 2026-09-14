import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import type { AgentProfile, ProfileResponse, ModelChoice } from '../lib/agent-profile';
import type { PersistentRun } from '../lib/control-client';
const port = 14318, base = `http://127.0.0.1:${port}`, state = mkdtempSync(join(tmpdir(), 'harness-profiles-'));
let child: ChildProcess, token = '';
async function start() {
  child = spawn(process.execPath, ['--import', 'tsx', 'runtime/service.ts'], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, OPEN_HARNESS_MOCK: '1', OPEN_HARNESS_PORT: String(port), OPEN_HARNESS_STATE_DIR: state }, stdio: 'pipe' });
  for (let i = 0; i < 80; i++) { try { const r = await fetch(`${base}/v1/bootstrap`); if (r.ok) { token = (await r.json() as { token: string }).token; return; } } catch {} await new Promise(r => setTimeout(r, 50)); }
  throw new Error('Service did not start.');
}
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await r.json(); if (!r.ok) throw Object.assign(new Error(JSON.stringify(value)), { status: r.status }); return value as T;
}
async function profile(id = 'atlas') { return (await request<ProfileResponse>(`/v1/agents/${id}/profile`)).profile; }
async function save(p: AgentProfile) { return request<ProfileResponse>(`/v1/agents/${p.id}/profile`, 'PUT', p); }
async function waitRun(id: string, states = ['completed','failed','cancelled']) {
  for (let i = 0; i < 100; i++) { const run = await request<PersistentRun>(`/v1/runs/${id}`); if (states.includes(run.state)) return run; await new Promise(r => setTimeout(r, 30)); } throw new Error('Run timed out.');
}
async function run(prompt: string, agentId = 'atlas') { return request<PersistentRun>('/v1/runs', 'POST', { agentId, prompt }); }
test.before(async () => { await start(); await request('/v1/agents/sync', 'POST', { agents: ['atlas','scout'].map(id => ({ id, name: id, role: 'Assistant', description: 'A durable profile', tone: 1, instructions: 'Keep context.', memory: [] })) }); });
test.after(async () => { if (child && child.exitCode === null) { const exited = new Promise(r => child.once('exit', r)); child.kill('SIGTERM'); await exited; } });

test('independent model overrides survive workspace updates and stale browser sync', async () => {
  const atlas = await profile(), scout = await profile('scout');
  await save({ ...atlas, model: { inherit: false, provider: 'mock', model: 'atlas-model', credentialRef: '', baseUrl: '' }, prompt: { enabled: true, text: 'Atlas custom system prompt' }, allowedTools: ['terminal'] });
  await save({ ...scout, model: { ...scout.model, inherit: true }, prompt: { enabled: false, text: 'Keep this draft' } });
  const defaults = await request<{ revision: number }>('/v1/workspace/model');
  await request('/v1/workspace/model', 'PUT', { revision: defaults.revision, model: { provider: 'mock', model: 'workspace-new', credentialRef: '', baseUrl: '' } });
  await request('/v1/agents/sync', 'POST', { agents: [{ id: 'atlas', name: 'STALE', role: 'STALE', instructions: 'STALE' }] });
  const a = await request<ProfileResponse>('/v1/agents/atlas/profile'), b = await request<ProfileResponse>('/v1/agents/scout/profile');
  assert.equal(a.effectiveModel.model, 'atlas-model'); assert.equal(a.profile.name, 'atlas'); assert.equal(b.effectiveModel.model, 'workspace-new'); assert.equal(b.profile.prompt.text, 'Keep this draft'); assert.equal(b.profile.prompt.enabled, false);
});
test('stale saves return a conflict and never replace the winning revision', async () => {
  const old = await profile(); const latest = await save({ ...old, description: 'Winning edit' });
  await assert.rejects(save({ ...old, description: 'Losing edit' }), { status: 409 });
  assert.equal((await profile()).revision, latest.profile.revision); assert.equal((await profile()).description, 'Winning edit');
});
test('a running task keeps its snapshot; the next queued task uses the new profile', async () => {
  const old = await profile(); await save({ ...old, allowedTools: ['terminal'] });
  const first = await run('MOCK_SLOW MOCK_TOOL:terminal'); await waitRun(first.id, ['running']);
  const next = await run('MOCK_TOOL:terminal');
  const current = await profile(); const saved = await save({ ...current, allowedTools: [], prompt: { enabled: false, text: current.prompt.text } }); assert.equal(saved.pending, true);
  const policy = JSON.parse(readFileSync(join(state, 'agents/atlas/managed/policy.json'), 'utf8')); assert.deepEqual(policy.allowedTools, ['terminal']);
  assert.equal((await waitRun(first.id)).state, 'completed'); assert.equal((await waitRun(next.id)).state, 'failed');
  assert.deepEqual(JSON.parse(readFileSync(join(state, 'agents/atlas/managed/policy.json'), 'utf8')).allowedTools, []);
  assert.equal(readFileSync(join(state, 'agents/atlas/profile/SOUL.md'), 'utf8'), '');
});
test('disabling a connector removes its tools at execution even if individually selected', async () => {
  const p = await profile(); await save({ ...p, allowedTools: ['mcp_research_lookup'], connectors: [{ id: 'r', name: 'research', command: 'npx', args: [], secretRef: '', enabled: false }] });
  const r = await run('MOCK_TOOL:mcp_research_lookup'); assert.equal((await waitRun(r.id)).state, 'failed');
});
test('coordination cannot bypass disabled delegation or scheduling', async () => {
  const r = await run('MOCK_SLOW'); await waitRun(r.id, ['running']);
  const scoped = createHmac('sha256', token).update('agent:atlas').digest('hex');
  for (const path of ['/internal/handoff','/internal/schedule']) {
    const response = await fetch(base + path, { method: 'POST', headers: { Authorization: `Bearer ${scoped}`, 'X-Open-Harness-Agent': 'atlas', 'X-Open-Harness-Run': r.id, 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: 'scout', prompt: 'Bypass', name: 'Bypass' }) }); assert.equal(response.status, 403);
  }
  await waitRun(r.id);
});
test('secrets remain server-side and only selected references enter the next run', async () => {
  await request('/v1/secrets', 'POST', { name: 'ATLAS_KEY', value: 'secret-atlas-value' });
  await request('/v1/secrets', 'POST', { name: 'SCOUT_KEY', value: 'secret-scout-value' });
  const p = await profile(); await save({ ...p, model: { inherit: false, provider: 'mock', model: 'mock', credentialRef: 'ATLAS_KEY', baseUrl: '' } });
  const snapshot = await request<ProfileResponse>('/v1/agents/atlas/profile'); assert.ok(!JSON.stringify(snapshot).includes('secret-atlas-value')); assert.ok(snapshot.secretNames.includes('ATLAS_KEY'));
  const r = await run('hello'); await waitRun(r.id);
  const env = readFileSync(join(state, 'agents/atlas/profile/.env'), 'utf8'); assert.match(env, /secret-atlas-value/); assert.doesNotMatch(env, /secret-scout-value/);
  const exported = await request('/v1/agents'); assert.ok(!JSON.stringify(exported).includes('secret-atlas-value'));
});
test('profile revisions and disabled prompt text survive service restart', async () => {
  const before = await profile('scout'); const exited = new Promise(r => child.once('exit', r)); child.kill('SIGTERM'); await exited; await start();
  assert.deepEqual(await profile('scout'), before);
});
test('missing credentials and invalid endpoint URLs produce actionable errors', async () => {
  const model: ModelChoice = { provider: 'custom', model: 'local', credentialRef: 'MISSING_KEY', baseUrl: 'http://host.docker.internal:11434/v1' };
  const result = await request<{ ok: boolean; message: string }>('/v1/agents/atlas/connection-check', 'POST', { model }); assert.equal(result.ok, false); assert.match(result.message, /MISSING_KEY/);
  await assert.rejects(save({ ...await profile(), model: { ...model, inherit: false, baseUrl: 'https://user:password@example.test' } }), { status: 400 });
});
test('managed middleware denies direct and nested dispatch and filters both schema formats', () => {
  const result = spawnSync('python3', ['tests/policy-extension-test.py'], { cwd: join(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('MCP inventory survives refresh without claiming a stale handshake is connected', async () => {
  const connector = { id: 'catalog-test', name: 'catalog_test', command: 'npx', args: [], enabled: true, secretRef: '' };
  await request('/v1/agents/atlas/connector-check', 'POST', { connector });
  const catalog = await request<{ tools: Array<{ id: string; available: boolean; reason?: string }> }>('/v1/agents/atlas/tools');
  const tool = catalog.tools.find(t => t.id === 'mcp_catalog_test_lookup');
  assert.ok(tool); assert.equal(tool.available, false); assert.match(tool.reason || '', /Test this connection again/);
});
