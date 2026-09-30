import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containerSignature, containerStateKey, ensureContainer, stopAgentContainers } from '../runtime/hermes';
import { RUNTIME_CONTRACT } from '../runtime/readiness';
import type { ComputerConfig } from '../lib/agent-profile';

const computer = { machineId: 'local', access: 'private', folders: [], desktop: 'none', reserveMachine: false, resources: { cpu: 2, memoryMb: 4096, concurrency: 4 } } as ComputerConfig;
const base = 'open-harness-atlas';
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'harness-owner-')), root = join(dir, 'selected'), stateFile = join(dir, 'docker-state.json'), log = join(dir, 'calls.jsonl');
  const savedPath = process.env.PATH, savedMock = process.env.OPEN_HARNESS_MOCK;
  const state: { containers: Record<string, ReturnType<typeof container>>; psFailure?: boolean; inspectFailure?: boolean } = { containers: {} };
  const save = () => writeFileSync(stateFile, JSON.stringify(state));
  save(); writeFileSync(log, '');
  writeFileSync(join(dir, 'docker'), String.raw`#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), file = ${JSON.stringify(stateFile)}, state = JSON.parse(fs.readFileSync(file, 'utf8'));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\n');
const container = state.containers[args.at(-1)] || Object.values(state.containers).find(c => c.Id === args.at(-1));
if (args[0] === 'image') console.log(args.includes('{{.Id}}') ? 'sha256:test' : '${RUNTIME_CONTRACT}');
if (args[0] === 'inspect') {
  if (state.inspectFailure) { console.error('daemon not available'); process.exit(1); }
  if (!container) { console.error('Error: No such object: ' + args.at(-1)); process.exit(1); }
  console.log(JSON.stringify(container));
}
if (args[0] === 'run' && args.includes('--rm')) {
  const mount = args[args.indexOf('-v') + 1]; console.log(fs.readFileSync(mount.slice(0, -':/probe:ro'.length) + '/canary', 'utf8'));
}
if (args[0] === 'ps' && state.psFailure) { console.error('cannot confirm container cleanup'); process.exit(1); }
if (args[0] === 'version') console.log('29.0');
`, { mode: 0o700 });
  process.env.PATH = `${dir}:${savedPath || ''}`; delete process.env.OPEN_HARNESS_MOCK;
  t.after(() => { if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath; if (savedMock === undefined) delete process.env.OPEN_HARNESS_MOCK; else process.env.OPEN_HARNESS_MOCK = savedMock; rmSync(dir, { recursive: true, force: true }); });
  function calls() { return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]); }
  function mutations() { return calls().filter(args => ['rm', 'start', 'stop'].includes(args[0]) || args[0] === 'run' && args.includes('-d')); }
  return { dir, root, alternate: `${base}-${containerStateKey(root).slice(0, 12)}`, state, save, calls, mutations };
}
function container(root: string, id = 'owned-id', options: { legacy?: boolean; running?: boolean; signature?: string } = {}) {
  return { Id: id, State: { Running: options.running ?? true }, Config: { Labels: { 'open-harness.managed': '1', ...(!options.legacy ? { 'open-harness.state': containerStateKey(root) } : {}), 'open-harness.config': options.signature ?? containerSignature(computer, 'sha256:test', root) } }, Mounts: [
    { Source: join(root, 'agents/atlas/managed'), Destination: '/run/open-harness' },
    { Source: join(root, 'agents/atlas/profile'), Destination: '/home/hermes/.hermes' },
    { Source: join(root, 'agents/atlas/private'), Destination: '/workspace/private' },
    { Source: join(root, 'shared'), Destination: '/workspace/shared' },
  ] };
}

test('another workspace keeps its base container while this workspace gets an owned alternate', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); f.state.containers[base] = container(join(f.dir, 'foreign'), 'foreign-id'); f.save();
  assert.equal(ensureContainer('atlas', f.root, computer), f.alternate);
  const mutations = f.mutations(); assert.equal(mutations.length, 1); assert.equal(mutations[0][0], 'run'); assert.ok(mutations[0].includes(f.alternate)); assert.ok(mutations[0].includes(`open-harness.state=${containerStateKey(f.root)}`));
  assert.equal(mutations.some(args => args.includes('foreign-id') || args.includes(base)), false);
});

test('selected folder grants require a directory before container replacement', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), file = join(f.dir, 'not-a-folder'); writeFileSync(file, 'file');
  f.state.containers[base] = container(f.root); f.save();
  assert.throws(() => ensureContainer('atlas', f.root, { ...computer, access: 'folders', folders: [{ id: 'file', path: file, mode: 'read' }] }), /not a directory/);
  assert.deepEqual(f.mutations(), []);
});

test('long agent IDs sharing their first 48 characters keep distinct containers and full profile paths', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), prefix = 'a'.repeat(48), first = `${prefix}${'b'.repeat(32)}`, second = `${prefix}${'c'.repeat(32)}`;
  const firstName = ensureContainer(first, f.root, computer);
  f.state.containers[firstName] = container(f.root, 'first-id'); f.save();
  const secondName = ensureContainer(second, f.root, computer);
  assert.equal(firstName, `open-harness-${first}`); assert.equal(secondName, `open-harness-${second}`); assert.notEqual(firstName, secondName);
  const created = f.mutations(); assert.equal(created.length, 2);
  for (const [index, id] of [first, second].entries()) {
    assert.equal(created[index][0], 'run');
    assert.ok(created[index].includes(`${f.root}/agents/${id}/profile:/home/hermes/.hermes`));
    assert.ok(created[index].includes(`${f.root}/agents/${id}/private:/workspace/private`));
    assert.ok(created[index].includes(`${f.root}/agents/${id}/managed:/run/open-harness:ro`));
  }
});

test('a foreign alternate is refused without stopping, starting, replacing, or reusing either container', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); f.state.containers[base] = container(join(f.dir, 'foreign'), 'foreign-base'); f.state.containers[f.alternate] = container(join(f.dir, 'other'), 'foreign-alternate'); f.save();
  assert.throws(() => ensureContainer('atlas', f.root, computer), /belongs to another workspace/); assert.deepEqual(f.mutations(), []);
});

test('a verified workspace can restart or replace its own container by immutable ID', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); f.state.containers[base] = container(f.root, 'owned-id', { running: false }); f.save();
  assert.equal(ensureContainer('atlas', f.root, computer), base); assert.deepEqual(f.mutations(), [['start', 'owned-id']]);
  f.state.containers[base] = container(f.root, 'old-id', { signature: 'stale' }); f.save();
  assert.equal(ensureContainer('atlas', f.root, computer), base); assert.deepEqual(f.mutations()[1], ['rm', '-f', 'old-id']); assert.equal(f.mutations()[2][0], 'run');
});

test('legacy containers require all private mounts to match and are recreated to acquire a state label', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); f.state.containers[base] = container(f.root, 'legacy-id', { legacy: true }); f.save();
  assert.equal(ensureContainer('atlas', f.root, computer), base); assert.deepEqual(f.mutations()[0], ['rm', '-f', 'legacy-id']); assert.ok(f.mutations()[1].includes(`open-harness.state=${containerStateKey(f.root)}`));
  f.state.containers[base].Mounts[2].Source = join(f.dir, 'foreign/private'); f.save();
  assert.equal(ensureContainer('atlas', f.root, computer), f.alternate); assert.equal(f.mutations().length, 3); assert.ok(f.mutations()[2].includes(f.alternate));
});

test('an existing alternate remains the selected container after the base name becomes free', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); f.state.containers[f.alternate] = container(f.root); f.save();
  assert.equal(ensureContainer('atlas', f.root, computer), f.alternate); assert.deepEqual(f.mutations(), []);
});

test('recovery stops only verified containers across both candidate names, including legacy same-root containers', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t); f.state.containers[base] = container(join(f.dir, 'foreign'), 'foreign-id'); f.state.containers[f.alternate] = container(f.root, 'alternate-id'); f.save();
  await stopAgentContainers('atlas', f.root); assert.deepEqual(f.mutations(), [['stop', '--time', '2', 'alternate-id']]);
  f.state.containers[base] = container(f.root, 'legacy-id', { legacy: true }); f.state.containers[f.alternate].State.Running = false; f.save();
  await stopAgentContainers('atlas', f.root); assert.deepEqual(f.mutations()[1], ['stop', '--time', '2', 'legacy-id']);
});

test('Docker inspection failures cannot be mistaken for a missing container', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t); f.state.inspectFailure = true; f.save();
  assert.throws(() => ensureContainer('atlas', f.root, computer), /daemon not available/);
  await assert.rejects(stopAgentContainers('atlas', f.root), /daemon not available/); assert.deepEqual(f.mutations(), []);
});

test('coordinator shutdown exits unsuccessfully when workspace cleanup cannot be confirmed', { skip: process.platform === 'win32', timeout: 15_000 }, async t => {
  const f = fixture(t); f.state.psFailure = true; f.save();
  const child = spawn(process.execPath, ['--import', 'tsx', 'runtime/service.ts'], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, OPEN_HARNESS_MOCK: '0', OPEN_HARNESS_PORT: '0', OPEN_HARNESS_STATE_DIR: f.root, OPEN_HARNESS_DISABLE_OS_VAULT: '1', HOME: f.dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
  for (let i = 0; i < 200 && !output.includes('coordinator listening'); i++) { assert.equal(child.exitCode, null, output); await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.match(output, /coordinator listening/); child.kill('SIGTERM');
  assert.equal(await exited, 1, output); assert.match(output, /cannot confirm container cleanup/);
});
