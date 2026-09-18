import { removeTestDirectory } from "./test-cleanup";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test } from "@playwright/test";
import { AppRepository } from "../../src/main/database";

test("switches one Bot model from the compact header picker and preserves unavailable CLI feedback", async () => {
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
    const trigger = page.locator(".header-model-trigger");
    await expect(trigger).toContainText("model-alpha");
    await trigger.click();
    const picker = page.getByRole("dialog", { name: "选择模型" });
    await expect(picker).toBeVisible();
    await expect(picker.locator(".header-model-list > button")).toHaveCount(2);
    await expect(picker.locator('.header-model-list > button[aria-current="true"]')).toContainText("当前");
    await picker.locator(".header-model-list > button").filter({ hasText: "model-beta" }).click();
    await expect(trigger).toContainText("model-beta");

    await trigger.click();
    await picker.getByRole("button", { name: "Codex CLI" }).click();
    await expect(picker.locator(".header-model-unavailable strong")).toHaveText(/未安装|未登录|不可用/u);
    await expect(picker.getByText("测试环境未探测 Codex CLI。", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");

    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(390, 640));
    await trigger.click();
    await expect.poll(() => picker.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= window.innerWidth;
    })).toBe(true);
    await page.screenshot({ path: "/tmp/aevoren-header-model-picker-390.png" });
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
    await expect(page.locator(".header-model-trigger")).toContainText("model-beta");
  } finally {
    await application.close();
    removeTestDirectory(userDataDir);
  }
});
