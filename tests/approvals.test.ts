import test from "node:test";
import assert from "node:assert/strict";
import { Store, type RunState } from "../runtime/db";
import { approvalSummary, listApprovals } from "../runtime/approvals";

test("lists approvals with agent filters, bounded pages and computed expiry", () => {
  const store = new Store(":memory:");
  try {
    store.upsertAgent({ id: "atlas", name: "Atlas", role: "Generalist", instructions: "" });
    const states: RunState[] = ["waiting_approval", "completed", "failed", "cancelled", "interrupted", "running"];
    for (const [index, state] of states.entries()) {
      const id = String(index), created = new Date(Date.now() - 5000).toISOString();
      store.createRun({ id, agent_id: index === 5 ? "other" : "atlas", conversation_id: "chat", prompt: "", state, session_id: null, parent_run_id: null, depth: 0, created_at: created, updated_at: created, result: null, error: null });
      store.createApproval(id, id, "gateway", { tool_name: "terminal", command: "ls" });
      store.db.prepare("UPDATE approvals SET created_at=? WHERE id=?").run(created, id);
    }
    const pending = listApprovals(store, { limit: 1 });
    assert.equal(pending.pendingCount, 2); assert.equal(pending.approvals.length, 1);
    const atlas = listApprovals(store, { agentId: "atlas" });
    assert.equal(atlas.pendingCount, 1); assert.equal(atlas.approvals[0].agentName, "Atlas");
    assert.equal(atlas.approvals[0].conversationId, "chat"); assert.ok(atlas.approvals[0].ageMs >= 5000);
    assert.equal(listApprovals(store, { state: "resolved" }).approvals.filter(row => row.state === "expired").length, 4);
    assert.equal(store.approval("1")!.state, "pending");
    store.resolveApproval("0", "approve");
    const resolved = listApprovals(store, { state: "resolved", agentId: "atlas" });
    assert.equal(resolved.pendingCount, 0); assert.equal(resolved.approvals.find(row => row.id === "0")!.decision, "approve");
    assert.equal(listApprovals(store, { state: "all" }).approvals.length, 6);
    assert.throws(() => listApprovals(store, { limit: 0 }), /Invalid/);
    for (let index = 0; index < 210; index++) store.createApproval(`extra-${index}`, "5", "gateway", {});
    assert.equal(listApprovals(store, { limit: 999 }).approvals.length, 200);
  } finally { store.db.close(); }
});


test("durable approval intermediates remain outstanding until the run ends", () => {
  const store = new Store(":memory:");
  try {
    const created = new Date().toISOString(), live = ["pending", "submitting", "submitted"];
    const cases: { id: string; stored: string; run: RunState; state: string; decision: string | null }[] = [];
    for (const run of ["waiting_approval", "running", "completed", "failed", "cancelled", "interrupted"] as RunState[]) {
      for (const stored of live) cases.push({ id: `${run}-${stored}`, stored, run, state: ["running", "waiting_approval"].includes(run) ? stored : "expired", decision: null });
    }
    for (const stored of ["approve", "deny", "expired"]) cases.push({ id: stored, stored, run: "running", state: stored === "expired" ? "expired" : "resolved", decision: stored === "expired" ? null : stored });
    for (const item of cases) {
      store.createRun({ id: item.id, agent_id: "atlas", conversation_id: "chat", prompt: "", state: item.run, session_id: null, parent_run_id: null, depth: 0, created_at: created, updated_at: created, result: null, error: null });
      store.createApproval(item.id, item.id, "gateway", {});
      store.db.prepare("UPDATE approvals SET state=? WHERE id=?").run(item.stored, item.id);
    }
    const all = listApprovals(store, { state: "all" });
    assert.equal(all.pendingCount, 6); assert.equal(all.approvals.length, cases.length);
    for (const expected of cases) {
      const item = all.approvals.find(item => item.id === expected.id)!;
      assert.equal(item.state, expected.state, expected.id); assert.equal(item.decision, expected.decision, expected.id);
      assert.equal(store.approval(expected.id)!.state, expected.stored, 'Listing must not mutate the durable approval state');
    }
    const pending = listApprovals(store, { state: "pending", limit: 2 });
    assert.equal(pending.pendingCount, 6); assert.equal(pending.approvals.length, 2);
    assert.deepEqual(new Set(listApprovals(store).approvals.map(item => item.state)), new Set(live));
    const resolved = listApprovals(store, { state: "resolved" });
    assert.equal(resolved.pendingCount, 6); assert.equal(resolved.approvals.length, cases.length - 6);
    assert.ok(resolved.approvals.every(item => ["expired", "resolved"].includes(item.state)));
    assert.deepEqual(listApprovals(store, { agentId: "missing" }), { approvals: [], pendingCount: 0 });
  } finally { store.db.close(); }
});

test("summaries exclude sensitive keys and their descendants and truncate text", () => {
  const payload = { secret: { command: "secret" }, apiKey: { tool_name: "secret" }, token: "secret", password: "secret", values: { description: "secret" }, args: { command: "x".repeat(400) }, tool_name: "terminal" };
  assert.deepEqual(approvalSummary(JSON.stringify(payload)), { toolName: "terminal", description: "x".repeat(300) });
  assert.deepEqual(approvalSummary('{invalid'), { toolName: null, description: null });
  assert.deepEqual(approvalSummary('null'), { toolName: null, description: null });
});

test("summaries only read allowlisted strings at the top level or directly in args", () => {
  const hidden = { description: "private description", command: "private command", tool: "private tool" };
  const payload = { headers: hidden, env: hidden, authorization: hidden, auth: hidden, credentials: hidden, cookie: hidden, bearer: hidden, nested: hidden, args: { headers: hidden, env: hidden, authorization: hidden, nested: hidden } };
  assert.deepEqual(approvalSummary(JSON.stringify(payload)), { toolName: null, description: null });
  assert.deepEqual(approvalSummary(JSON.stringify({ ...payload, tool: "terminal", args: { ...payload.args, path: "/safe/path" } })), { toolName: "terminal", description: "/safe/path" });
  assert.deepEqual(approvalSummary(JSON.stringify({ name: "reader", url: "https://example.test" })), { toolName: "reader", description: "https://example.test" });
});

test("summaries mask inline credentials before truncating selected strings", () => {
  assert.deepEqual(approvalSummary(JSON.stringify({ tool_name: "sk-toolSecret", command: 'curl Bearer abc123 sk-proj-secret api_key=value password="two words" auth=private cookie=session safe=yes' })), { toolName: "[redacted]", description: "curl [redacted] [redacted] [redacted] [redacted] [redacted] [redacted] safe=yes" });
  assert.equal(approvalSummary(JSON.stringify({ command: "x".repeat(290) + " Bearer " + "t".repeat(100) })).description, "x".repeat(290) + " [redacted" );
  assert.equal(approvalSummary(JSON.stringify({ tool: "t".repeat(400) })).toolName?.length, 300);
});
