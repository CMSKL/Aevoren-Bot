import { createServer, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import type { AevorenBotApi, RoomRuntimeSnapshot } from "../../src/shared/contracts";
import { AppRepository } from "../../src/main/database";
import { removeTestDirectory } from "./test-cleanup";

type PendingReply = { response: ServerResponse; released: boolean; aborted: boolean };
type RoomCase = {
  page: Page;
  bots: Array<{ id: string; name: string; modelId: string }>;
  replies: Map<string, PendingReply>;
  snapshot: () => Promise<RoomRuntimeSnapshot>;
  release: (modelId: string, failed?: boolean) => void;
  requestApproval: (modelId: string) => void;
};

// The local API holds every request until the test releases it. Reaching six
// requests before any reply is sent proves concurrency without timing guesses.
async function withRoom(callback: (room: RoomCase) => Promise<void>, task = "每位成员分别回复自己的验收结果。"): Promise<void> {
  const data = mkdtempSync(join(tmpdir(), "aevoren-room-parallel-"));
  const repository = new AppRepository(join(data, "aevoren-bot.sqlite"));
  const bots = Array.from({ length: 6 }, (_, index) => {
    const created = repository.createBot();
    const modelId = `fixture-parallel-${index + 1}`;
    const bot = repository.updateBot(created.bot.id, created.bot.version, {
      name: `并行成员${index + 1}`,
      mcpServerIds: [],
      modelSelection: { providerInstanceId: "openai-compatible.default", modelId },
    });
    return { id: bot.id, name: bot.name, modelId };
  });
  const detail = repository.createRoom({ name: "所有人并行验收", memberBotIds: bots.map((bot) => bot.id), leadBotId: null });
  repository.setSetting("memory.capture.enabled", "false", false);
  repository.close();

  const replies = new Map<string, PendingReply>();
  const requests: string[] = [];
  const fixtureErrors: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      const command = JSON.parse(body) as { model: string };
      if (!bots.some((bot) => bot.modelId === command.model)) throw new Error("Unexpected fixture model");
      if (replies.has(command.model)) throw new Error("Unexpected duplicate model request");
      requests.push(command.model);
      const pending = { response, released: false, aborted: false };
      replies.set(command.model, pending);
      response.on("close", () => { if (!pending.released) pending.aborted = true; });
    } catch (error) {
      fixtureErrors.push(error instanceof Error ? error.message : "Fixture request failed");
      response.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server unavailable");
  const executablePath = process.env.AEVOREN_PACKAGED_APP_PATH;
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("AEVOREN_BOT_FAKE_") && !["AEVOREN_BOT_DB_PATH", "AEVOREN_BOT_USER_DATA_DIR"].includes(key),
  ));
  const application = await electron.launch({
    ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : ["."], cwd: process.cwd(),
    env: { ...environment, AEVOREN_BOT_FAKE_PROVIDER: "0", AEVOREN_BOT_USER_DATA_DIR: data, AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_DISABLE_UPDATES: "1" },
  });
  try {
    if (executablePath) expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
    const page = await application.firstWindow();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.evaluate(async (baseUrl) => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const listed = await api.providers.list();
      const provider = listed.ok ? listed.data.find((item) => item.id === "openai-compatible.default") : undefined;
      if (!provider) throw new Error("API source unavailable");
      const saved = await api.providers.saveOpenAiCompatible({ instanceId: provider.id, expectedVersion: provider.version, baseUrl, apiKey: "parallel-fixture-token" });
      if (!saved.ok) throw new Error(saved.error.code);
    }, `http://127.0.0.1:${address.port}/v1`);
    await page.getByRole("listitem", { name: detail.room.name, exact: true }).click();
    await expect(page.getByRole("heading", { name: detail.room.name, exact: true })).toBeVisible();
    const input = page.getByLabel("消息", { exact: true });
    await input.fill("@");
    await expect(page.getByRole("listbox", { name: "提及 Bot" })).toBeVisible();
    await page.getByRole("option").filter({ hasText: "所有人" }).click();
    await expect(page.getByRole("button", { name: "移除 @所有人" })).toBeVisible();
    await input.fill(task);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(() => replies.size, { timeout: 15_000 }).toBe(6);
    expect(requests.toSorted()).toEqual(bots.map((bot) => bot.modelId).toSorted());

    const snapshot = async () => {
      const current = await page.evaluate(async (roomId) =>
        (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.roomRuntime.getSnapshot(roomId), detail.room.id,
      );
      if (!current.ok) throw new Error(current.error.code);
      return current.data;
    };
    const initial = await snapshot();
    expect(initial.batches.map((batch) => ({ mode: batch.routingMode, state: batch.state }))).toEqual([{ mode: "everyone", state: "running" }]);
    expect(initial.turns).toHaveLength(6);
    expect(initial.turns.every((turn) => turn.state === "running")).toBe(true);
    expect(initial.runs).toHaveLength(6);
    expect(initial.handoffs).toEqual([]);
    const release = (modelId: string, failed = false) => {
      const pending = replies.get(modelId);
      const bot = bots.find((item) => item.modelId === modelId);
      if (!pending || !bot || pending.released || pending.aborted) throw new Error("Fixture reply unavailable");
      pending.released = true;
      if (failed) {
        pending.response.writeHead(400, { "content-type": "application/json" });
        pending.response.end(JSON.stringify({ error: { message: "Fixture request refused", type: "invalid_request_error", code: "invalid_request_error" } }));
      } else {
        pending.response.writeHead(200, { "content-type": "text/event-stream" });
        pending.response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `${bot.name}独立回复` }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      }
    };
    const requestApproval = (modelId: string): void => {
      const pending = replies.get(modelId);
      if (!pending || pending.released || pending.aborted) throw new Error("Fixture approval reply unavailable");
      pending.released = true;
      pending.response.writeHead(200, { "content-type": "text/event-stream" });
      pending.response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "parallel-approval-create", type: "function", function: { name: "bot_create", arguments: JSON.stringify({ name: "并行审批测试 Bot", description: "本次审批停止后不应创建。" }) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
    };
    try { await callback({ page, bots, replies, snapshot, release, requestApproval }); }
    catch (error) {
      // Capture the actual owned Runtime state before cleanup cancels survivors.
      const diagnostic = await Promise.race([
        snapshot().then(current => ({
          batches: current.batches.map(({ id, state }) => ({ id, state })),
          turns: current.turns.map(({ memberBotId, state }) => ({ memberBotId, state })),
          runs: current.runs.map(({ executorBotId, state, lastErrorCode }) => ({ executorBotId, state, lastErrorCode })),
          assistantStatuses: current.entries.filter(entry => entry.role === "assistant").map(({ speakerBotId, status }) => ({ speakerBotId, status })),
        })).catch(() => ({ unavailable: true })),
        new Promise<{ unavailable: true }>(resolve => { const timer = setTimeout(() => resolve({ unavailable: true }), 1_000); timer.unref(); }),
      ]);
      await test.info().attach("controlled-room-failure-state", { body: JSON.stringify({
        runtime: diagnostic,
        responses: [...replies.entries()].map(([modelId, pending]) => ({ modelId, released: pending.released, aborted: pending.aborted, destroyed: pending.response.destroyed, ended: pending.response.writableEnded, finished: pending.response.writableFinished })),
        fixtureErrors, pageErrors,
      }), contentType: "application/json" });
      throw error;
    }
    expect((await snapshot()).handoffs).toEqual([]);
    expect(requests).toHaveLength(6);
    expect(fixtureErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isVisible()))).toBe(false);
  } finally {
    server.closeAllConnections();
    await application.close().catch(() => application.process().kill("SIGKILL"));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    removeTestDirectory(data);
  }
}

test("starts all six @everyone Bot replies together and displays a fast result before slower members finish", async () => {
  test.setTimeout(90_000);
  await withRoom(async ({ page, bots, replies, snapshot, release }) => {
    const fast = bots[5]!;
    release(fast.modelId);
    const completed = page.locator('article.message-assistant[data-status="completed"]');
    await expect(completed).toHaveCount(1);
    await expect(completed).toContainText(`${fast.name}独立回复`);
    await expect(completed.locator(".speaker-link")).toHaveText(fast.name);
    const partial = await snapshot();
    expect(partial.batches[0]?.state).toBe("running");
    expect(partial.turns.filter((turn) => turn.state === "running")).toHaveLength(5);
    expect([...replies.values()].filter((reply) => !reply.released && !reply.aborted)).toHaveLength(5);
    await expect(page.getByRole("button", { name: "停止群聊回复" })).toBeVisible();
    const evidence = process.env.AEVOREN_PRODUCT_EVIDENCE_DIR ?? tmpdir();
    mkdirSync(evidence, { recursive: true });
    // Hidden Windows runners can stall compositor capture. The concurrency,
    // visible reply and host-state assertions remain required on every platform.
    if (process.platform !== "win32") await page.screenshot({ path: join(evidence, "room-parallel-fast-result.png"), animations: "disabled" });

    for (const bot of bots.slice(0, 5)) release(bot.modelId);
    await expect(completed).toHaveCount(6);
    await expect.poll(async () => (await snapshot()).batches[0]?.state).toBe("completed");
    const final = await snapshot();
    expect(final.turns.every((turn) => turn.state === "completed")).toBe(true);
    expect(final.runs.every((run) => run.state === "completed")).toBe(true);
    const entries = final.entries.filter((entry) => entry.role === "assistant");
    expect(entries).toHaveLength(6);
    for (const bot of bots) {
      const turn = final.turns.find((item) => item.memberBotId === bot.id)!;
      expect(entries.find((entry) => entry.speakerBotId === bot.id)).toMatchObject({
        body: `${bot.name}独立回复`, status: "completed", sourceTurnId: turn.id, speakerNameSnapshot: bot.name,
      });
    }
    if (process.platform !== "win32") await page.screenshot({ path: join(evidence, "room-parallel-completed.png"), animations: "disabled" });
  });
});

test("stops only the member awaiting tool approval and lets the other five replies finish", async () => {
  test.setTimeout(90_000);
  await withRoom(async ({ page, bots, replies, snapshot, release, requestApproval }) => {
    requestApproval(bots[0]!.modelId);
    const permission = page.getByTestId("tool-permission-dialog");
    await expect(permission).toBeVisible();
    await expect(permission).toContainText(bots[0]!.name);
    const before = await page.evaluate(() => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.bots.list());
    if (!before.ok) throw new Error("Actual Bot list unavailable");
    await permission.getByRole("button", { name: "停止任务", exact: true }).click();
    await expect(permission).toBeHidden();
    await expect.poll(async () => (await snapshot()).turns.filter(turn => turn.state === "cancelled").length).toBe(1);
    const partial = await snapshot();
    expect(partial.turns.filter(turn => turn.state === "cancelled").map(turn => turn.memberBotId)).toEqual([bots[0]!.id]);
    expect(partial.turns.filter(turn => turn.state === "running")).toHaveLength(5);
    expect(partial.batches[0]?.state).toBe("running");
    expect([...replies.values()].filter(reply => !reply.released && !reply.aborted)).toHaveLength(5);
    for (const bot of bots.slice(1)) release(bot.modelId);
    await expect(page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(5);
    await expect.poll(async () => (await snapshot()).turns.filter(turn => turn.state === "completed").length).toBe(5);
    const final = await snapshot();
    expect(final.runs.filter(run => run.state === "cancelled")).toHaveLength(1);
    expect(final.runs.filter(run => run.state === "completed")).toHaveLength(5);
    const after = await page.evaluate(() => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.bots.list());
    expect(after.ok && after.data.map(bot => bot.id).toSorted()).toEqual(before.data.map(bot => bot.id).toSorted());
  }, "成员1请创建一个并行审批测试 Bot，其他成员分别回复自己的验收结果。");
});

test("stops all six parallel API requests when the user cancels the Room reply", async () => {
  test.setTimeout(90_000);
  await withRoom(async ({ page, replies, snapshot }) => {
    await page.getByRole("button", { name: "停止群聊回复" }).click();
    await expect.poll(() => [...replies.values()].filter((reply) => reply.aborted).length).toBe(6);
    await expect.poll(async () => (await snapshot()).turns.filter((turn) => turn.state === "cancelled").length).toBe(6);
    const final = await snapshot();
    expect(final.batches[0]?.state).toBe("cancelled");
    expect(final.runs.every((run) => run.state === "cancelled")).toBe(true);
    expect(final.entries.filter((entry) => entry.role === "assistant").every((entry) => entry.status === "cancelled")).toBe(true);
    await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
  });
});

test("keeps the other five members running after one parallel Bot request fails", async () => {
  test.setTimeout(90_000);
  await withRoom(async ({ page, bots, snapshot, release }) => {
    release(bots[0]!.modelId, true);
    await expect.poll(async () => (await snapshot()).turns.filter((turn) => turn.state === "failed").length).toBe(1);
    const partial = await snapshot();
    expect(partial.batches[0]?.state).toBe("running");
    expect(partial.turns.filter((turn) => turn.state === "running")).toHaveLength(5);
    for (const bot of bots.slice(1)) release(bot.modelId);
    await expect(page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(5);
    await expect.poll(async () => (await snapshot()).batches[0]?.state).toBe("partial");
    const final = await snapshot();
    expect(final.turns.filter((turn) => turn.state === "failed").map((turn) => turn.memberBotId)).toEqual([bots[0]!.id]);
    expect(final.turns.filter((turn) => turn.state === "completed")).toHaveLength(5);
  });
});
