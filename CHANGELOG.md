# Changelog

All notable changes to Aevoren Bot will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

## [0.3.0-beta.11] - 2026-09-24

### Added

- A compact Room execution indicator shows only the currently running Bot; completed batches no longer leave a persistent process panel in the conversation.
- The Workspace heading provides the single add-workspace entry point in the sidebar.

### Fixed

- Fixed-route Room Bots now receive the original user request without treating earlier peer replies as tool evidence, and unexpected Handoff requests cannot start duplicate role dispatches.
- Unsupported tool-completion claims get one bounded correction attempt and still fail closed if the current Runtime has no successful tool evidence.

## [0.3.0-beta.10] - 2026-09-24

### Added

- Group chats and Bots are organized under a collapsible Workspace section in the sidebar.

### Changed

- Bot avatars are assigned automatically when Bots are created, duplicated, or added from a team template; profile details no longer require users to choose an avatar.
- The conversation details panel can be collapsed on desktop, and the per-reply Markdown export action has been removed.
- Automatic update checks now use a configurable interval, while update downloads remain unobtrusive during active work.

## [0.3.0-beta.9] - 2026-09-23

### Changed

- Repackaged the current Beta application as `0.3.0-beta.9` to validate automatic updates from the preceding Beta build; no application behavior changes.

## [0.3.0-beta.8] - 2026-09-23

### Fixed

- Direct and Room speaker labels now use the configured Bot name, and an open Room refreshes member identity and avatar data after a Bot profile update.
- Bot avatar artwork now fills its square display area without the previous inset gutter while preserving its aspect ratio.

## [0.3.0-beta.7] - 2026-09-23

### Added

- A persistent Bot avatar picker with 12 original silhouettes and 8 colorways, shared by Bot lists, Room members, mentions, and speaker messages.

### Changed

- Existing Bots receive a safe default avatar during the database migration, and duplicated Bots retain their selected avatar.

## [0.3.0-beta.6] - 2026-09-22

### Added

- A task-level artifact shelf that collects Tool Journal-backed Workspace outputs and keeps their verified path, type, size, and reveal action available from the conversation header.
- Tamper-evident cross-Runtime execution receipts that carry the approved Brief, original task, verified tool results, artifact paths and SHA-256 digests into each automatic content-team handoff.
- A real-Provider content-team acceptance flow covering research, planning, human Brief approval, writing, fact review and CSV-backed analytics without manual routing or file handoff.

### Changed

- Consecutive successful tool calls now collapse into one reversible activity run, while active, approval-gated, and failed steps remain individually visible.
- Room response mode now lives in the conversation header; structured `@Bot` mentions remain the per-message routing override.
- Workspace outputs render as compact artifact cards, and manual reply export is presented separately instead of appearing as an unsaved artifact.
- Completed Room runs and normal Agent handoffs use compact receipts so the terminal answer, required decision, and saved outputs remain the visual focus.
- Content-team continuation is controlled by the Host from successful journalled artifacts; model text and provider-emitted role mentions cannot silently start another Agent.

### Fixed

- Invalid but recoverable Workspace tool arguments now return a corrective tool result to the model instead of discarding other valid calls or failing the whole Runtime.
- Brief approval recognizes annotated headings, vertical separators, emphasized fields and provider-generated title annotations while remaining bound to the exact saved file digest.
- Text-length enforcement no longer mistakes numeric UUID fragments for requested character ranges.
- CSV reports reject mismatched Host metrics and unrequested mental-arithmetic conversions, percentages or elapsed-time estimates before the file is written.

## [0.3.0-beta.5] - 2026-09-22

### Added

- Create-only Workspace artifacts for bounded Markdown and CSV output, with explicit per-Workspace write and automation controls.
- A one-click content-team template with atomic Bot and Room creation, structured Handoff rules, real tool evidence gates, and exact text measurement.
- Contextual Brief approval, delivery-file status, structured failure recovery, concise long-message summaries, and clearer Room routing controls.

### Changed

- Room descriptions now enter the model context, and collaboration claims are checked against the current Runtime's successful Tool Journal records.
- Workspace, public read-only network, and content-team interfaces now distinguish generated text from real tool execution and saved files.

### Fixed

- Stabilized combined Workspace and Handoff tool-call parsing without requiring users to split valid multi-tool work into manual steps.
- Prevented unsupported read, fetch, verification, write, metric, and exact-length claims from being presented as completed work.
- Kept the Brief decision UI inside the relevant transcript item instead of occupying a persistent page-level workflow row.
- Preserved usable Bot settings and model configuration controls at 200 percent zoom on compact windows.

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

[0.3.0-beta.6]: https://github.com/CMSKL/Aevoren-Bot/compare/v0.3.0-beta.5...v0.3.0-beta.6
[0.3.0-beta.7]: https://github.com/CMSKL/Aevoren-Bot/compare/v0.3.0-beta.6...v0.3.0-beta.7
[0.3.0-beta.8]: https://github.com/CMSKL/Aevoren-Bot/compare/v0.3.0-beta.7...v0.3.0-beta.8
[0.3.0-beta.9]: https://github.com/CMSKL/Aevoren-Bot/compare/v0.3.0-beta.8...v0.3.0-beta.9
[0.3.0-beta.10]: https://github.com/CMSKL/Aevoren-Bot/compare/v0.3.0-beta.9...v0.3.0-beta.10
[0.3.0-beta.11]: https://github.com/CMSKL/Aevoren-Bot/compare/v0.3.0-beta.10...v0.3.0-beta.11
[0.3.0-beta.5]: https://github.com/CMSKL/Aevoren-Bot/compare/v0.3.0-beta.4...v0.3.0-beta.5
[0.3.0-beta.4]: https://github.com/CMSKL/Aevoren-Bot/compare/v0.3.0-beta.3...v0.3.0-beta.4
[0.3.0-beta.3]: https://github.com/CMSKL/Aevoren-Bot/compare/v0.3.0-beta.2...v0.3.0-beta.3
[0.3.0-beta.2]: https://github.com/CMSKL/Aevoren-Bot/compare/v0.2.0-beta.7...v0.3.0-beta.2
