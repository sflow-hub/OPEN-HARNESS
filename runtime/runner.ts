/* eslint-disable @typescript-eslint/no-explicit-any */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir, hostname, platform, arch } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { HermesGateway, ensureContainer, hermesApprovalDecision } from './hermes';
import { HERMES_IMAGE, RUNTIME_LABEL, classifyContract } from './readiness';
import { COORDINATION_TOOLS, discoverModels, groupTool, prepareProfile, runtimeProbe } from './profile-runtime';
import type { AgentProfile, MachineInfo } from '../lib/agent-profile';
import { exportAgentFiles, importAgentFiles } from './transfer-files';
import { SecretStore } from './secrets';
import { decryptRunnerSecret, generateRunnerKeyPair, type EncryptedRunnerSecret } from '../lib/runner-crypto';
import { assertSandboxedComputer, validateComputerTarget } from './computer-validation';
import { agentContext } from './agent-context';
import { testModelConnection } from './model-validation';

type Credentials = { coordinator: string; machineId: string; token: string; encryptionPublicKey: string; encryptionPrivateKey: string };
type RunnerCommand = { id: string; agentId: string; kind: 'run' | 'stop' | 'steer' | 'approval' | 'input' | 'agent-context' | 'export-agent' | 'import-agent' | 'probe-tools' | 'probe-runtime' | 'probe-models' | 'store-secret'; payload: any };
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
function capabilities() { return probing ??= probeCapabilities().then(value => (known = value)).finally(() => { probing = null; }); }
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
    try { const response = await fetch(credentials.coordinator + path, { ...init, headers: { ...headers, ...init.headers } }); const value = await response.json() as any; if (!response.ok) throw new Error(value.error || `Coordinator returned HTTP ${response.status}.`); return value; }
    catch (error) { if (!retry) throw error; await new Promise(resolve => setTimeout(resolve, 2000)); }
  }
}

const active = new Map<string, { gateway: HermesGateway; sessionId: string | null; commandId: string; stopping: boolean; agentId: string }>();
const admittedCommands = new Set<string>();
const agentOperations = new Map<string, Promise<void>>();
const blockedAgents = new Set<string>();
const admittedRuns = new Map<string, { cancelled: boolean }>();
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
  const payload = command.payload as { runId: string; prompt: string; history?: Array<{ role: 'user' | 'assistant'; content: string }>; snapshot: AgentProfile & { effectiveModel: any }; encryptedSecrets?: Record<string, EncryptedRunnerSecret>; coordinationToken: string };
  const profile = payload.snapshot;
  let gateway: HermesGateway | undefined, result: unknown, failure: unknown;
  try {
    assertSandboxedComputer(profile.computer);
    const shared = join(stateRoot, 'shared'); mkdirSync(shared, { recursive: true });
    const needed = [profile.effectiveModel.credentialRef, ...profile.connectors.filter(item => item.enabled).map(item => item.secretRef)].filter(Boolean);
    const availableSecrets = { ...runnerSecrets.environment(), ...process.env } as Record<string,string>;
    const localSecrets = Object.fromEntries(needed.filter(name => availableSecrets[name]).map(name => [name, availableSecrets[name]]));
    const dispatched = await openDispatchedSecrets(payload.encryptedSecrets);
    if (admittedRuns.get(payload.runId)?.cancelled) throw new Error('Run stopped before its runtime started.');
    const ephemeralSecrets = { environment: () => ({ ...localSecrets, ...dispatched }) };
    const coordinatorForContainer = credentials.coordinator.replace('://localhost', '://host.docker.internal').replace('://127.0.0.1', '://host.docker.internal');
    prepareProfile(stateRoot, profile, profile.effectiveModel, ephemeralSecrets, payload.coordinationToken, payload.runId, { controlUrl: coordinatorForContainer });
    gateway = new HermesGateway(ensureContainer(profile.id, stateRoot, profile.computer), profile.allowedTools);
    const live = { gateway, sessionId: null as string | null, commandId: command.id, stopping: false, agentId: profile.id };
    active.set(payload.runId, live);
    gateway.on('event', event => void emit(command, event)); await gateway.start();
    if (live.stopping) throw new Error('Run stopped before its session started.');
    const session = await gateway.request('session.create', { cwd: '/workspace/shared', profile: 'default', messages: payload.history || [] });
    const sessionId = String(session?.session_id || session?.id || ''); if (!sessionId) throw new Error('Hermes did not return a session ID.');
    live.sessionId = sessionId;
    await emit(command, { type: 'session.started', session_id: sessionId, payload: { session_id: sessionId } });
    if (live.stopping) throw new Error('Run stopped before its prompt started.');
    result = await gateway.submitPrompt(sessionId, payload.prompt);
  } catch (error) { failure = error; }
  try {
    await gateway?.stop();
    active.delete(payload.runId);
  } catch (error) {
    blockedAgents.add(profile.id);
    failure = new Error(`Agent cleanup could not be confirmed. Further work is blocked until it is stopped: ${error instanceof Error ? error.message : error}`);
  }
  await finish(command, result, failure);
}
async function control(command: RunnerCommand) {
  try {
    if (command.kind === 'agent-context') { await finish(command, agentContext(stateRoot, command.agentId, command.payload)); return; }
    if (command.kind === 'store-secret') { const name = String(command.payload.name || ''), value = await decryptRunnerSecret(credentials.encryptionPrivateKey, command.payload.encrypted as EncryptedRunnerSecret); runnerSecrets.set(name, value); await finish(command, { stored: true, name, backend: runnerSecrets.backend }); return; }
    if (command.kind === 'export-agent') { await finish(command, exportAgentFiles(stateRoot, command.agentId)); return; }
    if (command.kind === 'import-agent') {
      const profile = command.payload.profile as AgentProfile | undefined;
      if (profile) validateComputerTarget(profile, await capabilities(), Array.isArray(command.payload.requiredSecrets) ? command.payload.requiredSecrets.map(String) : [], name => runnerSecrets.has(name) || Boolean(process.env[name]));
      // The coordinator always inlines the bundle with the command; there is no separate fetch.
      const bundle = command.payload.bundle;
      if (!bundle) throw new Error('This transfer arrived without its file bundle. Start the move again from Agent settings.');
      const imported = importAgentFiles(stateRoot, command.agentId, bundle);
      if (profile?.computer.desktop !== 'none' && profile) {
        const check = { action: 'computer', desktop: profile.computer.desktop };
        const result = await runtimeProbe(ensureContainer(profile.id, stateRoot, profile.computer), check);
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
        await finish(command, await runtimeProbe(ensureContainer(profile.id, stateRoot, profile.computer), probeInput));
        return;
      }
      const container = ensureContainer(profile.id, stateRoot, profile.computer);
      if (command.kind === 'probe-tools') { const input = await runtimeProbe(container, { action: 'catalog' }); await finish(command, { source: 'runtime', tools: [...(Array.isArray(input.tools) ? input.tools : []).filter((tool: any) => tool.group !== 'cronjob').map(groupTool), ...COORDINATION_TOOLS] }); return; }
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

async function executeCommand(command: RunnerCommand) {
  const usesProfile = command.kind === 'run' || command.kind.startsWith('probe-') || command.kind === 'import-agent' || command.kind === 'export-agent' || command.kind === 'agent-context';
  if (!usesProfile) return control(command);
  const agentId = String(command.kind === 'run' ? command.payload.snapshot?.id : command.payload.profile?.id || command.agentId);
  const previous = agentOperations.get(agentId);
  if (blockedAgents.has(agentId) || (previous && command.kind !== 'run')) {
    return finish(command, undefined, new Error(blockedAgents.has(agentId) ? 'The previous agent runtime could not be stopped. Stop it before checking settings or starting more work.' : 'This agent is busy. Wait for its current task or settings check to finish before checking or moving its profile.'));
  }
  const admission = { cancelled: false };
  if (command.kind === 'run') admittedRuns.set(String(command.payload.runId), admission);
  // Claim ownership before yielding, including gateway startup. A run queued behind
  // a probe cannot share files/container with it, and probes never mutate live runs.
  const operation = (async () => {
    if (previous) await previous.catch(() => {});
    if (admission.cancelled) return finish(command, undefined, new Error('Run stopped before its runtime started.'));
    if (blockedAgents.has(agentId)) return finish(command, undefined, new Error('The previous agent runtime could not be stopped.'));
    return command.kind === 'run' ? run(command) : control(command);
  })();
  agentOperations.set(agentId, operation);
  try { await operation; }
  finally {
    if (agentOperations.get(agentId) === operation) agentOperations.delete(agentId);
    if (command.kind === 'run') admittedRuns.delete(String(command.payload.runId));
  }
}

console.log(`Open Harness runner ${credentials.machineId} connected to ${credentials.coordinator}`);
await flushSpool();
if (!known) void capabilities().catch(() => {});
let lastHeartbeat = 0;
for (;;) {
  try {
    if (Date.now() - lastHeartbeat > 15_000) { void capabilities().catch(() => {}); await request('/v1/runner/heartbeat', { method: 'POST', body: JSON.stringify({ ...(known ? { capabilities: known } : {}), encryptionPublicKey: credentials.encryptionPublicKey, activeCommandIds: [...new Set([...admittedCommands, ...[...active.values()].map(item => item.commandId)])] }) }); lastHeartbeat = Date.now(); }
    const result = await request('/v1/runner/commands');
    for (const command of result.commands as RunnerCommand[]) { if (admittedCommands.has(command.id)) continue; admittedCommands.add(command.id); void executeCommand(command).catch(error => console.error(error instanceof Error ? error.message : error)).finally(() => admittedCommands.delete(command.id)); }
  } catch (error) { console.error(error instanceof Error ? error.message : error); }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
