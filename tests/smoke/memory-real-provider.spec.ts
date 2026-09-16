import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test } from "@playwright/test";
import { AppRepository } from "../../src/main/database";
import type { AevorenBotApi, PromptManifest } from "@shared/contracts";

const isolatedDatabase = process.env.AEVOREN_BOT_REAL_PROVIDER_DB_PATH;

test("uses one Bot-owned explicit Memory in one real Provider call", async () => {
  test.skip(
    !isolatedDatabase,
    "requires AEVOREN_BOT_REAL_PROVIDER_DB_PATH pointing to an isolated configured database snapshot",
  );
  test.setTimeout(180_000);

  const suffix = Date.now().toString(36);
  const botName = `Memory 真实验收-${suffix}`;
  const storedToken = `MEMORY-${suffix.toUpperCase()}`;
  const currentToken = `CURRENT-${suffix.toUpperCase()}`;
  const userMessage = `Memory 中的参考编号已经过期。本次消息把它更正为 ${currentToken}，请只回答更正后的编号。`;
  const repository = new AppRepository(isolatedDatabase!);
  let botId: string;
  let sessionId: string;
  let memoryId: string;
  try {
    const created = repository.createBot();
    botId = created.bot.id;
    sessionId = created.session.id;
    repository.updateBot(botId, created.bot.version, {
      name: botName,
      instructions:
        "回答验收问题时，从当前 Bot 的用户管理参考事实中读取参考编号，并且只输出该编号。不要调用工具，不要转交。",
    });
    memoryId = repository.createMemory(botId, `本次验收的旧参考编号是 ${storedToken}。`).id;
  } finally {
    repository.close();
  }

  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !["AEVOREN_BOT_FAKE_PROVIDER", "AEVOREN_BOT_DB_PATH", "AEVOREN_BOT_USER_DATA_DIR"].includes(entry[0]),
    ),
  );
  const testUserData = join(dirname(isolatedDatabase!), "electron-user-data");
  mkdirSync(testUserData, { recursive: true });
  environment.AEVOREN_BOT_USE_SYSTEM_SAFE_STORAGE = "1";
  environment.AEVOREN_BOT_DB_PATH = isolatedDatabase!;
  environment.AEVOREN_BOT_USER_DATA_DIR = testUserData;
  environment.AEVOREN_BOT_TEST_HIDDEN = "1";

  const application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment });
  try {
    const page = await application.firstWindow();
    const configured = await page.evaluate(async () => {
      const result = await (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.settings.getModelConfiguration();
      return result.ok && result.data.apiKeyConfigured && Boolean(result.data.modelId);
    });
    expect(configured).toBe(true);

    await page.locator(".bot-row").filter({ hasText: botName }).click();
    await expect(page.getByRole("heading", { name: botName })).toBeVisible();
    await page.getByLabel("消息").fill(userMessage);
    await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const assistant = page.locator('article.message-assistant[data-status="completed"]').last();
    await expect(assistant).toBeVisible({ timeout: 120_000 });
    await expect(assistant).toContainText(currentToken);
    await expect(assistant).not.toContainText(storedToken);
  } finally {
    await application.close();
  }

  const database = new DatabaseSync(isolatedDatabase!, { readOnly: true });
  try {
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM memory_items WHERE id = ? AND bot_id = ? AND deleted_at IS NULL").get(memoryId, botId),
    ).toEqual({ count: 1 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM runtime_runs WHERE session_id = ? AND state = 'completed'").get(sessionId),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM runtime_runs WHERE session_id = ? AND state IN ('created','dispatching','running','streaming','cancel-requested')",
        )
        .get(sessionId),
    ).toEqual({ count: 0 });

    const row = database
      .prepare("SELECT prompt_manifest_json FROM runtime_runs WHERE session_id = ?")
      .get(sessionId) as { prompt_manifest_json: string };
    const manifest = JSON.parse(row.prompt_manifest_json) as PromptManifest;
    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.blocks.map((block) => block.authority)).toEqual(["agent-profile", "memory", "user"]);
    expect(manifest.blocks.find((block) => block.authority === "memory")?.scope).toBe(`bot:${botId}:memory`);
    expect(row.prompt_manifest_json).not.toContain(storedToken);
    expect(row.prompt_manifest_json).not.toContain(currentToken);
    expect(row.prompt_manifest_json).not.toContain("本次验收的参考编号");
  } finally {
    database.close();
  }
});
