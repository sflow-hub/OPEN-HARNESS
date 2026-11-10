import type { DatabaseSync } from "node:sqlite";
import type { AuditEvent } from "../lib/control-client";

type AuditInput = { actorKind: AuditEvent["actorKind"]; actorId?: string; action: string; targetKind?: string; targetId?: string; detail?: unknown };
type AuditFilter = { after?: number; limit?: number; action?: string; targetKind?: string; targetId?: string };
type Row = { seq: number; id: string; at: string; actor_kind: AuditEvent["actorKind"]; actor_id: string | null; action: string; target_kind: string | null; target_id: string | null; detail_json: string };

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !/value|secret|token|password|key$/i.test(key)).map(([key, item]) => [key, redact(item)]));
  return value;
}

export class Audit {
  constructor(readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, at TEXT NOT NULL,
        actor_kind TEXT NOT NULL CHECK(actor_kind IN ('operator','agent','runner','system')),
        actor_id TEXT, action TEXT NOT NULL, target_kind TEXT, target_id TEXT, detail_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_events(action);
      CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_events(target_kind,target_id);
      CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'Audit events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'Audit events are append-only'); END;
    `);
  }

  private map(row: Row): AuditEvent {
    return { seq: Number(row.seq), id: row.id, at: row.at, actorKind: row.actor_kind, actorId: row.actor_id, action: row.action, targetKind: row.target_kind, targetId: row.target_id, detail: JSON.parse(row.detail_json) };
  }

  record(input: AuditInput): AuditEvent {
    let detail = JSON.stringify(redact(input.detail ?? {})) ?? '{}';
    if (detail.length > 4096) detail = JSON.stringify({ truncated: true });
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO audit_events(id,at,actor_kind,actor_id,action,target_kind,target_id,detail_json) VALUES(?,?,?,?,?,?,?,?)').run(id, new Date().toISOString(), input.actorKind, input.actorId ?? null, input.action, input.targetKind ?? null, input.targetId ?? null, detail);
    return this.map(this.db.prepare('SELECT * FROM audit_events WHERE id=?').get(id) as Row);
  }

  list({ after = 0, limit = 100, action, targetKind, targetId }: AuditFilter = {}): AuditEvent[] {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid audit cursor or limit.');
    const clauses = ['seq > ?'], params: (string | number)[] = [after];
    for (const [column, value] of [['action', action], ['target_kind', targetKind], ['target_id', targetId]]) if (value !== undefined) { clauses.push(`${column} = ?`); params.push(value); }
    params.push(Math.min(limit, 500));
    return (this.db.prepare(`SELECT * FROM audit_events WHERE ${clauses.join(' AND ')} ORDER BY seq ASC LIMIT ?`).all(...params) as Row[]).map(row => this.map(row));
  }
}
