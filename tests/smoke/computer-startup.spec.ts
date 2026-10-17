import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { AppRepository } from "../../src/main/database";
import type { AevorenBotApi } from "../../src/shared/contracts";
import type { BrowserScope, ComputerStartup } from "../../src/shared/browser-contracts";
import { selectDetailsTab, openInspector } from "./navigation";
import { closeTestApplication, removeTestDirectory } from "./test-cleanup";

type StartupFixture = { calls: number; opens: number; startup: ComputerStartup | null; finish(cancelled?: boolean): void };
// Browser plugin not available. Controlled delayed IPC isolates the rendered
// startup/cancel/retry states. Actual Docker acceptance runs separately.
async function withStartup(blocked: boolean, run: (page: Page, application: ElectronApplication) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "aevoren-computer-startup-"));
  const database = new AppRepository(join(directory, "app.sqlite")); database.setSetting("appearance.theme", "dark", false); database.close();
  const executablePath = process.env.AEVOREN_PACKAGED_APP_PATH;
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("AEVOREN_BOT_FAKE_")));
  const application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : ["."]), "--use-mock-keychain"], cwd: process.cwd(),
    env: { ...inherited, AEVOREN_BOT_USER_DATA_DIR: directory, AEVOREN_BOT_DB_PATH: join(directory, "app.sqlite"), AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_DISABLE_UPDATES: "1" } });
  try {
    const page = await application.firstWindow(); const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await expect(page).toHaveTitle("Aevoren Bot"); await expect(page.locator(".app-shell")).toBeVisible();
    await page.evaluate(async () => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const result = await api.bots.create(); if (!result.ok) throw new Error(result.error.safeMessage);
      const updated = await api.bots.update({ id: result.data.bot.id, expectedVersion: result.data.bot.version, patch: { name: "启动反馈验收", avatarShape: "rounded", avatarColor: "cobalt" } });
      if (!updated.ok) throw new Error(updated.error.safeMessage);
    });
    await page.reload();
    await application.evaluate(({ ipcMain, BrowserWindow }, initiallyBlocked) => {
      let owner: BrowserScope | undefined, resolvePending: ((value: unknown) => void) | undefined;
      const fixture: StartupFixture = { calls: 0, opens: 0, startup: null, finish(cancelled = false) {
        if (!fixture.startup || !owner) return;
        fixture.startup = { ...fixture.startup, phase: cancelled ? "cancelled" : "error", blocker: cancelled ? null : "startup-failed", message: cancelled ? "电脑启动已取消" : "准备电脑超时，请检查网络后重试。" };
        BrowserWindow.getAllWindows()[0]!.webContents.send("browser:changed", { ...owner, type: "startup", startup: fixture.startup });
        resolvePending?.({ ok: false, error: { code: cancelled ? "TOOL_EXECUTION_CANCELLED" : "BROWSER_UNAVAILABLE", domain: "tool", retryable: true, safeMessage: fixture.startup.message } }); resolvePending = undefined;
      } };
      Object.assign(globalThis, { computerStartupFixture: fixture });
      for (const channel of ["browser:start", "computer:startupStatus", "computer:cancelStartup", "computer:openDocker", "environments:probe"]) ipcMain.removeHandler(channel);
      ipcMain.handle("computer:startupStatus", () => ({ ok: true, data: fixture.startup }));
      ipcMain.handle("browser:start", (_event, input: BrowserScope) => {
        owner = input; fixture.calls++;
        fixture.startup = { attemptId: crypto.randomUUID(), phase: "preparing-browser", message: "正在准备浏览器组件", blocker: null };
        if (initiallyBlocked && fixture.calls === 1) fixture.startup = { ...fixture.startup, phase: "error", message: "Docker 尚未启动", blocker: "docker-stopped" };
        BrowserWindow.getAllWindows()[0]!.webContents.send("browser:changed", { ...owner, type: "startup", startup: fixture.startup });
        if (fixture.startup.phase === "error") return { ok: false, error: { code: "ENVIRONMENT_UNAVAILABLE", domain: "tool", retryable: true, safeMessage: fixture.startup.message } };
        return new Promise(resolve => { resolvePending = resolve; });
      });
      ipcMain.handle("computer:cancelStartup", () => { fixture.finish(true); return { ok: true, data: fixture.startup }; });
      ipcMain.handle("computer:openDocker", () => { fixture.opens++; return { ok: true, data: undefined }; });
      ipcMain.handle("environments:probe", () => ({ ok: true, data: { available: fixture.opens > 0, dockerInstalled: true, daemonReachable: fixture.opens > 0 } }));
    }, blocked);
    await page.locator(".sidebar").getByRole("listitem", { name: "启动反馈验收", exact: true }).click();
    await openInspector(page);
    await selectDetailsTab(page.getByRole("main", { name: "联系人资料", exact: true }), "电脑");
    await run(page, application);
    expect(errors).toEqual([]);
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()))).toBe(true);
  } finally {
    await application.evaluate(() => (globalThis as unknown as { computerStartupFixture?: StartupFixture }).computerStartupFixture?.finish(true));
    await closeTestApplication(application); removeTestDirectory(directory);
  }
}

test("opening the computer prepares once, survives tab changes, cancels and offers an explicit retry", async () => {
  await withStartup(false, async (page, application) => {
    const contact = page.getByRole("main", { name: "联系人资料", exact: true });
    const panel = contact.getByRole("region", { name: "电脑", exact: true });
    await expect(panel.getByRole("heading", { name: "正在准备电脑", exact: true })).toBeVisible();
    await expect(panel.getByText("正在准备浏览器组件", { exact: true })).toBeVisible();
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(panel.getByRole("button", { name: "启动浏览器与电脑", exact: true })).toHaveCount(0);
    await expect(panel.getByText("示范技能", { exact: true })).toHaveCount(0);
    await selectDetailsTab(contact, "详情"); await selectDetailsTab(contact, "电脑");
    expect(await application.evaluate(() => (globalThis as unknown as { computerStartupFixture: StartupFixture }).computerStartupFixture.calls)).toBe(1);
    await expect(panel.getByText("正在准备浏览器组件", { exact: true })).toBeVisible();
    if (process.env.AEVOREN_STARTUP_SCREENSHOT) await page.screenshot({ path: process.env.AEVOREN_STARTUP_SCREENSHOT });
    await panel.getByRole("button", { name: "取消启动", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "电脑已停止", exact: true })).toBeVisible();
    expect(await application.evaluate(() => (globalThis as unknown as { computerStartupFixture: StartupFixture }).computerStartupFixture.calls)).toBe(1);
    await panel.getByRole("button", { name: "启动电脑", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "正在准备电脑", exact: true })).toBeVisible();
    await application.evaluate(() => (globalThis as unknown as { computerStartupFixture: StartupFixture }).computerStartupFixture.finish());
    await expect(panel.getByRole("heading", { name: "准备电脑超时，请检查网络后重试。", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "重试", exact: true })).toBeVisible();
  });
});

test("a stopped Docker engine has one action and resumes preparation when ready", async () => {
  await withStartup(true, async (page, application) => {
    const panel = page.getByRole("region", { name: "电脑", exact: true });
    await expect(panel.getByRole("heading", { name: "Docker 尚未启动", exact: true })).toBeVisible();
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    if (process.env.AEVOREN_BLOCKED_SCREENSHOT) await page.screenshot({ path: process.env.AEVOREN_BLOCKED_SCREENSHOT });
    await panel.getByRole("button", { name: "打开 Docker", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "正在准备电脑", exact: true })).toBeVisible();
    expect(await application.evaluate(() => {
      const f = (globalThis as unknown as { computerStartupFixture: StartupFixture }).computerStartupFixture; return { opens: f.opens, calls: f.calls };
    })).toEqual({ opens: 1, calls: 2 });
  });
});
