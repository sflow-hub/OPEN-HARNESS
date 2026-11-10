# Security

## Trust model

The default local edition uses a single trusted operator on infrastructure they control. A coordinator hosts exactly one workspace; it is not a boundary between different host administrators. Anyone holding its operator token or running code as the coordinator/runner OS user has full operator-level access, including private files, selected-folder grants and stored user keys.

The authenticated shared-workspace candidate adds owner/operator/viewer membership through OIDC and an outbound signed relay. Browser/native clients receive scoped sessions instead of the coordinator operator token. Managed accounts, provisioning and metering are separate PostgreSQL control-plane data; each managed workspace requires a dedicated Linux VM while agents retain container boundaries. Production provider choice, real isolation, OAuth and device acceptance remain release gates. Authenticated shared execution currently uses the workspace’s local private Linux computer; remote runners without renewable human permission leases fail explicitly.

The dashboard operator token authorizes run creation and profile/file management, including selected-folder grants. Compose requires browser pairing: a trusted local launcher issues a random, short-lived, single-use code through the coordinator's CLI, then the browser exchanges it for the operator token. Unauthenticated `/v1/bootstrap` never returns a token in this mode, regardless of the request's `Host` header. Pairing records remain outside agent mounts; there is no HTTP endpoint for minting codes. The public `/v1/ready` probe returns only `{"ok":true}`.

Host-native development (`npm run dev`) retains the local bootstrap flow, requiring a loopback connection and `Host` header. Source-built Compose still requires browser pairing. The dashboard proxy also accepts only local clients by default. `OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD=1` permits that proxy to serve remote clients; it does not disable Compose pairing. Enable remote access only behind an authenticated HTTPS reverse proxy. A paired browser has full operator authority; treat its stored token and any unused pairing link like a password.

## Isolation boundaries

**Per-agent containers** (the default): each agent runs in its own Docker container. The host home directory, the Docker socket, and other agents' private directories are not mounted into it. The container is the filesystem boundary; Hermes's own execution guards apply inside it. Filesystem isolation and process-tree termination on stop are part of the security surface we care most about getting right — if you find a way to escape a container or to leave orphaned processes running after a stop, that's a security bug, not just a correctness bug.

**Selected folders**: mounts only the host folders an operator names into the container, honoring the read-only/read-write setting chosen for each. A folder mounted read-write is fully writable by that agent. In Compose, the operator must first bind the same physical folder into both outer services under `/host-folders/<name>` using an explicit override. Only exact exported mount roots can be granted; subfolders need their own explicit export. This keeps a writable parent from replacing a descendant grant with a link between validation and mounting. A read-only export cannot become writable through an agent setting. No host folders are exported by default. Select real directory paths; files, sockets and paths containing symbolic links are refused, including when a previously selected path is replaced with a link.

Native selected-folder execution requires a shared Linux kernel between the coordinator or runner and Docker. Each new admission creates an inert container, verifies the mounted directory identities and access modes against pinned directory handles, then initializes the desktop and gateway. Unverifiable mounts fail closed; native Mac/Windows coordinators and remote Docker daemons must use the Compose exported-folder path or a Linux runner instead. Such containers do not automatically resume agent processes after a Docker restart.

**Shared files and networking**: every container on a runner receives that workspace's `/workspace/shared` folder with read/write access. Keep private material in the agent's private files, not Shared files. Outbound networking, including reachable host services, remains enabled; tool switches are not a network firewall. Each agent can read its own selected model/connector credentials inside its profile. Other agents' profiles and the coordinator's credential store are not mounted.

**Changing access**: ordinary profile edits apply to the next task; active tasks retain their original revision. Terminal revocation is immediate at admission and remains pending until cleanup is confirmed. Same-machine changes to desktop mode, folder grants or browser sharing require idle exclusive access and confirmed shutdown of the old computer before saving. Machine transfers preserve the source until destination verification. Neither sandboxed mode falls back to direct execution when Docker is unavailable. Restart the coordinator and update/restart existing runners when applying this upgrade; saved native process handles are recovered and stopped. Already admitted work on an older disconnected runner remains governed by that runner until it is stopped.

**Desktop control**: runtime contract 9 separates the persistent Xvfb/Openbox/Chromium service from the stoppable per-agent execution container. The execution container receives no display sockets, browser profile, desktop startup files or Docker access. A managed MCP adapter brokers screenshots, navigation and input, enforcing grants, action review, active-run identity and the persisted ownership generation. Competing native desktop and browser paths are excluded in managed mode. No host display or session bus is mounted. Unrestricted native Direct Computer Access and Existing desktop control remain disabled.

**Terminal consent and ownership**: new agent profiles disable terminal/process tools; saved grants survive upgrades. Enabling these tools requires explicit owner consent. Removing them invalidates prepared runtimes, blocks admission and stops affected execution, with a durable pending state until the assigned runner confirms cleanup. Code execution and MCP remain separate grants. Taking control or handing back persists a new generation, closes old input and confirms execution-container shutdown, including detached jobs. Human shell HOME, workspace and PATH match the agent environment. Chromium remains alive across same-agent handoffs. Failures and disconnects retain blocked human ownership; reconnect never resumes agent work automatically.

**Computer streams and file exchange**: the current controller alone can attach a human PTY. One-use stream tickets expire after 30 seconds and bind actor, agent, machine, exact container and ownership generation. Input and resize are revalidated, buffering is bounded, and remote streams use an authenticated runner-initiated duplex connection. Terminal content is not logged or spooled; human screen-stream frames and human text are ephemeral and demonstrations omit them. Agent-requested captures follow Hermes tool/media caching and conversation storage, including the bounded managed PNG cache used for model vision. noVNC remains view-only. A bounded file broker separates browser storage from writable agent homes: 25 MiB per file, 100 MiB per batch and 100 entries. Shared-browser reservations attribute downloads to the initiating agent and clear staging before changing agents. A cross-agent reservation opens a fresh page after Chromium stops; same-agent ownership changes preserve the live page. Idle migration retains a recoverable old browser copy. Dedicated browser-state transfers are checksummed and require upgraded runners; normal portable backups continue to omit browser credentials.

**Read-only computer status**: an authenticated active workspace viewer may read only the precise desktop status endpoint. Its response exposes machine summary, controller display name, ownership state/time and agent activity, with empty or disabled control fields. It omits lease identity, ownership generation, controller identity, draft content and profile/team details. Viewer access to desktop frames, streams, terminals and control writes remains denied; revoked or expired membership cannot read status. A signed controller display name is presentation metadata and never authorizes control.

**Browser state when moving machines**: a private-browser transfer includes cookies, local storage and saved authenticated sessions. The destination runner therefore receives the authority of those sessions; moving an agent does not revoke them on the preserved source or remove recoverable destination backups. Both machines and their OS users remain trusted. Team-shared browser accounts are excluded from individual transfers.

New transfer commands seal the entire file/browser bundle to the destination key with AES-256-GCM and RSA-OAEP before it enters command storage or the source runner's completion spool. The authenticated payload binds the transfer, agent, source and destination; the destination verifies contents and checksums before restoring files. A local destination uses a temporary in-memory key, so coordinator restart fails the move while preserving the source. Updated runners reject plaintext transfers, and non-loopback runner transport requires HTTPS. This protects transfer payloads, not the browser profile files stored on either machine; use OS storage protection for those files. Normal portable backups continue to omit browser profiles and credentials.

**The self-hosted Docker Compose stack** (`compose.yaml`) runs a privileged `docker:*-dind` sidecar. Its engine listens only on a private root:1000 Unix socket (mode 0660), with no TCP listener. The coordinator runs as UID/GID 1000 and shares that control volume; agents never receive it. The sidecar and dashboard use separate networks, and browser pairing protects the operator API even when a platform routes a published host port back to the dashboard. The coordinator can control the privileged engine and must be treated as fully trusted. Do not attach the dashboard to the runtime network or share the control volume with other services.

## The Hermes pin

Open Harness vendors a specific pinned commit of [Hermes Agent](https://github.com/NousResearch/hermes-agent) (currently recorded in [`runtime/hermes/NOTICE.md`](runtime/hermes/NOTICE.md)) into its own container build, and does not modify Hermes's reasoning loop. A vulnerability in Hermes itself, independent of how Open Harness integrates it, should also be reported upstream to Nous Research. We aim to bump the pin promptly once a fix lands upstream; a report here that turns out to be purely a Hermes issue will still get triaged and forwarded, not dropped.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through [GitHub Security Advisories](https://github.com/sflow-hub/OPEN-HARNESS/security/advisories/new) for this repository, rather than as a public issue. We'll acknowledge receipt and work with you on a fix and disclosure timeline before any public detail is published.

**In scope**: authentication/authorization bypass (including bypasses of Compose pairing or the source-mode loopback bootstrap check), container escape or filesystem-isolation failures in the default per-agent-container mode, incomplete process-tree termination that leaves agent-spawned processes running after a stop, secret or credential leakage (including via logs, exports, or the Docker build context), and cross-run or cross-agent event forgery (a paired runner or agent affecting a run or agent it shouldn't be able to reach).

**Out of scope**: behavior that only follows from an operator having deliberately enabled a documented escape hatch (`OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD=1`, a read-write Selected Folder), and the absence of multi-tenant isolation, since none is claimed.

## Supported versions

Open Harness is pre-1.0. We patch `main` and the latest tagged release; older tags are not backported.

## Teammate workflow and device controls

Phone connection links require operator authentication to issue, configured HTTPS,
and browser pairing. They grant full operator access, expire after five minutes, and
can be redeemed once. Webhook routines use separate per-workflow bearer secrets;
only hashes are stored, rotation revokes the old secret, and those secrets cannot
access operator APIs. External event content remains untrusted task data.

Push subscriptions and signing keys use a separate restricted secret store. Delivery
contains generic status and run IDs, never transcript or approval contents. Push
endpoints are restricted to supported providers and checked for public DNS addresses.
Pending notifications are bounded, expire after 24 hours, and retry after restart.

Desktop supervision requires the operator token. Human input to remote runners is
encrypted, expires, and is never written to the durable command spool. Screenshots
are also ephemeral. Recordings omit typed text and screenshot data. Human control
blocks agent work until explicitly released; ownership survives a coordinator restart
and returns in a blocked state until released. Team browser sharing is an explicit
profile choice: opted-in agents on the same machine gain access to the same browser
sessions and cookies. Other private files remain isolated, and browser use is serialized.


## Complete-experience authorization changes

These candidate changes affect authentication, bootstrap authority, credential storage, runner capability negotiation and container admission. Shared/managed clients use short-lived EdDSA workspace/actor context; the coordinator checks membership again for tools and revocation stops work. Membership leases expire if the control plane is unavailable. Legacy local owner pairing remains available. Shared mode never serves the operator bootstrap token to clients and restricts host-folder grants from exposing private coordinator state. A runner missing required capabilities receives an explicit error.

Named Google/GitHub account credentials live in a separate coordinator vault. Personal accounts need explicit agent sharing. Exact connector action intents bind the account, operation, resource and reviewed request; dispatch is durable, receipts are followed by readback, and uncertain effects cannot be replayed as another write in the same task. Bounded routine allowances require a passed, reviewed workflow revision and are checked again for revocation/expiry at dispatch. Unclassified tools receive separate review by default; connector allowances do not authorize shell or browser work. Local trusted operators can explicitly disable scoped review for legacy workflows; shared authenticated workspaces cannot.

Read-only active-run leases gate idle/prepared runtimes. Clean prewarming happens only after confirmed cleanup, is identity-bound and currently supports local private BYOK runtimes without a desktop/shared browser. Selected folders retain fresh mount verification. Streaming exposes an observation-only RFB/noVNC channel through short-lived scoped tickets. Input uses the exclusive controller-bound human lease; owners can recover release, while another operator cannot send input. Raw typed values and screenshots are not recorded in demonstrations.

Platform model-provider keys stay in the control plane. Workers receive run-scoped leases, not provider keys. Requests reserve budget before dispatch; unknown usage stays held for independent reconciliation, and hard limits/credit balances cannot be bypassed by clients. Included usage currently has a text/tool contract; use user-provided keys for multimedia until a provider-specific metering bound is accepted. Billing/webhooks and native receipts require actual production configuration and platform acceptance.

Portable encrypted backups omit credential stores, model `.env` files, browser profiles and runner pairings. Restoration authenticates the archive before exposing destination files, creates a new folder, preserves history/revisions and pauses recurring work. Credentials require destination authorization. See the deployment operations guide and experience acceptance record for outstanding release gates.
