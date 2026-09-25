# MVP verification record

Verified on September 25, 2026 in macOS ARM64 and Ubuntu 24.04.5 ARM64 VMs
using Node 22.23.3, Python 3.12, and pinned Hermes `939e45c91d751fadd94dcd1b873ac3cb44846213`
(`v2026.9.11`). This records completed checks separately from environment limits.
The current source, including the mobile-app removal and runtime fixes, passes all 139 Node tests
on Ubuntu. Claude independently verified the earlier 136-test checkpoint on
Linux 6.18 with Node 22.22.2, including the real MCP subprocess socket test.

## Automated checks

- Integrated macOS and Ubuntu Node suites: 135 tests passed after mobile-app removal;
  the expanded Ubuntu suite passes 139 after runtime/setup fixes. They include
  coordinator persistence, queue admission, profile snapshots, tasks/routines,
  runner pairing, encrypted inputs, hosted D1 handler concurrency, path containment,
  actual coordination subprocess requests, and process-tree termination.
- Five recovery tests pass, including SIGKILL of a coordinator with a live native
  gateway and child tool. Restart stops the recorded process tree before starting
  queued work. A competing coordinator cannot interrupt the existing owner's run.
- Four state-ownership tests verify exclusive access, clean release, crash release,
  independent state directories, and preservation of underlying database errors.
- Three supervisor subprocess tests verify delayed graceful cleanup, forced stopping
  of an unresponsive service, and peer cleanup after unexpected service failure.
- Two dashboard proxy tests verify deployment-wide browser pairing requirements and
  authenticated device forwarding. With the actual standalone dashboard and
  coordinator, browser bootstrap returned 403, one-time pairing returned 201, scoped
  sessions and authenticated state returned 200, reused codes returned 410, and
  unauthenticated or runner-only access returned 401. Master tokens were not exposed.
- The Node suite invokes seven Python policy tests. Denied tools remain denied for
  direct and nested dispatch; missing/empty policy is fail-closed.
- Production `npm run build`, `npm run typecheck`, `npm run lint`, and `git diff --check` passed.
- Browser suite against the latest production dashboard:
  63 passed, 9 expected platform skips. This includes concurrent conversations,
  queued follow-ups, approval reload, clarification, fresh-client history, and
  safe model-save requests, reopened requests, multi-page event replay, and partial
  streamed replies recovered across repeated reloads without duplicate text.
- Fresh paired workspaces can open coordinator/model setup and create their first
  agent. Four desktop/mobile regressions use actual empty coordinators and scoped
  pairing, with deterministic setup/provider responses; existing hubs receive no
  automatic starter-agent import. Claude delivered the exact tested patch as UI
  owner and independently passed the full 139 Node and 63/9 browser suites.
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
- After the Linux/runtime fixes, `npm run desktop:prepare` passed on Ubuntu. The
  regenerated bundle's actual compiled coordinator and standalone dashboard started,
  returned authenticated health and CSP headers, served the new CUA compatibility
  helper through the dashboard proxy, and stopped cleanly. Bundled helper/entry/image
  and installer files matched source bytes. This checks packaged runtime resources,
  not the untested Linux native GUI. Evidence: `desktop-bundle-iqtufu9m/evidence.json`.

## Real Docker and Compose acceptance

Both production images built and both container gates passed on Ubuntu 24.04.5
ARM64 with Docker Engine 29.8.1, Compose 5.5.1, 4 vCPUs, and 8 GiB RAM. The source
and test commands ran inside Ubuntu so Docker bind mounts used Linux paths.
The macOS guest still lacks nested virtualization; the separate Ubuntu VM removes
that blocker. No paid provider credentials or model downloads were needed.

```bash
npm run harness:setup
npm run harness:doctor
OPEN_HARNESS_REAL_CONTAINER=1 node --import tsx tests/real-hermes-smoke.mjs
OPEN_HARNESS_COMPOSE_SMOKE=1 node --import tsx tests/compose-smoke.mjs
```

The direct-container gate passed real file writes, clarification and response, task
MCP, rejection of ungranted tools, fresh-session conversation context, stable replay,
host-provider networking, and container stopping. The Compose gate repeated these
flows through its private Docker 28.5.2 engine and a sibling scripted provider. It
also passed dashboard security headers, scoped single-use browser pairing, blocked
bootstrap and runner access, persistent credentials/profile/tasks/files/history after
restart, and graceful shutdown while a real agent waited for input.

Actual container inspection confirmed UID 1000, the four expected agent bind mounts
(including read-only managed policy), and no mounted Docker control socket. Neither
Docker TCP port was reachable. The coordinator exited cleanly and stopped its nested
agent before engine shutdown. All disposable project containers, volumes, and
networks were removed. These checks prove runtime integration, not model reasoning.

Real execution exposed owner-only source permissions preserved by Docker COPY from
the shared-folder checkout. Both Dockerfiles now make application assets readable
to their non-root runtime users while retaining root ownership. A separate Docker
probe also confirmed that an ephemeral published port changes on restart; the Compose
test now refreshes that address and records endpoints in its diagnostics.

Evidence on the Ubuntu VM is under `/home/developer/open-harness-evidence/20260925/`:
`open-harness-real-smoke-6Rf0eD/evidence.json` and
`open-harness-compose-smoke-9nOLak/evidence.json`, plus build and test logs.
`.github/workflows/runtime.yml` runs the same gates for Docker-capable CI.

The fresh-install variant also passed with an empty nested Docker image store:

```bash
OPEN_HARNESS_COMPOSE_SMOKE=1 OPEN_HARNESS_COMPOSE_BUILD_RUNTIME=1 \
  node --import tsx tests/compose-smoke.mjs
```

Using only the paired browser credential, setup reported the missing image, built
it from the coordinator's bundled sources in 209 seconds, and reported ready.
The remaining real-agent, auth/isolation, restart, and shutdown checks then passed.
This variant imports no prebuilt host image. Setup drains child output without
blocking and its dedicated dashboard proxy allows up to one hour for the response,
preserving cancellation and the existing credential/header boundary. External
reverse proxies must also allow a long setup request, or use the README's CLI setup.
Evidence: `/tmp/open-harness-compose-smoke-jL9AB4/{evidence,runtime-setup}.json`
on Ubuntu. Its disposable stack was removed after the test.

The delivered UI also passed first use in a separate fresh production Compose stack.
An actual browser paired with the empty coordinator, started runtime installation
through the same-origin dashboard proxy, and reached the ready state. It validated
and saved a local scripted model, created the first agent through the profile editor,
and retained exactly that agent and its saved profile after a page reload. No starter
agents or prebuilt runtime image were imported. This verifies the real UI, API, build,
and storage path; the scripted provider does not establish model reasoning quality.
Evidence: `compose-ui-aqAySo/evidence.json` under the Ubuntu evidence directory.

## Linux services, remote runner, and persistent workflows

The actual Linux coordinator user-service installer passed enable/start, authenticated
health, stop, and restart checks with isolated state. The standalone runner installer
also passed using its downloaded Node runtime and bundled runner, without a source
checkout at its installation location. Its systemd user service paired, accepted work,
restarted, and was removed after the test. Runner-scoped credentials could not access
dashboard routes and stopped working after revocation.

```bash
OPEN_HARNESS_REAL_RUNNER_SMOKE=1 node --import tsx tests/real-runner-smoke.mjs
OPEN_HARNESS_REAL_WORKFLOWS=1 node --import tsx tests/real-workflows-smoke.mjs
```

The remote-runner gate verified checksummed transfer of private files, memory, and
skills; actual file, clarification, and task tools; rejected terminal access; distinct
persisted Hermes sessions; history after service restart; and immutable event replay.
Dashboard memory and skill edits reached the selected runner, real Hermes read those
changes, and tool-created memory returned through the dashboard API. The old local
copy remained untouched, including after remote skill deletion.

The workflow gate verified real memory and skill tools across fresh sessions and a
coordinator restart, a named-agent handoff with a child artifact and returned result,
and a one-minute routine created through task MCP. After coordinator restart the
actual scheduler dispatched its due occurrence, without a run-now request. Both
gates used a deterministic local provider, not paid inference or model reasoning.

These checks exposed and fixed dashboard/Hermes memory-directory disagreement,
missing canonical memory in computer transfers, remote context operations targeting
the coordinator instead of the runner, and missing remote session metadata. Legacy
dashboard memories are adopted only when canonical Hermes files do not exist;
original files remain as backups and never overwrite newer runtime memories.

Additional Ubuntu evidence: `linux-service-UkHA7s/evidence.json`,
`open-harness-runner-smoke-xlHxTn/evidence.json`, and `workflows-ypsxeh/evidence.json`
under the evidence directory above. Temporary services and agent containers were removed.

## Browser and private desktop

The real desktop gate passes on Ubuntu ARM64 with the production container's
unprivileged UID, capability restrictions, private HOME, and four bind mounts.
It checks Chromium navigation and accessibility snapshots through Hermes, browser
and desktop PNG captures, pixel and accessibility clicks, foreground typing, and
desktop recovery after container restart. DOM readbacks verify that clicks and
typing actually changed the local fixture page. A second UID501 health check passes.

```bash
OPEN_HARNESS_DESKTOP_SMOKE=1 node --import tsx tests/real-desktop-smoke.mjs
```

Fixes make the CUA driver globally readable, start Openbox with valid arguments,
wait for Xvfb, provide a private DBus/AT-SPI session for arbitrary coordinator UIDs,
and clear stale private display sockets on restart. CUA is pinned to tested version
0.28.2. A narrow adapter uses the driver's advertised input schema when its optional
capability metadata is absent, allowing Hermes to forward captured accessibility
tokens. The gate also confirms stale tokens are rejected. No host desktop is exposed.

The optional Camofox backend is **not ready in this image**: its downloaded browser
and native dependency require newer NSS/glibc libraries, and its addon directory
requires separate preparation. Use the verified default Chromium backend. This
limitation does not affect the browser or private-desktop checks above.

The final rebuilt production image passed the direct-container gate again
(`open-harness-real-smoke-r7DNMF/evidence.json`), the installed-runner gate above,
and `open-harness-desktop-smoke-3l4Q6j/evidence.json` including stale-token refusal.
Earlier desktop diagnosis evidence is retained under `desktop-ndPL5I/`.

## Remaining environment checks

No PR or remote CI run was created: repository publication previously failed with
GitHub integration HTTP 403 and no local Git credentials. The completed Docker
evidence above comes from the Ubuntu VM, not GitHub Actions.

The packaged desktop WKWebView displayed the dashboard and agent cards; Cmd+Q
shut down both sidecars cleanly. Windows native execution,
the packaged Linux desktop, a live hosted Cloudflare deployment, and paid cloud-model
inference have not been exercised in this environment.

Provider-specific behavior and optional Hermes integrations still need acceptance
with the chosen model and deployment. The scripted-provider gates establish real
runtime behavior, not reasoning quality or compatibility with every provider.
