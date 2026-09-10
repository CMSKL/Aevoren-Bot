import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test } from "@playwright/test";

test("creates, persists and restores a reliable fake-provider conversation", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "ms-bot-smoke-"));
  const environment = {
    ...process.env,
    MS_BOT_USER_DATA_DIR: userDataDir,
    MS_BOT_FAKE_PROVIDER: "1",
  };

  let application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment });
  let page = await application.firstWindow();

  await expect(page.getByText("从创建第一个 Bot 开始")).toBeVisible();
  await page.getByRole("button", { name: "新建 Bot" }).click();
  await expect(page.getByRole("heading", { name: "产品需求分析助手" })).toBeVisible();

  await page.getByRole("button", { name: "模型设置" }).click();
  await page.getByLabel("Model ID").fill("smoke-model");
  await page.getByLabel("API Key").fill("smoke-key-not-a-real-secret");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("设置已保存。")).toBeVisible();
  await page.getByRole("button", { name: "关闭" }).click();

  const description = page.getByLabel("描述");
  await description.fill("把模糊想法整理成可评审的产品需求。");
  await description.blur();
  await expect(page.getByTestId("profile-save-status")).toContainText("已保存");

  await page.getByLabel("产品想法").fill("做一个帮助团队整理产品需求的桌面应用。");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText("待确认事项", { exact: true })).toBeVisible();
  await expect(page.locator("article.message-assistant")).toHaveAttribute("data-status", "completed");
  await expect(page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).resolves.toBe("undefined");

  await page.screenshot({ path: "test-results/p0-a-main.png", fullPage: true });
  await description.fill("关闭应用前未移焦，也必须可靠保存。");
  await application.close();

  const database = new DatabaseSync(join(userDataDir, "ms-bot.sqlite"), { readOnly: true });
  const storedKey = database.prepare("SELECT value, encrypted FROM app_settings WHERE key = 'model.apiKey'").get() as {
    value: string;
    encrypted: number;
  };
  expect(storedKey.encrypted).toBe(1);
  expect(storedKey.value).not.toContain("smoke-key-not-a-real-secret");
  database.close();

  application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment });
  page = await application.firstWindow();
  await expect(page.getByRole("heading", { name: "产品需求分析助手" })).toBeVisible();
  await expect(page.getByText("做一个帮助团队整理产品需求的桌面应用。")).toBeVisible();
  await expect(page.getByText("待确认事项", { exact: true })).toBeVisible();
  await expect(page.getByLabel("描述")).toHaveValue("关闭应用前未移焦，也必须可靠保存。");

  await application.close();
  rmSync(userDataDir, { recursive: true, force: true });
});
