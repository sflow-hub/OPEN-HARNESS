// Opt in on a disposable Linux host with Docker and a systemd user session:
// OPEN_HARNESS_REAL_RUNNER_SMOKE=1 node --import tsx tests/real-runner-smoke.mjs
// Installs the actual no-checkout runner into temporary paths, verifies real work,
// then removes only its own user service and agent container. No paid inference.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

assert.equal(process.env.OPEN_HARNESS_REAL_RUNNER_SMOKE, '1', 'Set OPEN_HARNESS_REAL_RUNNER_SMOKE=1 on a disposable Linux Docker host.');
assert.equal(process.platform, 'linux');
assert.notEqual(process.env.OPEN_HARNESS_MOCK, '1');
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(tmpdir(), 'open-harness-runner-smoke-'));
const state = join(root, 'coordinator'), runnerState = join(root, 'runner-state'), install = join(root, 'installed');
const unit = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd/user/open-harness-runner.service');
assert.equal(existsSync(unit), false, 'An existing runner service must not be overwritten.');
const runFile = promisify(execFile);
const command = async (binary, args, options = {}) => (await runFile(binary, args, { cwd: repository, encoding: 'utf8', timeout: 30_000, maxBuffer: 5_000_000, ...options })).stdout.trim();
await command('systemctl', ['--user', 'show-environment']);
const image = process.env.OPEN_HARNESS_HERMES_IMAGE || 'open-harness-hermes:2026.9.11';
await command('docker', ['image', 'inspect', image]);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
};
const coordinatorPort = await port(), fixturePort = await port();
const endpoint = `http://127.0.0.1:${coordinatorPort}`;
const agentId = `runner-smoke-${process.pid}`, containerName = `open-harness-${agentId}`;
const children = [], logs = [], snapshots = [];
let token, evidence, failure, database, sealedDispatch = false;
const child = (name, args, env = {}) => {
  const processChild = spawn(process.execPath, args, { cwd: repository, env: { ...process.env, OPEN_HARNESS_MOCK: '0', OPEN_HARNESS_DISABLE_OS_VAULT: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(processChild);
  for (const stream of [processChild.stdout, processChild.stderr]) stream.on('data', data => logs.push({ name, text: String(data) }));
  return processChild;
};
const api = async (path, method = 'GET', data) => {
  const response = await fetch(endpoint + path, { method, signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const value = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(value)}`);
  return value;
};
const waitFor = async (fn, label, timeout = 120_000) => {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (error) { if (error instanceof assert.AssertionError) throw error; last = error; }
    await pause(250);
  }
  throw new Error(`${label}: ${last || 'timed out'}`);
};
const waitRun = async run => {
  const answered = new Set();
  return waitFor(async () => {
    const snapshot = await api(`/v1/runs/${run.id}/events?after=0`);
    for (const input of snapshot.run.pendingInputs || []) if (!answered.has(input.inputId)) {
      answered.add(input.inputId);
      const dispatched = snapshot.events.find(event => event.type === 'runner.dispatched');
      const row = dispatched && database.prepare('SELECT payload_json FROM runner_commands WHERE id=?').get(dispatched.payload.commandId);
      if (row) { const payload = JSON.parse(row.payload_json); assert.ok(payload.encryptedSecrets?.RUNNER_FIXTURE_KEY); assert.ok(!payload.secrets); assert.ok(!row.payload_json.includes('local-scripted-provider-only')); sealedDispatch = true; }
      await api(`/v1/runs/${run.id}/input`, 'POST', { inputId: input.inputId, value: 'runner-answer' });
    }
    for (const approval of snapshot.run.pendingApprovals || []) if (!answered.has(approval.approvalId)) {
      answered.add(approval.approvalId);
      await api(`/v1/runs/${run.id}/approval`, 'POST', { approvalId: approval.approvalId, decision: 'approve' });
    }
    if (!['completed', 'failed', 'interrupted', 'cancelled'].includes(snapshot.run.state)) return false;
    snapshots.push(snapshot);
    assert.equal(snapshot.run.state, 'completed', JSON.stringify(snapshot));
    return snapshot;
  }, `Runner run ${run.id}`);
};
console.log(`Runner acceptance artifacts: ${root}`);
try {
  child('provider', ['tests/helpers/compose-provider.mjs'], { COMPOSE_FIXTURE_PORT: String(fixturePort), COMPOSE_REQUIRE_CREDENTIAL: '1' });
  // The container's task MCP reaches this disposable coordinator through the host bridge.
  child('coordinator', ['--import', 'tsx', 'runtime/service.ts'], { OPEN_HARNESS_STATE_DIR: state, OPEN_HARNESS_PORT: String(coordinatorPort), OPEN_HARNESS_BIND: '0.0.0.0', OPEN_HARNESS_ALLOW_LOOPBACK_PAIRING: '1' });
  token = await waitFor(async () => {
    const response = await fetch(endpoint + '/v1/bootstrap');
    return response.ok && (await response.json()).token;
  }, 'Coordinator startup', 30_000);
  await waitFor(async () => (await fetch(`http://127.0.0.1:${fixturePort}/v1/models`)).ok, 'Provider startup', 30_000);
  database = new DatabaseSync(join(state, 'state.db'));
  // Pairing creation advertises a deployable HTTPS address. This disposable test installs
  // the runner on the same host, where its actual loopback transport is explicitly allowed.
  const pairing = await api('/v1/machines', 'POST', { name: 'Real installed runner', platform: 'linux', coordinatorUrl: 'https://runner-acceptance.invalid' });
  const installer = await fetch(endpoint + '/v1/install/runner.sh');
  assert.equal(installer.status, 200);
  const script = join(root, 'install-runner.sh'); writeFileSync(script, await installer.text(), { mode: 0o600 });
  console.log('Installing and pairing the standalone Linux runner.');
  const installed = await command('sh', [script, '--coordinator', endpoint, '--pairing-code', pairing.code], { timeout: 180_000, env: { ...process.env, OPEN_HARNESS_MOCK: '0', OPEN_HARNESS_DISABLE_OS_VAULT: '1', OPEN_HARNESS_RUNNER_DIR: install, OPEN_HARNESS_RUNNER_STATE_DIR: runnerState } });
  writeFileSync(join(root, 'install.log'), installed);
  assert.ok(readFileSync(unit, 'utf8').includes(install));
  assert.ok(readFileSync(unit, 'utf8').includes(`OPEN_HARNESS_HERMES_IMAGE=${image}`));
  assert.equal(await command('systemctl', ['--user', 'is-active', 'open-harness-runner.service']), 'active');
  assert.equal(await command('systemctl', ['--user', 'is-enabled', 'open-harness-runner.service']), 'enabled');
  const connection = JSON.parse(readFileSync(join(runnerState, 'connection.json'), 'utf8'));
  const runnerHeaders = { Authorization: `Bearer ${connection.token}`, 'X-Open-Harness-Machine': connection.machineId };
  assert.equal((await fetch(endpoint + '/v1/agents', { headers: runnerHeaders })).status, 401);
  await waitFor(async () => (await api('/v1/machines')).machines.find(machine => machine.id === connection.machineId && machine.status === 'online'), 'Runner heartbeat');
  const credential = await api('/v1/credentials', 'POST', { ref: 'RUNNER_FIXTURE_KEY', label: 'Runner fixture credential', provider: 'local', value: 'local-scripted-provider-only' });
  assert.equal(credential.present, true); assert.equal(JSON.stringify(credential).includes('local-scripted-provider-only'), false);
  await api('/v1/agents/sync', 'POST', { agents: [{ id: agentId, name: 'Runner smoke', role: 'Integration verification', instructions: 'Work only on the isolated fixture.', memory: [] }] });
  const privateSource = join(state, 'agents', agentId, 'private'); mkdirSync(privateSource, { recursive: true });
  writeFileSync(join(privateSource, 'carried.txt'), 'Preserve this file when changing computers.\n');
  const contextPath = `/v1/agents/${agentId}/context`, skillPath = `${contextPath}/skills/runner-verification`;
  const originalMemory = 'Preserve RUNNER_TRANSFER_MEMORY_391 when moving computers.';
  const originalSkill = '---\nname: runner-verification\ndescription: Verify runner context.\n---\nOriginal local skill.\n';
  await api(contextPath, 'PUT', { memory: originalMemory });
  await api(skillPath, 'PUT', { content: originalSkill });
  const { profile } = await api(`/v1/agents/${agentId}/profile`);
  await api(`/v1/agents/${agentId}/profile`, 'PUT', { ...profile, model: { inherit: false, provider: 'local', model: 'compose-fixture', baseUrl: `http://127.0.0.1:${fixturePort}/v1`, credentialRef: 'RUNNER_FIXTURE_KEY' }, allowedTools: ['write_file', 'clarify', 'memory', 'skill_view', 'mcp__open_harness__task'], computer: { ...profile.computer, machineId: connection.machineId, access: 'private', desktop: 'none' } });
  await waitFor(async () => (await api(`/v1/agents/${agentId}/profile`)).profile.computer.machineId === connection.machineId, 'Verified agent transfer');
  assert.equal(readFileSync(join(runnerState, 'agents', agentId, 'private', 'carried.txt'), 'utf8'), readFileSync(join(privateSource, 'carried.txt'), 'utf8'));
  assert.equal((await api(contextPath)).memory, originalMemory);
  assert.equal((await api(skillPath)).content, originalSkill);
  const remoteMemory = `${originalMemory}\nThe dashboard remote marker is RUNNER_DASHBOARD_MEMORY_845.`;
  const remoteSkill = originalSkill + '\nRead RUNNER_SKILL_681 from the remote skill.\n';
  await api(contextPath, 'PUT', { memory: remoteMemory });
  await api(skillPath, 'PUT', { content: remoteSkill });
  assert.equal(readFileSync(join(runnerState, 'agents', agentId, 'profile', 'memories', 'MEMORY.md'), 'utf8'), remoteMemory);
  assert.equal(readFileSync(join(runnerState, 'agents', agentId, 'profile', 'skills', 'runner-verification', 'SKILL.md'), 'utf8'), remoteSkill);
  await api('/v1/boards', 'POST', { name: 'Runner acceptance board' });
  console.log('Running actual remote-container file, input, MCP and continuity flows.');
  const first = await waitRun(await api('/v1/runs', 'POST', { agentId, conversationId: 'runner-continuity', prompt: 'COMPOSE_SMOKE: Keep the continuity marker COMPOSE_SEED_729, write the artifact, clarify and list tasks.' }));
  assert.equal(first.run.machine_id, connection.machineId);
  assert.match(first.run.result, /COMPOSE_SMOKE_COMPLETE/);
  for (const type of ['clarify.request', 'input.resolved', 'message.complete']) assert.ok(first.events.some(event => event.type === type), type);
  const task = first.events.find(event => event.type === 'tool.complete' && event.payload.name === 'mcp__open_harness__task');
  assert.ok(task); assert.match(JSON.stringify(task.payload.result), /Runner acceptance board/);
  assert.equal(readFileSync(join(runnerState, 'shared', 'compose-verified.txt'), 'utf8'), 'Written through the real Compose Hermes tool loop.\n');
  assert.equal(existsSync(join(runnerState, 'shared', 'compose-forbidden.txt')), false);
  assert.equal(existsSync(join(state, 'shared', 'compose-verified.txt')), false);
  const contextRun = await waitRun(await api('/v1/runs', 'POST', { agentId, prompt: 'RUNNER_CONTEXT: Save the tool memory marker and read the runner-verification skill.' }));
  assert.match(contextRun.run.result, /RUNNER_CONTEXT_COMPLETE/);
  for (const name of ['memory', 'skill_view']) assert.ok(contextRun.events.some(event => event.type === 'tool.complete' && event.payload.name === name), name);
  assert.match((await api(contextPath)).memory, /RUNNER_TOOL_MEMORY_527/);
  assert.equal((await api(skillPath)).content, remoteSkill);
  assert.equal(readFileSync(join(state, 'agents', agentId, 'profile', 'memories', 'MEMORY.md'), 'utf8'), originalMemory);
  assert.equal(readFileSync(join(state, 'agents', agentId, 'profile', 'skills', 'runner-verification', 'SKILL.md'), 'utf8'), originalSkill);
  await api('/v1/credentials/RUNNER_FIXTURE_KEY/value', 'POST', { value: 'local-scripted-provider-rotated' });
  await command('systemctl', ['--user', 'restart', 'open-harness-runner.service']);
  const followup = await waitRun(await api('/v1/runs', 'POST', { agentId, conversationId: 'runner-continuity', prompt: 'COMPOSE_FOLLOWUP: Return the prior continuity marker.' }));
  assert.match(followup.run.result, /FOLLOWUP_COMPOSE_SEED_729/);
  assert.ok(first.run.session_id); assert.ok(followup.run.session_id);
  assert.notEqual(first.run.session_id, followup.run.session_id);
  assert.deepEqual((await api(`/v1/runs/${first.run.id}/events?after=0`)).events, first.events);
  assert.equal(await command('docker', ['inspect', '-f', '{{.State.Running}}', containerName]), 'false');
  const requests = await (await fetch(`http://127.0.0.1:${fixturePort}/__fixture/requests`)).json();
  assert.ok(sealedDispatch, 'The active remote command must contain encrypted credentials only.');
  assert.ok(requests.some(body => body.fixtureCredential === 'original'));
  assert.ok(requests.some(body => body.fixtureCredential === 'rotated'));
  assert.ok(requests.every(body => body.fixtureCredential !== 'invalid'));
  assert.ok((await api('/v1/credentials/RUNNER_FIXTURE_KEY')).lastUsedAt);
  assert.ok(requests.some(body => body.messages?.some(message => message.role === 'system' && String(message.content).includes('RUNNER_DASHBOARD_MEMORY_845'))));
  assert.ok(requests.some(body => body.messages?.some(message => message.role === 'tool' && message.tool_call_id === 'compose-skill_view' && String(message.content).includes('RUNNER_SKILL_681'))));
  assert.ok(requests.some(body => body.messages?.some(message => message.role === 'tool' && message.tool_call_id === 'compose-terminal' && /tool_disabled|does not exist/.test(String(message.content)))));
  await api(skillPath, 'DELETE');
  assert.equal(existsSync(join(runnerState, 'agents', agentId, 'profile', 'skills', 'runner-verification')), false);
  assert.equal(readFileSync(join(state, 'agents', agentId, 'profile', 'skills', 'runner-verification', 'SKILL.md'), 'utf8'), originalSkill);
  await api(`/v1/machines/${connection.machineId}/revoke`, 'POST');
  assert.equal((await fetch(endpoint + '/v1/runner/commands', { headers: runnerHeaders })).status, 401);
  evidence = { ok: true, mode: 'actual standalone Linux runner and real Docker Hermes with scripted provider', root, image, encryptedCredentialDispatch: sealedDispatch, credentialRotation: true, providerAuthenticated: true, runnerInstalled: true, userService: true, scopedCredential: true, agentTransfer: true, fileTool: true, clarification: true, taskMcp: true, deniedTerminal: true, runnerRestart: true, crossRunContext: true, remoteMemoryAndSkills: true, localContextPreserved: true, eventReplay: true, stoppedContainer: true, revokedCredential: true };
} catch (error) { failure = error; }
finally {
  database?.close();
  if (existsSync(unit) && readFileSync(unit, 'utf8').includes(install)) {
    try {
      writeFileSync(join(root, 'runner-service.log'), await command('journalctl', ['--user', '-u', 'open-harness-runner.service', '--no-pager', '-n', '100']));
      await command('systemctl', ['--user', 'disable', '--now', 'open-harness-runner.service']);
      unlinkSync(unit); await command('systemctl', ['--user', 'daemon-reload']);
    } catch (error) { failure ||= error; }
  }
  for (const processChild of children) {
    if (processChild.exitCode !== null || processChild.signalCode !== null) continue;
    const exited = new Promise(resolve => processChild.once('close', resolve));
    processChild.kill('SIGTERM'); const force = setTimeout(() => processChild.kill('SIGKILL'), 20_000);
    await exited; clearTimeout(force);
  }
  try { await command('docker', ['rm', '-f', containerName]); } catch { /* No container if setup failed. */ }
  writeFileSync(join(root, 'diagnostics.json'), JSON.stringify({ error: failure ? String(failure.stack || failure) : null, snapshots, logs }, null, 2));
}
if (failure) { console.error(`Runner acceptance failed; diagnostics: ${root}`); throw failure; }
evidence.serviceRemoved = !existsSync(unit);
assert.equal(evidence.serviceRemoved, true);
writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
