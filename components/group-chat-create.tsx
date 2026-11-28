"use client";

import { useEffect, useRef, useState } from "react";
import { Check, LoaderCircle, X } from "lucide-react";
import type { ControlClient } from "../lib/control-client";
import type { Conversation } from "../lib/conversation";
import type { Agent } from "../lib/types";
import { useDialogFocus } from "./group-chat-dialog";

const MAX_AGENTS = 8;

export default function GroupChatCreate({ client, onClose, onCreated }: { client: ControlClient; onClose: () => void; onCreated: (chat: Conversation) => void }) {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef, () => !busy && onClose());
  useEffect(() => {
    let live = true;
    client.listAgents().then(list => { if (live) setAgents(list); }).catch(cause => { if (live) { setAgents([]); setError(cause instanceof Error ? cause.message : "Could not load your agents."); } });
    return () => { live = false; };
  }, [client]);
  const toggle = (id: string) => setSelected(current => current.includes(id) ? current.filter(item => item !== id) : current.length >= MAX_AGENTS ? current : [...current, id]);
  const create = async () => {
    if (busy || !title.trim() || !selected.length) return;
    setBusy(true); setError("");
    try { onCreated(await client.createGroupChat({ title: title.trim(), agentIds: selected })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create this group chat."); }
    finally { setBusy(false); }
  };

  return <div className="modal-backdrop" onClick={() => !busy && onClose()}>
    <section ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="group-chat-create-title" onClick={event => event.stopPropagation()}>
      <div className="modal-heading"><div><div className="eyebrow">GROUP CHATS</div><h2 id="group-chat-create-title">New group chat</h2></div><button aria-label="Close new group chat" onClick={onClose}><X size={19} /></button></div>
      {error && <div className="task-error" role="alert">{error}</div>}
      <label>Title<input autoFocus maxLength={120} value={title} onChange={event => setTitle(event.target.value)} placeholder="Launch planning" /></label>
      <fieldset>
        <h3>Agents <small className="muted">({selected.length}/{MAX_AGENTS})</small></h3>
        {!agents ? <p className="muted small"><LoaderCircle className="spin" size={12} /> Loading agents…</p>
          : !agents.length ? <p className="muted small">No agents are available yet. Create an agent first.</p>
          : agents.map(agent => <label className="settings-feature-toggle" key={agent.id}>
            <input type="checkbox" checked={selected.includes(agent.id)} disabled={!selected.includes(agent.id) && selected.length >= MAX_AGENTS} onChange={() => toggle(agent.id)} />
            <span><strong>{agent.name}</strong>{agent.role}</span>
          </label>)}
      </fieldset>
      <div className="modal-footer">
        <button className="subtle-button" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="light-button" disabled={busy || !title.trim() || !selected.length} onClick={() => void create()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} Create group chat</button>
      </div>
    </section>
  </div>;
}
