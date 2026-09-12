import { _electron as electron, expect, test, type Page } from "@playwright/test";
import type { MsBotApi } from "@shared/contracts";

const isolatedUserData = process.env.MS_BOT_REAL_PROVIDER_USER_DATA_DIR;
const isolatedDatabase = process.env.MS_BOT_REAL_PROVIDER_DB_PATH;

async function createNamedBot(page: Page, name: string): Promise<void> {
  const before = await page.locator(".bot-row").count();
  await page.getByRole("button", { name: "新建聊天" }).click();
  await page.getByRole("button", { name: "创建新 Bot" }).click();
  await expect(page.locator(".bot-row")).toHaveCount(before + 1);
  await page.getByLabel("名称").fill(name);
  await page.getByLabel("名称").blur();
  await expect(page.getByTestId("profile-save-status")).toContainText("已保存");
}

test("completes three two-member Room batches with the configured real Provider", async () => {
  test.skip(
    !isolatedDatabase && !isolatedUserData,
    "requires an isolated database with the default safeStorage context, or isolated userData with a newly entered Key",
  );
  test.setTimeout(300_000);
  expect(
    !(isolatedDatabase && isolatedUserData),
    "set only one of MS_BOT_REAL_PROVIDER_DB_PATH or MS_BOT_REAL_PROVIDER_USER_DATA_DIR",
  ).toBe(true);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] =>
      entry[1] !== undefined && ![
        "MS_BOT_FAKE_PROVIDER",
        "MS_BOT_DB_PATH",
        "MS_BOT_USER_DATA_DIR",
      ].includes(entry[0]),
    ),
  );
  environment.MS_BOT_USE_SYSTEM_SAFE_STORAGE = "1";
  if (isolatedDatabase) environment.MS_BOT_DB_PATH = isolatedDatabase;
  else environment.MS_BOT_USER_DATA_DIR = isolatedUserData!;
  const application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment });
  try {
    const page = await application.firstWindow();
    const configured = await page.evaluate(async () => {
      const result = await (window as unknown as { msBot: MsBotApi }).msBot.settings.getModelConfiguration();
      return result.ok && result.data.apiKeyConfigured && Boolean(result.data.modelId);
    });
    expect(configured).toBe(true);
    const connection = await page.evaluate(() =>
      (window as unknown as { msBot: MsBotApi }).msBot.settings.testModelConnection(),
    );
    expect(connection.ok, connection.ok ? undefined : connection.error.code).toBe(true);
    await expect(page.locator(".bot-row").first()).toBeVisible();

    const suffix = Date.now().toString(36);
    const first = `真实验收甲-${suffix}`;
    const second = `真实验收乙-${suffix}`;
    await createNamedBot(page, first);
    await createNamedBot(page, second);
    await page.getByRole("button", { name: "新建聊天" }).click();
    await page.locator(".recipient-option").filter({ hasText: "创建群聊" }).click();
    await page.getByRole("button", { name: first, exact: true }).click();
    await page.getByRole("button", { name: second, exact: true }).click();
    await page.locator(".recipient-footer").getByRole("button", { name: "创建群聊", exact: true }).click();
    await expect(page.getByRole("heading", { name: `${first}、${second}` })).toBeVisible();

    for (let batch = 1; batch <= 3; batch += 1) {
      const before = await page.locator('article.message-assistant[data-status="completed"]').count();
      await page.getByLabel("消息").fill(`真实模型 Room 验收第 ${batch} 批。请用一句话确认收到。`);
      await page.getByRole("button", { name: "发送", exact: true }).click();
      await expect(page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(before + 2, { timeout: 90_000 });
      await expect(page.getByTestId("room-batch-state")).toContainText("completed");
    }
  } finally {
    await application.close();
  }
});
