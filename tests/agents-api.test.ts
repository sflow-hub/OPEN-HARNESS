import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/db';
import { Profiles, ProfileError } from '../runtime/profiles';
import { TeamStore } from '../runtime/teams';
import { TaskStore } from '../runtime/tasks';
import { draftProfile, profileAgent } from '../lib/agent-profile';
import type { Agent } from '../lib/types';

test('agent creation validates input, mints unique IDs, and keeps safe defaults', () => {
  const store = new Store(':memory:'), profiles = new Profiles(store.db);
  try {
    const first = profiles.create({ name: 'Research Scout', prompt: 'Research.' });
    const second = profiles.create({ name: 'Research Scout' });
    assert.match(first.id, /^research-scout-[a-f0-9]{8}$/);
    assert.notEqual(first.id, second.id);
    assert.deepEqual(first, { ...draftProfile({ ...profileAgent(first), profile: undefined }), revision: 1 });
    assert.equal(first.role, 'Generalist');
    assert.equal(first.prompt.text, 'Research.');
    assert.equal(first.connectors.length, 0);
    assert.equal(first.computer.access, 'private');
    for (const input of [{ name: '' }, { name: 'x'.repeat(31) }, { name: 'Bad', id: '../bad' }, { name: 'Bad', role: '' }, { name: 'Bad', prompt: 'x'.repeat(12001) }, { name: 'Bad', description: 'x'.repeat(181) }]) {
      assert.throws(() => profiles.create(input), (e: unknown) => e instanceof ProfileError && e.status === 400);
    }
    assert.throws(() => profiles.create({ name: 'Duplicate', id: first.id }), (e: unknown) => e instanceof ProfileError && e.status === 409);
    assert.equal(profiles.import({ ...profileAgent(first), name: 'Stale browser name' })?.name, first.name);
  } finally { store.db.close(); }
});

test('profile deletion keeps history, disables routines, removes memberships, and prevents resurrection', () => {
  const store = new Store(':memory:'), profiles = new Profiles(store.db), teams = new TeamStore(store.db);
  new TaskStore(store.db);
  try {
    const keep = profiles.create({ name: 'Keeper', id: 'keeper' });
    const agent = profiles.create({ name: 'Scout', id: 'scout', prompt: 'Research.' });
    const team = teams.create({ name: 'Research', color: 'blue', icon: 'people', memberAgentIds: [keep.id, agent.id] });
    profiles.snapshot('historic', agent);
    const now = new Date().toISOString();
    store.db.prepare('INSERT INTO schedules(id,agent_id,name,prompt,interval_minutes,timezone,next_run_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run('daily', agent.id, 'Daily', 'Research', 1440, 'UTC', now, now, now);
    for (const state of ['queued', 'running', 'waiting_approval', 'waiting_input', 'waiting_other']) {
      store.db.prepare('INSERT INTO runs(id,agent_id,conversation_id,prompt,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('active', agent.id, 'conversation', 'Work', state, now, now);
      assert.throws(() => profiles.delete(agent.id), (e: unknown) => e instanceof ProfileError && e.status === 409);
      assert.equal(profiles.isDeleted(agent.id), false);
      store.db.prepare('DELETE FROM runs WHERE id=?').run('active');
    }
    profiles.delete(agent.id);
    assert.equal(profiles.get(agent.id), null);
    assert.equal(profiles.isDeleted(agent.id), true);
    assert.equal(store.db.prepare('SELECT 1 FROM agents WHERE id=?').get(agent.id), undefined);
    assert.equal(store.db.prepare('SELECT enabled FROM schedules WHERE id=?').get('daily')?.enabled, 0);
    assert.deepEqual(teams.get(team.id)?.memberAgentIds, [keep.id]);
    assert.equal(teams.get(team.id)?.revision, team.revision + 1);
    assert.equal(profiles.runSnapshot('historic')?.id, agent.id);
    assert.ok(store.db.prepare('SELECT 1 FROM profile_revisions WHERE agent_id=?').get(agent.id));
    assert.equal(profiles.import(profileAgent(agent)), null);
    assert.throws(() => profiles.save({ ...agent, revision: 0 }), (e: unknown) => e instanceof ProfileError && e.status === 409);
    assert.throws(() => profiles.create({ name: 'New Scout', id: agent.id }), (e: unknown) => e instanceof ProfileError && e.status === 409);
    assert.throws(() => profiles.delete('unknown'), (e: unknown) => e instanceof ProfileError && e.status === 404);
    assert.throws(() => profiles.delete(keep.id), (e: unknown) => e instanceof ProfileError && e.status === 409);
    assert.equal(new Profiles(store.db).import(profileAgent(agent)), null);
  } finally { store.db.close(); }
});

test('agent HTTP API creates, validates, deletes, and treats browser sync as seed-only', async () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-agents-api-')), port = 14329, base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'runtime/service.ts'], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, OPEN_HARNESS_MOCK: '1', OPEN_HARNESS_PORT: String(port), OPEN_HARNESS_STATE_DIR: state }, stdio: 'pipe' });
  let token = '', stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.stdout.on('data', chunk => { stderr += chunk.toString(); });
  async function request(path: string, method = 'GET', body?: unknown) {
    return fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  try {
    const deadline = Date.now() + 30_000;
    while (!token && Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Service exited: ${stderr}`);
      try { const response = await fetch(base + '/v1/bootstrap'); if (response.ok) token = (await response.json() as { token: string }).token; } catch {}
      if (!token) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(token, stderr);
    for (const body of [{}, { name: '' }, { name: 'x'.repeat(31) }, { name: 'Bad', id: '../bad' }, { name: 'Bad', id: null }, { name: 'Bad', role: 1 }, { name: 'Bad', prompt: 'x'.repeat(12001) }]) assert.equal((await request('/v1/agents', 'POST', body)).status, 400);
    const created = await request('/v1/agents', 'POST', { name: 'Research Scout', prompt: 'Research carefully.' });
    assert.equal(created.status, 201);
    const { agent } = await created.json() as { agent: Agent };
    assert.match(agent.id, /^research-scout-[a-f0-9]{8}$/);
    assert.equal(agent.instructions, 'Research carefully.');
    assert.deepEqual(agent.profile, { ...draftProfile({ ...agent, profile: undefined }), revision: 1 });
    assert.ok(existsSync(join(state, 'agents', agent.id, 'profile')));
    assert.equal((await request('/v1/agents', 'POST', { name: 'Duplicate', id: agent.id })).status, 409);
    assert.equal((await request(`/v1/agents/${agent.id}`, 'DELETE')).status, 409);
    assert.equal((await request('/v1/agents', 'POST', { name: 'Keeper', id: 'keeper', role: 'Writer', description: 'Writes' })).status, 201);
    const runResponse = await request('/v1/runs', 'POST', { agentId: agent.id, prompt: 'MOCK_APPROVAL' });
    assert.equal(runResponse.status, 202);
    assert.equal((await request(`/v1/agents/${agent.id}`, 'DELETE')).status, 409);
    await request(`/v1/agents/${agent.id}/stop`, 'POST', {});
    const reservedProfile = { ...agent.profile!, computer: { ...agent.profile!.computer, reserveMachine: true } };
    assert.equal((await request(`/v1/agents/${agent.id}/profile`, 'PUT', reservedProfile)).status, 200);
    const keeperProfile = draftProfile({ id: 'keeper', name: 'Keeper', role: 'Writer', description: 'Writes', instructions: '', tone: 0, memory: [] });
    const keeperAssignment = { ...keeperProfile, revision: 1, computer: { ...keeperProfile.computer, machineId: reservedProfile.computer.machineId } };
    assert.equal((await request('/v1/agents/keeper/profile', 'PUT', keeperAssignment)).status, 409);
    const routineResponse = await request('/v1/routines', 'POST', { agentId: agent.id, name: 'Daily', prompt: 'Research', intervalMinutes: 1440, timezone: 'UTC' });
    assert.equal(routineResponse.status, 201);
    const routine = await routineResponse.json() as { id: string };
    const deleted = await request(`/v1/agents/${agent.id}`, 'DELETE');
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { ok: true, id: agent.id });
    assert.equal((await request('/v1/agents/keeper/profile', 'PUT', keeperAssignment)).status, 200);
    assert.equal((await request(`/v1/agents/${agent.id}`, 'DELETE')).status, 404);
    assert.equal((await request('/v1/agents/missing', 'DELETE')).status, 404);
    assert.equal((await request('/v1/agents', 'POST', { name: 'Resurrected', id: agent.id })).status, 409);
    const synced = await request('/v1/agents/sync', 'POST', { agents: [agent, { id: 'keeper', name: 'Changed', role: 'Changed', instructions: 'Changed' }] });
    assert.equal(synced.status, 200);
    const syncedList = await synced.json() as { agents: Agent[] };
    assert.deepEqual(syncedList.agents.map(a => a.id), ['keeper']);
    assert.equal(syncedList.agents[0].name, 'Keeper');
    const listed = await (await request('/v1/agents')).json() as { agents: Agent[] };
    assert.deepEqual(listed.agents, syncedList.agents);
    const routines = await (await request('/v1/routines')).json() as { routines: Array<{ id: string; enabled: number }> };
    assert.equal(routines.routines.find(item => item.id === routine.id)?.enabled, 0);
    assert.ok(existsSync(join(state, 'agents', agent.id, 'profile')));
  } finally { child.kill('SIGTERM'); }
});
