import { removeTestDirectory } from "./test-cleanup";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { AppRepository } from "../../src/main/database";

test("creates, runs, restores, and keeps one enabled Routine alive after the window closes", async () => {
  test.setTimeout(30_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-routine-e2e-"));
  const repository = new AppRepository(join(userDataDir, "aevoren-bot.sqlite"));
  repository.updateBot(repository.createBot().bot.id, 1, { name: "Routine Bot" });
  repository.close();
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({
      args: ["."], cwd: process.cwd(),
      env: { ...process.env, AEVOREN_BOT_USER_DATA_DIR: userDataDir, AEVOREN_BOT_FAKE_PROVIDER: "1", AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_ROUTINE_TICK_MS: "100" },
    });
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "主动服务", exact: true }).click();
    await page.getByLabel("Routine 名称").fill("每小时检查");
    await page.getByLabel("Routine 提示").fill("检查项目状态并给出摘要");
    await page.getByLabel("Routine 计划类型").selectOption("interval");
    await page.getByLabel("Routine 间隔分钟").fill("60");
    await page.getByRole("button", { name: "创建为暂停状态", exact: true }).click();
    const card = page.locator(".routine-card").filter({ hasText: "每小时检查" });
    await expect(card).toContainText("已暂停");
    await card.getByRole("button", { name: "启用", exact: true }).click();
    await expect(card).toContainText("已启用");
    await card.getByRole("button", { name: "立即运行", exact: true }).click();
    await page.getByRole("button", { name: "关闭设置" }).click();
    await expect(page.getByText("[Routine: 每小时检查]", { exact: false })).toBeVisible();
    await expect(page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(1);

    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "主动服务", exact: true }).click();
    await expect.poll(async () => {
      await page.getByRole("button", { name: "刷新", exact: true }).click();
      return page.locator(".routine-run-list").textContent();
    }).toContain("completed");
    await page.getByRole("button", { name: "关闭设置" }).click();

    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await expect.poll(() => application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(false);
    expect(application.process().exitCode).toBeNull();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show());
    await expect.poll(() => application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(true);
    await expect(page.getByRole("heading", { name: "Routine Bot" })).toBeVisible();

    await application.close();
    application = undefined;
  } finally {
    if (application) application.process().kill("SIGKILL");
    removeTestDirectory(userDataDir);
  }
});
