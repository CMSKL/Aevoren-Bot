# Troubleshooting

## No model is available

Open **Settings → Models & CLI**. For API, confirm Base URL, encrypted API Key, and model selection. For Claude Code or Codex CLI, run a rescan and confirm the CLI is installed, logged in, and reports at least one model. Use **Test real request** to distinguish installation/login success from an expired login, unavailable model, or exhausted quota.

## The app starts but does not answer

Check the selected Provider, model ID, and latest real-request test. A quota or authentication failure can occur even when a CLI binary is installed. For source evaluation, enable `AEVOREN_BOT_FAKE_PROVIDER=1` and retry with synthetic data. Do not put a real key in `.env` or a command-line argument.

## A Room is busy or interrupted

Only one active Room batch runs per Session. Wait for the current batch, cancel it, or use the exposed retry/continue action when the state allows it. An interrupted run is not silently replayed, because the previous Provider request may already have been accepted.

## MCP or Workspace tools are unavailable

Confirm the server is enabled, the exact read-only tool was reviewed, and the current Bot has scope. Every tool call still requires one-time approval. Workspace tools cannot write files, run shell commands, or access paths outside selected roots.

## The update notice shows an error

The current version remains usable. Retry after checking the network and the official GitHub Release channel. Development and unsigned local packages intentionally have updates disabled. Never install an update from a mirror or an unverified third-party link.

## Reporting a bug

Run `pnpm validate` for a source build, redact secrets and personal paths, and include the version or commit, operating system and architecture, Provider type, smallest reproduction, and safe error code. Use the private process in [SECURITY.md](../SECURITY.md) for security issues.
