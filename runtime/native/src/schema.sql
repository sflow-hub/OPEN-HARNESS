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
CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, arch TEXT NOT NULL,
  status TEXT NOT NULL, last_seen_at TEXT, local INTEGER NOT NULL DEFAULT 0,
  reserved_agent_id TEXT, capabilities_json TEXT NOT NULL, credential_hash TEXT,
  encryption_public_key TEXT, revoked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
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
);
CREATE TABLE IF NOT EXISTS native_run_bindings (
run_id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, machine_id TEXT NOT NULL,
stopping INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS native_transfers (
transfer_id TEXT PRIMARY KEY, command_id TEXT NOT NULL, checksum TEXT
);
CREATE TABLE IF NOT EXISTS native_pairing_aliases (
pairing_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS native_legacy_leases (
    run_id TEXT PRIMARY KEY, command_id TEXT UNIQUE NOT NULL
);
