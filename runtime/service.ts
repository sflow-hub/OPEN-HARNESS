import { processIdentity, recoverNativeProcess } from './process-identity';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, writeFileSync, readdirSync, readFileSync, statSync, unlinkSync, existsSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Profiles, ProfileError, validateModel, validateProfile, validId } from "./profiles";
import { discoverTools, discoverModels, nativeRuntimeProbe, prepareProfile, runtimeProbe } from "./profile-runtime";
import { profileAgent, type AgentProfile, type ComputerConfig, type ToolCatalog } from "../lib/agent-profile";
import { Store, type RunRow } from "./db";
import { SecretStore } from "./secrets";
import { validateComputerTarget } from './computer-validation';
import { HermesGateway, dockerStatusCached, ensureContainer } from "./hermes";
import { coordinationSocket } from "./coordination-socket";
import { TaskError, TaskStore } from "./tasks";
import { MachineError, Machines } from "./machines";
import { exportAgentFiles, importAgentFiles, type TransferBundle } from './transfer-files';
import { onboardingAction, onboardingStatus } from './readiness';
import { reachability } from './reachability';
import { safeWorkspacePath, resolveContainedPath } from './path-safety';
import { conversationHistory } from './conversation-history';
import { testModelConnection } from './model-validation';
import { encryptRunnerSecret } from '../lib/runner-crypto';
import { acquireCoordinatorLock } from './coordinator-lock';
import { profileMemory } from './profile-memory';
import { agentContext, type ContextOperation, type ContextResult } from './agent-context';

const root = resolve(process.env.OPEN_HARNESS_STATE_DIR || ".open-harness");
mkdirSync(root, { recursive: true });
// Recovery may terminate orphaned runtimes, so ownership must precede every state import.
const releaseOwnership = acquireCoordinatorLock(root);
process.once('exit', releaseOwnership);
mkdirSync(join(root, "shared"), { recursive: true }); mkdirSync(join(root, "agents"), { recursive: true });
const store = new Store(join(root, "state.db"), false);
const tasks = new TaskStore(store.db);
store.runListener = run => tasks.syncRun(run);

const secrets = new SecretStore(join(root, "secrets.json"));
const profiles = new Profiles(store.db);
const machines = new Machines(store.db);
const importedWorkspace = store.db.prepare("SELECT payload_json FROM migrations WHERE key='browser-v1'").get() as { payload_json: string } | undefined;
const importedAgents = importedWorkspace ? JSON.parse(importedWorkspace.payload_json).agents || [] : [];
for (const row of store.db.prepare("SELECT * FROM agents").all() as any[]) profiles.import({ ...row, description: "", tone: 0, memory: [], ...importedAgents.find((a: any) => a.id === row.id), config: JSON.parse(row.config_json) });
const port = Number(process.env.OPEN_HARNESS_PORT || 4317);
const gateways = new Map<string, HermesGateway>();
const active = new Map<string, { gateway: HermesGateway; sessionId: string }>();
const remoteActive = new Map<string, { machineId: string; commandId: string }>();
const remoteStopping = new Set<string>();
const stoppingAgents = new Set<string>();
const executingAgents = new Set<string>();
const probingAgents = new Set<string>();
const coordinationSockets = new Map<string, ReturnType<typeof coordinationSocket>>();
let pumping = false;
let recovering = true;
let stoppingSweeps = 0;
let shuttingDown = false;
const cancelledRuns = new Set<string>();
const blockedComputers = new Set<string>();
const maxTaskQueue = Math.max(1, Number(process.env.MAX_TASK_QUEUE || 100));
const maxTaskRuns = Math.max(1, Number(process.env.MAX_TASK_RUNS || 3));
const terminalStates = new Set(['completed', 'failed', 'interrupted', 'cancelled']);
const activeStates = new Set(['running', 'waiting_approval', 'waiting_input']);

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": allowedOrigin(res.req.headers.origin), "Vary": "Origin", "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Open-Harness-Machine", "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS" });
  res.end(JSON.stringify(body));
}
function raw(res: ServerResponse, status: number, contentType: string, value: string | Buffer) {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(value);
}
// The Tauri mobile webview serves the dashboard from tauri://localhost. Its native HTTP
// client sends no Origin at all, so this allowance is belt and braces for the cases where
// the webview's own fetch is used instead.
const LOCAL_ORIGIN = /^(https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?|tauri:\/\/localhost|https?:\/\/tauri\.localhost)$/;
function allowedOrigin(origin?: string) { return origin && LOCAL_ORIGIN.test(origin) ? origin : "http://localhost:3000"; }
// A DNS-rebinding page reaches this service from 127.0.0.1 and sends no Origin header,
// because from the browser's point of view the request is same-origin. The one thing it
// cannot forge is the Host header, which still carries the attacker's own name.
function loopbackHost(host?: string) { return Boolean(host && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)); }
async function body(req: IncomingMessage) {
  let text = ""; for await (const chunk of req) { text += chunk; if (text.length > 5_000_000) throw new Error("Request too large."); }
  return text ? JSON.parse(text) : {};
}
function runnerIdentity(req: IncomingMessage) {
  const machineId = String(req.headers['x-open-harness-machine'] || ''), token = String(req.headers.authorization || '').replace(/^Bearer /, '');
  return machineId && machines.authenticate(machineId, token, 'runner') ? machineId : null;
}
// A phone is a companion dashboard only. Its credential reaches dashboard routes that a
// computer runner credential must not, and runnerIdentity rejects it for command polling.
function deviceIdentity(req: IncomingMessage) {
  const machineId = String(req.headers['x-open-harness-machine'] || ''), token = String(req.headers.authorization || '').replace(/^Bearer /, '');
  return machineId && machines.authenticate(machineId, token, 'device') ? machineId : null;
}
function authenticated(req: IncomingMessage) { return req.headers.authorization === `Bearer ${secrets.token}` || Boolean(deviceIdentity(req)); }
function agentToken(agentId: string) { return createHmac("sha256", secrets.token).update(`agent:${agentId}`).digest("hex"); }
function authenticatedAgent(req: IncomingMessage) {
  const id = String(req.headers["x-open-harness-agent"] || ""), supplied = String(req.headers.authorization || "").replace(/^Bearer /, ""), expected = agentToken(id);
  return Boolean(id && supplied.length === expected.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) ? id : null;
}
// Computer runners are dispatchable only while connected. The suspended state remains for
// companion presence, but canAssign rejects companions before this check.
function reachable(machine: { status: string }) { return machine.status === 'online' || machine.status === 'suspended'; }
function event(runId: string, type: string, payload: unknown) { return store.appendEvent(runId, type, payload); }
// A command whose outcome nobody can vouch for leaves its run in limbo. Both the heartbeat
// reconciliation and legacy stale-device cleanup end here so a run is retired exactly once.
function interruptRunForCommand(command: { payload?: unknown }, error: string) {
  const run = store.getRun(String((command.payload as { runId?: unknown } | undefined)?.runId || ''));
  if (!run || ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.state)) return;
  store.setRun(run.id, { state: 'interrupted', error });
  event(run.id, 'run.interrupted', { error });
}
function profileResponse(profile: AgentProfile) {
  const live = store.liveRuns().find(run => run.agent_id === profile.id && ["running", "waiting_approval", "waiting_input"].includes(run.state));
  const snapshot = live ? profiles.runSnapshot(live.id) : null;
  return { profile, effectiveModel: profiles.effective(profile), activeRevision: snapshot?.revision ?? null, pending: Boolean(snapshot && (snapshot.revision !== profile.revision || JSON.stringify(snapshot.effectiveModel) !== JSON.stringify(profiles.effective(profile)) || JSON.stringify(snapshot.computer) !== JSON.stringify(profile.computer))), secretNames: secrets.names(), machine: machines.get(profile.computer.machineId), transfer: machines.transferStatus(profile.id) };
}

function selectedSecrets(profile: AgentProfile, effective: ReturnType<Profiles['effective']>) {
  const names = new Set([effective.credentialRef, ...profile.connectors.filter(item => item.enabled).map(item => item.secretRef)].filter(Boolean));
  const available = secrets.environment(); return Object.fromEntries([...names].filter(name => available[name]).map(name => [name, available[name]]));
}
async function runnerProbe(profile: AgentProfile, kind: 'probe-tools' | 'probe-runtime' | 'probe-models', input?: unknown) { const machine = machines.canAssign(profile.computer.machineId, profile.id); if (machine.status !== 'online') throw new MachineError(machine.status === 'suspended' ? `${machine.name} is asleep. Open Open Harness on it, then check this setting again.` : `${machine.name} is offline. Reconnect it before checking this setting.`, 409); const effectiveModel = profiles.effective(profile); return waitRunnerCommand(machines.enqueue(machine.id, profile.id, kind, { profile: { ...profile, effectiveModel }, input, secrets: selectedSecrets(profile, effectiveModel), coordinationToken: agentToken(profile.id) }).id); }

function priorHistory(run: RunRow) {
  const earlier = store.db.prepare("SELECT * FROM runs WHERE conversation_id=? AND agent_id=? AND id<>? AND state IN ('completed','failed','interrupted','cancelled') ORDER BY created_at,rowid").all(run.conversation_id, run.agent_id, run.id) as RunRow[];
  return conversationHistory(earlier);
}
async function watchRemote(run: RunRow, command: { machineId: string; id: string }) {
  remoteActive.set(run.id, { machineId: command.machineId, commandId: command.id });
  try {
    for (;;) {
      const current = store.getRun(run.id);
      if (!current || terminalStates.has(current.state)) return;
      const status = machines.command(command.id);
      if (!status) throw new Error('The runner command disappeared before completion.');
      if (['completed', 'failed'].includes(status.state)) {
        const stopped = remoteStopping.has(run.id);
        const state = stopped ? 'cancelled' : status.state === 'completed' ? 'completed' : status.result?.interrupted ? 'interrupted' : 'failed';
        const answer = state === 'completed' ? String(status.result?.text || status.result?.final_response || status.result?.message || status.result?.result || '') : null;
        const error = state === 'failed' || state === 'interrupted' ? String(status.result?.error || 'Remote runner failed.') : null;
        store.setRun(run.id, { state, result: answer, error });
        event(run.id, `run.${state}`, { ...(answer !== null ? { result: answer } : {}), ...(error ? { error } : {}), machineId: command.machineId });
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  } catch (error) {
    if (!terminalStates.has(store.getRun(run.id)?.state || '')) {
      const message = error instanceof Error ? error.message : 'Runner tracking failed.';
      store.setRun(run.id, { state: 'interrupted', error: message }); event(run.id, 'run.interrupted', { error: message });
    }
  } finally { remoteActive.delete(run.id); remoteStopping.delete(run.id); void pump(); }
}
async function executeRemote(run: RunRow, snapshot: AgentProfile & { effectiveModel: ReturnType<Profiles['effective']> }) {
  const machine = machines.canAssign(snapshot.computer.machineId, run.agent_id);
  if (!reachable(machine)) throw new Error(`${machine.name} is offline. This task will remain queued until its runner reconnects.`);
  const command = machines.enqueue(machine.id, run.agent_id, 'run', { runId: run.id, prompt: run.prompt, history: priorHistory(run), snapshot, secrets: selectedSecrets(snapshot, snapshot.effectiveModel), coordinationToken: agentToken(run.agent_id) });
  event(run.id, 'runner.dispatched', { commandId: command.id, machineId: machine.id, machineName: machine.name });
  await watchRemote(run, command);
}

function recoverRunResponses() {
  for (const [table, kind, key] of [['run_inputs', 'input', 'inputId'], ['approvals', 'approval', 'approvalId']] as const) {
    const pending = store.db.prepare(`SELECT id,run_id,state FROM ${table} WHERE state IN ('submitting','submitted')`).all() as Array<{ id: string; run_id: string; state: string }>;
    for (const request of pending) {
      const run = store.getRun(request.run_id);
      const command = store.db.prepare(`SELECT state,payload_json FROM runner_commands WHERE kind=? AND json_extract(payload_json,'$.runId')=? AND json_extract(payload_json,'$.${key}')=? ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(kind, request.run_id, request.id) as { state: string; payload_json: string } | undefined;
      const active = Boolean(run && activeStates.has(run.state));
      const state = !active ? 'expired' : !command || command.state === 'failed' ? 'pending' : command.state === 'completed' ? kind === 'input' ? 'answered' : String(JSON.parse(command.payload_json).decision) : 'submitted';
      store.db.prepare(`UPDATE ${table} SET state=?,resolved_at=? WHERE id=?`).run(state, ['pending', 'submitted'].includes(state) ? null : new Date().toISOString(), request.id);
    }
  }
  for (const run of store.liveRuns()) {
    const approvalPending = store.db.prepare("SELECT 1 FROM approvals WHERE run_id=? AND state IN ('pending','submitting','submitted') LIMIT 1").get(run.id);
    const inputPending = store.db.prepare("SELECT 1 FROM run_inputs WHERE run_id=? AND state IN ('pending','submitting','submitted') LIMIT 1").get(run.id);
    if (approvalPending || inputPending || ['waiting_input', 'waiting_approval'].includes(run.state)) store.setRun(run.id, { state: approvalPending ? 'waiting_approval' : inputPending ? 'waiting_input' : 'running' });
  }
}

function blockCleanup(agentId: string, computer: ComputerConfig, error: string) {
  stoppingAgents.add(agentId); blockedComputers.add(computer.machineId);
  store.db.prepare('INSERT OR REPLACE INTO runtime_cleanup(agent_id,computer_json,error) VALUES(?,?,?)').run(agentId, JSON.stringify(computer), error);
}
async function cleanPreviousRuntime(agentId: string, computer: ComputerConfig) {
  if (process.env.OPEN_HARNESS_MOCK !== '1') {
    if (computer.access === 'direct') {
      const handle = store.db.prepare('SELECT pid,identity FROM runtime_processes WHERE agent_id=?').get(agentId) as { pid: number; identity: string } | undefined;
      if (!handle) throw new Error('An older native run has no saved process identity. Its process tree must be stopped before this computer can resume work.');
      await recoverNativeProcess(handle.pid, handle.identity);
    } else await new HermesGateway(`open-harness-${validId(agentId)}`).stop();
  }
  store.db.prepare('DELETE FROM runtime_processes WHERE agent_id=?').run(agentId);
  store.db.prepare('DELETE FROM runtime_cleanup WHERE agent_id=?').run(agentId);
  stoppingAgents.delete(agentId);
  const remaining = store.db.prepare('SELECT computer_json FROM runtime_cleanup').all() as { computer_json: string }[];
  if (!remaining.some(row => JSON.parse(row.computer_json).machineId === computer.machineId)) blockedComputers.delete(computer.machineId);
}
async function recoverRuns() {
  recoverRunResponses();
  const cleaned = new Set<string>();
  // Also recover probes and prior failed cleanup, including failures on a run that
  // was already terminal when the coordinator restarted.
  const leftovers = store.db.prepare('SELECT agent_id,computer_json FROM runtime_cleanup').all() as { agent_id: string; computer_json: string }[];
  for (const row of store.db.prepare('SELECT agent_id FROM runtime_processes').all() as { agent_id: string }[]) {
    const profile = profiles.get(row.agent_id);
    if (profile && !leftovers.some(item => item.agent_id === row.agent_id)) leftovers.push({ agent_id: row.agent_id, computer_json: JSON.stringify({ ...profile.computer, machineId: 'local', access: 'direct' }) });
  }
  for (const row of leftovers) {
    const computer = JSON.parse(row.computer_json) as ComputerConfig;
    try { await cleanPreviousRuntime(row.agent_id, computer); cleaned.add(row.agent_id); }
    catch (error) { blockCleanup(row.agent_id, computer, error instanceof Error ? error.message : String(error)); }
  }
  for (const run of store.liveRuns()) {
    const command = store.db.prepare("SELECT id,machine_id FROM runner_commands WHERE kind='run' AND agent_id=? AND json_extract(payload_json,'$.runId')=? ORDER BY created_at DESC LIMIT 1").get(run.agent_id, run.id) as { id: string; machine_id: string } | undefined;
    if (command) {
      if (store.db.prepare("SELECT 1 FROM runner_commands WHERE kind='stop' AND json_extract(payload_json,'$.runId')=? AND state IN ('queued','leased','completed') LIMIT 1").get(run.id)) remoteStopping.add(run.id);
      void watchRemote(run, { id: command.id, machineId: command.machine_id });
    } else {
      let error = 'The local runtime restarted. Completed actions were preserved; this run was not replayed.';
      const computer = (profiles.runSnapshot(run.id) || profiles.get(run.agent_id))?.computer;
      try {
        if (!cleaned.has(run.agent_id) && computer) await cleanPreviousRuntime(run.agent_id, computer);
      } catch (cleanupError) {
        error += ` Cleanup could not be confirmed: ${cleanupError instanceof Error ? cleanupError.message : cleanupError}`;
        if (computer) blockCleanup(run.agent_id, computer, error);
      }
      store.setRun(run.id, { state: 'interrupted', error }); event(run.id, 'run.interrupted', { error });
    }
  }
  tasks.reconcile();
  recovering = false;
}

async function waitRunnerCommand(commandId: string) {
  for (;;) { const command = machines.command(commandId); if (!command) throw new Error('Transfer command disappeared.'); if (command.state === 'completed') return command.result; if (command.state === 'failed') throw new Error(String((command.result as { error?: string } | null)?.error || 'Runner transfer command failed.')); await new Promise(resolve => setTimeout(resolve, 500)); }
}
async function performTransfer(transfer: { id: string; agentId: string; sourceMachineId: string; destinationMachineId: string; pendingProfile?: AgentProfile }) {
  try {
    while (store.agentBusy(transfer.agentId)) await new Promise(resolve => setTimeout(resolve, 500));
    machines.setTransfer(transfer.id, 'exporting', 'Exporting managed files, memory, and skills.');
    const bundle = transfer.sourceMachineId === 'local' ? exportAgentFiles(root, transfer.agentId) : (() => { const source = machines.get(transfer.sourceMachineId); if (source.status === 'revoked') throw new Error('Source computer was revoked before export.'); return waitRunnerCommand(machines.enqueue(transfer.sourceMachineId, transfer.agentId, 'export-agent', { transferId: transfer.id }).id) as Promise<TransferBundle>; })();
    const resolvedBundle = await bundle;
    machines.setTransfer(transfer.id, 'importing', 'Importing data on the destination computer.');
    const pending = transfer.pendingProfile, effective = pending ? profiles.effective(pending) : null;
    const requiredSecrets = pending ? [effective?.credentialRef || '', ...pending.connectors.filter(item => item.enabled).map(item => item.secretRef)].filter(name => Boolean(name) && !secrets.has(name) && !process.env[name]) : [];
    let result: { checksum: string; validated?: boolean };
    if (transfer.destinationMachineId === 'local') {
      if (pending) validateComputerTarget(pending, machines.get('local').capabilities, requiredSecrets, name => secrets.has(name) || Boolean(process.env[name]));
      result = { ...importAgentFiles(root, transfer.agentId, resolvedBundle), validated: true };
      if (pending?.computer.desktop !== 'none' && pending && process.env.OPEN_HARNESS_MOCK !== '1') {
        const check = { action: 'computer', desktop: pending.computer.desktop };
        const tested = pending.computer.desktop === 'existing' ? nativeRuntimeProbe(join(root, 'agents', pending.id, 'profile'), check) : await runtimeProbe(ensureContainer(pending.id, root, pending.computer), check);
        if (!tested.ok) throw new Error(String(tested.message || 'Desktop control is not ready on this computer.'));
      }
    } else result = await waitRunnerCommand(machines.enqueue(transfer.destinationMachineId, transfer.agentId, 'import-agent', { transferId: transfer.id, bundle: resolvedBundle, profile: pending, requiredSecrets }).id) as { checksum: string; validated?: boolean };
    machines.setTransfer(transfer.id, 'verifying', 'Verifying transferred files.'); if (result.checksum !== resolvedBundle.checksum) throw new Error('Destination checksum does not match the source.');
    if (transfer.pendingProfile) { profiles.applyTransferredProfile(transfer.pendingProfile); machines.reserve(transfer.sourceMachineId, transfer.agentId, false); machines.reserve(transfer.destinationMachineId, transfer.agentId, transfer.pendingProfile.computer.reserveMachine); }
    machines.setTransfer(transfer.id, 'completed', `Transfer verified (${resolvedBundle.files.length} files). Source data was preserved.`);
  } catch (error) { if (transfer.pendingProfile) machines.reserve(transfer.destinationMachineId, transfer.agentId, false); machines.setTransfer(transfer.id, 'failed', `${error instanceof Error ? error.message : 'Transfer failed.'} Source assignment and data were preserved.`); }
  void pump();
}
function ensureProfileDirs(id: string) { validId(id); for (const folder of ['profile', 'private', 'managed']) mkdirSync(join(root, 'agents', id, folder), { recursive: true }); }
function internalAllowed(agentId: string | null, tool: string, runId?: string) {
  const run = runId ? store.getRun(runId) : store.liveRuns().find(r => r.agent_id === agentId && ['running','waiting_approval','waiting_input'].includes(r.state));
  return Boolean(run && run.agent_id === agentId && ['running','waiting_approval','waiting_input'].includes(run.state) && profiles.runSnapshot(run.id)?.allowedTools.includes(tool));
}

async function gatewayFor(agentId: string, allowedTools: string[] | null = null, computer?: ComputerConfig) {
  let gateway = gateways.get(agentId);
  if (gateway) return gateway;
  if (computer?.access === 'direct') {
    const agentRoot = join(root, 'agents', agentId), profileRoot = join(agentRoot, 'profile');
    gateway = new HermesGateway(`native-${agentId}`, allowedTools, { cwd: join(root, 'shared'), entry: join(import.meta.dirname, 'hermes', 'managed_entry.py'), env: { ...process.env, HERMES_HOME: profileRoot, HERMES_TUI: '1', PYTHONUNBUFFERED: '1', OPEN_HARNESS_POLICY_PATH: join(agentRoot, 'managed', 'policy.json') }, onSpawn: pid => { const identity = processIdentity(pid); if (!identity) throw new Error('Native runtime exited before its identity could be saved.'); store.db.prepare('INSERT OR REPLACE INTO runtime_processes(agent_id,pid,identity) VALUES(?,?,?)').run(agentId, pid, identity); } });
  } else {
    gateway = new HermesGateway(ensureContainer(agentId, root, computer), allowedTools);
  }
  gateways.set(agentId, gateway);
  try { await gateway.start(); return gateway; }
  catch (error) { gateways.delete(agentId); throw error; }
}

function mapHermesEvent(run: RunRow, value: any) {
  const type = String(value?.type || value?.event || 'runtime.event');
  const payload = value?.payload ?? value?.data ?? value;
  const current = store.getRun(run.id);
  const sessionId = value?.session_id || payload?.session_id;
  // Runner delivery is authenticated and pinned to this run's command. Session
  // metadata may arrive after completion when a buffered event is replayed.
  if (current && !current.session_id && ['session.started', 'session.info'].includes(type) && typeof sessionId === 'string' && sessionId.length <= 512 && sessionId) store.setRun(run.id, { session_id: sessionId });
  // Buffered runner events can arrive after their completion receipt. Preserve the
  // transcript, but never turn terminal work back into a waiting run.
  if (!current || terminalStates.has(current.state)) { event(run.id, type, payload); return; }
  if (type === 'approval.request') {
    const requestId = String(payload?.request_id || payload?.id || '');
    const duplicate = store.db.prepare('SELECT id FROM approvals WHERE run_id=? AND gateway_request_id=?').get(run.id, requestId);
    if (duplicate) return;
    const approvalId = crypto.randomUUID();
    store.createApproval(approvalId, run.id, requestId, payload);
    store.setRun(run.id, { state: 'waiting_approval' });
    event(run.id, type, { ...payload, approvalId });
  } else if (['clarify.request', 'secret.request', 'sudo.request'].includes(type)) {
    const inputId = crypto.randomUUID(), requestId = String(payload?.request_id || payload?.id || '');
    const inserted = store.db.prepare('INSERT OR IGNORE INTO run_inputs(id,run_id,gateway_request_id,type,payload_json,created_at) VALUES(?,?,?,?,?,?)').run(inputId, run.id, requestId, type.split('.')[0], JSON.stringify(payload), new Date().toISOString());
    if (!inserted.changes) return;
    store.setRun(run.id, { state: 'waiting_input' }); event(run.id, type, { ...payload, inputId });
  } else {
    if (['clarify.expire', 'secret.expire', 'sudo.expire'].includes(type)) {
      store.db.prepare("UPDATE run_inputs SET state='expired',resolved_at=? WHERE run_id=? AND gateway_request_id=? AND state IN ('pending','submitting','submitted')").run(new Date().toISOString(), run.id, String(payload?.request_id || payload?.id || ''));
      if (!store.pendingInputs(run.id).length) store.setRun(run.id, { state: store.pendingApprovals(run.id).length ? 'waiting_approval' : 'running' });
    }
    if (type === 'message.delta') tasks.appendOutput(run.id, String(payload?.text || ''));
    event(run.id, type, payload);
  }
}

async function execute(run: RunRow) {
  executingAgents.add(run.agent_id);
  store.setRun(run.id, { state: "running" });
  let subscribed: { gateway: HermesGateway; listener: (value: any) => void } | null = null;
  let outcome: { state: 'completed' | 'failed' | 'interrupted' | 'cancelled'; result?: string; error?: string } | undefined;
  try {
    const profile = profiles.get(run.agent_id);
    if (!profile) throw new Error("Agent profile not found. Open Agent settings and save this agent.");
    const snapshot = profiles.snapshot(run.id, profile);
    const assigned = machines.canAssign(snapshot.computer.machineId, run.agent_id);
    event(run.id, "run.started", { runId: run.id, agentId: run.agent_id, machineId: assigned.id, machineName: assigned.name });
    event(run.id, "profile.applied", { revision: snapshot.revision, model: snapshot.effectiveModel, allowedTools: snapshot.allowedTools, computer: snapshot.computer });
    if (assigned.id !== 'local') {
      await executeRemote(run, snapshot);
      return;
    }
    const priorGateway = gateways.get(run.agent_id);
    if (priorGateway) { await priorGateway.stop(); gateways.delete(run.agent_id); }
    const native = snapshot.computer.access === 'direct';
    const useSocket = process.platform === 'linux' || (native && process.platform !== 'win32');
    let controlSocket: string | undefined;
    if (useSocket) {
      if (!coordinationSockets.has(run.agent_id)) coordinationSockets.set(run.agent_id, coordinationSocket(join(root, 'agents', run.agent_id, 'managed'), run.agent_id, (req, res) => { server.emit('request', req, res); }));
      const socket = await coordinationSockets.get(run.agent_id)!;
      controlSocket = native ? socket.socketPath : undefined;
    }
    if (cancelledRuns.has(run.id) || store.getRun(run.id)?.state === 'cancelled') return;
    prepareProfile(root, snapshot, snapshot.effectiveModel, secrets, agentToken(run.agent_id), run.id, {
      ...(native ? { cwd: join(root, 'shared'), coordinationCommand: join(import.meta.dirname, 'hermes', 'coordination.mjs') } : {}),
      ...(useSocket ? { ...(controlSocket ? { controlSocket } : {}) } : { controlUrl: `http://${native ? '127.0.0.1' : 'host.docker.internal'}:${port}` }),
    });
    const gateway = await gatewayFor(run.agent_id, snapshot.allowedTools, snapshot.computer);
    const listener = (value: any) => mapHermesEvent(run, value); gateway.on("event", listener); subscribed = { gateway, listener };
    const session = run.session_id ? { session_id: run.session_id } : await gateway.request("session.create", { cwd: native ? join(root, 'shared') : "/workspace/shared", profile: "default", messages: priorHistory(run) });
    if (cancelledRuns.has(run.id) || store.getRun(run.id)?.state === "cancelled") return;
    const sessionId = String(session?.session_id || session?.id || run.session_id || "");
    if (!sessionId) throw new Error("Hermes did not return a session ID.");
    store.setRun(run.id, { session_id: sessionId }); active.set(run.id, { gateway, sessionId });
    const result = await gateway.submitPrompt(sessionId, run.prompt);
    const current = store.getRun(run.id);
    if (cancelledRuns.has(run.id) || current?.state === "cancelled") return;
    const answer = String(result?.text || result?.final_response || result?.message || "");
    outcome = { state: 'completed', result: answer };
  } catch (error) {
    if (terminalStates.has(store.getRun(run.id)?.state || '')) return;
    const message = error instanceof Error ? error.message : "Hermes execution failed.";
    const state = cancelledRuns.has(run.id) || store.getRun(run.id)?.state === "cancelled" || remoteStopping.has(run.id) ? "cancelled" : (error as { interrupted?: boolean })?.interrupted ? "interrupted" : "failed";
    remoteStopping.delete(run.id);
    outcome = { state, error: message };
  } finally {
    if (subscribed) {
      subscribed.gateway.off("event", subscribed.listener);
      try { await subscribed.gateway.stop(); gateways.delete(run.agent_id); store.db.prepare('DELETE FROM runtime_processes WHERE agent_id=?').run(run.agent_id); }
      catch (error) {
        const computer = (profiles.runSnapshot(run.id) || profiles.get(run.agent_id))?.computer;
        const message = `Runtime cleanup could not be confirmed: ${error instanceof Error ? error.message : error}`;
        if (computer) blockCleanup(run.agent_id, computer, message);
        outcome = { state: 'interrupted', error: message };
      }
    }
    active.delete(run.id);
    if (cancelledRuns.has(run.id) && outcome?.state !== 'interrupted') outcome = { state: 'cancelled' };
    if (outcome) { store.setRun(run.id, outcome); event(run.id, `run.${outcome.state}`, outcome); }
    cancelledRuns.delete(run.id); executingAgents.delete(run.agent_id); void pump();
  }
}

async function pump() {
  if (pumping || recovering || shuttingDown || stoppingSweeps) return; pumping = true;
  try {
    while (store.activeCount() < 4) {
      const next = store.queued().find(candidate =>
        !store.agentBusy(candidate.agent_id) && !executingAgents.has(candidate.agent_id) && !probingAgents.has(candidate.agent_id) && !stoppingAgents.has(candidate.agent_id) && !machines.transferring(candidate.agent_id) &&
        (!tasks.isTaskRun(candidate.id) || tasks.activeRunCount() < maxTaskRuns) &&
        (candidate.depth > 0 || store.activeTopLevelCount() < 2) && (() => {
          const profile = profiles.get(candidate.agent_id); if (!profile) return true;
          if (blockedComputers.has(profile.computer.machineId)) return false;
          try { if (!reachable(machines.canAssign(profile.computer.machineId, candidate.agent_id))) return false; } catch { return false; }
          const occupants = store.liveRuns().map(run => profiles.runSnapshot(run.id) || profiles.get(run.agent_id)).filter((other): other is AgentProfile => Boolean(other && other.computer.machineId === profile.computer.machineId));
          if (occupants.length >= profile.computer.resources.concurrency) return false;
          return profile.computer.desktop !== 'existing' || occupants.every(other => other.computer.desktop !== 'existing');
        })());
      if (!next) break;
      void execute(next);
    }
  } finally { pumping = false; }
}

async function stopRunTree(runId: string) {
  stoppingSweeps++;
  try {
  const ids = [runId, ...store.descendants(runId).map(item => item.id)];
  let stopped = 0;
  for (const id of ids) {
    const run = store.getRun(id);
    if (!run || ["completed", "failed", "interrupted", "cancelled"].includes(run.state)) continue;
    const live = active.get(id);
    const remote = remoteActive.get(id);
    stoppingAgents.add(run.agent_id);
    if (remote) {
      remoteStopping.add(id); machines.enqueue(remote.machineId, run.agent_id, 'stop', { runId: id, commandId: remote.commandId });
      event(id, 'stop.pending', { machineId: remote.machineId, message: 'Stop requested. Waiting for the runner to confirm.' });
      stoppingAgents.delete(run.agent_id); stopped++; continue;
    }
    cancelledRuns.add(id);
    try {
      const gateway = live?.gateway || (run.state === 'queued' ? undefined : gateways.get(run.agent_id));
      if (live) await live.gateway.request("session.interrupt", { session_id: live.sessionId }, 5000).catch(() => {});
      if (gateway) { await gateway.stop(); gateways.delete(run.agent_id); }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Runtime stop could not be confirmed.";
      store.setRun(id, { state: "interrupted", error: message });
      event(id, "run.interrupted", { error: message });
      const computer = (profiles.runSnapshot(id) || profiles.get(run.agent_id))?.computer;
      if (computer) blockCleanup(run.agent_id, computer, message);
      throw error;
    }
    store.setRun(id, { state: "cancelled" });
    stoppingAgents.delete(run.agent_id);
    event(id, "run.cancelled", { stoppedWithParent: id !== runId }); stopped++;
  }
  return stopped;
  } finally { stoppingSweeps--; void pump(); }
}

async function waitForRun(id: string, timeoutMs = 30 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = store.getRun(id); if (!run) throw new Error("Delegated run disappeared.");
    if (["completed", "failed", "interrupted", "cancelled"].includes(run.state)) return run;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("Delegated run is still active after 30 minutes. Its run ID remains available in Open Harness.");
}

function createRun(input: { agentId: string; conversationId?: string; prompt: string; parentRunId?: string; depth?: number; deferStart?: boolean }) {
  if (!input.agentId || !input.prompt?.trim()) throw new Error("agentId and prompt are required.");
  if (!profiles.get(input.agentId)) throw new ProfileError("Agent profile not found.", 404);
  const parent = input.parentRunId ? store.getRun(input.parentRunId) : undefined;
  const depth = parent ? parent.depth + 1 : Number(input.depth || 0);
  if (depth > 2) throw new Error("Delegation depth is limited to two.");
  if (parent) {
    const ancestors = new Set<string>([parent.agent_id]); let cursor = parent;
    while (cursor.parent_run_id) { const previous = store.getRun(cursor.parent_run_id); if (!previous) break; ancestors.add(previous.agent_id); cursor = previous; }
    if (ancestors.has(input.agentId)) throw new Error("Cyclic agent handoffs are not allowed.");
  }
  if (store.queued(maxTaskQueue + 1).length >= maxTaskQueue) throw new TaskError(`The task queue is full (${maxTaskQueue}). Try again when work completes.`, 429);
  const stamp = new Date().toISOString();
  const run: RunRow = { id: crypto.randomUUID(), agent_id: input.agentId, conversation_id: input.conversationId || crypto.randomUUID(), prompt: input.prompt.trim(), state: "queued", session_id: null, parent_run_id: input.parentRunId || null, depth, created_at: stamp, updated_at: stamp, result: null, error: null };
  store.createRun(run); event(run.id, "run.queued", { position: store.listRuns().filter(item => item.state === "queued").length }); if (!input.deferStart) void pump(); return run;
}
function runResponse(run: RunRow) { const profile = profiles.runSnapshot(run.id) || profiles.get(run.agent_id); const machineId = profile?.computer.machineId || null; let machineConnection: string | null = null; if (machineId) { try { machineConnection = machines.get(machineId).status; } catch { machineConnection = 'revoked'; } } return { ...run, machine_id: machineId, machine_connection: machineConnection, pendingApprovals: store.pendingApprovals(run.id), pendingInputs: store.pendingInputs(run.id) }; }

function listFiles(dir: string) {
  safeWorkspacePath(root, relative(root, dir));
  mkdirSync(dir, { recursive: true });
  return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isFile()).slice(0, 200).map(entry => {
    const path = join(dir, entry.name), stat = statSync(path); return { name: entry.name, size: stat.size, updatedAt: stat.mtime.toISOString(), mimeType: mimeType(entry.name), encoding: isText(entry.name) ? "utf8" : "base64" };
  });
}
function isText(name: string) { return /\.(txt|md|csv|json|html|css|js|mjs|cjs|ts|tsx|py|yaml|yml|xml|log|svg)$/i.test(name); }
function mimeType(name: string) {
  const ext = name.toLowerCase().split(".").pop();
  return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml", pdf: "application/pdf", json: "application/json", csv: "text/csv", md: "text/markdown", html: "text/html" } as Record<string, string>)[ext || ""] || (isText(name) ? "text/plain" : "application/octet-stream");
}
function workspaceDir(url: URL) {
  const scope = url.searchParams.get('scope') || 'shared', agentId = url.searchParams.get('agentId') || '';
  if (!['shared', 'private'].includes(scope)) throw new ProfileError('Invalid workspace scope.');
  if (scope === 'private') validId(agentId);
  return { scope, dir: safeWorkspacePath(root, scope === 'private' ? `agents/${agentId}/private` : 'shared') };
}
function safeFile(dir: string, name: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._ -]{0,159}$/.test(name) || name.includes('..')) throw new Error('Invalid filename.');
  return safeWorkspacePath(root, relative(root, resolveContainedPath(dir, name)));
}

const server = createServer(async (req, res) => {
  if (recovering) return json(res, 503, { error: 'The coordinator is recovering its previous work. Retry shortly.' });
  const origin = req.headers.origin;
  if (origin && !LOCAL_ORIGIN.test(origin)) return json(res, 403, { error: "Open Harness accepts local browser clients only." });
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": allowedOrigin(origin), "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Open-Harness-Machine", "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS" }); return res.end(); }
  const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
  let probingAgent: string | null = null;
  function reserveProbe(id: string) {
    if (store.agentBusy(id) || executingAgents.has(id) || probingAgents.has(id) || stoppingAgents.has(id)) throw new ProfileError('This agent is busy. Wait for its current run or connection check to finish.', 409);
    probingAgents.add(id); probingAgent = id;
  }
  try {
    if (req.method === "GET" && url.pathname === "/v1/bootstrap") { const address = req.socket.remoteAddress || ''; if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address)) return json(res, 403, { error: 'Dashboard bootstrap is available only from the coordinator machine.' }); if (!loopbackHost(req.headers.host)) return json(res, 403, { error: 'Dashboard bootstrap requires a loopback address. Open Open Harness at http://localhost:3000.' }); return json(res, 200, { token: secrets.token, runtime: await dockerStatusCached(), version: "0.3.0", hermes: { release: "v2026.9.11", commit: "939e45c91d751fadd94dcd1b873ac3cb44846213" } }); }
    // Phones never receive the master token. They already hold a revocable per-device
    // credential, so this returns the same status shape with the token field left empty.
    if (req.method === 'GET' && url.pathname === '/v1/device/session') {
      const device = deviceIdentity(req);
      if (!device) return json(res, 401, { error: 'Pair this phone again to reconnect it.' });
      machines.heartbeat(device, {});
      const runtime = await dockerStatusCached();
      return json(res, 200, { token: '', machine: machines.get(device), runtime: { ...runtime, message: runtime.available ? 'This phone is a companion dashboard. Agents run on the connected coordinator.' : runtime.message }, version: "0.3.0", hermes: { release: "v2026.9.11", commit: "939e45c91d751fadd94dcd1b873ac3cb44846213" } });
    }
    if (req.method === 'GET' && (url.pathname === '/v1/install/runner.sh' || url.pathname === '/v1/install/runner.ps1')) {
      const name = url.pathname.endsWith('.ps1') ? 'install-runner.ps1' : 'install-runner.sh';
      return raw(res, 200, name.endsWith('.ps1') ? 'text/plain; charset=utf-8' : 'text/x-shellscript; charset=utf-8', readFileSync(join(import.meta.dirname, 'installers', name)));
    }
    if (req.method === 'GET' && url.pathname === '/v1/install/file') {
      const requested = String(url.searchParams.get('path') || '').replaceAll('\\', '/');
      const allowed = new Set(['runtime/runner.mjs', 'runtime/hermes/Dockerfile', 'runtime/hermes/NOTICE.md', 'runtime/hermes/container-init.sh', 'runtime/hermes/coordination.mjs', 'runtime/hermes/inspect_runtime.py', 'runtime/hermes/managed_entry.py', 'runtime/hermes/cua_compat.py', 'runtime/hermes/extension/open_harness_policy.py', 'runtime/hermes/extension/pyproject.toml']);
      if (!allowed.has(requested)) return json(res, 404, { error: 'Runner file not found.' });
      const target = requested === 'runtime/runner.mjs' ? join(import.meta.dirname, 'runner.mjs') : join(import.meta.dirname, requested.slice('runtime/'.length));
      if (!existsSync(target)) return json(res, 503, { error: 'The standalone runner bundle is unavailable. Run npm run runner:bundle on this source installation.' });
      return raw(res, 200, 'application/octet-stream', readFileSync(target));
    }
    if (req.method === 'POST' && url.pathname === '/v1/runner/pair') return json(res, 201, machines.pair(await body(req)));
    const runner = url.pathname.startsWith('/v1/runner/') ? runnerIdentity(req) : null;
    if (url.pathname.startsWith('/v1/runner/') && !runner) return json(res, 401, { error: 'Invalid or revoked runner credential.' });
    if (runner && req.method === 'POST' && url.pathname === '/v1/runner/heartbeat') {
      const input = await body(req), result = machines.heartbeat(runner, input);
      const activeCommandIds = Array.isArray(input.activeCommandIds) ? input.activeCommandIds.map(String) : [];
      for (const command of machines.reconcileLeases(runner, activeCommandIds)) interruptRunForCommand(command, 'Runner restarted after accepting this work. Completed events were preserved and the task was not replayed.');
      void pump(); return json(res, 200, result);
    }
    if (runner && req.method === 'GET' && url.pathname === '/v1/runner/commands') return json(res, 200, { commands: machines.poll(runner) });
    const runnerCommand = url.pathname.match(/^\/v1\/runner\/commands\/([^/]+)\/(events|complete)$/);
    if (runner && runnerCommand && req.method === 'POST') {
      const input = await body(req), commandId = runnerCommand[1];
      if (runnerCommand[2] === 'complete') {
        const command = machines.command(commandId), receipt = machines.finish(runner, commandId, input.result || { error: input.error }, Boolean(input.error));
        if (!receipt.duplicate && command && ['input', 'approval'].includes(command.kind)) {
          const row = store.db.prepare('SELECT payload_json FROM runner_commands WHERE id=?').get(command.id) as { payload_json: string };
          const payload = JSON.parse(row.payload_json) as { runId?: string; inputId?: string; approvalId?: string; type?: string; decision?: string };
          const run = store.getRun(String(payload.runId || ''));
          if (run && run.agent_id === command.agentId) {
            const table = command.kind === 'input' ? 'run_inputs' : 'approvals', requestId = command.kind === 'input' ? payload.inputId : payload.approvalId;
            const isActive = activeStates.has(run.state), failed = Boolean(input.error);
            const state = !isActive ? 'expired' : failed ? 'pending' : command.kind === 'input' ? 'answered' : String(payload.decision);
            const changed = store.db.prepare(`UPDATE ${table} SET state=?,resolved_at=? WHERE id=? AND run_id=? AND state='submitted'`).run(state, isActive && failed ? null : new Date().toISOString(), String(requestId || ''), run.id);
            if (changed.changes && isActive) {
              const approvalPending = store.db.prepare("SELECT 1 FROM approvals WHERE run_id=? AND state IN ('pending','submitting','submitted') LIMIT 1").get(run.id);
              const inputPending = store.db.prepare("SELECT 1 FROM run_inputs WHERE run_id=? AND state IN ('pending','submitting','submitted') LIMIT 1").get(run.id);
              store.setRun(run.id, { state: approvalPending ? 'waiting_approval' : inputPending ? 'waiting_input' : 'running' });
              event(run.id, failed ? `${command.kind}.delivery_failed` : `${command.kind}.resolved`, command.kind === 'input' ? { inputId: requestId, type: payload.type, ...(failed ? { error: 'The runner could not deliver this response. Try again.' } : {}) } : { approvalId: requestId, decision: payload.decision, ...(failed ? { error: 'The runner could not deliver this decision. Try again.' } : {}) });
            }
          }
        }
        if (command?.agentId) void pump(); return json(res, 200, { ok: true });
      }
      const eventId = String(input.eventId || ''); if (!eventId) return json(res, 400, { error: 'Event ID is required.' });
      const claimedRunId = String(input.runId || '');
      if (machines.receiveEvent(runner, commandId, eventId, claimedRunId)) { const run = store.getRun(claimedRunId); if (run) mapHermesEvent(run, input.event); }
      return json(res, 200, { ok: true });
    }
    const internalAgent = url.pathname.startsWith("/internal/") ? authenticatedAgent(req) : null;
    if (!authenticated(req) && !internalAgent) return json(res, 401, { error: "Invalid local control token." });
    if (req.method === "GET" && url.pathname === "/v1/health") return json(res, 200, { ok: true, runtime: await dockerStatusCached(), activeRuns: store.activeCount(), queuedRuns: store.listRuns().filter(run => run.state === "queued").length, secrets: secrets.names(), secretStorage: secrets.backend });
    if (req.method === 'GET' && url.pathname === '/v1/support-bundle') return json(res, 200, {
      generatedAt: new Date().toISOString(), version: '0.3.0', hermes: { release: 'v2026.9.11', commit: '939e45c91d751fadd94dcd1b873ac3cb44846213' },
      platform: { os: process.platform, arch: process.arch, node: process.version }, readiness: onboardingStatus(), machines: machines.list(),
      agents: profiles.list().map(profile => ({ id: profile.id, revision: profile.revision, machineId: profile.computer.machineId, access: profile.computer.access, desktop: profile.computer.desktop })),
      recentRuns: store.listRuns(25).map(run => ({ id: run.id, agentId: run.agent_id, state: run.state, createdAt: run.created_at, updatedAt: run.updated_at, error: run.error })),
      configuredCredentialNames: secrets.names(), secretStorage: secrets.backend, note: 'Secret values, prompts, messages, results, file contents, and model responses are excluded.',
    });
    if (req.method === 'GET' && url.pathname === '/v1/onboarding/status') return json(res, 200, onboardingStatus());
    // How a device that is not this computer can reach this coordinator. Read before showing
    // a pairing code, so the wizard can guide instead of minting one that cannot be used.
    if (req.method === 'GET' && url.pathname === '/v1/reachability') {
      return json(res, 200, reachability({ publicUrl: String(process.env.OPEN_HARNESS_PUBLIC_URL || ''), bind, port }));
    }
    if (req.method === 'POST' && url.pathname === '/v1/onboarding/action') { const input = await body(req); return json(res, 200, await onboardingAction(input.action)); }
    if (req.method === 'POST' && url.pathname === '/v1/onboarding/model-test') {
      const input = await body(req), model = validateModel(input.model);
      if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 100_000)) throw new ProfileError('Invalid API key.');
      const revision = Number(input.revision ?? profiles.defaults().revision);
      if (input.save && revision !== profiles.defaults().revision) throw new ProfileError('Workspace settings changed elsewhere. Reload before saving.', 409);
      const key = input.apiKey === undefined || input.apiKey === '' ? secrets.environment()[model.credentialRef] || '' : input.apiKey;
      const tested = await testModelConnection(model, key);
      if (!tested.ok || !input.save) return json(res, 200, tested);
      // Recheck after inference. Never replace a credential that another agent or
      // the previously working model still references.
      if (revision !== profiles.defaults().revision) throw new ProfileError('Workspace settings changed elsewhere. Reload before saving.', 409);
      const savedModel = { ...model };
      if (input.apiKey) { savedModel.credentialRef = `MODEL_${crypto.randomUUID().replaceAll('-', '').toUpperCase()}`; secrets.set(savedModel.credentialRef, input.apiKey); }
      return json(res, 200, { ...tested, ...profiles.setDefaults(savedModel, revision) });
    }
    if (url.pathname === '/v1/machines') {
      if (req.method === 'GET') return json(res, 200, { machines: machines.list() });
      if (req.method === 'POST') {
        const input = await body(req), publicUrl = String(input.coordinatorUrl || process.env.OPEN_HARNESS_PUBLIC_URL || `http://${req.headers.host || `127.0.0.1:${port}`}`).replace(/\/$/, '');
        let target: URL; try { target = new URL(publicUrl); } catch { return json(res, 400, { error: 'Enter a valid public coordinator address.' }); }
        const loopback = ['localhost', '127.0.0.1', '::1'].includes(target.hostname);
        if (target.protocol !== 'https:' && !loopback) return json(res, 400, { error: 'The public coordinator address must use HTTPS.' });
        // An emulator reaches the host over adb reverse, so loopback is a legitimate hub
        // address while developing. It stays blocked otherwise: a runner on another machine
        // could never reach it, and the error explains that rather than failing later.
        const loopbackPairingAllowed = process.env.OPEN_HARNESS_MOCK === '1' || process.env.OPEN_HARNESS_ALLOW_LOOPBACK_PAIRING === '1';
        // The refusal now carries the ways out of it, because "enter a reachable address" is
        // not useful to someone whose coordinator does not have one yet.
        if (loopback && !loopbackPairingAllowed) return json(res, 409, {
          error: 'This address only works on this computer. Your phone needs an address it can reach from outside it.',
          reachability: reachability({ publicUrl, bind, port }),
        });
        return json(res, 201, machines.createPairing(input, publicUrl));
      }
    }
    const machineSecretsMatch = url.pathname.match(/^\/v1\/machines\/([^/]+)\/secrets$/);
    if (machineSecretsMatch && req.method === 'GET') { machines.get(decodeURIComponent(machineSecretsMatch[1])); return json(res, 200, { secrets: secrets.names(), storage: 'coordinator' }); }
    const machineMatch = url.pathname.match(/^\/v1\/machines\/([^/]+)\/(test|reconnect|revoke)$/);
    if (machineMatch && req.method === 'POST') {
      const machineId = decodeURIComponent(machineMatch[1]), action = machineMatch[2], input = await body(req);
      if (action === 'test') {
        const profile = input.agentId ? profiles.get(String(input.agentId)) || undefined : undefined, checked = machines.test(machineId, profile);
        if (!checked.ok || !profile || process.env.OPEN_HARNESS_MOCK === '1') return json(res, 200, checked);
        try {
          if (machineId === 'local') reserveProbe(profile.id);
          ensureProfileDirs(profile.id);
          const check = { action: 'computer', desktop: profile.computer.desktop };
          const result = machineId === 'local' ? profile.computer.access === 'direct' ? nativeRuntimeProbe(join(root, 'agents', profile.id, 'profile'), check) : await runtimeProbe(ensureContainer(profile.id, root, profile.computer), check) : await runnerProbe(profile, 'probe-runtime', check);
          return json(res, 200, { ...checked, ok: Boolean(result.ok), message: String(result.message || checked.message), machine: checked.machine });
        } catch (error) { return json(res, 200, { ...checked, ok: false, message: error instanceof Error ? error.message : 'Computer access check failed.' }); }
      }
      if (action === 'reconnect') return json(res, 200, machines.reconnect(machineId));
      return json(res, 200, machines.revoke(machineId));
    }
    const agentComputerMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/(stop|transfer)$/);
    if (agentComputerMatch && req.method === 'POST') {
      const agentId = validId(decodeURIComponent(agentComputerMatch[1])), input = await body(req), profile = profiles.get(agentId); if (!profile) return json(res, 404, { error: 'Agent profile not found.' });
      if (agentComputerMatch[2] === 'stop') { const runs = store.listRuns().filter(run => run.agent_id === agentId && ['queued','running','waiting_approval','waiting_input'].includes(run.state)); let stopped = 0; for (const run of runs) stopped += await stopRunTree(run.id); return json(res, 200, { ok: true, stopped, pending: remoteActive.has(runs[0]?.id) }); }
      const destination = String(input.destinationMachineId || ''), pending = { ...profile, computer: { ...profile.computer, machineId: destination } };
      const transfer = machines.transfer(agentId, profile.computer.machineId, destination, pending); void performTransfer(transfer);
      return json(res, 202, transfer);
    }
    if (req.method === "POST" && url.pathname === "/v1/agents/sync") {
      const input = await body(req);
      for (const agent of input.agents || []) { profiles.import(agent); ensureProfileDirs(agent.id); }
      return json(res, 200, { synced: input.agents?.length || 0, agents: profiles.list().map(p => profileAgent(p)) });
    }
    if (req.method === "GET" && url.pathname === "/v1/agents") return json(res, 200, { agents: profiles.list().map(p => profileAgent(p)) });
    if (req.method === "POST" && url.pathname === "/v1/workspace/model/import") {
      const input = await body(req);
      return json(res, 200, profiles.defaults().revision ? profiles.defaults() : profiles.setDefaults(input.model, 0));
    }
    if (url.pathname === "/v1/workspace/model") {
      if (req.method === "GET") return json(res, 200, profiles.defaults());
      if (req.method === "PUT") { const input = await body(req); return json(res, 200, profiles.setDefaults(input.model, input.revision)); }
    }
    const profileMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/(profile|tools|models|connection-check|connector-check)$/);
    if (profileMatch) {
      const id = validId(decodeURIComponent(profileMatch[1])), action = profileMatch[2];
      const profile = profiles.get(id);
      if (action === 'profile' && req.method === 'PUT') {
        const input = await body(req); if (input.id !== id) throw new ProfileError('Profile ID does not match the selected agent.');
        const current = profiles.get(id), desired = validateProfile(input); if (machines.transferring(id)) throw new MachineError('This agent is already transferring. Wait for it to finish before editing its computer.', 409); machines.canAssign(desired.computer.machineId, id);
        const moving = Boolean(current && current.computer.machineId !== desired.computer.machineId);
        if (moving && probingAgents.has(id)) throw new ProfileError('This agent is busy. Wait for its settings operation to finish before changing computers.', 409);
        // Changing an agent's computer normally starts a file transfer so its memory and
        // skills travel with it. Phones cannot take part in that yet. An agent that has not
        // written anything has nothing to carry, so it can simply be reassigned; one that has
        // would silently lose its work, so that is refused with a reason.
        const phoneMove = moving && (machines.get(desired.computer.machineId).capabilities.mobile || machines.get(current!.computer.machineId).capabilities.mobile);
        if (phoneMove) {
          const onThisComputer = current!.computer.machineId === 'local';
          const carries = onThisComputer ? exportAgentFiles(root, id).files.length > 0 : true;
          if (carries) throw new MachineError('This agent has saved files that cannot move to or from a phone yet. Create a new agent and choose the phone as its computer.', 409);
        }
        const transferring = moving && !phoneMove;
        const saved = profiles.save(transferring ? { ...desired, computer: current!.computer } : desired); ensureProfileDirs(id);
        if (transferring) { const pending = { ...desired, revision: saved.revision }; machines.reserve(desired.computer.machineId, id, desired.computer.reserveMachine); void performTransfer(machines.transfer(id, current!.computer.machineId, desired.computer.machineId, pending)); }
        else if (phoneMove) machines.reserve(desired.computer.machineId, id, desired.computer.reserveMachine);
        else machines.reserve(saved.computer.machineId, id, saved.computer.reserveMachine);
        return json(res, 200, profileResponse(saved));
      }
      if (!profile) return json(res, 404, { error: 'Agent profile not found.' });
      if (action === 'profile' && req.method === 'GET') return json(res, 200, profileResponse(profile));
      if (action !== 'profile' && profile.computer.machineId === 'local') reserveProbe(id);
      if (action === 'tools' && req.method === 'GET') {
        ensureProfileDirs(id);
        const catalog = profile.computer.machineId === 'local' ? await discoverTools(id, root, profile) : await runnerProbe(profile, 'probe-tools') as ToolCatalog;
        if (catalog.source === 'unavailable') {
          const cached = store.db.prepare('SELECT json FROM tool_catalogs WHERE agent_id=?').get(id) as { json: string } | undefined;
          if (cached) { catalog.tools = (JSON.parse(cached.json) as ToolCatalog).tools.map(t => ({ ...t, available: false, reason: catalog.error })); catalog.source = 'cached'; }
        } else {
          const cached = store.db.prepare('SELECT json FROM tool_catalogs WHERE agent_id=?').get(id) as { json: string } | undefined;
          // Keep discovered connection tools editable across refreshes. A past handshake
          // is inventory, not proof the connection is available now.
          if (cached) for (const tool of (JSON.parse(cached.json) as ToolCatalog).tools) {
            if (tool.group === 'mcp' && !catalog.tools.some(t => t.id === tool.id)) catalog.tools.push({ ...tool, available: false, reason: 'Previously discovered. Test this connection again to confirm availability.' });
          }
          store.db.prepare('INSERT INTO tool_catalogs VALUES(?,?) ON CONFLICT(agent_id) DO UPDATE SET json=excluded.json').run(id, JSON.stringify(catalog));
        }
        return json(res, 200, catalog);
      }
      if (action === 'models' && req.method === 'GET') {
        try {
          if (profile.computer.machineId !== 'local') return json(res, 200, await runnerProbe(profile, 'probe-models'));
          if (!gateways.has(id)) { ensureProfileDirs(id); prepareProfile(root, profile, profiles.effective(profile), secrets, agentToken(id), 'catalog'); }
          return json(res, 200, await discoverModels(await gatewayFor(id, [], profile.computer)));
        } catch { return json(res, 200, { models: [], error: 'Model catalog unavailable. Start the Hermes runtime or enter a custom model ID.' }); }
      }
      if (action === 'connection-check' && req.method === 'POST') {
        const input = await body(req), model = validateModel(input.model);
        if (model.credentialRef && !secrets.has(model.credentialRef)) return json(res, 200, { ok: false, message: `Add the ${model.credentialRef} credential first.` });
        if (process.env.OPEN_HARNESS_MOCK === '1') return json(res, 200, { ok: true, message: 'Deterministic test connection is ready.' });
        const endpoints: Record<string,string> = { xai: 'https://api.x.ai/v1', openrouter: 'https://openrouter.ai/api/v1', openai: 'https://api.openai.com/v1' };
        const baseUrl = model.baseUrl || endpoints[model.provider];
        if (!baseUrl) return json(res, 200, { ok: false, message: 'This provider does not expose a compatible model-list endpoint. Model authentication will be checked by Hermes at task start.' });
        ensureProfileDirs(id);
        try { const check = { action: 'connection', baseUrl, apiKey: secrets.environment()[model.credentialRef] || '' }; return json(res, 200, profile.computer.machineId === 'local' ? profile.computer.access === 'direct' ? nativeRuntimeProbe(join(root, 'agents', id, 'profile'), check) : await runtimeProbe(ensureContainer(id, root, profile.computer), check) : await runnerProbe(profile, 'probe-runtime', check)); }
        catch (error) { return json(res, 200, { ok: false, message: error instanceof Error ? error.message : 'Connection failed.' }); }
      }
      if (action === 'connector-check' && req.method === 'POST') {
        const input = await body(req), candidate = input.connector;
        // Validate a draft without persisting it or changing the active run configuration.
        const { validateProfile } = await import('./profiles');
        const tested = validateProfile({ ...profile, connectors: [candidate] }).connectors[0];
        if (tested.secretRef && !secrets.has(tested.secretRef)) return json(res, 200, { status: 'missing_credentials', error: `Add secret ${tested.secretRef}.`, tools: [] });
        try {
          ensureProfileDirs(id);
          const result = process.env.OPEN_HARNESS_MOCK === '1' ? { status: 'connected', tools: [{ name: 'lookup', description: 'Mock connected tool' }] } : profile.computer.machineId === 'local' ? profile.computer.access === 'direct' ? nativeRuntimeProbe(join(root, 'agents', id, 'profile'), { action: 'mcp', command: tested.command, args: tested.args, env: tested.secretRef ? { [tested.secretRef]: secrets.environment()[tested.secretRef] } : {} }) : await runtimeProbe(ensureContainer(id, root, profile.computer), { action: 'mcp', command: tested.command, args: tested.args, env: tested.secretRef ? { [tested.secretRef]: secrets.environment()[tested.secretRef] } : {} }) : await runnerProbe(profile, 'probe-runtime', { action: 'mcp', command: tested.command, args: tested.args, env: tested.secretRef ? { [tested.secretRef]: secrets.environment()[tested.secretRef] } : {} });
          const tools = (result.tools as Array<{ name: string; description: string }>).map(t => ({ id: `mcp_${tested.name}_${t.name}`, name: t.name, description: t.description, group: 'mcp', available: true }));
          const prior = store.db.prepare('SELECT json FROM tool_catalogs WHERE agent_id=?').get(id) as { json: string } | undefined;
          const catalog: ToolCatalog = prior ? JSON.parse(prior.json) : { source: 'runtime', tools: [] };
          catalog.tools = [...catalog.tools.filter(t => !t.id.startsWith(`mcp_${tested.name}_`)), ...tools];
          store.db.prepare('INSERT INTO tool_catalogs VALUES(?,?) ON CONFLICT(agent_id) DO UPDATE SET json=excluded.json').run(id, JSON.stringify(catalog));
          return json(res, 200, { ...result, tools });
        } catch { return json(res, 200, { status: 'failed', error: 'MCP initialize/tools-list handshake failed. Check the executable, arguments, and credentials.', tools: [] }); }
      }
    }
    const contextMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/context(?:\/skills\/([^/]+))?$/);
    if (contextMatch) {
      const id = validId(decodeURIComponent(contextMatch[1])), name = contextMatch[2] === undefined ? undefined : decodeURIComponent(contextMatch[2]);
      if (!['GET', 'PUT', ...(name ? ['DELETE'] : [])].includes(req.method || '')) return json(res, 405, { error: 'Unsupported context method.' });
      if (name !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(name)) throw new ProfileError('Invalid skill name.');
      if (machines.transferring(id)) throw new ProfileError('This agent is transferring. Wait for it to finish before editing its context.', 409);
      reserveProbe(id);
      const input = req.method === 'PUT' ? await body(req) : {};
      const operation: ContextOperation = name === undefined ? { operation: req.method === 'GET' ? 'get' : 'set-memory', memory: String(input.memory || '') }
        : { operation: req.method === 'GET' ? 'get-skill' : req.method === 'PUT' ? 'put-skill' : 'delete-skill', name, content: String(input.content || '') };
      if (operation.operation === 'set-memory' && operation.memory!.length > 50_000) throw new ProfileError('Memory is limited to 50 KB.', 413);
      const profile = profiles.get(id), machineId = profile?.computer.machineId || 'local';
      let result: ContextResult;
      if (machineId === 'local') result = agentContext(root, id, operation);
      else {
        const machine = machines.canAssign(machineId, id);
        if (machine.status !== 'online') throw new MachineError(`${machine.name} is offline. Reconnect it before editing context.`, 409);
        result = await waitRunnerCommand(machines.enqueue(machineId, id, 'agent-context', operation).id) as ContextResult;
      }
      if (operation.operation === 'get' && result.status === 200) {
        const machine = machines.get(machineId), available = machineId === 'local' ? (await dockerStatusCached()).available : machine.capabilities.container || machine.capabilities.direct;
        result.value.capabilities = { terminal: available, process: available, code: available, files: available, web: available, browser: available, memory: available, skills: available, mcp: available, delegation: available, schedules: true };
      }
      return json(res, result.status, result.value);
    }
    if (req.method === "POST" && url.pathname === "/v1/migrate") {
      const input = await body(req); const found = store.db.prepare("SELECT 1 FROM migrations WHERE key='browser-v1'").get();
      if (found) return json(res, 200, { migrated: false, reason: "already_migrated" });
      store.db.prepare("INSERT INTO migrations(key,payload_json,created_at) VALUES(?,?,?)").run("browser-v1", JSON.stringify(input), new Date().toISOString());
      for (const agent of input.agents || []) {
        profiles.import(agent);
        const { memory } = profileMemory(root, String(agent.id));
        if (Array.isArray(agent.memory) && agent.memory.length && !existsSync(memory)) writeFileSync(memory, agent.memory.map((item: unknown) => `- ${String(item)}`).join("\n") + "\n", { mode: 0o600 });
      }
      for (const conversation of input.conversations || []) store.db.prepare("INSERT OR IGNORE INTO conversations(id,agent_id,title,legacy_json,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(conversation.id, conversation.agentId, conversation.title, JSON.stringify(conversation), conversation.updatedAt || new Date().toISOString(), conversation.updatedAt || new Date().toISOString());
      for (const file of input.files || []) { const target = join(root, "shared", String(file.name).replace(/[^a-zA-Z0-9._ -]/g, "_")); writeFileSync(target, String(file.content).slice(0, 1_000_000)); }
      writeFileSync(join(root, "browser-v1-backup.json"), JSON.stringify(input, null, 2), { mode: 0o600 });
      return json(res, 200, { migrated: true });
    }
    if (url.pathname === "/v1/boards") {
      if (req.method === "GET") return json(res, 200, { boards: tasks.listBoards(url.searchParams.get("includeArchived") === "1") });
      if (req.method === "POST") return json(res, 201, tasks.createBoard(await body(req)));
    }
    const boardMatch = url.pathname.match(/^\/v1\/boards\/([^/]+)(?:\/(stages))?$/);
    if (boardMatch) {
      const boardId = decodeURIComponent(boardMatch[1]);
      if (!boardMatch[2] && req.method === "GET") return json(res, 200, tasks.getBoard(boardId));
      if (!boardMatch[2] && req.method === "PUT") return json(res, 200, tasks.updateBoard(boardId, await body(req)));
      if (boardMatch[2] === "stages" && req.method === "POST") return json(res, 201, tasks.addStage(boardId, await body(req)));
    }
    const stageMatch = url.pathname.match(/^\/v1\/stages\/([^/]+)$/);
    if (stageMatch) {
      if (req.method === "PUT") return json(res, 200, tasks.updateStage(decodeURIComponent(stageMatch[1]), await body(req)));
      if (req.method === "DELETE") return json(res, 200, tasks.removeStage(decodeURIComponent(stageMatch[1]), url.searchParams.get("moveToStageId") || undefined));
    }
    if (url.pathname === "/v1/tasks") {
      if (req.method === "GET") return json(res, 200, { boards: tasks.listBoards(url.searchParams.get("includeArchived") === "1"), tasks: tasks.listTasks(url.searchParams.get("includeArchived") === "1") });
      if (req.method === "POST") return json(res, 201, tasks.createTask(await body(req)));
    }
    const taskMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)(?:\/(comments|start|request-changes|approve|runs|move|stop|check|additem))?$/);
    if (taskMatch) {
      const taskId = decodeURIComponent(taskMatch[1]), action = taskMatch[2];
      if (!action && req.method === "GET") return json(res, 200, tasks.getTask(taskId));
      if (!action && req.method === "PUT") return json(res, 200, tasks.updateTask(taskId, await body(req)));
      if (!action && req.method === "DELETE") { const task = tasks.getTask(taskId); if (task.activeRunId) return json(res, 409, { error: 'Stop the active run before deleting this task.' }); store.db.prepare("DELETE FROM tasks WHERE id=?").run(taskId); return json(res, 200, { ok: true }); }
      if (action === "comments" && req.method === "POST") return json(res, 201, tasks.comment(taskId, { ...await body(req), author: 'you' }));
      if (action === "move" && req.method === "POST") return json(res, 200, tasks.move(taskId, await body(req)));
      if (action === "check" && req.method === "POST") { const input = await body(req); return json(res, 200, tasks.check(taskId, String(input.item || ''), input.done === undefined ? undefined : Boolean(input.done))); }
      if (action === "additem" && req.method === "POST") { const input = await body(req); return json(res, 201, tasks.addItem(taskId, String(input.text || ''))); }
      if ((action === "start" || action === "request-changes") && req.method === "POST") { const started = tasks.start(taskId, await body(req), input => createRun({ ...input, deferStart: true })); void pump(); return json(res, 202, started); }
      if (action === "stop" && req.method === "POST") { const task = tasks.getTask(taskId); if (!task.activeRunId) return json(res, 409, { error: 'This task is not running.' }); return json(res, 200, { ok: true, stopped: await stopRunTree(task.activeRunId) }); }
      if (action === "approve" && req.method === "POST") { const input = await body(req); return json(res, 200, tasks.approve(taskId, input.revision === undefined ? undefined : Number(input.revision))); }
      if (action === "runs" && req.method === "GET") return json(res, 200, { runs: tasks.getTask(taskId).runs });
    }
    if (req.method === "POST" && url.pathname === "/v1/runs") return json(res, 202, runResponse(createRun(await body(req))));
    if (req.method === 'GET' && url.pathname === '/v1/runs') return json(res, 200, { runs: store.listRuns(1000).map(runResponse) });
    if (req.method === 'GET' && url.pathname === '/v1/conversations') {
      const agentId = url.searchParams.get('agentId');
      const rows = (agentId ? store.db.prepare('SELECT * FROM runs WHERE agent_id=? ORDER BY created_at,rowid').all(agentId) : store.db.prepare('SELECT * FROM runs ORDER BY created_at,rowid').all()) as RunRow[];
      const conversations = new Map<string, { id: string; agentId: string; title: string; updatedAt: string; runs: ReturnType<typeof runResponse>[] }>();
      for (const run of rows) {
        const key = `${run.agent_id}:${run.conversation_id}`;
        const conversation = conversations.get(key) || { id: run.conversation_id, agentId: run.agent_id, title: run.prompt.slice(0, 52), updatedAt: run.updated_at, runs: [] };
        conversation.runs.push(runResponse(run)); conversation.updatedAt = run.updated_at > conversation.updatedAt ? run.updated_at : conversation.updatedAt; conversations.set(key, conversation);
      }
      return json(res, 200, { conversations: [...conversations.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) });
    }
    if (req.method === 'POST' && url.pathname === '/v1/runs/stop-all') { let stopped = 0; for (const run of store.db.prepare("SELECT * FROM runs WHERE parent_run_id IS NULL AND state IN ('queued','running','waiting_approval','waiting_input')").all() as RunRow[]) stopped += await stopRunTree(run.id); return json(res, 200, { stopped }); }
    const runMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)(?:\/(events|steer|stop|approval|input))?$/);
    if (runMatch) {
      const run = store.getRun(runMatch[1]); if (!run) return json(res, 404, { error: "Run not found." }); const action = runMatch[2];
      if (!action && req.method === "GET") return json(res, 200, runResponse(run));
      if (action === "events" && req.method === "GET") return json(res, 200, { events: store.events(run.id, Number(url.searchParams.get("after") || 0)), run: runResponse(store.getRun(run.id)!) });
      if (action === "steer" && req.method === "POST") { const input = await body(req), live = active.get(run.id), remote = remoteActive.get(run.id); if (!live && !remote) return json(res, 409, { error: "Run is not active." }); if (live) await live.gateway.request("session.steer", { session_id: live.sessionId, text: String(input.text || "") }); else machines.enqueue(remote!.machineId, run.agent_id, 'steer', { runId: run.id, commandId: remote!.commandId, text: String(input.text || '') }); event(run.id, "run.steered", { text: input.text }); return json(res, 200, { ok: true }); }
      if (action === "stop" && req.method === "POST") return json(res, 200, { ok: true, stopped: await stopRunTree(run.id) });
      if (action === 'approval' && req.method === 'POST') {
        const input = await body(req), approval = store.approval(String(input.approvalId));
        if (!approval || approval.run_id !== run.id) return json(res, 404, { error: 'Approval not found.' });
        if (approval.state !== 'pending' || !activeStates.has(run.state)) return json(res, 409, { error: 'This approval is no longer pending.' });
        const live = active.get(run.id), remote = remoteActive.get(run.id);
        if (!live && !remote) return json(res, 409, { error: 'Run is not active.' });
        if (!['approve', 'deny'].includes(input.decision)) throw new ProfileError('Choose approve or deny.');
        const decision = input.decision, approvalId = String(approval.id);
        const claimed = store.db.prepare("UPDATE approvals SET state='submitting' WHERE id=? AND run_id=? AND state='pending'").run(approvalId, run.id);
        if (!claimed.changes) return json(res, 409, { error: 'This approval is already being answered.' });
        try {
          if (live) {
            await live.gateway.request('approval.respond', { request_id: approval.gateway_request_id, decision });
            store.db.prepare("UPDATE approvals SET state=?,resolved_at=? WHERE id=? AND state='submitting'").run(decision, new Date().toISOString(), approvalId);
            event(run.id, 'approval.resolved', { approvalId, decision });
          } else {
            machines.enqueue(remote!.machineId, run.agent_id, 'approval', { runId: run.id, commandId: remote!.commandId, requestId: approval.gateway_request_id, approvalId, decision });
            store.db.prepare("UPDATE approvals SET state='submitted' WHERE id=? AND state='submitting'").run(approvalId);
          }
        } catch (error) {
          store.db.prepare("UPDATE approvals SET state=? WHERE id=? AND state='submitting'").run(activeStates.has(store.getRun(run.id)?.state || '') ? 'pending' : 'expired', approvalId);
          throw error;
        }
        if (!terminalStates.has(store.getRun(run.id)?.state || '')) {
          const approvalPending = store.db.prepare("SELECT 1 FROM approvals WHERE run_id=? AND state IN ('pending','submitting','submitted') LIMIT 1").get(run.id);
          const inputPending = store.db.prepare("SELECT 1 FROM run_inputs WHERE run_id=? AND state IN ('pending','submitting','submitted') LIMIT 1").get(run.id);
          store.setRun(run.id, { state: approvalPending ? 'waiting_approval' : inputPending ? 'waiting_input' : 'running' });
        }
        return json(res, 200, { ok: true, pending: Boolean(remote) });
      }
      if (action === 'input' && req.method === 'POST') {
        const input = await body(req), pending = store.db.prepare('SELECT * FROM run_inputs WHERE id=? AND run_id=?').get(String(input.inputId), run.id) as { id: string; gateway_request_id: string; type: string; state: string } | undefined;
        if (!pending) return json(res, 404, { error: 'Input request not found.' });
        if (pending.state !== 'pending' || !activeStates.has(run.state)) return json(res, 409, { error: 'This input is no longer pending.' });
        const value = input.value;
        if ((typeof value !== 'string' && !(pending.type === 'clarify' && Array.isArray(value) && value.every(item => typeof item === 'string'))) || JSON.stringify(value).length > 20_000) throw new ProfileError('Enter a valid response.');
        const live = active.get(run.id), remote = remoteActive.get(run.id);
        if (!live && !remote) return json(res, 409, { error: 'Run is not active.' });
        const claimed = store.db.prepare("UPDATE run_inputs SET state='submitting' WHERE id=? AND run_id=? AND state='pending'").run(pending.id, run.id);
        if (!claimed.changes) return json(res, 409, { error: 'This input is already being answered.' });
        try {
          const fields: Record<string, string> = { clarify: 'answer', secret: 'value', sudo: 'password' };
          if (live) {
            await live.gateway.request(`${pending.type}.respond`, { request_id: pending.gateway_request_id, [fields[pending.type]]: value });
            store.db.prepare("UPDATE run_inputs SET state='answered',resolved_at=? WHERE id=? AND state='submitting'").run(new Date().toISOString(), pending.id);
            event(run.id, 'input.resolved', { inputId: pending.id, type: pending.type });
          } else {
            let response: Record<string, unknown> = { value };
            if (pending.type !== 'clarify') {
              const key = store.db.prepare('SELECT encryption_public_key FROM machines WHERE id=?').get(remote!.machineId) as { encryption_public_key?: string };
              if (!key?.encryption_public_key) throw new MachineError('Reconnect this runner before sending a private response.', 409);
              response = { encrypted: await encryptRunnerSecret(key.encryption_public_key, String(value)) };
            }
            if (!activeStates.has(store.getRun(run.id)?.state || '') || !store.db.prepare("SELECT 1 FROM run_inputs WHERE id=? AND state='submitting'").get(pending.id)) throw new ProfileError('This run or input request finished before the response could be sent.', 409);
            machines.enqueue(remote!.machineId, run.agent_id, 'input', { runId: run.id, commandId: remote!.commandId, requestId: pending.gateway_request_id, inputId: pending.id, type: pending.type, ...response });
            store.db.prepare("UPDATE run_inputs SET state='submitted' WHERE id=? AND state='submitting'").run(pending.id);
          }
        } catch (error) {
          store.db.prepare("UPDATE run_inputs SET state=? WHERE id=? AND state='submitting'").run(activeStates.has(store.getRun(run.id)?.state || '') ? 'pending' : 'expired', pending.id);
          if (pending.type !== 'clarify' && !(error instanceof ProfileError || error instanceof MachineError)) throw new ProfileError('The agent could not accept this private response. Check whether its request is still pending.');
          throw error;
        }
        if (!terminalStates.has(store.getRun(run.id)?.state || '')) {
          const approvalPending = store.db.prepare("SELECT 1 FROM approvals WHERE run_id=? AND state IN ('pending','submitting','submitted') LIMIT 1").get(run.id);
          const inputPending = store.db.prepare("SELECT 1 FROM run_inputs WHERE run_id=? AND state IN ('pending','submitting','submitted') LIMIT 1").get(run.id);
          store.setRun(run.id, { state: approvalPending ? 'waiting_approval' : inputPending ? 'waiting_input' : 'running' });
        }
        return json(res, 200, { ok: true, pending: Boolean(remote) });
      }
    }
    if (req.method === "POST" && url.pathname === "/v1/secrets") { const input = await body(req); secrets.set(String(input.name), String(input.value)); return json(res, 200, { ok: true, name: input.name }); }
    if (/^\/v1\/agents\/[^/]+\/connectors/.test(url.pathname)) return json(res, 410, { error: 'Connection settings moved into Agent settings. Reload the app.' });
    if (url.pathname === "/v1/files") { const { scope, dir } = workspaceDir(url); mkdirSync(dir, { recursive: true }); if (req.method === "GET") { const name = url.searchParams.get("name"); if (name) { const target = safeFile(dir, name); if (!existsSync(target)) return json(res, 404, { error: "File not found." }); const encoding = isText(name) ? "utf8" : "base64"; return json(res, 200, { name, content: readFileSync(target, encoding), encoding, mimeType: mimeType(name), scope }); } return json(res, 200, { files: listFiles(dir), scope }); } if (req.method === "POST") { const input = await body(req), content = String(input.content || ""), encoding = input.encoding === "base64" ? "base64" : "utf8", bytes = encoding === "base64" ? Buffer.byteLength(content, "base64") : Buffer.byteLength(content); if (bytes > 1_000_000) return json(res, 413, { error: "Files are limited to 1 MB." }); const target = safeFile(dir, String(input.name || "")); writeFileSync(target, content, { encoding, mode: 0o600 }); return json(res, 201, { name: input.name, scope }); } if (req.method === "DELETE") { const target = safeFile(dir, String(url.searchParams.get("name") || "")); if (existsSync(target)) unlinkSync(target); return json(res, 200, { ok: true }); } }
    if (req.method === "GET" && url.pathname === "/v1/routines") return json(res, 200, { routines: store.db.prepare("SELECT * FROM schedules ORDER BY created_at DESC").all() });
    if (req.method === "POST" && url.pathname === "/v1/routines") { const input = await body(req), stamp = new Date(), id = crypto.randomUUID(), minutes = Math.max(1, Number(input.intervalMinutes || 60)); const next = new Date(stamp.getTime() + minutes * 60000).toISOString(); store.db.prepare("INSERT INTO schedules(id,agent_id,name,prompt,interval_minutes,timezone,enabled,next_run_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, input.agentId, input.name, input.prompt, minutes, input.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone, 1, next, stamp.toISOString(), stamp.toISOString()); return json(res, 201, { id, nextRunAt: next }); }
    // A routine with a typo, a wrong agent, or a runaway interval could previously only
    // be paused, never corrected or removed — so every mistake was permanent.
    const routineItem = url.pathname.match(/^\/v1\/routines\/([^/]+)$/);
    if (routineItem) {
      const routine = store.db.prepare("SELECT * FROM schedules WHERE id=?").get(routineItem[1]) as any;
      if (!routine) return json(res, 404, { error: "Routine not found." });
      if (req.method === "DELETE") {
        store.db.prepare("DELETE FROM schedule_runs WHERE schedule_id=?").run(routine.id);
        store.db.prepare("DELETE FROM schedules WHERE id=?").run(routine.id);
        return json(res, 200, { ok: true });
      }
      if (req.method === "PUT") {
        const input = await body(req), stamp = new Date().toISOString();
        const name = input.name === undefined ? routine.name : String(input.name).trim().slice(0, 200);
        const prompt = input.prompt === undefined ? routine.prompt : String(input.prompt).trim().slice(0, 20_000);
        if (!name || !prompt) return json(res, 400, { error: "A routine needs a name and a task." });
        const agentId = input.agentId === undefined ? routine.agent_id : String(input.agentId);
        if (!profiles.list().some(profile => profile.id === agentId)) return json(res, 400, { error: "That agent no longer exists." });
        // Clamped like the hosted route: an interval of 0 or a negative number would
        // otherwise land as "every minute, forever".
        const minutes = input.intervalMinutes === undefined
          ? Number(routine.interval_minutes)
          : Math.max(1, Math.min(525_600, Math.round(Number(input.intervalMinutes))));
        if (!Number.isFinite(minutes)) return json(res, 400, { error: "Enter how often this should run, in minutes." });
        // Re-base the next run so a shortened interval takes effect now rather than
        // waiting out the old one.
        const next = new Date(Date.now() + minutes * 60_000).toISOString();
        store.db.prepare("UPDATE schedules SET agent_id=?,name=?,prompt=?,interval_minutes=?,next_run_at=?,updated_at=? WHERE id=?")
          .run(agentId, name, prompt, minutes, next, stamp, routine.id);
        return json(res, 200, { ...routine, agent_id: agentId, name, prompt, interval_minutes: minutes, next_run_at: next, updated_at: stamp });
      }
    }
    const routineMatch = url.pathname.match(/^\/v1\/routines\/([^/]+)\/(run|toggle|history)$/);
    if (routineMatch) {
      const routine = store.db.prepare("SELECT * FROM schedules WHERE id=?").get(routineMatch[1]) as any;
      if (!routine) return json(res, 404, { error: "Routine not found." });
      if (routineMatch[2] === "history" && req.method === "GET") return json(res, 200, { history: store.db.prepare("SELECT schedule_runs.*,runs.state,runs.result,runs.error,runs.updated_at FROM schedule_runs JOIN runs ON runs.id=schedule_runs.run_id WHERE schedule_id=? ORDER BY scheduled_for DESC LIMIT 100").all(routine.id) });
      if (req.method === "POST" && routineMatch[2] === "run") { const stamp = new Date().toISOString(), run = createRun({ agentId: routine.agent_id, prompt: routine.prompt }); store.db.prepare("INSERT INTO schedule_runs(schedule_id,run_id,scheduled_for) VALUES(?,?,?)").run(routine.id, run.id, stamp); store.db.prepare("UPDATE schedules SET last_run_at=?,updated_at=? WHERE id=?").run(stamp, stamp, routine.id); return json(res, 202, run); }
      if (req.method === "POST" && routineMatch[2] === "toggle") { store.db.prepare("UPDATE schedules SET enabled=?,updated_at=? WHERE id=?").run(routine.enabled ? 0 : 1, new Date().toISOString(), routine.id); return json(res, 200, { enabled: !routine.enabled }); }
    }
    if (req.method === "POST" && url.pathname === "/internal/handoff") { const input = await body(req); const parent = store.liveRuns().find(run => run.agent_id === internalAgent && ["running","waiting_approval","waiting_input"].includes(run.state)); if (!parent) return json(res, 409, { error: "The delegating agent has no active run." }); if (!internalAllowed(internalAgent, "mcp_open_harness_delegate_named_agent", String(req.headers["x-open-harness-run"] || parent.id))) return json(res, 403, { error: "Delegation is disabled for this run." }); const child = createRun({ agentId: input.agentId, prompt: input.prompt, parentRunId: parent.id }); event(parent.id, "handoff.created", { childRunId: child.id, targetAgentId: input.agentId, prompt: input.prompt }); const result = await waitForRun(child.id); event(parent.id, "handoff.completed", { childRunId: child.id, targetAgentId: input.agentId, state: result.state }); return json(res, 200, { runId: result.id, state: result.state, result: result.result, error: result.error }); }
    if (req.method === "POST" && url.pathname === "/internal/task") {
      const input = await body(req), runId = String(req.headers['x-open-harness-run'] || '');
      if (!internalAllowed(internalAgent, 'mcp_open_harness_task', runId)) return json(res, 403, { error: 'Task board access is disabled for this run.' });
      const scopedRunId = runId || store.liveRuns().find(run => run.agent_id === internalAgent)?.id || '';
      const profile = profiles.runSnapshot(scopedRunId); if (!profile) return json(res, 403, { error: 'Run profile not found.' });
      const action = String(input.action || ''), taskId = String(input.taskId || ''), patch = (input.input || {}) as Record<string, unknown>;
      const mayTouch = (task: ReturnType<typeof tasks.getTask>) => task.ownerAgentId === null || task.ownerAgentId === internalAgent || profile.board.assignOthers;
      if (['create', 'update', 'move'].includes(action) && patch.ownerAgentId && patch.ownerAgentId !== internalAgent && !profile.board.assignOthers) return json(res, 403, { error: 'Assigning another agent requires Board: assign others.' });
      if (action === 'list') return json(res, 200, { boards: tasks.listBoards(), tasks: tasks.listTasks().filter(task => task.ownerAgentId === null || task.ownerAgentId === internalAgent || profile.board.assignOthers) });
      if (action === 'columns') return json(res, 200, { boards: tasks.listBoards() });
      if (action === 'create') return json(res, 201, tasks.createTask({ ...patch, boardId: patch.boardId || input.boardId, ownerAgentId: patch.ownerAgentId === undefined ? internalAgent : patch.ownerAgentId }));
      const task = tasks.getTask(taskId); if (!mayTouch(task)) return json(res, 403, { error: 'Changing another agent’s card requires Board: assign others.' });
      if (action === 'get') return json(res, 200, task);
      if (action === 'update') return json(res, 200, tasks.updateTask(taskId, { ...patch, revision: task.revision }));
      if (action === 'move') return json(res, 200, tasks.move(taskId, patch));
      if (action === 'comment') return json(res, 201, tasks.comment(taskId, { body: patch.text || patch.body, author: profile.name }));
      if (action === 'check') return json(res, 200, tasks.check(taskId, String(patch.item || ''), patch.done === undefined ? undefined : Boolean(patch.done)));
      if (action === 'additem') return json(res, 201, tasks.addItem(taskId, String(patch.text || '')));
      if (action === 'claim') return json(res, 200, tasks.updateTask(taskId, { revision: task.revision, ownerAgentId: internalAgent }));
      if (action === 'release') { tasks.updateTask(taskId, { revision: task.revision, ownerAgentId: null }); return json(res, 200, tasks.comment(taskId, { body: String(patch.reason || 'Released as blocked.'), author: profile.name })); }
      if (action === 'run') { if (task.ownerAgentId && task.ownerAgentId !== internalAgent && !profile.board.dispatch) return json(res, 403, { error: 'Starting another agent’s task requires Board: dispatch.' }); const board = tasks.getBoard(task.boardId); if (!board.settings.allowAgentDispatch) return json(res, 403, { error: 'Agent task dispatch is disabled for this board.' }); const started = tasks.start(taskId, { revision: task.revision, idempotencyKey: crypto.randomUUID() }, value => createRun({ ...value, deferStart: true })); void pump(); return json(res, 202, started); }
      return json(res, 400, { error: 'Unknown task action.' });
    }
    if (req.method === "POST" && url.pathname === "/internal/schedule") { if (!internalAllowed(internalAgent, "mcp_open_harness_create_open_harness_routine", String(req.headers["x-open-harness-run"] || ""))) return json(res, 403, { error: "Scheduling is disabled for this run." }); const input = await body(req), stamp = new Date(), id = crypto.randomUUID(), minutes = Math.max(1, Number(input.intervalMinutes || 60)), next = new Date(stamp.getTime() + minutes * 60000).toISOString(); store.db.prepare("INSERT INTO schedules(id,agent_id,name,prompt,interval_minutes,timezone,enabled,next_run_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, internalAgent, input.name, input.prompt, minutes, input.timezone || "UTC", 1, next, stamp.toISOString(), stamp.toISOString()); return json(res, 201, { id, nextRunAt: next }); }
    return json(res, 404, { error: "Not found." });
  } catch (error) { return json(res, error instanceof ProfileError || error instanceof TaskError || error instanceof MachineError ? error.status : 400, { error: error instanceof Error ? error.message : "Request failed." }); }
  finally {
    if (probingAgent) {
      const gateway = gateways.get(probingAgent);
      if (gateway) { try { await gateway.stop(); gateways.delete(probingAgent); store.db.prepare('DELETE FROM runtime_processes WHERE agent_id=?').run(probingAgent); } catch (error) { const computer = profiles.get(probingAgent)?.computer; if (computer) blockCleanup(probingAgent, computer, error instanceof Error ? error.message : String(error)); } }
      probingAgents.delete(probingAgent); void pump();
    }
  }
});

// createRun throws for an agent that no longer exists, for a full queue, and for depth
// and cycle violations. An unguarded throw here escapes the timer callback and takes the
// whole coordinator down, and because next_run_at is only advanced on success the same
// routine is still due on restart — a crash loop with no log and no way out. Every
// routine is therefore isolated, and a routine that can never succeed is disabled rather
// than retried forever.
function advanceRoutine(routine: any, now: Date) {
  const next = new Date(now.getTime() + Number(routine.interval_minutes) * 60000).toISOString();
  store.db.prepare("UPDATE schedules SET last_run_at=?,next_run_at=?,updated_at=? WHERE id=?").run(now.toISOString(), next, now.toISOString(), routine.id);
}
function runDueRoutine(routine: any, now: Date) {
  const scheduledFor = routine.next_run_at;
  if (store.db.prepare("SELECT 1 FROM schedule_runs WHERE schedule_id=? AND scheduled_for=?").get(routine.id, scheduledFor)) return;
  try {
    const run = createRun({ agentId: routine.agent_id, prompt: routine.prompt });
    store.db.prepare("INSERT INTO schedule_runs(schedule_id,run_id,scheduled_for) VALUES(?,?,?)").run(routine.id, run.id, scheduledFor);
    advanceRoutine(routine, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Routine could not start.";
    if (error instanceof ProfileError) {
      store.db.prepare("UPDATE schedules SET enabled=0,updated_at=? WHERE id=?").run(now.toISOString(), routine.id);
      console.error(`Routine ${routine.id} was disabled because its agent no longer exists: ${message}`);
      return;
    }
    console.error(`Routine ${routine.id} could not start and will retry at its next interval: ${message}`);
    advanceRoutine(routine, now);
  }
}
setInterval(() => {
  try {
    const now = new Date(), due = store.db.prepare("SELECT * FROM schedules WHERE enabled=1 AND next_run_at<=?").all(now.toISOString()) as any[];
    for (const routine of due) runDueRoutine(routine, now);
  } catch (error) {
    console.error(`The routine scheduler skipped this tick: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  try {
    // Clean up leases created by pre-MVP builds that briefly allowed phone execution.
    for (const command of machines.sweepStaleLeases()) interruptRunForCommand(command, 'A legacy phone-hosted task stopped responding. It was not replayed because its outcome is uncertain.');
  } catch (error) {
    console.error(`The phone lease sweep skipped this tick: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}, 30_000).unref();

const bind = process.env.OPEN_HARNESS_BIND || '127.0.0.1';
server.on("error", error => {
  // A bare EADDRINUSE here reaches the operator as a raw stack via uncaughtException,
  // which buries the one fact that matters: something already holds the port.
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EADDRINUSE") console.error(`Port ${port} on ${bind} is already in use. Another coordinator is probably running — stop it, or set OPEN_HARNESS_PORT to a free port.`);
  else if (code === "EACCES") console.error(`Not allowed to bind ${bind}:${port}. Use a port above 1024, or set OPEN_HARNESS_PORT.`);
  else if (code === "EADDRNOTAVAIL") console.error(`No interface on this machine has the address ${bind}. Check OPEN_HARNESS_BIND.`);
  else console.error(`The coordinator could not listen on ${bind}:${port}: ${error.message}`);
  process.exit(1);
});
// Reserve the address before recovery too, including when an older coordinator has no state lock.
await new Promise<void>(resolve => server.listen(port, bind, resolve));
await recoverRuns();
console.log(`Open Harness coordinator listening on http://${bind}:${port}`);
void pump();
// Without these the coordinator exits silently when anything throws outside a request —
// a timer callback, a detached promise — leaving no record of why the service stopped.
// In-flight runs are marked interrupted on the next start, so exiting is safe; being
// unable to tell that it happened is not.
process.on("unhandledRejection", reason => console.error(`Unhandled rejection in the coordinator: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`));
process.on("uncaughtException", error => { console.error(`The coordinator stopped on an unhandled error: ${error.stack || error.message}`); process.exit(1); });
// Agent containers run with --restart unless-stopped, so a coordinator that dies
// without stopping them leaves containers that come back on every Docker start and
// hold their CPU/memory reservations forever. SIGINT (Ctrl-C on `npm run harness:serve`)
// has to clean up exactly like SIGTERM does; stopping gateways in parallel and under a
// deadline keeps that cleanup from itself hanging on a wedged daemon.
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Open Harness coordinator stopping on ${signal}.`);
  const deadline = setTimeout(() => { console.error("Shutdown took too long; exiting with agents possibly still running."); process.exit(1); }, 15_000);
  deadline.unref();
  server.close();
  await Promise.allSettled([
    ...[...gateways.values()].map(gateway => gateway.stop()),
    ...[...coordinationSockets.values()].map(socket => socket.then(s => s.close())),
  ]);
  clearTimeout(deadline);
  process.exit(0);
}
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => void shutdown(signal));
// The desktop shell supervises this process through tauri-plugin-shell, whose only
// stop primitive is SIGKILL — which the handlers above cannot catch, so quitting the
// app would strand agent containers. It asks for a clean stop over stdin instead.
// Gated on the env var so a coordinator started from a terminal never touches stdin.
if (process.env.OPEN_HARNESS_STDIN_CONTROL === "1") {
  let pending = "";
  process.stdin.on("data", chunk => {
    pending = (pending + String(chunk)).slice(-256);
    let index = pending.indexOf("\n");
    while (index >= 0) {
      const line = pending.slice(0, index).trim();
      pending = pending.slice(index + 1);
      if (line === "shutdown") void shutdown("a shutdown request from the desktop app");
      index = pending.indexOf("\n");
    }
  });
  process.stdin.on("error", () => {});
  // Never let an idle stdin pipe be the reason this process stays alive.
  process.stdin.unref();
}
