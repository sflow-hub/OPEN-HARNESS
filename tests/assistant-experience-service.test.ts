import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { initialWorkspace } from '../lib/types';
import { PRIMARY_ASSISTANT_ID } from '../lib/product';
import type { StarterInput } from '../lib/assistant-starters';
import type { AssistantOutcome } from '../lib/assistant-overview';

test('assistant starters, result evidence, personal notes, and attention settings remain explicit and durable', { timeout: 90000 }, async t => {
  const state = mkdtempSync(join(tmpdir(), 'oh-assistant-experience-')), base = 'http://127.0.0.1:14697', workspaceId = 'assistant-experience-fixture', issuer = 'https://assistant-experience.test';
  const pair = await generateKeyPair('EdDSA'), publicKey = JSON.stringify(await exportJWK(pair.publicKey));
  let child: ChildProcess | undefined, db: DatabaseSync | undefined, token = '', output = '', shared = false;
  async function stop() { if (child && child.exitCode === null && child.signalCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; } }
  t.after(async () => { db?.close(); await stop(); rmSync(state, { recursive: true, force: true }); });
  async function start() {
    output = ''; child = spawn(process.execPath, ['--import', 'tsx', 'runtime/service.ts'], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, OPEN_HARNESS_MOCK: '1', OPEN_HARNESS_DISABLE_OS_VAULT: '1', OPEN_HARNESS_STATE_DIR: state, OPEN_HARNESS_PORT: '14697', OPEN_HARNESS_BIND: '127.0.0.1', OPEN_HARNESS_WORKSPACE_ID: workspaceId, OPEN_HARNESS_EDITION: 'self-hosted', OPEN_HARNESS_REQUIRE_BROWSER_PAIRING: '0', OPEN_HARNESS_REQUIRE_RELAY_IDENTITY: shared ? '1' : '0', OPEN_HARNESS_RELAY_ISSUER: issuer, OPEN_HARNESS_RELAY_PUBLIC_JWK: publicKey }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', value => { output += value; }); child.stderr?.on('data', value => { output += value; });
    for (const deadline = Date.now() + 30000; Date.now() < deadline;) {
      if (child.exitCode !== null) throw new Error(`Assistant fixture exited: ${output}`);
      try { const response = await fetch(base + (shared ? '/v1/ready' : '/v1/bootstrap')); if (response.ok) { if (!shared) token = (await response.json()).token; return; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error(`Assistant fixture did not start: ${output}`);
  }
  const request = (path: string, method = 'GET', input?: unknown, extra: Record<string, string> = {}) => fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  async function data(path: string, method = 'GET', input?: unknown, extra: Record<string, string> = {}) { const response = await request(path, method, input, extra), value = await response.json(); assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`); return value; }
  async function waitForRun(id: string, state: string) {
    for (const deadline = Date.now() + 20000; Date.now() < deadline;) { const run = await data(`/v1/runs/${id}`); if (run.state === state) return run; if (['failed', 'cancelled', 'interrupted'].includes(run.state)) throw new Error(`Task ended as ${run.state}: ${run.error}`); await new Promise(resolve => setTimeout(resolve, 30)); }
    throw new Error(`Task ${id} did not reach ${state}.`);
  }
  const material: StarterInput = { starterId: 'material-brief', connectionIds: [], inputs: { material: 'MOCK_CLARIFY. Dedicated fixture notes for a short brief.', deliverable: 'A one-page draft with sources' }, requestId: 'brief-submission' };
  let sourceId = '', newestDayId = '';
  await start(); db = new DatabaseSync(join(state, 'state.db'));

  await t.test('preview is side-effect free; activation and starter retries use the normal durable submission path', async () => {
    const catalog = await data('/v1/assistant/starters'); assert.deepEqual(catalog.starters.map((item: { id: string }) => item.id), ['prepare-day', 'material-brief', 'research-draft']); assert.deepEqual(catalog.agents, []);
    const before = await data('/v1/assistant'), preview = await data('/v1/assistant/starters/preview', 'POST', material);
    assert.match(preview.prompt, /Guided starter: material-brief/); assert.match(preview.prompt, /Do not send or publish/);
    const after = await data('/v1/assistant'); assert.equal(after.profile, before.profile); assert.deepEqual(after.runs, before.runs); assert.equal(after.overview.latestBriefRunId, null);
    await data('/v1/agents/sync', 'POST', { agents: initialWorkspace.agents });
    const activated = await data('/v1/assistant/activate', 'POST', {}); assert.equal(activated.profile.computer.access, 'private'); assert.equal(activated.profile.allowedTools.includes('write_file'), false);
    const available = await data('/v1/assistant/starters'); assert.ok(available.agents.some((agent: { id: string }) => agent.id === 'atlas')); assert.ok(available.agents.every((agent: { id: string }) => agent.id !== PRIMARY_ASSISTANT_ID));
    const missing = await request('/v1/assistant/starters', 'POST', { starterId: 'prepare-day', connectionIds: [], inputs: { window: 'Today', inboxQuery: 'in:inbox' }, requestId: 'missing-apps' }); assert.equal(missing.status, 409); assert.match((await missing.json()).error, /Gmail.*Calendar/);
    const [first, retry] = await Promise.all([data('/v1/assistant/starters', 'POST', material), data('/v1/assistant/starters', 'POST', material)]); sourceId = first.id; assert.equal(retry.id, first.id);
    assert.equal((await request('/v1/assistant/starters', 'POST', { ...material, inputs: { ...material.inputs, deliverable: 'A changed deliverable' } })).status, 409);
    const active = await waitForRun(first.id, 'waiting_input'); assert.equal(active.agent_id, PRIMARY_ASSISTANT_ID);
    assert.equal(db!.prepare('SELECT COUNT(*) AS count FROM assistant_starter_runs').get()!.count, 1);
  });

  await t.test('explicit result references survive completion without becoming verified or fabricated artifacts', async () => {
    const agentHeaders = { Authorization: `Bearer ${createHmac('sha256', token).update(`agent:${PRIMARY_ASSISTANT_ID}`).digest('hex')}`, 'x-open-harness-agent': PRIMARY_ASSISTANT_ID, 'x-open-harness-run': sourceId };
    const report = { title: 'Fixture brief', summary: 'A reported draft awaiting independent review.', artifacts: [{ label: 'Reported draft', kind: 'file', path: 'fixture-brief.md' }], sources: [{ label: 'Fixture source', url: 'https://example.test/source' }] };
    assert.equal((await request('/internal/workspace', 'POST', { action: 'report_result', input: report })).status, 403);
    assert.equal((await request('/internal/workspace', 'POST', { action: 'report_result', input: { ...report, artifacts: [{ label: 'Unsafe', kind: 'file', path: '../secrets.json' }] } }, agentHeaders)).status, 400);
    assert.equal((await request('/internal/workspace', 'POST', { action: 'report_result', input: { ...report, sources: [{ label: 'Unsafe', url: 'javascript:alert(1)' }] } }, agentHeaders)).status, 400);
    await data('/internal/workspace', 'POST', { action: 'report_result', input: report }, agentHeaders);
    const streamReport = () => {
      const body=JSON.stringify({action:'report_result',input:{...report,title:'Late streamed rewrite',summary:'This body completed after permission changed.'}});let pending!:ReturnType<typeof httpRequest>;
      const response=new Promise<{status:number;body:string}>((resolve,reject)=>{pending=httpRequest(base+'/internal/workspace',{method:'POST',headers:{...agentHeaders,'Content-Type':'application/json'}},reply=>{let body='';reply.setEncoding('utf8');reply.on('data',chunk=>{body+=chunk;});reply.on('end',()=>resolve({status:reply.statusCode||0,body}));});pending.on('error',reject);});
      pending.write(body.slice(0,-1));return {response,finish:()=>pending.end(body.slice(-1)),destroy:()=>pending.destroy()};
    };
    const revoked = streamReport();
    try {await data(`/v1/runs/${sourceId}`);db!.prepare("UPDATE human_members SET revoked=1 WHERE actor_id='local-owner'").run();revoked.finish();const reply=await revoked.response;assert.equal(reply.status,403);assert.match(reply.body,/permission/);}
    finally {db!.prepare("UPDATE human_members SET revoked=0 WHERE actor_id='local-owner'").run();revoked.destroy();}
    const delayed = streamReport();
    try {
      // A second request crosses the server event loop while the report still waits for its body.
      const active = await data(`/v1/runs/${sourceId}`); await data(`/v1/runs/${sourceId}/input`, 'POST', { inputId: active.pendingInputs[0].inputId, value: 'Finish the fixture' }); await waitForRun(sourceId, 'completed');
      delayed.finish(); const late=await delayed.response;assert.equal(late.status,403);assert.match(late.body,/Only the active task/);
    } finally {delayed.destroy();}
    const overview = (await data('/v1/assistant')).overview, outcome = overview.outcomes.find((item: AssistantOutcome) => item.runId === sourceId) as AssistantOutcome;
    assert.equal(typeof overview.generatedAt, 'string'); assert.match(overview.availability.detail, /coordinator.*execution computer.*powered/);
    assert.equal(outcome.title, report.title); assert.deepEqual(outcome.artifacts, report.artifacts); assert.deepEqual(outcome.sources, report.sources); assert.equal(outcome.verification.state, 'unreviewed'); assert.equal(outcome.verification.checkedAt, null); assert.equal(outcome.verification.evidence, ''); assert.deepEqual(outcome.delegation, []);
    assert.equal((await request('/internal/workspace', 'POST', { action: 'report_result', input: { ...report, summary: 'Late rewrite' } }, agentHeaders)).status, 403);
    await data(`/v1/runs/${sourceId}/outcome`, 'POST', { accepted: false, evidence: 'Fixture: the reported artifact has not been created; report metadata is not proof.' });
    const rejected = (await data('/v1/assistant')).overview.outcomes.find((item: AssistantOutcome) => item.runId === sourceId); assert.equal(rejected.verification.state, 'needs_changes'); assert.match(rejected.verification.evidence, /metadata is not proof/);
  });

  await t.test('day selection uses explicitly shared fixture accounts and latest brief never invents source readback', async () => {
    // These account rows exercise selection only; mock Hermes never contacts Google or reads a real account.
    for (const app of ['gmail', 'calendar']) db!.prepare('INSERT INTO app_connections VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(`fixture-${app}`, app, `${app}@example.test`, 'local-owner', JSON.stringify([PRIMARY_ASSISTANT_ID]), '[]', 'connected', null, 'UNUSABLE_FIXTURE_CREDENTIAL', 0, new Date().toISOString());
    const day = { starterId: 'prepare-day', connectionIds: ['fixture-gmail', 'fixture-calendar'], inputs: { window: 'Today in America/Denver', inboxQuery: 'in:inbox' }, requestId: 'day-first' };
    const first = await data('/v1/assistant/starters', 'POST', day); await waitForRun(first.id, 'completed');
    const second = await data('/v1/assistant/starters', 'POST', { ...day, requestId: 'day-second', inputs: { ...day.inputs, window: 'Tomorrow in America/Denver' } }); newestDayId = second.id; await waitForRun(second.id, 'completed');
    const overview = (await data('/v1/assistant')).overview; assert.equal(overview.latestBriefRunId, second.id);
    const outcome = overview.outcomes.find((item: AssistantOutcome) => item.runId === second.id); assert.deepEqual(outcome.sources, []); assert.deepEqual(outcome.artifacts, []); assert.equal(outcome.verification.state, 'unreviewed');
    assert.equal(db!.prepare('SELECT COUNT(*) AS count FROM action_intents').get()!.count, 0); assert.equal(db!.prepare('SELECT COUNT(*) AS count FROM responsibilities').get()!.count, 0);
  });

  await t.test('notes compare revisions across both fields and forget only the selected agent; notification drafts conflict safely', async () => {
    const path = `/v1/agents/${PRIMARY_ASSISTANT_ID}/context`, original = await data(path), other = await data('/v1/agents/atlas/context'); assert.equal(typeof original.revision, 'string');
    const saved = await data(path, 'PUT', { revision: original.revision, memory: 'Keep reports short.', user: 'My time zone is America/Denver.' }); assert.notEqual(saved.revision, original.revision);
    assert.equal((await request(path, 'PUT', { revision: original.revision, memory: 'Stale draft', user: 'Stale preferences' })).status, 409);
    assert.equal((await request(path, 'PUT', { user: 'Missing revision' })).status, 409);
    const current = await data(path); assert.equal(current.memory, 'Keep reports short.'); assert.equal(current.user, 'My time zone is America/Denver.');
    await data(path, 'PUT', { revision: current.revision, memory: '', user: '' }); const forgotten = await data(path); assert.equal(forgotten.memory, ''); assert.equal(forgotten.user, '');
    const untouched = await data('/v1/agents/atlas/context'); assert.equal(untouched.memory, other.memory); assert.equal(untouched.user, other.user); assert.equal(untouched.revision, other.revision);
    const preferences = await data('/v1/assistant/preferences'); assert.deepEqual(preferences, { revision: 0, completionNotifications: true });
    assert.deepEqual(await data('/v1/assistant/preferences', 'PATCH', { revision: 0, completionNotifications: false }), { revision: 1, completionNotifications: false });
    assert.equal((await request('/v1/assistant/preferences', 'PATCH', { revision: 0, completionNotifications: true })).status, 409);
    assert.equal((await request('/v1/assistant/preferences', 'PATCH', { revision: 1, completionNotifications: 'false' })).status, 400);
    assert.deepEqual(await data('/v1/assistant/preferences'), { revision: 1, completionNotifications: false });
    const noRepair = await data(`/v1/runs/${sourceId}/feedback`, 'POST', { requestId: 'remember-correction', repair: false, evidence: 'Do not call a reported artifact complete before it exists.' }); assert.equal(noRepair.repairRunId, null);
    const draft = await data('/v1/workflow-drafts', 'POST', { sourceRunId: sourceId }); assert.match(draft.instructions, /reported artifact complete/);
  });

  await t.test('restart preserves results and preferences; scoped viewers cannot mutate the new experience', async () => {
    db!.close(); db = undefined; await stop(); shared = true; await start();
    const assertion = (id: string, role: 'owner' | 'operator' | 'viewer') => new SignJWT({ workspaceId, role }).setSubject(id).setIssuer(issuer).setAudience(`open-harness:${workspaceId}`).setIssuedAt().setExpirationTime('60s').setProtectedHeader({ alg: 'EdDSA' }).sign(pair.privateKey);
    const owner = { 'x-open-harness-context': await assertion('local-owner', 'owner') }, viewer = { 'x-open-harness-context': await assertion('viewer-fixture', 'viewer') }, operator = { 'x-open-harness-context': await assertion('operator-fixture', 'operator') };
    assert.deepEqual(await data('/v1/assistant/preferences', 'GET', undefined, owner), { revision: 1, completionNotifications: false });
    const overview = (await data('/v1/assistant', 'GET', undefined, owner)).overview; assert.equal(overview.latestBriefRunId, newestDayId); assert.equal(overview.outcomes.find((item: AssistantOutcome) => item.runId === sourceId).verification.state, 'needs_changes');
    assert.equal((await data('/v1/assistant/starters', 'GET', undefined, operator)).starters.length, 3);
    assert.deepEqual(await data('/v1/assistant/preferences', 'GET', undefined, operator), { revision: 0, completionNotifications: true });
    for (const [path, method, input] of [
      ['/v1/assistant/starters', 'POST', material], ['/v1/assistant/starters/preview', 'POST', material], ['/v1/assistant/preferences', 'PATCH', { revision: 0, completionNotifications: false }], [`/v1/agents/${PRIMARY_ASSISTANT_ID}/context`, 'PUT', { memory: 'Viewer edit' }],
    ] as const) assert.equal((await request(path, method, input, viewer)).status, 403, `${method} ${path}`);
  });
});
