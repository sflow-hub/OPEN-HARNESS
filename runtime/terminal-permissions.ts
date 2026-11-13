import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentProfile } from '../lib/agent-profile';
import { ProductError } from './product-error';
import { validId } from './profiles';

const commandTools = new Set(['terminal', 'process_manage', 'process']);
export type TerminalPermissionRevocation = { agentId: string; state: 'pending' | 'confirmed'; machineId: string; revision: number; requestedAt: string; confirmedAt: string | null; reason: string };
type Row = { id: string; agent_id: string; state: 'pending' | 'confirmed'; machine_id: string; revision: number; requested_at: string; confirmed_at: string | null; reason: string; profile_json: string };
const waiting = 'Terminal permission was removed. Waiting for the assigned computer to confirm that command processes have stopped.';

export class TerminalPermissions {
  private closed = false;
  private active = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval>;
  constructor(private db: DatabaseSync, private cleanup: (profile: AgentProfile) => Promise<boolean>, private getProfile: (id: string) => AgentProfile | null, private onChanged: () => void = () => {}) {
    db.exec("CREATE TABLE IF NOT EXISTS terminal_permission_revocations(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','confirmed')),machine_id TEXT NOT NULL,revision INTEGER NOT NULL,requested_at TEXT NOT NULL,confirmed_at TEXT,reason TEXT NOT NULL,profile_json TEXT NOT NULL,UNIQUE(agent_id,revision)); CREATE INDEX IF NOT EXISTS terminal_permission_pending ON terminal_permission_revocations(state,agent_id)");
    this.timer = setInterval(() => { void this.retry(); }, 5000); this.timer.unref();
    queueMicrotask(() => { void this.retry(); });
  }
  requireConsent(current: AgentProfile | null, desired: AgentProfile, terminalConsent: unknown) {
    const before = new Set(current?.allowedTools || []);
    if (desired.allowedTools.some(tool => commandTools.has(tool) && !before.has(tool)) && terminalConsent !== true) throw new ProductError('Confirm terminal access for this agent before enabling command and process tools. Your draft was kept.');
  }
  revoke(current: AgentProfile, saved: AgentProfile): TerminalPermissionRevocation | null {
    if (this.closed) throw new ProductError('Terminal cleanup is stopping. Try again after the workspace restarts.', 409);
    if (current.id !== saved.id || !Number.isSafeInteger(saved.revision) || saved.revision <= current.revision) throw new ProductError('Terminal permissions changed from a different profile revision. Reload the profile before saving.', 409);
    const removed = current.allowedTools.filter(tool => commandTools.has(tool) && !saved.allowedTools.includes(tool));
    if (!removed.length) return null;
    const id = validId(saved.id), serialized = JSON.stringify(current), existing = this.db.prepare('SELECT * FROM terminal_permission_revocations WHERE agent_id=? AND revision=?').get(id, saved.revision) as Row | undefined;
    if (existing && existing.profile_json !== serialized) throw new ProductError('This terminal revocation belongs to another profile change.', 409);
    if (!existing) this.db.prepare("INSERT INTO terminal_permission_revocations VALUES(?,?,'pending',?,?,?,NULL,?,?)").run(randomUUID(), id, current.computer.machineId, saved.revision, new Date().toISOString(), waiting, serialized);
    // Admission observes the durable pending record before any asynchronous cleanup starts.
    queueMicrotask(() => { void this.retry(); });
    return this.status(id);
  }
  status(id: string): TerminalPermissionRevocation | null {
    const row = this.db.prepare("SELECT * FROM terminal_permission_revocations WHERE agent_id=? ORDER BY CASE state WHEN 'pending' THEN 0 ELSE 1 END,revision DESC LIMIT 1").get(validId(id)) as Row | undefined;
    return row ? { agentId: row.agent_id, state: row.state, machineId: row.machine_id, revision: row.revision, requestedAt: row.requested_at, confirmedAt: row.confirmed_at, reason: row.reason } : null;
  }
  pending(id: string) { return Boolean(this.db.prepare("SELECT 1 FROM terminal_permission_revocations WHERE agent_id=? AND state='pending' LIMIT 1").get(validId(id))); }
  async retry() {
    if (this.closed) return;
    const rows = this.db.prepare("SELECT DISTINCT agent_id FROM terminal_permission_revocations WHERE state='pending'").all() as { agent_id: string }[];
    await Promise.all(rows.map(row => this.drain(row.agent_id)));
  }
  private drain(id: string): Promise<void> {
    const current = this.active.get(id); if (current) return current;
    const operation = Promise.resolve().then(() => this.finish(id)).finally(() => { if (this.active.get(id) === operation) this.active.delete(id); });
    this.active.set(id, operation); return operation;
  }
  private async finish(id: string) {
    while (!this.closed) {
      const row = this.db.prepare("SELECT * FROM terminal_permission_revocations WHERE agent_id=? AND state='pending' ORDER BY revision LIMIT 1").get(id) as Row | undefined;
      if (!row) return;
      let confirmed = false;
      try {
        const profile = JSON.parse(row.profile_json) as AgentProfile, current = this.getProfile(id);
        if (profile.id !== id || profile.computer.machineId !== row.machine_id || current && current.id !== id) throw new Error('Invalid cleanup identity.');
        // The original machine and profile revision survive reassignment, deletion and restart.
        confirmed = await this.cleanup(profile) === true;
      } catch { /* Offline computers and failed stop acknowledgments keep admission blocked. */ }
      if (this.closed) return;
      if (!confirmed) { this.db.prepare("UPDATE terminal_permission_revocations SET reason=? WHERE id=? AND state='pending'").run(waiting, row.id); return; }
      const result = this.db.prepare("UPDATE terminal_permission_revocations SET state='confirmed',confirmed_at=?,reason=? WHERE id=? AND state='pending'").run(new Date().toISOString(), 'The assigned computer confirmed that command processes have stopped.', row.id);
      if (result.changes) this.onChanged();
    }
  }
  close() { this.closed = true; clearInterval(this.timer); }
}
