/* eslint-disable @typescript-eslint/no-explicit-any */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir, hostname, platform, arch } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { HermesGateway, ensureContainerAsync, hermesApprovalDecision, stopAgentContainers, stopManagedContainers } from './hermes';
import { closeContainerAdmissions } from './container-admission';
import { readRunnerResponse } from './runner-response';
import { HERMES_IMAGE, RUNTIME_LABEL, classifyContract } from './readiness';
import { discoverModels, prepareProfile, runtimeProbe, runtimeToolCatalog, writeRunLease } from './profile-runtime';
import type { AgentProfile, MachineInfo } from '../lib/agent-profile';
import { runToolGrants } from '../lib/agent-profile';
import { exportAgentTransfer, importAgentTransfer } from './transfer-files';
import { openAgentTransfer, sealAgentTransfer, type TransferBinding } from './transfer-crypto';
import { SecretStore } from './secrets';
import { decryptRunnerSecret, generateRunnerKeyPair, type EncryptedRunnerSecret } from '../lib/runner-crypto';
import { assertSandboxedComputer, validateComputerTarget } from './computer-validation';
import { agentContext } from './agent-context';
import { testModelConnection } from './model-validation';
import { executeDesktopCommand, type DesktopCommand } from './desktop-control';
import { admitRunnerTerminal, closeRunnerDuplex, executeRunnerDuplex, type DuplexCommand } from './runner-duplex';
import { assertComputerOwnership, type ComputerOwnership } from './computer-ownership';
import { ensureDesktopContainerAsync } from './computer-runtime';

type Credentials = { coordinator: string; machineId: string; token: string; encryptionPublicKey: string; encryptionPrivateKey: string };
type RunnerCommand = { id: string; agentId: string; kind: 'run' | 'stop' | 'steer' | 'approval' | 'input' | 'agent-context' | 'export-agent' | 'import-agent' | 'probe-tools' | 'probe-runtime' | 'probe-models' | 'store-secret' | 'desktop' | 'duplex'; payload: any };
const args = new Map<string,string>();
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[i + 1]?.startsWith('--') ? '' : process.argv[++i] || '');
const stateRoot = resolve(process.env.OPEN_HARNESS_RUNNER_STATE_DIR || join(homedir(), '.open-harness-runner'));
const credentialPath = join(stateRoot, 'connection.json');
const spool = join(stateRoot, 'spool'); mkdirSync(spool, { recursive: true });
let runnerSecrets: SecretStore;
try { runnerSecrets = new SecretStore(join(stateRoot, 'secrets.json')); }
catch (error) { console.error(error instanceof Error ? error.message : 'The runner could not open its credential store.'); process.exit(1); }

type Capabilities = MachineInfo['capabilities'];
// Bounded asynchronous probes keep heartbeats responsive even when Docker hangs.
function output(command: string, args: string[], timeout: number) {
  return new Promise<{ status: number | null; stdout: string }>(resolve => {
    let done = false, stdout = ''; const settle = (status: number | null) => { if (!done) { done = true; resolve({ status, stdout }); } };
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], timeout, killSignal: 'SIGKILL' });
    child.stdout.on('data', chunk => stdout += chunk); child.on('error', () => settle(null)); child.on('exit', code => settle(code));
  });
}
async function probeCapabilities(): Promise<Capabilities> {
  const container = process.env.OPEN_HARNESS_MOCK === '1' || classifyContract(await output('docker', ['image', 'inspect', '-f', `{{index .Config.Labels "${RUNTIME_LABEL}"}}`, HERMES_IMAGE], 5_000)) === 'current';
  return { container, direct: false, desktop: false, virtualDesktop: process.platform === 'linux' && container, detail: container ? 'Private agent workspaces are ready. Desktop control uses an isolated agent desktop.' : 'Install Docker and prepare the pinned runtime to enable sandboxed agents.' };
}
// Heartbeats send the last known value and refresh in the background; only pairing and
// import-agent validation wait for a fresh probe.
let known: Capabilities | null = null, probing: Promise<Capabilities> | null = null;
function capabilities() { return probing ??= probeCapabilities().then(value => (known = {...value,protocol:1,features:['workspace-tools','run-leases','scoped-tool-review','async-admission','desktop-preview','computer-duplex','computer-ownership','execution-quiescence','continuous-computer','terminal-pty','browser-state-transfer','sealed-agent-transfer']})).finally(() => { probing = null; }); }
async function pair(): Promise<Credentials> {
  const coordinator = String(args.get('coordinator') || '').replace(/\/$/, ''), code = String(args.get('pairing-code') || '');
  if (!coordinator || !code) throw new Error('Use --coordinator URL and --pairing-code CODE, or keep an existing runner connection.');
  const target = new URL(coordinator), loopback = ['localhost', '127.0.0.1', '::1'].includes(target.hostname); if (target.protocol !== 'https:' && !(target.protocol === 'http:' && loopback)) throw new Error('Remote coordinators must use HTTPS. Plain HTTP is accepted only for a coordinator on this computer.');
  const encryption = await generateRunnerKeyPair();
  const response = await fetch(`${coordinator}/v1/runner/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: hostname(), platform: platform(), arch: arch(), capabilities: await capabilities(), encryptionPublicKey: encryption.publicKey }) });
  const value = await response.json() as any; if (!response.ok) throw new Error(value.error || 'Pairing failed.');
  const saved: Credentials = { coordinator, machineId: value.machineId, token: value.token, encryptionPublicKey: encryption.publicKey, encryptionPrivateKey: encryption.privateKey };
  writeFileSync(credentialPath, JSON.stringify(saved, null, 2), { mode: 0o600 }); chmodSync(credentialPath, 0o600); return saved;
}
let credentials = args.has('pairing-code') ? await pair() : existsSync(credentialPath) ? JSON.parse(readFileSync(credentialPath, 'utf8')) as Credentials : await pair();
if (!credentials.encryptionPrivateKey || !credentials.encryptionPublicKey) { const encryption = await generateRunnerKeyPair(); credentials = { ...credentials, encryptionPublicKey: encryption.publicKey, encryptionPrivateKey: encryption.privateKey }; writeFileSync(credentialPath, JSON.stringify(credentials, null, 2), { mode: 0o600 }); chmodSync(credentialPath, 0o600); }
const savedTarget = new URL(credentials.coordinator), savedLoopback = ['localhost', '127.0.0.1', '::1'].includes(savedTarget.hostname); if (savedTarget.protocol !== 'https:' && !(savedTarget.protocol === 'http:' && savedLoopback)) throw new Error('The saved remote coordinator URL is not HTTPS. Pair this runner again using a secure URL.');
if (args.has('once')) { console.log(`Paired ${credentials.machineId}.`); process.exit(0); }
const headers = { Authorization: `Bearer ${credentials.token}`, 'X-Open-Harness-Machine': credentials.machineId, 'Content-Type': 'application/json' };
async function request(path: string, init: RequestInit = {}, retry = false): Promise<any> {
  for (;;) {
    try { const response = await fetch(credentials.coordinator + path, { ...init, signal: init.signal || AbortSignal.timeout(35_000), headers: { ...headers, ...init.headers } }); const value = await readRunnerResponse(response) as any; if (!response.ok) throw new Error(value.error || `Coordinator returned HTTP ${response.status}.`); return value; }
    catch (error) { if (!retry) throw error; await new Promise(resolve => setTimeout(resolve, 2000)); }
  }
}

const active = new Map<string, { gateway: HermesGateway; sessionId: string | null; commandId: string; stopping: boolean; agentId: string }>();
const admittedCommands = new Set<string>();
const agentOperations = new Map<string, Promise<void>>();
const browserOperations = new Map<string, Promise<void>>();
const blockedBrowserGroups = new Map<string, string>();
const blockedAgents = new Set<string>();
const terminalAdmissionEpochs = new Map<string, number>();
const admittedRuns = new Map<string, { cancelled: boolean; agentId: string }>();
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  const admissions = closeContainerAdmissions(stateRoot); closeRunnerDuplex(stateRoot);
  for (const admission of admittedRuns.values()) admission.cancelled = true;
  console.log(`Open Harness runner stopping on ${signal}.`);
  const deadline = setTimeout(() => { console.error('Runner cleanup timed out; some computers may still be running.'); process.exit(1); }, 120000); deadline.unref();
  await admissions;
  const stopped = await Promise.allSettled([...active.values()].map(live => { live.stopping = true; writeRunLease(stateRoot, live.agentId, null); return live.gateway.stop(); }));
  let failed = stopped.some(result => result.status === 'rejected');
  try { const result = await stopManagedContainers(stateRoot); if (result.failures.length) { failed = true; console.error(result.failures.join('\n')); } }
  catch { failed = true; console.error('Runner computer cleanup could not be confirmed.'); }
  clearTimeout(deadline); process.exit(failed ? 1 : 0);
}
for (const signal of ['SIGTERM','SIGINT','SIGHUP'] as const) process.on(signal, () => void shutdown(signal));
type SpoolRecord = { id: string; path: string; body: unknown };
async function deliver(record: SpoolRecord) { const file = join(spool, `${record.id}.json`); if (!existsSync(file)) writeFileSync(file, JSON.stringify(record), { mode: 0o600 }); await request(record.path, { method: 'POST', body: JSON.stringify(record.body) }, true); if (existsSync(file)) unlinkSync(file); }
async function flushSpool() { for (const name of readdirSync(spool).filter(name => name.endsWith('.json'))) { try { await deliver(JSON.parse(readFileSync(join(spool, name), 'utf8'))); } catch {} } }
async function emit(command: RunnerCommand, event: any) { const eventId = crypto.randomUUID(); await deliver({ id: eventId, path: `/v1/runner/commands/${command.id}/events`, body: { eventId, runId: command.payload.runId, event } }); }
async function finish(command: RunnerCommand, result?: unknown, error?: unknown) { await deliver({ id: `complete-${command.id}`, path: `/v1/runner/commands/${command.id}/complete`, body: error ? { error: error instanceof Error ? error.message : String(error) } : { result } }); }

// Credentials arrive sealed to this runner's key and are held only for the life of the
// command: they go into the agent's profile .env and are never written to runner state.
async function openDispatchedSecrets(sealed?: Record<string, EncryptedRunnerSecret>) {
  if (!sealed) return {};
  const opened = await Promise.all(Object.entries(sealed).map(async ([name, payload]) => [name, await decryptRunnerSecret(credentials.encryptionPrivateKey, payload)] as const));
  return Object.fromEntries(opened);
}

async function run(command: RunnerCommand) {
  const payload = command.payload as { runId: string; prompt: string; history?: Array<{ role: 'user' | 'assistant'; content: string }>; snapshot: AgentProfile & { effectiveModel: any }; encryptedSecrets?: Record<string, EncryptedRunnerSecret>; coordinationToken: string;reviewUnclassified?:boolean;ownership?:ComputerOwnership };
  const profile = payload.snapshot;
  let gateway: HermesGateway | undefined, result: unknown, failure: unknown;
  const admittedAt=performance.now(),phase=(name:string)=>emit(command,{type:'run.phase',payload:{phase:name,runnerElapsedMs:Math.round(performance.now()-admittedAt)}});
  try {
    assertSandboxedComputer(profile.computer);
    const assertOwnership = () => { if (profile.computer.desktop === 'virtual') { if (!payload.ownership || payload.ownership.owner !== 'agent') throw new Error('The agent computer ownership is missing. Update the coordinator.'); assertComputerOwnership(stateRoot, profile, payload.ownership); } };
    assertOwnership();
    const shared = join(stateRoot, 'shared'); mkdirSync(shared, { recursive: true });
    const needed = [profile.effectiveModel.credentialRef, ...profile.connectors.filter(item => item.enabled).map(item => item.secretRef)].filter(Boolean);
    const availableSecrets = { ...runnerSecrets.environment(), ...process.env } as Record<string,string>;
    const localSecrets = Object.fromEntries(needed.filter(name => availableSecrets[name]).map(name => [name, availableSecrets[name]]));
    const dispatched = await openDispatchedSecrets(payload.encryptedSecrets);
    if (admittedRuns.get(payload.runId)?.cancelled) throw new Error('Run stopped before its runtime started.');
    const ephemeralSecrets = { environment: () => ({ ...localSecrets, ...dispatched }) };
    const coordinatorForContainer = credentials.coordinator.replace('://localhost', '://host.docker.internal').replace('://127.0.0.1', '://host.docker.internal');
    prepareProfile(stateRoot, profile, profile.effectiveModel, ephemeralSecrets, payload.coordinationToken, payload.runId, { controlUrl: coordinatorForContainer,reviewUnclassified:payload.reviewUnclassified });
    await phase('profile-ready');
    const container = await ensureContainerAsync(profile.id, stateRoot, profile.computer);
    assertOwnership();
    if (admittedRuns.get(payload.runId)?.cancelled || blockedAgents.has(profile.id)) throw new Error('Run stopped before its runtime started.');
    gateway = new HermesGateway(container, runToolGrants(profile));
    const live = { gateway, sessionId: null as string | null, commandId: command.id, stopping: false, agentId: profile.id };
    active.set(payload.runId, live);
    gateway.on('event', event => void emit(command, event)); await gateway.start();await phase('gateway-ready');
    if (live.stopping) throw new Error('Run stopped before its session started.');
    const session = await gateway.request('session.create', { cwd: '/workspace/shared', profile: 'default', messages: payload.history || [] });
    const sessionId = String(session?.session_id || session?.id || ''); if (!sessionId) throw new Error('Hermes did not return a session ID.');
    live.sessionId = sessionId;
    await emit(command, { type: 'session.started', session_id: sessionId, payload: { session_id: sessionId } });
    if (live.stopping) throw new Error('Run stopped before its prompt started.');
    assertOwnership();
    await phase('prompt-dispatched');result = await gateway.submitPrompt(sessionId, payload.prompt);await phase('execution-finished');
  } catch (error) { failure = error; }
  try {
    await gateway?.stop();
    active.delete(payload.runId);await phase('cleanup-finished');
  } catch (error) {
    blockedAgents.add(profile.id);
    failure = new Error(`Agent cleanup could not be confirmed. Further work is blocked until it is stopped: ${error instanceof Error ? error.message : error}`);
  }
  await finish(command, result, failure);
}
function transferBinding(command: RunnerCommand): TransferBinding { return { transferId: String(command.payload.transferId || ''), agentId: command.agentId, sourceMachineId: String(command.payload.sourceMachineId || ''), destinationMachineId: String(command.payload.destinationMachineId || '') }; }
async function control(command: RunnerCommand) {
  try {
    if (command.kind === 'agent-context') { await finish(command, agentContext(stateRoot, command.agentId, command.payload)); return; }
    if (command.kind === 'store-secret') { const name = String(command.payload.name || ''), value = await decryptRunnerSecret(credentials.encryptionPrivateKey, command.payload.encrypted as EncryptedRunnerSecret); runnerSecrets.set(name, value); await finish(command, { stored: true, name, backend: runnerSecrets.backend }); return; }
    if (command.kind === 'export-agent') {
      const profile = command.payload.profile as AgentProfile | undefined, binding = transferBinding(command);
      if (!profile || profile.id !== command.agentId || profile.computer.machineId !== credentials.machineId || binding.sourceMachineId !== credentials.machineId || typeof command.payload.transferPublicKey !== 'string') throw new Error('An exact source computer profile and encrypted destination are required for transfer.');
      const bundle = await exportAgentTransfer(stateRoot, command.agentId, profile.computer);
      await finish(command, await sealAgentTransfer(bundle, binding, command.payload.transferPublicKey)); return;
    }
    if (command.kind === 'import-agent') {
      const profile = command.payload.profile as AgentProfile | undefined;
      if (profile) assertSandboxedComputer(profile.computer);
      const binding = transferBinding(command);
      if (!profile || profile.id !== command.agentId || profile.computer.machineId !== credentials.machineId || binding.destinationMachineId !== credentials.machineId) throw new Error('The destination computer profile does not match this runner.');
      if (profile) validateComputerTarget(profile, await capabilities(), Array.isArray(command.payload.requiredSecrets) ? command.payload.requiredSecrets.map(String) : [], name => runnerSecrets.has(name) || Boolean(process.env[name]));
      // Only authenticated ciphertext enters the command queue; opened files live in memory until restore.
      const bundle = await openAgentTransfer(command.payload.sealedTransfer, binding, credentials.encryptionPrivateKey);
      const imported = await importAgentTransfer(stateRoot, command.agentId, bundle, profile.computer);
      if (profile?.computer.desktop !== 'none' && profile) {
        const check = { action: 'computer', desktop: profile.computer.desktop };
        const result = await runtimeProbe(await ensureDesktopContainerAsync(profile.id, stateRoot, profile.computer), check);
        if (!result.ok) throw new Error(String(result.message || 'Desktop control is not ready on the destination computer.'));
      }
      await finish(command, { ...imported, validated: true }); return;
    }
    if (command.kind.startsWith('probe-')) {
      const profile = command.payload.profile as AgentProfile & { effectiveModel: any }, shared = join(stateRoot, 'shared');
      assertSandboxedComputer(profile.computer);
      mkdirSync(shared, { recursive: true });
      const availableSecrets = { ...runnerSecrets.environment(), ...process.env } as Record<string,string>, needed = [profile.effectiveModel.credentialRef, ...profile.connectors.filter(item => item.enabled).map(item => item.secretRef)].filter(Boolean), localSecrets = Object.fromEntries(needed.filter(name => availableSecrets[name]).map(name => [name, availableSecrets[name]])), dispatched = await openDispatchedSecrets(command.payload.encryptedSecrets as Record<string, EncryptedRunnerSecret> | undefined), secretSource = { environment: () => ({ ...localSecrets, ...dispatched }) };
      if (command.kind === 'probe-runtime' && command.payload.input?.action === 'model-test') {
        const model = command.payload.input.model;
        const apiKey = command.payload.encryptedApiKey ? await decryptRunnerSecret(credentials.encryptionPrivateKey, command.payload.encryptedApiKey) : availableSecrets[model.credentialRef] || '';
        await finish(command, await testModelConnection(model, apiKey)); return;
      }
      prepareProfile(stateRoot, profile, profile.effectiveModel, secretSource, command.payload.coordinationToken || '', `probe-${command.id}`, {});
      if (command.kind === 'probe-runtime') {
        const probeInput = { ...(command.payload.input || {}) } as any;
        if (probeInput.action === 'computer') probeInput.desktop = profile.computer.desktop;
        if (probeInput.action === 'connection' && !probeInput.apiKey) probeInput.apiKey = command.payload.encryptedApiKey ? await decryptRunnerSecret(credentials.encryptionPrivateKey, command.payload.encryptedApiKey) : secretSource.environment()[profile.effectiveModel.credentialRef] || '';
        if (probeInput.action === 'mcp' && probeInput.env) for (const name of Object.keys(probeInput.env)) if (!probeInput.env[name] && secretSource.environment()[name]) probeInput.env[name] = secretSource.environment()[name];
        const container = probeInput.action === 'computer' && profile.computer.desktop === 'virtual' ? await ensureDesktopContainerAsync(profile.id, stateRoot, profile.computer) : await ensureContainerAsync(profile.id, stateRoot, profile.computer);
        await finish(command, await runtimeProbe(container, probeInput));
        return;
      }
      const container = await ensureContainerAsync(profile.id, stateRoot, profile.computer);
      if (command.kind === 'probe-tools') { const input = await runtimeProbe(container, { action: 'catalog' }); await finish(command, { source: 'runtime', tools: runtimeToolCatalog(Array.isArray(input.tools) ? input.tools : [], profile) }); return; }
      const gateway = new HermesGateway(container, []);
      let result;
      try { await gateway.start(); result = await discoverModels(gateway); } finally { await gateway.stop(); }
      await finish(command, result); return;
    }
    const live = active.get(String(command.payload.runId));
    if (!live && command.kind === 'stop') {
      const waiting = admittedRuns.get(String(command.payload.runId));
      if (waiting) { waiting.cancelled = true; await finish(command, { ok: true }); return; }
    }
    if (!live) throw new Error('The requested run is no longer active on this runner.');
    if (command.kind === 'stop') { live.stopping = true; if (live.sessionId) await live.gateway.request('session.interrupt', { session_id: live.sessionId }, 5000).catch(() => {}); await live.gateway.stop(); blockedAgents.delete(live.agentId); }
    if (command.kind === 'steer') { if (!live.sessionId) throw new Error('The agent is still starting. Try again when its session is ready.'); await live.gateway.request('session.steer', { session_id: live.sessionId, text: String(command.payload.text || '') }); }
    if (command.kind === 'approval') await live.gateway.request('approval.respond', { session_id: live.sessionId, request_id: command.payload.requestId, choice: hermesApprovalDecision(command.payload.choice || command.payload.decision), all: false });
    if (command.kind === 'input') {
      const type = command.payload.type;
      if (!['clarify', 'secret', 'sudo'].includes(type)) throw new Error('Unsupported input request type.');
      if (type !== 'clarify' && !command.payload.encrypted) throw new Error('Sensitive input must be encrypted for this runner.');
      const value = command.payload.encrypted ? await decryptRunnerSecret(credentials.encryptionPrivateKey, command.payload.encrypted) : command.payload.value;
      const key = type === 'clarify' ? 'answer' : type === 'secret' ? 'value' : 'password';
      try { await live.gateway.request(`${type}.respond`, { request_id: command.payload.requestId, [key]: value }); }
      catch { throw new Error('The agent could not accept this input. Check whether its request is still pending.'); }
    }
    await finish(command, { ok: true });
  } catch (error) { await finish(command, undefined, error); }
}

function browserGroup(profile?: AgentProfile) { return profile?.computer.browserSessionTeamId || ''; }
function browserBlocked(group: string) { const agent = blockedBrowserGroups.get(group); if (agent && !blockedAgents.has(agent)) blockedBrowserGroups.delete(group); return Boolean(agent && blockedAgents.has(agent)); }
async function desktopCommand(command: RunnerCommand) {
  const profile = command.payload.profile as AgentProfile, agentId = String(profile?.id || ''), group = browserGroup(profile), action = command.payload.action as DesktopCommand['action'];
  const owner = command.payload.ownership as ComputerOwnership | undefined, liveOwner = owner?.owner === 'agent' ? active.get(owner.identity) : undefined;
  const agentAction = Boolean(['input','navigate','frame','stage-upload'].includes(action) && liveOwner?.agentId === agentId && !liveOwner.stopping);
  const complete = (value: unknown) => request(`/v1/runner/desktop/${encodeURIComponent(command.id)}/complete`, { method: 'POST', body: JSON.stringify(value) }).then(() => {});
  if (!agentId || agentId !== command.agentId || action !== 'claim' && (blockedAgents.has(agentId) || browserBlocked(group) || (action !== 'frame' && !agentAction && (agentOperations.has(agentId) || group && browserOperations.has(group))))) {
    return complete({ error: 'This computer is busy. Wait for its current task to finish before taking control.' });
  }
  const operation = Promise.resolve().then(async () => {
    try {
      if (typeof command.payload.expiresAt !== 'number' || !Number.isFinite(command.payload.expiresAt) || command.payload.expiresAt <= Date.now()) throw new Error('Desktop command expired.');
      if (owner?.owner === 'agent' && ['input','navigate','stage-upload'].includes(action) && !agentAction) throw new Error('The task no longer controls this computer.');
      if (agentAction) assertComputerOwnership(stateRoot, profile, owner!);
      if (action === 'input' && !command.payload.encrypted) throw new Error('Encrypted desktop input is required.');
      const input = action === 'input' ? JSON.parse(await decryptRunnerSecret(credentials.encryptionPrivateKey, command.payload.encrypted)) : undefined;
      if (command.payload.expiresAt <= Date.now()) throw new Error('Desktop command expired.');
      const result = await executeDesktopCommand(stateRoot, profile, { ...command.payload, action, input, expiresAt: command.payload.expiresAt });
      await complete({ result });
    } catch { await complete({ error: 'The private desktop could not complete that action. Check that the computer is online and try again.' }); }
  });
  // Interactive input never enters the durable runner spool, even on network failure.
  if (action !== 'frame' && action !== 'claim' && !agentAction) { agentOperations.set(agentId, operation); if (group) browserOperations.set(group, operation); }
  try { await operation; }
  finally {
    if (agentOperations.get(agentId) === operation) agentOperations.delete(agentId);
    if (group && browserOperations.get(group) === operation) browserOperations.delete(group);
  }
}
async function executeCommand(command: RunnerCommand) {
  if (shuttingDown) return;
  if (command.kind === 'desktop') return desktopCommand(command);
  if (command.kind === 'duplex') {
    if (command.payload.kind !== 'terminal') return executeRunnerDuplex(stateRoot, credentials, command as DuplexCommand);
    const epoch = terminalAdmissionEpochs.get(command.agentId) || 0;
    const validate = () => {
      if (shuttingDown || blockedAgents.has(command.agentId) || (terminalAdmissionEpochs.get(command.agentId) || 0) !== epoch) throw new Error('Terminal startup was cancelled because computer control changed.');
      assertComputerOwnership(stateRoot, command.payload.profile, command.payload.ownership);
    };
    return admitRunnerTerminal(command.agentId, command.payload.expiresAt, agentOperations, validate, ready => executeRunnerDuplex(stateRoot, credentials, command as DuplexCommand, { validate, ready }));
  }
  if (command.kind === 'stop' && command.payload.quiesce === true) {
    const profile = command.payload.profile as AgentProfile;
    if (!profile || profile.id !== command.agentId || profile.computer.machineId !== credentials.machineId) return finish(command, undefined, new Error('Invalid computer stop request.'));
    terminalAdmissionEpochs.set(profile.id, (terminalAdmissionEpochs.get(profile.id) || 0) + 1);
    blockedAgents.add(profile.id);
    try {
      for (const admission of admittedRuns.values()) if (admission.agentId === profile.id) admission.cancelled = true;
      writeRunLease(stateRoot, profile.id, null);
      for (const live of active.values()) if (live.agentId === profile.id) { live.stopping = true; if (live.sessionId) await live.gateway.request('session.interrupt', { session_id: live.sessionId }, 5000).catch(() => {}); await live.gateway.stop(); }
      await stopAgentContainers(profile.id, stateRoot);
      const pending = agentOperations.get(profile.id);
      if (pending) { let timer: ReturnType<typeof setTimeout> | undefined; try { await Promise.race([pending, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Computer cleanup is still in progress.')), 30000); })]); } finally { clearTimeout(timer); } }
      writeRunLease(stateRoot, profile.id, null); await stopAgentContainers(profile.id, stateRoot);
      blockedAgents.delete(profile.id); await finish(command, { ok: true });
    } catch (error) { await finish(command, undefined, error); }
    return;
  }
  const usesProfile = command.kind === 'run' || command.kind.startsWith('probe-') || command.kind === 'import-agent' || command.kind === 'export-agent' || command.kind === 'agent-context';
  if (!usesProfile) return control(command);
  const agentId = String(command.kind === 'run' ? command.payload.snapshot?.id : command.payload.profile?.id || command.agentId);
  const group = browserGroup(command.kind === 'run' ? command.payload.snapshot : command.payload.profile);
  const previous = agentOperations.get(agentId), sharedPrevious = group ? browserOperations.get(group) : undefined;
  if (blockedAgents.has(agentId) || browserBlocked(group) || ((previous || sharedPrevious) && command.kind !== 'run')) {
    return finish(command, undefined, new Error(blockedAgents.has(agentId) ? 'The previous agent runtime could not be stopped. Stop it before checking settings or starting more work.' : 'This agent is busy. Wait for its current task or settings check to finish before checking or moving its profile.'));
  }
  const admission = { cancelled: false, agentId };
  if (command.kind === 'run') admittedRuns.set(String(command.payload.runId), admission);
  // Claim ownership before yielding, including gateway startup. A run queued behind
  // a probe cannot share files/container with it, and probes never mutate live runs.
  const operation = (async () => {
    await Promise.all([previous, sharedPrevious].filter(Boolean).map(item => item!.catch(() => {})));
    if (admission.cancelled) return finish(command, undefined, new Error('Run stopped before its runtime started.'));
    if (blockedAgents.has(agentId) || browserBlocked(group)) return finish(command, undefined, new Error('The previous agent runtime could not be stopped.'));
    return command.kind === 'run' ? run(command) : control(command);
  })();
  agentOperations.set(agentId, operation);
  if (group) browserOperations.set(group, operation);
  try { await operation; }
  finally {
    if (agentOperations.get(agentId) === operation) agentOperations.delete(agentId);
    if (group && browserOperations.get(group) === operation) browserOperations.delete(group);
    if (group && blockedAgents.has(agentId)) blockedBrowserGroups.set(group, agentId);
    if (command.kind === 'run') admittedRuns.delete(String(command.payload.runId));
  }
}

console.log(`Open Harness runner ${credentials.machineId} connected to ${credentials.coordinator}`);
await flushSpool();
if (!known) void capabilities().catch(() => {});
let lastHeartbeat = 0;
for (; !shuttingDown;) {
  try {
    if (Date.now() - lastHeartbeat > 15_000) { void capabilities().catch(() => {}); await request('/v1/runner/heartbeat', { method: 'POST', body: JSON.stringify({ ...(known ? { capabilities: known } : {}), encryptionPublicKey: credentials.encryptionPublicKey, activeCommandIds: [...new Set([...admittedCommands, ...[...active.values()].map(item => item.commandId)])] }) }); lastHeartbeat = Date.now(); }
    // Keep the wait shorter than the heartbeat cadence; an idle runner remains online.
    const started = Date.now(), result = await request('/v1/runner/commands?wait=10000');
    if (shuttingDown) break;
    for (const command of result.commands as RunnerCommand[]) { if (admittedCommands.has(command.id)) continue; admittedCommands.add(command.id); void executeCommand(command).catch(error => console.error(error instanceof Error ? error.message : error)).finally(() => admittedCommands.delete(command.id)); }
    // Older coordinators ignore wait; avoid a tight loop during rolling upgrades.
    if (!result.commands.length && Date.now() - started < 500) await new Promise(resolve => setTimeout(resolve, 1000));
  } catch (error) { console.error(error instanceof Error ? error.message : error); await new Promise(resolve => setTimeout(resolve, 1000)); }
}
