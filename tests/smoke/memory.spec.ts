import { removeTestDirectory } from "./test-cleanup";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { AevorenBotApi } from "@shared/contracts";

function environment(userDataDir: string): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return { ...inherited, AEVOREN_BOT_USER_DATA_DIR: userDataDir, AEVOREN_BOT_FAKE_PROVIDER: "1" };
}

async function launch(userDataDir: string): Promise<{ application: ElectronApplication; page: Page }> {
  const application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment(userDataDir) });
  return { application, page: await application.firstWindow() };
}

async function createBot(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "新建聊天" }).click();
  await page.getByRole("button", { name: "创建新 Bot" }).click();
  await expect(page.getByLabel("名称")).toHaveValue("新建 Bot");
  await page.getByLabel("名称").fill(name);
  await page.getByLabel("名称").blur();
  await expect(page.getByTestId("profile-save-status")).toContainText("已保存");
}

function selectBot(page: Page, name: string) {
  return page.locator(".bot-row").filter({ hasText: name });
}

async function openAdvancedSettings(page: Page): Promise<void> {
  const details = page.locator("details.inspector-advanced");
  if (!await details.evaluate((element) => (element as HTMLDetailsElement).open)) {
    await details.locator("summary").click();
  }
}

test("creates, flushes, restores and lays out explicit Memory without touching daily data", async () => {
  test.setTimeout(45_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-memory-ui-"));
  let application: ElectronApplication | undefined;
  try {
    let launched = await launch(userDataDir);
    application = launched.application;
    let page = launched.page;
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    await createBot(page, "Memory Bot A");
    await openAdvancedSettings(page);
    const undeclaredFieldResult = await page.evaluate(async () => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const bots = await api.bots.list();
      if (!bots.ok) return bots;
      const bot = bots.data.find((item) => item.name === "Memory Bot A");
      if (!bot) throw new Error("missing Memory Bot A");
      const unsafeCreate = api.memories.create as unknown as (input: unknown) => Promise<unknown>;
      return unsafeCreate({ botId: bot.id, content: "不得写入", autoSynthesize: true });
    });
    expect(undeclaredFieldResult).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", domain: "validation" },
    });
    await page.getByLabel("新增 Memory").fill("默认使用简体中文");
    await page.getByRole("button", { name: "添加 Memory" }).click();
    await expect(page.getByLabel("Memory 1")).toHaveValue("默认使用简体中文");
    await expect(page.getByTestId("memory-status")).toHaveText("已保存");

    await page.getByLabel("Memory 1").fill("默认使用简体中文，并优先给出结论");
    await application.close();
    application = undefined;

    launched = await launch(userDataDir);
    application = launched.application;
    page = launched.page;
    await openAdvancedSettings(page);
    await expect(page.getByLabel("Memory 1")).toHaveValue("默认使用简体中文，并优先给出结论");

    await page.getByRole("button", { name: "删除 Memory" }).click();
    await expect(page.getByLabel("Memory 1")).toHaveCount(0);
    await page.getByRole("button", { name: "显示已删除" }).click();
    await expect(page.getByLabel("Memory 1")).toBeDisabled();
    await page.getByRole("button", { name: "恢复 Memory" }).click();
    await expect(page.getByLabel("Memory 1")).toBeEnabled();

    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(390, 640));
    await page.getByRole("button", { name: "打开 Bot 设置" }).click();
    await expect(page.locator(".inspector")).toBeVisible();
    await openAdvancedSettings(page);
    await page.waitForTimeout(220);
    const compactLayout = await page.locator(".inspector").evaluate((inspector) => {
      const panel = inspector.querySelector<HTMLElement>(".memory-panel");
      if (!(inspector instanceof HTMLElement) || !panel) throw new Error("missing Memory panel");
      const inspectorRect = inspector.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      return {
        inspectorContained: inspectorRect.left >= 0 && inspectorRect.right <= window.innerWidth,
        panelContained: panelRect.left >= inspectorRect.left && panelRect.right <= inspectorRect.right,
        fieldsContained: [...panel.querySelectorAll("textarea, button")].every((control) => {
          const rect = control.getBoundingClientRect();
          return rect.left >= inspectorRect.left && rect.right <= inspectorRect.right;
        }),
        horizontalOverflow: inspector.scrollWidth > inspector.clientWidth,
      };
    });
    expect(compactLayout).toEqual({
      inspectorContained: true,
      panelContained: true,
      fieldsContained: true,
      horizontalOverflow: false,
    });

    await page.getByLabel("Memory 1").fill("关闭详情前保存的已有 Memory");
    await page.getByLabel("新增 Memory").fill("关闭详情前创建的新 Memory");
    await page.getByRole("button", { name: "关闭 Bot 设置" }).click();
    await expect(page.locator(".inspector")).not.toBeVisible();
    await page.getByRole("button", { name: "打开 Bot 设置" }).click();
    await openAdvancedSettings(page);
    await expect(page.getByLabel("Memory 1")).toHaveValue("关闭详情前保存的已有 Memory");
    await expect(page.getByLabel("Memory 2")).toHaveValue("关闭详情前创建的新 Memory");

    const database = new DatabaseSync(join(userDataDir, "aevoren-bot.sqlite"), { readOnly: true });
    expect(database.prepare("SELECT content,deleted_at,source FROM memory_items ORDER BY created_at,id").all()).toEqual([
      { content: "关闭详情前保存的已有 Memory", deleted_at: null, source: "manual-user" },
      { content: "关闭详情前创建的新 Memory", deleted_at: null, source: "manual-user" },
    ]);
    database.close();
    expect(consoleErrors).toEqual([]);
    await application.close();
    application = undefined;
  } finally {
    if (application) application.process().kill("SIGKILL");
    removeTestDirectory(userDataDir);
  }
});

test("blocks Bot switching on a stale Memory version and preserves the draft", async () => {
  test.setTimeout(45_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-memory-conflict-"));
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(userDataDir);
    application = launched.application;
    const page = launched.page;

    await createBot(page, "Memory Bot A");
    await openAdvancedSettings(page);
    await page.getByLabel("新增 Memory").fill("初始事实");
    await page.getByRole("button", { name: "添加 Memory" }).click();
    await createBot(page, "Memory Bot B");
    await selectBot(page, "Memory Bot A").click();
    await expect(page.getByLabel("Memory 1")).toHaveValue("初始事实");

    const externalUpdate = await page.evaluate(async () => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const bots = await api.bots.list();
      if (!bots.ok) return bots;
      const target = bots.data.find((bot) => bot.name === "Memory Bot A");
      if (!target) throw new Error("missing Memory Bot A");
      const listed = await api.memories.list({ botId: target.id });
      if (!listed.ok) return listed;
      return api.memories.update({ id: listed.data[0]!.id, expectedVersion: listed.data[0]!.version, content: "外部更新事实" });
    });
    expect(externalUpdate).toMatchObject({ ok: true, data: { content: "外部更新事实", version: 2 } });

    await openAdvancedSettings(page);
    await page.getByLabel("Memory 1").fill("本地未保存草稿");
    await selectBot(page, "Memory Bot B").click();
    await expect(page.locator(".bot-row.selected")).toContainText("Memory Bot A");
    await expect(page.getByLabel("Memory 1")).toHaveValue("本地未保存草稿");
    await expect(page.getByTestId("memory-status")).toHaveText("保存失败");
    await expect(
      page.getByRole("region", { name: "Memory" }).getByText("Memory 已在别处更新，当前草稿未覆盖新版本。", { exact: true }),
    ).toBeVisible();

    await page.getByRole("button", { name: "重新加载" }).click();
    await expect(page.getByLabel("Memory 1")).toHaveValue("外部更新事实");
    await selectBot(page, "Memory Bot B").click();
    await expect(page.locator(".bot-row.selected")).toContainText("Memory Bot B");
    await application.close();
    application = undefined;
  } finally {
    if (application) application.process().kill("SIGKILL");
    removeTestDirectory(userDataDir);
  }
});
