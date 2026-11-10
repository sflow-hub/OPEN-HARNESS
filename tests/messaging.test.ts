import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, type RunRow } from '../runtime/db';
import { Profiles } from '../runtime/profiles';
import { Conversations } from '../runtime/conversations';
import { Messaging } from '../runtime/messaging';

function fixture() {
  const store = new Store(':memory:'), profiles = new Profiles(store.db);
  for (const id of ['a', 'b', 'outsider']) profiles.create({ id, name: id });
  const c = new Conversations(store.db, profiles, { sharesActiveTeam: (a, b) => a !== 'outsider' && b !== 'outsider' });
  const group = c.createConversation({ kind: 'group', members: [{ kind: 'agent', id: 'a' }, { kind: 'agent', id: 'b' }] });
  const now = new Date('2026-11-09T12:00:00Z');
  function run(agentId: string, conversationId = group.id, depth = 0, parent: string | null = null) {
    const r: RunRow = { id: crypto.randomUUID(), agent_id: agentId, conversation_id: conversationId, depth, parent_run_id: parent, prompt: 'Work', state: 'queued', session_id: null, result: null, error: null, created_at: now.toISOString(), updated_at: now.toISOString() }; store.createRun(r); return r;
  }
  const m = new Messaging(store, c, input => run(input.agentId, input.conversationId, input.depth), () => now);
  store.runListener = r => m.onRun(r);
  const post = (body = 'Hello') => c.postMessage({ conversationId: group.id, sender: { kind: 'user', id: 'user' }, body });
  return { store, c, group, m, run, post };
}

test('delivery selection is durable, only terminal failures reset, commit is idempotent', () => {
  const { store, m, group, post } = fixture(); post();
  const [{ runId }] = m.schedule(group.id, ['a']);
  const state = () => store.db.prepare("SELECT state FROM message_deliveries WHERE recipient_id='a'").get()!.state;
  assert.equal(state(), 'delivered');
  assert.equal(m.inbox('a', group.id).deliveries[0].state, 'delivered');
  assert.equal(m.selectInbox('a', group.id, 'other-run').messages.length, 0);
  for (const s of ['queued', 'running', 'waiting_input', 'waiting_approval'] as const) { store.setRun(runId, { state: s }); m.resetFailedTurn(runId); assert.equal(state(), 'delivered'); }
  for (const s of ['failed', 'cancelled', 'interrupted'] as const) { store.setRun(runId, { state: s }); assert.equal(state(), 'pending'); m.selectInbox('a', group.id, runId); }
  store.setRun(runId, { state: 'completed', result: 'Done' }); m.commitTurn(runId, 'Again');
  assert.equal(state(), 'consumed'); assert.equal(store.db.prepare("SELECT COUNT(*) n FROM messages WHERE idempotency_key=?").get(`turn-result:${runId}`)!.n, 1);
});

test('every terminal delegation result is exactly once including raw restart updates', () => {
  for (const state of ['completed', 'failed', 'cancelled', 'interrupted'] as const) {
    const { store, m, run, c } = fixture(); const parent = run('a'), child = run('b', parent.conversation_id, 1, parent.id);
    store.db.prepare('UPDATE runs SET state=?,result=?,error=? WHERE id=?').run(state, 'Answer', 'Problem', child.id);
    m.bootSweep(); m.bootSweep(); store.setRun(child.id, { state: 'interrupted' });
    const messages = store.db.prepare('SELECT * FROM messages WHERE idempotency_key=?').all(`delegation-result:${child.id}`);
    assert.equal(messages.length, 1); assert.equal(c.listConversations().length, 1);
    const followup = store.listRuns().find(r => m.isTurn(r.id))!;
    assert.equal(followup.agent_id, 'a'); assert.equal(followup.depth, 2); assert.equal(m.lineage(followup.id).anchor, child.id);
    assert.equal(store.db.prepare('SELECT delegation_root FROM message_deliveries WHERE message_id=? AND recipient_id=?').get(messages[0].id, 'a')!.delegation_root, parent.id);
  }
});

test('depth bound leaves result pending without waking the child', () => {
  const { store, m, run } = fixture(); const parent = run('a', undefined, 1), child = run('b', parent.conversation_id, 2, parent.id);
  store.setRun(child.id, { state: 'failed', error: 'Failure' });
  assert.equal(store.listRuns().filter(r => m.isTurn(r.id)).length, 0);
  assert.equal(m.inbox('a').messages.length, 1);
});

test('mentions, busy skips, halt/resume, hourly cap, scoped inbox and transcript provenance', () => {
  const { store, c, m, group, post } = fixture(); const message = post('@a');
  assert.deepEqual(JSON.parse(message.mentions_json), ['a']);
  assert.equal(m.schedule(group.id, JSON.parse(message.mentions_json)).length, 1);
  assert.equal(m.schedule(group.id, ['a']).length, 0);
  m.ack('outsider', [message.id]); assert.equal(m.inbox('b').messages.length, 1); assert.equal(m.inbox('outsider').messages.length, 0);
  m.ack('b', [message.id]); assert.equal(m.inbox('b').messages.length, 0);
  store.db.prepare('UPDATE conversations SET auto_turns_enabled=0 WHERE id=?').run(group.id);
  assert.equal(m.schedule(group.id, ['b']).length, 0);
  store.db.prepare('UPDATE conversations SET auto_turns_enabled=1 WHERE id=?').run(group.id);
  assert.equal(m.schedule(group.id, ['b']).length, 1);
  for (let i = 0; i < 29; i++) { for (const r of store.listRuns()) store.setRun(r.id, { state: 'completed', result: 'Reply' }); m.schedule(group.id, ['b']); }
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM events WHERE type='messaging.turn'").get()!.n, 30);
  assert.ok(c.getConversation(group.id).messages.some(msg => msg.sender_kind === 'system'));
  assert.match(m.buildTurnPrompt(group.id, 'a'), /"sender_kind":"user"/);
});

test('boot sweep commits completed turn output and resets interrupted deliveries', () => {
  const { store, m, group, post } = fixture(); post(); const turns = m.schedule(group.id, ['a', 'b']);
  store.db.prepare("UPDATE runs SET state='completed',result='Recovered' WHERE id=?").run(turns[0].runId);
  store.db.prepare("UPDATE runs SET state='interrupted' WHERE id=?").run(turns[1].runId);
  m.bootSweep(); m.bootSweep();
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM messages WHERE idempotency_key=?').get(`turn-result:${turns[0].runId}`)!.n, 1);
  assert.ok(m.inbox('b').messages.length);
});

test('boot sweep schedules an existing pending delegation result once', () => {
  const { store, m, run } = fixture(); const parent = run('a'), child = run('b', parent.conversation_id, 1, parent.id);
  const conversation = m.delegationConversation(parent, child);
  store.db.prepare('UPDATE conversations SET auto_turns_enabled=0 WHERE id=?').run(conversation);
  store.setRun(child.id, { state: 'completed', result: 'Answer' });
  assert.equal(store.listRuns().filter(r => m.isTurn(r.id)).length, 0);
  store.db.prepare('UPDATE conversations SET auto_turns_enabled=1 WHERE id=?').run(conversation);
  m.bootSweep(); m.bootSweep();
  const turns = store.listRuns().filter(r => m.isTurn(r.id));
  assert.equal(turns.length, 1); assert.equal(turns[0].agent_id, parent.agent_id);
  assert.equal(turns[0].depth, 2); assert.equal(m.lineage(turns[0].id).anchor, child.id);
  assert.equal(m.inbox(parent.agent_id, conversation).deliveries.find(d => d.consumed_run_id === turns[0].id)?.state, 'delivered');
});
