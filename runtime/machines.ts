import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hostname, platform, arch } from 'node:os';
import { spawnSync } from 'node:child_process';
import type { AgentProfile, MachineInfo } from '../lib/agent-profile';
import { dockerStatus } from './hermes';
import { addColumn } from './db';

type MachineRow = { id: string; name: string; platform: string; arch: string; status: string; last_seen_at: string | null; local: number; reserved_agent_id: string | null; capabilities_json: string; credential_hash: string | null; revoked_at: string | null };
type CommandRow = { id: string; machine_id: string; agent_id: string | null; kind: string; payload_json: string; state: string; created_at: string; leased_at: string | null; finished_at: string | null; result_json: string | null };
const now = () => new Date().toISOString();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class MachineError extends Error { constructor(message: string, readonly status = 400) { super(message); } }

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
    addColumn(db, 'agent_transfers', 'pending_profile_json', 'TEXT');
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
    const fresh = row.local || (row.last_seen_at && Date.now() - Date.parse(row.last_seen_at) < 45_000);
    const status = row.revoked_at ? 'revoked' : fresh ? 'online' : row.status === 'pairing' ? 'pairing' : 'offline';
    return { id: row.id, name: row.name, platform: ['linux','darwin','win32'].includes(row.platform) ? row.platform as MachineInfo['platform'] : 'unknown', arch: row.arch, status, lastSeenAt: row.last_seen_at, local: Boolean(row.local), reservedAgentId: row.reserved_agent_id, assignedAgents: this.assigned(row.id), capabilities: JSON.parse(row.capabilities_json) };
  }
  get(id: string) { const row = this.row(id); if (!row) throw new MachineError('Computer not found.', 404); return this.info(row); }
  list() { return (this.db.prepare('SELECT * FROM machines WHERE revoked_at IS NULL ORDER BY local DESC,name').all() as MachineRow[]).map(row => this.info(row)); }

  createPairing(input: { name?: string; platform?: string }, coordinatorUrl: string) {
    const target = ['linux','darwin','win32'].includes(String(input.platform)) ? String(input.platform) : 'linux';
    const code = Buffer.from(randomBytes(18)).toString('base64url');
    const id = crypto.randomUUID(), created = now(), expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    this.db.prepare('INSERT INTO machine_pairings VALUES(?,?,?,?,?,?,?)').run(id, hash(code), String(input.name || 'New computer').trim().slice(0, 80) || 'New computer', target, expiresAt, null, created);
    const sh = (value: string) => `'${value.replaceAll("'", "'\\''")}'`, ps = (value: string) => value.replaceAll("'", "''");
    const commands = {
      linux: `curl -fsSL ${sh(`${coordinatorUrl}/v1/install/runner.sh`)} | sh -s -- --coordinator ${sh(coordinatorUrl)} --pairing-code ${sh(code)}`,
      darwin: `curl -fsSL ${sh(`${coordinatorUrl}/v1/install/runner.sh`)} | sh -s -- --coordinator ${sh(coordinatorUrl)} --pairing-code ${sh(code)}`,
      win32: `$env:OPEN_HARNESS_COORDINATOR='${ps(coordinatorUrl)}'; $env:OPEN_HARNESS_PAIRING_CODE='${ps(code)}'; irm '${ps(`${coordinatorUrl}/v1/install/runner.ps1`)}' | iex`,
    };
    return { id, code, expiresAt, platform: target, command: commands[target as keyof typeof commands] };
  }
  pair(input: Record<string, unknown>) {
    const code = String(input.code || '');
    const pairing = this.db.prepare('SELECT * FROM machine_pairings WHERE code_hash=?').get(hash(code)) as { id: string; name: string; platform: string; expires_at: string; used_at: string | null } | undefined;
    if (!pairing || pairing.used_at || Date.parse(pairing.expires_at) <= Date.now()) throw new MachineError('This pairing code is invalid, expired, or already used.', 410);
    const id = `machine-${crypto.randomUUID()}`, token = Buffer.from(randomBytes(32)).toString('base64url'), stamp = now();
    const capabilities = input.capabilities && typeof input.capabilities === 'object' ? input.capabilities : { container: true, direct: true, desktop: false, virtualDesktop: pairing.platform === 'linux' };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE machine_pairings SET used_at=? WHERE id=? AND used_at IS NULL').run(stamp, pairing.id);
      this.db.prepare('INSERT INTO machines VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, String(input.name || pairing.name).slice(0, 80), String(input.platform || pairing.platform), String(input.arch || 'unknown').slice(0, 40), 'online', stamp, 0, null, JSON.stringify(capabilities), hash(token), null, stamp, stamp);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { machine: this.get(id), machineId: id, token };
  }
  authenticate(machineId: string, token: string) { const row = this.row(machineId); return Boolean(row?.credential_hash && !row.revoked_at && safeEqual(row.credential_hash, hash(token))); }
  heartbeat(machineId: string, input: Record<string, unknown>) {
    if (!this.exists(machineId)) throw new MachineError('Computer not found or revoked.', 404);
    const stamp = now();
    this.db.prepare('UPDATE machines SET status=?,last_seen_at=?,capabilities_json=COALESCE(?,capabilities_json),updated_at=? WHERE id=?').run('online', stamp, input.capabilities ? JSON.stringify(input.capabilities) : null, stamp, machineId);
    return this.get(machineId);
  }
  reconcileLeases(machineId: string, activeCommandIds: string[]) {
    const active = new Set(activeCommandIds), cutoff = new Date(Date.now() - 45_000).toISOString(), rows = this.db.prepare("SELECT * FROM runner_commands WHERE machine_id=? AND state='leased' AND leased_at<?").all(machineId, cutoff) as CommandRow[], uncertain = rows.filter(row => !active.has(row.id));
    for (const row of uncertain) {
      const stamp = now(), error = 'The runner restarted after accepting this command. It was not replayed because its outcome is uncertain.';
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
    return uncertain.map(row => ({ ...row, payload: JSON.parse(row.payload_json) }));
  }
  reserve(machineId: string, agentId: string, reserve: boolean) {
    const row = this.row(machineId); if (!row || (reserve && row.revoked_at)) throw new MachineError('Computer not found.', 404);
    if (reserve && row.reserved_agent_id && row.reserved_agent_id !== agentId) throw new MachineError('This computer is reserved for another agent.', 409);
    this.db.prepare('UPDATE machines SET reserved_agent_id=?,updated_at=? WHERE id=?').run(reserve ? agentId : row.reserved_agent_id === agentId ? null : row.reserved_agent_id, now(), machineId);
  }
  canAssign(machineId: string, agentId: string) { const machine = this.get(machineId); if (machine.status === 'revoked') throw new MachineError('This computer has been revoked.', 409); if (machine.reservedAgentId && machine.reservedAgentId !== agentId) throw new MachineError('This computer is reserved for another agent.', 409); return machine; }
  revoke(machineId: string) { if (machineId === 'local') throw new MachineError('The computer hosting this coordinator cannot be revoked.', 409); const stamp = now(); this.db.prepare("UPDATE machines SET status='revoked',revoked_at=?,credential_hash=NULL,updated_at=? WHERE id=?").run(stamp, stamp, machineId); return { ok: true }; }
  reconnect(machineId: string) { const machine = this.get(machineId); return { ok: machine.status === 'online', message: machine.status === 'online' ? `${machine.name} is connected.` : `Waiting for ${machine.name} to reconnect. The runner only needs outbound HTTPS access.` }; }
  test(machineId: string, profile?: AgentProfile) {
    const machine = this.get(machineId), issues: string[] = [];
    if (machine.status !== 'online') issues.push('Runner is offline.');
    if (profile?.computer.access === 'private' && !machine.capabilities.container) issues.push('Container execution is unavailable.');
    if (profile?.computer.access === 'direct' && !machine.capabilities.direct) issues.push(`Direct execution is unavailable. ${machine.capabilities.detail || 'Install Hermes and the Open Harness policy extension on the runner.'}`);
    if (profile?.computer.desktop === 'existing' && !machine.capabilities.desktop) issues.push(machine.platform === 'darwin' ? 'Grant Accessibility and Screen Recording to the runner.' : machine.platform === 'win32' ? 'Sign in to an interactive Windows session and start the runner there.' : 'Start a graphical session with DISPLAY or Wayland and enable AT-SPI.');
    if (profile?.computer.desktop === 'virtual' && !machine.capabilities.virtualDesktop) issues.push('Private virtual desktops are available on Linux runners only.');
    return { ok: !issues.length, message: issues.length ? issues.join(' ') : `${machine.name} is ready for this agent.`, machine };
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
