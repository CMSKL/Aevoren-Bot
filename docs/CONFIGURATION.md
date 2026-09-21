# Configuration

## Model sources

Aevoren Bot's first-phase model scope contains exactly three sources:

- an OpenAI-compatible API configured in the app;
- Claude Code;
- Codex CLI.

Open **Settings → Models & CLI** to configure API, rescan installed CLIs, inspect login status, run a minimal real request, and choose a model. On Windows, CLI discovery also checks npm/pnpm, Volta, Scoop, Chocolatey, Program Files, and the current user's CLI directories; `.cmd`/`.bat` wrappers are launched through the Windows shell only after the executable path has been resolved.

API keys entered in the application are encrypted by Electron `safeStorage`. Saved secret values are never returned to the Renderer. Do not put production keys in `.env`, command-line arguments, screenshots, Issues, or test fixtures.

Other Provider or CLI adapters are intentionally not exposed in this release line. They can enter a later phase only after discovery, authentication, model selection, real invocation, and error handling have independent acceptance coverage.

## Jev Shadow Mode

Jev is an optional Main-process decision layer. It is currently limited to Shadow Mode for Room routing, tool risk, Handoff, and result-quality observations; it does not replace the chat Provider, execute tools, or change the final route.

Enable it only in an isolated development process:

```text
AEVOREN_DECISION_SHADOW=1
AEVOREN_JEV_API_KEY=<process-environment-only>
AEVOREN_JEV_MODEL=jev-1.13.0
```

When disabled (the default), no Jev request is made and no decision journal is created. The key is read only by Electron Main, and must not be committed to `.env`, logs, screenshots, Issues, or test fixtures. Shadow records store bounded, redacted metadata and result digests rather than complete private file or clipboard contents.

## MCP Servers

Open **Settings → MCP** to add a local stdio or remote Streamable HTTP Server.

- New Servers are disabled by default.
- On Windows, keep MCP stdio commands as a real executable (for example `node.exe`) or explicitly configure `cmd.exe` with its arguments; MCP commands are intentionally launched without an implicit shell.
- Remote Servers may use OAuth 2.1/PKCE or write-only Header configuration.
- A Server's `readOnlyHint` is treated only as a claim.
- You must review and trust exact read-only tool names before they become available.
- Every actual tool call still requires one-time approval.
- Write and unreviewed tools are blocked.

The **Add Web Search** preset creates a disabled Exa Search MCP configuration. Authorization and tool review remain explicit user steps. Exa is a third-party service with its own terms, privacy policy, availability, and account requirements.

## Workspace access

Workspace access is opt-in and read-only. Aevoren Bot can list, search, and read bounded UTF-8 files only under roots selected by the user. It does not gain write, delete, shell, or unrestricted filesystem access.

## Message attachments

The composer can attach up to six bounded text, code, CSV, JSON, YAML, or Markdown files. Main reads the selected files and stores only validated content and metadata linked to the message; arbitrary local paths are never exposed to the Renderer or the model. Binary and unsupported files are rejected in the current release line.

## Memory

Long-term Memory can be scoped to the user, one Bot, or an authorized Workspace. After a completed turn, Aevoren may use the selected model to extract up to three durable candidates from the current human message only. Candidates remain pending until the user accepts or edits them in **Settings → Long-term Memory**; rejected, pending, deleted, or expired items never enter a prompt. Manual entries remain immediately active. **Background Memory candidates** can be disabled in the same panel; disabling it prevents the secondary extraction request without changing existing Memory.

## Routines and login item

Routines support one-time, interval, and five-field cron schedules. Enabling a Routine allows the app to remain active after its window is closed. Signed macOS builds can optionally register a login item so enabled Routines resume after login. Windows startup-task integration is intentionally disabled until its packaged ARM/Windows behavior is validated. Development builds never register a system startup item.

Routine execution still follows Provider, tool, approval, network, and account availability limits.

## Development environment variables

The supported development overrides are documented in `.env.example`:

| Variable | Purpose |
| --- | --- |
| `AEVOREN_BOT_USER_DATA_DIR` | Isolate the entire Electron user-data directory |
| `AEVOREN_BOT_DB_PATH` | Override only the SQLite database path |
| `AEVOREN_BOT_FAKE_PROVIDER` | Enable deterministic local Provider fixtures |
| `AEVOREN_BOT_DISABLE_UPDATES` | Emergency switch that disables update checks |

Test-only variables used by automated fixtures are not public runtime configuration and may change without notice.
