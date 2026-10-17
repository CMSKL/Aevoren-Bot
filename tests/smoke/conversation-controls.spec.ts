import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { removeTestDirectory } from "./test-cleanup";
import { closeInspector, openConversationMenu, openInspector } from "./navigation";

test("keeps per-reply Markdown export removed and Bot configuration in contacts rather than a chat details panel", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-conversation-controls-"));
  const application = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    env: {
      ...process.env,
      AEVOREN_BOT_USER_DATA_DIR: userDataDir,
      AEVOREN_BOT_FAKE_PROVIDER: "1",
      AEVOREN_BOT_FAKE_DELAY_MS: "5",
    },
  });

  try {
    const page = await application.firstWindow();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));
    await page.getByRole("button", { name: "新建聊天" }).click();
    await page.getByRole("button", { name: "创建新 Bot" }).click();
    await expect(page.getByRole("heading", { name: "新建 Bot" })).toBeVisible();
    await closeInspector(page);
    await page.getByLabel("消息").fill("请用一句话确认消息功能正常。");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(1);
    await expect(page.getByRole("button", { name: /保存为 Markdown/u })).toHaveCount(0);

    await page.getByLabel("消息").fill("联系人编辑期间保留的聊天草稿。");
    await openInspector(page);
    await expect(page.getByRole("main", { name: "联系人资料", exact: true })).toBeVisible();
    await expect(page.getByLabel("名称", { exact: true })).toHaveValue("新建 Bot");
    await expect(page.locator("#conversation-inspector")).toHaveCount(0);
    await page.screenshot({ path: "/tmp/aevoren-contact-profile-config.png" });
    await closeInspector(page);
    await expect(page.getByRole("main", { name: "联系人资料", exact: true })).toBeHidden();
    await expect(page.getByLabel("消息")).toHaveValue("联系人编辑期间保留的聊天草稿。");
    const menu = await openConversationMenu(page);
    await expect(menu.getByRole("menuitem", { name: "展开详情面板", exact: true })).toHaveCount(0);
    await expect(menu.getByRole("menuitem", { name: "Bot 设置", exact: true })).toHaveCount(0);
    await expect(menu.getByRole("menuitem", { name: "模型设置", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.screenshot({ path: "/tmp/aevoren-pure-chat-without-profile-panel.png" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    await application.close();
    removeTestDirectory(userDataDir);
  }
});
