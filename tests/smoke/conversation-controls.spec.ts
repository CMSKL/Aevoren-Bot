import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { removeTestDirectory } from "./test-cleanup";

test("removes per-reply Markdown export and allows the desktop details panel to collapse", async () => {
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
    await page.getByLabel("消息").fill("请用一句话确认消息功能正常。");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(1);
    await expect(page.getByRole("button", { name: /保存为 Markdown/u })).toHaveCount(0);

    await expect(page.getByRole("button", { name: "收起详情面板" })).toHaveAttribute("aria-expanded", "true");
    await page.screenshot({ path: "/tmp/aevoren-details-panel-expanded.png" });
    await page.getByRole("button", { name: "关闭 Bot 设置" }).click();
    await expect(page.locator(".app-shell")).toHaveClass(/inspector-collapsed/u);
    await expect(page.getByRole("button", { name: "展开详情面板" })).toHaveAttribute("aria-expanded", "false");
    await page.screenshot({ path: "/tmp/aevoren-details-panel-collapsed.png" });
    await page.getByRole("button", { name: "展开详情面板" }).click();
    await expect(page.locator(".app-shell")).not.toHaveClass(/inspector-collapsed/u);
    await expect(page.locator("#conversation-inspector")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    await application.close();
    removeTestDirectory(userDataDir);
  }
});
