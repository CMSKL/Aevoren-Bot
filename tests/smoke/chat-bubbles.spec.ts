import { removeTestDirectory } from "./test-cleanup";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test } from "@playwright/test";
import { closeInspector, openConversationMenu, openInspector } from "./navigation";

test("renders grouped role bubbles across desktop, dark mode and a narrow window", async () => {
  test.setTimeout(60_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-chat-bubbles-"));
  const application = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    env: { ...process.env, AEVOREN_BOT_USER_DATA_DIR: userDataDir, AEVOREN_BOT_FAKE_PROVIDER: "1" },
  });

  try {
    const page = await application.firstWindow();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
    await page.getByRole("button", { name: "新建聊天" }).click();
    await page.getByRole("button", { name: "创建新 Bot" }).click();
    await expect(page.locator(".inspector")).toBeVisible();
    await closeInspector(page);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(page.getByLabel("外观主题").locator("option")).toHaveText(["暗黑", "白昼"]);
    await page.getByLabel("外观主题").selectOption("light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.getByRole("button", { name: "关闭设置", exact: true }).click();
    await page.getByLabel("消息").fill("请用 Markdown 给出简短分析。");
    await page.getByRole("button", { name: "发送" }).click();
    await expect(page.locator("article.message-assistant")).toHaveAttribute("data-status", "completed");

    const transcript = page.locator(".transcript");
    const userBubble = page.locator("article.message-user .message-bubble");
    const assistantBubble = page.locator("article.message-assistant .message-bubble");
    await expect(userBubble).toBeVisible();
    await expect(assistantBubble).toBeVisible();

    const desktopLayout = await page.evaluate(() => {
      const transcriptElement = document.querySelector<HTMLElement>(".transcript");
      const user = document.querySelector<HTMLElement>(".message-user .message-bubble");
      const assistant = document.querySelector<HTMLElement>(".message-assistant .message-bubble");
      const composer = document.querySelector<HTMLElement>(".composer");
      const composerEditor = document.querySelector<HTMLElement>(".composer-editor");
      const conversationHeader = document.querySelector<HTMLElement>(".conversation-header");
      const selectedChat = document.querySelector<HTMLElement>(".bot-row.selected");
      if (!transcriptElement || !user || !assistant || !composer || !composerEditor || !conversationHeader || !selectedChat) {
        throw new Error("missing chat layout");
      }
      const transcriptRect = transcriptElement.getBoundingClientRect();
      const userRect = user.getBoundingClientRect();
      const assistantRect = assistant.getBoundingClientRect();
      return {
        userRatio: userRect.width / transcriptRect.width,
        assistantWidth: assistantRect.width,
        userIsRight: userRect.right > assistantRect.right,
        bubblesContained: [userRect, assistantRect].every((rect) => rect.left >= transcriptRect.left && rect.right <= transcriptRect.right),
        backgroundsDiffer: getComputedStyle(user).backgroundColor !== getComputedStyle(assistant).backgroundColor,
        userRadius: Number.parseFloat(getComputedStyle(user).borderTopLeftRadius),
        assistantRadius: Number.parseFloat(getComputedStyle(assistant).borderTopLeftRadius),
        composerRadius: Number.parseFloat(getComputedStyle(composer).borderTopLeftRadius),
        composerEditorHeight: composerEditor.getBoundingClientRect().height,
        headerHeight: conversationHeader.getBoundingClientRect().height,
        selectedChatHeight: selectedChat.getBoundingClientRect().height,
      };
    });
    expect(desktopLayout.userRatio).toBeLessThan(0.76);
    expect(desktopLayout.assistantWidth).toBeGreaterThan(0);
    expect(desktopLayout.assistantWidth).toBeLessThanOrEqual(720);
    expect(desktopLayout.userIsRight).toBe(true);
    expect(desktopLayout.bubblesContained).toBe(true);
    expect(desktopLayout.backgroundsDiffer).toBe(true);
    expect(desktopLayout.userRadius).toBe(8);
    expect(desktopLayout.assistantRadius).toBe(8);
    expect(desktopLayout.composerRadius).toBe(8);
    expect(desktopLayout.composerEditorHeight).toBeGreaterThanOrEqual(60);
    expect(desktopLayout.composerEditorHeight).toBeLessThanOrEqual(160);
    expect(desktopLayout.headerHeight).toBe(88);
    expect(desktopLayout.selectedChatHeight).toBe(82);
    await expect(page.locator("article.message-assistant .message-avatar img.bot-avatar-icon")).toHaveCSS("width", "56px");
    await expect(page.locator("article.message-user .message-avatar img.user-avatar")).toHaveCSS("width", "56px");
    await expect(page.getByRole("button", { name: "发送", exact: true })).toHaveCSS("height", "44px");
    await transcript.evaluate((element) => element.scrollTo({ top: 0 }));
    await page.screenshot({ path: "/tmp/aevoren-bot-chat-bubbles-desktop.png", fullPage: true });

    const database = new DatabaseSync(join(userDataDir, "aevoren-bot.sqlite"));
    try {
      const latest = database
        .prepare("SELECT session_id, generation, seq, updated_seq, created_at, updated_at FROM transcript_entries WHERE role = 'assistant' ORDER BY seq DESC LIMIT 1")
        .get() as {
          session_id: string;
          generation: number;
          seq: number;
          updated_seq: number;
          created_at: string;
          updated_at: string;
        };
      database
        .prepare(
          `INSERT INTO transcript_entries(
             id, session_id, generation, seq, client_nonce, role, body, status, updated_seq, created_at, updated_at
           ) VALUES (?, ?, ?, ?, NULL, 'assistant', ?, 'completed', ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          latest.session_id,
          latest.generation,
          latest.seq + 1,
          "补充说明：这是同一角色的连续消息。",
          latest.updated_seq + 1,
          latest.created_at,
          latest.updated_at,
        );
      database
        .prepare("UPDATE sessions SET transcript_cursor = ? WHERE id = ?")
        .run(latest.updated_seq + 1, latest.session_id);
    } finally {
      database.close();
    }

    await page.reload();
    const assistants = page.locator("article.message-assistant");
    await expect(assistants).toHaveCount(2);
    await expect(assistants.nth(1)).toHaveClass(/message-group-continuation/);
    await expect(assistants.locator(".message-avatar:not(.message-avatar-placeholder)")).toHaveCount(1);
    await expect(assistants.nth(1).locator(".message-meta")).toHaveCount(0);

    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByLabel("外观主题").selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("button", { name: "关闭设置", exact: true }).click();
    const darkColors = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLElement>(".conversation");
      const assistant = document.querySelector<HTMLElement>(".message-assistant .message-bubble");
      const user = document.querySelector<HTMLElement>(".message-user .message-bubble");
      if (!canvas || !assistant || !user) throw new Error("missing dark mode surfaces");
      return [getComputedStyle(canvas).backgroundColor, getComputedStyle(assistant).backgroundColor, getComputedStyle(user).backgroundColor];
    });
    expect(new Set(darkColors).size).toBe(3);

    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(430, 820);
    });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(430);
    await expect(page.getByRole("button", { name: "聊天选项", exact: true })).toBeVisible();
    await expect(page.locator(".conversation-header")).toHaveCSS("height", "64px");
    await expect(page.locator("article.message-assistant .message-avatar img.bot-avatar-icon").first()).toHaveCSS("width", "34px");
    await expect(page.locator(".sidebar")).not.toBeVisible();
    await expect(page.locator(".inspector")).not.toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await expect.poll(() => transcript.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

    const menu = await openConversationMenu(page);
    await expect(menu.getByRole("menuitem", { name: "Bot 设置", exact: true })).toBeVisible();
    await menu.getByRole("menuitem", { name: "打开 Bot 列表", exact: true }).click();
    await expect(page.locator(".sidebar")).toBeVisible();
    await page.getByRole("button", { name: "关闭 Bot 列表" }).click();
    await expect(page.locator(".sidebar")).not.toBeVisible();
    await openInspector(page);
    await expect(page.locator(".inspector")).toBeVisible();
    await page.getByRole("button", { name: "关闭 Bot 设置" }).click();
    await expect(page.locator(".inspector")).not.toBeVisible();

    const narrowBubbleRatio = await assistantBubble.first().evaluate((element) => {
      const bubble = element as HTMLElement;
      return bubble.getBoundingClientRect().width / document.documentElement.clientWidth;
    });
    expect(narrowBubbleRatio).toBeLessThanOrEqual(0.9);
    await page.screenshot({ path: "/tmp/aevoren-bot-chat-bubbles-narrow-dark.png", fullPage: true });
  } finally {
    await application.close();
    removeTestDirectory(userDataDir);
  }
});
