import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { MsBotApi } from "@shared/contracts";

function environment(userDataDir: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    MS_BOT_USER_DATA_DIR: userDataDir,
    MS_BOT_FAKE_PROVIDER: "1",
    ...overrides,
  };
}

async function launch(userDataDir: string, overrides: Record<string, string> = {}) {
  const application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment(userDataDir, overrides) });
  return { application, page: await application.firstWindow() };
}

async function createNamedBot(page: Page, name: string): Promise<void> {
  const before = await page.locator(".bot-row").count();
  await page.getByRole("button", { name: "新建聊天" }).click();
  await page.getByRole("button", { name: "创建新 Bot" }).click();
  await expect(page.locator(".bot-row")).toHaveCount(before + 1);
  const nameInput = page.getByLabel("名称");
  await nameInput.fill(name);
  await nameInput.blur();
  await expect(page.getByTestId("profile-save-status")).toContainText("已保存");
}

async function createRoom(page: Page, names: string[]): Promise<void> {
  await page.getByRole("button", { name: "新建聊天" }).click();
  await page.locator(".recipient-option").filter({ hasText: "创建群聊" }).click();
  for (const name of names) await page.getByRole("button", { name, exact: true }).click();
  await page.locator(".recipient-footer").getByRole("button", { name: "创建群聊", exact: true }).click();
  await expect(page.getByRole("heading", { name: names.join("、") })).toBeVisible();
}

async function forceKill(application: ElectronApplication): Promise<void> {
  const process = application.process();
  if (process.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => process.once("exit", () => resolve()));
  process.kill("SIGKILL");
  await exited;
}

test("creates and manages a deterministic multi-Bot Room with speaker bubbles", async () => {
  test.setTimeout(90_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "ms-bot-room-smoke-"));
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(userDataDir, { MS_BOT_FAKE_DELAY_MS: "10" });
    application = launched.application;
    const page = launched.page;
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 800));
    for (const name of ["研究员", "评审员", "执行员", "观察员"]) await createNamedBot(page, name);
    await createRoom(page, ["研究员", "评审员", "执行员"]);

    await expect(page.getByRole("heading", { name: "研究员、评审员、执行员" })).toBeVisible();
    await expect(page.getByText("将调用 3 个 Bot", { exact: true })).toBeVisible();
    await page.getByLabel("消息").fill("请依次给出分析。");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(3);
    await expect(page.locator(".speaker-link")).toHaveText(["研究员", "评审员", "执行员"]);
    await expect(page.locator("article.message-assistant.message-group-continuation")).toHaveCount(0);
    await expect(page.locator("article.message-assistant .message-avatar:not(.message-avatar-placeholder)")).toHaveCount(3);
    await expect(page.locator(".room-turn-state")).toHaveCount(3);
    await expect(page.getByTestId("room-batch-state")).toContainText("completed");

    const secondSpeaker = page.getByRole("button", { name: "评审员", exact: true }).last();
    await secondSpeaker.click();
    await expect(page.getByRole("heading", { name: "评审员" })).toBeVisible();
    await page.locator(".bot-row").filter({ hasText: "研究员、评审员、执行员" }).click();
    await expect(page.getByRole("heading", { name: "研究员、评审员、执行员" })).toBeVisible();

    await page.getByLabel("名称").fill("产品协作室");
    await page.getByLabel("名称").blur();
    await expect(page.getByTestId("room-save-status")).toContainText("已保存");
    const evaluatorRow = page.locator(".room-member-row").filter({ hasText: "评审员" });
    await evaluatorRow.getByRole("button", { name: "移除" }).click();
    await expect(page.locator(".room-member-row")).toHaveCount(2);
    await page.getByLabel("选择要添加的 Bot").selectOption({ label: "观察员" });
    await page.getByRole("button", { name: "添加", exact: true }).click();
    await expect(page.locator(".room-member-row")).toHaveCount(3);
    await page.locator(".target-chip").filter({ hasText: "观察员" }).click();
    await expect(page.getByText("将调用 2 个 Bot", { exact: true })).toBeVisible();
    await page.locator(".bot-row").filter({ hasText: "观察员" }).click();
    await expect(page.getByRole("heading", { name: "观察员" })).toBeVisible();
    await page.locator(".bot-row").filter({ hasText: "产品协作室" }).click();
    await expect(page.getByRole("heading", { name: "产品协作室" })).toBeVisible();
    await expect(page.getByText("将调用 2 个 Bot", { exact: true })).toBeVisible();
    await expect(page.locator(".target-chip").filter({ hasText: "观察员" })).toHaveAttribute("aria-pressed", "false");
    await page.getByLabel("描述").fill("关闭应用时也必须 flush 的 Room 描述");

    await page.screenshot({ path: "/tmp/ms-bot-room-desktop-light.png", fullPage: true });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator(".conversation")).toBeVisible();
    await page.screenshot({ path: "/tmp/ms-bot-room-desktop-dark.png", fullPage: true });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(390, 844));
    await expect(page.getByRole("button", { name: "打开 Bot 列表" })).toBeVisible();
    await page.waitForTimeout(250);
    await expect(page.locator(".sidebar")).not.toBeVisible();
    await expect(page.locator(".inspector")).not.toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: "/tmp/ms-bot-room-narrow.png", fullPage: true });
    await page.getByRole("button", { name: "打开 Bot 设置" }).click();
    await expect(page.locator(".inspector")).toBeVisible();
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: "/tmp/ms-bot-room-narrow-profile.png", fullPage: true });
    expect(consoleErrors).toEqual([]);

    await application.close();
    application = undefined;
    const database = new DatabaseSync(join(userDataDir, "ms-bot.sqlite"), { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM rooms").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT name, archived_at FROM rooms").get()).toEqual({ name: "产品协作室", archived_at: null });
    expect(database.prepare("SELECT description FROM rooms").get()).toEqual({ description: "关闭应用时也必须 flush 的 Room 描述" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM room_members").get()).toEqual({ count: 3 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM room_batches WHERE state='completed'").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM room_turns WHERE state='completed'").get()).toEqual({ count: 3 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM transcript_entries WHERE role='assistant' AND speaker_bot_id IS NOT NULL AND source_turn_id IS NOT NULL").get()).toEqual({ count: 3 });
    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM transcript_entries AS entry
       LEFT JOIN room_turns AS turn ON turn.id = entry.source_turn_id
       LEFT JOIN room_batches AS batch ON batch.id = turn.batch_id
       WHERE entry.source_turn_id IS NOT NULL AND (
         turn.id IS NULL OR batch.session_id != entry.session_id OR turn.member_bot_id != entry.speaker_bot_id
       )`,
    ).get()).toEqual({ count: 0 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();

    const restarted = await launch(userDataDir, { MS_BOT_FAKE_DELAY_MS: "10" });
    application = restarted.application;
    await restarted.page.locator(".bot-list .bot-row").first().click();
    await expect(restarted.page.getByRole("heading", { name: "产品协作室" })).toBeVisible();
    await expect(restarted.page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(3);
    await expect(restarted.page.locator(".room-member-row")).toHaveCount(3);
    await restarted.page.getByRole("button", { name: "归档群聊" }).click();
    await expect(restarted.page.getByRole("button", { name: "产品协作室" })).toHaveCount(0);
    await restarted.page.locator(".bot-row").filter({ hasText: "研究员" }).click();
    await restarted.page.getByLabel("描述").fill("恢复归档 Room 前必须先保存的 Bot 描述");
    await restarted.page.getByRole("button", { name: "已归档 (1)" }).click();
    await expect(restarted.page.getByText("产品协作室", { exact: true })).toBeVisible();
    await restarted.page.getByRole("button", { name: "恢复", exact: true }).click();
    await expect(restarted.page.getByRole("heading", { name: "产品协作室" })).toBeVisible();
    await application.close();
    application = undefined;
    const restoredDatabase = new DatabaseSync(join(userDataDir, "ms-bot.sqlite"), { readOnly: true });
    expect(restoredDatabase.prepare("SELECT description FROM bots WHERE name = ?").get("研究员")).toEqual({
      description: "恢复归档 Room 前必须先保存的 Bot 描述",
    });
    restoredDatabase.close();

    const restored = await launch(userDataDir, { MS_BOT_FAKE_DELAY_MS: "10" });
    application = restored.application;
    await restored.page.locator(".bot-row").filter({ hasText: "研究员" }).click();
    await expect(restored.page.getByLabel("描述")).toHaveValue("恢复归档 Room 前必须先保存的 Bot 描述");
  } finally {
    if (application) application.process().kill("SIGKILL");
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("reattaches Room streaming after five reloads and recovers a Main crash without auto-running", async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "ms-bot-room-recovery-"));
  let application: ElectronApplication | undefined;
  try {
    let launched = await launch(userDataDir, {
      MS_BOT_FAKE_START_DELAY_MS: "3000",
      MS_BOT_FAKE_DELAY_MS: "1000",
      MS_BOT_FAKE_IGNORE_ABORT: "1",
    });
    application = launched.application;
    for (const name of ["甲", "乙", "丙"]) await createNamedBot(launched.page, name);
    await createRoom(launched.page, ["甲", "乙", "丙"]);
    await launched.page.getByLabel("消息").fill("重载测试");
    await launched.page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(launched.page.getByText("正在连接模型", { exact: true })).toBeVisible();
    const scopeErrors = await launched.page.evaluate(async () => {
      const api = (window as unknown as { msBot: MsBotApi }).msBot;
      const rooms = await api.rooms.list();
      if (!rooms.ok || !rooms.data[0]) throw new Error("Room missing");
      const snapshot = await api.roomRuntime.getSnapshot(rooms.data[0].id);
      if (!snapshot.ok || !snapshot.data.runs[0] || !snapshot.data.batches[0]) throw new Error("Runtime missing");
      const runtimeCancel = await api.runtime.cancel(snapshot.data.runs[0].id);
      const messageCancel = await api.messages.cancel(snapshot.data.batches[0].clientNonce);
      return [runtimeCancel, messageCancel];
    });
    expect(scopeErrors).toEqual([
      { ok: false, error: { code: "RUNTIME_CONTROL_SCOPE_INVALID", domain: "runtime", retryable: false, safeMessage: "群聊运行必须使用群聊控制。" } },
      { ok: false, error: { code: "RUNTIME_CONTROL_SCOPE_INVALID", domain: "runtime", retryable: false, safeMessage: "群聊运行必须使用群聊控制。" } },
    ]);
    for (let reload = 0; reload < 5; reload += 1) {
      await expect(launched.page.getByText("正在连接模型", { exact: true })).toBeVisible();
      await launched.page.reload();
      await expect(launched.page.getByRole("button", { name: "停止群聊回复" })).toBeVisible({ timeout: 2_000 });
    }
    for (let reload = 0; reload < 5; reload += 1) {
      await expect(launched.page.getByText("正在生成回复", { exact: true })).toBeVisible();
      await launched.page.reload();
      await expect(launched.page.getByRole("button", { name: "停止群聊回复" })).toBeVisible({ timeout: 2_000 });
    }
    await expect(launched.page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(3, { timeout: 30_000 });

    await launched.page.getByLabel("消息").fill("崩溃恢复测试");
    await launched.page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(launched.page.getByText("正在生成回复", { exact: true })).toBeVisible();
    const databasePath = join(userDataDir, "ms-bot.sqlite");
    await forceKill(application);
    application = undefined;
    let database = new DatabaseSync(databasePath, { readOnly: true });
    const beforeRestart = database.prepare("SELECT COUNT(*) AS count FROM runtime_runs").get();
    database.close();

    launched = await launch(userDataDir, { MS_BOT_FAKE_DELAY_MS: "20" });
    application = launched.application;
    await launched.page.waitForTimeout(500);
    database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM runtime_runs").get()).toEqual(beforeRestart);
    expect(database.prepare("SELECT state FROM room_batches ORDER BY created_at DESC LIMIT 1").get()).toEqual({ state: "interrupted" });
    expect(database.prepare("SELECT DISTINCT state FROM room_turns WHERE batch_id=(SELECT id FROM room_batches ORDER BY created_at DESC LIMIT 1)").all()).toEqual([{ state: "interrupted" }]);
    database.close();
    await launched.page.locator(".bot-list .bot-row").first().click();
    await expect(launched.page.getByRole("heading", { name: "甲、乙、丙" })).toBeVisible();
    await expect(launched.page.getByTestId("room-batch-state")).toContainText("interrupted");
    await expect(launched.page.getByRole("button", { name: "继续未开始成员" })).toBeVisible();
  } finally {
    if (application) application.process().kill("SIGKILL");
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("offers a Turn retry when a Room member fails before Provider acceptance", async () => {
  test.setTimeout(45_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "ms-bot-room-prestart-retry-"));
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(userDataDir, { MS_BOT_FAKE_FAILURE: "first-run-before-start", MS_BOT_FAKE_DELAY_MS: "10" });
    application = launched.application;
    await createNamedBot(launched.page, "前置失败成员");
    await createNamedBot(launched.page, "正常成员");
    await createRoom(launched.page, ["前置失败成员", "正常成员"]);
    await launched.page.getByLabel("消息").fill("失败后重试");
    await launched.page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(launched.page.getByTestId("room-batch-state")).toContainText("partial");
    const failedTurn = launched.page.locator(".room-turn-state.turn-failed");
    await expect(failedTurn).toContainText("前置失败成员");
    await failedTurn.getByRole("button", { name: "重试", exact: true }).click();
    await expect(launched.page.getByTestId("room-batch-state")).toContainText("completed");
    await expect(launched.page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(2);
    await application.close();
    application = undefined;
    const database = new DatabaseSync(join(userDataDir, "ms-bot.sqlite"), { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM transcript_entries WHERE role='user'").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM room_turns").get()).toEqual({ count: 3 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM runtime_runs").get()).toEqual({ count: 3 });
    database.close();
  } finally {
    if (application) application.process().kill("SIGKILL");
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("settles Cancel then SIGKILL without leaving a running Turn or auto-resuming", async () => {
  test.setTimeout(45_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "ms-bot-room-cancel-crash-"));
  let application: ElectronApplication | undefined;
  try {
    let launched = await launch(userDataDir, { MS_BOT_FAKE_DELAY_MS: "1000", MS_BOT_FAKE_IGNORE_ABORT: "1" });
    application = launched.application;
    await createNamedBot(launched.page, "取消甲");
    await createNamedBot(launched.page, "取消乙");
    await createRoom(launched.page, ["取消甲", "取消乙"]);
    await launched.page.getByLabel("消息").fill("取消后立即崩溃");
    await launched.page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(launched.page.getByText("正在生成回复", { exact: true })).toBeVisible();
    await launched.page.getByRole("button", { name: "停止群聊回复" }).click();
    await forceKill(application);
    application = undefined;

    const databasePath = join(userDataDir, "ms-bot.sqlite");
    let database = new DatabaseSync(databasePath, { readOnly: true });
    const runCount = database.prepare("SELECT COUNT(*) AS count FROM runtime_runs").get();
    database.close();
    launched = await launch(userDataDir, { MS_BOT_FAKE_DELAY_MS: "10" });
    application = launched.application;
    await launched.page.waitForTimeout(500);
    database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM runtime_runs").get()).toEqual(runCount);
    expect(database.prepare("SELECT state FROM room_batches").get()).toEqual({ state: "cancelled" });
    expect(database.prepare("SELECT DISTINCT state FROM room_turns").all()).toEqual([{ state: "cancelled" }]);
    database.close();
  } finally {
    if (application) application.process().kill("SIGKILL");
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
