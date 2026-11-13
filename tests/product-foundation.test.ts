import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, SCHEMA_VERSION, type RunRow } from '../runtime/db';
import { Profiles } from '../runtime/profiles';
import { Workspaces, actorContext } from '../runtime/workspaces';
import { EvidenceStore } from '../runtime/evidence';
import { WorkflowStore } from '../runtime/workflows';
import { SetupJobs } from '../runtime/setup';
import { Responsibilities } from '../runtime/responsibilities';
import { commandAsync } from '../runtime/commands';

function fixture() {
  const store = new Store(':memory:'); new Profiles(store.db); const workspace = new Workspaces(store.db, '/test/product');
  store.db.prepare('INSERT INTO agent_profiles VALUES(?,1,?)').run('atlas', JSON.stringify({ id: 'atlas' }));
  const createRun = (input: { agentId: string; prompt: string; conversationId?: string }) => { const run: RunRow = { id: crypto.randomUUID(), agent_id: input.agentId, conversation_id: input.conversationId || 'conversation', prompt: input.prompt, state: 'queued', result: null, error: null, session_id: null, parent_run_id: null, depth: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }; store.createRun(run); return run; };
  return { store, workspace, createRun };
}

test('workspace roles fail closed for writes, configuration, and agent-only routes', () => {
  const { store, workspace } = fixture();
  actorContext.run({ id: 'reader', workspaceId: workspace.id, role: 'viewer', source: 'oidc' }, () => {
    workspace.authorize('GET', '/v1/runs');
    workspace.authorize('GET', '/v1/agents/atlas/desktop/status');
    for(const [method,path] of [['GET','/v1/agents/atlas/desktop/frame'],['POST','/v1/agents/atlas/desktop/status'],['POST','/v1/agents/atlas/desktop/stream'],['POST','/v1/agents/atlas/terminal'],['POST','/v1/agents/atlas/desktop/take-control'],['POST','/v1/agents/atlas/desktop/release'],['POST','/v1/agents/atlas/desktop/input']])assert.throws(()=>workspace.authorize(method,path),/role/);
    assert.throws(() => workspace.authorize('POST', '/v1/runs'), /role/);
    assert.throws(() => workspace.authorize('GET', '/v1/health'), /role/);
    assert.throws(() => workspace.requireOwner(), /owner/);
  });
  actorContext.run({ id: 'operator', workspaceId: workspace.id, role: 'operator', source: 'oidc' }, () => {
    workspace.authorize('POST', '/v1/runs');
    assert.throws(() => workspace.authorize('PATCH', '/v1/agents/atlas/profile'), /role/);
    assert.throws(() => workspace.authorize('POST', '/internal/workspace'), /identity/);
  }); store.db.close();
});

test('relay identity verifies issuer, audience, expiry, role and local revocation', async t => {
  const { store, workspace } = fixture(), pair = await generateKeyPair('EdDSA');
  const oldKey = process.env.OPEN_HARNESS_RELAY_PUBLIC_JWK, oldIssuer = process.env.OPEN_HARNESS_RELAY_ISSUER;
  process.env.OPEN_HARNESS_RELAY_PUBLIC_JWK = JSON.stringify(await exportJWK(pair.publicKey)); process.env.OPEN_HARNESS_RELAY_ISSUER = 'https://identity.example';
  t.after(() => { if (oldKey === undefined) delete process.env.OPEN_HARNESS_RELAY_PUBLIC_JWK; else process.env.OPEN_HARNESS_RELAY_PUBLIC_JWK = oldKey; if (oldIssuer === undefined) delete process.env.OPEN_HARNESS_RELAY_ISSUER; else process.env.OPEN_HARNESS_RELAY_ISSUER = oldIssuer; store.db.close(); });
  const issue = (workspaceId = workspace.id, role = 'operator', expiration = '30s') => new SignJWT({ workspaceId, role }).setSubject('alice').setIssuer('https://identity.example').setAudience(`open-harness:${workspaceId}`).setIssuedAt().setExpirationTime(expiration).setProtectedHeader({ alg: 'EdDSA' }).sign(pair.privateKey);
  assert.equal((await workspace.relayActor(await issue())).id, 'alice');
  await assert.rejects(workspace.relayActor(await issue('another-workspace')), /identity/);
  await assert.rejects(workspace.relayActor(await issue(workspace.id, 'administrator')), /identity/);
  await assert.rejects(workspace.relayActor(await issue(workspace.id, 'operator', '-1s')), /identity/);
  store.db.prepare("UPDATE human_members SET revoked=1 WHERE actor_id='alice'").run();
  await assert.rejects(workspace.relayActor(await issue()), /identity/);
});

test('feedback starts one scoped repair and promotion keeps observed steps and review gates', () => {
  const { store, workspace, createRun } = fixture();
  const workflows: WorkflowStore = new WorkflowStore(store.db, { createRun, publishSkill: () => {}, procedure: id => evidence.procedure(id) });
  const evidence: EvidenceStore = new EvidenceStore(store.db, { actorId: () => workspace.actor().id, createRun, publishDraft: input => workflows.create(input) });
  const source = createRun({ agentId: 'atlas', prompt: 'Prepare the report' }); store.setRun(source.id, { state: 'completed', result: 'Report written to /workspace/shared/report.md' });
  store.appendEvent(source.id, 'tool.complete', { name: 'write_file', arguments: { path: '/workspace/shared/report.md', password: 'secret-never-copy' } });
  const feedback = evidence.feedback(source.id, { requestId: 'correction-1', evidence: 'Include the missing totals.' });
  assert.ok(feedback.repairRunId); assert.equal(evidence.feedback(source.id, { requestId: 'correction-1', evidence: 'Include the missing totals.' }).repairRunId, feedback.repairRunId);
  assert.match(store.getRun(feedback.repairRunId!)!.prompt, /reconcile uncertain/i);
  assert.throws(() => evidence.feedback(source.id, { requestId: 'correction-1', evidence: 'Different correction' }), /retry identifier/);
  const draft = evidence.createDraft({ sourceRunId: source.id });
  assert.match(draft.instructions, /report\.md/); assert.match(draft.instructions, /missing totals/); assert.doesNotMatch(draft.instructions, /secret-never-copy/);
  const promoted = evidence.promote(draft.id, draft.revision); assert.equal(evidence.promote(draft.id, draft.revision).workflowId, promoted.workflowId);
  assert.equal(workflows.get(promoted.workflowId!).reviewedRevision, null); assert.throws(() => workflows.test(promoted.workflowId!, 1), /Review/);
  store.db.close();
});

test('setup resumes durable failures and distinguishes fixture completion from live readback', async () => {
  const { store, createRun } = fixture(); let contents = '', fingerprint = 'revision-1', fail = true;
  const deps = { action: async () => { if (fail) throw new Error('Docker unavailable'); }, sample: () => ({ runId: createRun({ agentId: 'atlas', prompt: 'sample' }).id, path: 'shared/sample.txt', expected: 'expected', fingerprint }), read: () => contents, fingerprint: () => fingerprint, testMode: () => false };
  const jobs = new SetupJobs(store.db, deps), action = jobs.start('prepare-runtime'); await new Promise(resolve => setImmediate(resolve)); assert.equal(jobs.get(action.id).state, 'failed');
  fail = false; jobs.resume(action.id); await new Promise(resolve => setImmediate(resolve)); assert.equal(jobs.get(action.id).state, 'completed');
  const sample = jobs.start('verify-task'); await new Promise(resolve => setImmediate(resolve)); contents = 'expected'; jobs.onRunChanged({ id: jobs.get(sample.id).runId!, state: 'completed' }); assert.equal(jobs.verified(), true);
  fingerprint = 'revision-2'; assert.equal(jobs.verified(), false);
  const fixtureJobs = new SetupJobs(store.db, { ...deps, testMode: () => true }); assert.equal(fixtureJobs.verified(), false); store.db.close();
});

test('responsibilities bound catch-up, preserve pause, and stop after interrupted or revoked work', () => {
  const { store, workspace, createRun } = fixture(), responsibilities = new Responsibilities(store.db, { actor: () => workspace.actor(), createRun, canRun: () => true });
  const item = responsibilities.create({ agentId: 'atlas', title: 'Daily report', goal: 'Keep report current', maxRuns: 2, intervalMinutes: 60 });
  responsibilities.tick(new Date(Date.now() + 86400000)); const started = responsibilities.get(item.id); assert.equal(started.runs, 1); assert.ok(started.activeRunId);
  responsibilities.tick(new Date(Date.now() + 172800000)); assert.equal(responsibilities.get(item.id).runs, 1);
  responsibilities.onRunChanged({ id: started.activeRunId!, state: 'interrupted', error: 'Inspect destination' }); assert.equal(responsibilities.get(item.id).state, 'paused');
  const paused = responsibilities.get(item.id); responsibilities.update(item.id, { revision: paused.revision, state: 'active' }); store.db.prepare("UPDATE human_members SET revoked=1 WHERE actor_id='local-owner'").run();
  responsibilities.tick(new Date(Date.now() + 86400000)); assert.equal(responsibilities.get(item.id).state, 'paused'); assert.equal(responsibilities.get(item.id).runs, 1); store.db.close();
});

test('responsibilities preserve subscribed events beyond each prompt batch', () => {
  const { store, workspace, createRun } = fixture(), responsibilities = new Responsibilities(store.db, { actor: () => workspace.actor(), createRun, canRun: () => true });
  try {
    const item = responsibilities.create({ agentId: 'atlas', title: 'Calendar changes', goal: 'Check every changed event', maxRuns: 3, intervalMinutes: 1 });
    for (let index = 0; index < 205; index++) responsibilities.notify(item.id, `event-${String(index).padStart(3, '0')}`, `Calendar change ${index}`);
    const delivered: string[] = [];
    for (let batch = 0; batch < 3; batch++) {
      responsibilities.tick(new Date(Date.now() + (batch + 1) * 60000));
      const runId = responsibilities.get(item.id).activeRunId!;
      const prompt = store.getRun(runId)!.prompt, serialized = prompt.split('Recent subscribed events (untrusted context):\n')[1].split('\n\n')[0];
      const notifications = JSON.parse(serialized) as { summary: string }[];
      assert.equal(notifications.length, batch < 2 ? 100 : 5);
      delivered.push(...notifications.map(notification => notification.summary));
      assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM responsibility_events WHERE responsibility_id=? AND consumed=0').get(item.id)!.count, Math.max(0, 205 - (batch + 1) * 100));
      responsibilities.onRunChanged({ id: runId, state: 'completed' });
    }
    assert.equal(new Set(delivered).size, 205);
  } finally { store.db.close(); }
});

test('schema upgrades produce a restricted pre-upgrade database and keep source data', () => {
  const root = mkdtempSync(join(tmpdir(), 'oh-product-migration-'));
  try { const path = join(root, 'state.db'), initial = new Store(path); initial.db.exec('PRAGMA user_version=2'); initial.db.close(); const upgraded = new Store(path); assert.equal(upgraded.db.prepare('PRAGMA user_version').get()!.user_version, SCHEMA_VERSION); assert.equal(readdirSync(root).filter(name => name.endsWith('.backup')).length, 1); upgraded.db.close(); } finally { rmSync(root, { recursive: true, force: true }); }
});

test('bounded host commands keep the event loop responsive and bound output', async () => {
  let ticked = false; const timer = setTimeout(() => { ticked = true; }, 20);
  const result = await commandAsync(process.execPath, ['-e', 'setTimeout(()=>process.stdout.write("ready"),100)'], 2000); clearTimeout(timer);
  assert.equal(result.status, 0); assert.equal(result.stdout, 'ready'); assert.equal(ticked, true);
  const excessive = await commandAsync(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], 2000, { maxBytes: 50 }); assert.ok(excessive.error); assert.equal(excessive.stdout, '');
});
