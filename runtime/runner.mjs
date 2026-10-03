import { createRequire as __openHarnessCreateRequire } from 'node:module'; const require = __openHarnessCreateRequire(import.meta.url);

// runtime/runner.ts
import { existsSync as existsSync6, mkdirSync as mkdirSync7, readFileSync as readFileSync8, writeFileSync as writeFileSync7, chmodSync as chmodSync3, readdirSync as readdirSync3, unlinkSync as unlinkSync2 } from "node:fs";
import { homedir, hostname, platform as platform2, arch } from "node:os";
import { join as join4, resolve as resolve4 } from "node:path";
import { spawn as spawn4 } from "node:child_process";

// runtime/hermes.ts
import { spawn as spawn2, spawnSync as spawnSync3 } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { createHash, randomUUID as randomUUID2 } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve as resolve3 } from "node:path";

// runtime/readiness.ts
import { spawn, spawnSync } from "node:child_process";

// lib/hermes-pin.ts
var HERMES_RELEASE = "v2026.9.11";
var HERMES_IMAGE_TAG = HERMES_RELEASE.replace(/^v/, "");

// runtime/readiness.ts
var HERMES_IMAGE = process.env.OPEN_HARNESS_HERMES_IMAGE || `open-harness-hermes:${HERMES_IMAGE_TAG}`;
var RUNTIME_CONTRACT = 7;
var RUNTIME_LABEL = "dev.openharness.runtime";
function classifyContract(result) {
  if (result.status !== 0) return "missing";
  return result.stdout.trim() === String(RUNTIME_CONTRACT) ? "current" : "stale";
}
function imageContract(run2 = command) {
  return classifyContract(run2("docker", ["image", "inspect", "-f", `{{index .Config.Labels "${RUNTIME_LABEL}"}}`, HERMES_IMAGE]));
}
var platform = ["linux", "darwin", "win32"].includes(process.platform) ? process.platform : "unknown";
function command(name, args2, timeout = 7e3) {
  return spawnSync(name, args2, { encoding: "utf8", timeout });
}

// runtime/computer-validation.ts
import { accessSync, constants, existsSync, lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";

// lib/agent-profile.ts
var UNSANDBOXED_COMPUTER_MESSAGE = "Direct access to the signed-in computer is not sandboxed and is disabled. Open Agent settings \u2192 Computer and choose a private workspace or private agent desktop.";
function isSandboxedComputer(computer) {
  return ["private", "folders"].includes(computer.access) && ["none", "virtual"].includes(computer.desktop);
}
var MCP_PREFIX = "mcp__";
var COORDINATION_SERVER = "open_harness";
function mcpToolId(server, tool) {
  return `${MCP_PREFIX}${server}__${tool}`;
}
var TASK_TOOL = mcpToolId(COORDINATION_SERVER, "task");
var HANDOFF_TOOL = mcpToolId(COORDINATION_SERVER, "delegate_named_agent");
var ROUTINE_TOOL = mcpToolId(COORDINATION_SERVER, "create_open_harness_routine");

// runtime/host-folders.ts
import { readFileSync } from "node:fs";
import { posix } from "node:path";
function parseHostFolderMounts(mountinfo) {
  const mounts = /* @__PURE__ */ new Map();
  for (const line of mountinfo.split("\n")) {
    const fields = line.split(" "), path2 = fields[4]?.replace(/\\(040|011|012|134)/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    if (!path2?.startsWith("/host-folders/") || !fields.includes("-") || !fields[5]) continue;
    mounts.set(path2, fields[5].split(",").includes("ro") ? "read" : "write");
  }
  return [...mounts].map(([path2, mode]) => ({ path: path2, mode })).sort((a, b) => b.path.length - a.path.length);
}
function hostFolderExports() {
  if (process.env.OPEN_HARNESS_DEPLOYMENT !== "compose") return void 0;
  try {
    return parseHostFolderMounts(readFileSync("/proc/self/mountinfo", "utf8"));
  } catch {
    return [];
  }
}
function validateFolderExport(path2, mode, exports = hostFolderExports()) {
  if (!exports) return;
  const resolved = posix.resolve(path2);
  const grant = exports.find((folder) => resolved === folder.path);
  if (!grant) throw new Error("This exact folder has not been shared with Open Harness. Add it to both services in your host-folder Compose override, then select its /host-folders/ path. To select a subfolder, export that subfolder separately.");
  if (mode === "write" && grant.mode === "read") throw new Error(`This folder is shared read-only with Open Harness: ${grant.path}. Choose read-only access for this agent.`);
}

// runtime/computer-validation.ts
function assertSandboxedComputer(computer) {
  if (computer && !isSandboxedComputer(computer)) throw new Error(UNSANDBOXED_COMPUTER_MESSAGE);
}
function sharedFolderSource(value, mode = "read") {
  const source = resolve(value);
  validateFolderExport(source, mode);
  if (!existsSync(source)) throw new Error(`Shared folder does not exist on this computer: ${value}`);
  for (let current = source; ; current = dirname(current)) {
    const info = lstatSync(current);
    if (info.isSymbolicLink()) throw new Error(`Shared folders cannot contain symbolic links. Select the real folder path: ${value}`);
    if (current === source && !info.isDirectory()) throw new Error(`Shared folder is not a directory: ${value}`);
    if (dirname(current) === current) break;
  }
  return source;
}
function validateComputerTarget(profile, capabilities2, requiredSecrets = [], hasSecret = () => true) {
  assertSandboxedComputer(profile.computer);
  const issues = [];
  if (profile.computer.access !== "direct" && !capabilities2.container) issues.push("Container execution is unavailable. Install and start Docker, then retry the transfer.");
  if (profile.computer.desktop === "virtual" && !capabilities2.virtualDesktop) issues.push("A private virtual desktop requires a Linux runner with container support.");
  if (profile.computer.access === "folders") {
    for (const folder of profile.computer.folders) {
      try {
        accessSync(sharedFolderSource(folder.path, folder.mode), constants.R_OK | (folder.mode === "write" ? constants.W_OK : 0));
      } catch (error) {
        issues.push(`${folder.path} is not an accessible ${folder.mode === "write" ? "read/write" : "read-only"} folder on this computer.${process.env.OPEN_HARNESS_DEPLOYMENT === "compose" && error instanceof Error ? ` ${error.message}` : ""}`);
      }
    }
  }
  for (const name of [...new Set(requiredSecrets.filter(Boolean))]) if (!hasSecret(name)) issues.push(`Credential ${name} is missing on this computer. Add it in Agent settings, then retry the transfer.`);
  if (issues.length) throw new Error(issues.join(" "));
  return { ok: true };
}

// runtime/folder-mounts.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants as constants2, fstatSync, openSync, readFileSync as readFileSync2 } from "node:fs";
import { resolve as resolve2 } from "node:path";
var NATIVE_FOLDER_GUIDANCE = "Selected host folders require Open Harness and Docker to use the same Linux kernel. Use the local browser Compose installation with explicitly exported folders, or a native Linux runner.";
var BOOT_ID = "/proc/sys/kernel/random/boot_id";
var UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
var CONTAINER_ID = /^[a-f0-9]{64}$/;
var ATTEMPT_LABEL = "open-harness.folder-attempt";
var docker = (args2, timeout) => spawnSync2("docker", args2, { encoding: "utf8", timeout, maxBuffer: 1024 * 1024 });
function requiresFolderVerification(computer) {
  return process.env.OPEN_HARNESS_DEPLOYMENT !== "compose" && computer.access === "folders" && computer.folders.length > 0;
}
function pinDirectory(path2) {
  const flags = constants2.O_RDONLY | constants2.O_DIRECTORY | constants2.O_NOFOLLOW;
  let fd = openSync("/", flags);
  try {
    for (const component of resolve2(path2).split("/").filter(Boolean)) {
      const next = openSync(`/proc/self/fd/${fd}/${component}`, flags);
      closeSync(fd);
      fd = next;
    }
    const info = fstatSync(fd, { bigint: true });
    if (!info.isDirectory()) throw new Error("not a directory");
    return { fd, device: String(info.dev), inode: String(info.ino) };
  } catch (error) {
    closeSync(fd);
    throw new Error(`Could not safely open selected folder ${path2}. Select an existing directory without symbolic links. ${error instanceof Error ? error.message : ""}`);
  }
}
function pinSelectedFolders(folders) {
  if (process.platform !== "linux") throw new Error(NATIVE_FOLDER_GUIDANCE);
  let bootId;
  try {
    bootId = readFileSync2(BOOT_ID, "utf8").trim();
  } catch {
    throw new Error(NATIVE_FOLDER_GUIDANCE);
  }
  if (!UUID.test(bootId)) throw new Error(NATIVE_FOLDER_GUIDANCE);
  const fds = [], mounts = [];
  const close = () => {
    for (const fd of fds.splice(0)) closeSync(fd);
  };
  try {
    folders.forEach((folder, index) => {
      const pinned = pinDirectory(folder.path);
      fds.push(pinned.fd);
      mounts.push({ path: `/workspace/mounts/folder-${index + 1}`, device: pinned.device, inode: pinned.inode, readOnly: folder.mode === "read" });
    });
    return { bootId, mounts, close };
  } catch (error) {
    close();
    throw error;
  }
}
var FOLDER_VERIFIER = `import json, os, stat, sys
with open('/proc/sys/kernel/random/boot_id', encoding='ascii') as file:
    boot_id = file.read().strip()
with open('/proc/self/mountinfo', 'rb') as file:
    mountinfo = [line.split(b' ') for line in file]
mounts = []
for path in json.loads(sys.argv[1]):
    info = os.stat(path, follow_symlinks=False)
    if not stat.S_ISDIR(info.st_mode):
        raise ValueError('Selected mount is not a directory')
    options = [fields[5].split(b',') for fields in mountinfo if len(fields) > 5 and fields[4] == os.fsencode(path)]
    if len(options) != 1 or (b'ro' in options[0]) == (b'rw' in options[0]):
        raise ValueError('Selected mount has no unambiguous access mode')
    # QEMU user mode can report host filesystem flags for a read-only bind; mountinfo records per-mount flags.
    mounts.append({'path': path, 'device': str(info.st_dev), 'inode': str(info.st_ino), 'readOnly': b'ro' in options[0]})
print(json.dumps({'bootId': boot_id, 'mounts': mounts}))
`;
function verifyFolderMounts(pinned, output2) {
  let value;
  try {
    value = JSON.parse(output2);
  } catch {
    throw new Error("Docker returned invalid selected-folder verification. No agent was started.");
  }
  if (!value || value.bootId !== pinned.bootId) throw new Error(NATIVE_FOLDER_GUIDANCE);
  const mounts = value.mounts;
  if (!Array.isArray(mounts) || mounts.length !== pinned.mounts.length) throw new Error("Docker did not verify every selected folder. No agent was started.");
  for (const [index, expected] of pinned.mounts.entries()) {
    const actual = mounts[index];
    if (!actual || actual.path !== expected.path || actual.device !== expected.device || actual.inode !== expected.inode || actual.readOnly !== expected.readOnly) {
      throw new Error(`Docker could not confirm the selected folder and its access mode at ${expected.path}. Re-select the folder and retry. No agent was started.`);
    }
  }
}
function checked(command3, args2, timeout, description) {
  const result = command3(args2, timeout);
  if (result.status !== 0) throw new Error(`${description}: ${result.error?.message || result.stderr.trim() || "Docker did not complete the request."}`);
  return result.stdout.trim();
}
function createVerifiedFolderContainer(args2, pinned, desktop, command3 = docker) {
  const attempt = randomUUID(), name = args2[args2.indexOf("--name") + 1];
  let id = "";
  try {
    id = checked(command3, ["create", "--restart", "no", "--entrypoint", "/usr/bin/tini", "--label", `${ATTEMPT_LABEL}=${attempt}`, ...args2, "--", "/bin/sleep", "infinity"], 3e4, "Could not create the selected-folder container");
    if (!CONTAINER_ID.test(id)) {
      id = "";
      throw new Error("Docker did not return a valid selected-folder container ID.");
    }
    checked(command3, ["start", id], 2e4, "Could not start the selected-folder container");
    const result = checked(command3, ["exec", "--workdir", "/", id, "/usr/local/bin/python", "-I", "-S", "-c", FOLDER_VERIFIER, JSON.stringify(pinned.mounts.map((mount) => mount.path))], 15e3, "Could not verify selected folders");
    verifyFolderMounts(pinned, result);
    if (desktop) checked(command3, ["exec", "--workdir", "/", id, "/opt/open-harness/container-init.sh", "--init-only"], 45e3, "Could not initialize the private desktop");
    return id;
  } catch (error) {
    let cleanupError = "";
    try {
      if (!id && name) {
        const inspected = command3(["inspect", "-f", "{{json .}}", name], 1e4);
        if (inspected.status === 0) {
          const candidate = JSON.parse(inspected.stdout);
          if (candidate?.Config?.Labels?.[ATTEMPT_LABEL] === attempt && CONTAINER_ID.test(candidate.Id)) id = candidate.Id;
        } else if (!/No such (?:object|container)/i.test(inspected.stderr)) throw new Error(inspected.error?.message || inspected.stderr.trim() || "Docker could not check the incomplete creation.");
      }
      if (id) checked(command3, ["rm", "-f", id], 2e4, "Could not remove the unverified selected-folder container");
    } catch (failure2) {
      cleanupError = ` Cleanup could not be confirmed: ${failure2 instanceof Error ? failure2.message : failure2}`;
    }
    throw new Error(`${error instanceof Error ? error.message : error}${cleanupError}`);
  } finally {
    pinned.close();
  }
}

// runtime/hermes.ts
var FIRST_SETUP_MESSAGE = "Docker is ready, but the pinned Hermes runtime still needs its first-time setup.";
var STALE_IMAGE_MESSAGE = "Docker is ready, but the agent runtime on this computer was built before a fix. Open Settings \u2192 Readiness and update it.";
function lastWords(stderrTail, keep = 3, limit = 400) {
  const lines = stderrTail.filter((line) => line.trim()).slice(-keep);
  if (!lines.length) return "";
  const text = lines.join(" | ");
  return ` Last output: ${text.length > limit ? `\u2026${text.slice(-limit)}` : text}`;
}
var GATEWAY_ENV = ["-e", "HERMES_GATEWAY_SESSION=1"];
function hermesApprovalDecision(decision) {
  return decision === "approve" || decision === "once" ? "once" : decision === "session" || decision === "always" ? decision : "deny";
}
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
    this.mockInput = null;
    this.mockSessions = /* @__PURE__ */ new Map();
    this.stopping = null;
    this.stopped = false;
    // Hermes reports its failures on stderr and then dies. Without a copy, the exit
    // code is all that survives, and "exited with code 1" tells an operator nothing.
    this.stderrTail = [];
  }
  async start() {
    if (this.native) throw new Error(UNSANDBOXED_COMPUTER_MESSAGE);
    if (this.stopping) await this.stopping;
    this.stopped = false;
    if (process.env.OPEN_HARNESS_MOCK === "1") {
      queueMicrotask(() => this.emit("event", { type: "gateway.ready", payload: { mock: true } }));
      return;
    }
    if (this.child && !this.child.killed) return;
    const child = this.child = spawn2("docker", ["exec", "-i", ...GATEWAY_ENV, this.container, "python", "/opt/open-harness/managed_entry.py"], { stdio: ["pipe", "pipe", "pipe"] });
    let exited = false;
    const failed = (error) => {
      if (exited) return;
      exited = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      if (this.child === child) this.child = null;
      this.emit("exit", error);
    };
    child.once("error", (error) => failed(new Error(`Could not start the Hermes ${this.native ? "host" : "container"} gateway: ${error.message}`)));
    child.stdin.on("error", (error) => failed(Object.assign(new Error(`Hermes gateway input failed: ${error.message}`), { interrupted: true })));
    createInterface({ input: child.stdout }).on("line", (line) => {
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
    this.stderrTail = [];
    createInterface({ input: child.stderr }).on("line", (line) => {
      const message = line.slice(0, 1e3);
      this.stderrTail.push(message);
      if (this.stderrTail.length > 50) this.stderrTail.shift();
      this.emit("log", { level: "debug", message });
    });
    child.once("exit", (code) => {
      const error = Object.assign(new Error(`Hermes ${this.native ? "host" : "container"} gateway exited with code ${code ?? "unknown"}.${lastWords(this.stderrTail)} Inspect its saved work before retrying.`), { interrupted: true });
      failed(error);
    });
    try {
      await new Promise((resolve5, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          this.off("event", ready);
          this.off("exit", fail);
        };
        const fail = (error) => {
          cleanup();
          reject(error);
        };
        const ready = (event) => {
          if (event?.type === "gateway.ready") {
            cleanup();
            resolve5();
          }
        };
        const timer = setTimeout(() => fail(new Error("Hermes gateway did not become ready.")), 3e4);
        this.on("event", ready);
        this.once("exit", fail);
      });
    } catch (error) {
      try {
        await this.stop();
      } catch (cleanupError) {
        throw new Error(`${error instanceof Error ? error.message : error} Cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : cleanupError}`);
      }
      throw error;
    }
  }
  request(method, params = {}, timeout = 3e5) {
    if (process.env.OPEN_HARNESS_MOCK === "1") return this.mockRequest(method, params);
    if (!this.child) return Promise.reject(new Error("Hermes gateway is not running."));
    const id = String(++this.requestId);
    return new Promise((resolve5, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out.`));
      }, timeout);
      this.pending.set(id, { resolve: resolve5, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  submitPrompt(sessionId, text, timeout = 24 * 60 * 60 * 1e3) {
    return new Promise((resolve5, reject) => {
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
            resolve5(payload);
          }
        }
      };
      const timer = setTimeout(() => onExit(Object.assign(new Error("Hermes completion was not confirmed. Inspect the session before retrying."), { interrupted: true })), timeout);
      this.on("event", onEvent);
      this.on("exit", onExit);
      this.request("prompt.submit", { session_id: sessionId, text }, timeout).then((result) => {
        if (result?.status !== "streaming") {
          cleanup();
          resolve5(result);
        }
      }, onExit);
    });
  }
  async mockRequest(method, params) {
    if (method === "session.create") {
      const sessionId = crypto.randomUUID();
      this.mockSessions.set(sessionId, Array.isArray(params.messages) ? params.messages : []);
      return { session_id: sessionId };
    }
    if (method === "prompt.submit") {
      const prompt = String(params.text || "");
      if (prompt.includes("MOCK_HISTORY")) return { final_response: JSON.stringify(this.mockSessions.get(String(params.session_id)) || []) };
      if (prompt.includes("MOCK_TOOL:")) {
        const name = prompt.split("MOCK_TOOL:")[1].split(/\s/)[0];
        if (!this.allowedTools?.includes(name)) throw new Error(`Tool ${name} is disabled in this agent profile.`);
      }
      const canUseTerminal = this.allowedTools === null || this.allowedTools.includes("terminal");
      if (canUseTerminal) this.emit("event", { type: "tool.start", payload: { id: "mock-tool", name: "terminal", preview: "python task.py" } });
      if (prompt.includes("MOCK_SLOW")) await new Promise((resolve5) => setTimeout(resolve5, 800));
      if (prompt.includes("MOCK_APPROVAL")) {
        this.emit("event", { type: "approval.request", payload: { request_id: "mock-approval", command: "publish mock result" } });
        const decision = await new Promise((resolve5) => {
          this.mockApproval = resolve5;
        });
        if (decision === "deny") throw new Error("Mock action was denied.");
      }
      if (prompt.includes("MOCK_CLARIFY")) {
        this.emit("event", { type: "clarify.request", session_id: params.session_id, payload: { request_id: "mock-clarify", question: "What should I use?" } });
        const answer = await new Promise((resolve5) => {
          this.mockInput = resolve5;
        });
        return { final_response: `Hermes mock completed the task. Answer: ${Array.isArray(answer) ? answer.join(", ") : String(answer)}` };
      }
      if (canUseTerminal) this.emit("event", { type: "tool.complete", payload: { id: "mock-tool", name: "terminal", result: "Created and executed task.py" } });
      this.emit("event", { type: "message.delta", payload: { text: "Hermes mock completed the task." } });
      return { final_response: "Hermes mock completed the task." };
    }
    if (method === "approval.respond") {
      this.mockApproval?.(String(params.choice));
      this.mockApproval = null;
      return { resolved: 1 };
    }
    if (method === "clarify.respond") {
      this.mockInput?.(params.answer);
      this.mockInput = null;
      return { ok: true };
    }
    if (["session.steer", "session.interrupt", "process.stop"].includes(method)) return { ok: true };
    return { ok: true };
  }
  stop() {
    if (this.stopped) return Promise.resolve();
    return this.stopping ??= this.stopRuntime().finally(() => {
      this.stopping = null;
    });
  }
  async stopRuntime() {
    if (process.env.OPEN_HARNESS_MOCK !== "1" && !this.native) await new Promise((resolve5, reject) => {
      const child = spawn2("docker", ["stop", "--time", "2", this.container], { stdio: "ignore", timeout: 1e4, killSignal: "SIGKILL" });
      child.once("error", () => reject(new Error("Could not stop the agent container. Check Docker.")));
      child.once("exit", (code) => code === 0 ? resolve5() : reject(new Error("Docker could not confirm the agent container stopped.")));
    });
    this.mockApproval?.("deny");
    this.mockApproval = null;
    this.mockInput?.("");
    this.mockInput = null;
    this.child?.kill("SIGTERM");
    this.child = null;
    this.stopped = true;
    this.emit("exit", Object.assign(new Error("Agent runtime stopped."), { interrupted: true }));
  }
};
var sharingCache = null;
function stateSharing(stateRoot2) {
  if (process.env.OPEN_HARNESS_MOCK === "1") return { ok: true, detail: "Deterministic test runtime shares state directly." };
  const root = resolve3(stateRoot2);
  if (sharingCache?.root === root) return sharingCache.value;
  let value;
  try {
    const dir = join(root, ".mount-probe");
    mkdirSync(dir, { recursive: true });
    const token = randomUUID2();
    writeFileSync(join(dir, "canary"), token, { mode: 420 });
    const result = spawnSync3("docker", [
      "run",
      "--rm",
      "--user",
      `${process.getuid?.() ?? 1e3}:${process.getgid?.() ?? 1e3}`,
      "-v",
      `${dir}:/probe:ro`,
      HERMES_IMAGE,
      "cat",
      "/probe/canary"
    ], { encoding: "utf8", timeout: 6e4 });
    value = result.stdout.trim() === token ? { ok: true, detail: "Docker can read the Open Harness data folder." } : { ok: false, detail: `Docker cannot read the Open Harness data folder at ${root}, so agent containers would start with an empty profile and never receive your model credential. Add this folder to Docker Desktop \u2192 Settings \u2192 Resources \u2192 File sharing, or set OPEN_HARNESS_STATE_DIR to a folder inside your home directory.` };
  } catch {
    value = { ok: false, detail: `Open Harness could not verify that Docker can read its data folder at ${root}.` };
  }
  sharingCache = { root, value };
  return value;
}
function containerSignature(selected, imageId, stateRoot2 = "") {
  return createHash("sha256").update(JSON.stringify({ access: selected.access, folders: selected.folders, desktop: selected.desktop, resources: selected.resources, imageId, stateRoot: stateRoot2 && resolve3(stateRoot2), ...requiresFolderVerification(selected) ? { folderStartup: "verified-inert-v1" } : {} })).digest("hex").slice(0, 24);
}
var imageIdCache = null;
function currentImageId() {
  if (imageIdCache && Date.now() - imageIdCache.at < 5e3) return imageIdCache.id;
  const result = spawnSync3("docker", ["image", "inspect", "-f", "{{.Id}}", HERMES_IMAGE], { encoding: "utf8", timeout: 1e4 });
  imageIdCache = { id: result.status === 0 ? result.stdout.trim() : "", at: Date.now() };
  return imageIdCache.id;
}
var MANAGED_LABEL = "open-harness.managed";
var STATE_LABEL = "open-harness.state";
function containerStateKey(stateRoot2) {
  return createHash("sha256").update(resolve3(stateRoot2)).digest("hex").slice(0, 24);
}
function agentContainerNames(agentId, stateRoot2) {
  const safe = agentId.replace(/[^a-zA-Z0-9_.-]/g, "-"), base = `open-harness-${safe}`;
  return { safe, names: [base, `${base}-${containerStateKey(stateRoot2).slice(0, 12)}`] };
}
function inspectedContainer(code, stdout, stderr, name) {
  if (code !== 0) {
    if (/No such (?:object|container)/i.test(stderr)) return null;
    throw new Error(stderr.trim() || `Docker could not inspect agent container ${name}. Check the Docker daemon.`);
  }
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error(`Docker returned invalid details for agent container ${name}.`);
  }
  if (!value?.Id || !value.State || !value.Config) throw new Error(`Docker returned incomplete details for agent container ${name}.`);
  return value;
}
function ownsContainer(container, safe, stateRoot2) {
  const labels = container.Config.Labels || {};
  if (labels[MANAGED_LABEL] !== "1") return false;
  if (labels[STATE_LABEL] !== void 0) return labels[STATE_LABEL] === containerStateKey(stateRoot2);
  const expected = /* @__PURE__ */ new Map([
    ["/run/open-harness", join(stateRoot2, "agents", safe, "managed")],
    ["/home/hermes/.hermes", join(stateRoot2, "agents", safe, "profile")],
    ["/workspace/private", join(stateRoot2, "agents", safe, "private")],
    ["/workspace/shared", join(stateRoot2, "shared")]
  ]);
  return [...expected].every(([destination, source]) => container.Mounts?.some((mount) => mount.Destination === destination && resolve3(mount.Source) === resolve3(source)));
}
function inspectContainer(name) {
  const result = spawnSync3("docker", ["inspect", "-f", "{{json .}}", name], { encoding: "utf8", timeout: 1e4 });
  return inspectedContainer(result.status, result.stdout || "", result.stderr || "", name);
}
function ensureContainer(agentId, stateRoot2, computer) {
  assertSandboxedComputer(computer);
  if (process.env.OPEN_HARNESS_MOCK === "1") return `mock-${agentId}`;
  const sharing = stateSharing(stateRoot2);
  if (!sharing.ok) throw new Error(sharing.detail);
  const contract = imageContract();
  if (contract !== "current") throw new Error(contract === "missing" ? FIRST_SETUP_MESSAGE : STALE_IMAGE_MESSAGE);
  const { safe, names } = agentContainerNames(agentId, stateRoot2);
  const selected = computer || { machineId: "local", access: "private", folders: [], desktop: "none", reserveMachine: false, resources: { cpu: 2, memoryMb: 4096, concurrency: 4 } };
  const mounts = [];
  if (selected.access === "folders") selected.folders.forEach((folder, index) => {
    const source = sharedFolderSource(folder.path, folder.mode);
    mounts.push("-v", `${source}:/workspace/mounts/folder-${index + 1}${folder.mode === "read" ? ":ro" : ""}`);
  });
  const pinned = requiresFolderVerification(selected) ? pinSelectedFolders(selected.folders) : null;
  try {
    const signature = containerSignature(selected, currentImageId(), stateRoot2);
    let name = names[0], container = inspectContainer(name);
    if (!container || !ownsContainer(container, safe, stateRoot2)) {
      const alternate = inspectContainer(names[1]);
      if (alternate && !ownsContainer(alternate, safe, stateRoot2)) throw new Error(`Agent container ${names[1]} belongs to another workspace. Choose a different agent ID or remove the conflicting container yourself.`);
      if (container || alternate) {
        name = names[1];
        container = alternate;
      }
    }
    if (container) {
      if (pinned || container.Config.Labels?.["open-harness.config"] !== signature || !container.Config.Labels?.[STATE_LABEL]) {
        const removed = spawnSync3("docker", ["rm", "-f", container.Id], { encoding: "utf8", timeout: 2e4 });
        if (removed.status !== 0) throw new Error(removed.stderr?.trim() || "Could not replace the previous agent container. Check the Docker daemon.");
      } else if (!container.State.Running) {
        const started = spawnSync3("docker", ["start", container.Id], { encoding: "utf8", timeout: 2e4 });
        if (started.status !== 0) throw new Error(started.error?.code === "ETIMEDOUT" ? "Docker did not respond within 20s. Check the Docker daemon." : started.stderr.trim() || "Could not start the agent container.");
        return name;
      } else return name;
    }
    const profile = `${stateRoot2}/agents/${safe}/profile`, privateDir = `${stateRoot2}/agents/${safe}/private`, shared = `${stateRoot2}/shared`;
    const args2 = [
      "--name",
      name,
      "--label",
      `open-harness.config=${signature}`,
      "--label",
      `${MANAGED_LABEL}=1`,
      "--label",
      `${STATE_LABEL}=${containerStateKey(stateRoot2)}`,
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
    ];
    if (pinned) return createVerifiedFolderContainer(args2, pinned, selected.desktop === "virtual");
    const run2 = spawnSync3("docker", ["run", "-d", "--restart", "unless-stopped", ...args2], { encoding: "utf8", timeout: 3e4 });
    if (run2.status !== 0) throw new Error(run2.error?.code === "ETIMEDOUT" ? "Docker did not respond within 30s. Check the Docker daemon." : run2.stderr.trim() || "Could not create the private agent workspace. Open Readiness in Settings and finish setup.");
    return name;
  } finally {
    pinned?.close();
  }
}

// runtime/profile-runtime.ts
import { spawn as spawn3 } from "node:child_process";
import { copyFileSync, mkdirSync as mkdirSync3, chmodSync } from "node:fs";
import { join as join2 } from "node:path";

// runtime/profile-memory.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync4, writeFileSync as writeFileSync3 } from "node:fs";

// runtime/path-safety.ts
import { closeSync as closeSync2, constants as constants3, fstatSync as fstatSync2, lstatSync as lstatSync2, openSync as openSync2, readFileSync as readFileSync3, renameSync, rmSync, writeFileSync as writeFileSync2 } from "node:fs";
import { randomUUID as randomUUID3 } from "node:crypto";
import path from "node:path";
function atomicWorkspaceWrite(target, data) {
  const temporary = `${target}.${randomUUID3()}.tmp`;
  try {
    writeFileSync2(temporary, data, { mode: 384, flag: "wx" });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}
function resolveContainedPath(root, name, paths = path) {
  if (!name || name.includes("\0") || name.includes(":") || path.posix.isAbsolute(name) || path.win32.isAbsolute(name)) throw new Error("Invalid workspace path.");
  const parts = name.replaceAll("\\", "/").split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("Invalid workspace path.");
  if (parts.some((part) => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) throw new Error("Invalid portable workspace path.");
  const target = paths.resolve(root, parts.join(paths.sep));
  const relative2 = paths.relative(paths.resolve(root), target);
  if (!relative2 || relative2 === ".." || relative2.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative2)) throw new Error("Path escaped the workspace.");
  return target;
}
function safeWorkspacePath(root, name) {
  const target = resolveContainedPath(root, name);
  const parts = path.relative(path.resolve(root), target).split(path.sep);
  let current = path.resolve(root);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try {
      stat = lstatSync2(current);
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error("Workspace paths cannot contain symbolic links.");
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error("Workspace parent is not a directory.");
  }
  return target;
}

// runtime/profiles.ts
var ProfileError = class extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
};
function validId(id) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) throw new ProfileError("Invalid agent ID.");
  return id;
}

// runtime/profile-memory.ts
function profileMemory(root, agentId) {
  const profile = `agents/${validId(agentId)}/profile`;
  const directory = safeWorkspacePath(root, `${profile}/memories`);
  mkdirSync2(directory, { recursive: true });
  const paths = { memory: "", user: "" };
  for (const [key, file] of [["memory", "MEMORY.md"], ["user", "USER.md"]]) {
    const target = safeWorkspacePath(root, `${profile}/memories/${file}`);
    const legacy = safeWorkspacePath(root, `${profile}/${file}`);
    if (!existsSync2(target) && existsSync2(legacy)) {
      try {
        writeFileSync3(target, readFileSync4(legacy), { flag: "wx", mode: 384 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    paths[key] = target;
  }
  return paths;
}

// runtime/model-validation.ts
var endpoints = {
  xai: "https://api.x.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1"
};
var COMPOSE_LOCAL_MODEL_MESSAGE = "This Docker browser installation cannot use localhost or Docker host aliases for a model server on your computer. Use a hosted provider or a model server network address reachable from both the coordinator and agent containers.";
function modelEndpointIssue(baseUrl) {
  if (process.env.OPEN_HARNESS_DEPLOYMENT !== "compose" || !baseUrl) return null;
  let host;
  try {
    host = new URL(baseUrl).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
  return host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || ["0.0.0.0", "[::]", "[::1]", "host.docker.internal", "gateway.docker.internal", "[::ffff:0:0]"].includes(host) || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host) ? COMPOSE_LOCAL_MODEL_MESSAGE : null;
}
async function failure(response, key) {
  const fallback = { 401: "The API key was rejected.", 402: "The provider account needs credits.", 403: "The provider denied access.", 404: "The model server address was not found.", 429: "The provider rate limit was reached. Try again shortly." };
  try {
    const body = await response.json();
    const detail = typeof body.error === "string" ? body.error : body.error?.message || body.message;
    if (detail) return (key ? String(detail).replaceAll(key, "[redacted]") : String(detail)).trim().slice(0, 500);
  } catch {
  }
  return fallback[response.status] || `The provider returned HTTP ${response.status}.`;
}
async function testModelConnection(model, apiKey) {
  const base = (model.baseUrl || endpoints[model.provider] || "").replace(/\/$/, "");
  const endpointIssue = modelEndpointIssue(base);
  if (endpointIssue) return { ok: false, message: endpointIssue };
  if (process.env.OPEN_HARNESS_MOCK === "1") return { ok: false, message: "Mock mode is active, so no model provider was contacted. Restart with npm run dev to test this API key and run real tasks." };
  if (!base) return { ok: false, message: "Enter the address of your model server." };
  if (!apiKey && !["local", "custom"].includes(model.provider)) return { ok: false, message: "Enter an API key for this provider." };
  const anthropic = model.provider === "anthropic" && !model.baseUrl;
  const headers2 = { "Content-Type": "application/json", ...anthropic ? { "anthropic-version": "2023-06-01", "x-api-key": apiKey } : apiKey ? { Authorization: `Bearer ${apiKey}` } : {} };
  try {
    const catalog = await fetch(`${base}/models`, { headers: headers2, signal: AbortSignal.timeout(15e3), redirect: "error" });
    if (!catalog.ok) return { ok: false, message: await failure(catalog, apiKey) };
    const rows = await catalog.json();
    if (!Array.isArray(rows.data) || !rows.data.some((row) => row.id === model.model)) return { ok: false, message: `The provider connection works, but model ${model.model} is not available to this API key.` };
    const completion = await fetch(`${base}/${anthropic ? "messages" : "chat/completions"}`, {
      method: "POST",
      headers: headers2,
      signal: AbortSignal.timeout(3e4),
      redirect: "error",
      body: JSON.stringify({ model: model.model, messages: [{ role: "user", content: "Reply with OK." }], ...model.provider === "openai" ? { max_completion_tokens: 16 } : { max_tokens: 16 }, stream: false })
    });
    if (!completion.ok) return { ok: false, message: await failure(completion, apiKey) };
    const result = await completion.json();
    if (!(anthropic ? Array.isArray(result.content) : Array.isArray(result.choices) && result.choices.length)) return { ok: false, message: "The model server returned an invalid completion response." };
    return { ok: true, message: "Provider authenticated and the selected model accepted a live test request." };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not reach the model provider.";
    return { ok: false, message: apiKey ? message.replaceAll(apiKey, "[redacted]") : message };
  }
}

// runtime/profile-runtime.ts
var COORDINATION_TOOLS = [
  { id: TASK_TOOL, name: "Task board", group: "other", description: "Read and update assigned board tasks.", available: true },
  { id: HANDOFF_TOOL, name: "Hand off to another agent", group: "delegation", description: "Assign explicit task context to a named agent on a shared team.", available: true },
  { id: ROUTINE_TOOL, name: "Create a routine", group: "scheduling", description: "Schedule work through Open Harness.", available: true }
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
  ["computer_use", "desktop"],
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
function containerBaseUrl(value) {
  const issue = modelEndpointIssue(value);
  if (issue) throw new Error(issue);
  const url = new URL(value);
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) url.hostname = "host.docker.internal";
  return url.toString().replace(/\/$/, "");
}
function runtimeProbe(container, input) {
  const probe = input;
  const request2 = probe.action === "connection" && probe.baseUrl ? { ...probe, baseUrl: containerBaseUrl(probe.baseUrl) } : input;
  return new Promise((resolve5, reject) => {
    const child = spawn3("docker", ["exec", "-i", container, "python", "/opt/open-harness/inspect_runtime.py"], { stdio: ["pipe", "pipe", "pipe"] });
    let output2 = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Runtime connection check timed out."));
    }, 25e3);
    child.stdout.on("data", (part) => {
      output2 += part;
      if (output2.length > 5e6) child.kill();
    });
    child.stderr.resume();
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("Docker could not start the runtime check."));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const value = JSON.parse(output2.trim());
        if (code || value.error) reject(new Error(value.error || "Runtime check failed."));
        else resolve5(value);
      } catch {
        reject(new Error("Runtime check returned an invalid response. Rebuild the Hermes image."));
      }
    });
    child.stdin.end(JSON.stringify(request2) + "\n");
  });
}
function prepareProfile(root, profile, effective, secrets, token, runId, options = {}) {
  assertSandboxedComputer(profile.computer);
  const baseUrl = effective.baseUrl ? containerBaseUrl(effective.baseUrl) : "";
  const dir = join2(root, "agents", profile.id), home = join2(dir, "profile"), managed = join2(dir, "managed");
  for (const path2 of [home, managed, join2(dir, "private")]) mkdirSync3(path2, { recursive: true });
  profileMemory(root, profile.id);
  const mcp = {};
  const coordination = join2(managed, "coordination.mjs");
  copyFileSync(join2(import.meta.dirname, "hermes", "coordination.mjs"), coordination);
  chmodSync(coordination, 384);
  if (profile.allowedTools.some((id) => COORDINATION_TOOLS.some((t) => t.id === id))) mcp.open_harness = { command: "node", args: [options.coordinationCommand || "/run/open-harness/coordination.mjs"], env: { OPEN_HARNESS_AGENT_ID: profile.id, OPEN_HARNESS_AGENT_TOKEN: token, OPEN_HARNESS_RUN_ID: runId, ...options.controlUrl ? { OPEN_HARNESS_CONTROL_URL: options.controlUrl } : {}, ...options.controlSocket ? { OPEN_HARNESS_CONTROL_SOCKET: options.controlSocket } : {} } };
  const env = {};
  const secretValues = secrets.environment();
  const customEndpoint = Boolean(baseUrl);
  const hermesProvider = customEndpoint ? "custom" : { local: "custom", openai: "openai-api" }[effective.provider] || effective.provider;
  const customKeyEnv = "OPEN_HARNESS_MODEL_API_KEY";
  const hasCredential = Boolean(effective.credentialRef && secretValues[effective.credentialRef]);
  if (hasCredential) {
    env[effective.credentialRef] = secretValues[effective.credentialRef];
    if (customEndpoint) env[customKeyEnv] = secretValues[effective.credentialRef];
    const providerEnv = { xai: "XAI_API_KEY", openrouter: "OPENROUTER_API_KEY", anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", "openai-api": "OPENAI_API_KEY" }[effective.provider];
    if (providerEnv && !customEndpoint) env[providerEnv] = secretValues[effective.credentialRef];
  }
  const providers = customEndpoint ? { custom: { name: "custom", base_url: baseUrl, ...hasCredential ? { key_env: customKeyEnv } : {}, ...effective.model ? { default_model: effective.model } : {} } } : void 0;
  for (const c of profile.connectors.filter((c2) => c2.enabled)) {
    const connectorEnv = c.secretRef && secretValues[c.secretRef] ? { [c.secretRef]: secretValues[c.secretRef] } : {};
    Object.assign(env, connectorEnv);
    mcp[c.name] = { command: c.command, args: c.args, env: c.secretRef ? { [c.secretRef]: "${" + c.secretRef + "}" } : {} };
  }
  const config = { model: { default: effective.model, provider: hermesProvider, ...effective.baseUrl ? { base_url: baseUrl } : {} }, terminal: { backend: "local", cwd: options.cwd || "/workspace/shared", home_mode: "profile" }, approvals: { mode: "smart", unattended_mode: "deny", cron_mode: "deny" }, computer_use: { permission_mode: "standard", no_overlay: profile.computer.desktop === "virtual" }, cron: { enabled: false }, delegation: { inherit_mcp_toolsets: false }, tools: { tool_search: { enabled: "off" } }, plugins: { enabled: ["open_harness_policy"] }, ...providers ? { providers } : {}, mcp_servers: mcp };
  atomicWorkspaceWrite(join2(home, "config.yaml"), JSON.stringify(config, null, 2));
  atomicWorkspaceWrite(join2(home, "SOUL.md"), profile.prompt.enabled ? profile.prompt.text : "");
  atomicWorkspaceWrite(join2(home, ".env"), Object.entries(env).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join("\n") + "\n");
  atomicWorkspaceWrite(join2(managed, "policy.json"), JSON.stringify({ runId, revision: profile.revision, allowedTools: profile.allowedTools }));
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
import { existsSync as existsSync3, lstatSync as lstatSync3, mkdirSync as mkdirSync4, readdirSync, readFileSync as readFileSync5, writeFileSync as writeFileSync4 } from "node:fs";
import { dirname as dirname2, join as join3, relative } from "node:path";
var memoryFiles = ["profile/MEMORY.md", "profile/USER.md", "profile/memories/MEMORY.md", "profile/memories/USER.md"];
var allowedRoots = ["private", ...memoryFiles, "profile/skills"];
function digest(data) {
  return createHash2("sha256").update(data).digest("hex");
}
function exportAgentFiles(stateRoot2, agentId) {
  const agentRoot = safeWorkspacePath(stateRoot2, `agents/${agentId}`), files = [];
  let total = 0;
  const visit = (path2) => {
    if (!existsSync3(path2)) return;
    const stat = lstatSync3(path2);
    if (stat.isSymbolicLink()) return;
    safeWorkspacePath(stateRoot2, relative(stateRoot2, path2));
    if (stat.isDirectory()) {
      for (const name of readdirSync(path2)) visit(join3(path2, name));
      return;
    }
    if (!stat.isFile()) return;
    const data = readFileSync5(path2);
    total += data.length;
    if (total > 2e7) throw new Error("Managed agent data exceeds the 20 MB transfer limit. Move large project files through an explicitly shared folder.");
    files.push({ path: relative(agentRoot, path2).replaceAll("\\", "/"), data: Buffer.from(data).toString("base64"), checksum: digest(data) });
  };
  for (const path2 of allowedRoots) visit(join3(agentRoot, path2));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, checksum: digest(files.map((file) => `${file.path}:${file.checksum}`).join("\n")) };
}
function importAgentFiles(stateRoot2, agentId, bundle) {
  safeWorkspacePath(stateRoot2, `agents/${agentId}`);
  let total = 0;
  const seen = /* @__PURE__ */ new Set();
  const files = bundle.files.map((file) => {
    const clean = file.path.replaceAll("\\", "/");
    if (!(clean.startsWith("private/") || memoryFiles.includes(clean) || clean.startsWith("profile/skills/"))) throw new Error("Transfer contains an invalid managed path.");
    const name = `agents/${agentId}/${clean}`, target = safeWorkspacePath(stateRoot2, name);
    const key = process.platform === "win32" ? target.toLowerCase() : target;
    if (seen.has(key)) throw new Error("Transfer contains duplicate managed paths.");
    seen.add(key);
    const data = Buffer.from(file.data, "base64");
    total += data.length;
    if (total > 1e8 || digest(data) !== file.checksum) throw new Error("Transfer checksum validation failed.");
    return { name, target, data };
  });
  const checksum = digest([...bundle.files].sort((a, b) => a.path.localeCompare(b.path)).map((file) => `${file.path}:${file.checksum}`).join("\n"));
  if (checksum !== bundle.checksum) throw new Error("Transfer bundle checksum validation failed.");
  for (const file of files) {
    safeWorkspacePath(stateRoot2, file.name);
    mkdirSync4(dirname2(file.target), { recursive: true });
    writeFileSync4(safeWorkspacePath(stateRoot2, file.name), file.data, { mode: 384 });
  }
  return { checksum, files: bundle.files.length };
}

// runtime/secrets.ts
import { chmodSync as chmodSync2, existsSync as existsSync4, mkdirSync as mkdirSync5, readFileSync as readFileSync6, unlinkSync, writeFileSync as writeFileSync5 } from "node:fs";
import { dirname as dirname3 } from "node:path";
import { spawnSync as spawnSync4 } from "node:child_process";
import { createHash as createHash3 } from "node:crypto";
var service = "dev.openharness.secrets";
function command2(name, args2, input) {
  return spawnSync4(name, args2, { input, encoding: "utf8", timeout: 8e3, windowsHide: true, maxBuffer: 2e6 });
}
var account = (path2) => `open-harness-${createHash3("sha256").update(path2).digest("hex").slice(0, 16)}`;
var DISABLED = { state: "unavailable", backend: "OS vault", reason: "OPEN_HARNESS_DISABLE_OS_VAULT=1 is set." };
function loadVault(path2) {
  if (process.env.OPEN_HARNESS_DISABLE_OS_VAULT === "1") return DISABLED;
  try {
    if (process.platform === "darwin") {
      const backend = "macOS Keychain";
      const result = command2("security", ["find-generic-password", "-s", service, "-a", account(path2), "-w"]);
      if (result.status === 0) return { state: "ok", value: result.stdout.trim(), backend };
      if (result.status === 44) return { state: "empty", backend };
      return { state: "unavailable", backend, reason: result.error ? result.error.message : (result.stderr || "").trim() || `security exited ${result.status}.` };
    }
    if (process.platform === "linux") {
      const backend = "system password vault";
      if (!process.env.DBUS_SESSION_BUS_ADDRESS) return { state: "unavailable", backend, reason: "No D-Bus session is available, so the password vault cannot be reached." };
      const result = command2("secret-tool", ["lookup", "application", service, "workspace", account(path2)]);
      if (result.status === 0) return result.stdout.trim() ? { state: "ok", value: result.stdout.trim(), backend } : { state: "empty", backend };
      if (result.status === 1 && !(result.stderr || "").trim()) return { state: "empty", backend };
      return { state: "unavailable", backend, reason: result.error ? result.error.message : (result.stderr || "").trim() || `secret-tool exited ${result.status}.` };
    }
    if (process.platform === "win32") {
      const backend = "Windows account vault";
      const target = `${process.env.APPDATA || dirname3(process.execPath)}\\Open Harness\\${account(path2)}.dpapi`;
      const script = "$p=$args[0];if(-not (Test-Path -LiteralPath $p)){exit 44};$b=[IO.File]::ReadAllBytes($p);$d=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($d))";
      const result = command2("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, target]);
      if (result.status === 0 && result.stdout) return { state: "ok", value: result.stdout, backend };
      if (result.status === 44) return { state: "empty", backend };
      return { state: "unavailable", backend, reason: result.error ? result.error.message : (result.stderr || "").trim() || `PowerShell exited ${result.status}.` };
    }
    return { state: "empty", backend: "OS vault" };
  } catch (error) {
    return { state: "unavailable", backend: "OS vault", reason: error instanceof Error ? error.message : "The OS vault could not be read." };
  }
}
function saveVault(path2, value) {
  if (process.env.OPEN_HARNESS_DISABLE_OS_VAULT === "1") return null;
  try {
    if (process.platform === "darwin") return command2("security", ["add-generic-password", "-U", "-s", service, "-a", account(path2), "-w", value]).status === 0 ? "macOS Keychain" : null;
    if (process.platform === "linux" && process.env.DBUS_SESSION_BUS_ADDRESS) return command2("secret-tool", ["store", "--label=Open Harness credentials", "application", service, "workspace", account(path2)], value).status === 0 ? "system password vault" : null;
    if (process.platform === "win32") {
      const target = `${process.env.APPDATA || dirname3(process.execPath)}\\Open Harness\\${account(path2)}.dpapi`;
      const script = "$p=$args[0];$v=[Console]::In.ReadToEnd();$d=Split-Path -Parent $p;New-Item -ItemType Directory -Force -Path $d|Out-Null;$b=[Text.Encoding]::UTF8.GetBytes($v);$e=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[IO.File]::WriteAllBytes($p,$e)";
      return command2("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, target], value).status === 0 ? "Windows account vault" : null;
    }
  } catch {
  }
  return null;
}
var SecretsUnavailableError = class extends Error {
};
var SecretStore = class {
  constructor(path2) {
    this.path = path2;
    this.backend = "restricted local file";
    mkdirSync5(dirname3(path2), { recursive: true });
    this.markerPath = `${path2.replace(/\.json$/, "")}.backend`;
    const recorded = existsSync4(this.markerPath) ? readFileSync6(this.markerPath, "utf8").trim() : "";
    const vaulted = loadVault(path2);
    const onDisk = existsSync4(path2);
    if (vaulted.state === "ok") {
      this.values = this.parse(vaulted.value, vaulted.backend);
      this.backend = vaulted.backend;
    } else if (onDisk) {
      this.values = this.parse(readFileSync6(path2, "utf8"), path2);
      this.backend = "restricted local file";
    } else if (recorded.startsWith("vault")) {
      const detail = vaulted.state === "unavailable" ? vaulted.reason : "The vault reports no stored credentials.";
      throw new SecretsUnavailableError(
        `Open Harness stored its credentials in the ${recorded.slice(6) || vaulted.backend} and cannot read them now. ${detail}
Start Open Harness from an unlocked desktop session, or set OPEN_HARNESS_DISABLE_OS_VAULT=1 and re-enter the keys.
Nothing was changed. Delete ${this.markerPath} to start over with an empty credential store.`
      );
    } else this.values = {};
    if (!this.values.controlToken) {
      this.values.controlToken = crypto.randomUUID() + crypto.randomUUID();
      this.save();
    } else this.record();
    if (existsSync4(path2)) chmodSync2(path2, 384);
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
  // save() reserializes the whole map, which still holds controlToken, so the vault blob
  // rewrites correctly and the dashboard token survives. The guard is defence in depth:
  // this is the one method that could otherwise brick it.
  delete(name) {
    if (name === "controlToken" || !(name in this.values)) return false;
    delete this.values[name];
    this.save();
    return true;
  }
  // Unreadable stored credentials are not the same as none: replacing them with a fresh
  // map is the one thing that cannot be undone, so say so and change nothing.
  parse(raw, source) {
    if (!raw.trim()) return {};
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new SecretsUnavailableError(`The stored Open Harness credentials in ${source} are not readable JSON. Nothing was changed. Move that entry aside to start over with an empty credential store.`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new SecretsUnavailableError(`The stored Open Harness credentials in ${source} are not in the expected format. Nothing was changed. Move that entry aside to start over with an empty credential store.`);
    return value;
  }
  record() {
    try {
      writeFileSync5(this.markerPath, this.backend === "restricted local file" ? "file" : `vault:${this.backend}`, { mode: 384 });
    } catch {
    }
  }
  save() {
    const serialized = JSON.stringify(this.values);
    const backend = saveVault(this.path, serialized);
    if (backend) {
      const confirmed = loadVault(this.path);
      if (confirmed.state === "ok" && confirmed.value.trim() === serialized) {
        this.backend = backend;
        this.record();
        if (existsSync4(this.path)) unlinkSync(this.path);
        return;
      }
    }
    this.backend = "restricted local file";
    writeFileSync5(this.path, JSON.stringify(this.values, null, 2), { mode: 384 });
    chmodSync2(this.path, 384);
    this.record();
  }
};

// lib/runner-crypto.ts
function bytes(value) {
  const binary = atob(value), output2 = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) output2[index] = binary.charCodeAt(index);
  return output2;
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

// runtime/agent-context.ts
import { existsSync as existsSync5, mkdirSync as mkdirSync6, readFileSync as readFileSync7, readdirSync as readdirSync2, renameSync as renameSync2, rmSync as rmSync2, writeFileSync as writeFileSync6 } from "node:fs";
import { dirname as dirname4 } from "node:path";
import { randomUUID as randomUUID4 } from "node:crypto";
function write(path2, content) {
  mkdirSync6(dirname4(path2), { recursive: true });
  const temporary = `${path2}.${randomUUID4()}.tmp`;
  try {
    writeFileSync6(temporary, content, { mode: 384, flag: "wx" });
    renameSync2(temporary, path2);
  } finally {
    rmSync2(temporary, { force: true });
  }
}
function agentContext(root, agentId, input) {
  const profile = `agents/${validId(agentId)}/profile`;
  const skills = safeWorkspacePath(root, `${profile}/skills`);
  if (input.operation === "get" || input.operation === "set-memory") {
    const paths = profileMemory(root, agentId);
    if (input.operation === "set-memory") {
      const memory = String(input.memory || "");
      if (memory.length > 5e4) throw new ProfileError("Memory is limited to 50 KB.", 413);
      write(paths.memory, memory);
      return { status: 200, value: { ok: true } };
    }
    return { status: 200, value: {
      memory: existsSync5(paths.memory) ? readFileSync7(paths.memory, "utf8") : "",
      user: existsSync5(paths.user) ? readFileSync7(paths.user, "utf8") : "",
      skills: existsSync5(skills) ? readdirSync2(skills, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name).slice(0, 200) : []
    } };
  }
  if (!["get-skill", "put-skill", "delete-skill"].includes(input.operation)) throw new ProfileError("Invalid context operation.");
  const name = String(input.name || "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(name)) throw new ProfileError("Invalid skill name.");
  const directory = safeWorkspacePath(root, `${profile}/skills/${name}`);
  const file = safeWorkspacePath(root, `${profile}/skills/${name}/SKILL.md`);
  if (input.operation === "get-skill") return existsSync5(file) ? { status: 200, value: { name, content: readFileSync7(file, "utf8") } } : { status: 404, value: { error: "Skill not found." } };
  if (input.operation === "put-skill") write(file, String(input.content || ""));
  else if (existsSync5(directory)) rmSync2(directory, { recursive: true });
  return { status: 200, value: { ok: true } };
}

// runtime/runner.ts
var args = /* @__PURE__ */ new Map();
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith("--")) args.set(process.argv[i].slice(2), process.argv[i + 1]?.startsWith("--") ? "" : process.argv[++i] || "");
var stateRoot = resolve4(process.env.OPEN_HARNESS_RUNNER_STATE_DIR || join4(homedir(), ".open-harness-runner"));
var credentialPath = join4(stateRoot, "connection.json");
var spool = join4(stateRoot, "spool");
mkdirSync7(spool, { recursive: true });
var runnerSecrets;
try {
  runnerSecrets = new SecretStore(join4(stateRoot, "secrets.json"));
} catch (error) {
  console.error(error instanceof Error ? error.message : "The runner could not open its credential store.");
  process.exit(1);
}
function output(command3, args2, timeout) {
  return new Promise((resolve5) => {
    let done = false, stdout = "";
    const settle = (status) => {
      if (!done) {
        done = true;
        resolve5({ status, stdout });
      }
    };
    const child = spawn4(command3, args2, { stdio: ["ignore", "pipe", "ignore"], timeout, killSignal: "SIGKILL" });
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.on("error", () => settle(null));
    child.on("exit", (code) => settle(code));
  });
}
async function probeCapabilities() {
  const container = process.env.OPEN_HARNESS_MOCK === "1" || classifyContract(await output("docker", ["image", "inspect", "-f", `{{index .Config.Labels "${RUNTIME_LABEL}"}}`, HERMES_IMAGE], 5e3)) === "current";
  return { container, direct: false, desktop: false, virtualDesktop: process.platform === "linux" && container, detail: container ? "Private agent workspaces are ready. Desktop control uses an isolated agent desktop." : "Install Docker and prepare the pinned runtime to enable sandboxed agents." };
}
var known = null;
var probing = null;
function capabilities() {
  return probing ??= probeCapabilities().then((value) => known = value).finally(() => {
    probing = null;
  });
}
async function pair() {
  const coordinator = String(args.get("coordinator") || "").replace(/\/$/, ""), code = String(args.get("pairing-code") || "");
  if (!coordinator || !code) throw new Error("Use --coordinator URL and --pairing-code CODE, or keep an existing runner connection.");
  const target = new URL(coordinator), loopback = ["localhost", "127.0.0.1", "::1"].includes(target.hostname);
  if (target.protocol !== "https:" && !(target.protocol === "http:" && loopback)) throw new Error("Remote coordinators must use HTTPS. Plain HTTP is accepted only for a coordinator on this computer.");
  const encryption = await generateRunnerKeyPair();
  const response = await fetch(`${coordinator}/v1/runner/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, name: hostname(), platform: platform2(), arch: arch(), capabilities: await capabilities(), encryptionPublicKey: encryption.publicKey }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "Pairing failed.");
  const saved = { coordinator, machineId: value.machineId, token: value.token, encryptionPublicKey: encryption.publicKey, encryptionPrivateKey: encryption.privateKey };
  writeFileSync7(credentialPath, JSON.stringify(saved, null, 2), { mode: 384 });
  chmodSync3(credentialPath, 384);
  return saved;
}
var credentials = args.has("pairing-code") ? await pair() : existsSync6(credentialPath) ? JSON.parse(readFileSync8(credentialPath, "utf8")) : await pair();
if (!credentials.encryptionPrivateKey || !credentials.encryptionPublicKey) {
  const encryption = await generateRunnerKeyPair();
  credentials = { ...credentials, encryptionPublicKey: encryption.publicKey, encryptionPrivateKey: encryption.privateKey };
  writeFileSync7(credentialPath, JSON.stringify(credentials, null, 2), { mode: 384 });
  chmodSync3(credentialPath, 384);
}
var savedTarget = new URL(credentials.coordinator);
var savedLoopback = ["localhost", "127.0.0.1", "::1"].includes(savedTarget.hostname);
if (savedTarget.protocol !== "https:" && !(savedTarget.protocol === "http:" && savedLoopback)) throw new Error("The saved remote coordinator URL is not HTTPS. Pair this runner again using a secure URL.");
if (args.has("once")) {
  console.log(`Paired ${credentials.machineId}.`);
  process.exit(0);
}
var headers = { Authorization: `Bearer ${credentials.token}`, "X-Open-Harness-Machine": credentials.machineId, "Content-Type": "application/json" };
async function request(path2, init = {}, retry = false) {
  for (; ; ) {
    try {
      const response = await fetch(credentials.coordinator + path2, { ...init, headers: { ...headers, ...init.headers } });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || `Coordinator returned HTTP ${response.status}.`);
      return value;
    } catch (error) {
      if (!retry) throw error;
      await new Promise((resolve5) => setTimeout(resolve5, 2e3));
    }
  }
}
var active = /* @__PURE__ */ new Map();
var admittedCommands = /* @__PURE__ */ new Set();
var agentOperations = /* @__PURE__ */ new Map();
var blockedAgents = /* @__PURE__ */ new Set();
var admittedRuns = /* @__PURE__ */ new Map();
async function deliver(record) {
  const file = join4(spool, `${record.id}.json`);
  if (!existsSync6(file)) writeFileSync7(file, JSON.stringify(record), { mode: 384 });
  await request(record.path, { method: "POST", body: JSON.stringify(record.body) }, true);
  if (existsSync6(file)) unlinkSync2(file);
}
async function flushSpool() {
  for (const name of readdirSync3(spool).filter((name2) => name2.endsWith(".json"))) {
    try {
      await deliver(JSON.parse(readFileSync8(join4(spool, name), "utf8")));
    } catch {
    }
  }
}
async function emit(command3, event) {
  const eventId = crypto.randomUUID();
  await deliver({ id: eventId, path: `/v1/runner/commands/${command3.id}/events`, body: { eventId, runId: command3.payload.runId, event } });
}
async function finish(command3, result, error) {
  await deliver({ id: `complete-${command3.id}`, path: `/v1/runner/commands/${command3.id}/complete`, body: error ? { error: error instanceof Error ? error.message : String(error) } : { result } });
}
async function openDispatchedSecrets(sealed) {
  if (!sealed) return {};
  const opened = await Promise.all(Object.entries(sealed).map(async ([name, payload]) => [name, await decryptRunnerSecret(credentials.encryptionPrivateKey, payload)]));
  return Object.fromEntries(opened);
}
async function run(command3) {
  const payload = command3.payload;
  const profile = payload.snapshot;
  let gateway, result, failure2;
  try {
    assertSandboxedComputer(profile.computer);
    const shared = join4(stateRoot, "shared");
    mkdirSync7(shared, { recursive: true });
    const needed = [profile.effectiveModel.credentialRef, ...profile.connectors.filter((item) => item.enabled).map((item) => item.secretRef)].filter(Boolean);
    const availableSecrets = { ...runnerSecrets.environment(), ...process.env };
    const localSecrets = Object.fromEntries(needed.filter((name) => availableSecrets[name]).map((name) => [name, availableSecrets[name]]));
    const dispatched = await openDispatchedSecrets(payload.encryptedSecrets);
    if (admittedRuns.get(payload.runId)?.cancelled) throw new Error("Run stopped before its runtime started.");
    const ephemeralSecrets = { environment: () => ({ ...localSecrets, ...dispatched }) };
    const coordinatorForContainer = credentials.coordinator.replace("://localhost", "://host.docker.internal").replace("://127.0.0.1", "://host.docker.internal");
    prepareProfile(stateRoot, profile, profile.effectiveModel, ephemeralSecrets, payload.coordinationToken, payload.runId, { controlUrl: coordinatorForContainer });
    gateway = new HermesGateway(ensureContainer(profile.id, stateRoot, profile.computer), profile.allowedTools);
    const live = { gateway, sessionId: null, commandId: command3.id, stopping: false, agentId: profile.id };
    active.set(payload.runId, live);
    gateway.on("event", (event) => void emit(command3, event));
    await gateway.start();
    if (live.stopping) throw new Error("Run stopped before its session started.");
    const session = await gateway.request("session.create", { cwd: "/workspace/shared", profile: "default", messages: payload.history || [] });
    const sessionId = String(session?.session_id || session?.id || "");
    if (!sessionId) throw new Error("Hermes did not return a session ID.");
    live.sessionId = sessionId;
    await emit(command3, { type: "session.started", session_id: sessionId, payload: { session_id: sessionId } });
    if (live.stopping) throw new Error("Run stopped before its prompt started.");
    result = await gateway.submitPrompt(sessionId, payload.prompt);
  } catch (error) {
    failure2 = error;
  }
  try {
    await gateway?.stop();
    active.delete(payload.runId);
  } catch (error) {
    blockedAgents.add(profile.id);
    failure2 = new Error(`Agent cleanup could not be confirmed. Further work is blocked until it is stopped: ${error instanceof Error ? error.message : error}`);
  }
  await finish(command3, result, failure2);
}
async function control(command3) {
  try {
    if (command3.kind === "agent-context") {
      await finish(command3, agentContext(stateRoot, command3.agentId, command3.payload));
      return;
    }
    if (command3.kind === "store-secret") {
      const name = String(command3.payload.name || ""), value = await decryptRunnerSecret(credentials.encryptionPrivateKey, command3.payload.encrypted);
      runnerSecrets.set(name, value);
      await finish(command3, { stored: true, name, backend: runnerSecrets.backend });
      return;
    }
    if (command3.kind === "export-agent") {
      await finish(command3, exportAgentFiles(stateRoot, command3.agentId));
      return;
    }
    if (command3.kind === "import-agent") {
      const profile = command3.payload.profile;
      if (profile) validateComputerTarget(profile, await capabilities(), Array.isArray(command3.payload.requiredSecrets) ? command3.payload.requiredSecrets.map(String) : [], (name) => runnerSecrets.has(name) || Boolean(process.env[name]));
      const bundle = command3.payload.bundle;
      if (!bundle) throw new Error("This transfer arrived without its file bundle. Start the move again from Agent settings.");
      const imported = importAgentFiles(stateRoot, command3.agentId, bundle);
      if (profile?.computer.desktop !== "none" && profile) {
        const check = { action: "computer", desktop: profile.computer.desktop };
        const result = await runtimeProbe(ensureContainer(profile.id, stateRoot, profile.computer), check);
        if (!result.ok) throw new Error(String(result.message || "Desktop control is not ready on the destination computer."));
      }
      await finish(command3, { ...imported, validated: true });
      return;
    }
    if (command3.kind.startsWith("probe-")) {
      const profile = command3.payload.profile, shared = join4(stateRoot, "shared");
      assertSandboxedComputer(profile.computer);
      mkdirSync7(shared, { recursive: true });
      const availableSecrets = { ...runnerSecrets.environment(), ...process.env }, needed = [profile.effectiveModel.credentialRef, ...profile.connectors.filter((item) => item.enabled).map((item) => item.secretRef)].filter(Boolean), localSecrets = Object.fromEntries(needed.filter((name) => availableSecrets[name]).map((name) => [name, availableSecrets[name]])), dispatched = await openDispatchedSecrets(command3.payload.encryptedSecrets), secretSource = { environment: () => ({ ...localSecrets, ...dispatched }) };
      if (command3.kind === "probe-runtime" && command3.payload.input?.action === "model-test") {
        const model = command3.payload.input.model;
        const apiKey = command3.payload.encryptedApiKey ? await decryptRunnerSecret(credentials.encryptionPrivateKey, command3.payload.encryptedApiKey) : availableSecrets[model.credentialRef] || "";
        await finish(command3, await testModelConnection(model, apiKey));
        return;
      }
      prepareProfile(stateRoot, profile, profile.effectiveModel, secretSource, command3.payload.coordinationToken || "", `probe-${command3.id}`, {});
      if (command3.kind === "probe-runtime") {
        const probeInput = { ...command3.payload.input || {} };
        if (probeInput.action === "computer") probeInput.desktop = profile.computer.desktop;
        if (probeInput.action === "connection" && !probeInput.apiKey) probeInput.apiKey = command3.payload.encryptedApiKey ? await decryptRunnerSecret(credentials.encryptionPrivateKey, command3.payload.encryptedApiKey) : secretSource.environment()[profile.effectiveModel.credentialRef] || "";
        if (probeInput.action === "mcp" && probeInput.env) {
          for (const name of Object.keys(probeInput.env)) if (!probeInput.env[name] && secretSource.environment()[name]) probeInput.env[name] = secretSource.environment()[name];
        }
        await finish(command3, await runtimeProbe(ensureContainer(profile.id, stateRoot, profile.computer), probeInput));
        return;
      }
      const container = ensureContainer(profile.id, stateRoot, profile.computer);
      if (command3.kind === "probe-tools") {
        const input = await runtimeProbe(container, { action: "catalog" });
        await finish(command3, { source: "runtime", tools: [...(Array.isArray(input.tools) ? input.tools : []).filter((tool) => tool.group !== "cronjob").map(groupTool), ...COORDINATION_TOOLS] });
        return;
      }
      const gateway = new HermesGateway(container, []);
      let result;
      try {
        await gateway.start();
        result = await discoverModels(gateway);
      } finally {
        await gateway.stop();
      }
      await finish(command3, result);
      return;
    }
    const live = active.get(String(command3.payload.runId));
    if (!live && command3.kind === "stop") {
      const waiting = admittedRuns.get(String(command3.payload.runId));
      if (waiting) {
        waiting.cancelled = true;
        await finish(command3, { ok: true });
        return;
      }
    }
    if (!live) throw new Error("The requested run is no longer active on this runner.");
    if (command3.kind === "stop") {
      live.stopping = true;
      if (live.sessionId) await live.gateway.request("session.interrupt", { session_id: live.sessionId }, 5e3).catch(() => {
      });
      await live.gateway.stop();
      blockedAgents.delete(live.agentId);
    }
    if (command3.kind === "steer") {
      if (!live.sessionId) throw new Error("The agent is still starting. Try again when its session is ready.");
      await live.gateway.request("session.steer", { session_id: live.sessionId, text: String(command3.payload.text || "") });
    }
    if (command3.kind === "approval") await live.gateway.request("approval.respond", { session_id: live.sessionId, request_id: command3.payload.requestId, choice: hermesApprovalDecision(command3.payload.choice || command3.payload.decision), all: false });
    if (command3.kind === "input") {
      const type = command3.payload.type;
      if (!["clarify", "secret", "sudo"].includes(type)) throw new Error("Unsupported input request type.");
      if (type !== "clarify" && !command3.payload.encrypted) throw new Error("Sensitive input must be encrypted for this runner.");
      const value = command3.payload.encrypted ? await decryptRunnerSecret(credentials.encryptionPrivateKey, command3.payload.encrypted) : command3.payload.value;
      const key = type === "clarify" ? "answer" : type === "secret" ? "value" : "password";
      try {
        await live.gateway.request(`${type}.respond`, { request_id: command3.payload.requestId, [key]: value });
      } catch {
        throw new Error("The agent could not accept this input. Check whether its request is still pending.");
      }
    }
    await finish(command3, { ok: true });
  } catch (error) {
    await finish(command3, void 0, error);
  }
}
async function executeCommand(command3) {
  const usesProfile = command3.kind === "run" || command3.kind.startsWith("probe-") || command3.kind === "import-agent" || command3.kind === "export-agent" || command3.kind === "agent-context";
  if (!usesProfile) return control(command3);
  const agentId = String(command3.kind === "run" ? command3.payload.snapshot?.id : command3.payload.profile?.id || command3.agentId);
  const previous = agentOperations.get(agentId);
  if (blockedAgents.has(agentId) || previous && command3.kind !== "run") {
    return finish(command3, void 0, new Error(blockedAgents.has(agentId) ? "The previous agent runtime could not be stopped. Stop it before checking settings or starting more work." : "This agent is busy. Wait for its current task or settings check to finish before checking or moving its profile."));
  }
  const admission = { cancelled: false };
  if (command3.kind === "run") admittedRuns.set(String(command3.payload.runId), admission);
  const operation = (async () => {
    if (previous) await previous.catch(() => {
    });
    if (admission.cancelled) return finish(command3, void 0, new Error("Run stopped before its runtime started."));
    if (blockedAgents.has(agentId)) return finish(command3, void 0, new Error("The previous agent runtime could not be stopped."));
    return command3.kind === "run" ? run(command3) : control(command3);
  })();
  agentOperations.set(agentId, operation);
  try {
    await operation;
  } finally {
    if (agentOperations.get(agentId) === operation) agentOperations.delete(agentId);
    if (command3.kind === "run") admittedRuns.delete(String(command3.payload.runId));
  }
}
console.log(`Open Harness runner ${credentials.machineId} connected to ${credentials.coordinator}`);
await flushSpool();
if (!known) void capabilities().catch(() => {
});
var lastHeartbeat = 0;
for (; ; ) {
  try {
    if (Date.now() - lastHeartbeat > 15e3) {
      void capabilities().catch(() => {
      });
      await request("/v1/runner/heartbeat", { method: "POST", body: JSON.stringify({ ...known ? { capabilities: known } : {}, encryptionPublicKey: credentials.encryptionPublicKey, activeCommandIds: [.../* @__PURE__ */ new Set([...admittedCommands, ...[...active.values()].map((item) => item.commandId)])] }) });
      lastHeartbeat = Date.now();
    }
    const result = await request("/v1/runner/commands");
    for (const command3 of result.commands) {
      if (admittedCommands.has(command3.id)) continue;
      admittedCommands.add(command3.id);
      void executeCommand(command3).catch((error) => console.error(error instanceof Error ? error.message : error)).finally(() => admittedCommands.delete(command3.id));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  }
  await new Promise((resolve5) => setTimeout(resolve5, 1e3));
}
