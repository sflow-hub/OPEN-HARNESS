import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { modelFixture, key, answer } from '../../rust-runner/tests/provider-fixture.mjs';

const binary = process.env.OPEN_HARNESS_TEST_NATIVE_BINARY;
const cases = [
  ['claude-code', 'anthropic', '/v1/messages'],
  ['codex', 'openai', '/v1/responses'],
  ['hermes', 'openai', '/v1/chat/completions'],
];
const terminalStates = new Set(['completed', 'failed', 'interrupted', 'cancelled']);
const turnTimeout = Number(process.env.OPEN_HARNESS_TEST_TURN_TIMEOUT_MS ?? 420_000);
assert.ok(Number.isSafeInteger(turnTimeout) && turnTimeout > 0, 'Set a positive live turn timeout in milliseconds');

test('installed headless harnesses use the native coordinator and a local model',
  { skip: !binary || process.env.OPEN_HARNESS_TEST_LIVE !== '1', timeout: Math.max(70 * 60_000, turnTimeout * 10) }, async t => {
    const selected = process.env.OPEN_HARNESS_RUST_LIVE_ONLY;
    assert.ok(!selected || cases.some(([id]) => id === selected), 'Unknown harness: ' + selected);
    const provider = await modelFixture(t);
    const state = await mkdtemp(join(tmpdir(), 'open-harness-native-live-'));
    const coordinator = spawn(resolve(binary), ['serve', '--port', '0', '--bind', '127.0.0.1', '--state-dir', state], {
      cwd: state, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, OPEN_HARNESS_MOCK: '0', OPEN_HARNESS_DISABLE_OS_VAULT: '1' },
    });
    let logs = '';
    for (const stream of [coordinator.stdout, coordinator.stderr]) {
      stream.on('data', chunk => { logs = (logs + chunk).slice(-8000); });
    }
    t.after(async () => {
      if (coordinator.pid && coordinator.exitCode === null && !coordinator.signalCode) {
        const closed = once(coordinator, 'exit');
        coordinator.kill('SIGTERM');
        await closed;
      }
      await rm(state, { recursive: true, force: true });
    });
    await once(coordinator, 'spawn');
    async function until(action, what, timeout) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline && coordinator.exitCode === null && !coordinator.signalCode) {
        const result = await action();
        if (result) return result;
        await delay(200);
      }
      const reason = coordinator.exitCode !== null || coordinator.signalCode
        ? 'Coordinator exited while waiting for ' : 'Timed out waiting for ';
      assert.fail(reason + what + '\n' + logs);
    }
    const base = await until(() => /serving (http:\/\/127\.0\.0\.1:\d+)/.exec(logs)?.[1], 'startup', 20_000);
    const { token } = await (await fetch(base + '/v1/bootstrap')).json();
    async function api(path, data) {
      const res = await fetch(base + path, {
        method: data === undefined ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const body = await res.json();
      assert.ok(res.ok, path + ' ' + JSON.stringify(body));
      return body;
    }
    function terminalRun(runId) {
      return until(async () => {
        const run = await api('/v1/runs/' + runId);
        return terminalStates.has(run.state) && run;
      }, 'terminal state for ' + runId, turnTimeout);
    }
    const { harnesses } = await api('/v1/harnesses');
    assert.deepEqual(harnesses.map(harness => harness.id).sort(), cases.map(([id]) => id).sort(), 'Every registered harness needs a live test case');
    await until(async () => (await api('/v1/health')).runtime.available, 'local container engine', 90_000);
    await api('/v1/secrets', { name: 'TEST_MODEL_KEY', value: key });
    for (const [harness, modelProvider, endpoint] of cases) await t.test(harness, { skip: !!selected && harness !== selected }, async () => {
      const anthropic = modelProvider === 'anthropic';
      const id = 'native-' + harness;
      await api('/v1/agents', { id, name: 'Test ' + harness, harness,
        model: { inherit: false, provider: modelProvider, model: anthropic ? 'claude-sonnet-4-6' : 'gpt-4o-mini',
          credentialRef: 'TEST_MODEL_KEY', baseUrl: provider.base + (anthropic ? '' : '/v1') } });
      const requestsBefore = provider.seen.get(endpoint) || 0;
      const submit = prompt => api('/v1/runs', { agentId: id, prompt });
      const created = await submit('Reply that the headless run was confirmed.');
      const result = await terminalRun(created.id);
      const history = await api('/v1/runs/' + created.id + '/events');
      assert.equal(result.state, 'completed', JSON.stringify({ result, events: history.events.map(e => e.type), providerRequests: [...provider.seen.keys()] }) + '\n' + logs);
      assert.equal(result.result, answer);
      assert.ok((provider.seen.get(endpoint) || 0) > requestsBefore, harness + ' must reach its configured local endpoint');
      assert.equal(history.events.filter(e => e.type === 'run.completed').length, 1);
      assert.ok(history.events.some(e => e.type === 'profile.applied' && e.payload.harness === harness && e.payload.computer.desktop === 'none'));
      t.diagnostic(harness + ' completed through the Rust API and ' + endpoint);
    });
  });
