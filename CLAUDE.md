# Open Harness

MIT-licensed, local named-agent workspace. Each named agent runs as a persistent
[Hermes](https://hermes-agent.nousresearch.com) worker behind a loopback-only Node.js control
service; the browser is just a client, so closing it does not cancel work. Ships as a Next.js
dashboard, a Tauri desktop app, an Android companion, and a self-hosted Compose stack.
Version `0.3.0`, pre-1.0 — see [ROADMAP.md](ROADMAP.md) for what is and isn't mature.

Not affiliated with xAI or Nous Research.

## Layout

| Path | Responsibility |
| --- | --- |
| [runtime/](runtime/) | Coordinator service, runner, Hermes adapter, SQLite, profiles, CLI. Has its own CLAUDE.md. |
| [app/](app/) | Next.js routes: dashboard page, `/api/control/[...path]` proxy, run/status endpoints |
| [components/](components/) | `agent-settings.tsx` (5-tab profile/computer editor), `onboarding.tsx`, `task-manager.tsx`, `hub-connect.tsx` |
| [lib/](lib/) | Shared browser/server code: `control-client.ts`, `agent-profile.ts`, `types.ts` (shipped default agents), `harness.ts`, `runner-crypto.ts` |
| [db/](db/), [drizzle/](drizzle/) | Hosted (Cloudflare D1) schema and migrations — separate from the local `node:sqlite` state |
| [src-tauri/](src-tauri/) | Desktop and Android shell. Has its own CLAUDE.md. |
| [desktop/](desktop/) | Build/packaging scripts for the desktop bundle, runner bundle, and release staging |
| [mobile/](mobile/) | Android signing config plus the `cloudflare:workers` stub used by the mobile build |
| [tests/](tests/) | `node --test` suites (mocked runtime) and `tests/browser/` Playwright specs |

Local coordinator state lives in `.open-harness/` (gitignored): `state.db`, `secrets.json`,
and generated per-agent `agents/<id>/profile/` directories. `.open-harness-local-test/` is
leftover state from a test run — treat both as disposable, never as source.

## Commands

```bash
npm ci
npm run harness:doctor     # node version, port, Docker, pinned Hermes image, desktop capability
npm run harness:setup      # build/pull the pinned Hermes image + policy extension
npm run dev                # UI + control service; http://localhost:3000
npm run dev:mock           # no Docker, no paid inference
```

Verification, all four expected clean before a PR:

```bash
npm test          # node --import tsx --test tests/*.test.ts, sets OPEN_HARNESS_MOCK=1
npm run typecheck
npm run lint
npm run build
npm run test:browser   # needed for components/ or app/ changes; npx playwright install chromium first
```

`runtime/VERIFICATION.md` covers the real-runtime checks the mock suite cannot do (container
isolation, process-tree termination, real providers, Direct Computer Access). Say in the PR
description which of those you actually ran.

## Things that will bite you

- **Node 22.13+ is mandatory.** The coordinator imports `node:sqlite`. `.nvmrc` pins it; the
  `predev`/`prebuild`/`pretest` guards fail early with a clear message.
- **`.env` is only loaded by `npm run dev` and `npm run harness:serve`.** Other entry points
  need the variables exported in the shell.
- Coordinator port defaults to `4317` (`OPEN_HARNESS_PORT`); the dashboard is `3000`.
- Tests run against an explicitly mocked Hermes (`OPEN_HARNESS_MOCK=1`) and make no paid
  calls, so they are safe to loop on. Mock mode deliberately refuses provider connection
  tests rather than reporting a fake success.
- Concurrency limits are real: one run per agent, two top-level, four including delegated
  subagents. Delegation depth is capped at 2 and cyclic handoffs are rejected. A run paused
  on an unanswered approval still holds its slot.
- Agent profiles are authoritative in SQLite and versioned by revision. Active runs keep
  their original revision; queued work snapshots the latest profile at start.
- After changing the Hermes adapter or the policy extension, re-run `npm run harness:setup`
  and recreate containers before trusting any real-runtime result.

## Security-sensitive areas

Call these out explicitly in a PR description; they get reviewed harder ([SECURITY.md](SECURITY.md)):
the dashboard bootstrap token (it authorizes arbitrary run creation, host-path mounts, and
direct OS execution), runner pairing and scoped credentials, container isolation and mounts,
and credential storage (`runtime/secrets.ts`, OS vaults, `.open-harness/secrets.json` at mode
`0600`). Loopback binding alone is not a boundary — `/v1/bootstrap` also requires a loopback
`Host` header. Never report a suspected vulnerability in a public issue or PR.

## Style

- Dense, direct code over added abstraction. Keep diffs minimal and scoped to the problem.
- Match the file you are editing rather than introducing a new convention.
- Comments explain *why*, and only where the reasoning isn't already obvious.
- Documentation here describes what the code actually does today; do not write aspirational
  claims into README/CHANGELOG/ROADMAP.

## Current focus

Core native Hermes runs, local-model inference, conversation recovery, and task MCP have
real integration evidence. The packaged macOS dashboard renders with its HTTP CSP and
cleans up sidecars on quit. Container acceptance still requires a Docker-capable host;
Android keyboard behavior still needs a physical-device check. See
[runtime/VERIFICATION.md](runtime/VERIFICATION.md) for exact checks and limits, and
[CHANGELOG.md](CHANGELOG.md) `[Unreleased]` for the running change summary.
