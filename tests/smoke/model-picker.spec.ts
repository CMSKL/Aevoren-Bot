import { removeTestDirectory } from "./test-cleanup";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test } from "@playwright/test";
import { AppRepository } from "../../src/main/database";
import { openModelPicker } from "./navigation";

test("switches one Bot model within Contacts and preserves unavailable CLI feedback", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-header-model-picker-"));
  const databasePath = join(userDataDir, "aevoren-bot.sqlite");
  const repository = new AppRepository(databasePath);
  const first = repository.createBot();
  const firstBot = repository.updateBot(first.bot.id, first.bot.version, {
    name: "Picker Bot",
    modelSelection: { providerInstanceId: "openai-compatible.default", modelId: "model-alpha" },
  });
  const second = repository.createBot();
  repository.updateBot(second.bot.id, second.bot.version, {
    name: "Catalog Bot",
    modelSelection: { providerInstanceId: "openai-compatible.default", modelId: "model-beta" },
  });
  repository.setSetting("provider.openai-compatible.default.apiKey", "encrypted-fixture", true);
  repository.close();

  const environment = {
    ...process.env,
    AEVOREN_BOT_USER_DATA_DIR: userDataDir,
    AEVOREN_BOT_FAKE_PROVIDER: "1",
  };
  let application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment });
  try {
    let page = await application.firstWindow();
    const consoleErrors: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    await expect(page.getByRole("heading", { name: "Picker Bot" })).toBeVisible();
    const picker = await openModelPicker(page);
    await expect(picker).toBeVisible();
    const providerOptions = picker.getByLabel("模型供应商", { exact: true }).locator("option");
    await expect(providerOptions).toHaveCount(3);
    expect((await providerOptions.allTextContents()).sort()).toEqual(["API", "Claude Code", "Codex CLI"].sort());
    await expect(picker.locator("datalist option")).toHaveCount(2);
    await expect(picker.getByLabel("Bot 模型", { exact: true })).toHaveValue("model-alpha");
    await picker.getByLabel("Bot 模型", { exact: true }).fill("model-beta");
    await picker.getByLabel("Bot 模型", { exact: true }).blur();
    await expect(page.getByTestId("profile-save-status")).toContainText("已保存");

    await picker.locator("summary").filter({ hasText: "本机连接设置" }).click();
    const codex = picker.locator(".provider-engine-card").filter({ hasText: "Codex CLI" });
    await codex.locator(".provider-engine-summary").click();
    await expect(codex.locator(".provider-discovery-details")).toContainText(/未安装|未登录|不可用/u);
    await expect(picker.getByText("测试环境未探测 Codex CLI。", { exact: true })).toBeVisible();

    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(390, 640));
    await expect.poll(() => picker.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= window.innerWidth;
    })).toBe(true);
    await page.screenshot({ path: "/tmp/aevoren-contact-model-picker-390.png" });
    expect(consoleErrors).toEqual([]);

    await application.close();
    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT provider_instance_id, model_id FROM bots WHERE id = ?").get(firstBot.id)).toEqual({
      provider_instance_id: "openai-compatible.default",
      model_id: "model-beta",
    });
    database.close();

    application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment });
    page = await application.firstWindow();
    const restored = await openModelPicker(page);
    await expect(restored.getByLabel("模型供应商", { exact: true })).toHaveValue("openai-compatible.default");
    await expect(restored.getByLabel("Bot 模型", { exact: true })).toHaveValue("model-beta");
  } finally {
    await application.close();
    removeTestDirectory(userDataDir);
  }
});
