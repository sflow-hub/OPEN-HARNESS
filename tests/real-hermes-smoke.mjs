// Build the pinned image with npm run harness:setup, then opt in:
// OPEN_HARNESS_REAL_CONTAINER=1 node --import tsx tests/real-hermes-smoke.mjs
// Exercises the real pinned Hermes gateway against a local scripted provider.
// It verifies protocol/tool integration, not model reasoning. Container mode also
// exercises the production private profile, bind mounts, networking and shutdown.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HERMES_IMAGE } from '../runtime/readiness.ts';

const container = process.env.OPEN_HARNESS_REAL_CONTAINER === '1';
assert.ok(container, 'Set OPEN_HARNESS_REAL_CONTAINER=1 for Docker. Native execution is disabled.');
assert.notEqual(process.env.OPEN_HARNESS_MOCK, '1', 'This verification must use the real Hermes process.');
if (container) execFileSync('docker', ['image', 'inspect', HERMES_IMAGE], { stdio: 'ignore', timeout: 10_000 });
const agentId = container ? `real-smoke-${process.pid}` : 'real-smoke';
const containerName = `open-harness-${agentId}`;
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(tmpdir(), 'open-harness-real-smoke-'));
const profile = join(root, 'profile'), workspace = join(root, 'workspace');
mkdirSync(profile); mkdirSync(workspace);
let artifact = join(workspace, 'verified.txt'), denied = join(workspace, 'forbidden.txt');
let toolArtifact = artifact, toolDenied = denied;
const requests = [], events = [], logs = [];
let providerFailure;

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ object: 'list', data: [{ id: 'fixture-model', object: 'model' }] })); return; }
    let input = ''; for await (const part of req) input += part;
    const body = JSON.parse(input); requests.push(body);
    const transcript = body.messages || [];
    const latestPrompt = String(transcript.filter(message => message.role === 'user').at(-1)?.content);
    const followup = latestPrompt.includes('REAL_HERMES_FOLLOWUP');
    const approval = latestPrompt.includes('APPROVAL_SMOKE');
    const mainTurn = !followup && body.tools?.some(tool => tool.function?.name === 'write_file') && transcript.some(message => String(message.content).includes('REAL_HERMES_SMOKE'));
    const called = transcript.flatMap(message => message.tool_calls || []).map(call => call.function?.name);
    const tool = approval && !called.includes('terminal') ? { name: 'terminal', arguments: { command: `chmod 666 ${JSON.stringify(toolArtifact)}` } }
      : mainTurn && !called.includes('write_file') ? { name: 'write_file', arguments: { path: toolArtifact, content: 'Written by the real Hermes tool loop.\n' } }
      : mainTurn && !called.includes('clarify') ? { name: 'clarify', arguments: { question: 'Which acceptance marker should I use?' } }
      : mainTurn && body.tools?.some(tool => tool.function?.name === 'mcp__open_harness__task') && !called.includes('mcp__open_harness__task') ? { name: 'mcp__open_harness__task', arguments: { action: 'list' } }
      : mainTurn && !called.includes('terminal') ? { name: 'terminal', arguments: { command: `touch ${JSON.stringify(toolDenied)}` } }
      : null;
    const content = approval ? 'APPROVAL_SMOKE_COMPLETE' : followup ? (transcript.some(message => String(message.content).includes('SERVICE_SEED_729')) ? 'FOLLOWUP_SERVICE_SEED_729' : 'FOLLOWUP_CONTEXT_MISSING') : mainTurn ? 'REAL_HERMES_SMOKE_COMPLETE' : 'Smoke verification';
    const message = tool ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${tool.name}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { role: 'assistant', content };
    const common = { id: `fixture-${requests.length}`, created: Math.floor(Date.now() / 1000), model: 'fixture-model' };
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const delta = tool ? { role: 'assistant', tool_calls: message.tool_calls.map(call => ({ index: 0, ...call })) } : { role: 'assistant', content };
      res.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...common, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
    }
  } catch (error) { providerFailure = error; res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }
});
// A Linux bridge container reaches the fixture through host.docker.internal.
// Only this disposable test provider listens beyond loopback; the coordinator
// remains private and uses its per-agent Unix socket for container coordination.
await new Promise(resolve => server.listen(0, container ? '0.0.0.0' : '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
writeFileSync(join(profile, 'config.yaml'), JSON.stringify({ model: { default: 'fixture-model', provider: 'custom', base_url: baseUrl, context_length: 131072 }, terminal: { backend: 'local', cwd: workspace, home_mode: 'profile' }, plugins: { enabled: ['open_harness_policy'] }, cron: { enabled: false }, agent: { max_turns: 8 }, mcp_servers: {} }));
writeFileSync(join(profile, 'SOUL.md'), 'You are an integration verification agent.');
writeFileSync(join(root, 'policy.json'), JSON.stringify({ allowedTools: ['write_file', 'clarify'] }));
let coordinator;
async function verifyCoordinator() {
  const state = join(root, 'coordinator');
  const portReservation = createServer();
  await new Promise(resolve => portReservation.listen(0, '127.0.0.1', resolve));
  const port = portReservation.address().port;
  await new Promise(resolve => portReservation.close(resolve));
  coordinator = spawn(process.execPath, ['--import', 'tsx', 'runtime/service.ts'], {
    cwd: repository,
    env: { PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, TMPDIR: root, LANG: 'en_US.UTF-8', ...Object.fromEntries(['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'].filter(key => process.env[key]).map(key => [key, process.env[key]])), OPEN_HARNESS_HERMES_IMAGE: HERMES_IMAGE, OPEN_HARNESS_PORT: String(port), OPEN_HARNESS_STATE_DIR: state, OPEN_HARNESS_DISABLE_OS_VAULT: '1', OPENAI_API_KEY: 'local-fixture-only', OPENAI_BASE_URL: baseUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  coordinator.stdout.on('data', data => logs.push({ coordinator: String(data) }));
  coordinator.stderr.on('data', data => { logs.push({ coordinator: String(data) }); if (process.env.OPEN_HARNESS_REAL_SMOKE_DEBUG) console.error(String(data)); });
  const endpoint = `http://127.0.0.1:${port}`;
  let token;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { const response = await fetch(endpoint + '/v1/bootstrap'); if (response.ok) { token = (await response.json()).token; break; } } catch { /* wait for the isolated service */ }
    assert.equal(coordinator.exitCode, null, 'Coordinator exited before becoming ready.');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(token, 'Coordinator must become ready.');
  const api = async (path, method = 'GET', data) => {
    const response = await fetch(endpoint + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
    const value = await response.json(); assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(value)}`); return value;
  };
  await api('/v1/agents/sync', 'POST', { agents: [{ id: agentId, name: 'Real smoke', role: 'Integration verification', instructions: 'Work only on this isolated smoke task.', memory: [] }] });
  const { profile: saved } = await api(`/v1/agents/${agentId}/profile`);
  await api(`/v1/agents/${agentId}/profile`, 'PUT', { ...saved, model: { inherit: false, provider: 'local', model: 'fixture-model', baseUrl, credentialRef: 'OPENAI_API_KEY' }, allowedTools: ['write_file', 'clarify', 'mcp__open_harness__task'], computer: { ...saved.computer, access: 'private', desktop: 'none' } });
  artifact = join(state, 'shared', 'verified.txt'); denied = join(state, 'shared', 'forbidden.txt');
  toolArtifact = container ? '/workspace/shared/verified.txt' : artifact;
  toolDenied = container ? '/workspace/shared/forbidden.txt' : denied;
  const requestStart = requests.length;
  const waitRun = async (run, approvalDecision) => {
    const deadline = Date.now() + 90_000, answered = new Set();
    while (Date.now() < deadline) {
      const snapshot = await api(`/v1/runs/${run.id}/events?after=0`);
      for (const approval of snapshot.events.filter(event => event.type === 'approval.request')) {
        const id = approval.payload.approvalId;
        if (!answered.has(id)) {
          assert.ok(approvalDecision, 'Unexpected approval request.');
          assert.equal(snapshot.run.state, 'waiting_approval');
          assert.equal(statSync(artifact).mode & 0o777, 0o600, 'The flagged command must not execute before approval.');
          answered.add(id);
          await api(`/v1/runs/${run.id}/approval`, 'POST', { approvalId: id, decision: approvalDecision });
        }
      }
      for (const pending of snapshot.run.pendingInputs || []) {
        if (!answered.has(pending.inputId)) { answered.add(pending.inputId); await api(`/v1/runs/${run.id}/input`, 'POST', { inputId: pending.inputId, value: 'fixture-answer' }); }
      }
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(snapshot.run.state)) {
        assert.equal(snapshot.run.state, 'completed', JSON.stringify(snapshot));
        return snapshot;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Real coordinator run ${run.id} timed out.`);
  };
  const first = await api('/v1/runs', 'POST', { agentId, conversationId: 'real-continuity', prompt: 'REAL_HERMES_SMOKE: The continuity marker is SERVICE_SEED_729. Write the artifact, clarify, and complete.' });
  const completed = await waitRun(first);
  events.push(...completed.events);
  assert.equal(readFileSync(artifact, 'utf8'), 'Written by the real Hermes tool loop.\n');
  assert.ok(completed.events.some(event => event.type === 'clarify.request'));
  assert.ok(completed.events.some(event => event.type === 'input.resolved'));
  assert.ok(completed.events.some(event => event.type === 'tool.complete' && event.payload.name === 'write_file'));
  const coordination = completed.events.find(event => event.type === 'tool.complete' && event.payload.name === 'mcp__open_harness__task');
  assert.ok(coordination, 'The mandatory task tool must be available through the real Hermes MCP registry.');
  assert.match(JSON.stringify(coordination.payload.result), /boards/);
  assert.doesNotMatch(JSON.stringify(coordination.payload.result), /disabled|authentication|ECONNREFUSED/);
  assert.equal(existsSync(denied), false);
  const modelRequests = requests.slice(requestStart).filter(body => body.tools?.some(tool => tool.function?.name === 'write_file') && body.messages?.some(message => String(message.content).includes('REAL_HERMES_SMOKE')));
  assert.ok(modelRequests.length >= 5, 'The coordinator must exercise file, clarify, task and denied terminal calls.');
  for (const body of modelRequests) assert.ok(body.tools.every(tool => ['write_file', 'clarify', 'mcp__open_harness__task'].includes(tool.function?.name)), 'Only granted tools may be model-visible.');
  assert.ok(modelRequests.some(body => body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'call-terminal' && /tool_disabled|does not exist/.test(String(message.content)))), 'The managed policy must reject the fixture\'s ungranted terminal call.');
  const assertContainerStopped = () => {
    if (!container) return;
    assert.equal(execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', containerName], { encoding: 'utf8', timeout: 10_000 }).trim(), 'false', 'A completed run must stop its container.');
  };
  assertContainerStopped();
  const second = await api('/v1/runs', 'POST', { agentId, conversationId: 'real-continuity', prompt: 'REAL_HERMES_FOLLOWUP: Return the prior continuity marker.' });
  const followed = await waitRun(second);
  events.push(...followed.events);
  assert.match(followed.run.result, /FOLLOWUP_SERVICE_SEED_729/);
  assert.notEqual(completed.run.session_id, followed.run.session_id, 'A new profile snapshot must seed a fresh real session.');
  const replay = await api(`/v1/runs/${first.id}/events?after=0`);
  assert.deepEqual(replay.events, completed.events, 'Completed event history must remain stable after the next run.');
  assertContainerStopped();
  if (container) {
    const config = JSON.parse(readFileSync(join(state, 'agents', agentId, 'profile', 'config.yaml'), 'utf8'));
    assert.equal(config.model.base_url, baseUrl.replace('127.0.0.1', 'host.docker.internal'));
  }
  const { profile: approvalProfile } = await api(`/v1/agents/${agentId}/profile`);
  await api(`/v1/agents/${agentId}/profile`, 'PUT', { ...approvalProfile, allowedTools: ['terminal', 'mcp__open_harness__task'] });
  const approvalRuns = [];
  for (const decision of ['deny', 'approve']) {
    chmodSync(artifact, 0o600);
    const run = await api('/v1/runs', 'POST', { agentId, conversationId: `approval-${decision}`, prompt: 'APPROVAL_SMOKE: Request the harmless fixture permission change once, then finish.' });
    const snapshot = await waitRun(run, decision);
    events.push(...snapshot.events);
    assert.ok(snapshot.events.some(event => event.type === 'approval.request'));
    assert.ok(snapshot.events.some(event => event.type === 'approval.resolved' && event.payload.decision === decision));
    const mode = statSync(artifact).mode & 0o777;
    assert.equal(mode, decision === 'approve' ? 0o666 : 0o600, `Actual terminal effect must match ${decision}.`);
    assertContainerStopped();
    approvalRuns.push({ runId: run.id, decision, resultingMode: mode.toString(8) });
  }
  chmodSync(artifact, 0o600);
  return { firstRun: first.id, followupRun: second.id, firstSession: completed.run.session_id, followupSession: followed.run.session_id, modelRequests: modelRequests.length, clarificationAnswered: true, realApprovalRoundTrips: approvalRuns, crossRunContext: true, authenticatedMcpDispatch: true, deniedTerminal: true, ...(container ? { containerStopped: true, hostModelNetworking: true } : {}), artifact };
}
try {
  const service = await verifyCoordinator();
  assert.ifError(providerFailure);
  const evidence = { ok: true, mode: `real ${container ? 'container' : 'native'} Hermes with local scripted completion fixture`, root, eventTypes: [...new Set(events.map(event => event.type))], artifact, seededContext: true, deniedTerminal: true, service };
  writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  writeFileSync(join(root, 'diagnostics.json'), JSON.stringify({ requests, events, logs }, null, 2));
  console.error(`Real Hermes smoke diagnostics: ${root}`);
  throw error;
} finally {
  if (coordinator && coordinator.exitCode === null) {
    const exited = new Promise(resolve => coordinator.once('exit', resolve));
    coordinator.kill('SIGTERM');
    const force = setTimeout(() => coordinator.kill('SIGKILL'), 20_000);
    await exited; clearTimeout(force);
  }
  if (container) {
    try { execFileSync('docker', ['rm', '-f', containerName], { stdio: 'ignore', timeout: 15_000 }); }
    catch { /* the fixture may have failed before creating its container */ }
  }
  await new Promise(resolve => server.close(resolve));
}
