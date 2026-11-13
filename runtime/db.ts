import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync, existsSync, statSync } from "node:fs";
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
// Version 4 protects reply-only grants; version 5 prevents interval-only schedulers from
// silently treating cron schedules as recurring interval work after a downgrade.
export const SCHEMA_VERSION = 5;

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

  constructor(path: string, recover = true) {
    mkdirSync(dirname(path), { recursive: true });
    const existing = path !== ':memory:' && existsSync(path) && statSync(path).size > 0;
    this.db = new DatabaseSync(path);
    const found = Number((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version || 0);
    if (found > SCHEMA_VERSION) {
      this.db.close();
      throw new SchemaTooNewError(
        `This Open Harness data folder was written by a newer version (database format ${found}; this build understands ${SCHEMA_VERSION}). ` +
        `Install the newer version again, or move ${path} aside to start with an empty workspace. Nothing was changed.`,
      );
    }
    if (existing && found < SCHEMA_VERSION) {
      const backup = `${path}.before-v${SCHEMA_VERSION}-${Date.now()}.backup`;
      this.db.prepare('VACUUM INTO ?').run(backup); chmodSync(backup, 0o600);
    }
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS sandbox_selftests (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, machine_id TEXT, runner_kind TEXT,
      attestation TEXT, status TEXT, result_json TEXT NOT NULL, created_at TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS sandbox_selftests_agent ON sandbox_selftests(agent_id, created_at);`);
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
      CREATE TABLE IF NOT EXISTS run_inputs (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, gateway_request_id TEXT NOT NULL,
        type TEXT NOT NULL, payload_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL, resolved_at TEXT, UNIQUE(run_id,gateway_request_id)
      );
      CREATE TABLE IF NOT EXISTS runtime_processes (
        agent_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, identity TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_cleanup (
        agent_id TEXT PRIMARY KEY, computer_json TEXT NOT NULL, error TEXT NOT NULL
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
    for (const [column, definition] of Object.entries({ kind: "TEXT NOT NULL DEFAULT 'direct'", title: "TEXT", turn_policy: "TEXT NOT NULL DEFAULT 'manual'", auto_turns_enabled: "INTEGER NOT NULL DEFAULT 1", limits_json: "TEXT NOT NULL DEFAULT '{}'", source: "TEXT NOT NULL DEFAULT 'native'", created_at: "TEXT NOT NULL DEFAULT ''", updated_at: "TEXT NOT NULL DEFAULT ''" })) addColumn(this.db, "conversations", column, definition);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        seq           INTEGER PRIMARY KEY AUTOINCREMENT,
        id            TEXT UNIQUE NOT NULL,
        conversation_id TEXT NOT NULL,
        sender_kind   TEXT NOT NULL,
        sender_id     TEXT NOT NULL,
        sender_name   TEXT NOT NULL,
        body          TEXT NOT NULL,
        idempotency_key TEXT,
        mentions_json TEXT NOT NULL DEFAULT '[]',
        in_reply_to   TEXT,
        origin_run_id TEXT,
        round_id      TEXT,
        source        TEXT NOT NULL DEFAULT 'native',
        created_at    TEXT NOT NULL,
        FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS messages_conv_seq ON messages(conversation_id, seq);
      CREATE UNIQUE INDEX IF NOT EXISTS messages_idem
        ON messages(conversation_id, sender_kind, sender_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE TABLE IF NOT EXISTS message_deliveries (
        message_id    TEXT NOT NULL,
        recipient_kind TEXT NOT NULL,
        recipient_id  TEXT NOT NULL,
        state         TEXT NOT NULL DEFAULT 'pending',
        deliver_after TEXT,
        consumed_run_id TEXT,
        delegation_root TEXT,
        hop_depth INTEGER,
        attempts      INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        PRIMARY KEY(message_id, recipient_kind, recipient_id),
        FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS deliveries_inbox ON message_deliveries(recipient_kind, recipient_id, state);
      CREATE TABLE IF NOT EXISTS conversation_members (
        conversation_id TEXT NOT NULL,
        participant_kind TEXT NOT NULL,
        participant_id  TEXT NOT NULL,
        role            TEXT NOT NULL DEFAULT 'member',
        session_id      TEXT,
        joined_at       TEXT NOT NULL,
        removed_at      TEXT,
        PRIMARY KEY(conversation_id, participant_kind, participant_id),
        FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS conv_members_agent ON conversation_members(participant_kind, participant_id);
    `);
    const internalRun = ['task_runs', 'schedule_runs'].filter(table => this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
      .map(table => ` OR EXISTS(SELECT 1 FROM ${table} linked WHERE linked.run_id=r.id)`).join('');
    this.db.exec(`
      INSERT OR IGNORE INTO conversations(id,agent_id,title,kind,source,created_at,updated_at)
        SELECT r.conversation_id,(SELECT first.agent_id FROM runs first WHERE first.conversation_id=r.conversation_id ORDER BY first.created_at,first.id LIMIT 1),'','direct',CASE WHEN MIN(r.parent_run_id IS NOT NULL${internalRun})=1 THEN 'internal' ELSE 'backfill' END,MIN(r.created_at),MAX(r.updated_at) FROM runs r GROUP BY r.conversation_id;
      INSERT OR IGNORE INTO conversation_members(conversation_id,participant_kind,participant_id,role,joined_at)
        SELECT id,'agent',agent_id,'member',created_at FROM conversations;
      INSERT OR IGNORE INTO conversation_members(conversation_id,participant_kind,participant_id,role,joined_at)
        SELECT id,'user','user','owner',created_at FROM conversations;
    `);
    // Existing interval schedules keep their behavior; cron semantics require schema 5.
    addColumn(this.db, "schedules", "schedule_kind", "TEXT NOT NULL DEFAULT 'interval'");
    addColumn(this.db, "schedules", "cron_expression", "TEXT");
    addColumn(this.db, "schedules", "misfire_policy", "TEXT NOT NULL DEFAULT 'run_once'");
    for (const migration of MIGRATIONS) if (migration.to > found) migration.apply(this.db);
    if (found !== SCHEMA_VERSION) this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    const stamp = new Date().toISOString();
    if (recover) this.db.prepare("UPDATE runs SET state='interrupted', error=?, updated_at=? WHERE state IN ('running','waiting_approval','waiting_input')")
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
  liveRuns() { return this.db.prepare("SELECT * FROM runs WHERE state IN ('running','waiting_approval','waiting_input') ORDER BY created_at").all() as RunRow[]; }
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
    if (updated && patch.state) {
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(patch.state)) {
        this.db.prepare("UPDATE approvals SET state='expired',resolved_at=? WHERE run_id=? AND state IN ('pending','submitting','submitted')").run(new Date().toISOString(), id);
        this.db.prepare("UPDATE run_inputs SET state='expired',resolved_at=? WHERE run_id=? AND state IN ('pending','submitting','submitted')").run(new Date().toISOString(), id);
      }
      this.runListener?.(updated);
    }
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
  pendingApprovals(runId: string) {
    return (this.db.prepare("SELECT * FROM approvals WHERE run_id=? AND state='pending' ORDER BY created_at").all(runId) as Array<Record<string, unknown>>).map(row => {
      const payload = JSON.parse(String(row.payload_json));
      return { approvalId: String(row.id), detail: String(payload.command || payload.description || 'Hermes requests approval.'), payload, createdAt: String(row.created_at) };
    });
  }
  pendingInputs(runId: string) {
    return (this.db.prepare("SELECT * FROM run_inputs WHERE run_id=? AND state='pending' ORDER BY created_at").all(runId) as Array<Record<string, unknown>>).map(row => ({ inputId: String(row.id), type: String(row.type), payload: JSON.parse(String(row.payload_json)), createdAt: String(row.created_at) }));
  }
  resolveApproval(id: string, state: string) { this.db.prepare("UPDATE approvals SET state=?,resolved_at=? WHERE id=?").run(state, new Date().toISOString(), id); }
}
