import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../runtime/db';
import { Profiles } from '../runtime/profiles';
import { Workspaces, actorContext } from '../runtime/workspaces';
import { Connections } from '../runtime/connections';
import { Actions } from '../runtime/actions';

function fixture() {
  const store = new Store(':memory:'); new Profiles(store.db); const workspace = new Workspaces(store.db, '/revision');
  store.db.prepare('INSERT INTO agent_profiles VALUES(?,1,?)').run('atlas', '{}');
  const secrets = { set: () => {}, delete: () => {}, environment: () => ({ token: JSON.stringify({ access_token: 'fixture', expires_at: Date.now() + 3600000 }) }) };
  let reads = 0, writes = 0, pause: (() => Promise<void>) | undefined;
  const transport = (async (_url: string | URL | Request, init: RequestInit = {}) => { if (init.method && init.method !== 'GET') writes++; else reads++; if (pause) await pause(); return new Response(JSON.stringify({ values: [['before']] }), { status: 200 }); }) as typeof fetch;
  const connections = new Connections(store.db, secrets, () => workspace.actor(), transport), changes: string[] = [], actions = new Actions(store.db, connections, () => workspace.actor(), action => { changes.push(action.id); });
  store.db.prepare('INSERT INTO app_connections VALUES(?,?,?,?,?,?,?,NULL,?,?,?)').run('sheet-account', 'sheets', 'owner@example.com', 'local-owner', '["atlas"]', JSON.stringify(['https://www.googleapis.com/auth/spreadsheets.readonly', 'https://www.googleapis.com/auth/spreadsheets']), 'connected', 'token', Date.now() + 3600000, new Date().toISOString());
  const args = { spreadsheetId: 'sheet', range: 'Sheet1!A1', values: [['new']] };
  const create = async (runId?: string) => actions.prepare({ requestId: crypto.randomUUID(), connectionId: 'sheet-account', operation: 'sheets.update', input: args }, runId ? 'atlas' : undefined, runId);
  const input = (id: string) => ({ confirmation: actions.review(id).confirmation, requestId: crypto.randomUUID(), input: { ...args, values: [['revised']] } });
  const createRun = (id: string, ownerId = 'local-owner') => { const stamp = new Date().toISOString(); store.createRun({ id, agent_id: 'atlas', conversation_id: id, prompt: 'Revise result', state: 'running', depth: 0, parent_run_id: null, session_id: null, result: null, error: null, created_at: stamp, updated_at: stamp }); store.db.prepare('INSERT INTO human_run_owners VALUES(?,?)').run(id, ownerId); };
  return { store, workspace, connections, actions, create, input, createRun, changes, reads: () => reads, writes: () => writes, pause: (value: (() => Promise<void>) | undefined) => { pause = value; } };
}

test('revision preserves immutable scope, requires fresh approval, and retries without preparing or executing again', async () => {
  const f = fixture(); try {
    f.createRun('run'); const original = await f.create('run'), input = f.input(original.id), oldConfirmation = input.confirmation;
    const revised = await f.actions.revise(original.id, input);
    assert.notEqual(revised.id, original.id); assert.equal(revised.runId, 'run'); assert.equal(revised.connectionId, original.connectionId); assert.equal(revised.operation, original.operation); assert.equal(revised.state, 'awaiting_approval'); assert.notEqual(revised.confirmation, oldConfirmation); assert.deepEqual(revised.request.values, [['revised']]);
    const saved = f.store.db.prepare('SELECT * FROM action_intents WHERE id=?').get(revised.id)!; assert.equal(saved.actor_id, 'local-owner'); assert.equal(saved.agent_id, 'atlas'); assert.equal(saved.grant_id, null);
    const old = f.actions.get(original.id); assert.equal(old.state, 'denied'); assert.deepEqual(old.request, original.request); assert.match(old.evidence, new RegExp(revised.id));
    await assert.rejects(f.actions.execute(original.id), /approval/); await assert.rejects(f.actions.execute(revised.id), /approval/); assert.throws(() => f.actions.decide(revised.id, { approved: true, confirmation: oldConfirmation }), /current action/);
    const reads = f.reads(); assert.equal((await f.actions.revise(original.id, input)).id, revised.id); assert.equal(f.reads(), reads); assert.equal(f.writes(), 0); assert.deepEqual(f.changes, [original.id, revised.id]);
    await assert.rejects(f.actions.revise(original.id, { ...input, input: { ...input.input, values: [['different']] } }), /different action/);
  } finally { f.store.db.close(); }
});

test('revision rejects stale confirmation, unsupported fields, changed scope and invalid replacement values', async () => {
  const f = fixture(); try {
    const action = await f.create(), input = f.input(action.id);
    await assert.rejects(f.actions.revise(action.id, { ...input, confirmation: 'stale' }), /current action/);
    await assert.rejects(f.actions.revise(action.id, { ...input, connectionId: 'other' }), /account and operation/);
    await assert.rejects(f.actions.revise(action.id, { ...input, operation: 'gmail.send' }), /account and operation/);
    await assert.rejects(f.actions.revise(action.id, { ...input, grantId: 'old-grant' }), /account and operation/);
    await assert.rejects(f.actions.revise(action.id, { ...input, input: { ...input.input, beforeHash: 'forged' } }), /editable fields/);
    await assert.rejects(f.actions.revise(action.id, { ...input, input: { ...input.input, values: [{ bad: true }] } }), /simple cell values/);
    assert.equal(f.actions.get(action.id).state, 'awaiting_approval'); assert.equal(f.writes(), 0);
    f.actions.decide(action.id, { approved: true, confirmation: input.confirmation }); await assert.rejects(f.actions.revise(action.id, input), /no longer waiting/);
  } finally { f.store.db.close(); }
});

test('only account owner can revise and original run owner is retained', async () => {
  const f = fixture(); try {
    const actor = { id: 'colleague', role: 'operator' as const, source: 'oidc' as const, workspaceId: f.workspace.id }; f.store.db.prepare('INSERT INTO human_members(actor_id,role,revoked,created_at) VALUES(?,?,0,?)').run(actor.id, actor.role, new Date().toISOString()); f.createRun('run', actor.id);
    const original = await actorContext.run(actor, () => f.create('run')), input = f.input(original.id);
    await assert.rejects(actorContext.run(actor, () => f.actions.revise(original.id, input)), /not been shared|owner/);
    await assert.rejects(actorContext.run({ ...f.workspace.localOwner(), role: 'viewer' }, () => f.actions.revise(original.id, input)), /not been shared|owner/);
    const next = await f.actions.revise(original.id, input); assert.equal(f.store.db.prepare('SELECT actor_id FROM action_intents WHERE id=?').get(next.id)!.actor_id, actor.id); assert.equal(f.store.db.prepare('SELECT actor_id FROM human_run_owners WHERE run_id=?').get('run')!.actor_id, actor.id); assert.equal(f.writes(), 0);
  } finally { f.store.db.close(); }
});

test('concurrent identical revisions return one replacement and state changes during preparation block replacement', async () => {
  const f = fixture(); try {
    const action = await f.create(), input = f.input(action.id), gates: Array<() => void> = []; f.pause(() => new Promise<void>(resolve => { gates.push(resolve); }));
    const first = f.actions.revise(action.id, input), second = f.actions.revise(action.id, input); await new Promise(resolve => setImmediate(resolve)); assert.equal(gates.length, 2); gates.forEach(resolve => resolve());
    const results = await Promise.all([first, second]); assert.equal(results[0].id, results[1].id); assert.equal(f.actions.list().length, 2);
    f.pause(undefined); const other = await f.create(), revision = f.input(other.id); let resume!: () => void; f.pause(() => new Promise<void>(resolve => { resume = resolve; }));
    const pending = f.actions.revise(other.id, revision); await new Promise(resolve => setImmediate(resolve)); f.actions.decide(other.id, { approved: false, confirmation: revision.confirmation }); resume(); await assert.rejects(pending, /changed while preparing/); assert.equal(f.actions.list().length, 3); assert.equal(f.writes(), 0);
  } finally { f.store.db.close(); }
});

test('revoked owner, run owner or agent access during preparation prevents committing the revision', async () => {
  for (const revoke of ['owner', 'run-owner', 'agent', 'account']) {
    const f = fixture(); try {
      f.store.db.prepare('INSERT INTO human_members(actor_id,role,revoked,created_at) VALUES(?, ?, 0, ?)').run('run-owner', 'operator', new Date().toISOString()); f.createRun('run', 'run-owner'); const action = await f.create('run'), input = f.input(action.id); let resume!: () => void;
      f.pause(() => new Promise<void>(resolve => { resume = resolve; })); const pending = f.actions.revise(action.id, input); await new Promise(resolve => setImmediate(resolve));
      if (revoke === 'owner' || revoke === 'run-owner') f.store.db.prepare('UPDATE human_members SET revoked=1 WHERE actor_id=?').run(revoke === 'owner' ? 'local-owner' : 'run-owner'); else if (revoke === 'agent') f.connections.share('sheet-account', []); else f.store.db.prepare("UPDATE app_connections SET state='revoked' WHERE id='sheet-account'").run();
      resume(); await assert.rejects(pending, /permission|owner|not been shared|Reconnect/); assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM action_intents').get()!.n, 1); assert.equal(f.store.db.prepare('SELECT state FROM action_intents WHERE id=?').get(action.id)!.state, 'awaiting_approval'); assert.equal(f.writes(), 0);
    } finally { f.store.db.close(); }
  }
});

test('revision rolls back its new intent if superseding the original fails', async () => {
  const f = fixture(); try {
    const action = await f.create(), input = f.input(action.id); f.store.db.exec("CREATE TRIGGER reject_revision BEFORE UPDATE OF state ON action_intents WHEN NEW.state='denied' BEGIN SELECT RAISE(ABORT, 'fixture interruption'); END");
    await assert.rejects(f.actions.revise(action.id, input), /fixture interruption/); assert.equal(f.actions.list().length, 1); assert.equal(f.actions.get(action.id).state, 'awaiting_approval'); assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM action_events').get()!.n, 0);
    f.store.db.exec('DROP TRIGGER reject_revision'); assert.equal((await f.actions.revise(action.id, input)).state, 'awaiting_approval'); assert.equal(f.writes(), 0);
  } finally { f.store.db.close(); }
});
