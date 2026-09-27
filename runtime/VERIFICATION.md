# Runtime verification

## Final local browser checkpoint — September 26, 2026

The final unreleased runtime-contract-6 source passes **218 Node tests**, with one
expected platform skip, **120 desktop/mobile browser tests**, typecheck, full lint,
and the production build on Ubuntu 24.04 ARM64. PowerShell 7.6.6 was on PATH for the
Node suite, so both launcher implementations ran. The final run corrected two test
assumptions: the Dockerfile layer check now distinguishes early dependency constraints
from the late managed-policy copy, and the Compose environment fixture preserves the
required `ProcessEnv` type. The affected contract/packaging tests pass **21/21**.
Application, runtime and image-build source remained unchanged after the image freeze.
Logs: `/private/tmp/oh-browser-contract6-integrated-checks-final.log` and
`/private/tmp/oh-browser-contract6-static-browser.log`.

The **actual downloaded ZIP/tar rehearsal passes** with the final coordinator, Hermes
and official Docker 29.8.1 engine. It verifies an empty-engine anonymous digest pull
from a disposable loopback registry (34.35 seconds), launcher pairing and replay
refusal, manual same-document pairing without reload, and immediate guide dismissal
after setup. A real cached `available:false` response was observed, followed by the
sidebar becoming ready without reloading. Chromium opened before the first computer
driver call supports real clicking and typing with DOM readback before and after
launcher stop/restart. Closing the browser preserves active work; profiles, tasks,
private/shared files, the data volume and the paired browser credential survive.
All 23 captured source hashes match. The final and failed locator-only fixture
resources were cleaned. Safe evidence:
`/private/tmp/open-harness-local-package-contract6-evidence-20260926.tar.gz`, SHA256
`05d828fea907265a546ff5fcb17c68591bdf8e28463088a64152370912147aa9`.
This is a Linux ARM64 local-registry rehearsal, not published GHCR acceptance or the
production validator's two-architecture gate.

A subsequent full `tests/compose-smoke.mjs` run against these **same final images**
also passes stopped-backup/empty-volume restore. All **6,873** entries match content
hashes, ownership and permissions. Restored profiles, rotated credentials used by an
actual follow-up run, private/shared files, memory, skills, tasks and history survive;
uncertain interrupted work is not replayed. A fresh engine cache and actual desktop
click/type after restore pass, along with pairing/authorization, explicit folder
grants and two-agent desktop isolation. This fixture streams the prebuilt runtime
image into its private engines; it complements the separate real digest-pull rehearsal
above. Both disposable projects and their volumes/networks were removed, and the
credential-bearing raw backup was deleted after exporting safe evidence. Archive:
`/private/tmp/open-harness-final6-backup-restore-evidence-20260926.tar.gz`, SHA256
`a644aa47c2b46f06752a216fb3037d823e20626fe4d3749812f6e8a3104981b0`.
This restores a final-version installation; older-version upgrade/rollback and the
24-hour soak remain separate release requirements.

A supplementary **v0.3.0 data upgrade and backup rollback** check passes 128
assertions. The unchanged historical backend at `cafc0a4` created its state through
ordinary APIs; all 42 captured historical source hashes match that commit. Final6
preserved 37 original rows across 15 populated tables, profiles/revisions, events,
routines, task data, memory, skills, private/shared files, credentials and the operator
token. The current entrypoint refused existing root-owned data without changing it;
the documented application-volume ownership migration enabled startup. Restoring the
pre-upgrade backup into a separate empty volume recovered schema 0 and original root
ownership, excluded post-upgrade changes, and allowed the old backend to work again.
All owned containers/volumes were removed. Safe evidence:
`/private/tmp/open-harness-upgrade-v030-evidence-20260926.tar.gz`, SHA256
`7ed52ca4fbe6694f2a38954b0fb8aa4d4c4700aca23ba70b150ec634c24bec39`.

This is data/API/credential/backup compatibility evidence with **mocked run execution**.
It does not exercise a historical Hermes image, old dashboard/installer, real inference
or a desktop-runtime upgrade. Final6's service was invoked directly because its
production supervisor correctly forces live mode. The full historical-upgrade release
checkbox remains open; actual current-runtime/Compose evidence is recorded separately.

The reviewed soak fixture also passes a **368.33-second rehearsal** on these exact
final images: six actual core-tool runs and six conversation follow-ups, six pending
approval browser reconnects (three approvals and three denials with file-mode checks),
one coordinator restart with persistence, and actual desktop click/type at start,
after restart and at end. Seven disk/health samples show at least 9.55 GB free and at
most 129.1 MB application-data growth. All owned containers, volumes and networks were
removed. Safe evidence:
`/private/tmp/open-harness-soak-rehearsal-evidence-20260927.tar.gz`, SHA256
`20b39b9265ca34dfad3439f6f1a758d35c710f04c0b334c285a35fb87bf4fcee`.
This short run explicitly reports `twentyFourHoursCompleted:false`. The full
86,400-second run was subsequently launched with 900-second task intervals;
**24-hour acceptance remains pending** until its final result and cleanup pass.

The final real-Hermes protocol fixture also passes tools, clarification, task MCP,
approval/denial side effects and conversation continuity. Its exact-image evidence is
`/private/tmp/open-harness-final6-evidence-20260926-UdSjwSPu/`. The image identities are:

| Image | Immutable Docker index ID | Separate BuildKit configuration digest |
| --- | --- | --- |
| Coordinator | `sha256:cd1085b10dc3576c7522e3c03ddc3cd478c411bd8d13cd401c05980a913ba8c9` | `sha256:4240e454cb76603b7b2cf061e91227f5de369eef3e83cd834de28bbf0b9a242d` |
| Hermes | `sha256:d81b01ed79d179a028a712831e89415aee0d4b629d238bf567435dd230782bb2` | `sha256:3bcb755402cec22e13a4de0a23c393e78a33f6aec80d0911898c2bd843f9cd36` |

The unchanged strict Trivy 0.74.0 HIGH/CRITICAL vulnerability and secret gate **still
fails all three images**. No unfixed finding is suppressed. Occurrence counts are not
an exploitability assessment; zero HIGH/CRITICAL secret findings is not an all-secrets
guarantee.

| Image | HIGH | CRITICAL | Distinct vulnerability IDs |
| --- | ---: | ---: | ---: |
| Final coordinator | 54 | 0 | 15 |
| Final Hermes | 94 | 1 | 36 |
| Exact official Docker 29.8.1 engine | 28 | 0 | 16 |

Final coordinator evidence is
`/private/tmp/open-harness-coordinator6-final-evidence-20260926.tar.gz`, SHA256
`e01a6dc951c303c326f081ce67eacf7696565774f7807306daa8725489c04fdf`.
The engine reference is
`docker:29.8.1-dind@sha256:3f3c01aaaebf7cce837356b688b7c059a4749f10bd7660dec7c58fc454a283f0`;
its earlier exact-image scan and full Compose restore evidence remain applicable.

Packaging now writes the stable default project name `open-harness`. Actual Compose
normalization across two versioned extraction folders confirms the same application
volume; environment and CLI project-name overrides still take precedence. The strict
Ubuntu packaging checks pass 12/12. Evidence:
`/private/tmp/open-harness-project-name-evidence-20260926-E6KX03ih/`.

Local source checkpoint `550f765906b7451899a8b23e9b149f84f9f6d374` is committed
in the isolated release-candidate worktree. Its actual Git-HEAD source archive contains
**189** matching tracked files, preserves executable launcher modes, and excludes local
state, conflict copies and collaboration artifacts. The original working tree and its
index were preserved. Archive:
`/private/tmp/open-harness-source-candidate-20260926-dlfh2zos/open-harness-self-hosted-0.4.0-beta.1.tar.gz`,
SHA256 `bf4c77e871570b5757a139bc62e25672ac23aea23393223e18912016d65679b1`.
Verified Trivy 0.74.0 scanned that exact extracted source for secrets at **all severities**
with an empty ignore file: exit 0, zero detections. Evidence:
`/private/tmp/open-harness-source-secret-evidence-20260926-3XulSe4t/evidence.tar.gz`, SHA256
`57c87754cbf85b831bdc1abd0a77923d5f0003a206811939cd77aabb96ec5f05`.
This source scan does not clear the separate image vulnerability gates. The pre-existing
local images have source-hash evidence; a published candidate must still be rebuilt and
validated from its final tagged source with matching image revision labels.

**Release remains blocked:** resolve the image scan findings, validate native AMD64
images, run Docker Desktop acceptance on Apple Silicon Mac, Intel Mac and Windows,
and publish/verify the committed-source multiarch packages. No image, tag, release or
PR has been published during this work. The current Mac VM has no hypervisor support;
its Bash launcher tests cannot establish Docker Desktop support. Signed native
installers remain a separate acceptance path.

Claude Desktop's separate Ubuntu AMD64 microVM was checked as a possible builder.
Its installed Docker 29.4.3 engine started on a temporary private Unix socket and
ran a minimal local container, but the normal Docker Hub image pull failed with
`403 Forbidden` from the environment's mandatory proxy. GHCR CONNECT was also
denied. No Open Harness AMD64 image was built or pulled, no registry relay or proxy
workaround was used, and no global trust configuration changed. Claude reported
verified cleanup of its temporary daemon, containers, networking and data roots.
This establishes an environment access blocker, not AMD64 product acceptance.

## Earlier local browser integration checkpoints — September 26, 2026

The Docker browser work is **not yet a published or platform-accepted Mac/Windows
release**. The following evidence is from Ubuntu 24.04 ARM64, Node 22.23.3, Docker
Engine 29.8.1 and Compose 5.5.1. Source Compose/restore and a separate downloaded-archive
rehearsal are recorded below. The latter pulls anonymously from a disposable loopback
registry; it is not a published GHCR release or a production image-lock validation.
The scripted local model fixture verifies transport/tools/state; no paid provider or
model-reasoning acceptance was performed here.

Current source changes include mandatory one-use CLI/browser pairing for Compose,
minimal public readiness separate from authenticated diagnostics, digest-pinned runtime
setup without a source-build fallback, and host-folder grants restricted to exact
explicitly exported outer mount roots with a read-only ceiling. Subfolders require
their own export. Compose rejects localhost-only host model URLs before provider
requests or profile writes; a host-model relay is not implemented. Claude delivered the
browser client, host-folder editor and launchers; the final reviewed delivery passes
**214** Node tests (three expected skips), typecheck, full lint, production build, and
all **110** desktop/mobile browser tests in the Ubuntu integration copy
(`/private/tmp/oh-browser-final-integrated.log`). A separate run with verified official
PowerShell **7.6.6** on Linux passes all **17** launcher cases, including both previously
skipped PowerShell cases (`/private/tmp/oh-browser-final-powershell.log`). The Mac VM
presents Bash **3.2** and passes **26** launcher/packaging checks with two expected
PowerShell skips (`/private/tmp/oh-browser-final-mac-launchers.log`). The subsequent
packaging-only change bundles the backup/restore guide alongside the installation guide;
ZIP/tar checks pass **11/11** (`/private/tmp/oh-browser-final-package-tests.log`). These
launcher cases use fake Docker responses. Pairing UI coverage uses mocked routes;
the completed real package rehearsal below covers the original full-page pairing path.
It exposed two UI follow-ups still being integrated: manual pairing after a same-document
fragment change, and an outdated sidebar runtime label after successful setup.

Actual `tests/compose-smoke.mjs` acceptance passed against runtime contract **4**:

- Unauthorized, expired and replayed pairing attempts fail; authenticated control,
  forged-Host refusal and nested-agent operator-token denial pass. The private engine
  exposes no TCP listener, and the coordinator/data use UID 1000.
- Actual Hermes file, clarification, task MCP, denied-tool and prior-conversation flows
  work. A saved credential is rotated, then used successfully by subsequent real requests.
- Physical exported folders with spaces preserve read-only/read-write grants for the
  selected agent. Ungranted peers, `/data`, and unexported descendant paths are denied.
- Browser-first accessibility clicks, typing with DOM readback and PNG screenshots work
  in the private desktop. Two agents have separate private files and windows; Shared
  files remain intentionally shared. Graceful stop terminates active work.
- A stopped data archive restores into an independently named **empty** application
  volume. All **6,725** file/directory entries match hashes, ownership and permissions
  before reopening. Profiles, rotated credentials, private/shared files, memory, skills,
  tasks and history survive. A real conversation uses the restored credential, uncertain
  interrupted work is not replayed, and actual desktop input works again after restore
  with a fresh private-engine cache.

This gate exposed and fixed an unauthenticated-bootstrap health probe and a private
accessibility startup-order defect. The session now enables accessibility before any
application launches; old images require a full contract-4 rebuild or the matching
release image, not a policy-only patch. The permanent fixture launches Chromium before
its first computer-driver call so doctor initialization cannot mask this regression.

The full Node checkpoint passes **183/183**, typecheck and full lint. Subsequent release-packaging checks pass **11/11**, scoped lint and actionlint, including Docker 29 containerd index/configuration-digest separation reproduced from real BuildKit history. No registry mutation was performed. Test output is
`/private/tmp/oh-browser-local-runtime-checks-4.log`. Exact runtime/helper hashes and
Docker image IDs plus their separate BuildKit configuration digests are in
`/private/tmp/open-harness-browser-acceptance-evidence-20260926.tar.gz`. It contains
safe evidence/logs/screenshots only; the credential-bearing backup and raw state are
excluded. All acceptance containers, volumes and networks were removed. Isolated test
image tags are retained for final integration; prior installation tags are unchanged.

A subsequent **contract-5** image adds synchronous desktop-initialization completion
for native Linux selected-folder startup. Actual ordinary Docker checks verify pinned
folder admission, read-only write refusal, read/write persistence, immediate X11/D-Bus
and desktop-driver readiness, inert manual restart, and fresh containers on new
admission. Focused Linux checks pass 27 tests with one expected platform skip; scoped
TypeScript and lint pass. Safe evidence is
`/private/tmp/open-harness-native-folder-evidence-20260926.tar.gz`. This is separate from
the contract-4 Compose/restore evidence above; final contract-5 integration is in progress.

A **contract-5 downloaded-package rehearsal** now passes on Linux ARM64. Both ZIP and
tar extract into a path with spaces with matching contents/modes and the offline
backup/restore guide. The actual launcher starts the stack, mints a one-use code, and
the real browser exchanges it; plain unpaired access and replay are refused. First-run
setup anonymously pulls the exact runtime digest into an initially empty private
engine (55 seconds in this run). Chromium is opened before the first computer-driver
call; accessibility click/type with DOM readback works before and after launcher
stop/relaunch. Work waiting for input remains active while the browser is closed.
Profiles, tasks, private/shared files and the browser credential persist across restart.
All fixture resources are cleaned, without touching earlier image tags. Safe evidence:
`/private/tmp/open-harness-local-package-evidence-20260926.tar.gz`, SHA256
`22b253bfb5309a62dde8edbc602f83ce7ad9b0b8c79364d5f398a555ce3ce593`. This uses a
fixture-only ARM64 lock/local registry; the production validator remains unchanged and
requires both architectures, official image repositories, and the release revision.

Production dependency audit on September 26 reports **0** known vulnerabilities. That
result covers npm production dependencies, not the agent image. The actual contract-5
Hermes image **fails** the required Trivy 0.74.0 release gate: 363 HIGH and 23 CRITICAL
occurrences, representing 287 distinct vulnerability IDs. The exact scanned Docker ID is
`sha256:df5c74e123e2a01537466f2a894a79d9da5e3f28b0c01ef4efbf6507f8873d6a`.
No HIGH/CRITICAL secret findings were reported. The scan uses the September 26 database,
no ignore file and no suppression of unfixed issues. Most findings are Debian package
families (including development headers); npm's bundled libraries and pinned Python
HTTP dependencies also require review. Occurrence counts do not establish exploitability.
Safe provenance and the private report are under
`/private/tmp/open-harness-release-scan-20260926-pFenT5hv/`. Publication is blocked while
an isolated dependency/base-image remediation candidate is evaluated. The release scan
gate remains unchanged.

The rebuilt functional coordinator also fails the unchanged image gate: **84 HIGH**
and **5 CRITICAL** occurrences, **45** distinct IDs. Its Docker image ID is
`sha256:5af91d089d6bd2c96886ec4543e7760c42dc3a51ad9d1cd2b5a09f1c5016f43c`;
its separate BuildKit configuration digest is
`sha256:ab5eb5c698061a800f47d9bbec88b5be730b174af5d5d72bb11e851568ab287e`.
An isolated Hermes packaging candidate updates the supported Debian base, Node/npm and
matching Python HTTP dependencies without changing Hermes's pinned reasoning source.
The final packaging candidate passes the full real Hermes protocol and private-desktop
fixtures, 920 native-library checks, and ordinary selected-folder/recreation checks.
The tests caught and corrected Trixie's restrictive `/home/hermes` parent mode and a
second HTTP dependency pin in Hermes's lazy installer. Both dependency metadata files
are hash-checked before the narrow version override; reasoning control flow is unchanged.
The image still fails the same scan with **94 HIGH** and **1 CRITICAL** occurrences,
**36** distinct IDs, all from Debian packages. Safe evidence is under
`/private/tmp/open-harness-hermes-candidate4-evidence-20260926-hlYjEK0A/`.
The verified packaging changes are now integrated into unreleased source with runtime
contract **6**; its separate final image rebuild and combined acceptance are in progress.
Neither image is approved for publication. No HIGH/CRITICAL secret findings were
reported in either scan. Scanner counts do not establish exploitability.

The revised coordinator packaging uses pinned Node 24/Trixie, verified npm 11.20
and the official Docker CLI/Buildx, retaining the curl health probe and removing the
unused coordinator daemon stack. It passes the full ordinary Compose agent, desktop,
restart and stopped-backup/restore fixture, plus a benign source-build transport check.
Its strict scan still fails with **54 HIGH**, **0 CRITICAL** findings (15 distinct IDs).
Safe evidence is `/private/tmp/open-harness-coordinator-candidate-evidence-20260926.tar.gz`.
The release workflow now also scans the exact private-engine manifest for each native
architecture; the previously cached Engine 28.5.2 image fails with **348 HIGH** and
**15 CRITICAL** findings. A current official Engine 29.8.1 candidate reduces these to
**28 HIGH**, **0 CRITICAL**, but still fails the gate. Its full ordinary Compose
fixture passes engine API/source-build transport, Unix-socket-only isolation, browser
pairing, agent/desktop/folder behavior, restart and empty-volume restore. Both native
architecture manifests exist; execution here is ARM64 only. Safe evidence is
`/private/tmp/open-harness-dind29-candidate-evidence-20260926.tar.gz`. Source Compose and
release resolution now use the tested official 29.8.1 multiarch digest
`sha256:3f3c01aaaebf7cce837356b688b7c059a4749f10bd7660dec7c58fc454a283f0`.
No findings are suppressed.

Outstanding before release: verify the two observed UI corrections against a rebuilt downloaded package;
package the final committed source; run native AMD64/ARM64 build/scan/publish and
anonymous downloaded ZIP/tar/launcher acceptance; make the release image packages
public; and test Docker Desktop on Apple Silicon Mac, Intel Mac and Windows. Current
Mac access is a VM without hypervisor support (`kern.hv_support=0`), so it cannot serve
as Docker Desktop acceptance. Signed native desktop installers remain separate. The
release workflow implementation is preparation, not evidence that those gates ran.

## Sandboxed computer control — September 26, 2026

This follow-up supersedes the native Direct Computer Access availability described in
older entries. Computer control uses the existing per-agent Docker boundary and a
private Linux Xvfb/Openbox desktop. Shared workspace files remain shared. Native
Direct / Existing desktop profiles stay readable for explicit conversion but are
rejected at save, run creation/start, discovery/probes, transfer, runner execution and
persisted command polling. No host Python or desktop-session fallback remains in the
coordinator, runner or installers. Saved local native PID identities still receive
upgrade cleanup. Already admitted work on older remote runner binaries requires
stopping and updating those runners.

Codex and Claude Desktop agreed this contract after reviewing native process sandboxing:
controlling the operator's existing desktop can drive applications outside a process
sandbox. A sandbox-exec prototype denied an ungranted file, but does not establish desktop
isolation; it was not shipped. No new sandbox dependency or system-wide security bypass
was added. These changes alter container-isolation enforcement and legacy execution
compatibility, not the single-trusted-operator authentication model.

Actual Ubuntu 24.04 ARM64 checks used Node 22.23.3, Docker 29.8.1, the source snapshot at
`/home/developer/src/open-harness-desktop-sandbox-20260926`, and the already rebuilt,
pinned `open-harness-hermes:sandbox-20260926` image. No image source changed in this pass.

- `tests/real-desktop-smoke.mjs` now uses the production `ensureContainer` factory:
  real Chromium screenshot, coordinate click, accessibility-token click and typing
  verified by DOM readback; stale-token refusal; two agents' separate X11/D-Bus desktop
  sessions and windows; host/other-agent private sentinel denial; own credential access;
  Shared read/write; private-desktop restart; disabling desktop access replaces the
  container and removes its display while preserving private files. Evidence:
  `/tmp/open-harness-desktop-smoke-byhrfI/evidence.json`.
- The real filesystem sandbox gate still passes all eight check groups, including kernel
  limits and folder-grant revocation. Evidence:
  `/tmp/open-harness-sandbox-XoPa0o/evidence.json`.
- The real pinned Hermes gateway passes file, clarification, task MCP, context continuity,
  denied/approved terminal actions, and cleanup with a scripted provider. Evidence:
  `/tmp/open-harness-real-smoke-6rbP5t/evidence.json`.
- The actual standalone installed Linux runner passes pairing, user service, encrypted
  credential dispatch/rotation, transfer, remote file/input/MCP/memory/skills, restart,
  event replay, revocation and cleanup. Evidence:
  `/tmp/open-harness-runner-smoke-YUkS6p/evidence.json`.

Runtime Node tests: 165/165, including legacy native-process recovery, rejection before
spawn, blocked old-runner capabilities and persisted commands, direct runner rejection,
and safe staging of legacy-profile conversion to a remote sandbox. The final combined
tree passes typecheck, full lint, production build and all 94 desktop/mobile browser
cases on Ubuntu ARM64. Claude independently passes the same Node165/browser94 gates on
Ubuntu x86-64. The seven delivered UI files match Claude's SHA-256 hashes; all 160 files
in the final source snapshot match the Ubuntu checkout.

Computer settings are available without Advanced features. The UI offers a private
agent desktop only on a capable Linux machine, explains unsupported machines, and
preserves legacy settings until explicit conversion. Desktop control remains a separate
tool grant: the browser acceptance enables it through the guidance beside the desktop
switch and verifies both saved settings. No permission is granted automatically.

Evidence, screenshots and final logs are collected locally in
`/private/tmp/open-harness-desktop-sandbox-evidence-20260926.tar.gz`; the source snapshot
and manifest are `/private/tmp/open-harness-desktop-sandbox-source-20260926.tar.gz` and
`/private/tmp/open-harness-desktop-sandbox-source-20260926.tar.sha256.json`.
All fixture containers and the temporary installed-runner service were removed.
These scripted fixtures verify enforcement and transport, not model reasoning or paid
provider behavior. macOS/Windows host-desktop isolation is not offered or claimed.

## Per-agent sandbox follow-up — September 26, 2026

Checked the current working tree with Claude's delivered UI in place. The requested
boundary keeps Shared files available to all agents while isolating private files and
ungranted host paths. Validation used a separate Ubuntu 24.04 ARM64 checkout at
`/home/developer/src/open-harness-sandbox-20260926`, Node 22.23.3 and Docker 29.8.1.
`npm run harness:setup` rebuilt the pinned runtime under the separate
`open-harness-hermes:sandbox-20260926` tag; existing installation images were preserved.

Fixed host-side profile temporary writes that could follow agent-planted links, hardened
workspace imports/uploads and file previews (including a link swap at open time), and
regenerated the standalone runner. Both sandboxed access modes now require Docker in
readiness and transfer validation. Folder mounts reject files, sockets and linked paths
before replacing a container. These are container-boundary and host-file-access changes;
At this earlier checkpoint Direct Computer Access remained an explicit unsandboxed mode; the subsequent computer-control follow-up above disables it.

The new `tests/real-sandbox-smoke.mjs` passed eight groups of checks with real production
containers and no model calls: separate private/profile mounts and selected credentials;
refusal of individual files, Unix sockets and links planted by an agent as folder grants;
intentional shared read/write files; non-root UID, zero effective capabilities, seccomp,
no-new-privileges and kernel CPU/memory/PID limits; immutable managed policy; resistance
to profile temporary-link writes; read-only/read-write folder enforcement; replacement
and mount revocation on return to Private workspace; and shutdown cleanup. Related checks
share groups. No agent received a Docker socket or could see the host sentinel or the
other agent's private paths. The real sandbox smoke is included in the runtime CI workflow.

The final Node suite passes **163/163**, with typecheck, full lint, production build and
diff checks passing. The unchanged UI passes **86/86** desktop/mobile browser cases with
the mock runtime. The rebuilt image also passes the real Hermes gateway smoke: allowed
file tools, denied Terminal dispatch, clarification, authenticated task MCP, distinct
sessions, prior context, explicit approval deny/approve and container shutdown. No paid
provider was used. Test containers were removed by their exact IDs.

Evidence: `/tmp/open-harness-sandbox-l9ASyy/evidence.json` and
`/tmp/open-harness-real-smoke-b4GgFl/evidence.json` on the VM, plus
`/private/tmp/open-harness-sandbox-evidence-20260926.tar.gz` locally. This establishes the
tested Linux filesystem/process boundary, not a kernel security certification or new
macOS/Windows Docker acceptance. Shared files and outbound networking (including reachable
host services) remain available. Saved permissions apply to the next task; stop active
work first when tightening access must be immediate. See `SECURITY.md` for these limits.

## Recent-commit integration — September 25, 2026

This pass starts at `main@3415d71` on `codex/recent-commit-integration`. It keeps the
new saved Credentials, teams/projects, canonical MCP tool names, encrypted runner dispatch,
Hermes pin and approval protocol. Removed hosted/native-mobile surfaces stay removed.
Earlier acceptance on the separate `codex/mvp-readiness` branch is not evidence for this tree.
The VM uses the isolated image tag `open-harness-hermes:integration-20260925`; its existing
default image is preserved. Updated installations must prepare runtime contract 3.

Validation ran on the separate Ubuntu 24.04 ARM64 VM with Node 22 and Docker, using isolated
source checkouts and disposable state. The untouched incoming tree passed 111 Node tests,
52 browser tests, typecheck, lint and build; new regression cases then exposed failures that
those suites did not cover. The integrated backend passes 158 Node tests, typecheck, full lint
and production build. Workflow actionlint, shell/Python syntax and diff checks also pass.
With the UI patch applied (below), the same tree also passes 86 production browser cases.

Current real integration evidence uses the pinned Hermes runtime and scripted local
OpenAI-compatible providers. No paid provider was called during this pass; these results
establish tool/transport/state behavior, not model reasoning:

- **Actual Docker gateway:** file tools, clarification, canonical task-board MCP dispatch,
  denied tools, distinct session IDs and prior-conversation context work. An explicitly manual
  approval test denies and then approves a flagged chmod; the file stays 0600 until approval,
  then changes to 0666. The shipped `smart` guardian policy remains unchanged.
- **Cold production Compose:** fresh private engine storage starts without a Hermes image;
  setup builds runtime contract 3 through the dashboard proxy in 227846 ms. The coordinator
  and data run as UID 1000. Saved credentials authenticate actual requests, rotate between runs
  and preserve metadata. Team-scoped tasks, file/input/context/history, restart persistence
  and graceful shutdown pass. The engine has no TCP listener. Actual nested agents cannot
  reach dashboard bootstrap through its container address or published port, even with a
  loopback Host header. Production CSP and forged-Host checks pass.
- **Installed runner:** the downloaded standalone runner and its Node runtime run as a
  disposable Linux user service. Encrypted command delivery, credential authentication and
  rotation, remote memory/skill edits and tool reads, transfer, sessions, replay, restart and
  revocation pass. The installer persists the selected image and replaces stale contracts.
- **Persistent workflows:** Hermes writes canonical memory and a skill, then reads both in a
  new session and after a coordinator restart. Shared-team named delegation returns the child
  artifact/result. A persisted one-minute routine dispatches on its timer after restart.
- **Private virtual desktop:** actual Chromium navigation, accessibility snapshots, PNG
  screenshots, window capture, pixel/AX clicks with confirmed DOM effects, typing, stale-token
  refusal and restart pass with pinned CUA 0.28.2. This is the container's virtual desktop,
  not host-native Direct Computer Access.
- **Container ownership:** admission and crash recovery verify state ownership before reuse, replacement or stop. Same-name agents in separate workspaces get distinct container names, and long IDs retain distinct names and profile paths; legacy containers are adopted only when their private mounts prove ownership. Cleanup failures exit nonzero. The final actual gateway/approval gate passed after these checks were added.
- **Runtime updates:** full images write a contract marker. A policy-only rebuild succeeds on
  that base and refuses an old markerless image instead of relabeling outdated dependencies.

The tested UI/client patch under `work/current-ui-review/` **was applied to the shared
checkout by the UI owner on September 25 at 17:45 MDT**, on the user's explicit instruction
and under the ownership protocol. Before anything ran, all nine shared originals matched
`original-hashes.json`, the patch matched the SHA-256 in `checks.json`, `git apply --check`
was clean, and all eleven results matched `updated-hashes.json` byte for byte. Three new
regressions had first failed on unchanged main: a rejected model draft overwrote workspace
settings, inherited credentials filtered by the wrong provider, and long setup requests used
the ordinary 30-second deadline. The patch also covers clarification replies, concurrent
conversations and complete history/event recovery.

The applied tree was then validated on Linux (Ubuntu 24.04 x86-64 sandbox, Node 22.22.2,
Playwright 1.63.0 with its Chromium): 158/158 Node tests, typecheck, full lint, the production
build, and `npm run test:browser` **86/86** desktop+mobile cases — three consecutive full
runs, two of them under concurrent CPU load from the Node suite. That load surfaced three
races the reviewed candidate did not cover, fixed in UI-owned files and covered by the suite:
Workspace settings compared the form against a snapshot taken when the dialog opened, so the
coordinator's model import landing afterwards flagged an untouched form as edited (a spurious
"Discard unsaved settings?") and overwrote an edit in progress — the baseline now tracks the
saved model, a late import keeps an in-progress edit, and Discard restores the saved values;
the workspace was only written to browser storage 800 ms after its last change, so leaving
during a streaming run lost that conversation locally until the coordinator rebuilt it — it
is now also flushed on `pagehide`; and the task label field re-rendered its parsed labels and
swallowed each comma as it was typed, a fix lost in the 0.4.0 rebase — it now keeps what is
typed, with the regression carried into `integration-regressions.spec.ts`. The legacy-reply
recovery spec seeds storage from a one-shot init script so the previous document's pending
save cannot land on top of the seed. Twelve files were delivered (the eleven patch paths plus
`components/task-manager.tsx`); every one was re-read from the shared folder and matched its
SHA-256, recorded in `work/current-ui-review/checks.json` under `applied`. Docker-backed and
paid-provider checks were not part of this UI validation.

Evidence is retained on the VM under `/home/developer/open-harness-evidence/` and in local
`/private/tmp/open-harness-integration-{root,docker,runner}-evidence-20260925.tar.gz` archives.
The opt-in scripts are `tests/{real-hermes,compose,real-runner,real-desktop,real-workflows}-smoke.mjs`;
`.github/workflows/runtime.yml` runs the container/Compose/workflow/desktop gates in CI. The
installed-runner gate intentionally requires a disposable Linux user session. Test resources
are cleaned up by their exact IDs/projects; no global Docker prune is used.

Packaged-release acceptance, image vulnerability scans, backup/restore and soak testing,
paid-provider reasoning, third-party MCP servers, host-native desktop access and signed
macOS/Windows installers are separate gates and are not claimed here. The Intel release job
now uses `macos-15-intel`, following the [GitHub runner documentation](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

The entries below are historical reports with their original scope and limitations.

## Public beta release-candidate implementation pass — September 24, 2026

Implemented and verified without paid inference:

- The production dashboard now exposes `/api/health`, which returns only coordinator reachability. Compose uses it for the service healthcheck, passes the remote-dashboard trust switch explicitly, and gives the coordinator up to 25 seconds for cleanup during shutdown.
- Remote bootstrap remains denied by default and is allowed only when `OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD=1`; both paths have route coverage.
- First-run setup no longer records completion when dismissed, when runtime preparation is incomplete, or after a failed model test. Failed connection tests preserve the saved revision and can be retried.
- Teams, boards, routines, remote computers, direct access, and MCP configuration are hidden behind a local Advanced features preference that defaults off. Existing data and APIs are unchanged.
- Browser hydration no longer describes a persistent run as interrupted merely because its tab was closed; the coordinator remains authoritative and replay supplies the current state after reconnect.
- Pending approvals are rebuilt from durable run events after reconnect, including when the saved event cursor has already passed the approval request. The mobile workspace panel now starts closed so it cannot cover task and approval controls.
- Self-hosting documentation now covers authenticated HTTPS proxying with streaming, health checks, updates, diagnostics, and stopped-stack backup and restore.
- Every reported version is `0.4.0-beta.1`. Self-hosted release publication is separate from signed desktop packaging, rejects tags that do not match the reviewed `main` commit and package version, and depends on tests, browser coverage, a fresh Compose health smoke test, coordinator/Hermes builds, and high/critical image scans.
- The source-release builder archives the reviewed Git tree with the lockfile, Compose files, runtime Dockerfile, and operations documentation; it rejects local state, environment files, dependencies, and build/test output. The publishing job adds SHA-256 checksums.

Checks: 97 Node tests, 46 Playwright desktop/mobile tests, TypeScript, ESLint, the production Vinext build, Cargo manifest/lock metadata, workflow YAML parsing, `git diff --check`, and `docker compose config` passed. Browser coverage includes incomplete setup, failed model retry, advanced-feature visibility, agent creation, task submission, pending-approval reconnect, and exact file download. `npm audit --omit=dev` reported 0 known vulnerabilities across 126 production dependencies.

Live release acceptance remains blocked on this machine: its selected Docker Desktop socket does not exist, the system Docker socket is not accessible, and `.env` has no configured model credential. Therefore the full coordinator/Hermes builds and Trivy scans, fresh Compose smoke test, authenticated proxy test, real-provider `launch-smoke.md` workflow, process-tree termination, upgrade/restore comparison, and 24-hour soak are not claimed as passed. The release tag and GitHub Release must not be created until those gates and the repository-rule checklist in `docs/BETA_RELEASE.md` are complete.

## Fourth real-runtime pass — September 25, 2026

Named handoffs, task boards, scheduled routines and the approval round trip, against the same
paid provider as the third pass (OpenRouter, `meta-llama/llama-3.3-70b-instruct`), on Linux with
Docker Desktop 29.5.3 and the pinned image `open-harness-hermes:2026.9.11`. Two container agents
on a shared team, in a state directory holding one credential, on port 4401. Inference spend for
the pass: $0.034.

**Every coordination tool was unreachable, for four separate reasons at once.** Each one alone was
enough to make the whole feature silently absent, and the mocked suite could not see any of them.

1. **Tool names.** Hermes registers an MCP tool as `mcp__<server>__<tool>`; Open Harness granted
   `mcp_open_harness_task`. The managed policy extension matches a granted name against the
   registry name exactly, so it stripped every coordination tool from every request. The agent was
   told the tools did not exist. The same mismatch removed all tools from any user MCP connection.
2. **A stale copy in the image.** The image bakes its own `coordination.mjs`, and the pinned one
   predates the `task` tool: the container advertised two tools where the checkout has three, so
   task boards could not work even once the names matched. The checkout's copy is now placed in
   the agent's managed directory, which the container already mounts read-only.
3. **Tool Search.** Hermes defers MCP tools out of the model-facing array and offers
   `tool_search`/`tool_describe`/`tool_call` bridges instead. Those bridges are not tools an Open
   Harness profile grants, so the policy stripped them too, leaving the deferred tools reachable by
   neither route. Deferral is now off for managed agents; a profile grant is already a short
   explicit allow-list.
4. **`http.request(options, options, callback)`.** `coordination.mjs` passed an options object
   where node expects the response listener, so every call over the unix socket — the route every
   local container agent uses — failed with "The listener argument must be of type function". The
   existing socket test drove the socket with node's own client, and the existing coordination test
   drove `coordination.mjs` over a URL; nothing drove `coordination.mjs` over a socket.

**And the socket cannot work on this setup at all.** Docker Desktop passes bind mounts through a
VM: `coord.sock` is visible inside the container and refuses every connection (`ECONNREFUSED`,
mount type `fakeowner`), while connecting from the host succeeds. ROADMAP recorded this as a
macOS/Windows blocker; it applies just as much to Linux with Docker Desktop, which is the install
this project documents as supported. The socket is still tried first — it needs no open port and
cannot be reached from off the machine — with `http://host.docker.internal:<port>` behind it, the
same fallback a paired runner already used for its own containers. Docker Desktop's host proxy
reaches the coordinator on loopback, so nothing had to be exposed: `--add-host
host.docker.internal:host-gateway` was already set, and the container still needs the run's token.

Two more defects came out of driving the board from a live agent:

5. **The container signature left out the state root** the mounts are built from. Pointing
   `OPEN_HARNESS_STATE_DIR` at a new directory reused the existing container with its mounts still
   on the old path; Docker recreated that path as an empty directory, so the agent started with no
   `config.yaml`, the policy extension never registered, and the run died with "Hermes gateway
   exited during startup" over a log line telling the operator to rebuild the image. Restoring a
   backup to a different path, which `docs/SELF_HOSTING.md` documents, hits exactly this.
6. **The task tool's schema did not say where an action's fields go.** They nest under `input`, and
   a model that sent `stageId` beside `action` — the obvious reading — got "Stage is required."
   with no hint. The schema now documents the shape per action and the route accepts either
   spelling, plus an `input` sent as a JSON string, which would previously have been spread into
   one key per character.

Verified after those fixes:

- **A board task reaches Review.** A task assigned to Beta in the app moved to the Review stage by
  Beta's own `action: "move"` call, with the stage id it had read from the same tool.
- **Named handoff.** Alpha called `mcp__open_harness__delegate_named_agent` with Beta's id; the
  coordinator recorded `handoff.created`, created a child run for Beta in its own container, and
  recorded `handoff.completed` with its state. Beta wrote `handoff.md` to the shared workspace with
  exactly the requested contents, and the parent received the child's result.
- **Task board.** With a task assigned to Beta in the app, Beta called `mcp__open_harness__task`
  with `action: "list"` and replied with the task's exact title.
- **Scheduled routine.** A one-minute routine created in the app fired on the scheduler's next
  tick, its run completed with the requested output, `last_run_at` was recorded and `next_run_at`
  advanced by exactly one interval.

**The approval round trip was broken in two further ways, and is now verified in both
directions.** Hermes offers an approval channel only when it can see one: with neither
`HERMES_GATEWAY_SESSION` nor a bound session platform, `tools/approval_context.py` finds no
interactive context, no gateway context and no unattended context either, and approves every
flagged command outright. So the dashboard's approval UI and the configured
`approvals.unattended_mode: deny` did nothing on a real run, and a container agent ran `chmod 777`
against a bind-mounted host file with nobody asked. The managed gateway now announces itself.
Second, Hermes reads the decision from `choice` and accepts `once`/`session`/`always`/`deny`;
Open Harness sent `decision: "approve"`, so Hermes read every approval as a refusal — the operator
pressed Approve and the agent was told the user had blocked the command. The deterministic runtime
accepted `"approve"` too, which is exactly why this survived. Evidence, with a real before and
after: a run paused in `waiting_approval` carrying the real command and its
`world/other-writable permissions` finding; approving took the file from 644 to 777 and the agent
reported it "was approved by the user"; denying left it at 644 and stopped the command. The gate
was forced to `manual` for that pair of runs only, and `smart` is unchanged in the shipped code.

**One finding left for a decision, not fixed here.** With the shipped `approvals.mode: 'smart'`,
Hermes hands each flagged command to an auxiliary "guardian" model rather than to the operator. On
this machine it approved `chmod 777` on a bind-mounted host file silently, and it spends the
operator's own key to make that judgement. `manual` — which gates only commands Hermes has already
flagged, and is what the dashboard's approval UI exists for — is a one-word change in
`runtime/profile-runtime.ts`. Worth deciding before the beta.

Also confirmed incidentally: `POST /v1/onboarding/status` correctly refused a state directory that
Docker cannot read (the probe named the real cause and pointed at the fix), and all five readiness
checks passed once the directory moved under `$HOME`.

**`runtime/hermes/Dockerfile` builds from scratch**, for the first time: earlier passes could only
patch the existing image because a full build did not fit on the root disk. The result carries
`dev.openharness.runtime=2`, imports the policy extension, and serves all three coordination
tools. Built under a throwaway tag and removed afterwards, so the pinned image is untouched.

Still not exercised live: real third-party MCP servers, Direct Computer Access, native subagent
restrictions, a Compose install from a packaged source release, and a backup and restore cycle.

## Third real-runtime pass — September 25, 2026

First end-to-end pass against a **paid provider**, on Linux with Docker Desktop 29.5.3,
Node 22.23.2 and the pinned image `open-harness-hermes:2026.9.11`. Provider: OpenRouter,
model `meta-llama/llama-3.3-70b-instruct`. Total inference spend for the whole pass: $0.0054.

Run from a fresh state directory holding only one credential, on port 4399, so nothing
touched the operator's own workspace. Verified in order:

- **Readiness.** All five checks report ready, including the Docker bind-mount probe for the
  state directory.
- **Credential to provider.** `POST /v1/onboarding/model-test` authenticates against
  `https://openrouter.ai/api/v1/models` with the stored key and reports ready.
- **A real task that changes the workspace.** A run asking the agent to write a file
  completed, and `live-check.md` arrived on the host in `shared/` with exactly the requested
  contents. `GET /v1/files?scope=shared` lists it.
- **Event replay.** 26 durable events for that run, including the full tool lifecycle
  (`tool.generating` → `tool.start` → `tool.complete`) carrying the real `write_file`
  arguments, replayable from `?after=0`.
- **Filesystem isolation.** The container has exactly four mounts — `shared` read-write,
  the agent's own `private` read-write, its profile home read-write, and `managed`
  read-only. Inside it: the host home is not present, `/var/run/docker.sock` is not present,
  no other agent's private directory is reachable, `/run/open-harness` is genuinely
  read-only, and the process runs as `1000:1000` rather than root.
- **Process-tree termination.** With `managed_entry.py`, a Hermes terminal wrapper and a
  `sleep 400` child all running inside the container, `POST /v1/runs/:id/stop` returned
  `{"ok":true,"stopped":1}`, the run became `cancelled`, and the container exited 143 —
  taking the whole tree with it. No agent process survived on the host.
- **Crash recovery.** `SIGKILL` to the coordinator mid-run, then restart: the run is
  `interrupted` with the "not replayed" reason, its 17 events are preserved, the stored
  credential is intact, and the control token is unchanged.
- **Container reaping.** The hard kill left a container that the `--restart unless-stopped`
  policy brought back with no gateway owning it. The next clean shutdown logged
  "Stopped 1 agent container" and stopped it. The operator's separate Docker Compose stack,
  running at the same time, was untouched — the reaper matches on the managed label, not on
  the shared `open-harness-` name prefix.

This pass found one defect that no mocked test could see, now fixed: a new agent was granted
only `mcp_open_harness_task`, so the first thing anyone asked it to do it truthfully refused,
saying it could not create files. `DEFAULT_TOOLS` in `lib/agent-profile.ts` now grants the
working set — files, terminal, code execution, memory, session recall, skills, web and
clarify — while desktop control, delegation, scheduling and MCP connectors stay off.

Still not exercised live: real MCP servers, Direct Computer Access, native subagent
restrictions, named-agent handoff, scheduled routines, an approval round trip, a
from-scratch build of `runtime/hermes/Dockerfile`, and the broader code-repair and browsing
scenarios.

## Real-runtime pass — September 21, 2026

First execution against the real, non-mocked runtime (`mode: live`), on Linux with
Docker Desktop 29.5.3, Node 22.23.2 and the pinned image `open-harness-hermes:2026.9.11`.

A local OpenAI-compatible server stood in for a paid provider, so this exercises the
whole path — credential storage, profile preparation, the bind-mounted profile, plugin
discovery, gateway startup, model resolution and outbound authentication — without
billing a real key. No paid model calls were made.

Verified, from a fresh state directory and a container created from the image:

- A credential created through `POST /v1/credentials` is stored, fingerprinted, and
  written into the agent profile `.env` and nowhere else.
- `prepareProfile` writes `config.yaml`, `SOUL.md` and `.env`, and the agent container
  reads all three from the bind mount.
- The managed policy extension loads and registers, so `managed_entry.py` starts the
  gateway rather than aborting.
- `session.create` returns a session bound to the configured model.
- A run submitted through `POST /v1/runs` reaches `completed`, streams
  `message.start` → `message.delta` → `message.complete`, and the model's response
  propagates back as the run result.
- The outbound request to the model endpoint carries the configured credential.

This pass found four defects that the mocked suite could not see; all four are fixed
in commit `603b19b` and covered by `tests/managed-runtime-contract.test.ts`:

1. `plugins.enabled` was written in a shape Hermes reads as "nothing enabled", gating
   the policy extension off and killing every containerized run at gateway startup.
2. The extension entry point resolved to a function rather than a module, so Hermes
   found no `register()`.
3. A custom or local endpoint had its credential aliased to `OPENAI_API_KEY`, which
   Hermes refuses to send to a non-OpenAI host, so it sent `no-key-required`.
4. Docker Desktop bind-mounts only shared host paths; any other path mounts as an empty
   directory with no error, so the agent profile never arrived. The default state
   directory hits this whenever the checkout lives outside the shared roots. This is now
   probed per state root and reported with its real cause.

## Second real-runtime pass — September 21–22, 2026

Same setup as the first pass. Closed the gaps that pass left open; all evidence is from a
coordinator in `mode: live` unless noted.

- **Runtime contract.** The image now carries `dev.openharness.runtime` and readiness
  compares it with `RUNTIME_CONTRACT`. With an older-contract image under the pinned tag,
  `harness doctor` reports "Update agent runtime", `executionReady: false`, exit 1, and a
  run is refused with that cause instead of starting a container that dies at gateway
  startup. With the current image restored: ready, exit 0, run completes.
- **Container recreation.** The container signature includes the image ID. After retagging
  a rebuilt image (new ID, same contract) the next run recreated the container (`.Image`
  changed, newer `Created`), then completed.
- **First-party providers**, offline inside the image via Hermes's own resolver:
  `xai` and `openrouter` resolve the key from the profile `.env`. Hermes has no provider
  called `openai`; Open Harness now writes `openai-api`, which resolves `OPENAI_API_KEY`.
- **Explicit endpoint on a first-party provider.** Hermes ignores `base_url` on its native
  providers (a proxy for xAI still resolved to `api.x.ai`), so any explicit endpoint now
  takes the custom path. Hermes also refuses to hand a native provider's variable to a
  custom endpoint, so the credential is written under `OPEN_HARNESS_MODEL_API_KEY` and
  `key_env` names that. Live run: provider `xai`, credential saved as `XAI_API_KEY`,
  endpoint set to the local server — the request arrived as `Bearer xai-PROXY-…`.
  (The offline resolver reports a placeholder for this path even on a copy of a profile
  that provably sent the key; treat the gateway run as authoritative for custom endpoints.)
- **State directory.** `harness setup` on a simulated fresh checkout on the unshared drive
  chose `~/.open-harness/<project>`, recorded it in `.env`, and stayed silent on the next
  run; on this checkout, which already holds state, it changed nothing.
- **Cheap rebuilds.** `runtime/hermes/Dockerfile` now installs Open Harness files after the
  upstream layers and passes `docker build --check`. It was **not** built end to end on
  this machine: a from-scratch build does not fit on the root disk. The labeled image was
  produced with `runtime/hermes/extension/Dockerfile.patch`, which shares the label.
- Suites: 93 node tests, Playwright 36/36 desktop+mobile, `tsc`, `eslint`, `vinext build`.

## Still pending

Superseded by the two September 25 passes above, which covered paid-provider inference,
filesystem isolation, process-tree termination, crash recovery, named-agent teamwork, task
boards, scheduled runs and approvals. Still not exercised against a real runtime: real
third-party MCP servers, Direct Computer Access, native subagent restrictions, a full
from-scratch build of the reordered Dockerfile, and the broader code-repair, browsing and
durable skill-use scenarios.

The deterministic control and browser suites still run under `OPEN_HARNESS_MOCK=1` and
do not by themselves establish live acceptance.

## Agent profile upgrade verification — September 14, 2026

Verified with Node 22 and the pinned Hermes source interface (`v2026.9.11`,
`939e45c91d751fadd94dcd1b873ac3cb44846213`).

- `npm test`, including persistent profile revisions, independent model overrides,
  inheritance, stale saves, next-task snapshots, explicit empty grants, credential
  separation, MCP inventory retention, stream completion, provider errors, and scoped
  Unix coordination sockets.
- Seven Python policy tests for allowed and denied dispatch, nested code-tool dispatch,
  model schema filtering, forced disabled choices, and fail-closed behaviour.
- Playwright across desktop and mobile, covering the editor tabs, Save/Cancel, prompt
  switches, tool grants, inline MCP configuration, failed-save retry, reload
  persistence, stale-save recovery and keyboard navigation.
- `npm run lint`, `npm run typecheck`, `npm run build` and `git diff --check`: passed.


## Independent integrated-change review — September 26, 2026

A fresh isolated Ubuntu ARM64 review used Node 22.23.3 and Docker 29.8.1. Captured
source passed 162 Node tests, typecheck and full lint. The production build and
86 desktop/mobile browser cases passed on an earlier phase with identical UI source.
Actual pinned Hermes container acceptance passed clarification, task MCP, context,
tool policy, manual approval denial/approval and cleanup; the supplemental actual
sandbox gate passed eight checks, including folder access and revocation. These
checks used scripted local providers or no model calls, not paid inference.

Two additional reproductions found remaining integration defects: model validation
can outlast the client's 30-second deadline and commit after the UI reports failure;
and a run finishing between the bootstrap history and run-list reads can leave an
empty reply with no follower. No application fixes were made by this review.

The shared checkout changed during verification. Runtime fixes and runner
regeneration were incorporated into successive snapshots. After the last passing
supplemental snapshot, further changes arrived in runtime/computer-validation.ts
and runtime/hermes.ts; those later bytes are not covered by this review's final
results. Exact manifests, source archives, reproducers, logs and the review are in
work/integration-review-20260926/. Two unreadable duplicate local filenames were
excluded and preserved. Compose, installed-runner, private-desktop and scheduled
workflow gates were not repeated; their earlier evidence retains its original scope.
