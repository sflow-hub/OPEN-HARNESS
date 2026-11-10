import type { DatabaseSync } from 'node:sqlite';
import type { AssistantArtifact, AssistantOutcome, AssistantResultReport, AssistantSource } from '../lib/assistant-overview';
import type { ActionIntent } from '../lib/product';
import type { RunRow } from './db';
import { object, ProductError, text } from './product-error';

type ReportRow = { run_id: string; title: string; summary: string; artifacts_json: string; sources_json: string; updated_at: string };
type ReviewRow = { accepted: number; evidence: string; reviewed_at: string };
const unsafePath = /(?:^|[-_.])(?:secrets?|credentials?|passwords?|tokens?|keychains?|cookies?)(?:[-_.]|$)/i;
function sharedPath(value: unknown) {
  const path = text(value, 'Shared file path', 160);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._ -]{0,159}$/.test(path) || path.includes('..') || unsafePath.test(path) || /^(?:id_rsa|id_ed25519|config\.ya?ml|SOUL\.md)$/i.test(path) || /\.(?:pem|key|p12|pfx)$/i.test(path)) throw new ProductError('Choose a non-sensitive filename directly inside the shared folder.');
  return path;
}
function link(value: unknown) {
  const raw = text(value, 'Link URL', 2048);
  let url: URL;
  try { url = new URL(raw); } catch { throw new ProductError('Use a complete http or https link.'); }
  if (!/^https?:\/\//i.test(raw) || !['http:','https:'].includes(url.protocol) || !url.hostname || url.username || url.password || raw.includes('\\') || [...raw].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) throw new ProductError('Use an http or https link without embedded credentials.');
  return url.href;
}
function list<T>(input: unknown, label: string, limit: number, map: (item: Record<string, unknown>) => T): T[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > limit) throw new ProductError(`${label} must contain at most ${limit} entries.`);
  return input.map(item => map(object(item)));
}
function artifacts(input: unknown): AssistantArtifact[] {
  return list(input, 'Artifacts', 20, item => {
    const label = text(item.label, 'Artifact label', 150);
    if (item.kind === 'file' && item.url === undefined) return { label, kind: 'file', path: sharedPath(item.path) };
    if (item.kind === 'link' && item.path === undefined) return { label, kind: 'link', url: link(item.url) };
    throw new ProductError('Choose a file artifact with a shared path or a link artifact with a URL.');
  });
}
function sources(input: unknown): AssistantSource[] { return list(input, 'Sources', 30, item => ({ label: text(item.label, 'Source label', 150), url: link(item.url) })); }

export class AssistantResults {
  constructor(private db: DatabaseSync) {
    db.exec('CREATE TABLE IF NOT EXISTS assistant_results(run_id TEXT PRIMARY KEY,title TEXT NOT NULL,summary TEXT NOT NULL,artifacts_json TEXT NOT NULL,sources_json TEXT NOT NULL,updated_at TEXT NOT NULL)');
  }
  private hasTable(name: string) { return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); }
  report(runId: string, input: Record<string, unknown>): AssistantResultReport {
    const run = this.db.prepare('SELECT prompt FROM runs WHERE id=?').get(runId) as { prompt: string } | undefined;
    if (!run) throw new ProductError('Task not found.', 404);
    const title = text(input.title === undefined ? run.prompt.slice(0, 150) : input.title, 'Result title', 150), summary = text(input.summary, 'Result summary', 4000), files = artifacts(input.artifacts), references = sources(input.sources);
    this.db.prepare('INSERT INTO assistant_results VALUES(?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET title=excluded.title,summary=excluded.summary,artifacts_json=excluded.artifacts_json,sources_json=excluded.sources_json,updated_at=excluded.updated_at').run(runId, title, summary, JSON.stringify(files), JSON.stringify(references), new Date().toISOString());
    return this.get(runId)!;
  }
  get(runId: string): AssistantResultReport | null {
    const row = this.db.prepare('SELECT * FROM assistant_results WHERE run_id=?').get(runId) as ReportRow | undefined;
    return row ? { runId: row.run_id, title: row.title, summary: row.summary, artifacts: JSON.parse(row.artifacts_json), sources: JSON.parse(row.sources_json), updatedAt: row.updated_at } : null;
  }
  outcomes(runs: RunRow[], actions: ActionIntent[]): AssistantOutcome[] {
    const visible = new Map(runs.map(run => [run.id, run])), reports = new Map(runs.map(run => [run.id, this.get(run.id)])), reviews = this.hasTable('run_outcomes'), contexts = this.hasTable('run_contexts');
    const summary = (run: RunRow) => reports.get(run.id)?.summary || (run.result || run.error || '').slice(0, 4000);
    return runs.map<AssistantOutcome>(run => {
      const report = reports.get(run.id), review = reviews ? this.db.prepare('SELECT accepted,evidence,reviewed_at FROM run_outcomes WHERE run_id=?').get(run.id) as ReviewRow | undefined : undefined;
      const context = contexts ? this.db.prepare('SELECT source_run_id FROM run_contexts WHERE run_id=?').get(run.id) as { source_run_id: string | null } | undefined : undefined;
      const descendants = new Set<string>(), pending = [run.id];
      while (pending.length) { const parent = pending.pop()!; for (const child of runs) if (child.id !== run.id && child.parent_run_id === parent && !descendants.has(child.id)) { descendants.add(child.id); pending.push(child.id); } }
      return {
        runId: run.id, title: report?.title || run.prompt.slice(0, 150), summary: summary(run), state: run.state, agentId: run.agent_id,
        createdAt: run.created_at, updatedAt: run.updated_at,
        parentRunId: run.parent_run_id && visible.has(run.parent_run_id) ? run.parent_run_id : null,
        sourceRunId: context?.source_run_id && visible.has(context.source_run_id) ? context.source_run_id : null,
        artifacts: report?.artifacts || [], sources: report?.sources || [],
        verification: { state: review ? review.accepted === 1 && run.state === 'completed' ? 'accepted' : 'needs_changes' : 'unreviewed', evidence: review?.evidence || '', checkedAt: review?.reviewed_at || null },
        // The caller's permitted action list is the authority; never expand it from the database.
        actions: actions.filter(action => action.runId === run.id).map(action => ({ id: action.id, summary: action.summary, state: action.state, evidence: typeof (action as ActionIntent & { evidence?: unknown }).evidence === 'string' ? (action as ActionIntent & { evidence: string }).evidence : '' })),
        delegation: runs.filter(child => descendants.has(child.id)).map(child => {
          const parent = child.parent_run_id ? visible.get(child.parent_run_id) : undefined;
          return { runId: child.id, agentId: child.agent_id, parentRunId: parent?.id || null, fromAgentId: parent?.agent_id || '', state: child.state, summary: summary(child) };
        }),
      };
    });
  }
}
