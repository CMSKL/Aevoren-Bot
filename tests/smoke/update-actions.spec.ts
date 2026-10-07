import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { AppRepository } from "../../src/main/database";
import { IPC } from "../../src/shared/channels";
import type { AevorenBotApi, UpdateState } from "../../src/shared/contracts";
import { removeTestDirectory } from "./test-cleanup";

type DiagnosticMain = typeof globalThis & {
  updateRetryHandler?: (...args: unknown[]) => unknown;
  releaseUpdateRetry?: () => void;
  retryCount?: number;
  installCount?: number;
};

type InstrumentedIpc = { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> };

// State events below exercise stale UI and fault handling, not a successful
// download/install. All invoked IPC handlers are real and installation stays disabled.
async function presentState(application: ElectronApplication, state: UpdateState): Promise<void> {
  await application.evaluate(({ BrowserWindow }, state) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send("events:update", { state });
  }, state);
}

test("excludes update actions from drag regions and handles real IPC/save failures without restarting", async () => {
  const data = mkdtempSync(join(tmpdir(), "aevoren-update-actions-"));
  const repository = new AppRepository(join(data, "aevoren-bot.sqlite"));
  const bot = repository.createBot().bot;
  repository.updateBot(bot.id, bot.version, { name: "更新按钮验收" });
  repository.setSetting("appearance.theme", "dark", false);
  repository.close();
  const application = await electron.launch({ args: ["."], cwd: process.cwd(), env: { ...process.env, AEVOREN_BOT_USER_DATA_DIR: data, AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_DISABLE_UPDATES: "1" } });
  try {
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await expect(page.getByLabel("名称", { exact: true })).toHaveValue("更新按钮验收");
    const current = await page.evaluate(() => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.updates.getState());
    if (!current.ok) throw Error("Cannot read real update state");
    expect(current.data.status).toBe("disabled");
    const failure: UpdateState = { ...current.data, status: "error", error: { code: "UPDATE_CHECK_FAILED", domain: "update", retryable: true, safeMessage: "检查更新失败，当前版本可继续使用。" } };
    const ready: UpdateState = { ...current.data, status: "downloaded", availableVersion: "0.4.0" };

    for (const width of [1440, 1180, 1020, 620, 390]) {
      await application.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]?.setSize(width, 844), width);
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
      for (const state of [failure, ready]) {
        await presentState(application, state);
        await expect(page.locator(".update-action")).toBeVisible();
        expect(await page.locator(".update-status-notice").evaluate(el => getComputedStyle(el).getPropertyValue("-webkit-app-region"))).toBe("no-drag");
        expect(await page.locator(".update-action").evaluate(el => getComputedStyle(el).getPropertyValue("-webkit-app-region"))).toBe("no-drag");
        expect(await page.locator(".update-status-notice").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      }
      await page.screenshot({ path: join(tmpdir(), `aevoren-update-actions-${width}.png`) });
    }
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));
    await presentState(application, failure);

    // Delay the real handler to check pending feedback and duplicate submits.
    await application.evaluate(({ ipcMain }, channel) => {
      const globals = globalThis as DiagnosticMain;
      const original = (ipcMain as unknown as InstrumentedIpc)._invokeHandlers.get(channel);
      if (!original) throw Error("Missing real retry handler");
      globals.updateRetryHandler = original;
      globals.retryCount = 0;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (...args: unknown[]) => {
        globals.retryCount = (globals.retryCount ?? 0) + 1;
        await new Promise<void>(resolve => { globals.releaseUpdateRetry = resolve; });
        return original(...args);
      });
    }, IPC.updatesRetry);
    await page.locator(".update-action").evaluate(button => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await expect(page.getByRole("button", { name: "检查中…", exact: true })).toBeDisabled();
    await expect(page.getByText("正在检查更新…", { exact: true })).toBeVisible();
    expect(await application.evaluate(() => (globalThis as DiagnosticMain).retryCount)).toBe(1);
    await application.evaluate(() => (globalThis as DiagnosticMain).releaseUpdateRetry?.());
    await expect(page.locator(".update-status-notice")).toHaveCount(0);

    // A genuinely missing IPC handler rejects; raw Electron errors stay out of UI.
    await application.evaluate(({ ipcMain }, channel) => ipcMain.removeHandler(channel), IPC.updatesRetry);
    await presentState(application, failure);
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await expect(page.getByText("更新操作未完成", { exact: true })).toBeVisible();
    await expect(page.locator(".update-status-notice")).not.toContainText("No handler registered");
    await page.screenshot({ path: join(tmpdir(), "aevoren-update-ipc-failure.png") });
    await application.evaluate(({ ipcMain }, channel) => {
      ipcMain.handle(channel, (globalThis as DiagnosticMain).updateRetryHandler!);
    }, IPC.updatesRetry);

    // A stale downloaded view must reach the real backend and be rejected safely.
    await presentState(application, ready);
    await page.getByRole("button", { name: "重启更新", exact: true }).click();
    await expect(page.getByText("更新尚未下载完成，请稍后重试。", { exact: true })).toBeVisible();
    await expect(page.getByText("v0.4.0 已准备好", { exact: true })).toHaveCount(0);
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);

    // Settings and the top notice share the same safe action handling.
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "版本更新", exact: true }).click();
    const updates = page.locator('[aria-labelledby="settings-update-title"]');
    await presentState(application, ready);
    await updates.getByRole("button", { name: "重启并更新", exact: true }).click();
    await expect(updates.getByRole("alert")).toContainText("更新尚未下载完成");
    await presentState(application, failure);
    await updates.getByRole("button", { name: "重试", exact: true }).click();
    await expect(updates.getByRole("button", { name: "检查更新", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "关闭设置", exact: true }).click();

    // Invalid profile data goes through the real validation API; restart is not sent.
    await application.evaluate(({ ipcMain }, channel) => {
      const original = (ipcMain as unknown as InstrumentedIpc)._invokeHandlers.get(channel)!;
      (globalThis as DiagnosticMain).installCount = 0;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (...args: unknown[]) => {
        const globals = globalThis as DiagnosticMain;
        globals.installCount = (globals.installCount ?? 0) + 1;
        return original(...args);
      });
    }, IPC.updatesInstallAndRestart);
    await page.getByLabel("名称", { exact: true }).fill("");
    await presentState(application, ready);
    await page.getByRole("button", { name: "重启更新", exact: true }).click();
    await expect(page.getByText("资料未能保存，请先保存后再重启更新。", { exact: true })).toBeVisible();
    expect(await application.evaluate(() => (globalThis as DiagnosticMain).installCount)).toBe(0);
    expect(errors).toEqual([]);
    await page.screenshot({ path: join(tmpdir(), "aevoren-update-save-failure.png") });
    await page.getByLabel("名称", { exact: true }).fill("更新按钮验收");
  } finally {
    await application.close();
    removeTestDirectory(data);
  }
});
