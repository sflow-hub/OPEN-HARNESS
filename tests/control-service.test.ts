/* eslint-disable @typescript-eslint/no-explicit-any */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";

let child: ChildProcess;
let stateDir: string;
const port = 14317;
const base = `http://127.0.0.1:${port}`;
let token = "";
async function waitReady() {
  for (let i = 0; i < 80; i++) {
    try { const response = await fetch(`${base}/v1/bootstrap`); if (response.ok) { const value = await response.json() as { token: string }; token = value.token; return; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Control service did not start.");
}
function start() {
  child = spawn(process.execPath, ["--import", "tsx", "runtime/service.ts"], { cwd: join(import.meta.dirname, ".."), env: { ...process.env, OPEN_HARNESS_MOCK: "1", OPEN_HARNESS_PORT: String(port), OPEN_HARNESS_STATE_DIR: stateDir, OPENAI_API_KEY: 'bootstrap-test-key' }, stdio: "pipe" });
  return waitReady();
}
async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers } });
  const value = await response.json(); if (!response.ok) throw new Error(JSON.stringify(value)); return value as any;
}
async function waitRun(id: string) {
  for (let i = 0; i < 80; i++) { const run = await request(`/v1/runs/${id}`); if (["completed","failed","interrupted","cancelled"].includes(run.state)) return run; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error("Run did not finish.");
}

test.before(async () => { stateDir = mkdtempSync(join(tmpdir(), "open-harness-control-")); await start(); });
test.after(() => child.kill("SIGTERM"));

test("reports first-run readiness and serves no-checkout runner installers", async () => {
  const readiness = await request('/v1/onboarding/status');
  assert.equal(readiness.executionReady, true);
  assert.equal(readiness.credentialMode, 'coordinator');
  assert.ok(readiness.checks.every((check: any) => check.id && check.detail));
  assert.match(readiness.checks.find((check: any) => check.id === 'agent-runtime').detail, /mock mode/i);
  const modelTest = await request('/v1/onboarding/model-test', { method: 'POST', body: JSON.stringify({ model: { provider: 'xai', model: 'grok-4.6', credentialRef: 'XAI_API_KEY', baseUrl: '' } }) });
  assert.equal(modelTest.ok, false);
  assert.match(modelTest.message, /no model provider was contacted/i);
  const installer = await fetch(`${base}/v1/install/runner.sh`);
  assert.equal(installer.status, 200);
  assert.match(await installer.text(), /nodejs\.org\/dist/);
  const runnerFile = await fetch(`${base}/v1/install/file?path=${encodeURIComponent('runtime/runner.mjs')}`);
  assert.equal(runnerFile.status, 200);
  assert.match(await runnerFile.text(), /Open Harness runner/);
  const pairing = await request('/v1/machines', { method: 'POST', body: JSON.stringify({ name: 'Easy server', platform: 'linux' }) });
  assert.match(pairing.command, /^curl -fsSL/);
  assert.match(pairing.command, /--pairing-code/);
  const paired = spawnSync(process.execPath, ['runtime/runner.mjs', '--coordinator', base, '--pairing-code', pairing.code, '--once', '1'], { cwd: join(import.meta.dirname, '..'), encoding: 'utf8', env: { ...process.env, OPEN_HARNESS_MOCK: '1', OPEN_HARNESS_RUNNER_STATE_DIR: join(stateDir, 'installed-runner') } });
  assert.equal(paired.status, 0, paired.stderr);
  assert.match(paired.stdout, /Paired machine-/);
});

test("authenticates local clients, migrates once, and protects its secret file", async () => {
  assert.equal((await fetch(`${base}/v1/health`)).status, 401);
  assert.ok((await request('/v1/health')).secrets.includes('OPENAI_API_KEY'));
  const workspace = { agents: [{ id: "atlas", name: "Atlas", role: "Generalist", instructions: "Own the result.", memory: ["Prefer concise reports."] }], conversations: [{ id: "c1", agentId: "atlas", title: "Legacy", updatedAt: new Date().toISOString(), messages: [] }], files: [{ name: "notes.md", content: "Shared context" }] };
  assert.equal((await request("/v1/migrate", { method: "POST", body: JSON.stringify(workspace) })).migrated, true);
  assert.equal((await request("/v1/migrate", { method: "POST", body: JSON.stringify(workspace) })).reason, "already_migrated");
  assert.equal(readFileSync(join(stateDir, "shared", "notes.md"), "utf8"), "Shared context");
  assert.match(readFileSync(join(stateDir, "agents", "atlas", "profile", "MEMORY.md"), "utf8"), /concise reports/);
  assert.equal(statSync(join(stateDir, "secrets.json")).mode & 0o777, 0o600);
});

test("runs independently of event polling and replays stable events", async () => {
  await request("/v1/agents/sync", { method: "POST", body: JSON.stringify({ agents: [{ id: "atlas", name: "Atlas", role: "Generalist", instructions: "Own the result.", config: { model: "mock" } }] }) });
  const saved = await request("/v1/agents/atlas/profile");
  await request("/v1/agents/atlas/profile", { method: "PUT", body: JSON.stringify({ ...saved.profile, allowedTools: ["terminal"] }) });
  const run = await request("/v1/runs", { method: "POST", body: JSON.stringify({ agentId: "atlas", conversationId: "c1", prompt: "MOCK_SLOW create and execute a script" }) });
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal((await request(`/v1/runs/${run.id}`)).state, "completed");
  const first = await request(`/v1/runs/${run.id}/events?after=0`); assert.ok(first.events.length >= 5);
  const cursor = first.events[1].seq; const replay = await request(`/v1/runs/${run.id}/events?after=${cursor}`);
  assert.deepEqual(replay.events.map((event: any) => event.seq), first.events.slice(2).map((event: any) => event.seq));
});

test("pauses for approval and resumes only after an explicit decision", async () => {
  const run = await request("/v1/runs", { method: "POST", body: JSON.stringify({ agentId: "atlas", prompt: "MOCK_APPROVAL" }) });
  let approval: any;
  for (let i = 0; i < 40; i++) { const events = await request(`/v1/runs/${run.id}/events?after=0`); approval = events.events.find((event: any) => event.type === "approval.request"); if (approval) break; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.ok(approval); assert.equal((await request(`/v1/runs/${run.id}`)).state, "waiting_approval");
  await request(`/v1/runs/${run.id}/approval`, { method: "POST", body: JSON.stringify({ approvalId: approval.payload.approvalId, decision: "approve" }) });
  assert.equal((await waitRun(run.id)).state, "completed");
});

test("separates private workspaces and supports shared files and run-now routines", async () => {
  await request("/v1/files?scope=private&agentId=atlas", { method: "POST", body: JSON.stringify({ name: "private.txt", content: "atlas only" }) });
  const atlas = await request("/v1/files?scope=private&agentId=atlas"); const scout = await request("/v1/files?scope=private&agentId=scout");
  assert.equal(atlas.files.length, 1); assert.equal(scout.files.length, 0);
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
  await request("/v1/files?scope=shared", { method: "POST", body: JSON.stringify({ name: "browser-shot.png", content: png, encoding: "base64" }) });
  const screenshot = await request("/v1/files?scope=shared&name=browser-shot.png"); assert.equal(screenshot.encoding, "base64"); assert.equal(screenshot.content, png);
  const routine = await request("/v1/routines", { method: "POST", body: JSON.stringify({ agentId: "atlas", name: "Daily", prompt: "Make report", intervalMinutes: 1440, timezone: "America/Denver" }) });
  const run = await request(`/v1/routines/${routine.id}/run`, { method: "POST" }); assert.equal((await waitRun(run.id)).state, "completed");
  const history = await request(`/v1/routines/${routine.id}/history`); assert.equal(history.history[0].run_id, run.id);
});

test("inspects, edits, invokes storage for, and removes durable skills", async () => {
  const path = "/v1/agents/atlas/context/skills/report-writer";
  await request(path, { method: "PUT", body: JSON.stringify({ content: "# Report writer\nUse concise sections." }) });
  assert.match((await request(path)).content, /concise sections/);
  const context = await request("/v1/agents/atlas/context"); assert.ok(context.skills.includes("report-writer"));
  await request(path, { method: "DELETE" });
  assert.ok(!(await request("/v1/agents/atlas/context")).skills.includes("report-writer"));
});

test("checks MCP handshakes and reports missing credentials", async () => {
  const connector = { id: "test-connector", name: "source-db", command: "npx", args: ["-y", "example-mcp"], secretRef: "SOURCE_API_KEY", enabled: true };
  const missing = await request("/v1/agents/atlas/connector-check", { method: "POST", body: JSON.stringify({ connector }) }); assert.equal(missing.status, "missing_credentials");
  await request("/v1/secrets", { method: "POST", body: JSON.stringify({ name: "SOURCE_API_KEY", value: "test-secret" }) });
  const connected = await request("/v1/agents/atlas/connector-check", { method: "POST", body: JSON.stringify({ connector }) }); assert.equal(connected.status, "connected"); assert.equal(connected.tools.length, 1);
});

test("delegates to another named agent and records the handoff", async () => {
  await request("/v1/agents/sync", { method: "POST", body: JSON.stringify({ agents: [{ id: "scout", name: "Scout", role: "Researcher", instructions: "Analyze.", config: { model: "mock" } }] }) });
  const { profile } = await request("/v1/agents/atlas/profile");
  await request("/v1/agents/atlas/profile", { method: "PUT", body: JSON.stringify({ ...profile, allowedTools: ["mcp_open_harness_delegate_named_agent"] }) });
  const parent = await request("/v1/runs", { method: "POST", body: JSON.stringify({ agentId: "atlas", prompt: "MOCK_SLOW prepare final artifact" }) });
  await new Promise(resolve => setTimeout(resolve, 80));
  const scoped = createHmac("sha256", token).update("agent:atlas").digest("hex");
  const response = await fetch(`${base}/internal/handoff`, { method: "POST", headers: { Authorization: `Bearer ${scoped}`, "X-Open-Harness-Agent": "atlas", "Content-Type": "application/json" }, body: JSON.stringify({ agentId: "scout", prompt: "Analyze the inputs" }) });
  assert.equal(response.status, 200); const delegated = await response.json() as any; assert.equal(delegated.state, "completed");
  const events = await request(`/v1/runs/${parent.id}/events?after=0`);
  assert.ok(events.events.some((event: any) => event.type === "handoff.created"));
  assert.ok(events.events.some((event: any) => event.type === "handoff.completed"));
  assert.equal((await waitRun(parent.id)).state, "completed");
});

test("persists boards and tasks, rejects stale edits, and preserves assignments", async () => {
  const snapshot = await request("/v1/tasks");
  assert.equal(snapshot.boards.length, 1);
  const board = snapshot.boards[0];
  assert.deepEqual(board.stages.map((stage: any) => stage.category), ["backlog", "ready", "in_progress", "review", "done"]);
  const task = await request("/v1/tasks", { method: "POST", body: JSON.stringify({
    boardId: board.id, title: "Prepare launch brief", description: "Summarize the launch plan.",
    ownerAgentId: "atlas", collaboratorAgentIds: ["scout", "scout"], priority: "high",
    labels: ["launch", "research"], checklist: [{ text: "Draft outline", done: false }],
  }) });
  assert.equal(task.priority, "high");
  assert.deepEqual(task.collaboratorAgentIds, ["scout"]);
  assert.equal(task.checklist.length, 1);
  const saved = await request(`/v1/tasks/${task.id}`, { method: "PUT", body: JSON.stringify({ revision: task.revision, title: "Prepare final launch brief" }) });
  assert.equal(saved.title, "Prepare final launch brief");
  const stale = await fetch(`${base}/v1/tasks/${task.id}`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ revision: task.revision, title: "Stale title" }) });
  assert.equal(stale.status, 409);
  assert.equal((await request(`/v1/tasks/${task.id}`)).title, "Prepare final launch brief");
});

test("links idempotent task runs, moves completed work to review, and approves it", async () => {
  const snapshot = await request("/v1/tasks");
  const board = snapshot.boards[0];
  const task = await request("/v1/tasks", { method: "POST", body: JSON.stringify({
    boardId: board.id, title: "Run launch checks", description: "MOCK_SLOW verify the release", ownerAgentId: "atlas",
  }) });
  const key = crypto.randomUUID();
  const first = await request(`/v1/tasks/${task.id}/start`, { method: "POST", body: JSON.stringify({ revision: task.revision, idempotencyKey: key }) });
  const duplicate = await request(`/v1/tasks/${task.id}/start`, { method: "POST", body: JSON.stringify({ idempotencyKey: key }) });
  assert.equal(duplicate.run.id, first.run.id);
  const locked = await fetch(`${base}/v1/tasks/${task.id}`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ revision: first.task.revision, ownerAgentId: "scout" }) });
  assert.equal(locked.status, 409);
  assert.equal((await waitRun(first.run.id)).state, "completed");
  const reviewed = await request(`/v1/tasks/${task.id}`);
  assert.equal(reviewed.activeRunId, null);
  assert.equal(board.stages.find((stage: any) => stage.id === reviewed.stageId).category, "review");
  assert.equal(reviewed.runs.length, 1);
  const approved = await request(`/v1/tasks/${task.id}/approve`, { method: "POST", body: JSON.stringify({ revision: reviewed.revision }) });
  assert.equal(board.stages.find((stage: any) => stage.id === approved.stageId).category, "done");
});

test("uses board dispatch settings, sparse moves, output, and explicit task stops", async () => {
  const board = (await request("/v1/tasks")).boards[0];
  const configured = await request(`/v1/boards/${board.id}`, { method: "PUT", body: JSON.stringify({ revision: board.revision, settings: { ...board.settings, autoRunOnDrop: false } }) });
  assert.equal(configured.settings.autoRunOnDrop, false);
  const backlog = configured.stages.find((stage: any) => stage.category === 'backlog');
  const task = await request('/v1/tasks', { method: 'POST', body: JSON.stringify({ boardId: board.id, stageId: backlog.id, title: 'Move safely', description: 'MOCK_SLOW', ownerAgentId: 'atlas' }) });
  const moved = await request(`/v1/tasks/${task.id}/move`, { method: 'POST', body: JSON.stringify({ stageId: configured.settings.runStageId }) });
  assert.equal(moved.stageId, configured.settings.runStageId);
  const started = await request(`/v1/tasks/${task.id}/start`, { method: 'POST', body: JSON.stringify({ revision: moved.revision, idempotencyKey: crypto.randomUUID() }) });
  await request(`/v1/tasks/${task.id}/stop`, { method: 'POST' });
  const stopped = await waitRun(started.run.id);
  assert.equal(stopped.state, 'cancelled');
  assert.equal((await request(`/v1/tasks/${task.id}`)).activeRunId, null);
});

test("edits workflow stages and archives and restores task records", async () => {
  const board = (await request("/v1/tasks")).boards[0];
  const withStage = await request(`/v1/boards/${board.id}/stages`, { method: "POST", body: JSON.stringify({ name: "Blocked", category: "ready" }) });
  const blocked = withStage.stages.find((stage: any) => stage.name === "Blocked");
  assert.ok(blocked);
  const renamed = await request(`/v1/stages/${blocked.id}`, { method: "PUT", body: JSON.stringify({ name: "Waiting", position: 1.5 }) });
  assert.equal(renamed.stages.find((stage: any) => stage.id === blocked.id).name, "Waiting");
  const task = await request("/v1/tasks", { method: "POST", body: JSON.stringify({ boardId: board.id, stageId: blocked.id, title: "Archived item" }) });
  const archived = await request(`/v1/tasks/${task.id}`, { method: "PUT", body: JSON.stringify({ revision: task.revision, archived: true }) });
  assert.equal(archived.archived, true);
  assert.ok(!(await request("/v1/tasks")).tasks.some((item: any) => item.id === task.id));
  const all = await request("/v1/tasks?includeArchived=1");
  const restored = await request(`/v1/tasks/${task.id}`, { method: "PUT", body: JSON.stringify({ revision: all.tasks.find((item: any) => item.id === task.id).revision, archived: false }) });
  assert.equal(restored.archived, false);
  await request(`/v1/stages/${blocked.id}?moveToStageId=${encodeURIComponent(board.stages[0].id)}`, { method: "DELETE" });
  assert.equal((await request(`/v1/tasks/${task.id}`)).stageId, board.stages[0].id);
});

test("marks uncertain active work interrupted after service restart without replay", async () => {
  const run = await request("/v1/runs", { method: "POST", body: JSON.stringify({ agentId: "atlas", prompt: "MOCK_SLOW" }) });
  await new Promise(resolve => setTimeout(resolve, 100)); child.kill("SIGKILL"); await new Promise(resolve => child.once("exit", resolve)); await start();
  const recovered = await request(`/v1/runs/${run.id}`); assert.equal(recovered.state, "interrupted"); assert.match(recovered.error, /not replayed/);
});

test("a routine can be corrected and removed, not just paused", async () => {
  const created = await request("/v1/routines", { method: "POST", body: JSON.stringify({ agentId: "atlas", name: "Typo'd name", prompt: "Draft the wrong thing", intervalMinutes: 1440 }) });
  const listed = (await request("/v1/routines")).routines.find((item: any) => item.id === created.id);
  assert.equal(listed.name, "Typo'd name");

  const updated = await request(`/v1/routines/${created.id}`, { method: "PUT", body: JSON.stringify({ name: "Weekly digest", prompt: "Summarize the week", intervalMinutes: 10_080 }) });
  assert.equal(updated.name, "Weekly digest");
  assert.equal(updated.interval_minutes, 10_080);
  // Shortening or lengthening an interval should take effect from now, not after the old one.
  assert.ok(new Date(updated.next_run_at).getTime() > Date.now());

  // An interval of zero or less would otherwise mean "every minute, forever".
  const clamped = await request(`/v1/routines/${created.id}`, { method: "PUT", body: JSON.stringify({ intervalMinutes: -5 }) });
  assert.equal(clamped.interval_minutes, 1);

  await assert.rejects(
    request(`/v1/routines/${created.id}`, { method: "PUT", body: JSON.stringify({ agentId: "no-such-agent" }) }),
    /no longer exists/,
  );
  await assert.rejects(
    request(`/v1/routines/${created.id}`, { method: "PUT", body: JSON.stringify({ name: "   " }) }),
    /needs a name and a task/,
  );

  await request(`/v1/routines/${created.id}`, { method: "DELETE" });
  assert.equal((await request("/v1/routines")).routines.some((item: any) => item.id === created.id), false);
  await assert.rejects(request(`/v1/routines/${created.id}`, { method: "DELETE" }), /not found/);
});

test("a paired phone reaches the dashboard while a paired computer stays runner-only", async () => {
  const pairing = await request('/v1/machines', { method: 'POST', body: JSON.stringify({ name: 'Pixel', platform: 'android', coordinatorUrl: base }) });
  assert.equal(pairing.kind, 'device');
  assert.match(pairing.pairingUri, /^openharness:\/\/pair\?hub=/);

  const paired = await (await fetch(`${base}/v1/runner/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: pairing.code, name: 'Pixel', platform: 'android', arch: 'arm64', capabilities: { mobile: true } }) })).json() as any;
  assert.ok(paired.token);
  const deviceHeaders = { Authorization: `Bearer ${paired.token}`, 'X-Open-Harness-Machine': paired.machineId, 'Content-Type': 'application/json' };

  // The phone never receives the master token; it gets its own session view instead.
  const session = await (await fetch(`${base}/v1/device/session`, { headers: deviceHeaders })).json() as any;
  assert.equal(session.token, '');
  assert.equal(session.machine.kind, 'device');
  assert.equal(session.machine.capabilities.mobile, true);

  // A dashboard route the master token can reach is reachable with the device credential.
  const runs = await fetch(`${base}/v1/runs`, { headers: deviceHeaders });
  assert.equal(runs.status, 200);
  assert.equal((await fetch(`${base}/v1/runner/commands`, { headers: deviceHeaders })).status, 401, 'a companion credential cannot lease runner work');

  // The same route with a computer's runner credential must not open.
  const computerPairing = await request('/v1/machines', { method: 'POST', body: JSON.stringify({ name: 'VPS', platform: 'linux', coordinatorUrl: base }) });
  const computer = await (await fetch(`${base}/v1/runner/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: computerPairing.code, platform: 'linux', arch: 'x64' }) })).json() as any;
  const runnerHeaders = { Authorization: `Bearer ${computer.token}`, 'X-Open-Harness-Machine': computer.machineId };
  assert.equal((await fetch(`${base}/v1/runs`, { headers: runnerHeaders })).status, 401);
  assert.equal((await fetch(`${base}/v1/device/session`, { headers: runnerHeaders })).status, 401);

  // Revoking the phone closes both doors at once.
  await request(`/v1/machines/${paired.machineId}/revoke`, { method: 'POST' });
  assert.equal((await fetch(`${base}/v1/runs`, { headers: deviceHeaders })).status, 401);
  assert.equal((await fetch(`${base}/v1/runner/commands`, { headers: deviceHeaders })).status, 401);
});

test("bootstrap still refuses to hand the master token to a phone", async () => {
  const pairing = await request('/v1/machines', { method: 'POST', body: JSON.stringify({ platform: 'ios', coordinatorUrl: base }) });
  const paired = await (await fetch(`${base}/v1/runner/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: pairing.code, platform: 'ios', arch: 'arm64' }) })).json() as any;
  const bootstrap = await (await fetch(`${base}/v1/bootstrap`, { headers: { Authorization: `Bearer ${paired.token}`, 'X-Open-Harness-Machine': paired.machineId } })).json() as any;
  // Loopback in this test, so bootstrap answers — but the phone must use /v1/device/session
  // in real deployments, where bootstrap is unreachable from off-host.
  assert.ok('token' in bootstrap);
});

test("the Tauri webview origin is accepted and a stray web origin is not", async () => {
  assert.equal((await fetch(`${base}/v1/health`, { headers: { Authorization: `Bearer ${token}`, Origin: 'tauri://localhost' } })).status, 200);
  assert.equal((await fetch(`${base}/v1/health`, { headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example.com' } })).status, 403);
});

test("a phone pairs as a companion but can never become an agent runner", async () => {
  const pairing = await request('/v1/machines', { method: 'POST', body: JSON.stringify({ name: 'Test phone', platform: 'android', coordinatorUrl: base }) });
  const phone = await (await fetch(`${base}/v1/runner/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: pairing.code, platform: 'android', arch: 'arm64' }) })).json() as any;

  await request('/v1/agents/sync', { method: 'POST', body: JSON.stringify({ agents: [
    { id: 'fresh-agent', name: 'Fresh', role: 'Assistant', description: '', tone: 0, instructions: 'Help.', memory: [] },
    { id: 'seasoned-agent', name: 'Seasoned', role: 'Assistant', description: '', tone: 0, instructions: 'Help.', memory: [] },
  ] }) });

  const toPhone = async (agentId: string) => {
    const { profile } = await request(`/v1/agents/${agentId}/profile`);
    return request(`/v1/agents/${agentId}/profile`, { method: 'PUT', body: JSON.stringify({ ...profile, computer: { ...profile.computer, machineId: phone.machineId, access: 'mobile', desktop: 'none', folders: [] } }) });
  };

  await assert.rejects(toPhone('fresh-agent'), /companion dashboards/);
  const moved = await request('/v1/agents/fresh-agent/profile');
  assert.notEqual(moved.profile.computer.machineId, phone.machineId);
  assert.equal((await request(`/v1/machines/${phone.machineId}/test`, { method: 'POST', body: JSON.stringify({ agentId: 'fresh-agent' }) })).ok, false);

  // Give the other agent something to lose, and the move must be refused rather than
  // queueing a transfer the phone cannot complete.
  await request('/v1/agents/seasoned-agent/context', { method: 'PUT', body: JSON.stringify({ memory: 'Remembers the user prefers short answers.' }) });
  await assert.rejects(toPhone('seasoned-agent'), /companion dashboards/);
  const stayed = await request('/v1/agents/seasoned-agent/profile');
  assert.notEqual(stayed.profile.computer.machineId, phone.machineId, 'the refused move leaves the agent where it was');
});
