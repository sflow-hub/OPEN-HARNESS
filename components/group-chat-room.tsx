"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowUp, LoaderCircle, Play, Square, Users } from "lucide-react";
import type { ControlClient } from "../lib/control-client";
import { mentionHandle, mentionedAgentIds, mergeMessages, type Conversation, type ConversationMessage } from "../lib/conversation";
import type { Agent } from "../lib/types";
import GroupChatMembers from "./group-chat-members";

const POLL_MS = 2000;
const newKey = () => typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export default function GroupChatRoom({ client, chatId, agents, onBack, onNotice }: { client: ControlClient; chatId: string; agents: Agent[]; onBack: () => void; onNotice: (text: string) => void }) {
  const [chat, setChat] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [loadError, setLoadError] = useState("");
  const [pollError, setPollError] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [haltSupported, setHaltSupported] = useState(true);
  const [haltBusy, setHaltBusy] = useState(false);
  const lastSeq = useRef(0), sendingRef = useRef(false), keyRef = useRef(""), bottomRef = useRef<HTMLDivElement>(null);

  // Only the snapshot and ordered polls may move the cursor: a send response can carry a seq past agent messages no poll has fetched yet.
  const receive = useCallback((incoming: ConversationMessage[], advance: boolean) => {
    if (!incoming.length) return;
    if (advance) lastSeq.current = Math.max(lastSeq.current, ...incoming.map(message => message.seq));
    setMessages(current => mergeMessages(current, incoming));
  }, []);

  const load = useCallback(() => client.getConversation(chatId).then(
    loaded => { setLoadError(""); setChat(loaded); lastSeq.current = 0; setMessages([]); receive(loaded.messages, true); },
    error => setLoadError(error instanceof Error ? error.message : "Could not open this group chat."),
  ), [client, chatId, receive]);
  useEffect(() => { void load(); }, [load]);

  const loaded = Boolean(chat);
  useEffect(() => {
    if (!loaded) return;
    let inFlight = false;
    // Agents reply on their own schedule; a hidden tab skips ticks so it does not poll for nobody.
    const timer = setInterval(() => {
      if (inFlight || document.hidden) return;
      inFlight = true;
      client.listConversationMessages(chatId, lastSeq.current)
        .then(incoming => { receive(incoming, true); setPollError(""); })
        .catch(error => setPollError(error instanceof Error ? error.message : "Lost contact with the local service."))
        .finally(() => { inFlight = false; });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [loaded, client, chatId, receive]);

  useEffect(() => { bottomRef.current?.scrollIntoView?.({ block: "end" }); }, [messages.length]);

  const agentFor = (id: string) => agents.find(agent => agent.id === id);
  const agentMembers = (chat?.members || []).filter(member => member.participant_kind === "agent").map(member => ({ id: member.participant_id, name: agentFor(member.participant_id)?.name || member.participant_id }));
  const mentionQuery = /(?:^|\s)@([a-zA-Z0-9_-]*)$/.exec(draft)?.[1];
  const suggestions = mentionQuery === undefined ? [] : agentMembers.filter(member => mentionHandle(member).toLowerCase().startsWith(mentionQuery.toLowerCase()));

  const send = async () => {
    const body = draft.trim();
    // A ref, not state: a double click lands before React re-renders the disabled button.
    if (!body || sendingRef.current) return;
    sendingRef.current = true; setSending(true);
    keyRef.current ||= newKey();
    try {
      const { message, scheduledRuns } = await client.postConversationMessage(chatId, { body, mentions: mentionedAgentIds(body, agentMembers), idempotencyKey: keyRef.current });
      receive([message], false); setDraft(""); keyRef.current = "";
      if (scheduledRuns.length) onNotice(`${scheduledRuns.map(run => agentFor(run.agentId)?.name || run.agentId).join(", ")} will reply shortly.`);
    } catch (error) { onNotice(error instanceof Error ? error.message : "Could not send that message. Your draft is still here."); }
    finally { sendingRef.current = false; setSending(false); }
  };

  const toggleHalt = async () => {
    if (!chat || haltBusy) return;
    const halting = chat.auto_turns_enabled;
    setHaltBusy(true);
    try {
      const result = halting ? await client.haltConversation(chatId) : await client.resumeConversation(chatId);
      if (result === null) { setHaltSupported(false); onNotice("This version of the local service cannot pause group chats yet."); return; }
      setChat(current => current && { ...current, auto_turns_enabled: !halting });
      onNotice(halting ? "Agents in this chat were stopped. Resume to let them reply again." : "Agents can reply in this chat again.");
    } catch (error) { onNotice(error instanceof Error ? error.message : halting ? "Could not stop this chat." : "Could not resume this chat."); }
    finally { setHaltBusy(false); }
  };

  if (loadError) return <section className="files-page">
    <button className="subtle-button" onClick={onBack}><ArrowLeft size={14} /> All group chats</button>
    <div className="task-error" role="alert">{loadError}</div>
    <button className="light-button" onClick={() => void load()}>Try again</button>
  </section>;
  if (!chat) return <section className="files-page"><p className="muted small"><LoaderCircle className="spin" size={12} /> Opening group chat…</p></section>;

  return <div className="chat-layout no-inspector">
    <section className="chat-main">
      <div className="chat-toolbar">
        <button aria-label="All group chats" title="All group chats" onClick={onBack}><ArrowLeft size={17} /></button>
        <div><strong>{chat.title || "Untitled group chat"}</strong><small>{agentMembers.map(member => member.name).join(", ")}</small></div>
        <div className="toolbar-actions">
          {haltSupported && <button className="subtle-button" disabled={haltBusy} onClick={() => void toggleHalt()}>{chat.auto_turns_enabled ? <><Square size={13} /> Stop</> : <><Play size={13} /> Resume</>}</button>}
          <button aria-label="Members" title="Members" onClick={() => setMembersOpen(true)}><Users size={17} /></button>
        </div>
      </div>
      <div className="transcript" aria-live="polite">
        {!messages.length ? <div className="chat-welcome"><div className="eyebrow">GROUP CHAT</div><h2>No messages yet.</h2><p>Say hello, or @mention an agent to ask it directly.</p></div>
          : messages.map(message => {
            const agent = message.sender_kind === "agent" ? agentFor(message.sender_id) : undefined;
            return <article className={`message ${message.sender_kind === "user" ? "user" : "assistant"}`} data-sender-kind={message.sender_kind} key={message.seq}>
              <div className="message-heading">
                {message.sender_kind === "user" ? <div className="user-avatar">Y</div> : message.sender_kind === "agent" ? <div className={`avatar tone-${(agent?.tone ?? 0) % 6}`}>{(message.sender_name || "?")[0]}</div> : null}
                <strong>{message.sender_kind === "user" ? "You" : message.sender_kind === "system" ? "System" : message.sender_name || message.sender_id}</strong>
                <small className="muted">{message.created_at && new Date(message.created_at).toLocaleTimeString()}</small>
              </div>
              <div className={`markdown ${message.sender_kind === "system" ? "muted" : ""}`} style={{ whiteSpace: "pre-wrap" }}>{message.body}</div>
            </article>;
          })}
        <div ref={bottomRef} />
      </div>
      <div className="composer-wrap">
        {pollError && <div className="task-error" role="alert">{pollError} New replies will appear once it reconnects.</div>}
        <form className="composer" onSubmit={event => { event.preventDefault(); void send(); }}>
          {/* Read-only rather than disabled keeps focus; the draft is cleared on success, so nothing may be typed into it meanwhile. */}
          <textarea value={draft} readOnly={sending} aria-busy={sending} onChange={event => { setDraft(event.target.value); keyRef.current = ""; }} placeholder="Message the group… use @name to ask an agent" aria-label="Message the group" maxLength={20000} rows={3}
            onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
          {suggestions.length > 0 && !sending && <div className="collaborator-picker" role="listbox" aria-label="Mention an agent">
            {suggestions.map(member => <button type="button" role="option" aria-selected="false" key={member.id} onClick={() => setDraft(current => current.replace(/@[a-zA-Z0-9_-]*$/, `@${mentionHandle(member)} `))}>@{member.name}</button>)}
          </div>}
          <div className="composer-bottom">
            <span className="muted small">{chat.auto_turns_enabled ? "" : "Agents are stopped in this chat."}</span>
            <button type="submit" className="send-button" aria-label="Send message" disabled={sending || !draft.trim()}>{sending ? <LoaderCircle className="spin" size={15} /> : <ArrowUp size={15} />}</button>
          </div>
        </form>
        <div className="composer-note">Enter to send · Shift + Enter for a new line · Agents you @mention are asked to reply</div>
      </div>
    </section>
    {membersOpen && <GroupChatMembers client={client} chatId={chatId} members={chat.members} agents={agents} onClose={() => setMembersOpen(false)} onChanged={members => setChat(current => current && { ...current, members })} onNotice={onNotice} />}
  </div>;
}
