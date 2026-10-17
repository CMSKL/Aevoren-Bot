import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test } from "@playwright/test";
import type { AevorenBotApi } from "../../src/shared/contracts";
import { removeTestDirectory } from "./test-cleanup";
import { openToolRecords } from "./tool-ui";
import { AppRepository } from "../../src/main/database";

test("remembers only explicit public-read consent and keeps execution out of the transcript", async () => {
  const data = mkdtempSync(join(tmpdir(), "aevoren-public-consent-"));
  const repository = new AppRepository(join(data, "aevoren-bot.sqlite"));
  repository.createBot();
  repository.close();
  const env = { ...process.env, AEVOREN_BOT_USER_DATA_DIR: data, AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_FAKE_PROVIDER: "1", AEVOREN_BOT_FAKE_NETWORK_TOOL: "time", AEVOREN_BOT_FAKE_NETWORK_QUERY: "Asia/Shanghai", AEVOREN_BOT_DISABLE_UPDATES: "1" };
  let app = await electron.launch({ args: ["."], cwd: process.cwd(), env });
  let closed = false;
  try {
    let page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const initial = await page.evaluate(() => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.settings.getGeneral());
    expect(initial.ok && initial.data.autoApprovePublicReadTools).toBe(false);
    await page.getByLabel("消息", { exact: true }).fill("现在几点");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const permission = page.getByTestId("tool-permission-dialog");
    await expect(permission).toBeVisible();
    await expect(permission).toContainText("文件、剪贴板、MCP 和外部写操作不包含在内");
    await expect(page.locator(".transcript .message-tools")).toHaveCount(0);
    await permission.getByRole("button", { name: "允许公开查询并记住", exact: true }).click();
    await expect(permission).toBeHidden();
    await expect(page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(1);
    await page.getByLabel("消息", { exact: true }).fill("再查询一次当前时间");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(2);
    await expect(permission).toBeHidden();
    await expect(page.locator(".transcript .message-tools")).toHaveCount(0);
    const shelf = await openToolRecords(page);
    await expect(shelf.getByTestId("tool-activity-run")).toContainText("已完成 2 个步骤");
    await expect(shelf.getByRole("button", { name: "仅允许一次" })).toHaveCount(0);
    await page.getByRole("button", { name: "关闭会话成果", exact: true }).last().click();

    await app.close();
    closed = true;
    app = await electron.launch({ args: ["."], cwd: process.cwd(), env });
    closed = false;
    page = await app.firstWindow();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(page.getByLabel("自动批准公开只读工具")).toBeChecked();
    await page.getByLabel("自动批准公开只读工具").click();
    await expect(page.getByLabel("自动批准公开只读工具")).not.toBeChecked();
    await page.getByRole("button", { name: "关闭设置", exact: true }).click();
    await page.getByLabel("消息", { exact: true }).fill("关闭自动授权后查询时间");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByTestId("tool-permission-dialog")).toBeVisible();
    await page.getByTestId("tool-permission-dialog").getByRole("button", { name: "仅允许一次", exact: true }).click();
    await expect(page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(3);
    const after = await page.evaluate(() => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.settings.getGeneral());
    expect(after.ok && after.data.autoApprovePublicReadTools).toBe(false);
    await app.close();
    closed = true;
    const db = new DatabaseSync(join(data, "aevoren-bot.sqlite"), { readOnly: true });
    try {
      expect(db.prepare("SELECT tool_kind,state,attempt_count FROM tool_invocations").all()).toEqual(Array.from({ length: 3 }, () => ({ tool_kind: "time-now", state: "succeeded", attempt_count: 1 })));
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.close(); }
    expect(errors).toEqual([]);
  } finally {
    if (!closed) await app.close();
    removeTestDirectory(data);
  }
});
