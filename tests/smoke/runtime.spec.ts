import { removeTestDirectory } from "./test-cleanup";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { AevorenBotApi } from "@shared/contracts";

function environment(userDataDir: string, overrides: Record<string, string> = {}): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return {
    ...inherited,
    AEVOREN_BOT_USER_DATA_DIR: userDataDir,
    AEVOREN_BOT_FAKE_PROVIDER: "1",
    ...overrides,
  };
}

async function launch(
  userDataDir: string,
  overrides: Record<string, string> = {},
): Promise<{ application: ElectronApplication; page: Page }> {
  const application = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    env: environment(userDataDir, overrides),
  });
  return { application, page: await application.firstWindow() };
}

async function createAndSend(page: Page, text: string): Promise<void> {
  await page.getByRole("button", { name: "新建聊天" }).click();
  await page.getByRole("button", { name: "创建新 Bot" }).click();
  await page.locator('textarea[aria-label="消息"]').fill(text);
  await page.getByRole("button", { name: "发送", exact: true }).click();
}

async function requestWindowClose(application: ElectronApplication, timeoutMs = 3_000): Promise<boolean> {
  const process = application.process();
  const exited = new Promise<boolean>((resolve) => process.once("exit", () => resolve(true)));
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  return Promise.race([
    exited,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

async function forceKill(application: ElectronApplication): Promise<void> {
  const process = application.process();
  if (process.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => process.once("exit", () => resolve()));
  process.kill("SIGKILL");
  await exited;
}

test("reattaches the active runtime after renderer reloads in three phases", async () => {
  test.setTimeout(120_000);
  const phases: Array<{ name: string; overrides: Record<string, string>; stateText: string }> = [
    {
      name: "dispatching",
      overrides: { AEVOREN_BOT_FAKE_START_DELAY_MS: "500", AEVOREN_BOT_FAKE_DELAY_MS: "80" },
      stateText: "正在连接模型",
    },
    {
      name: "running",
      overrides: { AEVOREN_BOT_FAKE_DELAY_MS: "500" },
      stateText: "模型已接受，正在运行",
    },
    {
      name: "streaming",
      overrides: { AEVOREN_BOT_FAKE_DELAY_MS: "250" },
      stateText: "正在生成回复",
    },
  ];

  for (const phase of phases) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const userDataDir = mkdtempSync(join(tmpdir(), `aevoren-bot-reload-${phase.name}-`));
      let application: ElectronApplication | undefined;
      try {
        const launched = await launch(userDataDir, phase.overrides);
        application = launched.application;
        const page = launched.page;
        await createAndSend(page, `reload ${phase.name} ${attempt}`);
        await expect(page.getByText(phase.stateText, { exact: true })).toBeVisible();
        await page.reload();
        await expect(page.getByRole("button", { name: "停止回复" })).toBeVisible({ timeout: 2_000 });
        await expect(page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(1, {
          timeout: 10_000,
        });
        await application.close();
        application = undefined;

        const database = new DatabaseSync(join(userDataDir, "aevoren-bot.sqlite"), { readOnly: true });
        expect(database.prepare("SELECT COUNT(*) AS count FROM runtime_runs").get()).toEqual({ count: 1 });
        expect(database.prepare("SELECT state FROM runtime_runs").get()).toEqual({ state: "completed" });
        expect(database.prepare("SELECT role, COUNT(*) AS count FROM transcript_entries GROUP BY role ORDER BY role").all()).toEqual([
          { role: "assistant", count: 1 },
          { role: "user", count: 1 },
        ]);
        database.close();
      } finally {
        if (application) application.process().kill("SIGKILL");
        removeTestDirectory(userDataDir);
      }
    }
  }
});

test("regenerates a failed accepted run without duplicating its user entry", async () => {
  test.setTimeout(60_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-regenerate-"));
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(userDataDir, {
      AEVOREN_BOT_FAKE_DELAY_MS: "30",
      AEVOREN_BOT_FAKE_START_DELAY_MS: "300",
      AEVOREN_BOT_FAKE_FAILURE: "first-run-after-delta",
    });
    application = launched.application;
    const page = launched.page;
    await createAndSend(page, "retry accepted runtime");
    await expect(page.getByText("回复生成失败，已保留可用的部分内容。")).toBeVisible();
    await page.waitForTimeout(30_000);
    await expect(page.locator('article.message-assistant[data-status="failed"]')).toHaveCount(1);
    await expect(page.getByRole("button", { name: "重新生成回复" })).toHaveCount(1);
    await page.getByRole("button", { name: "重新生成回复" }).click();
    await expect(page.getByText("正在重新生成", { exact: true })).toBeVisible();
    await expect(page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(1);
    await application.close();
    application = undefined;

    const database = new DatabaseSync(join(userDataDir, "aevoren-bot.sqlite"), { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM transcript_entries WHERE role='user'").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM transcript_entries WHERE role='assistant'").get()).toEqual({ count: 2 });
    expect(database.prepare("SELECT attempt_no,state FROM runtime_runs ORDER BY attempt_no").all()).toEqual([
      { attempt_no: 1, state: "failed" },
      { attempt_no: 2, state: "completed" },
    ]);
    database.close();
  } finally {
    if (application) application.process().kill("SIGKILL");
    removeTestDirectory(userDataDir);
  }
});

test("closes a streaming runtime as interrupted and does not restart it", async () => {
  test.setTimeout(30_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-runtime-close-"));
  let application: ElectronApplication | undefined;
  try {
    let launched = await launch(userDataDir, { AEVOREN_BOT_FAKE_DELAY_MS: "500" });
    application = launched.application;
    await createAndSend(launched.page, "close during streaming");
    await expect(launched.page.getByText("正在生成回复", { exact: true })).toBeVisible();
    expect(await requestWindowClose(application)).toBe(true);
    application = undefined;

    const databasePath = join(userDataDir, "aevoren-bot.sqlite");
    let database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT state FROM runtime_runs").get()).toEqual({ state: "interrupted" });
    expect(database.prepare("SELECT status FROM transcript_entries WHERE role='assistant'").get()).toEqual({ status: "failed" });
    const runCount = database.prepare("SELECT COUNT(*) AS count FROM runtime_runs").get();
    database.close();

    launched = await launch(userDataDir, { AEVOREN_BOT_FAKE_DELAY_MS: "500" });
    application = launched.application;
    await expect(launched.page.getByText("运行被应用中断，没有自动重新发送。")).toBeVisible();
    database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM runtime_runs").get()).toEqual(runCount);
    database.close();
    await application.close();
    application = undefined;
  } finally {
    if (application) application.process().kill("SIGKILL");
    removeTestDirectory(userDataDir);
  }
});

test("recovers running, streaming and cancel-requested runs after SIGKILL", async () => {
  test.setTimeout(45_000);
  const phases: Array<{
    name: string;
    waitText: string;
    cancelBeforeKill: boolean;
  }> = [
    { name: "running", waitText: "模型已接受，正在运行", cancelBeforeKill: false },
    { name: "streaming", waitText: "正在生成回复", cancelBeforeKill: false },
    { name: "cancel-requested", waitText: "正在取消", cancelBeforeKill: true },
  ];

  for (const phase of phases) {
    const userDataDir = mkdtempSync(join(tmpdir(), `aevoren-bot-sigkill-${phase.name}-`));
    let application: ElectronApplication | undefined;
    try {
      let launched = await launch(userDataDir, {
        AEVOREN_BOT_FAKE_DELAY_MS: "1000",
        AEVOREN_BOT_FAKE_IGNORE_ABORT: "1",
      });
      application = launched.application;
      await createAndSend(launched.page, `SIGKILL ${phase.name}`);
      if (phase.cancelBeforeKill) {
        await expect(launched.page.getByText("模型已接受，正在运行", { exact: true })).toBeVisible();
        await launched.page.getByRole("button", { name: "停止回复" }).click();
      }
      await expect(launched.page.getByText(phase.waitText, { exact: true })).toBeVisible();
      await forceKill(application);
      application = undefined;

      const databasePath = join(userDataDir, "aevoren-bot.sqlite");
      launched = await launch(userDataDir, {
        AEVOREN_BOT_FAKE_DELAY_MS: "1000",
        AEVOREN_BOT_FAKE_IGNORE_ABORT: "1",
      });
      application = launched.application;
      await expect(launched.page.getByText("运行被应用中断，没有自动重新发送。")).toBeVisible();
      const database = new DatabaseSync(databasePath, { readOnly: true });
      expect(database.prepare("SELECT COUNT(*) AS count FROM runtime_runs").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT state FROM runtime_runs").get()).toEqual({ state: "interrupted" });
      expect(database.prepare("SELECT COUNT(*) AS count FROM transcript_entries WHERE role='user'").get()).toEqual({ count: 1 });
      database.close();
      await application.close();
      application = undefined;
    } finally {
      if (application) await forceKill(application);
      removeTestDirectory(userDataDir);
    }
  }
});

test("recovers a Direct pre-start SIGKILL as unknown without offering a safe retry", async () => {
  test.setTimeout(30_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-direct-pre-start-"));
  let application: ElectronApplication | undefined;
  try {
    let launched = await launch(userDataDir, { AEVOREN_BOT_FAKE_START_DELAY_MS: "20000" });
    application = launched.application;
    await createAndSend(launched.page, "crash after Direct dispatch starts");
    await expect(launched.page.getByText("正在连接模型", { exact: true })).toBeVisible();

    const databasePath = join(userDataDir, "aevoren-bot.sqlite");
    let database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT state FROM send_journal").get()).toEqual({ state: "dispatching" });
    expect(database.prepare("SELECT state FROM runtime_runs").get()).toEqual({ state: "dispatching" });
    expect(database.prepare("SELECT status FROM transcript_entries WHERE role='user'").get()).toEqual({ status: "pending" });
    database.close();

    await forceKill(application);
    application = undefined;
    launched = await launch(userDataDir, { AEVOREN_BOT_FAKE_START_DELAY_MS: "20000" });
    application = launched.application;
    await expect(launched.page.getByText("应用中断，模型可能已接受该消息；不会自动重发。", { exact: true })).toBeVisible();
    await expect(launched.page.getByRole("button", { name: "安全重试发送" })).toHaveCount(0);
    database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT state,attempt_count FROM send_journal").get()).toEqual({
      state: "interrupted-unknown",
      attempt_count: 0,
    });
    expect(database.prepare("SELECT state FROM runtime_runs").get()).toEqual({ state: "interrupted" });
    expect(database.prepare("SELECT status FROM transcript_entries WHERE role='user'").get()).toEqual({ status: "failed" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM transcript_entries WHERE role='assistant'").get()).toEqual({ count: 0 });
    database.close();
    await launched.page.waitForTimeout(500);
    database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM runtime_runs").get()).toEqual({ count: 1 });
    database.close();
    await application.close();
    application = undefined;
  } finally {
    if (application) await forceKill(application);
    removeTestDirectory(userDataDir);
  }
});

test("shows stale after thirty seconds without provider activity and remains cancellable", async () => {
  test.setTimeout(45_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-runtime-stale-"));
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(userDataDir, {
      AEVOREN_BOT_FAKE_START_DELAY_MS: "35000",
      AEVOREN_BOT_FAKE_DELAY_MS: "20",
    });
    application = launched.application;
    const startedAt = Date.now();
    await createAndSend(launched.page, "stale runtime");
    await expect(launched.page.getByText("连接可能已停滞，仍可停止本次运行", { exact: true })).toBeVisible({
      timeout: 45_000,
    });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(28_000);
    expect(Date.now() - startedAt).toBeLessThanOrEqual(33_000);
    await launched.page.getByRole("button", { name: "停止回复" }).click();
    await expect(launched.page.getByText("消息已取消。", { exact: true })).toBeVisible();
    await application.close();
    application = undefined;
  } finally {
    if (application) application.process().kill("SIGKILL");
    removeTestDirectory(userDataDir);
  }
});

test("keeps the window open and explains a close handshake timeout", async () => {
  test.setTimeout(20_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-close-notice-"));
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(userDataDir);
    application = launched.application;
    await launched.page.getByRole("button", { name: "新建聊天" }).click();
    await launched.page.getByRole("button", { name: "创建新 Bot" }).click();
    const blocker = launched.page.evaluate(() => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < 7_000) {
        // Deliberately keep the renderer unresponsive past the five-second close deadline.
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await blocker;
    expect(application.process().exitCode).toBeNull();
    await expect(launched.page.getByText("关闭未完成：资料仍保留在当前窗口，请稍后重试关闭。", { exact: true })).toBeVisible();
    expect(await requestWindowClose(application)).toBe(true);
    application = undefined;
  } finally {
    if (application) application.process().kill("SIGKILL");
    removeTestDirectory(userDataDir);
  }
});

test("exposes only typed runtime capabilities and validates run ids", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-runtime-ipc-"));
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(userDataDir);
    application = launched.application;
    expect(await application.evaluate(({ app }) => app.getName())).toBe("Aevoren Bot");
    expect(await application.evaluate(({ app }) => app.commandLine.hasSwitch("use-mock-keychain"))).toBe(true);
    const result = await launched.page.evaluate(() =>
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.runtime.cancel("not-a-uuid"),
    );
    expect(result).toEqual({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        domain: "validation",
        retryable: false,
        safeMessage: "请求参数不符合要求。",
      },
    });
    expect(await launched.page.evaluate(() =>
      typeof (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.runtime.getSessionSnapshot,
    )).toBe("function");
    const roomResult = await launched.page.evaluate(() =>
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.roomRuntime.getSnapshot("not-a-uuid"),
    );
    expect(roomResult).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST", domain: "validation" } });
    const memoryResult = await launched.page.evaluate(() =>
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.memories.list({ botId: "not-a-uuid" }),
    );
    expect(memoryResult).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST", domain: "validation" } });
    const toolResult = await launched.page.evaluate(() =>
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.tools.list({ sessionId: "not-a-uuid" }),
    );
    expect(toolResult).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST", domain: "validation" } });
    const capabilityResult = await launched.page.evaluate(() =>
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.capabilities.getSnapshot({ botId: "not-a-uuid" }),
    );
    expect(capabilityResult).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST", domain: "validation" } });
    expect(await launched.page.evaluate(() => Object.keys((window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot).toSorted())).toEqual([
      "app", "approvals", "artifacts", "attachments", "bots", "capabilities", "conversations", "events", "mcp", "memories", "messages", "providers", "roomRuntime", "rooms", "routines", "runtime", "sessions", "settings", "tools", "transcript", "updates", "workspaces",
    ]);
    expect(await launched.page.evaluate(() => Object.keys(
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.conversations,
    ).toSorted())).toEqual(["deleteBatch"]);
    expect(await launched.page.evaluate(() => Object.keys(
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.providers,
    ).toSorted())).toEqual(["list", "refresh", "saveCli", "saveOpenAiCompatible", "scan", "test"]);
    expect(await launched.page.evaluate(() => Object.keys(
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.mcp,
    ).toSorted())).toEqual(["authorize", "cancelAuthorization", "clearAuthorization", "delete", "list", "probe", "save", "setEnabled"]);
    expect(await launched.page.evaluate(() => Object.keys(
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.routines,
    ).toSorted())).toEqual(["create", "delete", "list", "listRuns", "runNow", "setEnabled", "update"]);
    expect(await launched.page.evaluate(() => Object.keys(
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.updates,
    ).toSorted())).toEqual(["check", "getState", "installAndRestart", "retry"]);
    expect(await launched.page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe("undefined");
    expect(await launched.page.evaluate(() => typeof (window as unknown as { process?: unknown }).process)).toBe("undefined");
    await application.close();
    application = undefined;
  } finally {
    if (application) application.process().kill("SIGKILL");
    removeTestDirectory(userDataDir);
  }
});
