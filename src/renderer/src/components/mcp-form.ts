import type { McpServerInfo } from "@shared/contracts";

export type McpDraft = {
  name: string;
  transport: "stdio" | "streamable-http";
  command: string;
  args: string;
  url: string;
  secrets: string;
  trustedReadOnlyTools: string[];
};

export const EMPTY_MCP_DRAFT: McpDraft = {
  name: "",
  transport: "streamable-http",
  command: "",
  args: "",
  url: "",
  secrets: "",
  trustedReadOnlyTools: [],
};

export function draftForMcpServer(server: McpServerInfo): McpDraft {
  return {
    name: server.name,
    transport: server.transport,
    command: server.command ?? "",
    args: server.args.join("\n"),
    url: server.url ?? "",
    secrets: server.secretKeys.map((key) => server.transport === "stdio" ? `${key}=` : `${key}: `).join("\n"),
    trustedReadOnlyTools: server.trustedReadOnlyTools,
  };
}

export function parseMcpSecretLines(
  value: string,
  transport: McpDraft["transport"],
  savedKeys: readonly string[],
): { ok: true; values: Record<string, string | true> } | { ok: false; error: string } {
  const saved = new Set(savedKeys);
  const values: Record<string, string | true> = {};
  for (const original of value.split(/\r?\n/u)) {
    const line = original.trim();
    if (!line) continue;
    const separator = transport === "stdio" ? line.indexOf("=") : line.indexOf(":");
    if (separator <= 0) return { ok: false, error: transport === "stdio" ? "每行使用 NAME=value。" : "每行使用 Header: value。" };
    const key = line.slice(0, separator).trim();
    const secret = line.slice(separator + 1).trim();
    if (Object.hasOwn(values, key)) return { ok: false, error: `重复的 Secret：${key}` };
    if (!secret && !saved.has(key)) return { ok: false, error: `${key} 尚未保存，必须提供值。` };
    values[key] = secret || true;
  }
  return { ok: true, values };
}
