// Explicit opt-in: actual stopped-browser transfers through a coordinator and bundled runner.
// This uses only synthetic cookies/files and a local web fixture; no model or paid inference.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { containerStateKey } from '../runtime/hermes.ts';
import { desktopResourcePaths, runningDesktopContainer } from '../runtime/computer-runtime.ts';

assert.equal(process.env.OPEN_HARNESS_REAL_COMPUTER_TRANSFER, '1', 'Set OPEN_HARNESS_REAL_COMPUTER_TRANSFER=1 on an isolated Linux Docker host.');
assert.equal(process.platform, 'linux'); assert.notEqual(process.env.OPEN_HARNESS_MOCK, '1');
const repository = resolve(import.meta.dirname, '..'), root = mkdtempSync(join(process.env.OPEN_HARNESS_SMOKE_DIR || tmpdir(), 'computer-transfer-'));
const state = join(root, 'coordinator'), runnerState = join(root, 'runner'), agentId = `transfer-${process.pid}`;
const cookie = `COOKIE_${crypto.randomUUID()}`, storage = `STORAGE_${crypto.randomUUID()}`, file = `PRIVATE_${crypto.randomUUID()}`;
const forbidden = [cookie, storage, file, ...[cookie, storage, file].map(value => Buffer.from(value).toString('base64'))];
const image = process.env.OPEN_HARNESS_HERMES_IMAGE || 'open-harness-hermes:2026.9.11', exec = promisify(execFile), logs = [], children = [], observations = [];
let endpoint, token, database, failure, evidence, seed = true, spoolSamples = 0, sealedCompletions = 0;
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const command = async (name, args) => (await exec(name, args, { cwd: repository, timeout: 30000, maxBuffer: 5000000, encoding: 'utf8' })).stdout.trim();
const wait = async (check, label, timeout = 60000) => { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (failure) throw failure; const value = await check(); if (value) return value; await pause(100); } throw new Error(`Timed out: ${label}`); };
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
const noSecrets = (text, label) => { for (const value of forbidden) assert.equal(text.includes(value), false, `${label} contains synthetic private data.`); };
const inspectDurable = () => {
  noSecrets(JSON.stringify(database.prepare('SELECT payload_json,result_json FROM runner_commands').all()), 'Coordinator command queue');
  const spool = join(runnerState, 'spool');
  if (existsSync(spool)) for (const name of readdirSync(spool).filter(name => name.endsWith('.json'))) { noSecrets(readFileSync(join(spool, name), 'utf8'), 'Runner completion spool'); spoolSamples++; }
};
const listen = server => new Promise(resolve => server.listen(0, '0.0.0.0', () => resolve(server.address().port)));
const web = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://fixture');
  if (url.pathname === '/observed') { observations.push({ cookie: req.headers.cookie || '', storage: url.searchParams.get('storage') }); res.end('ok'); return; }
  const initialize = url.pathname === '/seed' && seed; if (initialize) seed = false;
  if (initialize) res.setHeader('Set-Cookie', `harness_transfer=${cookie}; Max-Age=3600; HttpOnly; SameSite=Lax; Path=/`);
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><title>Private transfer fixture</title><h1>Private transfer fixture</h1><script>${initialize ? `localStorage.setItem('fixture',${JSON.stringify(storage)});` : ''}fetch('/observed?storage='+encodeURIComponent(localStorage.getItem('fixture')||''));</script>`);
});
// Delay completion delivery long enough to inspect the real durable runner spool.
const proxy = createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = Buffer.concat(chunks);
    if (/\/commands\/[^/]+\/complete$/.test(req.url || '')) {
      noSecrets(body.toString(), 'Runner completion HTTP body'); inspectDurable();
      if (body.includes(Buffer.from('encrypted'))) sealedCompletions++;
      await pause(150);
    }
    const response = await fetch(endpoint + req.url, { method: req.method, headers: { Authorization: req.headers.authorization || '', 'X-Open-Harness-Machine': req.headers['x-open-harness-machine'] || '', 'Content-Type': 'application/json' }, ...(body.length ? { body } : {}), signal: AbortSignal.timeout(100000) });
    res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { failure ||= error; res.writeHead(502); res.end('{"error":"Fixture proxy failed."}'); }
});
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, value, { mode: 0o600 }); };
const browserVisit = async (profile, machineRoot, path, webPort) => {
  const lease = await request(`/v1/agents/${agentId}/desktop/take-control`, 'POST', { confirm: true }); assert.equal(lease.ready, true);
  const id = await runningDesktopContainer(agentId, machineRoot, profile.computer); assert.ok(id);
  const gateway = await command('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}', id]), count = observations.length;
  for (const input of [{ type: 'key', key: 'Control+l' }, { type: 'text', text: `http://${gateway}:${webPort}/${path}` }, { type: 'key', key: 'Enter' }]) await request(`/v1/agents/${agentId}/desktop/input`, 'POST', { leaseId: lease.leaseId, input });
  await wait(() => observations.slice(count).some(value => value.cookie.includes(`harness_transfer=${cookie}`) && value.storage === storage), 'browser cookie and local storage');
  const browserProcesses = JSON.parse(await command('docker', ['exec', id, 'python', '-c', 'import json,sys; sys.path.insert(0,"/opt/open-harness"); from browser_shutdown import browser_processes; print(json.dumps(browser_processes()))']));
  assert.ok(Object.keys(browserProcesses).length > 0, 'The shutdown helper must identify the live managed browser before transfer.');
  await request(`/v1/agents/${agentId}/desktop/release`, 'POST', { leaseId: lease.leaseId, continueWork: false }); return id;
};
const move = async (profile, machineId) => {
  await request(`/v1/agents/${agentId}/profile`, 'PUT', { ...profile, computer: { ...profile.computer, machineId } });
  return wait(async () => { inspectDurable(); const value = await request(`/v1/agents/${agentId}/profile`); assert.notEqual(value.transfer?.state, 'failed', value.transfer?.detail); return value.profile.computer.machineId === machineId && value.transfer?.state === 'completed' && value.profile; }, 'sealed agent transfer', 100000);
};
console.log(`Computer transfer acceptance artifacts: ${root}`);
try {
  const imageInfo = JSON.parse(await command('docker', ['image', 'inspect', image]))[0]; assert.equal(imageInfo.Config.Labels['dev.openharness.runtime'], '11');
  const free = createServer(), port = await listen(free); await new Promise(resolve => free.close(resolve)); endpoint = `http://127.0.0.1:${port}`;
  const webPort = await listen(web), proxyPort = await listen(proxy);
  processChild('coordinator', ['--import', 'tsx', 'runtime/service.ts'], { OPEN_HARNESS_STATE_DIR: state, OPEN_HARNESS_PORT: String(port), OPEN_HARNESS_BIND: '127.0.0.1', OPEN_HARNESS_ALLOW_LOOPBACK_PAIRING: '1' });
  token = await wait(async () => { try { const response = await fetch(endpoint + '/v1/bootstrap'); return response.ok && (await response.json()).token; } catch { return false; } }, 'coordinator startup', 30000);
  database = new DatabaseSync(join(state, 'state.db'));
  const pairing = await request('/v1/machines', 'POST', { name: 'Sealed transfer fixture', platform: 'linux', coordinatorUrl: 'https://transfer-fixture.invalid' });
  const runnerEnvironment = { OPEN_HARNESS_RUNNER_STATE_DIR: runnerState };
  processChild('runner', ['runtime/runner.mjs', '--coordinator', `http://127.0.0.1:${proxyPort}`, '--pairing-code', pairing.code], runnerEnvironment);
  const machine = await wait(async () => (await request('/v1/machines')).machines.find(item => !item.local && item.status === 'online'), 'paired runner');
  assert.ok(machine.capabilities.features.includes('sealed-agent-transfer'));
  await request('/v1/agents/sync', 'POST', { agents: [{ id: agentId, name: 'Transfer fixture', role: 'Acceptance', description: '', tone: 0, instructions: '', memory: [] }] });
  let profile = (await request(`/v1/agents/${agentId}/profile`)).profile;
  await request(`/v1/agents/${agentId}/profile`, 'PUT', { ...profile, model: { inherit: false, provider: 'local', model: 'no-inference-fixture', credentialRef: '', baseUrl: 'http://127.0.0.1:1/v1' }, allowedTools: ['mcp__open_harness__computer'], computer: { ...profile.computer, desktop: 'virtual' } });
  profile = (await request(`/v1/agents/${agentId}/profile`)).profile;
  const sourcePaths = desktopResourcePaths(agentId, state, profile.computer), sourceDesktop = await browserVisit(profile, state, 'seed', webPort);
  write(join(state, 'agents', agentId, 'private', 'transfer-proof.txt'), file);
  const destinationComputer = { ...profile.computer, machineId: machine.id }, destinationPaths = desktopResourcePaths(agentId, runnerState, destinationComputer);
  write(join(destinationPaths.browser, 'previous-destination.txt'), 'recoverable-before-transfer');
  profile = await move(profile, machine.id);
  assert.equal(await command('docker', ['inspect', '-f', '{{.State.Running}}', sourceDesktop]), 'false');
  assert.equal(readFileSync(join(state, 'agents', agentId, 'private', 'transfer-proof.txt'), 'utf8'), file);
  assert.equal(readFileSync(join(runnerState, 'agents', agentId, 'private', 'transfer-proof.txt'), 'utf8'), file);
  const recovery = JSON.parse(readFileSync(destinationPaths.migration, 'utf8')); assert.ok(recovery.backup);
  assert.equal(readFileSync(join(runnerState, recovery.backup, 'previous-destination.txt'), 'utf8'), 'recoverable-before-transfer');
  const pairedDesktop = await browserVisit(profile, runnerState, 'check', webPort);
  console.log('Local → paired transfer preserved the private file, cookie/local storage and prior destination browser backup.');
  profile = await move(profile, 'local');
  assert.equal(await command('docker', ['inspect', '-f', '{{.State.Running}}', pairedDesktop]), 'false');
  assert.equal(readFileSync(join(runnerState, 'agents', agentId, 'private', 'transfer-proof.txt'), 'utf8'), file);
  assert.equal(readFileSync(join(state, 'agents', agentId, 'private', 'transfer-proof.txt'), 'utf8'), file);
  await browserVisit(profile, state, 'check', webPort); inspectDurable();
  assert.ok(existsSync(sourcePaths.browser)); assert.ok(spoolSamples > 0, 'Inspect the actual durable completion spool before delivery.'); assert.ok(sealedCompletions > 0, 'Export completion must contain an encrypted envelope.');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM runs').get().count, 0);
  await request(`/v1/machines/${machine.id}/revoke`, 'POST');
  evidence = { ok: true, mode: 'real Linux Docker coordinator and bundled paired runner; synthetic browser cookies; no model or paid inference', image, imageId: imageInfo.Id, architecture: imageInfo.Architecture, localToPaired: true, pairedToLocal: true, privateFilePreserved: true, browserCookiePreserved: true, browserLocalStoragePreserved: true, liveManagedBrowserMatched: true, sourceStoppedAndPreserved: true, priorDestinationBrowserRecoverable: true, commandQueueHasNoPlaintext: true, completionSpoolHasNoPlaintext: true, spoolSamples, sealedCompletions, noModelRuns: true };
} catch (error) { failure ||= error; }
finally {
  for (const child of [...children].reverse()) await stop(child);
  for (const server of [web, proxy]) { server.closeAllConnections(); await new Promise(resolve => server.close(() => resolve())); }
  database?.close();
  for (const directory of [runnerState, state]) {
    try { const ids = (await command('docker', ['ps', '-aq', '--filter', `label=open-harness.state=${containerStateKey(directory)}`])).split('\n').filter(Boolean); if (ids.length) await command('docker', ['rm', '-f', ...ids]); } catch (error) { failure ||= error; }
  }
  writeFileSync(join(root, 'diagnostics.json'), JSON.stringify({ error: failure ? String(failure.stack || failure) : null, logs, observations: observations.map(value => ({ cookie: value.cookie.includes(`harness_transfer=${cookie}`), localStorage: value.storage === storage })), spoolSamples, sealedCompletions }, null, 2));
}
if (failure) { console.error(`Computer transfer acceptance failed: ${root}`); throw failure; }
writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify({ ...evidence, artifacts: root }, null, 2));
