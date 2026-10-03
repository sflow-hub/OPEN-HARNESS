# Roadmap

Open Harness is pre-1.0 (currently `0.4.0-beta.1`). This document tracks feature
maturity and what's outstanding before a 1.0, not a scheduled feature list.

## Feature maturity

| Feature | Status |
| --- | --- |
| Per-agent Docker container (default) | Most mature path. Container isolation is the primary security boundary; see [SECURITY.md](SECURITY.md). |
| Selected folders | Compose grants exact explicitly exported roots with read-only/read-write ceilings. Native execution verifies folder identity before starting code and requires the same Linux kernel as Docker; cross-kernel native grants fail closed. |
| Computer control | Private agent desktops run inside per-agent containers on Linux with Docker. Legacy native Direct / Existing desktop modes are blocked; use Computer settings to convert them. Host desktop isolation is not claimed. |
| Local browser / Docker Compose | Docker-and-browser is the MVP target. Linux ARM64 has real runtime evidence; AMD64 container execution is still required and may use recorded emulation. Physical Mac/Windows checks are follow-up compatibility work, not MVP gates. The coordinator and agents run in Linux containers, with browser pairing, explicit host-folder exports and prebuilt ARM64/AMD64 package gates. Publication and final package/restore evidence are tracked in `runtime/VERIFICATION.md`. |
| Desktop app (Windows/macOS/Linux) | Deferred. Builds from source and the signed-release workflow exists, but no release secrets are provisioned and it is not part of the beta. |

## Before 1.0

- **Self-hosted MVP live acceptance.** Against a paid provider on 2026-09-25: a real file-writing task, filesystem isolation, process-tree stopping, restart recovery, container reaping, a named-agent handoff, a board task moved to Review by the agent itself, a scheduled routine, an approval round trip in both directions, and the first from-scratch build of the agent image (`runtime/VERIFICATION.md`). The September 26 source Compose check also passes a stopped backup restored into a fresh empty volume, including actual resumed work and desktop input. A separate September 26 Linux ARM64 rehearsal also passes extracted ZIP/tar launch, one-use browser pairing, anonymous pinned pulls from a disposable local registry, real desktop input and restart persistence. The published GHCR archive and final per-architecture Docker/browser acceptance remain outstanding. The September 29 scope decision removes physical Mac/Windows hardware as an MVP prerequisite.

- **Real-runtime verification.** The automated suite still runs against an explicitly mocked Hermes runtime (`OPEN_HARNESS_MOCK=1`). Real-runtime passes on 2026-09-21/22 covered credential storage, profile preparation, plugin loading, gateway startup, authenticated round trips to an OpenAI-compatible endpoint (directly and as a proxy for a first-party provider), stale-image detection via the image's runtime label, and the state-directory choice; they fixed six defects the mocked suite could not see. Two further passes on 2026-09-25 covered paid-provider inference, filesystem isolation, process-tree termination, crash recovery, and the whole coordination surface -- handoffs, task boards, routines and approvals -- and found ten more defects of the same kind, including four that each made every coordination tool silently absent. The current integration also verifies the private Chromium desktop, encrypted installed-runner credential rotation, durable memory/skills and team handoffs with a scripted local provider. Real third-party MCP servers still need separate acceptance. Native Direct Computer Access is disabled. Tracked in `runtime/VERIFICATION.md`.
- **Desktop CSP validation.** A Content-Security-Policy was recently defined for the Tauri webview; it needs a real `npm run desktop:dev` smoke test to confirm it doesn't break the dashboard before it ships in a signed release.
- **Release secret provisioning.** Signed desktop builds require code-signing and notarization secrets to be present in GitHub Actions; unverified from a source checkout.

## Deferred

The MVP install is a local browser dashboard with the coordinator and agents in Linux
Docker containers. Docker Desktop supplies that environment on Mac and Windows. These are understood but deliberately not part of the beta:

- **Host-native coordinators on macOS and Windows.** The supported browser architecture puts
  the coordinator, state and coordination sockets in Linux containers. This avoids depending
  on Windows Unix sockets or forwarding host sockets through Docker Desktop bind mounts.
  Running the coordinator directly on those hosts remains a separate acceptance effort.
  Physical Docker Desktop checks of startup, file-sharing prompts, Gatekeeper, SmartScreen
  and Windows PowerShell 5.1 are follow-up compatibility work, not MVP release gates.
  Container tests do not establish those host-specific results. Private desktops, shutdown
  and restore remain required Docker/browser checks. Signed desktop installers are separate.
- **Localhost-only model servers in Compose.** The coordinator and nested agent engine have
  different loopback interfaces. Host-local URLs and Docker host aliases are refused before
  probes or agent execution; use a configured hosted provider or an explicit model-server
  address reachable by both services. A host-model relay is not implemented.
- **Desktop installers and signed updates.** No code-signing, notarization, or updater keys
  exist. `desktop-release.yml` is `workflow_dispatch`-only and unverified.
- **Approval coverage.** Generated profiles use `manual` following the October 3 beta decision,
  so Hermes-flagged commands go to the operator. Unattended and scheduled approvals are denied.
  Hermes still decides which commands to flag; manual mode does not gate every command.
  Final-image acceptance must confirm approval denial, approval, reconnect and stopping while
  waiting. The historical guardian-model finding remains in `runtime/VERIFICATION.md`.
- **A hosted multi-operator service.** The Cloudflare/D1 surface was removed in `0.4.0`: its
  authentication was a single spoofable header with no per-user scoping, and it shipped inside
  the local build. Open Harness's trust model (see [SECURITY.md](SECURITY.md)) assumes one
  trusted operator; serving mutually-untrusted operators is a larger effort than anything here.
- **Reproducible agent image.** Hermes, base images and reviewed OS/browser inputs are pinned;
  OS/browser packages use signed snapshots and checked identities/hashes. Python and npm
  dependency resolution is not fully locked, so byte-identical rebuilds are not established.
  Ship and accept the exact immutable image digests instead of treating a rebuild as equivalent.
- **Retention.** `events`, `runs`, and `runner_commands` grow without bound; there is no
  pruning and no agent-deletion path that removes a container, profile, and history.
