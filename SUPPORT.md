# Support

## Questions and troubleshooting

Before opening an Issue:

1. Read [README.md](README.md), [docs/INSTALLATION.md](docs/INSTALLATION.md), and [docs/CONFIGURATION.md](docs/CONFIGURATION.md).
2. Confirm the issue reproduces on the latest available commit or release.
3. Run `pnpm validate` for source builds.
4. Remove or redact API keys, OAuth tokens, local paths, transcripts, database contents, and account identifiers.

Use a GitHub Issue for reproducible bugs. Feature ideas should use the feature request template.

Security issues must use the private process in [SECURITY.md](SECURITY.md).

## Maintainer targets

These are operating targets for the pre-release project, not guaranteed service-level commitments:

- acknowledge a complete private security report within 3 business days when the report is accessible;
- triage reproducible public bugs within 7 calendar days;
- document a release-impacting regression or security fix before promoting it from `dev` to `beta`.

## Scope

The supported release target is macOS 13 or newer on Apple silicon. Windows 10/11 x64 is covered by the source-build and CI MVP matrix, but signed public Windows installers are pending certificate setup. Linux, Intel macOS, mobile platforms, third-party Provider outages, and arbitrary MCP Server behavior are not currently covered by the supported release matrix.
