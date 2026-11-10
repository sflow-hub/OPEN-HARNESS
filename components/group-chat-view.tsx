"use client";

import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, MessagesSquare, Plus } from "lucide-react";
import type { ControlClient } from "../lib/control-client";
import type { Conversation } from "../lib/conversation";
import type { Agent } from "../lib/types";
import GroupChatCreate from "./group-chat-create";
import GroupChatRoom from "./group-chat-room";

export default function GroupChatView({ client, agents, onNotice }: { client: ControlClient; agents: Agent[]; onNotice: (text: string) => void }) {
  const [chats, setChats] = useState<Conversation[] | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const refresh = useCallback(() => client.listGroupChats().then(
    list => { setError(""); setChats(list); },
    cause => setError(cause instanceof Error ? cause.message : "Could not load your group chats."),
  ), [client]);
  useEffect(() => { if (!openId) void refresh(); }, [openId, refresh]);

  if (openId) return <GroupChatRoom client={client} chatId={openId} agents={agents} onBack={() => setOpenId(null)} onNotice={onNotice} />;
  return <section className="files-page">
    <div className="eyebrow">AGENTS TOGETHER</div>
    <div className="files-title">
      <div><h1>Group chats</h1><p className="intro">Talk with several agents at once. Each agent keeps its own session in the chat.</p></div>
      <button className="light-button" onClick={() => setCreating(true)}><Plus size={14} /> New group chat</button>
    </div>
    {error && <div className="task-error" role="alert">{error} <button className="subtle-button" onClick={() => void refresh()}>Try again</button></div>}
    {!chats ? !error && <p className="muted small"><LoaderCircle className="spin" size={12} /> Loading group chats…</p>
      : !chats.length ? <div className="files-empty"><MessagesSquare size={40} /><h2>No group chats yet.</h2><p>Start one with two or more of your agents.</p></div>
      : <div className="file-table">
        {chats.map(chat => <div className="file-table-row" key={chat.id}>
          <div className="file-name"><MessagesSquare size={20} /><span>{chat.title || "Untitled group chat"}<small>{chat.updated_at ? `Updated ${new Date(chat.updated_at).toLocaleString()}` : ""}{chat.auto_turns_enabled ? "" : " · Agents stopped"}</small></span></div>
          <button className="subtle-button" aria-label={`Open ${chat.title || "Untitled group chat"}`} onClick={() => setOpenId(chat.id)}>Open</button>
        </div>)}
      </div>}
    {creating && <GroupChatCreate client={client} onClose={() => setCreating(false)} onCreated={chat => { setCreating(false); setChats(current => [chat, ...(current || []).filter(item => item.id !== chat.id)]); onNotice(`Created ${chat.title || "the group chat"}.`); }} />}
  </section>;
}
