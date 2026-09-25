# Changelog

All notable changes to Open Harness are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project is
pre-1.0, so breaking changes can still land in a minor version.

## [Unreleased]

### Added

- The dashboard adapts to desktop and phone browsers pointed at a self-hosted deployment.
- A remote browser can pair for its own scoped, revocable device credential
  instead of being handed the master control token.
  `OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD=1` becomes a legacy opt-out rather than
  the only way in.
- A web manifest, so the browser path installs to the home screen.
- Adding a phone now says how to make the coordinator reachable when it only
  answers on loopback, instead of minting a code against an address the phone
  can never resolve. It detects an existing tailnet and offers that address, and
  otherwise gives the commands for a tunnel or a reverse proxy. Also available
  as `GET /v1/reachability`.
- Conversations follow every run the coordinator has for them: two agents can work at
  the same time, each in its own chat, and a follow-up sent while an agent is busy is
  queued behind its current task, shown in the transcript, and followed to its own
  reply. (claude)
- Questions from an agent — a clarification, a needed secret, a sudo password — are
  asked in the conversation and answered there. The answer goes to the run and never
  into the transcript. (claude)
- A client with no history of its own, such as a phone that just paired or a browser
  whose storage was cleared, rebuilds its conversations from the coordinator's runs,
  and a conversation it already has is caught up with runs it missed. (claude)

### Fixed

- A freshly paired workspace — a Compose install, where every browser pairs and the
  coordinator starts with no agents — showed "No agents yet" with nothing to do about it:
  the empty screen returned before the agent editor and setup guide were mounted, and a
  paired browser could not reopen setup. It now offers "Create your first agent" and "Set
  up connected computer", paired operators can run setup again from Workspace settings,
  and joining an established hub still seeds nothing. (claude, from a Codex-prepared patch)
- First-time runtime builds no longer block on unread subprocess output or hit the dashboard proxy's five-minute response deadline. Paired setup builds a missing Hermes image from bundled sources. (codex)
- Private Linux desktops now start and recover after container restart under the coordinator's UID. Browser screenshots, typing, pixel clicks and accessibility clicks work with the pinned CUA driver while stale targets remain rejected. (codex)
- Memory and skills now follow the agent's selected computer and use Hermes's canonical memory files. Existing dashboard notes migrate without overwriting newer runtime notes, transfers carry those files, and remote runs retain their session IDs. (codex)
- Docker images built from shared-folder checkouts now make startup scripts and application assets readable by their non-root runtime users, preventing permission-denied startup failures. (codex)
- A newly paired browser immediately uses its scoped device session and reads the coordinator workspace, including an empty workspace, without importing local starter agents. (codex)

- Follow-up runs keep prior conversation text, and remote work remains attached after a coordinator restart. Pending approvals and input requests recover across client reloads; failed runner replies remain retryable. (codex)
- Model setup validates draft credentials before committing a new reference, preserving the working configuration after failed tests or stale saves. (codex)
- Pinned Hermes now loads the policy extension, exposes granted MCP task tools, and connects to the coordinator over native Unix sockets. Native probes use the selected runtime, container model URLs resolve host loopback addresses, and the browser binary installs in a location readable by the container's runtime user. (codex)
- Hosted dispatch atomically enforces capacity and task ownership, snapshots profiles at start, and supports task stopping, routine editing/history, encrypted inputs, and conversation history. (codex)
- Runtime stopping waits for tool process cleanup; native process identities survive coordinator restarts, and a second coordinator cannot interrupt the existing owner's work. File transfers reject traversal and symlink paths on Windows and Unix. (codex)
- Desktop startup failure and quit clean up the coordinator sidecar. (codex)
- Compose uses consistent coordinator/agent file ownership, private Unix-socket engine access, explicit browser pairing, and enough shutdown time to finish agent cleanup. Existing root-owned data requires the documented migration. (codex)
- Steering and Stop acted on whichever run the dashboard happened to be holding, so
  after switching agents they could reach another agent's run. They now act on the open
  conversation's run. (claude)
- Reloading during a run lost its approval banner, because the client resumed past the
  request event. Pending approvals and questions are read from the run itself, so they
  survive a reload, clear when answered from another client, and come back if the
  coordinator has to reopen one. (claude)
- A run that finished while the page was closed left an empty reply behind for good. The
  reply is caught up from the coordinator on the next open, reading every page of its
  events rather than the first 500 and taking the stored outcome as final. (claude)
- Saving a workspace model wrote the pasted key before testing it, so a failed test
  destroyed the working key. The key is tested and saved in one request, and a failed
  test leaves the previous model and key untouched. (claude)
- Agent settings showed every saved tool as missing when the coordinator refused to
  probe a running agent's runtime. The saved choices stay editable and the message says
  to refresh once the agent finishes. (claude)
- The task drawer's label field dropped a trailing comma on every keystroke, so a second
  label could never be typed. (claude)
- On screens narrower than 1000px the agent workspace panel opened on top of the
  composer's send button in every conversation. It starts closed there, and Back closes
  it on a phone. (claude)
- Tool activity from the real Hermes gateway (`tool_id`, object `context` and `result`)
  is shown the same way as the mock's, and MCP tool ids read as words. (claude)

- Pairing with a coordinator that has no agents crashed the dashboard instead of
  saying so.
- The task board forced roughly 1300px of horizontal panning on a phone, and the
  only touch control for moving a task was about 21px.

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

- Removed the native mobile app, build/release tooling, native dashboard adapters, mobile-only dependencies, and app-specific documentation from this repository. Mobile development continues in a separate repository; shared pairing APIs and responsive browser support remain. (codex)

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
