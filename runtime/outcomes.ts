import type { DatabaseSync } from 'node:sqlite';
export class OutcomeError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
export class Outcomes {
  constructor(private db: DatabaseSync) { db.exec('CREATE TABLE IF NOT EXISTS run_outcomes(run_id TEXT PRIMARY KEY,accepted INTEGER NOT NULL,evidence TEXT NOT NULL,reviewed_at TEXT NOT NULL)'); }
  get(id: string) {
    const row = this.db.prepare('SELECT * FROM run_outcomes WHERE run_id=?').get(id) as { run_id: string; accepted: number; evidence: string; reviewed_at: string } | undefined;
    return row ? { runId: row.run_id, accepted: Boolean(row.accepted), evidence: row.evidence, reviewedAt: row.reviewed_at } : null;
  }
  review(id: string, input: { accepted?: unknown; evidence?: unknown }) {
    const run = this.db.prepare('SELECT state FROM runs WHERE id=?').get(id) as { state: string } | undefined;
    if (!run) throw new OutcomeError('Run not found.', 404);
    if (!['completed','failed','interrupted','cancelled'].includes(run.state)) throw new OutcomeError('Wait for this task to finish before reviewing its result.', 409);
    if (typeof input.accepted !== 'boolean' || typeof input.evidence !== 'string' || !input.evidence.trim() || input.evidence.length > 12000) throw new OutcomeError('Describe what you checked (up to 12,000 characters) and whether the result was accepted.');
    if (input.accepted && run.state !== 'completed') throw new OutcomeError('Only completed tasks can be marked accepted. Record needed changes for an interrupted or failed task.', 409);
    this.db.prepare('INSERT INTO run_outcomes VALUES(?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET accepted=excluded.accepted,evidence=excluded.evidence,reviewed_at=excluded.reviewed_at').run(id, Number(input.accepted), input.evidence.trim(), new Date().toISOString());
    return this.get(id);
  }
  summary() {
    const values = this.db.prepare('SELECT COUNT(*) AS reviewed,COALESCE(SUM(accepted),0) AS accepted FROM run_outcomes').get() as { reviewed: number; accepted: number };
    return { ...values, needsChanges: values.reviewed - values.accepted, source: 'Operator reviews; unreviewed tasks are excluded.' };
  }
}
