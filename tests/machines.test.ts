import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Machines, MachineError } from '../runtime/machines';

// The Machines constructor probes dockerStatus() for the 'local' machine's capabilities
// (machines.ts:48-50); on a host with a wedged Docker daemon that costs 5s per instance and
// none of these tests assert on local capabilities, so mock it out.
process.env.OPEN_HARNESS_MOCK ??= '1';

function database() { const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE agent_profiles(id TEXT PRIMARY KEY,json TEXT NOT NULL)'); return db; }

test('pairing codes expire and remain single use', () => {
  const db = database(), machines = new Machines(db), pairing = machines.createPairing({ name: 'VPS', platform: 'linux' }, 'https://coordinator.example');
  db.prepare('UPDATE machine_pairings SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1_000).toISOString(), pairing.id);
  assert.throws(() => machines.pair({ code: pairing.code }), (error: unknown) => error instanceof MachineError && error.status === 410);
  const fresh = machines.createPairing({ name: 'VPS', platform: 'linux' }, 'https://coordinator.example'), paired = machines.pair({ code: fresh.code });
  assert.ok(paired.machineId); assert.throws(() => machines.pair({ code: fresh.code }), (error: unknown) => error instanceof MachineError && error.status === 410);
});

test('restart fails interrupted transfers, preserves source, and releases destination reservation', () => {
  const db = database(), machines = new Machines(db), pairing = machines.createPairing({ name: 'Destination', platform: 'linux' }, 'https://coordinator.example'), paired = machines.pair({ code: pairing.code });
  machines.reserve(paired.machineId, 'atlas', true); machines.transfer('atlas', 'local', paired.machineId);
  const restarted = new Machines(db), transfer = db.prepare('SELECT state,detail FROM agent_transfers WHERE agent_id=?').get('atlas') as { state: string; detail: string };
  assert.equal(transfer.state, 'failed'); assert.match(transfer.detail, /source assignment and data were preserved/i); assert.equal(restarted.get(paired.machineId).reservedAgentId, null);
});

test('runner events are pinned to the run their command was issued for', () => {
  const db = database(), machines = new Machines(db);
  const command = machines.enqueue('local', 'atlas', 'run', { runId: 'run-a' });
  const receipts = () => (db.prepare('SELECT COUNT(*) AS count FROM runner_event_receipts WHERE command_id=?').get(command.id) as { count: number }).count;
  assert.throws(() => machines.receiveEvent('local', command.id, 'evt-1', 'run-b'), (error: unknown) => error instanceof MachineError && error.status === 403);
  // '' is what service.ts sends when the runner's event omits a runId entirely.
  assert.throws(() => machines.receiveEvent('local', command.id, 'evt-2', ''), (error: unknown) => error instanceof MachineError && error.status === 403);
  assert.equal(receipts(), 0, 'a rejected event must not leave a receipt behind');
  assert.equal(machines.receiveEvent('local', command.id, 'evt-1', 'run-a'), true);
  assert.equal(machines.receiveEvent('local', command.id, 'evt-1', 'run-a'), false, 'the same eventId is deduplicated');
  assert.equal(receipts(), 1);
  assert.throws(() => machines.receiveEvent('machine-other', command.id, 'evt-3', 'run-a'), (error: unknown) => error instanceof MachineError && error.status === 404);
});

test('phone pairings mint a device machine with a typable code and a deep link', () => {
  const db = database(), machines = new Machines(db);
  const pairing = machines.createPairing({ name: 'Pixel', platform: 'android' }, 'https://agents.example.com');
  assert.equal(pairing.kind, 'device');
  assert.equal(pairing.platform, 'android');
  // Typed by hand on a touch keyboard: short, and free of characters that read alike.
  assert.match(pairing.code, /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/);
  assert.equal(pairing.pairingUri, `openharness://pair?hub=${encodeURIComponent('https://agents.example.com')}&code=${pairing.code}`);
  assert.equal((pairing as { command?: string }).command, undefined);
  const paired = machines.pair({ code: pairing.code, name: 'Pixel', platform: 'android', arch: 'arm64' });
  assert.equal(paired.machine.kind, 'device');
  assert.equal(paired.machine.platform, 'android');
  assert.equal(paired.machine.capabilities.mobile, true);
  assert.equal(paired.machine.capabilities.container, false);
});

test('a runner cannot promote itself to a device by claiming one while pairing', () => {
  const db = database(), machines = new Machines(db);
  const pairing = machines.createPairing({ name: 'VPS', platform: 'linux' }, 'https://agents.example.com');
  assert.equal(pairing.kind, 'runner');
  // The body asks for a phone. The kind comes from the pairing the operator created, so it
  // stays a runner: this is what stops a paired computer from reaching the dashboard routes.
  const paired = machines.pair({ code: pairing.code, platform: 'ios', capabilities: { mobile: true } });
  assert.equal(paired.machine.kind, 'runner');
  assert.equal(machines.authenticate(paired.machineId, paired.token, 'device'), false);
  assert.equal(machines.authenticate(paired.machineId, paired.token, 'runner'), true);
});

test('a device credential is scoped to its own machine and dies with revocation', () => {
  const db = database(), machines = new Machines(db);
  const phone = machines.pair({ code: machines.createPairing({ platform: 'ios' }, 'https://agents.example.com').code });
  assert.equal(machines.authenticate(phone.machineId, phone.token, 'device'), true);
  assert.equal(machines.authenticate(phone.machineId, 'not-the-token', 'device'), false);
  machines.revoke(phone.machineId);
  assert.equal(machines.authenticate(phone.machineId, phone.token, 'device'), false);
});

test('a backgrounded phone reads as suspended, then offline, while a computer goes straight offline', () => {
  const db = database(), machines = new Machines(db);
  const phone = machines.pair({ code: machines.createPairing({ platform: 'ios' }, 'https://agents.example.com').code });
  const computer = machines.pair({ code: machines.createPairing({ platform: 'linux' }, 'https://agents.example.com').code });
  const seen = (id: string, agoMs: number) => db.prepare('UPDATE machines SET last_seen_at=? WHERE id=?').run(new Date(Date.now() - agoMs).toISOString(), id);

  seen(phone.machineId, 2 * 60_000); seen(computer.machineId, 2 * 60_000);
  assert.equal(machines.get(phone.machineId).status, 'suspended');
  assert.equal(machines.get(computer.machineId).status, 'offline');

  seen(phone.machineId, 11 * 60_000);
  assert.equal(machines.get(phone.machineId).status, 'offline');
});

test('lease reconciliation gives a phone its grace window and a computer none', () => {
  const db = database(), machines = new Machines(db);
  const phone = machines.pair({ code: machines.createPairing({ platform: 'android' }, 'https://agents.example.com').code });
  const computer = machines.pair({ code: machines.createPairing({ platform: 'linux' }, 'https://agents.example.com').code });
  const lease = (machineId: string, agoMs: number) => {
    const command = machines.enqueue(machineId, 'atlas', 'run', { runId: `run-${machineId}` });
    machines.poll(machineId);
    db.prepare('UPDATE runner_commands SET leased_at=? WHERE id=?').run(new Date(Date.now() - agoMs).toISOString(), command.id);
    return command;
  };
  const phoneCommand = lease(phone.machineId, 5 * 60_000), computerCommand = lease(computer.machineId, 5 * 60_000);

  assert.equal(machines.reconcileLeases(phone.machineId, []).length, 0, 'a five minute old phone lease is still within grace');
  assert.equal(machines.command(phoneCommand.id)?.state, 'leased');
  assert.equal(machines.reconcileLeases(computer.machineId, []).length, 1, 'a five minute old computer lease is uncertain');
  assert.equal(machines.command(computerCommand.id)?.state, 'failed');
});

test('the sweep retires work on a phone that never came back, and leaves computers alone', () => {
  const db = database(), machines = new Machines(db);
  const phone = machines.pair({ code: machines.createPairing({ platform: 'ios' }, 'https://agents.example.com').code });
  const computer = machines.pair({ code: machines.createPairing({ platform: 'linux' }, 'https://agents.example.com').code });
  const stale = (machineId: string) => {
    const command = machines.enqueue(machineId, 'atlas', 'run', { runId: `run-${machineId}` });
    machines.poll(machineId);
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    db.prepare('UPDATE runner_commands SET leased_at=? WHERE id=?').run(old, command.id);
    db.prepare('UPDATE machines SET last_seen_at=? WHERE id=?').run(old, machineId);
    return command;
  };
  const phoneCommand = stale(phone.machineId), computerCommand = stale(computer.machineId);

  const swept = machines.sweepStaleLeases();
  assert.equal(swept.length, 1);
  assert.equal(swept[0].id, phoneCommand.id);
  assert.equal(machines.command(phoneCommand.id)?.state, 'failed');
  // An offline computer is documented to finish work it already admitted and buffer the
  // results, so the sweep must not touch it. Only its own heartbeat may retire that lease.
  assert.equal(machines.command(computerCommand.id)?.state, 'leased');
});

test('phone readiness identifies companion-only devices instead of failing silently', () => {
  const db = database(), machines = new Machines(db);
  const phone = machines.pair({ code: machines.createPairing({ name: 'Pixel', platform: 'android' }, 'https://agents.example.com').code });
  const profile = (overrides: Record<string, unknown>) => ({
    computer: { machineId: phone.machineId, access: 'mobile', folders: [], desktop: 'none', reserveMachine: false, resources: { cpu: 1, memoryMb: 512, concurrency: 1 }, ...overrides },
  } as never);

  assert.equal(machines.test(phone.machineId, profile({})).ok, false);
  assert.match(machines.test(phone.machineId, profile({ access: 'private' })).message, /companion dashboards/);
  assert.match(machines.test(phone.machineId, profile({ desktop: 'existing' })).message, /cannot control a desktop/);
  assert.match(machines.test(phone.machineId, profile({ folders: [{ id: 'f', path: '/tmp', mode: 'read' }] })).message, /do not mount host folders/);

  const computer = machines.pair({ code: machines.createPairing({ platform: 'linux' }, 'https://agents.example.com').code });
  const onComputer = { computer: { machineId: computer.machineId, access: 'mobile', folders: [], desktop: 'none', reserveMachine: false, resources: { cpu: 1, memoryMb: 512, concurrency: 1 } } } as never;
  assert.match(machines.test(computer.machineId, onComputer).message, /companion dashboards/);
  assert.throws(() => machines.canAssign(phone.machineId, 'atlas'), /companion dashboards/);
});
