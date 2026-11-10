import type { Store, RunState } from "./db";
import type { ApprovalItem } from "../lib/control-client";

export function reconcileApproval(state: string, runState: RunState): ApprovalItem["state"] {
  return state === "pending" ? (["completed", "failed", "cancelled", "interrupted"].includes(runState) ? "expired" : "pending") : state === "expired" ? "expired" : "resolved";
}

export function approvalSummary(payloadJson: string): ApprovalItem["summary"] {
  const summary: ApprovalItem["summary"] = { toolName: null, description: null };
  function safeString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    return value.replace(/\bBearer\s+[^\s"'`,;]+/gi, "[redacted]")
      .replace(/\bsk-[a-zA-Z0-9_-]+/g, "[redacted]")
      .replace(/\b[\w.-]*(?:secret|token|password|passwd|credential|authorization|auth|cookie|key)[\w.-]*\s*[=:]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&]+)/gi, "[redacted]").slice(0, 300);
  }
  try {
    const payload = JSON.parse(payloadJson);
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      summary.toolName = safeString(payload.tool) ?? safeString(payload.tool_name) ?? safeString(payload.toolName) ?? safeString(payload.name);
      const args = payload.args && typeof payload.args === "object" && !Array.isArray(payload.args) ? payload.args : {};
      for (const source of [payload, args]) {
        for (const key of ["description", "command", "path", "url"]) summary.description ??= safeString(source[key]);
      }
    }
  } catch { /* Malformed legacy payloads have no safe summary. */ }
  return summary;
}

export function listApprovals(store: Store, { state = "pending", limit = 100, agentId }: { state?: "pending" | "resolved" | "all"; limit?: number; agentId?: string } = {}) {
  if (!["pending", "resolved", "all"].includes(state) || !Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid approval state or limit.");
  const effectiveState = "CASE WHEN a.state='pending' AND r.state IN ('completed','failed','cancelled','interrupted') THEN 'expired' WHEN a.state IN ('pending','expired') THEN a.state ELSE 'resolved' END";
  const clauses: string[] = [], params: string[] = [];
  if (agentId !== undefined) { clauses.push("r.agent_id=?"); params.push(agentId); }
  const from = "FROM approvals a JOIN runs r ON r.id=a.run_id LEFT JOIN agents g ON g.id=r.agent_id";
  const pendingCount = Number((store.db.prepare(`SELECT COUNT(*) n ${from} WHERE ${[...clauses, `${effectiveState}='pending'`].join(" AND ")}`).get(...params) as { n: number }).n);
  if (state !== "all") { clauses.push(state === "resolved" ? `${effectiveState}!='pending'` : `${effectiveState}='pending'`); }
  type Row = { id: string; run_id: string; agent_id: string; agent_name: string; conversation_id: string; run_state: RunState; run_created_at: string; state: string; created_at: string; resolved_at: string | null; payload_json: string };
  const rows = store.db.prepare(`SELECT a.*, r.agent_id, COALESCE(g.name,r.agent_id) agent_name, r.conversation_id, r.state run_state, r.created_at run_created_at ${from} ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY a.created_at DESC, a.id DESC LIMIT ?`).all(...params, Math.min(limit, 200)) as Row[];
  const approvals: ApprovalItem[] = rows.map(row => ({ id: row.id, runId: row.run_id, agentId: row.agent_id, agentName: row.agent_name, conversationId: row.conversation_id, runState: row.run_state, runCreatedAt: row.run_created_at, state: reconcileApproval(row.state, row.run_state), decision: ["pending", "expired"].includes(row.state) ? null : row.state, createdAt: row.created_at, resolvedAt: row.resolved_at, ageMs: Math.max(0, Date.now() - Date.parse(row.created_at) || 0), summary: approvalSummary(row.payload_json) }));
  return { approvals, pendingCount };
}
