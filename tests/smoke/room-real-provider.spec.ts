import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import type { MsBotApi } from "@shared/contracts";

const isolatedUserData = process.env.MS_BOT_REAL_PROVIDER_USER_DATA_DIR;
const isolatedDatabase = process.env.MS_BOT_REAL_PROVIDER_DB_PATH;

async function createNamedBot(page: Page, name: string): Promise<void> {
  const before = await page.locator(".bot-row").count();
  await page.getByRole("button", { name: "新建聊天" }).click();
  await page.getByRole("button", { name: "创建新 Bot" }).click();
  await expect(page.locator(".bot-row")).toHaveCount(before + 1);
  await page.getByLabel("名称").fill(name);
  await page.getByLabel("名称").blur();
  await expect(page.getByTestId("profile-save-status")).toContainText("已保存");
  await page.getByLabel("描述").fill("只直接用一句话回答当前用户请求。禁止调用 handoff_to_agent，禁止向其他 Bot 转交任务。");
  await page.getByLabel("描述").blur();
  await expect(page.getByTestId("profile-save-status")).toContainText("已保存");
}

async function selectMention(page: Page, query: string): Promise<void> {
  const input = page.getByLabel("消息");
  await input.fill(`@${query}`);
  await expect(page.getByRole("listbox", { name: "提及 Bot" })).toBeVisible();
  await input.press("Enter");
}

test("routes explicit, multiple, and automatic Room targets through the configured real Provider", async () => {
  test.skip(
    !isolatedDatabase && !isolatedUserData,
    "requires an isolated database with the default safeStorage context, or isolated userData with a newly entered Key",
  );
  test.setTimeout(300_000);
  expect(
    !(isolatedDatabase && isolatedUserData),
    "set only one of MS_BOT_REAL_PROVIDER_DB_PATH or MS_BOT_REAL_PROVIDER_USER_DATA_DIR",
  ).toBe(true);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] =>
      entry[1] !== undefined && ![
        "MS_BOT_FAKE_PROVIDER",
        "MS_BOT_DB_PATH",
        "MS_BOT_USER_DATA_DIR",
      ].includes(entry[0]),
    ),
  );
  environment.MS_BOT_USE_SYSTEM_SAFE_STORAGE = "1";
  if (isolatedDatabase) environment.MS_BOT_DB_PATH = isolatedDatabase;
  else environment.MS_BOT_USER_DATA_DIR = isolatedUserData!;
  const databasePath = isolatedDatabase ?? join(isolatedUserData!, "ms-bot.sqlite");
  const application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment });
  let roomName: string;
  try {
    const page = await application.firstWindow();
    const configured = await page.evaluate(async () => {
      const result = await (window as unknown as { msBot: MsBotApi }).msBot.settings.getModelConfiguration();
      return result.ok && result.data.apiKeyConfigured && Boolean(result.data.modelId);
    });
    expect(configured).toBe(true);
    const connection = await page.evaluate(() =>
      (window as unknown as { msBot: MsBotApi }).msBot.settings.testModelConnection(),
    );
    expect(connection.ok, connection.ok ? undefined : connection.error.code).toBe(true);
    await expect(page.locator(".bot-row").first()).toBeVisible();

    const suffix = Date.now().toString(36);
    const first = `真实验收甲-${suffix}`;
    const second = `真实验收乙-${suffix}`;
    roomName = `${first}、${second}`;
    await createNamedBot(page, first);
    await createNamedBot(page, second);
    await page.getByRole("button", { name: "新建聊天" }).click();
    await page.locator(".recipient-option").filter({ hasText: "创建群聊" }).click();
    await page.getByRole("button", { name: first, exact: true }).click();
    await page.getByRole("button", { name: second, exact: true }).click();
    await page.locator(".recipient-footer").getByRole("button", { name: "创建群聊", exact: true }).click();
    await expect(page.getByRole("heading", { name: roomName })).toBeVisible();

    await selectMention(page, first);
    await page.getByLabel("消息").fill("真实模型单目标验收。请用一句话确认收到。");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(1, { timeout: 90_000 });
    await expect(page.locator(".speaker-link").last()).toHaveText(first);
    await expect(page.locator("article.message-user").last().locator(".message-route-chip")).toHaveText([`@${first}`]);
    await expect(page.getByTestId("room-batch-state")).toContainText("completed");

    await selectMention(page, second);
    await selectMention(page, first);
    await page.getByLabel("消息").fill("真实模型双目标验收。请分别用一句话确认收到。");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(3, { timeout: 90_000 });
    expect(await page.locator(".speaker-link").allTextContents()).toEqual([first, first, second]);
    await expect(page.locator("article.message-user").last().locator(".message-route-chip")).toHaveText([`@${first}`, `@${second}`]);
    await expect(page.getByTestId("room-batch-state")).toContainText("completed");

    await page.getByLabel("消息").fill("真实模型自动选择验收。请由最合适的一位用一句话确认收到。");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(4, { timeout: 90_000 });
    await expect(page.locator("article.message-user").last().locator(".message-route-chip")).toHaveCount(1);
    await expect(page.locator("article.message-user").last()).toContainText("自动选择");
    await expect(page.getByTestId("room-batch-state")).toContainText("completed");
  } finally {
    await application.close();
  }

  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const room = database.prepare("SELECT id FROM rooms WHERE name = ?").get(roomName) as { id: string };
    expect(database.prepare("SELECT COUNT(*) AS count FROM room_batches WHERE room_id = ? AND state = 'completed'").get(room.id)).toEqual({ count: 3 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM room_turns AS turn JOIN room_batches AS batch ON batch.id = turn.batch_id WHERE batch.room_id = ? AND turn.state = 'completed'",
    ).get(room.id)).toEqual({ count: 4 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM runtime_runs AS run JOIN room_turns AS turn ON turn.runtime_run_id = run.id JOIN room_batches AS batch ON batch.id = turn.batch_id WHERE batch.room_id = ? AND run.state = 'completed'",
    ).get(room.id)).toEqual({ count: 4 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM transcript_entries AS entry JOIN sessions AS session ON session.id = entry.session_id WHERE session.room_id = ? AND entry.role = 'user'",
    ).get(room.id)).toEqual({ count: 3 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM transcript_entries AS entry JOIN sessions AS session ON session.id = entry.session_id WHERE session.room_id = ? AND entry.role = 'assistant' AND entry.status = 'completed' AND entry.speaker_bot_id IS NOT NULL AND entry.source_turn_id IS NOT NULL",
    ).get(room.id)).toEqual({ count: 4 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM room_turns AS turn JOIN room_batches AS batch ON batch.id = turn.batch_id WHERE batch.room_id = ? AND turn.state IN ('queued', 'running')",
    ).get(room.id)).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM agent_handoffs AS handoff JOIN room_batches AS batch ON batch.id = handoff.run_id WHERE batch.room_id = ?",
    ).get(room.id)).toEqual({ count: 0 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    database.close();
  }
});
