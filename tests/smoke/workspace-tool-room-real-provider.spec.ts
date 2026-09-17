import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test } from "@playwright/test";
import type { AevorenBotApi } from "@shared/contracts";
import { AppRepository } from "../../src/main/database";
import { WorkspaceService } from "../../src/main/workspace-service";

const isolatedDatabase = process.env.AEVOREN_BOT_REAL_PROVIDER_DB_PATH;

test("routes one approved Room workspace read through the configured real Provider", async () => {
  test.skip(!isolatedDatabase, "requires AEVOREN_BOT_REAL_PROVIDER_DB_PATH pointing to an isolated configured database snapshot");
  test.setTimeout(180_000);
  const root = mkdtempSync(join(tmpdir(), "aevoren-real-room-workspace-"));
  const token = `REAL_ROOM_WORKSPACE_${Date.now().toString(36).toUpperCase()}`;
  writeFileSync(join(root, "room-provider-check.txt"), token, "utf8");
  const repository = new AppRepository(isolatedDatabase!);
  let roomId: string;
  let sessionId: string;
  let targetBotId: string;
  let targetBotName: string;
  try {
    const suffix = Date.now().toString(36);
    const targetCreated = repository.createBot();
    targetBotName = `Room Workspace 真实验收-${suffix}`;
    const target = repository.updateBot(targetCreated.bot.id, targetCreated.bot.version, {
      name: targetBotName,
      instructions: "必须先且只调用一次 workspace_read，读取用户指定的文件；得到工具结果后，只输出文件原文。不要调用 handoff_to_agent 或其他工具。",
    });
    const peerCreated = repository.createBot();
    const peer = repository.updateBot(peerCreated.bot.id, peerCreated.bot.version, {
      name: `Room Workspace 对照-${suffix}`,
      instructions: "只简短回答，不调用任何工具。",
    });
    const room = repository.createRoom({
      name: `Room Workspace E2E-${suffix}`,
      memberBotIds: [target.id, peer.id],
    });
    roomId = room.room.id;
    sessionId = room.session.id;
    targetBotId = target.id;
    await new WorkspaceService(repository).registerRoot(root);
  } finally {
    repository.close();
  }

  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && ![
        "AEVOREN_BOT_FAKE_PROVIDER",
        "AEVOREN_BOT_DB_PATH",
        "AEVOREN_BOT_USER_DATA_DIR",
      ].includes(entry[0]),
    ),
  );
  const testUserData = join(dirname(isolatedDatabase!), "workspace-tool-room-electron-user-data");
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
    await page.locator(".bot-row").filter({ hasText: "Room Workspace E2E" }).click();
    const input = page.getByLabel("消息");
    await input.fill("@真实验收");
    await expect(page.getByRole("listbox", { name: "提及 Bot" })).toBeVisible();
    await input.press("Enter");
    await input.fill("请读取 room-provider-check.txt，并按 Instructions 返回结果。");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const tool = page.getByTestId("workspace-tool-activity").last();
    await expect(tool).toContainText("等待你的确认", { timeout: 90_000 });
    await tool.getByRole("button", { name: "仅允许一次" }).click();
    await expect(tool).toContainText("读取完成", { timeout: 30_000 });
    const assistant = page.locator('article.message-assistant[data-status="completed"]').last();
    await expect(assistant).toContainText(token, { timeout: 90_000 });
    await expect(assistant.locator(".speaker-link")).toHaveText(targetBotName);
    await expect(page.getByTestId("room-batch-state")).toContainText("completed");
  } finally {
    await application.close();
    rmSync(root, { recursive: true, force: true });
  }

  const database = new DatabaseSync(isolatedDatabase!, { readOnly: true });
  try {
    expect(database.prepare("SELECT state,attempt_count FROM tool_invocations WHERE session_id = ?").all(sessionId)).toEqual([
      { state: "succeeded", attempt_count: 1 },
    ]);
    expect(database.prepare("SELECT state FROM room_batches WHERE room_id = ?").all(roomId)).toEqual([{ state: "completed" }]);
    expect(database.prepare("SELECT state,member_bot_id FROM room_turns WHERE batch_id IN (SELECT id FROM room_batches WHERE room_id = ?)").all(roomId)).toEqual([
      { state: "completed", member_bot_id: targetBotId },
    ]);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM transcript_entries WHERE session_id = ? AND role = 'assistant' AND status = 'completed' AND speaker_bot_id = ? AND source_turn_id IS NOT NULL",
    ).get(sessionId, targetBotId)).toEqual({ count: 1 });
    expect(JSON.stringify(database.prepare("SELECT arguments_json,result_metadata_json FROM tool_invocations WHERE session_id = ?").all(sessionId))).not.toContain(token);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    database.close();
  }
});
