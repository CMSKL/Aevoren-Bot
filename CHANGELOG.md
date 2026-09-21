# Changelog

All notable changes to Aevoren Bot will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

## [0.3.0-beta.4] - 2026-09-21

### Fixed

- Forced structured Room owner and continuation tool calls for OpenAI-compatible Providers.
- Normalized whitespace-only completion tasks without relaxing validation for actual Handoff content, preventing valid no-mention replies from ending as partial with `MODEL_ROUTER_INVALID`.

## [0.3.0-beta.3] - 2026-09-21

### Changed

- Rebuilt the verified Beta release line to exercise the complete signed `0.3.0-beta.2` to `0.3.0-beta.3` automatic-update path with public GitHub Release assets.

## [0.3.0-beta.2] - 2026-09-21

### Added

- Capability Self State for current version, model, tools, permissions, connections, time, and runtime environment.
- Safe read-only network tools for time, Open-Meteo weather, multi-source public web search, and bounded public HTTPS page reading.
- MCP stdio and Streamable HTTP support with OAuth 2.1/PKCE, per-Bot scope, explicit tool review, and one-time approval.
- User, Bot, and Workspace-scoped reviewed Memory capture with typed candidates, expiry, privacy controls, and prompt budgets.
- One-time, interval, and cron Routines with run history, notifications, and optional macOS login item support.
- Codex App Server Dynamic Tool integration through Aevoren's Approval and Tool Journal boundary.
- Exa Search MCP preset.
- First-phase API, Claude Code, and Codex CLI discovery, selection, validation, and real invocation paths.
- Bounded text/code attachments, Markdown artifact export, unified expandable traces, and Windows x64 MVP packaging.
- Structured multi-Agent Handoff and Jev Shadow Mode decision comparison without changing the accepted main route.

### Changed

- Web search now falls back from DuckDuckGo instant answers to Bing RSS and DuckDuckGo HTML/Lite, and fails explicitly instead of presenting upstream blocking as an empty result set.
- Model and CLI settings use one three-source registry and reject hidden or unsupported provider selections.

### Security

- Public-network address pinning, private-network rejection, response size limits, untrusted-content labeling, and result provenance.
- Third-party MCP `readOnlyHint` claims require exact user review before exposure to models.
- OAuth tokens, client credentials, Provider keys, and MCP Headers remain encrypted behind Electron `safeStorage`.
- Background Memory capture considers only the current human message and blocks likely credentials before persistence.

[0.3.0-beta.4]: https://github.com/CMSKL/Aevoren-Bot/compare/v0.3.0-beta.3...v0.3.0-beta.4
[0.3.0-beta.3]: https://github.com/CMSKL/Aevoren-Bot/compare/v0.3.0-beta.2...v0.3.0-beta.3
[0.3.0-beta.2]: https://github.com/CMSKL/Aevoren-Bot/compare/v0.2.0-beta.7...v0.3.0-beta.2
