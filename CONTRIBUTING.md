# Contributing to Aevoren Bot

Thanks for helping improve Aevoren Bot. The project is currently macOS-first and pre-release, so changes should keep reliability, local data safety, and explicit user approval ahead of feature breadth.

## Before opening a change

- Use GitHub Issues for reproducible bugs and scoped feature proposals.
- Report security vulnerabilities through the private process in [SECURITY.md](SECURITY.md), not a public Issue.
- Do not submit credentials, private transcripts, production databases, personal paths, third-party screenshots, proprietary protocol dumps, or assets you do not have permission to redistribute.
- Keep unrelated refactors out of focused fixes.

## Development setup

Requirements:

- macOS 13 or newer on Apple silicon for the supported desktop target;
- Node.js 24;
- pnpm 11.19.0.

```bash
pnpm install --frozen-lockfile
AEVOREN_BOT_FAKE_PROVIDER=1 pnpm dev
```

The Fake Provider is deterministic and requires no API key. Never put real credentials in `.env`, fixtures, screenshots, logs, Issues, or pull requests.

## Branch and pull request flow

1. Start from `dev` and create a focused feature branch.
2. Open pull requests against `dev`.
3. Maintainers promote validated changes from `dev` to `beta`, then from `beta` to `master`.
4. Do not target `master` directly except through the documented release promotion flow.

Use clear commit messages such as `fix: ...`, `feat: ...`, `docs: ...`, or `test: ...`.

## Required checks

Run the smallest relevant tests while developing, then run the full local gate before requesting review:

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm test:smoke
pnpm security:audit
```

If production dependencies change, regenerate and commit the third-party inventory:

```bash
pnpm licenses:generate
pnpm licenses:check
```

UI and runtime tests must use temporary `AEVOREN_BOT_USER_DATA_DIR` directories. Never point automated or destructive tests at a daily-use Aevoren Bot database.

## Pull request expectations

- Explain the user-visible outcome and scope.
- Add or update tests for normal, failure, cancellation, recovery, and boundary behavior.
- Preserve typed IPC, Renderer sandboxing, `safeStorage`, Tool Journal, and explicit approval boundaries.
- Document new environment variables, permissions, external services, migrations, dependencies, and release implications.
- Confirm `git diff --check` is clean and no generated build outputs are included.

The maintainers may ask for a smaller change, additional safety evidence, or removal of material whose redistribution rights are unclear.
