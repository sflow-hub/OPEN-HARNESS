# Agent profile upgrade verification

Verified locally on September 14, 2026, using Node 22 and the pinned Hermes source interface (`v2026.9.11`, `939e45c91d751fadd94dcd1b873ac3cb44846213`).

- `npm test`: 32 passing tests, including persistent profile revisions, independent model overrides, inheritance, stale saves, next-task snapshots, explicit empty grants, credential separation, MCP inventory retention, stream completion, provider errors, and scoped Unix coordination sockets. This total also includes the existing legacy-loop regression tests.
- The Node suite invokes seven Python policy tests for allowed and denied dispatch, nested code-tool dispatch, model schema filtering, forced disabled choices, and fail-closed empty/missing policy behavior.
- Playwright: 14 passing Chromium tests across desktop and mobile, covering all four editor tabs, Save/Cancel, prompt switches, individual/group/all-off tools, inline MCP configuration, failed-save retry, reload persistence, stale-save recovery, keyboard navigation, and visible mobile save controls.
- `npm run lint`, `npm run typecheck`, `npm run build`, and `git diff --check`: passed.

The deterministic control tests and browser tests use an explicitly labeled mock runtime and no paid inference. They do not establish live Hermes acceptance.

## Pending real-runtime verification

Docker is installed but its daemon is stopped; the pinned container image is not built. Consequently the installed Hermes model catalog, real provider authentication/inference, actual MCP servers, middleware loading inside Hermes, native subagent restrictions, container-side endpoint probes, filesystem isolation, and process-tree termination remain unverified. The broader code-repair, real browsing/screenshot, durable skill-use, named-agent teamwork, and scheduled real-model acceptance scenarios also remain pending.

Start Docker, run `npm run harness:setup`, and configure model credentials in Settings before running those checks. Existing containers must use the rebuilt image and the read-only managed-policy mount. No paid model calls were made during this verification.
