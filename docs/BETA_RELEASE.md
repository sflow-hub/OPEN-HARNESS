# Self-hosted beta release checklist

This checklist is the release gate for `v0.4.0-beta.1`. Open Harness remains a single-operator system. Do not expose it without an authenticated HTTPS reverse proxy; anyone who reaches the dashboard has operator-level access.

## Repository and release controls

- [ ] Merge the release candidate to `main` only after the Verify workflow passes on Linux, macOS, and Windows.
- [ ] In GitHub repository rules, protect tags matching `v*-beta.*` so only maintainers can create or update them.
- [ ] Confirm the release tag points at the current `main` commit. The release workflow checks this again before publishing.
- [x] On 2026-09-24, `npm audit --omit=dev --audit-level=high` reported 0 known vulnerabilities across 126 production dependencies.
- [ ] Confirm Trivy reports no unapproved high or critical findings in the coordinator and Hermes images.
- [ ] Confirm the release archive checksum and inspect its file list for local state, credentials, tokens, and machine-specific paths.

Severity-one blockers are credential disclosure, authentication bypass, container escape, cross-agent private-file access, destructive data loss, unrecoverable upgrade failure, or inability to stop an agent process tree. Do not publish with any severity-one blocker open.

## Clean-host acceptance

Use a clean Ubuntu 24.04 host with Docker, a disposable real-provider credential, and fresh Compose volumes. Record the date, Docker version, provider, model ID, commit, image IDs, and result in `runtime/VERIFICATION.md` without recording the credential.

- [ ] Run `docker compose up -d --build`; wait for `docker compose ps` to report healthy and verify `/api/health` returns `{"ok":true}`.
- [ ] Complete first-run setup and confirm a rejected credential remains retryable without marking setup complete.
- [ ] Create an agent and ask it to write `launch-smoke.md` with a unique expected line. Verify streamed progress, completed history, exact downloaded contents, and absence of the credential from diagnostics and logs.
- [ ] Start a second task, close the browser, reopen it, and verify execution continued and replay restored the current state.
- [ ] Leave an approval pending across a browser reconnect, approve it, and verify the same run completes once.
- [ ] Start a task that creates a child process, stop it, and verify the full process tree and agent container terminate.
- [ ] Restart the coordinator during a task. Verify completed events remain and uncertain work becomes interrupted without replay.
- [ ] Create two agents and verify neither can read the other agent’s private files.
- [ ] Confirm remote bootstrap is denied by default and without proxy authentication. Enable `OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD=1` only behind the authenticated HTTPS proxy and verify streaming remains responsive.

## Upgrade, restore, and soak

- [ ] Back up a representative `0.3.0` installation, upgrade it to the release candidate, and compare agents, profiles, revisions, histories, files, credentials, and health.
- [ ] With the stack stopped, restore the documented data and Docker-volume archives into empty volumes and repeat the comparison.
- [ ] Roll back by restoring the pre-upgrade backup into empty volumes and starting the previous release. Never point older code at a database already opened by newer code.
- [ ] Run a 24-hour soak with repeated core tasks, reconnects, one coordinator restart, and disk-usage observation.

Allow at least 20 GB of free disk before the first runtime build. Agent files, SQLite events, container layers, and logs grow with use; the beta does not automatically prune user history. Check `docker system df` and the Compose volume sizes during the soak.

## Release notes and support

- [ ] State that the beta supports one trusted operator and that advanced features remain experimental.
- [ ] State that model-provider calls may incur provider charges and that Open Harness has no telemetry.
- [ ] Link `SECURITY.md`, `docs/SELF_HOSTING.md`, the backup/rollback procedure, and the GitHub issue tracker.
- [ ] Ask bug reporters to attach the in-app diagnostic bundle after reviewing it; it excludes prompts, responses, file contents, and credential values.
- [ ] Publish only when every automated release job and every checkbox above passes and no severity-one blocker remains.
