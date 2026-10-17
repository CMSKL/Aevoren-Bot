import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { removeTestDirectory } from "./test-cleanup";
import { AppRepository } from "../../src/main/database";
import type { AevorenBotApi } from "../../src/shared/contracts";

test("keeps the completed transcript available without a per-reply Markdown export action", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-artifact-smoke-data-"));
  const repository = new AppRepository(join(userDataDir, "aevoren-bot.sqlite"));
  repository.createBot();
  repository.close();
  const application = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    env: {
      ...process.env,
      AEVOREN_BOT_USER_DATA_DIR: userDataDir,
      AEVOREN_BOT_FAKE_PROVIDER: "1",
      AEVOREN_BOT_TEST_HIDDEN: "1",
    },
  });
  try {
    const page = await application.firstWindow();
    await page.getByLabel("消息").fill("导出这条真实回复");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const assistant = page.locator('article.message-assistant[data-status="completed"]').last();
    await expect(assistant).toBeVisible();
    const body = await page.evaluate(async () => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const bots = await api.bots.list();
      if (!bots.ok || !bots.data[0]) throw new Error("missing bot");
      const session = await api.sessions.getMain(bots.data[0].id);
      if (!session.ok) throw new Error("missing session");
      const transcript = await api.transcript.list(session.data.id);
      if (!transcript.ok) throw new Error("missing transcript");
      return transcript.data.filter((entry) => entry.role === "assistant" && entry.status === "completed").at(-1)?.body ?? "";
    });
    expect(body).toContain("## 背景");
    await expect(assistant).toContainText("背景");
    await expect(assistant.getByRole("button", { name: "保存为 Markdown", exact: true })).toHaveCount(0);
  } finally {
    await application.close();
    removeTestDirectory(userDataDir);
  }
});
