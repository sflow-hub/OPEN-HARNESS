import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { coordinationToken } from '../runtime/coordination-auth';
import { DatabaseSync } from 'node:sqlite';
import { folderName, folderNotice, folderTarget, namedFolders, runComputer, runCwd, type AgentProfile, type ComputerConfig, type ProfileResponse, type SharedFolder } from '../lib/agent-profile';
import type { PersistentRun } from '../lib/control-client';
import type { ProjectFolder, TaskBoard } from '../lib/task-types';

const POLL_BUDGET_MS = 30_000;
const port = 14324, base = `http://127.0.0.1:${port}`;
// The data folder and the granted folders are siblings: a grant inside the data folder is refused.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-project-folders-'))), state = join(root, 'state');
const site = join(root, 'site'), assets = join(root, 'assets'), notes = join(root, 'notes');
for (const dir of [state, site, assets, notes]) mkdirSync(dir, { recursive: true });
let child: ChildProcess, token = '';

async function start() {
  child = spawn(process.execPath, ['--import', 'tsx', 'runtime/service.ts'], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, OPEN_HARNESS_MOCK: '1', OPEN_HARNESS_PORT: String(port), OPEN_HARNESS_STATE_DIR: state }, stdio: 'pipe' });
  const deadline = Date.now() + POLL_BUDGET_MS;
  while (Date.now() < deadline) { try { const r = await fetch(`${base}/v1/bootstrap`); if (r.ok) { token = (await r.json() as { token: string }).token; return; } } catch {} await new Promise(r => setTimeout(r, 50)); }
  throw new Error('Service did not start.');
}
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await r.json(); if (!r.ok) throw Object.assign(new Error(JSON.stringify(value)), { status: r.status }); return value as T;
}
async function profile(id: string) { return (await request<ProfileResponse>(`/v1/agents/${id}/profile`)).profile; }
async function waitRun(id: string, states = ['completed', 'failed', 'cancelled']) {
  const deadline = Date.now() + POLL_BUDGET_MS;
  while (Date.now() < deadline) { const run = await request<PersistentRun>(`/v1/runs/${id}`); if (states.includes(run.state)) return run; await new Promise(r => setTimeout(r, 30)); }
  throw new Error('Run timed out.');
}
async function mounted(runId: string) {
  const { events } = await request<{ events: Array<{ type: string; payload: { computer: ComputerConfig } }> }>(`/v1/runs/${runId}/events?after=0`);
  return events.find(event => event.type === 'profile.applied')!.payload.computer;
}
const soul = (agentId: string) => readFileSync(join(state, `agents/${agentId}/profile/SOUL.md`), 'utf8');
const cwd = (agentId: string) => JSON.parse(readFileSync(join(state, `agents/${agentId}/profile/config.yaml`), 'utf8')).terminal.cwd;

let project: TaskBoard;
test.before(async () => {
  await start();
  await request('/v1/agents/sync', 'POST', { agents: ['atlas', 'scout'].map(id => ({ id, name: id, role: 'Assistant', description: '', tone: 1, instructions: 'Keep context.', memory: [] })) });
  project = await request<TaskBoard>('/v1/boards', 'POST', { name: 'Website', folders: [
    { name: 'site', path: site, mode: 'write', agents: { atlas: 'write' } },
    { name: 'assets', path: assets, mode: 'read', agents: { atlas: 'write', scout: 'read' } },
  ] });
});
test.after(async () => {
  if (child && child.exitCode === null) { const exited = new Promise(r => child.once('exit', r)); child.kill('SIGTERM'); await exited; }
  rmSync(root, { recursive: true, force: true });
});

test('a project stores named folders and caps each agent at the folder’s own access', () => {
  assert.deepEqual(project.folders.map(({ name, mode, agents }) => ({ name, mode, agents })), [
    { name: 'site', mode: 'write', agents: { atlas: 'write' } },
    { name: 'assets', mode: 'read', agents: { atlas: 'read', scout: 'read' } },
  ]);
});

test('project folders are checked on save and an unrelated edit keeps them', async () => {
  const save = (folders: Partial<ProjectFolder>[]) => request<TaskBoard>(`/v1/boards/${project.id}`, 'PUT', { revision: project.revision, folders });
  await assert.rejects(save([{ name: 'data', path: join(state, 'agents'), mode: 'read', agents: {} }]), { status: 400, message: /Open Harness data/ });
  await assert.rejects(save([{ name: 'gone', path: join(root, 'missing'), mode: 'read', agents: {} }]), { status: 400, message: /does not exist/ });
  await assert.rejects(save([{ name: 'Bad Name', path: site, mode: 'read', agents: {} }]), { status: 400, message: /names must be unique/ });
  await assert.rejects(save([{ name: 'dup', path: site, mode: 'read', agents: {} }, { name: 'dup', path: assets, mode: 'read', agents: {} }]), { status: 400 });
  const renamed = await request<TaskBoard>(`/v1/boards/${project.id}`, 'PUT', { revision: project.revision, name: 'Website' });
  assert.deepEqual(renamed.folders, project.folders); project = renamed;
});

test('a task run mounts only the folders its project grants the owner, and tells the agent where they are', async () => {
  const task = await request<{ id: string; revision: number }>('/v1/tasks', 'POST', { boardId: project.id, title: 'Update the site', ownerAgentId: 'atlas' });
  const { run } = await request<{ run: PersistentRun & { project_id: string } }>(`/v1/tasks/${task.id}/start`, 'POST', { revision: task.revision, idempotencyKey: 'site-1' });
  assert.equal(run.project_id, project.id);
  await waitRun(run.id);
  assert.deepEqual((await mounted(run.id)).folders.map(({ name, mode, scope }) => ({ name, mode, scope })), [{ name: 'site', mode: 'write', scope: 'project' }, { name: 'assets', mode: 'read', scope: 'project' }]);
  assert.match(soul('atlas'), /Keep context\.\n\n## Folders you can use/);
  assert.match(soul('atlas'), /\/workspace\/project\/site \(read and write\): project folder "site" of Website/);
  assert.match(soul('atlas'), /\/workspace\/project\/assets \(read only\)/);
  assert.equal(cwd('atlas'), '/workspace/shared');
});

test('chat uses the agent’s own folders unless a project is chosen, and handoffs stay in that project', async () => {
  const atlas = await profile('atlas');
  // A grant sent on a profile (an older client) moves into the workspace folder list with the same access.
  await request(`/v1/agents/atlas/profile`, 'PUT', { ...atlas, prompt: { enabled: false, text: atlas.prompt.text }, computer: { ...atlas.computer, access: 'folders', folders: [{ id: 'notes', name: '', path: notes, mode: 'write' }] } });
  assert.deepEqual((await profile('atlas')).computer.folders, []);
  assert.deepEqual((await request<{ folders: SharedFolder[] }>('/v1/folders')).folders.map(({ name, path, mode, agents, machineId }) => ({ name, path, mode, agents, machineId })), [{ name: 'notes', path: notes, mode: 'write', agents: { atlas: 'write' }, machineId: 'local' }]);

  const plain = await request<PersistentRun & { project_id: string | null }>('/v1/runs', 'POST', { agentId: 'atlas', prompt: 'hello' });
  assert.equal(plain.project_id, null); await waitRun(plain.id);
  assert.deepEqual((await mounted(plain.id)).folders.map(folder => folder.name), ['notes']);
  assert.equal(soul('atlas'), `## Folders you can use\nThese host folders are mounted in your workspace. Nothing else on the host computer is available to you.\n- /workspace/folders/notes (read and write): your folder "notes"`);

  const chosen = await request<PersistentRun & { project_id: string }>('/v1/runs', 'POST', { agentId: 'atlas', prompt: 'MOCK_SLOW hello', projectId: project.id });
  assert.equal(chosen.project_id, project.id);
  // Children inherit the project only through a named handoff; see the archived-project test below.
  await waitRun(chosen.id);
  assert.deepEqual((await mounted(chosen.id)).folders.map(folder => folder.name), ['notes', 'site', 'assets']);

  await assert.rejects(request('/v1/runs', 'POST', { agentId: 'atlas', prompt: 'hello', projectId: 'missing' }), { status: 404 });
});

test('archived projects cannot be inherited by new handoffs', async () => {
  const atlas = await profile('atlas');
  await request('/v1/agents/atlas/profile', 'PUT', { ...atlas, terminalConsent: true, allowedTools: [...new Set([...atlas.allowedTools, 'terminal', 'mcp__open_harness__delegate_named_agent'])] });
  const team = await request<{ id: string }>('/v1/teams', 'POST', { name: 'Archived handoff test', color: 'blue', icon: 'people', memberAgentIds: ['atlas', 'scout'] });
  let board = await request<TaskBoard>('/v1/boards', 'POST', { name: 'Archived handoff', folders: [{ name: 'assets', path: assets, mode: 'read', agents: { scout: 'read' } }] });
  const parent = await request<PersistentRun>('/v1/runs', 'POST', { agentId: 'atlas', prompt: 'MOCK_APPROVAL keep the project conversation live', projectId: board.id });
  const scoped = coordinationToken(token, 'atlas', 'local');
  const handoff = async () => {
    const response = await fetch(`${base}/internal/handoff`, { method: 'POST', headers: { Authorization: `Bearer ${scoped}`, 'X-Open-Harness-Agent': 'atlas', 'X-Open-Harness-Run': parent.id, 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: 'scout', prompt: 'Use the project assets' }) });
    return { status: response.status, body: await response.json() as { error?: string; runId: string } };
  };
  try {
    await waitRun(parent.id, ['waiting_approval']);
    board = await request<TaskBoard>(`/v1/boards/${board.id}`, 'PUT', { revision: board.revision, archived: true });
    await assert.rejects(request('/v1/runs', 'POST', { agentId: 'scout', prompt: 'Direct archived run', projectId: board.id }), { status: 400, message: /archived/ });
    const denied = await handoff();
    assert.equal(denied.status, 400); assert.match(denied.body.error || '', /archived/);
    await assert.rejects(request('/v1/runs', 'POST', { agentId: 'scout', prompt: 'Inherited archived run', parentRunId: parent.id }), { status: 409, message: /named-agent handoff/ });
    const runs = (await request<{ runs: PersistentRun[] }>('/v1/runs')).runs;
    assert.equal(runs.some(run => run.parent_run_id === parent.id), false, 'Refused handoffs must not create a child run.');
    board = await request<TaskBoard>(`/v1/boards/${board.id}`, 'PUT', { revision: board.revision, archived: false });
    const allowed = await handoff();
    assert.equal(allowed.status, 200);
    const child = await request<PersistentRun & { project_id: string }>(`/v1/runs/${allowed.body.runId}`);
    assert.equal(child.project_id, board.id); assert.equal(child.state, 'completed');
    assert.deepEqual((await mounted(child.id)).folders.map(({ name, mode }) => ({ name, mode })), [{ name: 'assets', mode: 'read' }]);
  } finally {
    await request(`/v1/runs/${parent.id}/stop`, 'POST');
    await request(`/v1/teams/${team.id}`, 'DELETE');
  }
});

test('an agent without access gets no project folders and only a lone writable folder becomes the working directory', async () => {
  const solo = await request<TaskBoard>('/v1/boards', 'POST', { name: 'Solo', folders: [{ name: 'site', path: site, mode: 'write', agents: { scout: 'write' } }] });
  const scout = await request<PersistentRun>('/v1/runs', 'POST', { agentId: 'scout', prompt: 'hello', projectId: solo.id }); await waitRun(scout.id);
  assert.equal(cwd('scout'), '/workspace/project/site');
  const atlas = await request<PersistentRun>('/v1/runs', 'POST', { agentId: 'atlas', prompt: 'hello', projectId: solo.id }); await waitRun(atlas.id);
  assert.deepEqual((await mounted(atlas.id)).folders.map(folder => folder.scope || 'agent'), ['agent']);
  await request(`/v1/boards/${solo.id}`, 'PUT', { revision: solo.revision, archived: true });
  await assert.rejects(request('/v1/runs', 'POST', { agentId: 'scout', prompt: 'hello', projectId: solo.id }), { status: 400, message: /archived/ });
});

test('agents can neither see nor change project folders through the task or project tools', async () => {
  const atlas = await profile('atlas');
  await request(`/v1/agents/atlas/profile`, 'PUT', { ...atlas, allowedTools: [...atlas.allowedTools, 'mcp__open_harness__project'] });
  const run = await request<PersistentRun>('/v1/runs', 'POST', { agentId: 'atlas', prompt: 'MOCK_SLOW hold the board open' });
  await waitRun(run.id, ['running']);
  const scoped = coordinationToken(token, 'atlas', 'local');
  const call = async (tool: string, payload: unknown) => (await fetch(`${base}/internal/${tool}`, { method: 'POST', headers: { Authorization: `Bearer ${scoped}`, 'X-Open-Harness-Agent': 'atlas', 'X-Open-Harness-Run': run.id, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).json();
  const listed = await call('task', { action: 'list' }) as { boards: Array<Record<string, unknown>> };
  assert.ok(listed.boards.length && listed.boards.every(board => !('folders' in board)));
  const projects = await call('project', { action: 'list' }) as { projects: Array<Record<string, unknown>> };
  assert.ok(projects.projects.length && projects.projects.every(board => !('folders' in board)));
  const updated = await call('project', { action: 'update', boardId: project.id, description: 'Agent edit', folders: [] }) as Record<string, unknown>;
  assert.equal(updated.description, 'Agent edit'); assert.ok(!('folders' in updated));
  const aliased = await call('task', { action: 'board_update', boardId: project.id, input: { description: 'Alias edit', folders: [] } }) as Record<string, unknown>;
  assert.equal(aliased.description, 'Alias edit'); assert.ok(!('folders' in aliased));
  assert.equal((await request<TaskBoard>(`/v1/boards/${project.id}`)).folders.length, 2);
  await waitRun(run.id);
});

test('an agent’s own folders cannot reach the data folder or the home folder', async () => {
  const atlas: AgentProfile = await profile('atlas');
  for (const [path, reason] of [[state, /Open Harness data/], [join(state, 'agents/scout/private'), /Open Harness data/], [homedir(), /home folder/]] as const) {
    await assert.rejects(request(`/v1/agents/atlas/profile`, 'PUT', { ...atlas, computer: { ...atlas.computer, access: 'folders', folders: [{ id: 'bad', name: 'bad', path, mode: 'read' }] } }), { status: 400, message: reason });
  }
  await assert.rejects(request(`/v1/agents/atlas/profile`, 'PUT', { ...atlas, computer: { ...atlas.computer, access: 'folders', folders: [{ id: 'a', name: 'same', path: site, mode: 'read' }, { id: 'b', name: 'same', path: assets, mode: 'read' }] } }), { status: 400, message: /names must be unique/ });
});

test('folders saved before names existed get stable, unique names from their paths', () => {
  assert.deepEqual(namedFolders([{ path: '/home/me/My Site' }, { path: 'C:\\Work\\my-site' }, { path: '/' }, { path: '/x', name: 'Not Valid' }]).map(folder => folder.name), ['my-site', 'my-site-2', 'folder', 'x']);
  assert.equal(folderName('/srv/site', ['site', 'site-2']), 'site-3');
  const own: ComputerConfig = { machineId: 'local', access: 'private', folders: [], desktop: 'none', reserveMachine: false, resources: { cpu: 1, memoryMb: 512, concurrency: 1 } };
  assert.equal(runComputer(own, []).access, 'private');
  assert.deepEqual(runComputer(own, [{ id: 'p', name: 'site', path: '/srv/site', mode: 'read', scope: 'project' }]).access, 'folders');

  // A workspace folder and a project folder may share a name: they mount under different roots.
  // The container mounts what namedFolders gives back, so the agent must be told exactly that.
  const run = runComputer(own, [{ id: 'w', name: 'docs', path: '/srv/notes', mode: 'read' }, { id: 'p', name: 'docs', path: '/srv/client/docs', mode: 'write', scope: 'project' }, { id: 'q', name: 'docs-2', path: '/srv/archive', mode: 'read', scope: 'project' }]);
  const mounted = namedFolders(run.folders).map(folder => `${folderTarget(folder)} <- ${folder.path}`);
  assert.deepEqual(mounted, ['/workspace/folders/docs <- /srv/notes', '/workspace/project/docs <- /srv/client/docs', '/workspace/project/docs-2 <- /srv/archive']);
  const notice = folderNotice(run, 'Client');
  for (const target of ['/workspace/folders/docs', '/workspace/project/docs', '/workspace/project/docs-2']) assert.match(notice, new RegExp(target.replace(/[/.-]/g, '\\$&')));
  assert.equal(runCwd({ ...run, folders: run.folders.filter(folder => folder.id !== 'q') }), '/workspace/project/docs');
});

test('the workspace folder list sets which agents keep which folders, and is checked like any grant', async () => {
  const listed = await request<{ revision: number; folders: SharedFolder[] }>('/v1/folders');
  const save = (folders: Partial<SharedFolder>[], revision = listed.revision) => request<{ revision: number; folders: SharedFolder[] }>('/v1/folders', 'PUT', { revision, folders });
  await assert.rejects(save([{ name: 'data', path: state, mode: 'read', agents: {} }]), { status: 400, message: /Open Harness data/ });
  await assert.rejects(save([{ name: 'far', path: '/srv/far', mode: 'read', machineId: 'unknown-runner', agents: {} }]), { status: 404 });
  await assert.rejects(save(listed.folders, listed.revision - 1), { status: 409 });
  const next = await save([...listed.folders.map(folder => ({ ...folder, agents: {} })), { name: 'datasets', path: assets, mode: 'read', agents: { scout: 'write', atlas: 'read' } }]);
  assert.deepEqual(next.folders.map(folder => folder.agents), [{}, { scout: 'read', atlas: 'read' }]);

  // Revoked on the list, the folder is gone from Atlas's next run; Scout gains the new one.
  const atlasRun = await request<PersistentRun>('/v1/runs', 'POST', { agentId: 'atlas', prompt: 'hello' }); await waitRun(atlasRun.id);
  assert.deepEqual((await mounted(atlasRun.id)).folders.map(({ name, mode }) => ({ name, mode })), [{ name: 'datasets', mode: 'read' }]);
  assert.match(soul('atlas'), /\/workspace\/folders\/datasets \(read only\): your folder "datasets"/);
  const scoutRun = await request<PersistentRun>('/v1/runs', 'POST', { agentId: 'scout', prompt: 'hello', projectId: project.id }); await waitRun(scoutRun.id);
  assert.deepEqual((await mounted(scoutRun.id)).folders.map(folder => `${folder.scope || 'workspace'}:${folder.name}`), ['workspace:datasets', 'project:assets']);
  await save([], next.revision);
});

test('folders saved on agents by an older version move into the workspace list on startup', async () => {
  const exited = new Promise(r => child.once('exit', r)); child.kill('SIGTERM'); await exited;
  const db = new DatabaseSync(join(state, 'state.db'));
  const row = db.prepare("SELECT json FROM agent_profiles WHERE id='scout'").get() as { json: string };
  const legacy = JSON.parse(row.json) as AgentProfile;
  legacy.computer = { ...legacy.computer, access: 'folders', folders: [{ id: 'old', path: notes, mode: 'read' } as AgentProfile['computer']['folders'][number]] };
  db.prepare("UPDATE agent_profiles SET json=? WHERE id='scout'").run(JSON.stringify(legacy)); db.close();
  await start();
  assert.deepEqual((await profile('scout')).computer.folders, []);
  const listed = await request<{ folders: SharedFolder[] }>('/v1/folders');
  assert.deepEqual(listed.folders.map(({ name, path, mode, agents }) => ({ name, path, mode, agents })), [{ name: 'notes', path: notes, mode: 'read', agents: { scout: 'read' } }]);
});
