import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Machines, MachineError } from '../runtime/machines';

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
