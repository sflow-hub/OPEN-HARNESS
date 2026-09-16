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

Open the repository’s **Releases** page and download the installer for your computer:

- Windows: the `.exe` installer
- macOS: the `.dmg` for Apple silicon or Intel
- Linux: the `.AppImage`, `.deb`, or `.rpm`

Install [Docker Desktop](https://docs.docker.com/get-started/get-docker/) if you want private agent workspaces. Then open Open Harness. The first-run guide checks the computer, starts Docker when possible, prepares the pinned Hermes runtime, connects a model, and creates the first private workspace. It gives a direct installation link and a plain-language explanation when it cannot complete a step itself.

The desktop app includes Node, the dashboard, coordinator, and runner. Users do not need Git, npm, a source checkout, or terminal commands. Closing the window keeps active work running in the tray. Signed release builds check for signed updates at startup.

### Self-host with Docker Compose

Download and unzip the source release, install Docker, then run this command from that folder:

```bash
docker compose up -d
```

Open `http://localhost:3000`. Compose starts the dashboard, coordinator, a private Docker engine for agent containers, and persistent data volumes. No host Node or Python installation is required. By default the dashboard listens only on this computer. To expose it, put it behind an authenticated HTTPS reverse proxy, set `OPEN_HARNESS_LISTEN_ADDRESS=0.0.0.0`, and set `OPEN_HARNESS_PUBLIC_URL=https://agents.example.com/api/local`.

### Develop from source

Contributors need Node.js 22.13+ and Docker:

```bash
npm ci
npm run harness:doctor
npm run harness:setup
npm run dev
```

Open `http://localhost:3000`. Development mode starts the UI and persistent control service. Run `npm run harness:doctor` whenever runtime health is unclear. Set `OPEN_HARNESS_SKIP_DOCKER_START=1` only when another process manages the Docker daemon.

For automatic startup:

```bash
npm run harness:install-service
npm run harness:start
npm run harness -- status
npm run harness:stop
```

The installed user service owns background work. The UI and control service bind to loopback. Sleeping or shutting down the computer stops execution; schedules catch up once after downtime rather than building a backlog.

## Models and secrets

Configure xAI, OpenAI, OpenRouter, or another model in **Settings**. The desktop coordinator uses Windows account encryption, macOS Keychain, or the Linux password vault when available. Headless servers fall back to `.open-harness/secrets.json` with mode `0600`. Credentials are written only to managed profiles and are never returned to the browser, diagnostics, or normal exports. Agents inherit workspace model settings unless their profile overrides them.

The **Try a guided run** action remains an explicitly scripted demonstration. Normal tasks always enter the persistent Hermes queue; there is no silent fallback to the old four-tool loop.

## Agent settings

Use the settings icon on any agent card, or **Agent settings** in a conversation header. The tabs cover identity, computer assignment, model selection, custom instructions, and expandable tool/connection switches. The panel fills the screen on phones and supports keyboard navigation.

### Connect another computer

Open **Agent settings → Computer → Add computer**, choose Linux, macOS, or Windows, and copy the generated one-line command. It downloads a small self-contained runner and its own Node runtime, checks Docker, prepares Hermes, pairs once, and installs automatic startup through systemd, launchd, or Windows Task Scheduler. It does not need Git, npm, a source checkout, an inbound port, or SSH credentials. Pairing codes expire after ten minutes and work once.

Remote coordinators must use HTTPS; plain HTTP is accepted only on loopback. On a headless Linux VPS, the installer reports the `loginctl enable-linger` command when the user service needs permission to remain active after logout.

For a self-hosted coordinator, enter its public HTTPS address in the connection wizard. The address can come from Tailscale Serve or an authenticated reverse proxy. Source installations can also set it before starting:

```bash
OPEN_HARNESS_BIND=0.0.0.0
OPEN_HARNESS_PUBLIC_URL=https://agents.example.com
npm run harness:serve
```

The dashboard token remains available only from the coordinator machine. Public runner endpoints accept scoped runner credentials or one-time pairing codes. A hosted Open Harness Site stores profiles, machines, runs, commands, and replayable events in D1; model credentials for hosted coordination belong in the selected runner's environment.

Each agent starts with a private container. **Selected folders** mounts only the named host folders and preserves their read-only or read-write setting. **Direct computer access** runs Hermes under the runner's OS account; install the pinned host runtime and policy extension before selecting it:

```bash
python3 -m pip install "hermes-agent[all] @ git+https://github.com/NousResearch/hermes-agent.git@939e45c91d751fadd94dcd1b873ac3cb44846213"
python3 -m pip install runtime/hermes/extension
hermes computer-use install
```

Existing desktop control also needs the interactive OS session and its platform permissions. macOS requires Accessibility and Screen Recording. Windows remote hosts require a logged-in desktop session. Linux requires X11 or Wayland with AT-SPI. Linux runners can instead give each isolated agent a private Xvfb/Openbox desktop.

Independent agents may share a runner up to its configured capacity. Existing-desktop sessions are serialized. A disconnected runner finishes work already admitted and buffers results until the coordinator returns; new work remains queued. Moving an agent exports managed private files, memory, and skills, verifies every checksum at the destination, and preserves the source if transfer fails.

Profiles are authoritative in SQLite. Each save creates a revision; active work keeps its original revision, and queued work snapshots the latest profile when it starts. Workspace model changes affect inheriting agents only. Disabling instructions preserves their text. Failed saves keep your draft, and conflicting saves ask you to reload the winning revision.

Tool choices compile into an explicit allowlist, including an empty list when everything is off. Newly discovered tools start disabled. The managed Hermes extension filters model-visible tools and rejects disallowed dispatch, including tools called from code and temporary subagents. Named handoffs use the recipient's profile. Terminal can still run programs that read files or access the network; switches do not add filesystem or network isolation.

MCP connections use inline configuration and a real initialize/tools-list handshake inside the agent container. Cached inventories are labeled unavailable until rechecked. The model picker uses Hermes's catalog; custom model IDs remain editable if the runtime is unavailable. Saved credentials are references, and only selected secrets are placed in the next run's environment.

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

The deterministic suite sets `OPEN_HARNESS_MOCK=1` and uses no paid inference. Full acceptance additionally requires a running Docker daemon and model credentials configured in Settings. Verify real code repair, Chromium navigation and screenshots, cross-agent isolation, named handoffs, memory/skill reuse, background routines, steering, process-tree stopping, and approval behavior before relying on a new Hermes release or provider model.

## License and attribution

Open Harness is MIT licensed; see [LICENSE](LICENSE). Hermes Agent is also MIT licensed and remains an upstream dependency. Its pin and attribution are recorded in [`runtime/hermes/NOTICE.md`](runtime/hermes/NOTICE.md). Dependencies retain their own licenses.
