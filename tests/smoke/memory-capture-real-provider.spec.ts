import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test } from "@playwright/test";
import { AppRepository } from "../../src/main/database";
import type { AevorenBotApi } from "@shared/contracts";

const isolatedDatabase = process.env.AEVOREN_BOT_REAL_PROVIDER_DB_PATH;

test("creates a reviewed Memory candidate after one real Provider turn", async () => {
  test.skip(!isolatedDatabase, "requires an isolated configured database snapshot");
  test.setTimeout(240_000);
  const repository = new AppRepository(isolatedDatabase!);
  const created = repository.createBot();
  const bot = repository.updateBot(created.bot.id, created.bot.version, {
    name: `Memory Capture ${Date.now().toString(36)}`,
    instructions: "正常回答用户，不调用工具。不要在正文中讨论内部 Memory 捕获机制。",
  });
  repository.close();

  const userData = join(dirname(isolatedDatabase!), "memory-capture-user-data");
  mkdirSync(userData, { recursive: true });
  const environment = Object.fromEntries(Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && ![
      "AEVOREN_BOT_FAKE_PROVIDER", "AEVOREN_BOT_DB_PATH", "AEVOREN_BOT_USER_DATA_DIR",
    ].includes(entry[0]),
  ));
  environment.AEVOREN_BOT_USE_SYSTEM_SAFE_STORAGE = "1";
  environment.AEVOREN_BOT_DB_PATH = isolatedDatabase!;
  environment.AEVOREN_BOT_USER_DATA_DIR = userData;
  environment.AEVOREN_BOT_TEST_HIDDEN = "1";
  environment.AEVOREN_BOT_MEMORY_CAPTURE_DEBUG = "1";

  const application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment });
  try {
    const page = await application.firstWindow();
    const consoleErrors: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    const result = await page.evaluate(async ({ botId, sessionId }) => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const nonce = crypto.randomUUID();
      const sent = await api.messages.send({
        sessionId,
        clientNonce: nonce,
        text: "请记住：以后所有对话都先给结论，再用最多三点说明依据。这是我的长期回答偏好。",
      });
      return { sent, botId };
    }, { botId: bot.id, sessionId: created.session.id });
    expect(result.sent.ok).toBe(true);

    const readCaptureStatus = (): Record<string, unknown> | null => {
      const statusDatabase = new DatabaseSync(isolatedDatabase!, { readOnly: true });
      try {
        const row = statusDatabase.prepare("SELECT value FROM app_settings WHERE key = 'memory.capture.lastStatus'").get() as { value: string } | undefined;
        return row ? JSON.parse(row.value) : null;
      } finally {
        statusDatabase.close();
      }
    };
    await expect.poll(() => readCaptureStatus()?.state ?? null, {
      timeout: 60_000,
      intervals: [500, 1_000, 2_000],
    }).toMatch(/completed|failed/u);
    expect(readCaptureStatus()).toMatchObject({
      botId: bot.id,
      state: "completed",
      errorCode: null,
      candidateCount: 1,
    });

    await expect.poll(async () => page.evaluate(async (botId) => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const proposals = await api.memories.listProposals({ botId, state: "pending" });
      return proposals.ok ? proposals.data : [];
    }, bot.id), { timeout: 180_000, intervals: [500, 1_000, 2_000] }).toEqual([
      expect.objectContaining({
        botId: bot.id,
        state: "pending",
        kind: "preference",
        content: expect.stringMatching(/结论/u),
      }),
    ]);
    const active = await page.evaluate(async (botId) => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      return api.memories.list({ botId });
    }, bot.id);
    expect(active).toMatchObject({ ok: true, data: [] });
    const accepted = await page.evaluate(async (botId) => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const proposals = await api.memories.listProposals({ botId, state: "pending" });
      if (!proposals.ok || proposals.data.length !== 1) return proposals;
      const proposal = proposals.data[0]!;
      return api.memories.acceptProposal({ id: proposal.id, expectedVersion: proposal.version });
    }, bot.id);
    expect(accepted).toMatchObject({ ok: true, data: { proposal: { state: "accepted" }, memory: { source: "model-captured" } } });

    const recalled = await page.evaluate(async (sessionId) => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      return api.messages.send({
        sessionId,
        clientNonce: crypto.randomUUID(),
        text: "请只复述你记得的我的长期回答偏好。",
      });
    }, created.session.id);
    expect(recalled.ok).toBe(true);
    await expect.poll(async () => page.evaluate(async (sessionId) => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const entries = await api.transcript.list(sessionId);
      if (!entries.ok) return "";
      const replies = entries.data.filter((entry) => entry.role === "assistant" && entry.status === "completed");
      return replies.length >= 2 ? replies.at(-1)?.body ?? "" : "";
    }, created.session.id), { timeout: 120_000, intervals: [500, 1_000, 2_000] }).toMatch(/结论/u);
    expect(consoleErrors).toEqual([]);
  } finally {
    await application.close();
  }

  const database = new DatabaseSync(isolatedDatabase!, { readOnly: true });
  try {
    expect(database.prepare("SELECT COUNT(*) AS count FROM runtime_runs WHERE session_id = ? AND state = 'completed'").get(created.session.id)).toEqual({ count: 2 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM memory_proposals WHERE bot_id = ? AND state = 'accepted'").get(bot.id)).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM memory_items WHERE source = 'model-captured' AND deleted_at IS NULL").get()).toEqual({ count: 1 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    database.close();
  }
});
