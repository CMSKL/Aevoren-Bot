# Changelog

## v0.3.0-beta.32 (development candidate)

- Add separate account/operation/target write grants and fixed saved-draft approvals for Gmail sending, ordinary Drive text-file creation/replacement and Notion page creation. Gmail sending requires explicit full-scope reauthorization.
- Persist external intent state before dispatch; interrupted or ambiguous results remain unknown and can only be reconciled through current read authorization. Repeated calls return the original current receipt without another approval or write.
- Preserve full immutable approval content, detect draft/authorization changes, and retire removed group members' old intent content permanently. Keep internal receipts across history clearing and Runtime removal.
- Use genuine host-outbound Runtime records for interface actions, retain six independent group members and route Stop to the exact owned task. Existing model Runtime controls stay separate.
- Fix duplicate approval portals in hidden surfaces and group inspectors. Migration 39 preserves existing records, pending approvals/tools, environment provenance, foreign keys, indexes and triggers.
- Local ordinary tests: 1,528 passed, 44 skipped; TypeScript, ESLint, build, license, documentation, open-source and security gates passed. Hidden source acceptance passed six cases; the frozen unsigned macOS package passed eight. Controlled HTTP is not real third-party account verification; cross-platform CI and signed publication remain pending.

## v0.3.0-beta.31 (development candidate)

- Preserve the main renderer's save/close handshake when an embedded App or preview frame loads; reset readiness only for a real main-page navigation. Add source, installed-package and signed-package close regressions.
- Add native Gmail, selected/app-created Drive files and shared Notion-page read adapters; Google uses PKCE and a random loopback callback, with separate Drive Picker authorization. Notion uses internal tokens and API version 2026-03-11.
- Encrypt credentials in the host, keep them outside AI metadata, and require explicit conversation/executor grants. Account/scope changes invalidate grants; token refresh does not expand permissions. Revocation and member removal block late results and old bindings.
- Add application connection settings and Contact/Room application tabs, with local draft revisions, conflict-preserving editors and fixed-account draft provenance. This delivery has no external send/write path.
- Keep old draft receipts pinned to their saved revision while querying current authorization; every remote read is fresh and rechecks its grant. Cancellation retains its typed outcome.
- Controlled adapter, SQLite and hidden UI tests passed. Real third-party authorization, binary media import/preview and final installation-package acceptance remain separate verification boundaries.

## v0.3.0-beta.30 (development candidate)

- Add exact-revision Bash/Python/Node Skill grants tied to a conversation, executing Bot, entry checksum and environment image. Script metadata does not grant execution permission.
- Preserve immutable host approval reviews for each AI script run, including interpreter, arguments, working directory and timeout; invalid or revoked targets cannot execute or reuse a cached result.
- Add source review, explicit grant/run confirmation, execution provenance, real output/state queries and precise cancellation to the existing Library and execution panels.
- Execution Worker 1.2.0 adds private package installation and immutable per-job script snapshots. Existing environments retain their image until explicit rebuild.
- Keep an uncertain run's original intent and query its actual execution rather than repeating it. Stopping an approval in a group cancels that member's Runtime; the group footer retains batch stop.
- This is the script-Skill delivery of Stage 4, under validation. Demonstration capture, native app connectors, writable MCP/Apps and subsequent stages are not yet delivered.

## v0.3.0-beta.29 (development candidate)

- Add isolated persistent Chromium and Linux desktops beside each conversation/executor's local Docker environment, with 27 shared browser/computer/preview actions.
- Transfer actual screenshot pixels through API, Claude MCP and supported Codex app-server adapters, with scope, Runtime and control-epoch checks before transmission.
- Add explicit user takeover/return, expiring noVNC connections, verified downloads and previews bound to the original registered background process.
- Preserve user ownership on disconnect/restart and require fresh observations after return; cancellation seals only the selected operation.
- Execution Worker 1.1.0 adds a fixed-target HTTP/WebSocket preview proxy; running older environments require an explicit rebuild to use it.
- Close Codex RPC input before disposal, stop its known live Windows process tree when necessary, and reject late tool responses after closure.
- Local source checks and 13 final unsigned macOS package scenarios passed; cross-platform CI and signing/release remain separate gates. This entry does not imply a published installer, real cloud image understanding or completed Windows Docker validation.

All notable changes to Aevoren Bot will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [0.3.0-beta.28] - 2026-10-13

### Added

- Local Docker Linux environments scoped to the conversation and executing Bot, with image preparation, start/sleep/rebuild, versioned Worker health and persistent workspace volumes. Six Room members can operate independent environments.
- Twenty-three shared environment/execution/process operations and Contact/Room execution tabs plus a Docker status card. Commands produce real stdout/stderr, exit codes and cancellation; separately registered background services retain independent lifetimes.
- Bounded environment file operations and native uploads/downloads, create-only writes and expected-SHA-256 replacement checks. Service-port registration verifies actual listener ownership and connectivity; browser/service previews remain a later stage.

### Fixed

- Execution intent nonces use normalized foreground defaults (`cwd=.` and 120-second timeout); retries query existing tasks instead of replaying unknown side effects. Background tasks have no default timeout. Model-supplied task nonces and cross-executor/session identities are rejected.
- Clearing chat history preserves background ownership and historical Runtime provenance. Deleting a Bot or Room releases its containers and cleans only related application records while retaining Docker volumes. Sleeping an environment interrupts its active tasks without replay on wake.
- Environment state, logs and port records share the existing SQLite database and scope validation. Host tokens/control addresses are absent from public DTOs; Worker containers do not mount host HOME, Docker sockets or browser profiles.
- Removing a group member retires only that member's environment in the group. Delayed first starts are rejected during deletion, and legacy revoked scopes cannot block other environments' recovery or shutdown.
- Foreground cancellation seals pending startup before a Worker can spawn the command. Legal 1 MiB decoded files remain readable despite JSON escaping overhead. Unchanged Worker observations no longer increment versions or drive a repeated UI refresh loop.

### Validation status

- This is the `v0.3.0-beta.28` development candidate; branch promotion and signing/release are pending. Existing environments keep their recorded image across app upgrades until explicit rebuild.
- Full local unit suite: 1,285 passed, 20 skipped. The focused suite passed 33 cases without skips: 15 Worker unit, nine real Linux Worker Docker, five host-service Docker and four AI product-gateway cases. Repository/transport passed 22 cases and deterministic admission/recovery passed two cases.
- Node/Web/Worker TypeScript, ESLint, open-source readiness, documentation, license and security gates passed. Three hidden source-Electron cases and all three final unsigned macOS package execution-environment cases passed. The packaged app reported v0.3.0-beta.28 and loaded Worker/license resources from its Resources directory. Actual Windows Linux-container execution, signing and formal publication remain unverified/pending.
- Browser/desktop control, screenshots/model image transport, service previews, executable Skill-package integration, native app connectors and voice are outside this delivery. Image versions and separate operating-system license notices are recorded in [Execution environments](docs/EXECUTION_ENVIRONMENT.md).

## [0.3.0-beta.27] - 2026-10-13

### Added

- Persistent documents and text Skills with SQLite-backed immutable revisions, searchable text, conversation-specific bindings, Markdown editing/preview, import/export, soft deletion and version restoration.
- Contact and Room Library/Skill tabs, existing-resource binding, enable/disable controls and explicit save/discard/continue-editing choices. Revision conflicts preserve the local draft and allow reviewing the latest saved version.
- `/Skill` and grouped `@` selections use real resource/revision IDs and digests. Adding a Skill prepares the current composer; ordinary Send starts its Runtime. Resource selection keeps existing text and remains separate from Bot routing.
- Thirty-eight shared library/document/Skill product operations, including authorized `skills.load` and `skills.readFile`. Imported packages retain `SKILL.md`, auxiliary text, scripts and binary assets in application-owned storage; scripts are not executed and binary reads report metadata only.

### Fixed

- Message identity, Send Journal, group routing and PromptManifest include fixed resource references. Edits create new versions; member retries retain the original version. Revocation, deletion and disablement block later reads without silently broadening private or group access.
- Import prepares and validates all accepted bytes before publishing revisions/bindings; invalid input and cancellation cannot publish a partial library. Export refuses existing targets and preserves original resource bytes for round-trip imports.
- Composer resources follow the session, participate in draft digests and are verified before AI draft updates. Delayed reads and sends preserve concurrent user edits and unrelated chats. Historical references display an unavailable state after authorization is revoked.
- Library IPC channel identifiers are isolated from main-process schemas so the sandboxed Preload does not load host validation dependencies.
- Late resource-opening and save replies preserve a user's newer contact selection or cancelled navigation. The contact header remains contained at 200% zoom in narrow windows.
- Export rollback retains original file handles, preventing Linux inode reuse from deleting another owner's replacement file or directory.

### Validation status

- Linux CI: 1,219 unit tests passed, three skipped. macOS: 121 source smoke tests passed, 33 skipped, and eight packaged library scenarios passed. Windows: 1,214 unit tests passed, eight skipped, 26 source smoke tests and 24 installed-package tests passed. Real cloud inference and permission-dependent Windows symlink cases remain unverified; signing/publication is a separate release gate.
- Target release title and tag are `v0.3.0-beta.27`. Docker execution, browser/computer control, executable Skill scripts, native app connectors and voice are not part of this stage.

## [0.3.0-beta.26] - 2026-10-13

### Added

- Mentioning Everyone starts every group member concurrently. Each Bot keeps its own streaming reply, permissions and results; a slow response, pending approval or individual failure does not block the other members.

### Fixed

- A group finishes only after all parallel members settle, and stopping the reply cancels every active member. Independent replies use the same original-message context; coordinated work with dependencies retains its existing order.
- Runtime storage permits concurrent independent members of the same Everyone batch while retaining exclusive private chats, member executions and other group modes. The index migration preserves existing records.
- Release creation explicitly records the branch derived from the version, including Beta releases, before the Release becomes immutable.

### Verified

- Controlled six-member requests prove concurrent dispatch before any reply is released. Runtime, SQLite and hidden Electron checks cover fast and slow members, approvals, failure isolation, cancellation, reply attribution and ordinary routing protections.

## [0.3.0-beta.25] - 2026-10-13

### Fixed

- Bot and group creation can continue after a clarification reply such as supplying the Bot's role. The latest sentence no longer needs creation keywords; each creation still requires genuine per-call approval before any resource is added.
- Explicit prohibitions and cancellations apply to the requested resource across both legacy and product operation tools. Denying Bot creation does not also prevent a separately requested group, and vice versa.
- Replies reporting rejected or cancelled creation no longer count as successful creation claims. Affirmative claims still require matching successful tool evidence.
- Delayed contact-name autofocus no longer takes focus away from a field the user has selected or a chat they have opened, preventing description text from replacing a Bot's name.

### Verified

- Runtime and SQLite regressions cover clarification replies, approval, denial, cancellation, scoped prohibitions and both creation tool entry points. Hidden Electron acceptance follows the two-message conversation and verifies the actual approval dialog, resource count, sidebar and completed runtime.

## [0.3.0-beta.24] - 2026-10-12

### Added

- Connected AI can discover, describe and execute all 96 existing host operations plus seven semantic operations through a shared product catalogue. Settings, Bot and group management, messages, task results, Memory, routines, workspace and MCP configuration, and updates reuse the same business handlers as the interface.
- Twenty-five scoped view actions support navigation, search, task details, draft management, attachments, avatars and window controls. Draft changes require the current digest and preserve concurrent user input.

### Fixed

- Delegated messages persist their actual AI source, isolate the recipient's private history and Memory, and return real run/batch results. Root resource budgets cover new and legacy tools; cancellation follows descendants even after an intermediate sender finishes.
- Canonical parameters normalize defaults and field order for approvals and replay protection. Atomic resource mutations commit their success receipt in the same transaction; interrupted unknown results cannot be blindly replayed.
- User profile changes preserve omitted avatar/name fields. Approved update installation waits for the source request to finish and all other tasks to become idle.

### Verified

- API, Codex and Claude product workflows were exercised with real configured models in hidden windows and isolated databases. Authentication-specific and platform-specific coverage is documented in `docs/AI_PRODUCT_OPERATIONS.md`.
- Business regressions cover genuine approval, creation rollback, duplicate requests, private data boundaries, delegated replies, cancellation and validation recovery. Existing native tools and scoped MCP approval protections remain in place.

## [0.3.0-beta.23] - 2026-10-12

### Changed

- Replaced the application icon with the approved graphite sculpture on a warm ivory background across window/Dock PNG, macOS ICNS, Windows ICO, documentation and the editable Apple Icon Composer project.
- The Icon Composer project preserves separate foreground and background layers; Windows ICO includes 16–256px representations of the same approved artwork. Asset provenance and derivative checksums now record the new design.

## [0.3.0-beta.22] - 2026-10-11

### Changed

- Bot profiles, model/CLI selection, tool scopes and Memory configuration now live directly in Contacts, with separate Profile, Models and capabilities, and Memory tabs. Chats no longer open a profile inspector or duplicate model settings.
- Global Settings is a full page with six grouped categories and consistent Dark and Daylight theme previews. Existing local folder permissions, projects and archive recovery remain available through Settings rather than a permanent Workspaces navigation item.
- Global update notices appear only for a genuinely downloaded version and show the version, restart action and close control. Routine checks, download progress and errors remain in Settings.

### Fixed

- Contact creation and duplication preserve the current chat's draft, attachments and selection. Unsaved shared connection configuration blocks navigation and duplication until explicitly saved or discarded, and cannot be mislabeled as fully saved when only a Bot's model choice was persisted.
- Opening a Contact's chat validates its runtime snapshot before marking it read; failures stay in Contacts and do not replace an unrelated chat's error or draft.
- Restarting for an update is rejected while any conversation, group batch or active routine is still running, including when the current chat is idle.
- Close-timeout feedback remains visible while Contacts or Settings is open. Contact header controls stay within the narrowest window at 200% zoom.

### Verified

- Nineteen isolated real Electron/IPC/SQLite scenarios cover contact configuration, restart persistence, local permissions, archive recovery and genuine write/open failures without changing the installed application or its data.
- All six Settings categories, three Contact tabs and pure Chat views were checked in both themes at 1180, 1020, 620 and the 390-pixel minimum width.
- An authenticated Codex CLI request completed through the selected model. A real background request continued after the install IPC correctly refused to restart; no fake update event or model result was used as acceptance evidence.
- Actual download/restart installation remains subject to signed release artifact validation. This change does not claim new Windows signing support or retest API/Claude model inference.

## [0.3.0-beta.21] - 2026-10-11

### Changed

- Archived group chats now live in one collapsed Workspaces section, not the Chats list or individual project sections. Restore returns a group to Chats without opening it, marking it read, or interrupting the current draft; opening is a separate action.
- Group creation and details distinguish single-Agent automatic replies from coordinator-led collaboration using the selected members' actual model capabilities. Unavailable coordination options no longer promise automatic handoff.

### Fixed

- Conversation file management targets the current chat's granted folder instead of a previously managed project's folder. Unbound chats link to the existing workspace settings; legacy multiple-folder grants require an explicit target.
- Successful task retries no longer retain the earlier attempt's active failure card or global error. Historical attempts remain inspectable, and recovery does not clear unrelated settings or task errors.
- Partial archive recovery retains stage-specific retry and open feedback, including when no archived items remain, without repeating already successful steps or creating duplicate conversations.
- Negated tool requests and replies such as "do not read files" are no longer mistaken for required or completed file operations. Positive requirements and affirmative execution claims still require genuine tool evidence, including in mixed instructions.
- Automatic response-mode labels remain fully readable at the minimum window width in both Dark and Daylight themes.

### Verified

- Hidden real Electron and isolated SQLite checks cover folder targeting, archive recovery, historical results and connection recovery without touching the installed application or user data.
- Real Codex requests cover read-only failure, granting the correct folder, retrying the same task, file creation and hash-matching readback, plus one automatic reply and two independent Everyone replies.
- Live CLI acceptance is explicitly opt-in; environments without authenticated CLIs or an explicitly supplied genuine history snapshot report those cases as unverified skips rather than substituting simulated model results.

## [0.3.0-beta.20] - 2026-10-10

Version 0.3.0-beta.19 was not published: the release gate rejected personal paths in the QA documentation. This version removes those paths and checks the same gate in CI before promotion.

### Added

- Local personal nickname and avatar editing with centered image cropping, bounded PNG validation and restart persistence.
- Chats, Contacts and Workspaces navigation with recent mixed conversations, global Agent profiles, search and unread filtering.
- Independent persisted chat state, separate remove/clear/delete actions and unread notifications for completed background replies.
- Conversation-specific folder grants and explicit Memory audiences, preserving existing scopes through backed-up migrations without granting new chats access to other projects.
- Optional fixed Room coordinators with Host-owned ordered assignments, verified artifact handover and one tool-free final summary. Explicit mentions and Everyone keep their fixed dispatch semantics; existing content-team approval gates remain in place.

### Changed

- Rebuilt the interface around the approved Dark and Daylight messenger layouts: vertical navigation, dense mixed conversations, stable cartoon-human Bot portraits, message-level collaboration details, separate file cards and a full-width composer.
- Conversation actions now live in the ellipsis menu; response modes sit beside mentions. Settings use grouped pages with an independently scrolling content area and a persistent close toolbar.
- Agents can join groups across projects; file tools, approvals and inherited evidence are checked against the receiving conversation's current authorization.
- Necessary details stay collapsible; ordinary new chats start without folder access and can bind a workspace from chat details.
- Source-based file tasks require successful source reads before report creation. Failed downstream work does not erase successful upstream artifacts or turn a partial group task into a completed task.

### Fixed

- macOS-specific language trimming no longer removes Windows locale packs, preventing installed Windows renderers from crashing when native form controls initialize.
- Details drawers open and close at every window size, and short or zoomed navigation remains scrollable so Settings stays reachable.
- Retrying a failed assigned member resumes its unexecuted dependency chain. Handoff cards distinguish the original delivery from its latest retry using persisted acceptance records.
- Other Agents' messages are model-facing quoted context, not the current Agent's own assistant history; original authorship and transcript records are preserved.
- Named root-level output files, invalid control characters and future-tense coordination plans are validated without treating intentions as completed tool execution.

## [0.3.0-beta.18] - 2026-10-08

### Changed

- Routine tool activity no longer occupies the chat transcript. The existing task-details panel now provides separate artifact and read-only execution-record tabs.
- Necessary approvals use a compact dialog with complete targets, privacy scope and a stop-task action instead of appearing below each reply.
- The public-query dialog offers an explicit "allow and remember" entry to the existing public-read setting. Defaults remain off; only the current approval is resolved, and files, clipboard, MCP and writes retain their original permission boundaries.

### Verified

- Real Claude Code/k3 public search and page fetching continue after one explicit remembered consent; local-file requests still wait for approval and cancellation performs no read.
- Permission and task-record views retain true Tool Journal states and responsive layouts at 1180, 1020, 620 and the 390-pixel minimum window width.

## [0.3.0-beta.17] - 2026-10-07

### Added

- Compatible API-authenticated Claude Code CLIs can use six scoped Aevoren host tools through a per-Runtime authenticated MCP bridge: Workspace list, read, search, create-only write, web search and page fetch. Existing approvals and the Tool Journal remain authoritative; subscription-only OAuth tool mode is not included.
- Bounded, redacted local update diagnostics support troubleshooting without exposing raw errors in the interface.

### Changed

- Long replies display their full Markdown without an extra summary/folding action. Routine connection and generation labels no longer duplicate the existing stop control; errors, approvals and artifacts remain available.
- Explicit research requests require successful search/fetch evidence; requested artifact paths are enforced and requested file readback must match the saved SHA-256.

### Fixed

- Update notice actions are excluded from draggable title-bar regions, share safe action handling with Settings, and prevent duplicate requests or restart after a failed save.
- Native tool refusals, failures and duplicate-write guards return results to the CLI instead of leaving it waiting indefinitely. Repeated MCP request IDs reuse the original result and cannot change arguments or cross Runtime boundaries.
- Page-fetch journal metadata includes the actual source URL and retrieval timestamp for verifiable report provenance.
- Upgraded the MCP SDK to 1.31.0 and source-map-js to 1.2.2 to address GHSA-6qxp-vccf-f47h and GHSA-68fv-2mgg-jv7q. MCP OAuth records retain their issuer binding; older unbound credentials stay encrypted but require explicit reauthorization before use.

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
