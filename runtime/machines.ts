import type { DatabaseSync } from 'node:sqlite';
import { createHash, createPublicKey, randomBytes, timingSafeEqual } from 'node:crypto';
import { hostname, platform, arch } from 'node:os';
import { spawnSync } from 'node:child_process';
import type { AgentProfile, MachineInfo, MachineKind, MachinePlatform } from '../lib/agent-profile';
import { MACHINE_PLATFORMS, isPhonePlatform } from '../lib/agent-profile';
import { dockerStatus } from './hermes';

type MachineRow = { id: string; name: string; platform: string; arch: string; status: string; last_seen_at: string | null; local: number; kind: string; reserved_agent_id: string | null; capabilities_json: string; credential_hash: string | null; revoked_at: string | null };
type CommandRow = { id: string; machine_id: string; agent_id: string | null; kind: string; payload_json: string; state: string; created_at: string; leased_at: string | null; finished_at: string | null; result_json: string | null };
const now = () => new Date().toISOString();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const ONLINE_MS = 45_000;
// A phone stops polling whenever the OS backgrounds it, which is constantly. Failing its
// leased work after 45s the way a crashed computer is treated would interrupt healthy runs
// every time the screen locks, so mobile machines get a much longer window before their
// commands are declared uncertain. Computers keep the original 45s.
export const MOBILE_LEASE_GRACE_MS = 600_000;
function graceMs(capabilities: { mobile?: boolean }) {
  if (!capabilities.mobile) return ONLINE_MS;
  const configured = Number(process.env.OPEN_HARNESS_MOBILE_LEASE_GRACE_MS || MOBILE_LEASE_GRACE_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : MOBILE_LEASE_GRACE_MS;
}
function parseCapabilities(value: string): MachineInfo['capabilities'] {
  try { return JSON.parse(value); } catch { return { container: false, direct: false, desktop: false, virtualDesktop: false }; }
}
export const DEVICE_CAPABILITIES = { container: false, direct: false, desktop: false, virtualDesktop: false, mobile: true, detail: 'Companion dashboard only; agents run on a connected computer.' };

export class MachineError extends Error { constructor(message: string, readonly status = 400) { super(message); } }

// Crockford base32 without I, L, O, and U: no character can be confused with another when
// read off a screen and typed on a phone. 12 characters is 60 bits.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function deviceCode(length = 12) {
  const bytes = randomBytes(length);
  let code = '';
  for (let index = 0; index < length; index++) code += CODE_ALPHABET[bytes[index] % CODE_ALPHABET.length];
  return code;
}

function runnerPublicKey(value: unknown) {
  if (value === undefined || value === '') return null;
  try {
    if (typeof value !== 'string' || value.length > 16_000) throw new Error();
    const jwk = JSON.parse(value);
    if (jwk.kty !== 'RSA' || jwk.d || (jwk.alg && jwk.alg !== 'RSA-OAEP-256')) throw new Error();
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    if ((key.asymmetricKeyDetails?.modulusLength || 0) < 2048) throw new Error();
    return value;
  } catch { throw new MachineError('The runner supplied an invalid encryption key.'); }
}

export class Machines {
  constructor(readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS machines (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, arch TEXT NOT NULL,
      status TEXT NOT NULL, last_seen_at TEXT, local INTEGER NOT NULL DEFAULT 0,
      reserved_agent_id TEXT, capabilities_json TEXT NOT NULL, credential_hash TEXT,
      revoked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS machine_pairings (
      id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, platform TEXT NOT NULL,
      expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runner_commands (
      id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, agent_id TEXT, kind TEXT NOT NULL,
      payload_json TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL,
      leased_at TEXT, finished_at TEXT, result_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runner_commands_machine_state ON runner_commands(machine_id,state,created_at);
    CREATE TABLE IF NOT EXISTS runner_event_receipts (
      command_id TEXT NOT NULL, event_id TEXT NOT NULL, received_at TEXT NOT NULL,
      PRIMARY KEY(command_id,event_id)
    );
    CREATE TABLE IF NOT EXISTS agent_transfers (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, source_machine_id TEXT NOT NULL,
      destination_machine_id TEXT NOT NULL, state TEXT NOT NULL, detail TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, pending_profile_json TEXT
    );`);
    try { db.exec('ALTER TABLE agent_transfers ADD COLUMN pending_profile_json TEXT'); } catch {}
    try { db.exec('ALTER TABLE machines ADD COLUMN encryption_public_key TEXT'); } catch {}
    // 'device' machines are companion phones. Existing rows predate phones, so they default
    // to 'runner' and retain computer-runner access.
    try { db.exec("ALTER TABLE machines ADD COLUMN kind TEXT NOT NULL DEFAULT 'runner'"); } catch {}
    try { db.exec("ALTER TABLE machine_pairings ADD COLUMN kind TEXT NOT NULL DEFAULT 'runner'"); } catch {}
    const interrupted = db.prepare("SELECT agent_id,destination_machine_id FROM agent_transfers WHERE state IN ('queued','exporting','importing','verifying')").all() as Array<{ agent_id: string; destination_machine_id: string }>;
    for (const transfer of interrupted) db.prepare('UPDATE machines SET reserved_agent_id=NULL,updated_at=? WHERE id=? AND reserved_agent_id=?').run(now(), transfer.destination_machine_id, transfer.agent_id);
    db.prepare("UPDATE agent_transfers SET state='failed',detail='The coordinator restarted during transfer. The source assignment and data were preserved.',updated_at=? WHERE state IN ('queued','exporting','importing','verifying')").run(now());
    const stamp = now();
    const mock = process.env.OPEN_HARNESS_MOCK === '1', container = mock || dockerStatus().available;
    const direct = mock || ([process.env.HERMES_PYTHON, process.platform === 'win32' ? 'python' : 'python3', 'python'].filter(Boolean) as string[]).some(executable => spawnSync(executable, ['-c', 'import hermes_cli, open_harness_policy'], { stdio: 'ignore', timeout: 8_000 }).status === 0);
    const capabilities = { container, direct, desktop: mock || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.platform === 'darwin' || process.platform === 'win32'), virtualDesktop: process.platform === 'linux' && container, detail: container || direct ? 'Managed by this Open Harness installation.' : 'Finish computer setup from Workspace settings.' };
    db.prepare(`INSERT INTO machines(id,name,platform,arch,status,last_seen_at,local,reserved_agent_id,capabilities_json,credential_hash,revoked_at,created_at,updated_at)
      VALUES('local',?,?,?,?,?,1,NULL,?,NULL,NULL,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,platform=excluded.platform,arch=excluded.arch,status='online',last_seen_at=excluded.last_seen_at,capabilities_json=excluded.capabilities_json,updated_at=excluded.updated_at`)
      .run(hostname() || 'This computer', platform(), arch(), 'online', stamp, JSON.stringify(capabilities), stamp, stamp);
  }

  private row(id: string) { return this.db.prepare('SELECT * FROM machines WHERE id=?').get(id) as MachineRow | undefined; }
  exists(id: string) { const row = this.row(id); return Boolean(row && !row.revoked_at); }
  private assigned(machineId: string) {
    let count = 0;
    for (const row of this.db.prepare('SELECT json FROM agent_profiles').all() as Array<{ json: string }>) {
      try { if ((JSON.parse(row.json) as AgentProfile).computer?.machineId === machineId) count++; } catch {}
    }
    return count;
  }
  private info(row: MachineRow): MachineInfo {
    const capabilities = parseCapabilities(row.capabilities_json);
    const age = row.last_seen_at ? Date.now() - Date.parse(row.last_seen_at) : Number.POSITIVE_INFINITY;
    const fresh = Boolean(row.local) || age < ONLINE_MS;
    const status: MachineInfo['status'] = row.revoked_at ? 'revoked'
      : fresh ? 'online'
      : age < graceMs(capabilities) ? 'suspended'
      : row.status === 'pairing' ? 'pairing' : 'offline';
    return { id: row.id, name: row.name, platform: MACHINE_PLATFORMS.includes(row.platform as MachinePlatform) ? row.platform as MachinePlatform : 'unknown', arch: row.arch, status, lastSeenAt: row.last_seen_at, local: Boolean(row.local), kind: row.kind === 'device' ? 'device' : 'runner', reservedAgentId: row.reserved_agent_id, assignedAgents: this.assigned(row.id), capabilities };
  }
  get(id: string) { const row = this.row(id); if (!row) throw new MachineError('Computer not found.', 404); return this.info(row); }
  list() { return (this.db.prepare('SELECT * FROM machines WHERE revoked_at IS NULL ORDER BY local DESC,name').all() as MachineRow[]).map(row => this.info(row)); }

  createPairing(input: { name?: string; platform?: string; kind?: string }, coordinatorUrl: string) {
    const requested = String(input.platform || '');
    const phone = isPhonePlatform(requested);
    const kind: MachineKind = input.kind === 'device' || phone ? 'device' : 'runner';
    const target = MACHINE_PLATFORMS.includes(requested as MachinePlatform) ? requested : 'linux';
    if (kind === 'device' && !phone) throw new MachineError('Choose iPhone or Android to pair a phone.', 400);
    // A phone code is typed by hand on a touch keyboard, so it trades length for legibility:
    // 60 bits of Crockford base32 with the letters that look like digits removed. The ten
    // minute expiry, single use, and the pairing rate limit are what keep it safe.
    const code = kind === 'device' ? deviceCode() : Buffer.from(randomBytes(18)).toString('base64url');
    const id = crypto.randomUUID(), created = now(), expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const fallbackName = kind === 'device' ? 'New phone' : 'New computer';
    this.db.prepare('INSERT INTO machine_pairings(id,code_hash,name,platform,expires_at,used_at,created_at,kind) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, hash(code), String(input.name || fallbackName).trim().slice(0, 80) || fallbackName, target, expiresAt, null, created, kind);
    if (kind === 'device') {
      const enrollment = new URL('openharness://pair');
      enrollment.searchParams.set('hub', coordinatorUrl);
      enrollment.searchParams.set('code', code);
      return { id, code, expiresAt, platform: target, kind, hubUrl: coordinatorUrl, pairingUri: enrollment.toString() };
    }
    const sh = (value: string) => `'${value.replaceAll("'", "'\\''")}'`, ps = (value: string) => value.replaceAll("'", "''");
    const commands = {
      linux: `curl -fsSL ${sh(`${coordinatorUrl}/v1/install/runner.sh`)} | sh -s -- --coordinator ${sh(coordinatorUrl)} --pairing-code ${sh(code)}`,
      darwin: `curl -fsSL ${sh(`${coordinatorUrl}/v1/install/runner.sh`)} | sh -s -- --coordinator ${sh(coordinatorUrl)} --pairing-code ${sh(code)}`,
      win32: `$env:OPEN_HARNESS_COORDINATOR='${ps(coordinatorUrl)}'; $env:OPEN_HARNESS_PAIRING_CODE='${ps(code)}'; irm '${ps(`${coordinatorUrl}/v1/install/runner.ps1`)}' | iex`,
    };
    return { id, code, expiresAt, platform: target, kind, command: commands[target as keyof typeof commands] };
  }
  pair(input: Record<string, unknown>) {
    const code = String(input.code || '');
    const pairing = this.db.prepare('SELECT * FROM machine_pairings WHERE code_hash=?').get(hash(code)) as { id: string; name: string; platform: string; expires_at: string; used_at: string | null; kind: string } | undefined;
    if (!pairing || pairing.used_at || Date.parse(pairing.expires_at) <= Date.now()) throw new MachineError('This pairing code is invalid, expired, or already used.', 410);
    // The kind comes from the pairing the operator created, never from the body. A computer
    // runner that guessed a device code still could not award itself dashboard access.
    const kind: MachineKind = pairing.kind === 'device' ? 'device' : 'runner';
    const id = `machine-${crypto.randomUUID()}`, token = Buffer.from(randomBytes(32)).toString('base64url'), stamp = now();
    const supplied = input.capabilities && typeof input.capabilities === 'object' ? input.capabilities as Record<string, unknown> : null;
    const capabilities = kind === 'device'
      ? { ...DEVICE_CAPABILITIES, ...(supplied || {}), mobile: true, container: false, direct: false }
      : supplied || { container: true, direct: true, desktop: false, virtualDesktop: pairing.platform === 'linux' };
    const platform = String(input.platform || pairing.platform);
    const encryptionPublicKey = runnerPublicKey(input.encryptionPublicKey);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE machine_pairings SET used_at=? WHERE id=? AND used_at IS NULL').run(stamp, pairing.id);
      this.db.prepare(`INSERT INTO machines(id,name,platform,arch,status,last_seen_at,local,reserved_agent_id,capabilities_json,credential_hash,revoked_at,created_at,updated_at,kind)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, String(input.name || pairing.name).slice(0, 80), platform, String(input.arch || 'unknown').slice(0, 40), 'online', stamp, 0, null, JSON.stringify(capabilities), hash(token), null, stamp, stamp, kind);
      if (encryptionPublicKey) this.db.prepare('UPDATE machines SET encryption_public_key=? WHERE id=?').run(encryptionPublicKey, id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { machine: this.get(id), machineId: id, token };
  }
  authenticate(machineId: string, token: string, kind?: MachineKind) {
    const row = this.row(machineId);
    if (!row?.credential_hash || row.revoked_at) return false;
    if (kind && (row.kind === 'device' ? 'device' : 'runner') !== kind) return false;
    return safeEqual(row.credential_hash, hash(token));
  }
  heartbeat(machineId: string, input: Record<string, unknown>) {
    if (!this.exists(machineId)) throw new MachineError('Computer not found or revoked.', 404);
    const stamp = now(), encryptionPublicKey = runnerPublicKey(input.encryptionPublicKey);
    if (encryptionPublicKey) this.db.prepare('UPDATE machines SET encryption_public_key=? WHERE id=?').run(encryptionPublicKey, machineId);
    this.db.prepare('UPDATE machines SET status=?,last_seen_at=?,capabilities_json=COALESCE(?,capabilities_json),updated_at=? WHERE id=?').run('online', stamp, input.capabilities ? JSON.stringify(input.capabilities) : null, stamp, machineId);
    return this.get(machineId);
  }
  private failLeasedCommand(row: CommandRow, error: string) {
    const stamp = now();
    this.db.prepare("UPDATE runner_commands SET state='failed',finished_at=?,result_json=? WHERE id=? AND state='leased'").run(stamp, JSON.stringify({ error, interrupted: true }), row.id);
    if (row.kind === 'export-agent' || row.kind === 'import-agent') {
      const transferId = String((JSON.parse(row.payload_json) as { transferId?: string }).transferId || '');
      const transfer = transferId ? this.db.prepare("SELECT id,destination_machine_id,agent_id FROM agent_transfers WHERE id=? AND state IN ('exporting','importing','verifying')").get(transferId) as { id: string; destination_machine_id: string; agent_id: string } | undefined : undefined;
      if (transfer) {
        this.db.prepare("UPDATE agent_transfers SET state='failed',detail=?,updated_at=? WHERE id=?").run(`${error} Source assignment and data were preserved.`, stamp, transfer.id);
        this.db.prepare('UPDATE machines SET reserved_agent_id=NULL,updated_at=? WHERE id=? AND reserved_agent_id=?').run(stamp, transfer.destination_machine_id, transfer.agent_id);
      }
    }
  }
  reconcileLeases(machineId: string, activeCommandIds: string[]) {
    const row = this.row(machineId);
    const active = new Set(activeCommandIds);
    const cutoff = new Date(Date.now() - graceMs(row ? parseCapabilities(row.capabilities_json) : {})).toISOString();
    const rows = this.db.prepare("SELECT * FROM runner_commands WHERE machine_id=? AND state='leased' AND leased_at<?").all(machineId, cutoff) as CommandRow[];
    const uncertain = rows.filter(item => !active.has(item.id));
    for (const item of uncertain) this.failLeasedCommand(item, 'The runner restarted after accepting this command. It was not replayed because its outcome is uncertain.');
    return uncertain.map(item => ({ ...item, payload: JSON.parse(item.payload_json) }));
  }
  // reconcileLeases only runs when a runner heartbeats, which a phone that never comes back
  // never does. Without this sweep its work would sit leased forever and the conversation
  // would show a run that is permanently in progress. Deliberately mobile-only: an offline
  // computer is documented to finish work it already admitted and buffer the results.
  sweepStaleLeases() {
    const stale: Array<CommandRow & { payload: unknown }> = [];
    for (const row of this.db.prepare('SELECT * FROM machines WHERE local=0 AND revoked_at IS NULL').all() as MachineRow[]) {
      const capabilities = parseCapabilities(row.capabilities_json);
      if (!capabilities.mobile) continue;
      const grace = graceMs(capabilities);
      if (row.last_seen_at && Date.now() - Date.parse(row.last_seen_at) < grace) continue;
      const cutoff = new Date(Date.now() - grace).toISOString();
      for (const command of this.db.prepare("SELECT * FROM runner_commands WHERE machine_id=? AND state='leased' AND leased_at<?").all(row.id, cutoff) as CommandRow[]) {
        this.failLeasedCommand(command, 'The phone stopped responding before this work finished. It was not replayed because its outcome is uncertain.');
        stale.push({ ...command, payload: JSON.parse(command.payload_json) });
      }
    }
    return stale;
  }
  reserve(machineId: string, agentId: string, reserve: boolean) {
    const row = this.row(machineId); if (!row || (reserve && row.revoked_at)) throw new MachineError('Computer not found.', 404);
    if (reserve && row.reserved_agent_id && row.reserved_agent_id !== agentId) throw new MachineError('This computer is reserved for another agent.', 409);
    this.db.prepare('UPDATE machines SET reserved_agent_id=?,updated_at=? WHERE id=?').run(reserve ? agentId : row.reserved_agent_id === agentId ? null : row.reserved_agent_id, now(), machineId);
  }
  canAssign(machineId: string, agentId: string) { const machine = this.get(machineId); if (machine.status === 'revoked') throw new MachineError('This computer has been revoked.', 409); if (machine.capabilities.mobile) throw new MachineError('Phones are companion dashboards in this release and cannot run agents. Choose a connected computer.', 409); if (machine.reservedAgentId && machine.reservedAgentId !== agentId) throw new MachineError('This computer is reserved for another agent.', 409); return machine; }
  revoke(machineId: string) { if (machineId === 'local') throw new MachineError('The computer hosting this coordinator cannot be revoked.', 409); const stamp = now(); this.db.prepare("UPDATE machines SET status='revoked',revoked_at=?,credential_hash=NULL,updated_at=? WHERE id=?").run(stamp, stamp, machineId); return { ok: true }; }
  reconnect(machineId: string) {
    const machine = this.get(machineId);
    if (machine.status === 'online') return { ok: true, message: `${machine.name} is connected.` };
    if (machine.status === 'suspended') return { ok: true, message: `${machine.name} is asleep. Work you start now runs when it wakes up.` };
    return { ok: false, message: machine.kind === 'device' ? `Waiting for ${machine.name} to reconnect. Open Open Harness on that phone.` : `Waiting for ${machine.name} to reconnect. The runner only needs outbound HTTPS access.` };
  }
  test(machineId: string, profile?: AgentProfile) {
    const machine = this.get(machineId), issues: string[] = [];
    const phone = Boolean(machine.capabilities.mobile);
    if (machine.status !== 'online' && machine.status !== 'suspended') issues.push(phone ? 'Phone is not connected.' : 'Runner is offline.');
    if (phone || profile?.computer.access === 'mobile') issues.push('Phones are companion dashboards in this release and cannot run agents. Choose a connected computer.');
    if (phone && profile && profile.computer.desktop !== 'none') issues.push('Phones cannot control a desktop. Set Desktop access to No desktop.');
    if (phone && profile && profile.computer.folders.length) issues.push('Phones do not mount host folders. Remove the selected folders.');
    if (profile?.computer.access === 'private' && !machine.capabilities.container) issues.push('Container execution is unavailable.');
    if (profile?.computer.access === 'direct' && !machine.capabilities.direct) issues.push(`Direct execution is unavailable. ${machine.capabilities.detail || 'Install Hermes and the Open Harness policy extension on the runner.'}`);
    if (profile?.computer.desktop === 'existing' && !machine.capabilities.desktop) issues.push(machine.platform === 'darwin' ? 'Grant Accessibility and Screen Recording to the runner.' : machine.platform === 'win32' ? 'Sign in to an interactive Windows session and start the runner there.' : 'Start a graphical session with DISPLAY or Wayland and enable AT-SPI.');
    if (profile?.computer.desktop === 'virtual' && !machine.capabilities.virtualDesktop) issues.push('Private virtual desktops are available on Linux runners only.');
    const ready = machine.status === 'suspended' ? `${machine.name} is asleep but ready. Work you start now runs when it wakes up.` : `${machine.name} is ready for this agent.`;
    return { ok: !issues.length, message: issues.length ? issues.join(' ') : ready, machine };
  }
  enqueue(machineId: string, agentId: string | null, kind: string, payload: unknown) { const command = { id: crypto.randomUUID(), machineId, agentId, kind, state: 'queued', createdAt: now() }; this.db.prepare('INSERT INTO runner_commands VALUES(?,?,?,?,?,?,?,?,?,?)').run(command.id, machineId, agentId, kind, JSON.stringify(payload), command.state, command.createdAt, null, null, null); return command; }
  command(id: string) { const row = this.db.prepare('SELECT * FROM runner_commands WHERE id=?').get(id) as CommandRow | undefined; if (!row) return null; let runId = ''; try { runId = String((JSON.parse(row.payload_json) as { runId?: unknown })?.runId || ''); } catch { runId = ''; } return { id: row.id, machineId: row.machine_id, agentId: row.agent_id, kind: row.kind, state: row.state, runId, result: row.result_json ? JSON.parse(row.result_json) : null }; }
  // Ownership of the command is not enough: without pinning the run as well, any paired
  // runner could post approval or clarification events against an unrelated agent's run
  // and park it in waiting_approval indefinitely. A command carries exactly one run.
  receiveEvent(machineId: string, commandId: string, eventId: string, runId: string) { const command = this.command(commandId); if (!command || command.machineId !== machineId) throw new MachineError('Runner command not found.', 404); if (command.runId !== runId) throw new MachineError('This event does not belong to the run its command was issued for.', 403); const changed = this.db.prepare('INSERT OR IGNORE INTO runner_event_receipts VALUES(?,?,?)').run(commandId, eventId, now()); return Boolean(changed.changes); }
  poll(machineId: string) { const rows = this.db.prepare("SELECT * FROM runner_commands WHERE machine_id=? AND state='queued' ORDER BY created_at LIMIT 10").all(machineId) as CommandRow[]; const leased = now(); for (const row of rows) this.db.prepare("UPDATE runner_commands SET state='leased',leased_at=? WHERE id=? AND state='queued'").run(leased, row.id); return rows.map(row => ({ id: row.id, agentId: row.agent_id, kind: row.kind, payload: JSON.parse(row.payload_json), createdAt: row.created_at })); }
  finish(machineId: string, commandId: string, result: unknown, failed = false) { const existing = this.command(commandId); if (!existing || existing.machineId !== machineId) throw new MachineError('Runner command not found.', 404); if (['completed','failed'].includes(existing.state)) return { ok: true, duplicate: true }; this.db.prepare("UPDATE runner_commands SET state=?,finished_at=?,result_json=? WHERE id=? AND machine_id=? AND state IN ('queued','leased')").run(failed ? 'failed' : 'completed', now(), JSON.stringify(result), commandId, machineId); return { ok: true }; }
  transfer(agentId: string, source: string, destination: string, pendingProfile?: AgentProfile) { if (this.transferring(agentId)) throw new MachineError('This agent is already transferring. Wait for it to finish before changing computers again.', 409); if (source === destination) throw new MachineError('This agent is already on that computer.', 409); this.canAssign(destination, agentId); const id = crypto.randomUUID(), stamp = now(); this.db.prepare('INSERT INTO agent_transfers(id,agent_id,source_machine_id,destination_machine_id,state,detail,created_at,updated_at,pending_profile_json) VALUES(?,?,?,?,?,?,?,?,?)').run(id, agentId, source, destination, 'queued', 'Waiting for active work to finish.', stamp, stamp, pendingProfile ? JSON.stringify(pendingProfile) : null); return { id, agentId, sourceMachineId: source, destinationMachineId: destination, state: 'queued', detail: 'Waiting for active work to finish.', pendingProfile }; }
  transferring(agentId: string) { return Boolean(this.db.prepare("SELECT 1 FROM agent_transfers WHERE agent_id=? AND state IN ('queued','exporting','importing','verifying') LIMIT 1").get(agentId)); }
  transferStatus(agentId: string) { const row = this.db.prepare('SELECT state,detail FROM agent_transfers WHERE agent_id=? ORDER BY created_at DESC LIMIT 1').get(agentId) as { state: string; detail: string } | undefined; return row || null; }
  setTransfer(id: string, state: string, detail: string) { this.db.prepare('UPDATE agent_transfers SET state=?,detail=?,updated_at=? WHERE id=?').run(state, detail, now(), id); }
}
