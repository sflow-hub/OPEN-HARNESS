/* eslint-disable @typescript-eslint/no-explicit-any */
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { HostedD1 } from './helpers/hosted-d1';
import { decryptRunnerSecret, generateRunnerKeyPair } from '../lib/runner-crypto';

const environment: { DB?: HostedD1 } = {};
Object.assign(globalThis, { __hostedTestEnvironment: environment });
let handler: (request: Request, context: { params: Promise<{ path: string[] }> }) => Promise<Response>;
let db: HostedD1;
const capabilities = { container: true, direct: true, desktop: false, virtualDesktop: true };
const model = { provider: 'openai-compatible', model: 'local-test', credentialRef: '', baseUrl: 'http://localhost:11434/v1' };
test.before(async () => {
  const result = await build({
    entryPoints: [resolve('app/api/control/[...path]/route.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false,
    plugins: [{ name: 'hosted-test-bindings', setup(build) {
      build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'worker-env', namespace: 'hosted-test' }));
      build.onLoad({ filter: /.*/, namespace: 'hosted-test' }, () => ({ contents: 'export const env = globalThis.__hostedTestEnvironment;' }));
      build.onResolve({ filter: /\?raw$/ }, args => ({ path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'raw-text' }));
      build.onLoad({ filter: /.*/, namespace: 'raw-text' }, async args => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' }));
    } }],
  });
  handler = (await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)).GET;
});
test.beforeEach(() => { db = new HostedD1(); environment.DB = db; });
test.afterEach(() => db.close());
async function call(path: string, body?: unknown, headers: HeadersInit = { 'oai-authenticated-user-id': 'operator' }, method = body === undefined ? 'GET' : 'POST') {
  const response = await handler(new Request(`https://harness.example/api/control${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), { params: Promise.resolve({ path: path.split('?')[0].slice(1).split('/') }) });
  return { status: response.status, body: await response.json() as any };
}
async function request(path: string, body?: unknown, headers?: HeadersInit, method?: string) {
  const result = await call(path, body, headers, method);
  assert.ok(result.status < 400, `${path}: ${result.status} ${JSON.stringify(result.body)}`);
  return result.body;
}
async function pair(name = 'Runner', encryptionPublicKey?: string) {
  const pairing = await request('/v1/machines', { name, platform: 'linux' });
  const code = pairing.command.match(/--pairing-code '([^']+)'/)[1];
  const machine = await request('/v1/runner/pair', { code, capabilities, encryptionPublicKey }, {});
  return { ...machine, headers: { Authorization: `Bearer ${machine.token}`, 'x-open-harness-machine': machine.machineId } };
}

async function nextCommand(machine: any, kind: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const commands = (await request('/v1/runner/commands', undefined, machine.headers)).commands;
    const command = commands.find((command: any) => command.kind === kind);
    if (command) return command;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Runner did not receive ${kind}`);
}
async function complete(machine: any, command: any, result?: unknown, error?: string) {
  return request(`/v1/runner/commands/${command.id}/complete`, { result, error }, machine.headers);
}
async function emit(machine: any, command: any, type: string, payload: unknown) {
  return request(`/v1/runner/commands/${command.id}/events`, { runId: command.payload.runId, eventId: crypto.randomUUID(), event: { type, payload } }, machine.headers);
}
async function agent(agentId: string, machineId?: string) {
  await request('/v1/agents/sync', { agents: [{ id: agentId, name: agentId, role: 'Generalist', description: '', tone: 0, instructions: 'Complete the task.' }] });
  const result = await request(`/v1/agents/${agentId}/profile`);
  if (!machineId) return result.profile;
  return (await request(`/v1/agents/${agentId}/profile`, { ...result.profile, computer: { ...result.profile.computer, machineId } }, undefined, 'PUT')).profile;
}

test('hosted first assignment and workspace model inheritance work without a source transfer', async () => {
  const machine = await pair();
  const profile = await agent('atlas', machine.machineId);
  assert.equal(profile.computer.machineId, machine.machineId);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM agent_transfers').get()!.n, 0);
  await request('/v1/workspace/model', { model, revision: 0 }, undefined, 'PUT');
  assert.deepEqual((await request('/v1/agents/atlas/profile')).effectiveModel, model);
  const run = await request('/v1/runs', { agentId: 'atlas', prompt: 'Hello' });
  assert.equal(run.state, 'running');
  const command = (await request('/v1/runner/commands', undefined, machine.headers)).commands[0];
  assert.deepEqual(command.payload.snapshot.effectiveModel, model);
  assert.equal(command.payload.snapshot.workspaceRevision, 1);
  assert.equal((await call('/v1/workspace/model', { model, revision: 0 }, undefined, 'PUT')).status, 409);
});

test('queued runs snapshot the latest profile and model only when they start', async () => {
  const machine = await pair();
  let profile = await agent('atlas', machine.machineId);
  db.sqlite.prepare("UPDATE machines SET last_seen_at='2000-01-01T00:00:00.000Z'").run();
  const run = await request('/v1/runs', { agentId: 'atlas', prompt: 'Wait' });
  assert.equal(run.state, 'queued');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM run_snapshots').get()!.n, 0);
  profile = (await request('/v1/agents/atlas/profile', { ...profile, prompt: { enabled: true, text: 'Latest instruction' } }, undefined, 'PUT')).profile;
  await request('/v1/workspace/model', { model, revision: 0 }, undefined, 'PUT');
  await Promise.all([request('/v1/runner/heartbeat', { capabilities }, machine.headers), request('/v1/runner/heartbeat', { capabilities }, machine.headers)]);
  const commands = (await request('/v1/runner/commands', undefined, machine.headers)).commands;
  assert.equal(commands.length, 1);
  assert.equal(commands[0].payload.snapshot.revision, profile.revision);
  assert.equal(commands[0].payload.snapshot.prompt.text, 'Latest instruction');
  assert.deepEqual(commands[0].payload.snapshot.effectiveModel, model);
});

test('queued work follows an agent after a verified computer transfer', async () => {
  const source = await pair('Source'), destination = await pair('Destination');
  const profile = await agent('atlas', source.machineId);
  const first = await request('/v1/runs', { agentId: 'atlas', prompt: 'First task' });
  const firstCommand = await nextCommand(source, 'run');
  const queued = await request('/v1/runs', { agentId: 'atlas', prompt: 'Next task' });
  const saved = await request('/v1/agents/atlas/profile', { ...profile, computer: { ...profile.computer, machineId: destination.machineId } }, undefined, 'PUT');
  assert.equal(saved.activeRevision, profile.revision);
  assert.equal(saved.pending, true);
  assert.equal(saved.profile.computer.machineId, source.machineId);
  await complete(source, firstCommand, { text: 'Done' });
  assert.equal((await request(`/v1/runs/${first.id}`)).state, 'completed');
  await Promise.all([request('/v1/runner/heartbeat', { capabilities }, source.headers), request('/v1/runner/heartbeat', { capabilities }, source.headers)]);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM runner_commands WHERE kind='export-agent'").get()!.n, 1);
  await complete(source, await nextCommand(source, 'export-agent'), { files: [], checksum: 'verified-checksum' });
  await complete(destination, await nextCommand(destination, 'import-agent'), { validated: true, checksum: 'verified-checksum', files: 0 });
  await request('/v1/runner/heartbeat', { capabilities }, destination.headers);
  const command = await nextCommand(destination, 'run');
  assert.equal(command.payload.runId, queued.id);
  assert.equal(command.payload.snapshot.computer.machineId, destination.machineId);
  assert.equal((await request(`/v1/runs/${queued.id}`)).machine_id, destination.machineId);
});

test('concurrent requests preserve agent and workspace dispatch limits', async () => {
  const machine = await pair();
  for (const name of ['atlas', 'nova', 'sage', 'ember']) await agent(name, machine.machineId);
  const runs = await Promise.all(['atlas', 'atlas', 'nova', 'sage', 'ember'].map(agentId => request('/v1/runs', { agentId, prompt: 'Do work' })));
  assert.equal(runs.filter(run => run.state === 'running').length, 2);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM runs WHERE agent_id='atlas' AND state='running'").get()!.n, 1);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM runner_commands WHERE kind='run'").get()!.n, 2);
});

test('machine concurrency and existing desktop ownership are claimed atomically', async () => {
  const machine = await pair();
  for (const name of ['atlas', 'nova']) {
    const profile = await agent(name, machine.machineId);
    await request(`/v1/agents/${name}/profile`, { ...profile, computer: { ...profile.computer, access: 'direct', desktop: 'existing' } }, undefined, 'PUT');
  }
  await Promise.all(['atlas', 'nova'].map(agentId => request('/v1/runs', { agentId, prompt: 'Use desktop' })));
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM runs WHERE state='running'").get()!.n, 1);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM runner_commands WHERE kind='run'").get()!.n, 1);
});

test('a runner can only publish events for the run owned by its command', async () => {
  const machine = await pair(), other = await pair('Other');
  await agent('atlas', machine.machineId); await agent('nova', other.machineId);
  const run = await request('/v1/runs', { agentId: 'atlas', prompt: 'Own run' });
  const target = await request('/v1/runs', { agentId: 'nova', prompt: 'Other run' });
  const command = (await request('/v1/runner/commands', undefined, machine.headers)).commands[0];
  const path = `/v1/runner/commands/${command.id}/events`, event = { type: 'approval.request', payload: { request_id: 'gateway-1', command: 'touch test' } };
  assert.equal((await call(path, { runId: target.id, eventId: 'forged', event }, machine.headers)).status, 403);
  assert.equal((await request(`/v1/runs/${target.id}`)).state, 'running');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM approvals').get()!.n, 0);
  await Promise.all([request(path, { runId: run.id, eventId: 'approved-event', event }, machine.headers), request(path, { runId: run.id, eventId: 'approved-event', event }, machine.headers)]);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM approvals').get()!.n, 1);
  assert.equal((await request(`/v1/runs/${run.id}`)).state, 'waiting_approval');
  const recovered = await request(`/v1/runs/${run.id}`);
  assert.equal(recovered.pendingApprovals.length, 1);
  assert.equal(recovered.pendingApprovals[0].payload.command, 'touch test');
});

test('task starts are idempotent and card movement, task tools, and task stops work', async () => {
  const machine = await pair(); await agent('atlas', machine.machineId);
  const task = await request('/v1/tasks', { boardId: 'default-board', title: 'Deliver report', ownerAgentId: 'atlas' });
  const started = await Promise.all([request(`/v1/tasks/${task.id}/start`, { idempotencyKey: 'attempt-one', revision: task.revision }), request(`/v1/tasks/${task.id}/start`, { idempotencyKey: 'attempt-one', revision: task.revision })]);
  assert.equal(started[0].run.id, started[1].run.id);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM runs').get()!.n, 1);
  assert.equal((await call(`/v1/tasks/${task.id}/move`, { stageId: 'default-done' })).status, 409);
  const command = await nextCommand(machine, 'run');
  const agentHeaders = { Authorization: `Bearer ${command.payload.coordinationToken}`, 'x-open-harness-agent': 'atlas', 'x-open-harness-run': started[0].run.id };
  const updated = await request('/internal/task', { action: 'additem', taskId: task.id, input: { text: 'Verify the report' } }, agentHeaders);
  await request('/internal/task', { action: 'check', taskId: task.id, input: { item: updated.checklist[0].id, done: true } }, agentHeaders);
  assert.equal((await request(`/v1/tasks/${task.id}`)).checklist[0].done, true);
  assert.equal((await call('/internal/task', { action: 'update', taskId: task.id, input: { ownerAgentId: 'nova' } }, agentHeaders)).status, 403);
  await request(`/v1/tasks/${task.id}/stop`, {});
  const stop = await nextCommand(machine, 'stop'); await complete(machine, stop, { stopped: true });
  assert.equal((await request(`/v1/tasks/${task.id}`)).activeRunId, null);
  await complete(machine, command, { text: 'Late result' });
  assert.equal((await request(`/v1/runs/${started[0].run.id}`)).state, 'cancelled');
  const moved = await request(`/v1/tasks/${task.id}/move`, { stageId: 'default-ready', position: 12 });
  assert.equal(moved.stageId, 'default-ready');
  const restarted = await request(`/v1/tasks/${task.id}/move`, { stageId: 'default-in_progress' });
  assert.ok(restarted.activeRunId);
});

test('parent stop includes delegated descendants and queued runs can be cancelled', async () => {
  const machine = await pair();
  const profile = await agent('atlas', machine.machineId); await agent('nova', machine.machineId);
  await request('/v1/agents/atlas/profile', { ...profile, allowedTools: [...profile.allowedTools, 'mcp_open_harness_delegate_named_agent'] }, undefined, 'PUT');
  const parent = await request('/v1/runs', { agentId: 'atlas', prompt: 'Delegate' });
  const command = await nextCommand(machine, 'run');
  const headers = { Authorization: `Bearer ${command.payload.coordinationToken}`, 'x-open-harness-agent': 'atlas', 'x-open-harness-run': parent.id };
  const child = await request('/internal/handoff', { agentId: 'nova', prompt: 'Research' }, headers);
  const childCommand = await nextCommand(machine, 'run');
  const queued = await request('/v1/runs', { agentId: 'atlas', prompt: 'Later' });
  assert.equal(queued.state, 'queued');
  assert.equal((await request(`/v1/runs/${queued.id}/stop`, {})).pending, false);
  const stopped = await request(`/v1/runs/${parent.id}/stop`, {});
  assert.equal(stopped.stopped, 2);
  assert.equal((await call('/internal/handoff', { agentId: 'nova', prompt: 'Too late' }, headers)).status, 401);
  const stops = (await request('/v1/runner/commands', undefined, machine.headers)).commands.filter((command: any) => command.kind === 'stop');
  assert.equal(stops.length, 2);
  for (const stop of stops) await complete(machine, stop, { stopped: true });
  await complete(machine, childCommand, { text: 'Late child result' });
  assert.equal((await request(`/v1/runs/${child.runId}`)).state, 'cancelled');
  assert.equal((await request(`/v1/runs/${queued.id}`)).state, 'cancelled');
});

test('hosted conversations survive reload and seed follow-ups without cross-agent history', async () => {
  const machine = await pair(); await agent('atlas', machine.machineId); await agent('nova', machine.machineId);
  const first = await request('/v1/runs', { agentId: 'atlas', conversationId: 'conversation-1', prompt: 'Remember green' });
  await complete(machine, await nextCommand(machine, 'run'), { text: 'I will remember green.' });
  const second = await request('/v1/runs', { agentId: 'atlas', conversationId: 'conversation-1', prompt: 'What color?' });
  const command = await nextCommand(machine, 'run');
  assert.deepEqual(command.payload.history, [{ role: 'user', content: 'Remember green' }, { role: 'assistant', content: 'I will remember green.' }]);
  await request('/v1/runs', { agentId: 'nova', conversationId: 'conversation-1', prompt: 'Different agent' });
  assert.deepEqual((await nextCommand(machine, 'run')).payload.history, []);
  const history = await request('/v1/conversations?agentId=atlas');
  assert.equal(history.conversations.length, 1);
  assert.deepEqual(history.conversations[0].runs.map((run: any) => run.id), [first.id, second.id]);
});

test('hosted run views identify delegated work and preserve creation and update timestamps', async () => {
  const machine = await pair();
  const profile = await agent('atlas', machine.machineId); await agent('nova', machine.machineId);
  await request('/v1/agents/atlas/profile', { ...profile, allowedTools: [...profile.allowedTools, 'mcp_open_harness_delegate_named_agent'] }, undefined, 'PUT');
  const parent = await request('/v1/runs', { agentId: 'atlas', prompt: 'Delegate' });
  const command = await nextCommand(machine, 'run');
  const headers = { Authorization: `Bearer ${command.payload.coordinationToken}`, 'x-open-harness-agent': 'atlas', 'x-open-harness-run': parent.id };
  const child = await request('/internal/handoff', { agentId: 'nova', prompt: 'Research' }, headers);
  const listed = (await request('/v1/runs')).runs;
  const history = (await request('/v1/conversations')).conversations.flatMap((item: any) => item.runs);
  const eventView = (await request(`/v1/runs/${child.runId}/events`)).run;
  for (const view of [parent, ...listed, ...history, eventView]) {
    const row = db.sqlite.prepare('SELECT created_at,updated_at FROM runs WHERE id=?').get(view.id)!;
    assert.equal(view.parent_run_id, view.id === parent.id ? null : parent.id);
    assert.equal(view.created_at, row.created_at);
    assert.equal(view.updated_at, row.updated_at);
    assert.ok(Number.isFinite(Date.parse(view.created_at)));
  }
  assert.deepEqual(history.filter((run: any) => !run.parent_run_id).map((run: any) => run.id), [parent.id]);
});

test('hosted completion events and history expose only normalized reply text', async () => {
  const machine = await pair(); await agent('atlas', machine.machineId);
  for (const [result, expected] of [
    [{ text: 'Finished normally.', privateMetadata: 'not-a-reply' }, 'Finished normally.'],
    [{ final_response: 'Alternate reply.' }, 'Alternate reply.'],
    [{ message: 'Message reply.' }, 'Message reply.'],
    [{ text: { unexpected: 'object' }, final_response: 'Valid fallback.' }, 'Valid fallback.'],
    [{ text: { unexpected: 'object' }, message: ['not', 'text'] }, null],
  ]) {
    const run = await request('/v1/runs', { agentId: 'atlas', prompt: 'Complete without streaming' });
    await complete(machine, await nextCommand(machine, 'run'), result);
    const snapshot = await request(`/v1/runs/${run.id}/events`);
    assert.equal(snapshot.run.result, expected);
    assert.deepEqual(snapshot.events.find((event: any) => event.type === 'run.completed').payload, { result: expected });
    assert.equal((await request('/v1/conversations')).conversations.find((item: any) => item.id === run.conversation_id).runs[0].result, expected);
  }
});

test('hosted clarification replies preserve multiple selections and reject invalid or private arrays', async () => {
  const keys = await generateRunnerKeyPair(), machine = await pair('Secure runner', keys.publicKey);
  await agent('atlas', machine.machineId);
  const run = await request('/v1/runs', { agentId: 'atlas', prompt: 'Choose multiple options' });
  const command = await nextCommand(machine, 'run');
  await emit(machine, command, 'clarify.request', { request_id: 'multi', question: 'Which colors?', options: ['Red', 'Blue'], multiple: true });
  const input = (await request(`/v1/runs/${run.id}`)).pendingInputs[0];
  for (const value of [['Red', 1], { answer: 'Red' }, ['x'.repeat(20_000)]]) {
    assert.equal((await call(`/v1/runs/${run.id}/input`, { inputId: input.inputId, value })).status, 400);
    assert.equal((await request(`/v1/runs/${run.id}`)).pendingInputs[0].inputId, input.inputId);
  }
  await request(`/v1/runs/${run.id}/input`, { inputId: input.inputId, value: ['Red', 'Blue'] });
  const answer = await nextCommand(machine, 'input');
  assert.deepEqual(answer.payload.value, ['Red', 'Blue']);
  assert.equal(answer.payload.type, 'clarify');
  await complete(machine, answer, { answered: true });
  assert.equal((await request(`/v1/runs/${run.id}`)).pendingInputs.length, 0);
  for (const type of ['secret', 'sudo']) {
    await emit(machine, command, `${type}.request`, { request_id: type, prompt: 'Private input' });
    const pending = (await request(`/v1/runs/${run.id}`)).pendingInputs.find((item: any) => item.type === type);
    assert.equal((await call(`/v1/runs/${run.id}/input`, { inputId: pending.inputId, value: ['private'] })).status, 400);
  }
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM runner_commands WHERE kind='input'").get()!.n, 1);
});

test('pending input survives reload, rejects cross-run replies, expires, and encrypts secrets', async () => {
  const keys = await generateRunnerKeyPair(), machine = await pair('Secure runner', keys.publicKey);
  await agent('atlas', machine.machineId); await agent('nova', machine.machineId);
  const run = await request('/v1/runs', { agentId: 'atlas', prompt: 'Need input' });
  const command = await nextCommand(machine, 'run');
  const other = await request('/v1/runs', { agentId: 'nova', prompt: 'Other run' }); await nextCommand(machine, 'run');
  await emit(machine, command, 'clarify.request', { request_id: 'q1', question: 'Which color?' });
  const input = (await request(`/v1/runs/${run.id}`)).pendingInputs[0];
  assert.equal(input.type, 'clarify');
  assert.equal((await call(`/v1/runs/${other.id}/input`, { inputId: input.inputId, value: 'Red' })).status, 404);
  await emit(machine, command, 'clarify.expire', { request_id: 'q1' });
  assert.equal((await request(`/v1/runs/${run.id}`)).pendingInputs.length, 0);
  await emit(machine, command, 'secret.request', { request_id: 's1', label: 'Password' });
  const secret = (await request(`/v1/runs/${run.id}`)).pendingInputs[0];
  await request(`/v1/runs/${run.id}/input`, { inputId: secret.inputId, value: 'never-store-this-plaintext' });
  const answer = await nextCommand(machine, 'input');
  assert.equal(await decryptRunnerSecret(keys.privateKey, answer.payload.encrypted), 'never-store-this-plaintext');
  const durable = JSON.stringify(db.sqlite.prepare('SELECT payload_json FROM runner_commands UNION ALL SELECT payload_json FROM run_events UNION ALL SELECT payload_json FROM hosted_run_inputs').all());
  assert.ok(!durable.includes('never-store-this-plaintext'));
  await complete(machine, answer, undefined, 'Gateway could not accept input');
  assert.equal((await request(`/v1/runs/${run.id}`)).pendingInputs[0].inputId, secret.inputId);
});

test('hosted candidate model keys are encrypted and only successful tests update the workspace', async () => {
  const keys = await generateRunnerKeyPair(), machine = await pair('Secure runner', keys.publicKey);
  const original = { ...model, credentialRef: 'EXISTING_API_KEY' };
  await request('/v1/workspace/model', { model: original, revision: 0 }, undefined, 'PUT');
  const failed = call('/v1/onboarding/model-test', { model, apiKey: 'rejected-secret', save: true, revision: 1, machineId: machine.machineId });
  const rejectedProbe = await nextCommand(machine, 'probe-runtime');
  assert.equal(await decryptRunnerSecret(keys.privateKey, rejectedProbe.payload.encryptedApiKey), 'rejected-secret');
  await complete(machine, rejectedProbe, { ok: false, message: 'Key rejected.' });
  assert.equal((await failed).body.ok, false);
  assert.deepEqual((await request('/v1/workspace/model')).model, original);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM runner_commands WHERE kind='store-secret'").get()!.n, 0);
  const success = request('/v1/onboarding/model-test', { model, apiKey: 'accepted-secret', save: true, revision: 1, machineId: machine.machineId });
  await complete(machine, await nextCommand(machine, 'probe-runtime'), { ok: true, message: 'Model responded.' });
  const store = await nextCommand(machine, 'store-secret');
  assert.match(store.payload.name, /^MODEL_[A-Z0-9]+$/);
  assert.equal(await decryptRunnerSecret(keys.privateKey, store.payload.encrypted), 'accepted-secret');
  await complete(machine, store, { stored: true, backend: 'test-vault' });
  const saved = await success;
  assert.equal(saved.revision, 2); assert.equal(saved.model.credentialRef, store.payload.name);
  assert.ok(!JSON.stringify(db.sqlite.prepare('SELECT payload_json,result_json FROM runner_commands').all()).includes('accepted-secret'));
  const conflict = call('/v1/onboarding/model-test', { model, apiKey: 'conflicting-secret', save: true, revision: 2, machineId: machine.machineId });
  const conflictingProbe = await nextCommand(machine, 'probe-runtime');
  await request('/v1/workspace/model', { model: original, revision: 2 }, undefined, 'PUT');
  await complete(machine, conflictingProbe, { ok: true, message: 'Model responded.' });
  assert.equal((await conflict).status, 409);
  assert.deepEqual((await request('/v1/workspace/model')).model, original);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM runner_commands WHERE kind='store-secret'").get()!.n, 1);
});

test('hosted routines support editing, history, catch-up deduplication, and deletion', async () => {
  const machine = await pair(); await agent('atlas', machine.machineId);
  assert.equal((await call('/v1/routines', { agentId: 'atlas', name: 'Bad', prompt: 'Test', intervalMinutes: 'invalid' })).status, 400);
  const routine = await request('/v1/routines', { agentId: 'atlas', name: 'Daily check', prompt: 'Review tasks', intervalMinutes: 60 });
  const edited = await request(`/v1/routines/${routine.id}`, { name: 'Frequent check', intervalMinutes: 10 }, undefined, 'PUT');
  assert.equal(edited.name, 'Frequent check'); assert.equal(edited.interval_minutes, 10);
  const manual = await request(`/v1/routines/${routine.id}/run`, {});
  await complete(machine, await nextCommand(machine, 'run'), { text: 'Checked.' });
  assert.equal((await request(`/v1/routines/${routine.id}/history`)).history[0].run_id, manual.id);
  db.sqlite.prepare("UPDATE hosted_routines SET next_run_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(routine.id);
  await Promise.all([request('/v1/routines'), request('/v1/runner/heartbeat', { capabilities }, machine.headers)]);
  assert.equal((await request(`/v1/routines/${routine.id}/history`)).history.length, 2);
  assert.equal((await request('/v1/routines')).routines[0].last_run_at !== null, true);
  assert.equal((await request(`/v1/routines/${routine.id}/toggle`, {})).enabled, false);
  await request(`/v1/routines/${routine.id}`, undefined, undefined, 'DELETE');
  assert.equal((await request('/v1/routines')).routines.length, 0);
});
