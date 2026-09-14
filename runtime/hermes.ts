/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class HermesGateway extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private requestId = 0;
  private pending = new Map<string, Pending>();
  private mockApproval: ((decision: string) => void) | null = null;
  constructor(readonly container: string, readonly allowedTools: string[] | null = null) { super(); }

  async start() {
    if (process.env.OPEN_HARNESS_MOCK === "1") {
      queueMicrotask(() => this.emit("event", { type: "gateway.ready", payload: { mock: true } }));
      return;
    }
    if (this.child && !this.child.killed) return;
    this.child = spawn("docker", ["exec", "-i", this.container, "python", "/opt/open-harness/managed_entry.py"], { stdio: ["pipe", "pipe", "pipe"] });
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
    createInterface({ input: this.child.stderr }).on("line", line => this.emit("log", { level: "debug", message: line.slice(0, 1000) }));
    this.child.once("exit", code => {
      const error = Object.assign(new Error(`Hermes gateway exited with code ${code ?? "unknown"}. Inspect its saved work before retrying.`), { interrupted: true });
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
    if (process.env.OPEN_HARNESS_MOCK !== "1") await new Promise<void>((resolve, reject) => {
      const child = spawn("docker", ["stop", "--time", "2", this.container], { stdio: "ignore" });
      child.once("error", () => reject(new Error("Could not stop the agent container. Check Docker.")));
      child.once("exit", code => code === 0 ? resolve() : reject(new Error("Docker could not confirm the agent container stopped.")));
    });
    this.mockApproval?.("deny"); this.mockApproval = null;
    this.child?.kill("SIGTERM"); this.child = null;
    this.emit("exit", Object.assign(new Error("Agent runtime stopped."), { interrupted: true }));
  }
}

export function dockerStatus(requireImage = true) {
  if (process.env.OPEN_HARNESS_MOCK === "1") return { available: true, version: "mock", message: "Deterministic Hermes runtime is ready." };
  const version = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8", timeout: 5000 });
  if (version.status === 0) {
    if (requireImage && spawnSync("docker", ["image", "inspect", "open-harness-hermes:2026.9.11"], { stdio: "ignore" }).status !== 0)
      return { available: false, version: version.stdout.trim(), message: "Docker is ready, but the pinned Hermes image is not built. Run npm run harness:setup." };
    return { available: true, version: version.stdout.trim(), message: "Docker is ready." };
  }
  const detail = (version.stderr || version.stdout || "").trim();
  return { available: false, version: null, message: detail.includes("daemon") || detail.includes("sock")
    ? "Docker is installed, but its daemon is not running. Start Docker Desktop or the Docker service."
    : "Docker is required to run isolated Hermes agents." };
}

export function ensureContainer(agentId: string, stateRoot: string) {
  if (process.env.OPEN_HARNESS_MOCK === "1") return `mock-${agentId}`;
  const safe = agentId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48);
  const name = `open-harness-${safe}`;
  const inspect = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", name], { encoding: "utf8" });
  if (inspect.status === 0) {
    if (inspect.stdout.trim() !== "true") {
      const started = spawnSync("docker", ["start", name], { encoding: "utf8" });
      if (started.status !== 0) throw new Error(started.stderr.trim() || "Could not start the agent container.");
    }
    return name;
  }
  const profile = `${stateRoot}/agents/${safe}/profile`, privateDir = `${stateRoot}/agents/${safe}/private`, shared = `${stateRoot}/shared`;
  const run = spawnSync("docker", ["run", "-d", "--name", name, "--restart", "unless-stopped", "--security-opt", "no-new-privileges",
    "--cap-drop", "ALL", "--pids-limit", "512", "--memory", "4g", "--cpus", "2", "--add-host", "host.docker.internal:host-gateway",
    "--user", `${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`, "-e", "HOME=/workspace/private",
    "-v", `${stateRoot}/agents/${safe}/managed:/run/open-harness:ro`,
    "-v", `${profile}:/home/hermes/.hermes`, "-v", `${privateDir}:/workspace/private`, "-v", `${shared}:/workspace/shared`,
    "open-harness-hermes:2026.9.11"], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(run.stderr.trim() || "Could not create the agent container. Run npm run harness:setup first.");
  return name;
}
