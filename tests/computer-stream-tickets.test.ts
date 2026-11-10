import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { once } from 'node:events';
import { Duplex } from 'node:stream';
import { WebSocket } from 'ws';
import { draftProfile } from '../lib/agent-profile';
import { TerminalSessions } from '../runtime/terminal-session';
import { DesktopStreaming } from '../runtime/desktop-stream';
import { streamOriginAllowed, type ComputerStream, type StreamKind } from '../runtime/computer-stream';

const ownership = { generation: 1, owner: 'human' as const, identity: 'actor:lease' }, containerId = 'a'.repeat(64);
function profile() { const value = draftProfile({ id: 'atlas', name: 'Atlas', role: 'Assistant', description: '', tone: 0, instructions: '', memory: [] }); value.computer.desktop = 'virtual'; value.computer.machineId = 'runner'; return value; }
function connection(): ComputerStream { const stream = new Duplex({ highWaterMark: 65536, read() {}, write(_chunk, _encoding, callback) { callback(); } }); return { stream, containerId, close() { stream.destroy(); } }; }
function sessions(kind: StreamKind, connect: (_profile: unknown, _kind: StreamKind, _ownership: unknown, permitted: () => boolean) => Promise<ComputerStream>) {
  const deps = { remote: { connect } };
  if (kind === 'terminal') { const value = new TerminalSessions('/unused', deps); return { value, ticket: (permitted: () => boolean) => value.ticket(profile(), ownership, permitted) }; }
  const value = new DesktopStreaming('/unused', deps); return { value, ticket: (permitted: () => boolean) => value.ticket(profile(), permitted, ownership) };
}
async function listen(server: Server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return (server.address() as { port: number }).port; }
function environment(t: TestContext, name: string, value: string) { const previous = process.env[name]; process.env[name] = value; t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; }); }

test('computer streams admit only the configured HTTPS dashboard origin outside loopback', t => {
  environment(t, 'OPEN_HARNESS_PUBLIC_URL', 'https://harness.example:8443/api/local'); environment(t, 'OPEN_HARNESS_DESKTOP_ORIGIN', '');
  const allowed = (origin?: string) => streamOriginAllowed({ headers: { origin } } as IncomingMessage);
  assert.equal(allowed('https://harness.example:8443'), true);
  for (const origin of ['https://harness.example', 'http://harness.example:8443', 'https://harness.example:8443.evil.example', 'https://evil.example', 'null']) assert.equal(allowed(origin), false, origin);
  assert.equal(allowed('http://127.0.0.1:3000'), true); assert.equal(allowed(), true);
  for (const value of ['http://harness.example/api/local', 'https://user:password@harness.example:8443/api/local', 'invalid']) { process.env.OPEN_HARNESS_PUBLIC_URL = value; assert.equal(allowed('https://harness.example:8443'), false); }
});

for (const kind of ['terminal', 'desktop'] as const) {
  test(`${kind} remote ticket binds its immutable container before issuance and consumes that exact stream`, { timeout: 10000 }, async t => {
    environment(t, 'OPEN_HARNESS_PUBLIC_URL', 'https://harness.example/api/local');
    const source = connection(); let connects = 0; const { value, ticket } = sessions(kind, async () => { connects++; return source; });
    const server = createServer(); value.attach(server); const port = await listen(server); t.after(() => { value.close(); server.close(); });
    const result = await ticket(() => true); assert.equal(connects, 1);
    source.stream.push(kind === 'desktop' ? 'RFB 003.008\n' : '{"type":"output","data":"aGk="}\n');
    const ws = new WebSocket(`ws://127.0.0.1:${port}${result.path}`, { origin: 'https://harness.example' }), message = once(ws, 'message'); ws.on('error', () => {}); t.after(() => ws.terminate());
    assert.equal(String((await message)[0]), kind === 'desktop' ? 'RFB 003.008\n' : '{"type":"output","data":"hi"}'); assert.equal(connects, 1);
    const closed = once(source.stream, 'close'); ws.terminate(); await closed; assert.equal(source.stream.destroyed, true);
  });
  test(`${kind} unused remote tickets close their streams after 30 seconds`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] }); const source = connection(), { value, ticket } = sessions(kind, async () => source); t.after(() => value.close());
    await ticket(() => true); assert.equal(source.stream.destroyed, false); t.mock.timers.tick(30001); assert.equal(source.stream.destroyed, true);
  });
  test(`${kind} shutdown during remote startup cancels the pending permission and closes a late stream`, async () => {
    let complete!: (source: ComputerStream) => void, permitted!: () => boolean;
    const { value, ticket } = sessions(kind, async (_profile, _kind, _ownership, check) => { permitted = check; return new Promise(resolve => { complete = resolve; }); });
    const pending = ticket(() => true); assert.equal(permitted(), true); value.close(); assert.equal(permitted(), false);
    const source = connection(); complete(source); await assert.rejects(pending, /permission changed|control changed/i); assert.equal(source.stream.destroyed, true);
  });
  test(`${kind} rejects a mutable remote container name before issuing a ticket`, async () => {
    const source = connection(); source.containerId = 'container-name'; const { value, ticket } = sessions(kind, async () => source);
    await assert.rejects(ticket(() => true), /container could not be confirmed|before viewing/); assert.equal(source.stream.destroyed, true); value.close();
  });
}
