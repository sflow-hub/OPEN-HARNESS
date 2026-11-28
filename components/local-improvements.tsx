'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ControlClient } from '../lib/control-client';
import type { LocalImprovement, LocalImprovementList } from '../lib/local-improvements';
import './local-improvements.css';

type AgentChoice = { id: string; name: string };
type Props = { client: ControlClient; agents: AgentChoice[]; workspaceId: string };

export default function LocalImprovements({ client, agents, workspaceId }: Props) {
  const [open, setOpen] = useState(false);
  const launch = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!open || !dialog.current) return;
    const element = dialog.current, trigger = launch.current;
    element.showModal();
    return () => { element.close(); trigger?.focus(); };
  }, [open]);

  return <div className="local-improvements-entry">
    <button ref={launch} type="button" aria-haspopup="dialog" onClick={() => setOpen(true)}>Improve my Open Harness</button>
    {open && <dialog ref={dialog} className="local-improvements-dialog" aria-labelledby="local-improvements-title" onCancel={event => { event.preventDefault(); setOpen(false); }}>
      <div className="improvements-heading"><h2 id="local-improvements-title">Improve my Open Harness</h2><button type="button" onClick={() => setOpen(false)}>Close</button></div>
      <ImprovementRequests client={client} agents={agents} workspaceId={workspaceId} />
    </dialog>}
  </div>;
}

type Draft = { requestId: string; agentId: string; request: string };
const endpoint = '/v1/local-improvements';
const stages = {
  editing: 'Your agent is editing the dashboard',
  building: 'Building the preview',
  review: 'Ready for review',
  applied: 'Applied on this computer',
  undone: 'Change undone',
  failed: 'Couldn’t prepare this change',
};

function downloadPatch(item: LocalImprovement) {
  const chunks = item.changes.map(change => {
    const mode = change.kind === 'added' ? 'new file mode 100644\n' : change.kind === 'deleted' ? 'deleted file mode 100644\n' : '';
    return 'diff --git a/' + change.path + ' b/' + change.path + '\n' + mode + change.diff;
  });
  const url = URL.createObjectURL(new Blob(chunks, { type: 'text/x-patch;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = 'open-harness-' + item.id + '.patch';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ImprovementRequests({ client, agents, workspaceId }: Props) {
  const [list, setList] = useState<LocalImprovementList | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState<Draft>({ requestId: '', agentId: '', request: '' });
  const [busy, setBusy] = useState('');
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [preview, setPreview] = useState<{ id: string; html: string } | null>(null);
  const serial = useRef(0);
  const acting = useRef(false);
  const requestInput = useRef<HTMLTextAreaElement>(null);
  const draftStorage = 'open-harness.local-improvement-draft:' + workspaceId;
  const original = new URL(window.location.href);
  original.pathname = '/'; original.searchParams.set('original', '1'); original.hash = '';
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(draftStorage) || 'null');
      if (saved && typeof saved.agentId === 'string' && typeof saved.request === 'string' && typeof saved.requestId === 'string') {
        queueMicrotask(() => setDraft(saved));
      }
    } catch { /* A browser without session storage can still submit a request. */ }
  }, [draftStorage]);
  function editDraft(value: Draft) {
    setDraft(value);
    try { if (value.request) sessionStorage.setItem(draftStorage, JSON.stringify(value)); else sessionStorage.removeItem(draftStorage); } catch {}
  }
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const current = ++serial.current;
    try {
      const next = await client.request<LocalImprovementList>(endpoint);
      if (!signal?.aborted && current === serial.current) { setList(next); setLoadError(''); }
    } catch (cause) {
      if (!signal?.aborted && current === serial.current) setLoadError(cause instanceof Error ? cause.message : 'Could not load your requests.');
    }
  }, [client]);
  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) void refresh(controller.signal); });
    return () => controller.abort();
  }, [refresh]);
  const pending = list?.items.some(item => item.state === 'editing' || item.state === 'building');
  useEffect(() => {
    if (!pending) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (!acting.current) await refresh(controller.signal);
      if (!controller.signal.aborted) timer = setTimeout(poll, 3500);
    }
    timer = setTimeout(poll, 3500);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [pending, refresh]);
  const selection = list?.items.find(item => item.id === selectedId) || list?.items[0];
  const active = list?.items.find(item => item.id === list.activeId);
  const agentId = agents.some(agent => agent.id === draft.agentId) ? draft.agentId : agents[0]?.id || '';

  async function act(name: string, operation: () => Promise<void>) {
    if (acting.current) return;
    acting.current = true; serial.current++; setBusy(name); setActionError('');
    try { await operation(); } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Could not complete the request. Refresh to see its latest status.');
      await refresh();
    } finally { acting.current = false; setBusy(''); }
  }
  async function propose() {
    const outgoing = { agentId, request: draft.request.trim(), requestId: draft.requestId || crypto.randomUUID() };
    editDraft(outgoing);
    const item = await client.request<LocalImprovement>(endpoint, { method: 'POST', body: JSON.stringify(outgoing) });
    setList(current => ({ activeId: current?.activeId ?? null, items: [item, ...(current?.items || []).filter(other => other.id !== item.id)] }));
    setSelectedId(item.id); setPreview(null); editDraft({ agentId, request: '', requestId: '' });
    await refresh();
  }
  async function applyOrUndo(id: string, action: 'apply' | 'undo') {
    await client.request<LocalImprovement>(endpoint + '/' + encodeURIComponent(id) + '/' + action, { method: 'POST', body: '{}' });
    if (action === 'apply') {
      const applied = new URL(window.location.href);
      applied.searchParams.delete('original');
      window.history.replaceState(window.history.state, '', applied);
    }
    window.location.reload();
  }
  function select(id: string) { setSelectedId(id); setPreview(null); setActionError(''); }

  return <div className="improvements-body">
    <p>Ask an agent to improve how your local dashboard looks or works. It edits a separate copy of the dashboard source for you to review before applying it.</p>
    <form onSubmit={event => { event.preventDefault(); void act('submit', propose); }}>
      <label>Agent<select aria-label="Agent" value={agentId} disabled={Boolean(busy) || !agents.length} onChange={event => editDraft({ ...draft, agentId: event.target.value, requestId: '' })}>
        {!agents.length && <option value="">Create an agent first</option>}
        {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
      </select></label>
      <label>What would you like to change?<textarea ref={requestInput} value={draft.request} rows={3} maxLength={4000} required disabled={Boolean(busy)} placeholder="For example, change the Assistant heading to “How can I help?”" onChange={event => editDraft({ ...draft, agentId, request: event.target.value, requestId: '' })} /></label>
      <button className="light-button" disabled={Boolean(busy) || !agentId || !draft.request.trim() || !list} type="submit">{busy === 'submit' ? 'Sending request…' : 'Ask for a change'}</button>
    </form>
    {actionError && <p role="alert">{actionError}</p>}
    {loadError && <p role="alert">{loadError}</p>}
    {!list && !loadError && <p role="status">Loading requests…</p>}
    {(list || loadError) && <div className="improvements-history">
      <h3>Your requests</h3><button disabled={Boolean(busy)} type="button" onClick={() => void refresh()}>Refresh requests</button>
    </div>}
    {list?.activeId && list.activeId !== selection?.id && <aside aria-label="Applied improvement">
      <p>Currently applied to your dashboard{active ? ' · ' + active.request : ''}</p>
      <button type="button" disabled={Boolean(busy)} onClick={() => void act('undo', () => applyOrUndo(list.activeId!, 'undo'))}>Undo the active change</button>
      <a href={original.pathname + original.search}>Open the original dashboard</a>
    </aside>}
    {list && !list.items.length && <p>No requests yet.</p>}
    {list && list.items.length > 1 && <label>Choose a request<select aria-label="Choose a request" value={selection?.id || ''} disabled={Boolean(busy)} onChange={event => select(event.target.value)}>{list.items.map(item => <option key={item.id} value={item.id}>{item.request} · {stages[item.state]}</option>)}</select></label>}
    {selection && <article aria-label="Selected improvement">
      <h3>{selection.request}</h3>
      <p>{agents.find(agent => agent.id === selection.agentId)?.name || selection.agentId}</p>
      <p role="status"><strong>{stages[selection.state]}</strong></p>
      {(selection.state === 'editing' || selection.state === 'building') && <p>You can close this window and return to this request.</p>}
      {selection.error && <p role="alert">{selection.error}</p>}
      {selection.state === 'failed' && !draft.request && <button type="button" disabled={Boolean(busy)} onClick={() => {
        editDraft({ agentId: selection.agentId, request: selection.request, requestId: '' });
        requestInput.current?.focus();
      }}>Edit this request and try again</button>}
      {selection.check && <p><strong>Check result</strong> {selection.check}</p>}
      {selection.changes.length > 0 && <section aria-label="Changed files">
        <h4>Changed files</h4>
        <button type="button" onClick={() => downloadPatch(selection)}>Download source patch</button>
        <p>You can use this patch with Git to make the same change in a matching source checkout.</p>
        {selection.changes.map(change => <details key={change.path}>
          <summary>{change.path} · {change.kind}</summary>
          <pre tabIndex={0} aria-label={'Changes to ' + change.path}>{change.diff}</pre>
        </details>)}
      </section>}
      {['review','applied'].includes(selection.state) && <button type="button" disabled={Boolean(busy)} onClick={() => {
        if (preview?.id === selection.id) { setPreview(null); return; }
        void act('preview', async () => {
          const result = await client.request<{ html: string }>(endpoint + '/' + encodeURIComponent(selection.id) + '/preview');
          setPreview({ id: selection.id, html: result.html });
        });
      }}>{busy === 'preview' ? 'Opening preview…' : preview?.id === selection.id ? 'Close preview' : 'Preview dashboard'}</button>}
      {preview?.id === selection.id && <><p>The preview uses an empty, offline workspace.</p><iframe title="Preview of your dashboard change" sandbox="allow-scripts" srcDoc={preview.html} /></>}
      {selection.state === 'review' && <p>Applying runs the reviewed dashboard code with your usual access to this workspace.</p>}
      {selection.state === 'review' && <button className="light-button" disabled={Boolean(busy)} type="button" onClick={() => void act('apply', () => applyOrUndo(selection.id, 'apply'))}>{busy === 'apply' ? 'Applying…' : 'Apply on this computer'}</button>}
      {selection.id === list?.activeId && <button type="button" disabled={Boolean(busy)} onClick={() => void act('undo', () => applyOrUndo(selection.id, 'undo'))}>{busy === 'undo' ? 'Restoring…' : 'Undo this change'}</button>}
      {['review','applied'].includes(selection.state) && <p><a href={original.pathname + original.search}>Open the original dashboard</a> to return to the built-in version, including its undo control.</p>}
    </article>}
  </div>;
}
