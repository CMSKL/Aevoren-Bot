import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test } from "@playwright/test";
import type { AevorenBotApi } from "@shared/contracts";

test("creates, persists and restores a reliable fake-provider conversation", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-smoke-"));
  const environment = {
    ...process.env,
    AEVOREN_BOT_USER_DATA_DIR: userDataDir,
    AEVOREN_BOT_FAKE_PROVIDER: "1",
  };

  let application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment });
  let page = await application.firstWindow();

  await expect(page.locator(".brand")).toHaveText("Aevoren Bot");
  await expect(page).toHaveTitle("Aevoren Bot");
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle())).toBe("Aevoren Bot");
  await expect(page.getByText("从创建第一个 Bot 开始")).toBeVisible();
  await page.getByRole("button", { name: "新建聊天" }).click();
  await page.getByRole("button", { name: "创建新 Bot" }).click();
  await expect(page.getByRole("heading", { name: "新建 Bot" })).toBeVisible();
  await expect(page.getByText("产品需求分析助手")).toHaveCount(0);

  await page.getByLabel("模型供应商").selectOption("openai-compatible.default");
  await expect(page.getByLabel("模型供应商")).toHaveValue("openai-compatible.default");
  await page.getByLabel("Bot 模型").fill("smoke-model");
  await page.getByLabel("Bot 模型").blur();
  await expect(page.getByTestId("profile-save-status")).toContainText("已保存");
  const capabilitySnapshot = await page.evaluate(async () => {
    const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
    const bots = await api.bots.list();
    if (!bots.ok || !bots.data[0]) return bots;
    return api.capabilities.getSnapshot({ botId: bots.data[0].id });
  });
  expect(capabilitySnapshot).toMatchObject({
    ok: true,
    data: {
      availableTools: expect.arrayContaining(["web_search", "time_now", "weather_current"]),
      capabilities: expect.arrayContaining([
        expect.objectContaining({ id: "network.search", availability: "available" }),
        expect.objectContaining({ id: "network.realtime-data", availability: "available" }),
      ]),
    },
  });

  const description = page.getByLabel("描述");
  await description.fill("把模糊想法整理成可评审的产品需求。");
  await description.blur();
  await expect(page.getByTestId("profile-save-status")).toContainText("已保存");

  await page.getByLabel("消息").fill("做一个帮助团队整理产品需求的桌面应用。");
  await page.getByRole("button", { name: "发送" }).click();
  const assistant = page.locator("article.message-assistant").first();
  await expect(assistant.locator("h2", { hasText: "背景" })).toBeVisible();
  await expect(assistant.locator("ol > li")).toHaveCount(2);
  await expect(assistant).not.toContainText("## 背景");
  await expect(page.getByText("待确认事项", { exact: true })).toBeVisible();
  await expect(page.locator("article.message-assistant")).toHaveAttribute("data-status", "completed");

  for (const [index, supplement] of ["补充目标用户和使用场景。", "补充验收标准和风险。"].entries()) {
    await page.getByLabel("消息").fill(supplement);
    await page.getByRole("button", { name: "发送" }).click();
    await expect(page.locator("article.message-assistant")).toHaveCount(index + 2);
    await expect(page.locator("article.message-assistant").last()).toHaveAttribute("data-status", "completed");
  }
  await expect.poll(() => page.locator(".transcript").evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeGreaterThan(0);
  await expect.poll(() => page.locator(".transcript").evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
  )).toBeLessThanOrEqual(2);
  await expect(page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).resolves.toBe("undefined");

  await page.screenshot({ path: "test-results/p0-a-main.png", fullPage: true });
  await description.fill("关闭应用前未移焦，也必须可靠保存。");
  await application.close();

  const database = new DatabaseSync(join(userDataDir, "aevoren-bot.sqlite"), { readOnly: true });
  expect(database.prepare("SELECT COUNT(*) AS count FROM provider_instances").get()).toEqual({ count: 12 });
  expect(database.prepare("SELECT provider_instance_id, model_id FROM bots LIMIT 1").get()).toEqual({
    provider_instance_id: "openai-compatible.default",
    model_id: "smoke-model",
  });
  expect(database.prepare("SELECT MIN(json_extract(prompt_manifest_json, '$.schemaVersion')) AS min_version, MAX(json_extract(prompt_manifest_json, '$.schemaVersion')) AS max_version FROM runtime_runs").get()).toEqual({
    min_version: 4,
    max_version: 4,
  });
  database.close();

  application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment });
  page = await application.firstWindow();
  await expect(page.getByRole("heading", { name: "新建 Bot" })).toBeVisible();
  await expect(page.getByText("做一个帮助团队整理产品需求的桌面应用。")).toBeVisible();
  await expect(page.getByText("待确认事项", { exact: true }).last()).toBeVisible();
  await expect(page.getByLabel("描述")).toHaveValue("关闭应用前未移焦，也必须可靠保存。");
  await expect(page.getByLabel("模型供应商")).toHaveValue("openai-compatible.default");
  await expect(page.getByLabel("Bot 模型")).toHaveValue("smoke-model");

  await application.close();
  rmSync(userDataDir, { recursive: true, force: true });
});
