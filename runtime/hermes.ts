/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { ComputerConfig } from '../lib/agent-profile';
import { HERMES_IMAGE, RUNTIME_LABEL, classifyContract, imageContract } from './readiness';

const FIRST_SETUP_MESSAGE = "Docker is ready, but the pinned Hermes runtime still needs its first-time setup.";
const STALE_IMAGE_MESSAGE = "Docker is ready, but the agent runtime on this computer was built before a fix. Open Settings → Readiness and update it.";

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
export type NativeGatewayOptions = { cwd: string; env: NodeJS.ProcessEnv; entry: string; python?: string };

// Python tracebacks put the useful line last, so report the tail, newest last, and
// keep it short enough to read inside an error bubble.
export function lastWords(stderrTail: string[], keep = 3, limit = 400) {
  const lines = stderrTail.filter(line => line.trim()).slice(-keep);
  if (!lines.length) return "";
  const text = lines.join(" | ");
  return ` Last output: ${text.length > limit ? `…${text.slice(-limit)}` : text}`;
}

export class HermesGateway extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private requestId = 0;
  private pending = new Map<string, Pending>();
  private mockApproval: ((decision: string) => void) | null = null;
  // Hermes reports its failures on stderr and then dies. Without a copy, the exit
  // code is all that survives, and "exited with code 1" tells an operator nothing.
  private stderrTail: string[] = [];
  constructor(readonly container: string, readonly allowedTools: string[] | null = null, readonly native: NativeGatewayOptions | null = null) { super(); }

  async start() {
    if (process.env.OPEN_HARNESS_MOCK === "1") {
      queueMicrotask(() => this.emit("event", { type: "gateway.ready", payload: { mock: true } }));
      return;
    }
    if (this.child && !this.child.killed) return;
    this.child = this.native
      ? spawn(this.native.python || process.env.HERMES_PYTHON || 'python3', [this.native.entry], { cwd: this.native.cwd, env: this.native.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== 'win32' })
      : spawn("docker", ["exec", "-i", this.container, "python", "/opt/open-harness/managed_entry.py"], { stdio: ["pipe", "pipe", "pipe"] });
    createInterface({ input: this.child.stdout }).on("line", line => {
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
    createInterface({ input: this.child.stderr }).on("line", line => {
      const message = line.slice(0, 1000);
      this.stderrTail.push(message);
      if (this.stderrTail.length > 50) this.stderrTail.shift();
      this.emit("log", { level: "debug", message });
    });
    this.child.once("exit", code => {
      const error = Object.assign(new Error(`Hermes ${this.native ? 'host' : 'container'} gateway exited with code ${code ?? "unknown"}.${lastWords(this.stderrTail)} Inspect its saved work before retrying.`), { interrupted: true });
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear(); this.child = null; this.emit("exit", error);
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Hermes gateway did not become ready.")), 30_000);
      const ready = (event: any) => { if (event?.type === "gateway.ready") { clearTimeout(timer); this.off("event", ready); resolve(); } };
      this.on("event", ready);
      this.child!.once("exit", () => { clearTimeout(timer); reject(new Error("Hermes gateway exited during startup.")); });
    });
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
    if (method === "session.create") return { session_id: crypto.randomUUID() };
    if (method === "prompt.submit") {
      const prompt = String(params.text || "");
      if (prompt.includes("MOCK_TOOL:")) { const name = prompt.split("MOCK_TOOL:")[1].split(/\s/)[0]; if (!this.allowedTools?.includes(name)) throw new Error(`Tool ${name} is disabled in this agent profile.`); }
      const canUseTerminal = this.allowedTools === null || this.allowedTools.includes("terminal");
      if (canUseTerminal) this.emit("event", { type: "tool.start", payload: { id: "mock-tool", name: "terminal", preview: "python task.py" } });
      if (prompt.includes("MOCK_SLOW")) await new Promise(resolve => setTimeout(resolve, 800));
      if (prompt.includes("MOCK_APPROVAL")) {
        this.emit("event", { type: "approval.request", payload: { request_id: "mock-approval", command: "publish mock result" } });
        const decision = await new Promise<string>(resolve => { this.mockApproval = resolve; });
        if (decision !== "approve") throw new Error("Mock action was denied.");
      }
      if (canUseTerminal) this.emit("event", { type: "tool.complete", payload: { id: "mock-tool", name: "terminal", result: "Created and executed task.py" } });
      this.emit("event", { type: "message.delta", payload: { text: "Hermes mock completed the task." } });
      return { final_response: "Hermes mock completed the task." };
    }
    if (method === "approval.respond") { this.mockApproval?.(String(params.decision)); this.mockApproval = null; return { ok: true }; }
    if (["session.steer", "session.interrupt", "process.stop"].includes(method)) return { ok: true };
    return { ok: true };
  }
  async stop() {
    // Killing the docker CLI alone leaves the Python process inside the container.
    // Stopping this agent's container also reaps detached tools and subagents;
    // mounted profile/workspace data persists for its next task.
    if (process.env.OPEN_HARNESS_MOCK !== "1" && !this.native) await new Promise<void>((resolve, reject) => {
      const child = spawn("docker", ["stop", "--time", "2", this.container], { stdio: "ignore" });
      child.once("error", () => reject(new Error("Could not stop the agent container. Check Docker.")));
      child.once("exit", code => code === 0 ? resolve() : reject(new Error("Docker could not confirm the agent container stopped.")));
    });
    if (process.env.OPEN_HARNESS_MOCK !== '1' && this.native && this.child?.pid) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { stdio: 'ignore' });
      else { try { process.kill(-this.child.pid, 'SIGTERM'); } catch { this.child.kill('SIGTERM'); } }
    }
    this.mockApproval?.("deny"); this.mockApproval = null;
    this.child?.kill("SIGTERM"); this.child = null;
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
// forever, so updating the runtime would appear to change nothing.
export function containerSignature(selected: ComputerConfig, imageId: string) {
  return createHash('sha256').update(JSON.stringify({ access: selected.access, folders: selected.folders, desktop: selected.desktop, resources: selected.resources, imageId })).digest('hex').slice(0, 24);
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

// Agent containers run with --restart unless-stopped so a run survives a Docker hiccup, which
// means anything left behind comes back on every Docker start and holds its CPU and memory
// reservation for good. Stopping only the containers with a live gateway was not enough:
// opening Agent settings creates one through a probe and never registers a gateway for it.
// Reaping by label also covers containers orphaned by an earlier hard kill.
export function stopManagedContainers() {
  const listed = spawnSync('docker', ['ps', '-q', '--filter', `label=${MANAGED_LABEL}=1`], { encoding: 'utf8', timeout: 15_000 });
  if (listed.status !== 0) return [];
  const ids = listed.stdout.split('\n').map(id => id.trim()).filter(Boolean);
  if (ids.length) spawnSync('docker', ['stop', '--time', '2', ...ids], { stdio: 'ignore', timeout: 60_000 });
  return ids;
}

export function ensureContainer(agentId: string, stateRoot: string, computer?: ComputerConfig) {
  if (process.env.OPEN_HARNESS_MOCK === "1") return `mock-${agentId}`;
  const sharing = stateSharing(stateRoot);
  if (!sharing.ok) throw new Error(sharing.detail);
  // Refuse here, not just in readiness: a container from an image that predates a fix
  // would start and then die with "gateway exited during startup", which says nothing.
  const contract = imageContract();
  if (contract !== 'current') throw new Error(contract === 'missing' ? FIRST_SETUP_MESSAGE : STALE_IMAGE_MESSAGE);
  const safe = agentId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48);
  const name = `open-harness-${safe}`;
  const selected = computer || { machineId: 'local', access: 'private', folders: [], desktop: 'none', reserveMachine: false, resources: { cpu: 2, memoryMb: 4096, concurrency: 4 } } as ComputerConfig;
  const signature = containerSignature(selected, currentImageId());
  const inspect = spawnSync("docker", ["inspect", "-f", "{{.State.Running}} {{index .Config.Labels \"open-harness.config\"}}", name], { encoding: "utf8", timeout: 10_000 });
  if (inspect.status === 0) {
    const [running, currentSignature] = inspect.stdout.trim().split(/\s+/);
    if (currentSignature !== signature) {
      spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 20_000 });
    } else if (running !== "true") {
      const started = spawnSync("docker", ["start", name], { encoding: "utf8", timeout: 20_000 });
      if (started.status !== 0) throw new Error((started.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' ? 'Docker did not respond within 20s. Check the Docker daemon.' : started.stderr.trim() || "Could not start the agent container.");
      return name;
    } else {
      return name;
    }
  }
  const profile = `${stateRoot}/agents/${safe}/profile`, privateDir = `${stateRoot}/agents/${safe}/private`, shared = `${stateRoot}/shared`;
  const mounts: string[] = [];
  if (selected.access === 'folders') selected.folders.forEach((folder, index) => {
    const source = isAbsolute(folder.path) ? folder.path : resolve(folder.path);
    if (!existsSync(source)) throw new Error(`Shared folder does not exist on this computer: ${folder.path}`);
    mounts.push('-v', `${source}:/workspace/mounts/folder-${index + 1}${folder.mode === 'read' ? ':ro' : ''}`);
  });
  const run = spawnSync("docker", ["run", "-d", "--name", name, "--restart", "unless-stopped", '--label', `open-harness.config=${signature}`, '--label', `${MANAGED_LABEL}=1`, "--security-opt", "no-new-privileges",
    "--cap-drop", "ALL", "--pids-limit", "512", "--memory", `${Math.round(selected.resources.memoryMb)}m`, "--cpus", String(selected.resources.cpu), "--add-host", "host.docker.internal:host-gateway",
    "--user", `${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`, "-e", "HOME=/workspace/private",
    ...(selected.desktop === 'virtual' ? ['-e', 'DISPLAY=:99', '-e', 'OPEN_HARNESS_VIRTUAL_DESKTOP=1'] : []),
    "-v", `${stateRoot}/agents/${safe}/managed:/run/open-harness:ro`,
    "-v", `${profile}:/home/hermes/.hermes`, "-v", `${privateDir}:/workspace/private`, "-v", `${shared}:/workspace/shared`,
    ...mounts,
    HERMES_IMAGE], { encoding: "utf8", timeout: 30_000 });
  if (run.status !== 0) throw new Error((run.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' ? 'Docker did not respond within 30s. Check the Docker daemon.' : run.stderr.trim() || "Could not create the private agent workspace. Open Readiness in Settings and finish setup.");
  return name;
}
