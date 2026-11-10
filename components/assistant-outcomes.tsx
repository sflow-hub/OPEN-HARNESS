'use client';
import { useState } from 'react';
import type { AssistantArtifact, AssistantOutcome } from '../lib/assistant-overview';
import type { ControlClient, PersistentRun } from '../lib/control-client';
import { PRIMARY_ASSISTANT_ID, type WorkflowDraft } from '../lib/product';

type Agent = { id: string; name: string };
type Mutate = (work: () => Promise<unknown>) => Promise<void>;
type SharedFile = { name: string; content: string; encoding: 'utf8' | 'base64'; mimeType?: string };

// Links are rendered only for plain http(s) addresses without embedded credentials.
export function safeHref(value: string | undefined) {
  if (!value) return null;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export const formatTime = (value?: string | null) => { if (!value) return ''; const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(); };
const verificationLabel = { accepted: 'Accepted', needs_changes: 'Needs changes', unreviewed: 'Not reviewed yet' } as const;
const finished = (state: string) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(state);
const stateLabel = (state: string) => ({ completed: 'Finished', failed: 'Failed', cancelled: 'Stopped', interrupted: 'Interrupted', waiting_approval: 'Waiting for you', waiting_input: 'Waiting for you', running: 'Working', queued: 'Queued' }[state] || state.replaceAll('_', ' '));

export function ArtifactLinks({ client, outcome, mutate }: { client: ControlClient; outcome: AssistantOutcome; mutate: Mutate }) {
  const [file, setFile] = useState<SharedFile | null>(null);
  const open = (artifact: AssistantArtifact) => mutate(async () => {
    if (!artifact.path) return;
    const value = await client.request<SharedFile>(`/v1/files?scope=shared&name=${encodeURIComponent(artifact.path)}`);
    if (value.encoding === 'utf8') { setFile(value); return; }
    const bytes = Uint8Array.from(atob(value.content), char => char.charCodeAt(0)), url = URL.createObjectURL(new Blob([bytes], { type: value.mimeType || 'application/octet-stream' })), anchor = document.createElement('a');
    anchor.href = url; anchor.download = value.name.split('/').pop() || 'download'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  if (!outcome.artifacts.length && !outcome.sources.length) return null;
  return <div className="assistant-links">
    {outcome.artifacts.length > 0 && <><h4>Deliverables</h4><ul>{outcome.artifacts.map((artifact, index) => <li key={index}>{artifact.kind === 'file' ? <button className="assistant-link-button" onClick={() => void open(artifact)}>{artifact.label} <small>shared file · {artifact.path}</small></button> : safeHref(artifact.url) ? <a href={safeHref(artifact.url)!} target="_blank" rel="noopener noreferrer">{artifact.label}</a> : <span>{artifact.label} <small>(link not shown: not a plain web address)</small></span>}</li>)}</ul></>}
    {outcome.sources.length > 0 && <><h4>Sources</h4><ul>{outcome.sources.map((source, index) => <li key={index}>{safeHref(source.url) ? <a href={safeHref(source.url)!} target="_blank" rel="noopener noreferrer">{source.label}</a> : <span>{source.label}</span>}</li>)}</ul></>}
    <small>Deliverables are what the agent reported. Open them to check; reporting is not proof the work is right.</small>
    {file && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-label={`Shared file ${file.name}`}><h2>{file.name}</h2><pre className="assistant-pre">{file.content}</pre><button onClick={() => setFile(null)}>Close</button></section></div>}
  </div>;
}

export function OutcomeCard({ client, outcome, run, agents, busy, writable, mutate, onOpenRun, onDraft, compact = false }: { client: ControlClient; outcome: AssistantOutcome; run?: PersistentRun; agents: Agent[]; busy: boolean; writable: boolean; mutate: Mutate; onOpenRun(run: PersistentRun, title: string): void; onDraft(draft: WorkflowDraft): void; compact?: boolean }) {
  const [correcting, setCorrecting] = useState(false), [correction, setCorrection] = useState(''), [requestId, setRequestId] = useState(''), [saved, setSaved] = useState('');
  const name = (id: string) => agents.find(agent => agent.id === id)?.name || (id === PRIMARY_ASSISTANT_ID ? 'Your assistant' : id);
  const done = finished(outcome.state), verification = outcome.verification;
  // Older tasks are loaded on demand; a missing one reports an error instead of failing silently.
  const openRun = () => mutate(async () => onOpenRun(run || await client.request<PersistentRun>(`/v1/runs/${outcome.runId}`), outcome.title));
  const again = () => mutate(async () => onDraft(await client.request<WorkflowDraft>('/v1/workflow-drafts', { method: 'POST', body: JSON.stringify({ sourceRunId: outcome.runId }) })));
  const remember = () => mutate(async () => {
    const id = requestId || crypto.randomUUID(); setRequestId(id);
    // repair:false records the correction without starting another task; the draft then carries it.
    await client.request(`/v1/runs/${outcome.runId}/feedback`, { method: 'POST', body: JSON.stringify({ evidence: correction.trim(), requestId: id, repair: false }) });
    const draft = await client.request<WorkflowDraft>('/v1/workflow-drafts', { method: 'POST', body: JSON.stringify({ sourceRunId: outcome.runId }) });
    setCorrecting(false); setCorrection(''); setRequestId(''); setSaved('Correction saved with a workflow draft. It applies when you review and use that workflow; the agent’s memory was not changed.'); onDraft(draft);
  });
  return <article className="assistant-card assistant-outcome" aria-label={`Result: ${outcome.title}`}>
    <div className="assistant-decision-head"><strong>{outcome.title}</strong><span className={`assistant-chip ${verification.state === 'accepted' ? 'good' : verification.state === 'needs_changes' ? 'warn' : ''}`}>{done ? verificationLabel[verification.state] : stateLabel(outcome.state)}</span></div>
    <small>{stateLabel(outcome.state)} · {name(outcome.agentId)}{formatTime(outcome.updatedAt || run?.updated_at) ? ` · ${formatTime(outcome.updatedAt || run?.updated_at)}` : ''}</small>
    {outcome.summary && <p className={compact ? 'assistant-clamp' : ''}>{outcome.summary}</p>}
    {done && verification.state !== 'unreviewed' && <p className="assistant-evidence"><strong>{verificationLabel[verification.state]}{verification.checkedAt ? ` ${formatTime(verification.checkedAt)}` : ''}: </strong>{verification.evidence || 'No evidence recorded.'}</p>}
    {done && verification.state === 'unreviewed' && <p className="muted">Finished is not the same as checked. Open the task to review the result at its destination.</p>}
    {!compact && <ArtifactLinks client={client} outcome={outcome} mutate={mutate} />}
    {!compact && outcome.delegation.length > 0 && <div className="assistant-handoffs"><h4>Handoffs</h4><ol>{outcome.delegation.map(item => <li key={item.runId}><strong>{name(item.fromAgentId || outcome.agentId)} → {name(item.agentId)}</strong> <span className="assistant-chip">{stateLabel(item.state)}</span>{item.summary && <p>{item.summary}</p>}</li>)}</ol></div>}
    {!compact && outcome.actions.length > 0 && <div className="assistant-handoffs"><h4>Connected actions</h4><ul>{outcome.actions.map(action => <li key={action.id}>{action.summary} <span className="assistant-chip">{action.state.replaceAll('_', ' ')}</span>{action.evidence && <small>{action.evidence}</small>}</li>)}</ul></div>}
    {saved && <p role="status">{saved}</p>}
    <div className="assistant-actions">
      <button onClick={() => void openRun()}>Open task</button>
      {done && outcome.state === 'completed' && writable && <button disabled={busy} onClick={() => void again()}>Do this again</button>}
      {done && writable && !correcting && <button disabled={busy} onClick={() => { setSaved(''); setCorrecting(true); }}>Remember this correction</button>}
    </div>
    {correcting && <div className="assistant-correction">
      <label>What should be different next time?<textarea rows={3} maxLength={5000} value={correction} onChange={event => { setCorrection(event.target.value); setRequestId(''); }} placeholder="For example: list meetings before email, and skip newsletters." /></label>
      <small>This saves your correction with a reusable workflow draft for review. It does not start another task or edit the agent’s memory.</small>
      <button className="light-button" disabled={busy || !correction.trim()} onClick={() => void remember()}>Save correction to a workflow draft</button>
      <button onClick={() => setCorrecting(false)}>Cancel</button>
    </div>}
  </article>;
}
