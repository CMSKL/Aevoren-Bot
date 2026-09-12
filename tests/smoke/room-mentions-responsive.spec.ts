import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { AppRepository } from "../../src/main/database";

function seedRoom(userDataDir: string): { roomName: string; botNames: string[] } {
  const repository = new AppRepository(join(userDataDir, "ms-bot.sqlite"));
  try {
    const botNames = ["研究员", "评审员", "执行员"];
    const bots = botNames.map((name) => {
      const created = repository.createBot();
      return repository.updateBot(created.bot.id, created.bot.version, { name, label: `${name}标签` });
    });
    const roomName = "@Bot 验收群聊";
    repository.createRoom({ name: roomName, memberBotIds: bots.map((bot) => bot.id) });
    return { roomName, botNames };
  } finally {
    repository.close();
  }
}

async function mention(page: Page, query: string): Promise<void> {
  const input = page.getByLabel("消息");
  await input.fill(`@${query}`);
  await expect(page.getByRole("listbox", { name: "提及 Bot" })).toBeVisible();
  await input.press("Enter");
}

async function assertViewportContained(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const composer = document.querySelector<HTMLElement>(".composer");
    const transcript = document.querySelector<HTMLElement>(".transcript");
    if (!composer || !transcript) return false;
    const composerRect = composer.getBoundingClientRect();
    return document.documentElement.scrollWidth <= window.innerWidth
      && transcript.scrollWidth <= transcript.clientWidth
      && composerRect.left >= 0
      && composerRect.right <= window.innerWidth;
  })).toBe(true);
}

test("supports Grok-style Room mentions, deterministic routing, and responsive layouts", async () => {
  test.setTimeout(90_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "ms-bot-room-mentions-"));
  const seeded = seedRoom(userDataDir);
  const application = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    env: { ...process.env, MS_BOT_USER_DATA_DIR: userDataDir, MS_BOT_FAKE_PROVIDER: "1", MS_BOT_FAKE_DELAY_MS: "5" },
  });

  try {
    const page = await application.firstWindow();
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.locator(".bot-row").filter({ hasText: seeded.roomName }).click();
    await expect(page.getByRole("heading", { name: seeded.roomName })).toBeVisible();
    await expect(page.getByText("未 @ 时，全部 3 个成员按顺序响应", { exact: true })).toBeVisible();

    const input = page.getByLabel("消息");
    await input.fill("@");
    const options = page.getByRole("option");
    await expect(options).toHaveCount(4);
    await expect(options.nth(0)).toContainText("所有人");
    await expect(options.nth(1)).toContainText(seeded.botNames[0]!);

    await input.fill("@评");
    await expect(options).toHaveCount(1);
    await input.press("Enter");
    await expect(page.getByRole("button", { name: "移除 @评审员" })).toBeVisible();
    await expect(input).toHaveValue("");
    await input.fill("只回复这一条。");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(1);
    await expect(page.locator("article.message-user").last().getByText("@评审员", { exact: true })).toBeVisible();
    await expect(page.locator(".speaker-link").last()).toHaveText("评审员");

    await mention(page, "评");
    await mention(page, "执");
    await mention(page, "评");
    await expect(page.locator(".mention-chip")).toHaveCount(2);
    await expect(page.getByText("将调用 2 个被 @ 的 Bot", { exact: true })).toBeVisible();
    await input.fill("两位一起复核。");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(3);
    await expect(page.locator("article.message-user").last().locator(".message-route-chip")).toHaveText(["@评审员", "@执行员"]);

    await mention(page, "评");
    await mention(page, "执");
    await input.fill("");
    await input.press("Backspace");
    await expect(page.locator(".mention-chip")).toHaveCount(1);
    await page.locator(".mention-chip").click();
    await expect(page.locator(".mention-chip")).toHaveCount(0);

    await input.fill("@不存在");
    await expect(page.locator(".mention-empty")).toContainText("未找到与“不存在”匹配的 Bot");
    await input.press("Escape");
    await expect(page.getByRole("listbox", { name: "提及 Bot" })).toHaveCount(0);
    await expect(input).toHaveValue("@不存在");

    await input.fill("没有提及时全部成员响应。");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(6);
    await expect(page.locator("article.message-user").last().locator(".message-route-chip")).toHaveCount(3);

    await mention(page, "all");
    await expect(page.getByRole("button", { name: "移除 @所有人" })).toBeVisible();
    await expect(page.getByText("已 @所有人，将调用 3 个 Bot", { exact: true })).toBeVisible();
    await input.fill("显式通知所有人。");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(9);

    for (const [width, height] of [[1440, 900], [1180, 800], [981, 780], [980, 780], [768, 800], [390, 844]] as const) {
      await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height), { width, height });
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(width);
      await assertViewportContained(page);
      if (width === 1180) await page.screenshot({ path: "/tmp/ms-bot-room-mentions-desktop.png", fullPage: true });
    }

    await expect(page.locator(".sidebar")).not.toBeVisible();
    await expect(page.locator(".inspector")).not.toBeVisible();
    await input.fill("@");
    await expect(page.getByRole("listbox", { name: "提及 Bot" })).toBeVisible();
    expect(await page.locator(".mention-menu").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight;
    })).toBe(true);
    await page.screenshot({ path: "/tmp/ms-bot-room-mentions-narrow.png", fullPage: true });
    await input.press("Escape");

    await page.getByRole("button", { name: "打开 Bot 列表" }).click();
    await expect(page.locator(".sidebar")).toBeVisible();
    await assertViewportContained(page);
    await page.getByRole("button", { name: "关闭 Bot 列表" }).click();
    await page.getByRole("button", { name: "打开 Bot 设置" }).click();
    await expect(page.locator(".inspector")).toBeVisible();
    await assertViewportContained(page);
    await page.getByRole("button", { name: "关闭群聊设置" }).click();
    expect(consoleErrors).toEqual([]);

    const database = new DatabaseSync(join(userDataDir, "ms-bot.sqlite"), { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM room_batches WHERE state = 'completed'").get()).toEqual({ count: 4 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM room_turns WHERE state = 'completed'").get()).toEqual({ count: 9 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  } finally {
    await application.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
