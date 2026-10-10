import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { AevorenBotApi } from "../../src/shared/contracts";
import { AppRepository } from "../../src/main/database";
import { removeTestDirectory } from "./test-cleanup";
import { closeInspector, openBotList } from "./navigation";

test("creates Bots and Rooms from each project heading without leaking the active project", async () => {
  const data = mkdtempSync(join(tmpdir(), "aevoren-project-create-"));
  const repository = new AppRepository(join(data, "aevoren-bot.sqlite"));
  const first = repository.createProject("项目甲");
  const second = repository.createProject("项目乙");
  const original = repository.createBot(first.id);
  repository.updateBot(original.bot.id, original.bot.version, { name: "甲项目 Bot" });
  repository.setSetting("appearance.theme", "dark", false);
  repository.close();
  const application = await electron.launch({ args: ["."], cwd: process.cwd(), env: { ...process.env, AEVOREN_BOT_USER_DATA_DIR: data, AEVOREN_BOT_TEST_HIDDEN: "1" } });
  try {
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("tab", { name: "工作区", exact: true }).click();
    const group = page.locator('.sidebar-project').filter({ has: page.getByRole("button", { name: "项目乙", exact: true }) });
    await group.getByRole("button", { name: "在 项目乙 新建 Bot" }).click();
    await expect(group.locator(".bot-row")).toHaveCount(1);
    await expect(page.locator(".inspector")).toBeVisible();
    await closeInspector(page);
    await group.getByRole("button", { name: "在 项目乙 新建 Bot" }).click();
    await expect(group.locator(".bot-row")).toHaveCount(2);
    await expect(page.locator(".inspector")).toBeVisible();
    await closeInspector(page);
    await group.getByRole("button", { name: "在 项目乙 新建群聊" }).click();
    const chooser = page.getByRole("dialog", { name: "新建群聊" });
    await expect(chooser).toBeVisible();
    await expect(chooser).toContainText("甲项目 Bot");
    const options = chooser.locator(".recipient-options > button");
    await expect(options).toHaveCount(3);
    await options.nth(0).click();
    await options.nth(1).click();
    await chooser.getByRole("button", { name: "创建群聊", exact: true }).click();
    await expect(chooser).toBeHidden();
    await expect(group.locator(".bot-row")).toHaveCount(3);
    const snapshot = await page.evaluate(async () => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      return { bots: await api.bots.list(), rooms: await api.rooms.list() };
    });
    expect(snapshot.bots.ok && snapshot.rooms.ok).toBe(true);
    if (snapshot.bots.ok && snapshot.rooms.ok) {
      expect(snapshot.bots.data.filter((bot) => bot.projectId === second.id)).toHaveLength(2);
      expect(snapshot.rooms.data).toEqual([expect.objectContaining({ projectId: second.id })]);
    }
    for (const width of [1180, 1020, 620, 390]) {
      await application.evaluate(({ BrowserWindow }, next) => BrowserWindow.getAllWindows()[0]?.setSize(next, 844), width);
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
      await openBotList(page);
      await expect(group.getByRole("button", { name: "在 项目乙 新建 Bot" })).toBeVisible();
      await expect(group.getByRole("button", { name: "在 项目乙 新建群聊" })).toBeVisible();
      expect(await group.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.locator(".sidebar").screenshot({ path: `/tmp/aevoren-project-create-${width}.png` });
    }
    expect(errors).toEqual([]);
  } finally {
    await application.close();
    removeTestDirectory(data);
  }
});
