/* eslint-disable @typescript-eslint/no-explicit-any */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coordinationToken } from '../runtime/coordination-auth';
import { Store } from "../runtime/db";
import { generateRunnerKeyPair } from '../lib/runner-crypto';

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
  child = spawn(process.execPath, ["--import", "tsx", "runtime/service.ts"], { cwd: join(import.meta.dirname, ".."), env: { ...process.env, OPEN_HARNESS_MOCK: "1", OPEN_HARNESS_DISABLE_OS_VAULT: "1", OPEN_HARNESS_PORT: String(port), OPEN_HARNESS_STATE_DIR: stateDir, OPEN_HARNESS_HANDOFF_WAIT_MS: "3000" }, stdio: "pipe" });
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
  const paired = spawnSync(process.execPath, ['runtime/runner.mjs', '--coordinator', base, '--pairing-code', pairing.code, '--once', '1'], { cwd: join(import.meta.dirname, '..'), encoding: 'utf8', env: { ...process.env, OPEN_HARNESS_MOCK: '1', OPEN_HARNESS_DISABLE_OS_VAULT: '1', OPEN_HARNESS_RUNNER_STATE_DIR: join(stateDir, 'installed-runner') } });
  assert.equal(paired.status, 0, paired.stderr);
  assert.match(paired.stdout, /Paired machine-/);
});

test('runner installers supply the Dockerfile file inputs through the restricted download route', async t => {
  const repo = join(import.meta.dirname, '..'), dockerfile = readFileSync(join(repo, 'runtime/hermes/Dockerfile'), 'utf8');
  const inputs = [...dockerfile.matchAll(/^COPY (?!-)(.+)$/gm)].flatMap(match => match[1].split(/\s+/).slice(0, -1)).filter(path => path.startsWith('runtime/') && !path.endsWith('/'));
  for (const directory of ['runtime/ubuntu/helpers', 'runtime/ubuntu/lock']) {
    assert.ok(dockerfile.includes(`COPY ${directory}/ `));
    inputs.push(...readdirSync(join(repo, directory)).filter(name => statSync(join(repo, directory, name)).isFile()).map(name => `${directory}/${name}`));
  }
  inputs.push('runtime/hermes/browser_shutdown.py');
  inputs.push('runtime/opencode-policy.mjs','runtime/opencode-policy-core.mjs');
  inputs.push(...readdirSync(join(repo, 'runtime/hermes/vendor/http-cache-semantics')).map(name => `runtime/hermes/vendor/http-cache-semantics/${name}`));
  assert.ok(inputs.length > 0);
  const powershell = await (await fetch(`${base}/v1/install/runner.ps1`)).text();
  for (const path of inputs) {
    const response = await fetch(`${base}/v1/install/file?path=${encodeURIComponent(path)}`);
    assert.equal(response.status, 200, path);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), readFileSync(join(repo, path)), path);
    assert.ok(powershell.includes(`"${path.replace(/^runtime\/(hermes|ubuntu)\//, '')}"`), `PowerShell installer omits ${path}`);
  }
  for (const path of ['.env', 'runtime/hermes/../../.env', 'runtime/service.ts', 'runtime/hermes/secrets.json', 'runtime/ubuntu/../../.env', 'runtime/ubuntu/helpers/private.py']) {
    assert.equal((await fetch(`${base}/v1/install/file?path=${encodeURIComponent(path)}`)).status, 404, path);
  }
  if (process.platform === 'win32') return;
  const root = mkdtempSync(join(tmpdir(), 'runner download ')), install = join(root, 'install with spaces'), bin = join(root, 'bin');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(install, 'node/bin'), { recursive: true }); mkdirSync(bin);
  writeFileSync(join(install, 'node/bin/node'), '#!/bin/sh\nexit 99\n'); chmodSync(join(install, 'node/bin/node'), 0o755);
  // Stop at the build boundary; never pair or install a host service in this test.
  writeFileSync(join(bin, 'docker'), `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === 'version') process.exit(0);
if (args[0] === 'image') process.exit(1);
if (args[0] !== 'build') process.exit(98);
const root = args.at(-1), inputs = JSON.parse(process.env.FIXTURE_INPUTS);
for (const input of inputs) if (!fs.existsSync(path.join(root, input))) { console.error(input); process.exit(78); }
fs.writeFileSync(process.env.FIXTURE_LOG, JSON.stringify(inputs));
process.exit(77);
`);
  chmodSync(join(bin, 'docker'), 0o755);
  const log = join(root, 'build-inputs.json');
  const result = spawnSync('sh', [join(repo, 'runtime/installers/install-runner.sh')], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OPEN_HARNESS_COORDINATOR: base, OPEN_HARNESS_PAIRING_CODE: 'not-consumed', OPEN_HARNESS_RUNNER_DIR: install, OPEN_HARNESS_RUNNER_STATE_DIR: join(root, 'state'), FIXTURE_INPUTS: JSON.stringify(inputs), FIXTURE_LOG: log } });
  assert.equal(result.status, 77, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')), inputs);
  for (const path of inputs) assert.deepEqual(readFileSync(join(install, path)), readFileSync(join(repo, path)));
});

test("authenticates local clients, migrates once, and protects its secret file", async () => {
  assert.equal((await fetch(`${base}/v1/health`)).status, 401);
  const workspace = { agents: [{ id: "atlas", name: "Atlas", role: "Generalist", instructions: "Own the result.", memory: ["Prefer concise reports."] }], conversations: [{ id: "c1", agentId: "atlas", title: "Legacy", updatedAt: new Date().toISOString(), messages: [] }], files: [{ name: "notes.md", content: "Shared context" }] };
  const sentinel = join(stateDir, 'host-sentinel'); writeFileSync(sentinel, 'Host data');
  symlinkSync(sentinel, join(stateDir, 'shared', 'notes.md'));
  await assert.rejects(request('/v1/migrate', { method: 'POST', body: JSON.stringify(workspace) }), /symbolic links/);
  assert.equal(readFileSync(sentinel, 'utf8'), 'Host data');
  unlinkSync(join(stateDir, 'shared', 'notes.md'));
  writeFileSync(join(stateDir, 'shared', 'current.md'), 'Newer coordinator copy');
  workspace.files.push({ name: 'current.md', content: 'Older browser copy' });
  assert.equal((await request("/v1/migrate", { method: "POST", body: JSON.stringify(workspace) })).migrated, true);
  assert.equal((await request("/v1/migrate", { method: "POST", body: JSON.stringify(workspace) })).reason, "already_migrated");
  assert.equal(readFileSync(join(stateDir, "shared", "notes.md"), "utf8"), "Shared context");
  assert.equal(readFileSync(join(stateDir, 'shared', 'current.md'), 'utf8'), 'Newer coordinator copy');
  assert.deepEqual(JSON.parse(readFileSync(join(stateDir, 'browser-v1-backup.json'), 'utf8')).files, workspace.files);
  assert.match(readFileSync(join(stateDir, "agents", "atlas", "profile", "memories", "MEMORY.md"), "utf8"), /concise reports/);
  assert.equal(readFileSync(join(stateDir, "secrets.backend"), "utf8"), "encrypted-file");
  if (process.platform !== "win32") assert.equal(statSync(join(stateDir, "secrets.json")).mode & 0o777, 0o600);
});

test('context edits share Hermes memory files and legacy notes cannot overwrite runtime updates', async () => {
  const home = join(stateDir, 'agents', 'legacy-memory', 'profile');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'MEMORY.md'), 'Dashboard notes from an older version.');
  writeFileSync(join(home, 'USER.md'), 'Legacy user notes.');
  const path = '/v1/agents/legacy-memory/context';
  assert.equal((await request(path)).memory, 'Dashboard notes from an older version.');
  assert.equal((await request(path)).user, 'Legacy user notes.');
  await request(path, { method: 'PUT', body: JSON.stringify({ memory: 'Dashboard notes for the next Hermes session.' }) });
  assert.equal(readFileSync(join(home, 'memories', 'MEMORY.md'), 'utf8'), 'Dashboard notes for the next Hermes session.');
  writeFileSync(join(home, 'memories', 'MEMORY.md'), 'Updated by the Hermes memory tool.');
  writeFileSync(join(home, 'memories', 'USER.md'), 'Updated by Hermes user memory.');
  assert.equal((await request(path)).memory, 'Updated by the Hermes memory tool.');
  assert.equal((await request(path)).user, 'Updated by Hermes user memory.');
  await request(path, { method: 'PUT', body: JSON.stringify({ memory: '' }) });
  assert.equal((await request(path)).memory, '', 'Cleared memory must not resurrect legacy notes.');
  assert.equal(readFileSync(join(home, 'MEMORY.md'), 'utf8'), 'Dashboard notes from an older version.');
});

test("runs independently of event polling and replays stable events", async () => {
  await request("/v1/agents/sync", { method: "POST", body: JSON.stringify({ agents: [{ id: "atlas", name: "Atlas", role: "Generalist", instructions: "Own the result.", config: { model: "mock" } }] }) });
  const saved = await request("/v1/agents/atlas/profile");
  await request("/v1/agents/atlas/profile", { method: "PUT", body: JSON.stringify({ ...saved.profile, allowedTools: ["terminal"], terminalConsent: true }) });
  const run = await request("/v1/runs", { method: "POST", body: JSON.stringify({ agentId: "atlas", conversationId: "c1", prompt: "MOCK_SLOW create and execute a script" }) });
  assert.equal((await waitRun(run.id)).state, "completed");
  const first = await request(`/v1/runs/${run.id}/events?after=0`); assert.ok(first.events.length >= 5);
  const cursor = first.events[1].seq; const replay = await request(`/v1/runs/${run.id}/events?after=${cursor}`);
  assert.deepEqual(replay.events.map((event: any) => event.seq), first.events.slice(2).map((event: any) => event.seq));
});

test("stops all active runs through the POST-only fixed route", async () => {
  const run = await request("/v1/runs", { method: "POST", body: JSON.stringify({ agentId: "atlas", prompt: "MOCK_APPROVAL" }) });
  const deadline = Date.now() + POLL_BUDGET_MS;
  while (Date.now() < deadline && (await request(`/v1/runs/${run.id}`)).state !== "waiting_approval") await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await request(`/v1/runs/${run.id}`)).state, "waiting_approval");

  const get = await fetch(`${base}/v1/runs/stop-all`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(get.status, 404);
  assert.deepEqual(await get.json(), { error: "Run not found." });
  assert.equal((await request(`/v1/runs/${run.id}`)).state, "waiting_approval");

  const response = await fetch(`${base}/v1/runs/stop-all`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(result.stopped >= 1);
  assert.ok(["completed","failed","interrupted","cancelled"].includes((await waitRun(run.id)).state));
});

test("pauses for approval and resumes only after an explicit decision", async () => {
  const run = await request("/v1/runs", { method: "POST", body: JSON.stringify({ agentId: "atlas", prompt: "MOCK_APPROVAL" }) });
  let approval: any;
  const approvalDeadline = Date.now() + POLL_BUDGET_MS;
  while (Date.now() < approvalDeadline) { const events = await request(`/v1/runs/${run.id}/events?after=0`); approval = events.events.find((event: any) => event.type === "approval.request"); if (approval) break; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.ok(approval); assert.equal((await request(`/v1/runs/${run.id}`)).state, "waiting_approval");
  assert.equal((await fetch(`${base}/v1/approvals`)).status, 401);
  const scoped = coordinationToken(token, 'atlas', 'local');
  assert.equal((await fetch(`${base}/v1/approvals`, { headers: { Authorization: `Bearer ${scoped}`, "X-Open-Harness-Agent": "atlas" } })).status, 401);
  const inbox = await request('/v1/approvals?state=pending&agentId=atlas&limit=1');
  assert.ok(inbox.pendingCount >= 1); assert.equal(inbox.approvals[0].id, approval.payload.approvalId); assert.equal(inbox.approvals[0].agentName, 'Atlas');

  await request(`/v1/runs/${run.id}/approval`, { method: "POST", body: JSON.stringify({ approvalId: approval.payload.approvalId, decision: "approve" }) });
  const duplicate = await fetch(`${base}/v1/runs/${run.id}/approval`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ approvalId: approval.payload.approvalId, decision: 'approve' }) });
  assert.equal(duplicate.status, 409); assert.match((await duplicate.json()).error, /already been resolved/);
  const audit = await request(`/v1/audit?action=run.approval&targetId=${run.id}`);
  assert.deepEqual(audit.events[0].detail, { decision: 'approve', approvalId: approval.payload.approvalId });
  assert.equal((await waitRun(run.id)).state, "completed");
});

test("scopes the approvals inbox and removes a deleted agent's approvals while retaining its runs", async () => {
  const agentIds = ['inbox-a', 'inbox-b'];
  await request('/v1/agents/sync', { method: 'POST', body: JSON.stringify({ agents: agentIds.map(id => ({ id, name: id, role: 'Generalist', instructions: '', config: { model: 'mock' } })) }) });
  const runs: any[] = [];
  try {
    for (const agentId of agentIds) {
      const saved = await request(`/v1/agents/${agentId}/profile`);
      await request(`/v1/agents/${agentId}/profile`, { method: 'PUT', body: JSON.stringify({ ...saved.profile, allowedTools: ['terminal'], terminalConsent: true }) });
      const run = await request('/v1/runs', { method: 'POST', body: JSON.stringify({ agentId, prompt: 'MOCK_APPROVAL' }) });
      runs.push(run);
      const deadline = Date.now() + POLL_BUDGET_MS;
      while (Date.now() < deadline && (await request(`/v1/runs/${run.id}`)).state !== 'waiting_approval') await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal((await request(`/v1/runs/${run.id}`)).state, 'waiting_approval');
    }
    for (const [index, agentId] of agentIds.entries()) {
      const scoped = await request(`/v1/approvals?agentId=${agentId}&state=all`);
      assert.equal(scoped.pendingCount, 1);
      assert.deepEqual(scoped.approvals.map((item: any) => item.runId), [runs[index].id]);
      assert.ok(scoped.approvals.every((item: any) => item.agentId === agentId));
    }
    const before = await request('/v1/approvals?state=all');
    assert.ok(runs.every(run => before.approvals.some((item: any) => item.runId === run.id)));
    const aApprovals = before.approvals.filter((item: any) => item.runId === runs[0].id);
    const aPendingCount = aApprovals.filter((item: any) => item.state === 'pending').length;
    const rejected = await fetch(`${base}/v1/agents/inbox-a`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    assert.equal(rejected.status, 409);
    const unchanged = await request('/v1/approvals?state=all');
    assert.equal(unchanged.pendingCount, before.pendingCount);
    assert.deepEqual(unchanged.approvals.filter((item: any) => item.runId === runs[0].id).map(({ ageMs, ...rest }: any) => { void ageMs; return rest; }), aApprovals.map(({ ageMs, ...rest }: any) => { void ageMs; return rest; }));
    assert.equal((await request(`/v1/runs/${runs[0].id}`)).state, 'waiting_approval');
    await request(`/v1/runs/${runs[0].id}/stop`, { method: 'POST' });
    assert.equal((await waitRun(runs[0].id)).state, 'cancelled');
    const deleted = await fetch(`${base}/v1/agents/inbox-a`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { ok: true, id: 'inbox-a' });
    const after = await request('/v1/approvals?state=all');
    assert.equal(after.pendingCount, before.pendingCount - aPendingCount);
    assert.ok(after.approvals.every((item: any) => item.agentId !== 'inbox-a'));
    assert.ok(after.approvals.some((item: any) => item.runId === runs[1].id && item.state === 'pending'));
    const removed = await request('/v1/approvals?agentId=inbox-a&state=all');
    assert.deepEqual(removed, { approvals: [], pendingCount: 0 });
    const survivor = await request('/v1/approvals?agentId=inbox-b');
    assert.equal(survivor.pendingCount, 1);
    assert.deepEqual(survivor.approvals.map((item: any) => item.runId), [runs[1].id]);
    assert.equal((await request(`/v1/runs/${runs[1].id}`)).state, 'waiting_approval');
    const store = new Store(join(stateDir, 'state.db'));
    try { assert.equal((store.db.prepare('SELECT COUNT(*) n FROM approvals WHERE run_id=?').get(runs[0].id) as { n: number }).n, 0); }
    finally { store.db.close(); }
  } finally {
    for (const run of runs) { await request(`/v1/runs/${run.id}/stop`, { method: 'POST' }); await waitRun(run.id); }
  }
});

test("rejects expired approvals without changing the row, audit or events", async () => {
  const store = new Store(join(stateDir, "state.db"));
  try {
    const now = new Date().toISOString(), runId = crypto.randomUUID(), approvalId = crypto.randomUUID();
    store.createRun({ id: runId, agent_id: "atlas", conversation_id: "c1", prompt: "", state: "completed", session_id: null, parent_run_id: null, depth: 0, created_at: now, updated_at: now, result: null, error: null });
    store.createApproval(approvalId, runId, "expired-request", { tool_name: "terminal", command: "ls" });
    const before = store.approval(approvalId);
    const auditBefore = store.db.prepare("SELECT * FROM audit_events ORDER BY seq").all();
    const eventsBefore = store.db.prepare("SELECT * FROM events ORDER BY seq").all();
    const response = await fetch(`${base}/v1/runs/${runId}/approval`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ approvalId, decision: "approve" }) });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "Approval expired because the run has ended.");
    assert.deepEqual(store.approval(approvalId), before);
    assert.deepEqual(store.db.prepare("SELECT * FROM audit_events ORDER BY seq").all(), auditBefore);
    assert.deepEqual(store.db.prepare("SELECT * FROM events ORDER BY seq").all(), eventsBefore);
  } finally { store.db.close(); }
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
  const connected = await request("/v1/agents/atlas/connector-check", { method: "POST", body: JSON.stringify({ connector }) }); assert.equal(connected.status, "connected"); assert.equal(connected.tools.length, 1); assert.equal(connected.tools[0].id, 'mcp__source-db__lookup');
});

test("delegates to another named agent and records the handoff", async () => {
  await request("/v1/agents/sync", { method: "POST", body: JSON.stringify({ agents: [{ id: "scout", name: "Scout", role: "Researcher", instructions: "Analyze.", config: { model: "mock" } }] }) });
  await request("/v1/teams", { method: "POST", body: JSON.stringify({ name: "Delegation team", description: "Shared handoffs", color: "blue", icon: "people", memberAgentIds: ["atlas", "scout"] }) });
  const { profile } = await request("/v1/agents/atlas/profile");
  await request("/v1/agents/atlas/profile", { method: "PUT", body: JSON.stringify({ ...profile, allowedTools: ["mcp__open_harness__delegate_named_agent"] }) });
  const parent = await request("/v1/runs", { method: "POST", body: JSON.stringify({ agentId: "atlas", prompt: "MOCK_SLOW prepare final artifact" }) });
  await new Promise(resolve => setTimeout(resolve, 80));
  const scoped = coordinationToken(token, 'atlas', 'local');
  const response = await fetch(`${base}/internal/handoff`, { method: "POST", headers: { Authorization: `Bearer ${scoped}`, "X-Open-Harness-Agent": "atlas", "X-Open-Harness-Run": parent.id, "Content-Type": "application/json" }, body: JSON.stringify({ agentId: "scout", prompt: "Analyze the inputs", detached: true }) });
  assert.equal(response.status, 202); const delegated = await response.json() as any; assert.equal(delegated.state, "queued");
  assert.ok(delegated.childRunId); assert.ok(delegated.conversationId);
  await waitRun(delegated.childRunId);
  const events = await request(`/v1/runs/${parent.id}/events?after=0`);
  assert.ok(events.events.some((event: any) => event.type === "handoff.created"));

  assert.equal((await waitRun(parent.id)).state, "completed");
});

test("blocks named handoffs when agents do not share an active team", async () => {
  await request("/v1/agents/sync", { method: "POST", body: JSON.stringify({ agents: [{ id: "solo", name: "Solo", role: "Independent", instructions: "Work alone.", config: { model: "mock" } }] }) });
  const parent = await request("/v1/runs", { method: "POST", body: JSON.stringify({ agentId: "atlas", prompt: "MOCK_SLOW work independently" }) });
  await new Promise(resolve => setTimeout(resolve, 80));
  const scoped = coordinationToken(token, 'atlas', 'local');
  const response = await fetch(`${base}/internal/handoff`, { method: "POST", headers: { Authorization: `Bearer ${scoped}`, "X-Open-Harness-Agent": "atlas", "X-Open-Harness-Run": parent.id, "Content-Type": "application/json" }, body: JSON.stringify({ agentId: "solo", prompt: "Try to join" }) });
  assert.equal(response.status, 403);
  assert.match(JSON.stringify(await response.json()), /share an active team/);
  await waitRun(parent.id);
});

test("browser cache sync seeds missing teams and preserves existing memberships until an explicit import", async () => {
  const cached = { id: 'cache-team', name: 'Cache sync team', color: 'sage', icon: 'people', memberAgentIds: ['atlas', 'scout'] };
  const sync = (team: typeof cached, onlyMissing?: boolean) => request('/v1/teams/sync', { method: 'POST', body: JSON.stringify({ teams: [team], onlyMissing }) });
  const original = (await sync(cached, true)).teams[0];
  assert.deepEqual([...original.memberAgentIds].sort(), ['atlas', 'scout']);
  const partial = { ...cached, memberAgentIds: ['atlas'] };
  assert.deepEqual((await sync(partial, true)).teams[0], original);
  assert.deepEqual((await sync({ ...partial, id: 'old-browser-id' }, true)).teams[0], original);
  assert.deepEqual((await sync(partial)).teams[0].memberAgentIds, ['atlas']);
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

// A mock run asking for approval stays live until it is answered, so agent tool calls made
// "from" it cannot race the run's end the way a fixed delay can.
async function approvalOf(runId: string) {
  const deadline = Date.now() + POLL_BUDGET_MS;
  while (Date.now() < deadline) { const found = (await request(`/v1/runs/${runId}/events?after=0`)).events.find((event: any) => event.type === "approval.request"); if (found) return String(found.payload.approvalId); await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(`No approval request on ${runId}.`);
}

test("agent workspace tools: the old project switch is retired, and each permission gates its own tool", async () => {
  const grant = async (patch: Record<string, unknown>) => {
    const { profile } = await request("/v1/agents/atlas/profile");
    const saved = await request("/v1/agents/atlas/profile", { method: "PUT", body: JSON.stringify({ ...profile, ...patch }) });
    return saved.profile;
  };
  let run = await request("/v1/runs", { method: "POST", body: JSON.stringify({ agentId: "atlas", prompt: "MOCK_APPROVAL hold a board session open" }) });
  const call = async (tool: string, payload: unknown, runId = run.id) => { const response = await fetch(`${base}/internal/${tool}`, { method: "POST", headers: { Authorization: `Bearer ${coordinationToken(token, 'atlas', 'local')}`, "X-Open-Harness-Agent": "atlas", "X-Open-Harness-Run": runId, "Content-Type": "application/json" }, body: JSON.stringify(payload) }); return { status: response.status, body: await response.json() as any }; };
  // The retired switch is cleared on save and grants nothing.
  const { profile } = await request("/v1/agents/atlas/profile");
  const saved = await grant({ allowedTools: profile.allowedTools.filter((id: string) => !id.startsWith("mcp__open_harness__") || id === "mcp__open_harness__task"), board: { ...profile.board, manageProjects: true } });
  assert.equal(saved.board.manageProjects, false);
  await approvalOf(run.id);
  const refused = await call("task", { action: "board_create", name: "Agent project" });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /"Projects" permission/);
  for (const tool of ["project", "routines", "directory", "runs"]) assert.equal((await call(tool, { action: "list" })).status, 403, tool);

  // Flat fields work, and a missing one is named rather than guessed at.
  const missing = await call("task", { action: "create", boardId: "x" });
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.body.missing, ["title"]);
  const boards = (await call("task", { action: "list" })).body.boards;
  const flat = await call("task", { action: "create", boardId: boards[0].id, title: "Flat fields", description: "Sent next to action" });
  assert.equal(flat.status, 201);
  assert.equal(flat.body.title, "Flat fields");
  const unknownAction = await call("task", { action: "board_delete" });
  assert.equal(unknownAction.status, 400);
  assert.match(unknownAction.body.error, /Use one of/);

  // A grant made during a run is reported as pending, not as missing.
  await grant({ allowedTools: [...saved.allowedTools, "mcp__open_harness__project", "mcp__open_harness__routines", "mcp__open_harness__directory", "mcp__open_harness__runs"] });
  assert.match((await call("project", { action: "list" })).body.error, /takes effect from this agent's next run/);
  await request(`/v1/runs/${run.id}/stop`, { method: "POST" });
  run = await request("/v1/runs", { method: "POST", body: JSON.stringify({ agentId: "atlas", prompt: "MOCK_APPROVAL use newly granted workspace permissions" }) });
  await approvalOf(run.id);

  const created = await call("project", { action: "create", name: "Agent project", description: "Opened by an agent." });
  assert.equal(created.status, 201);
  const board = created.body;
  assert.equal(board.description, "Opened by an agent.");
  assert.equal(board.folders, undefined);
  await request(`/v1/boards/${board.id}`, { method: "PUT", body: JSON.stringify({ revision: board.revision, settings: { ...board.settings, allowAgentDispatch: false } }) });
  const updated = await call("project", { action: "update", boardId: board.id, name: "Agent project v2", allowAgentDispatch: true, autoRunOnDrop: true, folders: [{ path: "/etc", mode: "write" }] });
  // Protected fields are dropped, not refused, so the rest of the change still lands.
  assert.equal(updated.status, 200);
  assert.equal(updated.body.name, "Agent project v2");
  const stored = await request(`/v1/boards/${board.id}`);
  // Automation and folders stay under human control even with the permission on.
  assert.equal(stored.settings.allowAgentDispatch, false);
  assert.deepEqual(stored.folders, []);
  // The old aliases still work for agents holding a cached schema, under the new permission.
  assert.equal((await call("task", { action: "board_update", boardId: board.id, input: { description: "Alias" } })).body.description, "Alias");

  const added = await call("project", { action: "add_stage", boardId: board.id, name: "Blocked", category: "backlog" });
  const blocked = added.body.stages.find((stage: any) => stage.name === "Blocked");
  const reordered = await call("project", { action: "update_stage", stageId: blocked.id, position: 0, name: "On hold" });
  assert.equal(reordered.body.stages[0].id, blocked.id);
  assert.equal(reordered.body.stages[0].name, "On hold");
  assert.equal((await call("project", { action: "remove_stage", stageId: blocked.id })).body.stages.some((stage: any) => stage.id === blocked.id), false);
  assert.equal((await call("project", { action: "archive", boardId: board.id })).body.archived, true);
  assert.equal((await call("project", { action: "restore", boardId: board.id })).body.archived, false);
  assert.equal((await call("project", { action: "delete", boardId: board.id })).status, 400);

  // Routines: only this agent's own, and another agent's is reported missing.
  const mine = await request("/v1/routines", { method: "POST", body: JSON.stringify({ agentId: "atlas", name: "Mine", prompt: "Digest", intervalMinutes: 60 }) });
  const theirs = await request("/v1/routines", { method: "POST", body: JSON.stringify({ agentId: "scout", name: "Theirs", prompt: "Other", intervalMinutes: 60 }) });
  const listed = (await call("routines", { action: "list" })).body.routines;
  assert.ok(listed.some((item: any) => item.id === mine.id));
  assert.ok(!listed.some((item: any) => item.id === theirs.id));
  assert.equal((await call("routines", { action: "pause", routineId: theirs.id })).status, 404);
  assert.equal((await call("routines", { action: "pause", routineId: mine.id })).body.enabled, false);
  assert.equal((await call("routines", { action: "update", routineId: mine.id, name: "Mine, renamed" })).body.name, "Mine, renamed");
  assert.equal((await call("routines", { action: "delete", routineId: mine.id })).status, 200);
  await request(`/v1/routines/${theirs.id}`, { method: "DELETE" });

  // Directory: whitelisted fields only.
  const agents = (await call("directory", { action: "agents" })).body.agents;
  const self = agents.find((item: any) => item.id === "atlas");
  assert.equal(self.status, "working");
  assert.deepEqual(Object.keys(self).sort(), ["description", "id", "name", "role", "status", "teamIds", "you"]);

  // Runs: its own are visible, another agent's are not, and a run cannot stop itself.
  const listedRuns = (await call("runs", { action: "list" })).body.runs;
  assert.ok(listedRuns.some((item: any) => item.id === run.id));
  // Its own runs, plus work it delegated to teammates (those carry a parent run).
  assert.ok(listedRuns.every((item: any) => item.agentId === "atlas" || item.parentRunId));
  const other = await request("/v1/runs", { method: "POST", body: JSON.stringify({ agentId: "scout", prompt: "MOCK_SLOW not yours" }) });
  assert.equal((await call("runs", { action: "get", runId: other.id })).status, 404);
  assert.equal((await call("runs", { action: "stop", runId: run.id })).status, 409);
  await request(`/v1/runs/${other.id}/stop`, { method: "POST" });
  await request(`/v1/runs/${run.id}/stop`, { method: "POST" });
});

test("task moves enforce the same ownership permission as updates", async () => {
  const agentId = 'move-permissions', helperId = 'move-recipient';
  await request('/v1/agents/sync', { method: 'POST', body: JSON.stringify({ agents: [agentId, helperId].map(id => ({ id, name: id, role: 'Assistant', instructions: 'Test move permissions.', memory: [] })) }) });
  const grant = async (assignOthers: boolean) => {
    const { profile } = await request(`/v1/agents/${agentId}/profile`);
    await request(`/v1/agents/${agentId}/profile`, { method: 'PUT', body: JSON.stringify({ ...profile, terminalConsent: true, allowedTools: ['terminal'], board: { ...profile.board, assignOthers } }) });
  };
  await grant(false);
  const board = await request('/v1/boards', { method: 'POST', body: JSON.stringify({ name: 'Move permissions' }) });
  const ready = board.stages.find((stage: any) => stage.category === 'ready');
  const card = await request('/v1/tasks', { method: 'POST', body: JSON.stringify({ boardId: board.id, title: 'Keep ownership', ownerAgentId: agentId }) });
  let run = await request('/v1/runs', { method: 'POST', body: JSON.stringify({ agentId, prompt: 'MOCK_APPROVAL hold move permissions open' }) });
  const call = async (payload: unknown) => { const response = await fetch(`${base}/internal/task`, { method: 'POST', headers: { Authorization: `Bearer ${coordinationToken(token, agentId, 'local')}`, 'X-Open-Harness-Agent': agentId, 'X-Open-Harness-Run': run.id, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); return { status: response.status, body: await response.json() as any }; };
  try {
    await approvalOf(run.id);
    assert.equal((await call({ action: 'update', taskId: card.id, ownerAgentId: helperId })).status, 403);
    const fields = { stageId: ready.id, ownerAgentId: helperId };
    for (const spelling of [fields, { input: fields }, { input: JSON.stringify(fields) }]) {
      const denied = await call({ action: 'move', taskId: card.id, ...spelling });
      assert.equal(denied.status, 403);
      assert.match(denied.body.error, /Change other agents' cards/);
      const unchanged = await request(`/v1/tasks/${card.id}`);
      assert.equal(unchanged.ownerAgentId, agentId);
      assert.equal(unchanged.stageId, card.stageId);
      assert.equal(unchanged.revision, card.revision);
    }
    const moved = await call({ action: 'move', taskId: card.id, stageId: ready.id });
    assert.equal(moved.status, 200); assert.equal(moved.body.ownerAgentId, agentId); assert.equal(moved.body.stageId, ready.id);
    const unassigned = await request('/v1/tasks', { method: 'POST', body: JSON.stringify({ boardId: board.id, title: 'Claim by moving', ownerAgentId: null }) });
    assert.equal((await call({ action: 'move', taskId: unassigned.id, stageId: ready.id, ownerAgentId: helperId })).status, 403);
    const claimed = await call({ action: 'move', taskId: unassigned.id, stageId: ready.id, ownerAgentId: agentId });
    assert.equal(claimed.status, 200); assert.equal(claimed.body.ownerAgentId, agentId);

    await request(`/v1/runs/${run.id}/stop`, { method: 'POST' });
    await grant(true);
    run = await request('/v1/runs', { method: 'POST', body: JSON.stringify({ agentId, prompt: 'MOCK_APPROVAL use assignment permission' }) });
    await approvalOf(run.id);
    const assigned = await call({ action: 'move', taskId: card.id, stageId: ready.id, ownerAgentId: helperId });
    assert.equal(assigned.status, 200); assert.equal(assigned.body.ownerAgentId, helperId);
  } finally {
    await request(`/v1/runs/${run.id}/stop`, { method: 'POST' });
  }
});

test("agent conversation access excludes private follow-ups to delegated work before applying the turn limit", async () => {
  const agentId = 'conversation-reader', helperId = 'conversation-helper';
  await request('/v1/agents/sync', { method: 'POST', body: JSON.stringify({ agents: [agentId, helperId].map(id => ({ id, name: id, role: 'Assistant', instructions: 'Test conversation permissions.', memory: [] })) }) });
  const { profile } = await request(`/v1/agents/${agentId}/profile`);
  await request(`/v1/agents/${agentId}/profile`, { method: 'PUT', body: JSON.stringify({ ...profile, terminalConsent: true, allowedTools: ['terminal', 'mcp__open_harness__runs', 'mcp__open_harness__delegate_named_agent'] }) });
  const team = await request('/v1/teams', { method: 'POST', body: JSON.stringify({ name: 'Conversation scope', color: 'blue', icon: 'people', memberAgentIds: [agentId, helperId] }) });
  const parent = await request('/v1/runs', { method: 'POST', body: JSON.stringify({ agentId, prompt: 'MOCK_APPROVAL hold conversation access open' }) });
  const call = async (tool: string, payload: unknown) => { const response = await fetch(`${base}/internal/${tool}`, { method: 'POST', headers: { Authorization: `Bearer ${coordinationToken(token, agentId, 'local')}`, 'X-Open-Harness-Agent': agentId, 'X-Open-Harness-Run': parent.id, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); return { status: response.status, body: await response.json() as any }; };
  try {
    await approvalOf(parent.id);
    const handed = await call('handoff', { agentId: helperId, prompt: 'Delegated research' });
    assert.equal(handed.status, 200); assert.equal(handed.body.done, true);
    const delegated = await request(`/v1/runs/${handed.body.runId}`);
    let privateRun: any;
    // More private turns than the response limit must neither leak nor hide the authorized turn.
    for (let turn = 0; turn < 21; turn++) {
      privateRun = await request('/v1/runs', { method: 'POST', body: JSON.stringify({ agentId: helperId, conversationId: delegated.conversation_id, prompt: `Private follow-up ${turn}` }) });
      await waitRun(privateRun.id);
    }
    for (const action of ['get', 'conversation', 'stop']) assert.equal((await call('runs', { action, runId: privateRun.id })).status, 404, action);
    const conversation = await call('runs', { action: 'conversation', runId: delegated.id });
    assert.equal(conversation.status, 200);
    assert.deepEqual(conversation.body.runs.map((run: any) => run.id), [delegated.id]);
    assert.equal(JSON.stringify(conversation.body).includes('Private follow-up'), false);
    assert.deepEqual((await call('runs', { action: 'conversation', runId: parent.id })).body.runs.map((run: any) => run.id), [parent.id]);
  } finally {
    await request(`/v1/runs/${parent.id}/stop`, { method: 'POST' });
    await request(`/v1/teams/${team.id}`, { method: 'DELETE' });
  }
});

test("agent project edits preserve the human-selected automatic-start stage", async () => {
  const agentId = 'automation-editor';
  await request('/v1/agents/sync', { method: 'POST', body: JSON.stringify({ agents: [{ id: agentId, name: 'Automation editor', role: 'Assistant', instructions: 'Test project permissions.', memory: [] }] }) });
  const { profile } = await request(`/v1/agents/${agentId}/profile`);
  await request(`/v1/agents/${agentId}/profile`, { method: 'PUT', body: JSON.stringify({ ...profile, terminalConsent: true, allowedTools: ['terminal', 'mcp__open_harness__project'] }) });
  const run = await request('/v1/runs', { method: 'POST', body: JSON.stringify({ agentId, prompt: 'MOCK_APPROVAL hold project access open' }) });
  const call = async (payload: unknown, tool = 'project') => { const response = await fetch(`${base}/internal/${tool}`, { method: 'POST', headers: { Authorization: `Bearer ${coordinationToken(token, agentId, 'local')}`, 'X-Open-Harness-Agent': agentId, 'X-Open-Harness-Run': run.id, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); return { status: response.status, body: await response.json() as any }; };
  try {
    await approvalOf(run.id);
    const board = (await call({ action: 'create', name: 'Protected automation' })).body;
    // Unsaved defaults derive the trigger from stage categories; stage edits must pin that choice.
    const originalTrigger = board.settings.runStageId;
    // Like removing it, recategorizing the only In progress stage would leave tasks nowhere to run.
    const stranded = await call({ action: 'update_stage', stageId: originalTrigger, category: 'backlog' });
    assert.equal(stranded.status, 400); assert.match(stranded.body.error, /Keep at least one/);
    const extra = await call({ action: 'add_stage', boardId: board.id, name: 'Another progress stage', category: 'in_progress' });
    assert.equal(extra.status, 201); assert.equal(extra.body.settings.runStageId, originalTrigger);
    const recategorized = await call({ action: 'update_stage', stageId: originalTrigger, category: 'backlog', position: 0 });
    assert.equal(recategorized.status, 200); assert.equal(recategorized.body.settings.runStageId, originalTrigger);
    assert.equal(recategorized.body.stages[0].id, originalTrigger);
    const extraId = extra.body.stages.find((stage: any) => stage.name === 'Another progress stage').id;
    const reordered = await call({ action: 'update_stage', stageId: extraId, position: 0 });
    assert.equal(reordered.status, 200); assert.equal(reordered.body.settings.runStageId, originalTrigger);
    // A human can choose any stage as the trigger, including a removable Backlog stage.
    const trigger = board.stages.find((stage: any) => stage.category === 'backlog');
    const target = board.stages.find((stage: any) => stage.category === 'ready');
    const completion = board.stages.find((stage: any) => stage.category === 'done');
    let selected = await request(`/v1/boards/${board.id}`);
    selected = await request(`/v1/boards/${board.id}`, { method: 'PUT', body: JSON.stringify({ revision: selected.revision, settings: { ...selected.settings, runStageId: trigger.id } }) });
    const updated = await call({ action: 'update', boardId: board.id, name: 'Permitted rename', runStageId: target.id, doneStageId: completion.id, settings: { runStageId: target.id, autoRunOnDrop: false, allowAgentDispatch: false } });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.name, 'Permitted rename');
    assert.equal(updated.body.settings.runStageId, trigger.id);
    assert.equal(updated.body.settings.doneStageId, completion.id);
    assert.equal(updated.body.settings.autoRunOnDrop, true);
    assert.equal(updated.body.settings.allowAgentDispatch, true);
    assert.equal((await call({ action: 'board_update', boardId: board.id, input: { runStageId: target.id, settings: { runStageId: target.id } } }, 'task')).body.settings.runStageId, trigger.id);
    for (const automatic of [true, false]) {
      selected = await request(`/v1/boards/${board.id}`);
      await request(`/v1/boards/${board.id}`, { method: 'PUT', body: JSON.stringify({ revision: selected.revision, settings: { ...selected.settings, autoRunOnDrop: automatic } }) });
      const removed = await call({ action: 'remove_stage', stageId: trigger.id, moveToStageId: target.id });
      assert.equal(removed.status, 403);
      assert.match(removed.body.error, /person|user/);
      selected = await request(`/v1/boards/${board.id}`);
      assert.equal(selected.settings.runStageId, trigger.id);
      assert.equal(selected.settings.autoRunOnDrop, automatic);
      assert.ok(selected.stages.some((stage: any) => stage.id === trigger.id));
    }
    const edited = await call({ action: 'update_stage', stageId: trigger.id, name: 'Start here', category: 'ready', position: 1 });
    assert.equal(edited.status, 200); assert.equal(edited.body.settings.runStageId, trigger.id);
    const added = (await call({ action: 'add_stage', boardId: board.id, name: 'Safe to remove', category: 'backlog' })).body.stages.find((stage: any) => stage.name === 'Safe to remove');
    assert.equal((await call({ action: 'remove_stage', stageId: added.id })).status, 200);
    selected = await request(`/v1/boards/${board.id}`);
    const human = await request(`/v1/boards/${board.id}`, { method: 'PUT', body: JSON.stringify({ revision: selected.revision, settings: { ...selected.settings, runStageId: target.id } }) });
    assert.equal(human.settings.runStageId, target.id);
    const unconfigured = await request('/v1/boards', { method: 'POST', body: JSON.stringify({ name: 'No run destination' }) });
    await request(`/v1/stages/${unconfigured.settings.runStageId}`, { method: 'PUT', body: JSON.stringify({ category: 'backlog' }) });
    assert.equal((await request(`/v1/boards/${unconfigured.id}`)).settings.runStageId, '');
    const refused = await call({ action: 'add_stage', boardId: unconfigured.id, name: 'Would enable starts', category: 'in_progress' });
    assert.equal(refused.status, 403);
    const unchanged = await request(`/v1/boards/${unconfigured.id}`);
    assert.equal(unchanged.settings.runStageId, '');
    assert.equal(unchanged.stages.some((stage: any) => stage.name === 'Would enable starts'), false, 'Refused stage changes must roll back.');
  } finally {
    await request(`/v1/runs/${run.id}/stop`, { method: 'POST' });
  }
});

test("agents collaborate: one plans a project, starts a teammate's card, and keeps waiting on a long handoff", async () => {
  const team = await request("/v1/teams", { method: "POST", body: JSON.stringify({ name: "Collaboration", description: "Atlas and Scout", color: "violet", icon: "people", memberAgentIds: ["atlas", "scout"] }) });
  const { profile } = await request("/v1/agents/atlas/profile");
  await request("/v1/agents/atlas/profile", { method: "PUT", body: JSON.stringify({ ...profile, allowedTools: [...new Set([...profile.allowedTools, "mcp__open_harness__project", "mcp__open_harness__directory", "mcp__open_harness__runs", "mcp__open_harness__delegate_named_agent"])], board: { ...profile.board, assignOthers: true, dispatch: true } }) });
  // Approval keeps Atlas's own run live for as long as the test needs.
  const parent = await request("/v1/runs", { method: "POST", body: JSON.stringify({ agentId: "atlas", prompt: "MOCK_APPROVAL plan the launch with Scout" }) });
  const parentApproval = await approvalOf(parent.id);
  const scoped = coordinationToken(token, 'atlas', 'local');
  const call = async (tool: string, payload: unknown) => { const response = await fetch(`${base}/internal/${tool === "delegate_named_agent" ? "handoff" : tool}`, { method: "POST", headers: { Authorization: `Bearer ${scoped}`, "X-Open-Harness-Agent": "atlas", "X-Open-Harness-Run": parent.id, "Content-Type": "application/json" }, body: JSON.stringify(payload) }); return { status: response.status, body: await response.json() as any }; };
  try {
    const teammates = (await call("directory", { action: "agents" })).body.agents;
    assert.ok(teammates.some((agent: any) => agent.id === "scout" && agent.teamIds.includes(team.id)));
    const board = (await call("project", { action: "create", name: "Launch plan" })).body;
    const card = await call("task", { action: "create", boardId: board.id, title: "Write test.md", description: "A file that says test", ownerAgentId: "scout" });
    assert.equal(card.status, 201); assert.equal(card.body.ownerAgentId, "scout");
    const started = await call("task", { action: "run", taskId: card.body.id });
    assert.equal(started.status, 202); assert.equal(started.body.run.agent_id, "scout");
    // Atlas follows Scout's work through the card: its run state and result are on it.
    let followed: any; const deadline = Date.now() + POLL_BUDGET_MS;
    while (Date.now() < deadline) { followed = (await call("task", { action: "get", taskId: card.body.id })).body; if (followed.runs[0]?.state === "completed") break; await new Promise(resolve => setTimeout(resolve, 50)); }
    assert.equal(followed.runs[0].agent_id, "scout"); assert.equal(followed.runs[0].state, "completed"); assert.ok(followed.runs[0].result);
    // The list stays a summary however much the cards accumulate.
    const summary = (await call("task", { action: "list", boardId: board.id })).body.tasks;
    assert.deepEqual(summary.map((task: any) => task.id), [card.body.id]);
    assert.equal(typeof summary[0].comments, "number"); assert.equal(summary[0].runs, undefined);

    // A handoff that outlasts the wait returns its run ID instead of failing the call.
    const handed = await call("delegate_named_agent", { agentId: "scout", prompt: "MOCK_APPROVAL review the plan" });
    assert.equal(handed.status, 200); assert.equal(handed.body.done, false); assert.match(handed.body.message, /only this runId/);
    assert.equal((await call("runs", { action: "get", runId: handed.body.runId })).body.agentId, "scout");
    await request(`/v1/runs/${handed.body.runId}/approval`, { method: "POST", body: JSON.stringify({ approvalId: await approvalOf(handed.body.runId), decision: "approve" }) });
    const resumed = await call("delegate_named_agent", { runId: handed.body.runId });
    assert.equal(resumed.body.done, true); assert.equal(resumed.body.state, "completed");
    assert.equal((await call("delegate_named_agent", { runId: started.body.run.id })).status, 404, "a run this agent did not hand off cannot be waited on");
    assert.deepEqual((await call("delegate_named_agent", { agentId: "scout" })).body.missing, ["prompt"]);
  } finally {
    await request(`/v1/runs/${parent.id}/approval`, { method: "POST", body: JSON.stringify({ approvalId: parentApproval, decision: "approve" }) });
    await waitRun(parent.id);
    await request(`/v1/teams/${team.id}`, { method: "DELETE" }).catch(() => {});
  }
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
  // A rename, even one resending the same interval, must not push back the run that is due.
  const renamed = await request(`/v1/routines/${created.id}`, { method: "PUT", body: JSON.stringify({ name: "Weekly summary", intervalMinutes: 10_080 }) });
  assert.equal(renamed.next_run_at, updated.next_run_at);

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
  const scoped = coordinationToken(token, 'atlas', 'local');
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


test("stop-all reaches its dedicated route and stops all active agents", async () => {
  const first = await request('/v1/runs', { method: 'POST', body: JSON.stringify({ agentId: 'atlas', prompt: 'MOCK_APPROVAL Stop all active work' }) });
  const second = await request('/v1/runs', { method: 'POST', body: JSON.stringify({ agentId: 'scout', prompt: 'MOCK_APPROVAL Stop all active work' }) });
  const response = await request('/v1/runs/stop-all', { method: 'POST' });
  assert.ok(response.stopped >= 2);
  assert.equal((await waitRun(first.id)).state, 'cancelled');
  assert.equal((await waitRun(second.id)).state, 'cancelled');
});

test("routine POST and PUT share validation and persist cron schedules", async () => {
  const input = { agentId: 'atlas', name: 'Cron report', prompt: 'Write report', timezone: 'America/Denver', intervalMinutes: 60 };
  const created = await request('/v1/routines', { method: 'POST', body: JSON.stringify(input) });
  try {
    for (const patch of [{ name: '' }, { prompt: '  ' }, { agentId: 'missing-agent' }, { intervalMinutes: 'Infinity' }, { timezone: 'bad/zone' }, { scheduleKind: 'cron', cronExpression: '60 * * * *' }]) {
      for (const method of ['POST', 'PUT']) {
        const response = await fetch(`${base}/v1/routines${method === 'PUT' ? `/${created.id}` : ''}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, ...patch }) });
        assert.equal(response.status, 400);
        assert.ok((await response.json() as { error: string }).error);
      }
    }
    await request(`/v1/routines/${created.id}`, { method: 'PUT', body: JSON.stringify({ scheduleKind: 'cron', cronExpression: '30 9 * * 1-5', timezone: 'Asia/Tokyo' }) });
    const routine = (await request('/v1/routines')).routines.find((item: any) => item.id === created.id);
    assert.equal(routine.schedule_kind, 'cron');
    assert.equal(routine.cron_expression, '30 9 * * 1-5');
    assert.equal(routine.timezone, 'Asia/Tokyo');
    assert.equal(routine.misfire_policy, 'run_once');
  } finally { await request(`/v1/routines/${created.id}`, { method: 'DELETE' }); }
});

test('group messages schedule mentions or all speakers and halt/resume controls admission', async () => {
  await request('/v1/agents/sync', { method: 'POST', body: JSON.stringify({ agents: [{ id: 'msg-a', name: 'Msg A', role: 'Generalist', instructions: '', config: { model: 'mock' } }, { id: 'msg-b', name: 'Msg B', role: 'Generalist', instructions: '', config: { model: 'mock' } }] }) });
  const group = await request('/v1/conversations', { method: 'POST', body: JSON.stringify({ kind: 'group', members: [{ kind: 'agent', id: 'msg-a' }, { kind: 'agent', id: 'msg-b' }] }) });
  const post = (body: string) => request(`/v1/conversations/${group.id}/messages`, { method: 'POST', body: JSON.stringify({ body }) });
  const directed = await post('@msg-a please answer');
  assert.deepEqual(directed.scheduledRuns.map((r: any) => r.agentId), ['msg-a']);
  await waitRun(directed.scheduledRuns[0].runId);
  const all = await post('Everyone, please answer');
  assert.deepEqual(all.scheduledRuns.map((r: any) => r.agentId).sort(), ['msg-a', 'msg-b']);
  const halted = await request(`/v1/conversations/${group.id}/halt`, { method: 'POST' });
  assert.equal(halted.halted, true); assert.equal(typeof halted.stopped, 'number');
  assert.deepEqual((await post('While halted')).scheduledRuns, []);
  assert.deepEqual(await request(`/v1/conversations/${group.id}/resume`, { method: 'POST' }), { resumed: true });
  const resumed = await post('@msg-b resume'); assert.equal(resumed.scheduledRuns[0].agentId, 'msg-b');
  await waitRun(resumed.scheduledRuns[0].runId);
});

test('late runner requests cannot revive terminal runs or create pending approvals', async () => {
  const pairing = await request('/v1/machines', { method: 'POST', body: JSON.stringify({ name: 'Late events', platform: 'linux' }) });
  const paired = await request('/v1/runner/pair', { method: 'POST', body: JSON.stringify({ code: pairing.code }) });
  const headers = { Authorization: `Bearer ${paired.token}`, 'X-Open-Harness-Machine': paired.machineId };
  const store = new Store(join(stateDir, 'state.db'));
  try {
    for (const state of ['completed', 'failed', 'cancelled', 'interrupted', 'running'] as const) {
      const id = crypto.randomUUID(), commandId = crypto.randomUUID(), stamp = new Date().toISOString();
      store.createRun({ id, agent_id: 'late-events', conversation_id: 'late-events', prompt: '', state, session_id: null, parent_run_id: null, depth: 0, created_at: stamp, updated_at: stamp, result: null, error: null });
      store.db.prepare('INSERT INTO runner_commands VALUES(?,?,?,?,?,?,?,NULL,NULL,NULL)').run(commandId, paired.machineId, 'late-events', 'run', JSON.stringify({ runId: id }), 'leased', stamp);
      const before = await request('/v1/approvals?state=all');
      const activeBefore = store.activeCount();
      for (const type of ['approval.request', 'clarify.request', 'secret.request', 'sudo.request']) {
        await request(`/v1/runner/commands/${commandId}/events`, { method: 'POST', headers, body: JSON.stringify({ runId: id, eventId: crypto.randomUUID(), event: { type, payload: { request_id: crypto.randomUUID() } } }) });
        if (state === 'running') {
          assert.equal(store.getRun(id)?.state, type === 'approval.request' ? 'waiting_approval' : 'waiting_input');
        } else {
          assert.equal(store.getRun(id)?.state, state);
          const after = await request('/v1/approvals?state=all');
          assert.equal(after.pendingCount, before.pendingCount);
          assert.equal(after.approvals.length, before.approvals.length);
          assert.equal(store.activeCount(), activeBefore);
          assert.equal(store.events(id, 0).at(-1)?.type, type, 'buffered transcript events are retained without changing terminal state');
          assert.equal(store.pendingInputs(id).length, 0);
        }
      }
      if (state === 'running') {
        assert.equal((store.db.prepare('SELECT COUNT(*) n FROM approvals WHERE run_id=? AND state=?').get(id, 'pending') as { n: number }).n, 1);
        store.db.prepare('DELETE FROM approvals WHERE run_id=?').run(id);
        store.setRun(id, { state: 'completed' });
      }
      await request(`/v1/runner/commands/${commandId}/events`, { method: 'POST', headers, body: JSON.stringify({ runId: id, eventId: crypto.randomUUID(), event: { type: 'message.delta', payload: { text: 'trailing output' } } }) });
      assert.equal(store.events(id, 0).at(-1)?.type, 'message.delta');
      assert.equal(store.getRun(id)?.state, state === 'running' ? 'completed' : state);
    }
  } finally { store.db.close(); }
});

test('revoking a computer ends the run active on it and frees its execution slot', async () => {
  await request('/v1/agents/sync', { method: 'POST', body: JSON.stringify({ agents: [{ id: 'remote-r', name: 'Remote R', role: 'Generalist', instructions: '', config: { model: 'mock' } }] }) });
  const pairing = await request('/v1/machines', { method: 'POST', body: JSON.stringify({ name: 'Revoked VPS', platform: 'linux' }) });
  const encryption = await generateRunnerKeyPair();
  const paired = await (await fetch(`${base}/v1/runner/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: pairing.code, encryptionPublicKey: encryption.publicKey, platform: 'linux', capabilities: { container: true, direct: false, desktop: false, virtualDesktop: true, features: ['browser-state-transfer', 'sealed-agent-transfer', 'workspace-tools', 'run-leases', 'scoped-tool-review'] } }) })).json() as { machineId: string; token: string };
  const runnerHeaders = { Authorization: `Bearer ${paired.token}`, 'X-Open-Harness-Machine': paired.machineId, 'Content-Type': 'application/json' };
  const commands = async () => (await (await fetch(`${base}/v1/runner/commands`, { headers: runnerHeaders })).json() as { commands: Array<{ id: string; kind: string; payload: { runId?: string; sealedTransfer?: { checksum: string } } }> }).commands;
  const saved = await request('/v1/agents/remote-r/profile');
  await request('/v1/agents/remote-r/profile', { method: 'PUT', body: JSON.stringify({ ...saved.profile, computer: { ...saved.profile.computer, machineId: paired.machineId, access: 'private', desktop: 'none', reserveMachine: false } }) });
  const deadline = Date.now() + POLL_BUDGET_MS;
  while ((await request('/v1/agents/remote-r/profile')).profile.computer.machineId !== paired.machineId) {
    if (Date.now() > deadline) throw new Error('Transfer did not complete.');
    for (const item of await commands()) if (item.kind === 'import-agent') await request(`/v1/runner/commands/${item.id}/complete`, { method: 'POST', headers: runnerHeaders, body: JSON.stringify({ result: { checksum: item.payload.sealedTransfer?.checksum, validated: true } }) });
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const run = await request('/v1/runs', { method: 'POST', body: JSON.stringify({ agentId: 'remote-r', prompt: 'remote work that never returns' }) });
  let leased = false;
  while (!leased) { if (Date.now() > deadline) throw new Error('Run was not dispatched.'); leased = (await commands()).some(item => item.kind === 'run' && item.payload.runId === run.id); if (!leased) await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.equal((await request(`/v1/runs/${run.id}`)).state, 'running');
  const activeBefore = (await request('/v1/health')).activeRuns;
  await request(`/v1/machines/${paired.machineId}/revoke`, { method: 'POST' });
  const ended = await waitRun(run.id);
  assert.equal(ended.state, 'failed'); assert.equal(ended.error, 'Computer was revoked.');
  assert.ok((await request('/v1/health')).activeRuns <= activeBefore - 1, 'the revoked run no longer holds an execution slot');
  assert.equal((await fetch(`${base}/v1/runner/commands`, { headers: runnerHeaders })).status, 401);
});
