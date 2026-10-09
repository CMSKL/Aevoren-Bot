# Configuration

## Model sources

Aevoren Bot's first-phase model scope contains exactly three sources:

- an OpenAI-compatible API configured in the app;
- Claude Code;
- Codex CLI.

Open **Settings → Models & CLI** to configure API, rescan installed CLIs, inspect login status, run a minimal real request, and choose a model. On Windows, CLI discovery also checks npm/pnpm, Volta, Scoop, Chocolatey, Program Files, and the current user's CLI directories; `.cmd`/`.bat` wrappers are launched through the Windows shell only after the executable path has been resolved.

API keys entered in the application are encrypted by Electron `safeStorage`. Saved secret values are never returned to the Renderer. Do not put production keys in `.env`, command-line arguments, screenshots, Issues, or test fixtures.

Other Provider or CLI adapters are intentionally not exposed in this release line. They can enter a later phase only after discovery, authentication, model selection, real invocation, and error handling have independent acceptance coverage.

### Claude Code host tools

Compatible Claude Code CLIs can use these six Aevoren tools: `workspace_list`, `workspace_read`, `workspace_search`, `workspace_write`, `web_search`, and `web_fetch`. Rescan the CLI after upgrading it. This integration reuses the existing CLI API authentication configuration; it does not require entering the same key in Aevoren.

Each Runtime starts its own authenticated localhost MCP endpoint. Claude runs with `--bare`, `--restricted`, no built-in tools, and only that explicit MCP configuration. User/global MCP servers, shell, native file tools, browser control, project creation, Handoff and additional tools are not exposed by this bridge. Existing API and Codex CLI integrations are unchanged.

Only CLIs advertising the required isolation flags **and** having reusable `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` configuration advertise host-tool capability. Subscription-only OAuth/keychain authentication remains on the existing text path: `--bare` does not read it, and a separate isolated OAuth tool mode has not been verified. This is not reported as successful tool support.

Select a folder Workspace and enable create-only writes if the task should save a report. Tool calls go through the same approval, permissions and Tool Journal as API/Codex calls. Approving a local read permits its contents to enter model context and, for a cloud model, leave the computer. Do not approve private credentials. Denial, cancellation and network errors are returned to the model without bypassing approvals.

An explicit live-research request needs successful search and page-fetch records to complete. A requested output path constrains the write; requested readback must match the saved file's SHA-256 and be untruncated. Existing files are never overwritten. Failed or unverified outputs remain distinguishable from successful execution.

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
- OAuth credentials are bound to their authorization server. On upgrade, older credentials without that binding remain encrypted but require explicit reauthorization; they are never guessed from new server metadata or sent to another issuer.
- A Server's `readOnlyHint` is treated only as a claim.
- You must review and trust exact read-only tool names before they become available.
- Every actual tool call still requires one-time approval.
- Write and unreviewed tools are blocked.

The **Add Web Search** preset creates a disabled Exa Search MCP configuration. Authorization and tool review remain explicit user steps. Exa is a third-party service with its own terms, privacy policy, availability, and account requirements.

## Workspace access

File scope belongs to the conversation, not to an Agent's original project. Bind a folder through **chat details → Current chat workspace**. The same Agent can participate in multiple project groups without gaining their combined permissions. New ordinary chats and copies start without folder grants; project-specific creation grants that selected project's folder. Existing chats retain their previous folder snapshot. Changing scope invalidates old approval and handoff authority, even if the chat later switches back to the original folder.

Workspace access is opt-in. By default Aevoren Bot can only list, search, and read bounded UTF-8 files under roots selected by the user. Per Workspace, the user may additionally enable create-only UTF-8 Markdown/CSV artifacts and may persist automatic approval for those bounded Workspace tools. Writes reject traversal, symlink parents, secrets, oversized content, unsupported extensions, existing targets, overwrite, delete, rename, shell, and unrestricted filesystem access. Every attempt remains in the Tool Journal.

**Settings → General → Automatically approve public read-only tools** separately covers only bounded public web search/fetch, weather, and time. It does not authorize Workspace, clipboard, MCP, external writes, or computer control.

The public-query approval dialog can enable that same setting only after the user clicks **Allow public queries and remember**. Defaults remain unchanged. It then resolves only the current approval; it does not sweep or resume already-waiting operations in other tasks. The setting applies to subsequent requests until the user disables it. Tool execution records remain available on demand in the conversation's existing task-details panel.

## Message attachments

The composer can attach up to six bounded text, code, CSV, JSON, YAML, or Markdown files. Main reads the selected files and stores only validated content and metadata linked to the message; arbitrary local paths are never exposed to the Renderer or the model. Binary and unsupported files are rejected in the current release line.

## Memory

Bot-scoped entries also have an explicit conversation audience. Automatic entries are visible only in their source chat; manual Bot entries default to its private chat. Migration preserves existing visibility without sharing entries with new groups or newly added members. Clearing chat history retains accepted Memory and its audience. A correction proposed in one chat does not replace a legacy entry in other chats. User Memory remains explicitly global, while Workspace Memory requires both the Bot's subscription and the current chat's file authorization.

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
