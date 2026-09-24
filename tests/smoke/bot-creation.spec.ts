import { removeTestDirectory } from "./test-cleanup";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { BOT_AVATAR_COLORS, BOT_AVATAR_SHAPES } from "@shared/bot-avatar";

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

function databaseCounts(userDataDir: string): { bots: number; sessions: number; transcript: number } {
  const database = new DatabaseSync(join(userDataDir, "aevoren-bot.sqlite"), { readOnly: true });
  try {
    const count = (table: string): number =>
      Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
    return { bots: count("bots"), sessions: count("sessions"), transcript: count("transcript_entries") };
  } finally {
    database.close();
  }
}

function databaseAvatar(userDataDir: string): { shape: string; color: string } {
  const database = new DatabaseSync(join(userDataDir, "aevoren-bot.sqlite"), { readOnly: true });
  try {
    return database.prepare("SELECT avatar_shape AS shape, avatar_color AS color FROM bots WHERE deleted_at IS NULL ORDER BY created_at ASC LIMIT 1").get() as { shape: string; color: string };
  } finally {
    database.close();
  }
}

async function openChooser(page: Page): Promise<ReturnType<Page["getByRole"]>> {
  await page.locator(".new-bot-button").click();
  const dialog = page.getByRole("dialog", { name: "新建聊天" });
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel("搜索或创建 Bot")).toBeFocused();
  return dialog;
}

test("keeps the database empty until Create new Bot is explicitly selected", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-create-cancel-"));
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(userDataDir);
    application = launched.application;
    const page = launched.page;

    await expect(page.getByText("产品需求分析助手")).toHaveCount(0);
    let dialog = await openChooser(page);
    expect(databaseCounts(userDataDir)).toEqual({ bots: 0, sessions: 0, transcript: 0 });
    await dialog.getByRole("button", { name: "关闭新聊天" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".new-bot-button")).toBeFocused();
    expect(databaseCounts(userDataDir)).toEqual({ bots: 0, sessions: 0, transcript: 0 });

    dialog = await openChooser(page);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.locator(".new-bot-button")).toBeFocused();
    expect(databaseCounts(userDataDir)).toEqual({ bots: 0, sessions: 0, transcript: 0 });

    dialog = await openChooser(page);
    await page.locator(".new-bot-backdrop").click({ position: { x: 10, y: 300 } });
    await expect(dialog).toBeHidden();
    await expect(page.locator(".new-bot-button")).toBeFocused();
    expect(databaseCounts(userDataDir)).toEqual({ bots: 0, sessions: 0, transcript: 0 });

    await openChooser(page);
    await application.close();
    application = undefined;
    expect(databaseCounts(userDataDir)).toEqual({ bots: 0, sessions: 0, transcript: 0 });
  } finally {
    if (application) application.process().kill("SIGKILL");
    removeTestDirectory(userDataDir);
  }
});

test("creates one neutral Bot and one MAIN session under a duplicate trigger, then restores profile edits", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-create-once-"));
  let application: ElectronApplication | undefined;
  try {
    let launched = await launch(userDataDir);
    application = launched.application;
    let page = launched.page;
    const dialog = await openChooser(page);
    const create = dialog.getByRole("button", { name: "创建新 Bot" });
    await create.evaluate((button) => {
      if (!(button instanceof HTMLElement)) throw new Error("expected an HTML button");
      button.click();
      button.click();
    });

    await expect(page.getByRole("heading", { name: "新建 Bot" })).toBeVisible();
    await expect(page.locator(".bot-row.selected")).toHaveCount(1);
    await expect(page.getByLabel("名称")).toHaveValue("新建 Bot");
    await expect(page.getByLabel("标签（可选）")).toHaveValue("");
    await expect(page.getByLabel("标签（可选）")).toHaveAttribute("placeholder", "研究、市场、行政");
    await expect(page.getByLabel("描述")).toHaveValue("");
    await expect(page.getByLabel("描述")).toHaveAttribute("placeholder", "详细说明用途和工作方式");
    await expect(page.getByLabel("Instructions")).toHaveCount(0);
    const avatar = page.locator(".bot-row.selected .bot-avatar-icon");
    const avatarShape = await avatar.getAttribute("data-avatar-shape");
    const avatarColor = await avatar.getAttribute("data-avatar-color");
    expect(BOT_AVATAR_SHAPES).toContain(avatarShape);
    expect(BOT_AVATAR_COLORS).toContain(avatarColor);
    await expect(page.locator(".avatar-settings .bot-avatar-icon")).toHaveAttribute("data-avatar-shape", avatarShape!);
    await expect(page.locator(".avatar-settings .bot-avatar-icon")).toHaveAttribute("data-avatar-color", avatarColor!);
    await expect(page.getByRole("radiogroup", { name: "Bot 头像造型" })).toHaveCount(0);
    await expect(page.getByRole("radiogroup", { name: "Bot 头像配色" })).toHaveCount(0);
    await page.screenshot({ path: "/tmp/aevoren-avatar-random-profile.png" });
    expect(databaseAvatar(userDataDir)).toEqual({ shape: avatarShape, color: avatarColor });
    expect(databaseCounts(userDataDir)).toEqual({ bots: 1, sessions: 1, transcript: 0 });

    await page.getByLabel("名称").fill("研究助手");
    await page.getByLabel("标签（可选）").fill("研究");
    await page.getByLabel("描述").fill("整理材料并给出可核验的研究结论。");
    await page.getByLabel("描述").blur();
    await expect(page.getByTestId("profile-save-status")).toContainText("已保存");
    expect(databaseAvatar(userDataDir)).toEqual({ shape: avatarShape, color: avatarColor });
    await expect(page.getByRole("button", { name: "保存", exact: true })).toHaveCount(0);
    await application.close();
    application = undefined;

    launched = await launch(userDataDir);
    application = launched.application;
    page = launched.page;
    await expect(page.getByRole("heading", { name: "研究助手" })).toBeVisible();
    await expect(page.getByLabel("名称")).toHaveValue("研究助手");
    await expect(page.getByLabel("标签（可选）")).toHaveValue("研究");
    await expect(page.getByLabel("描述")).toHaveValue("整理材料并给出可核验的研究结论。");
    await expect(page.getByRole("radiogroup", { name: "Bot 头像造型" })).toHaveCount(0);
    await expect(page.getByRole("radiogroup", { name: "Bot 头像配色" })).toHaveCount(0);
    expect(databaseAvatar(userDataDir)).toEqual({ shape: avatarShape, color: avatarColor });
    await expect(page.locator(".bot-row.selected .bot-avatar-icon")).toHaveCount(1);
    expect(databaseCounts(userDataDir)).toEqual({ bots: 1, sessions: 1, transcript: 0 });

    await application.close();
    application = undefined;
  } finally {
    if (application) application.process().kill("SIGKILL");
    removeTestDirectory(userDataDir);
  }
});

test("rolls back a failed create and keeps the chooser recoverable", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-create-failure-"));
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(userDataDir);
    application = launched.application;
    const page = launched.page;
    const databasePath = join(userDataDir, "aevoren-bot.sqlite");
    let database = new DatabaseSync(databasePath);
    database.exec("CREATE TRIGGER reject_main BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'test'); END;");
    database.close();

    const dialog = await openChooser(page);
    await dialog.getByRole("button", { name: "创建新 Bot" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("操作失败，请稍后重试。");
    expect(databaseCounts(userDataDir)).toEqual({ bots: 0, sessions: 0, transcript: 0 });

    database = new DatabaseSync(databasePath);
    database.exec("DROP TRIGGER reject_main;");
    database.close();
    await dialog.getByRole("button", { name: "创建新 Bot" }).click();
    await expect(page.getByRole("heading", { name: "新建 Bot" })).toBeVisible();
    expect(databaseCounts(userDataDir)).toEqual({ bots: 1, sessions: 1, transcript: 0 });

    await application.close();
    application = undefined;
  } finally {
    if (application) application.process().kill("SIGKILL");
    removeTestDirectory(userDataDir);
  }
});

test("supports Enter to create from the recipient search field", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-create-keyboard-"));
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(userDataDir);
    application = launched.application;
    const page = launched.page;
    await openChooser(page);
    await page.getByLabel("搜索或创建 Bot").press("Enter");
    await expect(page.getByRole("heading", { name: "新建 Bot" })).toBeVisible();
    expect(databaseCounts(userDataDir)).toEqual({ bots: 1, sessions: 1, transcript: 0 });
    await application.close();
    application = undefined;
  } finally {
    if (application) application.process().kill("SIGKILL");
    removeTestDirectory(userDataDir);
  }
});

test("filters and selects an existing Bot without creating another resource", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-create-existing-"));
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(userDataDir);
    application = launched.application;
    const page = launched.page;

    let dialog = await openChooser(page);
    await dialog.getByRole("button", { name: "创建新 Bot" }).click();
    await page.getByLabel("名称").fill("Alpha");
    await page.getByLabel("名称").blur();
    await expect(page.getByTestId("profile-save-status")).toContainText("已保存");

    dialog = await openChooser(page);
    await dialog.getByRole("button", { name: "创建新 Bot" }).click();
    await page.getByLabel("名称").fill("Beta");
    await page.getByLabel("名称").blur();
    await expect(page.getByTestId("profile-save-status")).toContainText("已保存");

    dialog = await openChooser(page);
    await page.getByLabel("搜索或创建 Bot").fill("Alpha");
    await expect(dialog.getByRole("button", { name: "Alpha" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Beta" })).toHaveCount(0);
    await dialog.evaluate((element) => {
      const existing = element.querySelector<HTMLButtonElement>('button[aria-label="Alpha"]');
      const create = [...element.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === "创建新 Bot");
      if (!existing || !create) throw new Error("expected chooser actions");
      existing.click();
      create.click();
    });
    await expect(dialog).toBeHidden({ timeout: 200 });
    await expect(page.getByRole("heading", { name: "Alpha" })).toBeVisible();
    await expect(page.locator(".bot-row.selected strong")).toHaveText("Alpha");
    expect(databaseCounts(userDataDir)).toEqual({ bots: 2, sessions: 2, transcript: 0 });

    await application.close();
    application = undefined;
  } finally {
    if (application) application.process().kill("SIGKILL");
    removeTestDirectory(userDataDir);
  }
});
