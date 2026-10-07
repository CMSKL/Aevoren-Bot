import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AevorenBotError } from "../errors";
import { parseStructuredModelToolCall, structuredModelToolDefinitions, type ModelEvent, type ModelRunContext } from "../model";

export const CLAUDE_HOST_TOOL_NAMES = ["workspace_list", "workspace_read", "workspace_search", "workspace_write", "web_search", "web_fetch"] as const;
const MAX_BODY_BYTES = 1_048_576;
// API tools are budgeted in rounds, which can contain several calls. Native MCP
// must allow a bounded multi-source task, not treat every parallel call as a round.
const MAX_TOOL_CALLS = 64;

function errorResult(code: "INVALID_REQUEST" | "TOOL_EXECUTION_CANCELLED" | "TOOL_ROUND_LIMIT_EXCEEDED" | "TOOL_IDEMPOTENCY_CONFLICT"): CallToolResult {
  const error = new AevorenBotError(code).toAppError();
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, code, safeMessage: error.safeMessage }) }] };
}

function toolResult(content: string): CallToolResult {
  let isError = false;
  try { isError = (JSON.parse(content) as { ok?: unknown }).ok === false; } catch { /* Plain file text is valid. */ }
  return { isError, content: [{ type: "text", text: content }] };
}

/** A per-Runtime transport only: it never reads files or executes tools itself. */
export class ClaudeToolBridge {
  private readonly lifetime = new AbortController();
  private readonly token = randomBytes(32).toString("hex");
  private readonly calls = new Map<string, { signature: string; result: Promise<CallToolResult> }>();
  private readonly pending = new Set<() => void>();
  private readonly server = new Server({ name: "aevoren-host-tools", version: "1.0.0" }, { capabilities: { tools: {} } });
  private readonly transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
  private listener: HttpServer | null = null;
  private directory: string | null = null;
  private host = "";
  private closed = false;
  private scopedContext: ModelRunContext;
  configPath = "";
  readonly toolNames: string[];

  constructor(
    context: ModelRunContext,
    private readonly emit: (event: ModelEvent) => void,
    private readonly parentSignal: AbortSignal,
  ) {
    this.scopedContext = {
      ...context,
      workspaces: context.workspaces?.map((workspace) => ({ ...workspace })),
      supportedToolNames: CLAUDE_HOST_TOOL_NAMES.filter((name) => !context.supportedToolNames || context.supportedToolNames.includes(name)),
    };
    const definitions = structuredModelToolDefinitions(this.scopedContext);
    this.toolNames = definitions.map(({ name }) => `mcp__aevoren_host__${name}`);
    this.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: definitions.map((tool) => ({ ...tool, inputSchema: tool.inputSchema as { type: "object" }, annotations: { readOnlyHint: tool.name !== "workspace_write", destructiveHint: false, openWorldHint: tool.name.startsWith("web_") } })) }));
    this.server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
      if (this.closed || parentSignal.aborted) return errorResult("TOOL_EXECUTION_CANCELLED");
      const key = String(extra.requestId);
      const signature = createHash("sha256").update(JSON.stringify({ name: request.params.name, arguments: request.params.arguments })).digest("hex");
      const previous = this.calls.get(key);
      if (previous) return previous.signature === signature ? previous.result : errorResult("TOOL_IDEMPOTENCY_CONFLICT");
      if (this.calls.size >= MAX_TOOL_CALLS) return errorResult("TOOL_ROUND_LIMIT_EXCEEDED");
      const toolCallId = `claude_${createHash("sha256").update(`${context.executionKey}:${this.token}:${key}`).digest("hex")}`;
      let event: ReturnType<typeof parseStructuredModelToolCall>;
      try {
        event = parseStructuredModelToolCall(toolCallId, request.params.name, request.params.arguments ?? {}, this.scopedContext);
        if (event.type === "workspace-tool" && /(?:^|\/)(?:\.env(?:\.[^/]+)?|\.ssh|\.codex|\.claude)(?:$|\/)/iu.test(event.tool.path.replaceAll("\\", "/"))) {
          return errorResult("INVALID_REQUEST");
        }
      } catch {
        return errorResult("INVALID_REQUEST");
      }
      const toolSignal = AbortSignal.any([parentSignal, this.lifetime.signal, extra.signal]);
      const result = new Promise<CallToolResult>((resolve) => {
        let answered = false;
        const finish = (value: CallToolResult): void => {
          if (answered) return;
          answered = true;
          this.pending.delete(cancel);
          toolSignal.removeEventListener("abort", cancel);
          resolve(value);
        };
        const cancel = (): void => finish(errorResult("TOOL_EXECUTION_CANCELLED"));
        this.pending.add(cancel);
        toolSignal.addEventListener("abort", cancel, { once: true });
        if (toolSignal.aborted) { cancel(); return; }
        this.emit({ ...event, toolSignal, respond: async (content) => finish(toolResult(content)) });
      });
      this.calls.set(key, { signature, result });
      return result;
    });
  }

  async start(cwd: string): Promise<void> {
    if (this.parentSignal.aborted) throw new DOMException("Aborted", "AbortError");
    await this.server.connect(this.transport);
    this.listener = createServer({ maxHeaderSize: 8_192 }, (request, response) => {
      void this.handle(request, response).catch(() => { if (!response.headersSent) response.writeHead(400).end(); else response.end(); });
    });
    const listener = this.listener;
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => { listener.removeListener("error", reject); resolve(); });
    });
    const address = listener.address();
    if (!address || typeof address === "string") throw new AevorenBotError("MODEL_CLI_PROTOCOL_ERROR");
    this.host = `127.0.0.1:${address.port}`;
    this.directory = await mkdtemp(join(cwd, "host-tools-"));
    this.configPath = join(this.directory, "mcp.json");
    await writeFile(this.configPath, JSON.stringify({ mcpServers: { aevoren_host: { type: "http", url: `http://${this.host}/mcp`, headers: { Authorization: `Bearer ${this.token}` } } } }), { mode: 0o600 });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const authorization = Buffer.from(typeof request.headers.authorization === "string" ? request.headers.authorization : "");
    const expected = Buffer.from(`Bearer ${this.token}`);
    if (this.closed || this.parentSignal.aborted || request.url !== "/mcp" || request.headers.host !== this.host || request.headers.origin !== undefined || request.socket.remoteAddress !== "127.0.0.1" || authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
      response.writeHead(403).end(); return;
    }
    if (!["POST", "GET", "DELETE"].includes(request.method ?? "")) { response.writeHead(405).end(); return; }
    let parsedBody: unknown;
    if (request.method === "POST") {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk as Uint8Array);
        size += bytes.length;
        if (size > MAX_BODY_BYTES) { response.writeHead(413).end(); return; }
        chunks.push(bytes);
      }
      try { parsedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { response.writeHead(400).end(); return; }
    }
    await this.transport.handleRequest(request, response, parsedBody);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort();
    for (const cancel of this.pending) cancel();
    await this.server.close().catch(() => undefined);
    const listener = this.listener;
    if (listener?.listening) {
      listener.closeAllConnections();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
    if (this.directory) await rm(this.directory, { recursive: true, force: true }).catch(() => undefined);
    this.calls.clear();
  }
}
