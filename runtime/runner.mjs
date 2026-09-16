import { createRequire as __openHarnessCreateRequire } from 'node:module'; const require = __openHarnessCreateRequire(import.meta.url);

// runtime/runner.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync3, readFileSync as readFileSync2, writeFileSync as writeFileSync3, chmodSync as chmodSync2, readdirSync as readdirSync2, unlinkSync } from "node:fs";
import { homedir, hostname, platform as platform2, arch } from "node:os";
import { join as join3, resolve as resolve3 } from "node:path";
import { spawnSync as spawnSync3 } from "node:child_process";

// runtime/hermes.ts
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

// runtime/readiness.ts
var HERMES_IMAGE = process.env.OPEN_HARNESS_HERMES_IMAGE || "open-harness-hermes:2026.9.11";
var platform = ["linux", "darwin", "win32"].includes(process.platform) ? process.platform : "unknown";

// runtime/hermes.ts
var HermesGateway = class extends EventEmitter {
  constructor(container, allowedTools = null, native = null) {
    super();
    this.container = container;
    this.allowedTools = allowedTools;
    this.native = native;
    this.child = null;
    this.requestId = 0;
    this.pending = /* @__PURE__ */ new Map();
    this.mockApproval = null;
  }
  async start() {
    if (process.env.OPEN_HARNESS_MOCK === "1") {
      queueMicrotask(() => this.emit("event", { type: "gateway.ready", payload: { mock: true } }));
      return;
    }
    if (this.child && !this.child.killed) return;
    this.child = this.native ? spawn(this.native.python || process.env.HERMES_PYTHON || "python3", [this.native.entry], { cwd: this.native.cwd, env: this.native.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" }) : spawn("docker", ["exec", "-i", this.container, "python", "/opt/open-harness/managed_entry.py"], { stdio: ["pipe", "pipe", "pipe"] });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        const value = JSON.parse(line);
        if (value.id != null && this.pending.has(String(value.id))) {
          const pending = this.pending.get(String(value.id));
          clearTimeout(pending.timer);
          this.pending.delete(String(value.id));
          if (value.error) pending.reject(new Error(value.error.message || JSON.stringify(value.error)));
          else pending.resolve(value.result);
        } else {
          const event = value.method === "event" ? value.params : value.params?.event ?? value;
          this.emit("event", event);
        }
      } catch {
        this.emit("log", { level: "warn", message: line.slice(0, 1e3) });
      }
    });
    createInterface({ input: this.child.stderr }).on("line", (line) => this.emit("log", { level: "debug", message: line.slice(0, 1e3) }));
    this.child.once("exit", (code) => {
      const error = Object.assign(new Error(`Hermes ${this.native ? "host" : "container"} gateway exited with code ${code ?? "unknown"}. Inspect its saved work before retrying.`), { interrupted: true });
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      this.child = null;
      this.emit("exit", error);
    });
    await new Promise((resolve4, reject) => {
      const timer = setTimeout(() => reject(new Error("Hermes gateway did not become ready.")), 3e4);
      const ready = (event) => {
        if (event?.type === "gateway.ready") {
          clearTimeout(timer);
          this.off("event", ready);
          resolve4();
        }
      };
      this.on("event", ready);
      this.child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Hermes gateway exited during startup."));
      });
    });
  }
  request(method, params = {}, timeout = 3e5) {
    if (process.env.OPEN_HARNESS_MOCK === "1") return this.mockRequest(method, params);
    if (!this.child) return Promise.reject(new Error("Hermes gateway is not running."));
    const id = String(++this.requestId);
    return new Promise((resolve4, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out.`));
      }, timeout);
      this.pending.set(id, { resolve: resolve4, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  submitPrompt(sessionId, text, timeout = 24 * 60 * 60 * 1e3) {
    return new Promise((resolve4, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off("event", onEvent);
        this.off("exit", onExit);
      };
      const onExit = (error) => {
        cleanup();
        reject(error);
      };
      const onEvent = (value) => {
        if (value.session_id !== sessionId) return;
        const payload = value.payload || {};
        if (value.type === "error") onExit(new Error(payload.message || "Hermes execution failed."));
        if (value.type === "message.complete") {
          if (payload.status === "error" || payload.status === "interrupted") onExit(Object.assign(new Error(payload.error || payload.text || "Hermes execution was interrupted."), { interrupted: payload.status === "interrupted" }));
          else {
            cleanup();
            resolve4(payload);
          }
        }
      };
      const timer = setTimeout(() => onExit(Object.assign(new Error("Hermes completion was not confirmed. Inspect the session before retrying."), { interrupted: true })), timeout);
      this.on("event", onEvent);
      this.on("exit", onExit);
      this.request("prompt.submit", { session_id: sessionId, text }, timeout).then((result) => {
        if (result?.status !== "streaming") {
          cleanup();
          resolve4(result);
        }
      }, onExit);
    });
  }
  async mockRequest(method, params) {
    if (method === "session.create") return { session_id: crypto.randomUUID() };
    if (method === "prompt.submit") {
      const prompt = String(params.text || "");
      if (prompt.includes("MOCK_TOOL:")) {
        const name = prompt.split("MOCK_TOOL:")[1].split(/\s/)[0];
        if (!this.allowedTools?.includes(name)) throw new Error(`Tool ${name} is disabled in this agent profile.`);
      }
      const canUseTerminal = this.allowedTools === null || this.allowedTools.includes("terminal");
      if (canUseTerminal) this.emit("event", { type: "tool.start", payload: { id: "mock-tool", name: "terminal", preview: "python task.py" } });
      if (prompt.includes("MOCK_SLOW")) await new Promise((resolve4) => setTimeout(resolve4, 800));
      if (prompt.includes("MOCK_APPROVAL")) {
        this.emit("event", { type: "approval.request", payload: { request_id: "mock-approval", command: "publish mock result" } });
        const decision = await new Promise((resolve4) => {
          this.mockApproval = resolve4;
        });
        if (decision !== "approve") throw new Error("Mock action was denied.");
      }
      if (canUseTerminal) this.emit("event", { type: "tool.complete", payload: { id: "mock-tool", name: "terminal", result: "Created and executed task.py" } });
      this.emit("event", { type: "message.delta", payload: { text: "Hermes mock completed the task." } });
      return { final_response: "Hermes mock completed the task." };
    }
    if (method === "approval.respond") {
      this.mockApproval?.(String(params.decision));
      this.mockApproval = null;
      return { ok: true };
    }
    if (["session.steer", "session.interrupt", "process.stop"].includes(method)) return { ok: true };
    return { ok: true };
  }
  async stop() {
    if (process.env.OPEN_HARNESS_MOCK !== "1" && !this.native) await new Promise((resolve4, reject) => {
      const child = spawn("docker", ["stop", "--time", "2", this.container], { stdio: "ignore" });
      child.once("error", () => reject(new Error("Could not stop the agent container. Check Docker.")));
      child.once("exit", (code) => code === 0 ? resolve4() : reject(new Error("Docker could not confirm the agent container stopped.")));
    });
    if (process.env.OPEN_HARNESS_MOCK !== "1" && this.native && this.child?.pid) {
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(this.child.pid), "/T", "/F"], { stdio: "ignore" });
      else {
        try {
          process.kill(-this.child.pid, "SIGTERM");
        } catch {
          this.child.kill("SIGTERM");
        }
      }
    }
    this.mockApproval?.("deny");
    this.mockApproval = null;
    this.child?.kill("SIGTERM");
    this.child = null;
    this.emit("exit", Object.assign(new Error("Agent runtime stopped."), { interrupted: true }));
  }
};
function dockerStatus(requireImage = true) {
  if (process.env.OPEN_HARNESS_MOCK === "1") return { available: true, version: "mock", message: "Deterministic Hermes runtime is ready." };
  const version = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8", timeout: 5e3 });
  if (version.status === 0) {
    if (requireImage && spawnSync("docker", ["image", "inspect", HERMES_IMAGE], { stdio: "ignore" }).status !== 0)
      return { available: false, version: version.stdout.trim(), message: "Docker is ready, but the pinned Hermes runtime still needs its first-time setup." };
    return { available: true, version: version.stdout.trim(), message: "Docker is ready." };
  }
  const detail = (version.stderr || version.stdout || "").trim();
  return { available: false, version: null, message: detail.includes("daemon") || detail.includes("sock") ? "Docker is installed, but its daemon is not running. Start Docker Desktop or the Docker service." : "Docker is required to run isolated Hermes agents." };
}
function ensureContainer(agentId, stateRoot2, computer) {
  if (process.env.OPEN_HARNESS_MOCK === "1") return `mock-${agentId}`;
  const safe = agentId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48);
  const name = `open-harness-${safe}`;
  const selected = computer || { machineId: "local", access: "private", folders: [], desktop: "none", reserveMachine: false, resources: { cpu: 2, memoryMb: 4096, concurrency: 4 } };
  const signature = createHash("sha256").update(JSON.stringify({ access: selected.access, folders: selected.folders, desktop: selected.desktop, resources: selected.resources })).digest("hex").slice(0, 24);
  const inspect = spawnSync("docker", ["inspect", "-f", '{{.State.Running}} {{index .Config.Labels "open-harness.config"}}', name], { encoding: "utf8" });
  if (inspect.status === 0) {
    const [running, currentSignature] = inspect.stdout.trim().split(/\s+/);
    if (currentSignature !== signature) {
      spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    } else if (running !== "true") {
      const started = spawnSync("docker", ["start", name], { encoding: "utf8" });
      if (started.status !== 0) throw new Error(started.stderr.trim() || "Could not start the agent container.");
      return name;
    } else {
      return name;
    }
  }
  const profile = `${stateRoot2}/agents/${safe}/profile`, privateDir = `${stateRoot2}/agents/${safe}/private`, shared = `${stateRoot2}/shared`;
  const mounts = [];
  if (selected.access === "folders") selected.folders.forEach((folder, index) => {
    const source = isAbsolute(folder.path) ? folder.path : resolve(folder.path);
    if (!existsSync(source)) throw new Error(`Shared folder does not exist on this computer: ${folder.path}`);
    mounts.push("-v", `${source}:/workspace/mounts/folder-${index + 1}${folder.mode === "read" ? ":ro" : ""}`);
  });
  const run2 = spawnSync("docker", [
    "run",
    "-d",
    "--name",
    name,
    "--restart",
    "unless-stopped",
    "--label",
    `open-harness.config=${signature}`,
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--pids-limit",
    "512",
    "--memory",
    `${Math.round(selected.resources.memoryMb)}m`,
    "--cpus",
    String(selected.resources.cpu),
    "--add-host",
    "host.docker.internal:host-gateway",
    "--user",
    `${process.getuid?.() || 1e3}:${process.getgid?.() || 1e3}`,
    "-e",
    "HOME=/workspace/private",
    ...selected.desktop === "virtual" ? ["-e", "DISPLAY=:99", "-e", "OPEN_HARNESS_VIRTUAL_DESKTOP=1"] : [],
    "-v",
    `${stateRoot2}/agents/${safe}/managed:/run/open-harness:ro`,
    "-v",
    `${profile}:/home/hermes/.hermes`,
    "-v",
    `${privateDir}:/workspace/private`,
    "-v",
    `${shared}:/workspace/shared`,
    ...mounts,
    HERMES_IMAGE
  ], { encoding: "utf8" });
  if (run2.status !== 0) throw new Error(run2.stderr.trim() || "Could not create the private agent workspace. Open Readiness in Settings and finish setup.");
  return name;
}

// runtime/profile-runtime.ts
import { spawn as spawn2, spawnSync as spawnSync2 } from "node:child_process";
import { mkdirSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { join } from "node:path";
var COORDINATION_TOOLS = [
  { id: "mcp_open_harness_delegate_named_agent", name: "Hand off to another agent", group: "delegation", description: "Assign explicit task context to another named agent.", available: true },
  { id: "mcp_open_harness_create_open_harness_routine", name: "Create a routine", group: "scheduling", description: "Schedule work through Open Harness.", available: true }
];
var mockTools = [
  ["terminal", "terminal"],
  ["process", "terminal"],
  ["execute_code", "code"],
  ["read_file", "files"],
  ["write_file", "files"],
  ["search_files", "files"],
  ["web_search", "web"],
  ["web_extract", "web"],
  ["browser_navigate", "browser"],
  ["browser_screenshot", "browser"],
  ["memory", "memory"],
  ["skills_list", "skills"],
  ["skill_manage", "skills"],
  ["session_search", "recall"],
  ["delegate_task", "delegation"]
].map(([id, group]) => ({ id, group, name: id.replaceAll("_", " "), description: "Deterministic test runtime tool.", available: true }));
function groupTool(tool) {
  const group = { file: "files", terminal: "terminal", process: "terminal", code_execution: "code", execute_code: "code", web: "web", browser: "browser", memory: "memory", skills: "skills", session_search: "recall", delegation: "delegation", delegate: "delegation", cronjob: "scheduling" }[tool.group] || (tool.id.startsWith("mcp_") ? "mcp" : tool.group);
  return { ...tool, group };
}
function runtimeProbe(container, input) {
  return new Promise((resolve4, reject) => {
    const child = spawn2("docker", ["exec", "-i", container, "python", "/opt/open-harness/inspect_runtime.py"], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Runtime connection check timed out."));
    }, 25e3);
    child.stdout.on("data", (part) => {
      output += part;
      if (output.length > 5e6) child.kill();
    });
    child.stderr.resume();
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("Docker could not start the runtime check."));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const value = JSON.parse(output.trim());
        if (code || value.error) reject(new Error(value.error || "Runtime check failed."));
        else resolve4(value);
      } catch {
        reject(new Error("Runtime check returned an invalid response. Rebuild the Hermes image."));
      }
    });
    child.stdin.end(JSON.stringify(input) + "\n");
  });
}
function atomic(path, data) {
  writeFileSync(`${path}.tmp`, data, { mode: 384 });
  renameSync(`${path}.tmp`, path);
  chmodSync(path, 384);
}
function prepareProfile(root, profile, effective, secrets, token, runId, options = {}) {
  const dir = join(root, "agents", profile.id), home = join(dir, "profile"), managed = join(dir, "managed");
  for (const path of [home, managed, join(dir, "private")]) mkdirSync(path, { recursive: true });
  const mcp = {};
  if (profile.allowedTools.some((id) => COORDINATION_TOOLS.some((t) => t.id === id))) mcp.open_harness = { command: "node", args: [options.coordinationCommand || "/opt/open-harness/coordination.mjs"], env: { OPEN_HARNESS_AGENT_ID: profile.id, OPEN_HARNESS_AGENT_TOKEN: token, OPEN_HARNESS_RUN_ID: runId, ...options.controlUrl ? { OPEN_HARNESS_CONTROL_URL: options.controlUrl } : {}, ...options.controlSocket ? { OPEN_HARNESS_CONTROL_SOCKET: options.controlSocket } : {}, ...options.sitesToken ? { OPEN_HARNESS_SITES_TOKEN: options.sitesToken } : {} } };
  const env = {};
  const secretValues = secrets.environment();
  if (effective.credentialRef && secretValues[effective.credentialRef]) {
    env[effective.credentialRef] = secretValues[effective.credentialRef];
    const providerEnv = { xai: "XAI_API_KEY", openrouter: "OPENROUTER_API_KEY", anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", local: "OPENAI_API_KEY", custom: "OPENAI_API_KEY" }[effective.provider];
    if (providerEnv) env[providerEnv] = secretValues[effective.credentialRef];
  }
  for (const c of profile.connectors.filter((c2) => c2.enabled)) {
    const connectorEnv = c.secretRef && secretValues[c.secretRef] ? { [c.secretRef]: secretValues[c.secretRef] } : {};
    Object.assign(env, connectorEnv);
    mcp[c.name] = { command: c.command, args: c.args, env: c.secretRef ? { [c.secretRef]: "${" + c.secretRef + "}" } : {} };
  }
  const config = { model: { default: effective.model, provider: effective.provider === "local" ? "custom" : effective.provider, ...effective.baseUrl ? { base_url: effective.baseUrl } : {} }, terminal: { backend: "local", cwd: options.cwd || "/workspace/shared", home_mode: "profile" }, approvals: { mode: "smart", unattended_mode: "deny", cron_mode: "deny" }, computer_use: { permission_mode: "standard", no_overlay: profile.computer.desktop === "virtual" }, cron: { enabled: false }, delegation: { inherit_mcp_toolsets: false }, plugins: { entries: { open_harness_policy: { enabled: true } } }, mcp_servers: mcp };
  atomic(join(home, "config.yaml"), JSON.stringify(config, null, 2));
  atomic(join(home, "SOUL.md"), profile.prompt.enabled ? profile.prompt.text : "");
  atomic(join(home, ".env"), Object.entries(env).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join("\n") + "\n");
  atomic(join(managed, "policy.json"), JSON.stringify({ runId, revision: profile.revision, allowedTools: profile.allowedTools }));
}
async function discoverModels(gateway) {
  if (process.env.OPEN_HARNESS_MOCK === "1") return { models: [{ id: "mock-atlas", provider: "mock", label: "Mock Atlas" }, { id: "mock-scout", provider: "mock", label: "Mock Scout" }] };
  const result = await gateway.request("model.options", { refresh: true }, 3e4);
  return normalizeModels(result);
}
function normalizeModels(result) {
  const models = [];
  function walk(value, provider = "") {
    if (typeof value === "string" && provider) {
      models.push({ id: value, provider, label: value });
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, provider));
      return;
    }
    const row = value;
    const p = String(row.slug || row.provider_id || row.provider || provider);
    const id = row.model_id || row.model || (p && !row.models ? row.id : "");
    if (typeof id === "string" && id && p) models.push({ id, provider: p, label: String(row.name || row.label || id) });
    for (const key of ["providers", "models", "options", "items"]) if (row[key]) walk(row[key], key === "models" ? String(row.slug || row.provider_id || row.provider || row.id || provider) : p);
  }
  walk(result);
  if (!models.length) return { models, error: "The runtime returned no model choices. Refresh or enter a custom model ID." };
  return { models: [...new Map(models.map((m) => [`${m.provider}:${m.id}`, m])).values()] };
}

// runtime/transfer-files.ts
import { createHash as createHash2 } from "node:crypto";
import { existsSync as existsSync2, lstatSync, mkdirSync as mkdirSync2, readdirSync, readFileSync, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname, join as join2, normalize, relative, resolve as resolve2 } from "node:path";
var allowedRoots = ["private", "profile/MEMORY.md", "profile/USER.md", "profile/skills"];
function digest(data) {
  return createHash2("sha256").update(data).digest("hex");
}
function exportAgentFiles(stateRoot2, agentId) {
  const agentRoot = resolve2(stateRoot2, "agents", agentId), files = [];
  let total = 0;
  const visit = (path) => {
    if (!existsSync2(path)) return;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) visit(join2(path, name));
      return;
    }
    if (!stat.isFile()) return;
    const data = readFileSync(path);
    total += data.length;
    if (total > 2e7) throw new Error("Managed agent data exceeds the 20 MB transfer limit. Move large project files through an explicitly shared folder.");
    files.push({ path: relative(agentRoot, path).replaceAll("\\", "/"), data: Buffer.from(data).toString("base64"), checksum: digest(data) });
  };
  for (const path of allowedRoots) visit(join2(agentRoot, path));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, checksum: digest(files.map((file) => `${file.path}:${file.checksum}`).join("\n")) };
}
function importAgentFiles(stateRoot2, agentId, bundle) {
  const agentRoot = resolve2(stateRoot2, "agents", agentId);
  let total = 0;
  for (const file of bundle.files) {
    const clean = normalize(file.path).replaceAll("\\", "/");
    if (clean.startsWith("../") || !allowedRoots.some((root) => clean === root || clean.startsWith(root + "/"))) throw new Error("Transfer contains an invalid managed path.");
    const target = resolve2(agentRoot, clean);
    if (!target.startsWith(agentRoot + "/") && target !== agentRoot) throw new Error("Transfer path escaped the agent workspace.");
    const data = Buffer.from(file.data, "base64");
    total += data.length;
    if (total > 1e8 || digest(data) !== file.checksum) throw new Error("Transfer checksum validation failed.");
    mkdirSync2(dirname(target), { recursive: true });
    writeFileSync2(target, data, { mode: 384 });
  }
  const checksum = digest([...bundle.files].sort((a, b) => a.path.localeCompare(b.path)).map((file) => `${file.path}:${file.checksum}`).join("\n"));
  if (checksum !== bundle.checksum) throw new Error("Transfer bundle checksum validation failed.");
  return { checksum, files: bundle.files.length };
}

// runtime/runner.ts
var args = /* @__PURE__ */ new Map();
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith("--")) args.set(process.argv[i].slice(2), process.argv[i + 1]?.startsWith("--") ? "" : process.argv[++i] || "");
var stateRoot = resolve3(process.env.OPEN_HARNESS_RUNNER_STATE_DIR || join3(homedir(), ".open-harness-runner"));
var credentialPath = join3(stateRoot, "connection.json");
var spool = join3(stateRoot, "spool");
mkdirSync3(spool, { recursive: true });
function capabilities() {
  const container = dockerStatus().available;
  const python = [process.env.HERMES_PYTHON, process.platform === "win32" ? "python" : "python3", "python"].filter(Boolean).some((executable) => spawnSync3(executable, ["-c", "import hermes_cli, open_harness_policy"], { stdio: "ignore" }).status === 0);
  return { container, direct: python, desktop: Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.platform === "darwin" || process.platform === "win32"), virtualDesktop: process.platform === "linux" && container, detail: python ? "Hermes host runtime is installed." : "Install the Hermes host runtime to enable direct access." };
}
async function pair() {
  const coordinator = String(args.get("coordinator") || "").replace(/\/$/, ""), code = String(args.get("pairing-code") || ""), sitesToken = String(args.get("sites-token") || "");
  if (!coordinator || !code) throw new Error("Use --coordinator URL and --pairing-code CODE, or keep an existing runner connection.");
  const target = new URL(coordinator), loopback = ["localhost", "127.0.0.1", "::1"].includes(target.hostname);
  if (target.protocol !== "https:" && !(target.protocol === "http:" && loopback)) throw new Error("Remote coordinators must use HTTPS. Plain HTTP is accepted only for a coordinator on this computer.");
  const response = await fetch(`${coordinator}/v1/runner/pair`, { method: "POST", headers: { "Content-Type": "application/json", ...sitesToken ? { "OAI-Sites-Authorization": `Bearer ${sitesToken}` } : {} }, body: JSON.stringify({ code, name: hostname(), platform: platform2(), arch: arch(), capabilities: capabilities() }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "Pairing failed.");
  const saved = { coordinator, machineId: value.machineId, token: value.token, ...sitesToken ? { sitesToken } : {} };
  writeFileSync3(credentialPath, JSON.stringify(saved, null, 2), { mode: 384 });
  chmodSync2(credentialPath, 384);
  return saved;
}
var credentials = args.has("pairing-code") ? await pair() : existsSync3(credentialPath) ? JSON.parse(readFileSync2(credentialPath, "utf8")) : await pair();
var savedTarget = new URL(credentials.coordinator);
var savedLoopback = ["localhost", "127.0.0.1", "::1"].includes(savedTarget.hostname);
if (savedTarget.protocol !== "https:" && !(savedTarget.protocol === "http:" && savedLoopback)) throw new Error("The saved remote coordinator URL is not HTTPS. Pair this runner again using a secure URL.");
if (args.has("once")) {
  console.log(`Paired ${credentials.machineId}.`);
  process.exit(0);
}
var headers = { Authorization: `Bearer ${credentials.token}`, "X-Open-Harness-Machine": credentials.machineId, "Content-Type": "application/json", ...credentials.sitesToken ? { "OAI-Sites-Authorization": `Bearer ${credentials.sitesToken}` } : {} };
async function request(path, init = {}, retry = false) {
  for (; ; ) {
    try {
      const response = await fetch(credentials.coordinator + path, { ...init, headers: { ...headers, ...init.headers } });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || `Coordinator returned HTTP ${response.status}.`);
      return value;
    } catch (error) {
      if (!retry) throw error;
      await new Promise((resolve4) => setTimeout(resolve4, 2e3));
    }
  }
}
var active = /* @__PURE__ */ new Map();
var admittedCommands = /* @__PURE__ */ new Set();
async function deliver(record) {
  const file = join3(spool, `${record.id}.json`);
  if (!existsSync3(file)) writeFileSync3(file, JSON.stringify(record), { mode: 384 });
  await request(record.path, { method: "POST", body: JSON.stringify(record.body) }, true);
  if (existsSync3(file)) unlinkSync(file);
}
async function flushSpool() {
  for (const name of readdirSync2(spool).filter((name2) => name2.endsWith(".json"))) {
    try {
      await deliver(JSON.parse(readFileSync2(join3(spool, name), "utf8")));
    } catch {
    }
  }
}
async function emit(command, event) {
  const eventId = crypto.randomUUID();
  await deliver({ id: eventId, path: `/v1/runner/commands/${command.id}/events`, body: { eventId, runId: command.payload.runId, event } });
}
async function finish(command, result, error) {
  await deliver({ id: `complete-${command.id}`, path: `/v1/runner/commands/${command.id}/complete`, body: error ? { error: error instanceof Error ? error.message : String(error) } : { result } });
}
async function run(command) {
  const payload = command.payload;
  const profile = payload.snapshot, direct = profile.computer.access === "direct";
  try {
    const agentRoot = join3(stateRoot, "agents", profile.id), shared = join3(stateRoot, "shared");
    mkdirSync3(shared, { recursive: true });
    const needed = [profile.effectiveModel.credentialRef, ...profile.connectors.filter((item) => item.enabled).map((item) => item.secretRef)].filter(Boolean);
    const localSecrets = Object.fromEntries(needed.filter((name) => process.env[name]).map((name) => [name, process.env[name]]));
    const ephemeralSecrets = { environment: () => ({ ...localSecrets, ...payload.secrets }) };
    const coordinatorForContainer = credentials.coordinator.replace("://localhost", "://host.docker.internal").replace("://127.0.0.1", "://host.docker.internal");
    prepareProfile(stateRoot, profile, profile.effectiveModel, ephemeralSecrets, payload.coordinationToken, payload.runId, direct ? { cwd: shared, coordinationCommand: join3(import.meta.dirname, "hermes", "coordination.mjs"), controlUrl: credentials.coordinator, sitesToken: credentials.sitesToken } : { controlUrl: coordinatorForContainer, sitesToken: credentials.sitesToken });
    const gateway = direct ? new HermesGateway(`native-${profile.id}`, profile.allowedTools, { cwd: shared, entry: join3(import.meta.dirname, "hermes", "managed_entry.py"), env: { ...process.env, HERMES_HOME: join3(agentRoot, "profile"), HERMES_TUI: "1", PYTHONUNBUFFERED: "1", OPEN_HARNESS_POLICY_PATH: join3(agentRoot, "managed", "policy.json") } }) : new HermesGateway(ensureContainer(profile.id, stateRoot, profile.computer), profile.allowedTools);
    gateway.on("event", (event) => void emit(command, event));
    await gateway.start();
    const session = await gateway.request("session.create", { cwd: direct ? shared : "/workspace/shared", profile: "default" });
    const sessionId = String(session?.session_id || session?.id || "");
    if (!sessionId) throw new Error("Hermes did not return a session ID.");
    active.set(payload.runId, { gateway, sessionId, commandId: command.id });
    const result = await gateway.submitPrompt(sessionId, payload.prompt);
    active.delete(payload.runId);
    await finish(command, result);
  } catch (error) {
    active.delete(payload.runId);
    await finish(command, void 0, error);
  }
}
async function control(command) {
  try {
    if (command.kind === "export-agent") {
      await finish(command, exportAgentFiles(stateRoot, command.agentId));
      return;
    }
    if (command.kind === "import-agent") {
      const bundle = command.payload.bundle || (await request(`/v1/runner/transfers/${encodeURIComponent(command.payload.transferId)}`)).bundle;
      await finish(command, importAgentFiles(stateRoot, command.agentId, bundle));
      return;
    }
    if (command.kind.startsWith("probe-")) {
      const profile = command.payload.profile, direct = profile.computer.access === "direct", shared = join3(stateRoot, "shared"), agentRoot = join3(stateRoot, "agents", profile.id);
      mkdirSync3(shared, { recursive: true });
      const needed = [profile.effectiveModel.credentialRef, ...profile.connectors.filter((item) => item.enabled).map((item) => item.secretRef)].filter(Boolean), localSecrets = Object.fromEntries(needed.filter((name) => process.env[name]).map((name) => [name, process.env[name]])), secretSource = { environment: () => ({ ...localSecrets, ...command.payload.secrets || {} }) };
      prepareProfile(stateRoot, profile, profile.effectiveModel, secretSource, command.payload.coordinationToken || "", `probe-${command.id}`, direct ? { cwd: shared, coordinationCommand: join3(import.meta.dirname, "hermes", "coordination.mjs"), controlUrl: credentials.coordinator, sitesToken: credentials.sitesToken } : { sitesToken: credentials.sitesToken });
      if (command.kind === "probe-runtime") {
        const probeInput = { ...command.payload.input || {} };
        if (probeInput.action === "connection" && !probeInput.apiKey) probeInput.apiKey = localSecrets[profile.effectiveModel.credentialRef] || "";
        if (probeInput.action === "mcp" && probeInput.env) {
          for (const name of Object.keys(probeInput.env)) if (!probeInput.env[name] && localSecrets[name]) probeInput.env[name] = localSecrets[name];
        }
        if (direct) {
          const result = spawnSync3(process.env.HERMES_PYTHON || "python3", [join3(import.meta.dirname, "hermes", "inspect_runtime.py")], { input: JSON.stringify(probeInput) + "\n", encoding: "utf8", env: { ...process.env, HERMES_HOME: join3(agentRoot, "profile") }, maxBuffer: 5e6 });
          if (result.status || !result.stdout) throw new Error(result.stderr || "Native runtime probe failed.");
          await finish(command, JSON.parse(result.stdout));
        } else await finish(command, await runtimeProbe(ensureContainer(profile.id, stateRoot, profile.computer), probeInput));
        return;
      }
      const gateway = direct ? new HermesGateway(`native-${profile.id}`, [], { cwd: shared, entry: join3(import.meta.dirname, "hermes", "managed_entry.py"), env: { ...process.env, HERMES_HOME: join3(agentRoot, "profile"), HERMES_TUI: "1", PYTHONUNBUFFERED: "1", OPEN_HARNESS_POLICY_PATH: join3(agentRoot, "managed", "policy.json") } }) : new HermesGateway(ensureContainer(profile.id, stateRoot, profile.computer), []);
      if (command.kind === "probe-tools") {
        const input = direct ? (() => {
          const result = spawnSync3(process.env.HERMES_PYTHON || "python3", [join3(import.meta.dirname, "hermes", "inspect_runtime.py")], { input: '{"action":"catalog"}\n', encoding: "utf8", env: { ...process.env, HERMES_HOME: join3(agentRoot, "profile") }, maxBuffer: 5e6 });
          if (result.status || !result.stdout) throw new Error(result.stderr || "Tool discovery failed.");
          return JSON.parse(result.stdout);
        })() : await runtimeProbe(ensureContainer(profile.id, stateRoot, profile.computer), { action: "catalog" });
        await finish(command, { source: "runtime", tools: [...(input.tools || []).filter((tool) => tool.group !== "cronjob").map(groupTool), ...COORDINATION_TOOLS] });
        return;
      }
      await gateway.start();
      try {
        await finish(command, await discoverModels(gateway));
      } finally {
        await gateway.stop();
      }
      return;
    }
    const live = active.get(String(command.payload.runId));
    if (!live) throw new Error("The requested run is no longer active on this runner.");
    if (command.kind === "stop") {
      await live.gateway.request("session.interrupt", { session_id: live.sessionId }, 5e3).catch(() => {
      });
      await live.gateway.stop();
    }
    if (command.kind === "steer") await live.gateway.request("session.steer", { session_id: live.sessionId, text: String(command.payload.text || "") });
    if (command.kind === "approval") await live.gateway.request("approval.respond", { request_id: command.payload.requestId, decision: command.payload.decision });
    await finish(command, { ok: true });
  } catch (error) {
    await finish(command, void 0, error);
  }
}
console.log(`Open Harness runner ${credentials.machineId} connected to ${credentials.coordinator}`);
await flushSpool();
var lastHeartbeat = 0;
for (; ; ) {
  try {
    if (Date.now() - lastHeartbeat > 15e3) {
      await request("/v1/runner/heartbeat", { method: "POST", body: JSON.stringify({ capabilities: capabilities(), activeCommandIds: [.../* @__PURE__ */ new Set([...admittedCommands, ...[...active.values()].map((item) => item.commandId)])] }) });
      lastHeartbeat = Date.now();
    }
    const result = await request("/v1/runner/commands");
    for (const command of result.commands) {
      admittedCommands.add(command.id);
      void (command.kind === "run" ? run(command) : control(command)).finally(() => admittedCommands.delete(command.id));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  }
  await new Promise((resolve4) => setTimeout(resolve4, 1e3));
}
