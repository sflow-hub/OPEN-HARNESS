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
