/* eslint-disable @typescript-eslint/no-explicit-any */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFileSync, mkdirSync, writeFileSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, existsSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Profiles, ProfileError, validateModel, validateProfile, validId } from "./profiles";
import { discoverTools, discoverModels, nativeRuntimeProbe, prepareProfile, runtimeProbe } from "./profile-runtime";
import { HANDOFF_TOOL, profileAgent, ROUTINE_TOOL, TASK_TOOL, type AgentProfile, type ComputerConfig, type ToolCatalog } from "../lib/agent-profile";
import { SchemaTooNewError, Store, type RunRow } from "./db";
import { SecretStore, SecretsUnavailableError } from "./secrets";
import { Credentials, CredentialError } from "./credentials";
import type { CredentialRecord, CredentialUsage, CredentialUse } from "../lib/credentials";
import { validateComputerTarget } from './computer-validation';
import { hermesApprovalDecision, HermesGateway, dockerStatusCached, ensureContainer, stopManagedContainers } from "./hermes";
import { coordinationSocket } from "./coordination-socket";
import { TaskError, TaskStore } from "./tasks";
import { TeamError, TeamStore } from "./teams";
import { MachineError, Machines } from "./machines";
import { encryptRunnerSecret } from "../lib/runner-crypto";
import { exportAgentFiles, importAgentFiles, type TransferBundle } from './transfer-files';
import { onboardingAction, onboardingStatus } from './readiness';
import { APP_VERSION } from '../lib/version';
import { HERMES_COMMIT, HERMES_RELEASE } from '../lib/hermes-pin';

const root = resolve(process.env.OPEN_HARNESS_STATE_DIR || ".open-harness");
mkdirSync(root, { recursive: true }); mkdirSync(join(root, "shared"), { recursive: true }); mkdirSync(join(root, "agents"), { recursive: true });
const store = openStore(join(root, "state.db"));
function openStore(file: string) {
  try { return new Store(file); }
  catch (error) {
    if (!(error instanceof SchemaTooNewError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}
// A vault that cannot be read is reported and fatal, never worked around: continuing would
// mint a new control token and overwrite the stored keys on the first save.
const secrets = openSecrets(join(root, "secrets.json"));
function openSecrets(file: string) {
  try { return new SecretStore(file); }
  catch (error) {
    if (!(error instanceof SecretsUnavailableError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}
const credentials = new Credentials(store.db, secrets);
const profiles = new Profiles(store.db);
const teams = new TeamStore(store.db);
const tasks = new TaskStore(store.db);
store.runListener = run => tasks.syncRun(run);
tasks.reconcile();
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
const coordinationSockets = new Map<string, ReturnType<typeof coordinationSocket>>();
let pumping = false;
const maxTaskQueue = Math.max(1, Number(process.env.MAX_TASK_QUEUE || 100));
const maxTaskRuns = Math.max(1, Number(process.env.MAX_TASK_RUNS || 3));
// How long a dispatched run waits for a runner that has stopped heartbeating.
const REMOTE_OFFLINE_GRACE_MS = Math.max(60_000, Number(process.env.OPEN_HARNESS_REMOTE_OFFLINE_GRACE_MS || 5 * 60_000));

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": allowedOrigin(res.req.headers.origin), "Vary": "Origin", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS" });
  res.end(JSON.stringify(body));
}
function raw(res: ServerResponse, status: number, contentType: string, value: string | Buffer) {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(value);
}
function allowedOrigin(origin?: string) { return origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? origin : "http://localhost:3000"; }
// A DNS-rebinding page reaches this service from 127.0.0.1 and sends no Origin header,
// because from the browser's point of view the request is same-origin. The one thing it
// cannot forge is the Host header, which still carries the attacker's own name.
function loopbackHost(host?: string) { return Boolean(host && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)); }
async function body(req: IncomingMessage) {
  let text = ""; for await (const chunk of req) { text += chunk; if (text.length > 5_000_000) throw new Error("Request too large."); }
  return text ? JSON.parse(text) : {};
}
function authenticated(req: IncomingMessage) {
  const supplied = String(req.headers.authorization || ''), expected = `Bearer ${secrets.token}`;
  return supplied.length === expected.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}
function runnerIdentity(req: IncomingMessage) {
  const machineId = String(req.headers['x-open-harness-machine'] || ''), token = String(req.headers.authorization || '').replace(/^Bearer /, '');
  return machineId && machines.authenticate(machineId, token) ? machineId : null;
}
function agentToken(agentId: string) { return createHmac("sha256", secrets.token).update(`agent:${agentId}`).digest("hex"); }
function authenticatedAgent(req: IncomingMessage) {
  const id = String(req.headers["x-open-harness-agent"] || ""), supplied = String(req.headers.authorization || "").replace(/^Bearer /, ""), expected = agentToken(id);
  return Boolean(id && supplied.length === expected.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) ? id : null;
}
function event(runId: string, type: string, payload: unknown) { return store.appendEvent(runId, type, payload); }
// Kept outside the agent's own workspace: it is the record of what the runtime said when a
// run failed, and the agent should not be able to read or rewrite it. Bounded so a chatty
// runtime cannot fill the disk.
const logDir = join(root, 'logs');
function appendAgentLog(agentId: string, entry: { level?: string; message?: string }) {
  try {
    mkdirSync(logDir, { recursive: true });
    const file = join(logDir, `${validId(agentId)}.log`);
    if (existsSync(file) && statSync(file).size > 2_000_000) renameSync(file, `${file}.1`);
    appendFileSync(file, `${new Date().toISOString()} ${entry.level || 'info'} ${String(entry.message || '').slice(0, 1000)}\n`, { mode: 0o600 });
  } catch { /* logging must never take down a run */ }
}
function profileResponse(profile: AgentProfile) {
  const live = store.listRuns().find(run => run.agent_id === profile.id && ["running", "waiting_approval", "waiting_input"].includes(run.state));
  const snapshot = live ? profiles.runSnapshot(live.id) : null;
  return { profile, effectiveModel: profiles.effective(profile), activeRevision: snapshot?.revision ?? null, pending: Boolean(snapshot && (snapshot.revision !== profile.revision || JSON.stringify(snapshot.effectiveModel) !== JSON.stringify(profiles.effective(profile)) || JSON.stringify(snapshot.computer) !== JSON.stringify(profile.computer))), secretNames: secrets.names(), credentials: credentialRecords(), machine: machines.get(profile.computer.machineId), transfer: machines.transferStatus(profile.id) };
}

function credentialUses(ref: string): CredentialUsage {
  const uses: CredentialUse[] = [];
  // Reported once rather than fanned out, so the delete dialog can say "the workspace
  // default, which N agents inherit" instead of listing every inheriting agent twice.
  if (profiles.defaults().model.credentialRef === ref) uses.push({ kind: "workspace-default" });
  for (const profile of profiles.list()) {
    if (!profile.model.inherit && profile.model.credentialRef === ref) uses.push({ kind: "agent-model", agentId: profile.id, agentName: profile.name });
    for (const connector of profile.connectors) if (connector.secretRef === ref) uses.push({ kind: "agent-connector", agentId: profile.id, agentName: profile.name, connectorName: connector.name, enabled: connector.enabled });
  }
  const activeRuns = store.listRuns().filter(run => ["running", "waiting_approval", "waiting_input"].includes(run.state)).filter(run => {
    const snapshot = profiles.runSnapshot(run.id);
    return Boolean(snapshot && (snapshot.effectiveModel.credentialRef === ref || snapshot.connectors.some(c => c.enabled && c.secretRef === ref)));
  }).length;
  return { uses, agentCount: new Set(uses.filter(use => "agentId" in use).map(use => (use as { agentId: string }).agentId)).size, activeRuns };
}
function credentialRecord(row: ReturnType<Credentials["row"]>): CredentialRecord {
  return { ref: row.ref, label: row.label, provider: row.provider, fingerprint: row.fingerprint, length: row.length, present: credentials.present(row.ref), createdAt: row.created_at, updatedAt: row.updated_at, lastUsedAt: row.last_used_at, usage: credentialUses(row.ref) };
}
function credentialRecords() { return credentials.rows().map(credentialRecord); }
// Points every reference at a different credential so one can be deleted without
// silently breaking agents. Server-side read-modify-write, so profiles.save() always
// sees a matching revision -- but it still bumps, which 409s any stale open editor.
function reassignCredential(from: string, to: string) {
  const updated: string[] = [];
  const defaults = profiles.defaults();
  if (defaults.model.credentialRef === from) { profiles.setDefaults({ ...defaults.model, credentialRef: to }, defaults.revision); updated.push("workspace"); }
  for (const profile of profiles.list()) {
    const model = !profile.model.inherit && profile.model.credentialRef === from ? { ...profile.model, credentialRef: to } : profile.model;
    const connectors = profile.connectors.map(c => c.secretRef === from ? { ...c, secretRef: to } : c);
    if (model === profile.model && connectors.every((c, i) => c === profile.connectors[i])) continue;
    profiles.save({ ...profile, model, connectors }); updated.push(profile.id);
  }
  return updated;
}
function selectedSecrets(profile: AgentProfile, effective: ReturnType<Profiles['effective']>) {
  const names = new Set([effective.credentialRef, ...profile.connectors.filter(item => item.enabled).map(item => item.secretRef)].filter(Boolean));
  const available = secrets.environment(); return Object.fromEntries([...names].filter(name => available[name]).map(name => [name, available[name]]));
}
// A dispatched command is a durable row, so a provider key must never travel through it in
// the clear: it would outlive the run in state.db with no way to notice. Each value is
// sealed to the runner's own public key, which only that machine can open.
async function dispatchSecrets(machineId: string, profile: AgentProfile, effective: ReturnType<Profiles['effective']>) {
  const plain = selectedSecrets(profile, effective);
  if (!Object.keys(plain).length) return {};
  const key = machines.encryptionKey(machineId);
  if (!key) throw new MachineError('This computer has not published its encryption key yet. It is sent on every heartbeat, so wait a few seconds for it to check in, or pair it again.', 409);
  return Object.fromEntries(await Promise.all(Object.entries(plain).map(async ([name, value]) => [name, await encryptRunnerSecret(key, value)])));
}
async function runnerProbe(profile: AgentProfile, kind: 'probe-tools' | 'probe-runtime' | 'probe-models', input?: unknown) { const machine = machines.canAssign(profile.computer.machineId, profile.id); if (machine.status !== 'online') throw new MachineError(`${machine.name} is offline. Reconnect it before checking this setting.`, 409); const effectiveModel = profiles.effective(profile); return waitRunnerCommand(machines.enqueue(machine.id, profile.id, kind, { profile: { ...profile, effectiveModel }, input, encryptedSecrets: await dispatchSecrets(machine.id, profile, effectiveModel), coordinationToken: agentToken(profile.id) }).id); }

async function executeRemote(run: RunRow, snapshot: AgentProfile & { effectiveModel: ReturnType<Profiles['effective']> }) {
  const machine = machines.canAssign(snapshot.computer.machineId, run.agent_id);
  if (machine.status !== 'online') throw new Error(`${machine.name} is offline. This task will remain queued until its runner reconnects.`);
  const command = machines.enqueue(machine.id, run.agent_id, 'run', { runId: run.id, prompt: run.prompt, snapshot, encryptedSecrets: await dispatchSecrets(machine.id, snapshot, snapshot.effectiveModel), coordinationToken: agentToken(run.agent_id) });
  remoteActive.set(run.id, { machineId: machine.id, commandId: command.id });
  let offlineSince = 0;
  event(run.id, 'runner.dispatched', { commandId: command.id, machineId: machine.id, machineName: machine.name });
  try {
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, 250));
      const current = store.getRun(run.id); if (!current || current.state === 'cancelled') throw Object.assign(new Error('Run cancelled.'), { cancelled: true });
      const status = machines.command(command.id); if (!status) throw new Error('The runner command disappeared before completion.');
      if (machines.get(machine.id).status !== 'online') {
        if (!offlineSince) offlineSince = Date.now();
        else if (Date.now() - offlineSince > REMOTE_OFFLINE_GRACE_MS) throw new Error(`${machine.name} stopped responding and did not return within ${Math.round(REMOTE_OFFLINE_GRACE_MS / 60_000)} minutes. Its work was not replayed because the outcome is uncertain.`);
      } else offlineSince = 0;
      if (status.state === 'completed') return status.result || {};
      if (status.state === 'failed') throw new Error(String((status.result as { error?: string } | null)?.error || 'Remote runner failed.'));
    }
  } finally { remoteActive.delete(run.id); }
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
  const run = runId ? store.getRun(runId) : store.listRuns().find(r => r.agent_id === agentId && ['running','waiting_approval','waiting_input'].includes(r.state));
  return Boolean(run && run.agent_id === agentId && ['running','waiting_approval','waiting_input'].includes(run.state) && profiles.runSnapshot(run.id)?.allowedTools.includes(tool));
}

async function gatewayFor(agentId: string, allowedTools: string[] | null = null, computer?: ComputerConfig) {
  let gateway = gateways.get(agentId);
  if (gateway) return gateway;
  if (computer?.access === 'direct') {
    const agentRoot = join(root, 'agents', agentId), profileRoot = join(agentRoot, 'profile');
    gateway = new HermesGateway(`native-${agentId}`, allowedTools, { cwd: join(root, 'shared'), entry: join(import.meta.dirname, 'hermes', 'managed_entry.py'), env: { ...process.env, HERMES_HOME: profileRoot, HERMES_TUI: '1', HERMES_GATEWAY_SESSION: '1', PYTHONUNBUFFERED: '1', OPEN_HARNESS_POLICY_PATH: join(agentRoot, 'managed', 'policy.json') } });
  } else {
    gateway = new HermesGateway(ensureContainer(agentId, root, computer), allowedTools);
  }
  gateway.on('log', (entry: { level?: string; message?: string }) => appendAgentLog(agentId, entry));
  gateways.set(agentId, gateway);
  try { await gateway.start(); return gateway; }
  catch (error) { gateways.delete(agentId); throw error; }
}

function mapHermesEvent(run: RunRow, value: any) {
  const type = String(value?.type || value?.event || "runtime.event");
  const payload = value?.payload ?? value?.data ?? value;
  if (type === "approval.request") {
    const approvalId = crypto.randomUUID();
    store.createApproval(approvalId, run.id, String(payload?.request_id || payload?.id || ""), payload);
    store.setRun(run.id, { state: "waiting_approval" });
    event(run.id, "approval.request", { ...payload, approvalId });
  } else if (type === "clarify.request" || type === "secret.request" || type === "sudo.request") {
    store.setRun(run.id, { state: "waiting_input" }); event(run.id, type, payload);
  } else {
    if (type === 'message.delta') tasks.appendOutput(run.id, String(payload?.text || ''));
    event(run.id, type, payload);
  }
}

async function execute(run: RunRow) {
  store.setRun(run.id, { state: "running" });
  let subscribed: { gateway: HermesGateway; listener: (value: any) => void } | null = null;
  try {
    const profile = profiles.get(run.agent_id);
    if (!profile) throw new Error("Agent profile not found. Open Agent settings and save this agent.");
    const snapshot = profiles.snapshot(run.id, profile);
    credentials.touch([snapshot.effectiveModel.credentialRef, ...snapshot.connectors.filter(c => c.enabled).map(c => c.secretRef)]);
    const assigned = machines.canAssign(snapshot.computer.machineId, run.agent_id);
    event(run.id, "run.started", { runId: run.id, agentId: run.agent_id, machineId: assigned.id, machineName: assigned.name });
    event(run.id, "profile.applied", { revision: snapshot.revision, model: snapshot.effectiveModel, allowedTools: snapshot.allowedTools, computer: snapshot.computer });
    if (assigned.id !== 'local') {
      const result = await executeRemote(run, snapshot);
      const current = store.getRun(run.id); if (current?.state === 'cancelled') return;
      const answer = String(result?.text || result?.final_response || result?.message || result?.result || '');
      store.setRun(run.id, { state: 'completed', result: answer }); event(run.id, 'run.completed', { result: answer, machineId: assigned.id });
      return;
    }
    const priorGateway = gateways.get(run.agent_id);
    if (priorGateway) { await priorGateway.stop(); gateways.delete(run.agent_id); }
    if (!coordinationSockets.has(run.agent_id)) coordinationSockets.set(run.agent_id, coordinationSocket(join(root, 'agents', run.agent_id, 'managed'), run.agent_id, (req, res) => { server.emit('request', req, res); }));
    await coordinationSockets.get(run.agent_id);
    if (store.getRun(run.id)?.state === 'cancelled') return;
    const native = snapshot.computer.access === 'direct';
    // A container agent reached the coordinator only over the unix socket in its managed mount.
    // Docker Desktop passes bind mounts through a VM, where that socket is visible and refuses
    // every connection, so on the setup this project documents as supported no coordination tool
    // worked at all. The socket is still tried first -- it needs no port and cannot be reached
    // from off the machine -- with the host URL behind it, exactly as a paired runner already
    // does for its own containers. The container needs the control token either way.
    prepareProfile(root, snapshot, snapshot.effectiveModel, secrets, agentToken(run.agent_id), run.id, native
      ? { cwd: join(root, 'shared'), coordinationCommand: join(import.meta.dirname, 'hermes', 'coordination.mjs'), controlSocket: join(root, 'agents', run.agent_id, 'managed', 'coord.sock') }
      : { controlUrl: `http://host.docker.internal:${port}` });
    const gateway = await gatewayFor(run.agent_id, snapshot.allowedTools, snapshot.computer);
    const listener = (value: any) => mapHermesEvent(run, value); gateway.on("event", listener); subscribed = { gateway, listener };
    const session = run.session_id ? { session_id: run.session_id } : await gateway.request("session.create", { cwd: native ? join(root, 'shared') : "/workspace/shared", profile: "default" });
    if (store.getRun(run.id)?.state === "cancelled") return;
    const sessionId = String(session?.session_id || session?.id || run.session_id || "");
    if (!sessionId) throw new Error("Hermes did not return a session ID.");
    store.setRun(run.id, { session_id: sessionId }); active.set(run.id, { gateway, sessionId });
    const result = await gateway.submitPrompt(sessionId, run.prompt);
    active.delete(run.id);
    const current = store.getRun(run.id);
    if (current?.state === "cancelled") return;
    const answer = String(result?.text || result?.final_response || result?.message || "");
    store.setRun(run.id, { state: "completed", result: answer }); event(run.id, "run.completed", { result: answer });
  } catch (error) {
    active.delete(run.id); const message = error instanceof Error ? error.message : "Hermes execution failed.";
    const state = store.getRun(run.id)?.state === "cancelled" || remoteStopping.has(run.id) ? "cancelled" : (error as { interrupted?: boolean })?.interrupted ? "interrupted" : "failed";
    remoteStopping.delete(run.id);
    store.setRun(run.id, { state, error: message }); event(run.id, `run.${state}`, { error: message });
  } finally { if (subscribed) subscribed.gateway.off("event", subscribed.listener); void pump(); }
}

async function pump() {
  if (pumping) return; pumping = true;
  try {
    while (store.activeCount() < 4) {
      const next = store.queued().find(candidate =>
        !store.agentBusy(candidate.agent_id) && !stoppingAgents.has(candidate.agent_id) && !machines.transferring(candidate.agent_id) &&
        (!tasks.isTaskRun(candidate.id) || tasks.activeRunCount() < maxTaskRuns) &&
        (candidate.depth > 0 || store.activeTopLevelCount() < 2) && (() => {
          const profile = profiles.get(candidate.agent_id); if (!profile) return true;
          try { if (machines.canAssign(profile.computer.machineId, candidate.agent_id).status !== 'online') return false; } catch { return false; }
          const occupants = store.listRuns().filter(run => ['running','waiting_approval','waiting_input'].includes(run.state)).map(run => profiles.runSnapshot(run.id) || profiles.get(run.agent_id)).filter((other): other is AgentProfile => Boolean(other && other.computer.machineId === profile.computer.machineId));
          if (occupants.length >= profile.computer.resources.concurrency) return false;
          return profile.computer.desktop !== 'existing' || occupants.every(other => other.computer.desktop !== 'existing');
        })());
      if (!next) break;
      void execute(next);
    }
  } finally { pumping = false; }
}

async function stopRunTree(runId: string) {
  const ids = [runId, ...store.descendants(runId).map(item => item.id)];
  let stopped = 0;
  const failures: string[] = [];
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
    store.setRun(id, { state: "cancelled" });
    try {
      const gateway = live?.gateway || (run.state === 'queued' ? undefined : gateways.get(run.agent_id));
      if (live) await live.gateway.request("session.interrupt", { session_id: live.sessionId }, 5000).catch(() => {});
      if (gateway) { await gateway.stop(); gateways.delete(run.agent_id); }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Runtime stop could not be confirmed.";
      store.setRun(id, { state: "interrupted", error: message });
      event(id, "run.interrupted", { error: message });
      failures.push(message);
    } finally {
      // Always release the agent. Holding it would keep it out of admission for the life of
      // the process, and the run is already recorded as cancelled or interrupted either way.
      stoppingAgents.delete(run.agent_id);
    }
    event(id, "run.cancelled", { stoppedWithParent: id !== runId }); stopped++;
  }
  void pump();
  return { stopped, failures };
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
function runResponse(run: RunRow) { const profile = profiles.runSnapshot(run.id) || profiles.get(run.agent_id); const machineId = profile?.computer.machineId || null; let machineConnection: string | null = null; if (machineId) { try { machineConnection = machines.get(machineId).status; } catch { machineConnection = 'revoked'; } } return { ...run, machine_id: machineId, machine_connection: machineConnection }; }

function listFiles(dir: string) {
  if (!dir.startsWith(root)) throw new Error("Invalid workspace path.");
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
function workspaceDir(url: URL) { const scope = url.searchParams.get("scope") || "shared", agentId = url.searchParams.get("agentId") || ""; return { scope, dir: scope === "private" ? join(root, "agents", validId(agentId), "private") : join(root, "shared") }; }
function safeFile(dir: string, name: string) { if (!/^[a-zA-Z0-9][a-zA-Z0-9._ -]{0,159}$/.test(name) || name.includes("..")) throw new Error("Invalid filename."); const target = join(dir, name); if (!target.startsWith(dir + "/")) throw new Error("Invalid path."); return target; }

function validTaskMutation(input: Record<string, unknown>, current?: ReturnType<TaskStore["getTask"]>) {
  const teamId = input.teamId === undefined ? current?.teamId || null : input.teamId ? String(input.teamId) : null;
  let ownerAgentId: string | null;
  if (input.ownerAgentId === undefined) {
    ownerAgentId = current?.ownerAgentId || null;
    if (!current && input.boardId) ownerAgentId = tasks.getBoard(String(input.boardId)).defaultOwnerAgentId;
  } else ownerAgentId = input.ownerAgentId ? String(input.ownerAgentId) : null;
  const collaboratorAgentIds = input.collaboratorAgentIds === undefined ? current?.collaboratorAgentIds || [] : Array.isArray(input.collaboratorAgentIds) ? input.collaboratorAgentIds.map(String) : [];
  const allowLegacy = Boolean(current && !current.teamId && !teamId && input.collaboratorAgentIds === undefined);
  return { ...input, ...teams.validateAssignment(teamId, ownerAgentId, collaboratorAgentIds, allowLegacy) };
}

function agentMayTouchTask(agentId: string, assignOthers: boolean, task: ReturnType<TaskStore["getTask"]>) {
  if (task.teamId && !teams.isMember(task.teamId, agentId)) return false;
  return task.ownerAgentId === null || task.ownerAgentId === agentId || task.collaboratorAgentIds.includes(agentId) || assignOthers;
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return json(res, 403, { error: "Open Harness accepts local browser clients only." });
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": allowedOrigin(origin), "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS" }); return res.end(); }
  const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
  try {
    if (req.method === "GET" && url.pathname === "/v1/bootstrap") { const address = req.socket.remoteAddress || ''; if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address)) return json(res, 403, { error: 'Dashboard bootstrap is available only from the coordinator machine.' }); if (!loopbackHost(req.headers.host)) return json(res, 403, { error: 'Dashboard bootstrap requires a loopback address. Open Open Harness at http://localhost:3000.' }); return json(res, 200, { token: secrets.token, mode: process.env.OPEN_HARNESS_MOCK === '1' ? 'test' : 'live', runtime: await dockerStatusCached(), version: APP_VERSION, hermes: { release: HERMES_RELEASE, commit: HERMES_COMMIT } }); }
    if (req.method === 'GET' && (url.pathname === '/v1/install/runner.sh' || url.pathname === '/v1/install/runner.ps1')) {
      const name = url.pathname.endsWith('.ps1') ? 'install-runner.ps1' : 'install-runner.sh';
      return raw(res, 200, name.endsWith('.ps1') ? 'text/plain; charset=utf-8' : 'text/x-shellscript; charset=utf-8', readFileSync(join(import.meta.dirname, 'installers', name)));
    }
    if (req.method === 'GET' && url.pathname === '/v1/install/file') {
      const requested = String(url.searchParams.get('path') || '').replaceAll('\\', '/');
      const allowed = new Set(['runtime/runner.mjs', 'runtime/hermes/Dockerfile', 'runtime/hermes/NOTICE.md', 'runtime/hermes/container-init.sh', 'runtime/hermes/coordination.mjs', 'runtime/hermes/inspect_runtime.py', 'runtime/hermes/managed_entry.py', 'runtime/hermes/extension/open_harness_policy.py', 'runtime/hermes/extension/pyproject.toml']);
      if (!allowed.has(requested)) return json(res, 404, { error: 'Runner file not found.' });
      const target = requested === 'runtime/runner.mjs' ? join(import.meta.dirname, 'runner.mjs') : join(import.meta.dirname, requested.slice('runtime/'.length));
      if (!existsSync(target)) return json(res, 503, { error: 'The standalone runner bundle is unavailable. Run npm run runner:bundle on this source installation.' });
      return raw(res, 200, 'application/octet-stream', readFileSync(target));
    }
    if (req.method === 'POST' && url.pathname === '/v1/runner/pair') return json(res, 201, machines.pair(await body(req)));
    const runner = url.pathname.startsWith('/v1/runner/') ? runnerIdentity(req) : null;
    if (url.pathname.startsWith('/v1/runner/') && !runner) return json(res, 401, { error: 'Invalid or revoked runner credential.' });
    if (runner && req.method === 'POST' && url.pathname === '/v1/runner/heartbeat') { const input = await body(req), result = machines.heartbeat(runner, input); for (const command of machines.reconcileLeases(runner, Array.isArray(input.activeCommandIds) ? input.activeCommandIds.map(String) : [])) { const run = store.getRun(String((command as any).payload?.runId || '')); if (run && !['completed','failed','cancelled','interrupted'].includes(run.state)) { const error = 'Runner restarted after accepting this work. Completed events were preserved and the task was not replayed.'; store.setRun(run.id, { state: 'interrupted', error }); event(run.id, 'run.interrupted', { error }); } } void pump(); return json(res, 200, result); }
    if (runner && req.method === 'GET' && url.pathname === '/v1/runner/commands') return json(res, 200, { commands: machines.poll(runner) });
    const runnerCommand = url.pathname.match(/^\/v1\/runner\/commands\/([^/]+)\/(events|complete)$/);
    if (runner && runnerCommand && req.method === 'POST') {
      const input = await body(req), commandId = runnerCommand[1];
      if (runnerCommand[2] === 'complete') { const command = machines.command(commandId); machines.finish(runner, commandId, input.result || { error: input.error }, Boolean(input.error)); if (command?.agentId) void pump(); return json(res, 200, { ok: true }); }
      const eventId = String(input.eventId || ''); if (!eventId) return json(res, 400, { error: 'Event ID is required.' });
      const claimedRunId = String(input.runId || '');
      if (machines.receiveEvent(runner, commandId, eventId, claimedRunId)) { const run = store.getRun(claimedRunId); if (run) mapHermesEvent(run, input.event); }
      return json(res, 200, { ok: true });
    }
    const internalAgent = url.pathname.startsWith("/internal/") ? authenticatedAgent(req) : null;
    if (!authenticated(req) && !internalAgent) return json(res, 401, { error: "Invalid local control token." });
    if (req.method === "GET" && url.pathname === "/v1/health") return json(res, 200, { ok: true, runtime: await dockerStatusCached(), activeRuns: store.activeCount(), queuedRuns: store.listRuns().filter(run => run.state === "queued").length, secrets: secrets.names(), secretStorage: secrets.backend });
    if (req.method === 'GET' && url.pathname === '/v1/support-bundle') return json(res, 200, {
      generatedAt: new Date().toISOString(), version: APP_VERSION, hermes: { release: HERMES_RELEASE, commit: HERMES_COMMIT },
      platform: { os: process.platform, arch: process.arch, node: process.version }, readiness: onboardingStatus(secrets.names(), root), machines: machines.list(),
      agents: profiles.list().map(profile => ({ id: profile.id, revision: profile.revision, machineId: profile.computer.machineId, access: profile.computer.access, desktop: profile.computer.desktop })),
      recentRuns: store.listRuns(25).map(run => ({ id: run.id, agentId: run.agent_id, state: run.state, createdAt: run.created_at, updatedAt: run.updated_at, error: run.error })),
      credentials: credentials.rows().map(row => ({ ref: row.ref, label: row.label, provider: row.provider, present: credentials.present(row.ref), createdAt: row.created_at, updatedAt: row.updated_at, lastUsedAt: row.last_used_at })), secretStorage: secrets.backend, note: 'Secret values, prompts, messages, results, file contents, and model responses are excluded.',
    });
    if (req.method === 'GET' && url.pathname === '/v1/onboarding/status') return json(res, 200, onboardingStatus(secrets.names(), root));
    if (req.method === 'POST' && url.pathname === '/v1/onboarding/action') { const input = await body(req); return json(res, 200, await onboardingAction(input.action, secrets.names())); }
    if (req.method === 'POST' && url.pathname === '/v1/onboarding/model-test') {
      const input = await body(req), model = validateModel(input.model);
      if (process.env.OPEN_HARNESS_MOCK === '1') return json(res, 200, { ok: true, message: 'Model connection is ready.' });
      if (model.credentialRef && !secrets.has(model.credentialRef)) return json(res, 200, { ok: false, message: 'Save your API key first.' });
      const endpoints: Record<string,string> = { xai: 'https://api.x.ai/v1', openrouter: 'https://openrouter.ai/api/v1', openai: 'https://api.openai.com/v1' };
      const baseUrl = (model.baseUrl || endpoints[model.provider] || '').replace(/\/$/, '');
      if (!baseUrl) return json(res, 200, { ok: false, message: 'Enter the address of your model server.' });
      const key = model.credentialRef ? secrets.environment()[model.credentialRef] : '';
      try {
        const response = await fetch(`${baseUrl}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(15_000), redirect: 'error' });
        if (response.ok) return json(res, 200, { ok: true, message: 'Model connection is ready.' });
        const messages: Record<number,string> = { 401: 'The API key was rejected.', 403: 'The provider denied access.', 404: 'The model server address was not found.', 429: 'The provider rate limit was reached. Try again shortly.' };
        return json(res, 200, { ok: false, message: messages[response.status] || `The provider returned HTTP ${response.status}.` });
      } catch (error) { return json(res, 200, { ok: false, message: error instanceof Error ? error.message : 'Could not reach the model provider.' }); }
    }
    if (url.pathname === '/v1/machines') {
      if (req.method === 'GET') return json(res, 200, { machines: machines.list() });
      if (req.method === 'POST') {
        const input = await body(req), publicUrl = String(input.coordinatorUrl || process.env.OPEN_HARNESS_PUBLIC_URL || `http://${req.headers.host || `127.0.0.1:${port}`}`).replace(/\/$/, '');
        let target: URL; try { target = new URL(publicUrl); } catch { return json(res, 400, { error: 'Enter a valid public coordinator address.' }); }
        const loopback = ['localhost', '127.0.0.1', '::1'].includes(target.hostname);
        if (target.protocol !== 'https:' && !loopback) return json(res, 400, { error: 'The public coordinator address must use HTTPS.' });
        if (loopback && process.env.OPEN_HARNESS_MOCK !== '1') return json(res, 409, { error: 'This address only works on this computer. Enter the HTTPS address that the new computer can reach.' });
        return json(res, 201, machines.createPairing(input, publicUrl));
      }
    }
    const machineSecretsMatch = url.pathname.match(/^\/v1\/machines\/([^/]+)\/secrets$/);
    if (machineSecretsMatch && req.method === 'GET') { machines.get(decodeURIComponent(machineSecretsMatch[1])); return json(res, 200, { secrets: secrets.names(), credentials: credentialRecords(), storage: 'coordinator' }); }
    const machineMatch = url.pathname.match(/^\/v1\/machines\/([^/]+)\/(test|reconnect|revoke)$/);
    if (machineMatch && req.method === 'POST') {
      const machineId = decodeURIComponent(machineMatch[1]), action = machineMatch[2], input = await body(req);
      if (action === 'test') {
        const profile = input.agentId ? profiles.get(String(input.agentId)) || undefined : undefined, checked = machines.test(machineId, profile);
        if (!checked.ok || !profile || process.env.OPEN_HARNESS_MOCK === '1') return json(res, 200, checked);
        try {
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
      if (agentComputerMatch[2] === 'stop') { const runs = store.listRuns().filter(run => run.agent_id === agentId && ['queued','running','waiting_approval','waiting_input'].includes(run.state)); let stopped = 0; const failures: string[] = []; for (const run of runs) { const result = await stopRunTree(run.id); stopped += result.stopped; failures.push(...result.failures); } return json(res, 200, { ok: true, stopped, ...(failures.length ? { failures } : {}), pending: remoteActive.has(runs[0]?.id) }); }
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
    if (url.pathname === "/v1/teams") {
      if (req.method === "GET") return json(res, 200, { teams: teams.list(url.searchParams.get("includeRetired") === "1") });
      if (req.method === "POST") return json(res, 201, teams.create(await body(req)));
    }
    if (url.pathname === "/v1/teams/sync" && req.method === "POST") {
      const input = await body(req), saved = [];
      for (const team of Array.isArray(input.teams) ? input.teams : []) saved.push(teams.import(team));
      return json(res, 200, { teams: saved });
    }
    const teamMatch = url.pathname.match(/^\/v1\/teams\/([^/]+)$/);
    if (teamMatch) {
      const teamId = decodeURIComponent(teamMatch[1]);
      if (req.method === "GET") { const team = teams.get(teamId, url.searchParams.get("includeRetired") === "1"); return team ? json(res, 200, team) : json(res, 404, { error: "Team not found." }); }
      if (req.method === "PUT") return json(res, 200, teams.update(teamId, await body(req)));
      if (req.method === "DELETE") return json(res, 200, teams.retire(teamId));
    }
    if (req.method === "POST" && url.pathname === "/v1/workspace/model/import") {
      const input = await body(req);
      return json(res, 200, profiles.defaults().revision ? profiles.defaults() : profiles.setDefaults(input.model, 0));
    }
    if (url.pathname === "/v1/workspace/model") {
      if (req.method === "GET") return json(res, 200, profiles.defaults());
      if (req.method === "PUT") { const input = await body(req); return json(res, 200, profiles.setDefaults(input.model, input.revision)); }
    }
    const profileMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/(profile|credential|tools|models|connection-check|connector-check)$/);
    if (profileMatch) {
      const id = validId(decodeURIComponent(profileMatch[1])), action = profileMatch[2];
      const profile = profiles.get(id);
      if (action === 'profile' && req.method === 'PUT') {
        const input = await body(req); if (input.id !== id) throw new ProfileError('Profile ID does not match the selected agent.');
        const current = profiles.get(id), desired = validateProfile(input); if (machines.transferring(id)) throw new MachineError('This agent is already transferring. Wait for it to finish before editing its computer.', 409); machines.canAssign(desired.computer.machineId, id);
        const moving = Boolean(current && current.computer.machineId !== desired.computer.machineId), saved = profiles.save(moving ? { ...desired, computer: current!.computer } : desired); ensureProfileDirs(id);
        if (moving) { const pending = { ...desired, revision: saved.revision }; machines.reserve(desired.computer.machineId, id, desired.computer.reserveMachine); void performTransfer(machines.transfer(id, current!.computer.machineId, desired.computer.machineId, pending)); }
        else machines.reserve(saved.computer.machineId, id, saved.computer.reserveMachine);
        return json(res, 200, profileResponse(saved));
      }
      if (!profile) return json(res, 404, { error: 'Agent profile not found.' });
      if (action === 'credential' && req.method === 'PUT') {
        const input = await body(req);
        if (input.inherit) return json(res, 200, profileResponse(profiles.save({ ...profile, model: { ...profile.model, inherit: true } })));
        const ref = String(input.ref || '');
        if (ref && !credentials.has(ref)) throw new CredentialError('That credential no longer exists.', 404);
        return json(res, 200, profileResponse(profiles.save({ ...profile, model: { ...profiles.effective(profile), inherit: false, credentialRef: ref } })));
      }
      if (action === 'profile' && req.method === 'GET') return json(res, 200, profileResponse(profile));
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
        try { return json(res, 200, profile.computer.machineId === 'local' ? await runtimeProbe(ensureContainer(id, root, profile.computer), { action: 'connection', baseUrl, apiKey: secrets.environment()[model.credentialRef] || '' }) : await runnerProbe(profile, 'probe-runtime', { action: 'connection', baseUrl, apiKey: secrets.environment()[model.credentialRef] || '' })); }
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
          const result = process.env.OPEN_HARNESS_MOCK === '1' ? { status: 'connected', tools: [{ name: 'lookup', description: 'Mock connected tool' }] } : profile.computer.machineId === 'local' ? await runtimeProbe(ensureContainer(id, root, profile.computer), { action: 'mcp', command: tested.command, args: tested.args, env: tested.secretRef ? { [tested.secretRef]: secrets.environment()[tested.secretRef] } : {} }) : await runnerProbe(profile, 'probe-runtime', { action: 'mcp', command: tested.command, args: tested.args, env: tested.secretRef ? { [tested.secretRef]: secrets.environment()[tested.secretRef] } : {} });
          const tools = (result.tools as Array<{ name: string; description: string }>).map(t => ({ id: `mcp_${tested.name}_${t.name}`, name: t.name, description: t.description, group: 'mcp', available: true }));
          const prior = store.db.prepare('SELECT json FROM tool_catalogs WHERE agent_id=?').get(id) as { json: string } | undefined;
          const catalog: ToolCatalog = prior ? JSON.parse(prior.json) : { source: 'runtime', tools: [] };
          catalog.tools = [...catalog.tools.filter(t => !t.id.startsWith(`mcp_${tested.name}_`)), ...tools];
          store.db.prepare('INSERT INTO tool_catalogs VALUES(?,?) ON CONFLICT(agent_id) DO UPDATE SET json=excluded.json').run(id, JSON.stringify(catalog));
          return json(res, 200, { ...result, tools });
        } catch { return json(res, 200, { status: 'failed', error: 'MCP initialize/tools-list handshake failed. Check the executable, arguments, and credentials.', tools: [] }); }
      }
    }
    const skillMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/context\/skills\/([^/]+)$/);
    if (skillMatch) {
      const safe = validId(skillMatch[1]);
      const skill = decodeURIComponent(skillMatch[2]);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(skill)) return json(res, 400, { error: "Invalid skill name." });
      const skillDir = join(root, "agents", safe, "profile", "skills", skill), skillFile = join(skillDir, "SKILL.md");
      if (req.method === "GET") { if (!existsSync(skillFile)) return json(res, 404, { error: "Skill not found." }); return json(res, 200, { name: skill, content: readFileSync(skillFile, "utf8") }); }
      if (req.method === "PUT") { const input = await body(req); mkdirSync(skillDir, { recursive: true }); writeFileSync(skillFile, String(input.content || ""), { mode: 0o600 }); return json(res, 200, { ok: true }); }
      if (req.method === "DELETE") { if (existsSync(skillDir)) rmSync(skillDir, { recursive: true }); return json(res, 200, { ok: true }); }
    }
    const contextMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/context$/);
    if (contextMatch) {
      const safe = validId(contextMatch[1]), profile = join(root, "agents", safe, "profile"), memoryPath = join(profile, "MEMORY.md"), userPath = join(profile, "USER.md"), skillsPath = join(profile, "skills"); mkdirSync(profile, { recursive: true });
      if (req.method === "PUT") { const input = await body(req); if (String(input.memory || "").length > 50_000) return json(res, 413, { error: "Memory is limited to 50 KB." }); writeFileSync(memoryPath, String(input.memory || ""), { mode: 0o600 }); return json(res, 200, { ok: true }); }
      if (req.method === "GET") { const skills = existsSync(skillsPath) ? readdirSync(skillsPath, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).slice(0, 200) : [], available = (await dockerStatusCached()).available; return json(res, 200, { memory: existsSync(memoryPath) ? readFileSync(memoryPath, "utf8") : "", user: existsSync(userPath) ? readFileSync(userPath, "utf8") : "", skills, capabilities: { terminal: available, process: available, code: available, files: available, web: available, browser: available, memory: available, skills: available, mcp: available, delegation: available, schedules: true } }); }
    }
    if (req.method === "POST" && url.pathname === "/v1/migrate") {
      const input = await body(req); const found = store.db.prepare("SELECT 1 FROM migrations WHERE key='browser-v1'").get();
      if (found) return json(res, 200, { migrated: false, reason: "already_migrated" });
      store.db.prepare("INSERT INTO migrations(key,payload_json,created_at) VALUES(?,?,?)").run("browser-v1", JSON.stringify(input), new Date().toISOString());
      for (const agent of input.agents || []) {
        profiles.import(agent);
        const safe = validId(String(agent.id)), profile = join(root, "agents", safe, "profile");
        mkdirSync(profile, { recursive: true });
        if (Array.isArray(agent.memory) && agent.memory.length) writeFileSync(join(profile, "MEMORY.md"), agent.memory.map((item: unknown) => `- ${String(item)}`).join("\n") + "\n", { mode: 0o600 });
      }
      for (const conversation of input.conversations || []) store.db.prepare("INSERT OR IGNORE INTO conversations(id,agent_id,title,legacy_json,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(conversation.id, conversation.agentId, conversation.title, JSON.stringify(conversation), conversation.updatedAt || new Date().toISOString(), conversation.updatedAt || new Date().toISOString());
      for (const file of input.files || []) { const target = join(root, "shared", String(file.name).replace(/[^a-zA-Z0-9._ -]/g, "_")); writeFileSync(target, String(file.content).slice(0, 1_000_000)); }
      writeFileSync(join(root, "browser-v1-backup.json"), JSON.stringify(input, null, 2), { mode: 0o600 });
      return json(res, 200, { migrated: true });
    }
    if (url.pathname === "/v1/boards") {
      if (req.method === "GET") return json(res, 200, { boards: tasks.listBoards(url.searchParams.get("includeArchived") === "1"), summaries: tasks.boardSummaries() });
      if (req.method === "POST") return json(res, 201, tasks.createBoard(await body(req)));
    }
    // Ahead of boardMatch: its ([^/]+) would otherwise read "reorder" as a board id.
    if (url.pathname === "/v1/boards/reorder" && req.method === "POST") return json(res, 200, { boards: tasks.reorderBoards((await body(req)).ids), summaries: tasks.boardSummaries() });
    const boardMatch = url.pathname.match(/^\/v1\/boards\/([^/]+)(?:\/(stages|duplicate))?$/);
    if (boardMatch) {
      const boardId = decodeURIComponent(boardMatch[1]);
      if (!boardMatch[2] && req.method === "GET") return json(res, 200, tasks.getBoard(boardId));
      if (!boardMatch[2] && req.method === "PUT") return json(res, 200, tasks.updateBoard(boardId, await body(req)));
      if (!boardMatch[2] && req.method === "DELETE") return json(res, 200, tasks.deleteBoard(boardId));
      if (boardMatch[2] === "stages" && req.method === "POST") return json(res, 201, tasks.addStage(boardId, await body(req)));
      if (boardMatch[2] === "duplicate" && req.method === "POST") return json(res, 201, tasks.duplicateBoard(boardId, await body(req)));
    }
    const stageMatch = url.pathname.match(/^\/v1\/stages\/([^/]+)$/);
    if (stageMatch) {
      if (req.method === "PUT") return json(res, 200, tasks.updateStage(decodeURIComponent(stageMatch[1]), await body(req)));
      if (req.method === "DELETE") return json(res, 200, tasks.removeStage(decodeURIComponent(stageMatch[1]), url.searchParams.get("moveToStageId") || undefined));
    }
    if (url.pathname === "/v1/tasks") {
      if (req.method === "GET") return json(res, 200, { boards: tasks.listBoards(url.searchParams.get("includeArchived") === "1"), tasks: tasks.listTasks(url.searchParams.get("includeArchived") === "1"), summaries: tasks.boardSummaries() });
      if (req.method === "POST") return json(res, 201, tasks.createTask(validTaskMutation(await body(req))));
    }
    const taskMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)(?:\/(comments|start|request-changes|approve|runs|move|stop|check|additem))?$/);
    if (taskMatch) {
      const taskId = decodeURIComponent(taskMatch[1]), action = taskMatch[2];
      if (!action && req.method === "GET") return json(res, 200, tasks.getTask(taskId));
      if (!action && req.method === "PUT") { const current = tasks.getTask(taskId); return json(res, 200, tasks.updateTask(taskId, validTaskMutation(await body(req), current))); }
      if (!action && req.method === "DELETE") { const task = tasks.getTask(taskId); if (task.activeRunId) return json(res, 409, { error: 'Stop the active run before deleting this task.' }); store.db.prepare("DELETE FROM tasks WHERE id=?").run(taskId); return json(res, 200, { ok: true }); }
      if (action === "comments" && req.method === "POST") return json(res, 201, tasks.comment(taskId, { ...await body(req), author: 'you' }));
      if (action === "move" && req.method === "POST") { const current = tasks.getTask(taskId), input = await body(req); validTaskMutation(input, current); return json(res, 200, tasks.move(taskId, input)); }
      if (action === "check" && req.method === "POST") { const input = await body(req); return json(res, 200, tasks.check(taskId, String(input.item || ''), input.done === undefined ? undefined : Boolean(input.done))); }
      if (action === "additem" && req.method === "POST") { const input = await body(req); return json(res, 201, tasks.addItem(taskId, String(input.text || ''))); }
      if ((action === "start" || action === "request-changes") && req.method === "POST") { const started = tasks.start(taskId, await body(req), input => createRun({ ...input, deferStart: true })); void pump(); return json(res, 202, started); }
      if (action === "stop" && req.method === "POST") { const task = tasks.getTask(taskId); if (!task.activeRunId) return json(res, 409, { error: 'This task is not running.' }); const result = await stopRunTree(task.activeRunId); return json(res, 200, { ok: true, stopped: result.stopped, ...(result.failures.length ? { failures: result.failures } : {}) }); }
      if (action === "approve" && req.method === "POST") { const input = await body(req); return json(res, 200, tasks.approve(taskId, input.revision === undefined ? undefined : Number(input.revision))); }
      if (action === "runs" && req.method === "GET") return json(res, 200, { runs: tasks.getTask(taskId).runs });
    }
    if (req.method === "POST" && url.pathname === "/v1/runs") return json(res, 202, runResponse(createRun(await body(req))));
    if (req.method === "GET" && url.pathname === "/v1/runs") return json(res, 200, { runs: store.listRuns().map(runResponse) });
    const runMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)(?:\/(events|steer|stop|approval))?$/);
    if (runMatch) {
      const run = store.getRun(runMatch[1]); if (!run) return json(res, 404, { error: "Run not found." }); const action = runMatch[2];
      if (!action && req.method === "GET") return json(res, 200, runResponse(run));
      if (action === "events" && req.method === "GET") return json(res, 200, { events: store.events(run.id, Number(url.searchParams.get("after") || 0)), run: runResponse(store.getRun(run.id)!) });
      if (action === "steer" && req.method === "POST") { const input = await body(req), live = active.get(run.id), remote = remoteActive.get(run.id); if (!live && !remote) return json(res, 409, { error: "Run is not active." }); if (live) await live.gateway.request("session.steer", { session_id: live.sessionId, text: String(input.text || "") }); else machines.enqueue(remote!.machineId, run.agent_id, 'steer', { runId: run.id, commandId: remote!.commandId, text: String(input.text || '') }); event(run.id, "run.steered", { text: input.text }); return json(res, 200, { ok: true }); }
      if (action === "stop" && req.method === "POST") { const result = await stopRunTree(run.id); return json(res, 200, { ok: true, stopped: result.stopped, ...(result.failures.length ? { failures: result.failures } : {}) }); }
      if (action === "approval" && req.method === "POST") { const input = await body(req), approval = store.approval(String(input.approvalId)); if (!approval || approval.run_id !== run.id) return json(res, 404, { error: "Approval not found." }); const live = active.get(run.id), remote = remoteActive.get(run.id); if (!live && !remote) return json(res, 409, { error: "Run is not active." }); const granted = hermesApprovalDecision(String(input.decision || "")), decision = granted === "deny" ? "deny" : "approve"; if (live) await live.gateway.request("approval.respond", { session_id: live.sessionId, request_id: approval.gateway_request_id, choice: granted, all: false }); else machines.enqueue(remote!.machineId, run.agent_id, 'approval', { runId: run.id, commandId: remote!.commandId, requestId: approval.gateway_request_id, decision: granted }); store.resolveApproval(String(input.approvalId), decision); store.setRun(run.id, { state: "running" }); event(run.id, "approval.resolved", { approvalId: input.approvalId, decision }); return json(res, 200, { ok: true }); }
    }
    if (req.method === "POST" && url.pathname === "/v1/runs/stop-all") { let stopped = 0; const failures: string[] = []; for (const run of store.listRuns().filter(item => !item.parent_run_id && ["queued","running","waiting_approval","waiting_input"].includes(item.state))) { const result = await stopRunTree(run.id); stopped += result.stopped; failures.push(...result.failures); } return json(res, 200, { stopped, ...(failures.length ? { failures } : {}) }); }
    if (url.pathname === "/v1/credentials") {
      if (req.method === "GET") return json(res, 200, { credentials: credentialRecords(), backend: credentials.backend });
      if (req.method === "POST") { const input = await body(req); return json(res, 201, credentialRecord(credentials.create(input))); }
    }
    const credentialMatch = url.pathname.match(/^\/v1\/credentials\/([^/]+)(?:\/(value))?$/);
    if (credentialMatch) {
      const ref = decodeURIComponent(credentialMatch[1]), action = credentialMatch[2];
      if (action === "value" && req.method === "POST") { const input = await body(req); return json(res, 200, credentialRecord(credentials.rotate(ref, input.value))); }
      if (action) return json(res, 405, { error: "Unsupported credential action." });
      if (req.method === "GET") return json(res, 200, credentialRecord(credentials.row(ref)));
      if (req.method === "PUT") { const input = await body(req); return json(res, 200, credentialRecord(credentials.relabel(ref, input))); }
      if (req.method === "DELETE") {
        const usage = credentialUses(credentials.row(ref).ref), reassignTo = url.searchParams.get("reassignTo") || "";
        if (reassignTo) { if (reassignTo === ref || !credentials.has(reassignTo)) return json(res, 400, { error: "Choose a different saved credential to move these to." }); const reassigned = reassignCredential(ref, reassignTo); credentials.remove(ref); return json(res, 200, { ok: true, reassigned }); }
        // Refuse by default rather than silently breaking agents; the client re-sends with
        // force=1 once it has shown the operator exactly what references this.
        if (usage.uses.length && url.searchParams.get("force") !== "1") return json(res, 409, { error: "This credential is still in use.", usage });
        credentials.remove(ref); return json(res, 200, { ok: true, reassigned: [] });
      }
    }
    if (req.method === "POST" && url.pathname === "/v1/secrets") {
      const input = await body(req), name = String(input.name);
      const row = credentials.has(name) ? credentials.rotate(name, input.value) : credentials.create({ ref: name, value: input.value });
      return json(res, 200, { ok: true, name: row.ref });
    }
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
    if (req.method === "POST" && url.pathname === "/internal/handoff") { const input = await body(req); const parent = store.listRuns().find(run => run.agent_id === internalAgent && ["running","waiting_approval","waiting_input"].includes(run.state)); if (!parent) return json(res, 409, { error: "The delegating agent has no active run." }); if (!internalAllowed(internalAgent, HANDOFF_TOOL, String(req.headers["x-open-harness-run"] || parent.id))) return json(res, 403, { error: "Delegation is disabled for this run." }); const targetId = String(input.agentId || ""); if (!internalAgent || !teams.sharesActiveTeam(internalAgent, targetId)) return json(res, 403, { error: "Named handoffs require both agents to share an active team." }); const child = createRun({ agentId: targetId, prompt: input.prompt, parentRunId: parent.id }); event(parent.id, "handoff.created", { childRunId: child.id, targetAgentId: targetId, prompt: input.prompt }); const result = await waitForRun(child.id); event(parent.id, "handoff.completed", { childRunId: child.id, targetAgentId: targetId, state: result.state }); return json(res, 200, { runId: result.id, state: result.state, result: result.result, error: result.error }); }
    if (req.method === "POST" && url.pathname === "/internal/task") {
      const input = await body(req), runId = String(req.headers['x-open-harness-run'] || '');
      if (!internalAllowed(internalAgent, TASK_TOOL, runId)) return json(res, 403, { error: 'Task board access is disabled for this run.' });
      const profile = profiles.get(internalAgent!); if (!profile) return json(res, 403, { error: 'Agent profile not found.' });
      // The schema nests an action's fields under `input`, and nothing else says so, so a model
      // that puts stageId or text alongside `action` is guessing reasonably -- and used to get
      // "Stage is required." with no hint about where the field belonged. Both spellings work;
      // `input` wins where they disagree.
      const action = String(input.action || ''), taskId = String(input.taskId || '');
      // A model may also send `input` as a JSON string. Spreading a string yields one key per
      // character and loses every field, so parse it rather than quietly producing nonsense.
      const nested = typeof input.input === 'string' ? (() => { try { const value = JSON.parse(input.input); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; } })() : (input.input && typeof input.input === 'object' && !Array.isArray(input.input) ? input.input : {});
      const patch = { ...Object.fromEntries(Object.entries(input).filter(([key]) => !['action', 'taskId', 'input'].includes(key))), ...nested } as Record<string, unknown>;
      const mayTouch = (task: ReturnType<typeof tasks.getTask>) => agentMayTouchTask(internalAgent!, profile.board.assignOthers, task);
      if (action === 'list') return json(res, 200, { boards: tasks.listBoards(), tasks: tasks.listTasks().filter(mayTouch) });
      if (action === 'columns') return json(res, 200, { boards: tasks.listBoards() });
      if (action === 'create') {
        const candidate = { ...patch, boardId: patch.boardId || input.boardId, ownerAgentId: patch.ownerAgentId === undefined ? internalAgent : patch.ownerAgentId };
        if (candidate.ownerAgentId !== internalAgent && !profile.board.assignOthers) return json(res, 403, { error: 'Assigning another agent requires Board: assign others.' });
        return json(res, 201, tasks.createTask(validTaskMutation(candidate)));
      }
      if (action === 'board_create' || action === 'board_update') {
        if (!profile.board.manageProjects) return json(res, 403, { error: 'Creating or changing projects requires Board: manage projects.' });
        // An allowlist, not a denylist: an agent may shape a project's identity and nothing
        // else, so it can never re-enable dispatch or unarchive a project a person closed.
        const safe = Object.fromEntries(['name', 'description', 'color', 'defaultOwnerAgentId'].filter(key => key in patch).map(key => [key, patch[key]]));
        if (action === 'board_create') return json(res, 201, tasks.createBoard(safe));
        const boardId = String(patch.boardId || input.boardId || '');
        return json(res, 200, tasks.updateBoard(boardId, { ...safe, revision: tasks.getBoard(boardId).revision }));
      }
      const task = tasks.getTask(taskId); if (!mayTouch(task)) return json(res, 403, { error: 'Changing another agent’s card requires Board: assign others.' });
      if (action === 'get') return json(res, 200, task);
      if (action === 'update') {
        if (patch.ownerAgentId !== undefined && patch.ownerAgentId !== internalAgent && patch.ownerAgentId !== task.ownerAgentId && !profile.board.assignOthers) return json(res, 403, { error: 'Assigning another agent requires Board: assign others.' });
        return json(res, 200, tasks.updateTask(taskId, validTaskMutation({ ...patch, revision: task.revision }, task)));
      }
      if (action === 'move') { validTaskMutation(patch, task); return json(res, 200, tasks.move(taskId, patch)); }
      if (action === 'comment') return json(res, 201, tasks.comment(taskId, { body: patch.text || patch.body, author: profile.name }));
      if (action === 'check') return json(res, 200, tasks.check(taskId, String(patch.item || ''), patch.done === undefined ? undefined : Boolean(patch.done)));
      if (action === 'additem') return json(res, 201, tasks.addItem(taskId, String(patch.text || '')));
      if (action === 'claim') return json(res, 200, tasks.updateTask(taskId, validTaskMutation({ revision: task.revision, ownerAgentId: internalAgent }, task)));
      if (action === 'release') { tasks.updateTask(taskId, validTaskMutation({ revision: task.revision, ownerAgentId: null }, task)); return json(res, 200, tasks.comment(taskId, { body: String(patch.reason || 'Released as blocked.'), author: profile.name })); }
      if (action === 'run') { if (task.ownerAgentId && task.ownerAgentId !== internalAgent && !profile.board.dispatch) return json(res, 403, { error: 'Starting another agent’s task requires Board: dispatch.' }); const board = tasks.getBoard(task.boardId); if (!board.settings.allowAgentDispatch) return json(res, 403, { error: 'Agent task dispatch is disabled for this board.' }); const started = tasks.start(taskId, { revision: task.revision, idempotencyKey: crypto.randomUUID() }, value => createRun({ ...value, deferStart: true })); void pump(); return json(res, 202, started); }
      return json(res, 400, { error: 'Unknown task action.' });
    }
    if (req.method === "POST" && url.pathname === "/internal/schedule") { if (!internalAllowed(internalAgent, ROUTINE_TOOL, String(req.headers["x-open-harness-run"] || ""))) return json(res, 403, { error: "Scheduling is disabled for this run." }); const input = await body(req), stamp = new Date(), id = crypto.randomUUID(), minutes = Math.max(1, Number(input.intervalMinutes || 60)), next = new Date(stamp.getTime() + minutes * 60000).toISOString(); store.db.prepare("INSERT INTO schedules(id,agent_id,name,prompt,interval_minutes,timezone,enabled,next_run_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, internalAgent, input.name, input.prompt, minutes, input.timezone || "UTC", 1, next, stamp.toISOString(), stamp.toISOString()); return json(res, 201, { id, nextRunAt: next }); }
    return json(res, 404, { error: "Not found." });
  } catch (error) { return json(res, error instanceof ProfileError || error instanceof TaskError || error instanceof TeamError || error instanceof MachineError || error instanceof CredentialError ? error.status : 400, { error: error instanceof Error ? error.message : "Request failed." }); }
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
server.listen(port, bind, () => console.log(`Open Harness coordinator listening on http://${bind}:${port}`));
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
let shuttingDown = false;
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
  // Gateways stop the containers they own. Anything else this coordinator started, including
  // containers created by a settings probe, is stopped here so it does not come back.
  try { const reaped = stopManagedContainers(); if (reaped.length) console.log(`Stopped ${reaped.length} agent container${reaped.length === 1 ? '' : 's'}.`); }
  catch (error) { console.error(`Some agent containers may still be running: ${error instanceof Error ? error.message : 'unknown error'}`); }
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
