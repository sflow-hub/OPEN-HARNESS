# Open Harness (contributor guide)

<!-- Kept byte-identical across the contributor instruction files below the title. -->

MIT-licensed, local-first named-agent workspace. Each named agent runs as a persistent
[Hermes](https://hermes-agent.nousresearch.com) worker behind a loopback-only Node.js
control service. The browser is only a client — closing it must never cancel active work.
Pre-1.0 (`0.4.0-beta.1`). Repo: `sflow-hub/OPEN-HARNESS`. Not affiliated with xAI or Nous Research.

The integration stays behind a gateway adapter and does not modify Hermes's reasoning loop.
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

`.github/workflows/ci.yml` runs test/typecheck/lint plus a Tauri debug build and the
Playwright suite, on Ubuntu 24.04 only. Playwright coverage is expected for changes under
`components/` or `app/`. macOS and Windows are deferred — see `ROADMAP.md` for why.

Service lifecycle: `harness:install-service`, `harness:start`, `harness:stop`,
`npm run harness -- status`. Desktop: `desktop:prepare`, `desktop:dev`, `desktop:build`.

## Layout

| Path | Responsibility |
| --- | --- |
| `runtime/service.ts` | Coordinator API, queue, schedules, approvals, runner dispatch, migration, handoffs (largest file in the repo) |
| `runtime/runner.ts` | Outbound runner polling, execution, durable result delivery, remote controls |
| `runtime/machines.ts` | Pairing, scoped credentials, machine health, commands, reservations, transfers |
| `runtime/hermes.ts` | Hermes TUI gateway JSON-RPC adapter and container lifecycle |
| `runtime/db.ts` | SQLite schema, runs, events, approvals, recovery state |
| `runtime/profiles.ts` | Profile validation, revisions, inheritance, migration, run snapshots |
| `runtime/profile-runtime.ts` | Runtime catalogs, connection checks, configuration compiler, profile-home writer |
| `runtime/tasks.ts` / `runtime/teams.ts` | Task board and team scoping |
| `runtime/secrets.ts` / `runtime/credentials.ts` | Restricted credential storage; saved-credential metadata, rotation, deletion |
| `runtime/cli.ts` | `npm run harness -- <command>` (setup, start, stop, doctor, status, install-service) |
| `runtime/readiness.ts` | Host capability probing (async and bounded by design) |
| `runtime/hermes/Dockerfile` | Reproducible pinned Hermes/Python 3.12 runtime |
| `runtime/hermes/extension/` | Managed Hermes tool-allowlist middleware (Python) |
| `runtime/hermes/coordination.mjs` | Agent-scoped named handoff and scheduling MCP tools |
| `app/page.tsx` | The whole workspace UI — runtime, skills, memory, files, routines (~2.5k lines) |
| `app/api/local/[...path]/route.ts` | The dashboard's proxy to the local coordinator; the only transport besides a direct loopback call |
| `components/` | `agent-settings`, `onboarding`, `credential-manager`, `task-manager`, `team-manager` |
| `lib/` | Shared types and browser-side client (`control-client.ts`), profile/provider/crypto helpers |
| `src-tauri/` | Desktop shell, tray, sidecar, signed updater |
| `desktop/*.mjs` | Build and packaging scripts for the desktop bundle |
| `compose.yaml` | No-Node self-hosted dashboard, coordinator, private container engine |

## Reserved filename: SOUL.md

`SOUL.md` is Hermes's per-agent system prompt and is **generated, never authored in the repo**.
`prepareProfile` in `runtime/profile-runtime.ts` writes it into each agent's profile home
beside `config.yaml` and `.env`, using `profile.prompt.text` when `profile.prompt.enabled` is
true and an empty file when it is false. `runtime/runner.mjs` contains the bundled copy of the
same logic.

Consequences:

- Do not create a `SOUL.md` at the repo root or in any source folder. It would not be read,
  and it reads as a contradiction of the runtime contract.
- To change an agent's instructions, edit the profile: **Agent settings → System prompt**, or
  the `prompt.text` field on the stored profile. The cap is 12,000 characters, enforced in
  `validateProfile`. Disabling instructions preserves the text but writes an empty `SOUL.md`.
- Every profile save creates a revision. Active work keeps its original revision; queued work
  snapshots the latest profile when it starts.
- `tests/agent-profiles.test.ts` asserts the generated file's contents, so changes to this
  plumbing show up there first.

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
never mounted. The dashboard bootstrap token authorizes arbitrary run creation, host-path
mounts, and direct OS execution, so it is loopback-only and `Host`-header checked.

Call out changes to authentication, the bootstrap token, container isolation, runner pairing,
or credential storage explicitly in the PR description. Never open a public issue or PR for a
suspected vulnerability.

Credentials are written only to managed profiles and are never returned to the browser,
diagnostics, or normal exports. Desktop uses the OS vault (Windows account encryption, macOS
Keychain, Linux password vault); headless falls back to `.open-harness/secrets.json` mode
`0600`.

Tool choices compile into an explicit allowlist, including an empty list when everything is
off. Newly discovered tools start disabled. The managed Hermes extension filters model-visible
tools and rejects disallowed dispatch. `plugins.enabled` must stay a list containing
`open_harness_policy`; any other shape silently gates the policy extension off and every run
dies at startup.

## Verification state

The automated suite runs against a mocked Hermes runtime (`OPEN_HARNESS_MOCK=1`).
Real-runtime passes on 2026-09-21/22 covered credential storage, profile preparation, plugin
loading, gateway startup, authenticated round trips to an OpenAI-compatible endpoint, stale
image detection, and state-directory choice. A third pass on 2026-09-25 added paid-provider
inference, a real file-writing task, event replay, filesystem isolation, process-tree
termination, crash recovery, and container reaping. Real MCP servers, Direct Computer Access,
an approval round trip, and named-agent handoff remain unverified.
`runtime/VERIFICATION.md` is the record; update it when a real-runtime check is performed.
`ROADMAP.md` tracks feature maturity — Direct Computer Access is the least mature path, and
the supported install is a local browser dashboard on Linux.

## Gotchas

- Only `npm run dev` and `npm run harness:serve` load `.env`. Other entry points need the
  variables exported in the shell.
- `OPEN_HARNESS_STATE_DIR` should stay commented out rather than set empty. `harness:setup`
  fills it with `~/.open-harness/<project>` when Docker Desktop cannot read the project
  folder, because agents started there would never receive their profile or credential.
- Agent containers run `--restart unless-stopped`. Quit from the tray or stop the coordinator
  with Ctrl-C; clean up orphans with
  `docker rm -f $(docker ps -aq --filter name=open-harness-)`.
- Concurrency caps: one task per agent, two top-level runs you started, four total including
  delegated subagents. A run paused on an unanswered approval still holds its slot.
- Delegation depth is limited to two; cyclic handoffs are rejected.
- After changing the Hermes adapter or the policy extension, rebuild with
  `npm run harness:setup` — existing containers must use the new image and its read-only
  managed-policy mount.
- Set `OPEN_HARNESS_SKIP_DOCKER_START=1` only when another process manages the daemon.
- On Linux the installed service logs to the journal:
  `journalctl --user -u open-harness.service -f`.
