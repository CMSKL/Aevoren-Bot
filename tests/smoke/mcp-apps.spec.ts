import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { z } from "zod";
import type { AevorenBotApi, ApiResult } from "../../src/shared/contracts";
import type { EnvironmentScope } from "../../src/shared/environment-contracts";
import type { McpWriteApi } from "../../src/shared/mcp-write-contracts";
import { AppRepository } from "../../src/main/database";
import { NATIVE_OUTBOUND_REQUEST_APPROVAL_CHANNEL } from "../../src/shared/native-outbound-channels";
import { openBotList } from "./navigation";
import { closeTestApplication, removeTestDirectory } from "./test-cleanup";

// A real loopback MCP SDK server exercises IPC, durable approval and sandboxing.
// The only write target is an in-memory fixture object, never a user account.
const appHtml = `<!doctype html><meta charset="utf-8"><title>Isolated fixture App</title>
<p id="status">Booting</p><button id="write">Change fixture target</button><button id="unknown">Request unsupported capability</button>
<script>
let next=1; const requests=new Map();
function request(method,params){const id=next++;parent.postMessage({jsonrpc:'2.0',id,method,params},'*');return new Promise(resolve=>requests.set(id,resolve));}
addEventListener('message',async event=>{const value=event.data;if(value?.id&&requests.has(value.id)){requests.get(value.id)(value);requests.delete(value.id);}
 if(value?.method==='ui/notifications/tool-input')document.querySelector('#status').textContent='Input received: '+JSON.stringify(value.params.arguments);
 if(value?.method==='ui/notifications/tool-result')document.body.dataset.result='received';});
let parentBlocked=false;try{void parent.document.body;}catch{parentBlocked=true;}document.body.dataset.parentBlocked=String(parentBlocked);
document.body.dataset.preload=String(typeof window.aevorenBot);
document.querySelector('#write').onclick=async()=>{document.body.dataset.write=JSON.stringify(await request('tools/call',{name:'change',arguments:{target:'app-target',value:'from-app'}}));};
document.querySelector('#unknown').onclick=async event=>{document.body.dataset.unknownHandlerEntered='true';document.body.dataset.unknownTrusted=String(event.isTrusted);
 const response=request('host/read-file',{path:'/etc/passwd'});document.body.dataset.unknownRequestPosted='true';
 const result=await response;document.body.dataset.unknownResponseReceived='true';document.body.dataset.unknown=JSON.stringify(result);};
void request('ui/initialize',{protocolVersion:'2026-01-26',appInfo:{name:'Fixture App',version:'1'},appCapabilities:{}}).then(result=>{document.body.dataset.initialized=String(Boolean(result.result));parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}},'*');});
</script>`;

function data<T>(value: ApiResult<T>): T { if (!value.ok) throw new Error(`${value.error.code}: ${value.error.safeMessage}`); return value.data; }
async function mcpCall<T>(page: Page, method: keyof McpWriteApi, input: unknown): Promise<T> {
  return data(await page.evaluate(async ({ method, input }) => {
    const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.mcpWrites;
    return (api[method] as (input: unknown) => Promise<ApiResult<T>>)(input);
  }, { method, input }));
}

async function withMcp(callback: (fixture: { page: Page; application: ElectronApplication; scope: EnvironmentScope; groupScope: EnvironmentScope;
  serverId: string; writes: () => number; nativeWrites: () => number; releaseWrite: () => void; holdWrites: () => void }) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "aevoren-mcp-apps-"));
  const repository = new AppRepository(join(directory, "aevoren-bot.sqlite"));
  const created = repository.createBot();
  const bot = repository.updateBot(created.bot.id, created.bot.version, { name: "MCP 隔离验收" });
  const sibling = repository.createBot();
  const room = repository.createRoom({ name: "MCP 群范围验收", memberBotIds: [bot.id, sibling.bot.id], leadBotId: null });
  repository.close();
  let writes = 0, nativeWrites = 0, hold = false, release: (() => void) | undefined;
  const remotes: McpServer[] = [], transports = new Map<string, StreamableHTTPServerTransport>();
  const server = createServer((request, response) => {
    if (request.headers["x-aevoren-native-host"] === "api.notion.com") {
      if (request.headers.authorization !== "Bearer handoff-fixture-token") { response.writeHead(401).end(); return; }
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/users/me") response.end(JSON.stringify({ type: "bot", id: "22222222-2222-4222-8222-222222222222", name: "fixture", bot: { workspace_name: "Handoff fixture account" } }));
      else if (request.url === "/v1/pages" && request.method === "POST") {
        const chunks: Buffer[] = []; request.on("data", chunk => chunks.push(Buffer.from(chunk)));
        request.on("end", () => { JSON.parse(Buffer.concat(chunks).toString()); nativeWrites += 1; response.end(JSON.stringify({ id: "33333333-3333-4333-8333-333333333333", object: "page" })); });
      } else response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      const sessionId = request.headers["mcp-session-id"];
      const transport = typeof sessionId === "string" ? transports.get(sessionId) : undefined;
      if (transport) { void transport.handleRequest(request, response, body); return; }
      if (request.method !== "POST" || body?.method !== "initialize") { response.writeHead(404).end(); return; }
      const remote = new McpServer({ name: "mcp-ui-fixture", version: "1" }); remotes.push(remote);
      remote.registerTool("change", { description: "Change only an in-memory fixture target", inputSchema: { target: z.string(), value: z.string() }, annotations: { readOnlyHint: false },
        _meta: { ui: { resourceUri: "ui://fixture/editor", visibility: ["model", "app"] } } }, async args => {
        writes += 1;
        if (hold) await new Promise<void>(resolve => { release = resolve; });
        return { content: [{ type: "text" as const, text: JSON.stringify(args) }] };
      });
      remote.registerResource("editor", "ui://fixture/editor", { mimeType: "text/html;profile=mcp-app" }, async () => ({ contents: [{ uri: "ui://fixture/editor", mimeType: "text/html;profile=mcp-app", text: appHtml }] }));
      const createdTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: id => { transports.set(id, createdTransport); } });
      void remote.connect(createdTransport).then(() => createdTransport.handleRequest(request, response, body));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing MCP loopback port");
  const executablePath = process.env.AEVOREN_PACKAGED_APP_PATH;
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith("AEVOREN_BOT_")));
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : ["."], cwd: process.cwd(), env: {
      ...environment, AEVOREN_BOT_USER_DATA_DIR: directory, AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_DISABLE_UPDATES: "1", AEVOREN_BOT_FAKE_PROVIDER: "1", AEVOREN_BOT_NATIVE_TEST_ORIGIN: `http://127.0.0.1:${address.port}`,
    } });
    if (executablePath) {
      const runtime = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion(), resourcesPath: process.resourcesPath }));
      expect(runtime.packaged).toBe(true);
      expect(runtime.version).toBe(JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version);
      const guide = join(runtime.resourcesPath, "docs", "MCP_APPS.md");
      expect(existsSync(guide)).toBe(true);
      expect(readFileSync(guide, "utf8")).toContain("Scoped MCP tools and Apps");
    }
    const page = await application.firstWindow(), errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await expect(page.locator(".app-shell")).toBeVisible();
    const configured = await page.evaluate(async url => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const saved = await api.mcp.save({ name: "isolated-mcp-fixture", config: { transport: "streamable-http", url, headers: { Authorization: "Bearer CONTROLLED_FIXTURE_SECRET" } } });
      if (!saved.ok) throw new Error(saved.error.code);
      const enabled = await api.mcp.setEnabled({ id: saved.data.id, expectedVersion: saved.data.version, enabled: true });
      if (!enabled.ok) throw new Error(enabled.error.code);
      return enabled.data;
    }, `http://127.0.0.1:${address.port}/mcp`);
    await callback({ page, application, scope: { sessionId: created.session.id, executorBotId: bot.id }, groupScope: { sessionId: room.session.id, executorBotId: bot.id },
      serverId: configured.id, writes: () => writes, nativeWrites: () => nativeWrites, releaseWrite: () => { release?.(); release = undefined; hold = false; }, holdWrites: () => { hold = true; } });
    expect(errors).toEqual([]);
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible()))).toBe(false);
  } finally {
    release?.();
    if (application) await closeTestApplication(application);
    await Promise.allSettled(remotes.map(remote => remote.close()));
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    removeTestDirectory(directory);
  }
}

async function openMcp(page: Page): Promise<void> {
  await openBotList(page);
  await page.getByRole("tab", { name: "联系人", exact: true }).click();
  await page.locator(".sidebar").getByRole("listitem", { name: "MCP 隔离验收", exact: true }).click();
  await page.getByRole("main", { name: "联系人资料", exact: true }).getByRole("tab", { name: "应用", exact: true }).click();
  await expect(page.getByRole("region", { name: "聊天 MCP 工具", exact: true })).toBeVisible();
}

test("MCP fixed operation uses a real approval and an opaque App sandbox with scoped RPC", async () => {
  test.setTimeout(90_000);
  await withMcp(async f => {
    await openMcp(f.page);
    await f.page.getByLabel("当前聊天的 MCP 服务器", { exact: true }).selectOption(f.serverId);
    await f.page.getByLabel("当前 MCP 工具", { exact: true }).selectOption("change");
    await f.page.getByRole("button", { name: "授权当前成员使用此工具", exact: true }).click();
    await f.page.getByRole("button", { name: "确认 MCP 工具授权", exact: true }).click();
    await f.page.getByLabel("MCP 工具参数 JSON", { exact: true }).fill(JSON.stringify({ target: "fixed-target", value: "<script>literal</script>" }));
    await f.page.getByLabel("MCP 写入目标说明", { exact: true }).fill("固定目标 fixed-target");
    await f.page.getByRole("button", { name: "准备固定 MCP 操作", exact: true }).click();
    expect(f.writes()).toBe(0);
    expect(await mcpCall(f.page, "toolGrants", f.groupScope)).toEqual([]);
    await f.page.getByRole("button", { name: "审阅并批准固定 MCP 操作", exact: true }).click();
    const approval = f.page.getByTestId("tool-permission-dialog");
    await expect(approval).toHaveCount(1);
    await expect(approval.getByLabel("本次 MCP 固定参数")).toContainText("<script>literal</script>");
    await expect(approval).toContainText("固定目标 fixed-target");
    await expect(approval).toContainText("未提供可验证的账号身份");
    expect(f.writes()).toBe(0);
    await approval.getByRole("button", { name: "仅允许一次", exact: true }).click();
    await expect.poll(f.writes).toBe(1);
    await expect(f.page.getByText("服务器已返回结果", { exact: true })).toBeVisible();
    await f.page.getByRole("button", { name: "打开此结果的交互 App", exact: true }).click();
    const outer = f.page.frameLocator('iframe[title^="MCP App："]');
    const inner = outer.frameLocator("iframe");
    await expect(inner.locator("body")).toHaveAttribute("data-initialized", "true");
    await expect(inner.locator("body")).toHaveAttribute("data-parent-blocked", "true");
    await expect(inner.locator("body")).toHaveAttribute("data-preload", "undefined");
    await expect(inner.locator("#status")).toContainText("fixed-target");
    await expect(inner.locator("body")).toHaveAttribute("data-result", "received");
    const proxyUrl = await f.page.locator('iframe[title^="MCP App："]').getAttribute("src");
    if (!proxyUrl) throw new Error("Missing controlled App proxy");
    const phases: { httpResponseReceived: boolean; httpStatus: number | null; responseIdMatches: boolean; errorCode: number | null } = {
      httpResponseReceived: false, httpStatus: null, responseIdMatches: false, errorCode: null,
    };
    const unsupportedResponse = f.page.waitForResponse(response => {
      const request = response.request();
      if (request.method() !== "POST" || response.url() !== `${proxyUrl}/rpc`) return false;
      try { return request.postDataJSON()?.method === "host/read-file"; } catch { return false; }
    });
    try {
      const [response] = await Promise.all([
        unsupportedResponse,
        inner.getByRole("button", { name: "Request unsupported capability", exact: true }).click(),
      ]);
      phases.httpResponseReceived = true;
      phases.httpStatus = response.status();
      expect(phases.httpStatus).toBe(200);
      let result: { jsonrpc?: unknown; id?: unknown; error?: { code?: unknown } } | null;
      try { result = await response.json(); } catch { throw new Error("Controlled App RPC response was not JSON"); }
      const requestId = response.request().postDataJSON()?.id;
      phases.responseIdMatches = Number.isSafeInteger(requestId) && result?.id === requestId;
      const errorCode = result?.error?.code;
      phases.errorCode = typeof errorCode === "number" && Number.isSafeInteger(errorCode) ? errorCode : null;
      expect(result?.jsonrpc === "2.0").toBe(true);
      expect(phases.responseIdMatches).toBe(true);
      expect(phases.errorCode).toBe(-32601);
      await expect(inner.locator("body")).toHaveAttribute("data-unknown", /-32601/u);
    } finally {
      const fixture = await inner.locator("body").evaluate(body => ({
        handlerEntered: body.dataset.unknownHandlerEntered === "true",
        isTrusted: body.dataset.unknownTrusted === "true" ? true : body.dataset.unknownTrusted === "false" ? false : null,
        requestPosted: body.dataset.unknownRequestPosted === "true",
        responseReceived: body.dataset.unknownResponseReceived === "true",
      }), undefined, { timeout: 1_000 }).catch(() => null);
      await test.info().attach("mcp-unsupported-rpc-phases", {
        body: JSON.stringify({ ...phases, fixture }), contentType: "application/json",
      });
    }
    expect(f.writes()).toBe(1);
    await inner.getByRole("button", { name: "Change fixture target", exact: true }).click();
    await expect(approval).toHaveCount(1);
    await expect(approval.getByLabel("本次 MCP 固定参数")).toContainText("app-target");
    expect(f.writes()).toBe(1);
    await approval.getByRole("button", { name: "仅允许一次", exact: true }).click();
    await expect.poll(f.writes).toBe(2);
    await f.page.getByRole("button", { name: "撤销成员 MCP 工具授权", exact: true }).click();
    await f.page.getByRole("button", { name: "确认 MCP 工具授权", exact: true }).click();
    await expect(f.page.locator('iframe[title^="MCP App："]')).toHaveCount(0);
    expect(f.writes()).toBe(2);
  });
});

test("a cancelled dispatched MCP request stays unknown and has no resend control", async () => {
  test.setTimeout(90_000);
  await withMcp(async f => {
    await openMcp(f.page);
    await f.page.getByLabel("当前聊天的 MCP 服务器", { exact: true }).selectOption(f.serverId);
    await f.page.getByLabel("当前 MCP 工具", { exact: true }).selectOption("change");
    await f.page.getByRole("button", { name: "授权当前成员使用此工具", exact: true }).click();
    await f.page.getByRole("button", { name: "确认 MCP 工具授权", exact: true }).click();
    await f.page.getByLabel("MCP 工具参数 JSON", { exact: true }).fill('{"target":"held-target","value":"once"}');
    await f.page.getByLabel("MCP 写入目标说明", { exact: true }).fill("held-target");
    await f.page.getByRole("button", { name: "准备固定 MCP 操作", exact: true }).click();
    f.holdWrites();
    await f.page.getByRole("button", { name: "审阅并批准固定 MCP 操作", exact: true }).click();
    await f.page.getByTestId("tool-permission-dialog").getByRole("button", { name: "仅允许一次", exact: true }).click();
    await expect.poll(f.writes).toBe(1);
    await f.page.getByRole("button", { name: "停止此 MCP 操作", exact: true }).click();
    await expect(f.page.getByText("结果未知，可能已生效", { exact: true })).toBeVisible();
    f.releaseWrite();
    await f.page.getByRole("button", { name: "刷新 MCP 操作记录", exact: true }).click();
    await expect(f.page.getByRole("button", { name: "准备固定 MCP 操作", exact: true })).toBeDisabled();
    await expect(f.page.getByRole("button", { name: /重试|重发/u })).toHaveCount(0);
    expect(f.writes()).toBe(1);
  });
});

test("Apps keeps one portal when a delayed native form response follows the next MCP approval", async () => {
  test.setTimeout(90_000);
  await withMcp(async f => {
    const connection = await f.page.evaluate(async scope => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const configured = await api.connectors.configure({ provider: "notion", name: "Handoff fixture", token: "handoff-fixture-token" });
      if (!configured.ok) throw new Error(configured.error.code);
      const authorized = await api.connectors.authorize({ id: configured.data.id, expectedVersion: configured.data.version });
      if (!authorized.ok) throw new Error(authorized.error.code);
      const binding = await api.connectors.bind({ ...scope, connectionId: authorized.data.id, expectedAuthVersion: authorized.data.authVersion });
      if (!binding.ok) throw new Error(binding.error.code);
      return authorized.data;
    }, f.scope);
    await openMcp(f.page);
    await f.page.getByLabel("当前聊天的应用连接", { exact: true }).selectOption(connection.id);
    await f.page.getByRole("button", { name: "新建本地草稿", exact: true }).click();
    await f.page.getByLabel("Notion 草稿父页面", { exact: true }).fill("11111111-1111-4111-8111-111111111111");
    await f.page.getByLabel("文件草稿标题", { exact: true }).fill("NATIVE_HANDOFF_FIXED");
    await f.page.getByLabel("文件草稿正文", { exact: true }).fill("Only the controlled loopback fixture is written.");
    await f.page.getByRole("button", { name: "保存本地草稿", exact: true }).click();
    await f.page.getByRole("button", { name: "授权当前成员写入此目标", exact: true }).click();
    await f.page.getByRole("button", { name: "确认成员写授权", exact: true }).click();
    await f.page.getByRole("button", { name: "准备此保存版本外发", exact: true }).click();

    // Hold the real handler's response after it created the real approval. The
    // native form stays pending while the shared host can resolve that approval.
    await f.application.evaluate(({ ipcMain }, channel) => {
      const globals = globalThis as { mcpHandoff?: { entered: boolean; release?: () => void } };
      const original = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers.get(channel);
      if (!original) throw new Error("Missing native approval IPC handler");
      globals.mcpHandoff = { entered: false };
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (...args: unknown[]) => {
        const result = await original(...args);
        if (globals.mcpHandoff!.entered) return result;
        globals.mcpHandoff!.entered = true;
        await new Promise<void>(resolve => { globals.mcpHandoff!.release = resolve; });
        return result;
      });
    }, NATIVE_OUTBOUND_REQUEST_APPROVAL_CHANNEL);
    try {
      await f.page.getByRole("button", { name: "审阅并批准此版本", exact: true }).click();
      const dialog = f.page.getByTestId("tool-permission-dialog");
      await expect(dialog).toHaveCount(1);
      await expect(dialog).toContainText("NATIVE_HANDOFF_FIXED");
      await dialog.getByRole("button", { name: "仅允许一次", exact: true }).click();
      await expect.poll(f.nativeWrites).toBe(1);
      await expect.poll(async () => data(await f.page.evaluate(async sessionId => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.runtime.getSessionSnapshot(sessionId), f.scope.sessionId)).runs.every(run => run.state === "completed")).toBe(true);
      await expect(dialog).toHaveCount(0);
      await f.page.getByLabel("当前聊天的 MCP 服务器", { exact: true }).selectOption(f.serverId);
      await f.page.getByLabel("当前 MCP 工具", { exact: true }).selectOption("change");
      await f.page.getByRole("button", { name: "授权当前成员使用此工具", exact: true }).click();
      await f.page.getByRole("button", { name: "确认 MCP 工具授权", exact: true }).click();
      await f.page.getByLabel("MCP 工具参数 JSON", { exact: true }).fill('{"target":"handoff-target","value":"after-native"}');
      await f.page.getByLabel("MCP 写入目标说明", { exact: true }).fill("handoff-target");
      await f.page.getByRole("button", { name: "准备固定 MCP 操作", exact: true }).click();
      await f.page.getByRole("button", { name: "审阅并批准固定 MCP 操作", exact: true }).click();
      await expect(dialog).toHaveCount(1);
      await expect(dialog.getByLabel("本次 MCP 固定参数")).toContainText("handoff-target");
      await f.application.evaluate(() => (globalThis as { mcpHandoff?: { release?: () => void } }).mcpHandoff?.release?.());
      await expect(f.page.getByText("固定版本已进入当前成员的审批队列，请核对原操作记录。", { exact: true })).toBeVisible();
      await expect(dialog).toHaveCount(1);
      await expect(dialog.getByLabel("本次 MCP 固定参数")).toContainText("handoff-target");
      await dialog.getByRole("button", { name: "仅允许一次", exact: true }).click();
      await expect.poll(f.writes).toBe(1);
      await expect(dialog).toHaveCount(0);
      expect(f.nativeWrites()).toBe(1);
    } finally {
      await f.application.evaluate(() => (globalThis as { mcpHandoff?: { release?: () => void } }).mcpHandoff?.release?.()).catch(() => undefined);
    }
  });
});
