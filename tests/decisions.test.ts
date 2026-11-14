import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SecretStore } from '../runtime/secrets';
import { Credentials } from '../runtime/credentials';
import { CredentialOAuth } from '../runtime/credential-oauth';
import type { CredentialTransport } from '../runtime/credential-http';
import { coordinationToken } from '../runtime/coordination-auth';
import { DECIDE_TOOL, DIRECTORY_TOOL } from '../lib/agent-profile';
import { Decisions, DECISION_DISCLOSURE, RUN_DECISION_LIMIT, type DecisionCaller, type Question } from '../runtime/decisions';

const KEY = 'typesafe-live-key-0123456789';
const operator: DecisionCaller = { kind: 'operator' };
type Sent = { url: URL; method: string; headers: Record<string, string>; allowPrivate?: boolean; body: { model: string; state: unknown; questions: Record<string, Question> } };
type Reply = { status?: number; body: unknown };

// Answers the way the API reference documents, leaning toward the first option as jev-1.13 does.
function jev(body: Sent['body']): Reply {
  const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
    if (question.type === 'choice') {
      const keys = Object.keys(question.criteria), rest = keys.length > 1 ? 0.4 / (keys.length - 1) : 0;
      return [id, { type: 'choice', choice: keys[0], probabilities: Object.fromEntries(keys.map((key, index) => [key, index ? rest : keys.length > 1 ? 0.6 : 1])), confidence: 0.9 }];
    }
    if (question.type === 'noul') return [id, { type: 'noul', noul: JSON.stringify(body.state).includes('match') ? 0.9 : 0.2 }];
    return [id, { type: 'score', score: 7.5, confidence: 0.85, legend: {} }];
  }));
  return { body: { model: 'jev-1.13', answers, usage: { input_tokens: 10, output_tokens: 0 } } };
}

function setup(t: import('node:test').TestContext, options: { now?: () => Date } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'decisions-')), previous = process.env.OPEN_HARNESS_DISABLE_OS_VAULT;
  process.env.OPEN_HARNESS_DISABLE_OS_VAULT = '1';
  const db = new DatabaseSync(':memory:'), secrets = new SecretStore(join(directory, 'secrets.json')), credentials = new Credentials(db, secrets);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); if (previous === undefined) delete process.env.OPEN_HARNESS_DISABLE_OS_VAULT; else process.env.OPEN_HARNESS_DISABLE_OS_VAULT = previous; });
  const sent: Sent[] = [], state = { reply: (body: Sent['body'], count: number): Reply => { void count; return jev(body); } };
  const transport: CredentialTransport = async (url, request) => {
    const body = JSON.parse(request.body || '{}'); sent.push({ url, method: request.method, headers: request.headers, allowPrivate: request.allowPrivate, body });
    const reply = state.reply(body, sent.length);
    return { status: reply.status ?? 200, body: typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body), contentType: 'application/json' };
  };
  const decisions = new Decisions(db, credentials, new CredentialOAuth(credentials), { transport, retryDelayMs: 1, ...options,
    secretValues: () => [secrets.token, ...Object.values(secrets.environment()), ...credentials.rows().flatMap(row => Object.values(credentials.fields(row.ref)))] });
  const enable = (settings: Record<string, unknown> = {}) => {
    if (!credentials.has('TYPESAFE_API_KEY')) credentials.create({ label: 'TypeSafe', ref: 'TYPESAFE_API_KEY', type: 'bearer', fields: { token: KEY } });
    return decisions.saveSettings({ enabled: true, credentialRef: 'TYPESAFE_API_KEY', ...settings }, decisions.settings().revision);
  };
  return { db, secrets, credentials, decisions, sent, state, enable };
}
const refused = (status: number, message: RegExp) => (error: unknown) => { assert.equal((error as { status?: number }).status, status, String(error)); assert.match(String((error as Error).message), message); return true; };
const choose = { op: 'choose', question: 'Which teammate should handle a billing refund?', options: [{ id: 'alpha', text: 'Handles billing and refunds' }, { id: 'bravo', text: 'Reads research papers' }, { id: 'charlie', text: 'Writes release notes' }] };

test('decisions stay off until the operator saves a usable key and turns them on', async t => {
  const { decisions, credentials, sent, enable } = setup(t);
  const status = decisions.status();
  assert.equal(status.settings.enabled, false); assert.equal(status.settings.origin, 'https://api.typesafe.ai'); assert.equal(status.sends, DECISION_DISCLOSURE);
  await assert.rejects(decisions.decide(operator, choose), refused(403, /not turned on/));
  assert.throws(() => decisions.saveSettings({ enabled: true }, 0), /Choose the saved credential/);
  credentials.create({ label: 'Wrong kind', ref: 'QUERY_KEY', type: 'api-key', fields: { value: 'query-key-value-123' }, config: { placement: 'query', parameterName: 'key' } });
  assert.throws(() => decisions.saveSettings({ enabled: true, credentialRef: 'QUERY_KEY' }, 0), /Bearer token or Model API key/);
  for (const origin of ['http://api.typesafe.ai', 'https://api.typesafe.ai/v1', 'https://user:pass@api.typesafe.ai', 'not a url']) assert.throws(() => decisions.saveSettings({ origin }, 0), /address/);
  assert.throws(() => decisions.saveSettings({ dailyLimit: 0 }, 0), /daily limit/);
  assert.throws(() => decisions.saveSettings({ model: 'jev latest; drop' }, 0), /model name/);
  assert.equal(enable().revision, 1);
  assert.throws(() => decisions.saveSettings({ enabled: false }, 0), refused(409, /changed elsewhere/));
  credentials.remove('TYPESAFE_API_KEY');
  await assert.rejects(decisions.decide(operator, choose), refused(409, /no longer exists/));
  assert.equal(sent.length, 0, 'nothing is sent while decisions are off or unusable');
});

test('requests go through the credential transport to one origin, with the key added there and stored secrets removed', async t => {
  const { decisions, secrets, sent, enable } = setup(t);
  enable(); secrets.set('LEGACY_SERVICE_KEY', 'legacy-service-secret-42');
  const result = await decisions.decide(operator, { ...choose, context: `Customer wrote: refund please. Debug dump: ${KEY} ${secrets.token} legacy-service-secret-42 short1` });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url.href, 'https://api.typesafe.ai/v1/systemone'); assert.equal(sent[0].method, 'POST'); assert.equal(sent[0].allowPrivate, false);
  assert.equal(sent[0].headers.authorization, `Bearer ${KEY}`);
  const body = JSON.stringify(sent[0].body);
  for (const secret of [KEY, secrets.token, 'legacy-service-secret-42']) assert.ok(!body.includes(secret), 'a stored secret was sent');
  assert.match(body, /\[redacted\]/); assert.match(body, /short1/, 'values under eight characters are left alone');
  assert.equal(result.redacted, true);
  const pick = sent[0].body.questions.pick as Extract<Question, { type: 'choice' }>;
  assert.equal(sent[0].body.model, 'jev-latest'); assert.equal(pick.type, 'choice'); assert.equal(pick.instructions, choose.question);
  assert.deepEqual(pick.criteria, { alpha: 'Handles billing and refunds', bravo: 'Reads research papers', charlie: 'Writes release notes' });
  assert.deepEqual(result.result, ['alpha']); assert.equal(result.model, 'jev-1.13'); assert.equal(result.decided, true);
});

test('choose offsets position bias with a reversed second pass, returns k options and gates on confidence', async t => {
  const { decisions, sent, enable } = setup(t);
  enable();
  const plain = await decisions.decide(operator, { ...choose, k: 2 });
  assert.deepEqual(plain.result, ['alpha', 'bravo']);
  const debiased = await decisions.decide(operator, { ...choose, k: 2, debias: true });
  assert.deepEqual(Object.keys((sent[2].body.questions.pick as Extract<Question, { type: 'choice' }>).criteria), ['charlie', 'bravo', 'alpha']);
  const probabilities = debiased.probabilities as Record<string, number>;
  assert.equal(probabilities.alpha, probabilities.charlie); assert.ok(probabilities.bravo < probabilities.alpha);
  assert.deepEqual(debiased.result, ['alpha', 'charlie'], 'ties break by ID, so the order is stable');
  const unsure = await decisions.decide(operator, { ...choose, minConfidence: 0.95 });
  assert.equal(unsure.decided, false);
  assert.equal(decisions.list(1)[0].outcome, 'undecided');
});

test('rank, classify, score and check use the documented question types and keep option text out of instructions', async t => {
  const { decisions, sent, enable } = setup(t);
  enable();
  const ranked = await decisions.decide(operator, { op: 'rank', question: 'Is this card about the outage?', context: 'Incident 42', options: [{ id: 'zulu', text: 'Unrelated chore' }, { id: 'yankee', text: 'This is the match' }, { id: 'xray', text: 'Another chore' }] });
  assert.deepEqual(ranked.result, ['yankee', 'xray', 'zulu']); assert.equal(ranked.confidence, null);
  assert.equal(sent.length, 3);
  for (const request of sent) { assert.equal(request.body.questions.fits.type, 'noul'); assert.equal(request.body.questions.fits.instructions, 'Is this card about the outage?'); assert.equal((request.body.state as { context: string }).context, 'Incident 42'); }
  const labelled = await decisions.decide(operator, { op: 'classify', question: 'Keep or drop this result?', labels: ['keep', 'drop'], options: [{ id: 'one', text: 'Relevant passage' }, { id: 'two', text: 'Another passage' }] });
  assert.deepEqual(labelled.result, { one: 'keep', two: 'keep' }); assert.equal(labelled.decided, true); assert.deepEqual(labelled.undecided, []);
  assert.deepEqual((sent.at(-1)!.body.questions.label as Extract<Question, { type: 'choice' }>).criteria, { keep: 'keep', drop: 'drop' });
  const scored = await decisions.decide(operator, { op: 'score', question: 'How complete is this answer?', options: [{ id: 'draft', text: 'A draft' }] });
  assert.deepEqual(scored.result, { draft: 7.5 }); assert.equal((sent.at(-1)!.body.questions.level as Extract<Question, { type: 'score' }>).criteria.length, 5);
  const checked = await decisions.decide(operator, { op: 'check', question: 'Is the task finished?', context: 'Two of five steps are done.' });
  assert.equal(checked.result, false); assert.equal(checked.confidence, 0.8); assert.equal(checked.decided, true);
});

test('answers outside the question are refused and recorded as failures', async t => {
  const { decisions, state, enable } = setup(t);
  enable();
  const bad: Array<Record<string, unknown>> = [
    { pick: { choice: 'zulu', probabilities: { zulu: 1 }, confidence: 0.9 } },
    { pick: { choice: 'alpha', probabilities: { alpha: 0.5, intruder: 0.5 }, confidence: 0.9 } },
    { pick: { choice: 'alpha', probabilities: { alpha: 1 }, confidence: 1.5 } },
    {},
  ];
  for (const answers of bad) {
    state.reply = () => ({ body: { model: 'jev-1.13', answers } });
    await assert.rejects(decisions.decide(operator, choose), refused(424, /outside the question/));
    assert.equal(decisions.list(1)[0].outcome, 'failed');
  }
  state.reply = () => ({ body: 'not json' });
  await assert.rejects(decisions.decide(operator, choose), refused(424, /outside the question/));
});

test('caps, IDs and fields are checked before anything is sent', async t => {
  const { decisions, sent, enable } = setup(t);
  enable();
  const many = (count: number, text = 'x') => Array.from({ length: count }, (_, index) => ({ id: `o${index}`, text }));
  const cases: Array<[unknown, RegExp]> = [
    [{ ...choose, options: many(1) }, /Send 2 to 255/],
    [{ ...choose, options: many(256) }, /Send 2 to 255/],
    [{ ...choose, options: [{ id: 'same', text: 'a' }, { id: 'same', text: 'b' }] }, /unique/],
    [{ ...choose, options: [{ id: '123', text: 'a' }, { id: 'b', text: 'b' }] }, /not be only digits/],
    [{ ...choose, options: [{ id: 'a'.repeat(81), text: 'a' }, { id: 'b', text: 'b' }] }, /1 to 80/],
    [{ ...choose, question: '' }, /question is required/],
    [{ ...choose, question: 'q'.repeat(1001) }, /limited to 1000/],
    [{ ...choose, context: 'c'.repeat(8001) }, /limited to 8000/],
    [{ ...choose, options: [{ id: 'a', text: 't'.repeat(1001) }, { id: 'b', text: 'b' }] }, /limited to 1000/],
    [{ ...choose, pool: 'agents' }, /Unknown field: pool/],
    [{ ...choose, op: 'route' }, /op must be one of/],
    [{ ...choose, op: 'rank', debias: true }, /only used by choose/],
    [{ ...choose, labels: ['a', 'b'] }, /only used by classify/],
    [{ ...choose, k: 4 }, /k must be/],
    [{ op: 'check', question: 'Done?' }, /context is required/],
    [{ op: 'check', question: 'Done?', context: 'x', options: [] }, /takes no options/],
    [{ op: 'classify', question: 'Which?', labels: ['only'], options: many(1) }, /Send 2 to 255 labels/],
    [{ op: 'score', question: 'How good?', levels: ['one'], options: many(1) }, /2 to 10/],
    [{ op: 'rank', question: 'Fits?', context: 'c'.repeat(8000), options: many(200) }, /more than 1 MB/],
  ];
  for (const [input, message] of cases) await assert.rejects(decisions.decide(operator, input), refused(400, message));
  assert.equal(sent.length, 0); assert.equal(decisions.list().length, 0, 'refused input is not recorded');
});

test('daily and per-run limits refuse decisions before sending, and the daily count resets', async t => {
  let now = new Date('2026-10-09T10:00:00Z');
  const { decisions, sent, enable } = setup(t, { now: () => now });
  enable({ dailyLimit: 3 });
  await decisions.decide(operator, { op: 'rank', question: 'Fits?', options: [{ id: 'a', text: 'a' }, { id: 'b', text: 'b' }, { id: 'c', text: 'c' }] });
  await assert.rejects(decisions.decide(operator, choose), refused(429, /daily limit of 3/));
  assert.equal(sent.length, 3);
  now = new Date('2026-10-10T00:00:01Z');
  assert.equal(decisions.usedToday(), 0);
  enable({ dailyLimit: 1000 });
  const agent: DecisionCaller = { kind: 'agent', agentId: 'atlas', runId: 'run-1' };
  for (let index = 0; index < RUN_DECISION_LIMIT; index++) await decisions.decide(agent, { op: 'check', question: 'Done?', context: 'Steps remain.' });
  await assert.rejects(decisions.decide(agent, { op: 'check', question: 'Done?', context: 'Steps remain.' }), refused(429, /This run has used its 30/));
  await decisions.decide({ ...agent, runId: 'run-2' }, { op: 'check', question: 'Done?', context: 'Steps remain.' });
});

test('the audit log keeps metadata and chosen IDs, never the text that was sent', async t => {
  const { decisions, db, enable } = setup(t);
  enable();
  await decisions.decide(operator, { ...choose, context: 'SENSITIVE-CUSTOMER-PHRASE' });
  await decisions.decide({ kind: 'agent', agentId: 'atlas', runId: 'run-9' }, { op: 'check', question: 'PRIVATE-QUESTION?', context: 'PRIVATE-CONTEXT' });
  const rows = JSON.stringify(db.prepare('SELECT * FROM decisions').all());
  for (const text of ['SENSITIVE-CUSTOMER-PHRASE', 'PRIVATE-QUESTION', 'PRIVATE-CONTEXT', 'Handles billing', choose.question]) assert.ok(!rows.includes(text), `audit log kept "${text}"`);
  const [check, chosen] = decisions.list();
  assert.deepEqual(chosen.result, ['alpha']); assert.equal(chosen.caller, 'operator'); assert.equal(chosen.inputTokens, 10); assert.ok(Number(chosen.bytes) > 0);
  assert.equal(check.agentId, 'atlas'); assert.equal(check.runId, 'run-9'); assert.equal(check.result, false);
});

test('busy responses are retried, and provider errors are reported without the key', async t => {
  const { decisions, sent, state, enable } = setup(t);
  enable();
  state.reply = (body, count) => count <= 2 ? { status: 429, body: { error: 'slow down' } } : jev(body);
  assert.deepEqual((await decisions.decide(operator, choose)).result, ['alpha']); assert.equal(sent.length, 3);
  state.reply = () => ({ status: 529, body: {} });
  await assert.rejects(decisions.decide(operator, choose), refused(429, /busy/)); assert.equal(sent.length, 6);
  state.reply = () => ({ status: 401, body: { error: { message: `bad key ${KEY}` } } });
  await assert.rejects(decisions.decide(operator, choose), (error: Error) => { assert.match(error.message, /rejected the saved key/); assert.ok(!error.message.includes(KEY)); return true; });
  state.reply = () => ({ status: 422, body: { detail: `questions.pick: too many options ${KEY}` } });
  await assert.rejects(decisions.decide(operator, choose), (error: Error & { status: number }) => { assert.equal(error.status, 422); assert.match(error.message, /too many options/); assert.ok(!error.message.includes(KEY)); return true; });
});

test('decisions cannot act, and approvals never consult them', () => {
  const root = join(import.meta.dirname, '..'), source = (path: string) => readFileSync(join(root, path), 'utf8');
  const imports = [...source('runtime/decisions.ts').matchAll(/^import .* from '([^']+)';$/gm)].map(match => match[1]);
  assert.deepEqual(imports.sort(), ['../lib/credentials', './credential-api', './credential-http', './credential-oauth', './credentials', 'node:crypto', 'node:sqlite']);
  for (const path of ['runtime/hermes.ts', 'runtime/runner.ts', 'runtime/profile-runtime.ts', 'runtime/hermes/coordination.mjs']) assert.doesNotMatch(source(path), /from ['"][^'"]*decisions['"]/, `${path} imports the decision engine`);
  const service = source('runtime/service.ts'), start = service.indexOf("if (action === 'approval' && req.method === 'POST')");
  assert.ok(start > 0, 'approval handler not found');
  const handler = service.slice(start, service.indexOf('if (action ===', start + 10));
  assert.doesNotMatch(handler, /\bdecisions\b|Decisions|\.decide\(/, 'the approval handler consults the decision engine');
  assert.match(source('runtime/profile-runtime.ts'), /approvals: \{ mode: 'manual'/);
  // A decision is never a permission: nothing but the engine itself may read one back.
  for (const name of readdirSync(join(root, 'runtime')).filter(file => /\.(ts|mjs)$/.test(file) && file !== 'decisions.ts' && file !== 'runner.mjs')) assert.doesNotMatch(source(`runtime/${name}`), /decisionId/, `runtime/${name} reads a decision ID`);
  // A local agent reaches the coordinator through its socket, which refuses any path it does not list.
  const routes = [...source('runtime/hermes/coordination.mjs').match(/^const routes = (.*)$/m)![1].matchAll(/"(\/internal\/[^"]+)"/g)].map(match => match[1]);
  assert.ok(routes.includes('/internal/decide'));
  for (const route of routes) assert.ok(source('runtime/coordination-socket.ts').includes(`'${route}'`), `the coordination socket refuses ${route}`);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
async function service(t: import('node:test').TestContext, port: number) {
  const base = `http://127.0.0.1:${port}`, stateDir = mkdtempSync(join(tmpdir(), 'harness-decisions-'));
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'runtime/service.ts'], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, OPEN_HARNESS_MOCK: '1', OPEN_HARNESS_PORT: String(port), OPEN_HARNESS_STATE_DIR: stateDir, OPEN_HARNESS_DISABLE_OS_VAULT: '1' }, stdio: 'pipe' });
  t.after(async () => { if (child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await exited; } rmSync(stateDir, { recursive: true, force: true }); });
  let token = '';
  for (const deadline = Date.now() + 30_000; !token && Date.now() < deadline;) { try { const response = await fetch(`${base}/v1/bootstrap`); if (response.ok) token = (await response.json() as { token: string }).token; } catch { /* Not listening yet. */ } if (!token) await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.ok(token, 'service did not start');
  const call = async (path: string, method = 'GET', body?: unknown, auth = true) => { const response = await fetch(base + path, { method, headers: { ...(auth ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, value: await response.json() as Json }; };
  const enable = async () => {
    const credential = await call('/v1/credentials', 'POST', { label: 'TypeSafe', type: 'bearer', fields: { token: KEY } });
    assert.equal(credential.status, 201);
    return call('/v1/decisions/settings', 'PUT', { settings: { enabled: true, credentialRef: credential.value.ref }, revision: (await call('/v1/decisions/settings')).value.revision });
  };
  return { token, call, enable };
}

test('the coordinator serves decisions only to the operator, off by default, and contacts nothing in mock mode', async t => {
  const { call, enable } = await service(t, 14331);
  assert.equal((await call('/v1/decisions/settings', 'GET', undefined, false)).status, 401);
  assert.equal((await call('/v1/decide', 'POST', choose, false)).status, 401);
  const initial = await call('/v1/decisions/settings');
  assert.equal(initial.value.settings.enabled, false); assert.equal(initial.value.sends, DECISION_DISCLOSURE);
  assert.equal((await call('/v1/decide', 'POST', choose)).status, 403);
  const saved = await enable();
  assert.equal(saved.status, 200); assert.equal(saved.value.settings.enabled, true);
  const decided = await call('/v1/decide', 'POST', { op: 'choose', question: 'Which agent handles billing refunds?', options: [{ id: 'research', text: 'Reads papers and summarises research' }, { id: 'billing', text: 'Handles billing, refunds and invoices' }] });
  assert.equal(decided.status, 200, JSON.stringify(decided.value)); assert.deepEqual(decided.value.result, ['billing']); assert.match(decided.value.model, /\(mock\)/);
  assert.equal((await call('/v1/decide', 'POST', { op: 'choose' })).status, 400);
  const log = await call('/v1/decisions');
  assert.equal(log.value.decisions.length, 1); assert.equal(log.value.decisions[0].op, 'choose');
  assert.ok(!JSON.stringify(log.value).includes('billing refunds'));
});

test('agents decide only with the Decisions permission, and pools follow the directory and task visibility', async t => {
  const { token, call, enable } = await service(t, 14332);
  await call('/v1/agents/sync', 'POST', { agents: [{ id: 'atlas', name: 'Atlas', role: 'Generalist', instructions: 'Own the result.', config: { model: 'mock' } }, { id: 'scout', name: 'Scout', role: 'Reads research papers', instructions: 'Find sources.', config: { model: 'mock' } }, { id: 'outsider', name: 'Outsider', role: 'Reads research papers too', instructions: 'Elsewhere.', config: { model: 'mock' } }] });
  assert.equal((await call('/v1/teams', 'POST', { name: 'Research', description: 'Papers', color: 'blue', icon: 'people', memberAgentIds: ['atlas', 'scout'] })).status, 201);
  assert.equal((await enable()).status, 200);
  const grant = async (tools: string[]) => { const { profile } = (await call('/v1/agents/atlas/profile')).value; assert.equal((await call('/v1/agents/atlas/profile', 'PUT', { ...profile, allowedTools: [...new Set([...profile.allowedTools.filter((id: string) => id !== DECIDE_TOOL && id !== DIRECTORY_TOOL), ...tools])] })).status, 200); };
  // A run held open on an approval, so the agent's calls come from a live run with a fixed snapshot.
  const live = async () => {
    const run = (await call('/v1/runs', 'POST', { agentId: 'atlas', prompt: 'MOCK_APPROVAL hold a session open' })).value;
    for (const deadline = Date.now() + 30_000; Date.now() < deadline; await new Promise(resolve => setTimeout(resolve, 50))) if ((await call(`/v1/runs/${run.id}/events?after=0`)).value.events.some((item: Json) => item.type === 'approval.request')) break;
    const decide = async (payload: unknown) => { const response = await fetch(`http://127.0.0.1:14332/internal/decide`, { method: 'POST', headers: { Authorization: `Bearer ${coordinationToken(token, 'atlas', 'local')}`, 'X-Open-Harness-Agent': 'atlas', 'X-Open-Harness-Run': run.id, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); return { status: response.status, value: await response.json() as Json }; };
    return { run, decide, stop: () => call(`/v1/runs/${run.id}/stop`, 'POST', {}) };
  };
  const question = { op: 'choose', question: 'Which teammate reads research papers?' };

  await grant([]);
  let session = await live();
  const off = await session.decide({ ...question, options: [{ id: 'a', text: 'a' }, { id: 'b', text: 'b' }] });
  assert.equal(off.status, 403); assert.match(off.value.error, /"Decisions" permission/);
  await session.stop();

  await grant([DECIDE_TOOL]);
  session = await live();
  const pooled = await session.decide({ ...question, pool: 'agents' });
  assert.equal(pooled.status, 403, 'the agents pool needs the same switch as the directory tool'); assert.match(pooled.value.error, /"Teams and agents" permission/);
  assert.equal((await session.decide({ ...question, pool: 'agents', options: [] })).status, 400);
  assert.equal((await session.decide({ ...question, boardId: 'x', options: [{ id: 'a', text: 'a' }, { id: 'b', text: 'b' }] })).status, 400);
  const explicit = await session.decide({ ...question, options: [{ id: 'writer', text: 'Writes release notes' }, { id: 'reader', text: 'Reads research papers' }] });
  assert.equal(explicit.status, 200, JSON.stringify(explicit.value)); assert.deepEqual(explicit.value.result, ['reader']);
  const logged = (await call(`/v1/runs/${session.run.id}/events?after=0`)).value.events.find((item: Json) => item.type === 'decision.made');
  assert.deepEqual(logged.payload.result, ['reader']); assert.ok(!JSON.stringify(logged.payload).includes('research papers'), 'the run log keeps IDs, not text');
  await session.stop();

  await grant([DECIDE_TOOL, DIRECTORY_TOOL]);
  session = await live();
  const team = await session.decide({ ...question, pool: 'agents' });
  assert.equal(team.status, 200, JSON.stringify(team.value));
  assert.deepEqual(Object.keys(team.value.probabilities).sort(), ['atlas', 'scout'], 'only the directory circle: no agent outside a shared team');
  assert.deepEqual(team.value.result, ['scout']);
  const board = (await call('/v1/boards', 'POST', { name: 'Launch', description: 'Ship it.', color: 'blue' })).value;
  const stages = await session.decide({ op: 'choose', question: 'Which stage holds work that is done?', pool: 'stages', boardId: board.id });
  assert.equal(stages.status, 200, JSON.stringify(stages.value));
  assert.deepEqual(Object.keys(stages.value.probabilities).sort(), board.stages.map((stage: Json) => stage.id).sort());
  assert.equal(board.stages.find((stage: Json) => stage.id === stages.value.result[0]).category, 'done');
  assert.equal((await session.decide({ op: 'choose', question: 'Which?', pool: 'stages' })).status, 400);
  const agentRows = (await call('/v1/decisions')).value.decisions.filter((row: Json) => row.caller === 'agent');
  assert.ok(agentRows.length >= 3 && agentRows.every((row: Json) => row.agentId === 'atlas' && row.runId));
  const settings = (await call('/v1/decisions/settings')).value;
  await call('/v1/decisions/settings', 'PUT', { settings: { ...settings.settings, enabled: false }, revision: settings.revision });
  const disabled = await session.decide({ ...question, pool: 'agents' });
  assert.equal(disabled.status, 403); assert.match(disabled.value.error, /not turned on/);
  await session.stop();
});
