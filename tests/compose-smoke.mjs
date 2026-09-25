// Opt in after npm run harness:setup: OPEN_HARNESS_COMPOSE_SMOKE=1
// node --import tsx tests/compose-smoke.mjs
// Add OPEN_HARNESS_COMPOSE_BUILD_RUNTIME=1 to build through paired first-run setup
// instead of loading a prebuilt host image. This requires network access and extra time.
// --config-only validates the generated overlay without building or starting Docker.
// Real pinned Hermes uses a disposable scripted provider, not paid/model inference.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { HERMES_IMAGE } from '../runtime/readiness.ts';
import { generateRunnerKeyPair } from '../lib/runner-crypto.ts';

const configOnly = process.argv.includes('--config-only');
const buildRuntime = process.env.OPEN_HARNESS_COMPOSE_BUILD_RUNTIME === '1';
assert.ok(configOnly || process.env.OPEN_HARNESS_COMPOSE_SMOKE === '1', 'Set OPEN_HARNESS_COMPOSE_SMOKE=1 to build and run the isolated Compose stack.');
assert.notEqual(process.env.OPEN_HARNESS_MOCK, '1', 'Compose acceptance must exercise real Hermes.');
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(tmpdir(), 'open-harness-compose-smoke-'));
const project = `oh-compose-smoke-${randomUUID().slice(0, 8)}`;
const coordinatorImage = `${project}-coordinator:smoke`;
const docker = process.env.OPEN_HARNESS_DOCKER_BINARY || 'docker';
const composeBinary = process.env.OPEN_HARNESS_COMPOSE_BINARY || docker;
const composePrefix = process.env.OPEN_HARNESS_COMPOSE_BINARY ? [] : ['compose'];
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|HOME|TMPDIR|DOCKER_.*)$/.test(name))), OPEN_HARNESS_PUBLIC_URL: 'http://localhost:3000/api/local', OPEN_HARNESS_LISTEN_ADDRESS: '127.0.0.1' };
const composeArgs = [...composePrefix, '--project-name', project, '--project-directory', repository, '--env-file', join(root, 'compose.env'), '-f', join(repository, 'compose.yaml'), '-f', join(root, 'override.yaml')];
const runFile = promisify(execFile);
const command = async (binary, args, timeout = 30_000) => (await runFile(binary, args, { cwd: repository, env, encoding: 'utf8', timeout, maxBuffer: 12 * 1024 * 1024 })).stdout.trim();
const dc = (args, timeout) => command(composeBinary, [...composeArgs, ...args], timeout);
const nodeIn = async (service, script) => JSON.parse(await dc(['exec', '-T', service, 'node', '--input-type=module', '-e', script]));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const save = (name, value) => writeFileSync(join(root, name), JSON.stringify(value, null, 2));
writeFileSync(join(root, 'project.txt'), project);
writeFileSync(join(root, 'compose.env'), '');
writeFileSync(join(root, 'override.yaml'), `services:
  open-harness:
    image: ${coordinatorImage}
    ports: !override
      - "127.0.0.1::3000"
    environment:
      OPEN_HARNESS_HERMES_IMAGE: ${JSON.stringify(HERMES_IMAGE)}
      OPEN_HARNESS_DISABLE_OS_VAULT: "1"
      OPEN_HARNESS_MOCK: "0"
  fixture:
    image: ${coordinatorImage}
    entrypoint: ["node", "/fixture/compose-provider.mjs"]
    command: []
    volumes:
      - type: bind
        source: ${JSON.stringify(join(repository, 'tests/helpers/compose-provider.mjs'))}
        target: /fixture/compose-provider.mjs
        read_only: true
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3131/v1/models').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 2s
      timeout: 3s
      retries: 20
`);

const config = JSON.parse(await dc(['config', '--format', 'json']));
assert.equal(config.services.docker.environment.DOCKER_HOST, 'unix:///run/open-harness-docker/docker.sock');
assert.equal(config.services['open-harness'].environment.DOCKER_HOST, config.services.docker.environment.DOCKER_HOST);
assert.equal(config.services['open-harness'].environment.OPEN_HARNESS_DISABLE_BROWSER_BOOTSTRAP, '1');
assert.equal(config.services['open-harness'].environment.OPEN_HARNESS_ALLOW_LOOPBACK_PAIRING, '1');
assert.deepEqual(config.services.docker.ports || [], []);
assert.deepEqual(config.services.docker.command, ['dockerd', '--host=unix:///run/open-harness-docker/docker.sock', '--group=1000']);
assert.deepEqual(Object.entries(config.services).filter(([, service]) => service.volumes?.some(volume => volume.source === 'harness-control')).map(([name]) => name).sort(), ['docker', 'open-harness']);
assert.equal(config.services['open-harness'].stop_grace_period, '30s');
assert.equal(config.services['open-harness'].init, true);
assert.equal(config.services.docker.stop_grace_period, '30s');
assert.equal(config.services['open-harness'].ports.length, 1);
assert.equal(config.services['open-harness'].ports[0].host_ip, '127.0.0.1');
save('config.json', config);
console.log(`Compose acceptance artifacts: ${root}`);
if (configOnly) {
  console.log(JSON.stringify({ mode: 'config-only', project, root, runtimeExecuted: false }));
  process.exit(0);
}

// Stream the already-built image into DinD, avoiding another build/download and
// another complete image archive on the runner's limited disk.
async function loadNestedImage() {
  const saveImage = spawn(docker, ['image', 'save', HERMES_IMAGE], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const loadImage = spawn(composeBinary, [...composeArgs, 'exec', '-T', 'docker', 'docker', 'load'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const output = [];
  for (const child of [saveImage, loadImage]) child.stderr.on('data', data => output.push(String(data)));
  loadImage.stdout.on('data', data => output.push(String(data)));
  const timer = setTimeout(() => { saveImage.kill('SIGKILL'); loadImage.kill('SIGKILL'); }, 8 * 60_000);
  const finished = child => new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`Image transfer exited ${code ?? signal}: ${output.join('')}`))); });
  const jobs = [finished(saveImage), finished(loadImage)];
  // A failed docker load may close stdin early; its exit status supplies context.
  loadImage.stdin.on('error', () => {});
  saveImage.stdout.pipe(loadImage.stdin);
  try { await Promise.all(jobs); }
  finally { clearTimeout(timer); saveImage.kill('SIGKILL'); loadImage.kill('SIGKILL'); writeFileSync(join(root, 'image-load.log'), output.join('')); }
}

let started = false, token, deviceHeaders, endpoint, firstSnapshot, followupSnapshot, evidence;
const snapshots = [];
const publishedEndpoints = [];
async function refreshEndpoint() {
  const published = await dc(['port', 'open-harness', '3000']);
  assert.match(published, /^127\.0\.0\.1:\d+$/);
  endpoint = `http://${published}`;
  publishedEndpoints.push(endpoint);
}
const api = async (path, method = 'GET', data) => {
  const response = await fetch(endpoint + '/api/local' + path, { method, signal: AbortSignal.timeout(15_000), headers: { ...(deviceHeaders || { Authorization: `Bearer ${token}` }), 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const value = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(value)}`);
  return value;
};
// Node fetch itself stops waiting for response headers after five minutes. Give
// this client a build-sized deadline while still testing the actual dashboard proxy.
const prepareRuntime = () => new Promise((resolve, reject) => {
  const body = JSON.stringify({ action: 'prepare-runtime' });
  const request = httpRequest(endpoint + '/api/local/v1/onboarding/action', { method: 'POST', signal: AbortSignal.timeout(20 * 60_000), headers: { ...deviceHeaders, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
    let output = '';
    response.setEncoding('utf8');
    response.on('data', chunk => { output += chunk; });
    response.once('error', reject);
    response.once('end', () => {
      try { assert.equal(response.statusCode, 200, `Paired runtime setup failed: ${output}`); resolve(JSON.parse(output)); }
      catch (error) { reject(error); }
    });
  });
  request.once('error', reject);
  request.end(body);
});
const operatorToken = async () => (await nodeIn('open-harness', `const r = await fetch('http://127.0.0.1:4317/v1/bootstrap'); if (!r.ok) throw new Error('Operator bootstrap failed: '+r.status); console.log(JSON.stringify({token:(await r.json()).token}));`)).token;
async function waitRun(run, { waitForInput = false } = {}) {
  const deadline = Date.now() + 120_000, answered = new Set();
  while (Date.now() < deadline) {
    const snapshot = await api(`/v1/runs/${run.id}/events?after=0`);
    if (waitForInput && snapshot.run.pendingInputs?.length) return snapshot;
    for (const pending of snapshot.run.pendingInputs || []) {
      if (!answered.has(pending.inputId)) { answered.add(pending.inputId); await api(`/v1/runs/${run.id}/input`, 'POST', { inputId: pending.inputId, value: 'compose-answer' }); }
    }
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(snapshot.run.state)) {
      snapshots.push(snapshot);
      assert.equal(snapshot.run.state, 'completed', JSON.stringify(snapshot));
      assert.equal(waitForInput, false, 'Shutdown fixture completed before waiting for input.');
      return snapshot;
    }
    await pause(150);
  }
  throw new Error(`Compose run ${run.id} timed out.`);
}
const nestedRunning = async () => (await dc(['exec', '-T', 'docker', 'docker', 'inspect', '-f', '{{.State.Running}}', 'open-harness-compose-smoke'])) === 'true';
let failure;
let runtimeSetup = { mode: buildRuntime ? 'paired-api-build' : 'prebuilt-image-transfer' };
try {
  if (!buildRuntime) await command(docker, ['image', 'inspect', HERMES_IMAGE]);
  console.log('Building the production coordinator image.');
  await dc(['build', 'open-harness'], 12 * 60_000);
  started = true;
  await dc(['up', '-d', '--wait', '--wait-timeout', '180', 'docker', 'open-harness', 'fixture'], 210_000);
  if (!buildRuntime) {
    console.log('Loading the pinned Hermes image into the private nested daemon.');
    await loadNestedImage();
  }
  const fixtureId = await dc(['ps', '-q', 'fixture']);
  const fixture = JSON.parse(await command(docker, ['inspect', fixtureId]))[0];
  const providerIp = fixture.NetworkSettings.Networks[`${project}_default`]?.IPAddress;
  assert.equal(isIP(providerIp || ''), 4, 'The fixture must have an explicit outer Compose network IPv4 address.');
  assert.ok(!providerIp.startsWith('127.'));
  assert.equal(fixture.Config.User, 'node');
  assert.ok(fixture.Mounts.every(mount => mount.Destination !== '/run/open-harness-docker' && mount.Destination !== '/data'));
  const baseUrl = `http://${providerIp}:3131/v1`;
  await refreshEndpoint();
  const dashboard = await fetch(endpoint, { signal: AbortSignal.timeout(15_000) });
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.match(dashboard.headers.get('content-security-policy') || '', /object-src 'none'/);
  assert.equal(dashboard.headers.get('x-content-type-options'), 'nosniff');
  for (const headers of [{}, { Authorization: 'Bearer invalid-fixture-token' }]) assert.equal((await fetch(endpoint + '/api/local/v1/agents', { headers, signal: AbortSignal.timeout(15_000) })).status, 401);
  const bootstrap = await nodeIn('fixture', `import http from 'node:http'; const out=[]; for(const host of ['open-harness:3000','127.0.0.1:3000','localhost:3000']) out.push(await new Promise((resolve,reject)=>{const q=http.get({hostname:'open-harness',port:3000,path:'/api/local/v1/bootstrap',headers:{Host:host}},r=>{let body='';r.on('data',v=>body+=v);r.on('end',()=>resolve({host,status:r.statusCode,hasToken:body.includes('"token"')}));});q.on('error',reject);q.setTimeout(5000,()=>q.destroy(new Error('bootstrap timeout')));}));console.log(JSON.stringify(out));`);
  for (const response of bootstrap) { assert.equal(response.status, 403); assert.equal(response.hasToken, false); }
  const tcp = await nodeIn('fixture', `import net from 'node:net'; const out=[]; for(const port of [2375,2376]) out.push(await new Promise(resolve=>{const socket=net.connect({host:'docker',port});const finish=open=>{socket.destroy();resolve({port,open});};socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));socket.setTimeout(1500,()=>finish(false));}));console.log(JSON.stringify(out));`);
  assert.ok(tcp.every(result => !result.open), 'The private Docker daemon must have no TCP listener.');
  const dindId = await dc(['ps', '-q', 'docker']);
  const dind = JSON.parse(await command(docker, ['inspect', dindId]))[0];
  assert.ok(Object.values(dind.HostConfig.PortBindings || {}).every(bindings => !bindings?.length));
  const identity = await nodeIn('open-harness', `import fs from 'node:fs'; console.log(JSON.stringify({uid:process.getuid(),dataUid:fs.statSync('/data').uid}));`);
  assert.deepEqual(identity, { uid: 1000, dataUid: 1000 });
  token = await operatorToken(); assert.ok(token);
  const pairing = await api('/v1/machines', 'POST', { kind: 'device', platform: 'android', name: 'Compose browser' });
  assert.equal(pairing.kind, 'device');
  const encryption = await generateRunnerKeyPair();
  const pairBody = { code: pairing.code, name: 'Compose browser', platform: 'android', arch: 'arm64', capabilities: { mobile: true }, encryptionPublicKey: encryption.publicKey };
  const pairRequest = () => fetch(endpoint + '/api/local/v1/runner/pair', { method: 'POST', signal: AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pairBody) });
  const pairResponse = await pairRequest(); assert.equal(pairResponse.status, 201);
  const paired = await pairResponse.json(); assert.ok(paired.token); assert.notEqual(paired.token, token);
  deviceHeaders = { Authorization: `Bearer ${paired.token}`, 'X-Open-Harness-Machine': paired.machineId };
  const deviceSession = await api('/v1/device/session');
  assert.equal(deviceSession.token, ''); assert.equal(deviceSession.machine.kind, 'device');
  assert.equal((await pairRequest()).status, 410, 'A browser pairing code must be single-use.');
  assert.equal((await fetch(endpoint + '/api/local/v1/runner/commands', { headers: deviceHeaders, signal: AbortSignal.timeout(15_000) })).status, 401, 'A browser credential must not lease runner work.');
  // All remaining dashboard operations use the paired device credential.
  if (buildRuntime) {
    const before = await api('/v1/onboarding/status');
    assert.equal(before.executionReady, false, 'A fresh Compose stack must report its missing runtime.');
    assert.equal(before.checks.find(check => check.id === 'agent-runtime')?.action, 'prepare-runtime');
    assert.equal(await dc(['exec', '-T', 'docker', 'docker', 'image', 'ls', '-q', HERMES_IMAGE]), '', 'The fresh daemon must not contain a preloaded Hermes image.');
    runtimeSetup = { ...runtimeSetup, before, startedAt: new Date().toISOString() };
    save('runtime-setup.json', runtimeSetup);
    console.log('Building the missing Hermes runtime through paired dashboard setup.');
    const startedAt = Date.now();
    const result = await prepareRuntime();
    assert.equal(result.executionReady, true, JSON.stringify(result));
    const after = await api('/v1/onboarding/status');
    assert.equal(after.executionReady, true);
    assert.equal(after.checks.find(check => check.id === 'agent-runtime')?.state, 'ready');
    await dc(['exec', '-T', 'docker', 'docker', 'image', 'inspect', HERMES_IMAGE]);
    runtimeSetup = { ...runtimeSetup, after, durationMs: Date.now() - startedAt, pairedSetupSucceeded: true };
    save('runtime-setup.json', runtimeSetup);
  }
  const agentId = 'compose-smoke', conversationId = 'compose-continuity';
  await api('/v1/secrets', 'POST', { name: 'COMPOSE_FIXTURE_KEY', value: 'local-scripted-provider-only' });
  await api('/v1/agents/sync', 'POST', { agents: [{ id: agentId, name: 'Compose smoke', role: 'Integration verification', instructions: 'Work only on this isolated acceptance task.', memory: [] }] });
  const { profile } = await api(`/v1/agents/${agentId}/profile`);
  const saved = await api(`/v1/agents/${agentId}/profile`, 'PUT', { ...profile, model: { inherit: false, provider: 'local', model: 'compose-fixture', baseUrl, credentialRef: 'COMPOSE_FIXTURE_KEY' }, allowedTools: ['write_file', 'clarify', 'mcp_open_harness_task'], computer: { ...profile.computer, access: 'private', desktop: 'none' } });
  const board = await api('/v1/boards', 'POST', { name: 'Compose acceptance board' });
  const task = await api('/v1/tasks', 'POST', { boardId: board.id, stageId: board.stages[0].id, title: 'Compose persists this card', ownerAgentId: agentId });
  console.log('Exercising real Hermes file, input, task MCP, policy, and conversation flows.');
  const first = await api('/v1/runs', 'POST', { agentId, conversationId, prompt: 'COMPOSE_SMOKE: The continuity marker is COMPOSE_SEED_729. Write the artifact, clarify, list tasks, and finish.' });
  firstSnapshot = await waitRun(first);
  assert.match(firstSnapshot.run.result, /COMPOSE_SMOKE_COMPLETE/);
  for (const type of ['clarify.request', 'input.resolved', 'message.complete']) assert.ok(firstSnapshot.events.some(event => event.type === type), type);
  assert.ok(firstSnapshot.events.some(event => event.type === 'tool.complete' && event.payload.name === 'write_file'));
  const coordination = firstSnapshot.events.find(event => event.type === 'tool.complete' && event.payload.name === 'mcp__open_harness__task');
  assert.ok(coordination, 'The actual Hermes MCP child must reach the coordinator through its mounted socket.');
  assert.match(JSON.stringify(coordination.payload.result), /Compose acceptance board/);
  assert.doesNotMatch(JSON.stringify(coordination.payload.result), /disabled|authentication|ECONNREFUSED/);
  const artifact = await api('/v1/files?scope=shared&name=compose-verified.txt');
  assert.equal(artifact.content, 'Written through the real Compose Hermes tool loop.\n');
  const disk = await nodeIn('open-harness', `import fs from 'node:fs'; console.log(JSON.stringify({content:fs.readFileSync('/data/shared/compose-verified.txt','utf8'),denied:fs.existsSync('/data/shared/compose-forbidden.txt'),baseUrl:JSON.parse(fs.readFileSync('/data/agents/compose-smoke/profile/config.yaml','utf8')).model.base_url}));`);
  assert.equal(disk.content, artifact.content); assert.equal(disk.denied, false); assert.equal(disk.baseUrl, baseUrl);
  assert.equal(await nestedRunning(), false, 'Completed work must stop the nested agent container.');
  const second = await api('/v1/runs', 'POST', { agentId, conversationId, prompt: 'COMPOSE_FOLLOWUP: Return the prior continuity marker.' });
  followupSnapshot = await waitRun(second);
  assert.match(followupSnapshot.run.result, /FOLLOWUP_COMPOSE_SEED_729/);
  assert.notEqual(firstSnapshot.run.session_id, followupSnapshot.run.session_id);
  assert.deepEqual((await api(`/v1/runs/${first.id}/events?after=0`)).events, firstSnapshot.events);
  assert.equal(await nestedRunning(), false);
  const requests = await nodeIn('fixture', `console.log(JSON.stringify(await (await fetch('http://127.0.0.1:3131/__fixture/requests')).json()));`);
  save('provider-requests.json', requests);
  const mainRequests = requests.filter(body => body.tools?.some(tool => tool.function?.name === 'write_file') && body.messages?.some(message => String(message.content).includes('COMPOSE_SMOKE')));
  assert.ok(mainRequests.length >= 5);
  for (const body of mainRequests) assert.ok(body.tools.every(tool => ['write_file', 'clarify', 'mcp__open_harness__task'].includes(tool.function?.name)));
  assert.ok(mainRequests.some(body => body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'compose-terminal' && /tool_disabled|does not exist/.test(String(message.content)))), 'Ungrantable fixture tool calls must be rejected by the real dispatch policy.');
  console.log('Restarting the coordinator and checking durable state.');
  await dc(['restart', 'open-harness'], 45_000);
  // Docker may allocate a different ephemeral host port when the container restarts.
  await refreshEndpoint();
  let ready = false, readinessError;
  for (let attempt = 0; attempt < 100; attempt += 1) { try { await api('/v1/agents'); ready = true; break; } catch (error) { readinessError = error; await pause(300); } }
  assert.ok(ready, `Coordinator must recover after restart: ${readinessError}`);
  assert.equal(await operatorToken(), token, 'Control token must survive restart.');
  assert.equal((await api('/v1/device/session')).token, '', 'The paired browser session must survive restart without exposing the master token.');
  assert.deepEqual((await api(`/v1/agents/${agentId}/profile`)).profile, saved.profile);
  assert.equal((await api(`/v1/tasks/${task.id}`)).title, task.title);
  assert.equal((await api('/v1/files?scope=shared&name=compose-verified.txt')).content, artifact.content);
  const history = (await api(`/v1/conversations?agentId=${agentId}`)).conversations.find(item => item.id === conversationId);
  assert.deepEqual(history.runs.map(run => run.id), [first.id, second.id]);
  assert.deepEqual((await api(`/v1/runs/${first.id}/events?after=0`)).events, firstSnapshot.events);
  console.log('Stopping the stack with a real Hermes run waiting for input.');
  const shutdown = await api('/v1/runs', 'POST', { agentId, conversationId: 'compose-shutdown', prompt: 'COMPOSE_SHUTDOWN: Ask for input and stay waiting.' });
  const waiting = await waitRun(shutdown, { waitForInput: true });
  assert.ok(waiting.run.pendingInputs.length); assert.equal(await nestedRunning(), true);
  const agentContainer = JSON.parse(await dc(['exec', '-T', 'docker', 'docker', 'inspect', 'open-harness-compose-smoke']))[0];
  const agentMounts = agentContainer.Mounts.map(mount => ({ source: mount.Source, destination: mount.Destination, type: mount.Type, writable: mount.RW })).sort((a, b) => a.destination.localeCompare(b.destination));
  // The exact source/destination set also excludes the Docker control socket,
  // its private volume, and the coordinator's /data root even if renamed.
  assert.deepEqual(agentMounts, [
    { source: '/data/agents/compose-smoke/profile', destination: '/home/hermes/.hermes', type: 'bind', writable: true },
    { source: '/data/agents/compose-smoke/managed', destination: '/run/open-harness', type: 'bind', writable: false },
    { source: '/data/agents/compose-smoke/private', destination: '/workspace/private', type: 'bind', writable: true },
    { source: '/data/shared', destination: '/workspace/shared', type: 'bind', writable: true },
  ]);
  const coordinatorId = await dc(['ps', '-q', 'open-harness']);
  await dc(['stop', '--timeout', '30', 'open-harness'], 40_000);
  const stopped = JSON.parse(await command(docker, ['inspect', coordinatorId]))[0];
  assert.equal(stopped.HostConfig.Init, true, 'The coordinator needs an init process to reap orphaned subprocesses.');
  assert.equal(stopped.State.Running, false); assert.equal(stopped.State.ExitCode, 0, 'The supervisor must finish graceful cleanup before Docker kills it.');
  assert.equal(await nestedRunning(), false, 'Coordinator shutdown must stop its real nested agent before DinD stops.');
  evidence = { ok: true, mode: 'real Compose stack and pinned Hermes with scripted completion fixture; not model reasoning', project, root, image: HERMES_IMAGE, providerIp, dashboardCsp: true, authenticatedApi: true, devicePairing: true, singleUsePairing: true, deviceRunnerScopeDenied: true, remoteBootstrapDenied: bootstrap, privateDockerTcp: tcp, identity, agentMounts, fileTool: true, clarification: true, taskMcp: true, deniedTerminal: true, freshSessionContext: true, replayStable: true, restartPersistence: true, gracefulAgentCleanup: true, firstRun: first.id, followupRun: second.id };
} catch (error) { failure = error; }
finally {
  save('diagnostics.json', { error: failure ? String(failure.stack || failure) : null, runtimeSetup, publishedEndpoints, snapshots });
  if (started) {
    try { writeFileSync(join(root, 'compose.log'), await dc(['logs', '--no-color'], 20_000)); } catch (error) { console.error('Could not collect Compose logs:', String(error)); }
    try {
      await dc(['down', '--volumes', '--remove-orphans', '--timeout', '30'], 60_000);
      assert.equal(await command(docker, ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]), '');
      assert.equal(await command(docker, ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]), '');
      assert.equal(await command(docker, ['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]), '');
      if (evidence) evidence.projectResourcesRemoved = true;
    } catch (error) { failure ||= error; }
  }
  try { await command(docker, ['image', 'rm', coordinatorImage]); } catch { /* build may not have completed */ }
}
if (failure) { console.error(`Compose smoke failed; diagnostics: ${root}`); throw failure; }
evidence.runtimeSetup = runtimeSetup;
save('evidence.json', evidence);
console.log(JSON.stringify(evidence, null, 2));
