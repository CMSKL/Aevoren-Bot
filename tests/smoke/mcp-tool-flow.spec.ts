import { removeTestDirectory } from "./test-cleanup";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { AppRepository } from "../../src/main/database";
import type { AevorenBotApi } from "@shared/contracts";

test("connects one disabled-by-default stdio MCP server, exposes only its read-only tool, and journals one approved call", async () => {
  test.setTimeout(30_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-mcp-tool-e2e-"));
  const databasePath = join(userDataDir, "aevoren-bot.sqlite");
  const repository = new AppRepository(databasePath);
  const created = repository.createBot();
  repository.updateBot(created.bot.id, created.bot.version, {
    modelSelection: { providerInstanceId: "openai-compatible.default", modelId: "fixture-model" },
  });
  const fixture = join(process.cwd(), "tests/fixtures/fake-mcp-server.mjs");
  const server = repository.createMcpServerConfig("fixture", "stdio", {
    command: process.execPath,
    args: [fixture],
    envKeys: [],
    trustedReadOnlyTools: [],
  });
  repository.setMcpServerEnabled(server.id, server.version, true);
  repository.close();
  const environment = {
    ...process.env,
    AEVOREN_BOT_USER_DATA_DIR: userDataDir,
    AEVOREN_BOT_FAKE_PROVIDER: "1",
    AEVOREN_BOT_FAKE_MCP_TOOL: "first",
    AEVOREN_BOT_TEST_HIDDEN: "1",
  };
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment });
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "MCP", exact: true }).click();
    let card = page.locator('[data-mcp-server="fixture"]');
    await expect(card).toContainText("0 个已信任只读工具");
    await expect(card).toContainText("1 个只读声明待审核");
    await card.getByRole("button", { name: "编辑" }).click();
    await page.getByRole("checkbox", { name: /lookup/u }).check();
    await page.getByRole("button", { name: "保存（默认关闭）" }).click();
    card = page.locator('[data-mcp-server="fixture"]');
    await expect(card).toContainText("未启用");
    await card.getByRole("button", { name: "启用" }).click();
    await expect(card).toContainText("1 个已信任只读工具");
    await page.getByRole("button", { name: "关闭设置" }).click();

    await page.getByLabel("消息").fill("调用只读 MCP 工具");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const activity = page.getByTestId("workspace-tool-activity").last();
    await expect(activity).toContainText("MCP");
    await expect(activity.getByLabel("联网查询确认")).toContainText("外部只读数据服务");
    await activity.getByRole("button", { name: "仅允许一次" }).click();
    await expect(activity).toContainText("执行完成");
    await expect(page.getByText(/MCP_FIXTURE_RESULT:smoke:anonymous/u).last()).toBeVisible();

    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "MCP", exact: true }).click();
    card = page.locator('[data-mcp-server="fixture"]');
    await expect(card).toContainText("可用");
    await expect(card).toContainText("1 个已信任只读工具");
    await expect(card).toContainText("1 个写/未声明工具已阻止");
    await page.getByRole("button", { name: "关闭设置" }).click();

    const snapshot = await page.evaluate(async () => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const bots = await api.bots.list();
      if (!bots.ok || !bots.data[0]) return bots;
      return api.capabilities.getSnapshot({ botId: bots.data[0].id });
    });
    expect(snapshot).toMatchObject({
      ok: true,
      data: {
        availableTools: expect.arrayContaining(["mcp__fixture__lookup"]),
        capabilities: expect.arrayContaining([expect.objectContaining({ id: "mcp.client", availability: "available" })]),
      },
    });
    await application.close();
    application = undefined;

    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT tool_kind,effect_class,workspace_id,state FROM tool_invocations").get()).toEqual({
      tool_kind: "mcp-call",
      effect_class: "read-remote",
      workspace_id: null,
      state: "succeeded",
    });
    expect(JSON.stringify(database.prepare("SELECT arguments_json,result_metadata_json FROM tool_invocations").all())).not.toContain("MCP_FIXTURE_RESULT");
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  } finally {
    if (application) application.process().kill("SIGKILL");
    removeTestDirectory(userDataDir);
  }
});
