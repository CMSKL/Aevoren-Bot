import { createServer, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { AevorenBotApi, ApiResult, RoomRuntimeSnapshot, SessionRuntimeSnapshot } from "../../src/shared/contracts";
import type { LibraryApi, LibraryContent, LibraryExportResult, LibraryImportResult, LibraryResource, ResourceRevisionSummary } from "../../src/shared/library-contracts";
import { AppRepository } from "../../src/main/database";
import { WorkspaceService } from "../../src/main/workspace-service";
import { openInspector } from "./navigation";
import { removeTestDirectory } from "./test-cleanup";
import { IPC } from "../../src/shared/channels";
import { LIBRARY_CHANNELS } from "../../src/shared/library-channels";

type LibraryMethod = Exclude<keyof LibraryApi, "onChanged">;
type WireMessage = { role: string; content: unknown; tool_call_id?: string };
type WireRequest = { model: string; messages: WireMessage[]; tools?: unknown[] };
type Capture = { command: WireRequest; response: ServerResponse; aborted: boolean; released: boolean };
type FixtureBot = { id: string; name: string; sessionId: string; modelId: string; marker: string };
type LibraryFixture = {
  page: Page;
  application: ElectronApplication;
  data: string;
  workspace: { id: string; path: string };
  exportPath: string;
  bots: FixtureBot[];
  room: { id: string; name: string; sessionId: string };
  captures: Capture[];
  respond: (callback: (capture: Capture) => void) => void;
  restart: () => Promise<void>;
};
type DelayedLibraryMain = { libraryDelay?: { entered: boolean; returned: boolean; release?: () => void } };

// Hold the real host handler at a deterministic barrier; do not replace its result.
async function holdLibraryIpc(application: ElectronApplication, channel: string, id: string): Promise<void> {
  await application.evaluate(({ ipcMain }, input) => {
    const globals = globalThis as DelayedLibraryMain;
    const original = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers.get(input.channel);
    if (!original) throw new Error("Missing production IPC handler");
    globals.libraryDelay = { entered: false, returned: false };
    ipcMain.removeHandler(input.channel);
    ipcMain.handle(input.channel, async (...args: unknown[]) => {
      const request = args[1];
      const requestId = typeof request === "string" ? request : (request as { id?: string } | null)?.id;
      if (requestId !== input.id || globals.libraryDelay!.entered) return original(...args);
      globals.libraryDelay!.entered = true;
      await new Promise<void>(resolve => { globals.libraryDelay!.release = resolve; });
      const result = await original(...args);
      globals.libraryDelay!.returned = true;
      return result;
    });
  }, { channel, id });
}

async function releaseLibraryIpc(application: ElectronApplication): Promise<void> {
  await application.evaluate(() => (globalThis as DelayedLibraryMain).libraryDelay?.release?.());
}

async function settleLibraryView(page: Page): Promise<void> {
  // Flush both the IPC promise reaction and React's resulting visual commit.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

function value<T>(result: ApiResult<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.data;
}

async function libraryCall<T>(page: Page, method: LibraryMethod, input: unknown): Promise<ApiResult<T>> {
  return page.evaluate(async ({ method, input }) => {
    const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
    const library = api.library as unknown as Record<LibraryMethod, (input: unknown) => Promise<ApiResult<T>>>;
    return library[method](input);
  }, { method, input });
}

function respondText(capture: Capture, text: string): void {
  capture.released = true;
  capture.response.writeHead(200, { "content-type": "text/event-stream" });
  capture.response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
}

function respondTool(capture: Capture, operation: string, input: unknown): void {
  capture.released = true;
  capture.response.writeHead(200, { "content-type": "text/event-stream" });
  capture.response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0,
    id: "fixture-library-tool", type: "function", function: { name: "product_execute", arguments: JSON.stringify({ operation, input }) },
  }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
}

// These replies are deterministic API fixtures. Assertions cover the real
// IPC/Runtime/provider transport; they do not measure model reasoning quality.
async function withLibrary(callback: (fixture: LibraryFixture) => Promise<void>): Promise<void> {
  const data = mkdtempSync(join(tmpdir(), "aevoren-library-smoke-"));
  const source = join(data, "source-workspace");
  mkdirSync(source);
  const repository = new AppRepository(join(data, "aevoren-bot.sqlite"));
  const registration = await new WorkspaceService(repository).registerRoot(source);
  const bots = Array.from({ length: 7 }, (_, index) => {
    const created = repository.createBot(registration.project.id);
    const marker = `ONLY_PROFILE_LIBRARY_${index}`;
    const modelId = `fixture-library-${index}`;
    const bot = repository.updateBot(created.bot.id, created.bot.version, { name: `资料验收成员${index + 1}`, instructions: marker,
      mcpServerIds: [], modelSelection: { providerInstanceId: "openai-compatible.default", modelId } });
    return { id: bot.id, sessionId: created.session.id, name: bot.name, modelId, marker };
  });
  const room = repository.createRoom({ name: "资料引用并行验收", memberBotIds: bots.slice(0, 6).map((bot) => bot.id), leadBotId: null, projectId: registration.project.id });
  repository.setSetting("memory.capture.enabled", "false", false);
  repository.close();
  const captures: Capture[] = [];
  const errors: string[] = [];
  let onRequest: (capture: Capture) => void = (capture) => respondText(capture, "fixture reply");
  const server = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      const command = JSON.parse(body) as WireRequest;
      if (!bots.some((bot) => bot.modelId === command.model)) throw new Error("Unexpected fixture model");
      const capture: Capture = { command, response, aborted: false, released: false };
      response.on("close", () => { if (!capture.released) capture.aborted = true; });
      captures.push(capture);
      onRequest(capture);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Fixture request failed");
      response.writeHead(500).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server unavailable");
  const exportPath = join(source, "exported-skill");
  const executablePath = process.env.AEVOREN_PACKAGED_APP_PATH;
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key, item]) => item !== undefined && !key.startsWith("AEVOREN_BOT_")));
  let application: ElectronApplication;
  const pageErrors: string[] = [];
  const launch = async () => {
    application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : ["."], cwd: process.cwd(), env: {
      ...environment, AEVOREN_BOT_FAKE_PROVIDER: "0", AEVOREN_BOT_USER_DATA_DIR: data, AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_DISABLE_UPDATES: "1",
      AEVOREN_BOT_LIBRARY_EXPORT_TEST_PATH: exportPath,
    } });
    if (executablePath) expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
    const page = await application.firstWindow();
    page.on("pageerror", error => pageErrors.push(error.message));
    await expect(page.locator(".app-shell")).toBeVisible();
    await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { aevorenBot?: AevorenBotApi }).aevorenBot))).toBe(true);
    return page;
  };
  let fixture: LibraryFixture | undefined;
  try {
    const page = await launch();
    await page.evaluate(async (baseUrl) => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const listed = await api.providers.list();
      if (!listed.ok) throw new Error(listed.error.code);
      const provider = listed.data.find(item => item.id === "openai-compatible.default");
      if (!provider) throw new Error("API source unavailable");
      const saved = await api.providers.saveOpenAiCompatible({ instanceId: provider.id, expectedVersion: provider.version, baseUrl, apiKey: "library-fixture-token" });
      if (!saved.ok) throw new Error(saved.error.code);
    }, `http://127.0.0.1:${address.port}/v1`);
    fixture = { page, application: application!, data, workspace: { id: registration.workspace.id, path: source }, exportPath, bots,
      room: { id: room.room.id, name: room.room.name, sessionId: room.session.id }, captures,
      respond(callback) { onRequest = callback; },
      async restart() {
        await application.close();
        fixture!.page = await launch();
        fixture!.application = application;
      },
    };
    await callback(fixture);
    expect(errors).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(await application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible()))).toBe(false);
  } finally {
    server.closeAllConnections();
    if (application!) await application.close().catch(() => application.process().kill("SIGKILL"));
    await new Promise<void>(resolve => server.close(() => resolve()));
    removeTestDirectory(data);
  }
}

async function selectBot(page: Page, bot: FixtureBot): Promise<void> {
  await page.getByRole("listitem", { name: bot.name, exact: true }).click();
  await expect(page.getByRole("heading", { name: bot.name, exact: true })).toBeVisible();
}

async function sessionSnapshot(page: Page, sessionId: string): Promise<SessionRuntimeSnapshot> {
  return value(await page.evaluate(async id => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.runtime.getSessionSnapshot(id), sessionId));
}

async function roomSnapshot(f: LibraryFixture): Promise<RoomRuntimeSnapshot> {
  return value(await f.page.evaluate(async id => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.roomRuntime.getSnapshot(id), f.room.id));
}

async function captureEvidence(page: Page, name: string): Promise<void> {
  if (process.platform === "win32") return;
  const evidence = process.env.AEVOREN_PRODUCT_EVIDENCE_DIR ?? join(tmpdir(), "aevoren-library-evidence");
  mkdirSync(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, name), animations: "disabled" });
}

test("delayed resource opening preserves the later contact selection and existing chat draft", async () => {
  test.setTimeout(90_000);
  await withLibrary(async f => {
    const source = f.bots[0]!;
    const later = f.bots[1]!;
    const existing = f.bots[2]!;
    value(await libraryCall<LibraryContent>(f.page, "create", { sessionId: source.sessionId, kind: "document", name: "迟到引用资料", body: "DELAYED_RESOURCE_BODY" }));
    await selectBot(f.page, existing);
    await f.page.getByLabel("消息", { exact: true }).fill("EXISTING_CHAT_DRAFT_MUST_REMAIN");
    await f.page.getByRole("tab", { name: "联系人", exact: true }).click();
    await f.page.getByRole("listitem", { name: source.name, exact: true }).click();
    const contact = f.page.getByRole("main", { name: "联系人资料", exact: true });
    await contact.getByRole("tab", { name: "资料库", exact: true }).click();
    const panel = contact.getByRole("region", { name: "资料库", exact: true });
    await panel.getByRole("button", { name: "迟到引用资料", exact: false }).click();
    await holdLibraryIpc(f.application, IPC.runtimeGetSessionSnapshot, source.sessionId);
    try {
      await panel.getByRole("button", { name: "引用到消息", exact: true }).click();
      await expect.poll(() => f.application.evaluate(() => Boolean((globalThis as DelayedLibraryMain).libraryDelay?.entered))).toBe(true);
      await f.page.getByRole("listitem", { name: later.name, exact: true }).click();
      await expect(contact.getByRole("heading", { name: later.name, exact: true })).toBeVisible();
      await releaseLibraryIpc(f.application);
      await expect.poll(() => f.application.evaluate(() => Boolean((globalThis as DelayedLibraryMain).libraryDelay?.returned))).toBe(true);
      await expect.poll(() => f.page.evaluate(() => sessionStorage.getItem("aevoren-bot:selected"))).toBe(`bot:${source.id}`);
      await settleLibraryView(f.page);
      await expect(contact.getByRole("heading", { name: later.name, exact: true })).toBeVisible();
      await f.page.getByRole("tab", { name: "聊天", exact: true }).click();
      await selectBot(f.page, existing);
      await expect(f.page.getByLabel("消息", { exact: true })).toHaveValue("EXISTING_CHAT_DRAFT_MUST_REMAIN");
      await expect(f.page.getByLabel("已引用的资源", { exact: true })).toHaveCount(0);
    } finally { await releaseLibraryIpc(f.application); }
  });
});

test("cancelled resource navigation stays cancelled after its real save completes", async () => {
  test.setTimeout(90_000);
  await withLibrary(async f => {
    const bot = f.bots[0]!;
    const first = value(await libraryCall<LibraryContent>(f.page, "create", { sessionId: bot.sessionId, kind: "document", name: "保存中的资料 A", body: "NAVIGATION_SAVED_A" }));
    value(await libraryCall<LibraryContent>(f.page, "create", { sessionId: bot.sessionId, kind: "document", name: "另一份资料 B", body: "NAVIGATION_UNTOUCHED_B" }));
    await selectBot(f.page, bot);
    await openInspector(f.page);
    await f.page.getByRole("main", { name: "联系人资料", exact: true }).getByRole("tab", { name: "资料库", exact: true }).click();
    const panel = f.page.getByRole("region", { name: "资料库", exact: true });
    await panel.getByRole("button", { name: "保存中的资料 A", exact: false }).click();
    await panel.getByLabel("资料正文", { exact: true }).fill("NAVIGATION_USER_SAVED_A");
    await panel.getByRole("button", { name: "另一份资料 B", exact: false }).click();
    await holdLibraryIpc(f.application, LIBRARY_CHANNELS.update, first.resource.id);
    try {
      await panel.getByRole("button", { name: "保存并继续", exact: true }).click();
      await expect.poll(() => f.application.evaluate(() => Boolean((globalThis as DelayedLibraryMain).libraryDelay?.entered))).toBe(true);
      await panel.getByRole("button", { name: "继续编辑", exact: true }).click();
      await releaseLibraryIpc(f.application);
      await expect.poll(() => f.application.evaluate(() => Boolean((globalThis as DelayedLibraryMain).libraryDelay?.returned))).toBe(true);
      await settleLibraryView(f.page);
      await expect(panel.getByLabel("资料正文", { exact: true })).toHaveValue("NAVIGATION_USER_SAVED_A");
      const saved = value(await libraryCall<LibraryContent>(f.page, "read", { sessionId: bot.sessionId, id: first.resource.id }));
      expect(saved.revision.body).toBe("NAVIGATION_USER_SAVED_A");
      expect(saved.resource.version).toBe(2);
    } finally { await releaseLibraryIpc(f.application); }
  });
});

test("edits documents through the UI, preserves conflicting drafts and restores a saved version", async () => {
  test.setTimeout(90_000);
  await withLibrary(async f => {
    const bot = f.bots[0]!;
    await selectBot(f.page, bot);
    await openInspector(f.page);
    await f.page.getByRole("main", { name: "联系人资料", exact: true }).getByRole("tab", { name: "资料库", exact: true }).click();
    const panel = f.page.getByRole("region", { name: "资料库", exact: true });
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "新建资料", exact: true }).click();
    await panel.getByLabel("资料名称", { exact: true }).fill("冲突保留测试");
    await panel.getByLabel("资料正文", { exact: true }).fill("LIBRARY_SAVED_V1");
    await panel.getByRole("button", { name: "保存资料", exact: true }).click();
    await expect(panel.getByRole("button", { name: "保存资料", exact: true })).toBeDisabled();
    const content = value(await libraryCall<LibraryContent>(f.page, "read", { sessionId: bot.sessionId, id: value(await libraryCall<LibraryResource[]>(f.page, "list", { sessionId: bot.sessionId }))[0]!.id }));
    await panel.getByLabel("资料正文", { exact: true }).fill("LIBRARY_LOCAL_UNSAVED_DRAFT");
    value(await libraryCall<LibraryContent>(f.page, "update", { sessionId: bot.sessionId, id: content.resource.id, expectedVersion: content.resource.version, body: "LIBRARY_EXTERNAL_V2" }));
    await panel.getByRole("button", { name: "保存资料", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("当前草稿");
    await expect(panel.getByLabel("资料正文", { exact: true })).toHaveValue("LIBRARY_LOCAL_UNSAVED_DRAFT");
    await captureEvidence(f.page, "library-document-conflict-draft.png");
    await panel.getByRole("button", { name: "读取最新版本，保留草稿", exact: true }).click();
    await expect(panel.getByLabel("资料正文", { exact: true })).toHaveValue("LIBRARY_LOCAL_UNSAVED_DRAFT");
    await panel.getByRole("button", { name: "丢弃草稿", exact: true }).click();
    await panel.getByRole("button", { name: "确认", exact: true }).click();
    await expect(panel.getByLabel("资料正文", { exact: true })).toHaveValue("LIBRARY_EXTERNAL_V2");
    await panel.getByRole("button", { name: "版本记录", exact: true }).click();
    const versions = panel.getByRole("region", { name: "资源版本记录", exact: true });
    await expect(versions).toBeVisible();
    await versions.getByRole("button", { name: "恢复此版本", exact: true }).filter({ visible: true }).last().click();
    await panel.getByRole("button", { name: "确认", exact: true }).click();
    await expect(panel.getByLabel("资料正文", { exact: true })).toHaveValue("LIBRARY_SAVED_V1");
    const restored = value(await libraryCall<LibraryContent>(f.page, "read", { sessionId: bot.sessionId, id: content.resource.id }));
    expect(restored.resource.version).toBe(3);
    expect(value(await libraryCall<ResourceRevisionSummary[]>(f.page, "versions", { sessionId: bot.sessionId, id: content.resource.id }))).toHaveLength(3);
    await captureEvidence(f.page, "library-document-restored.png");
  });
});

test("selects /Skill and @document through the group composer, retains its draft and sends both pinned references without changing Bot routing", async () => {
  test.setTimeout(90_000);
  await withLibrary(async f => {
    const skill = value(await libraryCall<LibraryContent>(f.page, "create", { sessionId: f.room.sessionId, kind: "skill", name: "快捷 Skill", body: "UI_SLASH_SKILL_ORIGINAL" }));
    const document = value(await libraryCall<LibraryContent>(f.page, "create", { sessionId: f.room.sessionId, kind: "document", name: "快捷资料", body: "UI_AT_DOCUMENT_ORIGINAL" }));
    await f.page.getByRole("listitem", { name: f.room.name, exact: true }).click();
    await expect(f.page.getByRole("heading", { name: f.room.name, exact: true })).toBeVisible();
    const input = f.page.getByLabel("消息", { exact: true });
    const draft = "保留这段既有用户草稿。";
    await input.fill(`${draft} /`);
    const skillPicker = f.page.locator('[aria-label="选择当前会话Skill"]');
    await expect(skillPicker).toBeVisible();
    await skillPicker.locator(`[data-library-option="${skill.resource.id}"]`).click();
    await expect(f.page.getByRole("button", { name: "移除资源 Skill：快捷 Skill · v1", exact: true })).toBeVisible();
    expect((await input.inputValue()).trim()).toBe(draft);
    expect(f.captures).toEqual([]);
    await input.fill(`${draft} @`);
    await f.page.getByRole("group", { name: "提及类型", exact: true }).getByRole("button", { name: "资料", exact: true }).click();
    const documentPicker = f.page.locator('[aria-label="选择当前会话资料"]');
    await expect(documentPicker).toBeVisible();
    await documentPicker.locator(`[data-library-option="${document.resource.id}"]`).click();
    await expect(f.page.getByRole("button", { name: "移除资源 资料：快捷资料 · v1", exact: true })).toBeVisible();
    expect((await input.inputValue()).trim()).toBe(draft);
    await expect(f.page.getByRole("button", { name: /^移除 @/u })).toHaveCount(0);
    expect(f.captures).toEqual([]);
    // Choose the actual Bot route only after selecting both resource types.
    await input.fill(`${draft} @`);
    await f.page.getByRole("group", { name: "提及类型", exact: true }).getByRole("button", { name: "Bot", exact: true }).click();
    await f.page.getByRole("listbox", { name: "提及 Bot", exact: true }).getByRole("option").filter({ hasText: "所有人" }).click();
    await expect(f.page.getByRole("button", { name: "移除 @所有人", exact: true })).toBeVisible();
    expect((await input.inputValue()).trim()).toBe(draft);
    await captureEvidence(f.page, "library-slash-at-chips-draft.png");
    value(await libraryCall(f.page, "update", { sessionId: f.room.sessionId, id: skill.resource.id, expectedVersion: 1, body: "UI_SLASH_SKILL_CHANGED_LATER" }));
    value(await libraryCall(f.page, "update", { sessionId: f.room.sessionId, id: document.resource.id, expectedVersion: 1, body: "UI_AT_DOCUMENT_CHANGED_LATER" }));
    f.respond(() => undefined);
    await f.page.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(() => f.captures.length, { timeout: 15_000 }).toBe(6);
    const active = await roomSnapshot(f);
    expect(active.entries.find(entry => entry.role === "user")?.resourceRefs).toEqual([skill.reference, document.reference]);
    expect(active.batches[0]?.routingMode).toBe("everyone");
    expect(active.turns.map(turn => turn.memberBotId).toSorted()).toEqual(f.bots.slice(0, 6).map(bot => bot.id).toSorted());
    for (const capture of f.captures) {
      const prompt = JSON.stringify(capture.command.messages);
      expect(prompt).toContain("UI_SLASH_SKILL_ORIGINAL");
      expect(prompt).toContain("UI_AT_DOCUMENT_ORIGINAL");
      expect(prompt).not.toContain("UI_SLASH_SKILL_CHANGED_LATER");
      expect(prompt).not.toContain("UI_AT_DOCUMENT_CHANGED_LATER");
      respondText(capture, `fixture reference reply ${capture.command.model}`);
    }
    await expect.poll(async () => (await roomSnapshot(f)).batches[0]?.state).toBe("completed");
    await expect(f.page.locator('[aria-label="消息资源引用"] .message-attachment')).toContainText(["Skill：快捷 Skill · v1", "资料：快捷资料 · v1"]);
    await captureEvidence(f.page, "library-slash-at-message-refs.png");
  });
});

test("sends immutable resource references through real IPC/API transport and keeps other sessions isolated", async () => {
  test.setTimeout(90_000);
  await withLibrary(async f => {
    const bot = f.bots[0]!;
    const other = f.bots[6]!;
    const content = value(await libraryCall<LibraryContent>(f.page, "create", { sessionId: bot.sessionId, kind: "document", name: "固定版本资料", body: "LIBRARY_PINNED_ORIGINAL" }));
    const updated = value(await libraryCall<LibraryContent>(f.page, "update", { sessionId: bot.sessionId, id: content.resource.id, expectedVersion: 1, body: "LIBRARY_CHANGED_AFTER_REFERENCE" }));
    const refused = await libraryCall<LibraryContent>(f.page, "read", { sessionId: other.sessionId, id: content.resource.id });
    expect(refused.ok).toBe(false);
    expect(value(await libraryCall<LibraryResource[]>(f.page, "list", { sessionId: other.sessionId }))).toEqual([]);
    const nonce = crypto.randomUUID();
    const sent = await f.page.evaluate(async input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.messages.send(input), {
      sessionId: bot.sessionId, clientNonce: nonce, text: "检查这份固定版本资料。", resourceRefs: [content.reference],
    });
    const result = value(sent);
    await expect.poll(() => f.captures.length).toBe(1);
    const prompt = JSON.stringify(f.captures[0]!.command.messages);
    expect(prompt).toContain("LIBRARY_PINNED_ORIGINAL");
    expect(prompt).not.toContain("LIBRARY_CHANGED_AFTER_REFERENCE");
    await expect.poll(async () => (await sessionSnapshot(f.page, bot.sessionId)).runs.find(run => run.id === result.runId)?.state).toBe("completed");
    const snapshot = await sessionSnapshot(f.page, bot.sessionId);
    expect(snapshot.entries.find(entry => entry.role === "user")?.resourceRefs).toEqual([content.reference]);
    expect(JSON.stringify(snapshot.runs.find(run => run.id === result.runId)?.promptManifest)).toContain(content.reference.digest);
    const conflict = await f.page.evaluate(async input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.messages.send(input), {
      sessionId: bot.sessionId, clientNonce: nonce, text: "检查这份固定版本资料。", resourceRefs: [updated.reference],
    });
    expect(conflict.ok).toBe(false);
    expect(f.captures).toHaveLength(1);
    value(await libraryCall(f.page, "bind", { sessionId: other.sessionId, id: content.resource.id }));
    expect(value(await libraryCall<LibraryContent>(f.page, "read", { sessionId: other.sessionId, id: content.resource.id })).revision.id).toBe(updated.revision.id);
    value(await libraryCall(f.page, "unbind", { sessionId: other.sessionId, id: content.resource.id }));
    expect((await libraryCall(f.page, "read", { sessionId: other.sessionId, id: content.resource.id })).ok).toBe(false);
  });
});

test("uses the same pinned resource in all six parallel group prompts and cancellation preserves its saved version", async () => {
  test.setTimeout(90_000);
  await withLibrary(async f => {
    const owner = f.bots[0]!;
    const content = value(await libraryCall<LibraryContent>(f.page, "create", { sessionId: owner.sessionId, kind: "document", name: "群授权资料", body: "LIBRARY_GROUP_ORIGINAL" }));
    const initial = await f.page.evaluate(async input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.roomRuntime.send(input), {
      roomId: f.room.id, sessionId: f.room.sessionId, clientNonce: crypto.randomUUID(), text: "检查资料", targetBotIds: f.bots.slice(0, 6).map(bot => bot.id), routingMode: "everyone" as const, resourceRefs: [content.reference],
    });
    expect(initial.ok).toBe(false);
    expect(f.captures).toEqual([]);
    value(await libraryCall(f.page, "bind", { sessionId: f.room.sessionId, id: content.resource.id }));
    f.respond(() => undefined);
    const sent = value(await f.page.evaluate(async input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.roomRuntime.send(input), {
      roomId: f.room.id, sessionId: f.room.sessionId, clientNonce: crypto.randomUUID(), text: "所有成员分别检查此版本资料", targetBotIds: f.bots.slice(0, 6).map(bot => bot.id), routingMode: "everyone" as const, resourceRefs: [content.reference],
    }));
    await expect.poll(() => f.captures.length, { timeout: 15_000 }).toBe(6);
    expect(f.captures.every(capture => !capture.released)).toBe(true);
    for (const bot of f.bots.slice(0, 6)) {
      const capture = f.captures.find(item => item.command.model === bot.modelId)!;
      const prompt = JSON.stringify(capture.command.messages);
      expect(prompt).toContain("LIBRARY_GROUP_ORIGINAL");
      expect(prompt).toContain(bot.marker);
      for (const other of f.bots.filter(item => item.id !== bot.id)) expect(prompt).not.toContain(other.marker);
    }
    const active = await roomSnapshot(f);
    expect(active.turns.filter(turn => turn.state === "running")).toHaveLength(6);
    expect(active.runs).toHaveLength(6);
    expect(active.runs.every(run => JSON.stringify(run.promptManifest).includes(content.reference.digest))).toBe(true);
    const updated = value(await libraryCall<LibraryContent>(f.page, "update", { sessionId: owner.sessionId, id: content.resource.id, expectedVersion: 1, body: "LIBRARY_GROUP_NEW_CURRENT" }));
    value(await f.page.evaluate(async id => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.roomRuntime.cancel(id), sent.batchId));
    await expect.poll(() => f.captures.filter(capture => capture.aborted).length).toBe(6);
    await expect.poll(async () => (await roomSnapshot(f)).turns.filter(turn => turn.state === "cancelled").length).toBe(6);
    expect(value(await libraryCall<LibraryContent>(f.page, "read", { sessionId: f.room.sessionId, id: content.resource.id })).reference).toEqual(updated.reference);
    expect(value(await libraryCall<LibraryContent>(f.page, "read", { sessionId: f.room.sessionId, id: content.resource.id, revisionId: content.revision.id })).revision.body).toBe("LIBRARY_GROUP_ORIGINAL");
  });
});

test("loads a Skill through the product tool gateway and rejects new loads after disable or unbind", async () => {
  test.setTimeout(90_000);
  await withLibrary(async f => {
    const bot = f.bots[0]!;
    const content = value(await libraryCall<LibraryContent>(f.page, "create", { sessionId: bot.sessionId, kind: "skill", name: "按需 Skill", description: "受控加载验收", body: "LIBRARY_SKILL_LOADED_BODY" }));
    f.respond(capture => {
      if (capture.command.messages.at(-1)?.role === "tool") respondText(capture, "fixture recorded the host tool result");
      else respondTool(capture, "skills.load", { id: content.resource.id, revisionId: content.revision.id });
    });
    const send = async () => value(await f.page.evaluate(async input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.messages.send(input), {
      sessionId: bot.sessionId, clientNonce: crypto.randomUUID(), text: "通过产品工具加载指定 Skill，并报告工具返回状态。",
    }));
    const first = await send();
    await expect.poll(() => f.captures.length).toBe(2);
    expect(JSON.stringify(f.captures[1]!.command.messages.findLast(message => message.role === "tool")?.content)).toContain("LIBRARY_SKILL_LOADED_BODY");
    await expect.poll(async () => (await sessionSnapshot(f.page, bot.sessionId)).runs.find(run => run.id === first.runId)?.state).toBe("completed");
    value(await libraryCall(f.page, "setEnabled", { sessionId: bot.sessionId, id: content.resource.id, expectedVersion: content.resource.version, enabled: false }));
    await send();
    await expect.poll(() => f.captures.length).toBe(4);
    const disabledReply = String(f.captures[3]!.command.messages.findLast(message => message.role === "tool")?.content);
    expect(disabledReply).toContain("LIBRARY_DISABLED");
    expect(disabledReply).not.toContain("LIBRARY_SKILL_LOADED_BODY");
    await expect.poll(async () => (await sessionSnapshot(f.page, bot.sessionId)).runs.filter(run => ["created", "dispatching", "running", "streaming"].includes(run.state)).length).toBe(0);
    value(await libraryCall(f.page, "unbind", { sessionId: bot.sessionId, id: content.resource.id }));
    await send();
    await expect.poll(() => f.captures.length).toBe(6);
    const unboundReply = String(f.captures[5]!.command.messages.findLast(message => message.role === "tool")?.content);
    expect(unboundReply).toContain("LIBRARY_NOT_BOUND");
    expect(unboundReply).not.toContain("LIBRARY_SKILL_LOADED_BODY");
  });
});

test("imports and exports one complete Skill through IPC and keeps bytes available after deleting its original directory and restarting", async () => {
  test.setTimeout(90_000);
  await withLibrary(async f => {
    const bot = f.bots[0]!;
    const source = join(f.workspace.path, "original-skill");
    mkdirSync(join(source, "references"), { recursive: true });
    mkdirSync(join(source, "scripts"), { recursive: true });
    mkdirSync(join(source, "assets"), { recursive: true });
    const script = "#!/bin/sh\ntouch MUST_NOT_EXECUTE\n";
    const binary = Buffer.from([0, 255, 137, 80, 78, 71]);
    writeFileSync(join(source, "SKILL.md"), "---\nname: ipc-owned-skill\ndescription: Reimport all real bytes\nallowed-tools: shell\n---\nLIBRARY_SKILL_PACKAGE_BODY");
    writeFileSync(join(source, "references", "guide.md"), "REFERENCE_PACKAGE_BYTES");
    writeFileSync(join(source, "scripts", "run.sh"), script);
    writeFileSync(join(source, "assets", "sample.png"), binary);
    const imported = value(await libraryCall<LibraryImportResult>(f.page, "importPath", { sessionId: bot.sessionId, kind: "skill", workspaceId: f.workspace.id, path: "original-skill" }));
    expect(imported.imported).toHaveLength(1);
    const content = imported.imported[0]!;
    expect(content.revision.files).toHaveLength(3);
    rmSync(source, { recursive: true });
    await f.restart();
    const restored = value(await libraryCall<LibraryContent>(f.page, "read", { sessionId: bot.sessionId, id: content.resource.id }));
    expect(restored.reference).toEqual(content.reference);
    const exported = value(await libraryCall<LibraryExportResult | null>(f.page, "export", { sessionId: bot.sessionId, id: content.resource.id, revisionId: content.revision.id }));
    expect(exported).not.toBeNull();
    expect(readFileSync(join(exported!.path, "assets", "sample.png"))).toEqual(binary);
    expect(readFileSync(join(exported!.path, "scripts", "run.sh"), "utf8")).toBe(script);
    expect(readFileSync(join(exported!.path, "references", "guide.md"), "utf8")).toBe("REFERENCE_PACKAGE_BYTES");
    const reimported = value(await libraryCall<LibraryImportResult>(f.page, "importPath", { sessionId: bot.sessionId, kind: "skill", workspaceId: f.workspace.id, path: "exported-skill" }));
    expect(reimported.imported[0]!.revision.digest).toBe(content.revision.digest);
    expect(reimported.imported[0]!.revision.files).toEqual(content.revision.files);
  });
});
