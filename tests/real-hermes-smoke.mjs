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
const helperId = `${agentId}-helper`;
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
    const projectTurn = latestPrompt.includes('PROJECT_SMOKE');
    const mainTurn = !followup && body.tools?.some(tool => tool.function?.name === 'write_file') && transcript.some(message => String(message.content).includes('REAL_HERMES_SMOKE'));
    const called = transcript.flatMap(message => message.tool_calls || []).map(call => call.function?.name);
    // Four malformed task calls in a row used to trip Hermes's breaker ("unreachable after 3
    // consecutive failures"); after them the project and its first card must still be created.
    const taskCalls = called.filter(name => name === 'mcp__open_harness__task').length;
    const toolText = String(transcript.filter(message => message.role === 'tool').at(-1)?.content || '');
    // Hermes wraps MCP output in an <untrusted_tool_result> envelope, so fall back to the raw text.
    const createdBoard = (() => { try { const outer = JSON.parse(toolText); return JSON.parse(typeof outer.result === 'string' ? outer.result : JSON.stringify(outer)).id; } catch { return /id\\*"\s*:\s*\\*"([0-9a-f-]{36})/.exec(toolText)?.[1]; } })();
    // Two agents collaborating: the lead plans a project, gives the helper a card and starts it,
    // the helper does the work in its own container and reports on the card, then the lead hands
    // the helper a follow-up and waits for its answer.
    const collabTurn = latestPrompt.includes('COLLAB_SMOKE'), cardTurn = latestPrompt.includes('You are completing board task'), handoffTurn = latestPrompt.includes('HANDOFF_SMOKE');
    const cardId = /board task ([0-9a-f-]{36})/.exec(latestPrompt)?.[1];
    const collab = collabTurn && !called.includes('mcp__open_harness__directory') ? { name: 'mcp__open_harness__directory', arguments: { action: 'agents' } }
      : collabTurn && !called.includes('mcp__open_harness__project') ? { name: 'mcp__open_harness__project', arguments: { action: 'create', name: 'Collaboration project' } }
      : collabTurn && taskCalls === 0 ? { name: 'mcp__open_harness__task', arguments: { action: 'create', boardId: createdBoard, title: 'Write test.md', description: 'Create test.md in the shared folder containing the word test.', ownerAgentId: helperId } }
      : collabTurn && taskCalls === 1 ? { name: 'mcp__open_harness__task', arguments: { action: 'run', taskId: createdBoard } }
      : collabTurn && !called.includes('mcp__open_harness__delegate_named_agent') ? { name: 'mcp__open_harness__delegate_named_agent', arguments: { agentId: helperId, prompt: 'HANDOFF_SMOKE: Confirm test.md is in the shared folder.' } }
      : cardTurn && !called.includes('write_file') ? { name: 'write_file', arguments: { path: '/workspace/shared/test.md', content: 'test\n' } }
      : cardTurn && !called.includes('mcp__open_harness__task') ? { name: 'mcp__open_harness__task', arguments: { action: 'comment', taskId: cardId, text: 'Wrote test.md in the shared folder.' } }
      : null;
    const tool = collab ? collab : collabTurn || cardTurn || handoffTurn ? null
      : projectTurn && taskCalls < 4 ? { name: 'mcp__open_harness__task', arguments: { action: 'create' } }
      : projectTurn && !called.includes('mcp__open_harness__project') ? { name: 'mcp__open_harness__project', arguments: { action: 'create', name: 'Smoke project' } }
      : projectTurn && taskCalls === 4 ? { name: 'mcp__open_harness__task', arguments: { action: 'create', boardId: createdBoard, title: 'Smoke task' } }
      : projectTurn ? null
      : approval && !called.includes('terminal') ? { name: 'terminal', arguments: { command: `chmod 666 ${JSON.stringify(toolArtifact)}` } }
      : mainTurn && !called.includes('write_file') ? { name: 'write_file', arguments: { path: toolArtifact, content: 'Written by the real Hermes tool loop.\n' } }
      : mainTurn && !called.includes('clarify') ? { name: 'clarify', arguments: { question: 'Which acceptance marker should I use?' } }
      : mainTurn && body.tools?.some(tool => tool.function?.name === 'mcp__open_harness__task') && !called.includes('mcp__open_harness__task') ? { name: 'mcp__open_harness__task', arguments: { action: 'list' } }
      : mainTurn && !called.includes('terminal') ? { name: 'terminal', arguments: { command: `touch ${JSON.stringify(toolDenied)}` } }
      : null;
    const content = collabTurn ? 'COLLAB_SMOKE_COMPLETE' : cardTurn ? 'CARD_REPORT: test.md written.' : handoffTurn ? 'HANDOFF_CONFIRMED: test.md is present.' : projectTurn ? 'PROJECT_SMOKE_COMPLETE' : approval ? 'APPROVAL_SMOKE_COMPLETE' : followup ? (transcript.some(message => String(message.content).includes('SERVICE_SEED_729')) ? 'FOLLOWUP_SERVICE_SEED_729' : 'FOLLOWUP_CONTEXT_MISSING') : mainTurn ? 'REAL_HERMES_SMOKE_COMPLETE' : 'Smoke verification';
    const message = tool ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${tool.name}-${called.length}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { role: 'assistant', content };
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
  assert.ok(modelRequests.some(body => body.messages.some(message => message.role === 'tool' && String(message.tool_call_id).startsWith('call-terminal-') && /tool_disabled|does not exist/.test(String(message.content)))), 'The managed policy must reject the fixture\'s ungranted terminal call.');
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
  await api(`/v1/agents/${agentId}/profile`, 'PUT', { ...approvalProfile, allowedTools: ['terminal', 'mcp__open_harness__task'], terminalConsent: true });
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
  const { profile: projectProfile } = await api(`/v1/agents/${agentId}/profile`);
  await api(`/v1/agents/${agentId}/profile`, 'PUT', { ...projectProfile, allowedTools: ['mcp__open_harness__task', 'mcp__open_harness__project'] });
  const projectStart = requests.length;
  const projectRun = await waitRun(await api('/v1/runs', 'POST', { agentId, conversationId: 'project-smoke', prompt: 'PROJECT_SMOKE: Create a project and a first task on it.' }));
  events.push(...projectRun.events);
  const projectCalls = projectRun.events.filter(event => event.type === 'tool.complete');
  assert.equal(projectCalls.length, 6, `Every tool call must complete: ${JSON.stringify(projectRun.events.filter(event => event.type.startsWith('tool.')).map(event => event.type))}`);
  assert.ok(!JSON.stringify(projectRun.events).includes('consecutive failures'), 'A refusal must not trip the MCP circuit breaker.');
  const smokeBoard = (await api('/v1/boards')).boards.find(board => board.name === 'Smoke project');
  assert.ok(smokeBoard, 'The project tool must create the project.');
  assert.ok((await api('/v1/tasks')).tasks.some(task => task.title === 'Smoke task' && task.boardId === smokeBoard.id), 'The task must land on the new project.');
  const offered = requests.slice(projectStart).flatMap(body => body.tools || []).find(item => item.function?.name === 'mcp__open_harness__task');
  assert.ok(offered.function.parameters.properties.title && !offered.function.parameters.properties.input, 'The model must see flat task fields.');
  const agentLog = join(state, 'agents', agentId, 'profile', 'logs', 'agent.log');
  if (existsSync(agentLog)) assert.ok(!/Unsupported MCP method|consecutive failures/.test(readFileSync(agentLog, 'utf8')), 'Hermes must not report MCP failures.');
  assertContainerStopped();
  const collaboration = container ? await (async () => {
    await api('/v1/agents/sync', 'POST', { agents: [{ id: agentId, name: 'Real smoke', role: 'Integration verification', instructions: 'Work only on this isolated smoke task.', memory: [] }, { id: helperId, name: 'Smoke helper', role: 'Collaborator', instructions: 'Do the work you are given.', memory: [] }] });
    const { profile: helper } = await api(`/v1/agents/${helperId}/profile`);
    await api(`/v1/agents/${helperId}/profile`, 'PUT', { ...helper, model: { inherit: false, provider: 'local', model: 'fixture-model', baseUrl, credentialRef: 'OPENAI_API_KEY' }, allowedTools: ['write_file', 'mcp__open_harness__task'], computer: { ...helper.computer, access: 'private', desktop: 'none' } });
    const team = await api('/v1/teams', 'POST', { name: 'Smoke collaborators', description: 'Lead and helper', color: 'blue', icon: 'people', memberAgentIds: [agentId, helperId] });
    const { profile: lead } = await api(`/v1/agents/${agentId}/profile`);
    await api(`/v1/agents/${agentId}/profile`, 'PUT', { ...lead, allowedTools: ['mcp__open_harness__task', 'mcp__open_harness__project', 'mcp__open_harness__directory', 'mcp__open_harness__delegate_named_agent'], board: { ...lead.board, assignOthers: true, dispatch: true } });
    const leadRun = await waitRun(await api('/v1/runs', 'POST', { agentId, conversationId: 'collab-smoke', prompt: 'COLLAB_SMOKE: Plan the work with your teammate.' }));
    events.push(...leadRun.events);
    const board = (await api('/v1/boards')).boards.find(item => item.name === 'Collaboration project');
    assert.ok(board, 'The lead must create the project.');
    let card;
    for (const deadline = Date.now() + 180_000; Date.now() < deadline; await new Promise(resolve => setTimeout(resolve, 500))) {
      card = (await api('/v1/tasks')).tasks.find(task => task.boardId === board.id);
      if (card?.runs?.[0] && ['completed', 'failed', 'interrupted', 'cancelled'].includes(card.runs[0].state)) break;
    }
    assert.equal(card.ownerAgentId, helperId); assert.equal(card.runs[0].agent_id, helperId);
    assert.equal(card.runs[0].state, 'completed', JSON.stringify(card.runs[0]));
    assert.ok(card.comments.some(comment => comment.body === 'Wrote test.md in the shared folder.' && comment.author === 'Smoke helper'), 'The helper must report on its card.');
    assert.equal(readFileSync(join(state, 'shared', 'test.md'), 'utf8'), 'test\n', "The helper's file must land in the shared folder.");
    const handoff = leadRun.events.find(event => event.type === 'tool.complete' && event.payload.name === 'mcp__open_harness__delegate_named_agent');
    assert.match(JSON.stringify(handoff?.payload.result), /HANDOFF_CONFIRMED/, 'The lead must receive the helper\'s handoff result.');
    assert.ok(leadRun.events.some(event => event.type === 'handoff.completed'));
    assert.ok(!JSON.stringify(leadRun.events).includes('consecutive failures'));
    await api(`/v1/teams/${team.id}`, 'DELETE').catch(() => {});
    return { project: board.id, card: card.id, helperRun: card.runs[0].id, handoffConfirmed: true, sharedFile: true };
  })() : null;
  return { collaboration, projectTools: { project: smokeBoard.id, refusalsBeforeSuccess: 4, breakerTripped: false },
    firstRun: first.id, followupRun: second.id, firstSession: completed.run.session_id, followupSession: followed.run.session_id, modelRequests: modelRequests.length, clarificationAnswered: true, realApprovalRoundTrips: approvalRuns, crossRunContext: true, authenticatedMcpDispatch: true, deniedTerminal: true, ...(container ? { containerStopped: true, hostModelNetworking: true } : {}), artifact };
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
    for (const name of [containerName, `open-harness-${helperId}`]) try { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 15_000 }); }
    catch { /* the fixture may have failed before creating its container */ }
  }
  await new Promise(resolve => server.close(resolve));
}
