# Open Harness powered by Hermes

Open Harness is an MIT-licensed, local named-agent workspace inspired by Grok Bot. Each named agent runs as a persistent Hermes worker behind a loopback-only Node.js control service. The browser is a client: closing it does not cancel active work.

This is independent software and is not affiliated with xAI or Nous Research.

## Runtime

- Node.js 22.13+ control service with SQLite state and replayable events
- Hermes `v2026.9.11`, pinned to commit `939e45c91d751fadd94dcd1b873ac3cb44846213`
- One managed Docker container per isolated agent, or direct execution under a paired runner's OS account
- Outbound-only runners for Linux, macOS, and Windows computers, VPSs, and user-owned servers
- A shared project directory mounted into every agent container
- Two concurrent top-level runs and four total executions, including delegated subagents
- Durable routines, approvals, memories, skills, sessions, handoffs, and crash recovery
- Persistent project boards with editable stages, agent-owned tasks, collaborators, filters, checklists, comments, and linked run history

The host home directory, Docker socket, and other agents' private directories are not mounted. Containers provide the filesystem boundary; Hermes execution guards still apply inside it.

## Install for everyday use

Open Harness is currently available from source; no installers have been published on the [Releases page](https://github.com/sflow-hub/OPEN-HARNESS/releases). Use [Docker Compose](#self-host-with-docker-compose) or [run from a source checkout](#develop-from-source).

The desktop release workflow is configured to build these installers when a release is published:

- Windows: the `.exe` installer
- macOS: the `.dmg` for Apple silicon or Intel
- Linux: the `.AppImage`, `.deb`, or `.rpm`

Install [Docker Desktop](https://docs.docker.com/get-started/get-docker/) if you want private agent workspaces. In desktop builds, the first-run guide checks the computer, starts Docker when possible, prepares the pinned Hermes runtime, connects a model, and creates the first private workspace. It gives a direct installation link and a plain-language explanation when it cannot complete a step itself.

Packaged desktop builds include Node, the dashboard, coordinator, and runner, so running an installer build does not require Git, npm, or a source checkout. Closing the window keeps active work running in the tray. Signed release builds check for signed updates at startup.

### Self-host with Docker Compose

Clone the [repository](https://github.com/sflow-hub/OPEN-HARNESS) or download its source ZIP from **Code → Download ZIP**, install Docker, then run this command from that folder:

```bash
docker compose up -d
```

Open `http://localhost:3000`. Compose starts the dashboard, coordinator, a private Docker engine for agent containers, and persistent data volumes. No host Node or Python installation is required. By default the dashboard listens only on this computer. To expose it, put it behind an authenticated HTTPS reverse proxy, set `OPEN_HARNESS_LISTEN_ADDRESS=0.0.0.0`, and set `OPEN_HARNESS_PUBLIC_URL=https://agents.example.com/api/local`.

Compose requires pairing for every browser, including localhost. Create a one-time code from the operator's terminal and enter it in the dashboard:

```bash
docker compose exec -T open-harness node --input-type=module <<'NODE'
const base = 'http://127.0.0.1:4317';
const bootstrap = await fetch(`${base}/v1/bootstrap`);
if (!bootstrap.ok) throw new Error(`Coordinator bootstrap failed: ${bootstrap.status}`);
const { token } = await bootstrap.json();
const response = await fetch(`${base}/v1/machines`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ kind: 'device', platform: 'android', name: 'Browser' }),
});
const pairing = await response.json();
if (!response.ok) throw new Error(pairing.error || 'Pairing failed');
console.log(`Pairing code: ${pairing.code}\nExpires: ${pairing.expiresAt}`);
NODE
```

The code expires after ten minutes and works once. The master token stays inside that process. Local browser pairing uses the default localhost address; remote browsers and phones require `OPEN_HARNESS_PUBLIC_URL` to be the reachable HTTPS address before creating their codes.

The coordinator and agents use UID/GID `1000`, and only the coordinator receives the private engine's control socket. Fresh data volumes are initialized automatically. If upgrading an older root-owned data volume, back it up, stop the stack, and explicitly migrate its ownership before restarting:

```bash
docker compose down
docker compose run --rm --no-deps --user 0:0 --entrypoint /bin/sh docker -c 'chown -R 1000:1000 /data'
docker compose up -d --build
```

Do not add `--volumes` to `down` when preserving your data. Existing nonempty data is never automatically re-owned. For local models, configure a private/LAN provider URL reachable from both the coordinator and its agent containers. In this nested Docker deployment, `localhost` and `host.docker.internal` do not identify the physical VPS; use its reachable address and configure the model server to listen there.

### Develop from source

Contributors need Node.js 22.13+ and Docker:

```bash
npm ci
npm run harness:doctor
npm run harness:setup
npm run dev
```

Open `http://localhost:3000`. Development mode starts the UI and persistent control service. Run `npm run harness:doctor` whenever runtime health is unclear. Set `OPEN_HARNESS_SKIP_DOCKER_START=1` only when another process manages the Docker daemon.

For automatic coordinator startup on Linux with systemd:

```bash
npm run harness:install-service
npm run harness:start
npm run harness -- status
npm run harness:stop
```

The installed Linux user service owns coordinator background work. Start the dashboard separately with `npm run dev:app`; the dashboard and control service use loopback addresses. Sleeping or shutting down the computer stops execution; schedules catch up once after downtime rather than building a backlog.

## Models and secrets

Configure xAI, OpenAI, OpenRouter, or another model in **Settings**. The desktop coordinator uses Windows account encryption, macOS Keychain, or the Linux password vault when available. Headless servers fall back to `.open-harness/secrets.json` with mode `0600`. Credentials are written only to managed profiles and are never returned to the browser, diagnostics, or normal exports. Agents inherit workspace model settings unless their profile overrides them.

**Save and test** authenticates, confirms the exact model is available, and sends a minimal live completion before changing the workspace default. A failed test leaves the previous model active. Mock mode explicitly refuses this check and never reports a provider as ready.

The **Try a guided run** action remains an explicitly scripted demonstration. Normal tasks always enter the persistent Hermes queue; there is no silent fallback to the old four-tool loop.

## Agent settings

Use the settings icon on any agent card, or **Agent settings** in a conversation header. The tabs cover identity, computer assignment, model selection, custom instructions, and expandable tool/connection switches. The panel fills the screen on phones and supports keyboard navigation.

### Remote dashboard access

A browser pointed at a self-hosted deployment sends tasks, follows runs, and answers approvals while agents keep running on a connected computer. The dashboard adapts to desktop and small screens.

Remote browsers pair for their own revocable device credentials, which reach dashboard routes only and are rejected by runner command endpoints. The browser keeps its credential in origin storage; `OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD=1` remains as an opt-out for operators who authenticate in front of the dashboard themselves.

Pair from **Agent settings → Computer → Add computer**, choosing iPhone or Android. A coordinator listening only on loopback cannot be reached by a phone at all, so that screen says so and offers the two ways to fix it: serve it on a tailnet, which needs no open port and no certificate, or put it behind your own authenticated HTTPS address. It detects an existing tailnet and offers that address directly. Codes expire after ten minutes and work once.

### Connect another computer

Open **Agent settings → Computer → Add computer**, choose Linux, macOS, or Windows, and copy the generated one-line command. It downloads a small self-contained runner and its own Node runtime, checks Docker, prepares Hermes, pairs once, and installs automatic startup through systemd, launchd, or Windows Task Scheduler. The wizard watches the connection and selects the new computer automatically. It does not need Git, npm, a source checkout, an inbound port, or SSH credentials. Pairing codes expire after ten minutes and work once.

Remote coordinators must use HTTPS; plain HTTP is accepted only on loopback. On a headless Linux VPS, the installer reports the `loginctl enable-linger` command when the user service needs permission to remain active after logout.

For a self-hosted coordinator, enter its public HTTPS address in the connection wizard. The address can come from Tailscale Serve or an authenticated reverse proxy. Source installations can also set it before starting:

```bash
export OPEN_HARNESS_BIND=0.0.0.0
export OPEN_HARNESS_PUBLIC_URL=https://agents.example.com
npm run harness:serve
```

The dashboard token remains available only from the coordinator machine. Public runner endpoints accept scoped runner credentials or one-time pairing codes. A hosted Open Harness Site stores profiles, machines, runs, commands, and replayable events in D1. Model credentials entered in the hosted dashboard are encrypted to the selected runner’s public key; the coordinator keeps ciphertext only, and the runner saves the decrypted value in its OS credential vault.

Each agent starts with a private container. **Selected folders** mounts only the named host folders and preserves their read-only or read-write setting. **Direct computer access** runs Hermes under the runner's OS account; install the pinned host runtime and policy extension before selecting it:

```bash
git clone https://github.com/NousResearch/hermes-agent.git ~/.local/share/open-harness-hermes
git -C ~/.local/share/open-harness-hermes checkout 939e45c91d751fadd94dcd1b873ac3cb44846213
python3.12 -m venv ~/.local/share/open-harness-hermes-venv
~/.local/share/open-harness-hermes-venv/bin/python -m pip install -e "$HOME/.local/share/open-harness-hermes[all]"
~/.local/share/open-harness-hermes-venv/bin/python -m pip install runtime/hermes/extension
export HERMES_PYTHON="$HOME/.local/share/open-harness-hermes-venv/bin/python"
# Required only for existing-desktop control:
~/.local/share/open-harness-hermes-venv/bin/hermes computer-use install
```

Hermes requires an editable source installation. Keep that checkout in place and set `HERMES_PYTHON` in the coordinator or runner service environment too. On Windows use the virtual environment’s `Scripts/python.exe`. Node 22.13+ must be on that process’s PATH for task coordination. For native-only development, use `npm run dev:fast`; for the coordinator alone set `OPEN_HARNESS_SKIP_DOCKER_START=1` before `npm run harness:serve`.

Local OpenAI-compatible model servers can use an empty API key. For direct execution use their loopback URL, such as `http://127.0.0.1:11434/v1`. Container profiles translate loopback endpoints to `host.docker.internal`; the model server must listen on an interface reachable from Docker. Test the agent connection after choosing its computer.

Existing desktop control also needs the interactive OS session and its platform permissions. macOS requires Accessibility and Screen Recording. Windows remote hosts require a logged-in desktop session. Linux requires X11 or Wayland with AT-SPI. Linux runners can instead give each isolated agent a private Xvfb/Openbox desktop.

Independent agents may share a runner up to its configured capacity. Existing-desktop sessions are serialized. A disconnected runner finishes work already admitted and buffers results until the coordinator returns; new work remains queued. Moving an agent exports managed private files, memory, and skills, verifies every checksum at the destination, and preserves the source if transfer fails.

Profiles are authoritative in SQLite. Each save creates a revision; active work keeps its original revision, and queued work snapshots the latest profile when it starts. Workspace model changes affect inheriting agents only. Disabling instructions preserves their text. Failed saves keep your draft, and conflicting saves ask you to reload the winning revision.

Tool choices compile into an explicit allowlist. **Disable all tools** leaves only the mandatory task-board coordination tool; newly discovered tools start disabled. The managed Hermes extension filters model-visible tools and rejects disallowed dispatch, including tools called from code and temporary subagents. Named handoffs use the recipient's profile. Terminal can still run programs that read files or access the network; switches do not add filesystem or network isolation.

MCP connections use inline configuration and a real initialize/tools-list handshake in the selected native or container runtime. Cached inventories are labeled unavailable until rechecked. The model picker uses Hermes's catalog; custom model IDs remain editable if the runtime is unavailable. Saved credentials are references, and only selected secrets are placed in the next run's environment.

After changing the adapter or policy extension, rebuild with `npm run harness:setup`. Existing containers must use that new image and its read-only managed-policy mount before real-runtime verification.

## Capabilities and controls

Hermes supplies terminal and process execution, code editing, filesystem search, web and browser tools, memory, session recall, skills, context compression, and temporary subagents. Open Harness adds:

- persistent run creation, inspection, replay, steering, stopping, and approval resolution
- task launches that use the existing agent queue, move successful work to Review, and preserve every attempt for approval or revision
- streamed messages, commands, tool results, failures, and handoff activity
- named-agent delegation through an authenticated agent-scoped MCP server and private Unix socket
- delegation depth limited to two, with cyclic handoffs rejected
- private and shared file APIs and UI
- routines with timezone, next run, enable/disable, run-now, and stored execution linkage
- one-time migration of existing browser agents, conversations, files, and memories, with an original snapshot retained in SQLite
- interruption recovery that preserves completed events and never silently replays uncertain actions

Stopping a parent run also stops descendants and their associated Hermes sessions/processes. Pending approvals remain pending while the browser is closed. Managed profiles disable Hermes's separate cron executor so the control service is the only scheduler.

## Architecture

| Path | Responsibility |
| --- | --- |
| `runtime/service.ts` | Coordinator API, queue, schedules, approvals, runner dispatch, migration, handoffs |
| `runtime/runner.ts` | Outbound runner polling, execution, durable result delivery, and remote controls |
| `runtime/machines.ts` | Pairing, scoped credentials, machine health, commands, reservations, and transfers |
| `runtime/db.ts` | SQLite schema, runs, events, approvals, and recovery state |
| `runtime/hermes.ts` | Hermes TUI gateway JSON-RPC adapter and container lifecycle |
| `runtime/hermes/Dockerfile` | Reproducible pinned Hermes/Python 3.12 runtime |
| `runtime/hermes/coordination.mjs` | Agent-scoped named handoff and scheduling MCP tools |
| `components/agent-settings.tsx` | Accessible five-tab profile and computer editor |
| `components/onboarding.tsx` | First-run computer readiness and model connection guide |
| `src-tauri/` | Windows, macOS, and Linux desktop shell, tray, sidecar, and signed updater |
| `compose.yaml` | No-Node self-hosted dashboard, coordinator, and private container engine |
| `runtime/profiles.ts` | Profile revisions, inheritance, migration, and run snapshots |
| `runtime/profile-runtime.ts` | Runtime catalogs, connection checks, and configuration compiler |
| `runtime/hermes/extension/` | Managed Hermes allowlist middleware |
| `runtime/secrets.ts` | Restricted server-side credential storage |
| `lib/control-client.ts` | Browser client for the persistent control API |
| `app/page.tsx` | Existing visual workspace plus runtime, skills, memory, files, and routines |
| `tests/control-service.test.ts` | Paid-inference-free persistent runtime integration tests |

The integration stays behind the gateway adapter and does not modify Hermes's reasoning loop. See the [Hermes programmatic integration guide](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration) and [profile boundary documentation](https://hermes-agent.nousresearch.com/docs/user-guide/profiles).

## Verify

```bash
npm test
npm run typecheck
npm run lint
npm run build
npx playwright install chromium
npm run test:browser
```

The browser suite starts an isolated mock control service and the production app, and tests desktop and mobile editors. To use an existing Chromium install, set `OPEN_HARNESS_TEST_CHROMIUM` to its executable path. Python 3 is used for the policy middleware tests.

The deterministic service tests set `OPEN_HARNESS_MOCK=1` and use no paid inference. Opt-in acceptance checks exercise real Hermes, production Compose, the installed Linux runner, memory/skill persistence, named handoffs, actual scheduled dispatch, and Chromium/private-desktop control. These gates pass on Ubuntu ARM64 using local scripted providers or direct browser actions; they establish integration behavior, not model reasoning quality. See [runtime/VERIFICATION.md](runtime/VERIFICATION.md) for commands, evidence, known optional-backend limits, and remaining provider/platform checks. Verify real code repair and task quality with your chosen model before relying on a new Hermes release or provider.

## Troubleshooting

**`npm run dev` fails immediately.** Check your Node version first: the coordinator
imports `node:sqlite`, which needs Node 22.13 or newer. `nvm use` in this checkout
picks up `.nvmrc`. The `predev` guard reports this before anything else runs.

**Nothing in `.env` seems to apply.** `npm run dev` and `npm run harness:serve`
load `.env` if it is present. Other entry points do not — export the variables in
your shell, as shown under [Self-host with Docker Compose](#self-host-with-docker-compose).

**"Port 4317 is already in use."** Another coordinator is running. Stop it, or set
`OPEN_HARNESS_PORT` to a free port. `npm run harness -- doctor` reports whether a
coordinator is actually responding, as opposed to merely having state on disk.

**Check the whole setup at once.** `npm run harness -- doctor` verifies the Node
version, the port, Docker, the pinned Hermes image and desktop capability, and exits
non-zero if anything needs attention. Add `--json` to consume it from a script.

**An agent failed and the message is not enough.** The last lines the agent wrote to
stderr are included in the run's error. For more, `npm run harness -- doctor --json`
and the in-app **Download diagnostics** button (Workspace settings) capture the
coordinator's view. On Linux the service logs to the journal:
`journalctl --user -u open-harness.service -f`.

**A task is queued and never starts.** The coordinator runs at most one task per
agent, two you started yourself, and four counting anything agents delegate. A run
paused on an unanswered approval still holds its slot — answer or stop it from the
conversation it belongs to.

**Docker is already running and you want a faster restart.** Use `npm run dev:fast`,
which skips the attempt to start Docker but still uses the real Hermes runtime and your
configured model provider. Use `npm run dev:mock` only for deterministic UI and service
testing; mock mode never contacts a model provider or performs real agent work.

**Containers keep coming back after you quit.** Agent containers run with
`--restart unless-stopped`. Quit from the tray item or stop the coordinator with
Ctrl-C so it can stop them; if some were orphaned by an earlier hard kill, remove them
with `docker rm -f $(docker ps -aq --filter name=open-harness-)`.

## License and attribution

Open Harness is MIT licensed; see [LICENSE](LICENSE). Hermes Agent is also MIT licensed and remains an upstream dependency. Its pin and attribution are recorded in [`runtime/hermes/NOTICE.md`](runtime/hermes/NOTICE.md). Dependencies retain their own licenses.
