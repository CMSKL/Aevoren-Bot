# Roadmap

This roadmap is intentionally short and describes direction, not a promise of dates. Safety, local data integrity, and reproducible releases take priority over feature breadth.

## Current release line

- macOS-first local Bot and Room conversations;
- first-phase API, Claude Code, and Codex CLI discovery, validation, and model selection;
- reviewed long-term Memory capture, read-only Workspace access, reviewed MCP tools, and approval journals;
- discoverable AI product operations and concurrent Everyone group replies;
- persistent documents and text Skills, immutable revisions, conversation bindings, package import/export and fixed composer references in the v0.3.0-beta.27 release candidate;
- bounded Routines and recovery-aware signed update infrastructure;
- Apache-2.0 source with brand identity handled separately.

## Next priorities

1. Finish installed-package and release validation of the implemented document/text-Skill stage for v0.3.0-beta.27. The complete unit suite passed 1,195 tests with three skipped; hidden Electron acceptance is being rerun after the sandboxed Preload correction.
2. Build a configured execution environment with terminal, files, background processes, cancellation and recovery.
3. Add browser sessions, computer views, user takeover and verified service previews.
4. Add executable Skill packages, application connectors, reviewed write actions and richer MCP results.
5. Add media attachments and previews, speech transcription and playback, then real-time voice.
6. Expand resource search, task threads, event-triggered Routines, templates, exports and optional self-hosted sharing.

The [implementation record](docs/IMPLEMENTATION_PLAN.md) tracks these six stages and their actual evidence. The [Grok Bot feature comparison and implementation plan](docs/FEATURE_ADOPTION.md) records shipped-client evidence, current Aevoren gaps and acceptance criteria. Product login and registration are outside the current implementation scope. Planned capabilities remain unavailable until their actual adapters pass validation; provider keys and third-party authorization are still required where applicable.

## Later exploration

- broader platform support after a separate packaging and permission review;
- richer collaboration and workflow orchestration;
- optional cloud sync only after a new privacy and data-authority design;
- community governance and contributor-led integrations.

Roadmap discussion belongs in GitHub Discussions and scoped Issues. A proposal does not imply a committed release date.
