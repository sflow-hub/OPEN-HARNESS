'use client';
import { useState } from 'react';
import type { ControlClient } from '../lib/control-client';
import type { ActionIntent, Connection } from '../lib/product';
import { previewAction } from '../lib/action-preview';

export type ReviewedAction = ActionIntent & { confirmation: string };
// Internal integrity hashes bind an edit to the state that was reviewed; people never edit them.
const HIDDEN = new Set(['beforeHash', 'draftHash']);
const label = (key: string) => key.replace(/([A-Z])/g, ' $1').replace(/^./, letter => letter.toUpperCase());
// Sending an email edits only which reviewed draft is sent; the server rereads that draft.
const editable = (action: Pick<ActionIntent, 'operation' | 'request'>) => Object.entries(action.request).filter(([key]) => !HIDDEN.has(key) && (action.operation !== 'gmail.send' || key === 'draftId'));
const stateLabel: Partial<Record<ActionIntent['state'], string>> = { awaiting_approval: 'Waiting for your approval', uncertain: 'Not confirmed — check the destination', approved: 'Approved, not yet run', dispatching: 'Running now' };

export function accountName(accounts: Connection[], id: string) { const account = accounts.find(item => item.id === id); return account ? account.account : 'An account you no longer have access to'; }

export function ActionPreviewBody({ action, accounts }: { action: Pick<ActionIntent, 'operation' | 'resource' | 'summary' | 'request' | 'connectionId'>; accounts: Connection[] }) {
  const preview = previewAction(action);
  return <div className="assistant-preview">
    <h3>{preview.title}</h3>
    <dl>
      <div><dt>Account</dt><dd>{accountName(accounts, action.connectionId)}</dd></div>
      {preview.fields.map(field => <div key={field.label}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}
    </dl>
    {preview.body !== undefined && <pre className="assistant-pre assistant-preview-body" aria-label="Exact content">{preview.body || '(empty)'}</pre>}
    <p className="assistant-consequence"><strong>What happens: </strong>{preview.consequence}</p>
  </div>;
}

export function ActionCard({ action, accounts, busy, writable, onReview }: { action: ActionIntent; accounts: Connection[]; busy: boolean; writable: boolean; onReview(): void }) {
  const preview = previewAction(action);
  return <article className="assistant-card assistant-decision" aria-label={preview.title}>
    <div className="assistant-decision-head"><strong>{preview.title}</strong><span className={`assistant-chip ${action.state === 'uncertain' ? 'warn' : ''}`}>{stateLabel[action.state] || action.state.replaceAll('_', ' ')}</span></div>
    <p>{action.summary}</p>
    <small>{accountName(accounts, action.connectionId)}{preview.fields[0] ? ` · ${preview.fields[0].label}: ${preview.fields[0].value.slice(0, 120)}` : ''}</small>
    <button disabled={busy || !writable} onClick={onReview}>{action.state === 'awaiting_approval' ? 'Review and decide' : 'Review action'}</button>
  </article>;
}

type Mutate = (work: () => Promise<unknown>) => Promise<void>;
export function ActionReviewDialog({ client, review, accounts, busy, error, mutate, onReplace, onClose }: { client: ControlClient; review: ReviewedAction; accounts: Connection[]; busy: boolean; error: string; mutate: Mutate; onReplace(next: ReviewedAction): void; onClose(): void }) {
  const [editing, setEditing] = useState<Record<string, string> | null>(null), [requestId, setRequestId] = useState('');
  const startEdit = () => { setRequestId(crypto.randomUUID()); setEditing(Object.fromEntries(editable(review).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value, null, 2)]))); };
  // A changed edit is a different request; an unchanged retry keeps its identity so it cannot create two replacements.
  const change = (key: string, value: string) => { if (!editing) return; setEditing({ ...editing, [key]: value }); setRequestId(crypto.randomUUID()); };
  const revise = () => mutate(async () => {
    if (!editing) return;
    const input: Record<string, unknown> = {};
    for (const [key, original] of editable(review)) {
      const raw = editing[key] ?? '';
      if (typeof original === 'string') { input[key] = raw; continue; }
      try { input[key] = JSON.parse(raw); } catch { throw new Error(`${label(key)} must keep its original format. Your edits are still here.`); }
    }
    // The replacement carries its own confirmation; the old approval is never carried forward.
    onReplace(await client.request<ReviewedAction>(`/v1/actions/${review.id}/revise`, { method: 'POST', body: JSON.stringify({ confirmation: review.confirmation, requestId, input }) })); setEditing(null);
  });
  return <div className="modal-backdrop">
    <section className="modal assistant-review" role="dialog" aria-modal="true" aria-label="Review connected action">
      <h2>Review connected action</h2>
      {error && <p role="alert" className="task-error">{error}</p>}
      <p>{review.summary}</p>
      {!editing ? <ActionPreviewBody action={review} accounts={accounts} /> : <fieldset disabled={busy} className="assistant-edit">
        <legend>Edit this action</legend>
        {review.operation === 'gmail.send' && <p className="muted">To change the message itself, edit the Gmail draft, then choose it here.</p>}
        <p className="muted">Saving prepares a replacement. You review and approve it again; nothing runs from this edit.</p>
        {editable(review).map(([key, value]) => <label key={key}>{label(key)}{typeof value === 'string' && value.length < 120 && !value.includes('\n') ? <input value={editing[key] ?? ''} onChange={event => change(key, event.target.value)} /> : <textarea rows={typeof value === 'string' ? 8 : 4} value={editing[key] ?? ''} onChange={event => change(key, event.target.value)} />}</label>)}
        <button className="light-button" onClick={() => void revise()}>Prepare edited action for review</button>
        <button onClick={() => setEditing(null)}>Cancel edit</button>
      </fieldset>}
      {!editing && <details><summary>Technical details</summary><pre className="assistant-pre">{JSON.stringify({ operation: review.operation, resource: review.resource, request: review.request }, null, 2)}</pre></details>}
      {!editing && <p>{review.state === 'uncertain' ? 'The previous run was not confirmed. Checking the destination will not repeat the write.' : `Current state: ${stateLabel[review.state] || review.state.replaceAll('_', ' ')}`}</p>}
      {!editing && review.state === 'awaiting_approval' && <>
        <button className="light-button" disabled={busy} onClick={() => void mutate(async () => { await client.request(`/v1/actions/${review.id}/decision`, { method: 'POST', body: JSON.stringify({ approved: true, confirmation: review.confirmation }) }); await client.request(`/v1/actions/${review.id}/execute`, { method: 'POST', body: '{}' }); onClose(); })}>Approve and execute this action</button>
        <button disabled={busy} onClick={startEdit}>Edit before approving</button>
        <button disabled={busy} onClick={() => void mutate(async () => { await client.request(`/v1/actions/${review.id}/decision`, { method: 'POST', body: JSON.stringify({ approved: false, confirmation: review.confirmation }) }); onClose(); })}>Deny</button>
      </>}
      {!editing && ['approved', 'uncertain'].includes(review.state) && <button disabled={busy} onClick={() => void mutate(async () => { await client.request(`/v1/actions/${review.id}/${review.state === 'uncertain' ? 'reconcile' : 'execute'}`, { method: 'POST', body: '{}' }); onClose(); })}>{review.state === 'uncertain' ? 'Check destination' : 'Execute approved action'}</button>}
      <button onClick={onClose}>Close</button>
    </section>
  </div>;
}
