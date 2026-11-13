import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync } from 'node:crypto';
import { Machines, MachineError } from '../runtime/machines';
import { generateRunnerKeyPair } from '../lib/runner-crypto';
import { draftProfile } from '../lib/agent-profile';

// The Machines constructor probes dockerStatus() for the 'local' machine's capabilities
// (machines.ts:48-50); on a host with a wedged Docker daemon that costs 5s per instance and
// none of these tests assert on local capabilities, so mock it out.
process.env.OPEN_HARNESS_MOCK ??= '1';

function database() { const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE agent_profiles(id TEXT PRIMARY KEY,json TEXT NOT NULL)'); return db; }

test('computer readiness requires Docker for both sandboxed access modes', () => {
  const db = database(), machines = new Machines(db);
  try {
    const paired = machines.pair({ code: machines.createPairing({ name: 'Host only', platform: 'linux' }, 'https://coordinator.example').code, capabilities: { container: false, direct: true, desktop: false, virtualDesktop: false } });
    const profile = draftProfile({ id: 'atlas', name: 'Atlas', role: 'Assistant', description: '', tone: 0, instructions: '', memory: [] });
    for (const access of ['private', 'folders', 'direct'] as const) {
      const result = machines.test(paired.machineId, { ...profile, computer: { ...profile.computer, access } });
      assert.equal(result.ok, false);
      if (access === 'direct') assert.match(result.message, /not sandboxed and is disabled/);
      if (access !== 'direct') assert.match(result.message, /Container execution is unavailable/);
    }
  } finally { db.close(); }
});

test('pairing codes expire and remain single use', () => {
  const db = database(), machines = new Machines(db), pairing = machines.createPairing({ name: 'VPS', platform: 'linux' }, 'https://coordinator.example');
  db.prepare('UPDATE machine_pairings SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1_000).toISOString(), pairing.id);
  assert.throws(() => machines.pair({ code: pairing.code }), (error: unknown) => error instanceof MachineError && error.status === 410);
  const fresh = machines.createPairing({ name: 'VPS', platform: 'linux' }, 'https://coordinator.example'), paired = machines.pair({ code: fresh.code });
  assert.equal(machines.get(paired.machineId).capabilities.direct, false);
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

test('a runner encryption key is stored at pairing, backfilled by heartbeat, and validated', async () => {
  const db = database(), machines = new Machines(db);
  const { publicKey } = await generateRunnerKeyPair();

  // Machines paired before credentials were encrypted have no key on record. Dispatch has to
  // be able to tell that apart from having one, which is what encryptionKey() reports.
  const keyless = machines.pair({ code: machines.createPairing({ name: 'Old VPS', platform: 'linux' }, 'https://coordinator.example').code });
  assert.equal(machines.encryptionKey(keyless.machineId), '');

  // The runner publishes its key on every heartbeat, so an existing machine recovers without
  // being paired again.
  machines.heartbeat(keyless.machineId, { encryptionPublicKey: publicKey });
  assert.equal(machines.encryptionKey(keyless.machineId), publicKey);

  // A later heartbeat without one must not wipe it, and nothing that is not an RSA JWK is kept.
  machines.heartbeat(keyless.machineId, {});
  assert.equal(machines.encryptionKey(keyless.machineId), publicKey);
  assert.throws(() => machines.pair({ code: machines.createPairing({ name: 'Bad VPS', platform: 'linux' }, 'https://coordinator.example').code, encryptionPublicKey: 'not-a-jwk' }), /invalid encryption key/);

  const fresh = machines.pair({ code: machines.createPairing({ name: 'New VPS', platform: 'linux' }, 'https://coordinator.example').code, encryptionPublicKey: publicKey });
  assert.equal(machines.encryptionKey(fresh.machineId), publicKey);
});

test('invalid runner encryption keys neither consume pairing codes nor mutate heartbeats', async () => {
  const db = database(), machines = new Machines(db), key = await generateRunnerKeyPair(), jwk = JSON.parse(key.publicKey);
  try {
    const pairing = machines.createPairing({ name: 'VPS', platform: 'linux' }, 'https://coordinator.example');
    const weak = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'jwk' });
    const invalid = [null, {}, 'not-json', 'null', '[]', JSON.stringify({ kty: 'RSA' }), JSON.stringify(weak), key.privateKey, JSON.stringify({ ...jwk, d: '' }), JSON.stringify({ ...jwk, alg: 'RSA-OAEP' }), JSON.stringify({ ...jwk, use: 'sig' }), JSON.stringify({ ...jwk, key_ops: ['decrypt'] }), `${key.publicKey}${' '.repeat(16_000)}`];
    const rejected = (error: unknown) => error instanceof MachineError && error.status === 400 && /invalid encryption key/.test(error.message);
    for (const encryptionPublicKey of invalid) {
      assert.throws(() => machines.pair({ code: pairing.code, encryptionPublicKey }), rejected);
      assert.equal(db.prepare('SELECT used_at FROM machine_pairings WHERE id=?').get(pairing.id)?.used_at, null);
      assert.equal(db.prepare('SELECT COUNT(*) AS total FROM machines WHERE local=0').get()?.total, 0);
    }
    const paired = machines.pair({ code: pairing.code, encryptionPublicKey: key.publicKey });
    const before = db.prepare('SELECT * FROM machines WHERE id=?').get(paired.machineId);
    for (const encryptionPublicKey of invalid) {
      assert.throws(() => machines.heartbeat(paired.machineId, { encryptionPublicKey, capabilities: { container: false, detail: 'must not persist' } }), rejected);
      assert.deepEqual(db.prepare('SELECT * FROM machines WHERE id=?').get(paired.machineId), before);
    }
    machines.heartbeat(paired.machineId, { encryptionPublicKey: '' });
    assert.equal(machines.encryptionKey(paired.machineId), key.publicKey);
    const rotated = await generateRunnerKeyPair(); machines.heartbeat(paired.machineId, { encryptionPublicKey: rotated.publicKey });
    assert.equal(machines.encryptionKey(paired.machineId), rotated.publicKey);
  } finally { db.close(); }
});

test('revoking a computer invalidates its runner and ends the work queued for it', () => {
  const db = database(), machines = new Machines(db), status = (error: unknown) => error instanceof MachineError ? error.status : 0;
  const paired = machines.pair({ code: machines.createPairing({ name: 'VPS', platform: 'linux' }, 'https://coordinator.example').code });
  assert.equal(machines.authenticate(paired.machineId, paired.token), true);
  assert.throws(() => machines.revoke('machine-missing'), (error: unknown) => status(error) === 404);
  assert.throws(() => machines.revoke('local'), (error: unknown) => status(error) === 409);
  const queued = machines.enqueue(paired.machineId, 'atlas', 'run', { runId: 'run-1' }), leased = machines.enqueue(paired.machineId, 'atlas', 'run', { runId: 'run-2' });
  db.prepare("UPDATE runner_commands SET state='leased',leased_at=? WHERE id=?").run(new Date().toISOString(), leased.id);
  const done = machines.enqueue(paired.machineId, 'atlas', 'probe-tools', {}); db.prepare("UPDATE runner_commands SET state='completed' WHERE id=?").run(done.id);
  const elsewhere = machines.enqueue('local', 'nova', 'run', { runId: 'run-3' });

  assert.deepEqual(machines.revoke(paired.machineId), { ok: true, cancelledCommands: 2 });
  assert.equal(machines.authenticate(paired.machineId, paired.token), false, 'the runner credential stops working at once');
  for (const id of [queued.id, leased.id]) { const command = machines.command(id); assert.equal(command?.state, 'failed'); assert.equal((command?.result as { error: string }).error, 'Computer was revoked.'); }
  assert.equal(machines.command(done.id)?.state, 'completed', 'finished work keeps its outcome');
  assert.equal(machines.command(elsewhere.id)?.state, 'queued', 'other computers are untouched');
  assert.deepEqual(machines.poll(paired.machineId), []);
  assert.ok(!machines.list().some(machine => machine.id === paired.machineId));
  assert.throws(() => machines.revoke(paired.machineId), (error: unknown) => status(error) === 409);
});

test('a computer revoked after assignment checks cannot receive the command', () => {
  const db = database(), machines = new Machines(db), revoked = (error: unknown) => error instanceof MachineError && error.status === 409 && error.message === 'Computer was revoked.';
  const paired = machines.pair({ code: machines.createPairing({ name: 'VPS', platform: 'linux' }, 'https://coordinator.example').code });
  assert.equal(machines.canAssign(paired.machineId, 'atlas').status, 'online');
  machines.revoke(paired.machineId);
  assert.throws(() => machines.enqueue(paired.machineId, 'atlas', 'probe-tools', {}), revoked);
  assert.throws(() => machines.enqueue('machine-missing', 'atlas', 'run', { runId: 'run-1' }), revoked);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM runner_commands').get() as { count: number }).count, 0);
  assert.deepEqual(machines.poll(paired.machineId), []);
});

test('a finished command stops carrying the credentials it was dispatched with', () => {
  const db = database(), machines = new Machines(db);
  const paired = machines.pair({ code: machines.createPairing({ name: 'VPS', platform: 'linux' }, 'https://coordinator.example').code });
  const command = machines.enqueue(paired.machineId, 'atlas', 'run', { runId: 'run-1', encryptedSecrets: { ATLAS_KEY: { version: 1, key: 'k', iv: 'i', data: 'd' } } });
  machines.poll(paired.machineId);
  machines.finish(paired.machineId, command.id, { final_response: 'done' });
  const stored = db.prepare('SELECT payload_json FROM runner_commands WHERE id=?').get(command.id) as { payload_json: string };
  assert.doesNotMatch(stored.payload_json, /encryptedSecrets|ATLAS_KEY/);
  // What a later lookup still needs is kept, so a trailing event can still be matched to its run.
  assert.equal(machines.command(command.id)?.runId, 'run-1');
});

test('sealed imports are leased alone and later imports remain queued until another poll', () => {
  const db = database(), machines = new Machines(db);
  try {
    const commands = [machines.enqueue('local', 'atlas', 'stop', {}), machines.enqueue('local', 'atlas', 'import-agent', { sealedTransfer: { encrypted: 'ciphertext-only' } }), machines.enqueue('local', 'scout', 'import-agent', { sealedTransfer: { encrypted: 'ciphertext-only' } }), machines.enqueue('local', 'scout', 'stop', {})];
    commands.forEach((command, index) => db.prepare('UPDATE runner_commands SET created_at=? WHERE id=?').run(`2026-11-08T00:00:0${index}.000Z`, command.id));
    for (let index = 0; index < commands.length; index++) {
      assert.deepEqual(machines.poll('local').map(command => command.id), [commands[index].id]);
      assert.equal(machines.command(commands[index].id)?.state, 'leased');
      for (const pending of commands.slice(index + 1)) assert.equal(machines.command(pending.id)?.state, 'queued');
    }
    machines.finish('local', commands[1].id, { checksum: 'verified' });
    assert.doesNotMatch(String(db.prepare('SELECT payload_json FROM runner_commands WHERE id=?').get(commands[1].id)?.payload_json), /sealedTransfer|ciphertext-only/);
  } finally { db.close(); }
});

test('old runners cannot advertise native access or receive a persisted unsafe command', () => {
  const db = database(), machines = new Machines(db);
  try {
    const paired = machines.pair({ code: machines.createPairing({ platform: 'linux' }, 'https://example.test').code, capabilities: { container: true, direct: true, desktop: true, virtualDesktop: true } });
    assert.equal(machines.get(paired.machineId).capabilities.direct, false);
    assert.equal(machines.get(paired.machineId).capabilities.desktop, false);
    const profile = draftProfile({ id: 'atlas', name: 'Atlas', role: 'Assistant', description: '', tone: 0, instructions: '', memory: [] });
    const legacy = { ...profile, computer: { ...profile.computer, access: 'direct' as const, desktop: 'existing' as const } };
    for (const kind of ['run', 'probe-tools', 'probe-models', 'probe-runtime', 'import-agent']) {
      const payload = kind === 'run' ? { snapshot: legacy } : { profile: legacy };
      assert.throws(() => machines.enqueue(paired.machineId, 'atlas', kind, payload), /not sandboxed and is disabled/);
      const command = machines.enqueue(paired.machineId, 'atlas', kind, {});
      db.prepare('UPDATE runner_commands SET payload_json=? WHERE id=?').run(JSON.stringify(payload), command.id);
      assert.deepEqual(machines.poll(paired.machineId), []);
      assert.equal(machines.command(command.id)?.state, 'failed');
    }
  } finally { db.close(); }
});

for (const failed of [false, true]) test(`a ${failed ? 'failed' : 'completed'} probe drops its input credentials`, () => {
  const db = database(), machines = new Machines(db);
  const input = { apiKey: 'probe-api-key', env: { SECRET: 'probe-env-secret' }, baseUrl: 'https://provider.example' };
  const command = machines.enqueue('local', 'atlas', 'probe-runtime', { runId: 'run-probe', input });
  const stored = () => (db.prepare('SELECT payload_json FROM runner_commands WHERE id=?').get(command.id) as { payload_json: string }).payload_json;
  assert.deepEqual(JSON.parse(stored()).input, input);
  assert.deepEqual(machines.poll('local')[0].payload.input, input);
  assert.deepEqual(JSON.parse(stored()).input, input, 'leasing must preserve probe credentials');
  const result = failed ? { error: 'Connection failed.' } : { status: 'connected' };
  machines.finish('local', command.id, result, failed);
  assert.doesNotMatch(stored(), /probe-api-key|probe-env-secret/);
  assert.equal(JSON.parse(stored()).input, undefined);
  assert.equal(machines.command(command.id)?.runId, 'run-probe');
  assert.equal(machines.command(command.id)?.state, failed ? 'failed' : 'completed');
  assert.deepEqual(machines.command(command.id)?.result, result);
  assert.equal(machines.receiveEvent('local', command.id, 'trailing-event', 'run-probe'), true);
});

test('startup scrubs historical terminal payloads and preserves pending credentials', () => {
  const db = database(), machines = new Machines(db);
  const payload = { runId: 'run-old', transferId: 'transfer-old', input: { apiKey: 'historical-api-key', env: { SECRET: 'historical-env-secret' }, baseUrl: 'https://provider.example' }, secrets: { KEY: 'old-secret' }, encryptedSecrets: { KEY: 'old-encrypted-secret' }, bundle: 'old-bundle', encrypted: 'old-encrypted' };
  const commands = ['completed', 'failed', 'queued', 'leased'].map(state => {
    const command = machines.enqueue('local', 'atlas', 'probe-runtime', payload);
    db.prepare('UPDATE runner_commands SET state=? WHERE id=?').run(state, command.id);
    return { ...command, state };
  });
  const restarted = new Machines(db);
  for (const command of commands) {
    const stored = (db.prepare('SELECT payload_json FROM runner_commands WHERE id=?').get(command.id) as { payload_json: string }).payload_json;
    if (['completed', 'failed'].includes(command.state)) {
      assert.doesNotMatch(stored, /historical-api-key|historical-env-secret|old-secret|old-encrypted-secret|old-bundle|old-encrypted/);
      assert.deepEqual(JSON.parse(stored), { runId: 'run-old', transferId: 'transfer-old' });
    } else assert.deepEqual(JSON.parse(stored), payload, `${command.state} credentials must survive startup`);
    assert.equal(restarted.command(command.id)?.runId, 'run-old');
    assert.equal(restarted.command(command.id)?.state, command.state);
  }
});
