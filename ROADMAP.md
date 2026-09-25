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
| Phone access (Android app and phone browser) | Both reach a coordinator over HTTPS with a scoped, revocable device credential and share one mobile-first UI. Pairing, run following, tasks, approvals, notifications, Back-button navigation, downloads and external links are verified on the emulator ([ANDROID.md](ANDROID.md)); not yet on a physical device or against a real Hermes run. The dashboard follows every live run, answers approvals and questions in the conversation, and rebuilds history from the coordinator on a fresh client (Playwright `tests/browser/chat.spec.ts`). No iOS build exists (needs macOS). |
| Hosted "Open Harness Site" (Cloudflare/D1) | Earliest-stage surface. Currently authenticates via a single bearer control token, not per-user login — not yet suited to serving multiple independent operators. |

## Before 1.0

- **Container and provider acceptance.** Native pinned Hermes and genuine local-model inference have passed file tools, clarification, conversation context, task MCP, and process recovery checks. The pinned container, Compose deployment, real browsing, and optional integrations still need deployment-specific acceptance; exact evidence and remaining checks are in `runtime/VERIFICATION.md`.
- **Desktop release validation.** The packaged macOS dashboard renders with its HTTP Content-Security-Policy and shuts down its sidecars cleanly. Signed release builds and Windows/Linux desktop execution still need platform checks.
- **Release secret provisioning.** Signed desktop builds require code-signing and notarization secrets to be present in GitHub Actions; unverified from a source checkout.

## Out of scope for now

- Multi-tenant auth/isolation for the hosted site. Open Harness's trust model (see [SECURITY.md](SECURITY.md)) assumes a single trusted operator; making the hosted surface safe for independent, mutually-untrusted operators is a separate, larger effort than anything tracked here.
