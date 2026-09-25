# Roadmap

Open Harness is pre-1.0 (currently `0.4.0-beta.1`). This document tracks feature
maturity and what's outstanding before a 1.0, not a scheduled feature list.

## Feature maturity

| Feature | Status |
| --- | --- |
| Per-agent Docker container (default) | Most mature path. Container isolation is the primary security boundary; see [SECURITY.md](SECURITY.md). |
| Selected folders | Mature. Mounts named host folders with their configured read-only/read-write setting. |
| Direct computer access | Least mature. Deliberately trades container isolation for host-native capability (screen, accessibility, an existing desktop session). Has the least real-world testing of the three modes — see [`runtime/VERIFICATION.md`](runtime/VERIFICATION.md). |
| Self-hosted Docker Compose stack | Focused single-operator MVP implemented: combined dashboard/coordinator health, explicit remote-dashboard opt-in, graceful shutdown, and operations guidance. A clean live Compose pass remains a release gate. |
| Desktop app (Windows/macOS/Linux) | Deferred. Builds from source and the signed-release workflow exists, but no release secrets are provisioned and it is not part of the beta. |

## Before 1.0

- **Self-hosted MVP live acceptance.** A real file-writing task against a paid provider, filesystem isolation, process-tree stopping, restart recovery and container reaping passed on 2026-09-25 (`runtime/VERIFICATION.md`). Still outstanding before calling the build MVP-ready: a clean Compose install from a packaged source release, a backup and restore cycle, an approval round trip, and a named-agent handoff.

- **Real-runtime verification.** The automated suite still runs against an explicitly mocked Hermes runtime (`OPEN_HARNESS_MOCK=1`). Real-runtime passes on 2026-09-21/22 covered credential storage, profile preparation, plugin loading, gateway startup, authenticated round trips to an OpenAI-compatible endpoint (directly and as a proxy for a first-party provider), stale-image detection via the image's runtime label, and the state-directory choice; they fixed six defects the mocked suite could not see. Filesystem isolation, process-tree termination, paid-provider inference, real MCP servers, and Direct Computer Access remain unverified. Tracked in `runtime/VERIFICATION.md`.
- **Desktop CSP validation.** A Content-Security-Policy was recently defined for the Tauri webview; it needs a real `npm run desktop:dev` smoke test to confirm it doesn't break the dashboard before it ships in a signed release.
- **Release secret provisioning.** Signed desktop builds require code-signing and notarization secrets to be present in GitHub Actions; unverified from a source checkout.

## Deferred

The supported install is a local browser dashboard on Linux, run from source or through
Docker Compose. These are understood but deliberately not part of the beta:

- **macOS and Windows.** Three known blockers, none of them small: Node has no AF_UNIX on
  Windows, so the agent coordination socket needs a named pipe or the HTTP control path;
  Docker Desktop does not forward a Unix socket through a bind mount, so container agents on
  either platform cannot reach the coordinator that way; and the test harness reaches for the
  real Keychain on macOS. `.github/workflows/ci.yml` builds Linux only until these are fixed.
- **Desktop installers and signed updates.** No code-signing, notarization, or updater keys
  exist. `desktop-release.yml` is `workflow_dispatch`-only and unverified.
- **A hosted multi-operator service.** The Cloudflare/D1 surface was removed in `0.4.0`: its
  authentication was a single spoofable header with no per-user scoping, and it shipped inside
  the local build. Open Harness's trust model (see [SECURITY.md](SECURITY.md)) assumes one
  trusted operator; serving mutually-untrusted operators is a larger effort than anything here.
- **Reproducible agent image.** `runtime/hermes/Dockerfile` pins the Hermes commit but floats
  its apt and pip dependencies.
- **Retention.** `events`, `runs`, and `runner_commands` grow without bound; there is no
  pruning and no agent-deletion path that removes a container, profile, and history.
