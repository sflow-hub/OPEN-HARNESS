import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Store, SCHEMA_VERSION } from '../runtime/db';
import { Profiles } from '../runtime/profiles';
import { Conversations, ConversationError } from '../runtime/conversations';

function fixture() {
  const store = new Store(':memory:'), profiles = new Profiles(store.db);
  for (const id of ['atlas', 'scout', 'audit', 'solo', 'a', 'b', 'c', 'd', 'e']) profiles.create({ id, name: id });
  const conversations = new Conversations(store.db, profiles, { sharesActiveTeam: (a, b) => a === b });
  return { store, conversations };
}
const agents = [{ kind: 'agent' as const, id: 'atlas' }, { kind: 'agent' as const, id: 'scout' }];

test('additive conversation migration preserves legacy data and backfills on every boot', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'oh-conversation-db-')), 'state.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE conversations(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,title TEXT NOT NULL,legacy_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    INSERT INTO conversations VALUES('legacy','atlas','Old title','{"messages":[]}','old','old');
    CREATE TABLE runs(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,conversation_id TEXT NOT NULL,prompt TEXT NOT NULL,state TEXT NOT NULL,session_id TEXT,parent_run_id TEXT,depth INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,result TEXT,error TEXT);
    INSERT INTO runs VALUES('run','atlas','missing','hello','completed','untrusted',NULL,0,'old','old',NULL,NULL);
    INSERT INTO runs VALUES('later','scout','missing','later','completed',NULL,NULL,0,'z','z',NULL,NULL);`);
  old.close();
  for (let boot = 0; boot < 2; boot++) {
    const store = new Store(path);
    const legacy = store.db.prepare("SELECT * FROM conversations WHERE id='legacy'").get()!;
    assert.equal(legacy.title, 'Old title'); assert.equal(legacy.legacy_json, '{"messages":[]}');
    assert.equal(store.db.prepare("SELECT source FROM conversations WHERE id='missing'").get()!.source, 'backfill');
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM conversation_members WHERE conversation_id='missing'").get()!.n, 2);
    assert.equal(store.db.prepare("SELECT session_id FROM conversation_members WHERE conversation_id='missing' AND participant_kind='agent'").get()!.session_id, null);
    assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, SCHEMA_VERSION);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM runs').get()!.n, 2);
    assert.equal(store.db.prepare("SELECT agent_id FROM conversations WHERE id='missing'").get()!.agent_id, 'atlas');
    assert.equal(store.db.prepare("SELECT participant_id FROM conversation_members WHERE conversation_id='legacy' AND participant_kind='agent'").get()!.participant_id, 'atlas');
    assert.ok(store.db.prepare('PRAGMA table_info(message_deliveries)').all().some(row => row.name === 'delegation_root'));
    store.db.close();
  }
});

test('group storage, sender-scoped dedupe, mentions, fan-out, paging, and removal', () => {
  const { store, conversations: c } = fixture();
  try {
    const group = c.createConversation({ kind: 'group', title: 'Work', members: [...agents, { kind: 'agent', id: 'audit', role: 'observer' }] });
    assert.equal(group.members.length, 4); assert.equal(c.listConversations('group').length, 1); assert.equal(c.listConversations('direct').length, 0);
    const message = c.postMessage({ conversationId: group.id, sender: { kind: 'user', id: 'user' }, body: '@atlas @outsider', mentions: ['scout', 'outsider'], idempotencyKey: 'retry' });
    assert.deepEqual(JSON.parse(message.mentions_json), ['atlas', 'scout']); assert.match(message.id, /^[0-9a-f-]{36}$/);
    const retry = c.postMessage({ conversationId: group.id, sender: { kind: 'user', id: 'user' }, body: 'changed', idempotencyKey: 'retry' });
    assert.equal(retry.id, message.id);
    assert.deepEqual(store.db.prepare('SELECT recipient_id FROM message_deliveries WHERE message_id=? ORDER BY recipient_id').all(message.id).map(row => row.recipient_id), ['atlas', 'scout']);
    const reply = c.postMessage({ conversationId: group.id, sender: agents[0], body: 'Answer', idempotencyKey: 'retry', inReplyTo: message.id });
    assert.notEqual(reply.id, message.id);
    assert.deepEqual(store.db.prepare('SELECT recipient_id FROM message_deliveries WHERE message_id=? ORDER BY recipient_id').all(reply.id).map(row => row.recipient_id), ['scout', 'user']);
    assert.deepEqual(c.listMessages(group.id, 0, 1).map(m => m.id), [message.id]); assert.deepEqual(c.listMessages(group.id, message.seq).map(m => m.id), [reply.id]);
    assert.equal(c.getConversation(group.id).messages.length, 2);
    c.addMember(group.id, { kind: 'agent', id: 'solo' });
    assert.throws(() => c.addMember(group.id, { kind: 'agent', id: 'a' }, { kind: 'agent', id: 'atlas' }), (error: unknown) => error instanceof ConversationError && error.status === 403);
    c.addMember(group.id, { kind: 'agent', id: 'atlas', role: 'moderator' });
    assert.throws(() => c.addMember(group.id, { kind: 'agent', id: 'a' }, { kind: 'agent', id: 'atlas' }), /active team/);
    c.setSessionId(group.id, 'scout', 'session-scout'); assert.equal(c.getSessionId(group.id, 'atlas'), null);
    const removed = c.removeMember(group.id, 'scout'); assert.ok(removed.removed_at); assert.equal(c.getSessionId(group.id, 'scout'), null);
    assert.ok(store.db.prepare("SELECT state FROM message_deliveries WHERE recipient_id='scout'").all().every(row => row.state === 'dropped'));
    c.addMember(group.id, agents[1]); assert.equal(c.getSessionId(group.id, 'scout'), null);
    assert.throws(() => c.postMessage({ conversationId: group.id, sender: { kind: 'agent', id: 'a' }, body: 'No' }), /current member/);
  } finally { store.db.close(); }
});

test('message and delivery fan-out roll back together on a failed write', () => {
  const { store, conversations: c } = fixture();
  try {
    const group = c.createConversation({ kind: 'group', members: agents });
    store.db.exec("CREATE TRIGGER reject_delivery BEFORE INSERT ON message_deliveries BEGIN SELECT RAISE(ABORT,'delivery failed'); END");
    assert.throws(() => c.postMessage({ conversationId: group.id, sender: { kind: 'user', id: 'user' }, body: 'Atomic' }), /delivery failed/);
    assert.equal(c.listMessages(group.id).length, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM message_deliveries').get()!.n, 0);
  } finally { store.db.close(); }
});

test('validates conversations, member limits, messages and cursors', () => {
  const { store, conversations: c } = fixture();
  try {
    assert.throws(() => c.createConversation({ kind: 'group', members: [] }), /one to eight/);
    assert.throws(() => c.createConversation({ kind: 'direct', members: agents }), /one agent/);
    assert.throws(() => c.createConversation({ kind: 'group', members: agents, title: 'x'.repeat(121) }), /Title/);
    assert.throws(() => c.createConversation({ kind: 'group', members: [{ kind: 'agent', id: 'missing' }] }), /not found/);
    assert.throws(() => c.createConversation({ kind: 'group', members: ['atlas', 'scout', 'audit', 'solo', 'a', 'b', 'c', 'd', 'e'].map(id => ({ kind: 'agent', id })) }), /eight/);
    const group = c.createConversation({ kind: 'group', members: agents });
    assert.throws(() => c.addMember(group.id, { kind: 'agent', id: 'missing' }), /not found/);
    assert.throws(() => c.getConversation('missing'), (error: unknown) => error instanceof ConversationError && error.status === 404);
    assert.throws(() => c.postMessage({ conversationId: group.id, sender: { kind: 'user', id: 'user' }, body: 'x'.repeat(20001) }), /20000/);
    assert.throws(() => c.listMessages(group.id, -1), /cursor/);
    c.removeMember(group.id, 'scout'); assert.throws(() => c.removeMember(group.id, 'atlas'), /at least one/);
  } finally { store.db.close(); }
});

test('agent adds require the moderator and target to share a team; internal conversations stay hidden', () => {
  const { store } = fixture();
  const c = new Conversations(store.db, { get: id => ({ name: id }) }, { sharesActiveTeam: (a, b) => a === 'scout' && b === 'solo' });
  try {
    const group = c.createConversation({ kind: 'group', members: [{ kind: 'agent', id: 'atlas', role: 'moderator' }, agents[1]] });
    assert.throws(() => c.addMember(group.id, { kind: 'agent', id: 'solo' }, { kind: 'agent', id: 'atlas' }), /active team/);
    c.setSessionId(group.id, 'atlas', 'stale'); c.setSessionId(group.id, 'atlas', null);
    assert.equal(c.getSessionId(group.id, 'atlas'), null);
    store.db.prepare("UPDATE conversations SET source='internal' WHERE id=?").run(group.id);
    assert.deepEqual(c.listConversations(), []);
    assert.equal(c.getConversation(group.id).id, group.id);
  } finally { store.db.close(); }
});

test('conversation HTTP contract and explicit per-member session resume in mock mode', async () => {
  const state = mkdtempSync(join(tmpdir(), 'oh-conversation-http-')), port = 14331, base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'runtime/service.ts'], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, OPEN_HARNESS_MOCK: '1', OPEN_HARNESS_STATE_DIR: state, OPEN_HARNESS_PORT: String(port) }, stdio: 'pipe' });
  let output = ''; child.stderr!.on('data', chunk => { output += String(chunk); }); child.stdout!.on('data', chunk => { output += String(chunk); });
  let token = '';
  try {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) { await new Promise(resolve => setTimeout(resolve, 50)); throw new Error(`Service exited (${child.exitCode}): ${output}`); }
      try { const response = await fetch(`${base}/v1/bootstrap`); if (response.ok) { token = (await response.json() as { token: string }).token; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(token, output);
    async function request(path: string, method = 'GET', input?: unknown, status = 200) {
      const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: input === undefined ? undefined : JSON.stringify(input) });
      const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value as Record<string, unknown>;
    }
    assert.equal((await fetch(`${base}/v1/conversations`)).status, 401);
    await request('/v1/agents/sync', 'POST', { agents: agents.map(a => ({ id: a.id, name: a.id, role: 'Generalist', instructions: '', config: { model: 'mock' } })) });
    const group = await request('/v1/conversations', 'POST', { kind: 'group', title: 'HTTP', members: agents }, 201);
    const id = String(group.id);
    assert.equal(((await request('/v1/conversations?kind=group')).conversations as unknown[]).length, 1);
    const message = await request(`/v1/conversations/${id}/messages`, 'POST', { body: '@atlas hello', idempotencyKey: 'one' }, 201);
    assert.equal((await request(`/v1/conversations/${id}/messages`, 'POST', { body: 'retry', idempotencyKey: 'one' }, 201)).id, message.id);
    assert.deepEqual((await request('/v1/runs')).runs, []);
    assert.deepEqual((await request(`/v1/conversations/${id}/messages?after=${message.seq}`)).messages, []);
    assert.equal(((await request(`/v1/conversations/${id}`)).members as unknown[]).length, 3);
    await request(`/v1/conversations/${id}/members/scout`, 'DELETE');
    await request(`/v1/conversations/${id}/members`, 'POST', agents[1], 201);
    await request('/v1/conversations', 'POST', { kind: 'group', members: [] }, 400);
    await request('/v1/conversations/missing', 'GET', undefined, 404);
    await request(`/v1/conversations/${id}/members`, 'POST', { kind: 'agent', id: 'missing' }, 404);
    await request(`/v1/conversations/${id}/messages`, 'POST', { body: 'x'.repeat(20001) }, 400);
    await request(`/v1/conversations/${id}/messages?after=bad`, 'GET', undefined, 400);
    async function run(agentId: string, conversationId?: string) {
      const created = await request('/v1/runs', 'POST', { agentId, conversationId, prompt: 'Hello' }, 202);
      const until = Date.now() + 30000;
      while (Date.now() < until) {
        const current = await request(`/v1/runs/${created.id}`);
        if (current.state === 'completed') return { created, current };
        assert.ok(!['failed', 'cancelled', 'interrupted'].includes(String(current.state)), JSON.stringify(current));
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('Run timed out.');
    }
    const first = await run('atlas', id); assert.equal(first.created.session_id, null); assert.ok(first.current.session_id);
    const detail = await request(`/v1/conversations/${id}`);
    assert.equal((detail.members as Array<{ participant_id: string; session_id: string }>).find(m => m.participant_id === 'atlas')!.session_id, first.current.session_id);
    assert.equal((await run('atlas', id)).created.session_id, first.current.session_id);
    assert.equal((await run('scout', id)).created.session_id, null);
    const fresh = await run('atlas'); assert.equal(fresh.created.session_id, null);
    const direct = await request(`/v1/conversations/${fresh.current.conversation_id}`); assert.equal(direct.kind, 'direct'); assert.equal((direct.members as unknown[]).length, 2);
  } finally { child.kill('SIGTERM'); }
});
