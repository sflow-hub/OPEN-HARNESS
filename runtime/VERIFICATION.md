# Runtime verification

## Public beta release-candidate implementation pass — September 24, 2026

Implemented and verified without paid inference:

- The production dashboard now exposes `/api/health`, which returns only coordinator reachability. Compose uses it for the service healthcheck, passes the remote-dashboard trust switch explicitly, and gives the coordinator up to 25 seconds for cleanup during shutdown.
- Remote bootstrap remains denied by default and is allowed only when `OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD=1`; both paths have route coverage.
- First-run setup no longer records completion when dismissed, when runtime preparation is incomplete, or after a failed model test. Failed connection tests preserve the saved revision and can be retried.
- Teams, boards, routines, remote computers, direct access, and MCP configuration are hidden behind a local Advanced features preference that defaults off. Existing data and APIs are unchanged.
- Browser hydration no longer describes a persistent run as interrupted merely because its tab was closed; the coordinator remains authoritative and replay supplies the current state after reconnect.
- Pending approvals are rebuilt from durable run events after reconnect, including when the saved event cursor has already passed the approval request. The mobile workspace panel now starts closed so it cannot cover task and approval controls.
- Self-hosting documentation now covers authenticated HTTPS proxying with streaming, health checks, updates, diagnostics, and stopped-stack backup and restore.
- Every reported version is `0.4.0-beta.1`. Self-hosted release publication is separate from signed desktop packaging, rejects tags that do not match the reviewed `main` commit and package version, and depends on tests, browser coverage, a fresh Compose health smoke test, coordinator/Hermes builds, and high/critical image scans.
- The source-release builder archives the reviewed Git tree with the lockfile, Compose files, runtime Dockerfile, and operations documentation; it rejects local state, environment files, dependencies, and build/test output. The publishing job adds SHA-256 checksums.

Checks: 97 Node tests, 46 Playwright desktop/mobile tests, TypeScript, ESLint, the production Vinext build, Cargo manifest/lock metadata, workflow YAML parsing, `git diff --check`, and `docker compose config` passed. Browser coverage includes incomplete setup, failed model retry, advanced-feature visibility, agent creation, task submission, pending-approval reconnect, and exact file download. `npm audit --omit=dev` reported 0 known vulnerabilities across 126 production dependencies.

Live release acceptance remains blocked on this machine: its selected Docker Desktop socket does not exist, the system Docker socket is not accessible, and `.env` has no configured model credential. Therefore the full coordinator/Hermes builds and Trivy scans, fresh Compose smoke test, authenticated proxy test, real-provider `launch-smoke.md` workflow, process-tree termination, upgrade/restore comparison, and 24-hour soak are not claimed as passed. The release tag and GitHub Release must not be created until those gates and the repository-rule checklist in `docs/BETA_RELEASE.md` are complete.

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

Not yet exercised against a real runtime: authentication and inference against a paid
provider, real MCP servers, filesystem isolation, process-tree termination, Direct
Computer Access, native subagent restrictions, a full from-scratch build of the reordered
Dockerfile, and the broader code-repair, browsing, durable skill-use, named-agent
teamwork and scheduled-run scenarios.

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
