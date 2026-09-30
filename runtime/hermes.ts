/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ComputerConfig } from '../lib/agent-profile';
import { HERMES_IMAGE, RUNTIME_LABEL, classifyContract, imageContract } from './readiness';
import { assertSandboxedComputer, sharedFolderSource } from './computer-validation';
import { UNSANDBOXED_COMPUTER_MESSAGE } from '../lib/agent-profile';
import { createVerifiedFolderContainer, pinSelectedFolders, requiresFolderVerification } from './folder-mounts';

const FIRST_SETUP_MESSAGE = "Docker is ready, but the pinned Hermes runtime still needs its first-time setup.";
const STALE_IMAGE_MESSAGE = "Docker is ready, but the agent runtime on this computer was built before a fix. Open Settings → Readiness and update it.";

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
export type NativeGatewayOptions = { cwd: string; env: NodeJS.ProcessEnv; entry: string; python?: string; onSpawn?: (pid: number) => void };

async function processCommand(command: string, args: string[], timeout = 5000) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout, killSignal: 'SIGKILL' });
    let output = '', error = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(output) : reject(new Error(error.trim() || `${command} could not confirm process termination.`)));
  });
}
export async function stopNativeTree(pid: number) {
  if (process.platform === 'win32') {
    await processCommand('taskkill', ['/PID', String(pid), '/T', '/F']);
    return;
  }
  // Tools may start their own process groups. Remember descendants before TERM
  // reparents them, and include the gateway's group even if its leader has exited.
  const tracked = new Set<number>([pid]);
  const live = async () => {
    const rows = (await processCommand('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat='])).trim().split('\n').map(line => {
      const [id, parent, group, state] = line.trim().split(/\s+/);
      return { id: Number(id), parent: Number(parent), group: Number(group), state };
    });
    for (let changed = true; changed;) {
      changed = false;
      for (const row of rows) if (!tracked.has(row.id) && (tracked.has(row.parent) || row.group === pid)) { tracked.add(row.id); changed = true; }
    }
    return rows.filter(row => tracked.has(row.id) && !row.state?.startsWith('Z')).map(row => row.id);
  };
  const signal = (ids: number[], value: NodeJS.Signals) => {
    for (const id of [-pid, ...ids]) {
      try { process.kill(id, value); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
  };
  let remaining = await live();
  for (const value of ['SIGTERM', 'SIGKILL'] as const) {
    if (!remaining.length) return;
    signal(remaining, value);
    const deadline = Date.now() + 2000;
    do {
      await new Promise(resolve => setTimeout(resolve, 50));
      remaining = await live();
      if (!remaining.length) return;
      // Catch descendants created while their parent was handling termination.
      if (value === 'SIGKILL') signal(remaining, value);
    } while (Date.now() < deadline);
  }
  throw new Error('Could not confirm that the agent and its tool processes stopped.');
}

// Python tracebacks put the useful line last, so report the tail, newest last, and
// keep it short enough to read inside an error bubble.
export function lastWords(stderrTail: string[], keep = 3, limit = 400) {
  const lines = stderrTail.filter(line => line.trim()).slice(-keep);
  if (!lines.length) return "";
  const text = lines.join(" | ");
  return ` Last output: ${text.length > limit ? `…${text.slice(-limit)}` : text}`;
}

// Hermes offers an approval channel only when it can see one: tools/approval_context.py treats a
// session as a gateway that can answer approvals if HERMES_GATEWAY_SESSION is set (or a session
// platform is bound), and otherwise finds no interactive context, no unattended context either,
// and approves every flagged command outright. Open Harness set neither, so the whole approval
// feature was inert on a real run -- a container agent ran `chmod 777`, `curl | sh` or
// `rm -rf` in a bind-mounted host folder without anyone being asked, while the dashboard's
// approval UI and the configured approvals.unattended_mode: deny quietly did nothing. Passed on
// the exec rather than baked into the container so an existing agent picks it up immediately.
const GATEWAY_ENV = ['-e', 'HERMES_GATEWAY_SESSION=1'];

// Hermes's approval choices are once | session | always | deny, and it treats anything else as a
// refusal. Open Harness sent "approve", so a run the operator had just allowed resumed with the
// agent told that the user blocked the command and should not be asked again. The dashboard keeps
// its own approve/deny wording; it is translated here, at the one boundary where it matters.
// Anything unrecognised denies, because a decision nobody understands must not run a command.
export function hermesApprovalDecision(decision: string) {
  return decision === 'approve' || decision === 'once' ? 'once' : decision === 'session' || decision === 'always' ? decision : 'deny';
}

export class HermesGateway extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private requestId = 0;
  private pending = new Map<string, Pending>();
  private mockApproval: ((decision: string) => void) | null = null;
  private mockInput: ((answer: unknown) => void) | null = null;
  private mockSessions = new Map<string, unknown[]>();
  private stopping: Promise<void> | null = null;
  private stopped = false;
  // Hermes reports its failures on stderr and then dies. Without a copy, the exit
  // code is all that survives, and "exited with code 1" tells an operator nothing.
  private stderrTail: string[] = [];
  constructor(readonly container: string, readonly allowedTools: string[] | null = null, readonly native: NativeGatewayOptions | null = null) { super(); }

  async start() {
    if (this.native) throw new Error(UNSANDBOXED_COMPUTER_MESSAGE);
    if (this.stopping) await this.stopping;
    this.stopped = false;
    if (process.env.OPEN_HARNESS_MOCK === "1") {
      queueMicrotask(() => this.emit("event", { type: "gateway.ready", payload: { mock: true } }));
      return;
    }
    if (this.child && !this.child.killed) return;
    const child = this.child = spawn("docker", ["exec", "-i", ...GATEWAY_ENV, this.container, "python", "/opt/open-harness/managed_entry.py"], { stdio: ["pipe", "pipe", "pipe"] });
    let exited = false;
    const failed = (error: Error) => {
      if (exited) return; exited = true;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear(); if (this.child === child) this.child = null; this.emit('exit', error);
    };
    child.once('error', error => failed(new Error(`Could not start the Hermes ${this.native ? 'host' : 'container'} gateway: ${error.message}`)));
    child.stdin.on('error', error => failed(Object.assign(new Error(`Hermes gateway input failed: ${error.message}`), { interrupted: true })));
    createInterface({ input: child.stdout }).on("line", line => {
      try {
        const value = JSON.parse(line);
        if (value.id != null && this.pending.has(String(value.id))) {
          const pending = this.pending.get(String(value.id))!; clearTimeout(pending.timer); this.pending.delete(String(value.id));
          if (value.error) pending.reject(new Error(value.error.message || JSON.stringify(value.error))); else pending.resolve(value.result);
        } else {
          const event = value.method === "event" ? value.params : value.params?.event ?? value;
          this.emit("event", event);
        }
      } catch { this.emit("log", { level: "warn", message: line.slice(0, 1000) }); }
    });
    this.stderrTail = [];
    createInterface({ input: child.stderr }).on("line", line => {
      const message = line.slice(0, 1000);
      this.stderrTail.push(message);
      if (this.stderrTail.length > 50) this.stderrTail.shift();
      this.emit("log", { level: "debug", message });
    });
    child.once("exit", code => {
      const error = Object.assign(new Error(`Hermes ${this.native ? 'host' : 'container'} gateway exited with code ${code ?? "unknown"}.${lastWords(this.stderrTail)} Inspect its saved work before retrying.`), { interrupted: true });
      failed(error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); this.off('event', ready); this.off('exit', fail); };
        const fail = (error: Error) => { cleanup(); reject(error); };
        const ready = (event: any) => { if (event?.type === 'gateway.ready') { cleanup(); resolve(); } };
        const timer = setTimeout(() => fail(new Error('Hermes gateway did not become ready.')), 30_000);
        this.on('event', ready); this.once('exit', fail);
      });
    } catch (error) {
      try { await this.stop(); }
      catch (cleanupError) { throw new Error(`${error instanceof Error ? error.message : error} Cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : cleanupError}`); }
      throw error;
    }
  }

  request(method: string, params: Record<string, unknown> = {}, timeout = 300_000): Promise<any> {
    if (process.env.OPEN_HARNESS_MOCK === "1") return this.mockRequest(method, params);
    if (!this.child) return Promise.reject(new Error("Hermes gateway is not running."));
    const id = String(++this.requestId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  submitPrompt(sessionId: string, text: string, timeout = 24 * 60 * 60 * 1000): Promise<any> {
    // The pinned gateway acknowledges admission with {status: "streaming"}.
    // Subscribe before submitting: completion can arrive before that acknowledgement.
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.off("event", onEvent); this.off("exit", onExit); };
      const onExit = (error: Error) => { cleanup(); reject(error); };
      const onEvent = (value: any) => {
        if (value.session_id !== sessionId) return;
        const payload = value.payload || {};
        if (value.type === "error") onExit(new Error(payload.message || "Hermes execution failed."));
        if (value.type === "message.complete") {
          if (payload.status === "error" || payload.status === "interrupted") onExit(Object.assign(new Error(payload.error || payload.text || "Hermes execution was interrupted."), { interrupted: payload.status === "interrupted" }));
          else { cleanup(); resolve(payload); }
        }
      };
      const timer = setTimeout(() => onExit(Object.assign(new Error("Hermes completion was not confirmed. Inspect the session before retrying."), { interrupted: true })), timeout);
      this.on("event", onEvent); this.on("exit", onExit);
      this.request("prompt.submit", { session_id: sessionId, text }, timeout).then(result => {
        if (result?.status !== "streaming") { cleanup(); resolve(result); }
      }, onExit);
    });
  }
  private async mockRequest(method: string, params: Record<string, unknown>) {
    if (method === "session.create") { const sessionId = crypto.randomUUID(); this.mockSessions.set(sessionId, Array.isArray(params.messages) ? params.messages : []); return { session_id: sessionId }; }
    if (method === "prompt.submit") {
      const prompt = String(params.text || "");
      if (prompt.includes('MOCK_HISTORY')) return { final_response: JSON.stringify(this.mockSessions.get(String(params.session_id)) || []) };
      if (prompt.includes("MOCK_TOOL:")) { const name = prompt.split("MOCK_TOOL:")[1].split(/\s/)[0]; if (!this.allowedTools?.includes(name)) throw new Error(`Tool ${name} is disabled in this agent profile.`); }
      const canUseTerminal = this.allowedTools === null || this.allowedTools.includes("terminal");
      if (canUseTerminal) this.emit("event", { type: "tool.start", payload: { id: "mock-tool", name: "terminal", preview: "python task.py" } });
      if (prompt.includes("MOCK_SLOW")) await new Promise(resolve => setTimeout(resolve, 800));
      if (prompt.includes("MOCK_APPROVAL")) {
        this.emit("event", { type: "approval.request", payload: { request_id: "mock-approval", command: "publish mock result" } });
        const decision = await new Promise<string>(resolve => { this.mockApproval = resolve; });
        if (decision === "deny") throw new Error("Mock action was denied.");
      }
      if (prompt.includes('MOCK_CLARIFY')) {
        this.emit('event', { type: 'clarify.request', session_id: params.session_id, payload: { request_id: 'mock-clarify', question: 'What should I use?' } });
        const answer = await new Promise<unknown>(resolve => { this.mockInput = resolve; });
        return { final_response: `Hermes mock completed the task. Answer: ${Array.isArray(answer) ? answer.join(', ') : String(answer)}` };
      }
      if (canUseTerminal) this.emit("event", { type: "tool.complete", payload: { id: "mock-tool", name: "terminal", result: "Created and executed task.py" } });
      this.emit("event", { type: "message.delta", payload: { text: "Hermes mock completed the task." } });
      return { final_response: "Hermes mock completed the task." };
    }
    if (method === "approval.respond") { this.mockApproval?.(String(params.choice)); this.mockApproval = null; return { resolved: 1 }; }
    if (method === 'clarify.respond') { this.mockInput?.(params.answer); this.mockInput = null; return { ok: true }; }
    if (["session.steer", "session.interrupt", "process.stop"].includes(method)) return { ok: true };
    return { ok: true };
  }
  stop(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.stopping ??= this.stopRuntime().finally(() => { this.stopping = null; });
  }
  private async stopRuntime() {
    // Killing the docker CLI alone leaves the Python process inside the container.
    // Stopping this agent's container also reaps detached tools and subagents;
    // mounted profile/workspace data persists for its next task.
    if (process.env.OPEN_HARNESS_MOCK !== "1" && !this.native) await new Promise<void>((resolve, reject) => {
      const child = spawn("docker", ["stop", "--time", "2", this.container], { stdio: "ignore", timeout: 10_000, killSignal: 'SIGKILL' });
      child.once("error", () => reject(new Error("Could not stop the agent container. Check Docker.")));
      child.once("exit", code => code === 0 ? resolve() : reject(new Error("Docker could not confirm the agent container stopped.")));
    });
    this.mockApproval?.("deny"); this.mockApproval = null;
    this.mockInput?.(''); this.mockInput = null;
    this.child?.kill("SIGTERM"); this.child = null;
    this.stopped = true;
    this.emit("exit", Object.assign(new Error("Agent runtime stopped."), { interrupted: true }));
  }
}

export function dockerStatus(requireImage = true) {
  if (process.env.OPEN_HARNESS_MOCK === "1") return { available: true, version: "mock", message: "Deterministic Hermes runtime is ready." };
  const version = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8", timeout: 5000 });
  if (version.status === 0) {
    if (requireImage) {
      const contract = imageContract();
      if (contract !== 'current') return { available: false, version: version.stdout.trim(), message: contract === 'missing' ? FIRST_SETUP_MESSAGE : STALE_IMAGE_MESSAGE };
    }
    return { available: true, version: version.stdout.trim(), message: "Docker is ready." };
  }
  const detail = (version.stderr || version.stdout || "").trim();
  return { available: false, version: null, message: detail.includes("daemon") || detail.includes("sock")
    ? "Docker is installed, but its daemon is not running. Start Docker Desktop or the Docker service."
    : "Docker is required to run isolated Hermes agents." };
}

function execDocker(args: string[], timeout: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    let done = false, stdout = "", stderr = "";
    const settle = (code: number | null) => { if (!done) { done = true; resolve({ code, stdout, stderr }); } };
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"], timeout, killSignal: "SIGKILL" });
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    child.on("error", () => settle(null));
    child.on("exit", code => settle(code));
  });
}
async function probeDockerStatus(): Promise<ReturnType<typeof dockerStatus>> {
  if (process.env.OPEN_HARNESS_MOCK === "1") return { available: true, version: "mock", message: "Deterministic Hermes runtime is ready." };
  const version = await execDocker(["version", "--format", "{{.Server.Version}}"], 5000);
  if (version.code === 0) {
    const label = await execDocker(["image", "inspect", "-f", `{{index .Config.Labels "${RUNTIME_LABEL}"}}`, HERMES_IMAGE], 5000);
    const contract = classifyContract({ status: label.code, stdout: label.stdout });
    if (contract !== 'current') return { available: false, version: version.stdout.trim(), message: contract === 'missing' ? FIRST_SETUP_MESSAGE : STALE_IMAGE_MESSAGE };
    return { available: true, version: version.stdout.trim(), message: "Docker is ready." };
  }
  const detail = (version.stderr || version.stdout || "").trim();
  return { available: false, version: null, message: detail.includes("daemon") || detail.includes("sock")
    ? "Docker is installed, but its daemon is not running. Start Docker Desktop or the Docker service."
    : "Docker is required to run isolated Hermes agents." };
}
// dockerStatus()'s spawnSync calls block the event loop for up to ~10s; called from a
// coordinator request handler, a wedged (not just down) daemon would freeze every other
// in-flight request for that long. Probe asynchronously, cache briefly, and refresh in the
// background instead — request handlers get the last known answer immediately.
let cachedStatus: { value: ReturnType<typeof dockerStatus>; at: number } | null = null;
let statusRefresh: Promise<void> | null = null;
const DOCKER_STATUS_TTL_MS = 5_000;
export function dockerStatusCached(): Promise<ReturnType<typeof dockerStatus>> {
  const stale = !cachedStatus || Date.now() - cachedStatus.at > DOCKER_STATUS_TTL_MS;
  if (stale && !statusRefresh) statusRefresh = probeDockerStatus().then(value => { cachedStatus = { value, at: Date.now() }; }).finally(() => { statusRefresh = null; });
  if (cachedStatus) return Promise.resolve(cachedStatus.value);
  return statusRefresh!.then(() => cachedStatus!.value);
}

// Docker Desktop runs the engine in a VM and only forwards host paths that are on its
// file-sharing list. A bind mount of any other path silently succeeds and presents an
// EMPTY directory inside the container -- no error, no warning. Every agent profile
// (config.yaml, SOUL.md and the .env holding the model credential) arrives that way, so
// an unshared state directory means Hermes starts with no model and no key, and reports
// the misleading "policy extension failed to load". Probe once per state root and say
// the true cause instead. Reuses the pinned image so the check never pulls anything.
export type SharingProbe = { ok: boolean; detail: string };
let sharingCache: { root: string; value: SharingProbe } | null = null;
export function stateSharing(stateRoot: string): SharingProbe {
  if (process.env.OPEN_HARNESS_MOCK === "1") return { ok: true, detail: 'Deterministic test runtime shares state directly.' };
  const root = resolve(stateRoot);
  if (sharingCache?.root === root) return sharingCache.value;
  let value: SharingProbe;
  try {
    const dir = join(root, '.mount-probe');
    mkdirSync(dir, { recursive: true });
    const token = randomUUID();
    // 0o644 so the container user can read it whether or not it shares our uid.
    writeFileSync(join(dir, 'canary'), token, { mode: 0o644 });
    const result = spawnSync("docker", ["run", "--rm", "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      "-v", `${dir}:/probe:ro`, HERMES_IMAGE, "cat", "/probe/canary"], { encoding: "utf8", timeout: 60_000 });
    value = result.stdout.trim() === token
      ? { ok: true, detail: 'Docker can read the Open Harness data folder.' }
      : { ok: false, detail: `Docker cannot read the Open Harness data folder at ${root}, so agent containers would start with an empty profile and never receive your model credential. Add this folder to Docker Desktop → Settings → Resources → File sharing, or set OPEN_HARNESS_STATE_DIR to a folder inside your home directory.` };
  } catch {
    value = { ok: false, detail: `Open Harness could not verify that Docker can read its data folder at ${root}.` };
  }
  sharingCache = { root, value };
  return value;
}

// A container is reused by name for as long as this signature matches. The image ID is
// part of it: a container created from a superseded image would otherwise be reused
// forever, so updating the runtime would appear to change nothing. So is the state root,
// because the mounts are built from it: after the data folder moves -- a different
// OPEN_HARNESS_STATE_DIR, or a backup restored somewhere else, which SELF_HOSTING.md
// documents as a supported operation -- the old container was reused with its mounts still
// pointing at the previous path, Docker recreated that path empty, and every run died with
// "Hermes gateway exited during startup" and a log line blaming the image.
export function containerSignature(selected: ComputerConfig, imageId: string, stateRoot = '') {
  return createHash('sha256').update(JSON.stringify({ access: selected.access, folders: selected.folders, desktop: selected.desktop, resources: selected.resources, imageId, stateRoot: stateRoot && resolve(stateRoot), ...(requiresFolderVerification(selected) ? { folderStartup: 'verified-inert-v1' } : {}) })).digest('hex').slice(0, 24);
}
// Short-lived so a rebuild from Settings takes effect without restarting the coordinator.
let imageIdCache: { id: string; at: number } | null = null;
function currentImageId() {
  if (imageIdCache && Date.now() - imageIdCache.at < 5_000) return imageIdCache.id;
  const result = spawnSync("docker", ["image", "inspect", "-f", "{{.Id}}", HERMES_IMAGE], { encoding: "utf8", timeout: 10_000 });
  imageIdCache = { id: result.status === 0 ? result.stdout.trim() : '', at: Date.now() };
  return imageIdCache.id;
}

export const MANAGED_LABEL = 'open-harness.managed';

export const STATE_LABEL = 'open-harness.state';
export function containerStateKey(stateRoot: string) {
  return createHash('sha256').update(resolve(stateRoot)).digest('hex').slice(0, 24);
}

type ContainerInspection = { Id: string; State: { Running: boolean }; Config: { Labels?: Record<string, string> | null }; Mounts?: { Source: string; Destination: string }[] };
function agentContainerNames(agentId: string, stateRoot: string) {
  const safe = agentId.replace(/[^a-zA-Z0-9_.-]/g, '-'), base = `open-harness-${safe}`;
  return { safe, names: [base, `${base}-${containerStateKey(stateRoot).slice(0, 12)}`] };
}
function inspectedContainer(code: number | null, stdout: string, stderr: string, name: string): ContainerInspection | null {
  if (code !== 0) {
    if (/No such (?:object|container)/i.test(stderr)) return null;
    throw new Error(stderr.trim() || `Docker could not inspect agent container ${name}. Check the Docker daemon.`);
  }
  let value: ContainerInspection;
  try { value = JSON.parse(stdout) as ContainerInspection; } catch { throw new Error(`Docker returned invalid details for agent container ${name}.`); }
  if (!value?.Id || !value.State || !value.Config) throw new Error(`Docker returned incomplete details for agent container ${name}.`);
  return value;
}
function ownsContainer(container: ContainerInspection, safe: string, stateRoot: string) {
  const labels = container.Config.Labels || {};
  if (labels[MANAGED_LABEL] !== '1') return false;
  if (labels[STATE_LABEL] !== undefined) return labels[STATE_LABEL] === containerStateKey(stateRoot);
  // Older containers had no state label. Only adopt one whose private mounts prove it
  // belongs here; matching an agent name or configuration alone cannot establish this.
  const expected = new Map([
    ['/run/open-harness', join(stateRoot, 'agents', safe, 'managed')],
    ['/home/hermes/.hermes', join(stateRoot, 'agents', safe, 'profile')],
    ['/workspace/private', join(stateRoot, 'agents', safe, 'private')],
    ['/workspace/shared', join(stateRoot, 'shared')],
  ]);
  return [...expected].every(([destination, source]) => container.Mounts?.some(mount => mount.Destination === destination && resolve(mount.Source) === resolve(source)));
}
function inspectContainer(name: string) {
  const result = spawnSync('docker', ['inspect', '-f', '{{json .}}', name], { encoding: 'utf8', timeout: 10_000 });
  return inspectedContainer(result.status, result.stdout || '', result.stderr || '', name);
}

// Recovery has no live gateway handle. Verify both possible names before stopping by ID
// so another workspace's agent (or a newly reused name) cannot become a cleanup target.
export async function stopAgentContainers(agentId: string, stateRoot: string) {
  if (process.env.OPEN_HARNESS_MOCK === '1') return;
  const { safe, names } = agentContainerNames(agentId, stateRoot);
  for (const name of names) {
    const result = await execDocker(['inspect', '-f', '{{json .}}', name], 10_000);
    const container = inspectedContainer(result.code, result.stdout, result.stderr, name);
    if (!container || !ownsContainer(container, safe, stateRoot) || !container.State.Running) continue;
    const stopped = await execDocker(['stop', '--time', '2', container.Id], 10_000);
    if (stopped.code !== 0) throw new Error(stopped.stderr.trim() || `Docker could not stop agent container ${name}.`);
  }
}

// A daemon can serve several workspaces. Reap only this coordinator's containers,
// including probe containers, and report cleanup failures before releasing ownership.
export async function stopManagedContainers(stateRoot: string) {
  const result = { stopped: [] as string[], failures: [] as string[] };
  if (process.env.OPEN_HARNESS_MOCK === '1') return result;
  const listed = await execDocker(['ps', '-q', '--filter', `label=${MANAGED_LABEL}=1`, '--filter', `label=${STATE_LABEL}=${containerStateKey(stateRoot)}`], 5_000);
  if (listed.code !== 0) { result.failures.push(listed.stderr.trim() || 'Docker could not list this workspace’s agent containers.'); return result; }
  const ids = listed.stdout.split('\n').map(id => id.trim()).filter(Boolean);
  await Promise.all(ids.map(async id => {
    const stopped = await execDocker(['stop', '--time', '2', id], 10_000);
    if (stopped.code === 0) result.stopped.push(id);
    else result.failures.push(`${id}: ${stopped.stderr.trim() || 'Docker could not confirm the container stopped.'}`);
  }));
  return result;
}

export function ensureContainer(agentId: string, stateRoot: string, computer?: ComputerConfig) {
  assertSandboxedComputer(computer);
  if (process.env.OPEN_HARNESS_MOCK === "1") return `mock-${agentId}`;
  const sharing = stateSharing(stateRoot);
  if (!sharing.ok) throw new Error(sharing.detail);
  // Refuse here, not just in readiness: a container from an image that predates a fix
  // would start and then die with "gateway exited during startup", which says nothing.
  const contract = imageContract();
  if (contract !== 'current') throw new Error(contract === 'missing' ? FIRST_SETUP_MESSAGE : STALE_IMAGE_MESSAGE);
  const { safe, names } = agentContainerNames(agentId, stateRoot);
  const selected = computer || { machineId: 'local', access: 'private', folders: [], desktop: 'none', reserveMachine: false, resources: { cpu: 2, memoryMb: 4096, concurrency: 4 } } as ComputerConfig;
  const mounts: string[] = [];
  if (selected.access === 'folders') selected.folders.forEach((folder, index) => {
    const source = sharedFolderSource(folder.path, folder.mode);
    mounts.push('-v', `${source}:/workspace/mounts/folder-${index + 1}${folder.mode === 'read' ? ':ro' : ''}`);
  });
  const pinned = requiresFolderVerification(selected) ? pinSelectedFolders(selected.folders) : null;
  try {
    const signature = containerSignature(selected, currentImageId(), stateRoot);
    let name = names[0], container = inspectContainer(name);
    if (!container || !ownsContainer(container, safe, stateRoot)) {
      const alternate = inspectContainer(names[1]);
      if (alternate && !ownsContainer(alternate, safe, stateRoot)) throw new Error(`Agent container ${names[1]} belongs to another workspace. Choose a different agent ID or remove the conflicting container yourself.`);
      if (container || alternate) { name = names[1]; container = alternate; }
    }
    if (container) {
      if (pinned || container.Config.Labels?.['open-harness.config'] !== signature || !container.Config.Labels?.[STATE_LABEL]) {
        const removed = spawnSync('docker', ['rm', '-f', container.Id], { encoding: 'utf8', timeout: 20_000 });
        if (removed.status !== 0) throw new Error(removed.stderr?.trim() || 'Could not replace the previous agent container. Check the Docker daemon.');
      } else if (!container.State.Running) {
        const started = spawnSync('docker', ['start', container.Id], { encoding: 'utf8', timeout: 20_000 });
        if (started.status !== 0) throw new Error((started.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' ? 'Docker did not respond within 20s. Check the Docker daemon.' : started.stderr.trim() || 'Could not start the agent container.');
        return name;
      } else return name;
    }
    const profile = `${stateRoot}/agents/${safe}/profile`, privateDir = `${stateRoot}/agents/${safe}/private`, shared = `${stateRoot}/shared`;
    const args = ["--name", name, '--label', `open-harness.config=${signature}`, '--label', `${MANAGED_LABEL}=1`, '--label', `${STATE_LABEL}=${containerStateKey(stateRoot)}`, "--security-opt", "no-new-privileges",
      "--cap-drop", "ALL", "--pids-limit", "512", "--memory", `${Math.round(selected.resources.memoryMb)}m`, "--cpus", String(selected.resources.cpu), "--add-host", "host.docker.internal:host-gateway",
      "--user", `${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`, "-e", "HOME=/workspace/private",
      ...(selected.desktop === 'virtual' ? ['-e', 'DISPLAY=:99', '-e', 'OPEN_HARNESS_VIRTUAL_DESKTOP=1'] : []),
      "-v", `${stateRoot}/agents/${safe}/managed:/run/open-harness:ro`,
      "-v", `${profile}:/home/hermes/.hermes`, "-v", `${privateDir}:/workspace/private`, "-v", `${shared}:/workspace/shared`,
      ...mounts,
      HERMES_IMAGE];
    if (pinned) return createVerifiedFolderContainer(args, pinned, selected.desktop === 'virtual');
    const run = spawnSync("docker", ['run', '-d', '--restart', 'unless-stopped', ...args], { encoding: "utf8", timeout: 30_000 });
    if (run.status !== 0) throw new Error((run.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' ? 'Docker did not respond within 30s. Check the Docker daemon.' : run.stderr.trim() || "Could not create the private agent workspace. Open Readiness in Settings and finish setup.");
    return name;
  } finally { pinned?.close(); }
}
