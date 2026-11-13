import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_COMPUTER, DEFAULT_NETWORK, type ComputerConfig } from '../lib/agent-profile';
import { normalizeModels } from '../runtime/profile-runtime';
import { HermesGateway, lastWords, stopNativeTree, containerSignature, teamMountArgs, shouldRebuildContainer } from '../runtime/hermes';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { assertProcessStopped } from './helpers/process-state';

class StreamingGateway extends HermesGateway {
  constructor(readonly submit: () => Promise<unknown> = async () => ({ status: 'streaming' })) { super('test'); }
  override request() { return this.submit(); }
}
test('streaming acknowledgement does not finish a run; session completion does', async () => {
  const gateway = new StreamingGateway(); let settled = false;
  const result = gateway.submitPrompt('session-a', 'work').then(value => { settled = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  gateway.emit('event', { type: 'message.complete', session_id: 'child-session', payload: { text: 'child' } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  gateway.emit('event', { type: 'message.complete', session_id: 'session-a', payload: { status: 'complete', text: 'saved artifact' } });
  assert.equal((await result).text, 'saved artifact'); assert.equal(gateway.listenerCount('event'), 0);
});
test('completion arriving before the submit acknowledgement is preserved', async () => {
  const gateway = new StreamingGateway(async () => {
    gateway.emit('event', { type: 'message.complete', session_id: 'a', payload: { status: 'complete', text: 'early' } });
    return { status: 'streaming' };
  });
  assert.equal((await gateway.submitPrompt('a', 'work')).text, 'early');
});
test('provider errors and gateway crashes cannot become successful empty results', async () => {
  const gateway = new StreamingGateway();
  const result = gateway.submitPrompt('a', 'work');
  gateway.emit('event', { type: 'message.complete', session_id: 'a', payload: { status: 'error', error: 'Provider unavailable' } });
  await assert.rejects(result, /Provider unavailable/);
  const crashed = gateway.submitPrompt('b', 'work');
  gateway.emit('exit', Object.assign(new Error('container crashed'), { interrupted: true }));
  await assert.rejects(crashed, { interrupted: true });
  assert.equal(gateway.listenerCount('event'), 0); assert.equal(gateway.listenerCount('exit'), 0);
});

test('normalizes Hermes provider rows with string model IDs and custom providers', () => {
  const catalog = normalizeModels({ providers: [{ slug: 'openrouter', name: 'OpenRouter', models: ['vendor/fast', 'vendor/large'] }, { provider_id: 'custom-local', models: [{ id: 'local-model', name: 'Local model' }] }] });
  assert.deepEqual(catalog.models.map(m => [m.provider, m.id]), [['openrouter', 'vendor/fast'], ['openrouter', 'vendor/large'], ['custom-local', 'local-model']]);
});

test('a crashed gateway reports the agent\'s own last output, not just an exit code', () => {
  const traceback = ['Traceback (most recent call last):', '  File "/opt/open-harness/managed_entry.py", line 12', 'ModuleNotFoundError: No module named \'hermes_cli\''];
  const summary = lastWords(traceback);
  assert.match(summary, /ModuleNotFoundError/);
  assert.match(summary, /Last output:/);
  // Blank lines are noise, and the tail must stay short enough to read in an error bubble.
  assert.equal(lastWords([]), '');
  assert.equal(lastWords(['', '   ']), '');
  assert.ok(lastWords([`x${'y'.repeat(900)}`]).length < 460);
  // Newest last: the final line is the one that explains the crash.
  assert.ok(summary.endsWith("No module named 'hermes_cli'"));
});

test('native gateway requests fail closed before spawning, including mock mode', async t => {
  const mock = process.env.OPEN_HARNESS_MOCK;
  t.after(() => { if (mock === undefined) delete process.env.OPEN_HARNESS_MOCK; else process.env.OPEN_HARNESS_MOCK = mock; });
  let spawned = false;
  for (const value of ['0', '1']) {
    process.env.OPEN_HARNESS_MOCK = value;
    const gateway = new HermesGateway('native-blocked', [], { cwd: tmpdir(), entry: 'unused', python: process.execPath, env: process.env, onSpawn: () => { spawned = true; } });
    await assert.rejects(gateway.start(), /not sandboxed and is disabled/);
    await gateway.stop();
  }
  assert.equal(spawned, false);
});

test('legacy native cleanup still stops TERM-ignoring gateways and detached tool descendants', { skip: process.platform === 'win32' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'open-harness-stop-tree-')), entry = join(dir, 'legacy.mjs');
  const pids: number[] = [];
  t.after(() => { for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} } rmSync(dir, { recursive: true, force: true }); });
  writeFileSync(entry, `
    import { spawn } from 'node:child_process';
    process.on('SIGTERM', () => {});
    const tool = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], { detached: true, stdio: ['ignore','pipe','ignore'] });
    tool.stdout.once('data', () => console.log(JSON.stringify([process.pid, tool.pid])));
    setInterval(() => {}, 1000);
  `);
  const child = spawn(process.execPath, [entry], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  pids.push(...await new Promise<number[]>((resolve, reject) => { child.once('error', reject); child.stdout.once('data', data => resolve(JSON.parse(String(data)))); }));
  assert.equal(pids.length, 2);
  const started = Date.now();
  await stopNativeTree(pids[0]);
  assert.ok(Date.now() - started >= 1900, 'Cleanup waited for graceful termination before escalating');
  for (const pid of pids) assertProcessStopped(pid);
});

test('mock clarification waits for the answer and mock sessions retain supplied history', async t => {
  const mock = process.env.OPEN_HARNESS_MOCK; process.env.OPEN_HARNESS_MOCK = '1';
  t.after(() => { if (mock === undefined) delete process.env.OPEN_HARNESS_MOCK; else process.env.OPEN_HARNESS_MOCK = mock; });
  const gateway = new HermesGateway('mock');
  const history = [{ role: 'user', content: 'Remember the blue notebook.' }];
  const session = await gateway.request('session.create', { messages: history });
  assert.equal((await gateway.submitPrompt(session.session_id, 'MOCK_HISTORY')).final_response, JSON.stringify(history));
  let settled = false;
  const answer = gateway.submitPrompt(session.session_id, 'MOCK_CLARIFY').then(value => { settled = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  await gateway.request('clarify.respond', { request_id: 'mock-clarify', answer: 'blue' });
  assert.match((await answer).final_response, /Answer: blue/);
  await gateway.stop();
});

test('default network keeps the legacy container signature while policy changes invalidate it', () => {
  const selected = { ...DEFAULT_COMPUTER };
  const legacy = containerSignature(selected, 'image');
  assert.equal(containerSignature(selected, 'image'), legacy);
  const missing = { ...selected } as Partial<ComputerConfig>; delete missing.network;
  assert.equal(containerSignature(missing as ComputerConfig, 'image'), legacy);
  assert.equal(containerSignature({ ...selected, network: { ...DEFAULT_NETWORK } }, 'image'), legacy);
  for (const mode of ['none', 'allowlist'] as const) assert.notEqual(containerSignature({ ...selected, network: { mode, allow: [] } }, 'image'), legacy);
  assert.notEqual(containerSignature({ ...selected, network: { mode: 'open', allow: ['example.com'] } }, 'image'), legacy);
  assert.notEqual(containerSignature({ ...selected, network: { mode: 'allowlist', allow: ['example.com'] } }, 'image'), containerSignature({ ...selected, network: { mode: 'allowlist', allow: ['other.com'] } }, 'image'));
});

test('team mounts and signatures use sorted, validated ids without changing unassigned agents', () => {
  const root = resolve('/state');
  assert.deepEqual(teamMountArgs(root, []), []);
  assert.deepEqual(teamMountArgs(root, ['beta', 'alpha', 'beta']), ['-v', `${join(root, 'teams/alpha/shared')}:/workspace/teams/alpha`, '-v', `${join(root, 'teams/beta/shared')}:/workspace/teams/beta`]);
  assert.equal(containerSignature(DEFAULT_COMPUTER, 'image', '/state', []), containerSignature(DEFAULT_COMPUTER, 'image', '/state'));
  assert.equal(containerSignature(DEFAULT_COMPUTER, 'image', '/state', ['beta', 'alpha']), containerSignature(DEFAULT_COMPUTER, 'image', '/state', ['alpha', 'beta']));
  assert.notEqual(containerSignature(DEFAULT_COMPUTER, 'image', '/state', ['alpha']), containerSignature(DEFAULT_COMPUTER, 'image', '/state'));
  for (const id of ['../escape', '..', '.', '/absolute', 'team:ro', 'a/b', 'a\\b', '']) {
    assert.throws(() => teamMountArgs('/state', [id]), /Invalid team id/);
    assert.throws(() => containerSignature(DEFAULT_COMPUTER, 'image', '/state', [id]), /Invalid team id/);
  }
});

test('signature changes defer container rebuilds until idle', () => {
  assert.equal(shouldRebuildContainer('old', 'new', true), false);
  assert.equal(shouldRebuildContainer('old', 'new', false), true);
  assert.equal(shouldRebuildContainer('same', 'same', false), false);
  assert.equal(shouldRebuildContainer('same', 'same', true), false);
});
