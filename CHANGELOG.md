# Changelog

All notable changes to Open Harness are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project is
pre-1.0, so breaking changes can still land in a minor version.

## [Unreleased]

### Security

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

- Hardened the self-hosted `compose.yaml`: the `open-harness` service now
  drops all Linux capabilities, disables privilege escalation, and has its
  own healthcheck instead of relying on "the process started."
- Defined a real desktop Content-Security-Policy (previously disabled).

## [0.3.0] — 2026-09-12

Initial tracked baseline: persistent named Hermes agents in Docker-isolated
workspaces, a Tauri desktop app for Windows/macOS/Linux, a self-hosted Docker
Compose stack, outbound runners for remote/paired computers, project boards
with agent-owned tasks, routines/approvals/handoffs, and encrypted runner
credentials. See the README for the full feature set as of this version.
