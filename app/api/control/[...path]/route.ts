import { env } from "cloudflare:workers";
import { hostedRuntimeSchema, hostedTaskSchema } from "../../../../db/schema";
import type { AgentTask, TaskBoard, TaskStage, WorkflowCategory } from "../../../../lib/task-types";
import { DEFAULT_COMPUTER, DEFAULT_MODEL, draftProfile, runToolGrants, type AgentProfile } from '../../../../lib/agent-profile';
import type { Agent } from '../../../../lib/types';
import { encryptRunnerSecret } from '../../../../lib/runner-crypto';
import { validateProfile } from '../../../../runtime/profiles';
import runnerInstallSh from '../../../../runtime/installers/install-runner.sh?raw';
import runnerInstallPs1 from '../../../../runtime/installers/install-runner.ps1?raw';
import runnerBundle from '../../../../runtime/runner.mjs?raw';
import hermesDockerfile from '../../../../runtime/hermes/Dockerfile?raw';
import hermesNotice from '../../../../runtime/hermes/NOTICE.md?raw';
import hermesInit from '../../../../runtime/hermes/container-init.sh?raw';
import hermesCoordination from '../../../../runtime/hermes/coordination.mjs?raw';
import hermesInspect from '../../../../runtime/hermes/inspect_runtime.py?raw';
import hermesEntry from '../../../../runtime/hermes/managed_entry.py?raw';
import policyExtension from '../../../../runtime/hermes/extension/open_harness_policy.py?raw';
import policyProject from '../../../../runtime/hermes/extension/pyproject.toml?raw';

export const runtime = "edge";

type Row = Record<string, unknown>;
type RouteContext = { params: Promise<{ path: string[] }> };
const categories: WorkflowCategory[] = ["backlog", "ready", "in_progress", "review", "done"];
const priorities = new Set(["low", "normal", "high", "urgent"]);
const stamp = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const runnerFiles: Record<string,string> = { 'runtime/runner.mjs': runnerBundle, 'runtime/hermes/Dockerfile': hermesDockerfile, 'runtime/hermes/NOTICE.md': hermesNotice, 'runtime/hermes/container-init.sh': hermesInit, 'runtime/hermes/coordination.mjs': hermesCoordination, 'runtime/hermes/inspect_runtime.py': hermesInspect, 'runtime/hermes/managed_entry.py': hermesEntry, 'runtime/hermes/extension/open_harness_policy.py': policyExtension, 'runtime/hermes/extension/pyproject.toml': policyProject };

function database() {
  const db = (env as unknown as { DB?: D1Database }).DB;
  if (!db) throw new HttpError(503, "Task storage is not configured for this site.");
  return db;
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function required(value: unknown, label: string, limit = 240) {
  const text = String(value || "").trim();
  if (!text) throw new HttpError(400, `${label} is required.`);
  return text.slice(0, limit);
}

function array<T>(value: unknown): T[] {
  try { return Array.isArray(value) ? value as T[] : JSON.parse(String(value || "[]")); }
  catch { return []; }
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

async function input(request: Request): Promise<Row> {
  if (request.method === "GET" || request.method === "DELETE") return {};
  try {
    const text = await request.text();
    if (text.length > 30_000_000) throw new HttpError(413, "Request is too large.");
    const value = text ? JSON.parse(text) : {};
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Row;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Invalid request.");
  }
}

async function prepare(db: D1Database) {
  await db.batch([...hostedTaskSchema, ...hostedRuntimeSchema].map(sql => db.prepare(sql)));
  try { await db.prepare('ALTER TABLE machines ADD COLUMN encryption_public_key TEXT').run(); } catch { /* Existing and new databases already have this column after the first migration. */ }
  try { await db.prepare('ALTER TABLE agent_transfers ADD COLUMN pending_profile_json TEXT').run(); } catch { /* Existing and new databases already have this column after the first migration. */ }
  const now = stamp();
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO task_boards(id,name,archived,revision,created_at,updated_at) VALUES(?,?,?,?,?,?)").bind("default-board", "Open Harness", 0, 1, now, now),
    ...categories.map((category, position) => db.prepare("INSERT OR IGNORE INTO task_stages(id,board_id,name,category,position) VALUES(?,?,?,?,?)").bind(`default-${category}`, "default-board", category === "in_progress" ? "In Progress" : category[0].toUpperCase() + category.slice(1), category, position)),
  ]);
}

async function digest(value: string) { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)); return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
function normalizeProfile(input: AgentProfile): AgentProfile { return { ...input, computer: input.computer || { ...DEFAULT_COMPUTER, resources: { ...DEFAULT_COMPUTER.resources } } }; }
function mapMachine(row: Row, assignedAgents = 0) {
  const fresh = row.last_seen_at && Date.now() - Date.parse(String(row.last_seen_at)) < 45_000;
  return { id: String(row.id), name: String(row.name), platform: String(row.platform), arch: String(row.arch), status: row.revoked_at ? 'revoked' : fresh ? 'online' : 'offline', lastSeenAt: row.last_seen_at ? String(row.last_seen_at) : null, local: false, reservedAgentId: row.reserved_agent_id ? String(row.reserved_agent_id) : null, assignedAgents, capabilities: JSON.parse(String(row.capabilities_json || '{}')) };
}
async function machineList(db: D1Database) {
  const profiles = (await db.prepare('SELECT json FROM agent_profiles').all<Row>()).results.map(row => normalizeProfile(JSON.parse(String(row.json))));
  return (await db.prepare('SELECT * FROM machines WHERE revoked_at IS NULL ORDER BY name').all<Row>()).results.map(row => mapMachine(row, profiles.filter(profile => profile.computer.machineId === row.id).length));
}
async function runnerMachine(db: D1Database, request: Request) {
  const machineId = request.headers.get('x-open-harness-machine') || '', token = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
  if (!machineId || !token) return null; const row = await db.prepare('SELECT * FROM machines WHERE id=? AND revoked_at IS NULL').bind(machineId).first<Row>();
  return row && String(row.credential_hash) === await digest(token) ? row : null;
}
async function appendRunEvent(db: D1Database, runId: string, type: string, payload: unknown, eventId = id()) { await db.prepare('INSERT OR IGNORE INTO run_events(id,run_id,type,payload_json,created_at) VALUES(?,?,?,?,?)').bind(eventId, runId, type, JSON.stringify(payload), stamp()).run(); }
async function publicRun(db: D1Database, row: Row) { const machine = await db.prepare('SELECT * FROM machines WHERE id=?').bind(row.machine_id).first<Row>(); return { id: String(row.id), agent_id: String(row.agent_id), conversation_id: String(row.conversation_id), prompt: String(row.prompt), state: String(row.state), machine_id: String(row.machine_id), machine_connection: machine ? mapMachine(machine).status : 'offline', result: row.result ? String(row.result) : null, error: row.error ? String(row.error) : null }; }
async function enqueueRunnerCommand(db: D1Database, machineId: string, agentId: string | null, kind: string, payload: unknown) {
  const commandId = id(); await db.prepare('INSERT INTO runner_commands(id,machine_id,agent_id,kind,payload_json,state,created_at) VALUES(?,?,?,?,?,?,?)').bind(commandId, machineId, agentId, kind, JSON.stringify(payload), 'queued', stamp()).run(); return commandId;
}
async function immutableSnapshot(db: D1Database, runId: string, fallback?: AgentProfile) {
  const stored = await db.prepare('SELECT json FROM run_snapshots WHERE run_id=?').bind(runId).first<Row>();
  if (stored) return JSON.parse(String(stored.json)) as AgentProfile & { effectiveModel: typeof DEFAULT_MODEL; workspaceRevision: number };
  if (!fallback) throw new HttpError(409, 'This run has no configuration snapshot.');
  const snapshot = { ...fallback, allowedTools: runToolGrants(fallback), effectiveModel: fallback.model.inherit ? DEFAULT_MODEL : fallback.model, workspaceRevision: 0 };
  await db.prepare('INSERT OR IGNORE INTO run_snapshots VALUES(?,?,?)').bind(runId, JSON.stringify(snapshot), stamp()).run();
  return snapshot;
}
async function createHostedRun(db: D1Database, profile: AgentProfile, prompt: string, conversationId: string, parentRunId: string | null = null, depth = 0) {
  const runId = id(), now = stamp(), snapshot = { ...profile, allowedTools: runToolGrants(profile), effectiveModel: profile.model.inherit ? DEFAULT_MODEL : profile.model, workspaceRevision: 0 };
  await db.batch([
    db.prepare('INSERT INTO runs(id,agent_id,conversation_id,prompt,state,machine_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').bind(runId, profile.id, conversationId, prompt, 'queued', profile.computer.machineId, now, now),
    db.prepare('INSERT INTO run_snapshots VALUES(?,?,?)').bind(runId, JSON.stringify(snapshot), now),
    db.prepare('INSERT INTO run_relations VALUES(?,?,?)').bind(runId, parentRunId, depth),
  ]);
  await appendRunEvent(db, runId, 'run.queued', { machineId: profile.computer.machineId, parentRunId });
  const run = await db.prepare('SELECT * FROM runs WHERE id=?').bind(runId).first<Row>() as Row;
  await dispatchHostedRun(db, run, profile);
  return await db.prepare('SELECT * FROM runs WHERE id=?').bind(runId).first<Row>() as Row;
}
async function internalRun(db: D1Database, request: Request) {
  const agentId = request.headers.get('x-open-harness-agent') || '', runId = request.headers.get('x-open-harness-run') || '', token = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
  if (!agentId || !runId || !token) return null;
  const credential = await db.prepare('SELECT * FROM run_credentials WHERE run_id=? AND agent_id=?').bind(runId, agentId).first<Row>();
  if (!credential || String(credential.token_hash) !== await digest(token)) return null;
  const run = await db.prepare("SELECT * FROM runs WHERE id=? AND agent_id=? AND state IN ('running','waiting_approval')").bind(runId, agentId).first<Row>();
  if (!run) return null;
  return { run, snapshot: await immutableSnapshot(db, runId) };
}
async function dueRoutines(db: D1Database) {
  const now = stamp(), rows = (await db.prepare('SELECT * FROM hosted_routines WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at LIMIT 10').bind(now).all<Row>()).results;
  for (const routine of rows) {
    const minutes = Math.max(1, Number(routine.interval_minutes)), next = new Date(Date.now() + minutes * 60_000).toISOString();
    const claimed = await db.prepare('UPDATE hosted_routines SET next_run_at=?,updated_at=? WHERE id=? AND enabled=1 AND next_run_at<=?').bind(next, now, routine.id, now).run();
    if (!claimed.meta.changes) continue;
    const profileRow = await db.prepare('SELECT json FROM agent_profiles WHERE id=?').bind(routine.agent_id).first<Row>();
    if (profileRow) await createHostedRun(db, normalizeProfile(JSON.parse(String(profileRow.json))), String(routine.prompt), `routine-${routine.id}-${now}`);
  }
}
async function hostedProbe(db: D1Database, profile: AgentProfile, kind: 'probe-tools' | 'probe-models' | 'probe-runtime', probeInput?: unknown) {
  const machine = await db.prepare('SELECT * FROM machines WHERE id=? AND revoked_at IS NULL').bind(profile.computer.machineId).first<Row>();
  if (!machine || mapMachine(machine).status !== 'online') throw new HttpError(409, 'The selected computer is offline. Reconnect it before checking this setting.');
  const effectiveModel = profile.model.inherit ? DEFAULT_MODEL : profile.model;
  const commandId = await enqueueRunnerCommand(db, profile.computer.machineId, profile.id, kind, { profile: { ...profile, effectiveModel }, input: probeInput, secrets: {}, coordinationToken: '' });
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const command = await db.prepare('SELECT state,result_json FROM runner_commands WHERE id=?').bind(commandId).first<Row>();
    if (command && ['completed','failed'].includes(String(command.state))) { const result = JSON.parse(String(command.result_json || '{}')) as Row; if (command.state === 'failed') throw new HttpError(502, String(result.error || 'The runner check failed.')); return result; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new HttpError(504, 'The runner did not finish this check in time. It may still be reconnecting.');
}
async function activeTransfer(db: D1Database, agentId: string) { return db.prepare("SELECT * FROM agent_transfers WHERE agent_id=? AND state IN ('queued','exporting','importing','verifying') ORDER BY created_at DESC LIMIT 1").bind(agentId).first<Row>(); }
async function beginHostedTransfer(db: D1Database, agentId: string, source: string, destination: string, pendingProfile?: AgentProfile) {
  if (source === destination) throw new HttpError(409, 'This agent is already on that computer.');
  if (await activeTransfer(db, agentId)) throw new HttpError(409, 'This agent is already transferring. Wait for it to finish before changing computers again.');
  const sourceMachine = await db.prepare('SELECT id FROM machines WHERE id=? AND revoked_at IS NULL').bind(source).first<Row>();
  if (!sourceMachine) return;
  const now = stamp(); await db.prepare('INSERT INTO agent_transfers(id,agent_id,source_machine_id,destination_machine_id,state,detail,created_at,updated_at,pending_profile_json) VALUES(?,?,?,?,?,?,?,?,?)').bind(id(), agentId, source, destination, 'queued', 'Waiting for active work to finish.', now, now, pendingProfile ? JSON.stringify(pendingProfile) : null).run();
}
async function startReadyTransfers(db: D1Database, sourceMachineId: string) {
  const transfers = (await db.prepare("SELECT * FROM agent_transfers WHERE source_machine_id=? AND state='queued' ORDER BY created_at LIMIT 10").bind(sourceMachineId).all<Row>()).results;
  for (const transfer of transfers) {
    const busy = await db.prepare("SELECT 1 FROM runs WHERE agent_id=? AND state IN ('running','waiting_approval') LIMIT 1").bind(transfer.agent_id).first(); if (busy) continue;
    const commandId = await enqueueRunnerCommand(db, sourceMachineId, String(transfer.agent_id), 'export-agent', { transferId: transfer.id });
    await db.prepare("UPDATE agent_transfers SET state='exporting',detail='Exporting managed files, memory, and skills.',export_command_id=?,updated_at=? WHERE id=? AND state='queued'").bind(commandId, stamp(), transfer.id).run();
  }
}
async function dispatchHostedRun(db: D1Database, run: Row, profile: AgentProfile) {
  const machine = await db.prepare('SELECT * FROM machines WHERE id=? AND revoked_at IS NULL').bind(profile.computer.machineId).first<Row>();
  if (!machine || !machine.last_seen_at || Date.now() - Date.parse(String(machine.last_seen_at)) >= 45_000) return;
  if (await activeTransfer(db, profile.id)) return;
  if (await db.prepare("SELECT 1 FROM runs WHERE agent_id=? AND id<>? AND state IN ('running','waiting_approval') LIMIT 1").bind(profile.id, run.id).first()) return;
  const activeCount = await db.prepare("SELECT COUNT(*) AS count FROM runs WHERE state IN ('running','waiting_approval')").first<Row>(); if (Number(activeCount?.count || 0) >= 4) return;
  const relation = await db.prepare('SELECT depth FROM run_relations WHERE run_id=?').bind(run.id).first<Row>();
  if (Number(relation?.depth || 0) === 0) { const topLevel = await db.prepare("SELECT COUNT(*) AS count FROM runs JOIN run_relations ON run_relations.run_id=runs.id WHERE run_relations.depth=0 AND runs.state IN ('running','waiting_approval')").first<Row>(); if (Number(topLevel?.count || 0) >= 2) return; }
  const occupants = (await db.prepare("SELECT agent_id FROM runs WHERE machine_id=? AND state IN ('running','waiting_approval')").bind(profile.computer.machineId).all<Row>()).results;
  if (occupants.length >= profile.computer.resources.concurrency) return;
  if (profile.computer.desktop === 'existing') for (const occupant of occupants) { const activeRun = await db.prepare("SELECT id FROM runs WHERE agent_id=? AND machine_id=? AND state IN ('running','waiting_approval') ORDER BY created_at LIMIT 1").bind(occupant.agent_id, profile.computer.machineId).first<Row>(); if (activeRun && (await immutableSnapshot(db, String(activeRun.id))).computer.desktop === 'existing') return; }
  const commandId = id(), created = stamp(), coordinationToken = crypto.randomUUID() + crypto.randomUUID();
  const snapshot = await immutableSnapshot(db, String(run.id), profile);
  await db.batch([
    db.prepare('INSERT INTO runner_commands(id,machine_id,agent_id,kind,payload_json,state,created_at) VALUES(?,?,?,?,?,?,?)').bind(commandId, profile.computer.machineId, profile.id, 'run', JSON.stringify({ runId: run.id, prompt: run.prompt, snapshot, secrets: {}, coordinationToken }), 'queued', created),
    db.prepare('INSERT INTO run_credentials VALUES(?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET agent_id=excluded.agent_id,token_hash=excluded.token_hash,created_at=excluded.created_at').bind(run.id, profile.id, await digest(coordinationToken), created),
    db.prepare("UPDATE runs SET state='running',command_id=?,updated_at=? WHERE id=? AND state='queued'").bind(commandId, created, run.id),
  ]);
  await appendRunEvent(db, String(run.id), 'runner.dispatched', { commandId, machineId: profile.computer.machineId });
}

function mapStage(row: Row): TaskStage {
  return { id: String(row.id), boardId: String(row.board_id), name: String(row.name), category: String(row.category) as WorkflowCategory, position: Number(row.position) };
}

function boardSettings(stages: TaskStage[], raw: unknown) {
  const input = array<Row>(raw)[0] || (() => { try { return JSON.parse(String(raw || '{}')) as Row; } catch { return {}; } })();
  const fallback = (category: WorkflowCategory) => stages.find(stage => stage.category === category)?.id || '';
  const valid = (value: unknown, valueFallback: string) => stages.some(stage => stage.id === value) ? String(value) : valueFallback;
  return { runStageId: valid(input.runStageId, fallback('in_progress')), doneStageId: valid(input.doneStageId, fallback('review')), autoRunOnDrop: input.autoRunOnDrop === undefined ? true : Boolean(input.autoRunOnDrop), allowAgentDispatch: input.allowAgentDispatch === undefined ? true : Boolean(input.allowAgentDispatch) };
}

async function getBoard(db: D1Database, boardId: string): Promise<TaskBoard> {
  const row = await db.prepare("SELECT * FROM task_boards WHERE id=?").bind(boardId).first<Row>();
  if (!row) throw new HttpError(404, "Board not found.");
  const stages = (await db.prepare("SELECT * FROM task_stages WHERE board_id=? ORDER BY position,id").bind(boardId).all<Row>()).results.map(mapStage);
  return { id: String(row.id), name: String(row.name), archived: Boolean(row.archived), revision: Number(row.revision), stages, settings: boardSettings(stages, row.settings_json), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}

async function listBoards(db: D1Database, includeArchived: boolean) {
  const rows = (await db.prepare(`SELECT * FROM task_boards ${includeArchived ? "" : "WHERE archived=0"} ORDER BY created_at,id`).all<Row>()).results;
  return Promise.all(rows.map(row => getBoard(db, String(row.id))));
}

function mapTask(row: Row): AgentTask {
  return {
    id: String(row.id), boardId: String(row.board_id), stageId: String(row.stage_id), title: String(row.title), description: String(row.description || ""),
    ownerAgentId: row.owner_agent_id ? String(row.owner_agent_id) : null, collaboratorAgentIds: array<string>(row.collaborators_json),
    priority: String(row.priority) as AgentTask["priority"], labels: array<string>(row.labels_json), dueAt: row.due_at ? String(row.due_at) : null,
    position: Number(row.position), archived: Boolean(row.archived), revision: Number(row.revision), activeRunId: row.active_run_id ? String(row.active_run_id) : null, runState: row.run_state ? String(row.run_state) as AgentTask['runState'] : null,
    checklist: array<AgentTask["checklist"][number]>(row.checklist_json), comments: array<AgentTask["comments"][number]>(row.comments_json),
    activity: array<AgentTask["activity"][number]>(row.activity_json), runs: [], createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

async function getTask(db: D1Database, taskId: string) {
  const row = await db.prepare("SELECT tasks.*,runs.state AS run_state FROM tasks LEFT JOIN runs ON runs.id=tasks.active_run_id WHERE tasks.id=?").bind(taskId).first<Row>();
  if (!row) throw new HttpError(404, "Task not found.");
  return mapTask(row);
}

async function listTasks(db: D1Database, includeArchived: boolean) {
  const where = includeArchived ? "" : "WHERE tasks.archived=0 AND task_boards.archived=0";
  const rows = (await db.prepare(`SELECT tasks.*,runs.state AS run_state FROM tasks JOIN task_boards ON task_boards.id=tasks.board_id LEFT JOIN runs ON runs.id=tasks.active_run_id ${where} ORDER BY tasks.position,tasks.created_at`).all<Row>()).results;
  return rows.map(mapTask);
}

function cleanChecklist(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((entry, position) => {
    const item = entry as Row;
    return { id: String(item.id || id()), text: String(item.text || "").trim().slice(0, 500), done: Boolean(item.done), position };
  }).filter(item => item.text);
}

function cleanStrings(value: unknown, count: number, limit: number) {
  return Array.isArray(value) ? [...new Set(value.map(item => String(item).trim()).filter(Boolean))].slice(0, count).map(item => item.slice(0, limit)) : [];
}

async function createBoard(db: D1Database, body: Row) {
  const boardId = id(), now = stamp(), name = required(body.name, "Board name");
  await db.batch([
    db.prepare("INSERT INTO task_boards(id,name,archived,revision,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").bind(boardId, name, 0, 1, '{}', now, now),
    ...categories.map((category, position) => db.prepare("INSERT INTO task_stages(id,board_id,name,category,position) VALUES(?,?,?,?,?)").bind(id(), boardId, category === "in_progress" ? "In Progress" : category[0].toUpperCase() + category.slice(1), category, position)),
  ]);
  return getBoard(db, boardId);
}

async function createTask(db: D1Database, body: Row) {
  const board = await getBoard(db, required(body.boardId, "Board"));
  if (board.archived) throw new HttpError(409, "Restore this board before adding tasks.");
  const stageId = String(body.stageId || board.stages.find(stage => stage.category === "backlog")?.id || "");
  if (!board.stages.some(stage => stage.id === stageId)) throw new HttpError(400, "Stage is not on this board.");
  const priority = priorities.has(String(body.priority)) ? String(body.priority) : "normal";
  const position = Number((await db.prepare("SELECT COALESCE(MAX(position),-1)+1 AS next FROM tasks WHERE stage_id=?").bind(stageId).first<Row>())?.next || 0);
  const taskId = id(), now = stamp();
  const activity = [{ id: id(), type: "created", detail: "Task created", createdAt: now }];
  await db.prepare(`INSERT INTO tasks(id,board_id,stage_id,title,description,owner_agent_id,priority,due_at,position,archived,revision,collaborators_json,labels_json,checklist_json,comments_json,activity_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(taskId, board.id, stageId, required(body.title, "Task title"), String(body.description || "").slice(0, 20_000), body.ownerAgentId || null, priority, body.dueAt || null, position, 0, 1, JSON.stringify(cleanStrings(body.collaboratorAgentIds, 25, 120)), JSON.stringify(cleanStrings(body.labels, 20, 40)), JSON.stringify(cleanChecklist(body.checklist)), "[]", JSON.stringify(activity), now, now).run();
  return getTask(db, taskId);
}

async function updateTask(db: D1Database, taskId: string, body: Row) {
  const task = await getTask(db, taskId);
  if (Number(body.revision) !== task.revision) throw new HttpError(409, "This task changed elsewhere. Refresh and try again.");
  const boardId = body.boardId === undefined ? task.boardId : String(body.boardId);
  const board = await getBoard(db, boardId);
  const stageId = body.stageId === undefined ? task.stageId : String(body.stageId);
  if (!board.stages.some(stage => stage.id === stageId)) throw new HttpError(400, "Stage is not on this board.");
  const priority = body.priority === undefined ? task.priority : String(body.priority);
  if (!priorities.has(priority)) throw new HttpError(400, "Invalid task priority.");
  const now = stamp();
  const activity = [{ id: id(), type: "updated", detail: "Task details updated", createdAt: now }, ...task.activity].slice(0, 200);
  const collaborators = body.collaboratorAgentIds === undefined ? task.collaboratorAgentIds : cleanStrings(body.collaboratorAgentIds, 25, 120);
  const labels = body.labels === undefined ? task.labels : cleanStrings(body.labels, 20, 40);
  const checklist = body.checklist === undefined ? task.checklist : cleanChecklist(body.checklist);
  const result = await db.prepare(`UPDATE tasks SET board_id=?,stage_id=?,title=?,description=?,owner_agent_id=?,priority=?,due_at=?,position=?,archived=?,revision=revision+1,collaborators_json=?,labels_json=?,checklist_json=?,activity_json=?,updated_at=? WHERE id=? AND revision=?`).bind(
    boardId, stageId, body.title === undefined ? task.title : required(body.title, "Task title"), body.description === undefined ? task.description : String(body.description).slice(0, 20_000), body.ownerAgentId === undefined ? task.ownerAgentId : body.ownerAgentId || null, priority, body.dueAt === undefined ? task.dueAt : body.dueAt || null, body.position === undefined ? task.position : Number(body.position), body.archived === undefined ? Number(task.archived) : Number(Boolean(body.archived)), JSON.stringify(collaborators), JSON.stringify(labels), JSON.stringify(checklist), JSON.stringify(activity), now, taskId, task.revision,
  ).run();
  if (!result.meta.changes) throw new HttpError(409, "This task changed elsewhere. Refresh and try again.");
  return getTask(db, taskId);
}

async function commentTask(db: D1Database, taskId: string, body: Row) {
  const task = await getTask(db, taskId), now = stamp();
  const comments = [...task.comments, { id: id(), body: required(body.body, "Comment", 5_000), author: String(body.author || 'you').slice(0, 80), createdAt: now }];
  const activity = [{ id: id(), type: "commented", detail: "Comment added", createdAt: now }, ...task.activity].slice(0, 200);
  await db.prepare("UPDATE tasks SET comments_json=?,activity_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?").bind(JSON.stringify(comments), JSON.stringify(activity), now, taskId, task.revision).run();
  return getTask(db, taskId);
}

async function startTask(db: D1Database, taskId: string, body: Row) {
  const task = await getTask(db, taskId), key = required(body.idempotencyKey, 'Idempotency key', 200);
  const existing = await db.prepare('SELECT run_id FROM task_runs WHERE idempotency_key=?').bind(`${taskId}:${key}`).first<Row>();
  if (existing) return { task: await getTask(db, taskId), run: await publicRun(db, await db.prepare('SELECT * FROM runs WHERE id=?').bind(existing.run_id).first<Row>() as Row) };
  if (task.activeRunId && ['queued', 'running', 'waiting_approval', 'waiting_input'].includes(task.runState || '')) throw new HttpError(409, 'This task already has an active run.');
  if (!task.ownerAgentId) throw new HttpError(400, 'Assign an owner before starting this task.');
  if (body.revision !== undefined && Number(body.revision) !== task.revision) throw new HttpError(409, 'This task changed elsewhere. Refresh and try again.');
  const board = await getBoard(db, task.boardId), runStage = board.stages.find(stage => stage.id === board.settings.runStageId);
  if (!runStage) throw new HttpError(400, 'This board needs a run stage.');
  const profileRow = await db.prepare('SELECT json FROM agent_profiles WHERE id=?').bind(task.ownerAgentId).first<Row>();
  if (!profileRow) throw new HttpError(404, 'Task owner profile not found.');
  const checklist = task.checklist.map(item => `- [${item.done ? 'x' : ' '}] ${item.text}`).join('\n');
  const comments = task.comments.slice(-3).map(comment => `- ${comment.author || 'you'}: ${comment.body}`).join('\n');
  const prompt = [`You are completing board task ${task.id}: ${task.title}`, `Stage: ${runStage.name}`, `Priority: ${task.priority}`, task.dueAt && `Due: ${task.dueAt}`, task.description && `Brief:\n${task.description}`, checklist && `Checklist:\n${checklist}`, comments && `Recent comments:\n${comments}`, body.feedback && `Requested changes:\n${String(body.feedback)}`, 'Work independently. Do not move this card; successful work is sent for review automatically. End with a short report for the card.'].filter(Boolean).join('\n\n');
  const run = await createHostedRun(db, normalizeProfile(JSON.parse(String(profileRow.json))), prompt, `task-${task.id}-${id()}`);
  const attempt = Number((await db.prepare('SELECT COALESCE(MAX(attempt),0)+1 AS attempt FROM task_runs WHERE task_id=?').bind(taskId).first<Row>())?.attempt || 1);
  const now = stamp();
  await db.batch([
    db.prepare('INSERT INTO task_runs(task_id,run_id,attempt,idempotency_key,started_at) VALUES(?,?,?,?,?)').bind(taskId, run.id, attempt, `${taskId}:${key}`, now),
    db.prepare('UPDATE tasks SET stage_id=?,active_run_id=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').bind(runStage.id, run.id, now, taskId, task.revision),
  ]);
  return { task: await getTask(db, taskId), run: await publicRun(db, run) };
}

async function syncHostedTaskRun(db: D1Database, runId: string) {
  const link = await db.prepare('SELECT task_id FROM task_runs WHERE run_id=?').bind(runId).first<Row>();
  if (!link) return;
  const run = await db.prepare('SELECT * FROM runs WHERE id=?').bind(runId).first<Row>();
  if (!run || !['completed', 'failed', 'interrupted', 'cancelled'].includes(String(run.state))) return;
  const task = await getTask(db, String(link.task_id));
  if (task.activeRunId !== runId) return;
  const now = stamp(), activity = [{ id: id(), type: `run_${run.state}`, detail: run.state === 'completed' ? 'Agent finished; moved to review' : String(run.error || `Run ${run.state}`), createdAt: now }, ...task.activity].slice(0, 200);
  const comments = run.result ? [...task.comments, { id: id(), body: String(run.result).slice(-8000), author: 'agent', createdAt: now }] : task.comments;
  const board = await getBoard(db, task.boardId), doneStage = board.stages.find(stage => stage.id === board.settings.doneStageId);
  await db.prepare('UPDATE tasks SET stage_id=?,active_run_id=NULL,comments_json=?,activity_json=?,revision=revision+1,updated_at=? WHERE id=? AND active_run_id=?').bind(run.state === 'completed' && doneStage ? doneStage.id : task.stageId, JSON.stringify(comments), JSON.stringify(activity), now, task.id, runId).run();
}

async function approveTask(db: D1Database, taskId: string, body: Row) {
  const task = await getTask(db, taskId);
  if (body.revision !== undefined && Number(body.revision) !== task.revision) throw new HttpError(409, "This task changed elsewhere. Refresh and try again.");
  const board = await getBoard(db, task.boardId), done = board.stages.find(stage => stage.category === "done");
  if (!done) throw new HttpError(400, "This board needs a Done stage.");
  const now = stamp(), activity = [{ id: id(), type: "approved", detail: "Task approved and marked done", createdAt: now }, ...task.activity].slice(0, 200);
  await db.prepare("UPDATE tasks SET stage_id=?,activity_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?").bind(done.id, JSON.stringify(activity), now, taskId, task.revision).run();
  return getTask(db, taskId);
}

async function updateBoard(db: D1Database, boardId: string, body: Row) {
  const board = await getBoard(db, boardId);
  if (Number(body.revision) !== board.revision) throw new HttpError(409, "This board changed elsewhere. Refresh and try again.");
  const settings = body.settings === undefined ? board.settings : boardSettings(board.stages, JSON.stringify({ ...board.settings, ...(body.settings as Row) }));
  const result = await db.prepare("UPDATE task_boards SET name=?,archived=?,settings_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?").bind(body.name === undefined ? board.name : required(body.name, "Board name"), body.archived === undefined ? Number(board.archived) : Number(Boolean(body.archived)), JSON.stringify(settings), stamp(), boardId, board.revision).run();
  if (!result.meta.changes) throw new HttpError(409, "This board changed elsewhere. Refresh and try again.");
  return getBoard(db, boardId);
}

async function addStage(db: D1Database, boardId: string, body: Row) {
  await getBoard(db, boardId);
  const category = categories.includes(String(body.category) as WorkflowCategory) ? String(body.category) : "backlog";
  const position = Number((await db.prepare("SELECT COALESCE(MAX(position),-1)+1 AS next FROM task_stages WHERE board_id=?").bind(boardId).first<Row>())?.next || 0);
  const now = stamp();
  await db.batch([
    db.prepare("INSERT INTO task_stages(id,board_id,name,category,position) VALUES(?,?,?,?,?)").bind(id(), boardId, required(body.name, "Stage name", 100), category, position),
    db.prepare("UPDATE task_boards SET revision=revision+1,updated_at=? WHERE id=?").bind(now, boardId),
  ]);
  return getBoard(db, boardId);
}

async function updateStage(db: D1Database, stageId: string, body: Row) {
  const row = await db.prepare("SELECT * FROM task_stages WHERE id=?").bind(stageId).first<Row>();
  if (!row) throw new HttpError(404, "Stage not found.");
  const category = body.category === undefined ? String(row.category) : String(body.category);
  if (!categories.includes(category as WorkflowCategory)) throw new HttpError(400, "Invalid workflow category.");
  const boardId = String(row.board_id), now = stamp();
  await db.batch([
    db.prepare("UPDATE task_stages SET name=?,category=?,position=? WHERE id=?").bind(body.name === undefined ? row.name : required(body.name, "Stage name", 100), category, body.position === undefined ? row.position : Number(body.position), stageId),
    db.prepare("UPDATE task_boards SET revision=revision+1,updated_at=? WHERE id=?").bind(now, boardId),
  ]);
  return getBoard(db, boardId);
}

async function removeStage(db: D1Database, stageId: string, moveToStageId: string | null) {
  const row = await db.prepare("SELECT * FROM task_stages WHERE id=?").bind(stageId).first<Row>();
  if (!row) throw new HttpError(404, "Stage not found.");
  const boardId = String(row.board_id), category = String(row.category);
  if (["in_progress", "review", "done"].includes(category)) {
    const count = Number((await db.prepare("SELECT COUNT(*) AS count FROM task_stages WHERE board_id=? AND category=?").bind(boardId, category).first<Row>())?.count || 0);
    if (count <= 1) throw new HttpError(409, `Keep at least one ${category.replaceAll("_", " ")} stage for automation.`);
  }
  const taskCount = Number((await db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE stage_id=?").bind(stageId).first<Row>())?.count || 0);
  let target: Row | null = null;
  if (moveToStageId) target = await db.prepare("SELECT * FROM task_stages WHERE id=? AND board_id=?").bind(moveToStageId, boardId).first<Row>();
  if (taskCount && !target) throw new HttpError(409, "Move this stage's tasks to another stage before removing it.");
  const statements = [];
  if (taskCount && target) statements.push(db.prepare("UPDATE tasks SET stage_id=?,revision=revision+1,updated_at=? WHERE stage_id=?").bind(String(target.id), stamp(), stageId));
  statements.push(db.prepare("DELETE FROM task_stages WHERE id=?").bind(stageId));
  statements.push(db.prepare("UPDATE task_boards SET revision=revision+1,updated_at=? WHERE id=?").bind(stamp(), boardId));
  await db.batch(statements);
  return getBoard(db, boardId);
}

async function handler(request: Request, context: RouteContext) {
  try {
    const db = database();
    await prepare(db);
    const { path } = await context.params;
    const pathname = `/${path.join("/")}`, url = new URL(request.url), body = await input(request);
    if (request.method === 'GET' && pathname === '/v1/install/runner.sh') return new Response(runnerInstallSh, { headers: { 'Content-Type': 'text/x-shellscript; charset=utf-8', 'Cache-Control': 'no-store' } });
    if (request.method === 'GET' && pathname === '/v1/install/runner.ps1') return new Response(runnerInstallPs1, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    if (request.method === 'GET' && pathname === '/v1/install/file') { const file = runnerFiles[String(url.searchParams.get('path') || '')]; if (!file) throw new HttpError(404, 'Runner file not found.'); return new Response(file, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' } }); }
    const runnerFacing = pathname === '/v1/runner/pair' || pathname.startsWith('/v1/runner/') || pathname.startsWith('/internal/') || pathname.startsWith('/v1/install/');
    if (!runnerFacing && !request.headers.get('oai-authenticated-user-id')) throw new HttpError(401, 'Sign in to manage this workspace.');

    if (pathname === "/v1/bootstrap" && request.method === "GET") return json({ token: "hosted-site", runtime: { available: true, version: 'runner', message: "Connect a computer to run agents from this hosted dashboard." }, version: "0.3.0", hermes: { release: "v2026.9.11", commit: "939e45c91d751fadd94dcd1b873ac3cb44846213" } });
    if ((pathname === '/internal/handoff' || pathname === '/internal/schedule') && request.method === 'POST') {
      const scoped = await internalRun(db, request); if (!scoped) throw new HttpError(401, 'Invalid or expired run credential.');
      const tool = pathname === '/internal/handoff' ? 'mcp_open_harness_delegate_named_agent' : 'mcp_open_harness_create_open_harness_routine';
      if (!scoped.snapshot.allowedTools.includes(tool)) throw new HttpError(403, pathname === '/internal/handoff' ? 'Delegation is disabled for this run.' : 'Scheduling is disabled for this run.');
      if (pathname === '/internal/schedule') {
        const routineId = id(), now = stamp(), minutes = Math.max(1, Math.min(525_600, Number(body.intervalMinutes || 60))), next = new Date(Date.now() + minutes * 60_000).toISOString();
        await db.prepare('INSERT INTO hosted_routines VALUES(?,?,?,?,?,?,?,?,?,?)').bind(routineId, scoped.run.agent_id, required(body.name, 'Routine name'), required(body.prompt, 'Routine prompt', 20_000), minutes, String(body.timezone || 'UTC').slice(0, 100), 1, next, now, now).run();
        return json({ id: routineId, nextRunAt: next }, 201);
      }
      const relation = await db.prepare('SELECT * FROM run_relations WHERE run_id=?').bind(scoped.run.id).first<Row>(), depth = Number(relation?.depth || 0);
      if (depth >= 2) throw new HttpError(409, 'Delegation depth is limited to two.');
      const targetId = required(body.agentId, 'Target agent'), ancestors = new Set<string>([String(scoped.run.agent_id)]); let parentId = relation?.parent_run_id ? String(relation.parent_run_id) : '';
      while (parentId) { const parent = await db.prepare('SELECT agent_id FROM runs WHERE id=?').bind(parentId).first<Row>(); if (parent) ancestors.add(String(parent.agent_id)); const parentRelation = await db.prepare('SELECT parent_run_id FROM run_relations WHERE run_id=?').bind(parentId).first<Row>(); parentId = parentRelation?.parent_run_id ? String(parentRelation.parent_run_id) : ''; }
      if (ancestors.has(targetId)) throw new HttpError(409, 'This handoff would create an agent cycle.');
      const target = await db.prepare('SELECT json FROM agent_profiles WHERE id=?').bind(targetId).first<Row>(); if (!target) throw new HttpError(404, 'Target agent not found.');
      const child = await createHostedRun(db, normalizeProfile(JSON.parse(String(target.json))), required(body.prompt, 'Handoff prompt', 20_000), String(scoped.run.conversation_id), String(scoped.run.id), depth + 1);
      await appendRunEvent(db, String(scoped.run.id), 'handoff.created', { childRunId: child.id, targetAgentId: targetId, prompt: body.prompt });
      return json({ runId: child.id, state: child.state }, 202);
    }
    if (pathname === '/v1/runner/pair' && request.method === 'POST') {
      const code = String(body.code || ''), pairing = await db.prepare('SELECT * FROM machine_pairings WHERE code_hash=?').bind(await digest(code)).first<Row>();
      if (!pairing || pairing.used_at || Date.parse(String(pairing.expires_at)) <= Date.now()) throw new HttpError(410, 'This pairing code is invalid, expired, or already used.');
      const machineId = `machine-${id()}`, token = crypto.randomUUID() + crypto.randomUUID(), now = stamp();
      const encryptionPublicKey = String(body.encryptionPublicKey || '');
      if (encryptionPublicKey) { try { const key = JSON.parse(encryptionPublicKey) as Row; if (key.kty !== 'RSA' || key.alg && key.alg !== 'RSA-OAEP-256') throw new Error(); } catch { throw new HttpError(400, 'The runner supplied an invalid encryption key.'); } }
      const used = await db.prepare('UPDATE machine_pairings SET used_at=? WHERE id=? AND used_at IS NULL').bind(now, pairing.id).run(); if (!used.meta.changes) throw new HttpError(409, 'This pairing code was already used.');
      await db.prepare('INSERT INTO machines(id,name,platform,arch,status,last_seen_at,reserved_agent_id,capabilities_json,credential_hash,revoked_at,created_at,updated_at,encryption_public_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(machineId, String(body.name || pairing.name).slice(0,80), String(body.platform || pairing.platform), String(body.arch || 'unknown'), 'online', now, null, JSON.stringify(body.capabilities || {}), await digest(token), null, now, now, encryptionPublicKey || null).run();
      return json({ machineId, token, machine: mapMachine({ id: machineId, name: body.name || pairing.name, platform: body.platform || pairing.platform, arch: body.arch || 'unknown', last_seen_at: now, capabilities_json: JSON.stringify(body.capabilities || {}) }) }, 201);
    }
    if (pathname.startsWith('/v1/runner/')) {
      const runner = await runnerMachine(db, request); if (!runner) throw new HttpError(401, 'Invalid or revoked runner credential.'); const machineId = String(runner.id);
      if (pathname === '/v1/runner/heartbeat' && request.method === 'POST') {
        const now = stamp(); await db.prepare("UPDATE machines SET status='online',last_seen_at=?,capabilities_json=?,encryption_public_key=COALESCE(?,encryption_public_key),updated_at=? WHERE id=?").bind(now, JSON.stringify(body.capabilities || {}), body.encryptionPublicKey ? String(body.encryptionPublicKey) : null, now, machineId).run();
        const activeIds = new Set(Array.isArray(body.activeCommandIds) ? body.activeCommandIds.map(String) : []), cutoff = new Date(Date.now() - 45_000).toISOString(), leased = (await db.prepare("SELECT * FROM runner_commands WHERE machine_id=? AND state='leased' AND leased_at<?").bind(machineId, cutoff).all<Row>()).results.filter(command => !activeIds.has(String(command.id)));
        for (const command of leased) {
          const error = 'Runner restarted after accepting this work. Completed events were preserved and the task was not replayed.', run = await db.prepare('SELECT id FROM runs WHERE command_id=?').bind(command.id).first<Row>();
          await db.batch([db.prepare("UPDATE runner_commands SET state='failed',finished_at=?,result_json=? WHERE id=? AND state='leased'").bind(now, JSON.stringify({ error, interrupted: true }), command.id), db.prepare("UPDATE runs SET state='interrupted',error=?,updated_at=? WHERE command_id=? AND state NOT IN ('completed','failed','cancelled','interrupted')").bind(error, now, command.id), ...(run ? [db.prepare('DELETE FROM run_credentials WHERE run_id=?').bind(run.id)] : [])]);
          if (run) await appendRunEvent(db, String(run.id), 'run.interrupted', { error });
          if (command.kind === 'export-agent' || command.kind === 'import-agent') {
            const column = command.kind === 'export-agent' ? 'export_command_id' : 'import_command_id', transfer = await db.prepare(`SELECT * FROM agent_transfers WHERE ${column}=? AND state IN ('exporting','importing','verifying')`).bind(command.id).first<Row>();
            if (transfer) await db.batch([db.prepare("UPDATE agent_transfers SET state='failed',detail=?,updated_at=? WHERE id=?").bind(`${error} Source assignment and data were preserved.`, now, transfer.id), db.prepare('UPDATE machines SET reserved_agent_id=NULL,updated_at=? WHERE id=? AND reserved_agent_id=?').bind(now, transfer.destination_machine_id, transfer.agent_id)]);
          }
        }
        const queued = (await db.prepare("SELECT * FROM runs WHERE machine_id=? AND state='queued' ORDER BY created_at LIMIT 10").bind(machineId).all<Row>()).results;
        for (const run of queued) { const row = await db.prepare('SELECT json FROM agent_profiles WHERE id=?').bind(run.agent_id).first<Row>(); if (row) await dispatchHostedRun(db, run, normalizeProfile(JSON.parse(String(row.json)))); }
        await dueRoutines(db);
        await startReadyTransfers(db, machineId);
        return json(mapMachine({ ...runner, last_seen_at: now, capabilities_json: JSON.stringify(body.capabilities || {}) }));
      }
      if (pathname === '/v1/runner/commands' && request.method === 'GET') {
        const rows = (await db.prepare("SELECT * FROM runner_commands WHERE machine_id=? AND state='queued' ORDER BY created_at LIMIT 10").bind(machineId).all<Row>()).results, now = stamp();
        const claimed: Row[] = [];
        for (const row of rows) { const result = await db.prepare("UPDATE runner_commands SET state='leased',leased_at=? WHERE id=? AND machine_id=? AND state='queued'").bind(now, row.id, machineId).run(); if (result.meta.changes) claimed.push(row); }
        return json({ commands: claimed.map(row => ({ id: row.id, agentId: row.agent_id, kind: row.kind, payload: JSON.parse(String(row.payload_json)), createdAt: row.created_at })) });
      }
      const runnerTransfer = pathname.match(/^\/v1\/runner\/transfers\/([^/]+)$/);
      if (runnerTransfer && request.method === 'GET') {
        const transfer = await db.prepare("SELECT * FROM agent_transfers WHERE id=? AND destination_machine_id=? AND state IN ('importing','verifying')").bind(runnerTransfer[1], machineId).first<Row>(); if (!transfer) throw new HttpError(404, 'Transfer bundle not found.');
        const chunks = (await db.prepare('SELECT data FROM transfer_chunks WHERE transfer_id=? ORDER BY position').bind(transfer.id).all<Row>()).results; return json({ bundle: JSON.parse(chunks.map(chunk => String(chunk.data)).join('')) });
      }
      const runnerCommand = pathname.match(/^\/v1\/runner\/commands\/([^/]+)\/(events|complete)$/);
      if (runnerCommand && request.method === 'POST') {
        const command = await db.prepare('SELECT * FROM runner_commands WHERE id=? AND machine_id=?').bind(runnerCommand[1], machineId).first<Row>(); if (!command) throw new HttpError(404, 'Runner command not found.');
        if (runnerCommand[2] === 'events') { const received = await db.prepare('INSERT OR IGNORE INTO runner_event_receipts VALUES(?,?,?)').bind(command.id, required(body.eventId, 'Event ID'), stamp()).run(); if (received.meta.changes) { const event = body.event as Row || {}, eventType = String(event.type || 'runtime.event'), eventPayload = (event.payload || event) as Row; if (eventType === 'approval.request') { const approvalId = id(), requestId = String(eventPayload.request_id || eventPayload.id || ''); await db.prepare('INSERT INTO approvals VALUES(?,?,?,?,?,NULL)').bind(approvalId, body.runId, requestId, 'pending', stamp()).run(); await appendRunEvent(db, String(body.runId), eventType, { ...eventPayload, approvalId }, String(body.eventId)); await db.prepare("UPDATE runs SET state='waiting_approval',updated_at=? WHERE id=?").bind(stamp(), body.runId).run(); } else await appendRunEvent(db, String(body.runId), eventType, eventPayload, String(body.eventId)); } return json({ ok: true }); }
        if (['completed','failed'].includes(String(command.state))) return json({ ok: true, duplicate: true });
        const result = body.result as Row | undefined, error = body.error ? String(body.error) : null, now = stamp();
        if (command.kind === 'store-secret') {
          const payload = JSON.parse(String(command.payload_json)) as Row, name = String(payload.name || '');
          await db.prepare('UPDATE runner_commands SET state=?,finished_at=?,result_json=? WHERE id=?').bind(error ? 'failed' : 'completed', now, JSON.stringify(result || { error }), command.id).run();
          if (!error && name) await db.prepare('INSERT INTO machine_secrets(machine_id,name,updated_at) VALUES(?,?,?) ON CONFLICT(machine_id,name) DO UPDATE SET updated_at=excluded.updated_at').bind(machineId, name, now).run();
          return json({ ok: true });
        }
        if (command.kind === 'export-agent') {
          const transfer = await db.prepare('SELECT * FROM agent_transfers WHERE export_command_id=?').bind(command.id).first<Row>();
          await db.prepare('UPDATE runner_commands SET state=?,finished_at=?,result_json=? WHERE id=?').bind(error ? 'failed' : 'completed', now, JSON.stringify(error ? { error } : { exported: true }), command.id).run();
          if (!transfer) return json({ ok: true });
          if (error || !result || !Array.isArray(result.files) || !result.checksum) { await db.prepare("UPDATE agent_transfers SET state='failed',detail=?,updated_at=? WHERE id=?").bind(`${error || 'The source runner returned an invalid transfer bundle.'} Source data was preserved.`, now, transfer.id).run(); return json({ ok: true }); }
          const encoded = JSON.stringify(result), chunks = Array.from({ length: Math.ceil(encoded.length / 80_000) }, (_, position) => ({ position, data: encoded.slice(position * 80_000, (position + 1) * 80_000) }));
          await db.prepare('DELETE FROM transfer_chunks WHERE transfer_id=?').bind(transfer.id).run(); for (let offset = 0; offset < chunks.length; offset += 50) await db.batch(chunks.slice(offset, offset + 50).map(chunk => db.prepare('INSERT INTO transfer_chunks VALUES(?,?,?)').bind(transfer.id, chunk.position, chunk.data)));
          const pending = transfer.pending_profile_json ? validateProfile(JSON.parse(String(transfer.pending_profile_json))) : null;
          const effective = pending?.model.inherit ? DEFAULT_MODEL : pending?.model;
          const requiredSecrets = pending ? [effective?.credentialRef || '', ...pending.connectors.filter(item => item.enabled).map(item => item.secretRef)].filter(Boolean) : [];
          const importCommandId = await enqueueRunnerCommand(db, String(transfer.destination_machine_id), String(transfer.agent_id), 'import-agent', { transferId: transfer.id, profile: pending, requiredSecrets }); await db.prepare("UPDATE agent_transfers SET state='importing',detail='Checking the destination and importing data.',import_command_id=?,checksum=?,updated_at=? WHERE id=?").bind(importCommandId, result.checksum, now, transfer.id).run(); return json({ ok: true });
        }
        if (command.kind === 'import-agent') {
          const transfer = await db.prepare('SELECT * FROM agent_transfers WHERE import_command_id=?').bind(command.id).first<Row>(); await db.prepare('UPDATE runner_commands SET state=?,finished_at=?,result_json=? WHERE id=?').bind(error ? 'failed' : 'completed', now, JSON.stringify(result || { error }), command.id).run();
          if (transfer) {
            const verified = !error && result && result.validated === true && String(result.checksum) === String(transfer.checksum), pending = transfer.pending_profile_json ? validateProfile(JSON.parse(String(transfer.pending_profile_json))) : null;
            if (verified && pending) await db.batch([
              db.prepare('UPDATE agent_profiles SET revision=?,json=?,updated_at=? WHERE id=?').bind(pending.revision, JSON.stringify(pending), now, transfer.agent_id),
              db.prepare('UPDATE machines SET reserved_agent_id=NULL,updated_at=? WHERE id=? AND reserved_agent_id=?').bind(now, transfer.source_machine_id, transfer.agent_id),
              db.prepare('UPDATE machines SET reserved_agent_id=?,updated_at=? WHERE id=?').bind(pending.computer.reserveMachine ? transfer.agent_id : null, now, transfer.destination_machine_id),
            ]);
            if (!verified) await db.prepare('UPDATE machines SET reserved_agent_id=NULL,updated_at=? WHERE id=? AND reserved_agent_id=?').bind(now, transfer.destination_machine_id, transfer.agent_id).run();
            await db.prepare('UPDATE agent_transfers SET state=?,detail=?,updated_at=? WHERE id=?').bind(verified ? 'completed' : 'failed', verified ? `Transfer verified (${Number(result?.files || 0)} files). Assignment switched; source data was preserved.` : `${error || 'Destination checksum did not match the source.'} Source assignment and data were preserved.`, now, transfer.id).run(); if (verified) await db.prepare('DELETE FROM transfer_chunks WHERE transfer_id=?').bind(transfer.id).run();
          } return json({ ok: true });
        }
        if (command.kind === 'stop') { const payload = JSON.parse(String(command.payload_json)) as Row; await db.batch([db.prepare('UPDATE runner_commands SET state=?,finished_at=?,result_json=? WHERE id=?').bind(error ? 'failed' : 'completed', now, JSON.stringify(result || { error }), command.id), db.prepare("UPDATE runs SET state=?,error=?,updated_at=? WHERE id=? AND state IN ('running','waiting_approval')").bind(error ? 'failed' : 'cancelled', error, now, payload.runId), db.prepare('DELETE FROM run_credentials WHERE run_id=?').bind(payload.runId)]); await appendRunEvent(db, String(payload.runId), error ? 'run.failed' : 'run.cancelled', error ? { error } : { source: 'runner' }); return json({ ok: true }); }
        const run = await db.prepare('SELECT id FROM runs WHERE command_id=?').bind(command.id).first<Row>();
        await db.batch([db.prepare('UPDATE runner_commands SET state=?,finished_at=?,result_json=? WHERE id=?').bind(error ? 'failed' : 'completed', now, JSON.stringify(result || { error }), command.id), db.prepare('UPDATE runs SET state=?,result=?,error=?,updated_at=? WHERE command_id=?').bind(error ? 'failed' : 'completed', result ? String(result.text || result.final_response || result.message || '') : null, error, now, command.id), ...(run ? [db.prepare('DELETE FROM run_credentials WHERE run_id=?').bind(run.id)] : [])]);
        if (run) await syncHostedTaskRun(db, String(run.id));
        if (run) { await appendRunEvent(db, String(run.id), error ? 'run.failed' : 'run.completed', error ? { error } : { result }); const relation = await db.prepare('SELECT parent_run_id FROM run_relations WHERE run_id=?').bind(run.id).first<Row>(); if (relation?.parent_run_id) await appendRunEvent(db, String(relation.parent_run_id), 'handoff.completed', { childRunId: run.id, state: error ? 'failed' : 'completed' }); } return json({ ok: true });
      }
      throw new HttpError(404, 'Runner endpoint not found.');
    }
    if (pathname === "/v1/agents/sync" && request.method === "POST") {
      const agents = Array.isArray(body.agents) ? body.agents as Agent[] : [], now = stamp();
      for (const agent of agents) { const existing = await db.prepare('SELECT 1 FROM agent_profiles WHERE id=?').bind(agent.id).first(); if (!existing) { const profile = draftProfile(agent); await db.prepare('INSERT INTO agent_profiles VALUES(?,?,?,?)').bind(profile.id, 1, JSON.stringify({ ...profile, revision: 1 }), now).run(); } }
      const rows = (await db.prepare('SELECT json FROM agent_profiles ORDER BY updated_at').all<Row>()).results; return json({ agents: rows.map(row => { const profile = normalizeProfile(JSON.parse(String(row.json))); return { id: profile.id, name: profile.name, role: profile.role, description: profile.description, tone: profile.tone, instructions: profile.prompt.text, memory: [], profile }; }) });
    }
    if (pathname === "/v1/migrate" && request.method === "POST") return json({ migrated: false, reason: "hosted" });
    if (pathname === '/v1/health' && request.method === 'GET') return json({ ok: true, runtime: { available: true, message: 'Hosted coordinator is ready.' }, activeRuns: Number((await db.prepare("SELECT COUNT(*) AS count FROM runs WHERE state IN ('running','waiting_approval')").first<Row>())?.count || 0), queuedRuns: Number((await db.prepare("SELECT COUNT(*) AS count FROM runs WHERE state='queued'").first<Row>())?.count || 0), secrets: (await db.prepare('SELECT DISTINCT name FROM machine_secrets ORDER BY name').all<Row>()).results.map(row => String(row.name)), secretStorage: 'selected runner OS vault' });
    if (pathname === '/v1/support-bundle' && request.method === 'GET') return json({ generatedAt: stamp(), version: '0.3.0', platform: { os: 'hosted', arch: 'managed' }, machines: await machineList(db), recentRuns: (await db.prepare('SELECT id,agent_id,state,machine_id,created_at,updated_at,error FROM runs ORDER BY created_at DESC LIMIT 25').all<Row>()).results, note: 'Secret values, prompts, messages, results, and file contents are excluded.' });
    if (pathname === '/v1/onboarding/status' && request.method === 'GET') {
      const connected = await machineList(db), online = connected.filter(machine => machine.status === 'online'), credentialMachineId = online[0]?.id;
      const privateReady = online.some(machine => machine.capabilities.container), directReady = online.some(machine => machine.capabilities.direct), desktopReady = online.some(machine => machine.capabilities.desktop);
      const credentialNames = credentialMachineId ? (await db.prepare('SELECT name FROM machine_secrets WHERE machine_id=? ORDER BY name').bind(credentialMachineId).all<Row>()).results.map(row => String(row.name)) : [];
      return json({ platform: 'unknown', platformLabel: 'hosted coordinator', executionReady: privateReady || directReady, recommendedAccess: privateReady ? 'private' : 'direct', credentialMode: 'runner', credentialMachineId, credentialNames, checks: [
        { id: 'coordinator', label: 'Open Harness', state: 'ready', detail: 'The hosted coordinator is running.' },
        { id: 'container-engine', label: 'Connected computer', state: online.length ? 'ready' : 'missing', detail: online.length ? `${online.length} computer${online.length === 1 ? '' : 's'} connected.` : 'Connect a computer or VPS to run agents.' },
        { id: 'agent-runtime', label: 'Agent runtime', state: privateReady || directReady ? 'ready' : 'missing', detail: privateReady ? 'A connected computer supports private agent workspaces.' : directReady ? 'A connected computer supports direct access.' : 'Finish runner setup on a connected computer.' },
        { id: 'desktop', label: 'Desktop control', state: desktopReady ? 'ready' : 'unavailable', detail: desktopReady ? 'A connected computer has a graphical session.' : 'No connected computer currently reports desktop access.' },
      ] });
    }
    if (pathname === '/v1/onboarding/action' && request.method === 'POST') throw new HttpError(409, 'Finish this setup on the connected computer, then check again.');
    if (pathname === '/v1/onboarding/model-test' && request.method === 'POST') return json({ ok: true, message: 'Model choice and encrypted runner credential are ready.' });
    if (pathname === "/v1/workspace/model/import" && request.method === "POST") { const existing = await db.prepare('SELECT * FROM workspace_settings WHERE id=1').first<Row>(); if (existing) return json({ model: JSON.parse(String(existing.json)), revision: Number(existing.revision) }); await db.prepare('INSERT INTO workspace_settings VALUES(1,?,?)').bind(0, JSON.stringify(body.model || DEFAULT_MODEL)).run(); return json({ model: body.model || DEFAULT_MODEL, revision: 0 }); }
    if (pathname === '/v1/workspace/model') { const current = await db.prepare('SELECT * FROM workspace_settings WHERE id=1').first<Row>(); if (request.method === 'GET') return json(current ? { model: JSON.parse(String(current.json)), revision: Number(current.revision) } : { model: DEFAULT_MODEL, revision: 0 }); if (request.method === 'PUT') { const revision = Number(body.revision || 0); if (current && Number(current.revision) !== revision) throw new HttpError(409, 'Workspace settings changed elsewhere.'); await db.prepare('INSERT INTO workspace_settings VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,json=excluded.json').bind(revision + 1, JSON.stringify(body.model || DEFAULT_MODEL)).run(); return json({ model: body.model, revision: revision + 1 }); } }
    if (pathname === '/v1/machines') {
      if (request.method === 'GET') return json({ machines: await machineList(db) });
      if (request.method === 'POST') {
        const code = crypto.randomUUID().replaceAll('-','') + crypto.randomUUID().replaceAll('-',''), pairingId = id(), expiresAt = new Date(Date.now() + 600_000).toISOString(), platform = ['linux','darwin','win32'].includes(String(body.platform)) ? String(body.platform) : 'linux', base = `${new URL(request.url).origin}/api/control`;
        await db.prepare('INSERT INTO machine_pairings VALUES(?,?,?,?,?,?,?)').bind(pairingId, await digest(code), String(body.name || 'New computer').slice(0,80), platform, expiresAt, null, stamp()).run();
        const sitesToken = String((env as unknown as { RUNNER_SITES_BYPASS_TOKEN?: string }).RUNNER_SITES_BYPASS_TOKEN || ''), sh = (value: string) => `'${value.replaceAll("'", "'\\''")}'`, ps = (value: string) => value.replaceAll("'", "''");
        const command = platform === 'win32'
          ? `$env:OPEN_HARNESS_COORDINATOR='${ps(base)}'; $env:OPEN_HARNESS_PAIRING_CODE='${ps(code)}';${sitesToken ? ` $env:OPEN_HARNESS_SITES_TOKEN='${ps(sitesToken)}'; irm -Headers @{'OAI-Sites-Authorization'="Bearer $env:OPEN_HARNESS_SITES_TOKEN"}` : ' irm'} '${ps(`${base}/v1/install/runner.ps1`)}' | iex`
          : `curl -fsSL${sitesToken ? ` -H ${sh(`OAI-Sites-Authorization: Bearer ${sitesToken}`)}` : ''} ${sh(`${base}/v1/install/runner.sh`)} | sh -s -- --coordinator ${sh(base)} --pairing-code ${sh(code)}${sitesToken ? ` --sites-token ${sh(sitesToken)}` : ''}`;
        return json({ id: pairingId, expiresAt, platform, command }, 201);
      }
    }
    const hostedMachineSecrets = pathname.match(/^\/v1\/machines\/([^/]+)\/secrets$/);
    if (hostedMachineSecrets && request.method === 'GET') {
      const machineId = decodeURIComponent(hostedMachineSecrets[1]), machine = await db.prepare('SELECT 1 FROM machines WHERE id=? AND revoked_at IS NULL').bind(machineId).first(); if (!machine) throw new HttpError(404, 'Computer not found.');
      const secrets = (await db.prepare('SELECT name FROM machine_secrets WHERE machine_id=? ORDER BY name').bind(machineId).all<Row>()).results.map(item => String(item.name)); return json({ secrets, storage: 'runner' });
    }
    const hostedMachine = pathname.match(/^\/v1\/machines\/([^/]+)\/(test|reconnect|revoke)$/);
    if (hostedMachine && request.method === 'POST') {
      const machine = await db.prepare('SELECT * FROM machines WHERE id=? AND revoked_at IS NULL').bind(decodeURIComponent(hostedMachine[1])).first<Row>(); if (!machine) throw new HttpError(404, 'Computer not found.'); const mapped = mapMachine(machine);
      if (hostedMachine[2] === 'revoke') { await db.prepare("UPDATE machines SET status='revoked',revoked_at=?,credential_hash=NULL,updated_at=? WHERE id=?").bind(stamp(), stamp(), machine.id).run(); return json({ ok: true, message: `${mapped.name} was revoked.` }); }
      if (hostedMachine[2] === 'reconnect') return json({ ok: mapped.status === 'online', message: mapped.status === 'online' ? `${mapped.name} is connected.` : `Waiting for ${mapped.name} to reconnect. The runner only needs outbound HTTPS access.` });
      const profileRow = body.agentId ? await db.prepare('SELECT json FROM agent_profiles WHERE id=?').bind(body.agentId).first<Row>() : null, profile = profileRow ? normalizeProfile(JSON.parse(String(profileRow.json))) : null, issues: string[] = [];
      if (mapped.status !== 'online') issues.push('Runner is offline.'); if (profile?.computer.access === 'private' && !mapped.capabilities.container) issues.push('Container execution is unavailable.'); if (profile?.computer.access === 'direct' && !mapped.capabilities.direct) issues.push(`Direct execution is unavailable. ${mapped.capabilities.detail || 'Install Hermes and the Open Harness policy extension on the runner.'}`); if (profile?.computer.desktop === 'existing' && !mapped.capabilities.desktop) issues.push(mapped.platform === 'darwin' ? 'Grant Accessibility and Screen Recording to the runner.' : mapped.platform === 'win32' ? 'Sign in to an interactive Windows session and start the runner there.' : 'Start a graphical session with DISPLAY or Wayland and enable AT-SPI.'); if (profile?.computer.desktop === 'virtual' && !mapped.capabilities.virtualDesktop) issues.push('Private virtual desktops are available on Linux runners only.');
      if (!issues.length && profile && hostedMachine[2] === 'test') { try { const result = await hostedProbe(db, profile, 'probe-runtime', { action: 'computer', desktop: profile.computer.desktop }); return json({ ok: Boolean(result.ok), message: String(result.message || `${mapped.name} is ready for this agent.`), machine: mapped }); } catch (error) { issues.push(error instanceof Error ? error.message : 'Computer access check failed.'); } }
      return json({ ok: !issues.length, message: issues.length ? issues.join(' ') : `${mapped.name} is ready for this agent.`, machine: mapped });
    }
    const hostedProfile = pathname.match(/^\/v1\/agents\/([^/]+)\/(profile|tools|models|connection-check|connector-check|stop|transfer)$/);
    if (hostedProfile) {
      const agentId = decodeURIComponent(hostedProfile[1]), action = hostedProfile[2], row = await db.prepare('SELECT * FROM agent_profiles WHERE id=?').bind(agentId).first<Row>(); if (!row) throw new HttpError(404, 'Agent profile not found.'); const profile = normalizeProfile(JSON.parse(String(row.json)));
      if (action === 'profile' && request.method === 'GET') { const machine = (await machineList(db)).find(item => item.id === profile.computer.machineId), transfer = await db.prepare('SELECT state,detail FROM agent_transfers WHERE agent_id=? ORDER BY created_at DESC LIMIT 1').bind(agentId).first<Row>(), secretNames = (await db.prepare('SELECT name FROM machine_secrets WHERE machine_id=? ORDER BY name').bind(profile.computer.machineId).all<Row>()).results.map(item => String(item.name)); return json({ profile, effectiveModel: profile.model.inherit ? DEFAULT_MODEL : profile.model, activeRevision: null, pending: Boolean(await db.prepare("SELECT 1 FROM runs WHERE agent_id=? AND state IN ('running','waiting_approval') LIMIT 1").bind(agentId).first()), secretNames, machine, transfer }); }
      if (action === 'profile' && request.method === 'PUT') {
        if (Number(body.revision) !== Number(row.revision)) throw new HttpError(409, 'This profile changed elsewhere. Reload before saving.');
        if (await activeTransfer(db, agentId)) throw new HttpError(409, 'This agent is already transferring. Wait for it to finish before editing its computer.');
        const validated = validateProfile({ ...(body as unknown as AgentProfile), id: agentId, revision: Number(row.revision) }), desired = { ...validated, revision: Number(row.revision) + 1 }, moving = profile.computer.machineId !== desired.computer.machineId;
        const machine = await db.prepare('SELECT * FROM machines WHERE id=? AND revoked_at IS NULL').bind(desired.computer.machineId).first<Row>();
        if (!machine) throw new HttpError(400, 'Choose a connected computer.'); if (machine.reserved_agent_id && machine.reserved_agent_id !== agentId) throw new HttpError(409, 'This computer is reserved for another agent.');
        const saved = moving ? { ...desired, computer: profile.computer } : desired, now = stamp(), statements = [db.prepare('UPDATE agent_profiles SET revision=?,json=?,updated_at=? WHERE id=?').bind(saved.revision, JSON.stringify(saved), now, agentId)];
        if (moving) { if (desired.computer.reserveMachine) statements.push(db.prepare('UPDATE machines SET reserved_agent_id=?,updated_at=? WHERE id=?').bind(agentId, now, desired.computer.machineId)); }
        else { statements.push(db.prepare('UPDATE machines SET reserved_agent_id=NULL,updated_at=? WHERE id<>? AND reserved_agent_id=?').bind(now, saved.computer.machineId, agentId)); statements.push(db.prepare('UPDATE machines SET reserved_agent_id=?,updated_at=? WHERE id=?').bind(saved.computer.reserveMachine ? agentId : null, now, saved.computer.machineId)); }
        await db.batch(statements); if (moving) { await beginHostedTransfer(db, agentId, profile.computer.machineId, desired.computer.machineId, desired); await startReadyTransfers(db, profile.computer.machineId); }
        const transfer = await db.prepare('SELECT state,detail FROM agent_transfers WHERE agent_id=? ORDER BY created_at DESC LIMIT 1').bind(agentId).first<Row>(), secretNames = (await db.prepare('SELECT name FROM machine_secrets WHERE machine_id=? ORDER BY name').bind(saved.computer.machineId).all<Row>()).results.map(item => String(item.name));
        return json({ profile: saved, effectiveModel: saved.model.inherit ? DEFAULT_MODEL : saved.model, activeRevision: null, pending: Boolean(await db.prepare("SELECT 1 FROM runs WHERE agent_id=? AND state IN ('running','waiting_approval') LIMIT 1").bind(agentId).first()), secretNames, machine: mapMachine(moving ? await db.prepare('SELECT * FROM machines WHERE id=?').bind(saved.computer.machineId).first<Row>() as Row : machine), transfer });
      }
      if (action === 'tools' && request.method === 'GET') return json(await hostedProbe(db, profile, 'probe-tools'));
      if (action === 'models' && request.method === 'GET') return json(await hostedProbe(db, profile, 'probe-models'));
      if (action === 'connection-check' && request.method === 'POST') { const model = body.model as Row || {}, tested = { ...profile, model: { ...profile.model, ...model, inherit: false } } as AgentProfile, endpoints: Record<string,string> = { xai: 'https://api.x.ai/v1', openrouter: 'https://openrouter.ai/api/v1', openai: 'https://api.openai.com/v1' }, baseUrl = String(model.baseUrl || endpoints[String(model.provider)] || ''); if (!baseUrl) return json({ ok: false, message: 'This provider has no compatible model-list endpoint. Hermes will check it when the task starts.' }); return json(await hostedProbe(db, tested, 'probe-runtime', { action: 'connection', baseUrl, apiKey: '' })); }
      if (action === 'connector-check' && request.method === 'POST') { const connector = body.connector as Row || {}, name = required(connector.name, 'Connection name', 80).replace(/[^a-zA-Z0-9_.-]/g, '-'), command = required(connector.command, 'Connection executable', 500), args = Array.isArray(connector.args) ? connector.args.map(value => String(value).slice(0, 2_000)).slice(0, 100) : [], secretRef = String(connector.secretRef || '').slice(0, 120), result = await hostedProbe(db, profile, 'probe-runtime', { action: 'mcp', command, args, env: secretRef ? { [secretRef]: '' } : {} }), tools = Array.isArray(result.tools) ? (result.tools as Row[]).map(tool => ({ id: `mcp_${name}_${String(tool.name)}`, name: String(tool.name), description: String(tool.description || ''), group: 'mcp', available: true })) : []; return json({ ...result, tools }); }
      if (action === 'stop' && request.method === 'POST') { const runs = (await db.prepare("SELECT * FROM runs WHERE agent_id=? AND state IN ('queued','running','waiting_approval')").bind(agentId).all<Row>()).results; for (const run of runs) { if (run.command_id) await db.prepare('INSERT INTO runner_commands(id,machine_id,agent_id,kind,payload_json,state,created_at) VALUES(?,?,?,?,?,?,?)').bind(id(), run.machine_id, agentId, 'stop', JSON.stringify({ runId: run.id, commandId: run.command_id }), 'queued', stamp()).run(); else await db.prepare("UPDATE runs SET state='cancelled',updated_at=? WHERE id=?").bind(stamp(), run.id).run(); } return json({ ok: true, stopped: runs.length, pending: runs.some(run => run.command_id) }); }
      if (action === 'transfer' && request.method === 'POST') { const destination = required(body.destinationMachineId, 'Destination computer'), machine = await db.prepare('SELECT * FROM machines WHERE id=? AND revoked_at IS NULL').bind(destination).first<Row>(); if (!machine) throw new HttpError(404, 'Destination computer not found.'); if (machine.reserved_agent_id && machine.reserved_agent_id !== agentId) throw new HttpError(409, 'This computer is reserved for another agent.'); await beginHostedTransfer(db, agentId, profile.computer.machineId, destination, { ...profile, computer: { ...profile.computer, machineId: destination } }); await startReadyTransfers(db, profile.computer.machineId); return json(await activeTransfer(db, agentId) || { state: 'completed', detail: 'The agent is already assigned to this computer.' }, 202); }
    }
    if (pathname === "/v1/routines") {
      if (request.method === "GET") { await dueRoutines(db); return json({ routines: (await db.prepare('SELECT * FROM hosted_routines ORDER BY created_at DESC').all<Row>()).results }); }
      if (request.method === 'POST') { const agentId = required(body.agentId, 'Agent'), agent = await db.prepare('SELECT 1 FROM agent_profiles WHERE id=?').bind(agentId).first(); if (!agent) throw new HttpError(404, 'Agent profile not found.'); const routineId = id(), now = stamp(), minutes = Math.max(1, Math.min(525_600, Number(body.intervalMinutes || 60))), next = new Date(Date.now() + minutes * 60_000).toISOString(); await db.prepare('INSERT INTO hosted_routines VALUES(?,?,?,?,?,?,?,?,?,?)').bind(routineId, agentId, required(body.name, 'Routine name'), required(body.prompt, 'Routine prompt', 20_000), minutes, String(body.timezone || 'UTC').slice(0, 100), 1, next, now, now).run(); return json({ id: routineId, nextRunAt: next }, 201); }
    }
    const hostedRoutine = pathname.match(/^\/v1\/routines\/([^/]+)\/(run|toggle)$/);
    if (hostedRoutine && request.method === 'POST') { const routine = await db.prepare('SELECT * FROM hosted_routines WHERE id=?').bind(hostedRoutine[1]).first<Row>(); if (!routine) throw new HttpError(404, 'Routine not found.'); if (hostedRoutine[2] === 'toggle') { await db.prepare('UPDATE hosted_routines SET enabled=?,updated_at=? WHERE id=?').bind(routine.enabled ? 0 : 1, stamp(), routine.id).run(); return json({ enabled: !routine.enabled }); } const row = await db.prepare('SELECT json FROM agent_profiles WHERE id=?').bind(routine.agent_id).first<Row>(); if (!row) throw new HttpError(404, 'Agent profile not found.'); return json(await publicRun(db, await createHostedRun(db, normalizeProfile(JSON.parse(String(row.json))), String(routine.prompt), `routine-${routine.id}-${stamp()}`)), 202); }
    if (pathname === '/v1/runs') {
      if (request.method === 'GET') return json({ runs: await Promise.all((await db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT 100').all<Row>()).results.map(row => publicRun(db, row))) });
      if (request.method === 'POST') { const agentId = required(body.agentId, 'Agent'), row = await db.prepare('SELECT json FROM agent_profiles WHERE id=?').bind(agentId).first<Row>(); if (!row) throw new HttpError(404, 'Agent profile not found.'); return json(await publicRun(db, await createHostedRun(db, normalizeProfile(JSON.parse(String(row.json))), String(body.prompt || ''), String(body.conversationId || id()))), 202); }
    }
    const hostedRun = pathname.match(/^\/v1\/runs\/([^/]+)(?:\/(events|stop|steer|approval))?$/);
    if (hostedRun) { const run = await db.prepare('SELECT * FROM runs WHERE id=?').bind(hostedRun[1]).first<Row>(); if (!run) throw new HttpError(404, 'Run not found.'); const action = hostedRun[2]; if (!action && request.method === 'GET') return json(await publicRun(db, run)); if (action === 'events' && request.method === 'GET') { const after = Number(new URL(request.url).searchParams.get('after') || 0), events = (await db.prepare('SELECT * FROM run_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 500').bind(run.id, after).all<Row>()).results.map(row => ({ seq: row.seq, id: row.id, runId: row.run_id, type: row.type, payload: JSON.parse(String(row.payload_json)), createdAt: row.created_at })); return json({ events, run: await publicRun(db, run) }); } if (['stop','steer','approval'].includes(action || '') && request.method === 'POST') { if (!run.command_id) throw new HttpError(409, 'Run has not reached its runner.'); let commandBody: Row = { ...body, runId: run.id, commandId: run.command_id }; if (action === 'approval') { const approval = await db.prepare("SELECT * FROM approvals WHERE id=? AND run_id=? AND state='pending'").bind(body.approvalId, run.id).first<Row>(); if (!approval) throw new HttpError(404, 'Approval not found.'); const decision = body.decision === 'approve' ? 'approve' : 'deny'; commandBody = { runId: run.id, commandId: run.command_id, requestId: approval.gateway_request_id, decision }; const now = stamp(); await db.batch([db.prepare("UPDATE approvals SET state=?,resolved_at=? WHERE id=? AND state='pending'").bind(decision, now, approval.id), db.prepare("UPDATE runs SET state='running',updated_at=? WHERE id=?").bind(now, run.id)]); await appendRunEvent(db, String(run.id), 'approval.resolved', { approvalId: approval.id, decision }); } await enqueueRunnerCommand(db, String(run.machine_id), String(run.agent_id), String(action), commandBody); return json({ ok: true, pending: true }); } }
    if (pathname === '/v1/secrets' && request.method === 'POST') {
      const name = required(body.name, 'Credential name', 80), value = required(body.value, 'Credential value', 100_000), machineId = required(body.machineId, 'Computer');
      if (!/^[A-Z][A-Z0-9_]{1,79}$/.test(name)) throw new HttpError(400, 'Credential names use uppercase letters, digits, and underscores.');
      const machine = await db.prepare('SELECT * FROM machines WHERE id=? AND revoked_at IS NULL').bind(machineId).first<Row>();
      if (!machine || mapMachine(machine).status !== 'online') throw new HttpError(409, 'The selected computer must be online to save a credential.');
      if (!machine.encryption_public_key) throw new HttpError(409, 'This runner must reconnect once before it can receive encrypted credentials.');
      const commandId = await enqueueRunnerCommand(db, machineId, null, 'store-secret', { name, encrypted: await encryptRunnerSecret(String(machine.encryption_public_key), value) });
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) { const command = await db.prepare('SELECT state,result_json FROM runner_commands WHERE id=?').bind(commandId).first<Row>(); if (command && ['completed','failed'].includes(String(command.state))) { const result = JSON.parse(String(command.result_json || '{}')) as Row; if (command.state === 'failed') throw new HttpError(502, String(result.error || 'The runner could not store this credential.')); return json({ ok: true, name, machineId, storage: String(result.backend || 'runner OS vault') }); } await new Promise(resolve => setTimeout(resolve, 250)); }
      throw new HttpError(504, 'The runner did not confirm credential storage in time. Check its connection and try again.');
    }

    if (pathname === "/v1/boards") {
      if (request.method === "GET") return json({ boards: await listBoards(db, url.searchParams.get("includeArchived") === "1") });
      if (request.method === "POST") return json(await createBoard(db, body), 201);
    }
    const boardMatch = pathname.match(/^\/v1\/boards\/([^/]+)(?:\/(stages))?$/);
    if (boardMatch) {
      const boardId = decodeURIComponent(boardMatch[1]);
      if (!boardMatch[2] && request.method === "GET") return json(await getBoard(db, boardId));
      if (!boardMatch[2] && request.method === "PUT") return json(await updateBoard(db, boardId, body));
      if (boardMatch[2] && request.method === "POST") return json(await addStage(db, boardId, body), 201);
    }
    const stageMatch = pathname.match(/^\/v1\/stages\/([^/]+)$/);
    if (stageMatch) {
      const stageId = decodeURIComponent(stageMatch[1]);
      if (request.method === "PUT") return json(await updateStage(db, stageId, body));
      if (request.method === "DELETE") return json(await removeStage(db, stageId, url.searchParams.get("moveToStageId")));
    }
    if (pathname === "/v1/tasks") {
      const includeArchived = url.searchParams.get("includeArchived") === "1";
      if (request.method === "GET") return json({ boards: await listBoards(db, includeArchived), tasks: await listTasks(db, includeArchived) });
      if (request.method === "POST") return json(await createTask(db, body), 201);
    }
    const taskMatch = pathname.match(/^\/v1\/tasks\/([^/]+)(?:\/(comments|start|request-changes|approve|runs))?$/);
    if (taskMatch) {
      const taskId = decodeURIComponent(taskMatch[1]), action = taskMatch[2];
      if (!action && request.method === "GET") return json(await getTask(db, taskId));
      if (!action && request.method === "PUT") return json(await updateTask(db, taskId, body));
      if (action === "comments" && request.method === "POST") return json(await commentTask(db, taskId, body), 201);
      if (action === "approve" && request.method === "POST") return json(await approveTask(db, taskId, body));
      if (action === "runs" && request.method === "GET") { const rows = (await db.prepare('SELECT runs.*,task_runs.attempt,task_runs.started_at FROM task_runs JOIN runs ON runs.id=task_runs.run_id WHERE task_runs.task_id=? ORDER BY task_runs.attempt DESC').bind(taskId).all<Row>()).results; return json({ runs: await Promise.all(rows.map(async row => ({ ...await publicRun(db, row), attempt: Number(row.attempt), startedAt: String(row.started_at), output: String(row.result || '').slice(-20_000), stopReason: row.state === 'completed' ? 'end_turn' : row.error ? String(row.error) : null }))) }); }
      if ((action === "start" || action === "request-changes") && request.method === "POST") return json(await startTask(db, taskId, { ...body, feedback: action === 'request-changes' ? body.feedback : undefined }), 202);
    }
    throw new HttpError(404, "Not found.");
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Request failed." }, error instanceof HttpError ? error.status : 500);
  }
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
