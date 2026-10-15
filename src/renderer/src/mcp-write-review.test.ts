import { describe, expect, it } from "vitest";
import type { ToolInvocation } from "@shared/contracts";
import type { McpAppView, McpWriteReview } from "@shared/mcp-write-contracts";
import { canonicalMcpArguments, isMcpWrite, mcpReviewMatches, parseMcpArguments, validMcpProxyReady } from "./mcp-write-review";

const invocation = {
  arguments: { kind: "product-call", action: "execute", operation: "mcp.executeTool", input: { id: "intent-a", expectedVersion: 2 } },
} as ToolInvocation;
const snapshot: McpWriteReview = { kind: "mcp-write", intentId: "intent-a", expectedIntentVersion: 2,
  serverId: "server-a", serverName: "Test MCP", serverVersion: 3, transport: "streamable-http",
  accountNotice: "外部账号身份未知", toolName: "page.update", schemaDigest: "a".repeat(64),
  grantId: "grant-a", grantVersion: 4, arguments: { target: "page-a", text: "<script>literal</script>" },
  argumentsDigest: "b".repeat(64), targetPreview: "page-a" };
const view: McpAppView = { sessionId: "private-a", executorBotId: "bot-a", id: "view-a", intentId: "intent-a",
  serverId: "server-a", serverVersion: 3, resourceUri: "ui://test/app", epoch: 7,
  proxyUrl: "http://127.0.0.1:43122/view/view-a/ticket", title: "Test App", permissionsNotice: "隔离运行" };

describe("MCP fixed approval and sandbox provenance", () => {
  it("allows only an executable saved MCP review for the exact intent revision", () => {
    expect(isMcpWrite(invocation)).toBe(true);
    expect(mcpReviewMatches(invocation, { executable: true, snapshot })).toBe(true);
    for (const review of [
      { executable: false, snapshot },
      { executable: true, snapshot: null },
      { executable: true, snapshot: { ...snapshot, kind: "external-draft" } },
      { executable: true, snapshot: { ...snapshot, intentId: "intent-b" } },
      { executable: true, snapshot: { ...snapshot, expectedIntentVersion: 3 } },
    ]) expect(mcpReviewMatches(invocation, review)).toBe(false);
    const legacy = { ...invocation, arguments: { kind: "time-now" } } as ToolInvocation;
    expect(isMcpWrite(legacy)).toBe(false);
    expect(mcpReviewMatches(legacy, { executable: true })).toBe(true);
  });

  it("accepts a ready handshake only from the current outer frame, origin and epoch", () => {
    const frame = {} as Window;
    const event = { source: frame, origin: "http://127.0.0.1:43122", data: { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: { viewId: view.id, epoch: view.epoch } } };
    expect(validMcpProxyReady(event, frame, view)).toBe(true);
    expect(validMcpProxyReady(event, null, view)).toBe(false);
    expect(validMcpProxyReady({ ...event, source: {} as Window }, frame, view)).toBe(false);
    expect(validMcpProxyReady({ ...event, origin: "null" }, frame, view)).toBe(false);
    expect(validMcpProxyReady({ ...event, origin: "http://127.0.0.1:43123" }, frame, view)).toBe(false);
    expect(validMcpProxyReady({ ...event, data: { ...event.data, params: { viewId: "old-view", epoch: view.epoch } } }, frame, view)).toBe(false);
    expect(validMcpProxyReady({ ...event, data: { ...event.data, params: { viewId: view.id, epoch: view.epoch - 1 } } }, frame, view)).toBe(false);
    for (const proxyUrl of ["bad url", "https://example.com/view", "file:///app", "http://localhost:43122/view", `${view.proxyUrl}?ticket=other`])
      expect(validMcpProxyReady(event, frame, { ...view, proxyUrl })).toBe(false);
  });

  it("keeps literal structured arguments and rejects non-object or oversized JSON", () => {
    const args = { target: "page-a", nested: { z: 2, a: ["$(literal);", { value: "<script>literal</script>" }] } };
    expect(parseMcpArguments(JSON.stringify(args))).toEqual({ ok: true, arguments: args });
    expect(canonicalMcpArguments(args)).toBe(canonicalMcpArguments({ nested: { a: ["$(literal);", { value: "<script>literal</script>" }], z: 2 }, target: "page-a" }));
    for (const text of ["null", "[]", "\"value\"", "{bad", JSON.stringify({ text: "汉".repeat(43_000) })])
      expect(parseMcpArguments(text).ok).toBe(false);
  });
});
