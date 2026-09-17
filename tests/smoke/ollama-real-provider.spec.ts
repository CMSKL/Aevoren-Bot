import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test } from "@playwright/test";
import type { AevorenBotApi } from "@shared/contracts";

const runRealOllama = process.env.AEVOREN_BOT_OLLAMA_E2E === "1";

test("discovers and completes one message through the installed Ollama CLI", async () => {
  test.skip(!runRealOllama, "set AEVOREN_BOT_OLLAMA_E2E=1 to run the local Ollama acceptance test");
  test.setTimeout(180_000);

  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-ollama-real-"));
  const databasePath = join(userDataDir, "aevoren-bot.sqlite");
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] =>
      entry[1] !== undefined && ![
        "AEVOREN_BOT_FAKE_PROVIDER",
        "AEVOREN_BOT_DB_PATH",
        "AEVOREN_BOT_USER_DATA_DIR",
      ].includes(entry[0]),
    ),
  );
  environment.AEVOREN_BOT_USER_DATA_DIR = userDataDir;

  const application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment });
  try {
    const page = await application.firstWindow();
    const result = await page.evaluate(async () => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const scanned = await api.providers.scan();
      if (!scanned.ok) return { ok: false as const, reason: scanned.error.code };
      const ollama = scanned.data.find((provider) => provider.id === "ollama.default");
      if (!ollama || ollama.status !== "available") {
        return { ok: false as const, reason: ollama?.reason ?? "OLLAMA_NOT_DISCOVERED" };
      }
      const model = ollama.models.options.find((option) => option.id === "qwen3:0.6b");
      if (!model) return { ok: false as const, reason: "OLLAMA_MODEL_NOT_DISCOVERED" };
      const connection = await api.providers.test(ollama.id);
      if (!connection.ok) return { ok: false as const, reason: connection.error.code };

      const created = await api.bots.create();
      if (!created.ok) return { ok: false as const, reason: created.error.code };
      const updated = await api.bots.update({
        id: created.data.bot.id,
        expectedVersion: created.data.bot.version,
        patch: {
          name: "Ollama E2E",
          instructions: "只输出 OLLAMA_OK，不要输出思考过程、解释或其他字符。",
          modelSelection: { providerInstanceId: ollama.id, modelId: model.id },
        },
      });
      if (!updated.ok) return { ok: false as const, reason: updated.error.code };

      const nonce = crypto.randomUUID();
      const sent = await api.messages.send({
        sessionId: created.data.session.id,
        clientNonce: nonce,
        text: "按要求回答。",
      });
      if (!sent.ok) return { ok: false as const, reason: sent.error.code };
      return {
        ok: true as const,
        sessionId: created.data.session.id,
        provider: ollama,
      };
    });

    expect(result.ok, result.ok ? undefined : result.reason).toBe(true);
    if (!result.ok) return;
    expect(result.provider.runtimeVersion).toBeTruthy();
    expect(result.provider.models.options.some((model) => model.id === "qwen3:0.6b")).toBe(true);

    await expect.poll(async () => page.evaluate(async (sessionId) => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const transcript = await api.transcript.list(sessionId);
      if (!transcript.ok) return null;
      const assistant = transcript.data.find((entry) => entry.role === "assistant");
      return assistant ? { status: assistant.status, body: assistant.body.trim() } : null;
    }, result.sessionId), { timeout: 120_000 }).toEqual({ status: "completed", body: "OLLAMA_OK" });
  } finally {
    await application.close();
  }

  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    expect(database.prepare("SELECT COUNT(*) AS count FROM runtime_runs WHERE state <> 'completed'").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM transcript_entries WHERE role = 'assistant' AND status = 'completed'").get()).toEqual({ count: 1 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    database.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
