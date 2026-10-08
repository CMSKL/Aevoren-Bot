import { describe, expect, it } from "vitest";
import { isPublicReadTool } from "./tool-automation";

describe("public-read consent scope", () => {
  it("includes only the existing four bounded public-information tools", () => {
    for (const kind of ["web-search", "web-fetch", "weather-current", "time-now"] as const) expect(isPublicReadTool(kind)).toBe(true);
    for (const kind of ["workspace-list", "workspace-read", "workspace-search", "workspace-write", "clipboard-read", "mcp-call", "text-measure", "project-bots", "bot-create", "room-create"] as const) expect(isPublicReadTool(kind)).toBe(false);
  });
});
