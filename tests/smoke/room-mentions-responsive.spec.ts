import { removeTestDirectory } from "./test-cleanup";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { AppRepository } from "../../src/main/database";

function seedRoom(userDataDir: string): { roomName: string; botNames: string[] } {
  const repository = new AppRepository(join(userDataDir, "aevoren-bot.sqlite"));
  try {
    const botNames = ["研究员", "评审员", "执行员 · 负责验证窄窗口候选和提及标签不会撑破布局的超长名称"];
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
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-room-mentions-"));
  const seeded = seedRoom(userDataDir);
  const application = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    env: { ...process.env, AEVOREN_BOT_USER_DATA_DIR: userDataDir, AEVOREN_BOT_FAKE_PROVIDER: "1", AEVOREN_BOT_FAKE_DELAY_MS: "5" },
  });

  try {
    const page = await application.firstWindow();
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.locator(".bot-row").filter({ hasText: seeded.roomName }).click();
    await expect(page.getByRole("heading", { name: seeded.roomName })).toBeVisible();
    await expect(page.getByText("自动选择最合适的 Bot；也可输入 @ 临时指定", { exact: true })).toBeVisible();

    const input = page.getByLabel("消息");
    await input.fill("@");
    const options = page.getByRole("option");
    await expect(options).toHaveCount(4);
    await expect(options.nth(0)).toContainText("所有人");
    await expect(options.nth(1)).toContainText(seeded.botNames[0]!);

    await input.fill("请让 @评审员 检查");
    await input.evaluate((element) => {
      const textarea = element as HTMLTextAreaElement;
      textarea.setSelectionRange(7, 7);
      textarea.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await expect(page.getByRole("listbox", { name: "提及 Bot" })).toBeVisible();
    await input.press("Enter");
    await expect(page.getByRole("button", { name: "移除 @评审员" })).toBeVisible();
    await expect(input).toHaveValue("请让  检查");
    await input.pressSequentially("立即");
    await expect(input).toHaveValue("请让 立即 检查");
    await page.getByRole("button", { name: "移除 @评审员" }).click();
    await input.fill("");

    await input.fill("@评");
    await expect(page.getByRole("listbox", { name: "提及 Bot" })).toBeVisible();
    const userCountBeforeComposition = await page.locator("article.message-user").count();
    await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
    await expect(page.locator(".mention-chip")).toHaveCount(0);
    await expect(page.locator("article.message-user")).toHaveCount(userCountBeforeComposition);
    await expect(input).toHaveValue("@评");
    await input.press("Escape");

    await input.fill("");
    await input.evaluate((element) => {
      const textarea = element as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "@执");
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: "@执", inputType: "insertFromPaste" }));
    });
    await expect(page.getByRole("listbox", { name: "提及 Bot" })).toBeVisible();
    await expect(options).toHaveCount(1);
    await expect(options.first()).toContainText(seeded.botNames[2]!);
    await input.press("Escape");

    await input.fill("");
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
    await expect(page.getByText("将只调用 2 个指定 Bot", { exact: true })).toBeVisible();
    await input.fill("两位一起复核。");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(3);
    await expect(page.locator("article.message-user").last().locator(".message-route-chip")).toHaveText(["@评审员", `@${seeded.botNames[2]}`]);

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

    await input.fill("请由评审员标签处理自动路由。");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(4);
    await expect(page.locator("article.message-user").last().locator(".message-route-chip")).toHaveCount(1);
    await expect(page.locator("article.message-user").last()).toContainText("自动选择");
    await expect(page.locator("article.message-user").last()).toContainText("匹配");
    await expect(page.locator(".speaker-link").last()).toHaveText("评审员");

    await mention(page, "all");
    await expect(page.getByRole("button", { name: "移除 @所有人" })).toBeVisible();
    await expect(page.getByText("将按成员顺序调用全部 3 个 Bot", { exact: true })).toBeVisible();
    await input.fill("显式通知所有人。");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(7);

    await mention(page, "研");
    await input.fill("成员变化后不能静默改发给全部成员。");
    await page.locator(".room-member-row").filter({ hasText: seeded.botNames[0]! }).getByRole("button", { name: "移除" }).click();
    await expect(page.locator(".room-member-row")).toHaveCount(2);
    await expect(page.getByRole("alert")).toContainText(`@${seeded.botNames[0]} 已不在群聊，请移除后重新选择`);
    const invalidMention = page.getByRole("button", { name: `移除 @${seeded.botNames[0]}` });
    await expect(invalidMention).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
    await expect(page.locator("article.message-user")).toHaveCount(4);
    await page.screenshot({ path: "/tmp/aevoren-bot-room-mention-invalid.png", fullPage: true });
    await invalidMention.click();
    await expect(page.getByText("自动选择最合适的 Bot；也可输入 @ 临时指定", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
    await input.fill("");
    await page.getByLabel("选择要添加的 Bot").selectOption({ label: seeded.botNames[0] });
    await page.getByRole("button", { name: "添加", exact: true }).click();
    await expect(page.locator(".room-member-row")).toHaveCount(3);

    for (const [width, height] of [[1440, 900], [1180, 800], [1040, 708], [981, 780], [980, 780], [768, 800], [390, 844]] as const) {
      await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height), { width, height });
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(width);
      await assertViewportContained(page);
      if (width === 1180) await page.screenshot({ path: "/tmp/aevoren-bot-room-mentions-desktop.png", fullPage: true });
    }

    await expect(page.locator(".sidebar")).not.toBeVisible();
    await expect(page.locator(".inspector")).not.toBeVisible();
    await input.fill("@");
    await expect(page.getByRole("listbox", { name: "提及 Bot" })).toBeVisible();
    expect(await page.locator(".mention-menu").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight;
    })).toBe(true);
    expect(await page.locator(".mention-option").first().evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(40);
    const longCandidate = page.locator(".mention-option").filter({ hasText: seeded.botNames[2]! }).locator("strong");
    expect(await longCandidate.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0
        && rect.right <= window.innerWidth
        && getComputedStyle(element).textOverflow === "ellipsis";
    })).toBe(true);
    await page.screenshot({ path: "/tmp/aevoren-bot-room-mentions-narrow.png", fullPage: true });
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

    const database = new DatabaseSync(join(userDataDir, "aevoren-bot.sqlite"), { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM room_batches WHERE state = 'completed'").get()).toEqual({ count: 4 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM room_turns WHERE state = 'completed'").get()).toEqual({ count: 7 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  } finally {
    await application.close();
    removeTestDirectory(userDataDir);
  }
});
