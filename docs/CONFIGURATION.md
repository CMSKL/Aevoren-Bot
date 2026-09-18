# Configuration

## Model sources

Aevoren Bot scans common installation locations and `PATH` for supported CLIs:

- Codex CLI;
- Claude Code;
- Ollama;
- supported ACP-compatible CLIs.

Open **Settings → Models & CLI** to rescan, inspect login status, and choose a model. OpenAI-compatible HTTP configuration is available as a fallback.

API keys entered in the application are encrypted by Electron `safeStorage`. Saved secret values are never returned to the Renderer. Do not put production keys in `.env`, command-line arguments, screenshots, Issues, or test fixtures.

## MCP Servers

Open **Settings → MCP** to add a local stdio or remote Streamable HTTP Server.

- New Servers are disabled by default.
- Remote Servers may use OAuth 2.1/PKCE or write-only Header configuration.
- A Server's `readOnlyHint` is treated only as a claim.
- You must review and trust exact read-only tool names before they become available.
- Every actual tool call still requires one-time approval.
- Write and unreviewed tools are blocked.

The **Add Web Search** preset creates a disabled Exa Search MCP configuration. Authorization and tool review remain explicit user steps. Exa is a third-party service with its own terms, privacy policy, availability, and account requirements.

## Workspace access

Workspace access is opt-in and read-only. Aevoren Bot can list, search, and read bounded UTF-8 files only under roots selected by the user. It does not gain write, delete, shell, or unrestricted filesystem access.

## Memory

Long-term Memory is explicit and can be scoped to the user, one Bot, or an authorized Workspace. The model cannot silently create or change Memory items.

## Routines and login item

Routines support one-time, interval, and five-field cron schedules. Enabling a Routine allows the app to remain active after its window is closed. Signed macOS builds can optionally register a login item so enabled Routines resume after login.

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
