import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { draftProfile } from '../lib/agent-profile';
import { admitRunnerTerminal, RunnerDuplex } from '../runtime/runner-duplex';
import { assertComputerOwnership, claimComputerOwnership } from '../runtime/computer-ownership';
const container = 'a'.repeat(64), ownership = { generation: 2, owner: 'human' as const, identity: 'controller:lease' };
function profile() { const result = draftProfile({ id: 'atlas', name: 'Atlas', role: 'Assistant', description: '', tone: 0, instructions: '', memory: [] }); result.computer.desktop = 'virtual'; result.computer.machineId = 'runner'; return result; }
async function listen(server: Server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return (server.address() as { port: number }).port; }
test('runner duplex invitations are ephemeral and one-use with machine authentication', { timeout: 10000 }, async t => {
  let authorized = true; const wakes: string[] = [], bridge = new RunnerDuplex(id => wakes.push(id)), server = createServer();
  bridge.attach(server, req => authorized && req.headers.authorization === 'Bearer test' ? String(req.headers['x-open-harness-machine']) : null);
  const port = await listen(server); t.after(() => { bridge.close(); server.close(); });
  const pending = bridge.connect(profile(), 'terminal', ownership, () => true); assert.deepEqual(bridge.poll('other'), []);
  const [command] = bridge.poll('runner'); assert.equal(command.kind, 'duplex'); assert.deepEqual(command.payload.ownership, ownership); assert.deepEqual(bridge.poll('runner'), []); assert.deepEqual(wakes, ['runner']);
  const url = `ws://127.0.0.1:${port}${command.payload.path}`;
  const denied = new WebSocket(url, { headers: { Authorization: 'Bearer test', 'X-Open-Harness-Machine': 'other' } }); denied.on('error', () => {}); await new Promise(resolve => denied.once('close', resolve));
  const runner = new WebSocket(url, { headers: { Authorization: 'Bearer test', 'X-Open-Harness-Machine': 'runner' } }); runner.on('error', () => {}); t.after(() => runner.terminate()); await once(runner, 'open');
  const accepted = once(runner, 'message'); runner.send(JSON.stringify({ type: 'ready', containerId: container })); assert.deepEqual(JSON.parse(String((await accepted)[0])), { type: 'accepted' });
  const channel = await pending; assert.equal(channel.containerId, container);
  const input = once(runner, 'message'); channel.stream.write('private input'); assert.equal(String((await input)[0]), 'private input');
  const output = once(channel.stream, 'data'); runner.send(Buffer.from('private output')); assert.equal(String((await output)[0]), 'private output');
  const replay = new WebSocket(url, { headers: { Authorization: 'Bearer test', 'X-Open-Harness-Machine': 'runner' } }); replay.on('error', () => {}); await new Promise(resolve => replay.once('close', resolve));
  const closed = once(runner, 'close'), destroyed = new Promise(resolve => channel.stream.once('close', resolve)); authorized = false; await Promise.all([closed, destroyed]); assert.equal(channel.stream.destroyed, true);
});
test('runner duplex rejects expired or revoked invitations without replay and closes pending work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const bridge = new RunnerDuplex(() => {}); let permitted = true;
  const expired = bridge.connect(profile(), 'desktop', ownership, () => permitted), expiredCheck = assert.rejects(expired, /expired/); t.mock.timers.tick(20001); assert.deepEqual(bridge.poll('runner'), []); await expiredCheck;
  const revoked = bridge.connect(profile(), 'desktop', ownership, () => permitted), revokedCheck = assert.rejects(revoked, /expired/); permitted = false; assert.deepEqual(bridge.poll('runner'), []); await revokedCheck;
  permitted = true; const pending = bridge.connect(profile(), 'desktop', ownership, () => permitted), closeCheck = assert.rejects(pending, /stopping/); bridge.close(); await closeCheck;
  assert.deepEqual(bridge.poll('runner'), []); await assert.rejects(bridge.connect(profile(), 'terminal', ownership, () => true), /permission/);
});
test('runner cannot bind a shell stream to a mutable container name', { timeout: 10000 }, async t => {
  const bridge = new RunnerDuplex(() => {}), server = createServer(); bridge.attach(server, () => 'runner'); const port = await listen(server); t.after(() => { bridge.close(); server.close(); });
  const pending = bridge.connect(profile(), 'terminal', ownership, () => true), rejected = assert.rejects(pending, /before it was ready/), [command] = bridge.poll('runner');
  const runner = new WebSocket(`ws://127.0.0.1:${port}${command.payload.path}`); runner.on('error', () => {}); await once(runner, 'open'); runner.send(JSON.stringify({ type: 'ready', containerId: 'open-harness-atlas' })); await rejected;
});

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
test('terminal startup waits for a desktop operation but releases admission while the accepted stream remains open', async () => {
  const desktop = deferred(), stream = deferred(), started = deferred(), operations = new Map([['atlas', desktop.promise]]); let ready!: () => void, finished = false;
  const admission = admitRunnerTerminal('atlas', Date.now() + 20000, operations, () => {}, accepted => { ready = accepted; started.resolve(); return stream.promise; }).then(() => { finished = true; });
  await Promise.resolve(); assert.equal(operations.get('atlas'), desktop.promise);
  desktop.resolve(); await started.promise; const barrier = operations.get('atlas'); assert.ok(barrier); assert.notEqual(barrier, desktop.promise);
  ready(); await barrier; assert.equal(operations.has('atlas'), false); assert.equal(finished, false, 'A live shell must not hold the operation slot and block handback.');
  stream.resolve(); await admission;
});
test('queued terminal admission rejects changed ownership and cleanup epochs before starting a shell', async t => {
  const root = mkdtempSync(join(tmpdir(), 'runner-terminal-admission-')), agent = profile(); t.after(() => rmSync(root, {recursive:true,force:true}));
  claimComputerOwnership(root, agent, ownership);
  const desktop = deferred(), operations = new Map([['atlas', desktop.promise]]); let started = false;
  const admission = admitRunnerTerminal('atlas', Date.now() + 20000, operations, () => assertComputerOwnership(root, agent, ownership), async () => { started = true; });
  const rejected = assert.rejects(admission, /control changed/); claimComputerOwnership(root, agent, {...ownership,generation:3,owner:'idle',identity:'released'}); desktop.resolve(); await rejected; assert.equal(started,false);
  const cleanup = deferred(); operations.set('atlas', cleanup.promise); let epoch = 1, blocked = false; const queuedEpoch = epoch;
  const queued = admitRunnerTerminal('atlas', Date.now() + 20000, operations, () => { if (blocked || epoch !== queuedEpoch) throw new Error('Terminal startup cancelled.'); }, async () => { started = true; });
  const cancelled = assert.rejects(queued, /cancelled/); blocked = true; epoch++; blocked = false; cleanup.resolve(); await cancelled; assert.equal(started,false,'Completed cleanup must not admit an invitation from before revocation.');
});
test('terminal admission is bounded while busy and cleans up a failed startup reservation', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000}); const pending = deferred(), operations = new Map([['atlas',pending.promise]]); let started = false;
  const admission = admitRunnerTerminal('atlas',3000,operations,()=>{},async()=>{started=true;}); const rejected = assert.rejects(admission,/still busy/);
  t.mock.timers.tick(2001); await rejected; assert.equal(started,false); pending.resolve();
  operations.clear(); await assert.rejects(admitRunnerTerminal('atlas',10000,operations,()=>{},async()=>{throw new Error('Startup failed.');}),/Startup failed/); assert.equal(operations.size,0);
});
