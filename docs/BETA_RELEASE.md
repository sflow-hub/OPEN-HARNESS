# Self-hosted beta release checklist

This checklist is the release gate for `v0.4.0-beta.1`. Open Harness remains a single-operator system. Do not expose it without an authenticated HTTPS reverse proxy; a paired browser has operator-level access.

## Repository and release controls

- [ ] Merge the release candidate to `main` only after the Verify workflow passes on Linux, macOS, and Windows.
- [ ] In GitHub repository rules, protect tags matching `v*-beta.*` so only maintainers can create or update them.
- [ ] Confirm the release tag points at the current `main` commit. The release workflow checks this again before publishing.
- [x] On 2026-09-26, `npm audit --omit=dev --audit-level=high` reported 0 known vulnerabilities.
- [ ] Confirm Trivy reports no unapproved high or critical findings in the coordinator, Hermes and exact pinned private-engine images.
- [ ] Confirm the release archive checksum and inspect its file list for local state, credentials, tokens, and machine-specific paths.

Severity-one blockers are credential disclosure, authentication bypass, container escape, cross-agent private-file access, destructive data loss, unrecoverable upgrade failure, or inability to stop an agent process tree. Do not publish with any severity-one blocker open.

## Clean-host acceptance

Use a clean Ubuntu 24.04 host with Docker, a disposable real-provider credential, and fresh Compose volumes. Record the date, Docker version, provider, model ID, commit, image IDs, and result in `runtime/VERIFICATION.md` without recording the credential.

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

## Docker Desktop platform acceptance

Native host checks are additional to the Linux AMD64/ARM64 image jobs. Record exact OS,
architecture, Docker Desktop version, image digests and results separately; do not mark them
passed from mocked launcher tests or a Linux VM.

- [ ] Apple Silicon Mac: freshly extracted archive in a path with spaces, Docker Desktop initially stopped, first launch/pair/reopen, explicit read-only and writable host exports, private desktop interaction after restart, and stopped backup/restore.
- [ ] Intel Mac: repeat that complete workflow using the AMD64 images.
- [ ] Windows with Linux containers: repeat with Windows PowerShell 5.1 and the `.cmd` wrapper; verify Docker/WSL startup guidance, path quoting and host-folder permissions. Windows-container mode must fail with actionable instructions.
- [ ] No host folder is mounted by default; a selected agent can access its exact exported roots at the permitted mode, while an ungranted peer cannot. Export desired subfolders separately.
- [ ] The app and launcher explain that localhost-only host model servers are not reachable through the nested engine; a configured network-reachable model endpoint is tested from the actual agent.
- [ ] Stop and relaunch preserve data and do not prune unrelated Docker resources or remove volumes. Normal launch logs contain no pairing codes or credentials.

## Upgrade, restore, and soak

- [ ] Back up a representative `0.3.0` installation, upgrade it to the release candidate, and compare agents, profiles, revisions, histories, files, credentials, and health.
- [ ] With all writers stopped, restore the documented application-data archive into a new empty volume, download the pinned runtime into a fresh engine cache, and compare files/modes/owners, credentials, profiles, history, tasks, memory and skills. Continue real work using the restored credential; uncertain interrupted runs must not replay.
- [ ] Roll back by restoring the pre-upgrade backup into empty volumes and starting the previous release. Never point older code at a database already opened by newer code.
- [ ] Run a 24-hour soak with repeated core tasks, reconnects, one coordinator restart, and disk-usage observation.

Allow at least 20 GB of free disk before the first runtime build. Agent files, SQLite events, container layers, and logs grow with use; the beta does not automatically prune user history. Check `docker system df` and the Compose volume sizes during the soak.

## Release notes and support

- [ ] Finalize `docs/RELEASE_NOTES.md` against the exact tagged source, image and platform evidence. Replace its dated unreleased-draft status only after the gates pass, and review the generated changelog appended to the prepared notes before publication.
- [ ] State that the beta supports one trusted operator and that advanced features remain experimental.
- [ ] State that model-provider calls may incur provider charges and that Open Harness has no telemetry.
- [ ] Link `SECURITY.md`, `docs/SELF_HOSTING.md`, the backup/rollback procedure, and the GitHub issue tracker.
- [ ] Ask bug reporters to attach the in-app diagnostic bundle after reviewing it; it excludes prompts, responses, file contents, and credential values.
- [ ] Publish only when every automated release job and every checkbox above passes and no severity-one blocker remains.
