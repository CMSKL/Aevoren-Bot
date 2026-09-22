import { removeTestDirectory } from "./test-cleanup";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { AppRepository } from "../../src/main/database";

const maliciousLongTask = '请复核 <img src=x onerror="window.__aevorenBotHandoffXss=1"> 当前方案中的目标、边界、异常处理和验收标准，并指出需要补充的内容；这是一段用于验证窄窗口省略显示且不会造成页面横向溢出的较长任务说明。'.repeat(2);

function seed(userDataDir: string): { roomName: string; fromName: string; toName: string } {
  const repository = new AppRepository(join(userDataDir, "aevoren-bot.sqlite"));
  try {
    const firstCreated = repository.createBot();
    const first = repository.updateBot(firstCreated.bot.id, firstCreated.bot.version, { name: "协作员", label: "策划" });
    const secondCreated = repository.createBot();
    const second = repository.updateBot(secondCreated.bot.id, secondCreated.bot.version, {
      name: "协作员",
      label: "评审 · 负责验证非常狭窄窗口内任务转交名称不会撑破页面布局",
    });
    const roomName = "结构化转交验收群聊";
    repository.createRoom({ name: roomName, memberBotIds: [first.id, second.id] });
    return {
      roomName,
      fromName: `${first.name} · #${first.id.slice(0, 6)}`,
      toName: `${second.name} · #${second.id.slice(0, 6)}`,
    };
  } finally {
    repository.close();
  }
}

async function launch(userDataDir: string): Promise<{ application: ElectronApplication; page: Page }> {
  const application = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    env: {
      ...process.env,
      AEVOREN_BOT_USER_DATA_DIR: userDataDir,
      AEVOREN_BOT_FAKE_PROVIDER: "1",
      AEVOREN_BOT_FAKE_DELAY_MS: "1",
      AEVOREN_BOT_FAKE_HANDOFF: "first-other",
      AEVOREN_BOT_FAKE_HANDOFF_TOOL_ONLY: "1",
      AEVOREN_BOT_FAKE_HANDOFF_TASK: maliciousLongTask,
    },
  });
  return { application, page: await application.firstWindow() };
}

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.locator(".bot-row").filter({ hasText: roomName }).click();
  await expect(page.getByRole("heading", { name: roomName })).toBeVisible();
}

test("runs and restores a visible A-to-B fake handoff without responsive overflow", async () => {
  test.setTimeout(90_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-m3-handoff-"));
  const seeded = seed(userDataDir);
  let failedTargetTurnId: string;
  let application: ElectronApplication | undefined;
  try {
    let launched = await launch(userDataDir);
    application = launched.application;
    const consoleErrors: string[] = [];
    launched.page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    await openRoom(launched.page, seeded.roomName);
    const input = launched.page.getByLabel("消息");
    await input.fill("请由策划角色先规划，再自动转交评审角色。");
    await launched.page.getByRole("button", { name: "发送", exact: true }).click();

    await expect(launched.page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(2);
    await expect(launched.page.locator("article.message-assistant .message-bubble")).toHaveCount(1);
    await expect(launched.page.locator("article.message-user").last()).toContainText("自动选择");
    await expect(launched.page.locator("article.message-user").last().locator(".message-route-chip")).toHaveText(["@协作员 · 策划"]);
    const handoff = launched.page.getByTestId("room-handoff-list");
    await expect(handoff).toContainText(seeded.fromName);
    await expect(handoff).toContainText(seeded.toName);
    await expect(handoff).toContainText("已接收");
    await expect(handoff).toContainText("已完成");
    await expect(handoff).toContainText("<img src=x");
    await expect(handoff).not.toContainText("[room-speaker");
    await expect(handoff.locator("img, script")).toHaveCount(0);
    expect(await launched.page.evaluate(() => (window as unknown as { __aevorenBotHandoffXss?: unknown }).__aevorenBotHandoffXss)).toBeUndefined();

    await application.close();
    application = undefined;
    const rejectionRepository = new AppRepository(join(userDataDir, "aevoren-bot.sqlite"));
    try {
      const batch = rejectionRepository.listRoomBatches(rejectionRepository.listRooms()[0]!.id)[0]!;
      const source = rejectionRepository.listRoomTurns(batch.id)[0]!;
      failedTargetTurnId = rejectionRepository.listRoomTurns(batch.id)[1]!.id;
      rejectionRepository.recordHandoffRejection({
        runId: batch.id,
        fromTurnId: source.id,
        attemptedToAgentId: '<img src=x onerror="window.__aevorenBotHandoffRejectionXss=1">',
        toolCallId: "RAW_REJECTION_TOOL_SECRET",
        errorCode: "HANDOFF_CYCLE",
      });
    } finally {
      rejectionRepository.close();
    }
    const failureInjector = new DatabaseSync(join(userDataDir, "aevoren-bot.sqlite"));
    try {
      failureInjector.prepare(
        `UPDATE room_turns
         SET state = 'failed', outcome_json = '{"kind":"error","errorCode":"MODEL_TRANSPORT_ERROR"}',
             last_error_code = 'MODEL_TRANSPORT_ERROR', version = version + 1
         WHERE id = ?`,
      ).run(failedTargetTurnId);
      failureInjector.prepare(
        "UPDATE room_batches SET state = 'partial', version = version + 1 WHERE id = (SELECT batch_id FROM room_turns WHERE id = ?)",
      ).run(failedTargetTurnId);
      failureInjector.prepare(
        "UPDATE agent_handoffs SET state = 'failed', version = version + 1 WHERE target_turn_id = ?",
      ).run(failedTargetTurnId);
    } finally {
      failureInjector.close();
    }
    launched = await launch(userDataDir);
    application = launched.application;
    launched.page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    await openRoom(launched.page, seeded.roomName);
    await expect(launched.page.getByTestId("room-handoff-list")).toHaveCount(1);
    await expect(launched.page.getByTestId("room-handoff-list")).toContainText("投递：失败");
    await expect(launched.page.getByTestId("room-handoff-list")).toContainText("执行失败");
    const rejection = launched.page.getByTestId("room-handoff-rejection-list");
    await expect(rejection).toContainText("已阻止重复任务形成 Agent 调用循环");
    await expect(rejection).not.toContainText("RAW_REJECTION_TOOL_SECRET");
    await expect(rejection.locator("img, script")).toHaveCount(0);
    expect(await launched.page.evaluate(() => (
      window as unknown as { __aevorenBotHandoffRejectionXss?: unknown }
    ).__aevorenBotHandoffRejectionXss)).toBeUndefined();
    await expect(launched.page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(2);

    const retryResult = await launched.page.evaluate(async (turnId) => (
      window as unknown as {
        aevorenBot: { roomRuntime: { retryTurn(id: string): Promise<{ ok: boolean }> } };
      }
    ).aevorenBot.roomRuntime.retryTurn(turnId), failedTargetTurnId);
    expect(retryResult.ok).toBe(true);
    await expect(launched.page.getByTestId("room-handoff-list")).toContainText("投递：失败");
    await expect(launched.page.getByTestId("room-handoff-list")).toContainText("执行：已完成");
    await expect(launched.page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(3);

    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(390, 844));
    await expect.poll(() => launched.page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(390);
    expect(await launched.page.evaluate(() => {
      const handoffList = document.querySelector<HTMLElement>(".message-handoffs");
      if (!handoffList) return false;
      const rect = handoffList.getBoundingClientRect();
      return document.documentElement.scrollWidth <= window.innerWidth
        && handoffList.scrollWidth <= handoffList.clientWidth
        && rect.left >= 0
        && rect.right <= window.innerWidth;
    })).toBe(true);
    expect(consoleErrors).toEqual([]);

    const database = new DatabaseSync(join(userDataDir, "aevoren-bot.sqlite"), { readOnly: true });
    try {
      expect(database.prepare("SELECT COUNT(*) AS count FROM agent_handoffs").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM agent_handoffs WHERE state = 'failed'").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM room_turns WHERE state = 'completed'").get()).toEqual({ count: 2 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM handoff_rejections").get()).toEqual({ count: 1 });
      expect(JSON.stringify(database.prepare("SELECT * FROM handoff_rejections").all())).not.toContain("RAW_REJECTION_TOOL_SECRET");
      expect(database.prepare("SELECT COUNT(*) AS count FROM transcript_entries WHERE body LIKE '%room-speaker%'").get()).toEqual({ count: 0 });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  } finally {
    if (application) await application.close().catch(() => undefined);
    removeTestDirectory(userDataDir);
  }
});
