import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { AevorenBotApi } from "../../src/shared/contracts";
import { selectDetailsTab, selectNavigationTab } from "./navigation";
import { closeTestApplication, removeTestDirectory } from "./test-cleanup";

// Browser plugin not available. A deferred IPC response reproduces the loading
// state in real hidden Electron; this does not claim a real Docker build passed.
test("computer startup shows pending work until the host returns an error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aevoren-computer-startup-"));
  const databasePath = join(directory, "app.sqlite");
  const executablePath = process.env.AEVOREN_PACKAGED_APP_PATH;
  const application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : ["."]), "--use-mock-keychain"], cwd: process.cwd(),
    env: { ...process.env, AEVOREN_BOT_USER_DATA_DIR: directory, AEVOREN_BOT_DB_PATH: databasePath, AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_DISABLE_UPDATES: "1" } });
  try {
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await expect(page).toHaveTitle("Aevoren Bot");
    await expect(page.locator(".app-shell")).toBeVisible();
    await page.evaluate(async () => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const result = await api.bots.create();
      if (!result.ok) throw new Error(result.error.safeMessage);
      const updated = await api.bots.update({ id: result.data.bot.id, expectedVersion: result.data.bot.version, patch: { name: "启动反馈验收" } });
      if (!updated.ok) throw new Error(updated.error.safeMessage);
    });
    await page.reload();
    await application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("browser:start");
      ipcMain.handle("browser:start", () => new Promise(resolve => {
        Object.assign(globalThis, { finishStartupTest: () => resolve({ ok: false, error: {
          code: "BROWSER_UNAVAILABLE", domain: "tool", retryable: true,
          safeMessage: "浏览器镜像准备超时，请检查 Docker 和网络后重试。", details: {},
        } }) });
      }));
    });
    await selectNavigationTab(page, "联系人");
    await page.locator(".sidebar").getByRole("listitem", { name: "启动反馈验收", exact: true }).click();
    const contact = page.getByRole("main", { name: "联系人资料", exact: true });
    await selectDetailsTab(contact, "电脑");
    const panel = contact.getByRole("region", { name: "电脑", exact: true });
    const start = panel.getByRole("button", { name: "启动浏览器与电脑", exact: true });
    await expect(start).toBeEnabled();
    await start.click();
    await expect(panel.getByRole("status").first()).toHaveText("正在准备镜像并启动电脑");
    await expect(panel.getByRole("button", { name: "正在启动…", exact: true })).toBeDisabled();
    await expect(panel.getByText("首次启动需要下载 Chromium 和 Linux 图形组件；准备完成后会自动启动。", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "刷新状态", exact: true }).click();
    await expect(panel.getByRole("status").first()).toHaveText("正在准备镜像并启动电脑");
    if (process.env.AEVOREN_STARTUP_SCREENSHOT) await page.screenshot({ path: process.env.AEVOREN_STARTUP_SCREENSHOT });
    await application.evaluate(() => (globalThis as unknown as { finishStartupTest(): void }).finishStartupTest());
    await expect(panel.getByRole("alert")).toContainText("浏览器镜像准备超时");
    await expect(start).toBeEnabled();
    await expect(panel.getByRole("status").first()).toHaveText("尚未创建浏览器");
    expect(errors).toEqual([]);
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()))).toBe(true);
  } finally {
    await application.evaluate(() => (globalThis as unknown as { finishStartupTest?: () => void }).finishStartupTest?.());
    await closeTestApplication(application);
    removeTestDirectory(directory);
  }
});
