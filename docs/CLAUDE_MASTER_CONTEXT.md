# Open Harness master context for Claude

Prepared November 7, 2026. Use this as the starting context for work on Open Harness. Inspect the current checkout before editing: this is an active development tree with substantial work beyond its last local commit.

## Repository locations

**Primary local repository:**

```text
/Volumes/My Shared Files/VM 1/Open Harness
```

**GitHub repository:** [sflow-hub/OPEN-HARNESS](https://github.com/sflow-hub/OPEN-HARNESS)

**Configured origin:** `https://github.com/sflow-hub/OPEN-HARNESS.git`

Start here when local filesystem access is available:

```bash
cd "/Volumes/My Shared Files/VM 1/Open Harness"
pwd
node --version
git status --short
git branch --show-current
git remote -v
git log -5 --oneline
```

On November 7, the local branch was `pre-live-testing-snapshot`, with HEAD at `357fd76` (October 3, 2026, “Skip POSIX mode checks on Windows and expect resolved state paths”). Many later features and evidence records are modified or untracked locally. A clone of GitHub or a checkout of this commit alone must not be assumed to contain that work. The remote address above is verified from local Git configuration; recheck GitHub state when a task depends on current upstream contents.

If you cannot access the local path from your Claude environment, state that limitation. Request the relevant current files or a source snapshot before implementing changes that depend on local work. Do not silently substitute an older cloud clone. A local filesystem path is usable only from an environment where that volume is mounted.

## Read these files first

Paths below are relative to the local repository root unless an absolute path is shown.

1. `CLAUDE.md` and `AGENTS.md`: contributor instructions, runtime constraints, commands, security rules and generated-file boundaries. Their contributor bodies are intentionally kept identical.
2. `COORDINATION.md`: file ownership, requests and delivery log. Read before every edit, and record deliveries according to its protocol.
3. `README.md`: installation, operator workflows, models, pairing and architecture.
4. `docs/PRODUCT_IMPLEMENTATION_STATUS.md`: the November 2 product candidate, implemented milestones and remaining launch inputs.
5. `runtime/VERIFICATION.md`: dated evidence, failures, subsequent repairs and acceptance limits. Read the latest relevant entries, including November 2 runtime repair and November 3 OAuth integration.
6. `SECURITY.md`, `ROADMAP.md` and `docs/EXPERIENCE_ACCEPTANCE.md`: trust boundaries, maturity and release requirements.
7. `docs/TEAMMATE_WORKFLOWS.md`, `deploy/private-server/README.md`, `deploy/control-plane/README.md`, `deploy/control-plane/OPERATIONS.md` and `apps/mobile/README.md` as relevant to the task.

Some documents describe earlier baselines. For example, the opening of `COORDINATION.md` says this shared folder has no `.git` or `node_modules` and is based on September 25 source. That description is historical: Git is present in the November 7 checkout. Its ownership and collision-avoidance protocol still matters. Likewise, the November 2 status document describes the image-build blocker before the later same-day repair. Use actual files and later dated evidence to resolve status differences; do not treat old summaries as the current state.

## Product and direction

Open Harness is an MIT-licensed, local-first workspace for persistent named AI teammates, inspired by Grok Bot. It is independent software, unaffiliated with xAI or Nous Research. The package version is `0.4.0-beta.1`.

Each named agent runs as a persistent Hermes worker behind a Node.js coordinator. The browser is a client. Closing a browser must never cancel active work, schedules or pending approvals. Durable execution, recoverable history, explicit permissions and independent checking of results are central product requirements.

The established beta path is one trusted operator using a browser with the coordinator and agent runtimes in Linux Docker containers. Docker Desktop is the Mac/Windows route to that Linux environment; physical platform acceptance and signed installers have separate gates.

The local product candidate expands this into a conversational assistant front door, standing responsibilities, reviewed workflows, connected-account actions, desktop supervision, mobile clients and a provider-neutral managed control plane. Preserve the local-owner experience while building those paths. Managed cloud remains gated on a production provisioning adapter, configuration and live acceptance. Do not represent source contracts or mocked checks as a launched hosted service.

The intended experience is that a person describes a goal, connects only the needed accounts, reviews meaningful decisions, receives checked results and can correct or teach a repeatable procedure. Internal implementation details should appear in the interface only when they help the person act.

## Architecture

Hermes is pinned to `v2026.9.11`, commit `939e45c91d751fadd94dcd1b873ac3cb44846213`. Attribution is in `runtime/hermes/NOTICE.md`. Open Harness integrates through a gateway adapter and managed policy extension; it does not modify Hermes's reasoning loop.

The local browser talks through `app/api/local/[...path]/route.ts` to the coordinator, normally on loopback port `4317`. The dashboard normally runs on `http://localhost:3000`. SQLite owns local profiles, runs, events, approvals and recovery state. Paired runners poll outward, execute admitted work and deliver durable results. The managed candidate adds authenticated control-plane and outbound relay paths.

| Area | Main files and responsibilities |
| --- | --- |
| Coordinator | `runtime/service.ts`: API, admission, queues, schedules, approvals, recovery and orchestration. |
| Execution | `runtime/hermes.ts`, `runtime/runner.ts`, `runtime/machines.ts`: gateway, container lifecycle, remote work, pairing, scoped credentials, transfers and machine health. |
| State and profiles | `runtime/db.ts`, `runtime/profiles.ts`, `runtime/profile-runtime.ts`: SQLite, validation, revisions, inheritance, configuration and profile homes. |
| Policy and coordination | `runtime/hermes/extension/`, `runtime/hermes/coordination.mjs`, `runtime/coordination-socket.ts`, `runtime/tool-reviews.ts`: tool policy, scoped agent transport and review. |
| Credentials and models | `runtime/secrets.ts`, `runtime/credentials.ts`, `runtime/codex-oauth.ts`, `runtime/hermes/model-proxy.mjs`, `lib/provider.ts`, `lib/codex.ts`: protected credentials, providers and account model bridge. |
| Product orchestration | `runtime/responsibilities.ts`, `runtime/workflows.ts`, `runtime/actions.ts`, `runtime/connections.ts`, `runtime/connection-events.ts`, `runtime/outcomes.ts`: standing work, reviewed procedures, connected actions, event catch-up and outcome review. |
| Workspace and continuity | `runtime/workspaces.ts`, `runtime/setup.ts`, `runtime/readiness.ts`, `runtime/backups.ts`: identity, setup/repair, capability checks and encrypted migration/restore. |
| Desktop and delivery | `runtime/desktop-control.ts`, `runtime/desktop-stream.ts`, `runtime/runner-desktop.ts`, `runtime/delivery.ts`, `runtime/native-push.ts`, `desktop/stream-proxy.mjs`: supervision, streaming, ephemeral input and notifications. |
| Browser application | `app/page.tsx`, `components/assistant-workspace.tsx`, `components/onboarding.tsx`, settings, workflow, review, desktop and account components. Shared clients and types are under `lib/`. |
| Managed candidate | `control-plane/`: accounts, membership, identity, workspace lifecycle, provider contract, relay, model gateway, usage and billing. `runtime/workspace-relay.ts` links workspaces outward. |
| Native clients | `src-tauri/` and `desktop/`: desktop shell and packaging. `apps/mobile/`: Expo iOS/Android source, authentication, billing and workspace interface. |
| Deployment and release | `compose.yaml`, `Dockerfile.coordinator`, `Dockerfile.control-plane`, `Dockerfile.cloud-dashboard`, `deploy/`, `release/`, `.github/workflows/`. |
| Evidence and testing | `tests/*.test.ts`, `tests/browser/`, `tests/ubuntu-runtime/`, `runtime/VERIFICATION.md`, `scripts/experience-acceptance.ts`. |

## Runtime contracts to preserve

- Node **22.13+** is mandatory because the coordinator imports `node:sqlite`. `.nvmrc` pins `22.13.0`; `.npmrc` uses `engine-strict=true`. Check Node before debugging apparent runtime failures. The November 7 shell reports `v26.10.0`.
- Docker is required beyond mock execution. Policy middleware uses Python 3.12. Real private desktops require Linux with Docker.
- One task may run per agent. Defaults allow two operator-started top-level runs and four total executions including delegated work. Unanswered approvals retain their slots. Delegation depth is limited to two and cyclic handoffs are rejected.
- Profiles are authoritative in SQLite. Every save creates a revision. Active work keeps its original profile snapshot; queued work snapshots the latest revision when admitted.
- `SOUL.md` is generated per agent by `prepareProfile` in `runtime/profile-runtime.ts`. Never author one at the repo root or in source directories. Change instructions through profile `prompt.text` or Agent settings. The limit is 12,000 characters. Disabled instructions preserve their text but generate an empty file.
- Tool selection compiles to an explicit allowlist, including `[]` when everything is off. New tools start disabled. `plugins.enabled` must remain a list containing `open_harness_policy`.
- The coordinator owns scheduling; managed profiles disable Hermes's independent cron executor. Stopping a parent must stop descendants and their sessions/processes. Recovery must not silently repeat uncertain external effects.
- Legacy native Direct Computer Access and Existing desktop profiles cannot execute. Private container desktops are the supported computer-control boundary.

## Security requirements

Read `SECURITY.md` before touching authorization, credentials, mounts, runner admission, desktop control, backup or connected actions.

The established local trust model is one trusted operator. Its operator token permits arbitrary run creation and selected-folder grants. Host-native bootstrap requires loopback and a checked `Host` header. Compose uses a short-lived, single-use pairing code; its unauthenticated readiness endpoint returns only `{ok:true}`. Remote human access requires authenticated HTTPS.

Per-agent containers provide the primary filesystem boundary. Never mount the host home, Docker socket or another agent's private directories into an agent. Selected-folder grants must preserve explicit roots and access ceilings; native grants require the same Linux kernel as Docker and fresh mount verification. Shared workspace files are intentionally shared. Tool switches are not a network firewall.

Ordinary API keys may be placed only in the selected managed profiles. Coordinator credential stores must not reach browser metadata, diagnostics or normal exports. Desktop storage uses the OS vault where available; headless fallback is restricted `secrets.json` with mode `0600`.

ChatGPT OAuth account tokens have a stricter boundary: access, refresh and ID tokens stay in the coordinator vault or restricted store. Agent containers and runners use the scoped model bridge and never receive that account session. Do not merge the separate `openai-codex` provider into the OpenAI API-key flow.

Shared/managed candidate clients use short-lived workspace and actor context with membership rechecks; they do not receive the local operator bootstrap token. Named Google/GitHub connections have separate private storage and explicit sharing. Connected write actions bind the account, resource, operation and reviewed intent; retain receipts and independent readback. Uncertain effects block replay. Routine grants are bounded and tied to passed workflow revisions; they do not authorize unrelated shell/browser operations.

Human desktop input requires an exclusive controller lease. Remote input is encrypted, expires and must not enter the durable command spool. Screenshots and raw typed values must not enter demonstration records. Shared browser cookies require explicit opt-in and serialized use.

Call out changes to authentication, bootstrap authority, container isolation, runner pairing or credential storage in PR descriptions. Report suspected vulnerabilities privately; never create a public issue or PR disclosing one.

## Development workflow

Read `COORDINATION.md` before each edit. Respect current file ownership and requests. Announce changes to its shared-file list before editing; preserve the other agent's sections. Later log entries may supersede the original ownership baseline. If ownership is unclear, inspect those entries before changing the file.

Re-read a file immediately before writing it and merge concurrent changes. Preserve existing modified and untracked work. Do not reset, clean, replace the checkout, delete shared-folder duplicates or overwrite files from an old clone as routine cleanup. Directories such as `Claude outputs/` and duplicate names such as `COORDINATION 2.md` are existing artifacts, not automatically authoritative source.

Match the edited file's style: TypeScript strict, ESM, `@/*` imports rooted at the repo. Favor scoped, direct changes. Dense code and inline validation are deliberate. Failed UI saves must preserve the draft and identify conflicting revisions. User-facing language should be clear and non-blaming.

The application builds with **vinext**, not the Next CLI. `next.config.ts` retains standalone output for desktop packaging.

Never hand-edit generated output:

- `runtime/runner.mjs`: regenerate with `npm run runner:bundle` after source changes affecting its bundle.
- `src-tauri/resources/bundle/`: generated by `desktop/prepare-runtime.mjs`.
- `dist/`, `.next/`, `.vinext/`, `src-tauri/gen/`, `src-tauri/binaries/`, `.open-harness*/`, `test-results/` and `tsconfig.tsbuildinfo`.

After Hermes adapter or policy-extension changes, rebuild with `npm run harness:setup` and verify containers use the new image and managed-policy mount. A source change alone does not update existing runtimes.

## Commands

From the local repository root:

```bash
npm ci
npm run harness:doctor
npm run harness:setup
npm run dev
```

Do not reinstall dependencies or start services merely to read the repository. When execution is needed, doctor checks Node, ports, Docker, image and desktop capability. `OPEN_HARNESS_PORT` changes the coordinator port. Keep `OPEN_HARNESS_STATE_DIR` commented out rather than assigning an empty string. Setup may choose a home-directory state location when Docker Desktop cannot read the project path.

Run verification in the documented CI order when code changes require it:

```bash
npm test
npm run typecheck
npm run lint
npm run build
npx playwright install chromium
npm run test:browser
```

Changes under `app/` or `components/` require relevant Playwright coverage. Ordinary Node/browser suites use mock Hermes and no paid inference. Real integration needs separate acceptance. Mobile source has its own `npm ci`, `npm run typecheck` and `npm run export` inside `apps/mobile/`.

Useful additional commands are `npm run runner:bundle`, `npm run harness -- status`, `npm run harness:install-service`, `npm run harness:start`, `npm run harness:stop`, `npm run desktop:prepare`, `npm run desktop:dev`, `npm run desktop:build`, `npm run cloud:serve` and `npm run workspace:relay`. Managed commands require the deployment configuration in `deploy/control-plane/`.

The contributor guide documents automatic `.env` loading for `dev` and `harness:serve`. Check the current script before assuming any other entry point loads it; the managed scripts explicitly specify their env-file behavior.

Quit through the tray or stop the coordinator cleanly so it cleans up owned containers. For manual container recovery, verify the `open-harness.state` label and mounts first; other workspaces may share the daemon. Never stop all containers indiscriminately.

## Latest recorded verification

These are historical results recorded in `runtime/VERIFICATION.md`, not a claim that the November 7 dirty tree has just passed a fresh run.

**November 2 Linux ARM64 repair:** a real contract-8 image was built after repairing signed snapshot bootstrap handling. The Node suite had 359 tests, 356 passed and three skipped. Typecheck, build and lint passed with five existing warnings; 198 browser checks passed. The Ubuntu runtime suite had 165 tests, 31 historical-evidence skips and no failures. Six real smoke fixtures passed for gateway/tools, persistent workflows, sandbox, private desktop, desktop control and installed runner. Those fixtures used scripted local providers and establish actual tool/transport behavior, not model reasoning.

**November 3 OAuth integration:** the recorded Node suite had 366 tests, 363 passed and three skips, followed by eight focused OAuth/service checks. Typecheck, build, lint with five existing warnings and 210 browser checks passed on Ubuntu ARM64. A real coordinator and pinned Hermes container completed token refresh, account-model discovery, Responses streaming and a file-write with independent readback against a scripted provider. Account tokens were absent from generated agent files and browser credential metadata. This does not establish live ChatGPT authorization or account entitlement.

The final OAuth fixture used image `sha256:f4d9c8ac0ef7b08215308192117e2793eb743053307560ddedb99f84fb19be07`. It is a recorded test image, not evidence of a published or security-accepted release digest.

Some historical sections record earlier successful soaks; later source and runtime changes still require their own applicable gates. Do not generalize an old receipt to the current image or silently mark earlier security findings resolved.

## Remaining acceptance and launch work

The complete product candidate has not been accepted or launched. Key remaining work includes:

- Current-image security scanning and applicable soak/release gates; published immutable image and archive acceptance.
- Selecting and implementing the production VM provisioning adapter, then accepting real PostgreSQL/OIDC, isolation, operations and capacity behavior.
- Real Google/GitHub registrations and scopes, dedicated-account authorization/read/write/revocation tests and downtime recovery.
- Real model quality, external-effect auditing, failure injection and latency measurements.
- Billing, model rates, push, signing, updater and store configuration; physical installation, notifications, reconnect, handoff and rollback.
- Dedicated managed-account sign-in in the Tauri shell, native SDK linking/signing and physical iOS/Android acceptance.
- Encrypted S3 backup and fresh-host restoration, private alpha and invite-only beta.

The complete-experience matrix requires **180 live trials**: nine workflows, ten trials each, across two editions. Each trial needs independent destination checks, outcome review and effect-audit evidence. The required performance evidence includes p95 acknowledgement within one second and prewarmed dispatch within two seconds on documented hosts/networks. These are acceptance targets, not measured product claims. Release evidence must match the exact source revision; mocked tests and JavaScript exports cannot satisfy physical or live gates.

## Instructions for the next Claude session

Work from the current local repository when accessible. First read the contributor instructions, coordination log and latest relevant verification entries. Inspect Git status and the actual files affected by the user's task. Preserve existing work, respect ownership, implement the requested scope and run proportionate checks. Record delivery and real verification results without converting scripted, mocked or historical evidence into broader claims.

This context is a handoff, not a standing request to deploy, publish, select a cloud provider or change unrelated files. Continue with the user's next concrete task.
