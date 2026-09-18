import { removeTestDirectory } from "./test-cleanup";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { AppRepository } from "../../src/main/database";
import { WorkspaceService } from "../../src/main/workspace-service";

async function forceKill(application: ElectronApplication): Promise<void> {
  const process = application.process();
  if (process.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => process.once("exit", () => resolve()));
  process.kill("SIGKILL");
  await exited;
}

test("routes approved workspace tools through one Room speaker and recovers a pending Room tool safely", async () => {
  test.setTimeout(90_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-room-tool-e2e-data-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "aevoren-room-tool-e2e-root-"));
  const databasePath = join(userDataDir, "aevoren-bot.sqlite");
  const marker = "ROOM_WORKSPACE_CONTENT_7A19";
  writeFileSync(join(workspaceRoot, "room-brief.txt"), marker, "utf8");
  const repository = new AppRepository(databasePath);
  const analystCreated = repository.createBot();
  const analyst = repository.updateBot(analystCreated.bot.id, analystCreated.bot.version, { name: "群聊分析师" });
  const reviewerCreated = repository.createBot();
  const reviewer = repository.updateBot(reviewerCreated.bot.id, reviewerCreated.bot.version, { name: "群聊评审员" });
  const room = repository.createRoom({ name: "Workspace Room 验收", memberBotIds: [analyst.id, reviewer.id] });
  await new WorkspaceService(repository).registerRoot(workspaceRoot);
  repository.close();

  const environment = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    AEVOREN_BOT_USER_DATA_DIR: userDataDir,
    AEVOREN_BOT_FAKE_PROVIDER: "1",
    AEVOREN_BOT_FAKE_WORKSPACE_TOOL: "read",
    AEVOREN_BOT_FAKE_WORKSPACE_PATH: "room-brief.txt",
  };
  const launch = async (): Promise<ElectronApplication> => electron.launch({ args: ["."], cwd: process.cwd(), env: environment });
  let application: ElectronApplication | undefined;
  const consoleErrors: string[] = [];

  try {
    application = await launch();
    let page = await application.firstWindow();
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    await page.locator(".bot-row").filter({ hasText: room.room.name }).click();
    await expect(page.getByRole("heading", { name: room.room.name })).toBeVisible();

    const input = page.getByLabel("消息");
    await input.fill("@群聊分析师");
    await expect(page.getByRole("listbox", { name: "提及 Bot" })).toBeVisible();
    await input.press("Enter");
    await input.fill("请读取群聊工作区资料");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const allowedTool = page.getByTestId("workspace-tool-activity").last();
    await expect(allowedTool).toContainText("等待你的确认");
    await allowedTool.getByRole("button", { name: "仅允许一次" }).click();
    await expect(allowedTool).toContainText("执行完成");
    await expect(page.getByText(new RegExp(marker)).last()).toBeVisible();
    await expect(page.locator(".speaker-link")).toHaveText([analyst.name]);
    await expect(page.getByTestId("room-batch-state")).toContainText("completed");

    await input.fill("@群聊评审员");
    await expect(page.getByRole("listbox", { name: "提及 Bot" })).toBeVisible();
    await input.press("Enter");
    await input.fill("这次拒绝群聊读取");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const deniedTool = page.getByTestId("workspace-tool-activity").last();
    await expect(deniedTool).toContainText("等待你的确认");
    await deniedTool.getByRole("button", { name: "拒绝" }).click();
    await expect(deniedTool).toContainText("已拒绝");
    await expect(page.getByText(/TOOL_DENIED/).last()).toBeVisible();
    await expect(page.locator(".speaker-link")).toHaveText([analyst.name, reviewer.name]);

    await input.fill("@群聊分析师");
    await expect(page.getByRole("listbox", { name: "提及 Bot" })).toBeVisible();
    await input.press("Enter");
    await input.fill("等待审批后模拟进程中断");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const pendingTool = page.getByTestId("workspace-tool-activity").last();
    await expect(pendingTool).toContainText("等待你的确认");
    await forceKill(application);
    application = undefined;

    application = await launch();
    page = await application.firstWindow();
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    await page.locator(".bot-row").filter({ hasText: room.room.name }).click();
    await expect(page.getByTestId("workspace-tool-activity")).toHaveCount(3);
    await expect(page.getByTestId("workspace-tool-activity").nth(0)).toContainText("执行完成");
    await expect(page.getByTestId("workspace-tool-activity").nth(1)).toContainText("已拒绝");
    await expect(page.getByTestId("workspace-tool-activity").nth(2)).toContainText("确认已过期");
    await expect(page.getByTestId("workspace-tool-activity").nth(2).getByRole("button")).toHaveCount(0);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(390, 740));
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(consoleErrors).toEqual([]);
    await application.close();
    application = undefined;

    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT state,attempt_count FROM tool_invocations ORDER BY created_at").all()).toEqual([
      { state: "succeeded", attempt_count: 1 },
      { state: "denied", attempt_count: 0 },
      { state: "expired", attempt_count: 0 },
    ]);
    expect(database.prepare("SELECT state FROM approval_requests ORDER BY created_at").all()).toEqual([
      { state: "allowed" },
      { state: "denied" },
      { state: "expired" },
    ]);
    expect(database.prepare("SELECT state,COUNT(*) AS count FROM room_batches GROUP BY state ORDER BY state").all()).toEqual([
      { state: "completed", count: 2 },
      { state: "interrupted", count: 1 },
    ]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM room_turns WHERE member_bot_id = ?").get(analyst.id)).toEqual({ count: 2 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM room_turns WHERE member_bot_id = ?").get(reviewer.id)).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM transcript_entries WHERE role = 'assistant' AND speaker_bot_id IS NOT NULL").get()).toEqual({ count: 3 });
    expect(JSON.stringify(database.prepare("SELECT arguments_json,result_metadata_json FROM tool_invocations").all())).not.toContain(marker);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  } finally {
    if (application) await forceKill(application);
    removeTestDirectory(userDataDir);
    removeTestDirectory(workspaceRoot);
  }
});
