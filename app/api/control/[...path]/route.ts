import { env } from "cloudflare:workers";
import { hostedRuntimeSchema, hostedTaskSchema } from "../../../../db/schema";
import type { AgentTask, TaskBoard, TaskStage, WorkflowCategory } from "../../../../lib/task-types";
import { DEFAULT_COMPUTER, DEFAULT_MODEL, draftProfile, runToolGrants, type AgentProfile } from '../../../../lib/agent-profile';
import type { Agent } from '../../../../lib/types';
import { encryptRunnerSecret } from '../../../../lib/runner-crypto';
import { conversationHistory } from '../../../../runtime/conversation-history';
import { ProfileError, validateModel, validateProfile } from '../../../../runtime/profiles';
import runnerInstallSh from '../../../../runtime/installers/install-runner.sh?raw';
import runnerInstallPs1 from '../../../../runtime/installers/install-runner.ps1?raw';
import runnerBundle from '../../../../runtime/runner.mjs?raw';
import hermesDockerfile from '../../../../runtime/hermes/Dockerfile?raw';
import hermesNotice from '../../../../runtime/hermes/NOTICE.md?raw';
import hermesInit from '../../../../runtime/hermes/container-init.sh?raw';
import hermesCoordination from '../../../../runtime/hermes/coordination.mjs?raw';
import hermesInspect from '../../../../runtime/hermes/inspect_runtime.py?raw';
import hermesEntry from '../../../../runtime/hermes/managed_entry.py?raw';
import hermesCuaCompat from '../../../../runtime/hermes/cua_compat.py?raw';
import policyExtension from '../../../../runtime/hermes/extension/open_harness_policy.py?raw';
import policyProject from '../../../../runtime/hermes/extension/pyproject.toml?raw';

export const runtime = "edge";

type Row = Record<string, unknown>;
type RouteContext = { params: Promise<{ path: string[] }> };
const categories: WorkflowCategory[] = ["backlog", "ready", "in_progress", "review", "done"];
const priorities = new Set(["low", "normal", "high", "urgent"]);
const stamp = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const runnerFiles: Record<string,string> = { 'runtime/runner.mjs': runnerBundle, 'runtime/hermes/Dockerfile': hermesDockerfile, 'runtime/hermes/NOTICE.md': hermesNotice, 'runtime/hermes/container-init.sh': hermesInit, 'runtime/hermes/coordination.mjs': hermesCoordination, 'runtime/hermes/inspect_runtime.py': hermesInspect, 'runtime/hermes/managed_entry.py': hermesEntry, 'runtime/hermes/cua_compat.py': hermesCuaCompat, 'runtime/hermes/extension/open_harness_policy.py': policyExtension, 'runtime/hermes/extension/pyproject.toml': policyProject };

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
  try { await db.prepare("ALTER TABLE machines ADD COLUMN kind TEXT NOT NULL DEFAULT 'runner'").run(); } catch { /* Existing and new databases already have this column after the first migration. */ }
  try { await db.prepare("ALTER TABLE machine_pairings ADD COLUMN kind TEXT NOT NULL DEFAULT 'runner'").run(); } catch { /* Existing and new databases already have this column after the first migration. */ }
  const now = stamp();
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO task_boards(id,name,archived,revision,created_at,updated_at) VALUES(?,?,?,?,?,?)").bind("default-board", "Open Harness", 0, 1, now, now),
    ...categories.map((category, position) => db.prepare("INSERT OR IGNORE INTO task_stages(id,board_id,name,category,position) VALUES(?,?,?,?,?)").bind(`default-${category}`, "default-board", category === "in_progress" ? "In Progress" : category[0].toUpperCase() + category.slice(1), category, position)),
  ]);
}

// The hosted platform gates /api/control on a signed-in-user header the phone cannot produce,
// so a paired phone presents this bypass token alongside its device credential instead.
function sitesBypassToken() { return String((env as unknown as { RUNNER_SITES_BYPASS_TOKEN?: string }).RUNNER_SITES_BYPASS_TOKEN || ''); }
async function digest(value: string) { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)); return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
function normalizeProfile(input: AgentProfile): AgentProfile { return { ...input, computer: input.computer || { ...DEFAULT_COMPUTER, resources: { ...DEFAULT_COMPUTER.resources } } }; }
const ONLINE_MS = 45_000;
// A phone stops polling every time the OS backgrounds it. Treating that as a dead runner
// would interrupt healthy work whenever the screen locks, so phones get a long grace window
// and a 'suspended' status. Computers keep the original 45s and go straight to offline.
const MOBILE_LEASE_GRACE_MS = 600_000;
function machineCapabilities(row: Row): { mobile?: boolean } { try { return JSON.parse(String(row.capabilities_json || '{}')); } catch { return {}; } }
function machineGraceMs(row: Row) { return machineCapabilities(row).mobile ? MOBILE_LEASE_GRACE_MS : ONLINE_MS; }
function machineReachable(status: string) { return status === 'online' || status === 'suspended'; }
function mapMachine(row: Row, assignedAgents = 0) {
  const age = row.last_seen_at ? Date.now() - Date.parse(String(row.last_seen_at)) : Number.POSITIVE_INFINITY;
  const status = row.revoked_at ? 'revoked' : age < ONLINE_MS ? 'online' : age < machineGraceMs(row) ? 'suspended' : 'offline';
  return { id: String(row.id), name: String(row.name), platform: String(row.platform), arch: String(row.arch), status, lastSeenAt: row.last_seen_at ? String(row.last_seen_at) : null, local: false, kind: String(row.kind || 'runner') === 'device' ? 'device' : 'runner', reservedAgentId: row.reserved_agent_id ? String(row.reserved_agent_id) : null, assignedAgents, capabilities: JSON.parse(String(row.capabilities_json || '{}')) };
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
// A phone's credential reaches the dashboard routes a computer's runner credential must not.
// The kind is fixed when the operator creates the pairing, so a paired computer cannot
// promote itself by sending different headers.
async function deviceMachine(db: D1Database, request: Request) {
  const row = await runnerMachine(db, request);
  return row && String(row.kind || 'runner') === 'device' ? row : null;
}
async function appendRunEvent(db: D1Database, runId: string, type: string, payload: unknown, eventId = id()) { await db.prepare('INSERT OR IGNORE INTO run_events(id,run_id,type,payload_json,created_at) VALUES(?,?,?,?,?)').bind(eventId, runId, type, JSON.stringify(payload), stamp()).run(); }
async function publicRun(db: D1Database, row: Row) {
  const machine = await db.prepare('SELECT * FROM machines WHERE id=?').bind(row.machine_id).first<Row>();
  const relation = await db.prepare('SELECT parent_run_id FROM run_relations WHERE run_id=?').bind(row.id).first<Row>();
  const active = ['running','waiting_approval','waiting_input'].includes(String(row.state));
  const approvals = active ? (await db.prepare("SELECT approvals.*,run_events.payload_json FROM approvals LEFT JOIN run_events ON run_events.run_id=approvals.run_id AND json_extract(run_events.payload_json,'$.approvalId')=approvals.id WHERE approvals.run_id=? AND approvals.state='pending' ORDER BY approvals.created_at").bind(row.id).all<Row>()).results : [];
  const inputs = active ? (await db.prepare("SELECT * FROM hosted_run_inputs WHERE run_id=? AND state='pending' ORDER BY created_at").bind(row.id).all<Row>()).results : [];
  return { id: String(row.id), agent_id: String(row.agent_id), conversation_id: String(row.conversation_id), parent_run_id: relation?.parent_run_id ? String(relation.parent_run_id) : null, created_at: String(row.created_at), updated_at: String(row.updated_at), prompt: String(row.prompt), state: String(row.state), machine_id: String(row.machine_id), machine_connection: machine ? mapMachine(machine).status : 'offline', result: row.result ? String(row.result) : null, error: row.error ? String(row.error) : null,
    pendingApprovals: approvals.map(approval => { const payload = JSON.parse(String(approval.payload_json || '{}')); return { approvalId: String(approval.id), detail: String(payload.command || payload.description || payload.message || 'Approve this action?'), payload, createdAt: String(approval.created_at) }; }),
    pendingInputs: inputs.map(input => ({ inputId: String(input.id), type: String(input.type), payload: JSON.parse(String(input.payload_json)), createdAt: String(input.created_at) })),
  };
}
async function enqueueRunnerCommand(db: D1Database, machineId: string, agentId: string | null, kind: string, payload: unknown) {
  const commandId = id(); await db.prepare('INSERT INTO runner_commands(id,machine_id,agent_id,kind,payload_json,state,created_at) VALUES(?,?,?,?,?,?,?)').bind(commandId, machineId, agentId, kind, JSON.stringify(payload), 'queued', stamp()).run(); return commandId;
}
async function workspaceDefaults(db: D1Database) {
  const row = await db.prepare('SELECT revision,json FROM workspace_settings WHERE id=1').first<Row>();
  return row ? { model: validateModel(JSON.parse(String(row.json))), revision: Number(row.revision) } : { model: DEFAULT_MODEL, revision: 0 };
}
async function effectiveModel(db: D1Database, profile: AgentProfile) { return profile.model.inherit ? (await workspaceDefaults(db)).model : validateModel(profile.model); }
async function immutableSnapshot(db: D1Database, runId: string) {
  const stored = await db.prepare('SELECT json FROM run_snapshots WHERE run_id=?').bind(runId).first<Row>();
  if (stored) return JSON.parse(String(stored.json)) as AgentProfile & { effectiveModel: typeof DEFAULT_MODEL; workspaceRevision: number };
  throw new HttpError(409, 'This run has no configuration snapshot.');
}
async function profileRuntimeState(db: D1Database, profile: AgentProfile) {
  const active = await db.prepare("SELECT run_snapshots.json FROM runs JOIN run_snapshots ON run_snapshots.run_id=runs.id WHERE runs.agent_id=? AND runs.state IN ('running','waiting_approval','waiting_input') LIMIT 1").bind(profile.id).first<Row>();
  const activeRevision = active ? Number(JSON.parse(String(active.json)).revision) : null;
  return { activeRevision, pending: activeRevision !== null && activeRevision !== profile.revision };
}

async function createHostedRun(db: D1Database, profile: AgentProfile, prompt: string, conversationId: string, parentRunId: string | null = null, depth = 0) {
  if (!await db.prepare('SELECT 1 FROM machines WHERE id=? AND revoked_at IS NULL').bind(profile.computer.machineId).first()) throw new HttpError(409, 'Choose a connected computer in this agent’s settings before starting work.');
  const runId = id(), now = stamp();
  await db.batch([
    db.prepare(`INSERT INTO runs(id,agent_id,conversation_id,prompt,state,machine_id,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?
      WHERE ? IS NULL OR EXISTS (SELECT 1 FROM runs WHERE id=? AND state IN ('running','waiting_approval','waiting_input') AND NOT EXISTS (SELECT 1 FROM runner_commands WHERE kind='stop' AND json_extract(payload_json,'$.runId')=? AND state IN ('queued','leased')))`)
      .bind(runId, profile.id, conversationId, prompt, 'queued', profile.computer.machineId, now, now, parentRunId, parentRunId, parentRunId),
    db.prepare('INSERT INTO run_relations SELECT id,?,? FROM runs WHERE id=?').bind(parentRunId, depth, runId),
    db.prepare("INSERT INTO run_events(id,run_id,type,payload_json,created_at) SELECT ?,id,'run.queued',?,? FROM runs WHERE id=?").bind(id(), JSON.stringify({ machineId: profile.computer.machineId, parentRunId }), now, runId),
  ]);
  const run = await db.prepare('SELECT * FROM runs WHERE id=?').bind(runId).first<Row>();
  if (!run) throw new HttpError(409, 'The parent run stopped before this task could be delegated.');
  await dispatchHostedRun(db, run, profile);
  return await db.prepare('SELECT * FROM runs WHERE id=?').bind(runId).first<Row>() as Row;
}
async function internalRun(db: D1Database, request: Request) {
  const agentId = request.headers.get('x-open-harness-agent') || '', runId = request.headers.get('x-open-harness-run') || '', token = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
  if (!agentId || !runId || !token) return null;
  const credential = await db.prepare('SELECT * FROM run_credentials WHERE run_id=? AND agent_id=?').bind(runId, agentId).first<Row>();
  if (!credential || String(credential.token_hash) !== await digest(token)) return null;
  const run = await db.prepare("SELECT * FROM runs WHERE id=? AND agent_id=? AND state IN ('running','waiting_approval','waiting_input')").bind(runId, agentId).first<Row>();
  if (!run || await db.prepare("SELECT 1 FROM runner_commands WHERE kind='stop' AND json_extract(payload_json,'$.runId')=? AND state IN ('queued','leased') LIMIT 1").bind(runId).first()) return null;
  return { run, snapshot: await immutableSnapshot(db, runId) };
}
function intervalMinutes(value: unknown) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 525_600) throw new HttpError(400, 'Choose an interval between 1 and 525,600 minutes.');
  return Math.round(minutes);
}
async function runHostedRoutine(db: D1Database, routine: Row, scheduledFor: string) {
  const profileRow = await db.prepare('SELECT json FROM agent_profiles WHERE id=?').bind(routine.agent_id).first<Row>();
  if (!profileRow) throw new HttpError(404, 'Routine agent profile not found.');
  const run = await createHostedRun(db, normalizeProfile(JSON.parse(String(profileRow.json))), String(routine.prompt), `routine-${routine.id}-${scheduledFor}`);
  await db.prepare('INSERT INTO hosted_routine_runs VALUES(?,?,?)').bind(routine.id, run.id, scheduledFor).run();
  return run;
}
async function dueRoutines(db: D1Database) {
  const now = stamp(), rows = (await db.prepare('SELECT * FROM hosted_routines WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at LIMIT 10').bind(now).all<Row>()).results;
  for (const routine of rows) {
    let minutes: number;
    try { minutes = intervalMinutes(routine.interval_minutes); }
    catch { await db.prepare('UPDATE hosted_routines SET enabled=0,updated_at=? WHERE id=?').bind(now, routine.id).run(); continue; }
    const next = new Date(Date.now() + minutes * 60_000).toISOString();
    const claimed = await db.prepare('UPDATE hosted_routines SET next_run_at=?,updated_at=? WHERE id=? AND enabled=1 AND next_run_at=?').bind(next, now, routine.id, routine.next_run_at).run();
    if (!claimed.meta.changes) continue;
    try { await runHostedRoutine(db, routine, String(routine.next_run_at)); }
    catch (error) {
      // One unavailable agent must not prevent the runner heartbeat or other due
      // routines from making progress. Missing profiles require operator repair.
      if (error instanceof HttpError && error.status === 404) await db.prepare('UPDATE hosted_routines SET enabled=0,updated_at=? WHERE id=?').bind(now, routine.id).run();
    }
  }
}
async function hostedProbe(db: D1Database, profile: AgentProfile, kind: 'probe-tools' | 'probe-models' | 'probe-runtime', probeInput?: unknown, extra: Row = {}) {
  const machine = await db.prepare('SELECT * FROM machines WHERE id=? AND revoked_at IS NULL').bind(profile.computer.machineId).first<Row>();
  if (!machine || mapMachine(machine).status !== 'online') throw new HttpError(409, 'The selected computer is offline. Reconnect it before checking this setting.');
  const commandId = await enqueueRunnerCommand(db, profile.computer.machineId, profile.id, kind, { profile: { ...profile, effectiveModel: await effectiveModel(db, profile) }, input: probeInput, secrets: {}, coordinationToken: '', ...extra });
  const deadline = Date.now() + ((probeInput as Row)?.action === 'model-test' ? 55_000 : 25_000);
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
  const sourceMachine = await db.prepare('SELECT id,revoked_at FROM machines WHERE id=?').bind(source).first<Row>();
  const now = stamp();
  if (!sourceMachine) {
    if (source !== 'local' || !pendingProfile) throw new HttpError(409, 'The source computer is unavailable.');
    const profile = { ...pendingProfile, revision: pendingProfile.revision + 1 };
    const results = await db.batch([
      db.prepare('UPDATE agent_profiles SET revision=?,json=?,updated_at=? WHERE id=? AND revision=? AND EXISTS (SELECT 1 FROM machines WHERE id=? AND revoked_at IS NULL AND (reserved_agent_id IS NULL OR reserved_agent_id=?))').bind(profile.revision, JSON.stringify(profile), now, agentId, pendingProfile.revision, destination, agentId),
      db.prepare("UPDATE runs SET machine_id=? WHERE agent_id=? AND state='queued' AND EXISTS (SELECT 1 FROM agent_profiles WHERE id=? AND json=?)").bind(destination, agentId, agentId, JSON.stringify(profile)),
      db.prepare('UPDATE machines SET reserved_agent_id=?,updated_at=? WHERE id=? AND EXISTS (SELECT 1 FROM agent_profiles WHERE id=? AND json=?)').bind(profile.computer.reserveMachine ? agentId : null, now, destination, agentId, JSON.stringify(profile)),
    ]);
    if (!results[0].meta.changes) throw new HttpError(409, 'This profile or computer changed elsewhere.');
    return;
  }
  if (sourceMachine.revoked_at) throw new HttpError(409, 'The source computer was revoked. Its data must be restored before transferring this agent.');
  const inserted = await db.prepare("INSERT INTO agent_transfers(id,agent_id,source_machine_id,destination_machine_id,state,detail,created_at,updated_at,pending_profile_json) SELECT ?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM agent_transfers WHERE agent_id=? AND state IN ('queued','exporting','importing','verifying'))").bind(id(), agentId, source, destination, 'queued', 'Waiting for active work to finish.', now, now, pendingProfile ? JSON.stringify(pendingProfile) : null, agentId).run();
  if (!inserted.meta.changes) throw new HttpError(409, 'This agent is already transferring.');
}
async function startReadyTransfers(db: D1Database, sourceMachineId: string) {
  const transfers = (await db.prepare("SELECT * FROM agent_transfers WHERE source_machine_id=? AND state='queued' ORDER BY created_at LIMIT 10").bind(sourceMachineId).all<Row>()).results;
  for (const transfer of transfers) {
    const commandId = id(), now = stamp();
    await db.batch([
      db.prepare("UPDATE agent_transfers SET state='exporting',detail='Exporting managed files, memory, and skills.',export_command_id=?,updated_at=? WHERE id=? AND state='queued' AND NOT EXISTS (SELECT 1 FROM runs WHERE agent_id=? AND state IN ('running','waiting_approval','waiting_input'))").bind(commandId, now, transfer.id, transfer.agent_id),
      db.prepare("INSERT INTO runner_commands(id,machine_id,agent_id,kind,payload_json,state,created_at) SELECT ?,source_machine_id,agent_id,'export-agent',?,'queued',? FROM agent_transfers WHERE id=? AND export_command_id=?").bind(commandId, JSON.stringify({ transferId: transfer.id }), now, transfer.id, commandId),
    ]);
  }
}
async function dispatchHostedRun(db: D1Database, run: Row, profile: AgentProfile) {
  // Requests and runner heartbeats may race. Read the latest profile, then claim all
  // execution limits in the same transaction that publishes the command and snapshot.
  const current = await db.prepare('SELECT json FROM agent_profiles WHERE id=?').bind(profile.id).first<Row>();
  if (!current) return;
  profile = normalizeProfile(JSON.parse(String(current.json)));
  const machine = await db.prepare('SELECT * FROM machines WHERE id=? AND revoked_at IS NULL').bind(profile.computer.machineId).first<Row>();
  if (machine && (machineCapabilities(machine).mobile || machine.kind === 'device')) {
    const error = 'Phones are companion dashboards in this release and cannot run agents. Choose a connected computer.';
    const failed = await db.prepare("UPDATE runs SET state='failed',error=?,updated_at=? WHERE id=? AND state='queued'").bind(error, stamp(), run.id).run();
    if (failed.meta.changes) { await appendRunEvent(db, String(run.id), 'run.failed', { error }); await syncHostedTaskRun(db, String(run.id)); }
    return;
  }
  if (!machine) return;
  const defaults = await workspaceDefaults(db), commandId = id(), created = stamp(), coordinationToken = crypto.randomUUID() + crypto.randomUUID();
  const snapshot = { ...profile, allowedTools: runToolGrants(profile), effectiveModel: profile.model.inherit ? defaults.model : validateModel(profile.model), workspaceRevision: defaults.revision };
  const previous = (await db.prepare("SELECT prompt,result,error,state FROM runs WHERE conversation_id=? AND agent_id=? AND id<>? AND state IN ('completed','failed','cancelled','interrupted') ORDER BY created_at,id").bind(run.conversation_id, profile.id, run.id).all<Row>()).results;
  const history = conversationHistory(previous.map(row => ({ prompt: String(row.prompt), result: row.result ? String(row.result) : null, error: row.error ? String(row.error) : null, state: String(row.state) })));
  const active = "('running','waiting_approval','waiting_input')", cutoff = new Date(Date.now() - machineGraceMs(machine)).toISOString();
  const results = await db.batch([
    db.prepare(`UPDATE runs SET state='running',machine_id=?,command_id=?,updated_at=? WHERE id=? AND state='queued'
      AND EXISTS (SELECT 1 FROM agent_profiles WHERE id=? AND revision=?)
      AND COALESCE((SELECT revision FROM workspace_settings WHERE id=1),0)=?
      AND EXISTS (SELECT 1 FROM machines WHERE id=? AND revoked_at IS NULL AND last_seen_at>? AND (reserved_agent_id IS NULL OR reserved_agent_id=?))
      AND NOT EXISTS (SELECT 1 FROM agent_transfers WHERE agent_id=? AND state IN ('queued','exporting','importing','verifying'))
      AND NOT EXISTS (SELECT 1 FROM runs WHERE agent_id=? AND state IN ${active})
      AND (SELECT COUNT(*) FROM runs WHERE state IN ${active})<4
      AND (COALESCE((SELECT depth FROM run_relations WHERE run_id=?),0)>0 OR (SELECT COUNT(*) FROM runs LEFT JOIN run_relations ON run_relations.run_id=runs.id WHERE COALESCE(run_relations.depth,0)=0 AND runs.state IN ${active})<2)
      AND (SELECT COUNT(*) FROM runs WHERE machine_id=? AND state IN ${active})<?
      AND (?<>'existing' OR NOT EXISTS (SELECT 1 FROM runs JOIN run_snapshots ON run_snapshots.run_id=runs.id WHERE runs.machine_id=? AND runs.state IN ${active} AND json_extract(run_snapshots.json,'$.computer.desktop')='existing'))`)
      .bind(profile.computer.machineId, commandId, created, run.id, profile.id, profile.revision, defaults.revision, profile.computer.machineId, cutoff, profile.id, profile.id, profile.id, run.id, profile.computer.machineId, profile.computer.resources.concurrency, profile.computer.desktop, profile.computer.machineId),
    db.prepare('INSERT OR REPLACE INTO run_snapshots SELECT id,?,? FROM runs WHERE id=? AND command_id=?').bind(JSON.stringify(snapshot), created, run.id, commandId),
    db.prepare('INSERT INTO runner_commands(id,machine_id,agent_id,kind,payload_json,state,created_at) SELECT ?,machine_id,agent_id,?,?,?,? FROM runs WHERE id=? AND command_id=?').bind(commandId, 'run', JSON.stringify({ runId: run.id, prompt: run.prompt, history, snapshot, secrets: {}, coordinationToken }), 'queued', created, run.id, commandId),
    db.prepare('INSERT OR REPLACE INTO run_credentials SELECT id,agent_id,?,? FROM runs WHERE id=? AND command_id=?').bind(await digest(coordinationToken), created, run.id, commandId),
    db.prepare('INSERT INTO run_events(id,run_id,type,payload_json,created_at) SELECT ?,id,?,?,? FROM runs WHERE id=? AND command_id=?').bind(id(), 'runner.dispatched', JSON.stringify({ commandId, machineId: profile.computer.machineId }), created, run.id, commandId),
  ]);
  return Boolean(results[0].meta.changes);
}

async function stopHostedRunTree(db: D1Database, runId: string) {
  const rows = (await db.prepare(`WITH RECURSIVE tree(id) AS (SELECT id FROM runs WHERE id=? UNION SELECT run_relations.run_id FROM run_relations JOIN tree ON run_relations.parent_run_id=tree.id) SELECT runs.* FROM runs JOIN tree ON runs.id=tree.id WHERE runs.state IN ('queued','running','waiting_approval','waiting_input')`).bind(runId).all<Row>()).results;
  let pending = false;
  for (const run of rows) {
    const now = stamp();
    if (run.command_id) {
      pending = true;
      await db.prepare("INSERT INTO runner_commands(id,machine_id,agent_id,kind,payload_json,state,created_at) SELECT ?,machine_id,agent_id,'stop',?,'queued',? FROM runs WHERE id=? AND state IN ('running','waiting_approval','waiting_input') AND NOT EXISTS (SELECT 1 FROM runner_commands WHERE kind='stop' AND json_extract(payload_json,'$.runId')=? AND state IN ('queued','leased'))")
        .bind(id(), JSON.stringify({ runId: run.id, commandId: run.command_id }), now, run.id, run.id).run();
    } else {
      await db.batch([
        db.prepare("UPDATE runs SET state='cancelled',updated_at=? WHERE id=? AND state='queued'").bind(now, run.id),
        db.prepare("INSERT INTO run_events(id,run_id,type,payload_json,created_at) SELECT ?,?,'run.cancelled','{}',? WHERE changes()=1").bind(id(), run.id, now),
      ]);
      await syncHostedTaskRun(db, String(run.id));
    }
  }
  return { ok: true, stopped: rows.length, pending };
}
async function finishHostedRun(db: D1Database, command: Row, result: Row | undefined, error: string | null) {
  const payload = JSON.parse(String(command.payload_json)) as Row, stop = command.kind === 'stop';
  const run = await db.prepare('SELECT * FROM runs WHERE command_id=?').bind(stop ? payload.commandId : command.id).first<Row>();
  const now = stamp(), stopRequested = run && await db.prepare("SELECT 1 FROM runner_commands WHERE kind='stop' AND json_extract(payload_json,'$.runId')=? AND state IN ('queued','leased','completed') LIMIT 1").bind(run.id).first();
  if (stop && error) {
    await db.prepare("UPDATE runner_commands SET state='failed',finished_at=?,result_json=? WHERE id=?").bind(now, JSON.stringify({ error }), command.id).run();
    if (run) await appendRunEvent(db, String(run.id), 'run.stop_failed', { error });
    return;
  }
  const state = stopRequested ? 'cancelled' : error ? 'failed' : 'completed';
  const runError = state === 'cancelled' ? null : error, text = state === 'completed' && result ? [result.text, result.final_response, result.message].find((value): value is string => typeof value === 'string' && value.length > 0) || null : null;
  const mutations = await db.batch([
    db.prepare("UPDATE runs SET state=?,result=?,error=?,updated_at=? WHERE command_id=? AND state IN ('running','waiting_approval','waiting_input')").bind(state, text, runError, now, stop ? payload.commandId : command.id),
    db.prepare('INSERT INTO run_events(id,run_id,type,payload_json,created_at) SELECT ?,?,?,?,? WHERE changes()=1').bind(id(), run?.id || '', `run.${state}`, JSON.stringify(runError ? { error: runError } : state === 'cancelled' ? { source: 'runner' } : { result: text }), now),
    db.prepare("UPDATE runner_commands SET state=?,finished_at=?,result_json=? WHERE id=? AND state NOT IN ('completed','failed')").bind(error ? 'failed' : 'completed', now, JSON.stringify(result || { error }), command.id),
    ...(run ? [
      db.prepare("DELETE FROM run_credentials WHERE run_id=? AND EXISTS (SELECT 1 FROM runs WHERE id=? AND state IN ('completed','failed','cancelled','interrupted'))").bind(run.id, run.id),
      db.prepare("UPDATE approvals SET state='cancelled',resolved_at=? WHERE run_id=? AND state='pending'").bind(now, run.id),
      db.prepare("UPDATE hosted_run_inputs SET state='cancelled',resolved_at=? WHERE run_id=? AND state='pending'").bind(now, run.id),
    ] : []),
  ]);
  if (run && mutations[0].meta.changes) {
    await syncHostedTaskRun(db, String(run.id));
    const relation = await db.prepare('SELECT parent_run_id FROM run_relations WHERE run_id=?').bind(run.id).first<Row>();
    if (relation?.parent_run_id) await appendRunEvent(db, String(relation.parent_run_id), 'handoff.completed', { childRunId: run.id, state });
  }
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
  if (task.activeRunId && ((body.stageId !== undefined && body.stageId !== task.stageId) || (body.ownerAgentId !== undefined && body.ownerAgentId !== task.ownerAgentId) || (body.boardId !== undefined && body.boardId !== task.boardId) || body.archived === true)) throw new HttpError(409, 'Stage, owner, and board are locked while this task is active.');
  if (body.position !== undefined && !Number.isFinite(Number(body.position))) throw new HttpError(400, 'Invalid task position.');
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

async function moveHostedTask(db: D1Database, taskId: string, body: Row, automatic = true) {
  const task = await getTask(db, taskId), board = await getBoard(db, task.boardId);
  if (task.activeRunId) throw new HttpError(409, 'Stage and owner are locked while this task is active.');
  const stageId = required(body.stageId, 'Stage'), siblings = (await db.prepare('SELECT id,position FROM tasks WHERE stage_id=? AND archived=0 AND id<>? ORDER BY position,id').bind(stageId, taskId).all<Row>()).results;
  const before = body.beforeId ? siblings.findIndex(row => row.id === body.beforeId) : -1;
  const position = body.position !== undefined ? Number(body.position) : before < 0 ? (siblings.length ? Number(siblings.at(-1)?.position) + 1000 : 1000) : before === 0 ? Number(siblings[0].position) - 1000 : (Number(siblings[before - 1].position) + Number(siblings[before].position)) / 2;
  const moved = await updateTask(db, taskId, { ...body, stageId, position, revision: task.revision });
  if (automatic && stageId !== task.stageId && stageId === board.settings.runStageId && board.settings.autoRunOnDrop && moved.ownerAgentId) {
    return (await startTask(db, taskId, { revision: moved.revision, idempotencyKey: `move-${moved.revision}` })).task;
  }
  return moved;
}
async function internalTask(db: D1Database, scoped: NonNullable<Awaited<ReturnType<typeof internalRun>>>, body: Row) {
  const profile = scoped.snapshot, agentId = String(scoped.run.agent_id), action = String(body.action || ''), taskId = String(body.taskId || ''), patch = body.input && typeof body.input === 'object' ? body.input as Row : {};
  if (!profile.allowedTools.includes('mcp_open_harness_task')) throw new HttpError(403, 'Task board access is disabled for this run.');
  const mayTouch = (task: AgentTask) => !task.ownerAgentId || task.ownerAgentId === agentId || profile.board.assignOthers;
  const mayAssign = (owner: unknown) => !owner || owner === agentId || profile.board.assignOthers;
  if (action === 'columns') return { boards: await listBoards(db, false) };
  if (action === 'list') return { boards: await listBoards(db, false), tasks: (await listTasks(db, false)).filter(mayTouch) };
  if (action === 'create') {
    if (!mayAssign(patch.ownerAgentId)) throw new HttpError(403, 'Assigning another agent requires Board: assign others.');
    return createTask(db, { ...patch, boardId: patch.boardId || body.boardId, ownerAgentId: patch.ownerAgentId === undefined ? agentId : patch.ownerAgentId });
  }
  const task = await getTask(db, taskId);
  if (!mayTouch(task) || !mayAssign(patch.ownerAgentId)) throw new HttpError(403, 'Changing another agent’s card requires Board: assign others.');
  if (action === 'get') return task;
  if (action === 'update') return updateTask(db, taskId, { ...patch, revision: task.revision });
  if (action === 'move') return moveHostedTask(db, taskId, patch, false);
  if (action === 'comment') return commentTask(db, taskId, { body: patch.text || patch.body, author: profile.name });
  if (action === 'claim') return updateTask(db, taskId, { revision: task.revision, ownerAgentId: agentId });
  if (action === 'release') { await updateTask(db, taskId, { revision: task.revision, ownerAgentId: null }); return commentTask(db, taskId, { body: String(patch.reason || 'Released as blocked.'), author: profile.name }); }
  if (action === 'additem') return updateTask(db, taskId, { revision: task.revision, checklist: [...task.checklist, { id: id(), text: required(patch.text, 'Checklist item', 500), done: false }] });
  if (action === 'check') {
    const item = task.checklist.find(item => item.id === String(patch.item || '')) || task.checklist[Number(patch.item) - 1];
    if (!item) throw new HttpError(404, 'Checklist item not found.');
    return updateTask(db, taskId, { revision: task.revision, checklist: task.checklist.map(entry => entry.id === item.id ? { ...entry, done: patch.done === undefined ? !entry.done : Boolean(patch.done) } : entry) });
  }
  if (action === 'run') {
    if (task.ownerAgentId !== agentId && !profile.board.dispatch) throw new HttpError(403, 'Starting another agent’s task requires Board: dispatch.');
    if (!(await getBoard(db, task.boardId)).settings.allowAgentDispatch) throw new HttpError(403, 'Agent task dispatch is disabled for this board.');
    return startTask(db, taskId, { revision: task.revision, idempotencyKey: id() });
  }
  throw new HttpError(400, 'Unknown task action.');
}

async function commentTask(db: D1Database, taskId: string, body: Row) {
  const task = await getTask(db, taskId), now = stamp();
  const comments = [...task.comments, { id: id(), body: required(body.body, "Comment", 5_000), author: String(body.author || 'you').slice(0, 80), createdAt: now }];
  const activity = [{ id: id(), type: "commented", detail: "Comment added", createdAt: now }, ...task.activity].slice(0, 200);
  const changed = await db.prepare("UPDATE tasks SET comments_json=?,activity_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?").bind(JSON.stringify(comments), JSON.stringify(activity), now, taskId, task.revision).run();
  if (!changed.meta.changes) throw new HttpError(409, 'This task changed elsewhere. Refresh and try again.');
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
  if (task.archived || board.archived) throw new HttpError(409, 'Restore this task and board before starting work.');
  const profile = normalizeProfile(JSON.parse(String(profileRow.json))), runId = id(), now = stamp();
  if (!await db.prepare('SELECT 1 FROM machines WHERE id=? AND revoked_at IS NULL').bind(profile.computer.machineId).first()) throw new HttpError(409, 'Choose a connected computer for this task’s agent before starting work.');
  // Link and claim the card before a runner can see its command. A duplicate or
  // conflicting start must not leave behind unlinked work that still executes.
  const results = await db.batch([
    db.prepare(`INSERT INTO runs(id,agent_id,conversation_id,prompt,state,machine_id,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,? FROM tasks WHERE id=? AND revision=? AND archived=0
      AND NOT EXISTS (SELECT 1 FROM runs WHERE id=tasks.active_run_id AND state IN ('queued','running','waiting_approval','waiting_input'))
      AND NOT EXISTS (SELECT 1 FROM task_runs WHERE idempotency_key=?)`)
      .bind(runId, profile.id, `task-${task.id}-${id()}`, prompt, 'queued', profile.computer.machineId, now, now, taskId, task.revision, `${taskId}:${key}`),
    db.prepare('INSERT INTO run_relations SELECT id,NULL,0 FROM runs WHERE id=?').bind(runId),
    db.prepare('INSERT INTO task_runs(task_id,run_id,attempt,idempotency_key,started_at) SELECT ?,id,(SELECT COALESCE(MAX(attempt),0)+1 FROM task_runs WHERE task_id=?),?,? FROM runs WHERE id=?').bind(taskId, taskId, `${taskId}:${key}`, now, runId),
    db.prepare('UPDATE tasks SET stage_id=?,active_run_id=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND EXISTS (SELECT 1 FROM runs WHERE id=?)').bind(runStage.id, runId, now, taskId, task.revision, runId),
    db.prepare("INSERT INTO run_events(id,run_id,type,payload_json,created_at) SELECT ?,id,'run.queued',?,? FROM runs WHERE id=?").bind(id(), JSON.stringify({ machineId: profile.computer.machineId }), now, runId),
  ]);
  if (!results[0].meta.changes) {
    const existing = await db.prepare('SELECT run_id FROM task_runs WHERE idempotency_key=?').bind(`${taskId}:${key}`).first<Row>();
    if (existing) return { task: await getTask(db, taskId), run: await publicRun(db, await db.prepare('SELECT * FROM runs WHERE id=?').bind(existing.run_id).first<Row>() as Row) };
    throw new HttpError(409, 'This task changed elsewhere or already has active work.');
  }
  const run = await db.prepare('SELECT * FROM runs WHERE id=?').bind(runId).first<Row>() as Row;
  await dispatchHostedRun(db, run, profile);
  return { task: await getTask(db, taskId), run: await publicRun(db, await db.prepare('SELECT * FROM runs WHERE id=?').bind(runId).first<Row>() as Row) };
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
  if (task.activeRunId) throw new HttpError(409, 'Wait for the active run to finish.');
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
    // A phone cannot obtain the platform's signed-in-user header, so its own device
    // credential stands in for it. Revoking the phone closes this door with it.
    if (!runnerFacing && !request.headers.get('oai-authenticated-user-id') && !(await deviceMachine(db, request))) throw new HttpError(401, 'Sign in to manage this workspace.');
    if (pathname === '/v1/device/session' && request.method === 'GET') {
      const device = await deviceMachine(db, request);
      if (!device) throw new HttpError(401, 'Pair this phone again to reconnect it.');
      const now = stamp();
      await db.prepare("UPDATE machines SET status='online',last_seen_at=?,updated_at=? WHERE id=?").bind(now, now, device.id).run();
      return json({ token: '', machine: mapMachine({ ...device, last_seen_at: now }), runtime: { available: true, version: 'companion', message: 'This phone is a companion dashboard. Agents run on a connected computer.' }, version: '0.3.0', hermes: { release: 'v2026.9.11', commit: '939e45c91d751fadd94dcd1b873ac3cb44846213' } });
    }

    if (pathname === "/v1/bootstrap" && request.method === "GET") return json({ token: "hosted-site", runtime: { available: true, version: 'runner', message: "Connect a computer to run agents from this hosted dashboard." }, version: "0.3.0", hermes: { release: "v2026.9.11", commit: "939e45c91d751fadd94dcd1b873ac3cb44846213" } });
    if (pathname === '/internal/task' && request.method === 'POST') {
      const scoped = await internalRun(db, request); if (!scoped) throw new HttpError(401, 'Invalid or expired run credential.');
      return json(await internalTask(db, scoped, body));
    }
    if ((pathname === '/internal/handoff' || pathname === '/internal/schedule') && request.method === 'POST') {
      const scoped = await internalRun(db, request); if (!scoped) throw new HttpError(401, 'Invalid or expired run credential.');
      const tool = pathname === '/internal/handoff' ? 'mcp_open_harness_delegate_named_agent' : 'mcp_open_harness_create_open_harness_routine';
      if (!scoped.snapshot.allowedTools.includes(tool)) throw new HttpError(403, pathname === '/internal/handoff' ? 'Delegation is disabled for this run.' : 'Scheduling is disabled for this run.');
      if (pathname === '/internal/schedule') {
        const routineId = id(), now = stamp(), minutes = intervalMinutes(body.intervalMinutes === undefined ? 60 : body.intervalMinutes), next = new Date(Date.now() + minutes * 60_000).toISOString();
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
      const pairedKind = String(pairing.kind || 'runner') === 'device' ? 'device' : 'runner';
      const machineId = `machine-${id()}`, token = crypto.randomUUID() + crypto.randomUUID(), now = stamp();
      const encryptionPublicKey = String(body.encryptionPublicKey || '');
      if (encryptionPublicKey) { try { const key = JSON.parse(encryptionPublicKey) as Row; if (key.kty !== 'RSA' || key.alg && key.alg !== 'RSA-OAEP-256') throw new Error(); } catch { throw new HttpError(400, 'The runner supplied an invalid encryption key.'); } }
      const used = await db.prepare('UPDATE machine_pairings SET used_at=? WHERE id=? AND used_at IS NULL').bind(now, pairing.id).run(); if (!used.meta.changes) throw new HttpError(409, 'This pairing code was already used.');
      const supplied = body.capabilities && typeof body.capabilities === 'object' ? body.capabilities as Row : {};
      const pairedCapabilities = pairedKind === 'device' ? { container: false, direct: false, desktop: false, virtualDesktop: false, detail: 'Companion dashboard only; agents run on a connected computer.', ...supplied, mobile: true } : supplied;
      await db.prepare('INSERT INTO machines(id,name,platform,arch,status,last_seen_at,reserved_agent_id,capabilities_json,credential_hash,revoked_at,created_at,updated_at,encryption_public_key,kind) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(machineId, String(body.name || pairing.name).slice(0,80), String(body.platform || pairing.platform), String(body.arch || 'unknown'), 'online', now, null, JSON.stringify(pairedCapabilities), await digest(token), null, now, now, encryptionPublicKey || null, pairedKind).run();
      return json({ machineId, token, machine: mapMachine({ id: machineId, name: body.name || pairing.name, platform: body.platform || pairing.platform, arch: body.arch || 'unknown', last_seen_at: now, capabilities_json: JSON.stringify(pairedCapabilities), kind: pairedKind }) }, 201);
    }
    if (pathname.startsWith('/v1/runner/')) {
      const runner = await runnerMachine(db, request); if (!runner) throw new HttpError(401, 'Invalid or revoked runner credential.'); const machineId = String(runner.id);
      if (String(runner.kind || 'runner') === 'device' || machineCapabilities(runner).mobile) throw new HttpError(403, 'Phone credentials authorize the companion dashboard, not runner commands.');
      if (pathname === '/v1/runner/heartbeat' && request.method === 'POST') {
        const now = stamp(); await db.prepare("UPDATE machines SET status='online',last_seen_at=?,capabilities_json=?,encryption_public_key=COALESCE(?,encryption_public_key),updated_at=? WHERE id=?").bind(now, JSON.stringify(body.capabilities || {}), body.encryptionPublicKey ? String(body.encryptionPublicKey) : null, now, machineId).run();
        const activeIds = new Set(Array.isArray(body.activeCommandIds) ? body.activeCommandIds.map(String) : []), cutoff = new Date(Date.now() - machineGraceMs(runner)).toISOString(), leased = (await db.prepare("SELECT * FROM runner_commands WHERE machine_id=? AND state='leased' AND leased_at<?").bind(machineId, cutoff).all<Row>()).results.filter(command => !activeIds.has(String(command.id)));
        for (const command of leased) {
          const error = 'Runner restarted after accepting this work. Completed events were preserved and the task was not replayed.', run = await db.prepare('SELECT id FROM runs WHERE command_id=?').bind(command.id).first<Row>();
          await db.batch([db.prepare("UPDATE runner_commands SET state='failed',finished_at=?,result_json=? WHERE id=? AND state='leased'").bind(now, JSON.stringify({ error, interrupted: true }), command.id), db.prepare("UPDATE runs SET state='interrupted',error=?,updated_at=? WHERE command_id=? AND state NOT IN ('completed','failed','cancelled','interrupted')").bind(error, now, command.id), ...(run ? [db.prepare('DELETE FROM run_credentials WHERE run_id=?').bind(run.id)] : [])]);
          if (run) { await appendRunEvent(db, String(run.id), 'run.interrupted', { error }); await syncHostedTaskRun(db, String(run.id)); }
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
        if (runnerCommand[2] === 'events') {
          const run = await db.prepare('SELECT * FROM runs WHERE command_id=? AND machine_id=? AND agent_id=?').bind(command.id, machineId, command.agent_id).first<Row>();
          if (command.kind !== 'run' || !run || String(body.runId || '') !== run.id) throw new HttpError(403, 'This command does not own that run.');
          const eventId = required(body.eventId, 'Event ID'), event = body.event as Row || {}, eventType = String(event.type || 'runtime.event'), eventPayload = (event.payload || event) as Row;
          const duplicate = await db.prepare('SELECT 1 FROM runner_event_receipts WHERE command_id=? AND event_id=?').bind(command.id, eventId).first();
          if (duplicate) return json({ ok: true, duplicate: true });
          if (!['running','waiting_approval','waiting_input'].includes(String(run.state))) return json({ ok: true, ignored: true });
          const approvalId = id(), inputId = id(), now = stamp(), approval = eventType === 'approval.request';
          const inputType = /^(clarify|secret|sudo)\.request$/.exec(eventType)?.[1], expiredType = /^(clarify|secret|sudo)\.expire$/.exec(eventType)?.[1];
          const payload = approval ? { ...eventPayload, approvalId } : inputType ? { ...eventPayload, inputId } : eventPayload;
          // The receipt, visible event and approval transition commit together. A retry
          // after a lost response must neither create a second approval nor lose an event.
          await db.batch([
            db.prepare("INSERT OR IGNORE INTO run_events(id,run_id,type,payload_json,created_at) SELECT ?,id,?,?,? FROM runs WHERE id=? AND command_id=? AND state IN ('running','waiting_approval','waiting_input')").bind(eventId, eventType, JSON.stringify(payload), now, run.id, command.id),
            ...(approval ? [
              db.prepare('INSERT INTO approvals SELECT ?,?,?,?,?,NULL WHERE changes()=1').bind(approvalId, run.id, String(eventPayload.request_id || eventPayload.id || ''), 'pending', now),
              db.prepare("UPDATE runs SET state='waiting_approval',updated_at=? WHERE id=? AND EXISTS (SELECT 1 FROM approvals WHERE id=?) AND state IN ('running','waiting_approval','waiting_input')").bind(now, run.id, approvalId),
            ] : []),
            ...(inputType ? [
              db.prepare('INSERT INTO hosted_run_inputs SELECT ?,?,?,?,?,?,?,NULL WHERE changes()=1').bind(inputId, run.id, String(eventPayload.request_id || eventPayload.id || ''), inputType, JSON.stringify(eventPayload), 'pending', now),
              db.prepare("UPDATE runs SET state='waiting_input',updated_at=? WHERE id=? AND EXISTS (SELECT 1 FROM hosted_run_inputs WHERE id=?) AND state IN ('running','waiting_approval','waiting_input')").bind(now, run.id, inputId),
            ] : []),
            ...(expiredType ? [
              db.prepare("UPDATE hosted_run_inputs SET state='expired',resolved_at=? WHERE run_id=? AND gateway_request_id=? AND type=? AND state IN ('pending','submitted')").bind(now, run.id, String(eventPayload.request_id || eventPayload.id || ''), expiredType),
              db.prepare("UPDATE runs SET state=CASE WHEN EXISTS (SELECT 1 FROM approvals WHERE run_id=? AND state='pending') THEN 'waiting_approval' WHEN EXISTS (SELECT 1 FROM hosted_run_inputs WHERE run_id=? AND state='pending') THEN 'waiting_input' ELSE 'running' END,updated_at=? WHERE id=? AND state IN ('running','waiting_approval','waiting_input')").bind(run.id, run.id, now, run.id),
            ] : []),
            db.prepare('INSERT OR IGNORE INTO runner_event_receipts SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM run_events WHERE id=? AND run_id=?)').bind(command.id, eventId, now, eventId, run.id),
          ]);
          return json({ ok: true });
        }
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
          const effective = pending ? await effectiveModel(db, pending) : null;
          const requiredSecrets = pending ? [effective?.credentialRef || '', ...pending.connectors.filter(item => item.enabled).map(item => item.secretRef)].filter(Boolean) : [];
          const importCommandId = await enqueueRunnerCommand(db, String(transfer.destination_machine_id), String(transfer.agent_id), 'import-agent', { transferId: transfer.id, profile: pending, requiredSecrets }); await db.prepare("UPDATE agent_transfers SET state='importing',detail='Checking the destination and importing data.',import_command_id=?,checksum=?,updated_at=? WHERE id=?").bind(importCommandId, result.checksum, now, transfer.id).run(); return json({ ok: true });
        }
        if (command.kind === 'import-agent') {
          const transfer = await db.prepare('SELECT * FROM agent_transfers WHERE import_command_id=?').bind(command.id).first<Row>(); await db.prepare('UPDATE runner_commands SET state=?,finished_at=?,result_json=? WHERE id=?').bind(error ? 'failed' : 'completed', now, JSON.stringify(result || { error }), command.id).run();
          if (transfer) {
            const verified = !error && result && result.validated === true && String(result.checksum) === String(transfer.checksum), pending = transfer.pending_profile_json ? validateProfile(JSON.parse(String(transfer.pending_profile_json))) : null;
            if (verified && pending) await db.batch([
              db.prepare('UPDATE agent_profiles SET revision=?,json=?,updated_at=? WHERE id=?').bind(pending.revision, JSON.stringify(pending), now, transfer.agent_id),
              db.prepare("UPDATE runs SET machine_id=? WHERE agent_id=? AND state='queued'").bind(pending.computer.machineId, transfer.agent_id),
              db.prepare('UPDATE machines SET reserved_agent_id=NULL,updated_at=? WHERE id=? AND reserved_agent_id=?').bind(now, transfer.source_machine_id, transfer.agent_id),
              db.prepare('UPDATE machines SET reserved_agent_id=?,updated_at=? WHERE id=?').bind(pending.computer.reserveMachine ? transfer.agent_id : null, now, transfer.destination_machine_id),
            ]);
            if (!verified) await db.prepare('UPDATE machines SET reserved_agent_id=NULL,updated_at=? WHERE id=? AND reserved_agent_id=?').bind(now, transfer.destination_machine_id, transfer.agent_id).run();
            await db.prepare('UPDATE agent_transfers SET state=?,detail=?,updated_at=? WHERE id=?').bind(verified ? 'completed' : 'failed', verified ? `Transfer verified (${Number(result?.files || 0)} files). Assignment switched; source data was preserved.` : `${error || 'Destination checksum did not match the source.'} Source assignment and data were preserved.`, now, transfer.id).run(); if (verified) await db.prepare('DELETE FROM transfer_chunks WHERE transfer_id=?').bind(transfer.id).run();
          } return json({ ok: true });
        }
        if (command.kind === 'input' || command.kind === 'approval') {
          const payload = JSON.parse(String(command.payload_json)) as Row;
          const table = command.kind === 'input' ? 'hosted_run_inputs' : 'approvals', requestId = command.kind === 'input' ? payload.inputId : payload.approvalId;
          await db.batch([
            db.prepare("UPDATE runner_commands SET state=?,finished_at=?,result_json=? WHERE id=? AND state NOT IN ('completed','failed')").bind(error ? 'failed' : 'completed', now, JSON.stringify(result || { error }), command.id),
            db.prepare(`UPDATE ${table} SET state=?,resolved_at=? WHERE id=? AND run_id=? AND state<>'expired' AND EXISTS (SELECT 1 FROM runs WHERE id=? AND state IN ('running','waiting_approval','waiting_input'))`).bind(error ? 'pending' : command.kind === 'approval' ? String(payload.decision) : 'resolved', error ? null : now, String(requestId || ''), payload.runId, payload.runId),
            db.prepare("UPDATE runs SET state=CASE WHEN EXISTS (SELECT 1 FROM approvals WHERE run_id=? AND state='pending') THEN 'waiting_approval' WHEN EXISTS (SELECT 1 FROM hosted_run_inputs WHERE run_id=? AND state='pending') THEN 'waiting_input' ELSE 'running' END,updated_at=? WHERE id=? AND state IN ('running','waiting_approval','waiting_input')").bind(payload.runId, payload.runId, now, payload.runId),
          ]);
          if (error) await appendRunEvent(db, String(payload.runId), 'input.delivery_failed', { error });
          return json({ ok: true });
        }
        await finishHostedRun(db, command, result, error);
        return json({ ok: true });
      }
      throw new HttpError(404, 'Runner endpoint not found.');
    }
    // A paired phone reads the workspace it joined rather than pushing its own starter
    // agents into it, so it needs a plain read that /v1/agents/sync does not provide.
    if (pathname === "/v1/agents" && request.method === "GET") {
      const rows = (await db.prepare('SELECT json FROM agent_profiles ORDER BY updated_at').all<Row>()).results;
      return json({ agents: rows.map(row => { const profile = normalizeProfile(JSON.parse(String(row.json))); return { id: profile.id, name: profile.name, role: profile.role, description: profile.description, tone: profile.tone, instructions: profile.prompt.text, memory: [], profile }; }) });
    }
    if (pathname === "/v1/agents/sync" && request.method === "POST") {
      const agents = Array.isArray(body.agents) ? body.agents as Agent[] : [], now = stamp();
      for (const agent of agents) { const existing = await db.prepare('SELECT 1 FROM agent_profiles WHERE id=?').bind(agent.id).first(); if (!existing) { const profile = validateProfile(draftProfile(agent)); await db.prepare('INSERT OR IGNORE INTO agent_profiles VALUES(?,?,?,?)').bind(profile.id, 1, JSON.stringify({ ...profile, revision: 1 }), now).run(); } }
      const rows = (await db.prepare('SELECT json FROM agent_profiles ORDER BY updated_at').all<Row>()).results; return json({ agents: rows.map(row => { const profile = normalizeProfile(JSON.parse(String(row.json))); return { id: profile.id, name: profile.name, role: profile.role, description: profile.description, tone: profile.tone, instructions: profile.prompt.text, memory: [], profile }; }) });
    }
    if (pathname === "/v1/migrate" && request.method === "POST") return json({ migrated: false, reason: "hosted" });
    if (pathname === '/v1/health' && request.method === 'GET') return json({ ok: true, runtime: { available: true, message: 'Hosted coordinator is ready.' }, activeRuns: Number((await db.prepare("SELECT COUNT(*) AS count FROM runs WHERE state IN ('running','waiting_approval','waiting_input')").first<Row>())?.count || 0), queuedRuns: Number((await db.prepare("SELECT COUNT(*) AS count FROM runs WHERE state='queued'").first<Row>())?.count || 0), secrets: (await db.prepare('SELECT DISTINCT name FROM machine_secrets ORDER BY name').all<Row>()).results.map(row => String(row.name)), secretStorage: 'selected runner OS vault' });
    if (pathname === '/v1/support-bundle' && request.method === 'GET') return json({ generatedAt: stamp(), version: '0.3.0', platform: { os: 'hosted', arch: 'managed' }, machines: await machineList(db), recentRuns: (await db.prepare('SELECT id,agent_id,state,machine_id,created_at,updated_at,error FROM runs ORDER BY created_at DESC LIMIT 25').all<Row>()).results, note: 'Secret values, prompts, messages, results, and file contents are excluded.' });
    if (pathname === '/v1/onboarding/status' && request.method === 'GET') {
      const connected = await machineList(db), online = connected.filter(machine => machine.status === 'online' && machine.kind === 'runner' && !machine.capabilities.mobile), credentialMachineId = online[0]?.id;
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
    if (pathname === '/v1/onboarding/model-test' && request.method === 'POST') {
      const model = validateModel(body.model as typeof DEFAULT_MODEL), defaults = await workspaceDefaults(db);
      const revision = body.revision === undefined ? defaults.revision : Number(body.revision);
      if (body.save && (!Number.isInteger(revision) || revision !== defaults.revision)) throw new HttpError(409, 'Workspace settings changed elsewhere. Reload before saving.');
      const candidates = (await machineList(db)).filter(machine => machine.kind === 'runner' && !machine.capabilities.mobile && machine.status === 'online');
      const machineId = body.machineId ? String(body.machineId) : candidates[0]?.id;
      if (!machineId || !candidates.some(machine => machine.id === machineId)) throw new HttpError(409, 'Connect a computer before testing this model.');
      const machine = await db.prepare('SELECT * FROM machines WHERE id=?').bind(machineId).first<Row>() as Row;
      const apiKey = body.apiKey === undefined ? '' : String(body.apiKey);
      if (apiKey.length > 100_000) throw new HttpError(400, 'Credential is too large.');
      if (apiKey && !machine.encryption_public_key) throw new HttpError(409, 'Reconnect this runner before testing a new credential.');
      const encryptedApiKey = apiKey ? await encryptRunnerSecret(String(machine.encryption_public_key), apiKey) : undefined;
      const profile = draftProfile({ id: `model-test-${id()}`, name: 'Model test', role: 'Model connection test', description: '', instructions: '', memory: [], tone: 0 });
      profile.computer.machineId = machineId; profile.model = { ...model, inherit: false };
      const result = await hostedProbe(db, profile, 'probe-runtime', { action: 'model-test', model }, encryptedApiKey ? { encryptedApiKey } : {});
      if (!result.ok || !body.save) return json(result);
      if ((await workspaceDefaults(db)).revision !== revision) throw new HttpError(409, 'Workspace settings changed while testing. Your previous model and key were preserved.');
      let savedModel = model;
      if (encryptedApiKey) {
        // A D1 transaction cannot include a runner vault. Write a new credential
        // name, then atomically point the workspace at it; failed saves never
        // overwrite the credential used by the current working configuration.
        const credentialRef = `MODEL_${id().replaceAll('-','').toUpperCase()}`;
        const commandId = await enqueueRunnerCommand(db, machineId, null, 'store-secret', { name: credentialRef, encrypted: encryptedApiKey });
        const deadline = Date.now() + 25_000; let stored = false;
        while (Date.now() < deadline) {
          const command = await db.prepare('SELECT state,result_json FROM runner_commands WHERE id=?').bind(commandId).first<Row>();
          if (command?.state === 'failed') throw new HttpError(502, 'The runner could not save the tested credential. Your previous model and key were preserved.');
          if (command?.state === 'completed') { stored = true; break; }
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (!stored) throw new HttpError(504, 'The runner did not confirm credential storage. Your previous model and key were preserved.');
        savedModel = { ...model, credentialRef };
      }
      const saved = await db.prepare('INSERT INTO workspace_settings SELECT 1,?,? WHERE ?=COALESCE((SELECT revision FROM workspace_settings WHERE id=1),0) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,json=excluded.json WHERE workspace_settings.revision=?').bind(revision + 1, JSON.stringify(savedModel), revision, revision).run();
      if (!saved.meta.changes) throw new HttpError(409, 'Workspace settings changed while saving. The previous model and key were preserved.');
      return json({ ...result, model: savedModel, revision: revision + 1 });
    }
    if (pathname === '/v1/workspace/model/import' && request.method === 'POST') {
      const model = validateModel((body.model || DEFAULT_MODEL) as typeof DEFAULT_MODEL);
      await db.prepare('INSERT OR IGNORE INTO workspace_settings VALUES(1,0,?)').bind(JSON.stringify(model)).run();
      return json(await workspaceDefaults(db));
    }
    if (pathname === '/v1/workspace/model') {
      if (request.method === 'GET') return json(await workspaceDefaults(db));
      if (request.method === 'PUT') {
        const revision = Number(body.revision), model = validateModel(body.model as typeof DEFAULT_MODEL);
        if (!Number.isInteger(revision) || revision < 0) throw new HttpError(400, 'Invalid workspace revision.');
        const result = await db.prepare('INSERT INTO workspace_settings SELECT 1,?,? WHERE ?=COALESCE((SELECT revision FROM workspace_settings WHERE id=1),0) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,json=excluded.json WHERE workspace_settings.revision=?').bind(revision + 1, JSON.stringify(model), revision, revision).run();
        if (!result.meta.changes) throw new HttpError(409, 'Workspace settings changed elsewhere.');
        return json({ model, revision: revision + 1 });
      }
    }
    if (pathname === '/v1/machines') {
      if (request.method === 'GET') return json({ machines: await machineList(db) });
      if (request.method === 'POST') {
        const phone = String(body.platform) === 'ios' || String(body.platform) === 'android';
        const pairingKind = body.kind === 'device' || phone ? 'device' : 'runner';
        if (pairingKind === 'device' && !phone) throw new HttpError(400, 'Choose iPhone or Android to pair a phone.');
        // A phone code is typed by hand, so it trades length for legibility: 60 bits of
        // Crockford base32 without the characters that read alike. The ten minute expiry and
        // single use are what keep it safe.
        const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
        const code = pairingKind === 'device'
          ? [...crypto.getRandomValues(new Uint8Array(12))].map(byte => alphabet[byte % alphabet.length]).join('')
          : crypto.randomUUID().replaceAll('-','') + crypto.randomUUID().replaceAll('-','');
        const pairingId = id(), expiresAt = new Date(Date.now() + 600_000).toISOString(), platform = ['linux','darwin','win32','ios','android'].includes(String(body.platform)) ? String(body.platform) : 'linux', base = `${new URL(request.url).origin}/api/control`;
        await db.prepare('INSERT INTO machine_pairings(id,code_hash,name,platform,expires_at,used_at,created_at,kind) VALUES(?,?,?,?,?,?,?,?)').bind(pairingId, await digest(code), String(body.name || (pairingKind === 'device' ? 'New phone' : 'New computer')).slice(0,80), platform, expiresAt, null, stamp(), pairingKind).run();
        if (pairingKind === 'device') {
          const enrollment = new URL('openharness://pair');
          enrollment.searchParams.set('hub', base);
          enrollment.searchParams.set('code', code);
          if (sitesBypassToken()) enrollment.searchParams.set('sites', sitesBypassToken());
          return json({ id: pairingId, code, expiresAt, platform, kind: pairingKind, hubUrl: base, pairingUri: enrollment.toString() }, 201);
        }
        const sitesToken = sitesBypassToken(), sh = (value: string) => `'${value.replaceAll("'", "'\\''")}'`, ps = (value: string) => value.replaceAll("'", "''");
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
      if (hostedMachine[2] === 'reconnect') return json({ ok: machineReachable(mapped.status), message: mapped.status === 'online' ? `${mapped.name} is connected.` : mapped.status === 'suspended' ? `${mapped.name} is asleep. Work you start now runs when it wakes up.` : mapped.kind === 'device' ? `Waiting for ${mapped.name} to reconnect. Open Open Harness on that phone.` : `Waiting for ${mapped.name} to reconnect. The runner only needs outbound HTTPS access.` });
      const profileRow = body.agentId ? await db.prepare('SELECT json FROM agent_profiles WHERE id=?').bind(body.agentId).first<Row>() : null, profile = profileRow ? normalizeProfile(JSON.parse(String(profileRow.json))) : null, issues: string[] = [];
      const phone = Boolean(mapped.capabilities.mobile);
      if (!machineReachable(mapped.status)) issues.push(phone ? 'Phone is not connected.' : 'Runner is offline.');
      if (phone || profile?.computer.access === 'mobile') issues.push('Phones are companion dashboards in this release and cannot run agents. Choose a connected computer.');
      if (phone && profile && profile.computer.desktop !== 'none') issues.push('Phones cannot control a desktop. Set Desktop access to No desktop.');
      if (phone && profile && profile.computer.folders.length) issues.push('Phones do not mount host folders. Remove the selected folders.');
      if (profile?.computer.access === 'private' && !mapped.capabilities.container) issues.push('Container execution is unavailable.'); if (profile?.computer.access === 'direct' && !mapped.capabilities.direct) issues.push(`Direct execution is unavailable. ${mapped.capabilities.detail || 'Install Hermes and the Open Harness policy extension on the runner.'}`); if (profile?.computer.desktop === 'existing' && !mapped.capabilities.desktop) issues.push(mapped.platform === 'darwin' ? 'Grant Accessibility and Screen Recording to the runner.' : mapped.platform === 'win32' ? 'Sign in to an interactive Windows session and start the runner there.' : 'Start a graphical session with DISPLAY or Wayland and enable AT-SPI.'); if (profile?.computer.desktop === 'virtual' && !mapped.capabilities.virtualDesktop) issues.push('Private virtual desktops are available on Linux runners only.');
      if (!issues.length && profile && hostedMachine[2] === 'test') { try { const result = await hostedProbe(db, profile, 'probe-runtime', { action: 'computer', desktop: profile.computer.desktop }); return json({ ok: Boolean(result.ok), message: String(result.message || `${mapped.name} is ready for this agent.`), machine: mapped }); } catch (error) { issues.push(error instanceof Error ? error.message : 'Computer access check failed.'); } }
      return json({ ok: !issues.length, message: issues.length ? issues.join(' ') : `${mapped.name} is ready for this agent.`, machine: mapped });
    }
    const hostedProfile = pathname.match(/^\/v1\/agents\/([^/]+)\/(profile|tools|models|connection-check|connector-check|stop|transfer)$/);
    if (hostedProfile) {
      const agentId = decodeURIComponent(hostedProfile[1]), action = hostedProfile[2], row = await db.prepare('SELECT * FROM agent_profiles WHERE id=?').bind(agentId).first<Row>(); if (!row) throw new HttpError(404, 'Agent profile not found.'); const profile = normalizeProfile(JSON.parse(String(row.json)));
      if (action === 'profile' && request.method === 'GET') { const machine = (await machineList(db)).find(item => item.id === profile.computer.machineId), transfer = await db.prepare('SELECT state,detail FROM agent_transfers WHERE agent_id=? ORDER BY created_at DESC LIMIT 1').bind(agentId).first<Row>(), secretNames = (await db.prepare('SELECT name FROM machine_secrets WHERE machine_id=? ORDER BY name').bind(profile.computer.machineId).all<Row>()).results.map(item => String(item.name)); return json({ profile, effectiveModel: await effectiveModel(db, profile), ...await profileRuntimeState(db, profile), secretNames, machine, transfer }); }
      if (action === 'profile' && request.method === 'PUT') {
        if (Number(body.revision) !== Number(row.revision)) throw new HttpError(409, 'This profile changed elsewhere. Reload before saving.');
        if (await activeTransfer(db, agentId)) throw new HttpError(409, 'This agent is already transferring. Wait for it to finish before editing its computer.');
        const validated = validateProfile({ ...(body as unknown as AgentProfile), id: agentId, revision: Number(row.revision) }), desired = { ...validated, revision: Number(row.revision) + 1 };
        const source = await db.prepare('SELECT id,revoked_at FROM machines WHERE id=?').bind(profile.computer.machineId).first<Row>();
        if (source?.revoked_at && profile.computer.machineId !== desired.computer.machineId) throw new HttpError(409, 'The source computer was revoked. Restore its data on a connected runner before transferring this agent.');
        const moving = profile.computer.machineId !== desired.computer.machineId && Boolean(source);
        const machine = await db.prepare('SELECT * FROM machines WHERE id=? AND revoked_at IS NULL').bind(desired.computer.machineId).first<Row>();
        if (!machine) throw new HttpError(400, 'Choose a connected computer.'); if (machine.kind === 'device' || machineCapabilities(machine).mobile) throw new HttpError(400, 'Phones are companion dashboards and cannot run agents.'); if (machine.reserved_agent_id && machine.reserved_agent_id !== agentId) throw new HttpError(409, 'This computer is reserved for another agent.');
        const saved = moving ? { ...desired, computer: profile.computer } : desired, now = stamp();
        const results = await db.batch([
          db.prepare('UPDATE agent_profiles SET revision=?,json=?,updated_at=? WHERE id=? AND revision=? AND EXISTS (SELECT 1 FROM machines WHERE id=? AND revoked_at IS NULL AND (reserved_agent_id IS NULL OR reserved_agent_id=?))').bind(saved.revision, JSON.stringify(saved), now, agentId, row.revision, desired.computer.machineId, agentId),
          db.prepare(`UPDATE machines SET reserved_agent_id=CASE WHEN id=? THEN ? ELSE NULL END,updated_at=? WHERE (id=? OR reserved_agent_id=?) AND EXISTS (SELECT 1 FROM agent_profiles WHERE id=? AND revision=? AND json=?)`)
            .bind(desired.computer.machineId, desired.computer.reserveMachine ? agentId : null, now, desired.computer.machineId, moving ? '' : agentId, agentId, saved.revision, JSON.stringify(saved)),
          db.prepare("UPDATE runs SET machine_id=? WHERE agent_id=? AND state='queued' AND EXISTS (SELECT 1 FROM agent_profiles WHERE id=? AND revision=? AND json=?)").bind(saved.computer.machineId, agentId, agentId, saved.revision, JSON.stringify(saved)),
        ]);
        if (!results[0].meta.changes) throw new HttpError(409, 'The profile or selected computer changed elsewhere. Reload before saving.');
        if (moving) { await beginHostedTransfer(db, agentId, profile.computer.machineId, desired.computer.machineId, desired); await startReadyTransfers(db, profile.computer.machineId); }
        const transfer = await db.prepare('SELECT state,detail FROM agent_transfers WHERE agent_id=? ORDER BY created_at DESC LIMIT 1').bind(agentId).first<Row>(), secretNames = (await db.prepare('SELECT name FROM machine_secrets WHERE machine_id=? ORDER BY name').bind(saved.computer.machineId).all<Row>()).results.map(item => String(item.name));
        return json({ profile: saved, effectiveModel: await effectiveModel(db, saved), ...await profileRuntimeState(db, saved), secretNames, machine: mapMachine(moving ? await db.prepare('SELECT * FROM machines WHERE id=?').bind(saved.computer.machineId).first<Row>() as Row : machine), transfer });
      }
      if (action === 'tools' && request.method === 'GET') return json(await hostedProbe(db, profile, 'probe-tools'));
      if (action === 'models' && request.method === 'GET') return json(await hostedProbe(db, profile, 'probe-models'));
      if (action === 'connection-check' && request.method === 'POST') { const model = body.model as Row || {}, tested = { ...profile, model: { ...profile.model, ...model, inherit: false } } as AgentProfile, endpoints: Record<string,string> = { xai: 'https://api.x.ai/v1', openrouter: 'https://openrouter.ai/api/v1', openai: 'https://api.openai.com/v1' }, baseUrl = String(model.baseUrl || endpoints[String(model.provider)] || ''); if (!baseUrl) return json({ ok: false, message: 'This provider has no compatible model-list endpoint. Hermes will check it when the task starts.' }); return json(await hostedProbe(db, tested, 'probe-runtime', { action: 'connection', baseUrl, apiKey: '' })); }
      if (action === 'connector-check' && request.method === 'POST') { const connector = body.connector as Row || {}, name = required(connector.name, 'Connection name', 80).replace(/[^a-zA-Z0-9_.-]/g, '-'), command = required(connector.command, 'Connection executable', 500), args = Array.isArray(connector.args) ? connector.args.map(value => String(value).slice(0, 2_000)).slice(0, 100) : [], secretRef = String(connector.secretRef || '').slice(0, 120), result = await hostedProbe(db, profile, 'probe-runtime', { action: 'mcp', command, args, env: secretRef ? { [secretRef]: '' } : {} }), tools = Array.isArray(result.tools) ? (result.tools as Row[]).map(tool => ({ id: `mcp_${name}_${String(tool.name)}`, name: String(tool.name), description: String(tool.description || ''), group: 'mcp', available: true })) : []; return json({ ...result, tools }); }
      if (action === 'stop' && request.method === 'POST') {
        const runs = (await db.prepare("SELECT id FROM runs WHERE agent_id=? AND state IN ('queued','running','waiting_approval','waiting_input')").bind(agentId).all<Row>()).results;
        let stopped = 0, pending = false;
        for (const run of runs) { const result = await stopHostedRunTree(db, String(run.id)); stopped += result.stopped; pending ||= result.pending; }
        return json({ ok: true, stopped, pending });
      }
      if (action === 'transfer' && request.method === 'POST') { const destination = required(body.destinationMachineId, 'Destination computer'), machine = await db.prepare('SELECT * FROM machines WHERE id=? AND revoked_at IS NULL').bind(destination).first<Row>(); if (!machine) throw new HttpError(404, 'Destination computer not found.'); if (machine.kind === 'device' || machineCapabilities(machine).mobile) throw new HttpError(400, 'Phones are companion dashboards and cannot run agents.'); if (machine.reserved_agent_id && machine.reserved_agent_id !== agentId) throw new HttpError(409, 'This computer is reserved for another agent.'); await beginHostedTransfer(db, agentId, profile.computer.machineId, destination, { ...profile, computer: { ...profile.computer, machineId: destination } }); await startReadyTransfers(db, profile.computer.machineId); return json(await activeTransfer(db, agentId) || { state: 'completed', detail: 'The agent is already assigned to this computer.' }, 202); }
    }
    if (pathname === '/v1/routines') {
      if (request.method === 'GET') {
        await dueRoutines(db);
        return json({ routines: (await db.prepare('SELECT hosted_routines.*,(SELECT MAX(scheduled_for) FROM hosted_routine_runs WHERE schedule_id=hosted_routines.id) AS last_run_at FROM hosted_routines ORDER BY created_at DESC').all<Row>()).results });
      }
      if (request.method === 'POST') {
        const agentId = required(body.agentId, 'Agent');
        if (!await db.prepare('SELECT 1 FROM agent_profiles WHERE id=?').bind(agentId).first()) throw new HttpError(404, 'Agent profile not found.');
        const routineId = id(), now = stamp(), minutes = intervalMinutes(body.intervalMinutes === undefined ? 60 : body.intervalMinutes), next = new Date(Date.now() + minutes * 60_000).toISOString();
        await db.prepare('INSERT INTO hosted_routines VALUES(?,?,?,?,?,?,?,?,?,?)').bind(routineId, agentId, required(body.name, 'Routine name'), required(body.prompt, 'Routine prompt', 20_000), minutes, String(body.timezone || 'UTC').slice(0, 100), 1, next, now, now).run();
        return json({ id: routineId, nextRunAt: next }, 201);
      }
    }
    const hostedRoutine = pathname.match(/^\/v1\/routines\/([^/]+)(?:\/(run|toggle|history))?$/);
    if (hostedRoutine) {
      const routine = await db.prepare('SELECT * FROM hosted_routines WHERE id=?').bind(hostedRoutine[1]).first<Row>();
      if (!routine) throw new HttpError(404, 'Routine not found.');
      const action = hostedRoutine[2], now = stamp();
      if (action === 'history' && request.method === 'GET') return json({ history: (await db.prepare('SELECT hosted_routine_runs.*,runs.state,runs.result,runs.error,runs.updated_at FROM hosted_routine_runs JOIN runs ON runs.id=hosted_routine_runs.run_id WHERE schedule_id=? ORDER BY scheduled_for DESC LIMIT 100').bind(routine.id).all<Row>()).results });
      if (action === 'toggle' && request.method === 'POST') { await db.prepare('UPDATE hosted_routines SET enabled=?,updated_at=? WHERE id=?').bind(routine.enabled ? 0 : 1, now, routine.id).run(); return json({ enabled: !routine.enabled }); }
      if (action === 'run' && request.method === 'POST') return json(await publicRun(db, await runHostedRoutine(db, routine, now)), 202);
      if (!action && request.method === 'DELETE') { await db.batch([db.prepare('DELETE FROM hosted_routines WHERE id=?').bind(routine.id), db.prepare('DELETE FROM hosted_routine_runs WHERE schedule_id=?').bind(routine.id)]); return json({ ok: true }); }
      if (!action && request.method === 'PUT') {
        const agentId = body.agentId === undefined ? String(routine.agent_id) : required(body.agentId, 'Agent');
        if (!await db.prepare('SELECT 1 FROM agent_profiles WHERE id=?').bind(agentId).first()) throw new HttpError(404, 'Agent profile not found.');
        const minutes = intervalMinutes(body.intervalMinutes === undefined ? routine.interval_minutes : body.intervalMinutes), next = new Date(Date.now() + minutes * 60_000).toISOString();
        await db.prepare('UPDATE hosted_routines SET agent_id=?,name=?,prompt=?,interval_minutes=?,timezone=?,next_run_at=?,updated_at=? WHERE id=?').bind(agentId, body.name === undefined ? routine.name : required(body.name, 'Routine name'), body.prompt === undefined ? routine.prompt : required(body.prompt, 'Routine prompt', 20_000), minutes, body.timezone === undefined ? routine.timezone : String(body.timezone).slice(0, 100), next, now, routine.id).run();
        return json(await db.prepare('SELECT * FROM hosted_routines WHERE id=?').bind(routine.id).first());
      }
    }
    if (pathname === '/v1/runs') {
      if (request.method === 'GET') return json({ runs: await Promise.all((await db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT 100').all<Row>()).results.map(row => publicRun(db, row))) });
      if (request.method === 'POST') { const agentId = required(body.agentId, 'Agent'), row = await db.prepare('SELECT json FROM agent_profiles WHERE id=?').bind(agentId).first<Row>(); if (!row) throw new HttpError(404, 'Agent profile not found.'); return json(await publicRun(db, await createHostedRun(db, normalizeProfile(JSON.parse(String(row.json))), required(body.prompt, 'Prompt', 200_000), String(body.conversationId || id()).slice(0, 240))), 202); }
    }
    if (pathname === '/v1/runs/stop-all' && request.method === 'POST') {
      const runs = (await db.prepare("SELECT runs.id FROM runs LEFT JOIN run_relations ON run_relations.run_id=runs.id WHERE run_relations.parent_run_id IS NULL AND runs.state IN ('queued','running','waiting_approval','waiting_input')").all<Row>()).results;
      let stopped = 0; for (const run of runs) stopped += (await stopHostedRunTree(db, String(run.id))).stopped;
      return json({ stopped });
    }
    if (pathname === '/v1/conversations' && request.method === 'GET') {
      const agentId = url.searchParams.get('agentId'), rows = (await db.prepare(`SELECT * FROM runs ${agentId ? 'WHERE agent_id=?' : ''} ORDER BY created_at,id`).bind(...(agentId ? [agentId] : [])).all<Row>()).results;
      const conversations = new Map<string, { id: string; agentId: string; title: string; updatedAt: string; runs: Awaited<ReturnType<typeof publicRun>>[] }>();
      for (const row of rows) {
        const key = `${row.agent_id}:${row.conversation_id}`, existing = conversations.get(key) || { id: String(row.conversation_id), agentId: String(row.agent_id), title: String(row.prompt).slice(0, 80), updatedAt: String(row.updated_at), runs: [] };
        existing.runs.push(await publicRun(db, row)); if (String(row.updated_at) > existing.updatedAt) existing.updatedAt = String(row.updated_at); conversations.set(key, existing);
      }
      return json({ conversations: [...conversations.values()].sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)) });
    }
    const hostedRun = pathname.match(/^\/v1\/runs\/([^/]+)(?:\/(events|stop|steer|approval|input))?$/);
    if (hostedRun) {
      const run = await db.prepare('SELECT * FROM runs WHERE id=?').bind(hostedRun[1]).first<Row>();
      if (!run) throw new HttpError(404, 'Run not found.');
      const action = hostedRun[2];
      if (!action && request.method === 'GET') return json(await publicRun(db, run));
      if (action === 'events' && request.method === 'GET') {
        const after = Number(url.searchParams.get('after') || 0);
        const events = (await db.prepare('SELECT * FROM run_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 500').bind(run.id, after).all<Row>()).results.map(row => ({ seq: row.seq, id: row.id, runId: row.run_id, type: row.type, payload: JSON.parse(String(row.payload_json)), createdAt: row.created_at }));
        return json({ events, run: await publicRun(db, run) });
      }
      if (action === 'stop' && request.method === 'POST') return json(await stopHostedRunTree(db, String(run.id)));
      if (['steer','approval','input'].includes(action || '') && request.method === 'POST') {
        if (!run.command_id || !['running','waiting_approval','waiting_input'].includes(String(run.state))) throw new HttpError(409, 'This run is not active on its runner.');
        if (action === 'steer') { await enqueueRunnerCommand(db, String(run.machine_id), String(run.agent_id), 'steer', { runId: run.id, commandId: run.command_id, text: required(body.text, 'Steering message', 20_000) }); return json({ ok: true, pending: true }); }
        const commandId = id(), now = stamp();
        let commandBody: Row, transition: D1PreparedStatement, eventType: string, eventPayload: Row;
        if (action === 'approval') {
          if (!['approve','deny'].includes(String(body.decision))) throw new HttpError(400, 'Choose approve or deny.');
          const approval = await db.prepare("SELECT * FROM approvals WHERE id=? AND run_id=? AND state='pending'").bind(String(body.approvalId || ''), run.id).first<Row>();
          if (!approval) throw new HttpError(404, 'Approval not found.');
          commandBody = { runId: run.id, commandId: run.command_id, requestId: approval.gateway_request_id, approvalId: approval.id, decision: body.decision };
          transition = db.prepare("UPDATE approvals SET state=?,resolved_at=? WHERE id=? AND run_id=? AND state='pending' AND EXISTS (SELECT 1 FROM runs WHERE id=? AND state IN ('running','waiting_approval','waiting_input'))").bind(body.decision, now, approval.id, run.id, run.id);
          eventType = 'approval.resolved'; eventPayload = { approvalId: approval.id, decision: body.decision };
        } else {
          const input = await db.prepare("SELECT * FROM hosted_run_inputs WHERE id=? AND run_id=? AND state='pending'").bind(String(body.inputId || ''), run.id).first<Row>();
          if (!input) throw new HttpError(404, 'Input request not found.');
          if ((typeof body.value !== 'string' && !(input.type === 'clarify' && Array.isArray(body.value) && body.value.every(value => typeof value === 'string'))) || JSON.stringify(body.value).length > 20_000) throw new HttpError(400, 'Enter a valid response of at most 20,000 characters.');
          const sensitive = input.type !== 'clarify', machine = sensitive ? await db.prepare('SELECT encryption_public_key FROM machines WHERE id=? AND revoked_at IS NULL').bind(run.machine_id).first<Row>() : null;
          if (sensitive && !machine?.encryption_public_key) throw new HttpError(409, 'Reconnect the runner before sending sensitive input.');
          commandBody = { runId: run.id, commandId: run.command_id, requestId: input.gateway_request_id, inputId: input.id, type: input.type, ...(sensitive ? { encrypted: await encryptRunnerSecret(String(machine!.encryption_public_key), String(body.value)) } : { value: body.value }) };
          transition = db.prepare("UPDATE hosted_run_inputs SET state='submitted',resolved_at=? WHERE id=? AND run_id=? AND state='pending' AND EXISTS (SELECT 1 FROM runs WHERE id=? AND state IN ('running','waiting_approval','waiting_input'))").bind(now, input.id, run.id, run.id);
          eventType = 'input.resolved'; eventPayload = { inputId: input.id, type: input.type };
        }
        const results = await db.batch([
          transition,
          db.prepare('INSERT INTO runner_commands(id,machine_id,agent_id,kind,payload_json,state,created_at) SELECT ?,?,?,?,?,?,? WHERE changes()=1').bind(commandId, run.machine_id, run.agent_id, action, JSON.stringify(commandBody), 'queued', now),
          db.prepare('INSERT INTO run_events(id,run_id,type,payload_json,created_at) SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM runner_commands WHERE id=?)').bind(id(), run.id, eventType, JSON.stringify(eventPayload), now, commandId),
          db.prepare("UPDATE runs SET state=CASE WHEN EXISTS (SELECT 1 FROM approvals WHERE run_id=? AND state='pending') THEN 'waiting_approval' WHEN EXISTS (SELECT 1 FROM hosted_run_inputs WHERE run_id=? AND state='pending') THEN 'waiting_input' ELSE 'running' END,updated_at=? WHERE id=? AND state IN ('running','waiting_approval','waiting_input') AND EXISTS (SELECT 1 FROM runner_commands WHERE id=?)").bind(run.id, run.id, now, run.id, commandId),
        ]);
        if (!results[0].meta.changes) throw new HttpError(409, 'This request was already answered or the run has finished.');
        return json({ ok: true, pending: true });
      }
    }
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
    const taskMatch = pathname.match(/^\/v1\/tasks\/([^/]+)(?:\/(comments|start|request-changes|approve|runs|move|stop))?$/);
    if (taskMatch) {
      const taskId = decodeURIComponent(taskMatch[1]), action = taskMatch[2];
      if (!action && request.method === "GET") return json(await getTask(db, taskId));
      if (action === "move" && request.method === "POST") return json(await moveHostedTask(db, taskId, body));
      if (action === "stop" && request.method === "POST") { const task = await getTask(db, taskId); if (task.activeRunId) await stopHostedRunTree(db, task.activeRunId); return json(await getTask(db, taskId)); }
      if (!action && request.method === "PUT") return json(await updateTask(db, taskId, body));
      if (action === "comments" && request.method === "POST") return json(await commentTask(db, taskId, body), 201);
      if (action === "approve" && request.method === "POST") return json(await approveTask(db, taskId, body));
      if (action === "runs" && request.method === "GET") { const rows = (await db.prepare('SELECT runs.*,task_runs.attempt,task_runs.started_at FROM task_runs JOIN runs ON runs.id=task_runs.run_id WHERE task_runs.task_id=? ORDER BY task_runs.attempt DESC').bind(taskId).all<Row>()).results; return json({ runs: await Promise.all(rows.map(async row => ({ ...await publicRun(db, row), attempt: Number(row.attempt), startedAt: String(row.started_at), output: String(row.result || '').slice(-20_000), stopReason: row.state === 'completed' ? 'end_turn' : row.error ? String(row.error) : null }))) }); }
      if ((action === "start" || action === "request-changes") && request.method === "POST") return json(await startTask(db, taskId, { ...body, feedback: action === 'request-changes' ? body.feedback : undefined }), 202);
    }
    throw new HttpError(404, "Not found.");
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Request failed." }, error instanceof HttpError || error instanceof ProfileError ? error.status : 500);
  }
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
