import { removeTestDirectory } from "./test-cleanup";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { AppRepository } from "../../src/main/database";

test("routes one Codex CLI dynamic tool call through Aevoren approval and Tool Journal", async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-codex-tool-e2e-"));
  const databasePath = join(userDataDir, "aevoren-bot.sqlite");
  const repository = new AppRepository(databasePath);
  const codex = repository.getProviderInstanceConfig("codex.default");
  repository.updateProviderInstanceConfig(codex.id, codex.version, {
    ...codex.config,
    cliPath: join(process.cwd(), "tests/fixtures/fake-codex-cli.mjs"),
  });
  const created = repository.createBot();
  repository.updateBot(created.bot.id, created.bot.version, {
    modelSelection: { providerInstanceId: "codex.default", modelId: "fixture-model" },
  });
  repository.close();
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({
      args: ["."], cwd: process.cwd(),
      env: {
        ...process.env,
        AEVOREN_BOT_USER_DATA_DIR: userDataDir,
        AEVOREN_BOT_TEST_HIDDEN: "1",
        CODEX_HOME: join(userDataDir, "source-codex-home"),
        FAKE_CODEX_DYNAMIC_TOOL: "1",
      },
    });
    const page = await application.firstWindow();
    await page.getByLabel("消息").fill("请查询当前时间");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const activity = page.getByTestId("workspace-tool-activity").last();
    await expect(activity).toContainText("查询当前时间", { timeout: 30_000 });
    await activity.getByRole("button", { name: "仅允许一次" }).click();
    await expect(activity).toContainText("执行完成", { timeout: 30_000 });
    await expect(page.getByText("CLI used approved tool", { exact: true })).toBeVisible({ timeout: 30_000 });
    await application.close();
    application = undefined;

    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT route,state FROM runtime_runs ORDER BY created_at DESC LIMIT 1").get()).toEqual({ route: "codex-cli", state: "completed" });
    expect(database.prepare("SELECT tool_kind,effect_class,state,attempt_count FROM tool_invocations").get()).toEqual({
      tool_kind: "time-now", effect_class: "pure", state: "succeeded", attempt_count: 1,
    });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  } finally {
    if (application) application.process().kill("SIGKILL");
    removeTestDirectory(userDataDir);
  }
});
