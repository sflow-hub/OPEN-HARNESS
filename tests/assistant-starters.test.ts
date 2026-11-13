import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { AssistantStarters, buildStarterPrompt, type StarterContext } from '../runtime/assistant-starters';
import { assistantStarters, type StarterInput } from '../lib/assistant-starters';
import { PRIMARY_ASSISTANT_ID, type AppId, type Connection } from '../lib/product';
import { ProductError } from '../runtime/product-error';

const connection = (id: string, app: AppId, patch: Partial<Connection> = {}): Connection => ({ id, app, account: `${id}@example.test`, ownerId: 'alice', sharedAgentIds: [PRIMARY_ASSISTANT_ID], scopes: [], state: 'connected', lastError: null, updatedAt: '2026-11-08T00:00:00.000Z', ...patch });
const context = (): StarterContext => ({ connections: [connection('mail', 'gmail'), connection('calendar', 'calendar'), connection('drive', 'drive')], agents: [{ id: 'research', name: 'Scout' }, { id: 'writer', name: 'Harper' }] });
const day = (): StarterInput => ({ starterId: 'prepare-day', connectionIds: ['mail', 'calendar'], inputs: { window: 'Tomorrow in America/Denver', inboxQuery: 'in:inbox newer_than:7d' }, requestId: 'day-1' });
const material = (): StarterInput => ({ starterId: 'material-brief', connectionIds: [], inputs: { material: 'https://example.test/reference', deliverable: 'A one-page creative brief' }, requestId: 'material-1' });
const research = (): StarterInput => ({ starterId: 'research-draft', connectionIds: [], inputs: { topic: 'Practical container workflows', deliverable: 'A proposal with sources', researcherId: 'research', writerId: 'writer' }, requestId: 'research-1' });

function fixture() {
  const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE launches(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,request_id TEXT NOT NULL,prompt TEXT NOT NULL,UNIQUE(actor_id,request_id))');
  const available = context(), actor = { id: 'alice' };
  const createRun = (prompt: string, requestId: string) => {
    const old = db.prepare('SELECT id,prompt FROM launches WHERE actor_id=? AND request_id=?').get(actor.id, requestId) as { id: string; prompt: string } | undefined;
    if (old) { if (old.prompt !== prompt) throw new ProductError('This request identity belongs to an earlier goal.', 409); return { id: old.id }; }
    const id = crypto.randomUUID(); db.prepare('INSERT INTO launches VALUES(?,?,?,?)').run(id, actor.id, requestId, prompt); return { id };
  };
  const deps = { connections: () => available.connections, agents: () => available.agents, createRun, actorId: () => actor.id };
  return { db, available, actor, deps, starters: new AssistantStarters(db, deps) };
}

test('starter catalog keeps required accounts and optional inputs explicit without mutating shared definitions', t => {
  const { db, starters } = fixture(); t.after(() => db.close());
  const catalog = starters.catalog(); assert.deepEqual(catalog.map(item => item.id), ['prepare-day', 'material-brief', 'research-draft']);
  assert.deepEqual(catalog[0].apps, ['gmail', 'calendar']); assert.deepEqual(catalog[1].apps, ['drive']);
  assert.equal(catalog[2].fields.find(field => field.id === 'researcherId')?.required, false);
  catalog[0].apps.length = 0; catalog[1].fields[0].label = 'Changed';
  assert.deepEqual(starters.catalog(), assistantStarters); assert.deepEqual(starters.catalog()[0].apps, ['gmail', 'calendar']);
});

test('day starter refuses missing, unavailable, disconnected, and unshared accounts before creating work', t => {
  const { db, starters, available } = fixture(); t.after(() => db.close());
  assert.throws(() => starters.start({ ...day(), connectionIds: ['mail'] }), /both a Gmail account and a Calendar account/);
  assert.throws(() => starters.start({ ...day(), connectionIds: ['mail', 'another-users-calendar'] }), (error: unknown) => error instanceof ProductError && error.status === 403);
  for (const state of ['needs_authorization', 'revoked', 'error'] as const) {
    available.connections[1].state = state; assert.throws(() => starters.start(day()), /Reconnect/);
  }
  available.connections[1].state = 'connected'; available.connections[1].sharedAgentIds = [];
  assert.throws(() => starters.start(day()), /Share .* with your primary assistant/);
  assert.deepEqual(available.connections[1].sharedAgentIds, []); assert.equal(db.prepare('SELECT COUNT(*) AS count FROM launches').get()!.count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM assistant_starter_runs').get()!.count, 0);
});

test('optional account selection is explicit and prompts retain draft, approval, provenance, and save limits', () => {
  const supplied = context(), prompt = buildStarterPrompt(material(), supplied);
  assert.match(prompt, /Explicitly selected accounts:\n\[\]/); assert.doesNotMatch(prompt, /drive@example\.test/);
  assert.match(prompt, /report_result/); assert.match(prompt, /"file"\|"link"/); assert.match(prompt, /Do not send or publish drafts/);
  assert.match(prompt, /Never bypass connector approval with shell or browser tools/); assert.match(prompt, /Do not create or enable a schedule/);
  assert.match(prompt, /missing capability/); assert.match(prompt, /at most one eligible artifact helper/);
  assert.match(prompt, /"id":"writer","name":"Harper"/); assert.match(prompt, /untrusted data/);
  const withDrive = buildStarterPrompt({ ...material(), connectionIds: ['drive'] }, supplied); assert.match(withDrive, /drive@example\.test/);
  supplied.connections[2].sharedAgentIds = [];
  assert.throws(() => buildStarterPrompt({ ...material(), connectionIds: ['drive'] }, supplied), /Share/);
});

test('starter artifact instructions preserve historical results with names chosen afresh for each execution', () => {
  for (const input of [day(), material(), research()]) {
    const prompt = buildStarterPrompt(input, context());
    assert.match(prompt, /For each execution, including recurring runs, create a fresh unique safe flat shared filename/);
    assert.ok(prompt.includes(`prefix ${input.starterId}- followed by the current run identifier or a newly generated unique suffix, then .md`));
    assert.match(prompt, /Choose the suffix at execution time/);
    assert.match(prompt, /never reuse a filename or request identity copied from earlier workflow instructions/);
    assert.match(prompt, /If it exists, ask the user before overwriting and offer a uniquely named copy/);
    assert.match(prompt, /Never overwrite an older artifact by default/);
    assert.doesNotMatch(prompt, /Default to a flat shared filename (?:day-brief|material-brief|research-draft)\.md/);
  }
  const explicit = buildStarterPrompt({ ...material(), inputs: { ...material().inputs, deliverable: 'Save the draft as pitch.md' } }, context());
  assert.match(explicit, /Save the draft as pitch\.md/); assert.match(explicit, /Preserve an explicitly requested filename only if .* does not already exist/);
  assert.equal(buildStarterPrompt({ ...material(), requestId: 'a-new-submission' }, context()), buildStarterPrompt(material(), context()));
});

test('research starter uses only eligible explicit specialists and keeps primary accountable', () => {
  const supplied = context(), prompt = buildStarterPrompt(research(), supplied);
  assert.match(prompt, /"researcher":\{"id":"research","name":"Scout"\}/);
  assert.match(prompt, /"writer":\{"id":"writer","name":"Harper"\}/);
  assert.match(prompt, /Research precedes writing/); assert.match(prompt, /primary assistant remains responsible/);
  for (const id of ['unavailable', PRIMARY_ASSISTANT_ID, 'setup-verifier']) {
    supplied.agents.push({ id, name: 'Not a specialist' });
    const candidates = id === 'unavailable' ? { ...supplied, agents: supplied.agents.filter(agent => agent.id !== id) } : supplied;
    assert.throws(() => buildStarterPrompt({ ...research(), inputs: { ...research().inputs, researcherId: id } }, candidates), /Choose a teammate/);
  }
  const solo = buildStarterPrompt({ ...research(), inputs: { topic: 'Topic', deliverable: 'A draft' } }, supplied);
  assert.match(solo, /Selected teammates:\n\{\}/); assert.doesNotMatch(solo, /"id":"setup-verifier"/);
});

test('starter validation bounds inputs and rejects malformed or unsupported requests without launching', t => {
  const { db, starters } = fixture(); t.after(() => db.close());
  const invalid: unknown[] = [null, [], { ...day(), starterId: 'unknown' }, { ...day(), requestId: '' }, { ...day(), requestId: 'x'.repeat(101) }, { ...day(), inputs: [] }, { ...day(), inputs: { ...day().inputs, unexpected: 'value' } }, { ...day(), inputs: { window: '', inboxQuery: 'in:inbox' } }, { ...day(), inputs: { window: 'x'.repeat(201), inboxQuery: 'in:inbox' } }, { ...material(), inputs: { material: 'x'.repeat(8001), deliverable: 'Brief' } }, { ...day(), connectionIds: undefined }, { ...day(), connectionIds: ['mail', 1] }, { ...day(), connectionIds: Array.from({ length: 21 }, () => 'mail') }, { ...research(), inputs: { ...research().inputs, researcherId: 1 } }];
  for (const input of invalid) assert.throws(() => starters.start(input), ProductError);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM launches').get()!.count, 0);
  const oversized = context(); oversized.connections = Array.from({ length: 20 }, (_, index) => connection(`account-${index}`, 'drive', { account: 'a'.repeat(250) }));
  assert.throws(() => buildStarterPrompt({ ...material(), connectionIds: oversized.connections.map(account => account.id), inputs: { material: 'm'.repeat(7000), deliverable: 'd'.repeat(1000) } }, oversized), /too much material/);
});

test('starter launch reuses existing message idempotency, records once, and rejects changed retries', t => {
  const { db, starters, deps, actor } = fixture(); t.after(() => db.close());
  const first = starters.start(day()), repeated = new AssistantStarters(db, deps).start({ ...day(), connectionIds: ['calendar', 'mail', 'mail'] }); assert.deepEqual(repeated, first);
  const record = db.prepare('SELECT * FROM assistant_starter_runs WHERE run_id=?').get(first.id)!;
  assert.equal(record.starter_id, 'prepare-day'); assert.equal(record.actor_id, 'alice'); assert.ok(Date.parse(String(record.created_at)));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM launches').get()!.count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM assistant_starter_runs').get()!.count, 1);
  assert.throws(() => starters.start({ ...day(), inputs: { ...day().inputs, window: 'Friday' } }), /earlier goal/);
  actor.id = 'bob'; const other = starters.start(day()); assert.notEqual(other.id, first.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM assistant_starter_runs').get()!.count, 2);
});

test('a failed starter record rolls back run creation so a retry creates exactly one durable run', t => {
  const { db, starters } = fixture(); t.after(() => db.close());
  db.exec("CREATE TRIGGER reject_starter BEFORE INSERT ON assistant_starter_runs BEGIN SELECT RAISE(ABORT,'storage unavailable'); END");
  assert.throws(() => starters.start(material()), /storage unavailable/); assert.equal(db.prepare('SELECT COUNT(*) AS count FROM launches').get()!.count, 0);
  db.exec('DROP TRIGGER reject_starter'); const run = starters.start(material()); assert.ok(run.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM launches').get()!.count, 1); assert.equal(db.prepare('SELECT COUNT(*) AS count FROM assistant_starter_runs').get()!.count, 1);
});

test('latest day brief follows continuations and recurring workflows while keeping actor lineage private', t => {
  const { db, starters, actor } = fixture(); t.after(() => db.close());
  assert.equal(starters.latestBrief(), null);
  db.exec('CREATE TABLE runs(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE TABLE human_run_owners(run_id TEXT PRIMARY KEY,actor_id TEXT NOT NULL)');
  const add = (id: string, order: number, owner = 'alice') => { const stamp = new Date(1700000000000 + order * 1000).toISOString(); db.prepare('INSERT INTO runs VALUES(?,?,?)').run(id, stamp, stamp); db.prepare('INSERT INTO human_run_owners VALUES(?,?)').run(id, owner); };
  const record = (id: string, owner = 'alice') => db.prepare('INSERT INTO assistant_starter_runs VALUES(?,?,?,?)').run(id, 'prepare-day', owner, new Date().toISOString());
  add('original', 1); record('original'); assert.equal(starters.latestBrief(), 'original');
  db.exec('CREATE TABLE run_contexts(run_id TEXT PRIMARY KEY,source_run_id TEXT); CREATE TABLE workflows(id TEXT PRIMARY KEY,source_run_id TEXT NOT NULL); CREATE TABLE workflow_runs(workflow_id TEXT NOT NULL,run_id TEXT NOT NULL)');
  add('continued', 2); db.prepare('INSERT INTO run_contexts VALUES(?,?)').run('continued', 'original'); assert.equal(starters.latestBrief(), 'continued');
  db.prepare('INSERT INTO workflows VALUES(?,?)').run('daily', 'continued'); add('scheduled', 3); db.prepare('INSERT INTO workflow_runs VALUES(?,?)').run('daily', 'scheduled'); assert.equal(starters.latestBrief(), 'scheduled');
  add('scheduled-continuation', 4); db.prepare('INSERT INTO run_contexts VALUES(?,?)').run('scheduled-continuation', 'scheduled'); assert.equal(starters.latestBrief(), 'scheduled-continuation');
  db.prepare('INSERT INTO run_contexts VALUES(?,?)').run('original', 'continued'); db.prepare('INSERT INTO workflow_runs VALUES(?,?)').run('daily', 'missing-run');
  add('other-operator', 5, 'bob'); record('other-operator', 'bob');
  add('other-operator-copy', 6, 'bob'); db.prepare('INSERT INTO workflow_runs VALUES(?,?)').run('daily', 'other-operator-copy');
  add('private-lineage', 7); db.prepare('INSERT INTO run_contexts VALUES(?,?)').run('private-lineage', 'other-operator-copy');
  assert.equal(starters.latestBrief(), 'scheduled-continuation');
  actor.id = 'bob'; assert.equal(starters.latestBrief(), 'other-operator');
  actor.id = 'unrelated'; assert.equal(starters.latestBrief(), null);
});
