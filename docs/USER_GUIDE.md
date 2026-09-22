# User guide

This guide describes the supported pre-release workflow. It applies to macOS 13 or newer on Apple silicon and the Windows 10/11 x64 MVP validation build.

## First run

1. Follow [Installation](INSTALLATION.md) and start with the deterministic Fake Provider if you are evaluating the source build.
2. Open **Settings → Models & CLI** and choose API, Claude Code, or Codex CLI.
3. Configure the API or let Aevoren Bot scan the two supported CLIs, then run **Test real request** before selecting a model.
4. Use the left sidebar to create a neutral Bot, then edit its name, label, description, and Instructions in the profile inspector.
5. Send a message from the center composer. You can add up to six bounded text, code, CSV, JSON, YAML, or Markdown attachments; the application reads them in Main and shows their names and sizes in the Transcript. Completed assistant replies can be saved as Markdown through the system save dialog. Markdown replies render in the conversation view; streaming, cancellation, retry, and interrupted states remain visible.

## Content-team workflow UI

- A one-click content team avoids a persistent stage tracker. It shows a compact decision card only while a real Brief is waiting for user input.
- In that card, choose candidate A/B/C, return the Brief for more evidence, or abandon the run without writing orchestration prompts.
- Model text, successful tool execution, saved files, and external reads are shown as separate evidence states. Text alone never produces a successful execution badge.
- The latest failed Room step stays visible above the composer with the failed step, safe reason, preserved evidence, and retry action. Superseded failed attempts collapse after a successful retry.
- Delivery rows distinguish Workspace artifacts from manual Markdown exports and can reveal a validated saved file location.
- The Room composer offers Automatic, Specific Bot, and Everyone routing modes; `@` remains a shortcut for Specific Bot.

## Bots and Rooms

- A direct Bot conversation has one MAIN Session and a durable SQLite Transcript.
- A Room contains 2–6 Bots. Select explicit `@Bot` targets or use the automatic owner route.
- A Room preserves speaker identity, source turns, bounded handoffs, cancellation, and recovery in one transcript. A Bot's ordinary text such as `@OtherBot` is descriptive only; the next Bot starts only after a validated structured Handoff event, which prevents accidental calls and loops.
- Use the sidebar context menu for pin, hide, rename, archive, and deletion actions. Destructive actions require confirmation.

## Memory and tools

- Memory is scoped to the user, a Bot, or an authorized Workspace. Background capture creates reviewable candidates from the current user message; accept, edit, or reject them in **Settings → Long-term Memory**. Only accepted, active, non-expired items enter later prompts. Turn off **Background Memory candidates** there when no secondary extraction request should be made.
- Workspace access is limited to roots selected by the user. Read/list/search are available by default; create-only Markdown/CSV and automatic Workspace approval require separate per-Workspace switches. Existing files are never overwritten or deleted.
- File access permission and Workspace Memory injection are separate controls. Granting file access does not inject a Workspace into long-term model context.
- **New chat → Create content team** atomically creates the research, planning, writing, fact-editing, and analytics Bots plus their Room. The planning-to-writing Handoff is blocked until the current user message explicitly approves a candidate.
- A completed assistant reply exposes **Save as Markdown**. This uses a real system save operation and does not count as a Bot Workspace write.
- Claims that a file/source was read, fetched, verified, or written require a succeeded Tool Journal record in the same Runtime. CSV metrics additionally require a successful read of that CSV; exact length claims require `text_measure`. Unsupported claims fail the Runtime instead of being presented as completed work.
- Network and MCP tools are disabled or approval-gated by default. Review exact tools before allowing a call.
- Built-in web search returns untrusted public-index results with source URLs and retrieval time. Verify consequential or time-sensitive claims against the returned sources.
- Routines support one-time, interval, and five-field cron schedules. They depend on the selected Provider, permissions, and local app availability.

## Updating

Development builds do not check for updates. Signed Beta and Stable builds use the GitHub Release channel declared by their SemVer. A downloaded update is shown with progress and requires an explicit restart or the next normal quit; a failed update keeps the current version usable.

## Safe evaluation

Use a separate user-data directory for migrations, failure injection, or destructive tests:

```bash
AEVOREN_BOT_USER_DATA_DIR=/absolute/path/to/test-data \
AEVOREN_BOT_FAKE_PROVIDER=1 pnpm dev
```

Never paste real API keys, private transcripts, account data, or personal paths into public Issues, screenshots, fixtures, or pull requests. See [Troubleshooting](TROUBLESHOOTING.md) when a normal flow does not work.
