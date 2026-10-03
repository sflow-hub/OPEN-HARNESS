// Opt in after npm run harness:setup: OPEN_HARNESS_COMPOSE_SMOKE=1
// node --import tsx tests/compose-smoke.mjs
// Add OPEN_HARNESS_COMPOSE_BUILD_RUNTIME=1 to build through local first-run setup
// instead of loading a prebuilt host image. This requires network access and extra time.
// --config-only validates the generated overlay without building or starting Docker.
// OPEN_HARNESS_COMPOSE_PACKAGE_DIR points to an extracted browser-release package;
// OPEN_HARNESS_COMPOSE_COORDINATOR_IMAGE optionally selects a prebuilt local image.
// Real pinned Hermes uses a disposable scripted provider, not paid/model inference.
// --soak adds 24 hours of real-browser reconnects and real Hermes runs after restore.
// --soak-smoke exercises the same path for five minutes and cannot qualify the duration.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, mkdtempSync, readFileSync, statfsSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { request as httpRequest } from 'node:http';
import { createServer, isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { HERMES_IMAGE as DEFAULT_HERMES_IMAGE } from '../runtime/readiness.ts';
import { soakMode } from './helpers/soak-loop.mjs';
import { runComposeSoak } from './helpers/compose-soak.mjs';
import { monitorSoakContainers } from './helpers/soak-containers.mjs';

const configOnly = process.argv.includes('--config-only');
const soak = soakMode(process.argv.slice(2));
const buildRuntime = process.env.OPEN_HARNESS_COMPOSE_BUILD_RUNTIME === '1';
assert.ok(configOnly || process.env.OPEN_HARNESS_COMPOSE_SMOKE === '1', 'Set OPEN_HARNESS_COMPOSE_SMOKE=1 to build and run the isolated Compose stack.');
assert.notEqual(process.env.OPEN_HARNESS_MOCK, '1', 'Compose acceptance must exercise real Hermes.');
// Emulated AMD64 only: `packet.py acceptance-launch --browser-overrides emulated-amd64` sets this marker, and the two
// private-desktop helper execs then get the direct Chromium binary and flags of that reviewed profile. Unset keeps
// every exec unchanged.
const browserOverrides = process.env.OPEN_HARNESS_BROWSER_OVERRIDES;
assert.ok(browserOverrides === undefined || browserOverrides === 'emulated-amd64', 'OPEN_HARNESS_BROWSER_OVERRIDES may only be emulated-amd64.');
const desktopHelper = ['python', '/workspace/shared/compose-desktop.py'];
const helperEnvironment = { AGENT_BROWSER_EXECUTABLE_PATH: '/usr/lib/chromium/chromium', AGENT_BROWSER_ARGS: '--force-renderer-accessibility,--disable-gpu,--no-zygote,--disable-dev-shm-usage' };
let helperOverrides = 0;
const execOverrides = args => {
  if (!browserOverrides || args.length !== desktopHelper.length || args.some((arg, index) => arg !== desktopHelper[index])) return [];
  helperOverrides += 1;
  return Object.entries(helperEnvironment).flatMap(([name, value]) => ['-e', `${name}=${value}`]);
};
// Emulated AMD64 only: the coordinator starts each agent container with synchronous Docker CLI calls (runtime/hermes.ts
// ensureContainer, at most 147 s by their own limits in Compose) and cannot answer its API until they return. Under QEMU
// user mode they outlast the native 15 s request budget, so the marker allows 180 s per API request and 600 s per run
// wait, re-sends a read up to 3 times when it got no answer at all, and records both. Unset keeps the native limits and
// sends every request once.
const nativeTiming = { requestMs: 15_000, runMs: 120_000 };
const timing = browserOverrides ? { requestMs: 180_000, runMs: 600_000, readRetries: 3 } : nativeTiming;
const overNativeBudget = [], retriedReads = [];
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const deployment = resolve(process.env.OPEN_HARNESS_COMPOSE_PACKAGE_DIR || repository);
const packaged = deployment !== repository;
const pullRuntime = packaged || process.env.OPEN_HARNESS_COMPOSE_PULL_RUNTIME === '1';
assert.ok(!(pullRuntime && buildRuntime), 'Choose a packaged runtime pull or source build, not both.');
const root = mkdtempSync(join(tmpdir(), 'open-harness-compose-smoke-'));
const readOnlyFolder = join(root, 'host folders', 'read only'), writeFolder = join(root, 'host folders', 'read write');
for (const folder of [readOnlyFolder, writeFolder]) { mkdirSync(join(folder, 'nested'), { recursive: true }); writeFileSync(join(folder, 'host-proof.txt'), 'COMPOSE_HOST_729'); }
const project = `oh-compose-smoke-${randomUUID().slice(0, 8)}`;
const restoreProject = `${project}-restored`;
let activeProject = project, coordinatorImage;
const projects = new Set();
const docker = process.env.OPEN_HARNESS_DOCKER_BINARY || 'docker';
const composeBinary = process.env.OPEN_HARNESS_COMPOSE_BINARY || docker;
const composePrefix = process.env.OPEN_HARNESS_COMPOSE_BINARY ? [] : ['compose'];
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|HOME|TMPDIR|DOCKER_.*)$/.test(name))), ...(process.env.OPEN_HARNESS_ENGINE_IMAGE ? { OPEN_HARNESS_ENGINE_IMAGE: process.env.OPEN_HARNESS_ENGINE_IMAGE } : {}), OPEN_HARNESS_PUBLIC_URL: 'http://localhost:3000/api/local', OPEN_HARNESS_LISTEN_ADDRESS: '127.0.0.1' };
const composeArgs = () => [...composePrefix, '--project-name', activeProject, '--project-directory', deployment, '--env-file', join(root, 'compose.env'), '-f', join(deployment, 'compose.yaml'), '-f', join(root, 'override.yaml')];
const runFile = promisify(execFile);
const command = async (binary, args, timeout = 30_000) => (await runFile(binary, args, { cwd: repository, env, encoding: 'utf8', timeout, maxBuffer: 12 * 1024 * 1024 })).stdout.trim();
const dc = (args, timeout) => command(composeBinary, [...composeArgs(), ...args], timeout);
const nodeIn = async (service, script) => JSON.parse(await dc(['exec', '-T', service, 'node', '--input-type=module', '-e', script]));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const save = (name, value) => writeFileSync(join(root, name), JSON.stringify(value, null, 2));
writeFileSync(join(root, 'project.txt'), project);
writeFileSync(join(root, 'compose.env'), '');
const baseConfig = JSON.parse(await command(composeBinary, [...composePrefix, '--project-name', project, '--project-directory', deployment, '--env-file', join(root, 'compose.env'), '-f', join(deployment, 'compose.yaml'), 'config', '--format', 'json']));
const HERMES_IMAGE = process.env.OPEN_HARNESS_HERMES_IMAGE || (packaged ? baseConfig.services['open-harness'].environment.OPEN_HARNESS_HERMES_IMAGE : DEFAULT_HERMES_IMAGE);
coordinatorImage = process.env.OPEN_HARNESS_COMPOSE_COORDINATOR_IMAGE || (packaged ? baseConfig.services['open-harness'].image : `${project}-coordinator:smoke`);
assert.ok(coordinatorImage, 'The packaged deployment must specify a prebuilt coordinator image.');
const prebuilt = packaged || Boolean(process.env.OPEN_HARNESS_COMPOSE_COORDINATOR_IMAGE);
// Docker can change an ephemeral published port at restart. Fix the soak's
// selected loopback port so the browser can prove its saved origin session works.
const publishedPort = soak ? await new Promise((resolve, reject) => {
  const server = createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); });
}) : '';
writeFileSync(join(root, 'override.yaml'), `services:
  docker:
    volumes:
      - type: bind
        source: ${JSON.stringify(readOnlyFolder)}
        target: /host-folders/fixture-ro
        read_only: true
      - type: bind
        source: ${JSON.stringify(writeFolder)}
        target: /host-folders/fixture-rw
  open-harness:
    image: ${coordinatorImage}
    volumes:
      - type: bind
        source: ${JSON.stringify(readOnlyFolder)}
        target: /host-folders/fixture-ro
        read_only: true
      - type: bind
        source: ${JSON.stringify(writeFolder)}
        target: /host-folders/fixture-rw
    ports: !override
      - "127.0.0.1:${publishedPort}:3000"
    environment:
      OPEN_HARNESS_HERMES_IMAGE: ${JSON.stringify(HERMES_IMAGE)}
      OPEN_HARNESS_HERMES_PULL: ${JSON.stringify(pullRuntime ? '1' : '0')}
      OPEN_HARNESS_REQUIRE_BROWSER_PAIRING: "1"
      OPEN_HARNESS_DISABLE_OS_VAULT: "1"
      OPEN_HARNESS_MOCK: "0"
  fixture:
    networks: [runtime]
    environment:
      COMPOSE_REQUIRE_CREDENTIAL: "1"
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
assert.equal(config.services['open-harness'].environment.OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD, '0');
assert.deepEqual(Object.keys(config.services.docker.networks), ['runtime']);
assert.deepEqual(Object.keys(config.services['open-harness'].networks), ['default']);
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
  const loadImage = spawn(composeBinary, [...composeArgs(), 'exec', '-T', 'docker', 'docker', 'load'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
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

const volumeManifest = volume => command(docker, ['run', '--rm', '--user', '0', '--entrypoint', 'node', '-v', `${volume}:/source:ro`, coordinatorImage, '--input-type=module', '-e', `
import fs from 'node:fs'; import {createHash} from 'node:crypto';
const entries=[]; function walk(path,relative='') { const st=fs.lstatSync(path); if(st.isSocket()) return;
entries.push({path:relative,uid:st.uid,gid:st.gid,mode:st.mode,kind:st.isDirectory()?'directory':st.isSymbolicLink()?'link':'file',...(st.isFile()?{sha256:createHash('sha256').update(fs.readFileSync(path)).digest('hex')} : st.isSymbolicLink()?{target:fs.readlinkSync(path)}:{})});
if(st.isDirectory()) for(const name of fs.readdirSync(path).sort()) walk(path+'/'+name,relative+'/'+name); } walk('/source'); console.log(JSON.stringify(entries));`]);
async function volumeArchive(volume, restore = false) {
  const archive = join(root, 'data-backup.tgz');
  const child = spawn(docker, ['run', '--rm', '-i', '--user', '0', '--entrypoint', 'tar', '-v', `${volume}:/${restore ? 'target' : 'source'}${restore ? '' : ':ro'}`, coordinatorImage, restore ? '-xzpf' : '-czpf', '-', '-C', restore ? '/target' : '/source', ...(restore ? [] : ['.'])], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
  const result = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`Volume ${restore ? 'restore' : 'backup'} failed (${code}): ${errors}`))); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
  try {
    if (restore) { child.stdout.resume(); await Promise.all([pipeline(createReadStream(archive), child.stdin), result]); }
    else { child.stdin.end(); await Promise.all([pipeline(child.stdout, createWriteStream(archive, { mode: 0o600 })), result]); }
  } finally { clearTimeout(timer); }
}

let token, endpoint, firstSnapshot, followupSnapshot, evidence;
const snapshots = [];
const publishedEndpoints = [];
async function refreshEndpoint() {
  const published = await dc(['port', 'open-harness', '3000']);
  assert.match(published, /^127\.0\.0\.1:\d+$/);
  endpoint = `http://${published}`;
  publishedEndpoints.push(endpoint);
}
const callApi = async (path, method = 'GET', data) => {
  const response = await fetch(endpoint + '/api/local' + path, { method, signal: AbortSignal.timeout(timing.requestMs), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const value = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(value)}`);
  return value;
};
// No answer at all: this fetch failed, or the dashboard proxy's fetch to the coordinator did (its 502). Only a GET is
// re-sent, after 1, 2 and 4 s. A write is never repeated, and a timeout or any answer from the coordinator is final.
const unanswered = (error, method, path) => (error?.name === 'TypeError' && error.message === 'fetch failed') || error?.message === `${method} ${path}: {"error":"fetch failed"}`;
const api = !browserOverrides ? callApi : async (path, method = 'GET', data) => {
  const started = Date.now();
  try {
    for (let attempt = 1; ; attempt += 1) {
      try { return await callApi(path, method, data); }
      catch (error) {
        if (method !== 'GET' || attempt > timing.readRetries || !unanswered(error, method, path)) throw error;
        retriedReads.push({ path, attempt, error: String(error.message).slice(0, 200) });
        await pause(1000 * 2 ** (attempt - 1));
      }
    }
  } finally { const ms = Date.now() - started; if (ms > nativeTiming.requestMs) overNativeBudget.push({ method, path, ms }); }
};
// Node fetch itself stops waiting for response headers after five minutes. Give
// this client a build-sized deadline while still testing the actual dashboard proxy.
const prepareRuntime = () => new Promise((resolve, reject) => {
  const body = JSON.stringify({ action: 'prepare-runtime' });
  const request = httpRequest(endpoint + '/api/local/v1/onboarding/action', { method: 'POST', signal: AbortSignal.timeout(20 * 60_000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
    let output = '';
    response.setEncoding('utf8');
    response.on('data', chunk => { output += chunk; });
    response.once('error', reject);
    response.once('end', () => {
      try { assert.equal(response.statusCode, 200, `Runtime setup failed: ${output}`); resolve(JSON.parse(output)); }
      catch (error) { reject(error); }
    });
  });
  request.once('error', reject);
  request.end(body);
});
const operatorToken = async () => (await nodeIn('open-harness', `const r = await fetch('http://127.0.0.1:4317/v1/bootstrap',{headers:${JSON.stringify({ Authorization: 'Bearer ' + token })}}); if (!r.ok) throw new Error('Operator bootstrap failed: '+r.status); console.log(JSON.stringify({token:(await r.json()).token}));`)).token;
const mintBrowserCode = async (ttl = 300) => JSON.parse(await dc(['exec', '-T', 'open-harness', 'node', '/opt/open-harness/runtime/browser-pair.mjs', '--ttl-seconds', String(ttl)]));
const pairBrowser = code => fetch(endpoint + '/api/local/v1/browser/pair', { method: 'POST', signal: AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
async function waitRun(run, { waitForInput = false, answerInputs = true } = {}) {
  const deadline = Date.now() + timing.runMs, answered = new Set();
  let lastSnapshot;
  while (Date.now() < deadline) {
    const snapshot = await api(`/v1/runs/${run.id}/events?after=0`);
    lastSnapshot = snapshot;
    if (waitForInput && snapshot.run.pendingInputs?.length) return snapshot;
    for (const pending of answerInputs ? snapshot.run.pendingInputs || [] : []) {
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
  if (lastSnapshot) snapshots.push(lastSnapshot);
  throw new Error(`Compose run ${run.id} timed out.`);
}
const nestedRunning = async () => (await dc(['exec', '-T', 'docker', 'docker', 'inspect', '-f', '{{.State.Running}}', 'open-harness-compose-smoke'])) === 'true';
let failure;
let runtimeSetup = { mode: pullRuntime ? 'local-api-pull' : buildRuntime ? 'local-api-build' : 'prebuilt-image-transfer' };
let platform;
try {
  platform = { operator: process.platform, operatorArch: process.arch, node: process.version, docker: JSON.parse(await command(docker, ['version', '--format', '{{json .Server}}'])), compose: await command(composeBinary, [...composePrefix, 'version']) };
  save('platform.json', platform);
  if (!buildRuntime && !pullRuntime) await command(docker, ['image', 'inspect', HERMES_IMAGE]);
  if (packaged && !process.env.OPEN_HARNESS_COMPOSE_COORDINATOR_IMAGE) await command(docker, ['pull', coordinatorImage], 10 * 60_000);
  else if (prebuilt) await command(docker, ['image', 'inspect', coordinatorImage]);
  else { console.log('Building the production coordinator image.'); await dc(['build', 'open-harness'], 12 * 60_000); }
  try { await command(docker, ['image', 'inspect', config.services.docker.image]); }
  catch { await command(docker, ['pull', config.services.docker.image], 5 * 60_000); }
  projects.add(project);
  await dc(['up', '-d', '--wait', '--wait-timeout', '180', '--no-build', '--pull', 'never', 'docker', 'open-harness', 'fixture'], 210_000);
  if (!buildRuntime && !pullRuntime) {
    console.log('Loading the pinned Hermes image into the private nested daemon.');
    await loadNestedImage();
  }
  const fixtureId = await dc(['ps', '-q', 'fixture']);
  const fixture = JSON.parse(await command(docker, ['inspect', fixtureId]))[0];
  const providerIp = fixture.NetworkSettings.Networks[`${project}_runtime`]?.IPAddress;
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
  const deniedBootstrap = await new Promise((resolve, reject) => {
    const request = httpRequest(endpoint + '/api/local/v1/bootstrap', { headers: { Host: 'untrusted.example' }, signal: AbortSignal.timeout(15_000) }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
    request.once('error', reject); request.end();
  });
  assert.equal(deniedBootstrap, 403);
  const dashboardBootstrap = await fetch(endpoint + '/api/local/v1/bootstrap', { signal: AbortSignal.timeout(15_000) });
  assert.equal(dashboardBootstrap.status, 401);
  const unpaired = await dashboardBootstrap.json();
  assert.equal(unpaired.pairingRequired, true); assert.equal(unpaired.token, undefined);
  assert.equal((await pairBrowser('invalid-fixture-code')).status, 401);
  const expired = await mintBrowserCode(1);
  await pause(1200);
  assert.equal((await pairBrowser(expired.code)).status, 401, 'Expired browser codes must be refused.');
  const pairing = await mintBrowserCode();
  const paired = await pairBrowser(pairing.code);
  assert.equal(paired.status, 200);
  token = (await paired.json()).token;
  assert.ok(token);
  assert.equal((await pairBrowser(pairing.code)).status, 401, 'Browser pairing codes are single-use.');
  const tcp = await nodeIn('fixture', `import net from 'node:net'; const out=[]; for(const port of [2375,2376]) out.push(await new Promise(resolve=>{const socket=net.connect({host:'docker',port});const finish=open=>{socket.destroy();resolve({port,open});};socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));socket.setTimeout(1500,()=>finish(false));}));console.log(JSON.stringify(out));`);
  assert.ok(tcp.every(result => !result.open), 'The private Docker daemon must have no TCP listener.');
  const dindId = await dc(['ps', '-q', 'docker']);
  const dind = JSON.parse(await command(docker, ['inspect', dindId]))[0];
  assert.ok(Object.values(dind.HostConfig.PortBindings || {}).every(bindings => !bindings?.length));
  const identity = await nodeIn('open-harness', `import fs from 'node:fs'; console.log(JSON.stringify({uid:process.getuid(),dataUid:fs.statSync('/data').uid}));`);
  assert.deepEqual(identity, { uid: 1000, dataUid: 1000 });
  assert.equal(await operatorToken(), token, 'Loopback dashboard bootstrap must return the local operator session.');
  assert.deepEqual((await api('/v1/machines')).machines.find(machine => machine.local).folderExports.sort((a, b) => a.path.localeCompare(b.path)), [{ path: '/host-folders/fixture-ro', mode: 'read' }, { path: '/host-folders/fixture-rw', mode: 'write' }]);
  if (buildRuntime || pullRuntime) {
    const before = await api('/v1/onboarding/status');
    assert.equal(before.executionReady, false, 'A fresh Compose stack must report its missing runtime.');
    assert.equal(before.checks.find(check => check.id === 'agent-runtime')?.action, 'prepare-runtime');
    assert.equal(await dc(['exec', '-T', 'docker', 'docker', 'image', 'ls', '-q', HERMES_IMAGE]), '', 'The fresh daemon must not contain a preloaded Hermes image.');
    runtimeSetup = { ...runtimeSetup, before, startedAt: new Date().toISOString() };
    save('runtime-setup.json', runtimeSetup);
    console.log(`${pullRuntime ? 'Pulling' : 'Building'} the missing Hermes runtime through local dashboard setup.`);
    const startedAt = Date.now();
    const result = await prepareRuntime();
    assert.equal(result.executionReady, true, JSON.stringify(result));
    const after = await api('/v1/onboarding/status');
    assert.equal(after.executionReady, true);
    assert.equal(after.checks.find(check => check.id === 'agent-runtime')?.state, 'ready');
    await dc(['exec', '-T', 'docker', 'docker', 'image', 'inspect', HERMES_IMAGE]);
    runtimeSetup = { ...runtimeSetup, after, durationMs: Date.now() - startedAt, localSetupSucceeded: true };
    save('runtime-setup.json', runtimeSetup);
  }
  const agentId = 'compose-smoke', otherId = 'compose-peer', conversationId = 'compose-continuity';
  const credential = await api('/v1/credentials', 'POST', { ref: 'COMPOSE_FIXTURE_KEY', label: 'Compose fixture', provider: 'local', value: 'local-scripted-provider-only' });
  assert.equal(credential.ref, 'COMPOSE_FIXTURE_KEY');
  assert.equal(credential.present, true);
  assert.doesNotMatch(JSON.stringify(credential), /local-scripted-provider-only/);
  await api('/v1/agents/sync', 'POST', { agents: [agentId, otherId].map(id => ({ id, name: id, role: 'Integration verification', instructions: 'Work only on this isolated acceptance task.', memory: [] })) });
  const { profile } = await api(`/v1/agents/${agentId}/profile`);
  const folders = [{ id: 'fixture-ro', path: '/host-folders/fixture-ro', mode: 'read' }, { id: 'fixture-rw', path: '/host-folders/fixture-rw', mode: 'write' }];
  for (const grant of [{ ...folders[0], mode: 'write' }, { id: 'unexported', path: '/data', mode: 'read' }, { id: 'descendant', path: '/host-folders/fixture-rw/nested', mode: 'read' }]) {
    const refused = await fetch(endpoint + `/api/local/v1/agents/${agentId}/profile`, { method: 'PUT', signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...profile, computer: { ...profile.computer, access: 'folders', folders: [grant] } }) });
    assert.equal(refused.status, 400, 'An agent cannot widen a read-only export or grant an unexported host path/descendant.');
  }
  const saved = await api(`/v1/agents/${agentId}/profile`, 'PUT', { ...profile, model: { inherit: false, provider: 'local', model: 'compose-fixture', baseUrl, credentialRef: 'COMPOSE_FIXTURE_KEY' }, allowedTools: ['write_file', 'clarify', 'mcp__open_harness__task', 'computer_use'], computer: { ...profile.computer, access: 'folders', folders, desktop: 'virtual' } });
  const { profile: peerProfile } = await api(`/v1/agents/${otherId}/profile`);
  const peerSaved = await api(`/v1/agents/${otherId}/profile`, 'PUT', { ...peerProfile, model: saved.profile.model, allowedTools: saved.profile.allowedTools, computer: { ...peerProfile.computer, desktop: 'virtual' } });
  const contextPath = `/v1/agents/${agentId}/context`, skillPath = `${contextPath}/skills/compose-restore`;
  const memory = 'Retain COMPOSE_MEMORY_729 after restore.', skill = '---\nname: compose-restore\ndescription: Verify restored context.\n---\nCOMPOSE_SKILL_729\n';
  await api(contextPath, 'PUT', { memory });
  await api(skillPath, 'PUT', { content: skill });
  await api(`/v1/files?scope=private&agentId=${agentId}`, 'POST', { name: 'private-proof.txt', content: 'COMPOSE_PRIVATE_729' });
  const team = await api('/v1/teams', 'POST', { name: 'Compose integration', description: 'Disposable acceptance team', color: 'sage', icon: 'code', memberAgentIds: [agentId] });
  const board = await api('/v1/boards', 'POST', { name: 'Compose acceptance board' });
  const task = await api('/v1/tasks', 'POST', { boardId: board.id, stageId: board.stages[0].id, teamId: team.id, title: 'Compose persists this card', ownerAgentId: agentId });
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
  assert.ok((await api(`/v1/credentials/${credential.ref}`)).lastUsedAt, 'Real work must record credential usage.');
  const rotated = await api(`/v1/credentials/${credential.ref}/value`, 'POST', { value: 'local-scripted-provider-rotated' });
  assert.notEqual(rotated.fingerprint, credential.fingerprint);
  const second = await api('/v1/runs', 'POST', { agentId, conversationId, prompt: 'COMPOSE_FOLLOWUP: Return the prior continuity marker.' });
  followupSnapshot = await waitRun(second);
  assert.match(followupSnapshot.run.result, /FOLLOWUP_COMPOSE_SEED_729/);
  assert.notEqual(firstSnapshot.run.session_id, followupSnapshot.run.session_id);
  assert.deepEqual((await api(`/v1/runs/${first.id}/events?after=0`)).events, firstSnapshot.events);
  assert.equal(await nestedRunning(), false);
  const requests = await nodeIn('fixture', `console.log(JSON.stringify(await (await fetch('http://127.0.0.1:3131/__fixture/requests')).json()));`);
  save('provider-requests.json', requests);
  assert.ok(requests.some(request => request.fixtureCredential === 'original'));
  assert.ok(requests.some(request => request.fixtureCredential === 'rotated'));
  assert.ok(requests.every(request => request.fixtureCredential !== 'invalid'), 'Every real provider request must resolve the saved credential.');
  const mainRequests = requests.filter(body => body.tools?.some(tool => tool.function?.name === 'write_file') && body.messages?.some(message => String(message.content).includes('COMPOSE_SMOKE')));
  assert.ok(mainRequests.length >= 5);
  for (const body of mainRequests) assert.ok(body.tools.every(tool => ['write_file', 'clarify', 'mcp__open_harness__task', 'computer_use'].includes(tool.function?.name)));
  assert.ok(mainRequests.some(body => body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'compose-terminal' && /tool_disabled|does not exist/.test(String(message.content)))), 'Ungrantable fixture tool calls must be rejected by the real dispatch policy.');
  console.log('Restarting the coordinator and checking durable state.');
  await dc(['restart', 'open-harness'], 45_000);
  // Docker may allocate a different ephemeral host port when the container restarts.
  await refreshEndpoint();
  let ready = false, readinessError;
  for (let attempt = 0; attempt < 100; attempt += 1) { try { await api('/v1/agents'); ready = true; break; } catch (error) { readinessError = error; await pause(300); } }
  assert.ok(ready, `Coordinator must recover after restart: ${readinessError}`);
  assert.equal(await operatorToken(), token, 'Control token must survive restart.');
  assert.deepEqual((await api(`/v1/agents/${agentId}/profile`)).profile, saved.profile);
  assert.equal((await api(`/v1/tasks/${task.id}`)).title, task.title);
  assert.equal((await api(`/v1/tasks/${task.id}`)).teamId, team.id);
  assert.deepEqual(await api(`/v1/teams/${team.id}`), team);
  assert.equal((await api(`/v1/credentials/${credential.ref}`)).fingerprint, rotated.fingerprint);
  assert.equal((await api('/v1/files?scope=shared&name=compose-verified.txt')).content, artifact.content);
  const history = (await api(`/v1/conversations?agentId=${agentId}`)).conversations.find(item => item.id === conversationId);
  assert.deepEqual(history.runs.map(run => run.id), [first.id, second.id]);
  assert.deepEqual((await api(`/v1/runs/${first.id}/events?after=0`)).events, firstSnapshot.events);
  const contextBefore = await api(contextPath), skillBefore = await api(skillPath);
  assert.equal(contextBefore.memory, memory); assert.equal(skillBefore.content, skill);
  console.log('Stopping the stack with a real Hermes run waiting for input.');
  const shutdown = await api('/v1/runs', 'POST', { agentId, conversationId: 'compose-shutdown', prompt: 'COMPOSE_SHUTDOWN: Ask for input and stay waiting.' });
  const waiting = await waitRun(shutdown, { waitForInput: true });
  assert.ok(waiting.run.pendingInputs.length); assert.equal(await nestedRunning(), true);
  const peerRun = await api('/v1/runs', 'POST', { agentId: otherId, prompt: 'COMPOSE_SHUTDOWN: Keep the second private desktop alive for isolation checks.' });
  await waitRun(peerRun, { waitForInput: true });
  const nested = (id, args, timeout) => dc(['exec', '-T', 'docker', 'docker', 'exec', ...execOverrides(args), `open-harness-${id}`, ...args], timeout);
  for (const id of [agentId, otherId]) {
    const peer = id === agentId ? otherId : agentId;
    const isolation = JSON.parse(await nested(id, ['python', '-c', `import json,os\nfrom pathlib import Path\nassert os.environ['DISPLAY']==':99'\nassert os.environ['DBUS_SESSION_BUS_ADDRESS']=='unix:path=/tmp/open-harness-session-bus'\nfor path in ['/data','/var/run/docker.sock','/run/open-harness-docker/docker.sock','/home/node','/data/agents/${peer}']:\n assert not Path(path).exists(),path\nPath('/workspace/private/desktop-owner.txt').write_text('${id}')\nprint(json.dumps({'privateOwner':'${id}','hostAndOtherAgentDenied':True}))`]));
    assert.equal(isolation.privateOwner, id);
    assert.equal(await nested(id, ['cat', '/workspace/shared/compose-verified.txt']), artifact.content.trim());
  }
  await nested(agentId, ['python', '-c', "from pathlib import Path\nassert Path('/workspace/mounts/folder-1/host-proof.txt').read_text()=='COMPOSE_HOST_729'\ntry: Path('/workspace/mounts/folder-1/denied.txt').write_text('denied')\nexcept OSError: pass\nelse: raise AssertionError('Read-only export was writable')\nPath('/workspace/mounts/folder-2/agent-proof.txt').write_text('COMPOSE_GRANTED_WRITE_729')"]);
  assert.equal(readFileSync(join(writeFolder, 'agent-proof.txt'), 'utf8'), 'COMPOSE_GRANTED_WRITE_729');
  await nested(otherId, ['python', '-c', "from pathlib import Path\nassert not Path('/workspace/mounts/folder-1').exists()\nassert not Path('/workspace/mounts/folder-2').exists()\nassert not Path('/host-folders').exists()"]);
  await api('/v1/files?scope=shared', 'POST', { name: 'compose-desktop.py', content: readFileSync(join(repository, 'tests/helpers/compose-desktop.py'), 'utf8') });
  console.log('Checking real private desktop input, shared files, and isolation between two agents.');
  const desktopOutput = await nested(agentId, ['python', '/workspace/shared/compose-desktop.py'], 150_000);
  const desktop = JSON.parse(desktopOutput.split('\n').findLast(line => line.startsWith('{') && line.includes('screenshotBytes')));
  assert.equal(desktop.clickReadback, 'CLICK_CONFIRMED_729');
  assert.equal(desktop.typeReadback, 'COMPOSE_DESKTOP_729');
  assert.match(await nested(agentId, ['xwininfo', '-root', '-tree']), /Compose private desktop proof/);
  assert.doesNotMatch(await nested(otherId, ['xwininfo', '-root', '-tree']), /Compose private desktop proof/);
  const screenshot = await api('/v1/files?scope=shared&name=compose-desktop.png');
  writeFileSync(join(root, 'compose-desktop.png'), Buffer.from(screenshot.content, 'base64'));
  const agentContainer = JSON.parse(await dc(['exec', '-T', 'docker', 'docker', 'inspect', 'open-harness-compose-smoke']))[0];
  const agentMounts = agentContainer.Mounts.map(mount => ({ source: mount.Source, destination: mount.Destination, type: mount.Type, writable: mount.RW })).sort((a, b) => a.destination.localeCompare(b.destination));
  // The exact source/destination set also excludes the Docker control socket,
  // its private volume, and the coordinator's /data root even if renamed.
  assert.deepEqual(agentMounts, [
    { source: '/data/agents/compose-smoke/profile', destination: '/home/hermes/.hermes', type: 'bind', writable: true },
    { source: '/data/agents/compose-smoke/managed', destination: '/run/open-harness', type: 'bind', writable: false },
    { source: '/data/agents/compose-smoke/private', destination: '/workspace/private', type: 'bind', writable: true },
    { source: '/data/shared', destination: '/workspace/shared', type: 'bind', writable: true },
    { source: '/host-folders/fixture-ro', destination: '/workspace/mounts/folder-1', type: 'bind', writable: false },
    { source: '/host-folders/fixture-rw', destination: '/workspace/mounts/folder-2', type: 'bind', writable: true },
  ].sort((a, b) => a.destination.localeCompare(b.destination)));
  const coordinatorId = await dc(['ps', '-q', 'open-harness']);
  const coordinatorInfo = JSON.parse(await command(docker, ['inspect', coordinatorId]))[0];
  const dashboardAddress = coordinatorInfo.NetworkSettings.Networks[`${project}_default`].IPAddress;
  const publishedPort = Number(new URL(endpoint).port);
  const outerGateways = Object.values(dind.NetworkSettings.Networks).map(network => network.Gateway);
  const blockedTargets = [`http://${dashboardAddress}:3000/api/local/v1/bootstrap`, ...outerGateways.map(address => `http://${address}:${publishedPort}/api/local/v1/bootstrap`), `http://host.docker.internal:${publishedPort}/api/local/v1/bootstrap`];
  const probe = `import json,urllib.request,urllib.error\nout=[]\nfor url in ${JSON.stringify(blockedTargets)}:\n try:\n  response=urllib.request.urlopen(urllib.request.Request(url,headers={'Host':'localhost:3000'}),timeout=2)\n  text=response.read().decode();out.append({'url':url,'status':response.status,'hasToken':'"token"' in text})\n except urllib.error.HTTPError as error: out.append({'url':url,'status':error.code,'hasToken':False})\n except Exception: out.append({'url':url,'unreachable':True,'hasToken':False})\nprint(json.dumps(out))`;
  const nestedBootstrap = JSON.parse(await dc(['exec', '-T', 'docker', 'docker', 'exec', 'open-harness-compose-smoke', 'python', '-c', probe], 30_000));
  assert.ok(nestedBootstrap.every(result => !result.hasToken && (result.unreachable || [401, 403].includes(result.status))), 'Nested agents must not obtain the operator token even with a forged localhost Host header.');

  await dc(['stop', '--timeout', '30', 'open-harness'], 40_000);
  const stopped = JSON.parse(await command(docker, ['inspect', coordinatorId]))[0];
  assert.equal(stopped.HostConfig.Init, true, 'The coordinator needs an init process to reap orphaned subprocesses.');
  assert.equal(stopped.State.Running, false); assert.equal(stopped.State.ExitCode, 0, 'The supervisor must finish graceful cleanup before Docker kills it.');
  assert.equal(await nestedRunning(), false, 'Coordinator shutdown must stop its real nested agent before DinD stops.');
  assert.equal(await dc(['exec', '-T', 'docker', 'docker', 'inspect', '-f', '{{.State.Running}}', `open-harness-${otherId}`]), 'false');
  await dc(['stop', '--timeout', '30', 'fixture', 'docker'], 70_000);
  const oldVolume = config.volumes['harness-data'].name;
  const beforeManifest = JSON.parse(await volumeManifest(oldVolume));
  assert.ok(beforeManifest.some(entry => entry.path.endsWith('/state.db')));
  console.log('Backing up stopped data and restoring into a separate empty project.');
  await volumeArchive(oldVolume);
  activeProject = restoreProject; projects.add(restoreProject);
  const restoredConfig = JSON.parse(await dc(['config', '--format', 'json']));
  const restoredVolume = restoredConfig.volumes['harness-data'].name;
  assert.notEqual(restoredVolume, oldVolume);
  assert.equal(await command(docker, ['volume', 'ls', '-q', '--filter', `name=^${restoredVolume}$`]), '');
  await command(docker, ['volume', 'create', '--label', `com.docker.compose.project=${restoreProject}`, '--label', 'com.docker.compose.volume=harness-data', restoredVolume]);
  const empty = JSON.parse(await volumeManifest(restoredVolume));
  assert.equal(empty.length, 1, 'The restore destination must be empty.');
  await volumeArchive(restoredVolume, true);
  const restoredManifest = JSON.parse(await volumeManifest(restoredVolume));
  assert.deepEqual(restoredManifest, beforeManifest, 'Stopped backup must preserve every regular file, directory, mode and owner before reopening.');
  save('restore-files.json', { sourceVolume: oldVolume, destinationVolume: restoredVolume, destinationWasEmpty: true, entries: restoredManifest });
  await dc(['up', '-d', '--wait', '--wait-timeout', '180', '--no-build', '--pull', 'never', 'docker', 'open-harness', 'fixture'], 210_000);
  await refreshEndpoint();
  if (pullRuntime) assert.equal((await prepareRuntime()).executionReady, true);
  else await loadNestedImage();
  assert.equal(await operatorToken(), token, 'The restored operator session must be retained.');
  assert.deepEqual((await api(`/v1/agents/${agentId}/profile`)).profile, saved.profile);
  assert.deepEqual((await api(`/v1/agents/${otherId}/profile`)).profile, peerSaved.profile);
  assert.equal((await api(`/v1/tasks/${task.id}`)).title, task.title);
  assert.deepEqual(await api(`/v1/teams/${team.id}`), team);
  assert.equal((await api(`/v1/credentials/${credential.ref}`)).fingerprint, rotated.fingerprint);
  assert.equal((await api(contextPath)).memory, contextBefore.memory);
  assert.equal((await api(skillPath)).content, skillBefore.content);
  assert.equal((await api('/v1/files?scope=shared&name=compose-verified.txt')).content, artifact.content);
  assert.equal((await api(`/v1/files?scope=private&agentId=${agentId}&name=private-proof.txt`)).content, 'COMPOSE_PRIVATE_729');
  for (const id of [agentId, otherId]) assert.equal((await api(`/v1/files?scope=private&agentId=${id}&name=desktop-owner.txt`)).content, id);
  assert.deepEqual((await api(`/v1/runs/${first.id}/events?after=0`)).events, firstSnapshot.events);
  assert.deepEqual((await api(`/v1/conversations?agentId=${agentId}`)).conversations.find(item => item.id === conversationId).runs.map(run => run.id), [first.id, second.id]);
  for (const run of [shutdown, peerRun]) assert.ok(['interrupted', 'cancelled'].includes((await api(`/v1/runs/${run.id}/events?after=0`)).run.state), 'Interrupted work must not restart itself after restore.');
  const restoredFixture = JSON.parse(await command(docker, ['inspect', await dc(['ps', '-q', 'fixture'])]))[0];
  const restoredProviderIp = restoredFixture.NetworkSettings.Networks[`${restoreProject}_runtime`]?.IPAddress;
  assert.equal(isIP(restoredProviderIp || ''), 4);
  // A new disposable provider has a new IP; compare the restored profile first.
  await api(`/v1/agents/${agentId}/profile`, 'PUT', { ...saved.profile, model: { ...saved.profile.model, baseUrl: `http://${restoredProviderIp}:3131/v1` } });
  const restoredRun = await waitRun(await api('/v1/runs', 'POST', { agentId, conversationId, prompt: 'COMPOSE_FOLLOWUP: Return the prior continuity marker after restore.' }));
  assert.match(restoredRun.run.result, /FOLLOWUP_COMPOSE_SEED_729/);
  const restoredRequests = await nodeIn('fixture', `console.log(JSON.stringify(await (await fetch('http://127.0.0.1:3131/__fixture/requests')).json()));`);
  assert.ok(restoredRequests.length && restoredRequests.every(request => request.fixtureCredential === 'rotated'), 'Real work after restore must use the saved rotated credential.');
  const restoredDesktopRun = await api('/v1/runs', 'POST', { agentId, prompt: 'COMPOSE_SHUTDOWN: Keep the restored private desktop alive for input verification.' });
  await waitRun(restoredDesktopRun, { waitForInput: true });
  const restoredDesktopOutput = await nested(agentId, ['python', '/workspace/shared/compose-desktop.py'], 150_000);
  const restoredDesktop = JSON.parse(restoredDesktopOutput.split('\n').findLast(line => line.startsWith('{') && line.includes('screenshotBytes')));
  assert.equal(restoredDesktop.clickReadback, desktop.clickReadback); assert.equal(restoredDesktop.typeReadback, desktop.typeReadback);
  await api(`/v1/runs/${restoredDesktopRun.id}/stop`, 'POST', {});
  let soakResult;
  if (soak) {
    // The restore gives the disposable provider a different address for both agents.
    await api(`/v1/agents/${otherId}/profile`, 'PUT', { ...peerSaved.profile, model: { ...peerSaved.profile.model, baseUrl: `http://${restoredProviderIp}:3131/v1` } });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (['cancelled', 'interrupted', 'completed'].includes((await api(`/v1/runs/${restoredDesktopRun.id}/events?after=0`)).run.state)) break;
      assert.ok(attempt < 99, 'Restored desktop run must stop before soak.');
      await pause(300);
    }
    soakResult = await runComposeSoak({
      mode: soak, root, api, waitRun, dc, nodeIn, refreshEndpoint, getEndpoint: () => endpoint, mintBrowserCode, agentIds: [agentId, otherId],
      sampleResources: async () => {
        const artifacts = statfsSync(root);
        const data = await nodeIn('open-harness', "import fs from 'node:fs'; const s=fs.statfsSync('/data'); console.log(JSON.stringify({availableBytes:s.bavail*s.bsize}));");
        data.usedKiB = Number((await dc(['exec', '-T', 'open-harness', 'du', '-sk', '/data'])).split(/\s/)[0]);
        const engineDf = (await dc(['exec', '-T', 'docker', 'df', '-Pk', '/var/lib/docker'])).split('\n').at(-1).trim().split(/\s+/);
        const engine = { availableBytes: Number(engineDf[3]) * 1024, usedKiB: Number((await dc(['exec', '-T', 'docker', 'du', '-sk', '/var/lib/docker'])).split(/\s/)[0]) };
        return { artifacts: { availableBytes: artifacts.bavail * artifacts.bsize }, data, engine, dockerDiskUsage: await dc(['exec', '-T', 'docker', 'docker', 'system', 'df', '--format', '{{json .}}']) };
      },
      imageBindings: async () => {
        const images = {};
        for (const service of ['open-harness', 'docker', 'fixture']) {
          const container = await dc(['ps', '-q', service]);
          images[service] = (await command(docker, ['inspect', '--format', '{{.Image}}', container])).trim();
        }
        images.runtime = JSON.parse(await dc(['exec', '-T', 'docker', 'docker', 'image', 'inspect', HERMES_IMAGE, '--format', '{{json .Id}}']));
        return images;
      },
      // A restart keeps a container's ID and changes its start time; recreation changes the ID.
      watchContainers: options => monitorSoakContainers({ docker, env, ...options }),
      containerStates: async () => {
        const states = {};
        for (const service of ['open-harness', 'docker', 'fixture']) {
          const [containerId, startedAt] = (await command(docker, ['inspect', '--format', '{{.Id}} {{.State.StartedAt}}', await dc(['ps', '-q', service])])).split(' ');
          assert.ok(containerId && startedAt, `${service} container state was not measured.`);
          states[service] = { id: containerId, startedAt };
        }
        return states;
      },
    });
  }
  evidence = { ok: true, mode: 'real Compose stack and pinned Hermes with scripted completion fixture; not model reasoning', project, restoreProject, root, deployment, packaged, coordinatorImage, image: HERMES_IMAGE, providerIp, dashboardCsp: true, authenticatedApi: true, browserPairing: { required: true, invalidDenied: true, expiredDenied: true, replayDenied: true }, explicitHostFolders: { physicalPathsContainSpaces: true, readOnlyCeiling: true, selectedAgentWrite: true, otherAgentDenied: true, unexportedPathsDenied: true }, savedCredentialRotation: true, teamTaskPersistence: true, localBootstrap: true, forgedHostDenied: true, nestedBootstrapDenied: nestedBootstrap, privateDockerTcp: tcp, identity, agentMounts, fileTool: true, clarification: true, taskMcp: true, deniedTerminal: true, freshSessionContext: true, replayStable: true, restartPersistence: true, gracefulAgentCleanup: true, privateDesktop: desktop, twoAgentDesktopIsolation: true, sharedFilesPreserved: true, backupRestore: { destinationWasEmpty: true, stoppedFileOwnerModeHashesEqual: true, entries: restoredManifest.length, profiles: true, credentialsUsedByRealRun: true, privateFiles: true, sharedFiles: true, memory: true, skills: true, tasks: true, history: true, interruptedRunsNotReplayed: true, freshEngineCache: true }, firstRun: first.id, followupRun: second.id, restoredRun: restoredRun.run.id };
  if (soakResult) evidence.soak = soakResult;
  if (browserOverrides) {
    evidence.mode = `emulated AMD64 with browser overrides: ${evidence.mode}`;
    evidence.browserOverrides = { profile: browserOverrides, execEnvironment: helperEnvironment, desktopHelperExecs: helperOverrides };
    evidence.emulatedTiming = { ...timing, overNativeBudget, retriedReads };
  }
} catch (error) { failure = error; }
finally {
  save('diagnostics.json', { error: failure ? String(failure.stack || failure) : null, runtimeSetup, publishedEndpoints, snapshots, ...(browserOverrides ? { emulatedTiming: { ...timing, overNativeBudget, retriedReads } } : {}) });
  if (token && endpoint && failure) for (const name of ['compose-browser.png', 'compose-desktop.png']) {
    try { const file = await api(`/v1/files?scope=shared&name=${name}`); writeFileSync(join(root, name), Buffer.from(file.content, 'base64')); }
    catch { /* the desktop or coordinator may not have started */ }
  }
  for (const cleanupProject of projects) {
    activeProject = cleanupProject;
    try { writeFileSync(join(root, `${activeProject}.log`), await dc(['logs', '--no-color'], 20_000)); } catch (error) { console.error('Could not collect Compose logs:', String(error)); }
    try {
      await dc(['down', '--volumes', '--remove-orphans', '--timeout', '30'], 60_000);
      assert.equal(await command(docker, ['ps', '-aq', '--filter', `label=com.docker.compose.project=${activeProject}`]), '');
      assert.equal(await command(docker, ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${activeProject}`]), '');
      assert.equal(await command(docker, ['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${activeProject}`]), '');
      if (evidence) evidence.projectResourcesRemoved = true;
    } catch (error) { failure ||= error; }
  }
  try { if (!prebuilt) await command(docker, ['image', 'rm', coordinatorImage]); } catch { /* build may not have completed */ }
}
if (failure) { console.error(`Compose smoke failed; diagnostics: ${root}`); throw failure; }
evidence.runtimeSetup = runtimeSetup;
evidence.platform = platform;
evidence.backupRestore.privateDesktopInput = true;
// Written only after the whole fixture, including cleanup, has succeeded: a soak result on
// disk must never outlive a run that later failed or was interrupted.
if (evidence.soak) save('soak-result.json', evidence.soak);
save('evidence.json', evidence);
console.log(JSON.stringify(evidence, null, 2));
