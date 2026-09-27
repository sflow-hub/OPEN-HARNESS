# Security

## Trust model

Open Harness is built for a single trusted operator, or a small trusted team, self-hosting on infrastructure they control. It is not multi-tenant and provides no isolation between different human operators of the same coordinator. Anyone with the operator token, or who can run code as the OS user running the coordinator or a runner, has full operator-level access: they can create runs, read and write every agent's private files, and read stored model credentials.

The dashboard operator token authorizes run creation and profile/file management, including selected-folder grants. Compose requires browser pairing: a trusted local launcher issues a random, short-lived, single-use code through the coordinator's CLI, then the browser exchanges it for the operator token. Unauthenticated `/v1/bootstrap` never returns a token in this mode, regardless of the request's `Host` header. Pairing records remain outside agent mounts; there is no HTTP endpoint for minting codes. The public `/v1/ready` probe returns only `{"ok":true}`.

Host-native development (`npm run dev`) retains the local bootstrap flow, requiring a loopback connection and `Host` header. Source-built Compose still requires browser pairing. The dashboard proxy also accepts only local clients by default. `OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD=1` permits that proxy to serve remote clients; it does not disable Compose pairing. Enable remote access only behind an authenticated HTTPS reverse proxy. A paired browser has full operator authority; treat its stored token and any unused pairing link like a password.

## Isolation boundaries

**Per-agent containers** (the default): each agent runs in its own Docker container. The host home directory, the Docker socket, and other agents' private directories are not mounted into it. The container is the filesystem boundary; Hermes's own execution guards apply inside it. Filesystem isolation and process-tree termination on stop are part of the security surface we care most about getting right — if you find a way to escape a container or to leave orphaned processes running after a stop, that's a security bug, not just a correctness bug.

**Selected folders**: mounts only the host folders an operator names into the container, honoring the read-only/read-write setting chosen for each. A folder mounted read-write is fully writable by that agent. In Compose, the operator must first bind the same physical folder into both outer services under `/host-folders/<name>` using an explicit override. Only exact exported mount roots can be granted; subfolders need their own explicit export. This keeps a writable parent from replacing a descendant grant with a link between validation and mounting. A read-only export cannot become writable through an agent setting. No host folders are exported by default. Select real directory paths; files, sockets and paths containing symbolic links are refused, including when a previously selected path is replaced with a link.

Native selected-folder execution requires a shared Linux kernel between the coordinator or runner and Docker. Each new admission creates an inert container, verifies the mounted directory identities and access modes against pinned directory handles, then initializes the desktop and gateway. Unverifiable mounts fail closed; native Mac/Windows coordinators and remote Docker daemons must use the Compose exported-folder path or a Linux runner instead. Such containers do not automatically resume agent processes after a Docker restart.

**Shared files and networking**: every container on a runner receives that workspace's `/workspace/shared` folder with read/write access. Keep private material in the agent's private files, not Shared files. Outbound networking, including reachable host services, remains enabled; tool switches are not a network firewall. Each agent can read its own selected model/connector credentials inside its profile. Other agents' profiles and the coordinator's credential store are not mounted.

**Changing access**: saved settings apply to the next task. An active task keeps its original profile and mounts until it stops. Stop it before tightening access if the change must take effect immediately. The next container start replaces stale mount configurations, including removing selected folders when returning to Private workspace. Neither sandboxed mode falls back to direct execution when Docker is unavailable. Disabling the private desktop replaces its container on the next start and removes the display. Restart the coordinator and update/restart existing runners when applying this upgrade; local saved native process handles are recovered and stopped. Already admitted work on an older remote runner remains governed by that runner until it is stopped.

**Desktop control**: a private agent desktop runs Xvfb, Openbox, Chromium and the computer-use driver inside that agent's container on a Linux runner. Its X11 and D-Bus sockets and login sessions are private; no host display or session bus is mounted. File grants and Shared files have the same boundaries as ordinary agent tools. Unrestricted native Direct Computer Access and Existing desktop control are disabled. Old profiles remain readable for explicit conversion, but saves, runs, probes, transfers and persisted runner commands fail closed. A process filesystem sandbox cannot safely contain control of the operator's existing desktop, because applications launched or driven there run outside that process boundary.

**The self-hosted Docker Compose stack** (`compose.yaml`) runs a privileged `docker:*-dind` sidecar. Its engine listens only on a private root:1000 Unix socket (mode 0660), with no TCP listener. The coordinator runs as UID/GID 1000 and shares that control volume; agents never receive it. The sidecar and dashboard use separate networks, and browser pairing protects the operator API even when a platform routes a published host port back to the dashboard. The coordinator can control the privileged engine and must be treated as fully trusted. Do not attach the dashboard to the runtime network or share the control volume with other services.

## The Hermes pin

Open Harness vendors a specific pinned commit of [Hermes Agent](https://github.com/NousResearch/hermes-agent) (currently recorded in [`runtime/hermes/NOTICE.md`](runtime/hermes/NOTICE.md)) into its own container build, and does not modify Hermes's reasoning loop. A vulnerability in Hermes itself, independent of how Open Harness integrates it, should also be reported upstream to Nous Research. We aim to bump the pin promptly once a fix lands upstream; a report here that turns out to be purely a Hermes issue will still get triaged and forwarded, not dropped.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through [GitHub Security Advisories](https://github.com/sflow-hub/OPEN-HARNESS/security/advisories/new) for this repository, rather than as a public issue. We'll acknowledge receipt and work with you on a fix and disclosure timeline before any public detail is published.

**In scope**: authentication/authorization bypass (including bypasses of Compose pairing or the source-mode loopback bootstrap check), container escape or filesystem-isolation failures in the default per-agent-container mode, incomplete process-tree termination that leaves agent-spawned processes running after a stop, secret or credential leakage (including via logs, exports, or the Docker build context), and cross-run or cross-agent event forgery (a paired runner or agent affecting a run or agent it shouldn't be able to reach).

**Out of scope**: behavior that only follows from an operator having deliberately enabled a documented escape hatch (`OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD=1`, a read-write Selected Folder), and the absence of multi-tenant isolation, since none is claimed.

## Supported versions

Open Harness is pre-1.0. We patch `main` and the latest tagged release; older tags are not backported.
