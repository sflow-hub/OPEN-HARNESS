import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { SetupJob } from '../lib/product';
import { ProductError } from './product-error';

type Row = { id: string; kind: SetupJob['kind']; state: SetupJob['state']; detail: string; run_id: string | null; created_at: string; updated_at: string };
type SetupDependencies = { action(kind: string): Promise<unknown>; sample(): { runId: string; path: string; expected: string; fingerprint: string }; read(path: string): string; fingerprint(): string; testMode(): boolean };
export class SetupJobs {
  private active = new Set<string>();
  constructor(private db: DatabaseSync, private deps: SetupDependencies) {
    db.exec(`CREATE TABLE IF NOT EXISTS setup_jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,state TEXT NOT NULL,detail TEXT NOT NULL,run_id TEXT,proof_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);`);
    db.prepare("UPDATE setup_jobs SET state='interrupted',detail='Setup was interrupted. Resume this step when the computer is ready.',updated_at=? WHERE state IN ('queued','running')").run(new Date().toISOString());
  }
  private map(row: Row): SetupJob { return { id: row.id, kind: row.kind, state: row.state, detail: row.detail, runId: row.run_id, createdAt: row.created_at, updatedAt: row.updated_at }; }
  list() { return (this.db.prepare('SELECT * FROM setup_jobs ORDER BY created_at DESC LIMIT 50').all() as Row[]).map(row => this.map(row)); }
  get(id: string) { const row = this.db.prepare('SELECT * FROM setup_jobs WHERE id=?').get(id) as Row | undefined; if (!row) throw new ProductError('Setup step not found.', 404); return this.map(row); }
  start(kind: unknown) {
    if (!['start-container-engine','prepare-runtime','verify-task'].includes(String(kind))) throw new ProductError('Choose a supported setup step.');
    const existing = this.list().find(job => job.kind === kind && ['queued','running'].includes(job.state)); if (existing) return existing;
    const id = randomUUID(), time = new Date().toISOString();
    this.db.prepare('INSERT INTO setup_jobs VALUES(?,?,?,?,NULL,NULL,?,?)').run(id, kind as string, 'queued', 'Waiting to begin.', time, time);
    queueMicrotask(() => void this.execute(id)); return this.get(id);
  }
  resume(id: string) { const job = this.get(id); if (!['failed','interrupted'].includes(job.state)) throw new ProductError('Only an interrupted or failed setup step can be resumed.', 409); this.change(id, 'queued', 'Waiting to resume.'); queueMicrotask(() => void this.execute(id)); return this.get(id); }
  private change(id: string, state: SetupJob['state'], detail: string) { this.db.prepare('UPDATE setup_jobs SET state=?,detail=?,updated_at=? WHERE id=?').run(state, detail, new Date().toISOString(), id); }
  private async execute(id: string) {
    if (this.active.has(id)) return; this.active.add(id); const job = this.get(id);
    try {
      this.change(id, 'running', job.kind === 'verify-task' ? 'The agent is writing a sample file. Its contents will be checked independently.' : 'Preparing this computer. You can keep using the dashboard.');
      if (job.kind === 'verify-task') {
        const proof = this.deps.sample(); this.db.prepare('UPDATE setup_jobs SET run_id=?,proof_json=? WHERE id=?').run(proof.runId, JSON.stringify(proof), id);
      } else { await this.deps.action(job.kind); this.change(id, 'completed', 'This setup step completed.'); }
    } catch (error) { this.change(id, 'failed', error instanceof Error ? error.message : 'Setup could not complete.'); }
    finally { this.active.delete(id); }
  }
  onRunChanged(run: { id: string; state: string; error?: string | null }) {
    if (!['completed','failed','cancelled','interrupted'].includes(run.state)) return;
    const row = this.db.prepare("SELECT id,proof_json FROM setup_jobs WHERE run_id=? AND state='running'").get(run.id) as { id: string; proof_json: string } | undefined; if (!row) return;
    try {
      const proof = JSON.parse(row.proof_json) as { path: string; expected: string; fingerprint: string };
      if (run.state !== 'completed') throw new Error('The sample task did not finish. Review its conversation and retry.');
      if (this.deps.testMode()) { this.change(row.id, 'completed', 'Test fixture completed. Live execution has not been verified.'); return; }
      if (this.deps.read(proof.path).trim() !== proof.expected || proof.fingerprint !== this.deps.fingerprint()) throw new Error('The sample file did not match, or the model settings changed. Run the check again.');
      this.change(row.id, 'completed', 'Verified: the agent wrote the requested file and its contents matched.');
    } catch (error) { this.change(row.id, 'failed', error instanceof Error ? error.message : 'File verification failed.'); }
  }
  verified() {
    if (this.deps.testMode()) return false;
    const rows = this.db.prepare("SELECT proof_json FROM setup_jobs WHERE kind='verify-task' AND state='completed' ORDER BY updated_at DESC LIMIT 5").all() as { proof_json: string }[];
    return rows.some(row => { try { const proof = JSON.parse(row.proof_json); return proof.fingerprint === this.deps.fingerprint() && this.deps.read(proof.path).trim() === proof.expected; } catch { return false; } });
  }
}
