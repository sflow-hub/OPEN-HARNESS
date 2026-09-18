import { createRequire as __openHarnessCreateRequire } from 'node:module'; const require = __openHarnessCreateRequire(import.meta.url);

// runtime/runner.ts
import { existsSync as existsSync4, mkdirSync as mkdirSync4, readFileSync as readFileSync3, writeFileSync as writeFileSync4, chmodSync as chmodSync3, readdirSync as readdirSync2, unlinkSync as unlinkSync2 } from "node:fs";
import { homedir, hostname, platform as platform2, arch } from "node:os";
import { join as join3, resolve as resolve3 } from "node:path";
import { spawnSync as spawnSync4 } from "node:child_process";

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
  const group = { file: "files", terminal: "terminal", process: "terminal", code_execution: "code", execute_code: "code", web: "web", browser: "browser", computer_use: "desktop", memory: "memory", skills: "skills", session_search: "recall", delegation: "delegation", delegate: "delegation", cronjob: "scheduling" }[tool.group] || (tool.id.startsWith("mcp_") ? "mcp" : tool.group);
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
function nativeRuntimeProbe(profileHome, input) {
  const executable = [process.env.HERMES_PYTHON, process.platform === "win32" ? "python" : "python3", "python"].filter(Boolean).find((name) => spawnSync2(name, ["-c", "import hermes_cli, open_harness_policy"], { stdio: "ignore", timeout: 8e3 }).status === 0);
  if (!executable) throw new Error("Direct access needs the Hermes host runtime. Finish the direct-access setup on this computer.");
  const result = spawnSync2(executable, [join(import.meta.dirname, "hermes", "inspect_runtime.py")], { input: JSON.stringify(input) + "\n", encoding: "utf8", env: { ...process.env, HERMES_HOME: profileHome }, maxBuffer: 5e6, timeout: 25e3 });
  if (result.status || !result.stdout) throw new Error(result.stderr || "Direct computer access check failed.");
  const value = JSON.parse(result.stdout);
  if (value.error) throw new Error(String(value.error));
  return value;
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

// runtime/secrets.ts
import { chmodSync as chmodSync2, existsSync as existsSync3, mkdirSync as mkdirSync3, readFileSync as readFileSync2, unlinkSync, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname2 } from "node:path";
import { spawnSync as spawnSync3 } from "node:child_process";
import { createHash as createHash3 } from "node:crypto";
var service = "dev.openharness.secrets";
function command(name, args2, input) {
  return spawnSync3(name, args2, { input, encoding: "utf8", timeout: 8e3, windowsHide: true, maxBuffer: 2e6 });
}
var account = (path) => `open-harness-${createHash3("sha256").update(path).digest("hex").slice(0, 16)}`;
function loadVault(path) {
  if (process.env.OPEN_HARNESS_DISABLE_OS_VAULT === "1") return null;
  try {
    if (process.platform === "darwin") {
      const result = command("security", ["find-generic-password", "-s", service, "-a", account(path), "-w"]);
      return result.status === 0 ? { value: result.stdout.trim(), backend: "macOS Keychain" } : null;
    }
    if (process.platform === "linux" && process.env.DBUS_SESSION_BUS_ADDRESS) {
      const result = command("secret-tool", ["lookup", "application", service, "workspace", account(path)]);
      return result.status === 0 && result.stdout.trim() ? { value: result.stdout.trim(), backend: "system password vault" } : null;
    }
    if (process.platform === "win32") {
      const script = "$p=$args[0];if(Test-Path -LiteralPath $p){$b=[IO.File]::ReadAllBytes($p);$d=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($d))}";
      const result = command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, `${process.env.APPDATA || dirname2(process.execPath)}\\Open Harness\\${account(path)}.dpapi`]);
      return result.status === 0 && result.stdout ? { value: result.stdout, backend: "Windows account vault" } : null;
    }
  } catch {
  }
  return null;
}
function saveVault(path, value) {
  if (process.env.OPEN_HARNESS_DISABLE_OS_VAULT === "1") return null;
  try {
    if (process.platform === "darwin") return command("security", ["add-generic-password", "-U", "-s", service, "-a", account(path), "-w", value]).status === 0 ? "macOS Keychain" : null;
    if (process.platform === "linux" && process.env.DBUS_SESSION_BUS_ADDRESS) return command("secret-tool", ["store", "--label=Open Harness credentials", "application", service, "workspace", account(path)], value).status === 0 ? "system password vault" : null;
    if (process.platform === "win32") {
      const target = `${process.env.APPDATA || dirname2(process.execPath)}\\Open Harness\\${account(path)}.dpapi`;
      const script = "$p=$args[0];$v=[Console]::In.ReadToEnd();$d=Split-Path -Parent $p;New-Item -ItemType Directory -Force -Path $d|Out-Null;$b=[Text.Encoding]::UTF8.GetBytes($v);$e=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[IO.File]::WriteAllBytes($p,$e)";
      return command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, target], value).status === 0 ? "Windows account vault" : null;
    }
  } catch {
  }
  return null;
}
var SecretStore = class {
  constructor(path) {
    this.path = path;
    this.backend = "restricted local file";
    mkdirSync3(dirname2(path), { recursive: true });
    const vaulted = loadVault(path);
    try {
      this.values = vaulted?.value ? JSON.parse(vaulted.value) : existsSync3(path) ? JSON.parse(readFileSync2(path, "utf8")) : {};
    } catch {
      this.values = {};
    }
    if (vaulted) this.backend = vaulted.backend;
    if (!this.values.controlToken) {
      this.values.controlToken = crypto.randomUUID() + crypto.randomUUID();
      this.save();
    }
    if (existsSync3(path)) chmodSync2(path, 384);
  }
  get token() {
    return this.values.controlToken;
  }
  set(name, value) {
    if (!/^[A-Z][A-Z0-9_]{1,80}$/.test(name)) throw new Error("Invalid secret name.");
    this.values[name] = value;
    this.save();
  }
  has(name) {
    return Boolean(this.values[name]);
  }
  names() {
    return Object.keys(this.values).filter((key) => key !== "controlToken");
  }
  environment() {
    return Object.fromEntries(Object.entries(this.values).filter(([key]) => key !== "controlToken"));
  }
  save() {
    const serialized = JSON.stringify(this.values);
    const backend = saveVault(this.path, serialized);
    if (backend) {
      this.backend = backend;
      if (existsSync3(this.path)) unlinkSync(this.path);
      return;
    }
    this.backend = "restricted local file";
    writeFileSync3(this.path, JSON.stringify(this.values, null, 2), { mode: 384 });
    chmodSync2(this.path, 384);
  }
};

// lib/runner-crypto.ts
function bytes(value) {
  const binary = atob(value), output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) output[index] = binary.charCodeAt(index);
  return output;
}
async function generateRunnerKeyPair() {
  const pair2 = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt", "decrypt"]);
  return { publicKey: JSON.stringify(await crypto.subtle.exportKey("jwk", pair2.publicKey)), privateKey: JSON.stringify(await crypto.subtle.exportKey("jwk", pair2.privateKey)) };
}
async function decryptRunnerSecret(privateKey, payload) {
  if (payload.version !== 1) throw new Error("Unsupported encrypted credential version.");
  const rsa = await crypto.subtle.importKey("jwk", JSON.parse(privateKey), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"]);
  const rawKey = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, rsa, bytes(payload.key));
  const aes = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["decrypt"]);
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(payload.iv) }, aes, bytes(payload.data));
  return new TextDecoder().decode(clear);
}

// runtime/computer-validation.ts
import { accessSync, constants, statSync } from "node:fs";
function validateComputerTarget(profile, capabilities2, requiredSecrets = [], hasSecret = () => true) {
  const issues = [];
  if (profile.computer.access === "private" && !capabilities2.container) issues.push("Container execution is unavailable. Install and start Docker, then retry the transfer.");
  if (profile.computer.access === "direct" && !capabilities2.direct) issues.push(capabilities2.detail || "The Hermes host runtime is unavailable. Finish direct-access setup, then retry the transfer.");
  if (profile.computer.desktop === "existing" && !capabilities2.desktop) issues.push("The existing desktop is unavailable. Sign in to a graphical session and grant the runner the requested desktop permissions.");
  if (profile.computer.desktop === "virtual" && !capabilities2.virtualDesktop) issues.push("A private virtual desktop requires a Linux runner with container support.");
  if (profile.computer.access === "folders") {
    for (const folder of profile.computer.folders) {
      try {
        if (!statSync(folder.path).isDirectory()) throw new Error("not a directory");
        accessSync(folder.path, constants.R_OK | (folder.mode === "write" ? constants.W_OK : 0));
      } catch {
        issues.push(`${folder.path} is not an accessible ${folder.mode === "write" ? "read/write" : "read-only"} folder on this computer.`);
      }
    }
  }
  for (const name of [...new Set(requiredSecrets.filter(Boolean))]) if (!hasSecret(name)) issues.push(`Credential ${name} is missing on this computer. Add it in Agent settings, then retry the transfer.`);
  if (issues.length) throw new Error(issues.join(" "));
  return { ok: true };
}

// runtime/runner.ts
var args = /* @__PURE__ */ new Map();
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith("--")) args.set(process.argv[i].slice(2), process.argv[i + 1]?.startsWith("--") ? "" : process.argv[++i] || "");
var stateRoot = resolve3(process.env.OPEN_HARNESS_RUNNER_STATE_DIR || join3(homedir(), ".open-harness-runner"));
var credentialPath = join3(stateRoot, "connection.json");
var spool = join3(stateRoot, "spool");
mkdirSync4(spool, { recursive: true });
var runnerSecrets = new SecretStore(join3(stateRoot, "secrets.json"));
function capabilities() {
  const container = dockerStatus().available;
  const python = [process.env.HERMES_PYTHON, process.platform === "win32" ? "python" : "python3", "python"].filter(Boolean).some((executable) => spawnSync4(executable, ["-c", "import hermes_cli, open_harness_policy"], { stdio: "ignore" }).status === 0);
  return { container, direct: python, desktop: Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.platform === "darwin" || process.platform === "win32"), virtualDesktop: process.platform === "linux" && container, detail: python ? "Hermes host runtime is installed." : "Install the Hermes host runtime to enable direct access." };
}
async function pair() {
  const coordinator = String(args.get("coordinator") || "").replace(/\/$/, ""), code = String(args.get("pairing-code") || ""), sitesToken = String(args.get("sites-token") || "");
  if (!coordinator || !code) throw new Error("Use --coordinator URL and --pairing-code CODE, or keep an existing runner connection.");
  const target = new URL(coordinator), loopback = ["localhost", "127.0.0.1", "::1"].includes(target.hostname);
  if (target.protocol !== "https:" && !(target.protocol === "http:" && loopback)) throw new Error("Remote coordinators must use HTTPS. Plain HTTP is accepted only for a coordinator on this computer.");
  const encryption = await generateRunnerKeyPair();
  const response = await fetch(`${coordinator}/v1/runner/pair`, { method: "POST", headers: { "Content-Type": "application/json", ...sitesToken ? { "OAI-Sites-Authorization": `Bearer ${sitesToken}` } : {} }, body: JSON.stringify({ code, name: hostname(), platform: platform2(), arch: arch(), capabilities: capabilities(), encryptionPublicKey: encryption.publicKey }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "Pairing failed.");
  const saved = { coordinator, machineId: value.machineId, token: value.token, encryptionPublicKey: encryption.publicKey, encryptionPrivateKey: encryption.privateKey, ...sitesToken ? { sitesToken } : {} };
  writeFileSync4(credentialPath, JSON.stringify(saved, null, 2), { mode: 384 });
  chmodSync3(credentialPath, 384);
  return saved;
}
var credentials = args.has("pairing-code") ? await pair() : existsSync4(credentialPath) ? JSON.parse(readFileSync3(credentialPath, "utf8")) : await pair();
if (!credentials.encryptionPrivateKey || !credentials.encryptionPublicKey) {
  const encryption = await generateRunnerKeyPair();
  credentials = { ...credentials, encryptionPublicKey: encryption.publicKey, encryptionPrivateKey: encryption.privateKey };
  writeFileSync4(credentialPath, JSON.stringify(credentials, null, 2), { mode: 384 });
  chmodSync3(credentialPath, 384);
}
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
  if (!existsSync4(file)) writeFileSync4(file, JSON.stringify(record), { mode: 384 });
  await request(record.path, { method: "POST", body: JSON.stringify(record.body) }, true);
  if (existsSync4(file)) unlinkSync2(file);
}
async function flushSpool() {
  for (const name of readdirSync2(spool).filter((name2) => name2.endsWith(".json"))) {
    try {
      await deliver(JSON.parse(readFileSync3(join3(spool, name), "utf8")));
    } catch {
    }
  }
}
async function emit(command2, event) {
  const eventId = crypto.randomUUID();
  await deliver({ id: eventId, path: `/v1/runner/commands/${command2.id}/events`, body: { eventId, runId: command2.payload.runId, event } });
}
async function finish(command2, result, error) {
  await deliver({ id: `complete-${command2.id}`, path: `/v1/runner/commands/${command2.id}/complete`, body: error ? { error: error instanceof Error ? error.message : String(error) } : { result } });
}
async function run(command2) {
  const payload = command2.payload;
  const profile = payload.snapshot, direct = profile.computer.access === "direct";
  try {
    const agentRoot = join3(stateRoot, "agents", profile.id), shared = join3(stateRoot, "shared");
    mkdirSync4(shared, { recursive: true });
    const needed = [profile.effectiveModel.credentialRef, ...profile.connectors.filter((item) => item.enabled).map((item) => item.secretRef)].filter(Boolean);
    const availableSecrets = { ...runnerSecrets.environment(), ...process.env };
    const localSecrets = Object.fromEntries(needed.filter((name) => availableSecrets[name]).map((name) => [name, availableSecrets[name]]));
    const ephemeralSecrets = { environment: () => ({ ...localSecrets, ...payload.secrets }) };
    const coordinatorForContainer = credentials.coordinator.replace("://localhost", "://host.docker.internal").replace("://127.0.0.1", "://host.docker.internal");
    prepareProfile(stateRoot, profile, profile.effectiveModel, ephemeralSecrets, payload.coordinationToken, payload.runId, direct ? { cwd: shared, coordinationCommand: join3(import.meta.dirname, "hermes", "coordination.mjs"), controlUrl: credentials.coordinator, sitesToken: credentials.sitesToken } : { controlUrl: coordinatorForContainer, sitesToken: credentials.sitesToken });
    const gateway = direct ? new HermesGateway(`native-${profile.id}`, profile.allowedTools, { cwd: shared, entry: join3(import.meta.dirname, "hermes", "managed_entry.py"), env: { ...process.env, HERMES_HOME: join3(agentRoot, "profile"), HERMES_TUI: "1", PYTHONUNBUFFERED: "1", OPEN_HARNESS_POLICY_PATH: join3(agentRoot, "managed", "policy.json") } }) : new HermesGateway(ensureContainer(profile.id, stateRoot, profile.computer), profile.allowedTools);
    gateway.on("event", (event) => void emit(command2, event));
    await gateway.start();
    const session = await gateway.request("session.create", { cwd: direct ? shared : "/workspace/shared", profile: "default" });
    const sessionId = String(session?.session_id || session?.id || "");
    if (!sessionId) throw new Error("Hermes did not return a session ID.");
    active.set(payload.runId, { gateway, sessionId, commandId: command2.id });
    const result = await gateway.submitPrompt(sessionId, payload.prompt);
    active.delete(payload.runId);
    await finish(command2, result);
  } catch (error) {
    active.delete(payload.runId);
    await finish(command2, void 0, error);
  }
}
async function control(command2) {
  try {
    if (command2.kind === "store-secret") {
      const name = String(command2.payload.name || ""), value = await decryptRunnerSecret(credentials.encryptionPrivateKey, command2.payload.encrypted);
      runnerSecrets.set(name, value);
      await finish(command2, { stored: true, name, backend: runnerSecrets.backend });
      return;
    }
    if (command2.kind === "export-agent") {
      await finish(command2, exportAgentFiles(stateRoot, command2.agentId));
      return;
    }
    if (command2.kind === "import-agent") {
      const profile = command2.payload.profile;
      if (profile) validateComputerTarget(profile, capabilities(), Array.isArray(command2.payload.requiredSecrets) ? command2.payload.requiredSecrets.map(String) : [], (name) => runnerSecrets.has(name) || Boolean(process.env[name]));
      const bundle = command2.payload.bundle || (await request(`/v1/runner/transfers/${encodeURIComponent(command2.payload.transferId)}`)).bundle;
      const imported = importAgentFiles(stateRoot, command2.agentId, bundle);
      if (profile?.computer.desktop !== "none" && profile) {
        const check = { action: "computer", desktop: profile.computer.desktop };
        const result = profile.computer.desktop === "existing" ? nativeRuntimeProbe(join3(stateRoot, "agents", profile.id, "profile"), check) : await runtimeProbe(ensureContainer(profile.id, stateRoot, profile.computer), check);
        if (!result.ok) throw new Error(String(result.message || "Desktop control is not ready on the destination computer."));
      }
      await finish(command2, { ...imported, validated: true });
      return;
    }
    if (command2.kind.startsWith("probe-")) {
      const profile = command2.payload.profile, direct = profile.computer.access === "direct", shared = join3(stateRoot, "shared"), agentRoot = join3(stateRoot, "agents", profile.id);
      mkdirSync4(shared, { recursive: true });
      const availableSecrets = { ...runnerSecrets.environment(), ...process.env }, needed = [profile.effectiveModel.credentialRef, ...profile.connectors.filter((item) => item.enabled).map((item) => item.secretRef)].filter(Boolean), localSecrets = Object.fromEntries(needed.filter((name) => availableSecrets[name]).map((name) => [name, availableSecrets[name]])), secretSource = { environment: () => ({ ...localSecrets, ...command2.payload.secrets || {} }) };
      prepareProfile(stateRoot, profile, profile.effectiveModel, secretSource, command2.payload.coordinationToken || "", `probe-${command2.id}`, direct ? { cwd: shared, coordinationCommand: join3(import.meta.dirname, "hermes", "coordination.mjs"), controlUrl: credentials.coordinator, sitesToken: credentials.sitesToken } : { sitesToken: credentials.sitesToken });
      if (command2.kind === "probe-runtime") {
        const probeInput = { ...command2.payload.input || {} };
        if (probeInput.action === "computer") probeInput.desktop = profile.computer.desktop;
        if (probeInput.action === "connection" && !probeInput.apiKey) probeInput.apiKey = localSecrets[profile.effectiveModel.credentialRef] || "";
        if (probeInput.action === "mcp" && probeInput.env) {
          for (const name of Object.keys(probeInput.env)) if (!probeInput.env[name] && localSecrets[name]) probeInput.env[name] = localSecrets[name];
        }
        if (direct) {
          const result = spawnSync4(process.env.HERMES_PYTHON || "python3", [join3(import.meta.dirname, "hermes", "inspect_runtime.py")], { input: JSON.stringify(probeInput) + "\n", encoding: "utf8", env: { ...process.env, HERMES_HOME: join3(agentRoot, "profile") }, maxBuffer: 5e6 });
          if (result.status || !result.stdout) throw new Error(result.stderr || "Native runtime probe failed.");
          await finish(command2, JSON.parse(result.stdout));
        } else await finish(command2, await runtimeProbe(ensureContainer(profile.id, stateRoot, profile.computer), probeInput));
        return;
      }
      const gateway = direct ? new HermesGateway(`native-${profile.id}`, [], { cwd: shared, entry: join3(import.meta.dirname, "hermes", "managed_entry.py"), env: { ...process.env, HERMES_HOME: join3(agentRoot, "profile"), HERMES_TUI: "1", PYTHONUNBUFFERED: "1", OPEN_HARNESS_POLICY_PATH: join3(agentRoot, "managed", "policy.json") } }) : new HermesGateway(ensureContainer(profile.id, stateRoot, profile.computer), []);
      if (command2.kind === "probe-tools") {
        const input = direct ? (() => {
          const result = spawnSync4(process.env.HERMES_PYTHON || "python3", [join3(import.meta.dirname, "hermes", "inspect_runtime.py")], { input: '{"action":"catalog"}\n', encoding: "utf8", env: { ...process.env, HERMES_HOME: join3(agentRoot, "profile") }, maxBuffer: 5e6 });
          if (result.status || !result.stdout) throw new Error(result.stderr || "Tool discovery failed.");
          return JSON.parse(result.stdout);
        })() : await runtimeProbe(ensureContainer(profile.id, stateRoot, profile.computer), { action: "catalog" });
        await finish(command2, { source: "runtime", tools: [...(input.tools || []).filter((tool) => tool.group !== "cronjob").map(groupTool), ...COORDINATION_TOOLS] });
        return;
      }
      await gateway.start();
      try {
        await finish(command2, await discoverModels(gateway));
      } finally {
        await gateway.stop();
      }
      return;
    }
    const live = active.get(String(command2.payload.runId));
    if (!live) throw new Error("The requested run is no longer active on this runner.");
    if (command2.kind === "stop") {
      await live.gateway.request("session.interrupt", { session_id: live.sessionId }, 5e3).catch(() => {
      });
      await live.gateway.stop();
    }
    if (command2.kind === "steer") await live.gateway.request("session.steer", { session_id: live.sessionId, text: String(command2.payload.text || "") });
    if (command2.kind === "approval") await live.gateway.request("approval.respond", { request_id: command2.payload.requestId, decision: command2.payload.decision });
    await finish(command2, { ok: true });
  } catch (error) {
    await finish(command2, void 0, error);
  }
}
console.log(`Open Harness runner ${credentials.machineId} connected to ${credentials.coordinator}`);
await flushSpool();
var lastHeartbeat = 0;
for (; ; ) {
  try {
    if (Date.now() - lastHeartbeat > 15e3) {
      await request("/v1/runner/heartbeat", { method: "POST", body: JSON.stringify({ capabilities: capabilities(), encryptionPublicKey: credentials.encryptionPublicKey, activeCommandIds: [.../* @__PURE__ */ new Set([...admittedCommands, ...[...active.values()].map((item) => item.commandId)])] }) });
      lastHeartbeat = Date.now();
    }
    const result = await request("/v1/runner/commands");
    for (const command2 of result.commands) {
      if (admittedCommands.has(command2.id)) continue;
      admittedCommands.add(command2.id);
      void (command2.kind === "run" ? run(command2) : control(command2)).finally(() => admittedCommands.delete(command2.id));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  }
  await new Promise((resolve4) => setTimeout(resolve4, 1e3));
}
