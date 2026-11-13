# Per-agent network policy, per-team shared folders, and sandbox self-test

This document preserves the earlier design and branch implementation notes. Current integration retains disabled native Direct Computer Access and Existing desktop modes; network policy is metadata only. Source code and `runtime/VERIFICATION.md` determine implemented behavior and completed acceptance. Historical line numbers and future proposals below are not current release claims.

Status: design proposal (no code in this change). Targets `0.4.0-beta.x`.
Scope: a per-agent network policy (`none` | `allowlist` | `open`) and how it maps to Docker and
to paired native runners; coordinator-only egress for `none` that is *enforced*, not just
configured; replacing the global shared read-write mount with a per-team folder; a sandbox
self-test probe that runs inside each agent's sandbox and reports to the UI; a threat model
against `SECURITY.md`; and a test matrix.

All claims about current behavior cite `path:line`.

## Implementation status (M3 waves A/B)

This document is the full design; only part of it has shipped. Current state:

**Shipped (wave A).**
- The policy exists as a stored setting: `NetworkMode` / `NetworkPolicy` / `DEFAULT_NETWORK` on
  `ComputerConfig` (`lib/agent-profile.ts:7`–`9`, `:18`), defaulting to `open` and spread over
  older profiles (`draftProfile`, `lib/agent-profile.ts:117`). The launch path does read it, but
  only through `containerSignature`, which folds in a **non-default** network policy
  (`runtime/hermes.ts:266`–`268`); a change therefore recreates the container on the next idle
  `ensureContainer` (`runtime/hermes.ts:314`–`319`). No egress restriction is applied — the
  `docker run` vector still carries no `--network` flag (`runtime/hermes.ts:336`–`343`) — so the
  field drives a rebuild, not enforcement.
- Per-team shared folders are mounted additively: `${stateRoot}/teams/<teamId>/shared` →
  `/workspace/teams/<teamId>` (`teamMountArgs`, `runtime/hermes.ts:294`), with the
  signature-driven rebuild gated on the agent being idle (`shouldRebuildContainer`,
  `runtime/hermes.ts:298`). The legacy global `/workspace/shared` (§1.2, `runtime/hermes.ts:341`)
  is unchanged and still read-write for every agent.

**Shipped (wave B).**
- The sandbox self-test probe (§4) is wired up: `POST`/`GET /v1/agents/:id/sandbox-selftest` run
  and return a result. The two-layer model holds — host-attested `docker inspect` checks are
  authoritative, and the in-container probe `runtime/hermes/sandbox_selftest.py` runs via
  `env -i … python -I -S` and only corroborates, so a contradiction between the two is reported as
  `tampering_suspected` rather than a pass (§4). Paired runners are labelled `runner-attested`
  (§4); direct/native access reports `not a sandbox` (§2.2, §4.2). Results are persisted in a
  `sandbox_selftests` table and the run is audited (`sandbox.selftest`).

**Pending (wave B+).**
- Egress enforcement (§2, §3): the launch vector still has no `--network`/`--internal` and no
  proxy/relay (`runtime/hermes.ts:336`–`343`), so every mode has open egress.
- Read-only rootfs + `--tmpfs /tmp` (§4.1), so the writes-denied check can pass rather than
  fail-by-design.
- An explicit seccomp profile (§4.1) — only Docker's default applies today.
- Sandbox self-test real-container verification (§4, §7): functional tests have run only on a
  local rootful Docker, which is not a production isolation claim, and no network/team
  real-runtime pass is recorded in `runtime/VERIFICATION.md`.

## 1. Current state (evidence)

Container launch is `ensureContainer` (`runtime/hermes.ts:292`). The `docker run` argument
vector is `runtime/hermes.ts:324`–`331`:

```
docker run -d --name open-harness-<id> --restart unless-stopped
  --label open-harness.config=<sig> --label <MANAGED_LABEL>=1
  --security-opt no-new-privileges            # runtime/hermes.ts:324
  --cap-drop ALL --pids-limit 512             # runtime/hermes.ts:324-325
  --memory <m>m --cpus <n>                     # runtime/hermes.ts:325
  --add-host host.docker.internal:host-gateway # runtime/hermes.ts:325
  --user <uid>:<gid> -e HOME=/workspace/private # runtime/hermes.ts:326
  -v <state>/agents/<id>/managed:/run/open-harness:ro   # runtime/hermes.ts:328 (read-only)
  -v <profile>:/home/hermes/.hermes
  -v <private>:/workspace/private
  -v <shared>:/workspace/shared                # runtime/hermes.ts:329 (GLOBAL, read-write)
  ...folder mounts...                          # runtime/hermes.ts:319-323
  <HERMES_IMAGE>
```

Findings from this vector:

1. **There is no `--network` flag.** The container joins Docker's default bridge, which has
   unrestricted outbound egress. The only network configuration present is
   `--add-host host.docker.internal:host-gateway` (`runtime/hermes.ts:325`), which adds a
   hostname, not a restriction. So **every agent today has full open internet egress**, and
   `SECURITY.md` makes no network-isolation claim to the contrary — the documented boundary is
   the filesystem (`SECURITY.md:11`). Network policy is therefore a *new* control, not a
   tightening of an existing promise.
2. **The shared mount is global and read-write.** `shared = ${stateRoot}/shared`
   (`runtime/hermes.ts:317`) is mounted into *every* agent at `/workspace/shared`
   (`runtime/hermes.ts:329`) with no `:ro`. Any agent can read and overwrite any other agent's
   shared output. The native/direct and paired-runner paths use the same single `shared`
   directory (`runtime/runner.ts:101`, `runtime/runner.ts:108`).
3. **Security options already present** are good and we keep them: `no-new-privileges`,
   `--cap-drop ALL`, `--pids-limit 512`, `--memory`, `--cpus`, non-root `--user`
   (`runtime/hermes.ts:324`–`326`). The managed policy mount is read-only
   (`runtime/hermes.ts:328`).
4. **How the coordinator is reached depends on where the agent runs — and the paths are not
   symmetric.** The coordination client tries routes in order (`runtime/hermes/coordination.mjs:52`–
   `56`): the unix socket **first, always**, then a URL only if one was configured. Which routes
   exist is set when the profile is prepared:
   - **Local container** (coordinator's own Docker): both are configured — socket in the managed
     mount *and* `controlUrl: http://host.docker.internal:<port>` as fallback
     (`runtime/service.ts:286`–`288`). The socket is tried first; the URL is the documented
     Docker-Desktop fallback (`runtime/service.ts:280`–`285`).
   - **Local native/direct** (coordinator host, no container): the socket path
     (`runtime/service.ts:287`, default `/run/open-harness/coord.sock`,
     `runtime/hermes/coordination.mjs:7`).
   - **Paired runner container** (another machine's Docker): **no socket** — only a URL, rewritten
     to `host.docker.internal` (`runtime/runner.ts:107`–`108`). The coordinator is on a different
     host entirely.

   This asymmetry matters below: the coordinator binds `127.0.0.1` by default
   (`runtime/service.ts:866`). `--add-host host.docker.internal:host-gateway` maps that hostname
   to the **bridge gateway** IP (e.g. `172.17.0.1`), not to the host's loopback. So on a Linux
   Docker **Engine** host the URL fallback cannot reach a `127.0.0.1`-bound coordinator at all —
   the socket is what actually works there, which is why the client tries it first and why
   `CLAUDE.md` calls a local Linux dashboard the supported install. The one outbound path an agent
   must keep under `none` is therefore the socket wherever it exists, and on a paired runner — where
   there is no socket and the coordinator is a remote host — a single explicit remote `host:port`
   (§3).
5. **`ComputerConfig` has no network field today** (`lib/agent-profile.ts:9`–`16`); access is
   only `private | folders | direct` (`lib/agent-profile.ts:6`). Network policy is a new field.
6. **Direct/native mode is not a sandbox** — Hermes runs under the runner's OS account with no
   container (`SECURITY.md:15`; code path `runtime/runner.ts:110`). Any network policy there is
   best-effort at most.

## 2. Network policy model

Add to `ComputerConfig` (`lib/agent-profile.ts:9`):

```ts
network: { mode: 'none' | 'allowlist' | 'open'; allow: string[] }   // allow: host[:port] entries, mode-specific
```

Default `{ mode: 'open', allow: [] }` so existing agents keep today's behavior (finding §1.1);
new agents may default to `allowlist` or `none` once the enforcement below ships. The field is
stored in the profile JSON (same place as `folders`/`resources`,
`lib/agent-profile.ts:9`–`16`), versioned by the profile revision machinery, and spread over
stored defaults so older profiles load (the `DEFAULT_COMPUTER` pattern at
`lib/agent-profile.ts:41`). It is part of the container signature
(`containerSignature`, used at `runtime/hermes.ts:303`) so changing policy forces a container
rebuild rather than silently applying to nothing.

### 2.1 Mapping to Docker

| Mode | Docker shape | Egress result |
| --- | --- | --- |
| `open` | `--add-host host.docker.internal:host-gateway` only (today's vector, `runtime/hermes.ts:325`) | Unrestricted (current behavior) |
| `allowlist` | Attach to a per-agent **internal** user-defined bridge (`docker network create --internal`), plus an egress proxy container dual-homed on that network *and* an egress-capable network; container env `HTTP(S)_PROXY`/`NO_PROXY`; DNS pinned to the proxy | Only the effective model endpoint + `allow` hosts reachable, via the proxy; everything else refused |
| `none` | On Linux Engine, two sound shapes (a bare `--network none` reaches neither the model endpoint, §3, nor any relay): **(a)** per-agent `--internal` network + a dual-homed relay pinned to exactly the model endpoint, keeping the coordinator unix socket for coordination; or **(b)** bare `--network none` + socket **only** when inference is relayed through the coordinator over that socket, so the container needs no model route. On Docker Desktop (socket refused, `runtime/service.ts:280`–`285`): per-agent `--internal` network + a dual-homed relay pinned to exactly the coordinator `host:port` and the model endpoint | No egress except the coordinator and the model endpoint — reached via the relay, or, under (b), the model via the coordinator relay |

**The model endpoint is not optional, in any mode.** Hermes performs inference *from inside the
container*: the provider key is written into the profile `.env`
(`runtime/profile-runtime.ts:76`–`80`, `:104`) and `config.yaml` points `base_url`/provider at
the model host (`runtime/profile-runtime.ts:84`, `:91`). An agent on a bare `--internal` network
with no route to that host fails at its very first model call. So the egress rules **must always
include the effective model endpoint** resolved from `profiles.effective` — host and port of the
provider, or the custom `base_url`. Practically that means `none` is "model endpoint plus
coordinator only", and `allowlist` always implicitly contains the model endpoint even if the
operator forgets to list it. (An alternative is to relay all inference through the coordinator so
the container needs no direct provider route at all; heavier, noted as an open question.) This
endpoint is also an egress channel — see the threat model (§6) — especially a custom `base_url`.

Notes:

- `--internal` networks have no gateway to the outside, so a container on one cannot route to
  the internet at all regardless of what the agent tries — enforcement is at the Docker network
  layer, not inside the container where the agent could tamper.
- For `allowlist`, the agent cannot reach arbitrary IPs because the internal network has no
  route out; the *only* route out is the egress proxy. The proxy must sit on **two** networks —
  the agent's `--internal` network (so the agent can reach it) and a normal egress-capable
  network (so the proxy itself can reach the allowed hosts); an `--internal`-only proxy could not
  forward anything. It is configured to allow exactly the model endpoint + `allow` entries (host +
  optional port) and deny the rest. DNS is answered by the proxy (or a sidecar resolver on the
  internal net) so the agent cannot resolve-and-connect around it.
- The proxy is a small managed container (e.g. a filtering forward proxy) built into the pinned
  image set, started per policy-group and reaped like other managed containers via the
  `MANAGED_LABEL` sweep (`runtime/hermes.ts:285`–`288`). Proxy config is derived from `allow`;
  the agent never sees or edits it (read-only, mirroring the managed policy mount at
  `runtime/hermes.ts:328`).
- Network creation/teardown joins the container lifecycle in `ensureContainer`
  (`runtime/hermes.ts:292`); the network name is part of the container signature so a policy
  change rebuilds cleanly (`runtime/hermes.ts:303`–`308`).

### 2.2 Paired native runners

A paired runner that runs containers (`runtime/runner.ts:111` → `ensureContainer`) applies the
**same** Docker mapping locally — the network objects are created on that runner's Docker, not
the coordinator's. A runner in **direct/native** mode (`runtime/runner.ts:110`) has no container,
so network modes are not enforceable by Docker there. For native mode the design:

- Treats `none`/`allowlist` as **advisory** and surfaces it as such in the UI (see §5), never as
  a sandbox guarantee — consistent with `SECURITY.md:15` ("fully trusted, equivalent to giving
  the agent a shell").
- Optionally applies an OS-level best-effort (per-user firewall/`HTTP(S)_PROXY` env), but the
  self-test (§4) will *report it as unenforced* on native so the operator is never misled.

## 3. Coordinator-only egress for `none` (enforced)

Under `none` the agent must still reach the coordinator (for coordination tools, inbox, task
board) but nothing else. "Configured" is not enough — the enforcement must survive an agent that
edits its own env or hostnames.

The enforcement differs by where the agent runs, and the earlier draft conflated them. Concretely:

- **Local container, Linux Engine (the supported install):** the coordinator socket is mounted
  into the container read-only (`-v .../managed:/run/open-harness:ro`, `runtime/hermes.ts:328`)
  and is tried first (`runtime/hermes/coordination.mjs:52`). A unix socket has no IP surface, so
  `--network none` **plus** that socket gives the agent no route off the box while it still reaches
  the coordinator through the filesystem object — no proxy, and no `host.docker.internal` URL (the
  127.0.0.1 listener is not on the bridge gateway, §1.4). **But that shape reaches *only* the
  coordinator, not the model endpoint**, which §2.1 requires in every mode because Hermes infers
  from inside the container. So bare `--network none` + socket is sound **only** when inference is
  relayed through the coordinator over that same socket (the coordinator-relay option, §9), leaving
  the container with no direct model route. When inference is *not* relayed, Linux Engine `none`
  must instead use a per-agent `--internal` network plus a dual-homed relay pinned to exactly the
  model endpoint, still keeping the socket for coordination (§2.1 row `none`, shape (a)). Reserve
  bare `--network none` for the relayed-inference case; otherwise the agent fails at its first model
  call, reintroducing finding B1 on the supported install — which the §7 test plan's real-inference
  assertion is there to catch.
- **Local container, Docker Desktop:** the bind-mounted socket is visible but refuses every
  connection (`runtime/service.ts:280`–`285`, `runtime/hermes/coordination.mjs:48`–`60`), so
  `--network none` would strand the agent. Here `none` instead uses a per-agent `--internal`
  network plus a **dual-homed relay** (a minimal managed container on both the internal network
  and an egress network) pinned to exactly the coordinator `host:port` and the model endpoint
  (§2.1), and nothing else. If an operator does not want that relay, `none` is declared
  unsupported on Docker Desktop rather than silently degraded.
- **Paired runner container:** the coordinator is on *another machine* and the runner-side
  container has no socket, only a URL (`runtime/runner.ts:107`–`108`). So `none` there cannot mean
  "socket only"; it means an `--internal` network whose proxy allows exactly that one remote
  coordinator `host:port` (plus the model endpoint), and denies all else.
- **Native/direct (any host):** there is no container and nothing is mounted, so none of the above
  applies — network policy is advisory only (§2.2).

The proxy/relay in the Desktop and paired cases must sit on both the agent's `--internal` network
and an egress-capable network; that dual-homing is the actual enforcement point, not the env vars.

Enforcement, not configuration, because: the route restriction lives in the Docker network
(`--network none` or `--internal`) and the proxy/relay allowlist, both outside the container's
control; the coordinator still independently authenticates every agent call with a per-agent
bearer token (`runtime/service.ts:96`–`99`) and re-checks `internalAllowed` per run
(`runtime/service.ts:220`). So even a connection to the coordinator is authorized, not merely
reachable.

## 4. Sandbox self-test probe

A probe reports on isolation so an operator can verify it rather than trust the config. But a
critical subtlety the first draft missed: **a result reported from inside the sandbox is reported
by the thing being tested.** The existing transport execs `python
/opt/open-harness/inspect_runtime.py` in the container (`runtime/profile-runtime.ts:20`–`28`,
exec at `:22`) — and that `docker exec` passes no `python -I`, while `HOME` is
`/workspace/private`, which is agent-writable (`runtime/hermes.ts:326`, `:329`). So the agent can
plant a `usercustomize.py` / `.pth` under `~/.local` that makes every check print `"ok"`. An
in-container self-report is therefore untrusted input, not verification.

The design uses **two layers**:

1. **Host-attested facts (authoritative).** The coordinator reads the container's real
   configuration on the host with `docker inspect` — it never asks the container about itself.
   From the inspect JSON it checks `NetworkMode`, `HostConfig.CapDrop`, `HostConfig.SecurityOpt`
   (no-new-privileges / seccomp / apparmor), `Mounts` (sources, and `RW` flags),
   `HostConfig.PidsLimit`, `HostConfig.Memory`, `HostConfig.NanoCpus`, and
   `HostConfig.ReadonlyRootfs`. These are set by the launch vector (`runtime/hermes.ts:324`–`331`)
   and cannot be rewritten by the agent. This layer is what the UI badge trusts.
2. **In-container behavioral probe (corroborating, hardened).** A sibling `sandbox_selftest.py`
   baked into the pinned image (`runtime/hermes/Dockerfile`) still runs behavioral checks (an
   actual blocked write, an actual refused connection) because some things are only observable
   from inside. It is run with `python -I -S` and a cleared environment so a planted
   `usercustomize`/`.pth`/`PYTHON*` cannot load, and its output is treated as corroboration of the
   host-attested layer, never as the source of truth. Where the two disagree, host-attested wins
   and the badge flags tampering.

**Paired runners are runner-attested, not verified.** The `docker inspect` in layer 1 runs on the
paired runner's host (`runtime/runner.ts:134`, `:149` reuse the same probe transport), and §6
lists a malicious runner as an adversary — so a compromised runner can fabricate the inspect
output just as it can the probe output. Results from paired runners are therefore labelled
"runner-attested" in the UI, not "verified". Native uses `nativeRuntimeProbe`
(`runtime/profile-runtime.ts:30`–`36`) and is never a sandbox (§2.2).

The in-container behavioral probe emits:

```json
{
  "probe": "sandbox-selftest/v1",
  "runnerKind": "container|native",
  "checks": {
    "writes_outside_writable_mounts_denied": { "ok": true, "detail": "EROFS/EACCES on /, /etc, /tmp (needs --read-only root)" },
    "host_home_absent":             { "ok": true,  "detail": "no /host or host $HOME visible" },
    "docker_socket_absent":         { "ok": true,  "detail": "/var/run/docker.sock not present" },
    "egress_policy_honored":        { "ok": true,  "detail": "model endpoint + allow reachable; others refused", "mode": "none|allowlist|open" },
    "no_foreign_secrets_visible":   { "ok": true,  "detail": "only this profile's selected secrets present; no other agent .env, no secrets.json, no OS-vault socket" },
    "cpu_mem_pids_limited":         { "ok": true,  "detail": "pids-max=512, mem cgroup=<m>, cpus=<n>" },
    "no_privilege_escalation":      { "ok": true,  "detail": "no-new-privileges=1; CapEff=0; seccomp/apparmor active" }
  }
}
```

### 4.1 What each check actually tests (and the evidence it maps to)

- **Denied writes outside writable mounts.** The intended writable paths are **four** categories,
  not three: `/workspace/private`, `/workspace/shared` (or per-team, §5), `/home/hermes/.hermes`
  (the profile mount, read-write), and any write-mode folder grants (`runtime/hermes.ts:319`–
  `323`, `:329`). **Caveat the first draft got wrong:** the launch vector passes no `--read-only`
  flag (`runtime/hermes.ts:324`–`331`), so the image's root filesystem — `/tmp`, `/home/hermes`,
  `/var`, etc. — is *also* writable. A probe that attempts a write at `/tmp` would therefore
  succeed, and "writes outside mounts denied" would **fail as specified**. Two honest options:
  (a) add `--read-only` to the root filesystem (plus a `--tmpfs /tmp`) so the check can genuinely
  pass, and fold the flag into `containerSignature`; or (b) scope the check to the paths that are
  actually supposed to be denied (host roots like `/etc`, `/`, other agents' mounts) and report
  the writable image rootfs as a known, separate hardening gap. The matrix (§7) assumes option
  (a); until `--read-only` ships, that row is "fail-by-design", not "pass".
- **No host home.** Assert no host home directory is mounted; `SECURITY.md:11` claims the host
  home is never mounted — the probe verifies it on the live container, not just by reading the
  launch vector.
- **No docker socket.** Assert `/var/run/docker.sock` is absent; `SECURITY.md:11` claims the
  Docker socket is never mounted. (Note the compose self-hosting stack deliberately runs a
  privileged dind sidecar, `SECURITY.md:17`; the probe runs in the *agent* container, which must
  not see it.)
- **Egress policy honored.** From inside, try: (a) each `allow` host — expect reachable under
  `allowlist`/`open`; (b) a known-public host not in `allow` (e.g. a canary IP) — expect refused
  under `none`/`allowlist`; (c) the coordinator — expect reachable in all modes (§3); (d) the
  effective model endpoint — expect reachable in **all** modes including `none` (§2.1), since the
  agent cannot function without it; (e) a **DNS** lookup of a canary name through a resolver other
  than the pinned proxy — expect failure, to catch DNS-based exfiltration around the proxy; (f)
  the host gateway on a non-coordinator port — expect refused (host-services path, §6). This
  directly tests §2/§3 rather than trusting them.
- **No *foreign* secrets visible.** The first draft's "no provider keys anywhere outside the
  managed mount" is wrong by design: the agent's **own** provider key and coordination token are
  deliberately readable by it, written to the profile `.env` and `config.yaml` in the *read-write*
  profile mount `/home/hermes/.hermes` (`runtime/profile-runtime.ts:104`, `:102`; mounted
  read-write at `runtime/hermes.ts:329`), **not** the read-only managed mount
  (`:ro` at `runtime/hermes.ts:328`). Hermes needs them there to call the model. So the check is
  redefined: the agent may see *its own* selected secrets (`selectedSecrets`,
  `runtime/service.ts:153`–`156`) and nothing else — no other agent's `.env`, no workspace
  `secrets.json`, and no host OS-vault socket. That is the property that actually matters and that
  the isolation boundary (`SECURITY.md:11`) really provides; the probe asserts the *absence of
  foreign* credentials, host-attested by the `Mounts` list in `docker inspect` (§4, layer 1).
- **cpu/mem/pids limits.** Host-attested from `docker inspect` `HostConfig.PidsLimit` / `Memory` /
  `NanoCpus` and compared to the profile (`--pids-limit 512`, `--memory`, `--cpus`,
  `runtime/hermes.ts:324`–`325`); the in-container cgroup read is corroboration only (§4).
- **No privilege escalation.** Host-attested from `docker inspect` `HostConfig.SecurityOpt`
  (`no-new-privileges`, `runtime/hermes.ts:324`) and `HostConfig.CapDrop` (`ALL`,
  `runtime/hermes.ts:324`); seccomp/apparmor are Docker defaults unless overridden — we do not
  pass `--privileged` or `--security-opt seccomp=unconfined`, so defaults hold. The in-container
  `/proc/self/status` `Seccomp:` / `NoNewPrivs:` read corroborates but cannot be the sole source
  (it is forgeable, §4).

### 4.2 Surfacing and storage

- The coordinator runs the self-test on demand (a Settings → Readiness / per-agent "Verify
  sandbox" action) and on policy change, via the existing probe transport
  (`runtime/profile-runtime.ts:20`, paired via `runtime/runner.ts:134`).
- Results are stored as a run event (`events` table, `runtime/db.ts:149`–`158`) and/or a small
  `sandbox_selftests(agent_id, runner_kind, result_json, created_at, ok)` table keyed by agent,
  so the latest result and history are queryable.
- The UI shows a per-agent badge (green all-pass / amber partial / red fail) with the per-check
  detail. **Native/direct runners render every container-only check as "not a sandbox"** rather
  than pass/fail, matching `SECURITY.md:15`, so the operator is never told a native agent is
  isolated.

## 5. Per-team shared folder (replacing the global shared mount)

Today `-v ${shared}:/workspace/shared` (`runtime/hermes.ts:329`, `shared` from
`runtime/hermes.ts:317`) is one directory mounted read-write into every agent — cross-agent
read/write with no scoping. Replace it with per-team folders.

Design:

- Shared storage root becomes `${stateRoot}/teams/<teamId>/shared`. An agent's container mounts a
  shared folder **only for the teams it belongs to** (membership via `team_members`,
  `runtime/teams.ts:19`–`24`), e.g. `/workspace/teams/<teamId>`. An agent in no team gets no
  cross-agent shared mount (only its own `/workspace/private`).
- The mount list is assembled where folder mounts already are (`runtime/hermes.ts:318`–`323`);
  per-team shared mounts are appended the same way, honoring a read/write mode per team if
  desired. The team shared path joins the container signature so membership changes rebuild the
  container (`runtime/hermes.ts:303`).
- Read/write scoping: writers are team members; an `observer`-style team role (if adopted from
  the chat design) could mount `:ro`, reusing the `:ro` suffix pattern at
  `runtime/hermes.ts:322`.
- **Every current writer of the global `shared` must move with it, not just the container mount.**
  The single `${stateRoot}/shared` directory is referenced in several places that this design has
  to update together, or files will split across old and new layouts:
  - the default **working directory** for a turn: `session.create` defaults `cwd` to
    `/workspace/shared` (`runtime/service.ts:291`, `runtime/runner.ts:113`) and the native path
    uses `join(root, 'shared')` (`runtime/service.ts:230`, `:287`); the compiled config default is
    `/workspace/shared` (`runtime/profile-runtime.ts:91`). These must point at the agent's team
    folder (or its private dir when it has no team), and the doc commits to the team folder as the
    new default `cwd`.
  - the `/v1/migrate` **file import**, which writes uploaded files into `root/shared`
    (`runtime/service.ts:654`).
  - any `/v1/files` write with shared scope.
  All of these move to the per-team path or, for an agent in no team, to its private directory.

### 5.1 Migration

1. Keep the global `${stateRoot}/shared` as a **legacy, default-team** folder so nothing breaks
   on upgrade; existing files are not moved destructively.
2. For each existing team, create `${stateRoot}/teams/<teamId>/shared`. Offer (not force) a
   one-time copy of legacy shared files into the team folder; the legacy folder stays until the
   operator confirms, matching the non-destructive migration style used for the browser import
   (backup preserved, `runtime/service.ts:655`).
3. A follow-up release can mount the legacy `shared` `:ro` (visible, not writable) to push
   writes toward team folders, then retire it. Each step is reversible because the legacy data is
   never deleted by the migration.

## 6. Threat model

**Assets.** Model credentials (managed profiles only); each agent's private files
(`/workspace/private`); team/shared files; the coordinator bootstrap token
(`SECURITY.md:7`); the host OS account and its network.

**Adversaries.** (a) A misbehaving/compromised agent model trying to exfiltrate data or reach
the host/network; (b) a compromised dependency inside an agent container; (c) a malicious or
buggy paired runner; (d) a network attacker reaching the coordinator port (addressed by the
loopback `Host` check, `SECURITY.md:7`). Not in scope: a malicious operator — the trust model is
a single trusted operator (`SECURITY.md:5`).

**Trust boundaries.** Container ↔ host (primary filesystem boundary, `SECURITY.md:11`); container
↔ internet (today **none** — open egress, §1.1 — this design adds it); agent ↔ coordinator
(bearer-token authenticated, `runtime/service.ts:96`); coordinator ↔ paired runner (pairing +
scoped credentials, `runtime/machines.ts`).

**Additional adversary paths (first draft omitted these).**

- **Container → host services.** Today, and in `open` mode, `--add-host
  host.docker.internal:host-gateway` (`runtime/hermes.ts:325`) lets an agent reach *any* service
  bound to the host's bridge interface or to all interfaces, not just the coordinator. The sharp
  edge: the dashboard proxy decides whether to hand out the bootstrap token from the
  client-supplied `Host` header alone (`app/api/local/[...path]/route.ts:27`–`31`), and a
  non-browser client inside a container can forge `Host: localhost`. If the dashboard is listening
  beyond loopback — e.g. the supervisor binds the app server `HOST: 0.0.0.0`
  (`desktop/supervisor.mjs:27`) — a container agent could fetch `/v1/bootstrap`, obtain the master
  token, and escape via host-path mounts / direct OS execution. **Mitigations:** under
  `allowlist`/`none`, deny the host gateway except the coordinator port; the proxy must reject the
  host gateway address outright; and the dashboard must not be reachable from agent containers.
- **Confused-deputy exfiltration.** A `none` agent can still hand data to an `open` teammate
  through a handoff (`runtime/service.ts:778`), a group message (group-chat design §4), or the
  team shared folder (§5), which then exfiltrates it. Egress policy is per-agent; data-movement
  between agents is a separate channel the operator must reason about. Documented as a residual
  risk, not solved by network policy alone.
- **Proxy-side destination checks.** An allowlisted host that resolves to a private address is a
  pivot. The proxy must resolve-and-reject RFC1918 ranges, link-local `169.254.169.254` (cloud
  metadata), and the host gateway — allowing only the literal public destinations in `allow` plus
  the model endpoint.
- **DNS.** DNS itself is an exfiltration channel; the pinned proxy/resolver must be the only one
  reachable (§2.1), and the probe includes a DNS-exfil check (§4.1e).
- **The model endpoint is an egress channel too.** Because every mode must reach the model host
  (§2.1), a `none` agent can still smuggle data out inside an inference request — most sharply to a
  custom `base_url` the operator set (`runtime/profile-runtime.ts:84`). `none` means "coordinator
  + model endpoint only", which is a real reduction of reachable hosts, not "no egress"; the UI
  must label it that way so an operator is not misled.

**Delta vs. `SECURITY.md`.** `SECURITY.md:9`–`17` claims a filesystem boundary and makes **no**
network claim. This design (a) adds a real egress boundary the docs can then describe, (b)
narrows the global shared mount — `SECURITY.md:11` says only that *other agents' private*
directories are not mounted and makes **no** claim that the shared folder is private, yet §1.2
shows it is a single directory writable by every agent, which this design scopes per team (§5);
and (c) gives the operator a probe to verify the boundaries `SECURITY.md` asserts.
**Direct/native mode remains explicitly not a sandbox** (`SECURITY.md:15`); the probe and UI must
keep saying so — network policy there is advisory.

## 7. Test matrix

Dimensions: policy `{none, allowlist, open}` × runner `{local container, paired container,
native}` × probe check (the seven in §4). `OPEN_HARNESS_MOCK=1` for unit coverage; real-runtime
passes recorded in `runtime/VERIFICATION.md` (current record notes filesystem isolation and
process-tree termination were checked on 2026-09-25; network policy and per-team folders are new
and unverified).

All container rows are **host-attested** via `docker inspect` (§4, layer 1); paired-container
cells are "runner-attested" (same value, lower trust). `pass*` depends on a hardening flag not yet
in the launch vector.

| Check \ (policy, runner) | none/container | allowlist/container | open/container | any/native |
| --- | --- | --- | --- | --- |
| writes outside writable mounts denied | pass* | pass* | pass* | n/a (not a sandbox) |
| host home absent | pass | pass | pass | n/a |
| docker socket absent | pass | pass | pass | n/a |
| egress: coordinator reachable | pass | pass | pass | pass (socket/URL) |
| egress: model endpoint reachable | pass | pass | pass | advisory |
| egress: allow host reachable | n/a | pass | pass | advisory |
| egress: other host refused | pass | pass | fail-by-design (open) | advisory/fail |
| egress: DNS + host-gateway exfil refused | pass | pass | fail-by-design (open) | advisory/fail |
| no foreign secrets visible | pass | pass | pass | n/a |
| cpu/mem/pids limited | pass | pass | pass | n/a |
| no privilege escalation | pass | pass | pass | n/a |

`pass*` holds only once `--read-only` (plus `--tmpfs /tmp`) is added to the launch vector (§4.1);
without it the image rootfs is writable and the row is fail-by-design.

Specific tests:
- **Unit:** policy → `docker run`/network argument builder emits `--internal` network + dual-homed
  proxy (incl. the model endpoint) for `allowlist`; for `none` on Linux Engine, either `--internal`
  + a model-endpoint relay with the socket, or bare `--network none` + socket **only** when
  inference is relayed through the coordinator (§2.1 row `none`, §3); the dual-homed relay on Docker
  Desktop; today's vector for `open`. Signature changes on policy change (`runtime/hermes.ts:303`).
  Per-team mount list excludes non-member teams (`runtime/teams.ts`), includes member teams, honors
  `:ro`.
- **HTTP/integration (mock + real):** run the self-test probe and assert the JSON per cell above;
  assert a `none` agent can still call `/internal/*` (coordinator reachable) **and** complete one
  real inference call — the model reached via the model-endpoint relay, or, under the relayed
  shape, via the coordinator (model endpoint reachable, §2.1, §3) — while a canary host and a rogue
  DNS resolver time out/refuse; cross-check every cell against `docker inspect` (host-attested, §4).
- **Chaos/restart:** managed network + proxy containers are reaped by the `MANAGED_LABEL` sweep
  on shutdown (`runtime/hermes.ts:285`–`288`); assert no orphaned networks/proxies after
  stop-all, consistent with the process-tree-termination guarantee (`SECURITY.md:11`, in-scope
  at `SECURITY.md:27`).
- **Negative:** an agent that rewrites its own `HTTP_PROXY`/`NO_PROXY` or `/etc/hosts` still
  cannot reach a non-allow host, because the `--internal` network has no route (enforcement is
  outside the container).

## 8. Phased rollout

1. **Policy field + `open` default + self-test probe (read-only).** Add `network` to
   `ComputerConfig`, ship `sandbox_selftest.py`, surface results in the UI. No egress change yet,
   so nothing breaks; the probe immediately documents the current open-egress reality (§1.1).
2. **`allowlist`/`none` for local containers.** Per-agent `--internal` network + dual-homed relay
   pinned to the model endpoint (Linux Engine and Docker Desktop); bare `--network none` + socket
   only when inference is relayed through the coordinator (§2.1, §3); the effective model
   endpoint is always in the egress set (§2.1); add `--read-only` + `--tmpfs /tmp` so the
   writes-denied check genuinely passes (§4.1); rebuild only when the agent is idle (§9).
3. **Per-team shared folders.** New mount layout + non-destructive migration (§5.1).
4. **Paired runners.** Same mapping on the runner's Docker; native reported as advisory.
5. **Flip defaults.** New agents default to `allowlist` (or `none`); document the boundary in
   `SECURITY.md` and record a real-runtime pass in `runtime/VERIFICATION.md`.

## 9. Open questions

- **Proxy granularity.** Host-level allow (`api.example.com`) vs. host+port vs. full URL path?
  TLS makes path filtering a MITM; lean toward host[:port] with SNI-based allow, no interception.
- **Shared proxy vs. per-agent proxy.** One proxy per policy-group (cheaper) vs. one per agent
  (stronger isolation, more containers). Per-agent is cleaner for the deadlock-free lifecycle but
  heavier; revisit against `pids`/memory budgets.
- **DNS under `none`.** Even coordinator-only agents may need to resolve
  `host.docker.internal`; confirm the internal network resolves it without granting general DNS.
- **Direct model route vs. coordinator relay.** `none`/`allowlist` currently keep a direct route
  to the model endpoint because Hermes calls it from inside the container (§2.1). The stricter
  alternative is to relay all inference through the coordinator so the container needs no provider
  route and the key never leaves managed storage — heavier, and it puts inference traffic through
  the coordinator process. Worth it for the exfiltration reduction, or is the pinned endpoint
  allowance acceptable?
- **Root filesystem `--read-only`.** The writes-denied check only truly passes with `--read-only`
  + `--tmpfs /tmp` added to the launch vector (§4.1). Ship it as part of this work (it also folds
  into `containerSignature`), or treat the writable image rootfs as a separate hardening task?
  Must confirm the pinned Hermes image tolerates a read-only root first.
- **Native enforcement ceiling.** Is any OS-level egress control worth shipping for native, or
  does advisory-only keep the "not a sandbox" message honest and avoid false assurance?
- **Legacy shared cutover.** When is it safe to make `${stateRoot}/shared` read-only or remove
  it? Needs telemetry on who still writes there.
- **Signature churn vs. in-flight runs.** Folding network + team mounts into `containerSignature`
  (`runtime/hermes.ts:303`) means a team edit changes the signature and the next `ensureContainer`
  **force-removes** the container to rebuild it (`docker rm -f`, `runtime/hermes.ts:307`–`308`).
  For an agent with a live run that is a hard kill of its container mid-turn. So the rebuild must
  be gated on the agent being idle (no active run) or deferred until the current run finishes;
  the design should not let a membership change `rm -f` a running agent. Is signature-driven
  rebuild acceptable at all here, or should team/network mounts be hot-applied on the next
  idle transition instead?
