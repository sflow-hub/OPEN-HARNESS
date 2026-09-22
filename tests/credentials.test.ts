import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentProfile, ProfileResponse } from '../lib/agent-profile';
import type { CredentialList, CredentialRecord, CredentialUsage } from '../lib/credentials';
import { refFromLabel } from '../lib/credentials';
import type { PersistentRun } from '../lib/control-client';

const port = 14321, base = `http://127.0.0.1:${port}`, state = mkdtempSync(join(tmpdir(), 'harness-credentials-'));
let child: ChildProcess, token = '';
const ATLAS_KEY = 'atlas-secret-value-0001', SCOUT_KEY = 'scout-secret-value-0002';

async function start() {
  child = spawn(process.execPath, ['--import', 'tsx', 'runtime/service.ts'], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, OPEN_HARNESS_MOCK: '1', OPEN_HARNESS_PORT: String(port), OPEN_HARNESS_STATE_DIR: state, OPEN_HARNESS_DISABLE_OS_VAULT: '1' }, stdio: 'pipe' });
  for (let i = 0; i < 80; i++) { try { const r = await fetch(`${base}/v1/bootstrap`); if (r.ok) { token = (await r.json() as { token: string }).token; return; } } catch {} await new Promise(r => setTimeout(r, 50)); }
  throw new Error('Service did not start.');
}
async function stop() { if (child && child.exitCode === null) { const exited = new Promise(r => child.once('exit', r)); child.kill('SIGTERM'); await exited; } }
async function raw(path: string, method = 'GET', body?: unknown) {
  return fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const r = await raw(path, method, body);
  const value = await r.json(); if (!r.ok) throw Object.assign(new Error(JSON.stringify(value)), { status: r.status }); return value as T;
}
const list = () => request<CredentialList>('/v1/credentials');
const profile = async (id: string) => (await request<ProfileResponse>(`/v1/agents/${id}/profile`)).profile;
const save = (p: AgentProfile) => request<ProfileResponse>(`/v1/agents/${p.id}/profile`, 'PUT', p);
const secretsFile = () => readFileSync(join(state, 'secrets.json'), 'utf8');
const agentEnv = (id: string) => readFileSync(join(state, 'agents', id, 'profile', '.env'), 'utf8');
async function waitRun(id: string) {
  for (let i = 0; i < 100; i++) { const run = await request<PersistentRun>(`/v1/runs/${id}`); if (['completed','failed','cancelled'].includes(run.state)) return run; await new Promise(r => setTimeout(r, 30)); }
  throw new Error('Run timed out.');
}

test.before(async () => {
  await start();
  await request('/v1/agents/sync', 'POST', { agents: ['atlas','scout'].map(id => ({ id, name: id, role: 'Assistant', description: '', tone: 1, instructions: 'Keep context.', memory: [] })) });
});
test.after(stop);

test('pre-existing vault names are adopted as manageable credentials across a restart', async () => {
  // Seeded through the legacy write-only route, exactly as an older build would have.
  await request('/v1/secrets', 'POST', { name: 'XAI_API_KEY', value: 'legacy-seeded-value' });
  await stop(); await start();
  const adopted = (await list()).credentials.find(c => c.ref === 'XAI_API_KEY');
  assert.ok(adopted, 'the pre-existing name should be adopted');
  assert.equal(adopted.label, 'xAI API key');
  assert.equal(adopted.provider, 'xai');
  assert.equal(adopted.present, true);
  // DEFAULT_MODEL.credentialRef points at this name, so it must keep resolving untouched.
  const atlas = await profile('atlas');
  assert.equal((await save({ ...atlas, model: { ...atlas.model, inherit: true } })).effectiveModel.credentialRef, 'XAI_API_KEY');
});

test('no endpoint ever returns a stored value', async () => {
  await request('/v1/credentials', 'POST', { label: 'Leak probe', provider: 'mock', value: 'probe-value-must-never-appear' });
  for (const path of ['/v1/credentials', '/v1/credentials/LEAK_PROBE', '/v1/agents/atlas/profile', '/v1/health', '/v1/support-bundle', '/v1/machines/local/secrets', '/v1/agents']) {
    const body = JSON.stringify(await request(path));
    assert.ok(!body.includes('probe-value-must-never-appear'), `${path} leaked a credential value`);
  }
  // The support bundle gets mailed to strangers; it carries refs but not the fingerprint.
  const bundle = JSON.stringify(await request<{ credentials: unknown[] }>('/v1/support-bundle'));
  assert.ok(bundle.includes('LEAK_PROBE') && !bundle.includes('fingerprint'));
  await request('/v1/credentials/LEAK_PROBE?force=1', 'DELETE');
});

test('the control token is never exposed, adopted, or deletable', async () => {
  const before = (await request<{ token: string }>('/v1/bootstrap')).token;
  assert.ok(!(await list()).credentials.some(c => c.ref === 'controlToken'));
  assert.equal((await raw('/v1/credentials/controlToken', 'DELETE')).status, 404);
  await request('/v1/credentials', 'POST', { label: 'Token neighbour', provider: 'mock', value: 'neighbour' });
  await request('/v1/credentials/TOKEN_NEIGHBOUR?force=1', 'DELETE');
  assert.equal((await request<{ token: string }>('/v1/bootstrap')).token, before, 'deleting a credential must not disturb the control token');
  assert.ok(JSON.parse(secretsFile()).controlToken);
});

test('two credentials for one provider reach their own agents', async () => {
  const a = await request<CredentialRecord>('/v1/credentials', 'POST', { label: 'Atlas key', provider: 'mock', value: ATLAS_KEY });
  const b = await request<CredentialRecord>('/v1/credentials', 'POST', { label: 'Scout key', provider: 'mock', value: SCOUT_KEY });
  assert.notEqual(a.ref, b.ref);
  assert.notEqual(a.fingerprint, b.fingerprint);
  const atlas = await profile('atlas'), scout = await profile('scout');
  await save({ ...atlas, model: { inherit: false, provider: 'mock', model: 'm', credentialRef: a.ref, baseUrl: '' } });
  await save({ ...scout, model: { inherit: false, provider: 'mock', model: 'm', credentialRef: b.ref, baseUrl: '' } });
  await waitRun((await request<PersistentRun>('/v1/runs', 'POST', { agentId: 'atlas', prompt: 'hello' })).id);
  await waitRun((await request<PersistentRun>('/v1/runs', 'POST', { agentId: 'scout', prompt: 'hello' })).id);
  const atlasEnv = agentEnv('atlas'), scoutEnv = agentEnv('scout');
  assert.ok(atlasEnv.includes(ATLAS_KEY) && !atlasEnv.includes(SCOUT_KEY), 'atlas must only see its own credential');
  assert.ok(scoutEnv.includes(SCOUT_KEY) && !scoutEnv.includes(ATLAS_KEY), 'scout must only see its own credential');
  assert.equal(statSync(join(state, 'agents', 'atlas', 'profile', '.env')).mode & 0o777, 0o600);
  assert.ok((await request<CredentialRecord>(`/v1/credentials/${a.ref}`)).lastUsedAt, 'a run should record usage');
});

test('rotating a value keeps every reference and revision intact', async () => {
  const before = await profile('atlas');
  const rotated = await request<CredentialRecord>('/v1/credentials/ATLAS_KEY/value', 'POST', { value: 'atlas-rotated-value' });
  const after = await profile('atlas');
  assert.equal(after.model.credentialRef, before.model.credentialRef);
  assert.equal(after.revision, before.revision, 'rotating must not touch any profile');
  assert.notEqual(rotated.fingerprint, (await request<CredentialRecord>('/v1/credentials/SCOUT_KEY')).fingerprint);
  await waitRun((await request<PersistentRun>('/v1/runs', 'POST', { agentId: 'atlas', prompt: 'again' })).id);
  assert.ok(agentEnv('atlas').includes('atlas-rotated-value'));
});

test('relabelling moves the name but never the reference', async () => {
  const before = await profile('atlas');
  const renamed = await request<CredentialRecord>('/v1/credentials/ATLAS_KEY', 'PUT', { label: 'Atlas production key' });
  assert.equal(renamed.ref, 'ATLAS_KEY');
  assert.equal(renamed.label, 'Atlas production key');
  assert.deepEqual(await profile('atlas'), before, 'referencing profiles must be untouched');
  await assert.rejects(() => request('/v1/credentials/SCOUT_KEY', 'PUT', { label: 'Atlas production key' }), /already uses that name/);
});

test('deleting an in-use credential is refused, reassigned, or forced', async () => {
  const refused = await raw('/v1/credentials/ATLAS_KEY', 'DELETE');
  assert.equal(refused.status, 409);
  const usage = (await refused.json() as { usage: CredentialUsage }).usage;
  assert.ok(usage.uses.some(use => use.kind === 'agent-model' && use.agentId === 'atlas'), 'the refusal must name the agent');

  const spare = await request<CredentialRecord>('/v1/credentials', 'POST', { label: 'Shared spare', provider: 'mock', value: 'spare-value' });
  const before = await profile('atlas');
  const moved = await request<{ reassigned: string[] }>(`/v1/credentials/ATLAS_KEY?reassignTo=${spare.ref}`, 'DELETE');
  assert.ok(moved.reassigned.includes('atlas'));
  const after = await profile('atlas');
  assert.equal(after.model.credentialRef, spare.ref);
  assert.equal(after.revision, before.revision + 1, 'a reassign is a profile edit and bumps the revision');
  assert.ok(!(await list()).credentials.some(c => c.ref === 'ATLAS_KEY'));

  await request('/v1/credentials/SCOUT_KEY?force=1', 'DELETE');
  const scout = await profile('scout');
  assert.equal(scout.model.credentialRef, 'SCOUT_KEY', 'a forced delete leaves the reference dangling on purpose');
  assert.ok(!(await list()).credentials.some(c => c.ref === 'SCOUT_KEY'));
});

test('deleting rewrites the restricted file without disturbing its neighbours', async () => {
  const stored = JSON.parse(secretsFile());
  assert.ok(!('SCOUT_KEY' in stored), 'the deleted value must be gone from disk');
  assert.ok(stored.controlToken && stored.SHARED_SPARE, 'neighbours and the control token must survive');
  assert.equal(statSync(join(state, 'secrets.json')).mode & 0o777, 0o600);
});

test('switching a credential mid-run applies to the next task only', async () => {
  const atlas = await profile('atlas');
  await save({ ...atlas, model: { inherit: false, provider: 'mock', model: 'm', credentialRef: 'SHARED_SPARE', baseUrl: '' } });
  const other = await request<CredentialRecord>('/v1/credentials', 'POST', { label: 'Next task key', provider: 'mock', value: 'next-task-value' });
  const run = await request<PersistentRun>('/v1/runs', 'POST', { agentId: 'atlas', prompt: 'long' });
  await request(`/v1/agents/atlas/credential`, 'PUT', { ref: other.ref });
  const response = await request<ProfileResponse>('/v1/agents/atlas/profile');
  assert.equal(response.profile.model.credentialRef, other.ref);
  await waitRun(run.id);
  // The frozen run snapshot keeps the credential the run started on.
  assert.equal((await request<PersistentRun & { snapshot?: unknown }>(`/v1/runs/${run.id}`)).state, 'completed');
  await waitRun((await request<PersistentRun>('/v1/runs', 'POST', { agentId: 'atlas', prompt: 'next' })).id);
  assert.ok(agentEnv('atlas').includes('next-task-value'), 'the next run picks up the switch');
});

test('the quick switch can hand an agent back to the workspace default', async () => {
  const response = await request<ProfileResponse>('/v1/agents/scout/credential', 'PUT', { inherit: true });
  assert.equal(response.profile.model.inherit, true);
  assert.equal(response.effectiveModel.credentialRef, (await request<{ model: { credentialRef: string } }>('/v1/workspace/model')).model.credentialRef);
  await assert.rejects(() => request('/v1/agents/scout/credential', 'PUT', { ref: 'NO_SUCH_CREDENTIAL' }), /no longer exists/);
});

test('references are derived from labels and stay within every validator', async () => {
  const taken = new Set(['PERSONAL_XAI']);
  assert.equal(refFromLabel('Personal xAI', r => taken.has(r)), 'PERSONAL_XAI_2');
  assert.equal(refFromLabel('Personal xAI', () => false), 'PERSONAL_XAI');
  assert.match(refFromLabel('2024 key', () => false), /^[A-Z][A-Z0-9_]*$/);
  const long = refFromLabel('x'.repeat(90), () => false);
  assert.ok(long.length <= 64, 'derived references must fit the 64-character creation cap');
  // A derived ref has to survive validateModel, which caps references at 80.
  const created = await request<CredentialRecord>('/v1/credentials', 'POST', { label: 'Sixty four char label check', provider: 'mock', value: 'v' });
  const scout = await profile('scout');
  await save({ ...scout, model: { inherit: false, provider: 'mock', model: 'm', credentialRef: created.ref, baseUrl: '' } });
  assert.equal((await profile('scout')).model.credentialRef, created.ref);
});
