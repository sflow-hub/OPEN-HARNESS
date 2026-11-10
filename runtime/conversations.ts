import type { DatabaseSync } from 'node:sqlite';

export class ConversationError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
export type MemberInput = { kind: 'user' | 'agent'; id: string; role?: 'owner' | 'moderator' | 'member' | 'observer' };
export type MemberRow = { conversation_id: string; participant_kind: 'user' | 'agent'; participant_id: string; role: string; session_id: string | null; joined_at: string; removed_at: string | null };
export type ConversationRow = { id: string; agent_id: string; title: string; legacy_json: string | null; kind: 'direct' | 'group'; turn_policy: string; auto_turns_enabled: number; limits_json: string; source: string; created_at: string; updated_at: string };
export type MessageRow = { seq: number; id: string; conversation_id: string; sender_kind: string; sender_id: string; sender_name: string; body: string; idempotency_key: string | null; mentions_json: string; in_reply_to: string | null; origin_run_id: string | null; round_id: string | null; source: string; created_at: string };

export class Conversations {
  constructor(readonly db: DatabaseSync, readonly profiles: { get(id: string): { name: string } | null | undefined }, readonly teams?: { sharesActiveTeam(a: string, b: string): boolean }) {}
  private transaction<T>(fn: () => T): T { this.db.exec('SAVEPOINT conversation_write'); try { const result = fn(); this.db.exec('RELEASE conversation_write'); return result; } catch (error) { this.db.exec('ROLLBACK TO conversation_write; RELEASE conversation_write'); throw error; } }
  private row(id: string) { const row = this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as ConversationRow | undefined; if (!row) throw new ConversationError('Conversation not found.', 404); return row; }
  private members(id: string) { return this.db.prepare('SELECT * FROM conversation_members WHERE conversation_id=? AND removed_at IS NULL ORDER BY joined_at,rowid').all(id) as MemberRow[]; }
  private validateMember(member: MemberInput) {
    if (!member || !['agent', 'user'].includes(member.kind) || typeof member.id !== 'string' || !member.id) throw new ConversationError('Invalid member.');
    if (member.role && !['owner', 'moderator', 'member', 'observer'].includes(member.role)) throw new ConversationError('Invalid member role.');
    if (member.kind === 'user' && (member.id !== 'user' || (member.role && member.role !== 'owner'))) throw new ConversationError('The local user must be the owner.');
    if (member.kind === 'agent' && member.role === 'owner') throw new ConversationError('Only the user can own a conversation.');
    if (member.kind === 'agent' && !this.profiles.get(member.id)) throw new ConversationError('Agent profile not found.', 404);
  }
  private writeMember(id: string, member: MemberInput) {
    this.db.prepare(`INSERT INTO conversation_members(conversation_id,participant_kind,participant_id,role,joined_at) VALUES(?,?,?,?,?)
      ON CONFLICT(conversation_id,participant_kind,participant_id) DO UPDATE SET role=excluded.role,joined_at=CASE WHEN removed_at IS NOT NULL THEN excluded.joined_at ELSE joined_at END,removed_at=NULL,session_id=CASE WHEN removed_at IS NOT NULL THEN NULL ELSE session_id END`)
      .run(id, member.kind, member.id, member.kind === 'user' ? 'owner' : member.role || 'member', new Date().toISOString());
  }
  createConversation(input: { kind: 'direct' | 'group'; title?: string; members: MemberInput[]; turnPolicy?: string }) {
    if (!input || !['direct', 'group'].includes(input.kind) || !Array.isArray(input.members)) throw new ConversationError('Choose a conversation kind and members.');
    if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 120)) throw new ConversationError('Title must be at most 120 characters.');
    const policy = input.turnPolicy ?? 'manual'; if (!['manual', 'round_robin', 'moderated'].includes(policy)) throw new ConversationError('Invalid turn policy.');
    input.members.forEach(member => this.validateMember(member));
    const members = [...new Map(input.members.map(member => [`${member.kind}:${member.id}`, member])).values()];
    const agents = members.filter(member => member.kind === 'agent');
    if (!agents.length || agents.length > 8 || (input.kind === 'direct' && agents.length !== 1)) throw new ConversationError('Direct conversations need one agent; groups need one to eight agents.');
    if (!members.some(member => member.kind === 'user')) members.push({ kind: 'user', id: 'user', role: 'owner' });
    return this.transaction(() => {
      const id = crypto.randomUUID(), stamp = new Date().toISOString();
      this.db.prepare('INSERT INTO conversations(id,agent_id,title,kind,turn_policy,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id, agents[0].id, input.title || '', input.kind, policy, stamp, stamp);
      members.forEach(member => this.writeMember(id, member)); return this.getConversation(id);
    });
  }
  listConversations(kind?: string) {
    if (kind !== undefined && !['direct', 'group'].includes(kind)) throw new ConversationError('Invalid conversation kind.');
    return this.db.prepare(`SELECT c.* FROM conversations c WHERE c.source <> 'internal' AND EXISTS(SELECT 1 FROM conversation_members m WHERE m.conversation_id=c.id AND m.participant_kind='user' AND m.participant_id='user' AND m.removed_at IS NULL) ${kind ? 'AND c.kind=?' : ''} ORDER BY c.updated_at DESC,c.id`).all(...(kind ? [kind] : [])) as ConversationRow[];
  }
  getConversation(id: string) {
    const row = this.row(id);
    const messages = this.db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY seq DESC LIMIT 100').all(id) as MessageRow[];
    return { ...row, members: this.members(id), messages: messages.reverse() };
  }
  addMember(id: string, member: MemberInput, adder: { kind: 'user' | 'agent'; id: string } = { kind: 'user', id: 'user' }) {
    return this.transaction(() => {
      const conversation = this.row(id); this.validateMember(member); const members = this.members(id);
      if (adder.kind === 'agent') {
        if (!members.some(m => m.participant_kind === 'agent' && m.participant_id === adder.id && m.role === 'moderator')) throw new ConversationError('A moderator membership is required.', 403);
        if (member.kind === 'agent' && !this.teams?.sharesActiveTeam(adder.id, member.id)) throw new ConversationError('Agents must share an active team.', 403);
      }
      const exists = members.some(m => m.participant_kind === member.kind && m.participant_id === member.id);
      if (member.kind === 'agent' && !exists && (conversation.kind === 'direct' || members.filter(m => m.participant_kind === 'agent').length >= 8)) throw new ConversationError('The conversation has reached its agent member limit.');
      this.writeMember(id, member); this.touch(id); return this.members(id).find(m => m.participant_kind === member.kind && m.participant_id === member.id)!;
    });
  }
  removeMember(id: string, agentId: string) {
    return this.transaction(() => {
      this.row(id); const members = this.members(id);
      if (!members.some(m => m.participant_kind === 'agent' && m.participant_id === agentId)) throw new ConversationError('Member not found.', 404);
      if (members.filter(m => m.participant_kind === 'agent').length === 1) throw new ConversationError('Keep at least one agent in the conversation.');
      const stamp = new Date().toISOString();
      this.db.prepare("UPDATE conversation_members SET removed_at=? WHERE conversation_id=? AND participant_kind='agent' AND participant_id=?").run(stamp, id, agentId);
      this.db.prepare("UPDATE message_deliveries SET state='dropped',updated_at=? WHERE recipient_kind='agent' AND recipient_id=? AND state='pending' AND message_id IN (SELECT id FROM messages WHERE conversation_id=?)").run(stamp, agentId, id);
      this.touch(id); return this.db.prepare("SELECT * FROM conversation_members WHERE conversation_id=? AND participant_kind='agent' AND participant_id=?").get(id, agentId) as MemberRow;
    });
  }
  private touch(id: string) { this.db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(new Date().toISOString(), id); }
  postMessage(input: { conversationId: string; sender: { kind: 'user' | 'agent'; id: string }; body: string; mentions?: string[]; idempotencyKey?: string; inReplyTo?: string; originRunId?: string }) { return this.postMessageWithStatus(input).message; }
  postMessageWithStatus(input: Parameters<Conversations['postMessage']>[0]) {
    if (!input || typeof input.body !== 'string' || !input.body.trim() || input.body.length > 20000) throw new ConversationError('Message must contain text and be at most 20000 characters.');
    if (input.mentions !== undefined && (!Array.isArray(input.mentions) || input.mentions.some(m => typeof m !== 'string'))) throw new ConversationError('Mentions must be member IDs.');
    for (const value of [input.idempotencyKey, input.inReplyTo, input.originRunId]) if (value !== undefined && typeof value !== 'string') throw new ConversationError('Message references must be strings.');
    return this.transaction(() => {
      this.row(input.conversationId); const members = this.members(input.conversationId);
      const sender = members.find(m => m.participant_kind === input.sender?.kind && m.participant_id === input.sender.id);
      if (!sender) throw new ConversationError('Sender is not a current member.', 403);
      if (input.idempotencyKey !== undefined) {
        const existing = this.db.prepare('SELECT * FROM messages WHERE conversation_id=? AND sender_kind=? AND sender_id=? AND idempotency_key=?').get(input.conversationId, input.sender.kind, input.sender.id, input.idempotencyKey) as MessageRow | undefined;
        if (existing) return { message: existing, created: false };
      }
      if (input.inReplyTo && !this.db.prepare('SELECT 1 FROM messages WHERE id=? AND conversation_id=?').get(input.inReplyTo, input.conversationId)) throw new ConversationError('Reply message not found.', 404);
      const tokens = [...(input.mentions || []), ...Array.from(input.body.matchAll(/@([a-zA-Z0-9_-]+)/g), match => match[1])].map(token => token.replace(/^@/, '').toLowerCase());
      const mentions = members.filter(m => tokens.includes(m.participant_id.toLowerCase()) || (m.participant_kind === 'agent' && tokens.includes(this.profiles.get(m.participant_id)?.name.toLowerCase() || ''))).map(m => m.participant_id);
      const id = crypto.randomUUID(), stamp = new Date().toISOString();
      this.db.prepare('INSERT INTO messages(id,conversation_id,sender_kind,sender_id,sender_name,body,idempotency_key,mentions_json,in_reply_to,origin_run_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, input.conversationId, input.sender.kind, input.sender.id, input.sender.kind === 'user' ? 'User' : this.profiles.get(input.sender.id)?.name || input.sender.id, input.body, input.idempotencyKey ?? null, JSON.stringify(mentions), input.inReplyTo ?? null, input.originRunId ?? null, stamp);
      for (const member of members) if (member.role !== 'observer' && !(member.participant_kind === input.sender.kind && member.participant_id === input.sender.id)) this.db.prepare('INSERT INTO message_deliveries(message_id,recipient_kind,recipient_id,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, member.participant_kind, member.participant_id, stamp, stamp);
      this.touch(input.conversationId); return { message: this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) as MessageRow, created: true };
    });
  }
  postSystem(conversation: string, body: string, key: string) {
    this.db.prepare("INSERT OR IGNORE INTO messages(id,conversation_id,sender_kind,sender_id,sender_name,body,idempotency_key,created_at) VALUES(?,?,'system','system','System',?,?,?)").run(crypto.randomUUID(), conversation, body, key, new Date().toISOString());
  }
  listMessages(id: string, afterSeq = 0, limit = 100) {
    this.row(id); if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new ConversationError('Invalid message cursor or limit.');
    return this.db.prepare('SELECT * FROM messages WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT ?').all(id, afterSeq, limit) as MessageRow[];
  }
  getSessionId(id: string, agentId: string) { return (this.db.prepare("SELECT session_id FROM conversation_members WHERE conversation_id=? AND participant_kind='agent' AND participant_id=? AND removed_at IS NULL").get(id, agentId) as { session_id: string | null } | undefined)?.session_id ?? null; }
  setSessionId(id: string, agentId: string, sessionId: string | null) { this.db.prepare("UPDATE conversation_members SET session_id=? WHERE conversation_id=? AND participant_kind='agent' AND participant_id=? AND removed_at IS NULL").run(sessionId, id, agentId); }
}
