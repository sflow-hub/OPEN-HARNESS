import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  const unit = `[Unit]\nDescription=Open Harness local control service\nAfter=docker.service\n\n[Service]\nType=simple\nWorkingDirectory=${project}\nExecStart=/usr/bin/env npm run harness:serve\nRestart=on-failure\nEnvironment=OPEN_HARNESS_STATE_DIR=${state}\n\n[Install]\nWantedBy=default.target\n`;
  writeFileSync(resolve(unitDir, "open-harness.service"), unit); run("systemctl", ["--user", "daemon-reload"]); if (!process.exitCode) run("systemctl", ["--user", "enable", "--now", "open-harness.service"]);
} else if (command === "start") {
  run("systemctl", ["--user", "start", "open-harness.service"]);
} else if (command === "stop") {
  run("systemctl", ["--user", "stop", "open-harness.service"]);
} else { console.error("Usage: npm run harness -- setup|start|stop|doctor|status|install-service"); process.exitCode = 2; }
