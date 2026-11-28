"use client";

import { useRef, useState } from "react";
import { LoaderCircle, UserMinus, UserPlus, X } from "lucide-react";
import type { ControlClient } from "../lib/control-client";
import type { ConversationMember } from "../lib/conversation";
import type { Agent } from "../lib/types";
import { useDialogFocus } from "./group-chat-dialog";

const MAX_AGENTS = 8;

export default function GroupChatMembers({ client, chatId, members, agents, onClose, onChanged, onNotice }: { client: ControlClient; chatId: string; members: ConversationMember[]; agents: Agent[]; onClose: () => void; onChanged: (members: ConversationMember[]) => void; onNotice: (text: string) => void }) {
  const agentMembers = members.filter(member => member.participant_kind === "agent");
  const available = agents.filter(agent => !agentMembers.some(member => member.participant_id === agent.id));
  const [adding, setAdding] = useState(available[0]?.id || "");
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef, () => !busy && onClose());
  const nameFor = (id: string) => agents.find(agent => agent.id === id)?.name || id;
  const pick = available.some(agent => agent.id === adding) ? adding : available[0]?.id || "";
  const add = async () => {
    if (!pick || busy) return;
    setBusy(true);
    try { const member = await client.addConversationMember(chatId, pick); onChanged([...members.filter(item => !(item.participant_kind === "agent" && item.participant_id === pick)), member]); onNotice(`${nameFor(pick)} joined the chat.`); }
    catch (error) { onNotice(error instanceof Error ? error.message : `Could not add ${nameFor(pick)}.`); }
    finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    if (busy) return;
    setBusy(true);
    try { await client.removeConversationMember(chatId, id); onChanged(members.filter(item => !(item.participant_kind === "agent" && item.participant_id === id))); onNotice(`${nameFor(id)} left the chat.`); }
    catch (error) { onNotice(error instanceof Error ? error.message : `Could not remove ${nameFor(id)}.`); }
    finally { setBusy(false); }
  };

  return <div className="modal-backdrop" onClick={() => !busy && onClose()}>
    <section ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="group-chat-members-title" onClick={event => event.stopPropagation()}>
      <div className="modal-heading"><div><div className="eyebrow">GROUP CHAT</div><h2 id="group-chat-members-title">Members</h2></div><button aria-label="Close members" onClick={onClose}><X size={19} /></button></div>
      <div className="file-table">
        {agentMembers.map(member => <div className="file-table-row" key={member.participant_id}>
          <div className="file-name"><span>{nameFor(member.participant_id)}<small>{member.role}</small></span></div>
          {/* The coordinator refuses to remove the last agent, so say why before it has to. */}
          <button className="subtle-button" aria-label={`Remove ${nameFor(member.participant_id)}`} title={agentMembers.length === 1 ? "A group chat keeps at least one agent." : undefined} disabled={busy || agentMembers.length === 1} onClick={() => void remove(member.participant_id)}><UserMinus size={14} /> Remove</button>
        </div>)}
      </div>
      {agentMembers.length >= MAX_AGENTS ? <p className="muted small">This chat has the maximum of {MAX_AGENTS} agents.</p>
        : !available.length ? <p className="muted small">Every agent is already in this chat.</p>
        : <label>Add an agent<select aria-label="Agent to add" value={pick} onChange={event => setAdding(event.target.value)}>{available.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>}
      <div className="modal-footer">
        <button className="subtle-button" disabled={busy} onClick={onClose}>Done</button>
        {agentMembers.length < MAX_AGENTS && available.length > 0 && <button className="light-button" disabled={busy || !pick} onClick={() => void add()}>{busy ? <LoaderCircle className="spin" size={14} /> : <UserPlus size={14} />} Add member</button>}
      </div>
    </section>
  </div>;
}
