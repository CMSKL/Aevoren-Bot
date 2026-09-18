# User guide

This guide describes the supported pre-release workflow. It assumes macOS 13 or newer on Apple silicon.

## First run

1. Follow [Installation](INSTALLATION.md) and start with the deterministic Fake Provider if you are evaluating the source build.
2. Open **Settings → Models & CLI** and let Aevoren Bot scan installed CLIs.
3. Choose an available authenticated CLI/model, or configure the OpenAI-compatible fallback.
4. Use the left sidebar to create a neutral Bot, then edit its name, label, description, and Instructions in the profile inspector.
5. Send a message from the center composer. Markdown replies render in the conversation view; streaming, cancellation, retry, and interrupted states remain visible.

## Bots and Rooms

- A direct Bot conversation has one MAIN Session and a durable SQLite Transcript.
- A Room contains 2–6 Bots. Select explicit `@Bot` targets or use the automatic owner route.
- A Room preserves speaker identity, source turns, bounded handoffs, cancellation, and recovery in one transcript.
- Use the sidebar context menu for pin, hide, rename, archive, and deletion actions. Destructive actions require confirmation.

## Memory and tools

- Memory is explicit and scoped to the user, a Bot, or an authorized Workspace. Models cannot silently write long-term Memory.
- Workspace access is read-only and limited to roots selected by the user.
- Network and MCP tools are disabled or approval-gated by default. Review exact tools before allowing a call.
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
