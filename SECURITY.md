# Security

## Trust model

Open Harness is built for a single trusted operator, or a small trusted team, self-hosting on infrastructure they control. It is not multi-tenant and provides no isolation between different human operators of the same coordinator. Dashboard APIs require the master control token or a paired device credential; runner and agent credentials are restricted to their respective endpoints. Network reachability alone does not grant operator access. A paired dashboard credential permits operator actions on the shared coordinator, not access limited to one human or agent. Code running as the coordinator's or a runner's OS user can access the files and credentials available to that account.

The dashboard bootstrap token (served from `/v1/bootstrap`) authorizes arbitrary run creation, host-path container mounts, and direct OS-account execution. The coordinator requires both a loopback socket address and a loopback `Host` header, since a same-origin check alone cannot distinguish a local browser from a DNS-rebinding attacker. The dashboard proxy also checks the incoming `Host`. Setting `OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD=1` relaxes that proxy check for operators who authenticate access through their own reverse proxy; it does not relax the coordinator's check. `OPEN_HARNESS_DISABLE_BROWSER_BOOTSTRAP=1` takes precedence over that opt-in. Compose sets it by default, requiring every browser to pair for a revocable device credential.

## Isolation boundaries

**Per-agent containers** (the default): each agent runs in its own Docker container. The host home directory, the Docker socket, and other agents' private directories are not mounted into it. The container is the filesystem boundary; Hermes's own execution guards apply inside it. Filesystem isolation and process-tree termination on stop are part of the security surface we care most about getting right — if you find a way to escape a container or to leave orphaned processes running after a stop, that's a security bug, not just a correctness bug.

**Selected folders**: mounts only the host folders an operator names into the container, honoring the read-only/read-write setting chosen for each. A folder mounted read-write is fully writable by that agent.

**Direct computer access**: runs Hermes directly under the runner's OS account, with no container boundary at all. This is an explicit, opt-in trade of isolation for host-native capability (screen, accessibility APIs, an existing desktop session). Anything reachable by the OS account running the runner is reachable by the agent. Treat a runner configured this way as fully trusted, equivalent to giving the agent a shell as that user.

**The self-hosted Docker Compose stack** (`compose.yaml`) runs a `docker:*-dind` sidecar with `privileged: true`. Its Docker API listens only on a Unix socket in the `harness-control` volume, shared with the coordinator; no Docker TCP listener is enabled. The socket is owned by root with group `1000` and mode `0660`, allowing the coordinator's UID/GID `1000` process to use it. Agent containers receive neither that volume nor the socket. Control of the coordinator still gives control of the privileged Docker engine, so both belong to the host's administrative trust boundary. Keep the control volume private and do not add Docker TCP listeners or mount the socket into agents or unrelated services.

## The Hermes pin

Open Harness vendors a specific pinned commit of [Hermes Agent](https://github.com/NousResearch/hermes-agent) (currently recorded in [`runtime/hermes/NOTICE.md`](runtime/hermes/NOTICE.md)) into its own container build, and does not modify Hermes's reasoning loop. A vulnerability in Hermes itself, independent of how Open Harness integrates it, should also be reported upstream to Nous Research. We aim to bump the pin promptly once a fix lands upstream; a report here that turns out to be purely a Hermes issue will still get triaged and forwarded, not dropped.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through [GitHub Security Advisories](https://github.com/sflow-hub/OPEN-HARNESS/security/advisories/new) for this repository, rather than as a public issue. We'll acknowledge receipt and work with you on a fix and disclosure timeline before any public detail is published.

**In scope**: authentication/authorization bypass (including anything that defeats the loopback bootstrap check without the documented opt-out), container escape or filesystem-isolation failures in the default per-agent-container mode, incomplete process-tree termination that leaves agent-spawned processes running after a stop, secret or credential leakage (including via logs, exports, or the Docker build context), and cross-run or cross-agent event forgery (a paired runner or agent affecting a run or agent it shouldn't be able to reach).

**Out of scope**: behavior that only follows from an operator having deliberately enabled a documented escape hatch (`OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD=1`, Direct Computer Access, a read-write Selected Folder), and the absence of multi-tenant isolation, since none is claimed.

## Supported versions

Open Harness is pre-1.0. We patch `main` and the latest tagged release; older tags are not backported.
