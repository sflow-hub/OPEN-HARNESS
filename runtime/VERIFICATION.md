# Runtime verification

## Local Docker release-gate pass — September 25, 2026

Environment: Linux, Docker Desktop 4.77.0 with Docker Engine 29.5.3. Docker Desktop is running and enabled for the user's graphical session. This is a local release-candidate preflight, not the required clean Ubuntu 24.04 acceptance host.

Verified in this pass:

- A fresh Compose project built and started with both services healthy. `GET /api/health` returned `{"ok":true}`. Pausing the coordinator made the dashboard endpoint return 503, and unpausing it restored 200. Execution readiness remained a separate status: a restored stack with an empty private Docker volume stayed healthy while reporting that the Hermes runtime needed setup.
- Remote bootstrap with a non-loopback `Host` header returned 403 with the trust switch at its default. The authenticated HTTPS proxy path has not yet been exercised.
- The coordinator rebuilt from the final source, stopped on SIGTERM within the configured grace period, logged coordinator shutdown, and restarted healthy with the original data volume.
- The full Hermes Dockerfile built as image `432f7e5fbf27`, and the pinned `open-harness-hermes:2026.9.11` tag points at that image. Smoke checks passed for Hermes 0.21.2, the Open Harness policy extension, Node, `agent-browser`, the Hermes CLI, and a nested Docker build. Build-only compilers, npm, Git metadata, and package-manager caches are absent from the runtime image.
- The exact final coordinator image had zero high/critical vulnerabilities and zero detected secrets. The hardened Hermes image had 80 high/critical package occurrences across 32 unique CVEs, zero detected secrets, and no available fixed versions. Each Hermes finding has a narrow written rationale and an exception expiring 2026-10-09; Trivy completed with exit code 0 using `security/trivy-exceptions.yaml`. Any new finding or expired entry still fails the release workflow.
- The beta now writes Hermes approval mode `manual`, so a flagged command reaches the durable operator approval flow rather than being decided silently by the guardian model. The already-verified approve and deny round trips below cover the real Hermes vocabulary.
- First-run and workspace model fields can list models available to the saved credential, and OpenRouter starts with its `openrouter/auto` route instead of an empty model ID. The dashboard tracks active work per agent, while the coordinator admits four top-level agents by default, so one busy agent no longer disables every other agent.
- A stopped `harness-data` archive passed gzip validation, restored into an empty volume, and matched all six source files byte for byte. The restored project started healthy and preserved the expected empty agent and credential counts. Archiving the 9.9 GB `harness-docker` volume caused Docker Desktop's engine to exit twice and left an incomplete archive; that optional cache-volume archive and a complete representative 0.3.0 upgrade/rollback remain release gates.
- The source release implementation preserves the lockfile, Compose files, runtime Dockerfile, and operations documentation while excluding environment files, local state, dependencies, and build/test output.

Automated checks on the resulting source: 116 Node tests, 52 Playwright tests across desktop and mobile, TypeScript, ESLint, the production Vinext build, `docker compose config`, and the release scan policy passed. `npm audit --omit=dev --audit-level=high` reports 0 known vulnerabilities; the current npm metadata counts 107 production dependencies.

Release remains blocked on the clean Ubuntu 24.04 run, a real-provider `launch-smoke.md` workflow from this Compose install, authenticated proxy acceptance, the representative 0.3.0 upgrade and complete stopped-stack restore, the 24-hour soak, GitHub CI/repository-rule checks, and final source-archive inspection. Do not create the tag or GitHub Release until every item in `docs/BETA_RELEASE.md` is complete.

## Fourth real-runtime pass — September 25, 2026

Named handoffs, task boards, scheduled routines and the approval round trip, against the same
paid provider as the third pass (OpenRouter, `meta-llama/llama-3.3-70b-instruct`), on Linux with
Docker Desktop 29.5.3 and the pinned image `open-harness-hermes:2026.9.11`. Two container agents
on a shared team, in a state directory holding one credential, on port 4401. Inference spend for
the pass: $0.034.

**Every coordination tool was unreachable, for four separate reasons at once.** Each one alone was
enough to make the whole feature silently absent, and the mocked suite could not see any of them.

1. **Tool names.** Hermes registers an MCP tool as `mcp__<server>__<tool>`; Open Harness granted
   `mcp_open_harness_task`. The managed policy extension matches a granted name against the
   registry name exactly, so it stripped every coordination tool from every request. The agent was
   told the tools did not exist. The same mismatch removed all tools from any user MCP connection.
2. **A stale copy in the image.** The image bakes its own `coordination.mjs`, and the pinned one
   predates the `task` tool: the container advertised two tools where the checkout has three, so
   task boards could not work even once the names matched. The checkout's copy is now placed in
   the agent's managed directory, which the container already mounts read-only.
3. **Tool Search.** Hermes defers MCP tools out of the model-facing array and offers
   `tool_search`/`tool_describe`/`tool_call` bridges instead. Those bridges are not tools an Open
   Harness profile grants, so the policy stripped them too, leaving the deferred tools reachable by
   neither route. Deferral is now off for managed agents; a profile grant is already a short
   explicit allow-list.
4. **`http.request(options, options, callback)`.** `coordination.mjs` passed an options object
   where node expects the response listener, so every call over the unix socket — the route every
   local container agent uses — failed with "The listener argument must be of type function". The
   existing socket test drove the socket with node's own client, and the existing coordination test
   drove `coordination.mjs` over a URL; nothing drove `coordination.mjs` over a socket.

**And the socket cannot work on this setup at all.** Docker Desktop passes bind mounts through a
VM: `coord.sock` is visible inside the container and refuses every connection (`ECONNREFUSED`,
mount type `fakeowner`), while connecting from the host succeeds. ROADMAP recorded this as a
macOS/Windows blocker; it applies just as much to Linux with Docker Desktop, which is the install
this project documents as supported. The socket is still tried first — it needs no open port and
cannot be reached from off the machine — with `http://host.docker.internal:<port>` behind it, the
same fallback a paired runner already used for its own containers. Docker Desktop's host proxy
reaches the coordinator on loopback, so nothing had to be exposed: `--add-host
host.docker.internal:host-gateway` was already set, and the container still needs the run's token.

Two more defects came out of driving the board from a live agent:

5. **The container signature left out the state root** the mounts are built from. Pointing
   `OPEN_HARNESS_STATE_DIR` at a new directory reused the existing container with its mounts still
   on the old path; Docker recreated that path as an empty directory, so the agent started with no
   `config.yaml`, the policy extension never registered, and the run died with "Hermes gateway
   exited during startup" over a log line telling the operator to rebuild the image. Restoring a
   backup to a different path, which `docs/SELF_HOSTING.md` documents, hits exactly this.
6. **The task tool's schema did not say where an action's fields go.** They nest under `input`, and
   a model that sent `stageId` beside `action` — the obvious reading — got "Stage is required."
   with no hint. The schema now documents the shape per action and the route accepts either
   spelling, plus an `input` sent as a JSON string, which would previously have been spread into
   one key per character.

Verified after those fixes:

- **A board task reaches Review.** A task assigned to Beta in the app moved to the Review stage by
  Beta's own `action: "move"` call, with the stage id it had read from the same tool.
- **Named handoff.** Alpha called `mcp__open_harness__delegate_named_agent` with Beta's id; the
  coordinator recorded `handoff.created`, created a child run for Beta in its own container, and
  recorded `handoff.completed` with its state. Beta wrote `handoff.md` to the shared workspace with
  exactly the requested contents, and the parent received the child's result.
- **Task board.** With a task assigned to Beta in the app, Beta called `mcp__open_harness__task`
  with `action: "list"` and replied with the task's exact title.
- **Scheduled routine.** A one-minute routine created in the app fired on the scheduler's next
  tick, its run completed with the requested output, `last_run_at` was recorded and `next_run_at`
  advanced by exactly one interval.

**The approval round trip was broken in two further ways, and is now verified in both
directions.** Hermes offers an approval channel only when it can see one: with neither
`HERMES_GATEWAY_SESSION` nor a bound session platform, `tools/approval_context.py` finds no
interactive context, no gateway context and no unattended context either, and approves every
flagged command outright. So the dashboard's approval UI and the configured
`approvals.unattended_mode: deny` did nothing on a real run, and a container agent ran `chmod 777`
against a bind-mounted host file with nobody asked. The managed gateway now announces itself.
Second, Hermes reads the decision from `choice` and accepts `once`/`session`/`always`/`deny`;
Open Harness sent `decision: "approve"`, so Hermes read every approval as a refusal — the operator
pressed Approve and the agent was told the user had blocked the command. The deterministic runtime
accepted `"approve"` too, which is exactly why this survived. Evidence, with a real before and
after: a run paused in `waiting_approval` carrying the real command and its
`world/other-writable permissions` finding; approving took the file from 644 to 777 and the agent
reported it "was approved by the user"; denying left it at 644 and stopped the command. The gate
was forced to `manual` for that pair of runs only, and `smart` is unchanged in the shipped code.

**Resolved for the beta.** The shipped profile now uses `approvals.mode: 'manual'`, which sends
Hermes-flagged commands to the operator approval flow. This avoids a guardian model silently
approving a risky command with the operator's credential.

Also confirmed incidentally: `POST /v1/onboarding/status` correctly refused a state directory that
Docker cannot read (the probe named the real cause and pointed at the fix), and all five readiness
checks passed once the directory moved under `$HOME`.

**`runtime/hermes/Dockerfile` builds from scratch**, for the first time: earlier passes could only
patch the existing image because a full build did not fit on the root disk. The result carries
`dev.openharness.runtime=2`, imports the policy extension, and serves all three coordination
tools. Built under a throwaway tag and removed afterwards, so the pinned image is untouched.

Still not exercised live: real third-party MCP servers, Direct Computer Access, native subagent
restrictions, a Compose install from a packaged source release, and a backup and restore cycle.

## Third real-runtime pass — September 25, 2026

First end-to-end pass against a **paid provider**, on Linux with Docker Desktop 29.5.3,
Node 22.23.2 and the pinned image `open-harness-hermes:2026.9.11`. Provider: OpenRouter,
model `meta-llama/llama-3.3-70b-instruct`. Total inference spend for the whole pass: $0.0054.

Run from a fresh state directory holding only one credential, on port 4399, so nothing
touched the operator's own workspace. Verified in order:

- **Readiness.** All five checks report ready, including the Docker bind-mount probe for the
  state directory.
- **Credential to provider.** `POST /v1/onboarding/model-test` authenticates against
  `https://openrouter.ai/api/v1/models` with the stored key and reports ready.
- **A real task that changes the workspace.** A run asking the agent to write a file
  completed, and `live-check.md` arrived on the host in `shared/` with exactly the requested
  contents. `GET /v1/files?scope=shared` lists it.
- **Event replay.** 26 durable events for that run, including the full tool lifecycle
  (`tool.generating` → `tool.start` → `tool.complete`) carrying the real `write_file`
  arguments, replayable from `?after=0`.
- **Filesystem isolation.** The container has exactly four mounts — `shared` read-write,
  the agent's own `private` read-write, its profile home read-write, and `managed`
  read-only. Inside it: the host home is not present, `/var/run/docker.sock` is not present,
  no other agent's private directory is reachable, `/run/open-harness` is genuinely
  read-only, and the process runs as `1000:1000` rather than root.
- **Process-tree termination.** With `managed_entry.py`, a Hermes terminal wrapper and a
  `sleep 400` child all running inside the container, `POST /v1/runs/:id/stop` returned
  `{"ok":true,"stopped":1}`, the run became `cancelled`, and the container exited 143 —
  taking the whole tree with it. No agent process survived on the host.
- **Crash recovery.** `SIGKILL` to the coordinator mid-run, then restart: the run is
  `interrupted` with the "not replayed" reason, its 17 events are preserved, the stored
  credential is intact, and the control token is unchanged.
- **Container reaping.** The hard kill left a container that the `--restart unless-stopped`
  policy brought back with no gateway owning it. The next clean shutdown logged
  "Stopped 1 agent container" and stopped it. The operator's separate Docker Compose stack,
  running at the same time, was untouched — the reaper matches on the managed label, not on
  the shared `open-harness-` name prefix.

This pass found one defect that no mocked test could see, now fixed: a new agent was granted
only `mcp_open_harness_task`, so the first thing anyone asked it to do it truthfully refused,
saying it could not create files. `DEFAULT_TOOLS` in `lib/agent-profile.ts` now grants the
working set — files, terminal, code execution, memory, session recall, skills, web and
clarify — while desktop control, delegation, scheduling and MCP connectors stay off.

Still not exercised live: real MCP servers, Direct Computer Access, native subagent
restrictions, named-agent handoff, scheduled routines, an approval round trip, a
from-scratch build of `runtime/hermes/Dockerfile`, and the broader code-repair and browsing
scenarios.

## Real-runtime pass — September 21, 2026

First execution against the real, non-mocked runtime (`mode: live`), on Linux with
Docker Desktop 29.5.3, Node 22.23.2 and the pinned image `open-harness-hermes:2026.9.11`.

A local OpenAI-compatible server stood in for a paid provider, so this exercises the
whole path — credential storage, profile preparation, the bind-mounted profile, plugin
discovery, gateway startup, model resolution and outbound authentication — without
billing a real key. No paid model calls were made.

Verified, from a fresh state directory and a container created from the image:

- A credential created through `POST /v1/credentials` is stored, fingerprinted, and
  written into the agent profile `.env` and nowhere else.
- `prepareProfile` writes `config.yaml`, `SOUL.md` and `.env`, and the agent container
  reads all three from the bind mount.
- The managed policy extension loads and registers, so `managed_entry.py` starts the
  gateway rather than aborting.
- `session.create` returns a session bound to the configured model.
- A run submitted through `POST /v1/runs` reaches `completed`, streams
  `message.start` → `message.delta` → `message.complete`, and the model's response
  propagates back as the run result.
- The outbound request to the model endpoint carries the configured credential.

This pass found four defects that the mocked suite could not see; all four are fixed
in commit `603b19b` and covered by `tests/managed-runtime-contract.test.ts`:

1. `plugins.enabled` was written in a shape Hermes reads as "nothing enabled", gating
   the policy extension off and killing every containerized run at gateway startup.
2. The extension entry point resolved to a function rather than a module, so Hermes
   found no `register()`.
3. A custom or local endpoint had its credential aliased to `OPENAI_API_KEY`, which
   Hermes refuses to send to a non-OpenAI host, so it sent `no-key-required`.
4. Docker Desktop bind-mounts only shared host paths; any other path mounts as an empty
   directory with no error, so the agent profile never arrived. The default state
   directory hits this whenever the checkout lives outside the shared roots. This is now
   probed per state root and reported with its real cause.

## Second real-runtime pass — September 21–22, 2026

Same setup as the first pass. Closed the gaps that pass left open; all evidence is from a
coordinator in `mode: live` unless noted.

- **Runtime contract.** The image now carries `dev.openharness.runtime` and readiness
  compares it with `RUNTIME_CONTRACT`. With an older-contract image under the pinned tag,
  `harness doctor` reports "Update agent runtime", `executionReady: false`, exit 1, and a
  run is refused with that cause instead of starting a container that dies at gateway
  startup. With the current image restored: ready, exit 0, run completes.
- **Container recreation.** The container signature includes the image ID. After retagging
  a rebuilt image (new ID, same contract) the next run recreated the container (`.Image`
  changed, newer `Created`), then completed.
- **First-party providers**, offline inside the image via Hermes's own resolver:
  `xai` and `openrouter` resolve the key from the profile `.env`. Hermes has no provider
  called `openai`; Open Harness now writes `openai-api`, which resolves `OPENAI_API_KEY`.
- **Explicit endpoint on a first-party provider.** Hermes ignores `base_url` on its native
  providers (a proxy for xAI still resolved to `api.x.ai`), so any explicit endpoint now
  takes the custom path. Hermes also refuses to hand a native provider's variable to a
  custom endpoint, so the credential is written under `OPEN_HARNESS_MODEL_API_KEY` and
  `key_env` names that. Live run: provider `xai`, credential saved as `XAI_API_KEY`,
  endpoint set to the local server — the request arrived as `Bearer xai-PROXY-…`.
  (The offline resolver reports a placeholder for this path even on a copy of a profile
  that provably sent the key; treat the gateway run as authoritative for custom endpoints.)
- **State directory.** `harness setup` on a simulated fresh checkout on the unshared drive
  chose `~/.open-harness/<project>`, recorded it in `.env`, and stayed silent on the next
  run; on this checkout, which already holds state, it changed nothing.
- **Cheap rebuilds.** `runtime/hermes/Dockerfile` now installs Open Harness files after the
  upstream layers and passes `docker build --check`. It was **not** built end to end on
  this machine: a from-scratch build does not fit on the root disk. The labeled image was
  produced with `runtime/hermes/extension/Dockerfile.patch`, which shares the label.
- Suites: 93 node tests, Playwright 36/36 desktop+mobile, `tsc`, `eslint`, `vinext build`.

## Still pending

Superseded by the two September 25 passes above, which covered paid-provider inference,
filesystem isolation, process-tree termination, crash recovery, named-agent teamwork, task
boards, scheduled runs and approvals. Still not exercised against a real runtime: real
third-party MCP servers, Direct Computer Access, native subagent restrictions, a full
from-scratch build of the reordered Dockerfile, and the broader code-repair, browsing and
durable skill-use scenarios.

The deterministic control and browser suites still run under `OPEN_HARNESS_MOCK=1` and
do not by themselves establish live acceptance.

## Agent profile upgrade verification — September 14, 2026

Verified with Node 22 and the pinned Hermes source interface (`v2026.9.11`,
`939e45c91d751fadd94dcd1b873ac3cb44846213`).

- `npm test`, including persistent profile revisions, independent model overrides,
  inheritance, stale saves, next-task snapshots, explicit empty grants, credential
  separation, MCP inventory retention, stream completion, provider errors, and scoped
  Unix coordination sockets.
- Seven Python policy tests for allowed and denied dispatch, nested code-tool dispatch,
  model schema filtering, forced disabled choices, and fail-closed behaviour.
- Playwright across desktop and mobile, covering the editor tabs, Save/Cancel, prompt
  switches, tool grants, inline MCP configuration, failed-save retry, reload
  persistence, stale-save recovery and keyboard navigation.
- `npm run lint`, `npm run typecheck`, `npm run build` and `git diff --check`: passed.
