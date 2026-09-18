## Outcome

Describe the user-visible result and why the change is needed.

## Scope

- Included:
- Explicitly excluded:

## Verification

- [ ] `pnpm verify`
- [ ] Relevant Unit/Integration tests
- [ ] `pnpm test:smoke` for runtime or UI changes
- [ ] Normal, failure, cancellation, recovery, and boundary cases considered
- [ ] No regression to existing Bot/Room/Memory/Tool flows

## Security and release impact

- [ ] No credentials, private transcripts, databases, personal paths, or unlicensed third-party material are included
- [ ] New permissions, network destinations, dependencies, migrations, environment variables, and external services are documented
- [ ] `THIRD_PARTY_NOTICES.md` was regenerated if production dependencies changed
- [ ] The change does not weaken typed IPC, Renderer sandboxing, `safeStorage`, approval, Tool Journal, signing, or update trust boundaries

## Evidence

List test output, safe screenshots, or failure-injection evidence. Use synthetic data only.
