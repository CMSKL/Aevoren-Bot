import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { AppRepository } from "../../src/main/database";
import type { AevorenBotApi } from "@shared/contracts";
import { removeTestDirectory } from "./test-cleanup";

test("reviews, edits, accepts, and rejects background Memory candidates", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-memory-proposals-"));
  const environment = { ...process.env, AEVOREN_BOT_USER_DATA_DIR: userDataDir, AEVOREN_BOT_FAKE_PROVIDER: "1" };
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment });
    const page = await application.firstWindow();
    const seeded = await page.evaluate(async () => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const created = await api.bots.create();
      if (!created.ok) throw new Error(created.error.safeMessage);
      const nonce = crypto.randomUUID();
      const sent = await api.messages.send({ sessionId: created.data.session.id, clientNonce: nonce, text: "以后所有回答先给结论。" });
      if (!sent.ok) throw new Error(sent.error.safeMessage);
      return { botId: created.data.bot.id, sessionId: created.data.session.id };
    });
    await expect.poll(async () => page.evaluate(async (sessionId) => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const entries = await api.transcript.list(sessionId);
      return entries.ok ? entries.data.some((entry) => entry.role === "assistant" && entry.status === "completed") : false;
    }, seeded.sessionId)).toBe(true);
    await application.close();
    application = undefined;

    const repository = new AppRepository(join(userDataDir, "aevoren-bot.sqlite"));
    const source = repository.listTranscript(seeded.sessionId).find((entry) => entry.role === "user")!;
    repository.createMemoryProposal({
      botId: seeded.botId,
      scope: "user",
      scopeKey: "user",
      kind: "preference",
      content: "用户偏好所有回答先给结论。",
      reason: "用户明确表达了长期回答偏好。",
      sourceEntryId: source.id,
    });
    repository.createMemoryProposal({
      botId: seeded.botId,
      scope: "bot",
      scopeKey: seeded.botId,
      kind: "fact",
      content: "不应保留的候选。",
      reason: "用于验证拒绝。",
      sourceEntryId: source.id,
    });
    repository.close();

    application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment });
    const reviewPage = await application.firstWindow();
    const consoleErrors: string[] = [];
    reviewPage.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    await reviewPage.getByRole("button", { name: "设置", exact: true }).click();
    await reviewPage.getByRole("button", { name: "长期记忆", exact: true }).click();
    await expect(reviewPage.getByRole("region", { name: "待确认 Memory" })).toBeVisible();
    const userCandidate = reviewPage.locator(".memory-proposal").filter({ hasText: "长期回答偏好" });
    await userCandidate.locator('textarea[aria-label^="Memory 候选 "]').fill("用户偏好先看结论，再看简短依据。");
    await userCandidate.getByRole("button", { name: "批准" }).click();
    await expect(reviewPage.getByLabel(/Memory [0-9a-f-]{36}/u).last()).toHaveValue("用户偏好先看结论，再看简短依据。");

    const rejected = reviewPage.locator(".memory-proposal").filter({ hasText: "用于验证拒绝" });
    await rejected.getByRole("button", { name: "拒绝" }).click();
    await expect(reviewPage.getByRole("region", { name: "待确认 Memory" })).toHaveCount(0);
    expect(consoleErrors).toEqual([]);
    await application.close();
    application = undefined;

    const database = new DatabaseSync(join(userDataDir, "aevoren-bot.sqlite"), { readOnly: true });
    expect(database.prepare("SELECT content,kind,source FROM memory_items WHERE deleted_at IS NULL").all()).toEqual([{
      content: "用户偏好先看结论，再看简短依据。",
      kind: "preference",
      source: "model-captured",
    }]);
    expect(database.prepare("SELECT state,COUNT(*) AS count FROM memory_proposals GROUP BY state ORDER BY state").all()).toEqual([
      { state: "accepted", count: 1 },
      { state: "rejected", count: 1 },
    ]);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  } finally {
    if (application) application.process().kill("SIGKILL");
    removeTestDirectory(userDataDir);
  }
});
