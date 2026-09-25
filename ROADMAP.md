# Roadmap

Open Harness is pre-1.0 (currently `0.3.0`). This document tracks feature
maturity and what's outstanding before a 1.0, not a scheduled feature list.

## Feature maturity

| Feature | Status |
| --- | --- |
| Per-agent Docker container (default) | Most mature path. Container isolation is the primary security boundary; see [SECURITY.md](SECURITY.md). |
| Selected folders | Mature. Mounts named host folders with their configured read-only/read-write setting. |
| Direct computer access | Least mature. Deliberately trades container isolation for host-native capability (screen, accessibility, an existing desktop session). Has the least real-world testing of the three modes — see [`runtime/VERIFICATION.md`](runtime/VERIFICATION.md). |
| Self-hosted Docker Compose stack | Functional; hardening (container capabilities, healthchecks) is ongoing. |
| Desktop app (Windows/macOS/Linux) | Functional; signed-release infrastructure exists but depends on release secrets being provisioned per platform. |
| Remote browser access | Responsive dashboard with scoped, revocable device credentials. Pairing, live runs, tasks, approvals, conversation recovery, and small-screen layouts are covered by the browser suite. |
| Hosted "Open Harness Site" (Cloudflare/D1) | Earliest-stage surface. Currently authenticates via a single bearer control token, not per-user login — not yet suited to serving multiple independent operators. |

## Before 1.0

- **Container and provider acceptance.** Native pinned Hermes, genuine local-model inference, and real ARM64 container/Compose gates have passed their core run checks. Linux services, the installed remote runner, memory/skills, named handoffs, actual scheduled dispatch, Chromium and private virtual desktops also have integration evidence. Optional Camofox remains incompatible with the image's native libraries; use the default Chromium backend. Exact evidence and provider/platform limits are in `runtime/VERIFICATION.md`.
- **Desktop release validation.** The packaged macOS dashboard renders with its HTTP Content-Security-Policy and shuts down its sidecars cleanly. Signed release builds and Windows/Linux desktop execution still need platform checks.
- **Release secret provisioning.** Signed desktop builds require code-signing and notarization secrets to be present in GitHub Actions; unverified from a source checkout.

## Out of scope for now

- Multi-tenant auth/isolation for the hosted site. Open Harness's trust model (see [SECURITY.md](SECURITY.md)) assumes a single trusted operator; making the hosted surface safe for independent, mutually-untrusted operators is a separate, larger effort than anything tracked here.
