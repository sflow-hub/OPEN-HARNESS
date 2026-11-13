# Self-hosted beta release checklist

This checklist is the release gate for the Docker-and-browser `v0.4.0-beta.1` MVP. The September 29 scope decision removes physical Mac/Windows hardware, host-native coordinators and native installers as release prerequisites. Linux ARM64 and AMD64 container artifacts still need separate build and execution evidence; Docker emulation is acceptable when recorded explicitly. Open Harness remains a single-operator system. Do not expose it without an authenticated HTTPS reverse proxy; a paired browser has operator-level access.

## Repository and release controls

- [ ] Merge the release candidate to `main` only after the Verify workflow passes on Linux, macOS, and Windows.
- [ ] In GitHub repository rules, protect tags matching `v*-beta.*` so only maintainers can create or update them.
- [ ] Confirm the release tag points at the current `main` commit. The release workflow checks this again before publishing.
- [x] On 2026-09-29, `npm audit --omit=dev --audit-level=high` reported 0 known vulnerabilities for the current `package-lock.json`.
- [ ] Confirm Trivy reports no unapproved high or critical findings in the coordinator, Hermes and exact pinned private-engine images.
- [ ] Confirm the release archive checksum and inspect its file list for local state, credentials, tokens, and machine-specific paths.

Severity-one blockers are credential disclosure, authentication bypass, container escape, cross-agent private-file access, destructive data loss, unrecoverable upgrade failure, or inability to stop an agent process tree. Do not publish with any severity-one blocker open.

## Clean-host acceptance

Use a clean Ubuntu 24.04 Docker environment (a VM is sufficient), a disposable real-provider credential, and fresh Compose volumes. Record the date, Docker version, provider, model ID, commit, image IDs, and result in `runtime/VERIFICATION.md` without recording the credential.

- [ ] Download the browser ZIP/tar, verify checksums and the image lock, then use its launcher with no host Node/Python/Git and no source build. Verify all pinned images pull anonymously, `docker compose ps` reports healthy, and `/api/health` returns `{"ok":true}`. Test a source build separately.
- [ ] Verify unauthenticated bootstrap is denied even with a loopback Host; open the launcher's one-use pairing link, verify the fragment is removed, and reject expired/replayed codes. Reload with the paired browser and verify its session survives a coordinator restart.
- [ ] Complete first-run setup and confirm a rejected credential remains retryable without marking setup complete.
- [ ] Create an agent and ask it to write `launch-smoke.md` with a unique expected line. Verify streamed progress, completed history, exact downloaded contents, and absence of the credential from diagnostics and logs.
- [ ] Start a second task, close the browser, reopen it, and verify execution continued and replay restored the current state.
- [ ] Leave an approval pending across a browser reconnect, approve it, and verify the same run completes once.
- [ ] Start a task that creates a child process, stop it, and verify the full process tree and agent container terminate.
- [ ] Restart the coordinator during a task. Verify completed events remain and uncertain work becomes interrupted without replay.
- [ ] Create two agents and verify neither can read the other agent’s private files.
- [ ] Confirm remote bootstrap is denied by default and without proxy authentication. Enable `OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD=1` only behind the authenticated HTTPS proxy and verify streaming remains responsive.

## Docker and browser acceptance

Test the shipped Linux ARM64 and AMD64 images through Docker. Native execution,
Docker emulation or cross-compilation may produce the artifacts; each target must
still be executed and tested. Record the host and Docker daemon architectures,
target architecture, execution mode, Docker/Compose versions, exact images and
results. A build alone or a mocked launcher test is not runtime acceptance.

- [ ] Build and exercise each target architecture's coordinator, agent runtime and private engine, including private desktop input, pairing, restart and stopped backup/restore. Emulated results must be labelled as emulated.
- [ ] Test the Bash and PowerShell launchers, extracted paths with spaces, Linux-container detection, startup failures and actionable Docker installation guidance. Record the shells and environment actually used.
- [ ] No host folder is mounted by default; a selected agent can access its exact exported roots at the permitted mode, while an ungranted peer cannot. Export desired subfolders separately.
- [ ] Both agents can use the workspace's shared files, while neither can read its peer's private files or control the host desktop.
- [ ] The app and launcher explain that localhost-only host model servers are not reachable through the nested engine; a configured network-reachable model endpoint is tested from the actual agent.
- [ ] Stop and relaunch preserve data and do not prune unrelated Docker resources or remove volumes. Normal launch logs contain no pairing codes or credentials.

Physical Mac/Windows Docker Desktop checks are follow-up compatibility work, not
MVP release gates. Keep unverified host integration details explicit in the browser
guide: Desktop startup/file-sharing prompts, Gatekeeper, SmartScreen and Windows
PowerShell 5.1. Container tests do not establish those host-specific behaviours.
Signed Tauri installers and host-native computer access are outside this MVP.

## Upgrade, restore, and soak

- [ ] Back up a representative `0.3.0` installation, upgrade it to the release candidate, and compare agents, profiles, revisions, histories, files, credentials, and health.
- [ ] With all writers stopped, restore the documented application-data archive into a new empty volume, download the pinned runtime into a fresh engine cache, and compare files/modes/owners, credentials, profiles, history, tasks, memory and skills. Continue real work using the restored credential; uncertain interrupted runs must not replay.
- [ ] Roll back by restoring the pre-upgrade backup into empty volumes and starting the previous release. Never point older code at a database already opened by newer code.
- [ ] Run a 24-hour soak with repeated core tasks, reconnects, one coordinator restart, and disk-usage observation.

The September 29 native ARM64 rehearsal upgraded an unchanged `603b19b…`
historical checkpoint to the recorded contract-7 production build snapshot and
rolled back through the stopped original backup. Nine browser jobs, current UI
approval effects, two exact empty-destination restores, retained state, rotated
credentials and isolated private desktops passed. This is evidence for those
specific builds; the checkboxes above still require the final release candidate.
See `runtime/VERIFICATION.md` for source/image identities and limitations.

Allow at least 20 GB of free disk before the first runtime build. Agent files, SQLite events, container layers, and logs grow with use; the beta does not automatically prune user history. Check `docker system df` and the Compose volume sizes during the soak.

The developer acceptance runner can extend the complete real Compose/restore fixture
with `node --import tsx tests/compose-smoke.mjs --soak`. Set
`OPEN_HARNESS_COMPOSE_SMOKE=1`, select the reviewed coordinator, engine and Hermes
images using the fixture's image environment variables, and use a durable `TMPDIR`
for evidence. This test driver needs Node 22.13+ and installed Playwright Chromium;
the downloaded application launcher still needs neither. An existing test browser
can be selected with `OPEN_HARNESS_SOAK_CHROMIUM`. Allow at least 21 GiB free for the
two engine stores used by this fixture, plus room for 24 hours of accumulated data.

First run `--soak-smoke` to exercise the same path for five minutes. It never
qualifies the 24-hour duration. Full mode requires at least 288 successful cycles,
alternates between two agents, checks unique file contents and tool events, closes
every dashboard page during pending input, and alternates answering from a reopened
browser with finishing while all pages are closed. After each reply, and again after
restarting the coordinator halfway through, it reloads the dashboard without its cached
workspace (`open-harness.workspace.v2` and legacy `.v1`; the pairing token is kept) and
requires the completed reply to come back from the coordinator's conversation history.
It records disk observations at roughly one-minute intervals between cycles. A sampling
gap over ten minutes on either the monotonic or the wall clock fails the full run, so a
suspended machine or paused VM cannot count toward the duration; insufficient disk space,
changed images/source, a service container restarted or replaced outside the planned
restart, or a failed task also fails it.

Retain `soak-journal.jsonl`, `soak-result.json`, and the surrounding fixture's
`evidence.json` and diagnostics. The journal is flushed after each observation. It ends
with `complete` only after the soak's end-of-run image, container, pairing and source
checks, but before the fixture's own log collection and cleanup; `soak-result.json` is
written with `evidence.json` only after the whole fixture, including cleanup, has passed.
Accept a run only when all three exist and agree. An interrupted or failed process leaves
no `evidence.json` and must start a new run.
Review the recorded actual image IDs against the final release digests before
checking the soak box. This scripted provider exercises real tool dispatch and
browser behavior; it does not establish model reasoning or host-specific
Docker Desktop integration. Physical Mac/Windows checks are not an MVP gate.
The current Ubuntu ARM64 smoke rehearsal passed against
the integrated contract-7 images, including replay without browser workspace caches.
The soak requires a continuous synchronized Docker event stream and exactly one
planned SIGTERM, successful exit, start and restart sequence. Extra lifecycle
events or a lost monitor fail it. Native fault tests and the v7 five-minute
rehearsal passed; the final 24-hour run remains required. See `runtime/VERIFICATION.md`
for the exact tested images and remaining coverage limits.

## Release notes and support

- [ ] Finalize `docs/RELEASE_NOTES.md` against the exact tagged source, image and platform evidence. Replace its dated unreleased-draft status only after the gates pass, and review the generated changelog appended to the prepared notes before publication.
- [ ] State that the beta supports one trusted operator and that advanced features remain experimental.
- [ ] State that model-provider calls may incur provider charges and that Open Harness has no telemetry.
- [ ] Link `SECURITY.md`, `docs/SELF_HOSTING.md`, the backup/rollback procedure, and the GitHub issue tracker.
- [ ] Ask bug reporters to attach the in-app diagnostic bundle after reviewing it; it excludes prompts, responses, file contents, and credential values.
- [ ] Publish only when every automated release job and every checkbox above passes and no severity-one blocker remains.
