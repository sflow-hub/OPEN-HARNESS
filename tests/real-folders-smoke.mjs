// Opt in after npm run harness:setup:
// OPEN_HARNESS_REAL_FOLDERS=1 node --import tsx tests/real-folders-smoke.mjs
// Actual coordinator, pinned Docker runtime and native mount verification, driven by a scripted
// local provider: workspace folders (the Folders screen), project folders, per-agent access,
// read-only enforcement, revocation, refused paths, and the folder notice the model receives.
// This tests integration, not model reasoning. Allow about two minutes; no paid model is contacted.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HERMES_IMAGE } from '../runtime/readiness.ts';

assert.equal(process.env.OPEN_HARNESS_REAL_FOLDERS, '1', 'Set OPEN_HARNESS_REAL_FOLDERS=1 to run the real Docker folder verification.');
assert.notEqual(process.env.OPEN_HARNESS_MOCK, '1', 'This check requires the real Hermes runtime.');
execFileSync('docker', ['image', 'inspect', HERMES_IMAGE], { stdio: 'ignore', timeout: 10_000 });
// Host folders reach a native coordinator's agents only through a Docker engine on the same kernel.
const engineOs = execFileSync('docker', ['info', '--format', '{{.OperatingSystem}}'], { encoding: 'utf8', timeout: 15_000 }).trim();
assert.doesNotMatch(engineOs, /Docker Desktop/, 'Docker Desktop runs containers on another kernel, where native folder grants fail closed by design. Use a native Linux engine, or tests/compose-smoke.mjs for the Docker Desktop route.');
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Granted folders are siblings of the data folder: anything inside it is refused.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'open-harness-folders-')));
const state = join(root, 'state'), kept = join(root, 'kept'), site = join(root, 'site');
for (const dir of [state, kept, site]) mkdirSync(dir, { recursive: true });
const suffix = `${process.pid}-${Date.now().toString(36)}`;
const agents = { granted: `fold-a-${suffix}`, other: `fold-b-${suffix}` };
const hostMarker = `HOST_${suffix}`, runMarker = `RUN_${suffix}`;
writeFileSync(join(kept, 'host.txt'), `${hostMarker}\n`);
const requests = [], systems = [], logs = [], snapshots = [];
let providerFailure, coordinator, token, endpoint;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function nextReply(body) {
  const transcript = body.messages || [];
  const prompt = String(transcript.filter(message => message.role === 'user').at(-1)?.content || '');
  const advertised = new Set((body.tools || []).map(tool => tool.function?.name));
  const called = transcript.flatMap(message => message.tool_calls || []).map(call => call.function?.name);
  const results = transcript.filter(message => message.role === 'tool').map(message => String(message.content)).join('\n');
  const call = (name, args) => { assert.ok(advertised.has(name), `${name} must be model-visible for ${prompt}`); return { name, arguments: args }; };
  if (!advertised.size) return { content: 'Folder fixture auxiliary response.' };
  const step = prompt.match(/OH_FOLDERS_(\w+)/)?.[1];
  if (step && !called.length) systems.push({ step, system: transcript.filter(message => message.role === 'system').map(message => String(message.content)).join('\n') });
  if (step === 'PROJECT') {
    if (!called.includes('read_file')) return call('read_file', { path: '/workspace/folders/kept/host.txt' });
    if (!called.includes('write_file')) return call('write_file', { path: '/workspace/project/site/run-proof.txt', content: results.includes(hostMarker) ? `${runMarker}\n` : 'HOST_MARKER_MISSING\n' });
    return { content: 'Project folder run complete.' };
  }
  if (step === 'DENIED') {
    if (!called.includes('read_file')) return call('read_file', { path: '/workspace/folders/kept/host.txt' });
    return { content: results.includes(hostMarker) ? 'LEAKED' : 'The folder is not available, as expected.' };
  }
  if (step === 'READONLY') {
    if (!called.includes('write_file')) return call('write_file', { path: '/workspace/folders/kept/blocked.txt', content: 'This must not reach the host.\n' });
    return { content: 'Read-only check complete.' };
  }
  return { content: 'Unexpected fixture prompt.' };
}

const provider = createServer(async (req, res) => {
  try {
    if (req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'folder-fixture' }] })); return; }
    let input = ''; for await (const part of req) input += part;
    const body = JSON.parse(input); requests.push(body);
    const reply = nextReply(body), tool = reply.name;
    const message = tool ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${requests.length}`, type: 'function', function: { name: reply.name, arguments: JSON.stringify(reply.arguments) } }] } : { role: 'assistant', content: reply.content };
    const common = { id: `fixture-${requests.length}`, created: Math.floor(Date.now() / 1000), model: 'folder-fixture' };
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const delta = tool ? { role: 'assistant', tool_calls: message.tool_calls.map(call => ({ index: 0, ...call })) } : message;
      res.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ...common, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
    }
  } catch (error) { providerFailure = error; res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }
});
await new Promise(resolve => provider.listen(0, '0.0.0.0', resolve));
const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;

async function startCoordinator() {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  endpoint = `http://127.0.0.1:${port}`; token = undefined;
  coordinator = spawn(process.execPath, ['--import', 'tsx', 'runtime/service.ts'], { cwd: repository, env: {
    PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: process.env.HOME, TMPDIR: root, LANG: 'C.UTF-8',
    ...Object.fromEntries(['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'].filter(key => process.env[key]).map(key => [key, process.env[key]])),
    OPEN_HARNESS_HERMES_IMAGE: HERMES_IMAGE, OPEN_HARNESS_PORT: String(port), OPEN_HARNESS_STATE_DIR: state, OPEN_HARNESS_DISABLE_OS_VAULT: '1',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [coordinator.stdout, coordinator.stderr]) stream.on('data', data => { logs.push(String(data)); });
  for (let attempt = 0; attempt < 120; attempt++) {
    try { const response = await fetch(endpoint + '/v1/bootstrap'); if (response.ok) { token = (await response.json()).token; break; } } catch { /* isolated startup */ }
    assert.equal(coordinator.exitCode, null, 'Coordinator exited during startup.'); await delay(250);
  }
  assert.ok(token, 'Coordinator must become ready.');
}
async function stopCoordinator() {
  if (!coordinator || coordinator.exitCode !== null) return;
  const exited = new Promise(resolve => coordinator.once('close', resolve));
  coordinator.kill('SIGTERM'); const force = setTimeout(() => coordinator.kill('SIGKILL'), 20_000);
  await exited; clearTimeout(force);
  assert.equal(coordinator.exitCode, 0, 'Coordinator must shut down cleanly.');
}
async function request(path, method = 'GET', data) {
  const response = await fetch(endpoint + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(60_000) });
  return { status: response.status, value: await response.json() };
}
async function api(path, method = 'GET', data) { const { status, value } = await request(path, method, data); assert.ok(status < 300, `${method} ${path}: ${JSON.stringify(value)}`); return value; }
async function waitRun(run, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    assert.ifError(providerFailure);
    const snapshot = await api(`/v1/runs/${run.id}/events?after=0`);
    for (const pending of snapshot.run.pendingApprovals || []) await api(`/v1/runs/${run.id}/approval`, 'POST', { approvalId: pending.approvalId, decision: 'approve' });
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(snapshot.run.state)) {
      snapshots.push(snapshot); assert.equal(snapshot.run.state, 'completed', JSON.stringify(snapshot)); return snapshot;
    }
    await delay(200);
  }
  throw new Error(`Folder run ${run.id} timed out.`);
}
const run = (agentId, prompt, projectId) => api('/v1/runs', 'POST', { agentId, prompt, ...(projectId ? { projectId } : {}) }).then(waitRun);
const applied = snapshot => snapshot.events.find(event => event.type === 'profile.applied').payload.computer.folders.map(folder => `${folder.scope || 'workspace'}:${folder.name}:${folder.mode}`);
const toolResult = (snapshot, name) => { const event = snapshot.events.find(event => event.type === 'tool.complete' && event.payload.name === name); assert.ok(event, `${name} must execute through real Hermes.`); return JSON.stringify(event.payload); };
const mounts = agentId => {
  const container = JSON.parse(execFileSync('docker', ['inspect', `open-harness-${agentId}`], { encoding: 'utf8', timeout: 15_000 }))[0];
  return container.Mounts.filter(mount => mount.Destination.startsWith('/workspace/folders') || mount.Destination.startsWith('/workspace/project')).map(mount => ({ source: mount.Source, destination: mount.Destination, writable: mount.RW })).sort((a, b) => a.destination.localeCompare(b.destination));
};
const folders = async list => { const { revision } = await api('/v1/folders'); return api('/v1/folders', 'PUT', { revision, folders: list }); };
const evidence = [];
const check = async (name, work) => { await work(); evidence.push(name); console.log(`ok - ${name}`); };

try {
  await startCoordinator();
  await api('/v1/agents/sync', 'POST', { agents: Object.entries(agents).map(([role, id]) => ({ id, name: `Folder ${role}`, role: 'Folder verification', instructions: 'Work only inside this isolated folder test.', memory: [] })) });
  for (const id of Object.values(agents)) {
    const { profile } = await api(`/v1/agents/${id}/profile`);
    await api(`/v1/agents/${id}/profile`, 'PUT', { ...profile, model: { inherit: false, provider: 'local', model: 'folder-fixture', baseUrl, credentialRef: '' }, allowedTools: ['read_file', 'write_file'], computer: { ...profile.computer, access: 'private', folders: [], desktop: 'none' } });
  }

  await check('the data folder, its contents, the home folder and the whole disk are refused', async () => {
    for (const [path, reason] of [[state, /Open Harness data/], [join(state, 'agents'), /Open Harness data/], [homedir(), /home folder/], ['/', /whole disk/]]) {
      const { revision } = await api('/v1/folders');
      const refused = await request('/v1/folders', 'PUT', { revision, folders: [{ name: 'bad', path, mode: 'read', agents: { [agents.granted]: 'read' } }] });
      assert.equal(refused.status, 400, path); assert.match(refused.value.error, reason);
    }
  });

  await folders([{ name: 'kept', path: kept, mode: 'write', machineId: 'local', agents: { [agents.granted]: 'write' } }]);
  const project = await api('/v1/boards', 'POST', { name: `Folder project ${suffix}`, folders: [{ name: 'site', path: site, mode: 'write', agents: { [agents.granted]: 'write' } }] });

  await check('a granted agent reads its workspace folder and writes its project folder through real tools', async () => {
    const snapshot = await run(agents.granted, 'OH_FOLDERS_PROJECT read the kept folder and write the project folder.', project.id);
    assert.deepEqual(applied(snapshot), ['workspace:kept:write', 'project:site:write']);
    assert.match(toolResult(snapshot, 'read_file'), new RegExp(hostMarker));
    assert.equal(readFileSync(join(site, 'run-proof.txt'), 'utf8'), `${runMarker}\n`);
    assert.deepEqual(mounts(agents.granted), [{ source: kept, destination: '/workspace/folders/kept', writable: true }, { source: site, destination: '/workspace/project/site', writable: true }]);
  });

  await check('the model is told which folders are mounted, and a lone project folder is the working directory', async () => {
    const system = systems.find(entry => entry.step === 'PROJECT')?.system || '';
    const soul = readFileSync(join(state, 'agents', agents.granted, 'profile', 'SOUL.md'), 'utf8');
    for (const text of [soul, system]) {
      assert.match(text, /## Folders you can use/);
      assert.match(text, /\/workspace\/folders\/kept \(read and write\): your folder "kept"/);
      assert.match(text, /\/workspace\/project\/site \(read and write\): project folder "site"/);
    }
    assert.equal(JSON.parse(readFileSync(join(state, 'agents', agents.granted, 'profile', 'config.yaml'), 'utf8')).terminal.cwd, '/workspace/project/site');
  });

  await check('an agent given neither folder cannot see them, even in a chat set to the same project', async () => {
    const snapshot = await run(agents.other, 'OH_FOLDERS_DENIED try to read the kept folder.', project.id);
    assert.deepEqual(applied(snapshot), []);
    assert.doesNotMatch(toolResult(snapshot, 'read_file'), new RegExp(hostMarker));
    assert.deepEqual(mounts(agents.other), []);
    assert.doesNotMatch(readFileSync(join(state, 'agents', agents.other, 'profile', 'SOUL.md'), 'utf8'), /Folders you can use/);
  });

  await check('lowering access to read only is enforced by the mount on the next run', async () => {
    await folders([{ name: 'kept', path: kept, mode: 'write', machineId: 'local', agents: { [agents.granted]: 'read' } }]);
    const snapshot = await run(agents.granted, 'OH_FOLDERS_READONLY try to write the kept folder.');
    assert.deepEqual(applied(snapshot), ['workspace:kept:read']);
    assert.equal(existsSync(join(kept, 'blocked.txt')), false, 'A read-only folder must not be writable.');
    assert.deepEqual(mounts(agents.granted), [{ source: kept, destination: '/workspace/folders/kept', writable: false }]);
  });

  await check('revoking access removes the folder from the next run', async () => {
    await folders([{ name: 'kept', path: kept, mode: 'write', machineId: 'local', agents: {} }]);
    const snapshot = await run(agents.granted, 'OH_FOLDERS_DENIED try to read the kept folder after revocation.');
    assert.deepEqual(applied(snapshot), []);
    assert.doesNotMatch(toolResult(snapshot, 'read_file'), new RegExp(hostMarker));
    assert.deepEqual(mounts(agents.granted), []);
  });
  console.log(JSON.stringify({ ok: true, image: HERMES_IMAGE, checks: evidence }, null, 2));
} catch (error) {
  console.error(logs.join('').slice(-6000));
  throw error;
} finally {
  provider.close();
  try { await stopCoordinator(); } finally {
    for (const id of Object.values(agents)) { try { execFileSync('docker', ['rm', '-f', `open-harness-${id}`], { stdio: 'ignore', timeout: 15_000 }); } catch { /* not created before failure */ } }
  }
}
