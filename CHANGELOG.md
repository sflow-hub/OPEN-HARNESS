# Changelog

All notable changes to Open Harness are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project is
pre-1.0, so breaking changes can still land in a minor version.

## [Unreleased]

### Added

- Add a per-agent Computer panel with live desktop takeover, a private interactive terminal, persistent terminal consent, and confirmed permission revocation. Preserve existing grants and keep human terminal access separate from agent permissions. (claude, codex)
- Separate persistent Linux desktops from stoppable execution containers, preserving live browser pages across handoffs while stopping detached commands. Add ownership-checked managed computer tools, ephemeral runner streams, destination-encrypted transfers and runtime contract 11. (codex)

- Add prepared decision previews and edits requiring fresh approval, finished-work cards with artifacts and review evidence, a Today brief, three guided starters, agent-scoped notes, workflow reuse and completion-notification preferences to the assistant workspace. (claude, codex)

- Add a Harness tab to Agent settings for choosing which agent program runs each agent (Hermes or OpenCode), with a review of the tools and features that change before switching. OpenCode runs once the coordinator provides it. (claude)

- Add an optional Reply only mode that retains conversation history while disabling tools and MCP connections for that task; record full prompt tokens separately from cached input usage. (codex)

- Show animated chat status for sending, startup, thinking, tool use and streamed replies, with elapsed time and reduced-motion support. Apply streamed event batches in one message update to reduce UI work. (codex)

- Add a Credentials tab to the sidebar: a searchable, filterable, sortable list of saved credentials, an add flow that starts by choosing the service, and one form with Connection and Details panes for creating, editing, rotating and deleting. Saved values stay write-only; settings panels open the same repository as a dialog. (claude)

### Fixed

- Close two harness isolation gaps. Image archives must use standard POSIX tar headers with valid checksums, since Docker reads other formats' names differently and a hidden second manifest could retag another agent's runtime; any tag a load applies anyway is undone and the install fails. OpenCode no longer loads plugins or downloaded tools from the agent's writable private folder: its config, data, cache, and home are created fresh for each launch. (claude)
- Make agent instructions reliably reach the model. Pinned Hermes discarded a whole SOUL.md, folder and API notices included, when any line resembled prompt injection, which ordinary phrases such as "pull new tasks from the board" do. The managed entry now trusts only the SOUL.md whose hash the coordinator recorded in the read-only policy, and keeps scanning project context files. Every harness also receives the agent's name, role and description, and OpenCode and custom harnesses now receive API grants. Requires runtime contract 13. (claude)
- Advance the database to schema 5 so older interval-only schedulers refuse cron schedules instead of running them at the wrong cadence. Preserve a restricted pre-upgrade database backup. (codex)

- Reuse a matching prepared private runtime between chat turns, expire unused preparation, and coordinate cleanup with active tasks, settings probes, backups and shutdown. Keep the newest reply visible on short phone viewports. (codex)

- Count agents inheriting the workspace credential in its usage, and require explicit deletion when an active task still uses a credential after its agent switches away. (codex)

- Show what an agent is asking: the pinned Hermes sends clarifying questions as a `questions` list, which the dashboard did not read, so it showed an answer box under a generic "needs an answer" line. Each question now appears in readable text with its own choices and answer box, and answers go back keyed by question; previously Hermes took a plain-text reply to such a request as "cancel all" and the agent received blank answers. (claude)
- Require pairing for dashboard-proxy bootstrap, keep native production listeners on loopback, bind agent coordination tokens to their computer and require each call to name a live run of that agent there, and reject folder grants covering Docker-context sockets or protected data under literal two-dot-prefixed names. (codex)
- Make agent task and project tools work with API-key models: flat, typed tool fields replace the empty `input` object that models always sent as `{}`; refusals now name the missing field or the permission to ask for, and no longer trip Hermes's MCP circuit breaker ("server unreachable"); answer keepalive pings; refresh cached tool schemas when they change. (claude)
- Let agents collaborate on long work: a named handoff waits at most four minutes (under Hermes's five-minute tool limit), then returns its run ID to keep waiting on instead of failing and inviting a duplicate handoff, which also frees agents that were waiting on each other; the agent task list returns card summaries so a shared board cannot overflow a model's context. (claude)
- Ignore superseded browser readiness responses without overlapping slow background checks, retry failed folder-sharing checks on the next admission, and refuse container replacement when Docker cannot confirm the runtime image ID. (codex)
- Restore the coordinator connection and active runs before enabling chat after refresh; retry brief connection failures automatically while keeping the draft editable. (codex)
- Use the fully qualified local Hermes image name throughout runtime checks and container startup so Docker Desktop shorthand lookup failures do not send an installed workspace back to setup. (codex)
- Retry transient Docker image lookups, distinguish failed checks from missing runtimes, and automatically refresh an unavailable chat runtime after Docker recovers. (codex)
- Require authenticated PCRE2 10.49-r0 inputs for both engine architectures, with offline installation, exact-version checks and release labels bound to the input lock. (codex)
- Restore authenticated agent coordination on Linux Docker Desktop through the existing loopback HTTP fallback, and allow the authenticated API tool through its agent-scoped private socket. (codex)
- Fix hostname requests for API credentials and OAuth with Node's automatic address-family selection while preserving validated, pinned DNS addresses. (codex)
- Remove unused npm and development glob packages from the coordinator runtime; verify the production import graph before pruning standalone dependencies. (codex)

- Keep the dashboard working while an agent container starts on Docker Desktop: starting a container, checking the runtime image and data-folder sharing, and the setup checks now run Docker asynchronously, so the coordinator keeps answering other requests instead of stalling for up to several minutes. (claude)
- Require runtime contract 12 with signed Chromium/OpenSSL security inputs, guarded PyJWT and npm dependency fixes including http-cache-semantics 4.3.0 with a hash-verified cache-policy backport, and the authenticated API tool in the rebuilt image. (codex)
- Fetch locked Debian browser packages from the signed snapshot at the reviewed input cutoff, so live mirror updates cannot make the pinned Hermes runtime unbuildable. Package identities and hashes remain enforced. (codex)

- Refresh the coordinator and agent image dependencies, keep the coordinator as a Docker client without a redundant daemon, and require a full runtime-contract-6 rebuild. Image publication remains gated on security scans and platform acceptance. (codex)
- Initialize each private desktop's accessibility session before applications launch, so browsers opened before the first computer-control call support clicking and typing; require runtime contract 6, retaining confirmed initialization for native Linux folder grants. (codex)
- Keep computer control inside private per-agent desktops; block legacy native execution and probes, remove host-runtime installer fallbacks, and retain safe cleanup of saved native processes. (codex)
- Harden profile generation and workspace file access against agent-planted links, require Docker for both sandboxed access modes, and verify private-file isolation and folder revocation with real containers. (codex)
- Preserve canonical Hermes memory and skills on the assigned computer, durable run history and input delivery, revision-scoped permissions, and safe process recovery while retaining saved credentials, teams and projects. (codex)
- Test onboarding model drafts before saving them, encrypt temporary remote probe credentials, and repair the Stop all route. (codex)
- Prevent one workspace from stopping or replacing another workspace’s agent container; migrate verified legacy containers and report cleanup failures. (codex)
- Run Compose as a nonroot coordinator using a private Unix engine socket and separate agent network; restore production security headers and keep local Git bundles out of images. Existing root-owned state has an explicit migration in the operations guide. (codex)
- Restore private Chromium desktop initialization, enforce runtime contract 3 for full and incremental builds, and upgrade stale runtime images during runner installation. (codex)
- Test a pasted model key and save it in one request so a rejected candidate never replaces a working workspace model; offer an inheriting agent the credentials of its effective (workspace) provider; give only runtime preparation the long request budget. (claude)
- Follow each conversation's own run so two agents can work at once, queued follow-ups are shown and followed to their own replies, and Steer/Stop act on the open conversation; answer clarification, secret and sudo requests from the conversation; rebuild earlier conversations on a fresh client and catch finished runs up from every event page without repeating text. (claude)
- Stop a late workspace-model sync from flagging untouched settings as edited or overwriting an edit in progress; save the workspace when the tab is left, not only after a delay; keep commas in the task label field as they are typed. (claude)

### Added

- Decisions: `POST /v1/decide` for the operator, and a `decide` agent tool behind a new Decisions permission (off by default; its agents pool also needs Teams and agents and lists only shared-team members), that ask a System One decision model (TypeSafe's Jev) to choose, rank, classify, score or check, and returns option IDs, probabilities and confidence, never actions. Off until the operator saves a Bearer key and turns it on in `/v1/decisions/settings`; requests go only to the saved origin through the hardened credential transport, with stored secrets removed from the text; input caps, a daily request limit and a per-run limit apply; the audit log keeps metadata and chosen IDs, not text. Lint rules and tests keep the engine from acting and keep approvals with a person. Workspace settings → **Decisions** turns them on, says what is sent, and lists recent decisions; `npm run decide:eval` checks them against the real service on request. (claude)

- Agent settings → Tools → **Workspace access**: per-agent Projects, Routines, Teams and agents, and Runs and conversations permissions, off by default and visible without Advanced features. The old "Create and change projects" switch is retired; turn on Projects for agents that need it. (claude)

- A searchable named credential library with inline creation, shared model dropdowns, typed API accounts, generic OAuth2, MCP field mappings, and explicitly granted authenticated API requests. Headless credential files now use authenticated encryption with a separate backup key. (codex)

- A Folders screen lists the host folders agents keep across every task and chat, with each agent's access set in one table; a folder belongs to one computer and reaches an agent only while it works there. Folders saved on individual agents move into this list on upgrade with the same access, and Agent settings now shows them with a link to the screen. (claude)
- Project folders: a project can share host folders, with each agent's access (none, read-only or read/write) set per project and capped by the folder. They are mounted for that project's tasks, chats where the project is picked, and handoffs from those runs; a run on another computer fails closed. Folders now mount at named paths, `/workspace/folders/<name>` for an agent's own and `/workspace/project/<name>` for a project's, replacing the positional `/workspace/mounts/folder-N`, and the generated instructions tell the agent where they are. Grants of the whole disk, the home folder, the Open Harness data folder or the Docker socket's folder are refused. (claude)
- Mac and Windows local-browser launchers with one-use pairing, explicit folder sharing and an offline backup/restore guide; Docker Desktop is the only host prerequisite. Native platform acceptance remains pending. (claude, codex)
- Preserve the packaged workspace across release-folder changes, accept pairing links pasted into an open dashboard, and refresh setup readiness without reloading; delayed older connection replies cannot discard a newly paired browser token. (claude, codex)
- Prepare digest-pinned ARM64/AMD64 browser packages with native image checks and anonymous install/restore release gates; runtime setup downloads the packaged image without a source-build fallback. Publication and native Mac/Windows acceptance remain pending. (codex)
- Require a one-use local pairing link for Compose browsers, expose only explicitly exported host folders to agent grants, and refuse unsupported localhost-only model routes with actionable guidance. (codex)
- Real Docker, Compose, runner, private desktop and persistent-workflow regression gates alongside expanded lifecycle and integration tests. (codex)
### Security

- The coordinator's agent-directory file operations are now symlink-safe on Linux. `/v1/files`
  (read, list, write, delete), the skill and context (`MEMORY.md`/`USER.md`) endpoints, the
  `/v1/migrate` profile and shared writes, and agent file transfer export/import resolve every
  path from a trusted coordinator-owned anchor through held directory handles (fd-relative via
  `/proc/self/fd`, `O_NOFOLLOW`), so a planted or racing symlink can no longer redirect a read,
  write, or delete outside the agent or shared directories. Deleting a symlink is refused rather
  than followed, and `/v1/bootstrap` now reports the active mode as `fileSafety`
  (`fd-relative` | `path-fallback` | `unsupported`). Non-Linux hosts keep the pathname fallback;
  see the Known limitations in `SECURITY.md` for what it does and does not protect.
- Finished runner commands now drop their probe input as well as credential material, and the
  startup sweep rescans all finished rows. Commands failed by a machine revoke or by lease
  reconciliation keep their payload until the next coordinator restart, when the sweep scrubs them.

### Fixed

- Agents with very long IDs get a valid container name; a hashed suffix keeps it within Docker's
  limit instead of overflowing it.
- A run that has already reached a terminal state is no longer revived by a late event.
- Tool discovery no longer rebuilds a busy container or drops its team mounts.
- The task drawer prompts before discarding unsaved edits.
- Computers and approvals keep load errors separate from revoke and approval-decision errors.
- A single ordering guard keeps the approvals badge count correct.

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

- An agent container is recreated when the data folder moves. The signature that
  decides whether to reuse one left out the state root its mounts are built from, so
  a new `OPEN_HARNESS_STATE_DIR` — or a backup restored to another path — reused a
  container bound to the old directory. Docker recreates a missing bind source empty,
  so the agent found no config, the policy extension never registered, and the run
  died with "Hermes gateway exited during startup" over a log line blaming the image.
- The task board tool documents where each action's fields go. They nest under
  `input`, which only the schema said, so a model that sent `stageId` beside `action`
  got "Stage is required." and no hint. Either spelling now works, as does an `input`
  sent as a JSON string.
- Task boards, named handoffs and agent-created routines now work on a container
  agent. They never had. Four things each broke them on their own: Hermes registers
  an MCP tool as `mcp__<server>__<tool>` while Open Harness granted
  `mcp_open_harness_task`, and the managed policy matches the granted name exactly,
  so it stripped all three from every request and the agent was told they did not
  exist; the agent image bakes a copy of `coordination.mjs` that predates the task
  tool; Hermes defers MCP tools behind `tool_search` bridges that a profile does not
  grant either, so they were reachable by neither route; and `coordination.mjs`
  called `http.request` with an options object where node expects the response
  listener, so every call over the unix socket failed outright. The same name
  mismatch had silently removed every tool from a user's own MCP connection.
- A container agent can reach its coordinator on Docker Desktop. A unix socket in a
  bind mount is visible inside the container and refuses every connection, because
  the mount is passed through a VM — recorded as a macOS and Windows blocker, but
  true of Linux with Docker Desktop too, which is the supported install. The socket
  is still tried first, with the host URL behind it, as a paired runner already did.
- Approving a paused run no longer denies it. Hermes reads the decision from
  `choice` and accepts `once`, `session`, `always` or `deny`; Open Harness sent
  `decision: "approve"`, so every approval arrived as a refusal and the agent was
  told the operator had blocked the command it had just been allowed to run.
- Flagged commands are gated at all. Hermes offers an approval channel only when it
  can see one, and Open Harness announced none, so it found no interactive, gateway
  or unattended context and approved everything: the dashboard's approval UI and the
  configured `unattended_mode: deny` did nothing, and an agent could run `chmod 777`
  or `curl | sh` in a bind-mounted host folder with nobody asked.

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
- `npm test` now has a per-test timeout, and both CI jobs have a job timeout, so a
  hang fails in minutes instead of consuming the six-hour runner limit.
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
