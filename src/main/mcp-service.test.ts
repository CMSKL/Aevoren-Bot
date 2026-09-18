import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";
import { afterEach, describe, expect, it } from "vitest";
import { AppRepository } from "./database";
import { McpService } from "./mcp-service";
import type { SecretCodec } from "./settings";

const repositories: AppRepository[] = [];
const services: McpService[] = [];
const httpServers: Server[] = [];
const codec: SecretCodec = {
  isAvailable: () => true,
  encrypt: (value) => Buffer.from(value, "utf8").toString("base64"),
  decrypt: (value) => Buffer.from(value, "base64").toString("utf8"),
};

afterEach(async () => {
  while (services.length > 0) await services.pop()?.dispose();
  while (httpServers.length > 0) await new Promise<void>((resolve) => httpServers.pop()?.close(() => resolve()));
  while (repositories.length > 0) repositories.pop()?.close();
});

describe("McpService", () => {
  it("pins an approved loopback Streamable HTTP server and keeps its requests on the configured origin", async () => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    const remote = new McpServer({ name: "remote-fixture", version: "1.0.0" });
    remote.registerTool("lookup", {
      description: "remote fixture lookup",
      inputSchema: { query: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ query }) => ({ content: [{ type: "text", text: `REMOTE:${query}` }] }));
    await remote.connect(transport);
    const httpServer = createServer((request, response) => {
      if (request.url !== "/mcp") {
        response.writeHead(404).end();
        return;
      }
      void transport.handleRequest(request, response);
    });
    httpServers.push(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("fixture did not bind");

    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const service = new McpService(repository, codec, "1.0.0");
    services.push(service);
    const saved = await service.save({
      name: "remote",
      config: { transport: "streamable-http", url: `http://127.0.0.1:${address.port}/mcp`, headers: {} },
    });
    const probed = await service.probe(saved.id);
    expect(probed.lastErrorCode).toBeNull();
    expect(probed.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "lookup", claimedReadOnly: true, readOnly: false })]));
    await remote.close();
  }, 20_000);

  it("completes an explicit OAuth 2.1 PKCE flow, encrypts credentials, and still requires tool review", async () => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    const remote = new McpServer({ name: "oauth-fixture", version: "1.0.0" });
    remote.registerTool("search", {
      description: "OAuth-protected search",
      inputSchema: { query: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false },
    }, async ({ query }) => ({ content: [{ type: "text", text: `SEARCH:${query}` }] }));
    await remote.connect(transport);
    let baseUrl = "";
    let registeredRedirect = "";
    const httpServer = createServer((request, response) => {
      const url = new URL(request.url ?? "/", baseUrl || "http://127.0.0.1");
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp" || url.pathname === "/.well-known/oauth-protected-resource") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ resource: `${baseUrl}/mcp`, authorization_servers: [baseUrl], scopes_supported: ["mcp:tools"] }));
        return;
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          issuer: baseUrl,
          authorization_endpoint: `${baseUrl}/authorize`,
          token_endpoint: `${baseUrl}/token`,
          registration_endpoint: `${baseUrl}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
        }));
        return;
      }
      if (url.pathname === "/register" && request.method === "POST") {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
          const metadata = JSON.parse(body) as Record<string, unknown>;
          registeredRedirect = Array.isArray(metadata.redirect_uris) ? String(metadata.redirect_uris[0] ?? "") : "";
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ ...metadata, client_id: "oauth-client", client_secret: "oauth-client-secret" }));
        });
        return;
      }
      if (url.pathname === "/token" && request.method === "POST") {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
          const params = new URLSearchParams(body);
          if (params.get("code") !== "fixture-code" || !params.get("code_verifier") || params.get("redirect_uri") !== registeredRedirect) {
            response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" }));
            return;
          }
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ access_token: "oauth-access-secret", refresh_token: "oauth-refresh-secret", token_type: "Bearer", expires_in: 3600 }));
        });
        return;
      }
      if (url.pathname === "/mcp") {
        if (request.headers.authorization !== "Bearer oauth-access-secret") {
          response.writeHead(401, {
            "www-authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"`,
          }).end();
          return;
        }
        void transport.handleRequest(request, response);
        return;
      }
      response.writeHead(404).end();
    });
    httpServers.push(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("fixture did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;

    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    let openAuthorization!: (url: string) => void;
    const authorizationUrl = new Promise<string>((resolve) => { openAuthorization = resolve; });
    const service = new McpService(repository, codec, "1.0.0", async (url) => openAuthorization(url));
    services.push(service);
    const saved = await service.save({
      name: "oauth",
      config: { transport: "streamable-http", url: `${baseUrl}/mcp`, headers: { Authorization: "static-mcp-secret" } },
    });
    const authorizing = service.authorize(saved.id);
    const opened = new URL(await authorizationUrl);
    expect(service.list().find((server) => server.id === saved.id)).toMatchObject({ authenticating: true, oauthConfigured: false });
    await expect(service.probe(saved.id)).rejects.toMatchObject({ code: "MCP_AUTH_IN_PROGRESS" });
    expect(opened.origin).toBe(baseUrl);
    expect(opened.pathname).toBe("/authorize");
    expect(opened.searchParams.get("code_challenge_method")).toBe("S256");
    expect(opened.searchParams.get("state")).toBeTruthy();
    const callback = new URL(opened.searchParams.get("redirect_uri")!);
    callback.search = new URLSearchParams({
      code: "fixture-code",
      state: opened.searchParams.get("state")!,
    }).toString();
    await expect(fetch(callback)).resolves.toMatchObject({ status: 200 });
    const authorized = await authorizing;
    expect(authorized).toMatchObject({ status: "disabled", oauthConfigured: true, authenticating: false });
    expect(authorized.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "search", claimedReadOnly: true, readOnly: false }),
    ]));
    const encrypted = repository.getSetting(`mcp.server.${saved.id}.oauth`);
    expect(encrypted).toMatchObject({ encrypted: true });
    expect(encrypted?.value).not.toContain("oauth-access-secret");
    expect(encrypted?.value).not.toContain("oauth-client-secret");
    expect(JSON.stringify(authorized)).not.toContain("oauth-access-secret");
    expect(repository.getSetting(`mcp.server.${saved.id}.secrets`)?.value).not.toContain("static-mcp-secret");
    const cleared = await service.clearAuthorization(saved.id, authorized.version);
    expect(cleared).toMatchObject({ enabled: false, status: "disabled", oauthConfigured: false });
    expect(repository.getSetting(`mcp.server.${saved.id}.oauth`)).toBeNull();
    await remote.close();
  }, 20_000);

  it("blocks remote MCP targets that resolve directly to private network addresses", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const service = new McpService(repository, codec, "1.0.0");
    services.push(service);
    const saved = await service.save({
      name: "private-target",
      config: { transport: "streamable-http", url: "https://127.0.0.2/mcp", headers: {} },
    });
    const probed = await service.probe(saved.id);
    expect(probed).toMatchObject({ status: "disabled", lastErrorCode: "MCP_SERVER_UNAVAILABLE", tools: [] });
  });

  it("keeps a new stdio server inert, probes safely, exposes only read-only tools, and never returns secret values", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    let bot = repository.createBot().bot;
    const service = new McpService(repository, codec, "1.0.0");
    services.push(service);
    const fixture = join(process.cwd(), "tests/fixtures/fake-mcp-server.mjs");

    const saved = await service.save({
      name: "fixture",
      config: {
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
        env: { MCP_FIXTURE_TOKEN: "fixture-secret-value" },
      },
    });
    expect(saved).toMatchObject({
      name: "fixture",
      transport: "stdio",
      enabled: false,
      status: "disabled",
      secretKeys: ["MCP_FIXTURE_TOKEN"],
      tools: [],
    });
    expect(JSON.stringify(saved)).not.toContain("fixture-secret-value");
    const storedSecret = repository.getSetting(`mcp.server.${saved.id}.secrets`);
    expect(storedSecret).toMatchObject({ encrypted: true });
    expect(storedSecret?.value).not.toContain("fixture-secret-value");

    const probed = await service.probe(saved.id);
    expect(probed.status).toBe("disabled");
    expect(probed.tools.map((tool) => ({ name: tool.name, claimedReadOnly: tool.claimedReadOnly, readOnly: tool.readOnly }))).toEqual([
      { name: "lookup", claimedReadOnly: true, readOnly: false },
      { name: "mutate", claimedReadOnly: false, readOnly: false },
    ]);

    const reviewed = await service.save({
      id: saved.id,
      expectedVersion: probed.version,
      name: "fixture",
      trustedReadOnlyTools: ["lookup"],
      config: {
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
        env: { MCP_FIXTURE_TOKEN: true },
      },
    });
    expect(reviewed.trustedReadOnlyTools).toEqual(["lookup"]);
    const reviewedProbe = await service.probe(saved.id);
    expect(reviewedProbe.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "lookup", claimedReadOnly: true, readOnly: true }),
    ]));
    const enabled = await service.setEnabled(saved.id, reviewedProbe.version, true);
    expect(enabled).toMatchObject({ enabled: true, status: "available" });
    expect(service.availableTools().map((tool) => tool.namespacedName)).toEqual(["mcp__fixture__lookup"]);
    bot = repository.updateBot(bot.id, bot.version, { mcpServerIds: [] });
    expect(service.availableTools(bot.id)).toEqual([]);
    bot = repository.updateBot(bot.id, bot.version, { mcpServerIds: [saved.id] });
    expect(service.availableTools(bot.id).map((tool) => tool.namespacedName)).toEqual(["mcp__fixture__lookup"]);
    const result = await service.run({
      kind: "mcp-call",
      serverId: saved.id,
      toolName: "lookup",
      arguments: { query: "hello" },
      readOnly: true,
    }, new AbortController().signal);
    expect(JSON.parse(result.content)).toMatchObject({
      untrusted: true,
      server: "fixture",
      tool: "lookup",
      content: [{ type: "text", text: "MCP_FIXTURE_RESULT:hello:authenticated" }],
      structuredContent: { query: "hello", source: "fixture" },
    });
    await expect(service.run({
      kind: "mcp-call",
      serverId: saved.id,
      toolName: "mutate",
      arguments: { value: "blocked" },
      readOnly: true,
    }, new AbortController().signal)).rejects.toMatchObject({ code: "MCP_TOOL_NOT_READONLY" });

    await service.delete(saved.id, enabled.version);
    expect(service.list()).toEqual([]);
  }, 20_000);

  it("does not trust a third-party readOnlyHint until the exact tool name is reviewed", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const service = new McpService(repository, codec, "1.0.0");
    services.push(service);
    const fixture = join(process.cwd(), "tests/fixtures/fake-mcp-server.mjs");
    const saved = await service.save({
      name: "unreviewed",
      config: { transport: "stdio", command: process.execPath, args: [fixture], env: {} },
    });
    const probed = await service.probe(saved.id);
    expect(probed.trustedReadOnlyTools).toEqual([]);
    expect(probed.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "lookup", claimedReadOnly: true, readOnly: false }),
    ]));
    const enabled = await service.setEnabled(saved.id, probed.version, true);
    expect(enabled.status).toBe("available");
    expect(service.availableTools()).toEqual([]);
    await expect(service.run({
      kind: "mcp-call",
      serverId: saved.id,
      toolName: "lookup",
      arguments: { query: "blocked" },
      readOnly: true,
    }, new AbortController().signal)).rejects.toMatchObject({ code: "MCP_TOOL_NOT_READONLY" });
  }, 20_000);

  it.skipIf(process.env.AEVOREN_BOT_REAL_MCP !== "1")(
    "reaches the official Exa MCP preset and reports either its public catalog or an OAuth requirement",
    async () => {
      const repository = new AppRepository(":memory:");
      repositories.push(repository);
      const service = new McpService(repository, codec, "1.0.0");
      services.push(service);
      const saved = await service.save({
        name: "exa-search",
        config: { transport: "streamable-http", url: "https://mcp.exa.ai/mcp", headers: {} },
      });
      const probed = await service.probe(saved.id);
      expect(
        probed.tools.some((tool) => tool.name === "web_search_exa" && tool.claimedReadOnly) ||
        probed.lastErrorCode === "MCP_AUTH_REQUIRED",
      ).toBe(true);
      expect(probed.tools.every((tool) => !tool.readOnly)).toBe(true);
    },
    30_000,
  );
});
