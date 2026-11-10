import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type RunRow } from "../runtime/db";
import { WorkflowStore, WorkflowError, nextWorkflowOccurrence, validateWorkflowSchedule } from "../runtime/workflows";
import type { WorkflowSchedule } from "../lib/workflows";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "harness-workflows-")), path = join(directory, "state.sqlite"), store = new Store(path, false);
  const published: Array<{ agentId: string; name: string; content: string }> = [];
  let fail = false;
  const dependencies = { createRun: (input: { agentId: string; prompt: string }) => {
    const at = new Date().toISOString();
    const run: RunRow = { id: crypto.randomUUID(), agent_id: input.agentId, prompt: input.prompt, conversation_id: crypto.randomUUID(), state: "queued", created_at: at, updated_at: at, session_id: null, parent_run_id: null, depth: 0, error: null, result: null };
    store.createRun(run); if (fail) throw new Error("Queue unavailable"); return run;
  }, publishSkill: (agentId: string, name: string, content: string) => { published.push({ agentId, name, content }); } };
  const workflows = new WorkflowStore(store.db, dependencies);
  store.upsertAgent({ id: "atlas", name: "Atlas", role: "Generalist", instructions: "" });
  store.runListener = run => workflows.onRunChanged(run);
  const source = dependencies.createRun({ agentId: "atlas", prompt: "Prepare the weekly report in the workspace." }); store.setRun(source.id, { state: "completed", result: "Report written and checked." });
  const create = () => workflows.create({ sourceRunId: source.id, name: "Weekly report", successCriteria: "The report exists and cites each data source." });
  const accepted = () => { const workflow = create(); workflows.review(workflow.id, 1); const { run } = workflows.test(workflow.id, 1); store.setRun(run.id, { state: "completed", result: "workspace/report.md exists with verified citations." }); workflows.reviewTest(workflow.id, run.id, { revision: 1, passed: true, evidence: "Opened report.md and verified its citations." }); return workflows.get(workflow.id); };
  t.after(() => { store.db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, workflows, dependencies, source, create, accepted, published, failDispatch: (value: boolean) => { fail = value; } };
}

test("workflow drafts require completed work and immutable review revisions", t => {
  const { workflows, store, source, create } = fixture(t);
  store.setRun(source.id, { state: "failed" }); assert.throws(create, /completed run/); store.setRun(source.id, { state: "completed" });
  const workflow = create(); assert.equal(workflow.agentId, "atlas"); assert.match(workflow.instructions, /weekly report/); assert.equal(workflow.reviewedRevision, null);
  assert.throws(() => workflows.test(workflow.id, 1), /Review/);
  workflows.review(workflow.id, 1);
  const edited = workflows.update(workflow.id, { revision: 1, name: "Daily report", instructions: "Write the report and verify source dates.", successCriteria: "Only current source dates." });
  assert.equal(edited.revision, 2); assert.equal(edited.reviewedRevision, null);
  assert.throws(() => workflows.update(workflow.id, { revision: 1 }), /revision 2.*draft was kept/);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM workflow_revisions").get() as { count: number }).count, 2);
});

test("recorded demonstrations enter the same unreviewed test pipeline", t => {
  const { workflows } = fixture(t);
  const draft = workflows.create({ source: "demonstration", agentId: "atlas", name: "Recorded browser task", instructions: "Describe the goal and starting page.\n1. Click at 150, 400.\n2. Enter the required text (omitted from recording)." });
  assert.equal(draft.source, "demonstration"); assert.equal(draft.sourceRunId, ""); assert.equal(draft.reviewedRevision, null); assert.equal(draft.tests.length, 0);
  assert.throws(() => workflows.test(draft.id, 1), /Review/);
  assert.throws(() => workflows.create({ source: "demonstration", agentId: "missing", instructions: "A recorded step" }), /Agent not found/);
  assert.throws(() => workflows.create({ source: "demonstration", agentId: "atlas" }), /Instructions/);
});

test("only the latest completed test with explicit evidence permits publishing and scheduling", async t => {
  const { workflows, store, published, create } = fixture(t), workflow = create();
  workflows.review(workflow.id, 1);
  await assert.rejects(workflows.publish(workflow.id, 1), /accept its result/);
  const first = workflows.test(workflow.id, 1).run;
  assert.throws(() => workflows.test(workflow.id, 1), /already running/);
  assert.throws(() => workflows.reviewTest(workflow.id, first.id, { revision: 1, passed: true, evidence: "Looks fine" }), /completed test/);
  store.setRun(first.id, { state: "completed", result: "Report generated" });
  assert.throws(() => workflows.reviewTest(workflow.id, first.id, { revision: 1, passed: true, evidence: "" }), /evidence/);
  workflows.reviewTest(workflow.id, first.id, { revision: 1, passed: true, evidence: "Checked source links and destination." });
  await workflows.publish(workflow.id, 1); assert.equal(published.length, 1); assert.equal(published[0].agentId, "atlas"); assert.match(published[0].content, /Success criteria/); assert.equal(workflows.get(workflow.id).publishedRevision, 1);
  workflows.schedule(workflow.id, { revision: 1, schedule: { kind: "interval", minutes: 60 } });
  const second = workflows.test(workflow.id, 1).run;
  assert.equal(workflows.get(workflow.id).routine?.enabled, false);
  store.setRun(second.id, { state: "failed", error: "Could not verify report" });
  assert.equal(workflows.get(workflow.id).tests[0].verdict, "failed");
  assert.throws(() => workflows.toggle(workflow.id), /accept its result/);
  assert.throws(() => workflows.schedule(workflow.id, { revision: 1, schedule: { kind: "interval", minutes: 60 } }), /accept its result/);
  await assert.rejects(workflows.publish(workflow.id, 1), /accept its result/);
});

test("editing a scheduled workflow pauses it and old test results cannot approve the new revision", t => {
  const { workflows, accepted } = fixture(t), workflow = accepted();
  workflows.schedule(workflow.id, { revision: 1, schedule: { kind: "interval", minutes: 5 } });
  workflows.update(workflow.id, { revision: 1, name: "Changed", instructions: "Changed steps", successCriteria: "Changed criteria" });
  assert.equal(workflows.get(workflow.id).routine?.enabled, false);
  assert.throws(() => workflows.toggle(workflow.id), /revision 2/);
  workflows.review(workflow.id, 2);
  assert.throws(() => workflows.reviewTest(workflow.id, workflow.tests[0].runId, { revision: 2, passed: true, evidence: "Old evidence" }), /current workflow revision/);
});

test("manual test overrides require review, retain a reason, and cannot publish an untested skill", async t => {
  const { workflows, create } = fixture(t), workflow = create();
  const input = { revision: 1, schedule: { kind: "calendar", time: "09:00", timezone: "America/Denver", weekdays: [1, 2, 3, 4, 5] }, manualOverride: "Operator checked the harmless read-only report manually." };
  assert.throws(() => workflows.schedule(workflow.id, input), /Review/);
  workflows.review(workflow.id, 1); workflows.schedule(workflow.id, input);
  assert.equal(workflows.get(workflow.id).routine?.manualOverride, input.manualOverride);
  await assert.rejects(workflows.publish(workflow.id, 1), /accept its result/);
});

test("calendar recurrence uses wall time across DST, skips missing times, and never repeats ambiguous times", () => {
  const calendar = (time: string): WorkflowSchedule => ({ kind: "calendar", timezone: "America/Denver", weekdays: [0], time });
  assert.equal(nextWorkflowOccurrence(calendar("09:00"), new Date("2026-03-01T17:00:00Z")), "2026-03-08T15:00:00.000Z");
  assert.equal(nextWorkflowOccurrence(calendar("02:30"), new Date("2026-03-07T17:00:00Z")), "2026-03-15T08:30:00.000Z");
  assert.equal(nextWorkflowOccurrence(calendar("01:30"), new Date("2026-11-01T07:00:00Z")), "2026-11-01T07:30:00.000Z");
  assert.equal(nextWorkflowOccurrence(calendar("01:30"), new Date("2026-11-01T07:30:00Z")), "2026-11-08T08:30:00.000Z");
  assert.equal(nextWorkflowOccurrence({ kind: "calendar", timezone: "Asia/Kathmandu", weekdays: [1], time: "09:00" }, new Date("2026-10-25T12:00:00Z")), "2026-10-26T03:15:00.000Z");
  assert.equal(nextWorkflowOccurrence({ kind: "interval", minutes: 5 }, new Date("2026-10-25T12:00:00Z")), "2026-10-25T12:05:00.000Z");
  assert.equal(nextWorkflowOccurrence({ kind: "webhook" }, new Date()), null);
});

test("schedule validation rejects malformed and unbounded inputs", () => {
  for (const value of [null, [], { kind: "cron" }, { kind: "interval", minutes: 0 }, { kind: "interval", minutes: Infinity }, { kind: "interval", minutes: "60" }, { kind: "calendar", timezone: "bad-zone", time: "09:00", weekdays: [1] }, { kind: "calendar", timezone: "UTC", time: "25:00", weekdays: [1] }, { kind: "calendar", timezone: "UTC", time: "09:00", weekdays: [] }, { kind: "calendar", timezone: "UTC", time: "09:00", weekdays: [7] }]) assert.throws(() => validateWorkflowSchedule(value), WorkflowError);
  assert.deepEqual(validateWorkflowSchedule({ kind: "calendar", timezone: "UTC", time: "09:00", weekdays: [3, 1, 1] }), { kind: "calendar", timezone: "UTC", time: "09:00", weekdays: [1, 3] });
});

test("scheduler dispatch is atomic, catches up once after downtime, and preserves legacy schedules", t => {
  const { store, workflows, dependencies, accepted, failDispatch } = fixture(t), workflow = accepted();
  workflows.schedule(workflow.id, { revision: 1, schedule: { kind: "interval", minutes: 5 } });
  store.db.prepare("UPDATE workflow_routines SET next_run_at=? WHERE workflow_id=?").run("2026-01-01T00:00:00.000Z", workflow.id);
  store.db.prepare("INSERT INTO schedules(id,agent_id,name,prompt,interval_minutes,timezone,enabled,next_run_at,created_at,updated_at) VALUES('legacy','atlas','Old routine','Report',60,'UTC',1,'2026-01-01','','')").run();
  const count = store.listRuns().length; failDispatch(true); workflows.tick(new Date("2026-10-25T12:00:00Z"));
  assert.equal(store.listRuns().length, count); assert.equal(workflows.get(workflow.id).history.length, 0); assert.match(workflows.get(workflow.id).routine?.lastError || "", /Queue unavailable/);
  failDispatch(false); workflows.tick(new Date("2026-10-25T12:00:00Z")); workflows.tick(new Date("2026-10-25T12:00:01Z"));
  assert.equal(workflows.get(workflow.id).history.length, 1); assert.equal(workflows.get(workflow.id).routine?.nextRunAt, "2026-10-25T12:05:00.000Z");
  const restarted = new WorkflowStore(store.db, dependencies); restarted.tick(new Date("2026-10-25T12:00:02Z")); assert.equal(restarted.get(workflow.id).history.length, 1);
  assert.equal((store.db.prepare("SELECT enabled FROM schedules WHERE id='legacy'").get() as { enabled: number }).enabled, 1);
});

test("webhooks authenticate only a scoped rotated hash and deduplicate events across restart", async t => {
  const { workflows, store, dependencies, accepted } = fixture(t), workflow = accepted(), other = accepted();
  workflows.schedule(workflow.id, { revision: 1, schedule: { kind: "webhook" } }); workflows.schedule(other.id, { revision: 1, schedule: { kind: "webhook" } });
  const credential = workflows.rotateWebhook(workflow.id), authorization = `Bearer ${credential.secret}`;
  const call = (token = authorization, key = "private-event-123") => workflows.webhook(workflow.id, token, key, { context: "New report data is ready." });
  assert.throws(() => call("Bearer wrong"), /Invalid webhook credential/);
  assert.throws(() => workflows.webhook(other.id, authorization, "event", {}), /Invalid webhook credential/);
  assert.throws(() => call(authorization, ""), /Idempotency-Key/);
  const first = call(); assert.equal(first.duplicate, false); assert.equal(call().runId, first.runId); assert.equal(call().duplicate, true);
  const restarted = new WorkflowStore(store.db, dependencies); assert.equal(restarted.webhook(workflow.id, authorization, "private-event-123", {}).runId, first.runId);
  const stored = JSON.stringify(store.db.prepare("SELECT * FROM workflow_routines").all()) + JSON.stringify(store.db.prepare("SELECT * FROM workflow_runs").all());
  assert.ok(!stored.includes(credential.secret)); assert.ok(!stored.includes("private-event-123"));
  assert.ok(!JSON.stringify(workflows.list()).includes(credential.secret)); assert.ok(!JSON.stringify(workflows.list()).includes("webhook_hash"));
  const safeResponse = await workflows.handle("GET", `/v1/workflows/${workflow.id}`); assert.ok(!JSON.stringify(safeResponse).includes(credential.secret));
  const second = workflows.rotateWebhook(workflow.id); assert.throws(() => call(), /Invalid webhook credential/); assert.notEqual(second.secret, credential.secret);
  workflows.toggle(workflow.id); assert.throws(() => call(`Bearer ${second.secret}`), /paused/);
});

test("HTTP adapter preserves explicit review errors and never treats webhook credentials as operator authority", async t => {
  const { workflows, create } = fixture(t), workflow = create();
  assert.equal(await workflows.handle("GET", "/v1/agents"), null);
  assert.equal((await workflows.handle("POST", `/v1/workflows/${workflow.id}/test`, { revision: 1 }))?.status, 409);
  assert.equal((await workflows.handle("POST", `/hooks/workflows/${workflow.id}`, {}, { authorization: "Bearer operator-token", idempotencyKey: "1" }))?.status, 401);
  assert.equal((await workflows.handle("POST", "/v1/workflows", []))?.status, 400);
});
