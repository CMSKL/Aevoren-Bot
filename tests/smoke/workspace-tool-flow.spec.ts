import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { AppRepository } from "../../src/main/database";
import { WorkspaceService } from "../../src/main/workspace-service";

test("approves, denies, and restores one workspace tool flow without exposing journal content", async () => {
  test.setTimeout(60_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-tool-e2e-data-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "aevoren-tool-e2e-root-"));
  const databasePath = join(userDataDir, "aevoren-bot.sqlite");
  writeFileSync(join(workspaceRoot, "brief.txt"), "E2E_WORKSPACE_CONTENT", "utf8");
  const repository = new AppRepository(databasePath);
  repository.createBot();
  await new WorkspaceService(repository).registerRoot(workspaceRoot);
  repository.close();

  let application: ElectronApplication | undefined;
  const consoleErrors: string[] = [];
  const launch = async (): Promise<ElectronApplication> => electron.launch({
    args: ["."],
    cwd: process.cwd(),
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      AEVOREN_BOT_USER_DATA_DIR: userDataDir,
      AEVOREN_BOT_FAKE_PROVIDER: "1",
      AEVOREN_BOT_FAKE_WORKSPACE_TOOL: "read",
      AEVOREN_BOT_FAKE_WORKSPACE_PATH: "brief.txt",
    },
  });

  try {
    application = await launch();
    let page = await application.firstWindow();
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    await page.locator('textarea[aria-label="消息"]').fill("请读取工作区摘要");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const firstTool = page.getByTestId("workspace-tool-activity").last();
    await expect(firstTool).toContainText("等待你的确认");
    await firstTool.getByRole("button", { name: "仅允许一次" }).click();
    await expect(firstTool).toContainText("读取完成");
    await expect(page.getByText(/E2E_WORKSPACE_CONTENT/).last()).toBeVisible();
    await expect(page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(1);

    await page.locator('textarea[aria-label="消息"]').fill("这次拒绝读取");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const secondTool = page.getByTestId("workspace-tool-activity").last();
    await expect(secondTool).toContainText("等待你的确认");
    await secondTool.getByRole("button", { name: "拒绝" }).click();
    await expect(secondTool).toContainText("已拒绝");
    await expect(page.getByText(/TOOL_DENIED/).last()).toBeVisible();
    await expect(page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(2);
    expect(await page.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    await application.close();
    application = await launch();
    page = await application.firstWindow();
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(390, 740));
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(390);
    await expect(page.getByTestId("workspace-tool-activity")).toHaveCount(2);
    await expect(page.getByTestId("workspace-tool-activity").first()).toContainText("读取完成");
    await expect(page.getByTestId("workspace-tool-activity").last()).toContainText("已拒绝");
    expect(await page.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(consoleErrors).toEqual([]);
    await application.close();
    application = undefined;

    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT state,attempt_count FROM tool_invocations ORDER BY created_at").all()).toEqual([
      { state: "succeeded", attempt_count: 1 },
      { state: "denied", attempt_count: 0 },
    ]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM tool_invocations WHERE result_digest IS NOT NULL").get()).toEqual({ count: 1 });
    expect(JSON.stringify(database.prepare("SELECT arguments_json,result_metadata_json FROM tool_invocations").all())).not.toContain("E2E_WORKSPACE_CONTENT");
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  } finally {
    if (application) application.process().kill("SIGKILL");
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
