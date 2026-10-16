import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { AevorenBotApi, ApiResult } from "../../src/shared/contracts";
import type { MediaApi, MediaItem, MessageMediaReference } from "../../src/shared/media-contracts";
import type { ProductViewInput, ProductViewResult } from "../../src/shared/product-view";
import { PRODUCT_VIEW_DOM_EVENT } from "../../src/shared/product-view";
import { MEDIA_CHANNELS } from "../../src/shared/media-channels";
import { IPC } from "../../src/shared/channels";
import { AppRepository } from "../../src/main/database";
import { WorkspaceService } from "../../src/main/workspace-service";
import { tinyDocx, tinyPdf } from "../fixtures/media-parser-data";
import { closeTestApplication, removeTestDirectory } from "./test-cleanup";
import { closeInspector, openInspector } from "./navigation";

type Fixture = { application: ElectronApplication; page: Page; data: string; source: string; workspaceId: string; bots: { id: string; name: string; sessionId: string }[]; room: { id: string; sessionId: string; name: string }; imageSha256: string };
type MainFixture = { mediaUiBarrier?: { entered: boolean; returned: boolean; release?: () => void }; mediaUiReads?: number };
type Draft = { text: string; mediaRefs: MessageMediaReference[]; digest: string; draftVersion: number };
type MediaMethod = Exclude<keyof MediaApi, "onChanged">;
function value<T>(result: ApiResult<T>): T { if (!result.ok) throw new Error(result.error.code); return result.data; }
async function call<T>(page: Page, method: MediaMethod, input: unknown): Promise<T> {
  return value(await page.evaluate(async ({ method, input }) => {
    const media = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.media as unknown as Record<MediaMethod, (input: unknown) => Promise<ApiResult<T>>>;
    return media[method](input);
  }, { method, input }));
}
async function view(page: Page, input: ProductViewInput): Promise<ProductViewResult> {
  return page.evaluate(({ name, input }) => new Promise<ProductViewResult>(resolve => {
    window.dispatchEvent(new CustomEvent(name, { detail: { request: { id: crypto.randomUUID(), input }, respond: resolve } }));
  }), { name: PRODUCT_VIEW_DOM_EVENT, input });
}
async function draft(f: Fixture): Promise<Draft> { const result = await view(f.page, { action: "draft_get" }); expect(result.status).toBe("completed"); return result.result as Draft; }
async function selectBot(f: Fixture, index: number): Promise<void> {
  const bot = f.bots[index]!; await f.page.getByRole("listitem", { name: bot.name, exact: true }).click(); await expect(f.page.getByRole("heading", { name: bot.name, exact: true })).toBeVisible();
}

async function withMedia(work: (f: Fixture) => Promise<void>): Promise<void> {
  const data = mkdtempSync(join(tmpdir(), "aevoren-media-ui-")), source = join(data, "source"); mkdirSync(source);
  const image = readFileSync(join(process.cwd(), "resources/icon.png")); writeFileSync(join(source, "picture.png"), image);
  writeFileSync(join(source, "pages.pdf"), tinyPdf(["PDF_FIRST_UI", "", "PDF_LAST_UI"]));
  writeFileSync(join(source, "sections.docx"), await tinyDocx("DOCX_UI_SECTION\n<script>window.__media_test_script=1</script>"));
  const repository = new AppRepository(join(data, "aevoren-bot.sqlite"));
  const registration = await new WorkspaceService(repository).registerRoot(source);
  const bots = ["媒体甲", "媒体乙"].map(name => { const created = repository.createBot(registration.project.id); repository.updateBot(created.bot.id, created.bot.version, { name }); return { id: created.bot.id, sessionId: created.session.id, name }; });
  const room = repository.createRoom({ name: "媒体隔离群", memberBotIds: bots.map(bot => bot.id), leadBotId: null, projectId: registration.project.id });
  repository.setSetting("memory.capture.enabled", "false", false); repository.close();
  let application: ElectronApplication | undefined;
  try {
    const executablePath = process.env.AEVOREN_PACKAGED_APP_PATH;
    application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : ["."], cwd: process.cwd(), env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key, item]) => item !== undefined && !key.startsWith("AEVOREN_BOT_"))),
      AEVOREN_BOT_USER_DATA_DIR: data, AEVOREN_BOT_FAKE_PROVIDER: "1", AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_DISABLE_UPDATES: "1",
    } });
    if (executablePath) {
      const actual = await application.evaluate(({ app }) => ({ isPackaged: app.isPackaged, version: app.getVersion() }));
      expect(actual).toEqual({ isPackaged: true, version: JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version });
      await test.info().attach("actual-media-package", { body: JSON.stringify(actual), contentType: "application/json" });
    }
    const expectedUrl = pathToFileURL(join(await application.evaluate(({ app }) => app.getAppPath()), "out/renderer/index.html")).href;
    const page = await application.firstWindow(); await page.waitForURL(expectedUrl, { waitUntil: "domcontentloaded" }); await expect(page.locator(".app-shell")).toBeVisible();
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await application.evaluate(({ ipcMain }, channel) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
      const original = handlers.get(channel); if (!original) throw new Error("Missing real media read handler");
      (globalThis as MainFixture).mediaUiReads = 0; ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (...args) => { (globalThis as MainFixture).mediaUiReads! += 1; return original(...args); });
    }, MEDIA_CHANNELS.read);
    const f: Fixture = { application, page, data, source, workspaceId: registration.workspace.id, bots, room: { id: room.room.id, sessionId: room.session.id, name: room.room.name }, imageSha256: createHash("sha256").update(image).digest("hex") };
    await selectBot(f, 0); await work(f);
    expect(errors).toEqual([]); expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible()))).toBe(false);
  } finally { if (application) await closeTestApplication(application); removeTestDirectory(data); }
}

// Replace only the OS selection with a registered test Workspace path. Import parsing,
// owned storage, authorization, IPC reply and returned reference all remain production code.
async function picker(f: Fixture, hold = false): Promise<void> {
  await f.application.evaluate(({ ipcMain }, input) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
    const original = handlers.get(input.importChannel); if (!original) throw new Error("Missing real media importer");
    const globals = globalThis as MainFixture; globals.mediaUiBarrier = { entered: false, returned: false };
    ipcMain.removeHandler(input.pickChannel);
    ipcMain.handle(input.pickChannel, async (event, scope: { sessionId: string }) => {
      const result = await original(event, { ...scope, workspaceId: input.workspaceId, path: "picture.png" });
      globals.mediaUiBarrier!.entered = true;
      if (input.hold) await new Promise<void>(resolve => { globals.mediaUiBarrier!.release = resolve; });
      globals.mediaUiBarrier!.returned = true; return result;
    });
  }, { pickChannel: MEDIA_CHANNELS.pickImport, importChannel: MEDIA_CHANNELS.importPath, workspaceId: f.workspaceId, hold });
}
async function barrier(f: Fixture, channel: string): Promise<void> {
  await f.application.evaluate(({ ipcMain }, channel) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
    const original = handlers.get(channel); if (!original) throw new Error("Missing production barrier handler");
    const globals = globalThis as MainFixture; globals.mediaUiBarrier = { entered: false, returned: false };
    ipcMain.removeHandler(channel); ipcMain.handle(channel, async (...args) => {
      const result = await original(...args); globals.mediaUiBarrier!.entered = true;
      await new Promise<void>(resolve => { globals.mediaUiBarrier!.release = resolve; });
      globals.mediaUiBarrier!.returned = true; return result;
    });
  }, channel);
}
async function entered(f: Fixture): Promise<void> { await expect.poll(() => f.application.evaluate(() => Boolean((globalThis as MainFixture).mediaUiBarrier?.entered)), { timeout: 30_000 }).toBe(true); }
async function release(f: Fixture): Promise<void> { await f.application.evaluate(() => (globalThis as MainFixture).mediaUiBarrier?.release?.()); }
async function importFromComposer(f: Fixture): Promise<void> { await f.page.getByRole("button", { name: "添加媒体", exact: true }).click(); await f.page.getByRole("menuitem", { name: "导入媒体文件", exact: true }).click(); }
async function setMedia(f: Fixture, refs: MessageMediaReference[]): Promise<void> {
  const current = await draft(f); const result = await view(f.page, { action: "draft_update", expectedDigest: current.digest, expectedDraftVersion: current.draftVersion, mediaRefs: refs }); expect(result.status).toBe("completed");
}

test("imports owned pixels, preserves private media drafts and requires an explicit binding in another conversation", async () => {
  test.setTimeout(90_000);
  await withMedia(async f => {
    await picker(f); await importFromComposer(f);
    const chip = f.page.getByRole("button", { name: "预览媒体 picture.png", exact: true }); await expect(chip).toBeEnabled();
    const first = await draft(f); expect(first.mediaRefs).toHaveLength(1);
    expect(await f.application.evaluate(() => (globalThis as MainFixture).mediaUiReads)).toBe(0);
    unlinkSync(join(f.source, "picture.png")); await chip.click();
    const image = f.page.getByRole("dialog", { name: "媒体预览", exact: true }).locator("img"); await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const imageBytes = Buffer.from((await image.getAttribute("src"))!.split(",")[1]!, "base64"); expect(createHash("sha256").update(imageBytes).digest("hex")).toBe(f.imageSha256);
    await f.page.getByRole("button", { name: "关闭媒体预览", exact: true }).click();
    await selectBot(f, 1); expect((await draft(f)).mediaRefs).toEqual([]);
    const denied = await f.page.evaluate(async input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.media.metadata(input), { sessionId: f.bots[1]!.sessionId, id: first.mediaRefs[0]!.mediaId }); expect(denied.ok).toBe(false);
    const groupDenied = await f.page.evaluate(async input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.media.metadata(input), { sessionId: f.room.sessionId, id: first.mediaRefs[0]!.mediaId }); expect(groupDenied.ok).toBe(false);
    await f.page.getByRole("button", { name: "添加媒体", exact: true }).click(); await f.page.getByRole("menuitem", { name: "引用已有媒体", exact: true }).click();
    const selector = f.page.getByRole("dialog", { name: "选择媒体引用", exact: true }); await selector.getByRole("button", { name: "添加已有媒体", exact: true }).click();
    await selector.getByRole("button", { name: "添加到当前会话", exact: true }).click(); await selector.getByRole("button", { name: "引用媒体到消息", exact: true }).click();
    expect((await draft(f)).mediaRefs).toEqual(first.mediaRefs); await expect(f.page.getByRole("button", { name: "发送", exact: true })).toBeEnabled(); await f.page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(f.page.locator('article.message-user [aria-label="消息媒体引用"]')).toContainText("picture.png");
    await expect.poll(async () => (await draft(f)).mediaRefs.length).toBe(0);
    const sent = value(await f.page.evaluate(async sessionId => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.transcript.list(sessionId), f.bots[1]!.sessionId)); expect(sent.find(entry => entry.role === "user")).toMatchObject({ body: "", mediaRefs: first.mediaRefs });
    await selectBot(f, 0); expect((await draft(f)).mediaRefs).toEqual(first.mediaRefs);
    await f.page.getByRole("button", { name: "移除媒体引用 picture.png", exact: true }).click(); expect((await draft(f)).mediaRefs).toEqual([]);
    expect(await call<MediaItem[]>(f.page, "list", { sessionId: f.bots[0]!.sessionId })).toHaveLength(1);
    await f.page.getByLabel("消息", { exact: true }).fill("资料页保留草稿"); await openInspector(f.page);
    const contact = f.page.getByRole("main", { name: "联系人资料", exact: true }); await contact.getByRole("tab", { name: "资料库", exact: true }).click();
    await contact.getByRole("region", { name: "媒体资料库", exact: true }).getByRole("button", { name: "引用媒体到消息", exact: true }).click();
    await expect(f.page.getByLabel("消息", { exact: true })).toHaveValue("资料页保留草稿"); await expect.poll(async () => (await draft(f)).mediaRefs).toEqual(first.mediaRefs);
    await f.page.getByRole("listitem", { name: f.room.name, exact: true }).click(); await openInspector(f.page);
    const group = f.page.getByRole("dialog", { name: "群聊设置", exact: true }); await group.getByRole("tab", { name: "资料库", exact: true }).click();
    await expect(group.getByRole("region", { name: "媒体资料库", exact: true })).toContainText("当前会话没有匹配的媒体"); await expect(group.getByText("picture.png", { exact: true })).toHaveCount(0); await closeInspector(f.page);
    expect(await f.application.evaluate(() => (globalThis as MainFixture).mediaUiReads)).toBe(0);
  });
});

test("rejects draft ABA updates and ignores late imports and send acknowledgements across edits and remounts", async () => {
  test.setTimeout(90_000);
  await withMedia(async f => {
    const input = f.page.getByLabel("消息", { exact: true }); await input.fill("A"); const original = await draft(f);
    await picker(f, true); await importFromComposer(f); await entered(f);
    await input.fill("B"); await input.fill("A"); const edited = await draft(f); expect(edited.digest).toBe(original.digest); expect(edited.draftVersion).toBeGreaterThan(original.draftVersion);
    expect((await view(f.page, { action: "draft_update", expectedDigest: original.digest, expectedDraftVersion: original.draftVersion, text: "MUST_NOT_REPLACE" })).status).toBe("waiting_user");
    await release(f); await expect(f.page.getByRole("alert")).toContainText("草稿已变化"); expect((await draft(f)).mediaRefs).toEqual([]); expect(await call<MediaItem[]>(f.page, "list", { sessionId: f.bots[0]!.sessionId })).toHaveLength(1);
    await picker(f, true); await importFromComposer(f); await entered(f); await selectBot(f, 1); await f.page.getByLabel("消息", { exact: true }).fill("乙的草稿"); await release(f);
    expect((await draft(f)).mediaRefs).toEqual([]); await selectBot(f, 0); const restored = await draft(f); expect(restored.text).toBe("A"); expect(restored.draftVersion).toBeGreaterThanOrEqual(edited.draftVersion); expect(restored.mediaRefs).toEqual([]);
    await barrier(f, IPC.messagesSend); await f.page.getByRole("button", { name: "发送", exact: true }).click(); await entered(f);
    await input.fill("B"); await input.fill("A"); const duringSend = await draft(f); await release(f);
    await expect.poll(() => f.application.evaluate(() => Boolean((globalThis as MainFixture).mediaUiBarrier?.returned))).toBe(true);
    await expect(f.page.getByRole("button", { name: "发送", exact: true })).toBeEnabled(); expect((await draft(f)).text).toBe("A"); expect((await draft(f)).draftVersion).toBe(duringSend.draftVersion);
    await selectBot(f, 1); await selectBot(f, 0); expect((await draft(f)).draftVersion).toBe(duringSend.draftVersion);
  });
});

test("purges revoked preview pixels and refuses a delayed preview reply without deleting the draft reference", async () => {
  test.setTimeout(90_000);
  await withMedia(async f => {
    const imported = await call<{ imported: MediaItem[] }>(f.page, "importPath", { sessionId: f.bots[0]!.sessionId, workspaceId: f.workspaceId, path: "picture.png" }); const reference = imported.imported[0]!.reference;
    await setMedia(f, [reference]); await barrier(f, MEDIA_CHANNELS.preview);
    await f.page.getByRole("button", { name: "预览媒体 picture.png", exact: true }).click(); await entered(f);
    await call(f.page, "unbind", { sessionId: f.bots[0]!.sessionId, id: reference.mediaId }); const preview = f.page.getByRole("dialog", { name: "媒体预览", exact: true }); await expect(preview.getByRole("alert")).toContainText("预览内容已清除"); await release(f);
    await expect.poll(() => f.application.evaluate(() => Boolean((globalThis as MainFixture).mediaUiBarrier?.returned))).toBe(true);
    await f.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(preview.locator("img")).toHaveCount(0); await f.page.getByRole("button", { name: "关闭媒体预览", exact: true }).click();
    await expect(f.page.getByRole("button", { name: /预览媒体 媒体 .*不可读取/u })).toBeDisabled(); expect((await draft(f)).mediaRefs).toEqual([reference]);
    await f.page.getByRole("button", { name: "发送", exact: true }).click(); await expect(f.page.locator(".composer-error")).toBeVisible(); expect((await draft(f)).mediaRefs).toEqual([reference]);
    expect(await f.application.evaluate(() => (globalThis as MainFixture).mediaUiReads)).toBe(0);
  });
});

test("previews real physical PDF pages including blanks and renders DOCX as escaped text sections", async () => {
  test.setTimeout(90_000);
  await withMedia(async f => {
    const references: MessageMediaReference[] = [];
    for (const path of ["pages.pdf", "sections.docx"]) { const imported = await call<{ imported: MediaItem[] }>(f.page, "importPath", { sessionId: f.bots[0]!.sessionId, workspaceId: f.workspaceId, path }); references.push(imported.imported[0]!.reference); }
    await setMedia(f, references); expect(await f.application.evaluate(() => (globalThis as MainFixture).mediaUiReads)).toBe(0);
    await f.page.getByRole("button", { name: "预览媒体 pages.pdf", exact: true }).click(); const preview = f.page.getByRole("dialog", { name: "媒体预览", exact: true });
    await expect(preview.getByRole("navigation", { name: "PDF 分页", exact: true })).toContainText("第 1 / 3 页"); await expect(preview.locator("img")).toBeVisible();
    await preview.getByRole("button", { name: "下一页", exact: true }).click(); await expect(preview.getByRole("navigation", { name: "PDF 分页", exact: true })).toContainText("第 2 / 3 页"); await expect(preview.locator("img")).toBeVisible();
    await preview.getByRole("button", { name: "下一页", exact: true }).click(); await expect(preview.getByRole("navigation", { name: "PDF 分页", exact: true })).toContainText("第 3 / 3 页"); await expect(preview.getByRole("button", { name: "下一页", exact: true })).toBeDisabled();
    await f.page.getByRole("button", { name: "关闭媒体预览", exact: true }).click(); await f.page.getByRole("button", { name: "预览媒体 sections.docx", exact: true }).click();
    await expect(preview).toContainText("DOCX 文字分节预览，不代表物理分页"); await expect(preview.locator("pre")).toContainText("DOCX_UI_SECTION"); await expect(preview.locator("pre")).toContainText("<script>"); await expect(preview.locator("img")).toHaveCount(0);
    expect(await f.page.evaluate(() => (window as unknown as { __media_test_script?: number }).__media_test_script)).toBeUndefined();
  });
});
