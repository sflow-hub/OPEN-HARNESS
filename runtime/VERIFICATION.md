# MVP verification record

Verified on September 25, 2026 in a macOS ARM64 VM using Node 22.23.3,
Python 3.12, and pinned Hermes `939e45c91d751fadd94dcd1b873ac3cb44846213`
(`v2026.9.11`). This records completed checks separately from environment limits.
Claude independently verified the synchronized source on Linux 6.18 with Node
22.22.2: all 131 Node tests, typecheck, and lint passed, including the real MCP
subprocess socket test using the coordinator's explicit PID in its `/proc` path.

## Automated checks

- Integrated Node suite: 131 tests passed at the latest full checkpoint. It includes
  coordinator persistence, queue admission, profile snapshots, tasks/routines,
  runner pairing, encrypted inputs, hosted D1 handler concurrency, path containment,
  actual coordination subprocess requests, and process-tree termination.
- Five recovery tests pass, including SIGKILL of a coordinator with a live native
  gateway and child tool. Restart stops the recorded process tree before starting
  queued work. A competing coordinator cannot interrupt the existing owner's run.
- Four state-ownership tests verify exclusive access, clean release, crash release,
  independent state directories, and preservation of underlying database errors.
- The Node suite invokes seven Python policy tests. Denied tools remain denied for
  direct and nested dispatch; missing/empty policy is fail-closed.
- Production `npm run build`, `npm run typecheck`, `npm run lint`, and `git diff --check` passed.
- Browser suite against the latest production dashboard:
  59 passed, 9 expected platform skips. This includes concurrent conversations,
  queued follow-ups, approval reload, clarification, fresh-client history, and
  safe model-save requests, reopened requests, multi-page event replay, and partial
  streamed replies recovered across repeated reloads without duplicate text.
- Actual production HTTP responses contain CSP, nosniff, frame protection, and
  referrer headers. Browser tests pass with that policy. Inline hydration script
  tags remain allowed until the server supports per-response nonces.

## Real Hermes and real local inference

The opt-in native fixture check passed through the actual coordinator, Hermes
TUI gateway, policy extension, and task MCP connection over a private Unix socket.
It exercised a real file write, clarification and response, denied terminal access,
completed task-board query, a fresh-session follow-up with prior conversation text,
and immutable event replay. Its provider is a local scripted HTTP fixture, so this
check proves runtime integration without claiming model reasoning quality.

Run it after installing the pinned native runtime:

```bash
OPEN_HARNESS_REAL_HERMES_PYTHON=/absolute/path/to/hermes-venv/bin/python \
  node --import tsx tests/real-hermes-smoke.mjs
```

Genuine CPU inference also passed with a locally served Llama 3.2 3B Q4_K_M model:
model connection testing, Hermes choosing `write_file`, creation of the expected
artifact, normal run completion, and recall of that artifact's requested contents in
a second fresh Hermes session. No cloud provider, user API key, or paid inference was
used. `tests/real-local-model-smoke.mjs` documents its environment variables and
local-server requirements. Both smoke scripts isolate their coordinator state and
leave an evidence JSON file with replay and artifact locations.

These checks caught integration defects that mocks missed: plugin entry-point
registration, upstream MCP tool naming, deferred MCP tool search, and the Unix
socket HTTP client overload. Rebuild existing Hermes containers after this update.

## Native packaging

- Desktop Rust compilation passed. The packaged macOS app launched its bundled
  dashboard and coordinator; HTTP dashboard and authenticated health checks passed.
- A desktop startup-failure test removed the generated dashboard resource directory
  temporarily. The already-started coordinator received graceful shutdown and exited
  without leaving sidecars. Resources were restored afterward.
- Android ARM64 Rust/Kotlin compilation, actual mobile frontend export, and debug
  APK assembly passed at the 01:30 UI checkpoint. Package metadata and APK v2
  signature verified. This is a debug test artifact; late reconnect UI fixes are
  verified separately in the final source/browser checks.
- Android inset tests passed on Robolectric API 29 and 35: keyboard appearance
  reduces content bounds, repeated dispatch does not accumulate padding, and
  dismissal restores bounds.

## Remaining environment checks

Docker Desktop cannot start in this VM: its compatibility check reports no CPU
virtualization support (`kern.hv_support=0`). The pinned image and Compose stack
therefore have not been rebuilt or executed here. `.github/workflows/runtime.yml`
adds a Docker-capable, credential-free real-runtime gate for PR checks. Publishing a
test branch was blocked by the GitHub integration's write permissions (HTTP 403) and
the absence of local Git credentials; no PR or remote run was created. Container filesystem isolation,
container-side model networking, virtual desktops, and container process cleanup
still need a Docker-capable host:

```bash
npm run harness:setup
npm run harness:doctor
OPEN_HARNESS_REAL_CONTAINER=1 node --import tsx tests/real-hermes-smoke.mjs
docker compose up --build
```

The packaged desktop WKWebView displayed the dashboard and agent cards; Cmd+Q
shut down both sidecars cleanly. No physical Android device or hardware emulator
is available here. Native inset unit tests do not replace an Android keyboard
check on a real device. Windows native execution,
Linux service installation, a live hosted Cloudflare deployment, and paid cloud-model
inference have not been exercised in this environment.

Before a public release, also exercise real browsing/screenshots, named-agent
handoffs, persistent skills/memory, and scheduled model work with the chosen
provider and deployment. The current evidence establishes the core native run,
conversation, file-tool, clarification, and task-coordination paths; it does not
claim every optional Hermes integration is configured.
