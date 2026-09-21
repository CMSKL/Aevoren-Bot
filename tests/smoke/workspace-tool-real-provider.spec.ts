import { removeTestDirectory } from "./test-cleanup";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test } from "@playwright/test";
import type { AevorenBotApi } from "@shared/contracts";
import { AppRepository } from "../../src/main/database";
import { WorkspaceService } from "../../src/main/workspace-service";

const isolatedDatabase = process.env.AEVOREN_BOT_REAL_PROVIDER_DB_PATH;

test("runs one approved workspace read through the configured real Provider", async () => {
  test.skip(!isolatedDatabase, "requires AEVOREN_BOT_REAL_PROVIDER_DB_PATH pointing to an isolated configured database snapshot");
  test.setTimeout(180_000);
  const root = mkdtempSync(join(tmpdir(), "aevoren-real-workspace-"));
  const token = `REAL_WORKSPACE_${Date.now().toString(36).toUpperCase()}`;
  writeFileSync(join(root, "provider-check.txt"), token, "utf8");
  const repository = new AppRepository(isolatedDatabase!);
  let botName: string;
  let sessionId: string;
  try {
    const created = repository.createBot();
    botName = `Workspace 真实验收-${Date.now().toString(36)}`;
    sessionId = created.session.id;
    repository.updateBot(created.bot.id, created.bot.version, {
      name: botName,
      instructions: "必须先且只调用一次 workspace_read，读取用户指定的文件；得到工具结果后，只输出文件原文。不要调用其他工具。",
    });
    await new WorkspaceService(repository).registerRoot(root);
  } finally {
    repository.close();
  }

  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !["AEVOREN_BOT_FAKE_PROVIDER", "AEVOREN_BOT_DB_PATH", "AEVOREN_BOT_USER_DATA_DIR"].includes(entry[0]),
    ),
  );
  const testUserData = join(dirname(isolatedDatabase!), "workspace-tool-electron-user-data");
  mkdirSync(testUserData, { recursive: true });
  environment.AEVOREN_BOT_USE_SYSTEM_SAFE_STORAGE = "1";
  environment.AEVOREN_BOT_DB_PATH = isolatedDatabase!;
  environment.AEVOREN_BOT_USER_DATA_DIR = testUserData;
  environment.AEVOREN_BOT_TEST_HIDDEN = "1";

  const application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment });
  try {
    const page = await application.firstWindow();
    const connection = await page.evaluate(() =>
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.providers.test("openai-compatible.default"),
    );
    expect(connection.ok, connection.ok ? undefined : connection.error.code).toBe(true);
    await page.locator(".bot-row").filter({ hasText: botName }).click();
    await expect(page.getByRole("heading", { name: botName })).toBeVisible();
    await page.getByLabel("消息").fill("请读取 provider-check.txt，并按 Instructions 返回结果。");
    await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const tool = page.getByTestId("workspace-tool-activity").last();
    await expect(tool).toContainText("等待你的确认", { timeout: 90_000 });
    await tool.getByRole("button", { name: "仅允许一次" }).click();
    await expect(tool).toContainText("执行完成", { timeout: 30_000 });
    await expect(page.locator('article.message-assistant[data-status="completed"]').last()).toContainText(token, { timeout: 90_000 });
  } finally {
    await application.close();
    removeTestDirectory(root);
  }

  const database = new DatabaseSync(isolatedDatabase!, { readOnly: true });
  try {
    expect(database.prepare("SELECT state,attempt_count FROM tool_invocations WHERE session_id = ?").all(sessionId)).toEqual([
      { state: "succeeded", attempt_count: 1 },
    ]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM runtime_runs WHERE session_id = ? AND state = 'completed'").get(sessionId)).toEqual({ count: 1 });
    expect(JSON.stringify(database.prepare("SELECT arguments_json,result_metadata_json FROM tool_invocations WHERE session_id = ?").all(sessionId))).not.toContain(token);
  } finally {
    database.close();
  }
});
