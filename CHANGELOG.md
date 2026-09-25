# Changelog

All notable changes to Open Harness are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project is
pre-1.0, so breaking changes can still land in a minor version.

## [0.4.0-beta.1] — 2026-09-25

### Added

- Added a focused self-hosted interface that keeps experimental teams, boards,
  routines, remote computers, direct access, and MCP configuration behind an
  Advanced features preference.
- Added a coordinator-aware health endpoint, first-run retry coverage, and a
  self-hosting operations guide covering authenticated HTTPS access, updates,
  diagnostics, backup, restore, and rollback.
- Added a gated self-hosted beta release workflow with production dependency
  auditing, browser coverage, clean Compose smoke testing, image vulnerability
  scans, source packaging, and checksums.

### Removed

- Removed the hosted Cloudflare/D1 control plane (`app/api/control`, `db/`,
  `drizzle/`, `.openai/`). It was a second implementation of the coordinator that
  shipped inside every local build — its `cloudflare:workers` import reached the
  desktop bundle and `dist/standalone`, where any request to it threw — and its only
  authentication was the presence of a header whose value was never read, with no
  per-user scoping behind it. Dropping it also removes the Cloudflare and OpenAI
  Sites Vite plugins from the path of every build, and 30 packages with them.
- Removed `/api/run` and `/api/status`, a duplicate four-tool agent loop that was
  unauthenticated (its only gate was an `Origin` header, which a request without one
  passes) and spent whatever provider key was in the server environment.
- Removed the scripted "guided run", which fabricated events and wrote a file that
  the first real run then deleted.

### Security

- Model credentials dispatched to a paired runner are encrypted to that runner's
  public key. They were written as plaintext into `runner_commands.payload_json`,
  which nothing ever deleted, so every remote run left a copy of the operator's API
  key in `state.db` for good. A finished command now also drops the credential
  material and transfer bundle it carried.
- An OS vault that cannot be reached no longer destroys the credentials it holds.
  A failed lookup was indistinguishable from an empty vault, and the file fallback
  had already been deleted, so any headless start without a session bus read nothing,
  minted a new control token, invalidated every paired runner, and overwrote the real
  blob on the next save. Startup now stops with an explanation instead, and the file
  copy is kept until the vault hands the same bytes back.
- The control token is compared in constant time, and the file, skill, and context
  routes validate the agent ID rather than passing it through a sanitizer that kept
  dots, which let `..` reach a level above the agent's own folder.
- Closed a DNS-rebinding hole that could expose the dashboard bootstrap token
  (which authorizes arbitrary run creation, host-path container mounts, and
  direct OS execution) to a remote attacker despite the dashboard binding to
  loopback. `/v1/bootstrap` now also requires a loopback `Host` header, with
  an explicit `OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD=1` opt-out.
- Fixed a cross-run event forgery bug: a paired runner could previously post
  approval/clarification events against another agent's run.
- Excluded `.env`/`.env.*` and `.open-harness*` local state from the Docker
  build context, so `docker compose up -d` can no longer bake local secrets
  into an image layer.

### Fixed

- A new agent can actually do work. It was granted only the task tool, so the first thing
  anyone asked it to do — read a file, write one, run a command — it truthfully refused.
  New agents now start with files, terminal, code execution, memory, session recall,
  skills, web, and clarify; desktop control, delegation, scheduling, and MCP connectors
  stay off, and existing agents keep exactly what they had.
- Stopping a run tree no longer abandons the rest of the tree when one container
  refuses to stop, and always releases the agent. It rethrew from the middle of the
  loop with the agent still marked stopping, which kept it out of admission until a
  restart and let "stop everything" report success after doing part of the job.
- Agent containers created by a settings probe are stopped with the coordinator.
  They run with `--restart unless-stopped` and registered no gateway, so they came
  back on every Docker start holding their CPU and memory reservation.
- A dispatched run gives up on a runner that stops heartbeating, instead of staying
  "running" forever, holding a slot and blocking its agent.
- The dashboard recovers from losing the coordinator: a banner that stays until it
  answers, a status dot that can disagree with "ready", a retry with backoff, and a
  first-run guide that opens even when nothing is reachable. Requests carry a
  deadline, a stale token is re-bootstrapped once, and a reverse proxy's HTML error
  page is reported instead of surfacing as "Unexpected end of JSON input".
- Reopening a task run no longer discards its output. The page followed a message ID
  it had only added when the conversation did not already exist, so for an existing
  thread every token, tool call, and error went nowhere.
- One oversized runtime file no longer resets the saved workspace. It failed
  validation on the next load, which discarded the whole record including every local
  conversation; oversized files are now left out of storage and skipped on restore.
- Stop, stop all, and file delete report what the coordinator said. A failed delete
  removed the row anyway, so the file reappeared on the next refresh.
- The agent runtime build drains stdout and has a deadline, so a builder writing
  progress there cannot wedge first-run setup once the pipe fills.
- Hermes stderr is recorded per agent instead of discarded, so a failed run leaves
  more than a three-line tail.
- The database records `PRAGMA user_version` and refuses to open a data folder
  written by a newer build, rather than writing rows it does not understand.
- The routine scheduler no longer crash-loops the whole coordinator if a
  single routine references a deleted agent; that routine is now disabled
  with a logged reason instead.
- Added process-level `unhandledRejection`/`uncaughtException` handlers so a
  crash outside a request handler leaves a log instead of exiting silently.
- The runner's host-capability probing (Docker, Python) is now asynchronous
  and bounded, so a wedged Docker daemon or hung Python interpreter can no
  longer freeze the runner's heartbeat and command polling indefinitely.
- The coordinator's own Docker status checks (`/v1/bootstrap`, `/v1/health`,
  agent context) are now cached and non-blocking for the same reason.
- Added a `pretest` guard for Node ≥22.13 (`node:sqlite` requires it), which
  previously surfaced as a wall of unrelated-looking test failures.

### Changed

- Teams, task boards, and paired computers are shown by default; the focused
  workspace is now what **Advanced features** turns off. Routines are no longer part
  of that switch, because the coordinator runs them either way and hiding the view
  left scheduled work with nothing in the app to reach it.
- CI builds and tests on Linux only. macOS and Windows are deferred with known
  causes recorded in `ROADMAP.md`.
- The pinned Hermes release and commit live in one module, with a test that fails if
  the Dockerfile or release workflow drifts from it.

- Hardened the self-hosted `compose.yaml`: the `open-harness` service now
  drops all Linux capabilities, disables privilege escalation, and has its
  own dashboard-to-coordinator healthcheck instead of relying on "the process started."
- Defined a real desktop Content-Security-Policy (previously disabled).
- First-run setup now requires runtime readiness and a successful model test;
  dismissing setup no longer records a false completion.
- Signed desktop builds are now a separate manual release-candidate workflow
  and cannot block the self-hosted beta.

## [0.3.0] — 2026-09-12

Initial tracked baseline: persistent named Hermes agents in Docker-isolated
workspaces, a Tauri desktop app for Windows/macOS/Linux, a self-hosted Docker
Compose stack, outbound runners for remote/paired computers, project boards
with agent-owned tasks, routines/approvals/handoffs, and encrypted runner
credentials. See the README for the full feature set as of this version.
