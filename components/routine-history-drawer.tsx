"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarClock, CircleAlert, LoaderCircle, X } from "lucide-react";
import type { ControlClient } from "../lib/control-client";
import type { Routine, RoutineRun } from "../lib/routine";

const displayTime = (value: string) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
const runLabel = (state: string) => ({ waiting_approval: "Needs approval", waiting_input: "Needs input" }[state] || state.replaceAll("_", " "));
const RESULT_PREVIEW = 280;
const preview = (value: string) => value.length > RESULT_PREVIEW ? `${value.slice(0, RESULT_PREVIEW).trimEnd()}…` : value;

export default function RoutineHistoryDrawer({ routine, agentName, client, onClose }: { routine: Routine; agentName: string; client: ControlClient; onClose: () => void }) {
  const [history, setHistory] = useState<RoutineRun[] | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    client.routineHistory(routine.id).then(
      runs => { if (!cancelled) setHistory(runs); },
      cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load this routine’s history."); },
    );
    return () => { cancelled = true; };
  }, [client, routine.id, attempt]);

  // Listening on the document rather than the drawer keeps Escape working even after focus
  // has been lost to the page, and the page-level focus trap does not cover this drawer.
  const drawerRef = useRef<HTMLElement>(null), closeRef = useRef<HTMLButtonElement>(null), dismissRef = useRef(onClose);
  useEffect(() => { dismissRef.current = onClose; });
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); dismissRef.current(); return; }
      if (event.key !== "Tab" || !drawerRef.current) return;
      const items = Array.from(drawerRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])"));
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1], inside = drawerRef.current.contains(document.activeElement);
      if (event.shiftKey && (!inside || document.activeElement === first)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (!inside || document.activeElement === last)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); if (opener?.isConnected) opener.focus(); };
  }, []);

  const retry = () => { setError(""); setHistory(null); setAttempt(value => value + 1); };

  return <div className="task-drawer-backdrop" onClick={onClose}>
    <aside ref={drawerRef} className="task-drawer" role="dialog" aria-modal="true" aria-label={`History for ${routine.name}`} onClick={event => event.stopPropagation()}>
      <div className="task-drawer-head"><span>Run history</span><button ref={closeRef} onClick={onClose} aria-label="Close history"><X size={19} /></button></div>
      <div className="task-drawer-scroll">
        <h2>{routine.name}</h2>
        <p className="muted small">{agentName} · newest first, up to 100 runs</p>
        {error ? <div className="task-alert error" role="alert"><CircleAlert size={16} /> {error}<button onClick={retry}>Try again</button></div>
          : !history ? <p className="task-loading"><LoaderCircle className="spin" size={15} /> Loading history…</p>
          : !history.length ? <div className="files-empty"><CalendarClock size={32} /><h2>No runs yet.</h2><p>Runs appear here once the schedule fires or you press Run now.</p></div>
          : history.map(run => <div className="run-history" key={run.run_id}>
            <span><b>{displayTime(run.scheduled_for)}</b>{run.updated_at && <small>Updated {displayTime(run.updated_at)}</small>}</span>
            <span className={`run-pill ${run.state}`}>{runLabel(run.state)}</span>
            {run.error ? <p className="run-error">{run.error}</p> : run.result && <p title={run.result}>{preview(run.result)}</p>}
          </div>)}
      </div>
    </aside>
  </div>;
}
