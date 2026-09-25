/* eslint-disable @typescript-eslint/no-explicit-any */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir, hostname, platform, arch } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { HermesGateway, ensureContainer } from './hermes';
import { HERMES_IMAGE, RUNTIME_LABEL, classifyContract } from './readiness';
import { COORDINATION_TOOLS, discoverModels, groupTool, nativeRuntimeProbe, prepareProfile, runtimeProbe } from './profile-runtime';
import type { AgentProfile, MachineInfo } from '../lib/agent-profile';
import { exportAgentFiles, importAgentFiles } from './transfer-files';
import { SecretStore } from './secrets';
import { decryptRunnerSecret, generateRunnerKeyPair, type EncryptedRunnerSecret } from '../lib/runner-crypto';
import { validateComputerTarget } from './computer-validation';

type Credentials = { coordinator: string; machineId: string; token: string; encryptionPublicKey: string; encryptionPrivateKey: string };
type RunnerCommand = { id: string; agentId: string; kind: 'run' | 'stop' | 'steer' | 'approval' | 'export-agent' | 'import-agent' | 'probe-tools' | 'probe-runtime' | 'probe-models' | 'store-secret'; payload: any };
const args = new Map<string,string>();
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[i + 1]?.startsWith('--') ? '' : process.argv[++i] || '');
const stateRoot = resolve(process.env.OPEN_HARNESS_RUNNER_STATE_DIR || join(homedir(), '.open-harness-runner'));
const credentialPath = join(stateRoot, 'connection.json');
const spool = join(stateRoot, 'spool'); mkdirSync(spool, { recursive: true });
let runnerSecrets: SecretStore;
try { runnerSecrets = new SecretStore(join(stateRoot, 'secrets.json')); }
catch (error) { console.error(error instanceof Error ? error.message : 'The runner could not open its credential store.'); process.exit(1); }

type Capabilities = MachineInfo['capabilities'];
const pythons = ([process.env.HERMES_PYTHON, process.platform === 'win32' ? 'python' : 'python3', 'python'].filter(Boolean) as string[]);
// Host probes must not use spawnSync here: a wedged Docker daemon or a hung Python would block
// the event loop and with it every heartbeat and command poll. stdio is ignored and the promise
// settles on exit, not close, because an orphaned grandchild can hold pipes open past the kill.
function exitCode(command: string, args: string[], timeout: number) {
  return new Promise<number | null>(resolve => {
    let done = false; const settle = (code: number | null) => { if (!done) { done = true; resolve(code); } };
    const child = spawn(command, args, { stdio: 'ignore', timeout, killSignal: 'SIGKILL' });
    child.on('error', () => settle(null)); child.on('exit', code => settle(code));
  });
}
// Like exitCode, but keeps stdout: the image label is the answer, not the exit status.
function output(command: string, args: string[], timeout: number) {
  return new Promise<{ status: number | null; stdout: string }>(resolve => {
    let done = false, stdout = ''; const settle = (status: number | null) => { if (!done) { done = true; resolve({ status, stdout }); } };
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], timeout, killSignal: 'SIGKILL' });
    child.stdout.on('data', chunk => stdout += chunk); child.on('error', () => settle(null)); child.on('exit', code => settle(code));
  });
}
async function probeCapabilities(): Promise<Capabilities> {
  const [container, python] = await Promise.all([
    // An image built before a fix must not advertise container capability; the coordinator
    // would dispatch to it and every run would die at gateway startup.
    process.env.OPEN_HARNESS_MOCK === '1' ? true : output('docker', ['image', 'inspect', '-f', `{{index .Config.Labels "${RUNTIME_LABEL}"}}`, HERMES_IMAGE], 5_000).then(result => classifyContract(result) === 'current'),
    Promise.all(pythons.map(async name => (await exitCode(name, ['-c', 'import hermes_cli, open_harness_policy'], 8_000)) === 0)).then(found => found.some(Boolean)),
  ]);
  return { container, direct: python, desktop: Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.platform === 'darwin' || process.platform === 'win32'), virtualDesktop: process.platform === 'linux' && container, detail: python ? 'Hermes host runtime is installed.' : 'Install the Hermes host runtime to enable direct access.' };
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

const active = new Map<string, { gateway: HermesGateway; sessionId: string; commandId: string }>();
const admittedCommands = new Set<string>();
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
  const payload = command.payload as { runId: string; prompt: string; snapshot: AgentProfile & { effectiveModel: any }; encryptedSecrets?: Record<string, EncryptedRunnerSecret>; coordinationToken: string };
  const profile = payload.snapshot, direct = profile.computer.access === 'direct';
  try {
    const agentRoot = join(stateRoot, 'agents', profile.id), shared = join(stateRoot, 'shared'); mkdirSync(shared, { recursive: true });
    const needed = [profile.effectiveModel.credentialRef, ...profile.connectors.filter(item => item.enabled).map(item => item.secretRef)].filter(Boolean);
    const availableSecrets = { ...runnerSecrets.environment(), ...process.env } as Record<string,string>;
    const localSecrets = Object.fromEntries(needed.filter(name => availableSecrets[name]).map(name => [name, availableSecrets[name]]));
    const dispatched = await openDispatchedSecrets(payload.encryptedSecrets);
    const ephemeralSecrets = { environment: () => ({ ...localSecrets, ...dispatched }) };
    const coordinatorForContainer = credentials.coordinator.replace('://localhost', '://host.docker.internal').replace('://127.0.0.1', '://host.docker.internal');
    prepareProfile(stateRoot, profile, profile.effectiveModel, ephemeralSecrets, payload.coordinationToken, payload.runId, direct ? { cwd: shared, coordinationCommand: join(import.meta.dirname, 'hermes', 'coordination.mjs'), controlUrl: credentials.coordinator } : { controlUrl: coordinatorForContainer });
    const gateway = direct
      ? new HermesGateway(`native-${profile.id}`, profile.allowedTools, { cwd: shared, entry: join(import.meta.dirname, 'hermes', 'managed_entry.py'), env: { ...process.env, HERMES_HOME: join(agentRoot, 'profile'), HERMES_TUI: '1', PYTHONUNBUFFERED: '1', OPEN_HARNESS_POLICY_PATH: join(agentRoot, 'managed', 'policy.json') } })
      : new HermesGateway(ensureContainer(profile.id, stateRoot, profile.computer), profile.allowedTools);
    gateway.on('event', event => void emit(command, event)); await gateway.start();
    const session = await gateway.request('session.create', { cwd: direct ? shared : '/workspace/shared', profile: 'default' });
    const sessionId = String(session?.session_id || session?.id || ''); if (!sessionId) throw new Error('Hermes did not return a session ID.');
    active.set(payload.runId, { gateway, sessionId, commandId: command.id });
    const result = await gateway.submitPrompt(sessionId, payload.prompt); active.delete(payload.runId); await finish(command, result);
  } catch (error) { active.delete(payload.runId); await finish(command, undefined, error); }
}
async function control(command: RunnerCommand) {
  try {
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
        const result = profile.computer.desktop === 'existing'
          ? nativeRuntimeProbe(join(stateRoot, 'agents', profile.id, 'profile'), check)
          : await runtimeProbe(ensureContainer(profile.id, stateRoot, profile.computer), check);
        if (!result.ok) throw new Error(String(result.message || 'Desktop control is not ready on the destination computer.'));
      }
      await finish(command, { ...imported, validated: true }); return;
    }
    if (command.kind.startsWith('probe-')) {
      const profile = command.payload.profile as AgentProfile & { effectiveModel: any }, direct = profile.computer.access === 'direct', shared = join(stateRoot, 'shared'), agentRoot = join(stateRoot, 'agents', profile.id); mkdirSync(shared, { recursive: true });
      const availableSecrets = { ...runnerSecrets.environment(), ...process.env } as Record<string,string>, needed = [profile.effectiveModel.credentialRef, ...profile.connectors.filter(item => item.enabled).map(item => item.secretRef)].filter(Boolean), localSecrets = Object.fromEntries(needed.filter(name => availableSecrets[name]).map(name => [name, availableSecrets[name]])), dispatched = await openDispatchedSecrets(command.payload.encryptedSecrets as Record<string, EncryptedRunnerSecret> | undefined), secretSource = { environment: () => ({ ...localSecrets, ...dispatched }) };
      prepareProfile(stateRoot, profile, profile.effectiveModel, secretSource, command.payload.coordinationToken || '', `probe-${command.id}`, direct ? { cwd: shared, coordinationCommand: join(import.meta.dirname, 'hermes', 'coordination.mjs'), controlUrl: credentials.coordinator } : {});
      if (command.kind === 'probe-runtime') {
        const probeInput = { ...(command.payload.input || {}) } as any;
        if (probeInput.action === 'computer') probeInput.desktop = profile.computer.desktop;
        if (probeInput.action === 'connection' && !probeInput.apiKey) probeInput.apiKey = localSecrets[profile.effectiveModel.credentialRef] || '';
        if (probeInput.action === 'mcp' && probeInput.env) for (const name of Object.keys(probeInput.env)) if (!probeInput.env[name] && localSecrets[name]) probeInput.env[name] = localSecrets[name];
        if (direct) { const result = spawnSync(process.env.HERMES_PYTHON || 'python3', [join(import.meta.dirname, 'hermes', 'inspect_runtime.py')], { input: JSON.stringify(probeInput) + '\n', encoding: 'utf8', env: { ...process.env, HERMES_HOME: join(agentRoot, 'profile') }, maxBuffer: 5_000_000, timeout: 25_000 }); if (result.status || !result.stdout) throw new Error(result.stderr || 'Native runtime probe failed.'); await finish(command, JSON.parse(result.stdout)); }
        else await finish(command, await runtimeProbe(ensureContainer(profile.id, stateRoot, profile.computer), probeInput));
        return;
      }
      const gateway = direct ? new HermesGateway(`native-${profile.id}`, [], { cwd: shared, entry: join(import.meta.dirname, 'hermes', 'managed_entry.py'), env: { ...process.env, HERMES_HOME: join(agentRoot, 'profile'), HERMES_TUI: '1', PYTHONUNBUFFERED: '1', OPEN_HARNESS_POLICY_PATH: join(agentRoot, 'managed', 'policy.json') } }) : new HermesGateway(ensureContainer(profile.id, stateRoot, profile.computer), []);
      if (command.kind === 'probe-tools') { const input = direct ? (() => { const result = spawnSync(process.env.HERMES_PYTHON || 'python3', [join(import.meta.dirname, 'hermes', 'inspect_runtime.py')], { input: '{"action":"catalog"}\n', encoding: 'utf8', env: { ...process.env, HERMES_HOME: join(agentRoot, 'profile') }, maxBuffer: 5_000_000, timeout: 25_000 }); if (result.status || !result.stdout) throw new Error(result.stderr || 'Tool discovery failed.'); return JSON.parse(result.stdout); })() : await runtimeProbe(ensureContainer(profile.id, stateRoot, profile.computer), { action: 'catalog' }); await finish(command, { source: 'runtime', tools: [...(input.tools || []).filter((tool: any) => tool.group !== 'cronjob').map(groupTool), ...COORDINATION_TOOLS] }); return; }
      await gateway.start(); try { await finish(command, await discoverModels(gateway)); } finally { await gateway.stop(); } return;
    }
    const live = active.get(String(command.payload.runId));
    if (!live) throw new Error('The requested run is no longer active on this runner.');
    if (command.kind === 'stop') { await live.gateway.request('session.interrupt', { session_id: live.sessionId }, 5000).catch(() => {}); await live.gateway.stop(); }
    if (command.kind === 'steer') await live.gateway.request('session.steer', { session_id: live.sessionId, text: String(command.payload.text || '') });
    if (command.kind === 'approval') await live.gateway.request('approval.respond', { request_id: command.payload.requestId, decision: command.payload.decision });
    await finish(command, { ok: true });
  } catch (error) { await finish(command, undefined, error); }
}

console.log(`Open Harness runner ${credentials.machineId} connected to ${credentials.coordinator}`);
await flushSpool();
if (!known) void capabilities().catch(() => {});
let lastHeartbeat = 0;
for (;;) {
  try {
    if (Date.now() - lastHeartbeat > 15_000) { void capabilities().catch(() => {}); await request('/v1/runner/heartbeat', { method: 'POST', body: JSON.stringify({ ...(known ? { capabilities: known } : {}), encryptionPublicKey: credentials.encryptionPublicKey, activeCommandIds: [...new Set([...admittedCommands, ...[...active.values()].map(item => item.commandId)])] }) }); lastHeartbeat = Date.now(); }
    const result = await request('/v1/runner/commands');
    for (const command of result.commands as RunnerCommand[]) { if (admittedCommands.has(command.id)) continue; admittedCommands.add(command.id); void (command.kind === 'run' ? run(command) : control(command)).finally(() => admittedCommands.delete(command.id)); }
  } catch (error) { console.error(error instanceof Error ? error.message : error); }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
