import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { Duplex } from 'node:stream';
import { WebSocket } from 'ws';
import { draftProfile } from '../lib/agent-profile';
import { TerminalSessions, terminalInput, terminalOutput } from '../runtime/terminal-session';
const container = 'a'.repeat(64), ownership = { generation: 1, owner: 'human' as const, identity: 'actor:lease' };
function profile() { const result = draftProfile({ id: 'atlas', name: 'Atlas', role: 'Assistant', description: '', tone: 0, instructions: '', memory: [] }); result.computer.desktop = 'virtual'; return result; }
async function listen(server: Server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return (server.address() as { port: number }).port; }
async function denied(url: string) { const ws = new WebSocket(url); ws.on('error', () => {}); await new Promise(resolve => ws.once('close', resolve)); }
test('terminal input is bounded and validates dimensions without interpreting shell text', () => {
  assert.deepEqual(terminalInput({ type: 'input', data: 'echo $(whoami)\r\u0003' }), { type: 'input', data: Buffer.from('echo $(whoami)\r\u0003').toString('base64') });
  assert.deepEqual(terminalInput({ type: 'resize', rows: 40, cols: 120 }), { type: 'resize', rows: 40, cols: 120 });
  for (const value of [null, { type: 'command', data: 'pwd' }, { type: 'input', data: 'x'.repeat(16385) }, { type: 'input', data: '💻'.repeat(5000) }, { type: 'resize', rows: 0, cols: 80 }, { type: 'resize', rows: 24, cols: 501 }, { type: 'resize', rows: 24.5, cols: 80 }]) assert.throws(() => terminalInput(value));
});
test('terminal output decodes split UTF-8 and strips all unrecognized frame fields', async () => {
  const stream = terminalOutput(), frames: Array<{ type: string; data?: string; code?: number }> = []; stream.on('data', value => frames.push(JSON.parse(String(value))));
  const bytes = Buffer.from('A💻éB'), records = [bytes.subarray(0, 3), bytes.subarray(3, 6), bytes.subarray(6)].map(data => JSON.stringify({ type: 'output', data: data.toString('base64'), secret: 'not reflected' }) + '\n').join('') + JSON.stringify({ type: 'exit', code: 0, secret: 'not reflected' }) + '\n';
  stream.write(records.slice(0, 7)); stream.end(records.slice(7)); await once(stream, 'end');
  assert.equal(frames.filter(value => value.type === 'output').map(value => value.data).join(''), 'A💻éB');
  assert.deepEqual(frames.at(-1), { type: 'exit', code: 0 }); assert.ok(!JSON.stringify(frames).includes('not reflected'));
  const invalid = terminalOutput(), failure = once(invalid, 'error'); invalid.end('{"type":"output","data":"bad!"}\n'); assert.match(String((await failure)[0]), /invalid/);
});
test('terminal tickets are one-use and controller revocation closes input before dispatch', { timeout: 10000 }, async t => {
  let permitted = true, assertions = 0; const input: string[] = [];
  const source = new Duplex({ read() {}, write(chunk, _encoding, callback) { input.push(String(chunk)); callback(); } });
  const terminal = new TerminalSessions('/unused', { ensure: async () => container, current: async () => container, assertOwnership: () => { assertions++; }, open: () => ({ stream: source, containerId: container, close: () => source.destroy() }) });
  const server = createServer(); terminal.attach(server); const port = await listen(server); t.after(() => { terminal.close(); server.close(); });
  const ticket = await terminal.ticket(profile(), ownership, () => permitted), url = `ws://127.0.0.1:${port}${ticket.path}`, ws = new WebSocket(url); ws.on('error', () => {}); t.after(() => ws.terminate()); await once(ws, 'open');
  const response = once(ws, 'message'); source.push('{"type":"output","data":"aGk="}\n'); const [data, binary] = await response;
  assert.equal(binary, false, 'Browser JSON output must be a text WebSocket frame, not an ignored Blob.'); assert.deepEqual(JSON.parse(String(data)), { type: 'output', data: 'hi' });
  ws.send(JSON.stringify({ type: 'resize', rows: 24, cols: 80 })); while (!input.length) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(JSON.parse(input[0]), { type: 'resize', rows: 24, cols: 80 });
  await denied(url); const closed = once(ws, 'close'); permitted = false; ws.send(JSON.stringify({ type: 'input', data: 'secret' })); await closed;
  assert.equal(input.length, 1); assert.ok(assertions >= 3); assert.equal(source.destroyed, true);
});
test('terminal startup rejects ownership and container identity changes and wrong origins', { timeout: 10000 }, async t => {
  let current = container, opens = 0;
  const terminal = new TerminalSessions('/unused', { ensure: async () => container, current: async () => current, assertOwnership: () => {}, open: () => { opens++; throw new Error('must not open'); } });
  const server = createServer(); terminal.attach(server); const port = await listen(server); t.after(() => { terminal.close(); server.close(); });
  await assert.rejects(terminal.ticket(profile(), { ...ownership, owner: 'agent' }, () => true), /Take control/);
  await assert.rejects(terminal.ticket(profile(), ownership, () => false), /control changed/);
  const one = await terminal.ticket(profile(), ownership, () => true); current = 'b'.repeat(64); await denied(`ws://127.0.0.1:${port}${one.path}`); assert.equal(opens, 0);
  const two = await terminal.ticket(profile(), ownership, () => true), ws = new WebSocket(`ws://127.0.0.1:${port}${two.path}`, { origin: 'https://untrusted.example' }); ws.on('error', () => {}); await new Promise(resolve => ws.once('close', resolve)); assert.equal(opens, 0);
});
test('closing an agent invalidates outstanding terminal tickets', { timeout: 10000 }, async t => {
  const terminal = new TerminalSessions('/unused', { ensure: async () => container, assertOwnership: () => {} }), server = createServer(); terminal.attach(server); const port = await listen(server); t.after(() => { terminal.close(); server.close(); });
  const ticket = await terminal.ticket(profile(), ownership, () => true); terminal.closeAgent('atlas'); await denied(`ws://127.0.0.1:${port}${ticket.path}`);
});
