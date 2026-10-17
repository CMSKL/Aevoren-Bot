import type { ToolInvocation } from "./contracts";

/** Persisted public-read consent never includes files, clipboard, MCP or writes. */
export function isPublicReadTool(kind: ToolInvocation["toolKind"]): boolean {
  return ["web-search", "web-fetch", "weather-current", "time-now"].includes(kind);
}
