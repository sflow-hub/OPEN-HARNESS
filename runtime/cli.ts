import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createConnection } from "node:net";
import { dockerStatus, stateSharing } from "./hermes";
import { onboardingStatus, imageContract, HERMES_IMAGE } from "./readiness";
import { chooseStateDir, withEnvValue } from "./state-dir";

const argv = process.argv.slice(2);
const command = argv.find(arg => !arg.startsWith("-")) || (argv.includes("--help") || argv.includes("-h") ? "help" : argv.includes("--version") || argv.includes("-v") ? "version" : "status");
const wantsJson = argv.includes("--json");
const project = resolve(import.meta.dirname, "..");
// dev and harness:serve load the project .env through --env-file-if-exists. The CLI must see
// the same OPEN_HARNESS_STATE_DIR, or doctor and install-service would describe a different
// data folder from the one the coordinator actually uses. Variables already set are kept.
try { process.loadEnvFile(resolve(project, ".env")); } catch {}
const projectDefault = `${project}/.open-harness`;
const state = resolve(process.env.OPEN_HARNESS_STATE_DIR || projectDefault);
const version = (() => { try { return String(JSON.parse(readFileSync(resolve(project, "package.json"), "utf8")).version || "unknown"); } catch { return "unknown"; } })();
function run(name: string, args: string[]) { const result = spawnSync(name, args, { cwd: project, stdio: "inherit" }); process.exitCode = result.status || 0; }

const USAGE = `Open Harness ${version}

Usage: npm run harness -- <command> [options]

Commands:
  status            Summarize this machine's setup (always exits 0)
  doctor            Diagnose the setup and exit non-zero if something needs attention
  setup             Build the pinned Hermes runtime image
  start             Start the installed control service
  stop              Stop the installed control service
  install-service   Install the control service as a user service (Linux)
  runner            Run a machine runner in the foreground
  runner-install    Pair this machine and install the runner to start automatically

Options:
  --json            Print machine-readable output (status, doctor)
  -h, --help        Show this message
  -v, --version     Print the Open Harness version

Environment:
  OPEN_HARNESS_STATE_DIR   Where state.db and secrets live (default: <project>/.open-harness;
                           setup picks ~/.open-harness/<project> and records it in .env when
                           Docker cannot read the project folder)
  OPEN_HARNESS_PORT        Coordinator port (default: 4317)
  OPEN_HARNESS_HERMES_IMAGE  Override the pinned agent runtime image`;

// The coordinator's own readiness engine already classifies Docker, the runtime image
// and the desktop session, with timeouts, and the dashboard has been using it all along.
// doctor reuses it rather than keeping a second, weaker copy of the same probes.
function reachable(port: number, host = "127.0.0.1", timeout = 1_500) {
  return new Promise<boolean>(resolvePromise => {
    const socket = createConnection({ port, host });
    const finish = (value: boolean) => { socket.destroy(); resolvePromise(value); };
    socket.setTimeout(timeout);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function diagnose() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const nodeOk = major > 22 || (major === 22 && minor >= 13);
  const port = Number(process.env.OPEN_HARNESS_PORT || 4317);
  const listening = await reachable(port);
  const initialized = existsSync(`${state}/state.db`);
  const status = onboardingStatus([], state);
  return {
    version,
    node: { version: process.versions.node, required: ">=22.13.0", ok: nodeOk },
    stateDir: { path: state, initialized },
    coordinator: { port, listening },
    hermesImage: HERMES_IMAGE,
    platform: status.platformLabel,
    executionReady: status.executionReady,
    checks: status.checks.map(check => ({ id: check.id, label: check.label, state: check.state, detail: check.detail, helpUrl: check.helpUrl, action: check.action, actionLabel: check.actionLabel })),
  };
}

function report(data: Awaited<ReturnType<typeof diagnose>>) {
  const mark = { ready: "ok  ", action: "warn", missing: "FAIL", unavailable: "n/a " } as Record<string, string>;
  console.log(`Open Harness ${data.version} on ${data.platform}`);
  console.log(`${data.node.ok ? "ok  " : "FAIL"} Node ${data.node.version} (requires ${data.node.required})`);
  if (!data.node.ok) console.log(`       The coordinator imports node:sqlite. Run "nvm use" in this checkout.`);
  console.log(`${data.coordinator.listening ? "ok  " : "warn"} Coordinator ${data.coordinator.listening ? `responding on port ${data.coordinator.port}` : `not responding on port ${data.coordinator.port}`}`);
  if (!data.coordinator.listening) console.log(`       Start it with "npm run harness:serve", or set OPEN_HARNESS_PORT if it runs elsewhere.`);
  console.log(`${data.stateDir.initialized ? "ok  " : "warn"} State ${data.stateDir.initialized ? "initialized" : "not initialized"} at ${data.stateDir.path}`);
  for (const check of data.checks) {
    if (check.id === "coordinator") continue; // Already reported above, and measured rather than assumed.
    console.log(`${mark[check.state] || "?   "} ${check.label}: ${check.detail}`);
    if (check.state === "action" && check.id === "agent-runtime") console.log(`       Run "npm run harness:setup" to ${check.actionLabel === "Update agent runtime" ? "update" : "build"} ${data.hermesImage}.`);
    if (check.helpUrl) console.log(`       ${check.helpUrl}`);
  }
}


if (command === "help") {
  console.log(USAGE);
} else if (command === "version") {
  console.log(version);
} else if (command === "doctor" || command === "status") {
  const data = await diagnose();
  if (wantsJson) console.log(JSON.stringify(data, null, 2));
  else report(data);
  // status reports; doctor judges. Only doctor is meant to gate a script or CI step.
  if (command === "doctor") {
    const blocking = !data.node.ok || data.checks.some(check => check.state === "missing" || check.state === "action");
    if (blocking) process.exitCode = 1;
  }
} else if (command === "setup") {
  const docker = dockerStatus(false); if (!docker.available) { console.error(docker.message); process.exitCode = 1; }
  else {
    run("docker", ["build", "-f", "runtime/hermes/Dockerfile", "-t", HERMES_IMAGE, "."]);
    if (!process.exitCode) {
      // The sharing probe runs a container from the image, so it has to come after the build.
      const choice = chooseStateDir({
        explicit: process.env.OPEN_HARNESS_STATE_DIR, projectDefault, homeDefault: join(homedir(), ".open-harness", basename(project)),
        hasState: dir => existsSync(join(dir, "state.db")) || existsSync(join(dir, "secrets.json")),
        dockerCanRead: dir => stateSharing(dir).ok,
      });
      mkdirSync(choice.path, { recursive: true });
      if (choice.reason === "home") {
        const envPath = resolve(project, ".env"), existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
        const updated = withEnvValue(existing, "OPEN_HARNESS_STATE_DIR", choice.path);
        if (updated !== null) writeFileSync(envPath, updated, { mode: 0o600 });
        console.log(`Open Harness will keep its data in ${choice.path}.`);
        console.log(`Docker cannot read ${projectDefault}, so agents started there would never receive their profile or model credential.`);
        console.log(`Recorded as OPEN_HARNESS_STATE_DIR in .env; edit that line to choose another folder.`);
      }
    }
  }
} else if (command === "install-service") {
  const unitDir = resolve(process.env.XDG_CONFIG_HOME || `${process.env.HOME}/.config`, "systemd/user"); mkdirSync(unitDir, { recursive: true });
  const unit = `[Unit]\nDescription=Open Harness local control service\nAfter=docker-desktop.service docker.service\n\n[Service]\nType=simple\nWorkingDirectory=${project}\nExecStart=/usr/bin/env npm run harness:serve\nRestart=on-failure\nEnvironment=OPEN_HARNESS_STATE_DIR=${state}\n\n[Install]\nWantedBy=default.target\n`;
  writeFileSync(resolve(unitDir, "open-harness.service"), unit); run("systemctl", ["--user", "daemon-reload"]); if (!process.exitCode) run("systemctl", ["--user", "enable", "--now", "open-harness.service"]);
} else if (command === "start") {
  run("systemctl", ["--user", "start", "open-harness.service"]);
} else if (command === "stop") {
  run("systemctl", ["--user", "stop", "open-harness.service"]);
} else if (command === 'runner') {
  run(process.execPath, ['--import', 'tsx', 'runtime/runner.ts', ...process.argv.slice(3)]);
} else if (command === 'runner-install') {
  const docker = dockerStatus(false);
  if (docker.available && imageContract() !== 'current') {
    const built = spawnSync('docker', ['build', '-f', 'runtime/hermes/Dockerfile', '-t', HERMES_IMAGE, '.'], { cwd: project, stdio: 'inherit' }); if (built.status !== 0) process.exit(built.status || 1);
  }
  const nativeReady = spawnSync(process.env.HERMES_PYTHON || 'python3', ['-c', 'import hermes_cli, open_harness_policy'], { stdio: 'ignore', timeout: 8_000 }).status === 0;
  if (!docker.available && !nativeReady) { console.error('This machine needs Docker for isolated agents or a local Hermes installation for direct access.'); process.exit(1); }
  const forwarded = process.argv.slice(3), paired = spawnSync(process.execPath, ['--import', 'tsx', 'runtime/runner.ts', ...forwarded, '--once', '1'], { cwd: project, stdio: 'inherit' });
  if (paired.status !== 0) process.exitCode = paired.status || 1;
  else if (process.platform === 'linux') {
    const unitDir = resolve(process.env.XDG_CONFIG_HOME || `${process.env.HOME}/.config`, 'systemd/user'); mkdirSync(unitDir, { recursive: true });
    writeFileSync(resolve(unitDir, 'open-harness-runner.service'), `[Unit]\nDescription=Open Harness machine runner\nAfter=network-online.target docker.service\n\n[Service]\nType=simple\nWorkingDirectory=${project}\nExecStart=${process.execPath} --import tsx runtime/runner.ts\nRestart=always\nRestartSec=3\n\n[Install]\nWantedBy=default.target\n`);
    run('systemctl', ['--user', 'daemon-reload']); if (!process.exitCode) run('systemctl', ['--user', 'enable', '--now', 'open-harness-runner.service']);
    const linger = spawnSync('loginctl', ['show-user', process.env.USER || '', '--property=Linger', '--value'], { encoding: 'utf8' }); if (linger.status === 0 && linger.stdout.trim() !== 'yes') console.warn(`For an always-on VPS, run: sudo loginctl enable-linger ${process.env.USER || '<runner-user>'}`);
  } else if (process.platform === 'darwin') {
    const dir = resolve(`${process.env.HOME}/Library/LaunchAgents`); mkdirSync(dir, { recursive: true }); const path = resolve(dir, 'app.open-harness.runner.plist');
    writeFileSync(path, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>app.open-harness.runner</string><key>ProgramArguments</key><array><string>${process.execPath}</string><string>--import</string><string>tsx</string><string>${resolve(project, 'runtime/runner.ts')}</string></array><key>WorkingDirectory</key><string>${project}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>`); chmodSync(path, 0o600); run('launchctl', ['bootstrap', `gui/${process.getuid?.() || 501}`, path]);
  } else if (process.platform === 'win32') {
    const taskCommand = `\"${process.execPath}\" --import tsx \"${resolve(project, 'runtime/runner.ts')}\"`;
    run('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', 'Open Harness Runner', '/TR', taskCommand]); run('schtasks', ['/Run', '/TN', 'Open Harness Runner']);
  } else { console.error('Automatic runner startup is supported on Linux, macOS, and Windows.'); process.exitCode = 2; }
} else { console.error(`Unknown command: ${command}\n`); console.error(USAGE); process.exitCode = 2; }
