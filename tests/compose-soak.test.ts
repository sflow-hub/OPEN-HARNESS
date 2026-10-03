import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { runSoakLoop, soakMode, SOAK_MODES } from './helpers/soak-loop.mjs';
import { assertSoakResources, WORKSPACE_CACHE_KEYS } from './helpers/compose-soak.mjs';
import { soakContainerEvents } from './helpers/soak-containers.mjs';

function lifecycleFixture() {
  const containers = Object.fromEntries(['open-harness', 'docker', 'fixture'].map(service => [service, { id: service + '-id' }]));
  const records: Record<string, unknown>[] = [];
  const tracker = soakContainerEvents(containers, (entry: Record<string, unknown>) => records.push(entry));
  const event = (action: string, service = 'open-harness') => ({ Type: 'container', Action: action, Actor: { ID: service + '-id', Attributes: { exitCode: '0', signal: '15' } }, time: 123, timeNano: 123000000000 });
  return { tracker, records, event };
}

test('continuous lifecycle evidence requires exactly one complete manual restart', () => {
  const { tracker, records, event } = lifecycleFixture();
  assert.throws(() => tracker.finish(), /not observed/);
  tracker.beforeRestart();
  for (const action of ['kill', 'die', 'start', 'restart']) tracker.add(event(action));
  tracker.afterRestart();
  assert.deepEqual(tracker.finish().events.map(entry => entry.action), ['kill', 'die', 'start', 'restart']);
  assert.equal(records.length, 4);
});

test('lifecycle evidence rejects automatic crashes immediately before or after a manual restart', () => {
  for (const actions of [['die', 'start', 'kill', 'die', 'start', 'restart'], ['kill', 'die', 'start', 'restart', 'die', 'start']]) {
    const { tracker, event } = lifecycleFixture(); tracker.beforeRestart();
    assert.throws(() => { for (const action of actions) tracker.add(event(action)); }, /unexpected lifecycle event/);
  }
  const { tracker, event } = lifecycleFixture(); tracker.beforeRestart();
  for (const action of ['kill', 'die', 'start']) tracker.add(event(action));
  assert.throws(() => tracker.afterRestart(), /not fully observed/);
});

test('lifecycle evidence rejects unexpected service exits, replacement and OOM events', () => {
  for (const service of ['open-harness', 'docker', 'fixture']) for (const action of ['kill', 'die', 'start', 'restart', 'oom', 'destroy']) {
    const { tracker, event } = lifecycleFixture();
    assert.throws(() => tracker.add(event(action, service)), /outside the planned/);
  }
  for (const service of ['docker', 'fixture']) {
    const { tracker, event } = lifecycleFixture(); tracker.beforeRestart();
    assert.throws(() => tracker.add(event('die', service)), /outside the planned/);
  }
  const { tracker, event } = lifecycleFixture(); tracker.beforeRestart();
  assert.throws(() => tracker.add(event('die', 'another-container')), /Unexpected container lifecycle source/);
});

test('an event after the planned restart or a failed journal write cannot be accepted', () => {
  const { tracker, event } = lifecycleFixture(); tracker.beforeRestart();
  for (const action of ['kill', 'die', 'start', 'restart']) tracker.add(event(action));
  tracker.afterRestart(); assert.throws(() => tracker.add(event('die')), /outside the planned/);
  const states = { 'open-harness': { id: 'open-harness-id' }, docker: { id: 'docker-id' }, fixture: { id: 'fixture-id' } };
  const broken = soakContainerEvents(states, () => { throw new Error('journal unavailable'); }); broken.beforeRestart();
  assert.throws(() => broken.add(event('die')), /journal unavailable/);
});

test('planned restarts must show SIGTERM and a successful coordinator exit', () => {
  const killed = lifecycleFixture(); killed.tracker.beforeRestart();
  const signal = killed.event('kill'); signal.Actor.Attributes.signal = '9';
  assert.throws(() => killed.tracker.add(signal), /must use SIGTERM/);
  const crashed = lifecycleFixture(); crashed.tracker.beforeRestart(); crashed.tracker.add(crashed.event('kill'));
  const exit = crashed.event('die'); exit.Actor.Attributes.exitCode = '42';
  assert.throws(() => crashed.tracker.add(exit), /did not exit successfully/);
});

// Injected monotonic and wall time verify control flow only; these are never soak evidence.
// Awake time advances both clocks; a suspended machine or paused VM advances only wall time.
function simulation(mode = 'smoke') {
  let time = 0, wall = 1_790_000_000_000, restarts = 0;
  const records: Record<string, unknown>[] = [], cycles: number[] = [];
  const advance = (ms: number) => { time += ms; wall += ms; };
  return {
    records, cycles, advance, suspend: (ms: number) => { wall += ms; }, restarts: () => restarts,
    options: { mode, now: () => time, wallNow: () => wall, sleep: async (ms: number) => { advance(ms); }, record: (entry: Record<string, unknown>) => { records.push(entry); }, sample: async () => ({ availableBytes: 10 * 1024 ** 3 }), cycle: async (index: number) => { cycles.push(index); advance(1000); return { index }; }, restart: async () => { restarts += 1; advance(1000); return { recovered: true }; } },
  };
}

test('soak opt-in has fixed durations and refuses ambiguous or config-only runs', () => {
  assert.equal(soakMode([]), null);
  assert.equal(soakMode(['--soak']), 'soak');
  assert.equal(soakMode(['--soak-smoke']), 'smoke');
  assert.equal(SOAK_MODES.soak.durationMs, 86_400_000);
  for (const args of [['--soak', '--config-only'], ['--soak', '--soak-smoke'], ['--soak', '--soak']]) assert.throws(() => soakMode(args));
  assert.equal(Reflect.set(SOAK_MODES.soak, 'durationMs', 1), false);
});

test('five-minute simulated smoke repeats tasks and restarts but never qualifies 24 hours', async () => {
  const s = simulation(), result = await runSoakLoop(s.options);
  assert.equal(result.ok, true);
  assert.equal(result.durationQualified, false);
  assert.ok(result.elapsedMs >= 300_000);
  assert.ok(result.cycles >= 10);
  assert.equal(s.restarts(), 1);
  assert.equal(s.records.filter(entry => entry.type === 'restart-start').length, 1);
  assert.ok(s.records.findIndex(entry => entry.type === 'restart-complete') < s.records.findLastIndex(entry => entry.type === 'cycle-complete'));
});

test('simulated full duration needs at least 288 cycles with observations across the entire day', async () => {
  const s = simulation('soak'), result = await runSoakLoop(s.options);
  assert.equal(result.durationQualified, true);
  assert.ok(result.elapsedMs >= 86_400_000);
  assert.ok(result.cycles >= 288);
  const resources = s.records.filter(entry => entry.type === 'resources');
  assert.ok(resources.length > 1440);
  assert.equal(s.restarts(), 1);
});

test('disk observation overhead does not accumulate into a slower task cadence', async () => {
  const s = simulation('soak');
  s.options.sample = async () => { s.advance(1500); return { availableBytes: 10 * 1024 ** 3 }; };
  const result = await runSoakLoop(s.options);
  assert.ok(result.cycles >= 288);
  assert.ok(result.elapsedMs < 86_430_000);
});

test('a suspended or stalled process cannot qualify elapsed time', async () => {
  const s = simulation('soak');
  s.options.sleep = async () => { s.advance(86_400_000); };
  await assert.rejects(runSoakLoop(s.options), /observation gap/);
  assert.equal(s.records.at(-1)?.type, 'failed');
  assert.ok(!s.records.some(entry => entry.type === 'complete' || entry.type === 'loop-complete'));
});

test('a machine or VM suspension, which stops the monotonic clock, cannot qualify elapsed time', async () => {
  const s = simulation('soak');
  let suspended = false;
  s.options.sleep = async (ms: number) => { s.advance(ms); if (!suspended && s.cycles.length === 100) { suspended = true; s.suspend(8 * 60 * 60_000); } };
  await assert.rejects(runSoakLoop(s.options), /Wall-clock observation gap/);
  assert.equal(s.records.at(-1)?.type, 'failed');
  assert.ok(!s.records.some(entry => entry.type === 'complete' || entry.type === 'loop-complete'));
});

test('repeated short suspensions cannot accumulate into soak time', async () => {
  const s = simulation('soak');
  s.options.sleep = async (ms: number) => { s.advance(ms); s.suspend(120_000); };
  await assert.rejects(runSoakLoop(s.options), /clocks diverged/);
  assert.equal(s.records.at(-1)?.type, 'failed');
});

test('a wall clock stepped backwards is not a trustworthy record', async () => {
  const s = simulation();
  s.options.sleep = async (ms: number) => { s.advance(ms); s.suspend(-5 * 60_000); };
  await assert.rejects(runSoakLoop(s.options), /Wall clock moved backwards/);
});

test('the loop leaves the success receipt to its caller', async () => {
  const s = simulation('soak'), result = await runSoakLoop(s.options);
  assert.equal(result.durationQualified, true);
  assert.equal(s.records.at(-1)?.type, 'loop-complete');
  assert.ok(!s.records.some(entry => entry.type === 'complete' || 'durationQualified' in entry || 'ok' in entry));
});

test('backward monotonic clock movement fails with a durable failure entry', async () => {
  const s = simulation();
  s.options.sleep = async () => { s.advance(-1); };
  await assert.rejects(runSoakLoop(s.options), /moved backwards/);
  assert.equal(s.records.at(-1)?.type, 'failed');
});

test('a slow task cadence cannot pass using only the elapsed duration', async () => {
  const s = simulation('soak');
  s.options.cycle = async (index: number) => { s.advance(590_000); return { index }; };
  await assert.rejects(runSoakLoop(s.options), /at least 288 completed cycles/);
});

test('task, restart, resource, and evidence-write failures cannot produce a successful receipt', async () => {
  for (const field of ['cycle', 'restart', 'sample', 'record'] as const) {
    const s = simulation();
    const options = { ...s.options, [field]: async () => { throw new Error(`${field} refused`); } };
    await assert.rejects(runSoakLoop(options), new RegExp(`${field} refused`));
    assert.ok(!s.records.some(entry => entry.type === 'complete' || entry.type === 'loop-complete'));
  }
});

test('disk measurements enforce the stop floor on the artifact, data, and engine filesystems', () => {
  const sample = () => ({ artifacts: { availableBytes: 8 * 1024 ** 3 }, data: { availableBytes: 8 * 1024 ** 3, usedKiB: 17 }, engine: { availableBytes: 8 * 1024 ** 3, usedKiB: 1000 } });
  assert.doesNotThrow(() => assertSoakResources(sample()));
  for (const location of ['artifacts', 'data', 'engine'] as const) for (const availableBytes of [0, 4 * 1024 ** 3 - 1, NaN, Infinity]) {
    const s = sample(); s[location].availableBytes = availableBytes;
    assert.throws(() => assertSoakResources(s), /stop floor|measurement/);
  }
  const missingSize = sample(); missingSize.engine.usedKiB = NaN;
  assert.throws(() => assertSoakResources(missingSize), /size was not measured/);
});

test('fresh-server replay removes exactly the dashboard\'s workspace cache keys, never its pairing token', () => {
  const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  const constant = (name: string) => new RegExp(`const ${name} = "([^"]+)";`).exec(page)?.[1];
  assert.deepEqual([...WORKSPACE_CACHE_KEYS], [constant('STORAGE_KEY'), constant('LEGACY_STORAGE_KEY')]);
  assert.match(readFileSync(new URL('../lib/control-client.ts', import.meta.url), 'utf8'), /const pairKey = \(\) => `open-harness\.pair\.v1:\$\{base\(\)\}`;/);
  assert.ok(WORKSPACE_CACHE_KEYS.every(key => !key.startsWith('open-harness.pair.')));
});

test('scripted provider binds each soak artifact and completion to its unique marker; baseline is unchanged', async () => {
  const portHolder = createServer().listen(0, '127.0.0.1');
  await once(portHolder, 'listening');
  const port = (portHolder.address() as { port: number }).port;
  await new Promise<void>(resolve => portHolder.close(() => resolve()));
  const child = spawn(process.execPath, ['tests/helpers/compose-provider.mjs'], { env: { ...process.env, COMPOSE_FIXTURE_HOST: '127.0.0.1', COMPOSE_FIXTURE_PORT: String(port), COMPOSE_REQUIRE_CREDENTIAL: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const done = once(child, 'exit');
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Provider did not start.')), 10_000);
      child.stdout!.once('data', () => { clearTimeout(timer); resolve(); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Provider exited early.')); });
    });
    const ask = async (prompt: string, called: string[] = []) => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(5000), headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local-scripted-provider-rotated' }, body: JSON.stringify({ messages: [{ role: 'user', content: prompt }, { role: 'assistant', tool_calls: called.map(name => ({ function: { name } })) }], tools: [{ type: 'function', function: { name: 'write_file' } }] }) });
      assert.equal(response.status, 200);
      return (await response.json()).choices[0].message;
    };
    for (const marker of ['first-agent-1', 'second-agent-2']) {
      const prompt = `COMPOSE_SOAK:${marker} COMPOSE_SMOKE`;
      const first = await ask(prompt);
      assert.deepEqual(JSON.parse(first.tool_calls[0].function.arguments), { path: '/workspace/shared/compose-soak.txt', content: `COMPOSE_SOAK:${marker}\n` });
      const final = await ask(prompt, ['write_file', 'clarify', 'mcp__open_harness__task', 'terminal']);
      assert.equal(final.content, `COMPOSE_SOAK_COMPLETE:${marker}`);
    }
    assert.deepEqual(JSON.parse((await ask('COMPOSE_SMOKE')).tool_calls[0].function.arguments), { path: '/workspace/shared/compose-verified.txt', content: 'Written through the real Compose Hermes tool loop.\n' });
    assert.equal((await ask('COMPOSE_SMOKE', ['write_file', 'clarify', 'mcp__open_harness__task', 'terminal'])).content, 'COMPOSE_SMOKE_COMPLETE');
  } finally { child.kill('SIGTERM'); await done; }
});
