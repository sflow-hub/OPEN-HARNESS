// Explicit opt-in: actual Linux Docker, coordinator, paired runner and human WebSocket transports.
// No model, paid inference or user accounts. Keep diagnostics; remove only fixture containers.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { DatabaseSync } from 'node:sqlite';
import { containerStateKey, runningAgentContainer } from '../runtime/hermes.ts';
import { runningDesktopContainer } from '../runtime/computer-runtime.ts';
import { DESKTOP_STREAM_HELPER } from '../runtime/desktop-stream-helper.ts';

assert.equal(process.env.OPEN_HARNESS_REAL_COMPUTER_TRANSPORT, '1', 'Set OPEN_HARNESS_REAL_COMPUTER_TRANSPORT=1 on an isolated Linux Docker host.');
assert.equal(process.platform, 'linux'); assert.notEqual(process.env.OPEN_HARNESS_MOCK, '1');
const repository = resolve(import.meta.dirname, '..'), root = mkdtempSync(join(process.env.OPEN_HARNESS_SMOKE_DIR || tmpdir(), 'computer-transport-'));
const state = join(root, 'coordinator'), runnerState = join(root, 'runner'), agentId = `computer-${process.pid}`, marker = `PTY_${process.pid}_VERIFIED`, cliMarker = `CLI_${process.pid}_INSTALLED`;
const image = process.env.OPEN_HARNESS_HERMES_IMAGE || 'open-harness-hermes:2026.9.11', exec = promisify(execFile), logs = [], sockets = [], children = [], terminalDiagnostics = [];
let token, endpoint, coordinator, runner, profile, database, failure, evidence;
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const command = async (name, args) => (await exec(name, args, { cwd: repository, timeout: 30000, maxBuffer: 5000000, encoding: 'utf8' })).stdout.trim();
const wait = async (check, label, timeout = 60000) => { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const value = await check(); if (value) return value; await pause(100); } throw new Error(`Timed out: ${label}`); };
const processChild = (name, args, environment) => {
  const child = spawn(process.execPath, args, { cwd: repository, env: { ...process.env, OPEN_HARNESS_MOCK: '0', OPEN_HARNESS_DISABLE_OS_VAULT: '1', ...environment }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { if (logs.length < 1000) logs.push({ name, text: String(data).slice(0, 10000) }); });
  return child;
};
const stop = async child => { if (!child || child.exitCode !== null || child.signalCode !== null) return; const done = new Promise(resolve => child.once('close', resolve)); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 20000); await done; clearTimeout(timer); };
const request = async (path, method = 'GET', body) => {
  const response = await fetch(endpoint + path, { method, signal: AbortSignal.timeout(100000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(value)}`); return value;
};
const startCoordinator = async port => {
  coordinator = processChild('coordinator', ['--import', 'tsx', 'runtime/service.ts'], { OPEN_HARNESS_STATE_DIR: state, OPEN_HARNESS_PORT: String(port), OPEN_HARNESS_BIND: '127.0.0.1', OPEN_HARNESS_ALLOW_LOOPBACK_PAIRING: '1' });
  token = await wait(async () => { try { const response = await fetch(endpoint + '/v1/bootstrap'); return response.ok && (await response.json()).token; } catch { return false; } }, 'coordinator startup', 30000);
};
const websocket = (path, origin = endpoint) => { const url = new URL(path, endpoint); url.protocol = 'ws:'; const socket = new WebSocket(url, { origin, handshakeTimeout: 10000, perMessageDeflate: false }); sockets.push(socket); return socket; };
const opened = socket => new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
const refused = async path => { const socket = websocket(path); let accepted = false; socket.once('open', () => { accepted = true; socket.close(); }); socket.on('error', () => {}); await new Promise(resolve => socket.once('close', resolve)); assert.equal(accepted, false, 'A spent or stale ticket must be rejected.'); };
const input = async (leaseId, value) => request(`/v1/agents/${agentId}/desktop/input`, 'POST', { leaseId, input: value });
const terminal = async leaseId => {
  const ticket = await request(`/v1/agents/${agentId}/terminal`, 'POST', { leaseId }), socket = websocket(ticket.path); let output = '';
  socket.on('message', data => { const value = JSON.parse(data.toString()); if (value.type === 'output') output += value.data; if (value.type === 'error') logs.push({ name: 'terminal', text: value.message }); });
  socket.on('error', () => {}); await opened(socket);
  terminalDiagnostics.push(() => ({ state: socket.readyState, output: output.slice(-8000) }));
  return { socket, ticket, send: data => socket.send(JSON.stringify({ type: 'input', data })), output: () => output };
};
const fixtureRequests = [];
const web = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://fixture');
  if (url.pathname === '/seen' || url.pathname === '/typed') { fixtureRequests.push({ path: url.pathname, value: url.searchParams.get('value') }); res.end('ok'); return; }
  res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Computer transport fixture</title><h1>Managed computer</h1><input autofocus aria-label="Fixture value" id="value"><script>window.fixtureSession=String(Math.random());fetch("/seen?value="+fixtureSession);document.querySelector("input").oninput=e=>fetch("/typed?value="+encodeURIComponent(e.target.value));</script>');
});
const listen = server => new Promise(resolve => server.listen(0, '0.0.0.0', () => resolve(server.address().port)));
console.log(`Computer transport acceptance artifacts: ${root}`);
try {
  const imageInfo = JSON.parse(await command('docker', ['image', 'inspect', image]))[0]; assert.equal(imageInfo.Config.Labels['dev.openharness.runtime'], '9');
  const free = createServer(), port = await listen(free); await new Promise(resolve => free.close(resolve)); endpoint = `http://127.0.0.1:${port}`;
  const webPort = await listen(web); await startCoordinator(port);
  const pairing = await request('/v1/machines', 'POST', { name: 'Computer transport fixture', platform: 'linux', coordinatorUrl: 'https://computer-fixture.invalid' });
  runner = processChild('runner', ['runtime/runner.mjs', '--coordinator', endpoint, '--pairing-code', pairing.code], { OPEN_HARNESS_RUNNER_STATE_DIR: runnerState });
  const machine = await wait(async () => (await request('/v1/machines')).machines.find(item => !item.local && item.status === 'online'), 'paired runner');
  assert.ok(machine.capabilities.features.includes('terminal-pty')); assert.ok(machine.capabilities.features.includes('continuous-computer'));
  console.log('Bundled runner paired with terminal and continuous-computer capabilities.');
  await request('/v1/agents/sync', 'POST', { agents: [{ id: agentId, name: 'Transport fixture', role: 'Acceptance', description: '', tone: 0, instructions: '', memory: [] }] });
  profile = (await request(`/v1/agents/${agentId}/profile`)).profile;
  await request(`/v1/agents/${agentId}/profile`, 'PUT', { ...profile, model: { inherit: false, provider: 'local', model: 'no-inference-fixture', credentialRef: '', baseUrl: 'http://127.0.0.1:1/v1' }, allowedTools: ['terminal', 'process_manage', 'mcp__open_harness__computer'], terminalConsent: true, computer: { ...profile.computer, machineId: machine.id, desktop: 'virtual' } });
  profile = await wait(async () => { const value = await request(`/v1/agents/${agentId}/profile`); assert.notEqual(value.transfer?.state, 'failed', value.transfer?.message); return value.profile.computer.machineId === machine.id && value.profile; }, 'agent transfer');
  console.log('Private workspace transferred without requiring a model credential.');
  const first = await request(`/v1/agents/${agentId}/desktop/take-control`, 'POST', { confirm: true }); assert.equal(first.ready, true);
  const desktopId = await runningDesktopContainer(agentId, runnerState, profile.computer); assert.ok(desktopId);
  const gateway = await command('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}', desktopId]); assert.match(gateway, /^\d+\.\d+\.\d+\.\d+$/);
  await input(first.leaseId, { type: 'key', key: 'Control+l' }); await input(first.leaseId, { type: 'text', text: `http://${gateway}:${webPort}/` }); await input(first.leaseId, { type: 'key', key: 'Enter' });
  await wait(() => fixtureRequests.some(item => item.path === '/seen'), 'browser fixture page');
  await input(first.leaseId, { type: 'text', text: 'PRESERVED_BROWSER_VALUE' }); await wait(() => fixtureRequests.some(item => item.path === '/typed' && item.value === 'PRESERVED_BROWSER_VALUE'), 'browser typed value');
  const frame = await request(`/v1/agents/${agentId}/desktop/frame`); assert.match(frame.image, /^data:image\/png;base64,/); assert.equal(frame.width, 1440);
  assert.equal(await command('docker', ['exec', desktopId, 'timeout', '15s', 'python', '-c', DESKTOP_STREAM_HELPER]), 'RFB 003.008');
  console.log('Real desktop stream helper emitted its protocol banner.');
  const streamTicket = await request(`/v1/agents/${agentId}/desktop/stream`, 'POST', {}), view = websocket(streamTicket.path); let banner = '';
  view.on('message', data => { banner += data.toString(); }); view.on('error', () => {}); await opened(view); await wait(() => banner.startsWith('RFB 003.008\n'), 'paired desktop stream'); view.close();
  console.log('Paired screen capture, input and RFB duplex confirmed.');
  const shell = await terminal(first.leaseId);
  await wait(() => { assert.notEqual(shell.socket.readyState, WebSocket.CLOSED, 'Remote PTY closed before its prompt.'); return shell.output().length > 0; }, 'initial remote PTY output', 15000);
  shell.socket.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
  shell.send(`printf '${marker}\\n' > human-result.txt\nnohup sh -c 'while :; do date +%s%N > human-heartbeat.txt; sleep .1; done' >/dev/null 2>&1 &\ndisown\nprintf 'TERMINAL_READY\\n'\n`);
  const resultPath = join(runnerState, 'shared/human-result.txt'), heartbeat = join(runnerState, 'shared/human-heartbeat.txt');
  await wait(() => { assert.doesNotMatch(shell.output(), /Permission denied/, 'The human terminal must own its managed workspace files.'); return existsSync(resultPath) && readFileSync(resultPath, 'utf8').trim() === marker && existsSync(heartbeat); }, 'actual remote PTY writes');
  await refused(shell.ticket.path);
  const unused = await request(`/v1/agents/${agentId}/terminal`, 'POST', { leaseId: first.leaseId });
  const executionId = await runningAgentContainer(agentId, runnerState); assert.ok(executionId);
  await command('docker', ['exec', '--user', '0', executionId, 'python', '-c', `from pathlib import Path; p=Path('/usr/local/bin/open-harness-fixture-cli'); p.write_text('#!/bin/sh\\nprintf ${cliMarker}\\n'); p.chmod(0o755)`]);
  shell.send('open-harness-fixture-cli\n'); await wait(() => shell.output().includes(cliMarker), 'installed executable in the human terminal');
  assert.equal(await command('docker', ['exec', executionId, 'open-harness-fixture-cli']), cliMarker, 'The normal execution environment must find the same installed executable on PATH.');
  await request(`/v1/agents/${agentId}/desktop/release`, 'POST', { leaseId: first.leaseId, continueWork: false });
  await wait(() => shell.socket.readyState === WebSocket.CLOSED, 'terminal closed after handback'); await refused(unused.path);
  assert.equal(await command('docker', ['inspect', '-f', '{{.State.Running}}', executionId]), 'false'); assert.equal(await runningDesktopContainer(agentId, runnerState, profile.computer), desktopId);
  const stoppedHeartbeat = readFileSync(heartbeat, 'utf8'); await pause(700); assert.equal(readFileSync(heartbeat, 'utf8'), stoppedHeartbeat);
  const second = await request(`/v1/agents/${agentId}/desktop/take-control`, 'POST', { confirm: true }); assert.equal(second.browserSessionPreserved, true);
  const secondShell = await terminal(second.leaseId); secondShell.send('cat human-result.txt\nopen-harness-fixture-cli\n'); await wait(() => secondShell.output().includes(marker) && secondShell.output().includes(cliMarker), 'saved file and installed executable in resumed execution container');
  assert.equal(await runningAgentContainer(agentId, runnerState), executionId, 'Handback must reuse the exact execution container and its installed tools.');
  assert.equal(await command('docker', ['exec', executionId, 'open-harness-fixture-cli']), cliMarker);
  await pause(700); assert.equal(readFileSync(heartbeat, 'utf8'), stoppedHeartbeat); assert.equal(fixtureRequests.filter(item => item.path === '/seen').length, 1, 'The browser page must stay alive, rather than be restored by reloading.');
  console.log('Remote PTY file persists; detached human jobs stop; browser page survives handback.');
  await request(`/v1/agents/${agentId}/desktop/release`, 'POST', { leaseId: second.leaseId, continueWork: false });
  database = new DatabaseSync(join(state, 'state.db'));
  const durable = JSON.stringify(database.prepare('SELECT payload_json,result_json FROM runner_commands').all()); assert.ok(!durable.includes(marker) && !durable.includes('human-heartbeat.txt') && !durable.includes('PRESERVED_BROWSER_VALUE'));
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM runs').get().count, 0);
  await stop(runner);
  const current = (await request(`/v1/agents/${agentId}/profile`)).profile;
  await request(`/v1/agents/${agentId}/profile`, 'PUT', { ...current, allowedTools: ['mcp__open_harness__computer'] });
  assert.equal((await request(`/v1/agents/${agentId}/profile`)).terminalRevocation.state, 'pending');
  database.close(); database = undefined; await stop(coordinator); await startCoordinator(port);
  assert.equal((await request(`/v1/agents/${agentId}/profile`)).terminalRevocation.state, 'pending');
  runner = processChild('runner-reconnected', ['runtime/runner.mjs'], { OPEN_HARNESS_RUNNER_STATE_DIR: runnerState });
  await wait(async () => (await request(`/v1/agents/${agentId}/profile`)).terminalRevocation?.state === 'confirmed', 'runner acknowledged persisted terminal revocation');
  console.log('Offline terminal revocation survived coordinator restart and received runner cleanup acknowledgment.');
  await request(`/v1/machines/${machine.id}/revoke`, 'POST');
  evidence = { ok: true, mode: 'real Linux Docker with paired bundled runner; no model or paid inference', image, imageId: imageInfo.Id, architecture: imageInfo.Architecture, remoteFrame: true, remoteDesktopDuplex: true, remotePty: true, filePersistence: true, installedCliRunsInHumanAndAgentEnvironment: true, installedCliPersists: true, sameExecutionContainer: true, detachedHumanJobsStopped: true, browserPagePreserved: true, spentTicketDenied: true, handbackTicketDenied: true, terminalBytesNotSpooled: true, offlineRevocationAcrossRestart: true, runnerCleanupAcknowledged: true, noModelRuns: true };
} catch (error) { failure = error; }
finally {
  database?.close(); for (const socket of sockets) socket.terminate();
  for (const child of [...children].reverse()) await stop(child);
  web.closeAllConnections(); await new Promise(resolve => web.close(() => resolve()));
  try {
    for (const directory of [runnerState, state]) assert.equal(await command('docker', ['ps', '-q', '--filter', `label=open-harness.state=${containerStateKey(directory)}`]), '', 'Coordinator and runner shutdown must leave neither execution nor desktop containers running.');
    if (evidence) evidence.shutdownStopsAllContainerRoles = true;
  } catch (error) { failure ||= error; }
  for (const directory of [runnerState, state]) {
    try { const ids = (await command('docker', ['ps', '-aq', '--filter', `label=open-harness.state=${containerStateKey(directory)}`])).split('\n').filter(Boolean); if (ids.length) await command('docker', ['rm', '-f', ...ids]); } catch (error) { failure ||= error; }
  }
  writeFileSync(join(root, 'diagnostics.json'), JSON.stringify({ error: failure ? String(failure.stack || failure) : null, logs, terminals: terminalDiagnostics.map(read => read()) }, null, 2));
}
if (failure) { console.error(`Computer transport acceptance failed: ${root}`); throw failure; }
mkdirSync(join(root, 'evidence'), { recursive: true }); writeFileSync(join(root, 'evidence/result.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify({ ...evidence, artifacts: root }, null, 2));
