import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialWorkspace } from "../lib/types";

test("workflow service protects review APIs and delivers scoped external events exactly once", { timeout: 60_000 }, async t => {
  const state = mkdtempSync(join(tmpdir(), "harness-workflow-service-")), base = "http://127.0.0.1:14573";
  const child = spawn(process.execPath, ["--import", "tsx", "runtime/service.ts"], { cwd: join(import.meta.dirname, ".."), env: { ...process.env, OPEN_HARNESS_MOCK: "1", OPEN_HARNESS_DISABLE_OS_VAULT: "1", OPEN_HARNESS_PORT: "14573", OPEN_HARNESS_STATE_DIR: state }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const stopped = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM"); await stopped; } rmSync(state, { recursive: true, force: true }); });
  let token = "";
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Workflow fixture service exited: ${output}`);
    try { const response = await fetch(`${base}/v1/bootstrap`); if (response.ok) { token = (await response.json()).token; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(token, `Workflow fixture did not start: ${output}`);
  async function request(path: string, method = "GET", data?: unknown, credential = token, key?: string) {
    return fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(credential ? { Authorization: `Bearer ${credential}` } : {}), ...(key ? { "Idempotency-Key": key } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  }
  async function terminal(id: string) {
    const end = Date.now() + 20_000;
    while (Date.now() < end) { const run = await (await request(`/v1/runs/${id}`)).json(); if (["completed", "failed", "interrupted", "cancelled"].includes(run.state)) return run; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error("Workflow fixture run timed out.");
  }
  assert.equal((await request("/v1/agents/sync", "POST", { agents: initialWorkspace.agents })).status, 200);
  const source = await (await request("/v1/runs", "POST", { agentId: "atlas", prompt: "Prepare a scripted workflow report" })).json();
  assert.equal((await terminal(source.id)).state, "completed");
  const created = await request("/v1/workflows", "POST", { sourceRunId: source.id, name: "Integration report" }); assert.equal(created.status, 201);
  const workflow = await created.json(), path = `/v1/workflows/${workflow.id}`;
  assert.equal((await request("/v1/workflows", "GET", undefined, "")).status, 401);
  assert.equal((await request(path + "/routine", "POST", { revision: 1, schedule: { kind: "webhook" } })).status, 409);
  assert.equal((await request(path + "/review", "POST", { revision: 1 })).status, 200);
  const started = await request(path + "/test", "POST", { revision: 1 }); assert.equal(started.status, 202);
  const { run } = await started.json(); assert.equal((await terminal(run.id)).state, "completed");
  assert.equal((await request(path + `/tests/${run.id}/review`, "POST", { revision: 1, passed: true, evidence: "Scripted fixture result and destination checked." })).status, 200);
  assert.equal((await request(path + "/publish", "POST", { revision: 1 })).status, 200);
  assert.equal((await request(path + "/routine", "POST", { revision: 1, schedule: { kind: "webhook" } })).status, 200);
  const credential = await (await request(path + "/webhook/rotate", "POST", {})).json();
  assert.equal((await request(credential.path, "POST", {}, "bad", "event-1")).status, 401);
  assert.equal((await request("/v1/workflows", "GET", undefined, credential.secret)).status, 401);
  const triggered = await request(credential.path, "POST", { context: "The event is ready." }, credential.secret, "event-1"); assert.equal(triggered.status, 202);
  const first = await triggered.json(), duplicate = await (await request(credential.path, "POST", {}, credential.secret, "event-1")).json();
  assert.equal(duplicate.runId, first.runId); assert.equal(duplicate.duplicate, true); assert.equal((await terminal(first.runId)).state, "completed");
  const snapshot = await (await request(path)).text(); assert.ok(!snapshot.includes(credential.secret)); assert.ok(!snapshot.includes("webhook_hash"));
  const rotated = await (await request(path + "/webhook/rotate", "POST", {})).json(); assert.notEqual(rotated.secret, credential.secret);
  assert.equal((await request(credential.path, "POST", {}, credential.secret, "event-2")).status, 401);
});
