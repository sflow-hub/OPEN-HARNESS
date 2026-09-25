import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type RunState =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_input"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled";

export type RunRow = {
  id: string;
  agent_id: string;
  conversation_id: string;
  prompt: string;
  state: RunState;
  session_id: string | null;
  parent_run_id: string | null;
  depth: number;
  created_at: string;
  updated_at: string;
  result: string | null;
  error: string | null;
};

// Bump when a release changes the schema in a way an older build would mishandle. It is
// recorded in PRAGMA user_version, which is how a downgrade is detected: an older binary
// opening a newer database cannot know which columns and tables it must keep filling.
export const SCHEMA_VERSION = 1;

// Whole-database steps for an upgrade, keyed by the version they bring the file to.
// Column additions for a single store's own tables stay in that store, because it creates
// those tables itself and the coordinator builds the stores after this one.
const MIGRATIONS: Array<{ to: number; apply: (db: DatabaseSync) => void }> = [];

export class SchemaTooNewError extends Error {}

// SQLite has no ADD COLUMN IF NOT EXISTS. Comparing against table_info adds the column
// exactly when it is missing, so a genuine failure still surfaces instead of being
// swallowed by a catch that cannot tell "already there" from "the disk is full".
export function addColumn(db: DatabaseSync, table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.length || columns.some(existing => existing.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

export class Store {
  readonly db: DatabaseSync;
  runListener?: (run: RunRow) => void;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    const found = Number((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version || 0);
    if (found > SCHEMA_VERSION) throw new SchemaTooNewError(
      `This Open Harness data folder was written by a newer version (database format ${found}; this build understands ${SCHEMA_VERSION}). ` +
      `Install the newer version again, or move ${path} aside to start with an empty workspace. Nothing was changed.`,
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL,
        instructions TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, title TEXT NOT NULL, legacy_json TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, conversation_id TEXT NOT NULL, prompt TEXT NOT NULL,
        state TEXT NOT NULL, session_id TEXT, parent_run_id TEXT, depth INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, result TEXT, error TEXT
      );
      CREATE INDEX IF NOT EXISTS runs_queue ON runs(state, created_at);
      CREATE INDEX IF NOT EXISTS runs_agent ON runs(agent_id, state);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, run_id TEXT NOT NULL,
        type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_run_seq ON events(run_id, seq);
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, gateway_request_id TEXT NOT NULL,
        payload_json TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, name TEXT NOT NULL, prompt TEXT NOT NULL,
        interval_minutes INTEGER NOT NULL, timezone TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        next_run_at TEXT NOT NULL, last_run_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schedule_runs (
        schedule_id TEXT NOT NULL, run_id TEXT NOT NULL, scheduled_for TEXT NOT NULL,
        PRIMARY KEY(schedule_id, scheduled_for)
      );
      CREATE TABLE IF NOT EXISTS migrations (
        key TEXT PRIMARY KEY, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS connectors (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, name TEXT NOT NULL, command TEXT NOT NULL,
        args_json TEXT NOT NULL DEFAULT '[]', secret_ref TEXT, enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'unchecked', last_error TEXT, updated_at TEXT NOT NULL,
        UNIQUE(agent_id,name)
      );
    `);
    for (const migration of MIGRATIONS) if (migration.to > found) migration.apply(this.db);
    if (found !== SCHEMA_VERSION) this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    const stamp = new Date().toISOString();
    this.db.prepare("UPDATE runs SET state='interrupted', error=?, updated_at=? WHERE state IN ('running','waiting_approval','waiting_input')")
      .run("The local runtime restarted. Completed actions were preserved; this run was not replayed.", stamp);
  }

  upsertAgent(agent: { id: string; name: string; role: string; instructions: string; config?: unknown }) {
    this.db.prepare(`INSERT INTO agents(id,name,role,instructions,config_json,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, role=excluded.role,
      instructions=excluded.instructions, config_json=excluded.config_json, updated_at=excluded.updated_at`)
      .run(agent.id, agent.name, agent.role, agent.instructions, JSON.stringify(agent.config ?? {}), new Date().toISOString());
  }

  createRun(run: RunRow) {
    this.db.prepare(`INSERT INTO runs(id,agent_id,conversation_id,prompt,state,session_id,parent_run_id,depth,created_at,updated_at,result,error)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(run.id, run.agent_id, run.conversation_id, run.prompt, run.state,
      run.session_id, run.parent_run_id, run.depth, run.created_at, run.updated_at, run.result, run.error);
  }

  getRun(id: string) { return this.db.prepare("SELECT * FROM runs WHERE id=?").get(id) as RunRow | undefined; }
  listRuns(limit = 100) { return this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?").all(limit) as unknown as RunRow[]; }
  queued(limit = 100) { return this.db.prepare("SELECT * FROM runs WHERE state='queued' ORDER BY created_at LIMIT ?").all(limit) as unknown as RunRow[]; }
  descendants(id: string) {
    return this.db.prepare(`WITH RECURSIVE children(id) AS (
      SELECT id FROM runs WHERE parent_run_id=?
      UNION ALL SELECT runs.id FROM runs JOIN children ON runs.parent_run_id=children.id
    ) SELECT id FROM children`).all(id) as unknown as Array<{ id: string }>;
  }
  agentBusy(agentId: string) { return Boolean(this.db.prepare("SELECT 1 FROM runs WHERE agent_id=? AND state IN ('running','waiting_approval','waiting_input') LIMIT 1").get(agentId)); }
  activeCount() { return Number((this.db.prepare("SELECT COUNT(*) n FROM runs WHERE state IN ('running','waiting_approval','waiting_input')").get() as { n: number }).n); }
  activeTopLevelCount() { return Number((this.db.prepare("SELECT COUNT(*) n FROM runs WHERE depth=0 AND state IN ('running','waiting_approval','waiting_input')").get() as { n: number }).n); }
  setRun(id: string, patch: Partial<Pick<RunRow, "state" | "session_id" | "result" | "error">>) {
    const entries = Object.entries(patch);
    if (!entries.length) return;
    this.db.prepare(`UPDATE runs SET ${entries.map(([key]) => `${key}=?`).join(",")},updated_at=? WHERE id=?`)
      .run(...entries.map(([, value]) => value), new Date().toISOString(), id);
    const updated = this.getRun(id);
    if (updated && patch.state) this.runListener?.(updated);
  }
  appendEvent(runId: string, type: string, payload: unknown) {
    const id = crypto.randomUUID(), created = new Date().toISOString();
    const result = this.db.prepare("INSERT INTO events(id,run_id,type,payload_json,created_at) VALUES(?,?,?,?,?)")
      .run(id, runId, type, JSON.stringify(payload), created);
    return { seq: Number(result.lastInsertRowid), id, runId, type, payload, createdAt: created };
  }
  events(runId: string, after: number) {
    return (this.db.prepare("SELECT seq,id,run_id,type,payload_json,created_at FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 500").all(runId, after) as unknown as Array<Record<string, unknown>>)
      .map(row => ({ seq: row.seq, id: row.id, runId: row.run_id, type: row.type, payload: JSON.parse(String(row.payload_json)), createdAt: row.created_at }));
  }
  createApproval(id: string, runId: string, gatewayId: string, payload: unknown) {
    this.db.prepare("INSERT INTO approvals(id,run_id,gateway_request_id,payload_json,state,created_at) VALUES(?,?,?,?,?,?)")
      .run(id, runId, gatewayId, JSON.stringify(payload), "pending", new Date().toISOString());
  }
  approval(id: string) { return this.db.prepare("SELECT * FROM approvals WHERE id=?").get(id) as Record<string, unknown> | undefined; }
  resolveApproval(id: string, state: string) { this.db.prepare("UPDATE approvals SET state=?,resolved_at=? WHERE id=?").run(state, new Date().toISOString(), id); }
}
