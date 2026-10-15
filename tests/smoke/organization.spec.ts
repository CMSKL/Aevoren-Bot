import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { AevorenBotApi, ApiResult, ConversationSummary } from "../../src/shared/contracts";
import type { OrganizationSnapshot } from "../../src/shared/organization-contracts";
import { AppRepository } from "../../src/main/database";
import { closeTestApplication, removeTestDirectory } from "./test-cleanup";

function value<T>(result: ApiResult<T>): T { if (!result.ok) throw new Error(`${result.error.code}: ${result.error.safeMessage}`); return result.data; }
async function organization(page: Page): Promise<OrganizationSnapshot> { return value(await page.evaluate(() => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.organization.snapshot())); }

test("organizes MAIN and TASK rows by session, preserves concurrent edits and restores only the intended default assistant", async () => {
  test.setTimeout(90_000);
  const data = mkdtempSync(join(tmpdir(), "aevoren-organization-ui-")), filename = join(data, "aevoren-bot.sqlite"), repository = new AppRepository(filename);
  const first = repository.createBot(), second = repository.createBot();
  const firstBot = repository.updateBot(first.bot.id, first.bot.version, { name: "整理助手甲" }), secondBot = repository.updateBot(second.bot.id, second.bot.version, { name: "默认助手乙" });
  const privateDocument = repository.library.create({ sessionId: first.session.id, kind: "document", name: "私聊资料", body: "private document remains in the original conversation" });
  const selection = { executorBotId: firstBot.id, memories: [], history: [], workspaces: [], mcp: [], resourceRefs: [], mediaRefs: [], productOperations: [], network: false, clipboard: false };
  const task = (title: string) => repository.tasks.create({ parentSessionId: first.session.id, expectedScopeVersion: repository.tasks.scopeVersion(first.session.id), clientNonce: randomUUID(), title, selections: [selection] });
  const firstTask = task("整理任务甲"), secondTask = task("整理任务乙"); repository.setSetting("memory.capture.enabled", "false", false); repository.close();
  let app: ElectronApplication | undefined, page: Page, completed = false;
  const pageErrors: string[] = [], executablePath = process.env.AEVOREN_PACKAGED_APP_PATH;
  async function launch(): Promise<void> {
    app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : ["."], cwd: process.cwd(), env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key, item]) => item !== undefined && !key.startsWith("AEVOREN_"))),
      AEVOREN_BOT_USER_DATA_DIR: data, AEVOREN_BOT_FAKE_PROVIDER: "1", AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_DISABLE_UPDATES: "1",
    } });
    if (executablePath) expect(await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion() }))).toEqual({ packaged: true, version: JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version });
    page = await app.firstWindow(); page.on("pageerror", error => pageErrors.push(error.message)); await expect(page.locator(".app-shell")).toBeVisible();
  }
  async function close(): Promise<void> { if (!app) return; const owned = app.process(); await closeTestApplication(app); expect({ code: owned.exitCode, signal: owned.signalCode }).toEqual({ code: 0, signal: null }); app = undefined; }
  async function conversations(): Promise<ConversationSummary[]> { return value(await page.evaluate(() => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.conversations.list())); }
  try {
    await launch(); await page!.getByRole("listitem", { name: firstBot.name, exact: true }).click();
    const originalScope = (await conversations()).map(item => ({ id: item.sessionId, workspaceIds: item.workspaceIds, projectId: item.projectId })).sort((left, right) => left.id.localeCompare(right.id));
    await page!.getByRole("button", { name: "整理聊天", exact: true }).click();
    const dialog = (): ReturnType<Page["getByRole"]> => page.getByRole("dialog", { name: "聊天整理与通知", exact: true });
    for (const name of ["研究", "交付"]) { await dialog().getByLabel("新分区名称", { exact: true }).fill(name); await dialog().getByRole("button", { name: "创建分区", exact: true }).click(); await expect(dialog().getByLabel(`分区名称 ${name}`, { exact: true })).toHaveValue(name); }
    let state = await organization(page!); const research = state.sections.find(item => item.name === "研究")!, delivery = state.sections.find(item => item.name === "交付")!;
    await dialog().getByRole("button", { name: "上移分区 交付", exact: true }).click(); await expect.poll(async () => (await organization(page!)).sections.map(item => item.id)).toEqual([delivery.id, research.id]);
    async function move(label: string, sectionName: string): Promise<void> {
      const select = dialog().getByLabel(`移动聊天 ${label}`, { exact: true }), row = dialog().locator(".organization-chat-row").filter({ has: select });
      await select.selectOption({ label: sectionName }); await row.getByRole("button", { name: "保存归属", exact: true }).click(); await expect(row.getByRole("button", { name: "保存归属", exact: true })).toBeDisabled();
    }
    await move(firstBot.name, "研究"); await move(`任务：${firstTask.title}`, "研究"); await move(`任务：${secondTask.title}`, "交付");
    await dialog().getByRole("button", { name: `上移聊天 任务：${firstTask.title}`, exact: true }).click();
    await expect(dialog().getByRole("region", { name: "整理分区 研究", exact: true }).locator(".organization-chat-label strong")).toHaveText([`任务：${firstTask.title}`, firstBot.name]);
    const rejected = await page!.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.library.read(input), { sessionId: firstTask.session.id, id: privateDocument.resource.id });
    expect(rejected).toMatchObject({ ok: false, error: { code: "LIBRARY_NOT_BOUND" } });
    expect((await conversations()).map(item => ({ id: item.sessionId, workspaceIds: item.workspaceIds, projectId: item.projectId })).sort((left, right) => left.id.localeCompare(right.id))).toEqual(originalScope);
    await dialog().getByLabel("默认助理", { exact: true }).selectOption(secondBot.id);
    await dialog().getByLabel("审批请求通知", { exact: true }).uncheck(); await dialog().getByLabel("任务完成通知", { exact: true }).check(); await dialog().getByLabel("任务失败通知", { exact: true }).check(); await dialog().getByLabel("主动服务通知", { exact: true }).uncheck(); await dialog().getByLabel("通知声音", { exact: true }).uncheck();
    await dialog().getByRole("button", { name: "保存偏好", exact: true }).click();
    await expect.poll(async () => (await organization(page!)).preferences).toEqual({ defaultAssistantBotId: secondBot.id, notifications: { approvals: false, taskCompletion: true, taskFailure: true, routines: false }, sound: false });
    await dialog().getByLabel("分区名称 研究", { exact: true }).fill("我的研究草稿"); await dialog().getByLabel("通知声音", { exact: true }).check();
    state = await organization(page!); value(await page!.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.organization.renameSection(input), { id: research.id, expectedVersion: state.version, name: "远端研究名称" }));
    await expect(dialog().getByRole("status")).toContainText("当前编辑已保留"); await expect(dialog().getByLabel("分区名称 研究", { exact: true })).toHaveValue("我的研究草稿"); await expect(dialog().getByLabel("通知声音", { exact: true })).toBeChecked();
    await dialog().getByRole("button", { name: "保存分区 研究", exact: true }).click(); await expect(dialog().getByRole("alert")).toContainText("当前编辑已保留");
    await dialog().getByRole("button", { name: "读取最新版本，保留编辑", exact: true }).first().click(); await expect(dialog().getByLabel("分区名称 远端研究名称", { exact: true })).toHaveValue("我的研究草稿");
    await dialog().getByRole("button", { name: "保存分区 远端研究名称", exact: true }).click(); await expect(dialog().getByLabel("分区名称 我的研究草稿", { exact: true })).toHaveValue("我的研究草稿"); await expect(dialog().getByLabel("通知声音", { exact: true })).toBeChecked(); await dialog().getByLabel("通知声音", { exact: true }).uncheck();
    await dialog().getByRole("button", { name: "完成", exact: true }).click(); await expect(page!.getByRole("heading", { name: firstBot.name, exact: true })).toBeVisible();
    await expect(page!.getByRole("region", { name: "聊天分区 我的研究草稿", exact: true }).getByRole("listitem")).toHaveCount(2);
    await page!.getByRole("listitem", { name: `任务：${firstTask.title}`, exact: true }).click(); await page!.getByLabel("消息", { exact: true }).fill("此任务尚未发送的草稿"); await page!.getByRole("listitem", { name: firstBot.name, exact: true }).click(); await expect(page!.getByLabel("消息", { exact: true })).toHaveValue(""); await page!.getByRole("listitem", { name: `任务：${firstTask.title}`, exact: true }).click(); await expect(page!.getByLabel("消息", { exact: true })).toHaveValue("此任务尚未发送的草稿");
    await page!.reload(); await expect(page!.getByRole("heading", { name: firstTask.title, exact: true })).toBeVisible();
    await page!.evaluate(() => sessionStorage.removeItem("aevoren-bot:selected")); await page!.reload(); await expect(page!.getByRole("heading", { name: secondBot.name, exact: true })).toBeVisible();
    await close(); await launch(); await expect(page!.getByRole("heading", { name: secondBot.name, exact: true })).toBeVisible();
    expect((await organization(page!)).preferences).toEqual({ defaultAssistantBotId: secondBot.id, notifications: { approvals: false, taskCompletion: true, taskFailure: true, routines: false }, sound: false });
    await page!.getByRole("button", { name: "设置", exact: true }).click(); await page!.getByRole("button", { name: "暗黑", exact: true }).click(); await page!.getByRole("button", { name: "聊天整理与通知", exact: true }).click();
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(620, 820));
    expect(await dialog().evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await dialog().getByRole("button", { name: "删除分区 交付", exact: true }).click(); await dialog().getByRole("button", { name: "确认删除分区", exact: true }).click(); await expect.poll(async () => (await organization(page!)).assignments.find(item => item.sessionId === secondTask.session.id)?.sectionId).toBeNull();
    await dialog().getByRole("button", { name: "完成", exact: true }).click(); await page!.getByRole("button", { name: "白昼", exact: true }).click(); await page!.getByRole("button", { name: "聊天整理与通知", exact: true }).click(); expect(await dialog().evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const remainingTasks = value(await page!.evaluate(parentSessionId => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.sessions.listTasks({ parentSessionId }), first.session.id)); expect(remainingTasks.map(item => item.session.id).sort()).toEqual([firstTask.session.id, secondTask.session.id].sort());
    expect(pageErrors).toEqual([]); expect(await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible()))).toBe(false);
    completed = true;
  } finally {
    if (!completed && typeof page! !== "undefined" && !page!.isClosed()) {
      try {
        const diagnostic = await page!.evaluate(async () => {
          const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
          return { organization: await api.organization.snapshot(), conversations: await api.conversations.list(), inputs: [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(".organization-dialog input, .organization-dialog select")].slice(0, 60).map(element => ({ label: element.getAttribute("aria-label"), value: element.value, checked: element instanceof HTMLInputElement ? element.checked : null })) };
        });
        await test.info().attach("controlled-organization-state", { body: JSON.stringify(diagnostic), contentType: "application/json" });
      } catch { /* Keep the original failure if its owned Renderer already exited. */ }
    }
    await close();
    if (!completed) copyFileSync(filename, test.info().outputPath("isolated-organization.sqlite"));
    const inspected = new DatabaseSync(filename, { readOnly: true }); try { expect(inspected.prepare("PRAGMA foreign_key_check").all()).toEqual([]); } finally { inspected.close(); } removeTestDirectory(data);
  }
});
