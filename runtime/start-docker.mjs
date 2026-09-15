import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function run(command, args, timeout = 10_000) {
  return spawnSync(command, args, { encoding: "utf8", timeout });
}

function dockerReady() {
  return run("docker", ["version", "--format", "{{.Server.Version}}"], 5_000).status === 0;
}

function startCommand(platform, context) {
  if (platform === "darwin") return ["open", ["-gja", "Docker"]];
  if (platform === "win32") return ["powershell.exe", ["-NoProfile", "-Command", "Start-Process \"$Env:ProgramFiles\\Docker\\Docker\\Docker Desktop.exe\""]];
  if (platform === "linux" && context.startsWith("desktop")) return ["systemctl", ["--user", "start", "docker-desktop.service"]];
  if (platform === "linux") return ["systemctl", ["start", "--no-block", "docker.service"]];
  return null;
}

export async function ensureDockerStarted(options = {}) {
  if (process.env.OPEN_HARNESS_MOCK === "1" || process.env.OPEN_HARNESS_SKIP_DOCKER_START === "1") return { started: false, skipped: true };
  const docker = run("docker", ["--version"]);
  if (docker.status !== 0) throw new Error("Docker is not installed. Install Docker Desktop, then launch Open Harness again.");
  if (dockerReady()) return { started: false, skipped: false };

  const context = (run("docker", ["context", "show"]).stdout || "").trim();
  const command = startCommand(options.platform || process.platform, context);
  if (!command) throw new Error("Docker is installed, but Open Harness cannot start it on this operating system. Start the Docker daemon and try again.");

  console.log(`Starting ${context.startsWith("desktop") ? "Docker Desktop" : "Docker"}…`);
  const started = run(command[0], command[1], 15_000);
  if (started.status !== 0) {
    const detail = (started.stderr || started.stdout || "").trim();
    throw new Error(detail || "Docker could not be started. Start Docker manually and try again.");
  }

  const timeout = Math.max(5_000, Number(process.env.OPEN_HARNESS_DOCKER_TIMEOUT_MS || options.timeout || 120_000));
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (dockerReady()) { console.log("Docker is ready."); return { started: true, skipped: false }; }
    await wait(1_000);
  }
  throw new Error(`Docker did not become ready within ${Math.round(timeout / 1_000)} seconds. Check Docker Desktop and try again.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ensureDockerStarted().catch(error => { console.error(error instanceof Error ? error.message : "Docker could not be started."); process.exitCode = 1; });
}
