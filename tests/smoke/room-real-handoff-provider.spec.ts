import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test } from "@playwright/test";
import { AppRepository } from "../../src/main/database";

const isolatedDatabase = process.env.AEVOREN_BOT_REAL_PROVIDER_DB_PATH;

test("runs one real-provider A-to-B handoff from ordinary Chinese Room profiles", async () => {
  test.skip(!isolatedDatabase, "requires AEVOREN_BOT_REAL_PROVIDER_DB_PATH pointing to an isolated configured database copy");
  test.setTimeout(240_000);
  const suffix = Date.now().toString(36);
  const firstName = `转交代理甲-${suffix}`;
  const secondName = `评审代理乙-${suffix}`;
  const roomName = `真实转交验收-${suffix}`;
  const repository = new AppRepository(isolatedDatabase!);
  try {
    const firstCreated = repository.createBot();
    const first = repository.updateBot(firstCreated.bot.id, firstCreated.bot.version, {
      name: firstName,
      label: "转交发起者",
      description: `你是群聊任务总控。收到用户请求后，可以先给出一句简短 ASSIGN，然后必须让名称恰好为“${secondName}”的评审角色立即继续执行；不要要求用户再次 @，也不要只在正文里声称已经转交。`,
      instructions: "",
    });
    const secondCreated = repository.createBot();
    const second = repository.updateBot(secondCreated.bot.id, secondCreated.bot.version, {
      name: secondName,
      label: "评审角色",
      description: "你是评审角色。收到上游实际转交后，用一句中文完成复核，然后结束并等待用户。",
      instructions: "",
    });
    repository.createRoom({ name: roomName, memberBotIds: [first.id, second.id] });
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
    const input = page.getByLabel("消息");
    await input.fill(`请由${firstName}先给出一句简短 ASSIGN，然后让${secondName}完成复核；本轮不需要等待我确认。`);
    await page.getByRole("button", { name: "发送", exact: true }).click();

    await expect(page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(2, { timeout: 180_000 });
    await expect(page.locator(".speaker-link").last()).toHaveText(secondName);
    await expect(page.locator("article.message-user").last()).toContainText("自动选择");
    await expect(page.locator("article.message-user").last().locator(".message-route-chip")).toHaveText([`@${firstName}`]);
    await expect(page.getByTestId("room-handoff-list")).toHaveCount(1);
    await expect(page.getByTestId("room-handoff-list")).toContainText("已接收");
    await expect(page.locator("body")).not.toContainText("handoff_to_agent");
  } finally {
    await application.close();
  }

  const database = new DatabaseSync(isolatedDatabase!, { readOnly: true });
  try {
    const room = database.prepare("SELECT id FROM rooms WHERE name = ?").get(roomName) as { id: string };
    expect(database.prepare("SELECT COUNT(*) AS count FROM agent_handoffs AS handoff JOIN room_batches AS run ON run.id = handoff.run_id WHERE run.room_id = ? AND handoff.state = 'accepted'").get(room.id)).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(DISTINCT logical_turn_id) AS count FROM room_turns AS turn JOIN room_batches AS run ON run.id = turn.batch_id WHERE run.room_id = ?").get(room.id)).toEqual({ count: 2 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM runtime_runs AS runtime JOIN room_turns AS turn ON turn.runtime_run_id = runtime.id JOIN room_batches AS run ON run.id = turn.batch_id WHERE run.room_id = ?").get(room.id)).toEqual({ count: 2 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM transcript_entries AS entry JOIN sessions AS session ON session.id = entry.session_id WHERE session.room_id = ? AND (entry.body LIKE '%handoff_to_agent%' OR entry.body LIKE '%tool_call%')").get(room.id)).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM room_turns AS turn JOIN room_batches AS run ON run.id = turn.batch_id WHERE run.room_id = ? AND turn.state IN ('queued', 'running')").get(room.id)).toEqual({ count: 0 });
  } finally {
    database.close();
  }
});
