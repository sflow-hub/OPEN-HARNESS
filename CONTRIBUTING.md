# Contributing

## Setup

See the README's [Develop from source](README.md#develop-from-source) section. In short:

```bash
npm ci
npm run harness:doctor
npm run harness:setup
npm run dev
```

Node.js 22.13+ is required (`node:sqlite` doesn't exist before it); `.nvmrc` pins the version if you use nvm. Docker is required for anything beyond the mock runtime.

## Before opening a pull request

Run the full verification suite from the README's [Verify](README.md#verify) section and make sure it's clean:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

The deterministic suite sets `OPEN_HARNESS_MOCK=1` and makes no paid inference calls, so it's safe to run repeatedly while developing. If your change touches container lifecycle, runner pairing, or anything else the mock runtime doesn't exercise, also run the real-runtime checks described in [`runtime/VERIFICATION.md`](runtime/VERIFICATION.md) with Docker running and a real model provider configured, and say what you verified in your PR description.

Playwright coverage (`npx playwright install chromium && npm run test:browser`) is expected for changes to `components/` or `app/`.

## Security-relevant changes

If your change touches authentication, the bootstrap token, container isolation, runner pairing, or credential storage, call that out explicitly in the PR description — these get reviewed more carefully than typical changes. Please don't open a public issue or PR for a suspected vulnerability; see [SECURITY.md](SECURITY.md) instead.

## Style

- Keep changes minimal and scoped to the problem at hand; this codebase favors dense, direct code over added abstraction.
- Match the existing code's style in the file you're editing rather than introducing a new convention.
- Comments should explain *why*, not *what* — only add one where the reasoning genuinely isn't obvious from the code.

## Pull requests

Describe what changed and why, not just what. Link an issue if one exists. CI (`.github/workflows/ci.yml`) runs the same checks as above across Ubuntu, macOS, and Windows, plus the Playwright suite; a PR won't be merged with it red.
