'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ControlRequestError, type ControlClient } from '../lib/control-client';

type Context = { memory: string; user: string; revision?: string; skills?: string[] };
type Field = 'memory' | 'user';
type Agent = { id: string; name: string };
const titles: Record<Field, { heading: string; help: string }> = {
  memory: { heading: 'Working notes', help: 'What this agent noted about its work, tools and environment.' },
  user: { heading: 'About you', help: 'What this agent noted about your preferences and how you like work done.' },
};
// Hermes separates saved notes with a section sign on its own line.
const DELIMITER = '\n§\n';
const entries = (text: string) => text.split(/\n?§\n?/).map(item => item.trim()).filter(Boolean);

export default function AssistantMemory({ client, agents, initialAgentId, writable, owner }: { client: ControlClient; agents: Agent[]; initialAgentId: string; writable: boolean; owner: boolean }) {
  // Follow the default agent until the person picks one, so a late inbox load cannot leave another agent selected.
  const [chosen, setAgentId] = useState<string | null>(null), agentId = chosen || initialAgentId;
  // Notes are kept with the agent they were read for; anything for another agent is never shown or saved.
  const [loaded, setLoaded] = useState<{ agentId: string; context: Context } | null>(null), [draft, setDraft] = useState<Record<Field, string>>({ memory: '', user: '' }), [editing, setEditing] = useState<Field | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const sequence = useRef(0), saved = loaded?.agentId === agentId ? loaded.context : null;
  const agent = agents.find(item => item.id === agentId), name = agent?.name || 'This agent';
  const load = useCallback(async (keepDraft = false) => {
    const request = ++sequence.current, target = agentId; setError('');
    if (!keepDraft) setEditing(null);
    try { const value = await client.request<Context>(`/v1/agents/${encodeURIComponent(target)}/context`); if (request !== sequence.current) return; setLoaded({ agentId: target, context: value }); if (!keepDraft) setDraft({ memory: value.memory || '', user: value.user || '' }); }
    catch (cause) { if (request === sequence.current) setError(cause instanceof Error ? cause.message : 'Could not load these notes.'); }
  }, [client, agentId]);
  useEffect(() => { if (!owner) return; queueMicrotask(() => { setNotice(''); void load(); }); }, [load, owner]);
  const canEdit = owner && writable && Boolean(saved?.revision);
  const save = async (field: Field, value: string, done: string) => {
    if (!saved?.revision || busy) return;
    const target = agentId, revision = saved.revision;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await client.request<{ revision?: string }>(`/v1/agents/${encodeURIComponent(target)}/context`, { method: 'PUT', body: JSON.stringify({ [field]: value, revision }) });
      setLoaded(current => current?.agentId === target ? { agentId: target, context: { ...current.context, [field]: value, revision: result.revision || revision } } : current); setDraft(current => ({ ...current, [field]: value })); setEditing(null); setNotice(done);
    } catch (cause) {
      // Keep the person's text; a conflict means someone or the agent saved first.
      setDraft(current => ({ ...current, [field]: value })); setEditing(field);
      setError(cause instanceof ControlRequestError && cause.status === 409 ? `${cause.message} Reload to see the saved notes; copy your edits first if you need them.` : cause instanceof Error ? cause.message : 'Could not save. Your edits are still here.');
    } finally { setBusy(false); }
  };
  const forget = (field: Field, index: number) => { const list = entries(saved?.[field] || ''); list.splice(index, 1); void save(field, list.join(DELIMITER), `Forgot one ${titles[field].heading.toLowerCase()} entry for ${name}.`); };
  if (!owner) return <section className="assistant-card assistant-memory" aria-label="What this assistant knows"><h2>What your agents know</h2><p className="muted">Only the workspace owner can view or change agents’ notes.</p></section>;
  return <section className="assistant-card assistant-memory" aria-label="What this assistant knows">
    <h2>What {name} knows</h2>
    <p>These notes belong to <strong>{name}</strong> only. Other agents keep their own notes; nothing here is shared automatically.</p>
    <label>Agent<select value={agentId} disabled={busy} onChange={event => { setAgentId(event.target.value); setEditing(null); setNotice(''); }}>{agents.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    {error && <p role="alert" className="task-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!saved ? (!error && <p role="status">Loading notes for {name}…</p>) : <>
      {!saved.revision && <p className="muted">This agent’s computer runs an older runner that cannot protect edits from overwriting newer notes. Update its runner to edit or forget notes here.</p>}
      {(['user', 'memory'] as Field[]).map(field => {
        const list = entries(saved[field] || '');
        return <div key={field} className="assistant-memory-field">
          <h3>{titles[field].heading}</h3><small>{titles[field].help}</small>
          {editing === field ? <>
            <label>{titles[field].heading} for {name}<textarea rows={10} maxLength={50000} disabled={busy} value={draft[field]} onChange={event => setDraft({ ...draft, [field]: event.target.value })} /></label>
            <button className="light-button" disabled={busy} onClick={() => void save(field, draft[field], `Saved ${titles[field].heading.toLowerCase()} for ${name}.`)}>Save notes</button>
            <button disabled={busy} onClick={() => void load(false)}>Discard and reload</button>
          </> : <>
            {list.length ? <ul>{list.map((item, index) => <li key={index}><span>{item}</span>{canEdit && <button disabled={busy} aria-label={`Forget: ${item.slice(0, 60)}`} onClick={() => forget(field, index)}>Forget</button>}</li>)}</ul> : <p className="muted">No {titles[field].heading.toLowerCase()} yet.</p>}
            {canEdit && <button disabled={busy} onClick={() => { setDraft({ ...draft, [field]: saved[field] || '' }); setEditing(field); setNotice(''); }}>Edit {titles[field].heading.toLowerCase()}</button>}
            {canEdit && list.length > 0 && <button disabled={busy} onClick={() => void save(field, '', `Cleared ${titles[field].heading.toLowerCase()} for ${name}.`)}>Forget all {titles[field].heading.toLowerCase()}</button>}
          </>}
        </div>;
      })}
      {saved.skills && saved.skills.length > 0 && <p><small>Skills: {saved.skills.join(', ')}</small></p>}
    </>}
  </section>;
}
