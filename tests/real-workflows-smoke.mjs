// Opt in after npm run harness:setup:
// OPEN_HARNESS_REAL_WORKFLOWS=1 node --import tsx tests/real-workflows-smoke.mjs
// Actual coordinator, pinned Docker runtime, memory/skill tools, named handoff,
// and timer dispatch against a scripted local provider. This tests integration,
// not model reasoning. Allow about three minutes; no paid model is contacted.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HERMES_IMAGE } from '../runtime/readiness.ts';

assert.equal(process.env.OPEN_HARNESS_REAL_WORKFLOWS, '1', 'Set OPEN_HARNESS_REAL_WORKFLOWS=1 to run the real Docker workflow verification.');
assert.notEqual(process.env.OPEN_HARNESS_MOCK, '1', 'This check requires the real Hermes runtime.');
execFileSync('docker', ['image', 'inspect', HERMES_IMAGE], { stdio: 'ignore', timeout: 10_000 });
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(tmpdir(), 'open-harness-workflows-'));
const state = join(root, 'state');
const suffix = `${process.pid}-${Date.now().toString(36)}`;
const agentIds = { parent: `wf-parent-${suffix}`, child: `wf-child-${suffix}`, schedule: `wf-clock-${suffix}` };
const skillName = `workflow-${suffix}`;
const dashboardMarker = `DASHBOARD_${suffix}`, memoryMarker = `MEMORY_${suffix}`, skillMarker = `SKILL_${suffix}`, childMarker = `CHILD_${suffix}`, scheduleMarker = `SCHEDULE_${suffix}`;
const requests = [], snapshots = [], logs = [], approvals = [];
let providerFailure, coordinator, token, endpoint;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const names = { handoff: 'mcp__open_harness__delegate_named_agent', schedule: 'mcp__open_harness__create_open_harness_routine' };

function nextReply(body) {
  const transcript = body.messages || [];
  const prompt = String(transcript.filter(message => message.role === 'user').at(-1)?.content || '');
  const advertised = new Set((body.tools || []).map(tool => tool.function?.name));
  const called = transcript.flatMap(message => message.tool_calls || []).map(call => call.function?.name);
  const toolResults = transcript.filter(message => message.role === 'tool').map(message => String(message.content)).join('\n');
  const call = (name, args) => { assert.ok(advertised.has(name), `${name} must be model-visible for ${prompt}`); return { name, arguments: args }; };
  if (!advertised.size) return { content: 'Workflow fixture auxiliary response.' };
  if (prompt.includes('OH_WORKFLOW_SAVE')) {
    if (!called.includes('memory')) return call('memory', { target: 'memory', action: 'add', content: `The permanent workspace acceptance marker is ${memoryMarker}.` });
    if (!called.includes('skill_manage')) return call('skill_manage', { operations: [{ action: 'create', name: skillName, content: `---\nname: ${skillName}\ndescription: Use when verifying durable workflow artifacts.\n---\n# Workflow acceptance\nWrite the exact marker ${skillMarker} when verifying this workflow.\n` }] });
    return { content: 'WORKFLOW_CONTEXT_SAVED' };
  }
  if (prompt.includes('OH_WORKFLOW_RECALL')) {
    if (!called.includes('skills_list')) return call('skills_list', {});
    if (!called.includes('skill_view')) return call('skill_view', { name: skillName });
    const memoryPresent = transcript.some(message => message.role === 'system' && String(message.content).includes(memoryMarker) && String(message.content).includes(dashboardMarker));
    const skillPresent = toolResults.includes(skillMarker);
    if (!called.includes('write_file')) return call('write_file', { path: `/workspace/shared/${prompt.includes('AFTER_RESTART') ? 'recall-after-restart' : 'recall'}.txt`, content: `${memoryPresent ? memoryMarker : 'MEMORY_MISSING'}\n${skillPresent ? skillMarker : 'SKILL_MISSING'}\n` });
    return { content: 'WORKFLOW_RECALL_COMPLETE' };
  }
  if (prompt.includes('OH_WORKFLOW_PARENT')) {
    if (!called.includes(names.handoff)) return call(names.handoff, { agentId: agentIds.child, prompt: 'OH_WORKFLOW_CHILD: Write the delegated artifact and report completion.' });
    if (!called.includes('write_file')) return call('write_file', { path: '/workspace/shared/parent.txt', content: toolResults.includes(childMarker) ? `Parent received ${childMarker}.\n` : 'CHILD_RESULT_MISSING\n' });
    return { content: 'WORKFLOW_PARENT_COMPLETE' };
  }
  if (prompt.includes('OH_WORKFLOW_CHILD')) {
    if (!called.includes('write_file')) return call('write_file', { path: '/workspace/shared/child.txt', content: `${childMarker}\n` });
    return { content: childMarker };
  }
  if (prompt.includes('OH_WORKFLOW_SCHEDULE_SETUP')) {
    if (!called.includes(names.schedule)) return call(names.schedule, { name: `Workflow routine ${suffix}`, prompt: 'OH_WORKFLOW_SCHEDULE_FIRE: Write the scheduled artifact.', intervalMinutes: 1, timezone: 'UTC' });
    return { content: 'WORKFLOW_ROUTINE_CREATED' };
  }
  if (prompt.includes('OH_WORKFLOW_SCHEDULE_FIRE')) {
    if (!called.includes('write_file')) return call('write_file', { path: '/workspace/shared/scheduled.txt', content: `${scheduleMarker}\n` });
    return { content: 'WORKFLOW_SCHEDULE_COMPLETE' };
  }
  return { content: 'Workflow fixture response.' };
}

const provider = createServer(async (req, res) => {
  try {
    if (req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'workflow-fixture' }] })); return; }
    let input = ''; for await (const part of req) input += part;
    const body = JSON.parse(input); requests.push(body);
    const reply = nextReply(body), tool = reply.name;
    const message = tool ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${requests.length}`, type: 'function', function: { name: reply.name, arguments: JSON.stringify(reply.arguments) } }] } : { role: 'assistant', content: reply.content };
    const common = { id: `fixture-${requests.length}`, created: Math.floor(Date.now() / 1000), model: 'workflow-fixture' };
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
async function api(path, method = 'GET', data) {
  const response = await fetch(endpoint + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(30_000) });
  const value = await response.json(); assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(value)}`); return value;
}
async function waitRun(run, timeout = 120_000) {
  const answered = new Set(), deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    assert.ifError(providerFailure);
    const snapshot = await api(`/v1/runs/${run.id}/events?after=0`);
    for (const pending of snapshot.run.pendingApprovals || []) if (!answered.has(pending.approvalId)) {
      assert.equal(run.agent_id, agentIds.parent, 'Only the isolated memory/skill author may request approval.');
      approvals.push(pending); answered.add(pending.approvalId);
      await api(`/v1/runs/${run.id}/approval`, 'POST', { approvalId: pending.approvalId, decision: 'approve' });
    }
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(snapshot.run.state)) {
      snapshots.push(snapshot); assert.equal(snapshot.run.state, 'completed', JSON.stringify(snapshot)); return snapshot;
    }
    await delay(150);
  }
  throw new Error(`Real workflow ${run.id} timed out.`);
}
const run = (agentId, prompt) => api('/v1/runs', 'POST', { agentId, prompt }).then(waitRun);
const toolEvent = (snapshot, name) => { const event = snapshot.events.find(event => event.type === 'tool.complete' && event.payload.name === name); assert.ok(event, `${name} must execute through real Hermes.`); return event; };
const artifact = name => readFileSync(join(state, 'shared', name), 'utf8');

try {
  await startCoordinator();
  await api('/v1/agents/sync', 'POST', { agents: Object.entries(agentIds).map(([role, id]) => ({ id, name: `Workflow ${role}`, role: 'Integration verification', instructions: 'Work only inside this isolated workflow test.', memory: [] })) });
  for (const [role, id] of Object.entries(agentIds)) {
    const { profile } = await api(`/v1/agents/${id}/profile`);
    const allowedTools = role === 'parent' ? ['memory', 'skill_manage', 'skills_list', 'skill_view', 'write_file', 'mcp__open_harness__delegate_named_agent', 'mcp__open_harness__task'] : role === 'schedule' ? ['write_file', 'mcp__open_harness__create_open_harness_routine', 'mcp__open_harness__task'] : ['write_file', 'mcp__open_harness__task'];
    await api(`/v1/agents/${id}/profile`, 'PUT', { ...profile, model: { inherit: false, provider: 'local', model: 'workflow-fixture', baseUrl, credentialRef: '' }, allowedTools, computer: { ...profile.computer, access: 'private', desktop: 'none', resources: { ...profile.computer.resources, cpu: 1, memoryMb: 2048 } } });
  }
  await api('/v1/teams', 'POST', { name: 'Workflow acceptance', description: 'Disposable shared team', color: 'sage', icon: 'people', memberAgentIds: [agentIds.parent, agentIds.child] });
  await api(`/v1/agents/${agentIds.parent}/context`, 'PUT', { memory: `Dashboard-configured workspace fact: ${dashboardMarker}.` });
  const saved = await run(agentIds.parent, 'OH_WORKFLOW_SAVE: Store the memory fact and reusable skill.');
  toolEvent(saved, 'memory'); toolEvent(saved, 'skill_manage');
  const firstModelRequest = requests.find(body => body.tools?.some(tool => tool.function?.name === 'memory') && body.messages?.some(message => message.role === 'user' && String(message.content).includes('OH_WORKFLOW_SAVE')));
  assert.ok(firstModelRequest?.messages.some(message => message.role === 'system' && String(message.content).includes(dashboardMarker)), 'Dashboard-edited memory must be injected into the real Hermes session.');
  assert.match((await api(`/v1/agents/${agentIds.parent}/context`)).memory, new RegExp(memoryMarker), 'Hermes memory changes must be readable through the dashboard API.');
  assert.match(readFileSync(join(state, 'agents', agentIds.parent, 'profile', 'memories', 'MEMORY.md'), 'utf8'), new RegExp(memoryMarker));
  const recalled = await run(agentIds.parent, 'OH_WORKFLOW_RECALL: Load durable memory and the saved skill, then write the recall artifact.');
  toolEvent(recalled, 'skills_list'); toolEvent(recalled, 'skill_view'); toolEvent(recalled, 'write_file');
  assert.equal(artifact('recall.txt'), `${memoryMarker}\n${skillMarker}\n`);
  assert.notEqual(saved.run.session_id, recalled.run.session_id);
  const parent = await run(agentIds.parent, 'OH_WORKFLOW_PARENT: Delegate the child artifact to the named child, then record its result.');
  toolEvent(parent, names.handoff);
  const handoff = parent.events.find(event => event.type === 'handoff.created'); assert.ok(handoff);
  assert.equal(handoff.payload.targetAgentId, agentIds.child);
  const child = await api(`/v1/runs/${handoff.payload.childRunId}/events?after=0`); snapshots.push(child);
  assert.equal(child.run.parent_run_id, parent.run.id); assert.equal(child.run.agent_id, agentIds.child); assert.equal(child.run.state, 'completed');
  toolEvent(child, 'write_file');
  assert.ok(parent.events.some(event => event.type === 'handoff.completed' && event.payload.state === 'completed'));
  assert.equal(artifact('child.txt'), `${childMarker}\n`); assert.equal(artifact('parent.txt'), `Parent received ${childMarker}.\n`);
  const created = await run(agentIds.schedule, 'OH_WORKFLOW_SCHEDULE_SETUP: Create a one-minute recurring workflow.'); toolEvent(created, names.schedule);
  const routines = (await api('/v1/routines')).routines;
  assert.equal(routines.length, 1); const routine = routines[0]; assert.equal(routine.agent_id, agentIds.schedule);
  await stopCoordinator(); await startCoordinator();
  const afterRestart = await run(agentIds.parent, 'OH_WORKFLOW_RECALL AFTER_RESTART: Load durable memory and the saved skill, then write the recall artifact.');
  toolEvent(afterRestart, 'skill_view'); assert.notEqual(recalled.run.session_id, afterRestart.run.session_id);
  assert.equal(artifact('recall-after-restart.txt'), `${memoryMarker}\n${skillMarker}\n`);
  let history = [];
  const deadline = Date.now() + 110_000;
  while (Date.now() < deadline) { history = (await api(`/v1/routines/${routine.id}/history`)).history; if (history.length) break; await delay(500); }
  assert.equal(history.length, 1, 'The real timer must dispatch exactly one due execution without a run-now request.');
  assert.equal(history[0].scheduled_for, routine.next_run_at);
  await api(`/v1/routines/${routine.id}/toggle`, 'POST');
  const scheduled = await waitRun({ id: history[0].run_id, agent_id: agentIds.schedule }); toolEvent(scheduled, 'write_file');
  assert.equal(artifact('scheduled.txt'), `${scheduleMarker}\n`);
  const evidence = { ok: true, mode: 'real Docker Hermes with deterministic local provider; no model-reasoning claim', root, agentIds, handoff: { parentRun: parent.run.id, childRun: child.run.id, childResultReturned: true }, persistence: { memoryTool: true, skillTool: true, freshSessions: [saved.run.session_id, recalled.run.session_id, afterRestart.run.session_id], coordinatorRestart: true }, schedule: { routineId: routine.id, scheduledFor: history[0].scheduled_for, runId: scheduled.run.id, timerDispatched: true, persistedAcrossRestart: true }, approvals: approvals.length, providerRequests: requests.length };
  writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  console.error(`Workflow diagnostics: ${root}`); throw error;
} finally {
  writeFileSync(join(root, 'diagnostics.json'), JSON.stringify({ requests, snapshots, logs, approvals }, null, 2));
  try { await stopCoordinator(); } finally {
    for (const id of Object.values(agentIds)) { try { execFileSync('docker', ['rm', '-f', `open-harness-${id}`], { stdio: 'ignore', timeout: 15_000 }); } catch { /* not created before failure */ } }
    provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    writeFileSync(join(root, 'coordinator.log'), logs.join('')); console.log(`Evidence directory: ${root}`);
  }
}
