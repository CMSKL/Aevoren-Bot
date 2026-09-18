import { removeTestDirectory } from "./test-cleanup";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { AppRepository } from "../../src/main/database";

function environment(userDataDir: string, overrides: Record<string, string> = {}): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return { ...inherited, AEVOREN_BOT_USER_DATA_DIR: userDataDir, AEVOREN_BOT_FAKE_PROVIDER: "1", ...overrides };
}

async function launch(userDataDir: string, overrides: Record<string, string> = {}): Promise<{ application: ElectronApplication; page: Page }> {
  const application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment(userDataDir, overrides) });
  return { application, page: await application.firstWindow() };
}

function roomRow(page: Page, name: string): Locator {
  return page.locator(`.bot-row[aria-label="${name}"]`);
}

async function roomMenu(page: Page, name: string): Promise<Locator> {
  await roomRow(page, name).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "群聊操作" });
  await expect(menu).toBeVisible();
  return menu;
}

test("supports the first Grok-style Room context actions without touching the installed app", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-room-context-menu-"));
  let application: ElectronApplication | undefined;
  try {
    const repository = new AppRepository(join(userDataDir, "aevoren-bot.sqlite"));
    const first = repository.createBot();
    const second = repository.createBot();
    repository.createRoom({ memberBotIds: [first.bot.id, second.bot.id], name: "先建群聊" });
    const detail = repository.createRoom({ memberBotIds: [first.bot.id, second.bot.id], name: "产品协作室" });
    repository.close();

    let launched = await launch(userDataDir);
    application = launched.application;
    let page = launched.page;
    await roomRow(page, "产品协作室").click();
    await expect(page.getByRole("heading", { name: "产品协作室" })).toBeVisible();

    let menu = await roomMenu(page, "产品协作室");
    await expect(menu.getByRole("menuitem")).toHaveText(["置顶", "标为未读", "重命名聊天", "复制对话 ID", "从侧边栏隐藏", "归档群聊", "删除"]);
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(roomRow(page, "产品协作室")).toBeFocused();

    await roomRow(page, "产品协作室").focus();
    await page.keyboard.press("Shift+F10");
    await expect(page.getByRole("menu", { name: "群聊操作" })).toBeVisible();
    await page.keyboard.press("Escape");

    menu = await roomMenu(page, "产品协作室");
    await menu.getByRole("menuitem", { name: "置顶", exact: true }).click();
    await expect(page.locator('.bot-list .bot-row[aria-haspopup="menu"]').first()).toHaveAttribute("aria-label", "产品协作室");
    await expect(page.getByRole("status")).toHaveText("群聊已置顶。");

    menu = await roomMenu(page, "产品协作室");
    await menu.getByRole("menuitem", { name: "标为未读" }).click();
    await expect(roomRow(page, "产品协作室").locator(".bot-row-state i")).toHaveCount(1);
    menu = await roomMenu(page, "产品协作室");
    await expect(menu.getByRole("menuitem", { name: "标为已读" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "取消置顶" })).toBeVisible();
    await page.keyboard.press("Escape");

    menu = await roomMenu(page, "产品协作室");
    await menu.getByRole("menuitem", { name: "重命名聊天" }).click();
    const rename = page.getByLabel("重命名聊天");
    await expect(rename).toBeFocused();
    await rename.fill("  新   协作室  ");
    await rename.press("Enter");
    await expect(roomRow(page, "新 协作室")).toBeVisible();
    await expect(page.getByRole("heading", { name: "新 协作室" })).toBeVisible();

    menu = await roomMenu(page, "新 协作室");
    await menu.getByRole("menuitem", { name: "复制对话 ID" }).click();
    await expect.poll(() => application!.evaluate(({ clipboard }) => clipboard.readText())).toBe(detail.room.id);

    menu = await roomMenu(page, "新 协作室");
    await menu.getByRole("menuitem", { name: "归档群聊" }).click();
    await expect(roomRow(page, "新 协作室")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "已归档 (1)" })).toBeVisible();
    await page.getByRole("button", { name: "已归档 (1)" }).click();
    await expect(page.getByText("新 协作室", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "恢复", exact: true }).click();
    await expect(page.getByRole("heading", { name: "新 协作室" })).toBeVisible();

    await application.close();
    application = undefined;
    launched = await launch(userDataDir);
    application = launched.application;
    page = launched.page;
    await expect(roomRow(page, "新 协作室")).toBeVisible();
    await expect(roomRow(page, "新 协作室").locator(".bot-row-state svg")).toHaveCount(1);
    await expect(roomRow(page, "新 协作室").locator(".bot-row-state i")).toHaveCount(1);
    menu = await roomMenu(page, "新 协作室");
    await menu.getByRole("menuitem", { name: "标为已读" }).click();
    await expect(roomRow(page, "新 协作室").locator(".bot-row-state i")).toHaveCount(0);
    menu = await roomMenu(page, "新 协作室");
    await menu.getByRole("menuitem", { name: "取消置顶" }).click();
    await expect(page.locator('.bot-list .bot-row[aria-haspopup="menu"]').first()).toHaveAttribute("aria-label", "先建群聊");

    menu = await roomMenu(page, "新 协作室");
    await menu.getByRole("menuitem", { name: "从侧边栏隐藏" }).click();
    await expect(roomRow(page, "新 协作室")).toHaveCount(0);
    await application.close();
    application = undefined;
    launched = await launch(userDataDir);
    application = launched.application;
    page = launched.page;
    await expect(page.getByRole("button", { name: "已隐藏 (1)" })).toBeVisible();
    await page.getByRole("button", { name: "已隐藏 (1)" }).click();
    await expect(roomRow(page, "新 协作室")).toBeVisible();
    menu = await roomMenu(page, "新 协作室");
    await expect(menu.getByRole("menuitem", { name: "恢复到侧边栏" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "置顶", exact: true })).toHaveCount(0);
    await menu.getByRole("menuitem", { name: "恢复到侧边栏" }).click();
    await expect(page.getByRole("button", { name: "已隐藏 (1)" })).toHaveCount(0);
    await expect(roomRow(page, "新 协作室")).toBeVisible();

    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(390, 844));
    await page.getByRole("button", { name: "打开 Bot 列表" }).click();
    menu = await roomMenu(page, "新 协作室");
    const bounds = await menu.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(8);
    expect(bounds!.y).toBeGreaterThanOrEqual(8);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(382);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(836);
    await page.keyboard.press("Escape");

    const database = new DatabaseSync(join(userDataDir, "aevoren-bot.sqlite"), { readOnly: true });
    expect(database.prepare("SELECT name, archived_at, pinned_at, hidden_at, has_unread FROM rooms WHERE id = ?").get(detail.room.id)).toEqual({
      name: "新 协作室",
      archived_at: null,
      pinned_at: null,
      hidden_at: null,
      has_unread: 0,
    });
    database.close();
  } finally {
    if (application) application.process().kill("SIGKILL");
    removeTestDirectory(userDataDir);
  }
});

test("keeps Room inline rename recoverable when persistence fails", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-room-context-rename-failure-"));
  let application: ElectronApplication | undefined;
  try {
    const repository = new AppRepository(join(userDataDir, "aevoren-bot.sqlite"));
    const first = repository.createBot();
    const second = repository.createBot();
    repository.createRoom({ memberBotIds: [first.bot.id, second.bot.id], name: "可恢复群聊" });
    repository.close();

    const launched = await launch(userDataDir);
    application = launched.application;
    const page = launched.page;
    const databasePath = join(userDataDir, "aevoren-bot.sqlite");
    let database = new DatabaseSync(databasePath);
    database.exec("CREATE TRIGGER reject_room_context_rename BEFORE UPDATE OF name ON rooms BEGIN SELECT RAISE(ABORT, 'rename test'); END;");
    database.close();

    let menu = await roomMenu(page, "可恢复群聊");
    await menu.getByRole("menuitem", { name: "重命名聊天" }).click();
    const rename = page.getByLabel("重命名聊天");
    await rename.fill("重试后的群聊");
    await rename.press("Enter");
    await expect(rename).toBeVisible();
    await expect(rename).toHaveValue("重试后的群聊");
    await expect(page.getByRole("status")).toHaveText("重命名失败，请重试。");

    database = new DatabaseSync(databasePath);
    database.exec("DROP TRIGGER reject_room_context_rename;");
    database.close();
    await rename.press("Enter");
    await expect(roomRow(page, "重试后的群聊")).toBeVisible();

    menu = await roomMenu(page, "重试后的群聊");
    await menu.getByRole("menuitem", { name: "重命名聊天" }).click();
    await page.getByLabel("重命名聊天").fill("不应保存");
    await page.getByLabel("重命名聊天").press("Escape");
    await expect(roomRow(page, "重试后的群聊")).toBeVisible();
    await expect(roomRow(page, "不应保存")).toHaveCount(0);
  } finally {
    if (application) application.process().kill("SIGKILL");
    removeTestDirectory(userDataDir);
  }
});

test("refuses to archive a running Room from its context menu", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-room-context-archive-busy-"));
  let application: ElectronApplication | undefined;
  try {
    const repository = new AppRepository(join(userDataDir, "aevoren-bot.sqlite"));
    const first = repository.createBot();
    const second = repository.createBot();
    const detail = repository.createRoom({ memberBotIds: [first.bot.id, second.bot.id], name: "运行中群聊" });
    repository.close();

    const launched = await launch(userDataDir);
    application = launched.application;
    const page = launched.page;
    const liveRepository = new AppRepository(join(userDataDir, "aevoren-bot.sqlite"));
    liveRepository.prepareRoomMessage({
      roomId: detail.room.id,
      sessionId: detail.session.id,
      clientNonce: crypto.randomUUID(),
      text: "保持运行",
      targetBotIds: [first.bot.id],
    });
    liveRepository.close();

    const menu = await roomMenu(page, "运行中群聊");
    await menu.getByRole("menuitem", { name: "归档群聊" }).click();
    await expect(roomRow(page, "运行中群聊")).toBeVisible();
    await expect(page.getByText("群聊正在运行，暂时不能修改成员或归档。")).toBeVisible();

    const deleteMenu = await roomMenu(page, "运行中群聊");
    await deleteMenu.getByRole("menuitem", { name: "删除" }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "删除", exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(page.getByText("群聊正在运行，暂时不能删除。")).toBeVisible();
    await expect(roomRow(page, "运行中群聊")).toBeVisible();
    await dialog.getByRole("button", { name: "取消" }).click();
  } finally {
    if (application) application.process().kill("SIGKILL");
    removeTestDirectory(userDataDir);
  }
});

test("requires confirmation and permanently deletes only the selected Room", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-room-context-delete-"));
  let application: ElectronApplication | undefined;
  try {
    const repository = new AppRepository(join(userDataDir, "aevoren-bot.sqlite"));
    const first = repository.createBot();
    const second = repository.createBot();
    const detail = repository.createRoom({ memberBotIds: [first.bot.id, second.bot.id], name: "待删除群聊" });
    const prepared = repository.prepareRoomMessage({
      roomId: detail.room.id,
      sessionId: detail.session.id,
      clientNonce: crypto.randomUUID(),
      text: "将随群聊删除的历史",
      targetBotIds: [first.bot.id],
    });
    repository.transitionRoomBatch(prepared.batch.id, "cancelled");
    repository.close();

    const launched = await launch(userDataDir);
    application = launched.application;
    const page = launched.page;
    await roomRow(page, "待删除群聊").click();
    let menu = await roomMenu(page, "待删除群聊");
    await menu.getByRole("menuitem", { name: "删除" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("永久删除该群聊及聊天历史");
    await expect(dialog).toContainText("群聊中的 Bot 不会被删除");
    await expect(dialog.getByRole("button", { name: "取消" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(roomRow(page, "待删除群聊")).toBeVisible();

    menu = await roomMenu(page, "待删除群聊");
    await menu.getByRole("menuitem", { name: "删除" }).click();
    await dialog.getByRole("button", { name: "删除", exact: true }).click();
    await expect(roomRow(page, "待删除群聊")).toHaveCount(0);
    await expect(page.locator(".bot-list .bot-row")).toHaveCount(2);

    const database = new DatabaseSync(join(userDataDir, "aevoren-bot.sqlite"), { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM rooms WHERE id = ?").get(detail.room.id)).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM sessions WHERE id = ?").get(detail.session.id)).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM transcript_entries WHERE session_id = ?").get(detail.session.id)).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM bots WHERE deleted_at IS NULL").get()).toEqual({ count: 2 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  } finally {
    if (application) application.process().kill("SIGKILL");
    removeTestDirectory(userDataDir);
  }
});
