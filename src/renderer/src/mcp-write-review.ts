import type { ToolInvocation } from "@shared/contracts";
import type { McpAppView, McpWriteIntent, McpWriteReview } from "@shared/mcp-write-contracts";

export const mcpIntentLabels: Record<McpWriteIntent["state"], string> = {
  prepared: "待批准", dispatching: "正在派发", confirmed: "服务器已返回结果", rejected: "已拒绝", unknown: "结果未知，可能已生效",
};
export function isMcpWrite(invocation: ToolInvocation): boolean {
  return invocation.arguments.kind === "product-call" && invocation.arguments.action === "execute" && invocation.arguments.operation === "mcp.executeTool";
}
export function mcpReviewMatches(invocation: ToolInvocation, review: { executable: boolean; snapshot?: unknown }): boolean {
  if (!isMcpWrite(invocation)) return true;
  if (!review.executable || !review.snapshot || typeof review.snapshot !== "object" || !("kind" in review.snapshot) || review.snapshot.kind !== "mcp-write" || invocation.arguments.kind !== "product-call" || invocation.arguments.action !== "execute") return false;
  const input = invocation.arguments.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const snapshot = review.snapshot as McpWriteReview;
  const fields = input as Record<string, unknown>;
  return snapshot.intentId === fields.id && snapshot.expectedIntentVersion === fields.expectedVersion;
}
export function canonicalMcpArguments(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalMcpArguments).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalMcpArguments((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
export function parseMcpArguments(text: string): { ok: true; arguments: Record<string, unknown> } | { ok: false; message: string } {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, message: "参数须为 JSON 对象。" };
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 128_000) return { ok: false, message: "参数不能超过 128 KB。" };
    return { ok: true, arguments: value as Record<string, unknown> };
  } catch { return { ok: false, message: "请填写有效的 JSON 工具参数。" }; }
}
export function validMcpProxyReady(event: Pick<MessageEvent, "source" | "origin" | "data">, frame: Window | null, view: McpAppView): boolean {
  if (!frame || event.source !== frame || !event.data || typeof event.data !== "object") return false;
  let origin: string;
  try {
    const url = new URL(view.proxyUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.search || url.hash) return false;
    origin = url.origin;
  } catch { return false; }
  if (event.origin !== origin) return false;
  const message = event.data as { jsonrpc?: unknown; method?: unknown; params?: { viewId?: unknown; epoch?: unknown } };
  return message.jsonrpc === "2.0" && message.method === "ui/notifications/sandbox-proxy-ready" && message.params?.viewId === view.id && message.params.epoch === view.epoch;
}
