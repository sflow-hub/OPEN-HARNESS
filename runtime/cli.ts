import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { dockerStatus } from "./hermes";

const command = process.argv[2] || "status";
const project = resolve(import.meta.dirname, "..");
const state = resolve(process.env.OPEN_HARNESS_STATE_DIR || `${project}/.open-harness`);
function run(name: string, args: string[]) { const result = spawnSync(name, args, { cwd: project, stdio: "inherit" }); process.exitCode = result.status || 0; }

if (command === "doctor" || command === "status") {
  const docker = dockerStatus(); console.log(docker.message);
  console.log(`Hermes image: ${spawnSync("docker", ["image", "inspect", "open-harness-hermes:2026.9.11"], { stdio: "ignore" }).status === 0 ? "ready" : "not built"}`);
  console.log(`Control service: ${existsSync(`${state}/state.db`) ? "state initialized" : "not initialized"}`);
  console.log("Pinned Hermes: v2026.9.11 (939e45c91d751fadd94dcd1b873ac3cb44846213)");
} else if (command === "setup") {
  const docker = dockerStatus(false); if (!docker.available) { console.error(docker.message); process.exitCode = 1; }
  else { mkdirSync(state, { recursive: true }); run("docker", ["build", "-f", "runtime/hermes/Dockerfile", "-t", "open-harness-hermes:2026.9.11", "."]); }
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
  if (docker.available && spawnSync('docker', ['image', 'inspect', 'open-harness-hermes:2026.9.11'], { stdio: 'ignore' }).status !== 0) {
    const built = spawnSync('docker', ['build', '-f', 'runtime/hermes/Dockerfile', '-t', 'open-harness-hermes:2026.9.11', '.'], { cwd: project, stdio: 'inherit' }); if (built.status !== 0) process.exit(built.status || 1);
  }
  const nativeReady = spawnSync(process.env.HERMES_PYTHON || 'python3', ['-c', 'import hermes_cli, open_harness_policy'], { stdio: 'ignore' }).status === 0;
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
} else { console.error("Usage: npm run harness -- setup|start|stop|doctor|status|install-service|runner|runner-install"); process.exitCode = 2; }
