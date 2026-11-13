"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ControlClient, PersistentRun } from "@/lib/control-client";
import type { Agent } from "@/lib/types";
import type { Workflow, WorkflowSchedule, WorkflowSnapshot } from "@/lib/workflows";
import styles from "./workflow-manager.module.css";

type Props = { client: ControlClient; agents: Agent[]; fromRunId?: string; selectedWorkflowId?: string; onOpenRun?: (run: PersistentRun, title: string) => void };
const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const active = new Set(["queued", "running", "waiting_approval", "waiting_input"]);
const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
function status(workflow: Workflow) {
  if (workflow.reviewedRevision !== workflow.revision) return "Draft · review needed";
  const latest = workflow.tests.find(test => test.revision === workflow.revision);
  if (latest && active.has(latest.state)) return "Test in progress";
  if (latest?.verdict === "passed") return "Test accepted";
  return latest ? "Review test result" : "Reviewed · test needed";
}

export default function WorkflowManager({ client, agents, fromRunId, selectedWorkflowId, onOpenRun }: Props) {
  const [snapshot, setSnapshot] = useState<WorkflowSnapshot>({ workflows: [] });
  const [runs, setRuns] = useState<PersistentRun[]>([]);
  const [selected, setSelected] = useState(selectedWorkflowId || "");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [sourceRun, setSourceRun] = useState(fromRunId || "");
  const promoted = useRef("");
  const requestedWorkflow = useRef(selectedWorkflowId || "");
  const refresh = useCallback(async () => {
    const [workflows, allRuns] = await Promise.all([client.request<WorkflowSnapshot>("/v1/workflows"), client.request<{ runs: PersistentRun[] }>("/v1/runs")]);
    setSnapshot(workflows); setRuns(allRuns.runs.filter(run => run.state === "completed")); setLoaded(true);
  }, [client]);
  useEffect(() => {
    // Refreshes retain the editor's local draft; only a successful save replaces it.
    const load = () => { void refresh().catch(cause => { setError(cause instanceof Error ? cause.message : "Workflows are unavailable."); setLoaded(true); }); };
    load(); const timer = window.setInterval(() => { if (!document.hidden) load(); }, 4000); return () => window.clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (!fromRunId || promoted.current === fromRunId) return;
    promoted.current = fromRunId;
    // A conversation action selects the source but leaves promotion explicit and editable.
    setSourceRun(fromRunId);
  }, [fromRunId]);
  useEffect(() => {
    if (!selectedWorkflowId || requestedWorkflow.current === selectedWorkflowId) return;
    requestedWorkflow.current = selectedWorkflowId;
    setSelected(selectedWorkflowId);
  }, [selectedWorkflowId]);
  const operation = async (work: () => Promise<void>) => { setBusy(true); setError(""); setNotice(""); try { await work(); await refresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : "The workflow could not be saved."); } finally { setBusy(false); } };
  const current = snapshot.workflows.find(workflow => workflow.id === selected) || null;
  return <section className={styles.panel} aria-label="Reusable workflows">
    <header className={styles.header}><div><h2>Reusable workflows</h2><p className={styles.hint}>Turn completed work into clear instructions, test the result, then run it on a schedule.</p></div></header>
    {error && <div role="alert" className={styles.error}>{error}</div>}
    {notice && <div role="status" className={styles.notice}>{notice}</div>}
    <form className={styles.card} onSubmit={event => { event.preventDefault(); void operation(async () => { const workflow = await client.request<Workflow>("/v1/workflows", { method: "POST", body: JSON.stringify({ sourceRunId: sourceRun }) }); setSelected(workflow.id); setNotice("Draft created. Review the steps and success criteria before testing."); }); }}>
      <label className={styles.form}>Completed conversation<select aria-label="Completed conversation" value={sourceRun} onChange={event => setSourceRun(event.target.value)}><option value="">Choose completed work</option>{runs.map(run => <option value={run.id} key={run.id}>{agents.find(agent => agent.id === run.agent_id)?.name || run.agent_id}: {run.prompt.slice(0, 110)}</option>)}</select></label>
      <div className={styles.actions}><button className={styles.primary} type="submit" disabled={busy || !sourceRun}>Create workflow draft</button>{loaded && !runs.length && <span className={styles.hint}>Complete a task with an agent to begin.</span>}</div>
    </form>
    {!loaded ? <p role="status">Loading workflows…</p> : <div className={styles.layout}>
      <nav className={styles.list} aria-label="Saved workflows">{snapshot.workflows.map(workflow => <button type="button" aria-pressed={selected === workflow.id} key={workflow.id} onClick={() => { setSelected(workflow.id); setError(""); setNotice(""); }}><strong>{workflow.name}</strong><span className={styles.hint}>{agents.find(agent => agent.id === workflow.agentId)?.name || workflow.agentId} · revision {workflow.revision}</span><span className={styles.status}>{status(workflow)}</span></button>)}</nav>
      {current ? <WorkflowEditor key={current.id} workflow={current} busy={busy} client={client} operation={operation} notify={setNotice} onOpenRun={onOpenRun} /> : <div className={styles.card}><h3>Teach once, improve with evidence</h3><p className={styles.hint}>Choose a saved workflow or start with a completed conversation. A completed agent run still needs your review before it counts as a passing test.</p></div>}
    </div>}
  </section>;
}

function WorkflowEditor({ workflow, busy, client, operation, notify, onOpenRun }: { workflow: Workflow; busy: boolean; client: ControlClient; operation: (work: () => Promise<void>) => Promise<void>; notify: (message: string) => void; onOpenRun?: Props["onOpenRun"] }) {
  const [draft, setDraft] = useState({ revision: workflow.revision, name: workflow.name, instructions: workflow.instructions, successCriteria: workflow.successCriteria });
  const [evidence, setEvidence] = useState("");
  const [kind, setKind] = useState<WorkflowSchedule["kind"]>(workflow.routine?.schedule.kind || "calendar");
  const initial = workflow.routine?.schedule;
  const [minutes, setMinutes] = useState(initial?.kind === "interval" ? initial.minutes : 60);
  const [zone, setZone] = useState(initial?.kind === "calendar" ? initial.timezone : timezone);
  const [time, setTime] = useState(initial?.kind === "calendar" ? initial.time : "09:00");
  const [weekdays, setWeekdays] = useState(initial?.kind === "calendar" ? initial.weekdays : [1, 2, 3, 4, 5]);
  const [override, setOverride] = useState(false);
  const [reason, setReason] = useState("");
  const [webhook, setWebhook] = useState<{ secret: string; path: string } | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const dirty = draft.name !== workflow.name || draft.instructions !== workflow.instructions || draft.successCriteria !== workflow.successCriteria || draft.revision !== workflow.revision;
  const reviewed = workflow.reviewedRevision === workflow.revision;
  const latest = workflow.tests.find(test => test.revision === workflow.revision);
  const passed = latest?.verdict === "passed" && latest.state === "completed";
  const post = <T,>(action: string, data: Record<string, unknown> = {}) => client.request<T>(`/v1/workflows/${workflow.id}/${action}`, { method: "POST", body: JSON.stringify({ revision: workflow.revision, ...data }) });
  const apply = (value: Workflow) => setDraft({ revision: value.revision, name: value.name, instructions: value.instructions, successCriteria: value.successCriteria });
  const save = () => operation(async () => { apply(await client.request<Workflow>(`/v1/workflows/${workflow.id}`, { method: "PATCH", body: JSON.stringify(draft) })); notify("Saved a new revision. Review and test it before resuming its routine."); });
  const viewRun = (id: string) => operation(async () => { const run = await client.request<PersistentRun>(`/v1/runs/${id}`); onOpenRun?.(run, workflow.name); });
  return <div className={styles.card}>
    <div className={styles.header}><div><h3>{workflow.name}</h3><span className={styles.status}>{status(workflow)}</span></div><span className={styles.hint}>{workflow.source === "demonstration" ? "Recorded demonstration · " : ""}Revision {workflow.revision}</span></div>
    {workflow.sourceRunId && onOpenRun && <div className={styles.actions}><button type="button" disabled={busy} onClick={() => void viewRun(workflow.sourceRunId)}>Open source conversation</button></div>}
    <form className={styles.form} onSubmit={event => { event.preventDefault(); void save(); }}>
      <label>Workflow name<input value={draft.name} maxLength={120} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
      <label>Workflow instructions<textarea value={draft.instructions} maxLength={20000} rows={7} onChange={event => setDraft({ ...draft, instructions: event.target.value })} /></label>
      <label>Success criteria<textarea value={draft.successCriteria} maxLength={5000} rows={3} onChange={event => setDraft({ ...draft, successCriteria: event.target.value })} /></label>
      {draft.revision !== workflow.revision && <p className={styles.error}>A newer revision ({workflow.revision}) is available. Your draft is still here. Copy any changes you need before loading the saved revision.</p>}
      <div className={styles.actions}><button type="submit" disabled={busy || !dirty}>Save revision</button><button type="button" disabled={busy || !dirty} onClick={() => apply(workflow)}>Load saved revision</button><button type="button" disabled={busy || dirty || reviewed} onClick={() => void operation(async () => { await post("review"); notify("Instructions reviewed. Run a test against your success criteria."); })}>Mark reviewed</button></div>
    </form>
    <hr className={styles.separator} />
    <h3>Test and verify</h3><p className={styles.hint}>A test performs the actual task with the agent’s normal approval controls. Check its output before accepting it.</p>
    <div className={styles.actions}><button type="button" disabled={busy || dirty || !reviewed || Boolean(latest && active.has(latest.state))} onClick={() => void operation(async () => { await post("test"); notify("Workflow test started. Results will appear here; approvals are available in the conversation."); })}>Run workflow test</button>{latest && onOpenRun && <button type="button" onClick={() => void viewRun(latest.runId)}>Open test conversation</button>}</div>
    {latest && <div className={styles.form}><p className={styles.hint}>Latest test: {latest.state.replaceAll("_", " ")} · {latest.verdict}</p>{latest.result && <pre className={styles.result}>{latest.result}</pre>}{latest.error && <p className={styles.error}>{latest.error}</p>}{latest.evidence && <p className={styles.hint}>Recorded evidence: {latest.evidence}</p>}
      {!active.has(latest.state) && <><label>Test evidence<textarea value={evidence} onChange={event => setEvidence(event.target.value)} maxLength={5000} placeholder="What did you verify? Include the output or destination you checked." /></label><div className={styles.actions}><button type="button" disabled={busy || dirty || latest.state !== "completed" || !evidence.trim()} onClick={() => void operation(async () => { await post(`tests/${latest.runId}/review`, { passed: true, evidence }); setEvidence(""); notify("Test accepted for this revision. You can publish the skill or schedule it."); })}>Accept test result</button><button type="button" disabled={busy || dirty || !evidence.trim()} onClick={() => void operation(async () => { await post(`tests/${latest.runId}/review`, { passed: false, evidence }); setEvidence(""); notify("Test rejected. Update the instructions and try again."); })}>Reject test result</button></div></>}
    </div>}
    <div className={styles.actions}><button type="button" disabled={busy || dirty || !passed} onClick={() => void operation(async () => { await post("publish"); notify("Published to the agent’s managed skills."); })}>Publish as skill</button>{workflow.publishedRevision && <span className={styles.hint}>Published revision {workflow.publishedRevision}</span>}</div>
    <hr className={styles.separator} />
    <h3>Recurring work</h3>
    <form className={styles.form} onSubmit={event => { event.preventDefault(); void operation(async () => { const schedule: WorkflowSchedule = kind === "interval" ? { kind, minutes } : kind === "calendar" ? { kind, timezone: zone, weekdays, time } : { kind }; await post("routine", { schedule, ...(!passed && override ? { manualOverride: reason } : {}) }); setWebhook(null); notify("Routine saved. It runs while the coordinator and agent computer are available."); }); }}>
      <label>Trigger<select value={kind} onChange={event => setKind(event.target.value as WorkflowSchedule["kind"])}><option value="calendar">Days and time</option><option value="interval">Every few minutes or hours</option><option value="webhook">External event (webhook)</option></select></label>
      {kind === "interval" && <label>Interval in minutes<input type="number" min={1} max={525600} value={minutes} onChange={event => setMinutes(Number(event.target.value))} /></label>}
      {kind === "calendar" && <><fieldset className={styles.days}><legend>Days of the week</legend>{days.map((day, index) => <label key={day}><input type="checkbox" checked={weekdays.includes(index)} onChange={event => setWeekdays(event.target.checked ? [...weekdays, index] : weekdays.filter(value => value !== index))} />{day}</label>)}</fieldset><label>Time<input type="time" value={time} onChange={event => setTime(event.target.value)} /></label><label>Time zone<input value={zone} onChange={event => setZone(event.target.value)} placeholder="America/Denver" /></label><p className={styles.hint}>Uses local time in this zone. A missing daylight-saving time is skipped; a repeated time runs once. After downtime, one overdue run is started.</p></>}
      {kind === "webhook" && <p className={styles.hint}>An external service can trigger this workflow with a scoped credential and a unique event ID. Configure the sender after saving; no email or chat account is connected automatically.</p>}
      {!passed && <><label className={styles.check}><input type="checkbox" checked={override} onChange={event => setOverride(event.target.checked)} />Schedule without an accepted test</label>{override && <label>Reason for test override<textarea value={reason} maxLength={1000} onChange={event => setReason(event.target.value)} placeholder="Explain why this reviewed workflow can run before a passing test." /></label>}</>}
      <div className={styles.actions}><button className={styles.primary} type="submit" disabled={busy || dirty || !reviewed || (!passed && (!override || !reason.trim()))}>Save routine</button>{workflow.routine && <button type="button" disabled={busy || dirty} onClick={() => void operation(async () => { await post("toggle"); })}>{workflow.routine.enabled ? "Pause routine" : "Resume routine"}</button>}</div>
    </form>
    {workflow.routine && <div className={styles.form}><p className={styles.hint}>{workflow.routine.enabled ? "Enabled" : "Paused"} · revision {workflow.routine.revision}{workflow.routine.nextRunAt ? ` · Next: ${new Date(workflow.routine.nextRunAt).toLocaleString()}` : " · Waiting for external events"}</p>{workflow.routine.manualOverride && <p className={styles.notice}>Test override: {workflow.routine.manualOverride}</p>}{workflow.routine.lastError && <p className={styles.error}>{workflow.routine.lastError}</p>}
      {workflow.routine.schedule.kind === "webhook" && <><button type="button" disabled={busy} onClick={() => void operation(async () => { setWebhook(await post("webhook/rotate")); setShowSecret(false); })}>{workflow.routine.webhookConfigured ? "Rotate webhook credential" : "Create webhook credential"}</button><p className={styles.hint}>Rotation immediately invalidates the previous credential. The new value is shown once and is never included in workflow history.</p>{webhook && <div className={styles.notice}><p>Send POST to your coordinator at <code className={styles.secret}>{webhook.path}</code> with <code>Authorization: Bearer &lt;credential&gt;</code>, <code>Idempotency-Key: &lt;unique-event-id&gt;</code>, and optional JSON <code>{'{"context":"event details"}'}</code>.</p><button type="button" onClick={() => setShowSecret(!showSecret)}>{showSecret ? "Hide credential" : "Reveal credential"}</button>{showSecret && <p className={styles.secret}>{webhook.secret}</p>}</div>}</>}
    </div>}
    {!!workflow.history.length && <details><summary>Recent routine runs ({workflow.history.length})</summary><div className={styles.history}>{workflow.history.map(run => <div key={run.runId}>{new Date(run.createdAt).toLocaleString()} · {run.trigger} · {run.state}{onOpenRun && <button type="button" onClick={() => void viewRun(run.runId)}>Open run</button>}</div>)}</div></details>}
  </div>;
}
