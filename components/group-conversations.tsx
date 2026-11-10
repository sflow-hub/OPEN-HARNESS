"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ControlClient, PersistentRun } from '../lib/control-client';
import type { Agent } from '../lib/types';
import type { Team } from '../lib/team';
import styles from "./group-conversations.module.css";
import type { GroupChat, GroupMessage } from '../lib/group-chat';

export default function GroupConversations({ client, agents, teams, onOpenRun }: { client: ControlClient; agents: Agent[]; teams: Team[]; onOpenRun: (run: PersistentRun, title: string) => void }) {
  const [groups, setGroups] = useState<GroupChat[]>([]), [selected, setSelected] = useState(''), [messages, setMessages] = useState<GroupMessage[]>([]), [runs, setRuns] = useState<PersistentRun[]>([]);
  const [teamId, setTeamId] = useState(''), [title, setTitle] = useState(''), [members, setMembers] = useState<string[]>([]), [recipients, setRecipients] = useState<string[]>([]), [text, setText] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const retry = useRef<{ content: string; id: string } | null>(null);
  const team = teams.find(item => item.id === teamId), group = groups.find(item => item.id === selected);
  const name = (id: string) => agents.find(agent => agent.id === id)?.name || id;
  const refresh = useCallback(async () => {
    const value = await client.request<{ groups: GroupChat[] }>('/v1/groups'); setGroups(value.groups);
  }, [client]);
  useEffect(() => { let live = true; void client.request<{ groups: GroupChat[] }>('/v1/groups').then(value => { if (live) setGroups(value.groups); }).catch(error => { if (live) setError(error.message); }); return () => { live = false; }; }, [client]);
  useEffect(() => {
    if (!selected) return;
    let cancelled = false; const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try { const value = await client.request<{ messages: GroupMessage[]; runs: PersistentRun[] }>(`/v1/groups/${selected}`, { signal: controller.signal }); if (!cancelled) { setMessages(value.messages); setRuns(value.runs); } }
      catch (error) { if (!cancelled) setError(error instanceof Error ? error.message : 'Could not load this conversation.'); }
      finally { if (!cancelled) timer = setTimeout(load, document.hidden ? 10000 : 1500); }
    };
    void load(); return () => { cancelled = true; controller.abort(); clearTimeout(timer); };
  }, [client, selected]);
  async function create() {
    setBusy(true); setError('');
    try { const value = await client.request<GroupChat>('/v1/groups', { method: 'POST', body: JSON.stringify({ teamId, title, memberAgentIds: members }) }); await refresh(); setMessages([]); setRuns([]); setSelected(value.id); setRecipients(members.slice(0, 4)); setTitle(''); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not create this conversation.'); }
    finally { setBusy(false); }
  }
  async function send() {
    const content = JSON.stringify({ selected, text, recipients }); if (retry.current?.content !== content) retry.current = { content, id: crypto.randomUUID() };
    setBusy(true); setError('');
    try {
      const response = await client.request<{ runs: PersistentRun[] }>(`/v1/groups/${selected}/messages`, { method: 'POST', body: JSON.stringify({ text, recipientAgentIds: recipients, requestId: retry.current.id }) });
      setText(''); retry.current = null; setRuns(current => [...response.runs, ...current]);
      const value = await client.request<{ messages: GroupMessage[] }>(`/v1/groups/${selected}`); setMessages(value.messages);
    } catch (error) { setError(error instanceof Error ? error.message : 'Message could not be sent. Your draft is saved here.'); }
    finally { setBusy(false); }
  }
  const toggle = (id: string, value: string[], setter: (value: string[]) => void) => setter(value.includes(id) ? value.filter(item => item !== id) : [...value, id]);
  return <section className={`home-content ${styles.panel}`} aria-label="Group conversations">
    <h1>Group conversations</h1><p>Give teammates a shared conversation. Choose who should reply; every reply uses the normal agent queue and approvals.</p><p className="small">To let an agent post and hand off work itself, enable its Group conversations tool in Agent settings.</p>
    {error && <p role="alert">{error}</p>}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '20px 0' }}>
      <button className="subtle-button" disabled={busy} onClick={() => { setSelected(''); setMessages([]); setRuns([]); setText(''); }}>New group conversation</button>
      {groups.map(item => <button className="subtle-button" aria-pressed={selected === item.id} key={item.id} disabled={busy} onClick={() => { setMessages([]); setRuns([]); setText(''); setSelected(item.id); setRecipients(item.memberAgentIds.slice(0, 4)); }}>{item.title}</button>)}
    </div>
    {!selected ? <div className={styles.form}>
      {!teams.length && <p>Create a team in Teams before starting a group conversation.</p>}
      <label>Team<select aria-label="Team" value={teamId} onChange={event => { setTeamId(event.target.value); setMembers([]); }}><option value="">Choose a team</option>{teams.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Conversation name<input value={title} maxLength={100} onChange={event => setTitle(event.target.value)} /></label>
      <fieldset><legend>Participants</legend>{team?.memberAgentIds.map(id => <label key={id} style={{ display: 'inline-flex', gap: 6, margin: 8 }}><input type="checkbox" checked={members.includes(id)} onChange={() => toggle(id, members, setMembers)} />{name(id)}</label>)}</fieldset>
      <button className="light-button" disabled={busy || members.length < 2 || !title.trim()} onClick={() => void create()}>Create group conversation</button>
    </div> : <>
      <h2>{group?.title}</h2>
      <div aria-live="polite" style={{ display: 'grid', gap: 12, marginBottom: 20 }}>{messages.map(message => <article key={message.id} style={{ padding: 16, border: '1px solid var(--line, #ddd)', borderRadius: 12 }}><strong>{message.authorAgentId ? name(message.authorAgentId) : 'You'}</strong><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{message.text}</p></article>)}</div>
      {runs.filter(run => ['queued','running','waiting_approval','waiting_input'].includes(run.state)).map(run => <button className="subtle-button" key={run.id} onClick={() => onOpenRun(run, group?.title || 'Group conversation')}>{name(run.agent_id)} · {run.state.replaceAll('_', ' ')} · Open run</button>)}
      <fieldset><legend>Ask for a reply (up to four)</legend>{group?.memberAgentIds.map(id => <label key={id} style={{ display: 'inline-flex', gap: 6, margin: 8 }}><input type="checkbox" checked={recipients.includes(id)} disabled={!recipients.includes(id) && recipients.length >= 4} onChange={() => toggle(id, recipients, setRecipients)} />{name(id)}</label>)}</fieldset>
      <label>Message the group<textarea value={text} maxLength={12000} rows={4} onChange={event => setText(event.target.value)} /></label>
      <button className="light-button" disabled={busy || !text.trim()} onClick={() => void send()}>{busy ? 'Sending…' : recipients.length ? 'Send and request replies' : 'Post without starting work'}</button>
    </>}
  </section>;
}
