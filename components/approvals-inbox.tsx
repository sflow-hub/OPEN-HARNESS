"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, LoaderCircle, ShieldCheck, X } from "lucide-react";
import type { ApprovalItem, ControlClient } from "../lib/control-client";

type Filter = "pending" | "resolved";
const POLL_MS = 10_000;
const STATE_LABEL: Record<string, string> = { approve: "Approved", deny: "Denied" };
function age(ms: number) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}

// refreshKey changes when the page sees a new or answered approval in a run it follows, so the
// list catches up without waiting for the next poll.
export default function ApprovalsInbox({ client, refreshKey, onCount, onResolved }: { client: ControlClient; refreshKey: number; onCount: (count: number) => void; onResolved: (approvalId: string) => void }) {
  const [filter, setFilter] = useState<Filter>("pending");
  const [items, setItems] = useState<ApprovalItem[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  // Responses can land out of order across filter switches, polls and decisions; only the newest
  // request for the filter on screen may update the list. The filter is read from the ref, not a
  // closure, so a decision that finishes after a switch reloads the view now shown.
  const generation = useRef(0);
  const shown = useRef<Filter>("pending");
  const choose = (next: Filter) => { if (next === shown.current) return; shown.current = next; generation.current++; setItems(null); setError(""); setFilter(next); };

  const refresh = useCallback(async () => {
    const id = ++generation.current, target = shown.current;
    const latest = () => id === generation.current && shown.current === target;
    try {
      const value = await client.listApprovals({ state: target, limit: 100 });
      if (!latest()) return;
      setItems(value.approvals); onCount(value.pendingCount);
    } catch (cause) {
      if (!latest()) return;
      setItems(current => current ?? []);
      setError(cause instanceof Error ? cause.message : "Approvals could not be loaded.");
    }
  }, [client, onCount]);
  useEffect(() => {
    // The coordinator is the source of truth; load on mount, filter change and page events.
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, refreshKey, filter]);

  const resolve = async (item: ApprovalItem, decision: "approve" | "deny") => {
    setBusy(item.id); setError("");
    try {
      await client.resolveApproval(item.runId, item.id, decision);
      onResolved(item.id);
    } catch (cause) {
      setError((cause as { status?: number }).status === 409 ? "This approval is no longer pending." : cause instanceof Error ? cause.message : "Could not send that decision.");
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  return <section className="files-page approvals-page" aria-labelledby="approvals-title">
    <div className="eyebrow">NEEDS YOUR DECISION</div>
    <div className="files-title">
      <div>
        <h1 id="approvals-title">Approvals</h1>
        <p className="intro">Every request an agent is waiting on, across all your agents. Paused work keeps its slot until you answer.</p>
      </div>
      <div className="task-view-switch" role="group" aria-label="Show approvals">
        <button className={filter === "pending" ? "active" : ""} aria-pressed={filter === "pending"} onClick={() => choose("pending")}>Pending</button>
        <button className={filter === "resolved" ? "active" : ""} aria-pressed={filter === "resolved"} onClick={() => choose("resolved")}>History</button>
      </div>
    </div>
    {error && <div className="task-alert error approvals-alert" role="alert"><CircleAlert size={16} /> {error}<button aria-label="Dismiss" onClick={() => setError("")}><X size={15} /></button></div>}
    {items === null ? <p className="muted small approvals-loading"><LoaderCircle className="spin" size={14} /> Loading approvals…</p>
      : !items.length ? <div className="files-empty">
        <ShieldCheck size={40} />
        <h2>{filter === "pending" ? "Nothing is waiting for you." : "No answered approvals yet."}</h2>
        <p>{filter === "pending" ? "When an agent asks before taking an action, the request appears here." : "Approved, denied and expired requests are listed here."}</p>
      </div>
      : <ul className="file-table approvals-list" aria-label={filter === "pending" ? "Pending approvals" : "Approval history"}>
        {items.map(item => {
          const tool = item.summary.toolName || "Tool request";
          const outcome = item.state === "expired" ? "Expired" : STATE_LABEL[item.decision || ""] || "Resolved";
          return <li className="file-table-row approval-row" key={item.id} aria-label={`${item.agentName}: ${tool}`}>
            <div className="file-name">
              <ShieldCheck size={20} />
              <span>
                {item.agentName} · {tool}
                <small>{item.summary.description || "No details were shared for this request."}</small>
                <small>{item.state === "pending" ? `Requested ${age(item.ageMs)}` : `${outcome}${item.resolvedAt ? ` · ${new Date(item.resolvedAt).toLocaleString()}` : ""}`}</small>
              </span>
            </div>
            {item.state === "pending"
              ? <div className="approval-actions">
                <button className="subtle-button" disabled={busy !== null} aria-label={`Deny ${tool} for ${item.agentName}`} onClick={() => void resolve(item, "deny")}>Deny</button>
                <button className="light-button" disabled={busy !== null} aria-label={`Approve ${tool} for ${item.agentName}`} onClick={() => void resolve(item, "approve")}>{busy === item.id && <LoaderCircle className="spin" size={14} />} Approve</button>
              </div>
              : <span className={`run-pill ${item.state === "expired" ? "cancelled" : item.decision === "deny" ? "failed" : "completed"}`}>{outcome}</span>}
          </li>;
        })}
      </ul>}
  </section>;
}
