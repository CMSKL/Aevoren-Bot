import { createServer, type ServerResponse } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { AevorenBotApi, ApiResult } from "../../src/shared/contracts";
import type { ConnectorBinding, NativeConnection } from "../../src/shared/native-connector-contracts";
import { AppRepository } from "../../src/main/database";
import { closeTestApplication, removeTestDirectory } from "./test-cleanup";
import { openInspector } from "./navigation";

const pageId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const blockId = "33333333-3333-4333-8333-333333333333";
const title = "NATIVE_FIXTURE_PAGE <script>";
function unwrap<T>(result: ApiResult<T>): T { if (!result.ok) throw new Error(result.error.code); return result.data; }
function notionPage() { return { object: "page", id: pageId, in_trash: false, last_edited_time: "2026-10-14T12:00:00.000Z", properties: { title: { type: "title", title: [{ plain_text: title }] } } }; }
function json(response: ServerResponse, value: unknown): void { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); }

type Fixture = {
  application: ElectronApplication; page: Page; data: string;
  bots: { id: string; name: string; sessionId: string }[];
  room: { id: string; name: string; sessionId: string };
  requests: { method: string; path: string; host: string }[];
  delayNextRead(marker: string): { entered: () => boolean; release(): void };
};

async function withNative(callback: (fixture: Fixture) => Promise<void>): Promise<void> {
  const data = mkdtempSync(join(tmpdir(), "aevoren-native-connectors-"));
  const repository = new AppRepository(join(data, "aevoren-bot.sqlite"));
  const bots = [0, 1].map(index => {
    const created = repository.createBot();
    const bot = repository.updateBot(created.bot.id, created.bot.version, { name: `应用验收成员${index + 1}` });
    return { id: bot.id, name: bot.name, sessionId: created.session.id };
  });
  const room = repository.createRoom({ name: "应用范围验收群", memberBotIds: bots.map(bot => bot.id), leadBotId: null });
  repository.setSetting("memory.capture.enabled", "false", false);
  repository.close();
  const requests: Fixture["requests"] = [];
  const errors: string[] = [];
  let delay: { marker: string; entered: boolean; response: ServerResponse | null; released: boolean } | null = null;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const host = String(request.headers["x-aevoren-native-host"] ?? "");
      requests.push({ method: request.method ?? "GET", path: url.pathname, host });
      if (host !== "api.notion.com" || request.headers.authorization !== "Bearer native-fixture-token" || request.headers["notion-version"] !== "2026-03-11") throw new Error("Unexpected fixture authorization");
      if (url.pathname === "/v1/users/me") json(response, { type: "bot", id: accountId, name: "fixture bot", bot: { workspace_name: "Fixture workspace" } });
      else if (url.pathname === "/v1/search" && request.method === "POST") {
        let body = ""; for await (const chunk of request) body += chunk;
        if (JSON.parse(body).filter.value !== "page") throw new Error("Search filter missing");
        json(response, { results: [notionPage()], has_more: false, next_cursor: null });
      } else if (url.pathname === `/v1/pages/${pageId}`) json(response, notionPage());
      else if (url.pathname === `/v1/blocks/${pageId}/children`) {
        if (delay && !delay.entered) { delay.entered = true; delay.response = response; if (delay.released) json(response, { results: [{ id: blockId, type: "paragraph", has_children: false, paragraph: { rich_text: [{ plain_text: delay.marker }] } }], has_more: false }); }
        else json(response, { results: [{ id: blockId, type: "paragraph", has_children: false, paragraph: { rich_text: [{ plain_text: "FIXTURE_ESCAPED_TEXT <img src=x onerror=alert(1)>" }] } }], has_more: false });
      } else throw new Error(`Unexpected external operation ${request.method} ${url.pathname}`);
    } catch (error) { errors.push(String(error)); response.writeHead(500); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture server unavailable");
  let application: ElectronApplication | undefined;
  try {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith("AEVOREN_BOT_")));
    const executablePath = process.env.AEVOREN_PACKAGED_APP_PATH ?? process.env.AEVOREN_BOT_PACKAGED_EXECUTABLE;
    application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : ["."], cwd: process.cwd(), env: {
      ...environment, AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_USER_DATA_DIR: data, AEVOREN_BOT_FAKE_PROVIDER: "1", AEVOREN_BOT_DISABLE_UPDATES: "1", AEVOREN_BOT_NATIVE_TEST_ORIGIN: `http://127.0.0.1:${address.port}`,
    } });
    const page = await application.firstWindow();
    page.on("pageerror", error => errors.push(error.message));
    await expect(page.locator(".app-shell")).toBeVisible();
    if (executablePath) {
      const runtime = await application.evaluate(({ app }) => ({ isPackaged: app.isPackaged, version: app.getVersion(), resourcesPath: process.resourcesPath }));
      expect(runtime.isPackaged).toBe(true);
      expect(runtime.version).toBe(JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version);
      expect(existsSync(join(runtime.resourcesPath, "docs", "NATIVE_CONNECTORS.md"))).toBe(true);
      await test.info().attach("actual-native-connection-package", { body: JSON.stringify(runtime), contentType: "application/json" });
    }
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1182, 804));
    await callback({ application, page, data, bots, room: { id: room.room.id, name: room.room.name, sessionId: room.session.id }, requests,
      delayNextRead(marker) {
        delay = { marker, entered: false, response: null, released: false };
        const capture = delay;
        return { entered: () => capture.entered, release() { capture.released = true; if (capture.response && !capture.response.destroyed) json(capture.response, { results: [{ id: blockId, type: "paragraph", has_children: false, paragraph: { rich_text: [{ plain_text: capture.marker }] } }], has_more: false }); } };
      },
    });
    expect(errors).toEqual([]);
    expect(requests.every(request => request.host === "api.notion.com")).toBe(true);
    expect(requests.filter(request => request.method !== "GET").every(request => request.method === "POST" && request.path === "/v1/search")).toBe(true);
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible()))).toBe(false);
  } finally {
    server.closeAllConnections();
    if (application) await closeTestApplication(application);
    await new Promise<void>(resolve => server.close(() => resolve()));
    removeTestDirectory(data);
  }
}

async function configureNotion(page: Page): Promise<NativeConnection> {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "应用连接", exact: true }).click();
  await page.getByLabel("应用提供方").selectOption("notion");
  await page.getByLabel("连接名称", { exact: true }).fill("Fixture Notion");
  await page.getByLabel("Notion 内部连接 Token").fill("native-fixture-token");
  await page.getByRole("button", { name: "保存连接配置", exact: true }).click();
  await expect(page.getByLabel("Notion 内部连接 Token")).toHaveValue("");
  await expect(page.getByText("账号尚未确认", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "验证连接", exact: true }).click();
  await expect(page.getByText("Fixture workspace", { exact: true })).toBeVisible();
  await expect(page.getByText("native-fixture-token", { exact: false })).toHaveCount(0);
  const connection = await page.evaluate(async () => { const result = await (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.connectors.list({}); if (!result.ok) throw new Error(result.error.code); return result.data[0]!; });
  expect(connection.state).toBe("connected"); expect(connection.account?.accountId).toBe(accountId);
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  return connection;
}

async function privateApps(page: Page, bot: Fixture["bots"][number], connection: NativeConnection): Promise<void> {
  await page.getByRole("tab", { name: "联系人", exact: true }).click();
  await page.locator(".sidebar").getByRole("listitem", { name: bot.name, exact: true }).click();
  await page.getByRole("tab", { name: "应用", exact: true }).click();
  await page.getByLabel("当前聊天的应用连接").selectOption(connection.id);
}

async function binding(page: Page, sessionId: string, executorBotId: string): Promise<ConnectorBinding> {
  const result = await page.evaluate(async scope => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.connectors.bindings(scope), { sessionId, executorBotId });
  return unwrap(result)[0]!;
}

test("native read authorization is isolated and local draft conflicts retain the user's editor", async () => {
  test.setTimeout(90_000);
  await withNative(async fixture => {
    const { page, bots, room } = fixture;
    const connection = await configureNotion(page);
    await privateApps(page, bots[0]!, connection);
    await expect(page.getByText("尚未授权读取", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "授权当前成员读取", exact: true }).click();
    await expect(page.getByText("当前成员已授权", { exact: true })).toBeVisible();
    const privateGrant = await binding(page, bots[0]!.sessionId, bots[0]!.id);
    const groupGrants = unwrap(await page.evaluate(async input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.connectors.bindings(input), { sessionId: room.sessionId, executorBotId: bots[0]!.id }));
    expect(groupGrants).toEqual([]);
    const unauthorized = await page.evaluate(async input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.connectors.search(input), { sessionId: room.sessionId, executorBotId: bots[0]!.id, connectionId: connection.id, expectedAuthVersion: connection.authVersion, expectedBindingVersion: privateGrant.version, query: "" });
    expect(unauthorized.ok).toBe(false);
    await page.getByLabel("应用搜索内容").fill("fixture");
    await page.getByRole("button", { name: "搜索应用内容", exact: true }).click();
    await page.locator(".connector-results .connector-result").first().click();
    await expect(page.getByRole("article", { name: "应用读取结果" })).toContainText("FIXTURE_ESCAPED_TEXT <img src=x onerror=alert(1)>");
    expect(await page.getByRole("article", { name: "应用读取结果" }).locator("img,script").count()).toBe(0);
    await page.getByRole("button", { name: "新建本地草稿", exact: true }).click();
    await page.getByLabel("Notion 草稿父页面").fill(pageId);
    await page.getByLabel("文件草稿标题").fill("LOCAL_ONLY_DRAFT");
    await page.getByLabel("文件草稿正文").fill("first version");
    const beforeSave = fixture.requests.length;
    await page.getByRole("button", { name: "保存本地草稿", exact: true }).click();
    await expect(page.getByText("本地草稿已保存 · 版本 1。尚未向外部应用提交。", { exact: true })).toBeVisible();
    expect(fixture.requests.length).toBe(beforeSave);
    const draft = unwrap(await page.evaluate(async input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.drafts.list(input), { sessionId: bots[0]!.sessionId, executorBotId: bots[0]!.id }))[0]!;
    const updated = await page.evaluate(async input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.drafts.update(input), { sessionId: bots[0]!.sessionId, executorBotId: bots[0]!.id, id: draft.id, expectedVersion: draft.version, content: { kind: "notion-page" as const, parentPageId: pageId, title: "LOCAL_ONLY_DRAFT", text: "external local editor version" } });
    expect(updated.ok).toBe(true);
    await page.getByLabel("文件草稿正文").fill("USER_UNSAVED_CONFLICT_TEXT");
    await page.getByRole("button", { name: "保存本地草稿", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("当前草稿仍保留在编辑器中");
    await expect(page.getByLabel("文件草稿正文")).toHaveValue("USER_UNSAVED_CONFLICT_TEXT");
    const current = unwrap(await page.evaluate(async input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.drafts.read(input), { sessionId: bots[0]!.sessionId, executorBotId: bots[0]!.id, id: draft.id }));
    expect(current.draft.version).toBe(2); expect(current.revision.content).toMatchObject({ text: "external local editor version" });
    await page.getByRole("tab", { name: "资料库", exact: true }).click();
    await expect(page.getByRole("group", { name: "未保存应用草稿" })).toBeVisible();
    await page.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(page.getByRole("tab", { name: "应用", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByLabel("文件草稿正文")).toHaveValue("USER_UNSAVED_CONFLICT_TEXT");
    await page.getByRole("tab", { name: "资料库", exact: true }).click();
    await page.getByRole("button", { name: "丢弃修改并继续", exact: true }).click();
    await expect(page.getByRole("tab", { name: "资料库", exact: true })).toHaveAttribute("aria-selected", "true");
    expect(unwrap(await page.evaluate(async input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.drafts.list(input), { sessionId: room.sessionId, executorBotId: bots[0]!.id }))).toEqual([]);
    // Hidden Windows package capture can stall after fonts load. All content,
    // permission and hidden-window assertions still run on every platform.
    if (process.platform !== "win32") await page.screenshot({ path: join(tmpdir(), "aevoren-native-connectors-private-1182x804.png") });
  });
});

test("late native reads cannot replace another member's pane or reappear after revocation", async () => {
  test.setTimeout(90_000);
  await withNative(async fixture => {
    const { page, bots, room } = fixture;
    const connection = await configureNotion(page);
    for (const bot of bots) unwrap(await page.evaluate(async input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.connectors.bind(input), { sessionId: room.sessionId, executorBotId: bot.id, connectionId: connection.id, expectedAuthVersion: connection.authVersion }));
    await page.getByRole("tab", { name: "聊天", exact: true }).click();
    await page.locator(".sidebar").getByRole("listitem", { name: room.name, exact: true }).click();
    await openInspector(page);
    await expect.poll(() => page.getByRole("tablist", { name: "群聊配置" }).evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(40);
    await page.getByRole("tab", { name: "应用", exact: true }).click();
    await page.getByLabel("应用执行成员").selectOption(bots[0]!.id);
    await page.getByLabel("当前聊天的应用连接").selectOption(connection.id);
    await page.getByRole("button", { name: "搜索应用内容", exact: true }).click();
    const resultButton = page.locator(".connector-results .connector-result").first();
    await expect(resultButton).toBeVisible();
    const delayed = fixture.delayNextRead("OLD_MEMBER_DELAYED_CONTENT");
    await resultButton.click();
    await expect.poll(delayed.entered).toBe(true);
    await page.getByLabel("应用执行成员").selectOption(bots[1]!.id);
    await expect(page.getByText(`${room.name} · ${bots[1]!.name}`, { exact: false })).toBeVisible();
    delayed.release();
    await page.getByLabel("当前聊天的应用连接").selectOption(connection.id);
    await page.getByRole("button", { name: "搜索应用内容", exact: true }).click();
    await expect(resultButton).toBeVisible();
    await expect(page.getByText("OLD_MEMBER_DELAYED_CONTENT", { exact: false })).toHaveCount(0);
    const revoked = fixture.delayNextRead("REVOKED_DELAYED_CONTENT");
    await resultButton.click();
    await expect.poll(revoked.entered).toBe(true);
    await page.getByRole("button", { name: "撤销成员读取授权", exact: true }).click();
    await page.getByRole("button", { name: "确认撤销成员授权", exact: true }).click();
    await expect(page.getByText("当前成员的读取授权已撤销。", { exact: true })).toBeVisible();
    revoked.release();
    await expect(page.getByRole("button", { name: "搜索应用内容", exact: true })).toBeDisabled();
    await expect(page.getByText("REVOKED_DELAYED_CONTENT", { exact: false })).toHaveCount(0);
    expect(unwrap(await page.evaluate(async input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.connectors.bindings(input), { sessionId: room.sessionId, executorBotId: bots[0]!.id }))).toHaveLength(1);
    expect(unwrap(await page.evaluate(async input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.connectors.bindings(input), { sessionId: room.sessionId, executorBotId: bots[1]!.id }))).toEqual([]);
    if (process.platform !== "win32") await page.screenshot({ path: join(tmpdir(), "aevoren-native-connectors-group-revoke-1182x804.png") });
  });
});
