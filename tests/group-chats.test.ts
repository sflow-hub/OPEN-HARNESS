import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../runtime/db';
import { GroupChats } from '../runtime/group-chats';
import type { Team } from '../lib/team';
import type { RunRow } from '../runtime/db';

test('group messages persist, retry once, and return agent results without reply loops', () => {
  const store = new Store(':memory:'), members = ['alpha','beta'];
  const team = { id: 'team', memberAgentIds: members } as Team;
  const groups = new GroupChats(store.db, { team: id => id === 'team' ? team : null, createRun: input => {
    const now = new Date().toISOString(); const run: RunRow = { id: crypto.randomUUID(), agent_id: input.agentId, conversation_id: input.conversationId, prompt: input.prompt, parent_run_id: null, session_id: null, state: 'queued', depth: 0, created_at: now, updated_at: now, result: null, error: null }; store.createRun(run); return run;
  } });
  try {
    const group = groups.create({ teamId: 'team', title: 'Research', memberAgentIds: members });
    const input = { text: 'Research the account.', recipientAgentIds: ['alpha'], requestId: 'first' };
    const result = groups.post(group.id, input); assert.equal(result.runs.length, 1);
    assert.equal(groups.post(group.id, input).duplicate, true); assert.equal(store.queued().length, 1);
    assert.throws(() => groups.post(group.id, { ...input, text: 'Another task' }), /another message/);
    const completed = { ...result.runs[0], state: 'completed' as const, result: 'Research complete.' }; groups.onRunChanged(completed); groups.onRunChanged(completed);
    assert.equal(groups.messages(group.id).length, 2); assert.equal(store.listRuns().length, 1);
    members.splice(0, 1); assert.throws(() => groups.messages(group.id, 'alpha'), /not a member/);
    assert.throws(() => groups.post(group.id, { ...input, requestId: 'next' }), /current group/);
  } finally { store.db.close(); }
});

test('group dispatch rolls back all recipients on queue failure', () => {
  const store = new Store(':memory:'); const groups = new GroupChats(store.db, { team: () => ({ id: 'team', memberAgentIds: ['a','b'] } as Team), createRun: () => { throw new Error('Queue full'); } });
  try { const group = groups.create({ teamId: 'team', title: 'Ops', memberAgentIds: ['a','b'] }); assert.throws(() => groups.post(group.id, { text: 'Work', recipientAgentIds: ['a'], requestId: 'r1' }), /Queue full/); assert.equal(groups.messages(group.id).length, 0); }
  finally { store.db.close(); }
});

test('failure after one recipient was queued rolls back the message, run and link together', () => {
  const store = new Store(':memory:'); let calls = 0;
  const groups = new GroupChats(store.db, { team: () => ({ id: 'team', memberAgentIds: ['a','b'] } as Team), createRun: input => {
    if (++calls === 2) throw new Error('Queue full');
    const now = new Date().toISOString(); const run: RunRow = { id: crypto.randomUUID(), agent_id: input.agentId, conversation_id: input.conversationId, prompt: input.prompt, parent_run_id: null, session_id: null, state: 'queued', depth: 0, created_at: now, updated_at: now, result: null, error: null }; store.createRun(run); return run;
  } });
  try {
    const group = groups.create({ teamId: 'team', title: 'Ops', memberAgentIds: ['a','b'] });
    assert.throws(() => groups.post(group.id, { text: 'Work', recipientAgentIds: ['a','b'], requestId: 'retry' }), /Queue full/);
    assert.equal(groups.messages(group.id).length, 0); assert.equal(store.listRuns().length, 0); assert.equal(groups.activity(group.id).length, 0);
  } finally { store.db.close(); }
});

test('agent group access follows current membership and cannot dispatch itself or impersonate a retry', () => {
  const store = new Store(':memory:'); let active = true;
  const groups = new GroupChats(store.db, { team: () => active ? ({ id: 'team', memberAgentIds: ['a','b','c'] } as Team) : null, createRun: () => { throw new Error('No work should be started by these cases.'); } });
  try {
    const group = groups.create({ teamId: 'team', title: 'Ops', memberAgentIds: ['a','b'] });
    assert.equal(groups.list('c').length, 0); assert.throws(() => groups.get(group.id, 'c'), /not a member/);
    assert.throws(() => groups.post(group.id, { text: 'Reply', recipientAgentIds: ['a'], requestId: 'self' }, 'a', 'parent'), /other current group/);
    assert.throws(() => groups.post(group.id, { text: 'Reply', recipientAgentIds: ['b'], requestId: 'no-parent' }, 'a'), /active run is required/);
    groups.post(group.id, { text: 'Status update', requestId: 'same' }, 'a');
    assert.throws(() => groups.post(group.id, { text: 'Status update', requestId: 'same' }), /another message/);
    active = false; assert.equal(groups.list().length, 0); assert.throws(() => groups.messages(group.id, 'a'), /retired team/);
  } finally { store.db.close(); }
});

test('restart repairs a terminal result committed before its group listener ran', () => {
  const store = new Store(':memory:'), hooks = { team: () => ({ id: 'team', memberAgentIds: ['a','b'] } as Team), createRun: (input: { agentId: string; conversationId: string; prompt: string }) => {
    const stamp = new Date().toISOString(); const run: RunRow = { id: crypto.randomUUID(), agent_id: input.agentId, conversation_id: input.conversationId, prompt: input.prompt, parent_run_id: null, session_id: null, state: 'queued', depth: 0, created_at: stamp, updated_at: stamp, result: null, error: null }; store.createRun(run); return run;
  } };
  try {
    const first = new GroupChats(store.db, hooks), group = first.create({ teamId: 'team', title: 'Restart', memberAgentIds: ['a','b'] });
    const { runs } = first.post(group.id, { text: 'Complete this task', recipientAgentIds: ['a'], requestId: 'recovery' });
    store.setRun(runs[0].id, { state: 'completed', result: 'Verified destination result.' });
    assert.equal(first.messages(group.id).length, 1);
    const recovered = new GroupChats(store.db, hooks); assert.equal(recovered.messages(group.id)[1].text, 'Verified destination result.');
    const again = new GroupChats(store.db, hooks); assert.equal(again.messages(group.id).length, 2);
  } finally { store.db.close(); }
});
