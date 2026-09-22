import { removeTestDirectory } from "./test-cleanup";
import { expect, test, _electron as electron, type ElectronApplication } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AevorenBotApi } from "../../src/shared/contracts";
import { AppRepository } from "../../src/main/database";
import { WorkspaceService } from "../../src/main/workspace-service";

test("shows only public Workspace identity and revokes access without touching daily data", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-workspace-smoke-data-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "aevoren-workspace-smoke-root-"));
  const databasePath = join(userDataDir, "aevoren-bot.sqlite");
  const repository = new AppRepository(databasePath);
  const registered = await new WorkspaceService(repository).registerRoot(workspaceRoot);
  writeFileSync(join(workspaceRoot, "delivery.md"), "# Real delivery\n", "utf8");
  repository.close();
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({
      args: ["."],
      cwd: process.cwd(),
      env: {
        ...process.env,
        AEVOREN_BOT_USER_DATA_DIR: userDataDir,
        AEVOREN_BOT_FAKE_PROVIDER: "1",
        AEVOREN_BOT_TEST_HIDDEN: "1",
      },
    });
    const page = await application.firstWindow();
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.getByRole("button", { name: "工作区" }).click();
    const dialog = page.getByRole("dialog", { name: "工作区" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(registered.workspace.name, { exact: true })).toBeVisible();
    await expect(dialog).not.toContainText(workspaceRoot);
    await dialog.getByLabel("允许 Bot 新建 Markdown/CSV").check();
    await dialog.getByLabel("自动批准此工作区的受限工具").check();
    await expect(dialog.getByLabel("允许 Bot 新建 Markdown/CSV")).toBeChecked();
    await expect(dialog.getByLabel("自动批准此工作区的受限工具")).toBeChecked();

    const publicResult = await page.evaluate(() => (
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.workspaces.list()
    ));
    expect(publicResult).toMatchObject({
      ok: true,
      data: [{ id: registered.workspace.id, name: registered.workspace.name, writeEnabled: true, automationEnabled: true }],
    });
    expect(JSON.stringify(publicResult)).not.toContain(workspaceRoot);
    const revealResult = await page.evaluate(({ workspaceId }) => (
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.workspaces.reveal({ workspaceId, path: "delivery.md" })
    ), { workspaceId: registered.workspace.id });
    expect(revealResult).toEqual({ ok: true, data: true });
    const unsafeReveal = await page.evaluate(({ workspaceId }) => (
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.workspaces.reveal({ workspaceId, path: "../outside.md" })
    ), { workspaceId: registered.workspace.id });
    expect(unsafeReveal).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });

    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(390, 640));
    const compactLayout = await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        withinViewport: rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight,
        contentContained: element.scrollWidth <= element.clientWidth,
      };
    });
    expect(compactLayout).toEqual({ withinViewport: true, contentContained: true });

    await dialog.getByRole("button", { name: "移除" }).click();
    await expect(dialog.getByText("尚未授权工作区。")).toBeVisible();
    await application.close();
    application = undefined;
    expect(consoleErrors).toEqual([]);

    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT removed_at FROM workspaces WHERE id = ?").get(registered.workspace.id)).toEqual({
      removed_at: expect.any(String),
    });
    database.close();
  } finally {
    if (application) application.process().kill("SIGKILL");
    removeTestDirectory(userDataDir);
    removeTestDirectory(workspaceRoot);
  }
});
