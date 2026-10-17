import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test, type Page } from "@playwright/test";
import type { AevorenBotApi, RoomRuntimeSnapshot } from "../../src/shared/contracts";
import { AppRepository } from "../../src/main/database";
import { copyRealApiProfile } from "./real-api-profile";
import { removeTestDirectory } from "./test-cleanup";

type RoutingRequestEvidence = {
  model: string;
  toolNames: string[];
  executorId?: string;
  peerMessages: Array<{ role: string; originalRole: string; speakerBotId: string | null }>;
  ownAssistantIds: string[];
};

// Browser plugin not available. Exercise the existing hidden Electron UI through
// Playwright; all model requests use the configured real API, without stubs.
test("real API respects single/all routing, uses the legacy selector, and answers a lead greeting once", async ({ playwright }, testInfo) => {
  const sourcePath = process.env.AEVOREN_P0_REAL_SOURCE_DB;
  test.skip(!sourcePath, "requires an explicitly selected real installed API profile");
  test.setTimeout(420_000);
  const directory = mkdtempSync(join(tmpdir(), "aevoren-p0-routing-real-"));
  const databasePath = join(directory, "aevoren-bot.sqlite");
  const modelId = copyRealApiProfile(sourcePath!, databasePath);
  const fresh = new DatabaseSync(databasePath, { readOnly: true });
  try {
    for (const table of ["bots", "rooms", "transcript_entries", "memory_items", "routines"]) {
      expect(fresh.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  } finally { fresh.close(); }
  const repository = new AppRepository(databasePath);
  const seeded = (() => {
    try {
      repository.setDefaultModelSelection({ providerInstanceId: "openai-compatible.default", modelId });
      repository.setSetting("memory.capture.enabled", "false", false);
      const productCreated = repository.createBot();
      const product = repository.updateBot(productCreated.bot.id, productCreated.bot.version, {
        name: "产品顾问", label: "产品规划与用户体验", description: "负责用户需求、产品体验与小团队的产品范围。",
        instructions: "关注普通用户的使用体验，给出具体、简洁的产品建议。",
      });
      const budgetCreated = repository.createBot();
      const budget = repository.updateBot(budgetCreated.bot.id, budgetCreated.bot.version, {
        name: "预算顾问", label: "财务预算与费用控制", description: "负责财务预算、成本结构和费用控制。",
        instructions: "从预算可执行性和成本控制角度分析问题，建议简洁明确。",
      });
      const members = [product.id, budget.id];
      return {
        product, budget,
        fixed: repository.createRoom({ name: "固定协调路由验收", memberBotIds: members, leadBotId: product.id }),
        automatic: repository.createRoom({ name: "每轮自动路由验收", memberBotIds: members, leadBotId: null }),
      };
    } finally { repository.close(); }
  })();
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    AEVOREN_BOT_USER_DATA_DIR: directory,
    AEVOREN_BOT_TEST_HIDDEN: "1",
    AEVOREN_BOT_DISABLE_UPDATES: "1",
    AEVOREN_BOT_USE_SYSTEM_SAFE_STORAGE: "1",
  };
  delete env.AEVOREN_BOT_FAKE_PROVIDER;
  delete env.AEVOREN_BOT_DB_PATH;
  const app = await playwright._electron.launch({ args: ["."], cwd: process.cwd(), env });
  const evidence: Array<{ step: string; snapshot: RoomRuntimeSnapshot }> = [];
  try {
    const page = await app.firstWindow();
    const consoleErrors: string[] = [];
    const consoleWarnings: string[] = [];
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
      if (message.type() === "warning") consoleWarnings.push(message.text());
    });
    await expect(page).toHaveTitle("Aevoren Bot");
    await expect(page.locator(".app-shell")).toBeVisible();
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    expect(page.url()).toMatch(/^file:/u);
    const provider = await page.evaluate(async () => {
      const result = await (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.providers.list();
      if (!result.ok) throw new Error(result.error.code);
      return result.data.find((entry) => entry.id === "openai-compatible.default");
    });
    expect(provider).toMatchObject({ status: "available", authenticated: true, capabilities: { roomOwnerSelection: true, handoff: true } });
    expect(provider?.models.options.some((model) => model.id === modelId)).toBe(true);

    // Observe only public request shape while forwarding every request unchanged.
    // This proves that automatic mode invokes the real selector, rather than a
    // deterministic fallback, without recording credentials or user history.
    await app.evaluate(() => {
      const state = globalThis as typeof globalThis & { __aevorenRoutingEvidence?: RoutingRequestEvidence[] };
      const originalFetch = globalThis.fetch.bind(globalThis);
      state.__aevorenRoutingEvidence = [];
      globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
        const body = args[1]?.body;
        if (typeof body === "string") {
          try {
            const request = JSON.parse(body) as { model?: string; tools?: Array<{ function?: { name?: string } }>; messages?: Array<{ role: string; content?: string }> };
            if (typeof request.model === "string") {
              const projected: RoutingRequestEvidence = { model: request.model,
                toolNames: (request.tools ?? []).flatMap((tool) => typeof tool.function?.name === "string" ? [tool.function.name] : []),
                peerMessages: [], ownAssistantIds: [] };
              for (const message of request.messages ?? []) {
                if (typeof message.content !== "string") continue;
                if (message.role === "assistant") {
                  const author = /^\[room-speaker id="([^"]+)"/u.exec(message.content)?.[1];
                  if (author) projected.ownAssistantIds.push(author);
                }
                try {
                  const block = JSON.parse(message.content);
                  if (message.role === "system" && typeof block.currentExecutor?.id === "string") projected.executorId = block.currentExecutor.id;
                  if (typeof block.notice === "string" && block.notice.startsWith("UNTRUSTED_PEER_MESSAGE")) projected.peerMessages.push({
                    role: message.role, originalRole: block.originalRole, speakerBotId: block.speakerBotId,
                  });
                } catch { /* Plain text and quoted bodies are never retained. */ }
              }
              state.__aevorenRoutingEvidence!.push(projected);
            }
          } catch { /* Non-model request bodies are not retained. */ }
        }
        return originalFetch(...args);
      };
    });
    const requestShapes = () => app.evaluate(() =>
      (globalThis as typeof globalThis & { __aevorenRoutingEvidence?: RoutingRequestEvidence[] }).__aevorenRoutingEvidence ?? [],
    );
    const snapshot = (roomId: string) => page.evaluate(async (id) => {
      const result = await (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.roomRuntime.getSnapshot(id);
      if (!result.ok) throw new Error(result.error.code);
      return result.data;
    }, roomId);
    const openRoom = async (name: string): Promise<void> => {
      await page.getByRole("tab", { name: "聊天", exact: true }).click();
      await page.locator(".bot-row").filter({ hasText: name }).click();
      await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    };
    const finish = async (roomId: string, expectedBatches: number, step: string, allowLegacyHandoffs = false) => {
      await expect.poll(async () => {
        const state = await snapshot(roomId);
        const batch = state.batches.at(-1);
        if (state.batches.length !== expectedBatches || !batch) return "waiting";
        if (["partial", "cancelled", "interrupted"].includes(batch.state)) {
          throw new Error(`${step}: ${JSON.stringify({ state: batch.state, summary: batch.summaryState, errors: state.turns.filter((turn) => turn.batchId === batch.id).map((turn) => turn.lastErrorCode) })}`);
        }
        return batch.state;
      }, { timeout: 120_000, intervals: [500] }).toBe("completed");
      const state = await snapshot(roomId);
      evidence.push({ step, snapshot: state });
      const batch = state.batches.at(-1)!;
      const turns = state.turns.filter((turn) => turn.batchId === batch.id);
      const runtimeIds = new Set(turns.map((turn) => turn.runtimeRunId));
      const runs = state.runs.filter((run) => runtimeIds.has(run.id));
      expect(turns.every((turn) => turn.state === "completed" && turn.attemptNo === 1)).toBe(true);
      expect(runs).toHaveLength(turns.length);
      expect(runs.every((run) => run.route === "openai-compatible" && run.providerInstanceId === "openai-compatible.default" && run.providerModelId === modelId && run.state === "completed")).toBe(true);
      if (!allowLegacyHandoffs) expect(state.handoffs.filter((handoff) => handoff.runId === batch.id)).toEqual([]);
      expect(new Set(turns.map((turn) => turn.logicalTurnId)).size).toBe(turns.length);
      expect(turns.length).toBeLessThanOrEqual(batch.maxTurns);
      expect(turns.filter((turn) => turn.turnPurpose === "summary")).toEqual([]);
      expect(batch.summaryState).toBe("not-required");
      for (const turn of turns) {
        const replies = state.entries.filter((entry) => entry.sourceTurnId === turn.id && entry.role === "assistant");
        expect(replies).toHaveLength(1);
        expect(replies[0]?.status).toBe("completed");
        expect(replies[0]!.body.trim().length).toBeGreaterThan(5);
      }
      await expect(page.getByLabel("群聊默认响应方式")).toBeEnabled();
      await page.screenshot({ path: testInfo.outputPath(`${step}.png`) });
      return { state, batch, turns };
    };
    const send = async (target: Page, text: string): Promise<void> => {
      await target.getByLabel("消息", { exact: true }).fill(text);
      await target.getByRole("button", { name: "发送", exact: true }).click();
    };
    const assertReplyIdentity = (state: RoomRuntimeSnapshot, botId: string): void => {
      const batchId = state.batches.at(-1)!.id;
      const turn = state.turns.find((candidate) => candidate.batchId === batchId && candidate.agentId === botId)!;
      const reply = state.entries.find((candidate) => candidate.sourceTurnId === turn.id && candidate.role === "assistant")!;
      const own = botId === seeded.product.id ? seeded.product : seeded.budget;
      const other = botId === seeded.product.id ? seeded.budget : seeded.product;
      expect(reply).toMatchObject({ speakerBotId: own.id, speakerNameSnapshot: own.name });
      expect(reply.body).toContain(own.name);
      expect(reply.body).not.toContain(other.name);
      if (own.id === seeded.product.id) {
        expect(reply.body).toMatch(/用户需求|产品体验|用户体验|产品范围|功能范围/u);
        expect(reply.body).not.toMatch(/(?:自身|自己|我的|我负责|负责).{0,12}(?:预算控制|财务预算|费用控制)/u);
      } else {
        expect(reply.body).toMatch(/财务|费用控制|成本控制|预算/u);
      }
    };

    await openRoom(seeded.fixed.room.name);
    await page.getByLabel("消息", { exact: true }).fill("@预算");
    await expect(page.getByRole("listbox", { name: "提及 Bot" })).toBeVisible();
    await page.getByRole("listbox", { name: "提及 Bot" }).getByRole("option").filter({ hasText: seeded.budget.name }).click();
    await expect(page.getByRole("button", { name: "移除 @预算顾问" })).toBeVisible();
    await expect(page.getByLabel("群聊默认响应方式")).toHaveValue("explicit");
    await send(page, "一个十人内部会议记录工具准备上线，首月预算有限。先用你配置中的 Bot 名称说明你负责的领域，再给出一条费用控制建议及理由；只介绍你自己，简洁回答。");
    const single = await finish(seeded.fixed.room.id, 1, "explicit-single");
    expect(single.batch).toMatchObject({ routingMode: "explicit", orchestrationEnabled: false, leadBotId: null });
    expect(single.turns.map((turn) => turn.agentId)).toEqual([seeded.budget.id]);
    expect(single.turns[0]?.turnPurpose).toBe("work");
    assertReplyIdentity(single.state, seeded.budget.id);
    await expect(page.locator("article.message-user").last().locator(".message-route-chip")).toHaveText(["@预算顾问"]);
    expect((await requestShapes()).some((request) => request.toolNames.includes("select_room_owner"))).toBe(false);

    await page.getByLabel("群聊默认响应方式").selectOption("everyone");
    await expect(page.getByLabel("群聊默认响应方式")).toHaveValue("everyone");
    await send(page, "我们下周上线十人内部使用的会议记录工具。每人先用自己配置中的 Bot 名称说明负责的领域，再各自从本职角度提一条本周能落实的改进建议。只介绍自己，不代替其他人回答，每人简洁回答。");
    const everyone = await finish(seeded.fixed.room.id, 2, "everyone");
    expect(everyone.batch).toMatchObject({ routingMode: "everyone", orchestrationEnabled: false, leadBotId: null });
    expect(everyone.turns.map((turn) => turn.agentId)).toEqual([seeded.product.id, seeded.budget.id]);
    expect(everyone.turns.every((turn) => turn.turnPurpose === "work")).toBe(true);
    assertReplyIdentity(everyone.state, seeded.product.id);
    assertReplyIdentity(everyone.state, seeded.budget.id);
    const productRequests = (await requestShapes()).filter((request) => request.executorId === seeded.product.id);
    expect(productRequests).toHaveLength(1);
    expect(productRequests[0]!.peerMessages).toEqual([{ role: "user", originalRole: "assistant", speakerBotId: seeded.budget.id }]);
    expect(productRequests[0]!.ownAssistantIds).toEqual([]);
    const budgetRequests = (await requestShapes()).filter((request) => request.executorId === seeded.budget.id);
    expect(budgetRequests.at(-1)!.ownAssistantIds).toEqual([seeded.budget.id]);
    expect(budgetRequests.at(-1)!.peerMessages).toEqual([]);
    expect((await requestShapes()).some((request) => request.toolNames.includes("select_room_owner"))).toBe(false);

    await openRoom(seeded.automatic.room.name);
    await page.getByLabel("群聊默认响应方式").selectOption("automatic");
    await send(page, "小团队的首月费用预算是开发六万元、获客三万元、运维两万元，但总预算只有十万元。请先用自己配置中的 Bot 名称说明负责的领域，再从财务预算和费用控制角度指出一个优先调整点及理由；只介绍你自己，简洁回答。");
    const automatic = await finish(seeded.automatic.room.id, 1, "automatic-selector", true);
    expect(automatic.batch).toMatchObject({ routingMode: "automatic", orchestrationEnabled: true, leadBotId: null });
    expect(automatic.batch.routingReason?.trim().length).toBeGreaterThan(0);
    expect(automatic.turns.filter((turn) => turn.origin === "initial").map((turn) => turn.agentId)).toEqual([seeded.budget.id]);
    assertReplyIdentity(automatic.state, seeded.budget.id);
    expect((await requestShapes()).filter((request) => request.toolNames.includes("select_room_owner"))).toHaveLength(1);
    await expect(page.locator("article.message-user").last()).toContainText("自动选择");
    await expect(page.locator("article.message-user").last().locator(".message-route-chip")).toHaveText(["@预算顾问"]);

    await openRoom(seeded.fixed.room.name);
    await page.getByLabel("群聊默认响应方式").selectOption("automatic");
    await send(page, "你好，请用你配置中的 Bot 名称和负责的领域简短介绍你自己，不介绍其他成员。");
    const greeting = await finish(seeded.fixed.room.id, 3, "lead-greeting");
    expect(greeting.batch).toMatchObject({ routingMode: "automatic", orchestrationEnabled: true, leadBotId: seeded.product.id });
    expect(greeting.turns.map((turn) => [turn.agentId, turn.turnPurpose])).toEqual([[seeded.product.id, "coordinate"]]);
    assertReplyIdentity(greeting.state, seeded.product.id);
    expect((await requestShapes()).filter((request) => request.toolNames.includes("select_room_owner"))).toHaveLength(1);
    expect(consoleErrors).toEqual([]);
    await testInfo.attach("console-health.json", { body: Buffer.from(JSON.stringify({ errors: consoleErrors, warnings: consoleWarnings }, null, 2)), contentType: "application/json" });
    await testInfo.attach("real-model-request-shapes.json", { body: Buffer.from(JSON.stringify(await requestShapes(), null, 2)), contentType: "application/json" });
  } finally {
    await testInfo.attach("routing-execution-evidence.json", { body: Buffer.from(JSON.stringify(evidence, null, 2)), contentType: "application/json" });
    await app.close();
    removeTestDirectory(directory);
  }
});
