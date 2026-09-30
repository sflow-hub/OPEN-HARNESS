# Local browser installation

Open Harness can run on a Mac or Windows PC through Docker Desktop, with the dashboard in your
own browser at `http://localhost:3000`. Everything runs in Linux containers: the coordinator,
the private container engine that hosts agents, and the agents themselves. Nothing has to be
installed on the computer except Docker Desktop — no Node, Python or Git.

**Status, stated plainly.** The launchers, the one-use browser pairing link and the exported
host-folder editor are implemented. Automated launcher tests drive both scripts against a
fake `docker` command (`tests/local-launchers.test.ts`): Bash 3.2 on a Mac VM and PowerShell
7.6.6 on Linux pass. The browser tests cover pairing and the folder editor against a mocked
coordinator. Compose itself, pairing and restore are exercised
end to end on Linux by `tests/compose-smoke.mjs`. A final Linux ARM64 archive rehearsal also
passes actual image download, launcher and manual browser pairing, private-desktop input,
and stop/restart persistence; its registry is a temporary local test registry, not a published
release. The MVP acceptance target is Docker running Linux containers plus a browser;
physical Mac/Windows hardware is not a release prerequisite. ARM64 and AMD64 artifacts
still require separate execution evidence, with emulation identified when used. Docker
Desktop start-up/file-sharing prompts, Gatekeeper, SmartScreen and Windows PowerShell
5.1 have not been verified on physical Mac/Windows hosts. Those compatibility checks
remain follow-up work in `ROADMAP.md`, and are not implied by the Linux results.

## What you need

- **Docker Desktop** — a supported macOS release (Apple Silicon or Intel) or supported
  Windows release with the WSL 2 backend. Check Docker's current requirements for
  [Mac](https://docs.docker.com/desktop/setup/install/mac-install/) or
  [Windows](https://docs.docker.com/desktop/setup/install/windows-install/).
  It must be in *Linux containers* mode (the default; Windows containers are refused).
- About **20 GB** of free disk for images, agent runtime and data.
- **A model provider.** Your agents, files, conversations and credentials stay on this
  computer, in Docker volumes. Model inference does not: requests go to the provider you
  configure (xAI, OpenAI, OpenRouter, or another hosted endpoint), and may cost money. A model
  server that listens only on this computer's `localhost` — Ollama or LM Studio in their default
  configuration, for example — cannot be reached from the containers, and the Docker Desktop
  installation refuses such addresses (and Docker's host aliases) with a message saying so.
  Use a hosted provider, or a model server with an address the containers can reach.

## Install

The prebuilt browser release is not published yet: final image scanning, per-architecture
Docker/browser acceptance and the final 24-hour soak remain release gates. Once it is published, download your platform's archive from the project's
GitHub Releases page:
`open-harness-browser-<version>.zip` (Windows) or `open-harness-browser-<version>.tar.gz`
(Mac), and extract the whole archive. Keep the extracted folder together; the launcher works
from wherever the folder is, spaces in the path included. It contains:

| File | Purpose |
| --- | --- |
| `Start Open Harness.command` | Mac: double-click launcher |
| `Start Open Harness.cmd` | Windows: double-click launcher |
| `launchers/start.sh`, `launchers/start.ps1` | The launchers themselves, for a terminal |
| `compose.yaml` | The Docker Compose definition, with every image pinned by digest |
| `image-lock.json` | The digests the release was tested with |
| `compose.host-folders.example.yaml` | Template for sharing a folder with agents |
| `runtime/dind-entrypoint.sh` | Start-up script of the private container engine |
| `docs/LOCAL_BROWSER.md`, `docs/SELF_HOSTING.md`, `LICENSE` | Installation, backup/restore, and the MIT license |

There is no source code in the browser release and nothing to build: the launcher downloads
the images listed in `compose.yaml` from the registry, by digest, the first time it runs
(several gigabytes; later starts reuse them).

## Start on a Mac

1. Install Docker Desktop and open it once, so it can finish its own set-up.
2. Double-click **Start Open Harness.command**.
   Because the file was downloaded, macOS may refuse to open it the first time ("cannot be
   opened because it is from an unidentified developer"). Either Control-click the file and
   choose **Open**, or open **System Settings → Privacy & Security** and choose **Open Anyway**
   next to the message about it, then double-click again. If you prefer not to change that,
   open Terminal, drag the release folder into it after typing `cd `, press Return, and run
   `bash launchers/start.sh` — the same launcher, without the double-click wrapper.
3. A Terminal window shows progress. The launcher finds Docker (on your `PATH`, or inside
   `Docker.app` if the command-line tools have not been put on `PATH` yet), starts Docker
   Desktop if it is installed but not running, waits for it (up to five minutes), downloads the
   pinned images on first use, starts the stack, waits for the app to answer, and then opens
   your default browser on a freshly paired window. The Terminal window waits for a key press when it is done, so that a
   message stays readable if something went wrong.

## Start on Windows

1. Install Docker Desktop with the WSL 2 backend and open it once.
2. Double-click **Start Open Harness.cmd**. SmartScreen may show "Windows protected your PC"
   for a downloaded script; choose **More info → Run anyway**. The wrapper runs
   `launchers\start.ps1` with Windows PowerShell 5.1 and `-ExecutionPolicy Bypass` for that
   one script only; it does not change the computer's execution policy. From a PowerShell
   window the equivalent is `powershell -NoProfile -ExecutionPolicy Bypass -File .\launchers\start.ps1`.
3. The console shows the same steps as on the Mac: find Docker (on `PATH`, or in the per-user
   `%LOCALAPPDATA%\Programs\DockerDesktop` or all-users `C:\Program Files\Docker\Docker`
   install), start Docker Desktop if needed, wait for it, check that it runs Linux containers,
   download the images once, start the stack, wait for health, open a paired browser window.

## The pairing link

The Docker Desktop installation does not hand its operator token to whoever visits
`http://localhost:3000`; a browser has to be *paired*. Each time the launcher opens a
window, it first mints a random, one-use pairing code inside the coordinator container and
opens `http://localhost:3000/#pair=<code>`. The fragment is omitted from the initial HTTP
request. The page removes it from the address bar immediately, then sends the code to the
local coordinator once to exchange it for the operator token. The launcher does not print
the code or write it to its log. The browser keeps the token for this coordinator address
only; later visits from the same browser need no link.

Consequences worth knowing:

- Each link works **once** and expires after five minutes. A browser that arrives with a used
  or expired link, and holds no token, sees "This link has already been used or has expired":
  run the launcher again and it opens a fresh window.
- A plain visit to `http://localhost:3000` from a browser that has never been paired shows
  "This browser isn't paired with Open Harness" — Open Harness itself is running; only that
  browser is not connected. Run the launcher to open a paired window, or pair by hand as
  described under *Terminal use* below.
- A browser that is already paired keeps working even if it is opened with an old link.
- A different browser, a different profile, or a private window is a different browser: it
  needs its own link. Do not share links; a paired browser has full operator access.
- The token is stored in that browser only. Clearing site data for `localhost` un-pairs it.

Every Compose installation requires pairing, including a source checkout started with
`docker compose up -d --build` or the launcher's `--build`. Only the native development
setup (`npm run dev`, coordinator on this computer, no containers for the dashboard) keeps the
previous loopback-only bootstrap and needs no link.

## Stop, restart, status, logs

Run the launcher again at any time: it is safe to run while Open Harness is already up, and
just opens another paired window. From a terminal in the release folder:

| Mac / Linux | Windows | What it does |
| --- | --- | --- |
| `bash launchers/start.sh` | `.\launchers\start.ps1` | Start (or check) the stack and open a paired window |
| `bash launchers/start.sh --stop` | `.\launchers\start.ps1 -Stop` | Stop the containers. Everything stays in the Docker volumes |
| `bash launchers/start.sh --status` | `.\launchers\start.ps1 -Status` | Show the containers and whether the app answers |
| `bash launchers/start.sh --logs` | `.\launchers\start.ps1 -Logs` | Show recent coordinator logs |
| `bash launchers/start.sh --no-open` | `.\launchers\start.ps1 -NoOpen` | Start and wait for health without minting a code or opening a browser (for scripts and acceptance runs) |
| `bash launchers/start.sh --override <file>` | `.\launchers\start.ps1 -Override <file>` | Add your edited host-folder override (see below) |
| `bash launchers/start.sh --timeout <seconds>` | `.\launchers\start.ps1 -Timeout <seconds>` | Change the five-minute wait for Docker and for health |
| `bash launchers/start.sh --build` | `.\launchers\start.ps1 -Build` | Development only: build from a source tree instead of using the pinned images |

The PowerShell launcher also accepts the `--long` spellings, so the same command line works in
both. Every message is also appended to `open-harness-launcher.log` in the release folder; pairing
codes and tokens are never written there.

The launcher never chooses a Compose project name of its own: the stack is the `open-harness`
project from `compose.yaml`, and a `COMPOSE_PROJECT_NAME` you set in the environment is passed
through unchanged, as with any `docker compose` command. Packaged releases keep this default
name across extraction folders, so moving to a new release folder keeps the same workspace.
It never runs `docker system prune`,
never removes a volume, and never exposes the engine socket. Stopping, a failed start, or a timeout leaves your data where it is. To remove
Open Harness and **all of its data** deliberately, stop it and run
`docker compose -f compose.yaml down -v` in the release folder yourself; that is not something
the launcher will do for you. Back up first — the stopped-stack backup and restore procedure is
in [Self-hosting operations](SELF_HOSTING.md).

## Sharing a folder with agents

By default nothing on this computer is visible to any agent: each agent works in its own
container, and only the shared workspace inside the Docker volume is common to them. To let an
agent read or edit a real folder, the folder is first *exported* to Open Harness through a
Compose override, and then *granted* to that agent in its settings. The two steps are separate
on purpose: exporting makes a folder available, it does not give any agent access to it.

1. Stop Open Harness (`--stop`, or `-Stop`).
2. Copy `compose.host-folders.example.yaml` to a name of your own, say `my-folders.yaml`, and
   replace the example source path with the folder on your computer. Use forward slashes,
   and quote the path if it contains spaces:

   ```yaml
   # Mac
   source: /Users/name/Project
   # Windows
   source: C:/Users/name/Project
   ```

   Keep both `open-harness` and `docker` entries pointing at the same folder with the same
   `read_only` value: the coordinator validates grants against one, the agents' engine mounts
   the other. The `target` is the exported path offered in Agent settings,
   `/host-folders/project` in the example; give each exported folder its own
   `/host-folders/<name>`. Inside the agent, grants appear in order at
   `/workspace/mounts/folder-1`, `/workspace/mounts/folder-2`, and so on.
   `read_only: true` is a ceiling: an
   agent can then be given read access to it and nothing more. On a Mac, Docker Desktop also
   has to be allowed to share the folder's location (**Settings → Resources → File sharing**);
   on Windows, folders under your user profile are shared through WSL 2 without extra set-up.
3. Start with the override: `bash launchers/start.sh --override my-folders.yaml` or
   `.\launchers\start.ps1 -Override my-folders.yaml`. Use the same option for every launcher
   command from then on — `--stop`, `--status`, `--logs` — so that every command sees the
   same stack. Changing the exported folders means stopping and starting again with the
   edited file; mounts are fixed while the containers run.
4. In the dashboard, open **Agent settings → Computer**, choose **Selected folders**, open
   *Advanced resources and shared folders* and add a folder. On a Docker Desktop installation
   the path is chosen from the exported folders, at their `/host-folders/…` paths, and a folder
   exported read-only can only be granted read-only; a path on your computer such as
   `C:\Projects\website` or `/Users/name/Project` cannot be typed there, because the containers
   cannot see it. When nothing is exported yet, the editor says so and points back to this
   procedure. Save the profile; the grant applies to that agent's next task.

## Terminal use and manual pairing

The launchers are ordinary scripts; everything they do can also be done by hand with
`docker compose -f compose.yaml …` in the release folder (add `-f my-folders.yaml` when you use
an override). To pair a browser without the launcher, mint a code on this computer and open the
link within five minutes:

```bash
docker compose -f compose.yaml exec -T open-harness node /opt/open-harness/runtime/browser-pair.mjs
# prints {"code":"…","expiresAt":"…"}; then open http://localhost:3000/#pair=<code>
```

This is also how a `--no-open` run gets a browser afterwards. Put the code only in the
fragment (`#pair=`), never in a query string, and do not paste it anywhere else.

## Development: building from source

From the source folder, with Docker Desktop installed, run:

```bash
# macOS or Linux
bash launchers/start.sh --build
```

```powershell
# Windows PowerShell
& '.\Start Open Harness.cmd' --build
```

A source checkout can use the same launchers. `--build` (`-Build`) builds the coordinator image
from the `Dockerfile.coordinator` next to `compose.yaml`, starts with `docker compose up -d
--build`, and sets `OPEN_HARNESS_HERMES_PULL=0` so that the agent runtime image is prepared
from the checkout's own Hermes build instead of the published one. A checkout has no
`image-lock.json`; the launcher asks for one only in release mode, and in a checkout every
action is given together with `--build` (`--build --stop`, `--build --status`, `--build --logs`)
so that the same files are used throughout. `--build` is refused in a downloaded browser
release, which has no source tree — that release always uses the pinned images and never
builds anything. Pairing applies to a source Compose stack exactly as to a release.

## When something goes wrong

The launcher stops at the first problem, says what it found, and prints how to look further:
`docker compose -f compose.yaml ps`, `docker compose -f compose.yaml logs --tail=100 open-harness`,
and the path of `open-harness-launcher.log`. Its exit code says which stage failed:

| Exit code | Meaning |
| --- | --- |
| 0 | Done |
| 2 | Docker Desktop is not installed, did not become ready in time, is set to Windows containers, or has no Compose v2 |
| 3 | Docker Compose could not download the images or start (or stop) the stack |
| 4 | The containers started, but the app did not answer at `http://127.0.0.1:3000/api/health` within the timeout. The containers are still running and your data is intact |
| 5 | The app is running and healthy, but no paired window could be produced: either no connection link could be minted (the pairing helper in the coordinator failed, printed nothing, or printed something that is not a code — usually a coordinator image older than this launcher; check `--logs`), or no browser could be opened from this session (no desktop, or `open`/`xdg-open` missing). Nothing is opened in either case; run the launcher again once the cause is fixed, or pair by hand |
| 64 | Wrong option, incomplete release folder, missing override file, or `--build` without a source tree |

Common cases:

- **"Docker Desktop is not installed"** — install it from
  <https://www.docker.com/products/docker-desktop/>, open it once, then run the launcher again.
  The launcher looks in the usual places before saying this: on a Mac, a `docker` on your
  `PATH` first, then the copy inside `/Applications/Docker.app` (or `~/Applications/Docker.app`)
  and `~/.docker/bin`; on Windows, `docker.exe` on `PATH`, then the `resources\bin` folder of a
  per-user install (`%LOCALAPPDATA%\Programs\DockerDesktop`, the installer's default) or an
  all-users install (`C:\Program Files\Docker\Docker`). Whatever is on your `PATH` first is
  what gets used; the install locations are only consulted when `PATH` has no `docker`.
- **"…no browser connection link could be created"** (exit 5) — the containers are up, but the
  pairing helper inside the coordinator did not produce a code. Run `--logs`; if this release's
  launcher is newer than the images it found, update the release folder so that `compose.yaml`
  and the launcher match, then run it again.
- **"Docker did not become ready"** — Docker Desktop can take a few minutes on first start,
  and may be waiting for you to accept its terms or finish WSL 2 installation. Let its icon
  settle, then run the launcher again, or use `--timeout 600`.
- **"Docker is running windows containers"** — switch Docker Desktop to Linux containers
  (its menu → *Switch to Linux containers…*).
- **Port 3000 is in use** — Compose fails with exit 3 and names the port in its output. The
  dashboard's port is fixed at 3000 in this release (only the listening address can be changed,
  through `OPEN_HARNESS_LISTEN_ADDRESS` in a `.env` file next to `compose.yaml`), so stop the
  other program and run the launcher again.
- **Health timeout (exit 4)** — run `--status` and `--logs`. A first start after a download can
  take longer than the default while the coordinator prepares its data volume; simply running
  the launcher again continues waiting without restarting anything.
- **"This link has already been used or has expired"** — run the launcher again; each link is
  single-use. **"This browser isn't paired"** — same, or pair by hand as above.
- **A shared folder is not offered in Agent settings** — the override was not passed at start,
  the `source` path is wrong or not shared with Docker Desktop, or Open Harness was not
  restarted after editing the file. Check the resolved mount configuration with
  `docker compose -f compose.yaml -f my-folders.yaml config` (using your override's name),
  then compare it with the exported-folder list in Agent settings. `--status` shows
  container state and health.
