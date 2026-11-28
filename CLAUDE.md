# Open Harness

<!-- Kept byte-identical across the contributor instruction files below the title. -->

## Native application

The root Cargo workspace is the application entry point. `cargo run -- serve` launches the Rust coordinator, the server-rendered dashboard, and its colocated worker. Local and remote workers execute Hermes, Claude Code, Codex, OpenCode, Pi, and OpenHands headlessly. Use `cargo test --workspace --locked`, `cargo fmt --all --check`, and `cargo clippy --workspace --all-targets --locked -- -D warnings` for native changes. The legacy TypeScript source and its compatibility suites are retained in this checkout. Its Node version, generated bundle, desktop settings, and launch instructions below apply when working on that earlier implementation.

## TypeScript release reference

MIT-licensed, local-first named-agent workspace. Each named agent runs in a managed container through
Hermes (the default), OpenCode, or a compatible custom harness behind a loopback-only
Node.js control service. The browser is only a client — closing it must never cancel active work.
Pre-1.0 (`0.4.0-beta.1`). Repo: `sflow-hub/OPEN-HARNESS`. Not affiliated with xAI or Nous Research.

The integration stays behind gateway adapters and does not modify Hermes's reasoning loop.
See `docs/HARNESSES.md` for harness packages, configuration, upload limits, and runner compatibility.
Hermes is pinned to `v2026.9.11`, commit `939e45c91d751fadd94dcd1b873ac3cb44846213`
(attribution in `runtime/hermes/NOTICE.md`).

## Hard requirement: Node 22.13+

The coordinator imports `node:sqlite`, which does not exist before Node 22.13. `.nvmrc` pins
`22.13.0`, `.npmrc` sets `engine-strict=true`, and `runtime/check-node.mjs` guards `predev`,
`prebuild`, `pretest`, and `preharness:serve`. An unsatisfied engine surfaces as a wall of
unrelated-looking failures, so check the Node version before debugging anything else.

Docker is required for anything past the mock runtime. Python 3.12 is used for the policy
middleware tests.

## Commands

```bash
npm ci
npm run harness:doctor   # Node version, port, Docker, pinned Hermes image, desktop capability
npm run harness:setup    # prepare/rebuild the pinned Hermes image and state dir
npm run dev              # starts Docker, the control service (--watch), and vinext dev
```

Dashboard at `http://localhost:3000`; coordinator defaults to port 4317
(`OPEN_HARNESS_PORT` to change).

Verification, in the order CI runs it:

```bash
npm test          # node:test over tests/*.test.ts, sets OPEN_HARNESS_MOCK=1, no paid inference
npm run typecheck # tsc --noEmit
npm run lint      # eslint
npm run build     # vinext build + desktop/fix-standalone.mjs
npx playwright install chromium && npm run test:browser
```

`.github/workflows/ci.yml` keeps Linux/macOS/Windows test and Tauri debug-build jobs;
Playwright runs on Ubuntu 24.04. Linux remains the supported beta installation.
`.github/workflows/runtime.yml` also exercises actual Docker/Compose, tools, persistent
workflows and the private desktop without paid inference. Playwright coverage is expected
for changes under `components/` or `app/`. See `ROADMAP.md` for platform limitations.

Service lifecycle: `harness:install-service`, `harness:start`, `harness:stop`,
`npm run harness -- status`. Desktop: `desktop:prepare`, `desktop:dev`, `desktop:build`.

## Layout

| Path | Responsibility |
| --- | --- |
| `runtime/service.ts` | Coordinator API, queue, schedules, approvals, runner dispatch, migration, handoffs (largest file in the repo) |
| `runtime/runner.ts` | Outbound runner polling, execution, durable result delivery, remote controls |
| `runtime/machines.ts` | Pairing, scoped credentials, machine health, commands, reservations, transfers |
| `runtime/agent-runtime.ts` / `runtime/harness-registry.ts` | Harness adapters, pinned installations, and machine-specific catalogs |
| `runtime/agent-assets.ts` / `runtime/agent-files.ts` | Resumable private file uploads, encrypted runner delivery, installation jobs, and asset migration |
| `runtime/hermes.ts` | Hermes TUI gateway JSON-RPC adapter and container lifecycle |
| `runtime/db.ts` | SQLite schema, runs, events, approvals, recovery state |
| `runtime/profiles.ts` | Profile validation, revisions, inheritance, migration, run snapshots |
| `runtime/profile-runtime.ts` | Runtime catalogs, connection checks, configuration compiler, profile-home writer |
| `runtime/tasks.ts` / `runtime/teams.ts` | Task board and team scoping |
| `runtime/workspace-folders.ts` / `runtime/folder-list.ts` | Lasting per-agent host-folder access (the Folders screen); shared folder validation for it and project folders |
| `runtime/secrets.ts` / `runtime/credentials.ts` | Restricted credential storage; saved-credential metadata, rotation, deletion |
| `runtime/decisions.ts` | Advisory decisions (choose, rank, classify, score, check) from a System One decision model (TypeSafe Jev); off by default; `/v1/decide` for the operator, the `decide` agent tool behind the Decisions permission |
| `runtime/cli.ts` | `npm run harness -- <command>` (setup, start, stop, doctor, status, install-service) |
| `runtime/readiness.ts` | Host capability probing (async and bounded by design) |
| `runtime/hermes/Dockerfile` | Reproducible pinned Hermes/Python 3.12 runtime |
| `runtime/hermes/extension/` | Managed Hermes tool-allowlist middleware (Python) |
| `runtime/hermes/coordination.mjs` | The agent-side MCP server: task, project, routines, directory, runs, decision, handoff, routine and API tools |
| `app/page.tsx` | The whole workspace UI — runtime, skills, memory, files, routines (~2.5k lines) |
| `app/api/local/[...path]/route.ts` | The dashboard's proxy to the local coordinator; the only transport besides a direct loopback call |
| `components/` | `agent-settings`, `onboarding`, `credential-manager`, `decision-settings`, `task-manager`, `team-manager`, `folder-manager` |
| `lib/` | Shared types and browser-side client (`control-client.ts`), profile/provider/crypto helpers |
| `src-tauri/` | Desktop shell, tray, sidecar, signed updater |
| `desktop/*.mjs` | Build and packaging scripts for the desktop bundle |
| `compose.yaml` | No-Node self-hosted dashboard, coordinator, private container engine |

## Reserved filename: SOUL.md

`SOUL.md` is Hermes's per-agent system prompt and is **generated, never authored in the repo**.
`prepareProfile` in `runtime/profile-runtime.ts` writes it into each agent's profile home
beside `config.yaml` and `.env`. `agentInstructions` composes it: a "Who you are" block
(name, role, description), then `profile.prompt.text` when `profile.prompt.enabled` is true,
then a "Folders you can use" notice when the run mounts host folders, then any API grants.
Identity, folders and grants are written even with instructions disabled. OpenCode and custom
harnesses receive the same text as `managed/instructions.md`. `runtime/runner.mjs` contains
the bundled copy of the same logic.

Pinned Hermes scans SOUL.md for prompt injection and replaces the whole file with a
`[BLOCKED ...]` notice on any match, and ordinary instructions match ("pull new tasks",
"check in with ..."). `prepareProfile` therefore writes the file's sha256 to the read-only
`policy.json` as `soulSha256`, and `runtime/hermes/soul_trust.py` (installed by
`managed_entry.py`) skips the scan only for a SOUL.md whose bytes match it. Project
`AGENTS.md`/`CLAUDE.md` files and a SOUL.md the agent rewrote are still scanned.

Consequences:

- Do not create a `SOUL.md` at the repo root or in any source folder. It would not be read,
  and it reads as a contradiction of the runtime contract.
- To change an agent's instructions, edit the profile: **Agent settings → System prompt**, or
  the `prompt.text` field on the stored profile. The cap is 12,000 characters, enforced in
  `validateProfile`. Disabling instructions preserves the text but writes a `SOUL.md` that
  holds only the identity, folder and API notices.
- Every profile save creates a revision. Active work keeps its original revision; queued work
  snapshots the latest profile when it starts.
- `tests/agent-instructions.test.ts`, `tests/agent-profiles.test.ts` and
  `tests/project-folders.test.ts` assert the generated file's contents, so changes to this
  plumbing show up there first. `tests/soul-trust-test.py` covers the Hermes trust patch.

## Generated — do not hand-edit

- `runtime/runner.mjs` is committed but esbuild output; regenerate with `npm run runner:bundle`.
  ESLint ignores it.
- `src-tauri/resources/bundle/` is produced by `desktop/prepare-runtime.mjs`.
- `dist/`, `.next/`, `.vinext/`, `src-tauri/gen/`, `src-tauri/binaries/`,
  `.open-harness*/`, `test-results/`, `tsconfig.tsbuildinfo`.

## Conventions

- Dense, direct code over added abstraction. Multi-statement single lines and inline
  validation are deliberate — `runtime/profiles.ts` is representative. Match the file
  you are editing rather than introducing a new convention.
- Keep changes minimal and scoped. Comments explain *why*, never *what*.
- TypeScript strict, ESM (`"type": "module"`), `@/*` maps to the repo root.
- The build runs through `vinext` (a Vite-based Next 16 runner), not the Next CLI. `next`
  itself is a devDependency for one type import. `next.config.ts` still supplies
  `output: "standalone"` because the desktop installer embeds that server output.
- User-facing strings are plain-language and non-blaming; failed saves preserve the user's
  draft and name the conflicting revision.

## Security-sensitive areas

Trust model is a single trusted operator (`SECURITY.md`). Container isolation is the primary
boundary; the host home directory, Docker socket, and other agents' private directories are
never mounted. The dashboard operator token authorizes arbitrary run creation, host-path
mounts and agent execution. Direct host-native bootstrap is loopback-only and `Host`-header checked;
every bootstrap through the dashboard proxy requires authentication or one-use pairing.
Compose requires a one-use pairing code from the coordinator CLI. Its public
readiness endpoint returns only `{ok:true}`.

Call out changes to authentication, the bootstrap token, container isolation, runner pairing,
or credential storage explicitly in the PR description. Never open a public issue or PR for a
suspected vulnerability.

Credentials are written only to managed profiles and are never returned to the browser,
diagnostics, or normal exports. Desktop uses the OS vault (Windows account encryption, macOS
Keychain, Linux password vault); headless falls back to AES-256-GCM encrypted `.open-harness/secrets.json` and
a separate key (`secrets.json.key` or `OPEN_HARNESS_ENCRYPTION_KEY`), mode `0600`.
Preserve the original encryption key when backing up or restoring state; see `docs/CREDENTIALS.md`.

Tool choices compile into an explicit allowlist, including an empty list when everything is
off. Newly discovered tools start disabled. The managed Hermes extension filters model-visible
tools and rejects disallowed dispatch. `plugins.enabled` must stay a list containing
`open_harness_policy`; any other shape silently gates the policy extension off and every run
dies at startup.

## Verification state

The ordinary Node and browser suites use a mocked Hermes runtime (`OPEN_HARNESS_MOCK=1`).
Actual Ubuntu ARM64 checks on September 25, 2026 additionally exercised the pinned runtime,
approval denial/approval, encrypted runner credentials and rotation, persistent memory and
skills, shared-team handoffs, scheduled dispatch across restart, and the private Chromium
desktop. Those integration fixtures use a scripted local provider, so they establish tool
and transport behavior, not model reasoning. Earlier paid-provider evidence remains recorded
separately. `runtime/VERIFICATION.md` is the evidence record; update it after real checks.
`npm run decide:eval` (opt-in: `OPEN_HARNESS_LIVE_EVAL=1` and `TYPESAFE_API_KEY`) is the only check of
decisions against the real decision service; everything else uses the mock backend.
Private agent desktops require a Linux runner with Docker. Legacy native Direct Computer
Access and Existing desktop modes are disabled; third-party MCP integrations and signed
installers need separate platform acceptance.

## Gotchas

- Only `npm run dev` and `npm run harness:serve` load `.env`. Other entry points need the
  variables exported in the shell.
- `OPEN_HARNESS_STATE_DIR` should stay commented out rather than set empty. `harness:setup`
  fills it with `~/.open-harness/<project>` when Docker Desktop cannot read the project
  folder, because agents started there would never receive their profile or credential.
- Private and Compose agent containers run `--restart unless-stopped`. Native selected-folder
  containers use `--restart no`; each new admission verifies mounts in a fresh inert container
  before starting the desktop or agent, and requires Docker on the same Linux kernel.
  Quit from the tray or stop the coordinator with Ctrl-C so it cleans up its containers. For manual recovery,
  inspect the `open-harness.state` label and mounts before stopping specific container IDs;
  another workspace may share the Docker daemon.
- Concurrency caps: one task per agent, two top-level runs you started, four total including
  delegated subagents. A run paused on an unanswered approval still holds its slot.
- Delegation depth is limited to two; cyclic handoffs are rejected.
- Pass the agent image to Docker only as `HERMES_IMAGE` from `runtime/readiness.ts`, which
  `qualifiedImage` turns into a full reference (`docker.io/library/open-harness-hermes:<tag>`).
  Docker Desktop's containerd image store can reject the short `open-harness-hermes:<tag>`
  with "No such image" while listing it, which the app used to report as first-time setup.
  Readiness offers setup only when Docker answers "No such image"; any other failure is
  reported as Docker not responding. User-facing setup instructions must name a screen that
  exists: **Workspace settings → Run setup again**.
- `runtime/hermes/coordination.mjs` is copied into each run's managed folder, so changing it needs
  no image rebuild or `RUNTIME_CONTRACT` bump. Hermes caches tool schemas keyed only on the MCP
  command and args, so `prepareProfile` passes `--schema=<hash>` to refresh them. Keep every schema
  field explicitly typed: Hermes turns an object with no `properties` into an empty one, and models
  then always send `{}`. Return coordinator refusals (4xx) as ordinary results, never JSON-RPC errors
  or `isError` results: pinned Hermes counts both as strikes and blocks the whole server after three.
- ChatGPT (Codex) sign-in tokens stay on the coordinator. Never add them to
  `selectedSecrets`, runner payloads, MCP environment bindings or API grants;
  `checkCredentialSelections` and `credentialApi` refuse them.
- Coordination credentials are bound to one agent, run and computer. Always send the run ID
  header; there is no active-run fallback or reusable per-agent token. Probes carry no credential.
  Revoked runners and terminal runs cannot authenticate; stop work before upgrading this contract.
- Hermes gives an MCP tool call 300 seconds. A coordination route must answer within that, so a
  named handoff waits at most `OPEN_HARNESS_HANDOFF_WAIT_MS` (240 s) and then returns
  `done:false` with the run ID; calling `delegate_named_agent` with only that `runId` keeps waiting.
- After changing the Hermes adapter or the policy extension, rebuild with
  `npm run harness:setup` — existing containers must use the new image and its read-only
  managed-policy mount.
- Set `OPEN_HARNESS_SKIP_DOCKER_START=1` only when another process manages the daemon.
- On Linux the installed service logs to the journal:
  `journalctl --user -u open-harness.service -f`.
