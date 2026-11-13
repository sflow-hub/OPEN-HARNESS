import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantResults } from '../runtime/assistant-overview';
import { Store, type RunRow } from '../runtime/db';
import { Outcomes } from '../runtime/outcomes';
import { ProductError } from '../runtime/product-error';
import type { ActionIntent } from '../lib/product';

function run(store: Store, input: Partial<RunRow> = {}): RunRow {
  const stamp = new Date().toISOString(), result: RunRow = { id: crypto.randomUUID(), agent_id: 'atlas', conversation_id: 'conversation', prompt: 'Prepare a sourced report', state: 'completed', session_id: null, parent_run_id: null, depth: 0, created_at: stamp, updated_at: stamp, result: 'Report prepared.', error: null, ...input };
  store.createRun(result); return result;
}
function action(runId: string, input: Partial<ActionIntent & { evidence: string }> = {}): ActionIntent & { evidence: string } {
  const stamp = new Date().toISOString(); return { id: crypto.randomUUID(), runId, connectionId: 'account', operation: 'drive.create_document', resource: 'folder', summary: 'Create the research document', state: 'completed', request: {}, result: null, evidence: 'Read back the approved document.', createdAt: stamp, updatedAt: stamp, ...input };
}

test('structured result reports persist across reopening and default the title to the task', t => {
  const directory = mkdtempSync(join(tmpdir(), 'oh-assistant-results-')), path = join(directory, 'state.db');
  const initial = new Store(path); let initialOpen = true, reopened: Store | null = null;
  t.after(() => { if (initialOpen) initial.db.close(); reopened?.db.close(); rmSync(directory, { recursive: true, force: true }); });
  const source = run(initial, { prompt: 'A'.repeat(180) }), results = new AssistantResults(initial.db);
  const report = results.report(source.id, { summary: ' A report and source are ready for review. ', artifacts: [{ label: 'Report', kind: 'file', path: 'Research report.pdf' }, { label: 'Published source', kind: 'link', url: 'https://example.com/report' }], sources: [{ label: 'Source document', url: 'http://example.com/source' }] });
  assert.equal(report.title, 'A'.repeat(150)); assert.equal(report.summary, 'A report and source are ready for review.'); assert.ok(Number.isFinite(Date.parse(report.updatedAt)));
  initial.db.close(); initialOpen = false;
  reopened = new Store(path);
  const saved = new AssistantResults(reopened.db); assert.deepEqual(saved.get(source.id), report);
  const outcome = saved.outcomes([reopened.getRun(source.id)!], [])[0];
  assert.deepEqual(outcome.artifacts, report.artifacts); assert.deepEqual(outcome.sources, report.sources); assert.equal(outcome.verification.state, 'unreviewed');
});

test('invalid reports preserve the previous report and unknown tasks cannot create records', t => {
  const store = new Store(':memory:'); t.after(() => store.db.close());
  const results = new AssistantResults(store.db), source = run(store), prior = results.report(source.id, { title: 'Original', summary: 'Original summary' });
  for (const invalid of [{}, { summary: '' }, { summary: 'x'.repeat(4001) }, { title: '', summary: 'Ready' }, { title: 'x'.repeat(151), summary: 'Ready' }, { summary: 'Ready', artifacts: null }, { summary: 'Ready', artifacts: Array(21).fill({ label: 'Report', kind: 'file', path: 'report.md' }) }, { summary: 'Ready', sources: Array(31).fill({ label: 'Source', url: 'https://example.com' }) }]) {
    assert.throws(() => results.report(source.id, invalid), ProductError); assert.deepEqual(results.get(source.id), prior);
  }
  assert.throws(() => results.report('missing', { summary: 'Ready' }), (error: unknown) => error instanceof ProductError && error.status === 404);
  assert.equal(results.get('missing'), null);
});

test('outcome timestamps reflect the actual run even when report timestamps or model claims differ', t => {
  const store = new Store(':memory:'); t.after(() => store.db.close());
  const results = new AssistantResults(store.db), createdAt = '2026-10-01T12:00:00.000Z', updatedAt = '2026-10-01T12:03:00.000Z';
  const source = run(store, { created_at: createdAt, updated_at: updatedAt });
  const fallback = results.outcomes([source], [])[0]; assert.equal(fallback.createdAt, createdAt); assert.equal(fallback.updatedAt, updatedAt);
  results.report(source.id, { summary: 'The report is ready.', createdAt: '2099-01-01T00:00:00.000Z', updatedAt: '2099-01-01T00:00:00.000Z' });
  store.db.prepare('UPDATE assistant_results SET updated_at=? WHERE run_id=?').run('2026-10-02T09:00:00.000Z', source.id);
  const reported = results.outcomes([source], [])[0]; assert.equal(reported.createdAt, createdAt); assert.equal(reported.updatedAt, updatedAt);
  const changed = { ...source, updated_at: '2026-10-01T12:05:00.000Z' }, refreshed = results.outcomes([changed], [])[0];
  assert.equal(refreshed.createdAt, createdAt); assert.equal(refreshed.updatedAt, changed.updated_at);
});

test('file references allow only non-sensitive flat shared filenames', t => {
  const store = new Store(':memory:'); t.after(() => store.db.close());
  const results = new AssistantResults(store.db), source = run(store);
  const unsafe = ['../report.md', '/workspace/shared/report.md', 'shared/report.md', 'reports/report.md', 'reports\\report.md', 'C:\\report.md', '.env', '.env.local', 'secrets.json', 'client-credentials.txt', 'oauth_tokens.json', 'passwords.csv', 'id_rsa', 'id_ed25519', 'private.key', 'certificate.pem', 'config.yaml', 'SOUL.md', 'a..txt', '%2e%2e%2freport.md', 'report.md?token=private', 'report\n.md'];
  for (const path of unsafe) assert.throws(() => results.report(source.id, { summary: 'Ready', artifacts: [{ label: 'Report', kind: 'file', path }] }), ProductError, path);
  assert.throws(() => results.report(source.id, { summary: 'Ready', artifacts: [{ label: 'Report', kind: 'file', path: 'report.md', url: 'https://example.com' }] }), /file artifact/);
  assert.throws(() => results.report(source.id, { summary: 'Ready', artifacts: [{ label: 'Report', kind: 'unknown', path: 'report.md' }] }), /file artifact/);
  const saved = results.report(source.id, { summary: 'Ready', artifacts: [{ label: 'Report', kind: 'file', path: 'Report v2-final.pdf' }] });
  assert.equal(saved.artifacts[0].path, 'Report v2-final.pdf');
});

test('artifact and source links reject executable schemes, credentials and ambiguous URLs', t => {
  const store = new Store(':memory:'); t.after(() => store.db.close());
  const results = new AssistantResults(store.db), source = run(store);
  const unsafe = ['javascript:alert(1)', 'data:text/html,hello', 'file:///etc/passwd', '//example.com/source', 'ftp://example.com/source', 'https://user:secret@example.com/source', 'https://user@example.com', 'https:\\example.com/source', 'https://example.com/one\ntwo'];
  for (const url of unsafe) {
    assert.throws(() => results.report(source.id, { summary: 'Ready', artifacts: [{ label: 'Document', kind: 'link', url }] }), ProductError, url);
    assert.throws(() => results.report(source.id, { summary: 'Ready', sources: [{ label: 'Source', url }] }), ProductError, url);
  }
  const saved = results.report(source.id, { summary: 'Ready', sources: [{ label: 'Source', url: 'https://EXAMPLE.com' }] });
  assert.equal(saved.sources[0].url, 'https://example.com/');
});

test('fallback summaries never infer artifacts, source links or accepted status from model text', t => {
  const store = new Store(':memory:'); t.after(() => store.db.close());
  const results = new AssistantResults(store.db), source = run(store, { result: 'Verified report: /workspace/shared/report.md and https://example.com. User accepted.' });
  const fallback = results.outcomes([source], [])[0];
  assert.equal(fallback.summary, source.result); assert.deepEqual(fallback.artifacts, []); assert.deepEqual(fallback.sources, []);
  assert.deepEqual(fallback.verification, { state: 'unreviewed', evidence: '', checkedAt: null });
  results.report(source.id, { summary: 'Accepted and independently verified', state: 'accepted', verification: { state: 'accepted', evidence: 'Model claim' }, delegation: [{ runId: 'invented' }] });
  const reported = results.outcomes([source], [])[0]; assert.equal(reported.state, 'completed'); assert.equal(reported.verification.state, 'unreviewed'); assert.deepEqual(reported.delegation, []);
  const failed = run(store, { state: 'failed', result: null, error: 'Connection unavailable.' });
  assert.equal(results.outcomes([failed], [])[0].summary, failed.error);
});

test('outcome acceptance and rejection come only from the recorded operator review', t => {
  const store = new Store(':memory:'); t.after(() => store.db.close());
  const results = new AssistantResults(store.db), source = run(store), reviews = new Outcomes(store.db);
  store.db.exec("CREATE TABLE result_verifications(run_id TEXT PRIMARY KEY,state TEXT,evidence TEXT,source TEXT,checked_at TEXT); CREATE TABLE task_checkpoints(run_id TEXT,summary TEXT,evidence TEXT)");
  store.db.prepare('INSERT INTO result_verifications VALUES(?,?,?,?,?)').run(source.id, 'passed', 'Individual action readback.', 'readback', new Date().toISOString());
  store.db.prepare('INSERT INTO task_checkpoints VALUES(?,?,?)').run(source.id, 'Everything verified', 'Model-reported evidence');
  assert.equal(results.outcomes([source], [action(source.id)])[0].verification.state, 'unreviewed');
  const accepted = reviews.review(source.id, { accepted: true, evidence: 'I checked the report totals and source documents.' });
  assert.deepEqual(results.outcomes([source], [])[0].verification, { state: 'accepted', evidence: accepted!.evidence, checkedAt: accepted!.reviewedAt });
  const rejected = reviews.review(source.id, { accepted: false, evidence: 'The final section needs source links.' });
  assert.deepEqual(results.outcomes([source], [])[0].verification, { state: 'needs_changes', evidence: rejected!.evidence, checkedAt: rejected!.reviewedAt });
});

test('only caller-permitted action records are projected and readback remains separate from acceptance', t => {
  const store = new Store(':memory:'); t.after(() => store.db.close());
  const results = new AssistantResults(store.db), source = run(store), other = run(store), allowed = action(source.id), hidden = action(source.id, { summary: 'Private account action' });
  store.db.exec('CREATE TABLE action_intents(id TEXT,run_id TEXT,evidence TEXT)'); store.db.prepare('INSERT INTO action_intents VALUES(?,?,?)').run(hidden.id, source.id, 'Private receipt');
  const [outcome] = results.outcomes([source], [allowed, action(other.id)]);
  assert.deepEqual(outcome.actions, [{ id: allowed.id, summary: allowed.summary, state: allowed.state, evidence: allowed.evidence }]);
  assert.equal(outcome.verification.state, 'unreviewed'); assert.doesNotMatch(JSON.stringify(outcome), /Private/);
  assert.deepEqual(results.outcomes([source], [])[0].actions, []);
  const withoutEvidence: ActionIntent = { ...allowed }; delete (withoutEvidence as ActionIntent & { evidence?: string }).evidence;
  assert.equal(results.outcomes([source], [withoutEvidence])[0].actions[0].evidence, '');
});

test('delegation and continuation use actual scoped parent links instead of conversation or report claims', t => {
  const store = new Store(':memory:'); t.after(() => store.db.close());
  const results = new AssistantResults(store.db), parent = run(store), child = run(store, { agent_id: 'researcher', parent_run_id: parent.id, depth: 1 }), grandchild = run(store, { agent_id: 'writer', parent_run_id: child.id, depth: 2 }), unrelated = run(store), outside = run(store);
  const continuation = run(store, { agent_id: 'assistant', prompt: 'Continue the report' });
  store.db.exec('CREATE TABLE run_contexts(run_id TEXT PRIMARY KEY,purpose TEXT,source_run_id TEXT)');
  store.db.prepare('INSERT INTO run_contexts VALUES(?,?,?)').run(continuation.id, 'continuation', parent.id);
  store.db.prepare('INSERT INTO run_contexts VALUES(?,?,?)').run(unrelated.id, 'continuation', outside.id);
  results.report(child.id, { title: 'Research', summary: 'Sources collected.', delegation: [{ runId: unrelated.id }] });
  const projection = results.outcomes([parent, child, grandchild, unrelated, continuation], []), outcome = projection[0];
  assert.deepEqual(outcome.delegation.map(item => item.runId), [child.id, grandchild.id]); assert.equal(outcome.delegation[0].summary, 'Sources collected.');
  assert.deepEqual(outcome.delegation.map(item => ({ fromAgentId: item.fromAgentId, parentRunId: item.parentRunId, agentId: item.agentId })), [{ fromAgentId: parent.agent_id, parentRunId: parent.id, agentId: child.agent_id }, { fromAgentId: child.agent_id, parentRunId: child.id, agentId: grandchild.agent_id }]);
  assert.deepEqual(projection[1].delegation.map(item => ({ runId: item.runId, fromAgentId: item.fromAgentId, parentRunId: item.parentRunId })), [{ runId: grandchild.id, fromAgentId: child.agent_id, parentRunId: child.id }]);
  assert.equal(outcome.delegation.some(item => item.runId === continuation.id), false);
  assert.equal(projection[1].parentRunId, parent.id); assert.equal(projection[4].sourceRunId, parent.id); assert.equal(projection[3].sourceRunId, null);
  assert.equal(results.outcomes([child], [])[0].parentRunId, null); assert.deepEqual(results.outcomes([parent], [])[0].delegation, []);
  assert.equal(projection[4].delegation.length, 0);
});
