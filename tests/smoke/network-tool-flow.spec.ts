import { removeTestDirectory } from "./test-cleanup";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { AppRepository } from "../../src/main/database";

test("approves, executes, restores, and audits one read-only real-time tool without storing its result body", async () => {
  test.setTimeout(30_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-network-tool-e2e-"));
  const databasePath = join(userDataDir, "aevoren-bot.sqlite");
  const repository = new AppRepository(databasePath);
  repository.createBot();
  repository.close();
  const environment = {
    ...process.env,
    AEVOREN_BOT_USER_DATA_DIR: userDataDir,
    AEVOREN_BOT_FAKE_PROVIDER: "1",
    AEVOREN_BOT_FAKE_NETWORK_TOOL: "time",
    AEVOREN_BOT_FAKE_NETWORK_QUERY: "Asia/Shanghai",
    AEVOREN_BOT_TEST_HIDDEN: "1",
  };
  let application: ElectronApplication | undefined;
  const consoleErrors: string[] = [];
  try {
    application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment });
    let page = await application.firstWindow();
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    await page.getByLabel("消息").fill("现在几点");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const tool = page.getByTestId("workspace-tool-activity").last();
    const traceHeader = tool.locator(".expandable-trace-header");
    const traceBody = tool.locator(".expandable-trace-collapse");
    await expect(tool).toHaveAttribute("data-trace-kind", "search");
    await expect(traceHeader).toHaveAttribute("aria-expanded", "true");
    await expect(traceBody).toBeVisible();
    await expect(tool).toContainText("查询当前时间");
    await expect(tool).toContainText("Asia/Shanghai");
    await expect(tool.getByLabel("系统信息确认")).toContainText("不会访问外部网络");
    await tool.getByRole("button", { name: "仅允许一次" }).click();
    await expect(tool).toContainText("执行完成");
    await expect(traceHeader).toHaveAttribute("aria-expanded", "false");
    await expect(traceBody).toBeHidden();
    await traceHeader.click();
    await expect(traceHeader).toHaveAttribute("aria-expanded", "true");
    await expect(traceBody).toBeVisible();
    await expect(page.getByText(/system-clock/).last()).toBeVisible();
    await expect(page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(1);

    await application.close();
    application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment });
    page = await application.firstWindow();
    await expect(page.getByTestId("workspace-tool-activity")).toHaveCount(1);
    await expect(page.getByTestId("workspace-tool-activity")).toContainText("执行完成");
    await application.close();
    application = undefined;

    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT tool_kind,effect_class,workspace_id,target_path,state,attempt_count FROM tool_invocations").get()).toEqual({
      tool_kind: "time-now",
      effect_class: "pure",
      workspace_id: null,
      target_path: "Asia/Shanghai",
      state: "succeeded",
      attempt_count: 1,
    });
    const row = database.prepare("SELECT arguments_json,result_metadata_json,result_digest FROM tool_invocations").get() as Record<string, unknown>;
    expect(row.result_digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(row)).not.toContain("localDateTime");
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
    expect(consoleErrors).toEqual([]);
  } finally {
    if (application) application.process().kill("SIGKILL");
    removeTestDirectory(userDataDir);
  }
});
