# Changelog

All notable changes to Open Harness are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project is
pre-1.0, so breaking changes can still land in a minor version.

## [Unreleased]

### Added

- The dashboard is now mobile-first on both paths to a remote coordinator: the
  Android app and a phone browser pointed at a self-hosted deployment. Phone
  layout is decided by the screen rather than by the presence of Tauri, so a
  phone browser stops being served the desktop layout.
- A remote browser can pair for its own scoped, revocable device credential
  instead of being handed the master control token.
  `OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD=1` becomes a legacy opt-out rather than
  the only way in.
- A web manifest, so the browser path installs to the home screen.

### Fixed

- Android: Back closed the app from any modal, destroying unsaved profile edits,
  because the static export gave the webview no history to go back to.
- Android: downloads and external links silently did nothing. The WebView needs
  a download listener and a second-window handler, and the shell registers
  neither, so files and links now go through the `fs` and `opener` plugins.
- Android: content drew under the status and gesture bars, and the safe-area CSS
  that was meant to prevent it was dead because the build carried no
  `viewport-fit=cover`.
- Pairing with a coordinator that has no agents crashed the dashboard instead of
  saying so.
- The task board forced roughly 1300px of horizontal panning on a phone, and the
  only touch control for moving a task was about 21px.

### Known issues

- Android: the soft keyboard covers the chat composer. The shell never applies
  the IME window insets to the webview, so the web layer is told nothing about
  the keyboard; see ANDROID.md.

- An Android companion app. It is the same dashboard shipped as static files in a
  Tauri 2 shell, paired to a coordinator over HTTPS with a typable 12-character code
  or an `openharness://` link. The phone gets its own revocable device credential,
  kept in a native Stronghold vault, that reaches dashboard routes only; runner
  command endpoints reject it. Phones send tasks, follow runs, and answer approvals;
  execution stays on a connected computer. See [ANDROID.md](ANDROID.md).
- `Verify` builds a debug ARM64 APK on every push; tagged releases build a signed
  APK and AAB when the four `ANDROID_*` repository secrets are present.

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
