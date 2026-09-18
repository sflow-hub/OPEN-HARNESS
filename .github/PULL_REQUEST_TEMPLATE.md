## What changed and why

## Verification

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] Playwright (`npm run test:browser`), if this touches `app/` or `components/`
- [ ] Real-runtime checks from `runtime/VERIFICATION.md`, if this touches container lifecycle, runner pairing, or credential handling — describe what you verified

## Security-relevant?

If this touches authentication, the bootstrap token, container isolation, runner pairing, or credential storage, say so here — see [CONTRIBUTING.md](CONTRIBUTING.md#security-relevant-changes).
