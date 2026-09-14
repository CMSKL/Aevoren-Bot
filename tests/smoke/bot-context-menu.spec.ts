import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { AppRepository } from "../../src/main/database";

function environment(userDataDir: string, overrides: Record<string, string> = {}): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return { ...inherited, MS_BOT_USER_DATA_DIR: userDataDir, MS_BOT_FAKE_PROVIDER: "1", ...overrides };
}

async function launch(userDataDir: string, overrides: Record<string, string> = {}): Promise<{ application: ElectronApplication; page: Page }> {
  const application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment(userDataDir, overrides) });
  return { application, page: await application.firstWindow() };
}

function row(page: Page, name: string): Locator {
  return page.locator(`.bot-row[aria-label="${name}"]`);
}

async function menuFor(page: Page, name: string): Promise<Locator> {
  await row(page, name).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Bot 操作" });
  await expect(menu).toBeVisible();
  return menu;
}

test("supports Grok-style Bot context actions and restores their sidebar state", async () => {
  test.setTimeout(75_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "ms-bot-context-menu-"));
  let application: ElectronApplication | undefined;
  try {
    const repository = new AppRepository(join(userDataDir, "ms-bot.sqlite"));
    const alphaCreated = repository.createBot();
    repository.updateBot(alphaCreated.bot.id, alphaCreated.bot.version, { name: "Alpha", label: "研究" });
    const betaCreated = repository.createBot();
    repository.updateBot(betaCreated.bot.id, betaCreated.bot.version, { name: "Beta", description: "需要复制的资料" });
    const gammaCreated = repository.createBot();
    repository.updateBot(gammaCreated.bot.id, gammaCreated.bot.version, { name: "Gamma" });
    repository.close();

    let launched = await launch(userDataDir);
    application = launched.application;
    let page = launched.page;
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1040, 707));
    await expect(page.getByRole("heading", { name: "Alpha" })).toBeVisible();

    let menu = await menuFor(page, "Alpha");
    await expect(menu.getByRole("menuitem")).toHaveText([
      "置顶",
      "标为未读",
      "重命名 Bot",
      "编辑资料",
      "创建副本",
      "复制对话 ID",
      "从侧边栏隐藏",
      "删除",
    ]);
    await page.screenshot({ path: "/tmp/msbot-bot-context-menu.png", fullPage: true });
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem").nth(1)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(row(page, "Alpha")).toBeFocused();

    await row(page, "Beta").focus();
    await page.keyboard.press("Shift+F10");
    await expect(page.getByRole("menu", { name: "Bot 操作" })).toBeVisible();
    await page.keyboard.press("Escape");

    menu = await menuFor(page, "Gamma");
    await menu.getByRole("menuitem", { name: "置顶", exact: true }).click();
    await expect(page.locator('.bot-row[aria-haspopup="menu"]').first()).toHaveAttribute("aria-label", "Gamma");
    await expect(page.getByRole("status")).toHaveText("Bot 已置顶。");

    menu = await menuFor(page, "Alpha");
    await menu.getByRole("menuitem", { name: "标为未读" }).click();
    await expect(row(page, "Alpha").locator(".bot-row-state i")).toHaveCount(1);
    menu = await menuFor(page, "Alpha");
    await expect(menu.getByRole("menuitem", { name: "标为已读" })).toBeVisible();
    await menu.getByRole("menuitem", { name: "置顶", exact: true }).click();

    menu = await menuFor(page, "Alpha");
    await menu.getByRole("menuitem", { name: "重命名 Bot" }).click();
    const rename = page.getByLabel("重命名 Bot");
    await expect(rename).toBeFocused();
    await rename.fill("  研究   助手  ");
    await rename.press("Enter");
    await expect(row(page, "研究 助手")).toBeVisible();
    await expect(page.getByRole("heading", { name: "研究 助手" })).toBeVisible();

    menu = await menuFor(page, "Beta");
    await menu.getByRole("menuitem", { name: "编辑资料" }).click();
    await expect(page.getByRole("heading", { name: "Beta" })).toBeVisible();
    await expect(page.getByLabel("名称")).toBeFocused();

    menu = await menuFor(page, "Beta");
    await menu.getByRole("menuitem", { name: "创建副本" }).click();
    await expect(page.getByRole("heading", { name: "Beta 副本" })).toBeVisible();
    await expect(page.getByLabel("描述")).toHaveValue("需要复制的资料");
    const duplicateId = (() => {
      const database = new DatabaseSync(join(userDataDir, "ms-bot.sqlite"), { readOnly: true });
      try {
        return (database.prepare("SELECT id FROM bots WHERE name = 'Beta 副本' AND deleted_at IS NULL").get() as { id: string }).id;
      } finally {
        database.close();
      }
    })();

    menu = await menuFor(page, "Beta 副本");
    await menu.getByRole("menuitem", { name: "复制对话 ID" }).click();
    await expect.poll(() => application!.evaluate(({ clipboard }) => clipboard.readText())).toBe(duplicateId);

    menu = await menuFor(page, "Beta 副本");
    await menu.getByRole("menuitem", { name: "从侧边栏隐藏" }).click();
    await expect(row(page, "Beta 副本")).toHaveCount(0);
    await page.getByRole("button", { name: "已隐藏 (1)" }).click();
    await expect(row(page, "Beta 副本")).toBeVisible();
    menu = await menuFor(page, "Beta 副本");
    await expect(menu.getByRole("menuitem", { name: "恢复到侧边栏" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "置顶", exact: true })).toHaveCount(0);
    await menu.getByRole("menuitem", { name: "恢复到侧边栏" }).click();
    await expect(page.getByRole("button", { name: "已隐藏 (1)" })).toHaveCount(0);

    menu = await menuFor(page, "Gamma");
    await menu.getByRole("menuitem", { name: "删除" }).click();
    const deleteDialog = page.getByRole("alertdialog");
    await expect(deleteDialog).toContainText("删除“Gamma”？");
    await expect(deleteDialog.getByRole("button", { name: "取消" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(deleteDialog.getByRole("button", { name: "删除", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(deleteDialog.getByRole("button", { name: "取消" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(deleteDialog).toBeHidden();
    await expect(row(page, "Gamma")).toBeVisible();

    menu = await menuFor(page, "Gamma");
    await menu.getByRole("menuitem", { name: "删除" }).click();
    await deleteDialog.getByRole("button", { name: "删除", exact: true }).click();
    await expect(row(page, "Gamma")).toHaveCount(0);
    const deleted = (() => {
      const database = new DatabaseSync(join(userDataDir, "ms-bot.sqlite"), { readOnly: true });
      try {
        return database.prepare("SELECT name, deleted_at FROM bots WHERE id = ?").get(gammaCreated.bot.id) as {
          name: string;
          deleted_at: string | null;
        };
      } finally {
        database.close();
      }
    })();
    expect(deleted).toMatchObject({ name: "已删除 Bot", deleted_at: expect.any(String) });

    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(390, 844));
    await page.getByRole("button", { name: "打开 Bot 列表" }).click();
    menu = await menuFor(page, "研究 助手");
    const bounds = await menu.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(8);
    expect(bounds!.y).toBeGreaterThanOrEqual(8);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(382);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(836);
    await page.keyboard.press("Escape");

    await application.close();
    application = undefined;
    launched = await launch(userDataDir);
    application = launched.application;
    page = launched.page;
    await expect(row(page, "研究 助手").locator(".bot-row-state svg")).toHaveCount(1);
    await expect(row(page, "研究 助手").locator(".bot-row-state i")).toHaveCount(1);
    await expect(row(page, "Beta 副本")).toBeVisible();
    await expect(row(page, "Gamma")).toHaveCount(0);
    await application.close();
    application = undefined;
  } finally {
    if (application) application.process().kill("SIGKILL");
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("keeps the delete confirmation open when the Bot is running", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "ms-bot-context-delete-busy-"));
  let application: ElectronApplication | undefined;
  try {
    const repository = new AppRepository(join(userDataDir, "ms-bot.sqlite"));
    const created = repository.createBot();
    repository.updateBot(created.bot.id, created.bot.version, { name: "运行中的 Bot" });
    repository.close();

    const launched = await launch(userDataDir, { MS_BOT_FAKE_START_DELAY_MS: "5000" });
    application = launched.application;
    const page = launched.page;
    await page.getByLabel("消息").fill("保持运行");
    await page.getByRole("button", { name: "发送" }).click();
    await expect(page.getByRole("button", { name: "停止回复" })).toBeVisible();

    const menu = await menuFor(page, "运行中的 Bot");
    await menu.getByRole("menuitem", { name: "删除" }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "删除", exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(page.getByText("该 Bot 正在运行，暂时不能删除。")).toBeVisible();
    await expect(row(page, "运行中的 Bot")).toBeAttached();
    await dialog.getByRole("button", { name: "取消" }).click();
    await page.getByRole("button", { name: "停止回复" }).click();

    await application.close();
    application = undefined;
  } finally {
    if (application) application.process().kill("SIGKILL");
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("keeps inline rename recoverable when persistence fails", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "ms-bot-context-rename-failure-"));
  let application: ElectronApplication | undefined;
  try {
    const repository = new AppRepository(join(userDataDir, "ms-bot.sqlite"));
    const created = repository.createBot();
    repository.updateBot(created.bot.id, created.bot.version, { name: "可恢复名称" });
    repository.close();

    const launched = await launch(userDataDir);
    application = launched.application;
    const page = launched.page;
    const databasePath = join(userDataDir, "ms-bot.sqlite");
    let database = new DatabaseSync(databasePath);
    database.exec("CREATE TRIGGER reject_context_rename BEFORE UPDATE OF name ON bots BEGIN SELECT RAISE(ABORT, 'rename test'); END;");
    database.close();

    let menu = await menuFor(page, "可恢复名称");
    await menu.getByRole("menuitem", { name: "重命名 Bot" }).click();
    const rename = page.getByLabel("重命名 Bot");
    await rename.fill("重试后的名称");
    await rename.press("Enter");
    await expect(rename).toBeVisible();
    await expect(rename).toHaveValue("重试后的名称");
    await expect(page.getByRole("status")).toHaveText("重命名失败，请重试。");

    database = new DatabaseSync(databasePath);
    database.exec("DROP TRIGGER reject_context_rename;");
    database.close();
    await rename.press("Enter");
    await expect(row(page, "重试后的名称")).toBeVisible();

    menu = await menuFor(page, "重试后的名称");
    await menu.getByRole("menuitem", { name: "重命名 Bot" }).click();
    await page.getByLabel("重命名 Bot").fill("不应保存");
    await page.getByLabel("重命名 Bot").press("Escape");
    await expect(row(page, "重试后的名称")).toBeVisible();
    await expect(row(page, "不应保存")).toHaveCount(0);

    menu = await menuFor(page, "重试后的名称");
    await menu.getByRole("menuitem", { name: "重命名 Bot" }).click();
    await page.getByLabel("重命名 Bot").fill("   ");
    await page.getByLabel("重命名 Bot").press("Enter");
    await expect(row(page, "重试后的名称")).toBeVisible();

    await application.close();
    application = undefined;
  } finally {
    if (application) application.process().kill("SIGKILL");
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
