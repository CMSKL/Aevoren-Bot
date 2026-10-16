# Scoped MCP tools and Apps

This guide covers the v0.3.0-beta.34 development candidate. Published installers and candidate validation are tracked separately in the [implementation record](IMPLEMENTATION_PLAN.md). Configure a server using the existing **Settings → MCP** form; native Gmail/Drive/Notion setup remains in [Native connections](NATIVE_CONNECTORS.md).

## Grant one conversation and executing Bot

Open the Bot's **Applications** section or select a member in **Group settings → Applications**. Load the configured MCP server's actual tools, review their input schema and grant a specific tool to this conversation and Bot. The grant fixes the server configuration version, credential fingerprint and tool schema digest. Server configuration, a tool's read-only claim and an HTML interface do not grant access.

Changing the server configuration, credentials or tool schema requires a fresh grant. Removing a group member retires its old intents; adding it again does not restore private arguments or results. Existing reviewed read-only MCP tools retain their compatibility path. Tools marked App-only are excluded from model tool lists and direct model preparation; App calls require App visibility and the same explicit permissions.

MCP servers manage their own accounts. Aevoren cannot verify an arbitrary server's external account identity; the approval shows that limitation, the configured server, fixed parameters and the target description. Use native connections when a verified Gmail/Drive/Notion account is required.

## Prepare, approve and query

Enter complete JSON arguments and a concrete target description, then prepare the intent. Preparation validates the current schema and stores an immutable review; it does not invoke the remote tool. Review the complete saved arguments, tool, server version, target and grant before approving.

The interface and AI use the shared `mcp.toolCatalog`, `mcp.toolGrants`, `mcp.grantTool`, `mcp.revokeTool`, `mcp.prepareTool`, `mcp.executeTool`, `mcp.toolResult`, `mcp.listToolIntents`, `mcp.cancelTool`, `mcp.openApp` and `mcp.closeApp` product operations. Host-owned interface actions have real `host-mcp` Runtime records. Private data, callbacks and view transport are not exposed as arbitrary model IPC.

Each dispatch is durably recorded before the SDK call. Confirmed receipts mean **server-reported completion**, not independent proof that another service accepted a write. Cancellation, transport loss, a malformed response or an ambiguous server error after dispatch leaves the intent unknown. Querying an ended intent returns its current receipt; it never repeats the call or requests another write approval. This unit does not provide generic external reconciliation for arbitrary MCP tools.

Six members use independent sessions and Runtime ownership. Revoking or stopping one grant/task leaves sibling tasks running. HTTP writes use captured credentials without SDK authorization refresh/replay. Reauthorization is explicit, rather than automatically repeating a write after a 401.

## Open an isolated App

A completed result can offer **Open MCP App** when its tool declares a same-server `ui://` HTML resource. The interface fetches bounded HTML from that configured server. It loads an outer proxy on a separate host-owned loopback origin and an opaque inner sandbox; the App cannot access the messenger DOM, Preload API or Node.js.

The supported protocol is `2026-01-26`: initialization, saved tool input/result notifications, ping, the bound UI resource read, and `tools/call`. Each App call returns to the scoped business and approval layer. Unsupported RPC methods return explicit errors. Changing authorization closes the corresponding view and rejects stale epochs and cached private metadata reads.

External resource/network domains, camera, microphone, clipboard and arbitrary external navigation are disabled in this delivery. An App requiring those capabilities may not render fully; it is not silently granted them. Host callbacks validate the exact source window, origin, view ID and epoch. Only the active conversation/member owns its approval dialog, including handoff between native and MCP actions.

Protocol `_meta` is retained privately for an authorized App. Public intents, model results and Tool Journal output omit the top-level tool-result `_meta`; ordinary nested user data with that name remains data. AI requests to open an App return `waiting_user`, without a proxy URL capability.

## Evidence and limits

Controlled SDK servers, real local HTTP, real SQLite, real approval/Runtime handling and hidden Electron views verify the implementation. These tests do not establish a real third-party account's permissions or prove a remote service's side effects. Local unsigned packages and signed Releases are separate acceptance gates.

Latest local acceptance passed 12 source scenarios and 28 unique actual packaged scenarios, with the precise beta.34 version and bundled resources checked. Embedded Apps now retain the main renderer's close handshake, and the source/package runs contained no forced-close warnings. The full local unit run recorded 1,560 passes, 45 skips and six existing timing failures; the 106 affected tests passed serial isolation with unchanged assertions and limits. The implementation record preserves these distinct results and the earlier disposed-channel test-cleanup failure. Cross-platform CI and signing remain required.

The transport follows the official [MCP Apps overview](https://modelcontextprotocol.io/extensions/apps/overview) and [2026-01-26 protocol specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx). No additional UI SDK dependency is bundled.
