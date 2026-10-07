import { mkdtempSync, readFileSync, statSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { ClaudeToolBridge, CLAUDE_HOST_TOOL_NAMES } from "./claude-tool-bridge";
import type { ModelEvent, ModelRunContext } from "../model";

function context(workspaceId: string): ModelRunContext {
  return { executorBotId: randomUUID(), executionKey: randomUUID(), workspaces: [{ id: workspaceId, name: "公开材料", writeEnabled: true, automationEnabled: false }], networkTools: true, textMeasureTools: true, projectTools: true, deviceTools: true };
}

function configuration(bridge: ClaudeToolBridge): { url: string; headers: Record<string, string> } {
  return JSON.parse(readFileSync(bridge.configPath, "utf8")).mcpServers.aevoren_host;
}

describe("Claude host MCP bridge", () => {
  it("uses real HTTP MCP, exposes exactly the six scoped tools and preserves file evidence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-claude-bridge-"));
    const workspaceId = randomUUID();
    const content = readFileSync(join(process.cwd(), "LICENSE"), "utf8");
    writeFileSync(join(directory, "license.txt"), content);
    const received: ModelEvent[] = [];
    const bridge = new ClaudeToolBridge(context(workspaceId), (event) => {
      received.push(event);
      if (event.type === "workspace-tool" && event.tool.kind === "workspace-read") {
        const text = readFileSync(join(directory, event.tool.path), "utf8");
        void event.respond?.(JSON.stringify({ content: text, sha256: createHash("sha256").update(text).digest("hex") }));
      }
    }, new AbortController().signal);
    const client = new Client({ name: "real-local-protocol-test", version: "1" });
    try {
      await bridge.start(directory);
      const config = configuration(bridge);
      if (process.platform !== "win32") expect(statSync(bridge.configPath).mode & 0o777).toBe(0o600);
      await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(CLAUDE_HOST_TOOL_NAMES);
      const result = await client.callTool({ name: "workspace_read", arguments: { workspaceId, path: "license.txt", maxBytes: 30_000 } });
      expect(result.isError).toBe(false);
      expect(JSON.stringify(result)).toContain("Apache License");
      expect(JSON.stringify(result)).toContain(createHash("sha256").update(content).digest("hex"));
      expect(received).toEqual([expect.objectContaining({ type: "workspace-tool", tool: expect.objectContaining({ workspaceId, path: "license.txt" }), respond: expect.any(Function), toolSignal: expect.any(AbortSignal) })]);
      for (const args of [
        { name: "clipboard_read", arguments: { maxCharacters: 10 } },
        { name: "workspace_read", arguments: { workspaceId: randomUUID(), path: "license.txt" } },
        { name: "workspace_read", arguments: { workspaceId, path: "../outside.txt" } },
        { name: "workspace_read", arguments: { workspaceId, path: ".claude/settings.json" } },
        { name: "workspace_read", arguments: { workspaceId, path: ".env" } },
      ]) expect((await client.callTool(args)).isError).toBe(true);
      expect(received).toHaveLength(1);
    } finally {
      await client.close();
      const configPath = bridge.configPath;
      await bridge.close();
      expect(existsSync(configPath)).toBe(false);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects unauthenticated, cross-origin, wrong-host and oversized requests before dispatch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-claude-bridge-"));
    const received: ModelEvent[] = [];
    const bridge = new ClaudeToolBridge(context(randomUUID()), (event) => received.push(event), new AbortController().signal);
    try {
      await bridge.start(directory);
      const config = configuration(bridge);
      expect((await fetch(config.url, { method: "POST", body: "{}" })).status).toBe(403);
      expect((await fetch(config.url, { method: "POST", headers: { ...config.headers, Origin: "https://untrusted.invalid" }, body: "{}" })).status).toBe(403);
      const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
        const request = httpRequest(config.url, { method: "POST", headers: { ...config.headers, Host: "untrusted.invalid" } }, (response) => { response.resume(); resolve(response.statusCode); });
        request.on("error", reject);
        request.end("{}");
      });
      expect(wrongHost).toBe(403);
      expect((await fetch(config.url, { method: "POST", headers: config.headers, body: "x".repeat(1_048_577) })).status).toBe(413);
      expect(received).toEqual([]);
    } finally {
      await bridge.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("cancels a pending native call and invalidates the Runtime's endpoint", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-claude-bridge-"));
    const controller = new AbortController();
    let received: ModelEvent | null = null;
    const workspaceId = randomUUID();
    const bridge = new ClaudeToolBridge(context(workspaceId), (event) => { received = event; }, controller.signal);
    const client = new Client({ name: "real-cancel-test", version: "1" });
    try {
      await bridge.start(directory);
      const config = configuration(bridge);
      await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
      const pending = client.callTool({ name: "workspace_read", arguments: { workspaceId, path: "license.txt" } });
      await expect.poll(() => received).not.toBeNull();
      controller.abort();
      expect((await pending).isError).toBe(true);
      expect((await fetch(config.url, { method: "POST", headers: config.headers, body: "{}" })).status).toBe(403);
    } finally {
      await client.close();
      await bridge.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps simultaneous native calls independent when responses arrive out of order", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-claude-bridge-"));
    const workspaceId = randomUUID();
    const source = readFileSync(join(process.cwd(), "LICENSE"), "utf8");
    writeFileSync(join(directory, "a.txt"), source.slice(0, 80));
    writeFileSync(join(directory, "b.txt"), source.slice(-80));
    const pending: Array<Extract<ModelEvent, { type: "workspace-tool" }>> = [];
    const bridge = new ClaudeToolBridge(context(workspaceId), (event) => { if (event.type === "workspace-tool") pending.push(event); }, new AbortController().signal);
    const client = new Client({ name: "real-parallel-test", version: "1" });
    try {
      await bridge.start(directory);
      const config = configuration(bridge);
      await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
      const first = client.callTool({ name: "workspace_read", arguments: { workspaceId, path: "a.txt" } });
      const second = client.callTool({ name: "workspace_read", arguments: { workspaceId, path: "b.txt" } });
      await expect.poll(() => pending.length).toBe(2);
      expect(pending[0]?.toolCallId).not.toBe(pending[1]?.toolCallId);
      for (const event of pending.toReversed()) await event.respond?.(readFileSync(join(directory, event.tool.path), "utf8"));
      const firstResult = await first as { content: Array<{ text: string }> };
      const secondResult = await second as { content: Array<{ text: string }> };
      expect(firstResult.content[0]?.text).toBe(source.slice(0, 80));
      expect(secondResult.content[0]?.text).toBe(source.slice(-80));
    } finally {
      await client.close();
      await bridge.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reuses the same request result but rejects changed arguments and another Runtime's token", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-claude-bridge-"));
    const workspaceId = randomUUID();
    const received: ModelEvent[] = [];
    const content = readFileSync(join(process.cwd(), "LICENSE"), "utf8");
    const bridge = new ClaudeToolBridge(context(workspaceId), (event) => {
      received.push(event);
      if (event.type === "workspace-tool") void event.respond?.(content);
    }, new AbortController().signal);
    const other = new ClaudeToolBridge(context(workspaceId), () => {}, new AbortController().signal);
    const client = new Client({ name: "real-request-retry-test", version: "1" });
    try {
      await bridge.start(directory);
      await other.start(directory);
      const config = configuration(bridge);
      const transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
      await client.connect(transport);
      const headers = { ...config.headers, "content-type": "application/json", Accept: "application/json, text/event-stream", "mcp-session-id": transport.sessionId!, "mcp-protocol-version": "2025-11-25" };
      const call = async (path: string) => (await fetch(config.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: "same-request", method: "tools/call", params: { name: "workspace_read", arguments: { workspaceId, path } } }) })).json();
      const first = await call("license.txt");
      expect(await call("license.txt")).toEqual(first);
      expect((await call("different.txt")).result.isError).toBe(true);
      expect(received).toHaveLength(1);
      expect((await fetch(configuration(other).url, { method: "POST", headers: config.headers, body: "{}" })).status).toBe(403);
    } finally {
      await client.close();
      await bridge.close();
      await other.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
