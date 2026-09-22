import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { removeTestDirectory } from "./test-cleanup";
import { AppRepository } from "../../src/main/database";
import type { AevorenBotApi } from "../../src/shared/contracts";

test("shows Save as Markdown and exports the completed real transcript body", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-artifact-smoke-data-"));
  const outputDirectory = mkdtempSync(join(tmpdir(), "aevoren-artifact-smoke-output-"));
  const outputPath = join(outputDirectory, "answer.md");
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
      AEVOREN_BOT_ARTIFACT_TEST_PATH: outputPath,
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
    const save = assistant.getByRole("button", { name: "保存为 Markdown", exact: true });
    await expect(save).toBeVisible();
    await save.click();
    await expect(page.getByText("Markdown 已保存。", { exact: true })).toBeVisible();
    const reveal = assistant.getByRole("button", { name: "打开所在位置", exact: true });
    await expect(reveal).toBeVisible();
    await reveal.click();
    expect(existsSync(outputPath)).toBe(true);
    expect(readFileSync(outputPath, "utf8").trim()).toBe(body.trim());
  } finally {
    await application.close();
    removeTestDirectory(userDataDir);
    removeTestDirectory(outputDirectory);
  }
});
