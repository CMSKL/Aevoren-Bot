# Security Policy

## Supported versions

Aevoren Bot is currently pre-release. Security fixes are applied to the latest development line and, after validation, promoted through `dev` → `beta` → `master`. Older prerelease builds may stop receiving fixes.

## Reporting a vulnerability

Do not open a public Issue for a suspected vulnerability and do not include real API keys, OAuth tokens, private transcripts, databases, or personal data in a report.

Use GitHub's private vulnerability reporting for this repository:

`https://github.com/CMSKL/Aevoren-Bot/security/advisories/new`

Include:

- affected version or commit;
- impact and required preconditions;
- minimal reproduction steps using synthetic data;
- whether the issue exposes credentials, local files, transcripts, update trust, or external side effects;
- a suggested mitigation, if known.

Maintainers will acknowledge a complete report as soon as practical, reproduce it privately, coordinate a fix, and publish an advisory after users have a safe upgrade path. Please do not disclose the issue publicly before that point.

## Security boundaries

- Renderer code is sandboxed and receives only typed Preload capabilities.
- Secrets are stored through Electron `safeStorage` and are never returned to the Renderer after saving.
- Workspace, clipboard, network, and trusted read-only MCP tools require explicit approval.
- Third-party MCP metadata and web content are untrusted input.
- Release builds must be signed, notarized, checksummed, and produced by the tagged GitHub Actions workflow.

These controls reduce risk but do not make third-party models, CLI tools, MCP servers, or downloaded releases inherently trustworthy. Review providers and permissions before enabling them.
