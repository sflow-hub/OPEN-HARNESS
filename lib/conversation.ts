export type MemberRole = "owner" | "moderator" | "member" | "observer";
export type SenderKind = "user" | "agent" | "system";
// Columns arrive snake_case straight from the conversations tables.
export type ConversationMember = {
  conversation_id: string;
  participant_kind: "user" | "agent";
  participant_id: string;
  role: MemberRole;
  session_id: string | null;
  joined_at: string;
  removed_at: string | null;
};
export type ConversationMessage = {
  seq: number;
  id: string;
  conversation_id: string;
  sender_kind: SenderKind;
  sender_id: string;
  sender_name: string;
  body: string;
  idempotency_key: string | null;
  mentions: string[];
  in_reply_to: string | null;
  origin_run_id: string | null;
  round_id: string | null;
  source: string;
  created_at: string;
};
export type Conversation = {
  id: string;
  title: string;
  kind: "direct" | "group";
  turn_policy: string;
  auto_turns_enabled: boolean;
  source: string;
  created_at: string;
  updated_at: string;
  members: ConversationMember[];
  messages: ConversationMessage[];
};
export type GroupChatInput = { title: string; agentIds: string[] };
export type ScheduledRun = { agentId: string; runId: string };

const text = (value: unknown) => typeof value === "string" ? value : value == null ? "" : String(value);
const optionalText = (value: unknown) => typeof value === "string" && value ? value : null;
const record = (raw: unknown) => (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

// mentions_json is a JSON string column; a malformed one should cost the highlight, not the message.
function parseMentions(value: unknown) {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  try { const parsed = JSON.parse(text(value) || "[]"); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []; }
  catch { return []; }
}

export function normalizeMember(raw: unknown): ConversationMember {
  const row = record(raw);
  return {
    conversation_id: text(row.conversation_id), participant_kind: row.participant_kind === "user" ? "user" : "agent",
    participant_id: text(row.participant_id), role: (["owner", "moderator", "observer"].includes(text(row.role)) ? row.role : "member") as MemberRole,
    session_id: optionalText(row.session_id), joined_at: text(row.joined_at), removed_at: optionalText(row.removed_at),
  };
}

export function normalizeMessage(raw: unknown): ConversationMessage {
  const row = record(raw), seq = Number(row.seq);
  return {
    seq: Number.isSafeInteger(seq) ? seq : 0, id: text(row.id), conversation_id: text(row.conversation_id),
    sender_kind: row.sender_kind === "agent" || row.sender_kind === "system" ? row.sender_kind : "user",
    sender_id: text(row.sender_id), sender_name: text(row.sender_name), body: text(row.body),
    idempotency_key: optionalText(row.idempotency_key), mentions: parseMentions(row.mentions_json ?? row.mentions),
    in_reply_to: optionalText(row.in_reply_to), origin_run_id: optionalText(row.origin_run_id), round_id: optionalText(row.round_id),
    source: text(row.source), created_at: text(row.created_at),
  };
}

// SQLite hands back auto_turns_enabled as 0/1, and list rows carry no members or messages.
export function normalizeConversation(raw: unknown): Conversation {
  const row = record(raw);
  return {
    id: text(row.id), title: text(row.title), kind: row.kind === "group" ? "group" : "direct", turn_policy: text(row.turn_policy) || "manual",
    auto_turns_enabled: row.auto_turns_enabled === undefined ? true : Boolean(Number(row.auto_turns_enabled)),
    source: text(row.source), created_at: text(row.created_at), updated_at: text(row.updated_at),
    members: Array.isArray(row.members) ? row.members.map(normalizeMember).filter(member => !member.removed_at) : [],
    messages: Array.isArray(row.messages) ? row.messages.map(normalizeMessage) : [],
  };
}

export function normalizeScheduledRuns(value: unknown): ScheduledRun[] {
  return Array.isArray(value) ? value.map(record).filter(run => typeof run.agentId === "string" && typeof run.runId === "string").map(run => ({ agentId: run.agentId as string, runId: run.runId as string })) : [];
}

// Merge by seq so a poll racing the send response cannot show a message twice.
export function mergeMessages(current: ConversationMessage[], incoming: ConversationMessage[]) {
  if (!incoming.length) return current;
  const bySeq = new Map(current.map(message => [message.seq, message]));
  for (const message of incoming) bySeq.set(message.seq, message);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

// Matches the coordinator's own token rule, so a typed @name resolves the same way on both sides.
export function mentionedAgentIds(body: string, members: { id: string; name: string }[]) {
  const tokens = new Set(Array.from(body.matchAll(/@([a-zA-Z0-9_-]+)/g), match => match[1].toLowerCase()));
  return members.filter(member => tokens.has(member.id.toLowerCase()) || tokens.has(member.name.toLowerCase())).map(member => member.id);
}

export const mentionHandle = (member: { id: string; name: string }) => /^[a-zA-Z0-9_-]+$/.test(member.name) ? member.name : member.id;
