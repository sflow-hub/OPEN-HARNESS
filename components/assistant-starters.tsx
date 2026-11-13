'use client';
import { useEffect, useRef, useState } from 'react';
import type { StarterDefinition, StarterId } from '../lib/assistant-starters';
import type { ControlClient, PersistentRun } from '../lib/control-client';
import { PRIMARY_ASSISTANT_ID, type AppId, type Connection } from '../lib/product';

type Agent = { id: string; name: string };
type Draft = { connectionIds: string[]; inputs: Record<string, string>; requestId: string };
const appLabel: Record<AppId, string> = { gmail: 'Gmail', calendar: 'Google Calendar', drive: 'Google Drive', sheets: 'Google Sheets', github: 'GitHub' };
const output: Record<StarterId, string> = {
  'prepare-day': 'A short brief of what is next, conflicts and decisions, with reply drafts for you to review. Nothing is sent.',
  'material-brief': 'A finished draft built from your material, saved where you can open it, with sources kept.',
  'research-draft': 'A sourced draft with open questions. Your chosen teammates research and write; the assistant checks the result.',
};
// Drafts hold account IDs and a retry identity, so they belong to one workspace and one person.
const storageKey = (scope: string, id: string) => `open-harness.starter-draft:${scope}:${id}`;
const empty = (): Draft => ({ connectionIds: [], inputs: {}, requestId: '' });
function loadDraft(scope: string, id: string): Draft { try { const value = JSON.parse(localStorage.getItem(storageKey(scope, id)) || 'null'); if (value && Array.isArray(value.connectionIds) && typeof value.inputs === 'object') return { connectionIds: value.connectionIds, inputs: value.inputs, requestId: typeof value.requestId === 'string' ? value.requestId : '' }; } catch {} return empty(); }
const persist = (scope: string, id: string, draft: Draft) => { try { localStorage.setItem(storageKey(scope, id), JSON.stringify(draft)); } catch {} };

export default function AssistantStarters({ client, scope, accounts, writable, ready, autoOpen, onOpenRun, onConnections }: { client: ControlClient; scope: string; accounts: Connection[]; writable: boolean; ready: boolean; autoOpen?: StarterId; onOpenRun(run: PersistentRun, title: string): void; onConnections(): void }) {
  const [starters, setStarters] = useState<StarterDefinition[]>([]), [teammates, setTeammates] = useState<Agent[]>([]), [open, setOpen] = useState<StarterId | null>(autoOpen || null), [draft, setDraft] = useState<Draft>(() => autoOpen ? loadDraft(scope, autoOpen) : empty()), version = useRef(0);
  const [reviewed, setReviewed] = useState<{ body: string; prompt: string } | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [loadError, setLoadError] = useState('');
  useEffect(() => { if (!ready) return; let live = true; client.request<{ starters: StarterDefinition[]; agents?: Agent[] }>('/v1/assistant/starters').then(value => { if (live) { setStarters(value.starters); setTeammates(value.agents || []); } }).catch(cause => { if (live) setLoadError(cause instanceof Error ? cause.message : 'Guided starters are unavailable.'); }); return () => { live = false; }; }, [client, ready]);
  const starter = starters.find(item => item.id === open);
  const choose = (id: StarterId) => { version.current++; setOpen(id); setDraft(loadDraft(scope, id)); setReviewed(null); setError(''); };
  // Any change to inputs is a different request; an unchanged retry keeps its identity so it cannot start twice.
  const update = (next: Omit<Draft, 'requestId'>) => { version.current++; const value = { ...next, requestId: '' }; setDraft(value); setReviewed(null); if (open) persist(scope, open, value); };
  const usable = (account: Connection) => account.state === 'connected' && account.sharedAgentIds.includes(PRIMARY_ASSISTANT_ID);
  const missing = starter ? starter.apps.filter(app => starter.id === 'prepare-day' ? !draft.connectionIds.some(id => accounts.find(account => account.id === id)?.app === app) : false) : [];
  const requiredFilled = starter ? starter.fields.every(field => !field.required || draft.inputs[field.id]?.trim()) : false;
  const body = () => { const requestId = draft.requestId || crypto.randomUUID(), value = { ...draft, requestId }; setDraft(value); if (open) persist(scope, open, value); return JSON.stringify({ starterId: open, connectionIds: value.connectionIds, inputs: Object.fromEntries(Object.entries(value.inputs).filter(([, text]) => text.trim())), requestId }); };
  const run = async (work: () => Promise<void>) => { if (busy) return; setBusy(true); setError(''); try { await work(); } catch (cause) { setError(cause instanceof Error ? `${cause.message} Your choices are still here.` : 'Could not continue. Your choices are still here.'); } finally { setBusy(false); } };
  // A preview answers one exact request; a reply for inputs that have since changed is discarded.
  const review = () => run(async () => { const sent = body(), at = version.current, value = await client.request<{ prompt: string }>('/v1/assistant/starters/preview', { method: 'POST', body: sent }); if (at === version.current) setReviewed({ body: sent, prompt: value.prompt }); });
  // Start sends exactly the request that was reviewed, never the current form state.
  const start = () => run(async () => { if (!reviewed) return; const result = await client.request<PersistentRun>('/v1/assistant/starters', { method: 'POST', body: reviewed.body }); if (open) { try { localStorage.removeItem(storageKey(scope, open)); } catch {} } const title = starter?.title || 'Guided task'; setOpen(null); setReviewed(null); setDraft(empty()); onOpenRun(result, title); });
  if (loadError) return <p className="muted">{loadError}</p>;
  if (!starters.length) return null;
  return <section className="assistant-starters" aria-label="Guided starters">
    <h2>Start with a guided task</h2>
    <div className="assistant-starter-grid">{starters.map(item => <article key={item.id} className={`assistant-card assistant-starter ${open === item.id ? 'selected' : ''}`}>
      <h3>{item.title}</h3><p>{item.description}</p>
      <small>{item.apps.length ? `Uses ${item.apps.map(app => appLabel[app]).join(' and ')}` : 'No connected account required'}</small>
      <button disabled={!writable} aria-expanded={open === item.id} onClick={() => open === item.id ? setOpen(null) : choose(item.id)}>{open === item.id ? 'Close' : `Set up ${item.title.toLowerCase()}`}</button>
    </article>)}</div>
    {starter && <form ref={form => { if (form && autoOpen === starter.id && !form.dataset.shown) { form.dataset.shown = '1'; form.scrollIntoView({ block: 'nearest' }); } }} className="assistant-card assistant-starter-form" aria-label={starter.title} onSubmit={event => { event.preventDefault(); void (reviewed ? start() : review()); }}>
      <h3>{starter.title}</h3>
      <p><strong>You get: </strong>{output[starter.id]}</p>
      {error && <p role="alert" className="task-error">{error}</p>}
      <fieldset className="assistant-plain" disabled={busy || !writable}>
      {starter.apps.length > 0 && <fieldset><legend>Accounts to use</legend>
        {starter.apps.map(app => { const list = accounts.filter(account => account.app === app); return <div key={app} className="assistant-starter-app">
          <strong>{appLabel[app]}{starter.id !== 'prepare-day' ? ' (optional)' : ''}</strong>
          {list.length === 0 ? <p className="muted">No {appLabel[app]} account is connected. <button type="button" onClick={onConnections}>Open Connections</button></p> : list.map(account => <label key={account.id} className="connection-choice"><input type="checkbox" disabled={!usable(account)} checked={draft.connectionIds.includes(account.id)} onChange={event => update({ connectionIds: event.target.checked ? [...draft.connectionIds, account.id] : draft.connectionIds.filter(id => id !== account.id), inputs: draft.inputs })} />{account.account}{account.state !== 'connected' ? ' — reconnect in Connections' : !account.sharedAgentIds.includes(PRIMARY_ASSISTANT_ID) ? ' — share with your assistant in Connections' : ''}</label>)}
          {list.some(account => !usable(account)) && <button type="button" onClick={onConnections}>Open Connections</button>}
        </div>; })}
        <small>Choosing an account here does not grant new access. Writes still wait for your approval.</small>
      </fieldset>}
      {starter.fields.map(field => ['researcherId', 'writerId'].includes(field.id) ? <label key={field.id}>{field.label} (optional)<select value={draft.inputs[field.id] || ''} onChange={event => update({ connectionIds: draft.connectionIds, inputs: { ...draft.inputs, [field.id]: event.target.value } })}><option value="">No teammate — the assistant does it</option>{teammates.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
        : <label key={field.id}>{field.label}{field.required ? '' : ' (optional)'}{field.id === 'material' || field.id === 'topic' ? <textarea rows={4} value={draft.inputs[field.id] || ''} placeholder={field.placeholder} maxLength={8000} onChange={event => update({ connectionIds: draft.connectionIds, inputs: { ...draft.inputs, [field.id]: event.target.value } })} /> : <input value={draft.inputs[field.id] || ''} placeholder={field.placeholder} maxLength={1000} onChange={event => update({ connectionIds: draft.connectionIds, inputs: { ...draft.inputs, [field.id]: event.target.value } })} />}</label>)}
      </fieldset>
      <div><strong>Checks before it reports back</strong><ul>{starter.checks.map(check => <li key={check}>{check}</li>)}</ul></div>
      {missing.length > 0 && <p className="muted">Select {missing.map(app => appLabel[app]).join(' and ')} to continue.</p>}
      {reviewed && <div className="assistant-goal-preview"><h4>The goal your assistant will receive</h4><pre className="assistant-pre" aria-label="Generated goal">{reviewed.prompt}</pre><small>Change any choice above to revise it.</small></div>}
      <button type="submit" className="light-button" disabled={busy || !writable || !ready || !requiredFilled || missing.length > 0}>{reviewed ? 'Start this task' : 'Review the goal'}</button>
    </form>}
  </section>;
}
