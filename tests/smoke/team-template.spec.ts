import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { removeTestDirectory } from "./test-cleanup";

test("creates and restores one complete content team without duplicate partial resources", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-team-template-"));
  const environment = { ...process.env, AEVOREN_BOT_USER_DATA_DIR: userDataDir, AEVOREN_BOT_FAKE_PROVIDER: "1" };
  let application: ElectronApplication | undefined = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment });
  try {
    let page = await application.firstWindow();
    const consoleErrors: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    await page.getByRole("button", { name: "新建聊天", exact: true }).click();
    await page.getByRole("button", { name: /一键创建内容团队/u }).click();
    await expect(page.getByRole("heading", { name: "自媒体内容团队", exact: true })).toBeVisible();
    for (const name of ["情报侦察员", "选题策划师", "内容主笔", "事实编辑", "数据复盘师"]) {
      await expect(page.locator(".bot-row").filter({ hasText: name })).toHaveCount(1);
    }
    await application.close();

    application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment });
    page = await application.firstWindow();
    await page.getByRole("button", { name: "新建聊天", exact: true }).click();
    await page.getByRole("button", { name: /一键创建内容团队/u }).click();
    await expect(page.getByRole("heading", { name: "自媒体内容团队", exact: true })).toBeVisible();
    expect(consoleErrors).toEqual([]);
    await application.close();
    application = undefined;

    const database = new DatabaseSync(join(userDataDir, "aevoren-bot.sqlite"), { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM bots WHERE deleted_at IS NULL").get()).toEqual({ count: 5 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM rooms").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM room_members").get()).toEqual({ count: 5 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  } finally {
    if (application) await application.close();
    removeTestDirectory(userDataDir);
  }
});
