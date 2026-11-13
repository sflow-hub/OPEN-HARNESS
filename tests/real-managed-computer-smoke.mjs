// Real pinned Hermes -> managed MCP -> coordinator review -> private Chromium.
// The local provider scripts tool calls; this establishes integration, not model reasoning.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import { containerStateKey, runningAgentContainer } from '../runtime/hermes.ts';
import { runningDesktopContainer } from '../runtime/computer-runtime.ts';

assert.equal(process.env.OPEN_HARNESS_REAL_MANAGED_COMPUTER, '1', 'Set OPEN_HARNESS_REAL_MANAGED_COMPUTER=1 on an isolated Linux Docker host.');
assert.equal(process.platform, 'linux'); assert.notEqual(process.env.OPEN_HARNESS_MOCK, '1');
const repository = resolve(import.meta.dirname, '..'), root = mkdtempSync(join(process.env.OPEN_HARNESS_SMOKE_DIR || tmpdir(), 'managed-computer-'));
const paired = process.env.OPEN_HARNESS_REAL_MANAGED_COMPUTER_PAIRED === '1';
const state = join(root, 'coordinator'), runnerState = join(root, 'runner'), executionState = paired ? runnerState : state, agentId = `computer-mcp-${process.pid}`, toolName = 'mcp__open_harness__computer';
const image = process.env.OPEN_HARNESS_HERMES_IMAGE || 'open-harness-hermes:2026.9.11', exec = promisify(execFile), logs = [], requests = [], pageReads = [], decisions = [];
let coordinator, runner, endpoint, token, pageOrigin, failure, providerFailure, snapshot, database, providerImage, humanSocket, handoffWaiting = false, handoffResuming = false, continuationRead = false;
const humanMarker = `HUMAN_RESULT_${process.pid}`, handoffPrompt = 'MANAGED_COMPUTER_HANDOFF: Inspect the computer, then continue this task after the human saves handoff-proof.txt.';
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const command = async (name, args) => (await exec(name, args, { cwd: repository, timeout: 30000, maxBuffer: 5000000, encoding: 'utf8' })).stdout.trim();
const wait = async (check, label, timeout = 120000) => { const end = Date.now() + timeout; while (Date.now() < end) { const value = await check(); if (value) return value; await pause(100); } throw new Error(`Timed out: ${label}`); };
const visit = (value, found = []) => { if (typeof value === 'string' && value.startsWith('data:image/png;base64,')) found.push(value); else if (Array.isArray(value)) value.forEach(item => visit(item, found)); else if (value && typeof value === 'object') Object.values(value).forEach(item => visit(item, found)); return found; };
const provider = createServer(async (req, res) => {
  try {
    const path = new URL(req.url || '/', 'http://fixture').pathname;
    if (req.method === 'GET' && path.startsWith('/page')) { pageReads.push(path); res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Managed MCP acceptance</title><h1>MANAGED_COMPUTER_PAGE_729</h1>'); return; }
    if (req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-4o', object: 'model', context_length: 131072 }] })); return; }
    let input = ''; for await (const part of req) { input += part; if (input.length > 12000000) throw new Error('Fixture provider request too large.'); }
    const body = JSON.parse(input), messages = body.messages || [], tools = (body.tools || []).map(item => item.function?.name), called = messages.flatMap(item => item.tool_calls || []).map(item => item.id), images = visit(messages);
    if (images.length) providerImage ||= images[0];
    requests.push({ tools, calls: called, imageCount: images.length, imageBytes: images.map(value => Buffer.from(value.split(',')[1], 'base64').length), toolMessages: messages.filter(item => item.role === 'tool').map(item => ({ id: item.tool_call_id, text: typeof item.content === 'string' ? item.content.slice(0, 2000) : '[multimodal content]' })) });
    const main = tools.includes(toolName), handoff = messages.some(item => item.role === 'user' && JSON.stringify(item.content).includes('MANAGED_COMPUTER_HANDOFF:'));
    if (main && handoff && !handoffResuming && called.includes('handoff-capture')) { handoffWaiting = true; return; }
    let next = !main ? null : !called.includes('computer-deny') ? { id: 'computer-deny', args: { action: 'navigate', url: `${pageOrigin}/page-denied` } }
      : !called.includes('computer-allow') ? { id: 'computer-allow', args: { action: 'navigate', url: `${pageOrigin}/page-approved` } }
        : !called.includes('computer-capture') ? { id: 'computer-capture', args: { action: 'capture' } } : null;
    if (main && handoff) {
      if (!handoffResuming) next = { id: 'handoff-capture', args: { action: 'capture' } };
      else if (!called.includes('handoff-read')) {
        const schema = body.tools.find(item => item.function?.name === 'read_file')?.function?.parameters?.properties;
        assert.ok(schema, 'Continuation must retain the explicit read_file grant.');
        next = { id: 'handoff-read', name: 'read_file', args: { [schema.path ? 'path' : 'file_path']: '/workspace/shared/handoff-proof.txt' } };
      } else { continuationRead = messages.some(item => item.role === 'tool' && item.tool_call_id === 'handoff-read' && JSON.stringify(item.content).includes(humanMarker)); assert.equal(continuationRead, true, 'The new agent run must actually read the human-saved file.'); next = null; }
    }
    const content = main ? handoff ? `MANAGED_COMPUTER_HANDOFF_COMPLETE ${humanMarker}` : 'MANAGED_COMPUTER_MCP_COMPLETE' : 'Scripted computer acceptance';
    const message = next ? { role: 'assistant', content: null, tool_calls: [{ id: next.id, type: 'function', function: { name: next.name || toolName, arguments: JSON.stringify(next.args) } }] } : { role: 'assistant', content };
    const common = { id: `computer-fixture-${requests.length}`, created: Math.floor(Date.now() / 1000), model: 'gpt-4o' };
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const delta = next ? { role: 'assistant', tool_calls: message.tool_calls.map(call => ({ index: 0, ...call })) } : { role: 'assistant', content };
      res.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: next ? 'tool_calls' : 'stop' }] })}\n\n`); res.end('data: [DONE]\n\n');
    } else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ...common, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: next ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })); }
  } catch (error) { providerFailure = error; res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }
});
const listen = (server, host = '127.0.0.1') => new Promise(resolve => server.listen(0, host, () => resolve(server.address().port)));
const api = async (path, method = 'GET', body) => {
  const response = await fetch(endpoint + path, { method, signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(value)}`); return value;
};
console.log(`Managed computer MCP acceptance artifacts: ${root}`);
try {
  const imageInfo = JSON.parse(await command('docker', ['image', 'inspect', image]))[0]; assert.equal(imageInfo.Config.Labels['dev.openharness.runtime'], '10');
  const providerPort = await listen(provider, '0.0.0.0'), gateway = await command('docker', ['network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}']); assert.match(gateway, /^\d+\.\d+\.\d+\.\d+$/); pageOrigin = `http://${gateway}:${providerPort}`;
  const reservation = createServer(), port = await listen(reservation); await new Promise(resolve => reservation.close(resolve)); endpoint = `http://127.0.0.1:${port}`;
  coordinator = spawn(process.execPath, ['--import', 'tsx', 'runtime/service.ts'], { cwd: repository, env: { ...process.env, OPEN_HARNESS_MOCK: '0', OPEN_HARNESS_DISABLE_OS_VAULT: '1', OPEN_HARNESS_STATE_DIR: state, OPEN_HARNESS_PORT: String(port), OPEN_HARNESS_BIND: paired ? '0.0.0.0' : '127.0.0.1', OPEN_HARNESS_ALLOW_LOOPBACK_PAIRING: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [coordinator.stdout, coordinator.stderr]) stream.on('data', data => { if (logs.length < 1000) logs.push(String(data).slice(0, 10000)); });
  token = await wait(async () => { assert.equal(coordinator.exitCode, null); try { const response = await fetch(endpoint + '/v1/bootstrap'); return response.ok && (await response.json()).token; } catch { return false; } }, 'coordinator startup', 30000);
  let machineId = 'local';
  if (paired) {
    const pairing = await api('/v1/machines', 'POST', { name: 'Scripted Hermes paired fixture', platform: 'linux', coordinatorUrl: 'https://managed-computer-fixture.invalid' });
    runner = spawn(process.execPath, ['runtime/runner.mjs', '--coordinator', endpoint, '--pairing-code', pairing.code], { cwd: repository, env: { ...process.env, OPEN_HARNESS_MOCK: '0', OPEN_HARNESS_DISABLE_OS_VAULT: '1', OPEN_HARNESS_RUNNER_STATE_DIR: runnerState }, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [runner.stdout, runner.stderr]) stream.on('data', data => { if (logs.length < 1000) logs.push(`runner: ${String(data).slice(0, 10000)}`); });
    const machine = await wait(async () => { assert.equal(runner.exitCode, null); return (await api('/v1/machines')).machines.find(item => !item.local && item.status === 'online'); }, 'scripted provider paired runner');
    assert.ok(machine.capabilities.features.includes('continuous-computer')); machineId = machine.id;
  }
  await api('/v1/agents/sync', 'POST', { agents: [{ id: agentId, name: 'Computer MCP fixture', role: 'Acceptance', description: '', tone: 0, instructions: '', memory: [] }] });
  const { profile } = await api(`/v1/agents/${agentId}/profile`);
  await api(`/v1/agents/${agentId}/profile`, 'PUT', { ...profile, model: { inherit: false, provider: 'local', model: 'gpt-4o', credentialRef: '', baseUrl: `http://127.0.0.1:${providerPort}/v1` }, allowedTools: ['computer_use'], computer: { ...profile.computer, desktop: 'virtual', machineId } });
  if (paired) await wait(async () => { const value = await api(`/v1/agents/${agentId}/profile`); assert.notEqual(value.transfer?.state, 'failed', value.transfer?.detail); return value.profile.computer.machineId === machineId && value.transfer?.state === 'completed'; }, 'profile admitted to paired runner');
  const run = await api('/v1/runs', 'POST', { agentId, prompt: 'MANAGED_COMPUTER_MCP: Execute only the scripted computer actions against this isolated local fixture.', conversationId: 'computer-mcp-acceptance' }), answered = new Set();
  snapshot = await wait(async () => {
    if (providerFailure) throw providerFailure;
    const value = await api(`/v1/runs/${run.id}/events?after=0`);
    for (const approval of value.run.pendingApprovals || []) if (!answered.has(approval.approvalId)) {
      assert.equal(value.run.state, 'waiting_approval'); assert.ok(decisions.length < 2, 'Only the two navigations require approval.');
      assert.equal(pageReads.length, 0, 'The browser must not navigate before approval, including after the first denial.');
      // The scripted local endpoint has no models.dev entry. Declare its tested
      // image capability through Hermes's supported metadata override.
      const configPath = join(executionState, 'agents', agentId, 'profile/config.yaml'), config = JSON.parse(readFileSync(configPath, 'utf8'));
      writeFileSync(configPath, JSON.stringify({ ...config, model: { ...config.model, supports_vision: true } }));
      const decision = decisions.length === 0 ? 'deny' : 'approve'; answered.add(approval.approvalId); decisions.push(decision);
      await api(`/v1/runs/${run.id}/approval`, 'POST', { approvalId: approval.approvalId, decision });
    }
    if (!['completed', 'failed', 'interrupted', 'cancelled'].includes(value.run.state)) return false;
    assert.equal(value.run.state, 'completed', JSON.stringify(value)); return value;
  }, 'real Hermes managed computer run', 180000);
  assert.match(snapshot.run.result, /MANAGED_COMPUTER_MCP_COMPLETE/); assert.deepEqual(decisions, ['deny', 'approve']);
  assert.equal(pageReads.filter(path => path === '/page-denied').length, 0); assert.equal(pageReads.filter(path => path === '/page-approved').length, 1);
  const turns = requests.filter(item => item.tools.includes(toolName)); assert.ok(turns.length >= 4);
  assert.ok(turns.every(item => !item.tools.some(name => name === 'computer_use' || name === 'terminal' || name.startsWith('browser_'))), 'Only the explicitly mapped managed computer may appear.');
  assert.ok(providerImage, 'The real Hermes model request must carry MCP capture as image content.');
  const png = Buffer.from(providerImage.split(',')[1], 'base64'); assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); assert.ok(png.length > 1000 && png.length <= 6000000); writeFileSync(join(root, 'managed-capture.png'), png);
  assert.ok(turns.some(item => item.toolMessages.some(message => message.id === 'computer-deny' && /did not approve|denied/i.test(message.text))));
  const stale = await fetch(endpoint + '/internal/computer', { method: 'POST', headers: { Authorization: `Bearer ${createHmac('sha256', token).update(`agent:${agentId}`).digest('hex')}`, 'Content-Type': 'application/json', 'x-open-harness-agent': agentId, 'x-open-harness-run': run.id }, body: JSON.stringify({ action: 'capture' }) }); assert.equal(stale.status, 403, 'A completed run must lose its computer lease.');
  database = new DatabaseSync(join(state, 'state.db')); const reviews = database.prepare('SELECT tool,state FROM unclassified_actions WHERE run_id=? ORDER BY created_at').all(run.id); assert.equal(reviews.length, 2); assert.ok(reviews.every(item => item.tool === toolName)); assert.equal(reviews.filter(item => item.state === 'tool_confirmed').length, 1);
  const current = (await api(`/v1/agents/${agentId}/profile`)).profile;
  await api(`/v1/agents/${agentId}/profile`, 'PUT', { ...current, allowedTools: ['computer_use', 'read_file'] });
  const interrupted = await api('/v1/runs', 'POST', { agentId, prompt: handoffPrompt, conversationId: 'computer-handoff-acceptance' });
  await wait(() => { if (providerFailure) throw providerFailure; return handoffWaiting; }, 'real agent capture before human takeover', 180000);
  const executionId = await runningAgentContainer(agentId, executionState), desktopId = await runningDesktopContainer(agentId, executionState, current.computer); assert.ok(executionId && desktopId);
  const lease = await api(`/v1/agents/${agentId}/desktop/take-control`, 'POST', { confirm: true }); assert.equal(lease.ready, true); assert.equal(lease.browserSessionPreserved, true);
  const stopped = (await api(`/v1/runs/${interrupted.id}/events?after=0`)).run; assert.ok(['cancelled', 'interrupted'].includes(stopped.state));
  assert.equal(await command('docker', ['inspect', '-f', '{{.State.Running}}', executionId]), 'false');
  assert.equal(await runningDesktopContainer(agentId, executionState, current.computer), desktopId);
  const ticket = await api(`/v1/agents/${agentId}/terminal`, 'POST', { leaseId: lease.leaseId }), socketUrl = new URL(ticket.path, endpoint); socketUrl.protocol = 'ws:';
  humanSocket = new WebSocket(socketUrl, { origin: endpoint, perMessageDeflate: false }); let terminalOutput = '';
  humanSocket.on('message', bytes => { const value = JSON.parse(bytes.toString()); if (value.type === 'output') terminalOutput += value.data; if (value.type === 'error') providerFailure = new Error(value.message); }); humanSocket.on('error', error => { providerFailure = error; });
  await new Promise((resolve, reject) => { humanSocket.once('open', resolve); humanSocket.once('error', reject); });
  humanSocket.send(JSON.stringify({ type: 'input', data: `printf '${humanMarker}\\n' > handoff-proof.txt\n` }));
  await wait(() => existsSync(join(executionState, 'shared/handoff-proof.txt')) && readFileSync(join(executionState, 'shared/handoff-proof.txt'), 'utf8').trim() === humanMarker, 'human saved result through real terminal');
  assert.equal(await runningAgentContainer(agentId, executionState), executionId);
  handoffResuming = true; await api(`/v1/agents/${agentId}/desktop/release`, 'POST', { leaseId: lease.leaseId, continueWork: true });
  await wait(() => humanSocket.readyState === WebSocket.CLOSED, 'human terminal closes at handback');
  const continuation = await wait(() => database.prepare("SELECT r.id,r.state,r.result FROM runs r JOIN run_contexts c ON c.run_id=r.id WHERE c.source_run_id=? AND c.purpose='continuation'").get(interrupted.id), 'new continuation run');
  assert.notEqual(continuation.id, interrupted.id);
  const continued = await wait(async () => { if (providerFailure) throw providerFailure; const value = (await api(`/v1/runs/${continuation.id}/events?after=0`)).run; if (!['completed','failed','interrupted','cancelled'].includes(value.state)) return false; assert.equal(value.state, 'completed', JSON.stringify(value)); return value; }, 'real Hermes continuation after human work', 180000);
  assert.equal(continuationRead, true); assert.match(continued.result, /MANAGED_COMPUTER_HANDOFF_COMPLETE/); assert.ok(continued.result.includes(humanMarker)); assert.ok(terminalOutput.length > 0);
  assert.equal(await runningDesktopContainer(agentId, executionState, current.computer), desktopId); assert.equal(pageReads.filter(path => path === '/page-approved').length, 1);
  const evidence = { ok: true, mode: 'real pinned Hermes with local scripted provider and explicit vision metadata; no paid inference', execution: paired ? 'bundled paired Linux runner' : 'local Linux coordinator', image, imageId: imageInfo.Id, architecture: imageInfo.Architecture, modelTurns: turns.length, totalMainModelTurns: requests.filter(item => item.tools.includes(toolName)).length, mappedManagedTool: true, nativeBrowserHidden: true, deniedNavigationHasNoEffect: true, approvedNavigationOnce: true, readOnlyCaptureHasNoReview: true, modelReceivedMcpImage: true, pngBytes: png.length, completedRunLeaseDenied: true, brokerReviews: reviews.length, activeHermesRunStoppedForHuman: true, realHumanTerminalSavedFile: true, newContinuationReadHumanResult: true, sameExecutionContainer: true, liveBrowserPreservedThroughContinuation: true };
  writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence, null, 2));
} catch (error) { failure = error; }
finally {
  humanSocket?.terminate();
  database?.close();
  for (const child of [runner, coordinator]) if (child && child.exitCode === null && child.signalCode === null) { const closed = new Promise(resolve => child.once('close', resolve)); child.kill('SIGTERM'); const deadline = setTimeout(() => child.kill('SIGKILL'), 20000); await closed; clearTimeout(deadline); }
  provider.closeAllConnections(); await new Promise(resolve => provider.close(() => resolve()));
  for (const directory of paired ? [runnerState, state] : [state]) try { const ids = (await command('docker', ['ps', '-aq', '--filter', `label=open-harness.state=${containerStateKey(directory)}`])).split('\n').filter(Boolean); if (ids.length) await command('docker', ['rm', '-f', ...ids]); } catch (error) { failure ||= error; }
  writeFileSync(join(root, 'diagnostics.json'), JSON.stringify({ error: failure ? String(failure.stack || failure) : null, logs, requests, pageReads, decisions, snapshot }, null, 2));
}
if (failure) { console.error(`Managed computer MCP acceptance failed: ${root}`); throw failure; }
