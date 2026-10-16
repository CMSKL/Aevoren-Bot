import { closeTestApplication, removeTestDirectory } from "./test-cleanup";
import { createServer, type ServerResponse } from "node:http";
import { AppRepository } from "../../src/main/database";
import { closeInspector } from "./navigation";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { AevorenBotApi, SessionLiveStateName } from "@shared/contracts";

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
  const executablePath = process.env.AEVOREN_PACKAGED_APP_PATH ?? process.env.AEVOREN_BOT_PACKAGED_EXECUTABLE;
  const application = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: executablePath ? [] : ["."],
    cwd: process.cwd(),
    env: environment(userDataDir, overrides),
  });
  if (executablePath) {
    const runtime = await application.evaluate(({ app }) => ({ isPackaged: app.isPackaged, version: app.getVersion() }));
    expect(runtime.isPackaged).toBe(true);
    expect(runtime.version).toBe(JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version);
    await test.info().attach("actual-runtime-package", { body: JSON.stringify(runtime), contentType: "application/json" });
  }
  return { application, page: await application.firstWindow() };
}

async function createAndSend(page: Page, text: string, beforeSend?: () => Promise<void>): Promise<void> {
  await page.getByRole("button", { name: "新建聊天" }).click();
  await page.getByRole("button", { name: "创建新 Bot" }).click();
  await expect(page.getByRole("main", { name: "联系人资料", exact: true })).toBeVisible();
  await closeInspector(page);
  await beforeSend?.();
  await page.locator('textarea[aria-label="消息"]').fill(text);
  await page.getByRole("button", { name: "发送", exact: true }).click();
}

async function waitForLiveState(page: Page, state: SessionLiveStateName): Promise<void> {
  await expect.poll(() => page.evaluate(async () => {
    const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
    const bots = await api.bots.list();
    if (!bots.ok || !bots.data[0]) throw new Error("Bot missing");
    const session = await api.sessions.getMain(bots.data[0].id);
    if (!session.ok) throw new Error("Session missing");
    const snapshot = await api.runtime.getSessionSnapshot(session.data.id);
    if (!snapshot.ok) throw new Error("Snapshot unavailable");
    return snapshot.data.liveState.state;
  })).toBe(state);
  await expect(page.getByRole("button", { name: "停止回复" })).toBeVisible();
  await expect(page.locator(".composer-wrap .send-state:not(.runtime-stale), .streaming-indicator")).toHaveCount(0);
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
  const phases: Array<{ name: string; state: SessionLiveStateName }> = [
    { name: "dispatching", state: "starting" },
    { name: "running", state: "running" },
    { name: "streaming", state: "composing" },
  ];
  type Gate = { model: string; phase: string; count: number; response: ServerResponse | null; released: boolean; aborted: boolean };
  let gate: Gate | undefined;
  const errors: string[] = [];
  const delta = (text: string, done = false): string => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: done ? "stop" : null }] })}\n\n`;
  const server = createServer(async (request, response) => {
    try {
      let body = ""; for await (const chunk of request) body += chunk;
      const model = (JSON.parse(body) as { model: string }).model, active = gate;
      if (!active || active.model !== model || request.headers.authorization !== "Bearer reload-fixture-token") throw new Error("Unexpected controlled provider request");
      active.count += 1; if (active.count !== 1) throw new Error("Duplicate controlled provider request");
      active.response = response; response.on("close", () => { if (!active.released) active.aborted = true; });
      // Headers produce started/running; a first content delta produces composing.
      // The next boundary stays held until the reloaded Renderer shows Stop.
      if (active.phase !== "dispatching") { response.writeHead(200, { "content-type": "text/event-stream", "x-request-id": active.model }); response.flushHeaders(); }
      if (active.phase === "streaming") response.write(delta("CONTROLLED_RELOAD_ACTIVE "));
    } catch (error) { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Controlled provider unavailable");
  try {
    for (const phase of phases) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const userDataDir = mkdtempSync(join(tmpdir(), `aevoren-bot-reload-${phase.name}-`));
        const repository = new AppRepository(join(userDataDir, "aevoren-bot.sqlite")); repository.setSetting("memory.capture.enabled", "false", false); repository.close();
        const active: Gate = { model: `reload-${phase.name}-${attempt}`, phase: phase.name, count: 0, response: null, released: false, aborted: false }; gate = active;
        let application: ElectronApplication | undefined;
        try {
          const launched = await launch(userDataDir, { AEVOREN_BOT_FAKE_PROVIDER: "0" }); application = launched.application;
          const page = launched.page;
          await createAndSend(page, `reload ${phase.name} ${attempt}`, async () => {
            await page.evaluate(async input => {
              const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
              const providers = await api.providers.list(), bots = await api.bots.list();
              const provider = providers.ok ? providers.data.find(item => item.id === "openai-compatible.default") : undefined, bot = bots.ok ? bots.data[0] : undefined;
              if (!provider || !bot) throw new Error("Controlled source unavailable");
              const saved = await api.providers.saveOpenAiCompatible({ instanceId: provider.id, expectedVersion: provider.version, baseUrl: input.baseUrl, apiKey: "reload-fixture-token" }); if (!saved.ok) throw new Error(saved.error.code);
              const updated = await api.bots.update({ id: bot.id, expectedVersion: bot.version, patch: { modelSelection: { providerInstanceId: provider.id, modelId: input.model }, mcpServerIds: [] } }); if (!updated.ok) throw new Error(updated.error.code);
            }, { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: active.model });
          });
          await expect.poll(() => active.count).toBe(1);
          await waitForLiveState(page, phase.state);
          await page.reload();
          await expect(page.getByRole("button", { name: "停止回复" })).toBeVisible({ timeout: 2_000 });
          expect(active.aborted).toBe(false); expect(active.released).toBe(false);
          active.released = true;
          if (!active.response) throw new Error("Controlled response missing");
          if (!active.response.headersSent) active.response.writeHead(200, { "content-type": "text/event-stream", "x-request-id": active.model });
          active.response.end(`${delta("CONTROLLED_RELOAD_DONE", true)}data: [DONE]\n\n`);
          await expect(page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(1, { timeout: 10_000 });
          expect(active.count).toBe(1); expect(errors).toEqual([]);
          await closeTestApplication(application); application = undefined;
          const database = new DatabaseSync(join(userDataDir, "aevoren-bot.sqlite"), { readOnly: true });
          try {
            expect(database.prepare("SELECT COUNT(*) AS count FROM runtime_runs").get()).toEqual({ count: 1 });
            expect(database.prepare("SELECT state FROM runtime_runs").get()).toEqual({ state: "completed" });
            expect(database.prepare("SELECT role, COUNT(*) AS count FROM transcript_entries GROUP BY role ORDER BY role").all()).toEqual([{ role: "assistant", count: 1 }, { role: "user", count: 1 }]);
          } finally { database.close(); }
        } finally { if (application) await closeTestApplication(application); removeTestDirectory(userDataDir); }
      }
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
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
    await expect(page.getByText("模型回复未完整完成，系统已保留可验证结果。")).toBeVisible();
    await page.waitForTimeout(30_000);
    await expect(page.locator('article.message-assistant[data-status="failed"]')).toHaveCount(1);
    await expect(page.getByRole("button", { name: "重试此步骤" })).toHaveCount(1);
    await page.getByRole("button", { name: "重试此步骤" }).click();
    await waitForLiveState(page, "retrying");
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
    await waitForLiveState(launched.page, "composing");
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
    state: SessionLiveStateName;
    cancelBeforeKill: boolean;
  }> = [
    { name: "running", state: "running", cancelBeforeKill: false },
    { name: "streaming", state: "composing", cancelBeforeKill: false },
    { name: "cancel-requested", state: "cancelling", cancelBeforeKill: true },
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
        await waitForLiveState(launched.page, "running");
        await launched.page.getByRole("button", { name: "停止回复" }).click();
      }
      await waitForLiveState(launched.page, phase.state);
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
    await waitForLiveState(launched.page, "starting");

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
    if (!process.env.AEVOREN_PACKAGED_APP_PATH && !process.env.AEVOREN_BOT_PACKAGED_EXECUTABLE) {
      expect(await application.evaluate(({ app }) => app.commandLine.hasSwitch("use-mock-keychain"))).toBe(true);
    }
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
    const cancelMemberResult = await launched.page.evaluate(() =>
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.roomRuntime.cancelMember("not-a-uuid"),
    );
    expect(cancelMemberResult).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST", domain: "validation" } });
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
      "app", "approvals", "artifacts", "attachments", "bots", "browser", "capabilities", "computer", "connectors", "conversations", "demonstrations", "drafts", "environments", "events", "execution", "library", "mcp", "mcpWrites", "media", "memories", "messages", "outbound", "preview", "processes", "productUI", "projects", "providers", "roomRuntime", "rooms", "routines", "runtime", "sessions", "settings", "skillsExecution", "teams", "tools", "transcript", "updates", "userProfile", "voice", "workspaces",
    ]);
    expect(await launched.page.evaluate(() => Object.keys((window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.sessions).toSorted())).toEqual([
      "cancelTask", "createTask", "deleteTask", "getMain", "getTask", "listTasks", "onChanged", "onTasksChanged", "reviseTaskSelection", "taskOptions", "updateTask",
    ]);
    const taskValidation = await launched.page.evaluate(async () => {
      const sessions = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.sessions;
      const scope = { sessionId: "not-a-uuid" }, versioned = { ...scope, expectedVersion: 1 };
      return Promise.all([
        sessions.taskOptions(scope), sessions.getTask(scope), sessions.listTasks({ parentSessionId: scope.sessionId }),
        sessions.createTask({ parentSessionId: scope.sessionId, expectedScopeVersion: 1, clientNonce: "not-a-uuid", title: "Invalid task", selections: [] }),
        sessions.updateTask({ ...versioned, title: "Invalid task" }), sessions.reviseTaskSelection({ ...versioned, selections: [] }), sessions.cancelTask(versioned), sessions.deleteTask(versioned),
      ]);
    });
    for (const result of taskValidation) expect(result).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST", domain: "validation" } });
    expect(await launched.page.evaluate(() => Object.keys(
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.media,
    ).toSorted())).toEqual(["available", "bind", "delete", "importPath", "list", "metadata", "onChanged", "pickImport", "preview", "read", "restore", "setEnabled", "unbind"]);
    const mediaResult = await launched.page.evaluate(() =>
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.media.metadata({ sessionId: "not-a-uuid", id: "not-a-uuid" }),
    );
    expect(mediaResult).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST", domain: "validation" } });
    expect(await launched.page.evaluate(() => Object.keys(
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.voice,
    ).toSorted())).toEqual(["audio", "beginCapture", "cancelCapture", "commitCapture", "configurations", "get", "list", "onChanged", "realtime", "saveConfiguration", "speak", "stop", "transcribe"]);
    expect(await launched.page.evaluate(() => Object.keys(
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.voice.realtime,
    ).toSorted())).toEqual(["append", "commitTurn", "interrupt", "onChanged", "playbackAck", "snapshot", "start", "stop", "stopTask"]);
    const realtimeValidation = await launched.page.evaluate(async () => {
      const realtime = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.voice.realtime;
      return [await realtime.snapshot({ sessionId: "not-a-uuid", id: "not-a-uuid" }), await realtime.append({ sessionId: "not-a-uuid", id: "not-a-uuid", captureId: "not-a-uuid", sequence: 0, dataBase64: "AAA=" })];
    });
    for (const result of realtimeValidation) expect(result).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST", domain: "validation" } });
    const voiceResult = await launched.page.evaluate(() =>
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.voice.get({ sessionId: "not-a-uuid", id: "not-a-uuid" }),
    );
    expect(voiceResult).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST", domain: "validation" } });
    expect(await launched.page.evaluate(() => Object.keys(
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.connectors,
    ).toSorted())).toEqual(["authorize", "bind", "bindings", "cancelAuthorization", "configure", "list", "read", "revoke", "search", "unbind"]);
    expect(await launched.page.evaluate(() => Object.keys(
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.drafts,
    ).toSorted())).toEqual(["create", "delete", "list", "read", "update", "versions"]);
    expect(await launched.page.evaluate(() => Object.keys(
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.outbound,
    ).toSorted())).toEqual(["cancel", "enableSend", "get", "grantWrite", "list", "prepare", "reconcile", "reject", "requestApproval", "revokeWrite", "writeGrants"]);
    expect(await launched.page.evaluate(() => Object.keys(
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.mcpWrites,
    ).toSorted())).toEqual(["cancelTool", "closeApp", "grantTool", "listToolIntents", "openApp", "prepareTool", "requestToolApproval", "revokeTool", "toolCatalog", "toolGrants", "toolResult"]);
    const connectorValidation = await launched.page.evaluate(async () => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      return Promise.all([api.connectors.bindings({ sessionId: "not-a-uuid", executorBotId: "not-a-uuid" }),
        api.drafts.read({ sessionId: "not-a-uuid", executorBotId: "not-a-uuid", id: "not-a-uuid" }),
        api.outbound.writeGrants({ sessionId: "not-a-uuid", executorBotId: "not-a-uuid" }),
        api.outbound.requestApproval({ sessionId: "not-a-uuid", executorBotId: "not-a-uuid", id: "not-a-uuid", expectedVersion: 1 })]);
    });
    for (const result of connectorValidation) expect(result).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST", domain: "validation" } });
    const mcpValidation = await launched.page.evaluate(async () => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const scope = { sessionId: "not-a-uuid", executorBotId: "not-a-uuid" };
      return Promise.all([api.mcpWrites.toolGrants(scope), api.mcpWrites.requestToolApproval({ ...scope, id: "not-a-uuid", expectedVersion: 1 }),
        api.mcpWrites.openApp({ ...scope, id: "not-a-uuid", expectedVersion: 1 }), api.mcpWrites.closeApp({ ...scope, id: "not-a-uuid", expectedEpoch: -1 })]);
    });
    for (const result of mcpValidation) expect(result).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST", domain: "validation" } });
    expect(await launched.page.evaluate(() => Object.keys(
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.roomRuntime,
    ).toSorted())).toEqual(["cancel", "cancelMember", "continue", "getSnapshot", "retryTurn", "send"]);
    expect(await launched.page.evaluate(() => Object.keys(
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.skillsExecution,
    ).toSorted())).toEqual(["executionGrants", "grantExecution", "onChanged", "revokeExecution", "runScript", "scriptExecution", "scripts"]);
    const skillsValidation = await launched.page.evaluate(async () => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      return Promise.all([
        api.skillsExecution.scripts({ sessionId: "not-a-uuid", executorBotId: "not-a-uuid", reference: { resourceId: "not-a-uuid", revisionId: "not-a-uuid", digest: "invalid" } }),
        api.skillsExecution.executionGrants({ sessionId: "not-a-uuid", executorBotId: "not-a-uuid" }),
      ]);
    });
    for (const result of skillsValidation) expect(result).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST", domain: "validation" } });
    expect(await launched.page.evaluate(() => Object.keys(
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.browser,
    ).toSorted())).toEqual(["click", "closeTab", "download", "downloads", "get", "key", "navigate", "newTab", "observe", "onChanged", "read", "scroll", "start", "stop", "tabs", "type"]);
    expect(await launched.page.evaluate(() => Object.keys(
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.computer,
    ).toSorted())).toEqual(["click", "key", "onChanged", "returnControl", "screenshot", "scroll", "takeover", "type", "view", "vncTicket"]);
    expect(await launched.page.evaluate(() => Object.keys(
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.preview,
    ).toSorted())).toEqual(["close", "list", "onChanged", "open"]);
    expect(await launched.page.evaluate(() => Object.keys((window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.demonstrations).toSorted())).toEqual(["deleteDraft", "discard", "drafts", "publish", "readDraft", "start", "status", "stop", "updateDraft"]);
    const demonstrationValidation = await launched.page.evaluate(async () => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      return Promise.all([api.demonstrations.drafts({ sessionId: "not-a-uuid", executorBotId: "not-a-uuid" }), api.demonstrations.publish({ sessionId: "not-a-uuid", executorBotId: "not-a-uuid", id: "not-a-uuid", expectedVersion: -1, expectedDigest: "invalid" })]);
    });
    for (const result of demonstrationValidation) expect(result).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST", domain: "validation" } });
    const browserValidation = await launched.page.evaluate(async () => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const invalidScope = { sessionId: "not-a-uuid", executorBotId: "not-a-uuid" };
      return Promise.all([api.browser.get(invalidScope), api.computer.view(invalidScope), api.preview.list({ ...invalidScope, expectedEpoch: -1 })]);
    });
    for (const result of browserValidation) expect(result).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST", domain: "validation" } });
    expect(await launched.page.evaluate(() => Object.keys(
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.environments,
    ).toSorted())).toEqual(["get", "initialize", "list", "onChanged", "probe", "rebuild", "start", "stop"]);
    expect(await launched.page.evaluate(() => Object.keys(
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.execution,
    ).toSorted())).toEqual(["cancel", "downloadFile", "get", "list", "listFiles", "logs", "onChanged", "pickUpload", "readFile", "run", "writeFile"]);
    expect(await launched.page.evaluate(() => Object.keys(
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.processes,
    ).toSorted())).toEqual(["list", "listPorts", "onChanged", "registerPort", "start", "stop"]);
    const environmentValidation = await launched.page.evaluate(async () => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const invalidScope = { sessionId: "not-a-uuid", executorBotId: "not-a-uuid" };
      return Promise.all([api.environments.get(invalidScope), api.execution.run({ ...invalidScope, command: "printf should-not-run", clientNonce: "not-a-uuid" }), api.processes.listPorts(invalidScope)]);
    });
    for (const result of environmentValidation) expect(result).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST", domain: "validation" } });
    expect(await launched.page.evaluate(() => Object.keys(
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.library,
    ).toSorted())).toEqual(["available", "bind", "create", "delete", "export", "importPath", "importText", "list", "onChanged", "pickImport", "read", "readFile", "restore", "restoreVersion", "setEnabled", "unbind", "update", "versions"]);
    const libraryResult = await launched.page.evaluate(() =>
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.library.list({ sessionId: "not-a-uuid" }),
    );
    expect(libraryResult).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST", domain: "validation" } });
    expect(await launched.page.evaluate(() => Object.keys(
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.conversations,
    ).toSorted())).toEqual(["clear", "deleteBatch", "list", "setHidden", "setPinned", "setProject", "setUnread"]);
    expect(await launched.page.evaluate(() => Object.keys(
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.artifacts,
    ).toSorted())).toEqual(["reveal", "save"]);
    expect(await launched.page.evaluate(() => Object.keys(
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.workspaces,
    ).toSorted())).toEqual(["add", "list", "remove", "reveal", "updatePermissions"]);
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
    const owned = application.process();
    await application.close();
    expect({ code: owned.exitCode, signal: owned.signalCode }).toEqual({ code: 0, signal: null });
    application = undefined;
  } finally {
    if (application) application.process().kill("SIGKILL");
    removeTestDirectory(userDataDir);
  }
});
