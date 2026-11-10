import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMPUTER_TOOL, DEFAULT_TOOLS, draftProfile, runToolGrants } from '../lib/agent-profile';
import { prepareProfile, runtimeToolCatalog } from '../runtime/profile-runtime';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=';
const capture = { ok: true, image: 'data:image/png;base64,' + png, width: 1, height: 1 };
const profile = () => draftProfile({ id: 'managed-computer', name: 'Computer', role: 'Assistant', description: '', tone: 0, instructions: '', memory: [] });
type Handler = (body: Record<string, unknown>, req: IncomingMessage, res: ServerResponse) => unknown;

async function protocol(t: TestContext, handler: Handler, env: Record<string, string> = {}) {
  const server = createServer((req, res) => {
    let body = ''; req.on('data', part => { body += part; });
    req.on('end', () => { const value = handler(JSON.parse(body), req, res); if (value !== undefined) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); } });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const child = spawn(process.execPath, [join(import.meta.dirname, '../runtime/hermes/coordination.mjs')], { env: { ...process.env, OPEN_HARNESS_CONTROL_SOCKET: join(tmpdir(), 'absent-managed-computer.sock'), OPEN_HARNESS_CONTROL_URL: `http://127.0.0.1:${address.port}`, OPEN_HARNESS_AGENT_ID: 'managed-computer', OPEN_HARNESS_AGENT_TOKEN: 'scoped-test-token', OPEN_HARNESS_RUN_ID: 'active-run', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout }), iterator = lines[Symbol.asyncIterator]();
  t.after(async () => { child.kill(); lines.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  let id = 0;
  return async (args: Record<string, unknown>, method = 'tools/call') => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: { name: 'computer', arguments: args } }) + '\n');
    const next = await iterator.next(); assert.equal(next.done, false); return JSON.parse(next.value!);
  };
}

test('new profiles require terminal consent while saved grants and raw profile selections remain intact', () => {
  assert.ok(!DEFAULT_TOOLS.includes('terminal') && !DEFAULT_TOOLS.includes('process_manage') && !DEFAULT_TOOLS.includes(COMPUTER_TOOL));
  const prior = profile(); prior.allowedTools = ['terminal', 'process_manage', 'computer_use', 'browser_navigate']; prior.computer.desktop = 'virtual';
  const saved = structuredClone(prior);
  assert.ok(draftProfile({ id: prior.id, name: prior.name, role: prior.role, description: '', tone: 0, instructions: '', memory: [], profile: prior }).allowedTools.includes('terminal'));
  assert.deepEqual(runToolGrants(prior), ['terminal', 'process_manage', COMPUTER_TOOL]);
  assert.deepEqual(prior, saved);
  assert.deepEqual(runToolGrants({ ...prior, allowedTools: ['computer_use', COMPUTER_TOOL] }), [COMPUTER_TOOL]);
  assert.deepEqual(runToolGrants({ ...prior, allowedTools: ['browser_navigate'] }), []);
  assert.deepEqual(runToolGrants({ ...prior, computer: { ...prior.computer, desktop: 'none' } }), ['terminal', 'process_manage', 'browser_navigate']);
});

test('raw profiles compile the managed tool into both policy and MCP configuration', t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-managed-profile-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const selected = profile(); selected.allowedTools = ['computer_use', 'browser_navigate']; selected.computer.desktop = 'virtual';
  prepareProfile(root, selected, selected.model, { environment: () => ({}) }, 'token', 'run');
  const policy = JSON.parse(readFileSync(join(root, 'agents', selected.id, 'managed/policy.json'), 'utf8'));
  const config = JSON.parse(readFileSync(join(root, 'agents', selected.id, 'profile/config.yaml'), 'utf8'));
  assert.deepEqual(policy.allowedTools, [COMPUTER_TOOL]); assert.ok(config.mcp_servers.open_harness);
  const catalog = runtimeToolCatalog([{ id: 'computer_use', name: 'Native', group: 'computer_use', description: '', available: true }, { id: 'browser_navigate', name: 'Navigate', group: 'browser', description: '', available: true }], selected);
  assert.equal(catalog.some(tool => tool.id === 'computer_use'), false);
  assert.equal(catalog.find(tool => tool.id === 'browser_navigate')?.available, false);
  assert.match(catalog.find(tool => tool.id === COMPUTER_TOOL)!.description, /select it explicitly/);
});

test('managed capture is an MCP image with bounded metadata and scoped run authentication', async t => {
  const call = await protocol(t, (body, req) => {
    assert.deepEqual(body, { action: 'capture' }); assert.equal(req.url, '/internal/computer');
    assert.equal(req.headers.authorization, 'Bearer scoped-test-token'); assert.equal(req.headers['x-open-harness-run'], 'active-run');
    return capture;
  });
  const tools = await call({}, 'tools/list'); assert.ok(tools.result.tools.some((tool: { name: string }) => tool.name === 'computer'));
  const response = await call({ action: 'capture' }); assert.equal(response.error, undefined);
  assert.deepEqual(response.result.content, [{ type: 'text', text: '{"ok":true,"width":1,"height":1}' }, { type: 'image', mimeType: 'image/png', data: png }]);
});

test('managed capture rejects malformed, oversized and mismatched images', async t => {
  const responses = [ { ...capture, width: 2 }, { ...capture, image: 'data:image/png;base64,' + Buffer.from('not a png').toString('base64') }, { ...capture, width: 1441 }, { ...capture, image: 'data:image/png;base64,' + 'A'.repeat(8_000_004) }, { ...capture, image: 'data:image/png;base64,' + 'A'.repeat(8_200_000) } ];
  const call = await protocol(t, () => responses.shift());
  for (let index = 0; index < 5; index++) { const response = await call({ action: 'capture' }); assert.match(response.error.message, /invalid capture|too large/); assert.equal(response.result, undefined); }
});

test('computer approval polls one request identity and denied input does not claim dispatch', async t => {
  const requests: Record<string, unknown>[] = [];
  const call = await protocol(t, body => { requests.push(body); return requests.length === 1 ? { state: 'pending', requestId: body.requestId } : requests.length === 2 ? { ok: true } : { state: 'denied', requestId: body.requestId }; });
  const response = await call({ action: 'navigate', url: 'https://example.com/' }); assert.equal(response.error, undefined);
  assert.equal(requests.length, 2); assert.deepEqual(requests[0], requests[1]); assert.match(String(requests[0].requestId), /^[a-f0-9-]{36}$/);
  const denied = await call({ action: 'input', input: { type: 'text', text: 'private value' } });
  assert.equal(denied.result.isError, true); assert.match(denied.result.content[0].text, /No action was dispatched/); assert.ok(!JSON.stringify(denied).includes('private value'));
  assert.notEqual(requests[2].requestId, requests[0].requestId);
});

test('approval polling stops when its run lease is revoked', async t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-computer-lease-')), lease = join(root, 'lease.json'); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(lease, JSON.stringify({ active: true, runId: 'leased-run', expiresAt: Date.now() + 60000 }));
  let requests = 0;
  const call = await protocol(t, body => { requests++; writeFileSync(lease, JSON.stringify({ active: false })); return { state: 'pending', requestId: body.requestId }; }, { OPEN_HARNESS_RUN_LEASE: lease });
  const response = await call({ action: 'navigate', url: 'https://example.com/' });
  assert.match(response.error.message, /No active task/); assert.equal(requests, 1);
});

test('pending computer input never migrates to a newer run lease', async t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-computer-run-')), lease = join(root, 'lease.json'); t.after(() => rmSync(root, { recursive: true, force: true }));
  const live = { active: true, runId: 'original-run', expiresAt: Date.now() + 60000 }; writeFileSync(lease, JSON.stringify(live));
  let requests = 0;
  const call = await protocol(t, body => { requests++; writeFileSync(lease, JSON.stringify({ ...live, runId: 'new-run' })); return { state: 'pending', requestId: body.requestId }; }, { OPEN_HARNESS_RUN_LEASE: lease });
  const response = await call({ action: 'input', input: { type: 'key', key: 'Enter' } });
  assert.match(response.error.message, /owning this computer request has changed/); assert.equal(requests, 1);
});

test('computer errors and uncertain connections never poll or replay an action', async t => {
  let requests = 0;
  const call = await protocol(t, (_body, _req, res) => { requests++; if (requests === 1) { res.statusCode = 409; return { error: 'Human control owns this computer.' }; } res.destroy(); });
  assert.match((await call({ action: 'navigate', url: 'https://example.com/' })).error.message, /Human control/);
  assert.match((await call({ action: 'input', input: { type: 'key', key: 'Enter' } })).error.message, /not confirmed|interrupted/);
  assert.equal(requests, 2);
});
test('upload staging is discoverable and polls the exact provided request identity through approval', async t => {
  const requests:Record<string,unknown>[]=[],requestId='01234567-0123-4123-8123-0123456789ab';
  const file={ok:true,name:'proposal.pdf',bytes:22,path:'/workspace/exchange/uploads/0123456789abcdef-proposal.pdf'};
  const call=await protocol(t,body=>{requests.push(body);return requests.length===1?{state:'pending',requestId:body.requestId}:file;});
  const tools=await call({},'tools/list'),computer=tools.result.tools.find((tool:{name:string})=>tool.name==='computer');
  assert.ok(computer.inputSchema.properties.action.enum.includes('stage-upload'));assert.ok(computer.inputSchema.properties.input.properties.type.enum.includes('drag'));
  const response=await call({action:'stage-upload',fileName:'proposal.pdf',requestId});
  assert.deepEqual(requests,[{action:'stage-upload',fileName:'proposal.pdf',requestId},{action:'stage-upload',fileName:'proposal.pdf',requestId}]);
  assert.deepEqual(JSON.parse(response.result.content[0].text),file);
});
test('capture includes workspace download receipts and a fixed file exchange warning',async t=>{
  const downloads=[{name:'invoice.pdf',path:'downloads/file-invoice.pdf'}];
  const call=await protocol(t,()=>({...capture,downloads,fileExchangeError:'untrusted detail',extra:'omitted'}));
  const response=await call({action:'capture'}),text=JSON.parse(response.result.content[0].text);
  assert.deepEqual(text.downloads,downloads);assert.match(text.fileExchangeError,/exchange limits/);assert.equal(text.extra,undefined);assert.doesNotMatch(JSON.stringify(text),/untrusted detail/);
});
