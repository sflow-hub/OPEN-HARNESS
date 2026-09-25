# runtime/ — coordinator, runner, Hermes adapter

Everything that outlives the browser lives here. Read [../CLAUDE.md](../CLAUDE.md) first for
project-wide rules.

| File | Responsibility |
| --- | --- |
| `service.ts` | The coordinator: HTTP API, run queue, schedules, approvals, runner dispatch, migration, handoffs. The largest file here — extend an existing handler rather than adding a layer. |
| `runner.ts` | Outbound runner: polls for work, executes, delivers results durably, handles remote controls |
| `runner.mjs` | **Generated** esbuild bundle of `runner.ts`, committed on purpose. Never hand-edit; run `npm run runner:bundle` and commit the result, or `tests/runner-bundle.test.ts` fails. |
| `machines.ts` | Pairing codes, scoped runner credentials, machine health, commands, reservations, transfers |
| `db.ts` | `node:sqlite` schema, runs, events, approvals, recovery state |
| `hermes.ts` | Hermes TUI gateway JSON-RPC adapter and container lifecycle |
| `profiles.ts` | Profile validation, revisions, inheritance, migration, run snapshots |
| `profile-runtime.ts` | Runtime catalogs, connection checks, and the compiler that writes an agent's on-disk profile |
| `tasks.ts` | Task boards, stages, checklists, comments, dispatch |
| `secrets.ts` | Server-side credential storage: OS vault when available, else `0600` file |
| `coordination-socket.ts` | Per-agent private Unix socket for the coordination MCP server |
| `cli.ts` | `npm run harness -- <cmd>`: setup, start, stop, status, doctor, install-service |
| `hermes/` | Pinned container image, `container-init.sh`, `coordination.mjs` (agent-scoped MCP tools), and `extension/open_harness_policy.py` (the managed allowlist middleware) |

## Rules

- **Agent profile files are generated, not source.** `profile-runtime.ts` writes
  `.open-harness/agents/<id>/profile/{SOUL.md,config.yaml,.env}` and
  `managed/policy.json` from the profile in SQLite on every run. Editing those files by hand
  is pointless — they are overwritten. Change the profile (UI, or the `agent_profiles` /
  `profile_revisions` / `agents` rows) instead.
- Profiles are revisioned. A running run keeps its original revision; queued work snapshots
  the newest profile when it starts. Don't mutate a revision in place.
- The policy extension is fail-closed: an empty or missing `policy.json` denies everything.
  Keep it that way. `mcp_open_harness_task` is always in the allowlist.
- Tool allowlists are compiled explicitly and enforced inside Hermes, including for code-
  called tools and temporary subagents. Enforcement belongs there, not in the UI.
- The adapter sits behind the gateway and must not modify Hermes's reasoning loop.
- Delegation depth is capped at 2; cyclic handoffs are rejected. Stopping a parent run stops
  descendants and their Hermes sessions and process trees.
- Managed profiles disable Hermes's own cron executor — the control service is the only
  scheduler. Don't reintroduce a second one.
- Python tests (`tests/policy-extension-test.py`) are invoked from the Node suite, so the
  middleware needs Python 3 available.
- After touching `hermes.ts`, the Dockerfile, or the extension: `npm run harness:setup` and
  recreate containers, then record what you verified in [VERIFICATION.md](VERIFICATION.md).
