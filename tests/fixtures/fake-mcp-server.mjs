#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const server = new McpServer({ name: "aevoren-fixture", version: "1.0.0" });

server.registerTool("lookup", {
  description: "Return a deterministic read-only fixture result.",
  inputSchema: { query: z.string().max(100) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ query }) => ({
  content: [{ type: "text", text: `MCP_FIXTURE_RESULT:${query}:${process.env.MCP_FIXTURE_TOKEN ? "authenticated" : "anonymous"}` }],
  structuredContent: { query, source: "fixture" },
}));

server.registerTool("mutate", {
  description: "A write tool that Aevoren must not expose during the read-only phase.",
  inputSchema: { value: z.string() },
  annotations: { readOnlyHint: false, destructiveHint: true },
}, async () => ({ content: [{ type: "text", text: "MUTATION_SHOULD_NOT_RUN" }] }));

await server.connect(new StdioServerTransport());
