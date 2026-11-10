'use client';
import type { AssistantOutcome } from '../lib/assistant-overview';
import { isLiveRun, type ControlClient, type PersistentRun } from '../lib/control-client';
import type { ActionIntent, Connection, Responsibility, WorkflowDraft } from '../lib/product';
import { ActionCard } from './assistant-decisions';
import { OutcomeCard, formatTime } from './assistant-outcomes';

type Agent = { id: string; name: string };
type Mutate = (work: () => Promise<unknown>) => Promise<void>;
const today = (value?: string | null) => { if (!value) return false; const date = new Date(value), now = new Date(); return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate(); };

export default function AssistantToday({ client, generatedAt, briefRunId, outcomes, runs, decisions, pending, responsibilities, accounts, agents, busy, writable, mutate, onReview, onOpenRun, onDraft, onPrepare }: {
  client: ControlClient; generatedAt: string | null; briefRunId: string | null; outcomes: AssistantOutcome[]; runs: PersistentRun[]; decisions: ActionIntent[]; pending: PersistentRun[]; responsibilities: Responsibility[]; accounts: Connection[]; agents: Agent[];
  busy: boolean; writable: boolean; mutate: Mutate; onReview(action: ActionIntent): void; onOpenRun(run: PersistentRun, title: string): void; onDraft(draft: WorkflowDraft): void; onPrepare(): void;
}) {
  const runById = new Map(runs.map(run => [run.id, run])), brief = briefRunId ? outcomes.find(item => item.runId === briefRunId) : undefined, briefRun = briefRunId ? runById.get(briefRunId) : undefined;
  const finishedToday = outcomes.filter(item => item.runId !== briefRunId && !isLiveRun({ state: item.state as PersistentRun['state'] }) && today(item.updatedAt));
  const card = { client, agents, busy, writable, mutate, onOpenRun, onDraft };
  return <section className="assistant-today" aria-label="Today">
    <p className="muted">{generatedAt ? `Updated ${formatTime(generatedAt)}` : 'Not loaded yet'}</p>
    <h2>Your day brief</h2>
    {brief ? <>
      <small>From {formatTime(brief.updatedAt || brief.createdAt) || 'your latest Prepare my day task'}{!today(brief.updatedAt) ? ' — this brief is not from today' : ''}</small>
      <OutcomeCard {...card} outcome={brief} run={briefRun} />
      {writable && brief.state === 'completed' && <p><button disabled={busy} onClick={() => void mutate(async () => onDraft(await client.request<WorkflowDraft>('/v1/workflow-drafts', { method: 'POST', body: JSON.stringify({ sourceRunId: brief.runId }) })))}>Make this a reviewed routine</button><small>Recurring briefs go through the workflow review and test before they are scheduled.</small></p>}
    </> : <div className="assistant-card assistant-empty"><p>No day brief yet. Prepare my day reads the Gmail and Calendar accounts you choose and writes a short brief. Nothing is shown here until it has actually run.</p>{writable && <button className="light-button" onClick={onPrepare}>Prepare my day</button>}</div>}
    <h2>Needs you</h2>
    {decisions.length + pending.length ? <>{decisions.map(action => <ActionCard key={action.id} action={action} accounts={accounts} busy={busy} writable={writable} onReview={() => onReview(action)} />)}{pending.map(run => <article key={run.id} className="assistant-card"><strong>A question or approval is waiting</strong><p className="assistant-clamp">{run.prompt}</p><button onClick={() => onOpenRun(run, run.prompt)}>Open decision</button></article>)}</> : <p className="muted">Nothing is waiting for you.</p>}
    <h2>Finished today</h2>
    {finishedToday.length ? finishedToday.map(item => <OutcomeCard key={item.runId} {...card} outcome={item} run={runById.get(item.runId)} compact />) : <p className="muted">No work has finished today.</p>}
    <h2>Standing duties</h2>
    {responsibilities.length ? <ul className="assistant-duties">{responsibilities.map(item => <li key={item.id}><strong>{item.title}</strong> <span className="assistant-chip">{item.state}</span><small>{item.lastCheckedAt ? `Last checked ${formatTime(item.lastCheckedAt)}` : 'Not checked yet'}{item.nextCheckAt && item.state === 'active' ? ` · Next ${formatTime(item.nextCheckAt)}` : ''}</small>{item.lastError ? <small role="status">{item.lastError}</small> : item.lastResult ? <small className="assistant-clamp">{item.lastResult}</small> : null}</li>)}</ul> : <p className="muted">No standing duties. Ask your assistant to propose one; it starts paused for your review.</p>}
  </section>;
}
