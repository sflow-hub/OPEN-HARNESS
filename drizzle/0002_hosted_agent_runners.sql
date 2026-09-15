CREATE TABLE IF NOT EXISTS agent_profiles (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, json TEXT NOT NULL, updated_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS workspace_settings (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, json TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS machines (id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, arch TEXT NOT NULL, status TEXT NOT NULL, last_seen_at TEXT, reserved_agent_id TEXT, capabilities_json TEXT NOT NULL, credential_hash TEXT, revoked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS machine_pairings (id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, platform TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS runner_commands (id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, agent_id TEXT, kind TEXT NOT NULL, payload_json TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, leased_at TEXT, finished_at TEXT, result_json TEXT);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hosted_runner_commands_machine_state ON runner_commands(machine_id,state,created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, conversation_id TEXT NOT NULL, prompt TEXT NOT NULL, state TEXT NOT NULL, machine_id TEXT NOT NULL, command_id TEXT, result TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hosted_runs_agent_state ON runs(agent_id,state);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS run_snapshots (run_id TEXT PRIMARY KEY, json TEXT NOT NULL, created_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS run_credentials (run_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, token_hash TEXT NOT NULL, created_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS run_relations (run_id TEXT PRIMARY KEY, parent_run_id TEXT, depth INTEGER NOT NULL DEFAULT 0);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS run_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hosted_run_events_run_seq ON run_events(run_id,seq);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS runner_event_receipts (command_id TEXT NOT NULL, event_id TEXT NOT NULL, received_at TEXT NOT NULL, PRIMARY KEY(command_id,event_id));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, gateway_request_id TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS agent_transfers (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, source_machine_id TEXT NOT NULL, destination_machine_id TEXT NOT NULL, state TEXT NOT NULL, detail TEXT NOT NULL, export_command_id TEXT, import_command_id TEXT, checksum TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hosted_agent_transfers_agent_state ON agent_transfers(agent_id,state,created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS transfer_chunks (transfer_id TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(transfer_id,position));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS hosted_routines (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, name TEXT NOT NULL, prompt TEXT NOT NULL, interval_minutes INTEGER NOT NULL, timezone TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, next_run_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hosted_routines_due ON hosted_routines(enabled,next_run_at);
