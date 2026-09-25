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
| Desktop app (Windows/macOS/Linux) | Functional; signed-release infrastructure exists but depends on release secrets being provisioned per platform. |
| Hosted "Open Harness Site" (Cloudflare/D1) | Earliest-stage surface. Currently authenticates via a single bearer control token, not per-user login — not yet suited to serving multiple independent operators. |

## Before 1.0

- **Self-hosted MVP live acceptance.** The deterministic core and browser suites pass, but the 2026-09-24 verification machine had no accessible Docker daemon or configured model credential. A clean Compose install, real file-writing model task, restart recovery, process-tree stopping, and backup restore must pass before calling the self-hosted build MVP-ready.

- **Real-runtime verification.** The automated suite still runs against an explicitly mocked Hermes runtime (`OPEN_HARNESS_MOCK=1`). Real-runtime passes on 2026-09-21/22 covered credential storage, profile preparation, plugin loading, gateway startup, authenticated round trips to an OpenAI-compatible endpoint (directly and as a proxy for a first-party provider), stale-image detection via the image's runtime label, and the state-directory choice; they fixed six defects the mocked suite could not see. Filesystem isolation, process-tree termination, paid-provider inference, real MCP servers, and Direct Computer Access remain unverified. Tracked in `runtime/VERIFICATION.md`.
- **Desktop CSP validation.** A Content-Security-Policy was recently defined for the Tauri webview; it needs a real `npm run desktop:dev` smoke test to confirm it doesn't break the dashboard before it ships in a signed release.
- **Release secret provisioning.** Signed desktop builds require code-signing and notarization secrets to be present in GitHub Actions; unverified from a source checkout.

## Out of scope for now

- Multi-tenant auth/isolation for the hosted site. Open Harness's trust model (see [SECURITY.md](SECURITY.md)) assumes a single trusted operator; making the hosted surface safe for independent, mutually-untrusted operators is a separate, larger effort than anything tracked here.
