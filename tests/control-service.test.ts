/* eslint-disable @typescript-eslint/no-explicit-any */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";

// A generous budget: these loops only need to outlast a slow or loaded machine, and
// `npm test --test-timeout` is the real backstop. Fixed iteration counts gave them four
// seconds, which a busy runner could exceed while the coordinator was working correctly.
const POLL_BUDGET_MS = 30_000;

let child: ChildProcess;
let stateDir: string;
const port = 14317;
const base = `http://127.0.0.1:${port}`;
let token = "";
async function waitReady() {
  const deadline = Date.now() + POLL_BUDGET_MS;
  while (Date.now() < deadline) {
    try { const response = await fetch(`${base}/v1/bootstrap`); if (response.ok) { const value = await response.json() as { token: string }; token = value.token; return; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Control service did not start.");
}
function start() {
  child = spawn(process.execPath, ["--import", "tsx", "runtime/service.ts"], { cwd: join(import.meta.dirname, ".."), env: { ...process.env, OPEN_HARNESS_MOCK: "1", OPEN_HARNESS_PORT: String(port), OPEN_HARNESS_STATE_DIR: stateDir }, stdio: "pipe" });
  return waitReady();
}
async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers } });
  const value = await response.json(); if (!response.ok) throw new Error(JSON.stringify(value)); return value as any;
}
async function waitRun(id: string) {
  const deadline = Date.now() + POLL_BUDGET_MS;
  while (Date.now() < deadline) { const run = await request(`/v1/runs/${id}`); if (["completed","failed","interrupted","cancelled"].includes(run.state)) return run; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error("Run did not finish.");
}

test.before(async () => { stateDir = mkdtempSync(join(tmpdir(), "open-harness-control-")); await start(); });
test.after(() => child.kill("SIGTERM"));

test("reports first-run readiness and serves no-checkout runner installers", async () => {
  const readiness = await request('/v1/onboarding/status');
  assert.equal(readiness.executionReady, true);
  assert.equal(readiness.credentialMode, 'coordinator');
  assert.ok(readiness.checks.every((check: any) => check.id && check.detail));
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
  const approvalDeadline = Date.now() + POLL_BUDGET_MS;
  while (Date.now() < approvalDeadline) { const events = await request(`/v1/runs/${run.id}/events?after=0`); approval = events.events.find((event: any) => event.type === "approval.request"); if (approval) break; await new Promise(resolve => setTimeout(resolve, 50)); }
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
  await request("/v1/teams", { method: "POST", body: JSON.stringify({ name: "Delegation team", description: "Shared handoffs", color: "blue", icon: "people", memberAgentIds: ["atlas", "scout"] }) });
  const { profile } = await request("/v1/agents/atlas/profile");
  await request("/v1/agents/atlas/profile", { method: "PUT", body: JSON.stringify({ ...profile, allowedTools: ["mcp__open_harness__delegate_named_agent"] }) });
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

test("blocks named handoffs when agents do not share an active team", async () => {
  await request("/v1/agents/sync", { method: "POST", body: JSON.stringify({ agents: [{ id: "solo", name: "Solo", role: "Independent", instructions: "Work alone.", config: { model: "mock" } }] }) });
  const parent = await request("/v1/runs", { method: "POST", body: JSON.stringify({ agentId: "atlas", prompt: "MOCK_SLOW work independently" }) });
  await new Promise(resolve => setTimeout(resolve, 80));
  const scoped = createHmac("sha256", token).update("agent:atlas").digest("hex");
  const response = await fetch(`${base}/internal/handoff`, { method: "POST", headers: { Authorization: `Bearer ${scoped}`, "X-Open-Harness-Agent": "atlas", "Content-Type": "application/json" }, body: JSON.stringify({ agentId: "solo", prompt: "Try to join" }) });
  assert.equal(response.status, 403);
  assert.match(JSON.stringify(await response.json()), /share an active team/);
  await waitRun(parent.id);
});

test("persists boards and tasks, rejects stale edits, and preserves assignments", async () => {
  const snapshot = await request("/v1/tasks");
  assert.equal(snapshot.boards.length, 1);
  const board = snapshot.boards[0];
  assert.deepEqual(board.stages.map((stage: any) => stage.category), ["backlog", "ready", "in_progress", "review", "done"]);
  const team = await request("/v1/teams", { method: "POST", body: JSON.stringify({ name: "Launch collaborators", description: "Task collaborators", color: "sage", icon: "rocket", memberAgentIds: ["atlas", "scout"] }) });
  const task = await request("/v1/tasks", { method: "POST", body: JSON.stringify({
    boardId: board.id, title: "Prepare launch brief", description: "Summarize the launch plan.",
    teamId: team.id, ownerAgentId: "atlas", collaboratorAgentIds: ["scout", "scout"], priority: "high",
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

test("manages multi-team membership and protects scoped task references", async () => {
  const board = (await request("/v1/tasks")).boards[0];
  const team = await request("/v1/teams", { method: "POST", body: JSON.stringify({ name: "Operations", description: "Release operations", color: "teal", icon: "shield", memberAgentIds: ["atlas", "solo"] }) });
  assert.deepEqual(team.memberAgentIds.sort(), ["atlas", "solo"]);
  assert.ok((await request("/v1/teams")).teams.some((item: any) => item.id === team.id));

  const stale = await fetch(`${base}/v1/teams/${team.id}`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ ...team, revision: team.revision - 1 }) });
  assert.equal(stale.status, 409);

  const invalidUnscoped = await fetch(`${base}/v1/tasks`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ boardId: board.id, title: "Invalid collaboration", ownerAgentId: "atlas", collaboratorAgentIds: ["solo"] }) });
  assert.equal(invalidUnscoped.status, 400);
  const wrongTeamOwner = await fetch(`${base}/v1/tasks`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ boardId: board.id, teamId: team.id, title: "Wrong owner", ownerAgentId: "scout" }) });
  assert.equal(wrongTeamOwner.status, 400);

  const task = await request("/v1/tasks", { method: "POST", body: JSON.stringify({ boardId: board.id, teamId: team.id, title: "Scoped operation", ownerAgentId: "atlas", collaboratorAgentIds: ["solo"] }) });
  const blockedMember = await fetch(`${base}/v1/teams/${team.id}`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ ...team, memberAgentIds: ["solo"] }) });
  assert.equal(blockedMember.status, 409);
  const blockedDelete = await fetch(`${base}/v1/teams/${team.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  assert.equal(blockedDelete.status, 409);

  const archived = await request(`/v1/tasks/${task.id}`, { method: "PUT", body: JSON.stringify({ revision: task.revision, archived: true }) });
  assert.equal(archived.archived, true);
  const currentTeam = (await request(`/v1/teams/${team.id}`));
  await request(`/v1/teams/${team.id}`, { method: "PUT", body: JSON.stringify({ ...currentTeam, memberAgentIds: [] }) });
  const retired = await request(`/v1/teams/${team.id}`, { method: "DELETE" });
  assert.ok(retired.retiredAt);
  assert.ok(!(await request("/v1/teams")).teams.some((item: any) => item.id === team.id));
  assert.ok((await request("/v1/teams?includeRetired=1")).teams.some((item: any) => item.id === team.id));
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

test("creates, decorates, reorders, and duplicates projects", async () => {
  const created = await request("/v1/boards", { method: "POST", body: JSON.stringify({ name: "Website launch", description: "Ship the new site.", color: "blue", defaultOwnerAgentId: "atlas" }) });
  assert.equal(created.description, "Ship the new site.");
  assert.equal(created.color, "blue");
  assert.equal(created.defaultOwnerAgentId, "atlas");
  // Positions never drop to zero, which is what keeps the one-time seed from rerunning.
  assert.ok(created.position >= 1000);
  // An unrecognized colour falls back to what is stored rather than failing the save.
  const repaired = await request(`/v1/boards/${created.id}`, { method: "PUT", body: JSON.stringify({ revision: created.revision, color: "chartreuse" }) });
  assert.equal(repaired.color, "blue");

  const second = await request("/v1/boards", { method: "POST", body: JSON.stringify({ name: "Research" }) });
  assert.equal(second.color, "sage");
  const ids = (await request("/v1/boards")).boards.map((item: any) => item.id);
  const swapped = [...ids.slice(0, -2), ids.at(-1), ids.at(-2)];
  await request("/v1/boards/reorder", { method: "POST", body: JSON.stringify({ ids: swapped }) });
  assert.deepEqual((await request("/v1/boards")).boards.map((item: any) => item.id), swapped);

  const task = await request("/v1/tasks", { method: "POST", body: JSON.stringify({ boardId: created.id, title: "Draft the hero copy" }) });
  const summary = (await request("/v1/tasks")).summaries.find((item: any) => item.boardId === created.id);
  assert.equal(summary.total, 1);
  assert.equal(summary.byCategory.backlog, 1);
  assert.deepEqual(summary.ownerAgentIds, ["atlas"]);

  const copy = await request(`/v1/boards/${created.id}/duplicate`, { method: "POST", body: JSON.stringify({ includeTasks: true }) });
  assert.equal(copy.name, "Website launch copy");
  assert.equal(copy.description, "Ship the new site.");
  assert.deepEqual(copy.stages.map((stage: any) => stage.name), created.stages.map((stage: any) => stage.name));
  assert.ok(copy.stages.every((stage: any) => !created.stages.some((old: any) => old.id === stage.id)));
  // Automation has to follow the copy, not keep pointing at the original's stages.
  assert.ok(copy.stages.some((stage: any) => stage.id === copy.settings.runStageId));
  assert.ok(copy.stages.some((stage: any) => stage.id === copy.settings.doneStageId));
  const copied = (await request("/v1/tasks")).tasks.filter((item: any) => item.boardId === copy.id);
  assert.equal(copied.length, 1);
  assert.equal(copied[0].title, "Draft the hero copy");
  assert.notEqual(copied[0].id, task.id);
  assert.equal(copied[0].activeRunId, null);

  const template = await request(`/v1/boards/${created.id}/duplicate`, { method: "POST", body: JSON.stringify({ name: "Launch template" }) });
  assert.equal((await request("/v1/tasks")).tasks.filter((item: any) => item.boardId === template.id).length, 0);
});

test("applies the project default owner to new tasks", async () => {
  const board = await request("/v1/boards", { method: "POST", body: JSON.stringify({ name: "Owned work", defaultOwnerAgentId: "atlas" }) });
  assert.equal((await request("/v1/tasks", { method: "POST", body: JSON.stringify({ boardId: board.id, title: "Inherits the owner" }) })).ownerAgentId, "atlas");
  // An explicit null is a decision, not an omission, so it stays unassigned.
  assert.equal((await request("/v1/tasks", { method: "POST", body: JSON.stringify({ boardId: board.id, title: "Stays unassigned", ownerAgentId: null }) })).ownerAgentId, null);
});

test("archiving a project takes its tasks out of the cross-project views", async () => {
  const board = await request("/v1/boards", { method: "POST", body: JSON.stringify({ name: "Paused work" }) });
  const task = await request("/v1/tasks", { method: "POST", body: JSON.stringify({ boardId: board.id, title: "Waits for later" }) });
  await request(`/v1/boards/${board.id}`, { method: "PUT", body: JSON.stringify({ revision: board.revision, archived: true }) });
  assert.ok(!(await request("/v1/tasks")).tasks.some((item: any) => item.id === task.id));
  assert.ok((await request("/v1/tasks?includeArchived=1")).tasks.some((item: any) => item.id === task.id));
  // The project itself is still summarized so the Projects view can offer to restore it.
  assert.ok((await request("/v1/tasks")).summaries.some((item: any) => item.boardId === board.id));
});

test("refuses unsafe project deletes and cascades the safe ones", async () => {
  const board = await request("/v1/boards", { method: "POST", body: JSON.stringify({ name: "Throwaway" }) });
  const task = await request("/v1/tasks", { method: "POST", body: JSON.stringify({ boardId: board.id, title: "Long job", description: "MOCK_SLOW", ownerAgentId: "atlas" }) });
  const started = await request(`/v1/tasks/${task.id}/start`, { method: "POST", body: JSON.stringify({ revision: task.revision, idempotencyKey: crypto.randomUUID() }) });
  await assert.rejects(request(`/v1/boards/${board.id}`, { method: "DELETE" }), /running tasks/);
  await request(`/v1/tasks/${task.id}/stop`, { method: "POST" });
  await waitRun(started.run.id);
  const removed = await request(`/v1/boards/${board.id}`, { method: "DELETE" });
  assert.equal(removed.deletedTasks, 1);
  await assert.rejects(request(`/v1/tasks/${task.id}`), /not found/i);
  assert.ok(!(await request("/v1/boards")).boards.some((item: any) => item.id === board.id));
  // The run is the durable execution log and outlives the task it was started from.
  assert.equal((await request(`/v1/runs/${started.run.id}`)).id, started.run.id);
});

test("gates agent project management on the board permission", async () => {
  const setPermission = async (manageProjects: boolean) => {
    const { profile } = await request("/v1/agents/atlas/profile");
    await request("/v1/agents/atlas/profile", { method: "PUT", body: JSON.stringify({ ...profile, board: { ...profile.board, manageProjects } }) });
  };
  await setPermission(false);
  const run = await request("/v1/runs", { method: "POST", body: JSON.stringify({ agentId: "atlas", prompt: "MOCK_SLOW hold a board session open" }) });
  await new Promise(resolve => setTimeout(resolve, 80));
  const scoped = createHmac("sha256", token).update("agent:atlas").digest("hex");
  const call = (payload: unknown) => fetch(`${base}/internal/task`, { method: "POST", headers: { Authorization: `Bearer ${scoped}`, "X-Open-Harness-Agent": "atlas", "X-Open-Harness-Run": run.id, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  assert.equal((await call({ action: "board_create", input: { name: "Agent project" } })).status, 403);

  await setPermission(true);
  const allowed = await call({ action: "board_create", input: { name: "Agent project", description: "Opened by an agent." } });
  assert.equal(allowed.status, 201);
  const board = await allowed.json() as any;
  assert.equal(board.description, "Opened by an agent.");
  assert.equal(board.settings.allowAgentDispatch, true);

  await request(`/v1/boards/${board.id}`, { method: "PUT", body: JSON.stringify({ revision: board.revision, settings: { ...board.settings, allowAgentDispatch: false } }) });
  const changed = await call({ action: "board_update", boardId: board.id, input: { name: "Agent project v2", settings: { allowAgentDispatch: true }, archived: true } });
  assert.equal(changed.status, 200);
  const updated = await changed.json() as any;
  assert.equal(updated.name, "Agent project v2");
  // Automation and archive state stay under human control even with the permission on.
  assert.equal(updated.settings.allowAgentDispatch, false);
  assert.equal(updated.archived, false);
  await request(`/v1/runs/${run.id}/stop`, { method: "POST" });
});

test("moves, checks, and deletes task records", async () => {
  const board = await request("/v1/boards", { method: "POST", body: JSON.stringify({ name: "Task route parity" }) });
  const ready = board.stages.find((stage: any) => stage.category === "ready");
  const task = await request("/v1/tasks", { method: "POST", body: JSON.stringify({ boardId: board.id, title: "Walk the routes", checklist: [{ text: "First step" }] }) });
  const moved = await request(`/v1/tasks/${task.id}/move`, { method: "POST", body: JSON.stringify({ stageId: ready.id }) });
  assert.equal(moved.stageId, ready.id);
  const checked = await request(`/v1/tasks/${task.id}/check`, { method: "POST", body: JSON.stringify({ item: moved.checklist[0].id }) });
  assert.equal(checked.checklist[0].done, true);
  const added = await request(`/v1/tasks/${task.id}/additem`, { method: "POST", body: JSON.stringify({ text: "Second step" }) });
  assert.deepEqual(added.checklist.map((item: any) => item.text), ["First step", "Second step"]);
  await request(`/v1/tasks/${task.id}`, { method: "DELETE" });
  await assert.rejects(request(`/v1/tasks/${task.id}`), /not found/i);
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

// Last: this archives every other project, so it must not run before the tests above.
test("keeps at least one project", async () => {
  const boards = (await request("/v1/boards")).boards;
  const survivor = boards[0];
  for (const board of boards.slice(1)) await request(`/v1/boards/${board.id}`, { method: "PUT", body: JSON.stringify({ revision: board.revision, archived: true }) });
  await assert.rejects(request(`/v1/boards/${survivor.id}`, { method: "DELETE" }), /another project/);
});

// The coordination schema nests an action's fields under `input`, and nothing else said so: a
// model that put stageId alongside `action` got "Stage is required." with no hint, and one that
// sent `input` as a JSON string would have had it spread into one key per character.
test("the task tool accepts its fields nested, alongside the action, or as a JSON string", async () => {
  const board = (await request("/v1/boards")).boards[0];
  const review = board.stages.find((stage: any) => stage.category === "review");
  // The route needs a live run whose snapshot grants the tool, so park one on an approval.
  const held = await request("/v1/runs", { method: "POST", body: JSON.stringify({ agentId: "atlas", prompt: "MOCK_APPROVAL hold the run open" }) });
  const parked = Date.now() + POLL_BUDGET_MS;
  while (Date.now() < parked && (await request(`/v1/runs/${held.id}`)).state !== "waiting_approval") await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await request(`/v1/runs/${held.id}`)).state, "waiting_approval");
  const scoped = createHmac("sha256", token).update("agent:atlas").digest("hex");
  async function move(body: object) {
    const created = await request("/v1/tasks", { method: "POST", body: JSON.stringify({ boardId: board.id, title: `Nested ${crypto.randomUUID()}`, ownerAgentId: "atlas" }) });
    const response = await fetch(`${base}/internal/task`, { method: "POST", headers: { Authorization: `Bearer ${scoped}`, "X-Open-Harness-Agent": "atlas", "X-Open-Harness-Run": held.id, "Content-Type": "application/json" }, body: JSON.stringify({ action: "move", taskId: created.id, ...body }) });
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
    return (await request("/v1/tasks")).tasks.find((task: any) => task.id === created.id).stageId;
  }
  try {
    assert.equal(await move({ input: { stageId: review.id } }), review.id, "nested is the documented shape");
    assert.equal(await move({ stageId: review.id }), review.id, "alongside the action must work too");
    assert.equal(await move({ input: JSON.stringify({ stageId: review.id }) }), review.id, "a JSON string must be parsed, not spread");
  } finally {
    const events = await request(`/v1/runs/${held.id}/events?after=0`);
    const approval = events.events.find((event: any) => event.type === "approval.request");
    await request(`/v1/runs/${held.id}/approval`, { method: "POST", body: JSON.stringify({ approvalId: approval.payload.approvalId, decision: "approve" }) });
    await waitRun(held.id);
  }
});
