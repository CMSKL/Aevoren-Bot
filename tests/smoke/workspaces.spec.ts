import { removeTestDirectory } from "./test-cleanup";
import { openBotList, openWorkspaceTab } from "./navigation";
import { expect, test, _electron as electron, type ElectronApplication } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_PROJECT_ID, type AevorenBotApi } from "../../src/shared/contracts";
import { AppRepository } from "../../src/main/database";
import { WorkspaceService } from "../../src/main/workspace-service";

test("shows only public Workspace identity and revokes access without touching daily data", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-workspace-smoke-data-"));
  const workspaceParent = mkdtempSync(join(tmpdir(), "aevoren-workspace-smoke-folders-"));
  const workspaceRoot = join(workspaceParent, "现有资料");
  const workspaceRootToAdd = join(workspaceParent, "团队资料");
  mkdirSync(workspaceRoot);
  mkdirSync(workspaceRootToAdd);
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
        AEVOREN_BOT_TEST_HIDDEN: "1",
        AEVOREN_BOT_WORKSPACE_TEST_PATH: workspaceRootToAdd,
      },
    });
    const page = await application.firstWindow();
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByLabel("外观主题").selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("button", { name: "关闭设置" }).click();
    await openWorkspaceTab(page);
    const sidebarWorkspaces = page.locator(".sidebar-workspace");
    const workspaceRow = page.getByRole("button", { name: `管理工作区 ${registered.workspace.name}` });
    await expect(workspaceRow).toBeVisible();
    await expect(page.locator(".conversation-header").getByRole("button", { name: "工作区" })).toHaveCount(0);
    await workspaceRow.click();
    const dialog = page.getByRole("dialog", { name: "工作区权限" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(registered.workspace.name, { exact: true })).toBeVisible();
    await expect(dialog).not.toContainText(workspaceRoot);
    await dialog.getByLabel("允许 Bot 新建 Markdown/CSV").check();
    await dialog.getByLabel("自动批准此文件夹的受限工具").check();
    await expect(dialog.getByLabel("允许 Bot 新建 Markdown/CSV")).toBeChecked();
    await expect(dialog.getByLabel("自动批准此文件夹的受限工具")).toBeChecked();

    const publicResult = await page.evaluate(() => (
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.workspaces.list()
    ));
    expect(publicResult).toMatchObject({
      ok: true,
      data: expect.arrayContaining([expect.objectContaining({
        id: registered.workspace.id,
        name: registered.workspace.name,
        writeEnabled: true,
        automationEnabled: true,
      })]),
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

    await dialog.getByRole("button", { name: "完成" }).click();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));
    await page.getByRole("button", { name: "新建工作区", exact: true }).click();
    const addedWorkspaceName = workspaceRootToAdd.split(/[\\/]/u).at(-1)!;
    const addedWorkspaceRow = page.getByRole("button", { name: `管理工作区 ${addedWorkspaceName}` });
    await expect(page.getByRole("button", { name: addedWorkspaceName, exact: true })).toBeVisible();
    await expect(page.locator(".sidebar-file-workspaces")).toHaveCount(0);
    await page.getByRole("button", { name: "新建工作区", exact: true }).click();
    await expect(addedWorkspaceRow).toHaveCount(1);
    await expect(addedWorkspaceRow).toBeVisible();
    await expect(sidebarWorkspaces).not.toContainText(workspaceRootToAdd);
    await expect(page.locator(".bot-action-notice")).toHaveCount(0);
    await page.locator(".sidebar").screenshot({ path: "/tmp/aevoren-workspace-added-sidebar.png" });

    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(390, 844));
    await openBotList(page);
    await expect(addedWorkspaceRow).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.locator(".sidebar").screenshot({ path: "/tmp/aevoren-workspace-added-sidebar-compact.png" });
    await page.getByRole("button", { name: "关闭 Bot 列表", exact: true }).click();

    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));
    await page.getByRole("button", { name: `管理工作区 ${registered.workspace.name}` }).click();
    const reopenedDialog = page.getByRole("dialog", { name: "工作区权限" });
    await reopenedDialog.locator(".workspace-row").filter({ hasText: registered.workspace.name }).getByRole("button", { name: "取消授权" }).click();
    await expect(reopenedDialog.getByText(registered.workspace.name, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: `管理工作区 ${registered.workspace.name}` })).toHaveCount(0);
    await expect(page.getByRole("button", { name: `管理工作区 ${addedWorkspaceName}` })).toBeVisible();
    await expect(page.getByRole("button", { name: registered.workspace.name, exact: true })).toBeVisible();
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
    removeTestDirectory(workspaceParent);
  }
});

test("links existing project conversations to a real folder and restores the unified tree after restart", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-folder-link-smoke-"));
  const root = join(userDataDir, "团队工作区");
  mkdirSync(root);
  writeFileSync(join(root, "现有文档.md"), "# 保留原文件\n", "utf8");
  const repository = new AppRepository(join(userDataDir, "aevoren-bot.sqlite"));
  const first = repository.createBot(DEFAULT_PROJECT_ID);
  repository.updateBot(first.bot.id, first.bot.version, { name: "研究员" });
  const second = repository.createBot(DEFAULT_PROJECT_ID);
  repository.updateBot(second.bot.id, second.bot.version, { name: "编辑" });
  const room = repository.createRoom({ name: "现有群聊", memberBotIds: [first.bot.id, second.bot.id], projectId: DEFAULT_PROJECT_ID });
  const registered = await new WorkspaceService(repository).registerRoot(root);
  repository.setSetting("appearance.theme", "dark", false);
  repository.close();
  const env = { ...process.env, AEVOREN_BOT_USER_DATA_DIR: userDataDir, AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_WORKSPACE_TEST_PATH: root };
  let application: ElectronApplication | undefined;
  const consoleErrors: string[] = [];
  try {
    application = await electron.launch({ args: ["."], cwd: process.cwd(), env });
    let page = await application.firstWindow();
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    await openWorkspaceTab(page);
    await page.getByRole("button", { name: "关联文件夹", exact: true }).click();
    const project = page.locator('.sidebar-project').filter({ has: page.getByRole("button", { name: "团队工作区", exact: true }) });
    await expect(project).toHaveCount(1);
    await expect(project.getByRole("listitem", { name: "研究员" })).toBeVisible();
    await expect(project.getByRole("listitem", { name: "现有群聊" })).toBeVisible();
    const result = await page.evaluate(() => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.projects.list());
    expect(result).toMatchObject({ ok: true, data: [{ id: DEFAULT_PROJECT_ID, name: "团队工作区", workspaceId: registered.workspace.id }] });
    await project.getByRole("button", { name: "管理工作区 团队工作区" }).click();
    await page.getByLabel("允许 Bot 新建 Markdown/CSV").check();
    await expect(page.getByLabel("允许 Bot 新建 Markdown/CSV")).toBeChecked();
    await page.getByRole("button", { name: "完成", exact: true }).click();
    await application.close();
    application = await electron.launch({ args: ["."], cwd: process.cwd(), env });
    page = await application.firstWindow();
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    await openWorkspaceTab(page);
    await expect(page.getByRole("listitem", { name: "现有群聊" })).toBeVisible();
    await expect(page.getByRole("listitem", { name: "研究员" })).toBeVisible();
    const roomResult = await page.evaluate((id) => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.rooms.get(id), room.room.id);
    expect(roomResult).toMatchObject({ ok: true, data: { room: { id: room.room.id, projectId: DEFAULT_PROJECT_ID } } });
    for (const width of [1180, 1020, 620, 390]) {
      await application.evaluate(({ BrowserWindow }, nextWidth) => BrowserWindow.getAllWindows()[0]?.setSize(nextWidth, 844), width);
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
      await openBotList(page);
      await expect(page.getByRole("button", { name: "团队工作区", exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.locator(".sidebar").screenshot({ path: `/tmp/aevoren-folder-workspace-${width}.png` });
    }
    await page.getByRole("button", { name: "管理工作区 团队工作区" }).click();
    const dialog = page.getByRole("dialog", { name: "工作区权限" });
    await expect(dialog.getByLabel("允许 Bot 新建 Markdown/CSV")).toBeChecked();
    await dialog.getByRole("button", { name: "取消授权", exact: true }).click();
    await dialog.getByRole("button", { name: "完成", exact: true }).click();
    await expect(page.getByRole("button", { name: "重新授权文件夹", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "重新授权文件夹", exact: true }).click();
    await expect(page.getByRole("button", { name: "管理工作区 团队工作区" })).toBeVisible();
    await expect(page.getByRole("listitem", { name: "现有群聊" })).toBeVisible();
    await application.evaluate((_electron, missingRoot) => { process.env.AEVOREN_BOT_WORKSPACE_TEST_PATH = missingRoot; }, join(root, "不存在"));
    await page.getByRole("button", { name: "新建工作区", exact: true }).click();
    await expect(page.locator(".sidebar").getByRole("alert")).toBeVisible();
    await expect(page.getByRole("listitem", { name: "现有群聊" })).toBeVisible();
    await application.evaluate((_electron, selectedRoot) => { process.env.AEVOREN_BOT_WORKSPACE_TEST_PATH = selectedRoot; }, root);
    await page.getByRole("button", { name: "新建工作区", exact: true }).click();
    await expect(page.locator(".sidebar").getByRole("alert")).toHaveCount(0);
    expect(readFileSync(join(root, "现有文档.md"), "utf8")).toBe("# 保留原文件\n");
    expect(consoleErrors).toEqual([]);
  } finally {
    if (application) await application.close();
    removeTestDirectory(userDataDir);
  }
});
