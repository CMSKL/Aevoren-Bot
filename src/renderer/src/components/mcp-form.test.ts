import { describe, expect, it } from "vitest";
import { parseMcpSecretLines } from "./mcp-form";

describe("MCP settings form", () => {
  it("parses write-only env and header values while preserving saved blank placeholders", () => {
    expect(parseMcpSecretLines("TOKEN=new\nSAVED=", "stdio", ["SAVED"])).toEqual({
      ok: true,
      values: { TOKEN: "new", SAVED: true },
    });
    expect(parseMcpSecretLines("Authorization: Bearer value\nX-Saved: ", "streamable-http", ["X-Saved"])).toEqual({
      ok: true,
      values: { Authorization: "Bearer value", "X-Saved": true },
    });
  });

  it("rejects malformed, duplicate and never-saved blank values", () => {
    expect(parseMcpSecretLines("TOKEN", "stdio", [])).toMatchObject({ ok: false });
    expect(parseMcpSecretLines("TOKEN=a\nTOKEN=b", "stdio", [])).toMatchObject({ ok: false });
    expect(parseMcpSecretLines("TOKEN=", "stdio", [])).toMatchObject({ ok: false });
  });
});
