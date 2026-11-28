import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const binary = process.env.OPEN_HARNESS_RUST_RUNNER;
const live = process.env.OPEN_HARNESS_RUST_LIVE === '1';
const repo = resolve(import.meta.dirname, '../../..');
const coordinatorBinary = process.env.OPEN_HARNESS_TEST_NATIVE_BINARY || join(repo, 'target/debug/open-harness');
const answer = 'The Rust runner completed the task.';
const providerKey = 'pilot-provider-key';
const model = 'gpt-4o-mini';

async function listen(server, host = '127.0.0.1') {
  server.listen(0, host);
  await once(server, 'listening');
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}

async function stop(child, signal = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode) return;
  child.kill(signal);
  await once(child, 'exit');
}

async function until(action, label, logs) {
  const deadline = Date.now() + (live ? 420_000 : 25_000);
  while (Date.now() < deadline) {
    const result = await action();
    if (result) return result;
    await delay(100);
  }
  assert.fail(`Timed out waiting for ${label}.\n${logs()}`);
}

async function bodyOf(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('the Rust runner delivers ordered events and an unacknowledged result after restart', { timeout: live ? 600_000 : 140_000 }, async (t) => {
  assert.ok(binary, 'Set OPEN_HARNESS_RUST_RUNNER to the built runner executable.');
  const temp = mkdtempSync(join(tmpdir(), 'open-harness-rust-recovery-'));
  const state = join(temp, 'runner');
  let logs = '';
  const runProcess = (command, args, env) => {
    const child = spawn(command, args, { cwd: repo, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { logs = (logs + chunk).slice(-7000); });
    return child;
  };
  const children = [];
  const servers = [];
  t.after(async () => {
    await Promise.all(children.reverse().map((child) => stop(child, 'SIGKILL')));
    await Promise.all(servers.map(close));
    rmSync(temp, { recursive: true, force: true });
  });
  const addServer = (handler) => {
    const server = createServer((request, response) => {
      handler(request, response).catch((error) => {
        logs += `\nFixture HTTP failure: ${error.message}`;
        response.writeHead(500).end('{}');
      });
    });
    servers.push(server);
    return server;
  };

  let streamedTurns = 0;
  let endpoint = 'http://host.docker.internal:1/v1';
  if (live) {
    const provider = addServer(async (request, response) => {
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model' }] }));
        return;
      }
      assert.equal(request.headers.authorization, `Bearer ${providerKey}`);
      const { stream } = JSON.parse(await bodyOf(request));
      assert.equal(request.url, '/v1/chat/completions');
      const base = { id: 'chatcmpl-rust-test', created: 1, model };
      if (stream) {
        streamedTurns += 1;
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const [delta, finish_reason] of [[{ role: 'assistant', content: answer }, null], [{}, 'stop']]) {
          response.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        }
        response.end('data: [DONE]\n\n');
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17 } }));
      }
    });
    const providerPort = await listen(provider, '0.0.0.0');
    endpoint = `http://${process.env.OPEN_HARNESS_RUST_PROVIDER_HOST || 'host.docker.internal'}:${providerPort}/v1`;
  }

  const coordinatorState = join(temp, 'coordinator');
  children.push(runProcess(coordinatorBinary, ['serve', '--port', '0', '--bind', '127.0.0.1', '--state-dir', coordinatorState], {
    OPEN_HARNESS_MOCK: '1', OPEN_HARNESS_DISABLE_OS_VAULT: '1',
  }));
  const base = await until(() => logs.match(/serving (http:\/\/127\.0\.0\.1:\d+)/)?.[1], 'coordinator address', () => logs);
  const token = await until(async () => {
    const response = await fetch(base + '/v1/bootstrap').catch(() => null);
    if (!response?.ok) return null;
    const bootstrap = await response.json();
    return bootstrap.runtime?.available && bootstrap.token;
  }, 'coordinator startup', () => logs);
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, {
      method, body: JSON.stringify(body), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    const result = await response.json();
    assert.ok(response.ok, `${method} ${path} returned ${response.status} ${JSON.stringify(result)}`);
    return result;
  };

  let blockCompletion = true;
  let runCommandId;
  let lostEvent;
  const eventAttempts = [];
  const completionAttempts = [];
  const proxy = addServer(async (request, response) => {
    const data = await bodyOf(request);
    const payload = data.length ? JSON.parse(data) : {};
    const match = request.url.match(/^\/v1\/runner\/commands\/([^/]+)\/(events|complete)$/);
    if (match?.[1] === runCommandId && match?.[2] === 'complete') {
      completionAttempts.push(payload);
      if (blockCompletion) return;
    }
    const upstream = await fetch(base + request.url, {
      method: request.method, body: data.length ? data : undefined,
      headers: Object.fromEntries(['authorization', 'x-open-harness-machine', 'content-type']
        .filter((header) => request.headers[header]).map((header) => [header, request.headers[header]])),
    });
    const bytes = await upstream.arrayBuffer();
    if (request.url === '/v1/runner/commands') {
      const command = JSON.parse(Buffer.from(bytes)).commands?.find((entry) => entry.kind === 'run');
      if (command) runCommandId = command.id;
    }
    if (match?.[2] === 'events') {
      assert.ok(upstream.ok, 'runner event must be accepted by the real coordinator');
      eventAttempts.push(payload);
      if (!lostEvent && payload.event.type === 'message.delta') {
        lostEvent = payload.eventId;
        response.destroy();
        return;
      }
    }
    response.writeHead(upstream.status, { 'Content-Type': 'application/json' }).end(Buffer.from(bytes));
  });
  const runnerPort = await listen(proxy);
  const runnerBase = `http://127.0.0.1:${runnerPort}`;

  let runnerPath = process.env.PATH;
  if (!live) {
    const bin = join(temp, 'bin');
    mkdirSync(bin);
    copyFileSync(join(import.meta.dirname, 'fake-docker.mjs'), join(bin, 'docker'));
    chmodSync(join(bin, 'docker'), 0o755);
    runnerPath = `${bin}:${runnerPath}`;
  }
  const { code } = await api('/v1/machines', 'POST', { name: 'Rust pilot', platform: 'linux' });
  const runner = (args) => {
    const child = runProcess(binary, args, { PATH: runnerPath, OPEN_HARNESS_RUNNER_STATE_DIR: state });
    children.push(child);
    return child;
  };
  const first = runner(['--coordinator', runnerBase, '--pairing-code', code]);
  const saved = await until(() => {
    try { return JSON.parse(readFileSync(join(state, 'rust-connection.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
  }, 'pairing', () => logs);
  assert.equal(statSync(join(state, 'rust-connection.json')).mode & 0o777, 0o600);

  const profilePath = '/v1/agents/atlas/profile';
  await api('/v1/agents', 'POST', { id: 'atlas', name: 'Atlas', role: 'Test agent', harness: 'hermes' });
  await api('/v1/secrets', 'POST', { name: 'RUST_PILOT_KEY', value: providerKey });
  const { profile } = await api(profilePath);
  const source = join(coordinatorState, 'agents/atlas/private');
  await api('/v1/files?scope=private&agentId=atlas', 'POST', { name: 'imported.txt', content: 'Move this file with the agent.' });
  await api(profilePath, 'PUT', {
    ...profile, allowedTools: [],
    model: { inherit: false, provider: 'openai', model, credentialRef: 'RUST_PILOT_KEY', baseUrl: endpoint },
    computer: { ...profile.computer, access: 'private', desktop: 'none' },
  });
  await api('/v1/agents/atlas/transfer', 'POST', { destinationMachineId: saved.machineId });
  const assignment = await until(async () => {
    const value = await api(profilePath);
    return ['completed', 'failed'].includes(value.transfer?.state) && value;
  }, 'agent transfer', () => logs);
  assert.equal(assignment.transfer.state, 'completed', assignment.transfer.detail);
  assert.equal(readFileSync(join(state, 'agents/atlas/private/imported.txt'), 'utf8'), 'Move this file with the agent.');

  const run = await api('/v1/runs', 'POST', { agentId: 'atlas', prompt: 'Say the Rust runner completed the task.' });
  const outbox = join(state, 'rust-outbox');
  await until(() => completionAttempts[0], 'first completion delivery', () => logs);
  assert.deepEqual(completionAttempts[0].error, undefined, logs);
  assert.ok(readdirSync(outbox).some((name) => name.endsWith('.json')));
  assert.equal((await api(`/v1/runs/${run.id}`)).state, 'running');
  await stop(first, 'SIGKILL');
  blockCompletion = false;
  runner([]);

  const finished = await until(async () => {
    const value = await api(`/v1/runs/${run.id}`);
    return ['completed', 'failed', 'interrupted'].includes(value.state) && value;
  }, 'replayed completion', () => logs);
  assert.equal(finished.state, 'completed', JSON.stringify(finished));
  assert.equal(finished.result, answer);
  await until(() => readdirSync(outbox).length === 0, 'empty durable outbox', () => logs);
  assert.deepEqual(completionAttempts.at(-1), completionAttempts[0]);
  assert.ok(completionAttempts.length >= 2);
  assert.ok(lostEvent, 'at least one accepted event acknowledgment was lost');
  assert.equal(eventAttempts.filter((event) => event.eventId === lostEvent).length, 2);
  const { events } = await api(`/v1/runs/${run.id}/events`);
  const deliveries = [...new Map(eventAttempts.map((item) => [item.eventId, item.event.type])).values()];
  const relevant = new Set(deliveries);
  assert.deepEqual(events.filter((event) => relevant.has(event.type)).map((event) => event.type), deliveries);
  if (live) {
    // Hermes also makes an auxiliary non-streaming request to name the session.
    assert.equal(streamedTurns, 1, 'the Hermes prompt must only execute once');
    assert.equal(events.filter((event) => event.type === 'message.complete').length, 1);
  }
  else assert.equal(readFileSync(join(state, 'docker-starts'), 'utf8'), 'start\n');

  const movedFile = join(state, 'agents/atlas/private/returned.txt');
  const returned = live ? 'Move back to the coordinator.' : 'r'.repeat(4_000_000);
  writeFileSync(movedFile, returned);
  await api('/v1/agents/atlas/transfer', 'POST', { destinationMachineId: 'local' });
  const movedBack = await until(async () => {
    const value = await api(profilePath);
    return (value.transfer?.state === 'failed' || value.profile.computer.machineId === 'local') && value;
  }, 'agent transfer back', () => logs);
  assert.equal(movedBack.transfer.state, 'completed', movedBack.transfer.detail);
  assert.equal(readFileSync(join(source, 'returned.txt'), 'utf8'), returned);
});
