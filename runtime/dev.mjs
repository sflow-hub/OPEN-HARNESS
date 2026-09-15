import { spawn } from "node:child_process";
import { ensureDockerStarted } from "./start-docker.mjs";

try { await ensureDockerStarted(); }
catch (error) { console.error(`Open Harness startup stopped: ${error instanceof Error ? error.message : "Docker could not be started."}`); process.exit(1); }

const children = [
  spawn(process.execPath, ["--watch", "--watch-preserve-output", "--import", "tsx", "runtime/service.ts"], { stdio: "inherit" }),
  spawn("npx", ["vinext", "dev"], { stdio: "inherit" }),
];
let stopping = false;
function stop(code = 0) { if (stopping) return; stopping = true; for (const child of children) child.kill("SIGTERM"); setTimeout(() => process.exit(code), 500).unref(); }
for (const child of children) child.on("exit", code => { if (!stopping && code) stop(code); });
process.on("SIGINT", () => stop()); process.on("SIGTERM", () => stop());
