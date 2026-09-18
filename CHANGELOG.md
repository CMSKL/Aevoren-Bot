# Changelog

All notable changes to Aevoren Bot will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- Capability Self State for current version, model, tools, permissions, connections, time, and runtime environment.
- Safe read-only network tools for time, weather, limited Wikipedia search, and bounded public HTTPS page reading.
- MCP stdio and Streamable HTTP support with OAuth 2.1/PKCE, per-Bot scope, explicit tool review, and one-time approval.
- User, Bot, and Workspace-scoped explicit Memory.
- One-time, interval, and cron Routines with run history, notifications, and optional macOS login item support.
- Codex App Server Dynamic Tool integration through Aevoren's Approval and Tool Journal boundary.
- Exa Search MCP preset.

### Security

- Public-network address pinning, private-network rejection, response size limits, untrusted-content labeling, and result provenance.
- Third-party MCP `readOnlyHint` claims require exact user review before exposure to models.
- OAuth tokens, client credentials, Provider keys, and MCP Headers remain encrypted behind Electron `safeStorage`.

No public version has been released yet. Links to version comparisons will be added with the first published tag.
