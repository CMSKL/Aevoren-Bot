import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test } from "@playwright/test";
import { AppRepository } from "../../src/main/database";

const isolatedDatabase = process.env.AEVOREN_BOT_REAL_PROVIDER_DB_PATH;

test("routes one no-mention request through the real selector with at most two Provider calls", async () => {
  test.skip(!isolatedDatabase, "requires AEVOREN_BOT_REAL_PROVIDER_DB_PATH pointing to an isolated configured database copy");
  test.setTimeout(180_000);
  const suffix = Date.now().toString(36);
  const plannerName = `自动路由规划-${suffix}`;
  const financeName = `自动路由财务-${suffix}`;
  const roomName = `真实自动路由验收-${suffix}`;
  const repository = new AppRepository(isolatedDatabase!);
  let roomId: string;
  let financeId: string;
  try {
    const plannerCreated = repository.createBot();
    const planner = repository.updateBot(plannerCreated.bot.id, plannerCreated.bot.version, {
      name: plannerName,
      label: "产品规划",
      description: "负责产品规划与需求范围。只直接用一句话回答当前请求，禁止调用 handoff_to_agent，禁止向其他 Bot 转交任务。",
    });
    const financeCreated = repository.createBot();
    const finance = repository.updateBot(financeCreated.bot.id, financeCreated.bot.version, {
      name: financeName,
      label: "财务预算、成本分析",
      description: "负责财务预算、成本结构与费用分析。只直接用一句话回答当前请求，禁止调用 handoff_to_agent，禁止向其他 Bot 转交任务。",
    });
    financeId = finance.id;
    roomId = repository.createRoom({
      name: roomName,
      memberBotIds: [planner.id, finance.id],
    }).room.id;
  } finally {
    repository.close();
  }

  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] =>
      entry[1] !== undefined && !["AEVOREN_BOT_FAKE_PROVIDER", "AEVOREN_BOT_DB_PATH", "AEVOREN_BOT_USER_DATA_DIR"].includes(entry[0]),
    ),
  );
  environment.AEVOREN_BOT_USE_SYSTEM_SAFE_STORAGE = "1";
  environment.AEVOREN_BOT_DB_PATH = isolatedDatabase!;
  const application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment });
  try {
    const page = await application.firstWindow();
    await page.locator(".bot-row").filter({ hasText: roomName }).click();
    await expect(page.getByRole("heading", { name: roomName })).toBeVisible();
    await expect(page.getByLabel("群聊默认响应方式")).toHaveValue("automatic");

    await page.getByLabel("消息").fill("请分析本季度财务预算、成本结构和费用控制重点，并用一句话回答。");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(1, { timeout: 120_000 });
    await expect(page.locator(".speaker-link").last()).toHaveText(financeName);
    const userMessage = page.locator("article.message-user").last();
    await expect(userMessage).toContainText("自动选择");
    await expect(userMessage.locator(".message-route-chip")).toHaveText([`@${financeName}`]);
    await expect(page.getByTestId("room-batch-state")).toHaveCount(0);
  } finally {
    await application.close();
  }

  const database = new DatabaseSync(isolatedDatabase!, { readOnly: true });
  try {
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM room_batches WHERE room_id = ? AND routing_mode = 'automatic' AND length(routing_reason) BETWEEN 1 AND 240 AND state = 'completed'",
    ).get(roomId)).toEqual({ count: 1 });
    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM room_turns AS turn
       JOIN room_batches AS batch ON batch.id = turn.batch_id
       WHERE batch.room_id = ? AND turn.origin = 'initial' AND turn.member_bot_id = ? AND turn.state = 'completed'`,
    ).get(roomId, financeId)).toEqual({ count: 1 });
    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM runtime_runs AS runtime
       JOIN room_turns AS turn ON turn.runtime_run_id = runtime.id
       JOIN room_batches AS batch ON batch.id = turn.batch_id
       WHERE batch.room_id = ? AND runtime.executor_bot_id = ? AND runtime.state = 'completed'`,
    ).get(roomId, financeId)).toEqual({ count: 1 });
    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM transcript_entries AS entry
       JOIN sessions AS session ON session.id = entry.session_id
       WHERE session.room_id = ? AND entry.role = 'assistant' AND entry.status = 'completed'
         AND entry.speaker_bot_id = ? AND entry.source_turn_id IS NOT NULL`,
    ).get(roomId, financeId)).toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM agent_handoffs AS handoff JOIN room_batches AS batch ON batch.id = handoff.run_id WHERE batch.room_id = ?",
    ).get(roomId)).toEqual({ count: 0 });
    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM transcript_entries AS entry
       JOIN sessions AS session ON session.id = entry.session_id
       WHERE session.room_id = ? AND (
         entry.body LIKE '%handoff_to_agent%' OR entry.body LIKE '%select_room_owner%' OR entry.body LIKE '%tool_call%'
       )`,
    ).get(roomId)).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM room_turns AS turn JOIN room_batches AS batch ON batch.id = turn.batch_id WHERE batch.room_id = ? AND turn.state IN ('queued', 'running')",
    ).get(roomId)).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM runtime_runs AS runtime JOIN room_turns AS turn ON turn.runtime_run_id = runtime.id JOIN room_batches AS batch ON batch.id = turn.batch_id WHERE batch.room_id = ? AND runtime.state IN ('created', 'dispatching', 'running', 'streaming', 'cancel-requested')",
    ).get(roomId)).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM room_batches WHERE room_id = ? AND state IN ('queued', 'running')",
    ).get(roomId)).toEqual({ count: 0 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    database.close();
  }
});
