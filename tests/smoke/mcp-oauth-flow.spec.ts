import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import * as z from "zod/v4";
import { AppRepository } from "../../src/main/database";

test("completes explicit MCP OAuth without exposing credentials or auto-trusting tools", async () => {
  test.setTimeout(30_000);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  const remote = new McpServer({ name: "oauth-smoke", version: "1.0.0" });
  remote.registerTool("search", {
    description: "OAuth-protected search fixture",
    inputSchema: { query: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ query }) => ({ content: [{ type: "text", text: `SEARCH:${query}` }] }));
  await remote.connect(transport);
  let baseUrl = "";
  let registeredRedirect = "";
  const server = createServer((request, response) => {
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
        response.end(JSON.stringify({ ...metadata, client_id: "smoke-client", client_secret: "smoke-client-secret" }));
      });
      return;
    }
    if (url.pathname === "/token" && request.method === "POST") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const params = new URLSearchParams(body);
        if (params.get("code") !== "smoke-code" || !params.get("code_verifier") || params.get("redirect_uri") !== registeredRedirect) {
          response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ access_token: "smoke-access-secret", refresh_token: "smoke-refresh-secret", token_type: "Bearer", expires_in: 3600 }));
      });
      return;
    }
    if (url.pathname === "/mcp") {
      if (request.headers.authorization !== "Bearer smoke-access-secret") {
        response.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"` }).end();
        return;
      }
      void transport.handleRequest(request, response);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("OAuth fixture did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-mcp-oauth-e2e-"));
  const databasePath = join(userDataDir, "aevoren-bot.sqlite");
  const repository = new AppRepository(databasePath);
  repository.createMcpServerConfig("oauth-smoke", "streamable-http", {
    url: `${baseUrl}/mcp`, headerKeys: [], trustedReadOnlyTools: [],
  });
  repository.close();
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({
      args: ["."], cwd: process.cwd(),
      env: { ...process.env, AEVOREN_BOT_USER_DATA_DIR: userDataDir, AEVOREN_BOT_FAKE_PROVIDER: "1", AEVOREN_BOT_TEST_HIDDEN: "1" },
    });
    await application.evaluate(({ shell }) => {
      (globalThis as unknown as { __aevorenOAuthUrl: string | null }).__aevorenOAuthUrl = null;
      shell.openExternal = async (url: string): Promise<void> => {
        (globalThis as unknown as { __aevorenOAuthUrl: string | null }).__aevorenOAuthUrl = url;
      };
    });
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "MCP", exact: true }).click();
    const card = page.locator('[data-mcp-server="oauth-smoke"]');
    await card.getByRole("button", { name: "OAuth 授权" }).click();
    await expect(card.getByRole("button", { name: "取消授权" })).toBeVisible();
    await expect.poll(() => application!.evaluate(() => (
      globalThis as unknown as { __aevorenOAuthUrl: string | null }
    ).__aevorenOAuthUrl)).not.toBeNull();
    const opened = await application.evaluate(() => (
      globalThis as unknown as { __aevorenOAuthUrl: string }
    ).__aevorenOAuthUrl);
    const authorization = new URL(opened);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    const callback = new URL(authorization.searchParams.get("redirect_uri")!);
    callback.search = new URLSearchParams({ code: "smoke-code", state: authorization.searchParams.get("state")! }).toString();
    expect((await fetch(callback)).status).toBe(200);
    await expect(card).toContainText("OAuth 已授权");
    await expect(card).toContainText("1 个只读声明待审核");
    await expect(card).toContainText("0 个已信任只读工具");

    page.once("dialog", (dialog) => void dialog.accept());
    await card.getByRole("button", { name: "清除授权" }).click();
    await expect(card).toContainText("OAuth 未授权");
    await application.close();
    application = undefined;

    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM app_settings WHERE key LIKE 'mcp.server.%.oauth'").get()).toEqual({ count: 0 });
    expect(JSON.stringify(database.prepare("SELECT value FROM app_settings").all())).not.toContain("smoke-access-secret");
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  } finally {
    if (application) application.process().kill("SIGKILL");
    await remote.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
