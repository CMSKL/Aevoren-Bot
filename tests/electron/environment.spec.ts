import { selectDetailsTab } from "../smoke/navigation";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { AevorenBotApi, ApiResult } from "../../src/shared/contracts";
import type { EnvironmentScope, Execution, ExecutionLogsPage } from "../../src/shared/environment-contracts";
import { AppRepository } from "../../src/main/database";
import { DockerDriver } from "../../src/main/docker-driver";
import { openInspector } from "../smoke/navigation";
import { removeTestDirectory } from "../smoke/test-cleanup";

type Fixture = { page: Page; application: ElectronApplication; bots: { id: string; name: string; sessionId: string }[]; room: { id: string; name: string; sessionId: string }; uploadBytes: Buffer; downloadPath: string; crashRestart(): Promise<void> };
function value<T>(result: ApiResult<T>): T { if (!result.ok) throw new Error(`${result.error.code}: ${result.error.safeMessage}`); return result.data; }
async function executionList(page: Page, scope: EnvironmentScope): Promise<Execution[]> {
  return value(await page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.execution.list(input), scope));
}
async function executionLogs(page: Page, scope: EnvironmentScope, id: string): Promise<ExecutionLogsPage> {
  return value(await page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.execution.logs(input), { ...scope, id }));
}

async function withEnvironment(callback: (fixture: Fixture) => Promise<void>): Promise<void> {
  const data = mkdtempSync(join(tmpdir(), "aevoren-electron-environment-"));
  const databasePath = join(data, "aevoren-bot.sqlite");
  const repository = new AppRepository(databasePath);
  const bots = ["环境验收成员 A", "环境验收成员 B"].map(name => {
    const created = repository.createBot();
    const bot = repository.updateBot(created.bot.id, created.bot.version, { name });
    return { id: bot.id, name: bot.name, sessionId: created.session.id };
  });
  const room = repository.createRoom({ memberBotIds: bots.map(bot => bot.id), name: "执行环境验收群", leadBotId: null });
  repository.setSetting("memory.capture.enabled", "false", false);
  repository.close();
  const uploadPath = join(data, "actual-upload.bin");
  const downloadPath = join(data, "actual-downloaded.bin");
  const uploadBytes = Buffer.from([0, 255, 137, 80, 78, 71, 13, 10, 99]);
  writeFileSync(uploadPath, uploadBytes);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name, content]) => content !== undefined && !name.startsWith("AEVOREN_BOT_")));
  const errors: string[] = [];
  let application: ElectronApplication | undefined;
  const executablePath = process.env.AEVOREN_PACKAGED_APP_PATH;
  const launch = async (): Promise<{ application: ElectronApplication; page: Page }> => {
    const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : ["."], cwd: process.cwd(), env: { ...environment, AEVOREN_BOT_USER_DATA_DIR: data, AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_FAKE_PROVIDER: "1", AEVOREN_BOT_DISABLE_UPDATES: "1", AEVOREN_BOT_ENVIRONMENT_UPLOAD_TEST_PATH: uploadPath, AEVOREN_BOT_ENVIRONMENT_DOWNLOAD_TEST_PATH: downloadPath } });
    if (executablePath) {
      const packaged = await app.evaluate(({ app }) => ({ isPackaged: app.isPackaged, version: app.getVersion(), resourcesPath: process.resourcesPath }));
      const context = join(packaged.resourcesPath, "environment-worker");
      expect(packaged.isPackaged).toBe(true);
      expect(packaged.version).toBe(JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version);
      expect(context).not.toBe(join(process.cwd(), "out", "worker"));
      expect(readdirSync(context).toSorted()).toEqual(["Dockerfile", "file-helper.mjs", "index.mjs", "package.json"]);
      expect(existsSync(join(packaged.resourcesPath, "docs", "EXECUTION_ENVIRONMENT.md"))).toBe(true);
    }
    const page = await app.firstWindow();
    page.on("pageerror", error => errors.push(error.message));
    await expect(page.locator(".app-shell")).toBeVisible();
    await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { aevorenBot?: AevorenBotApi }).aevorenBot?.environments))).toBe(true);
    return { application: app, page };
  };
  try {
    const initial = await launch(); application = initial.application; const page = initial.page;
    const initialized = value(await page.evaluate(() => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.environments.initialize()));
    expect(initialized.probe.available).toBe(true);
    expect(initialized.probe.workerImagePresent).toBe(true);
    expect(initialized.imageDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    const fixture: Fixture = { page, application, bots, room: { id: room.room.id, name: room.room.name, sessionId: room.session.id }, uploadBytes, downloadPath,
      async crashRestart() {
        const child = application!.process();
        const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
        child.kill("SIGKILL"); await exited;
        const restarted = await launch(); application = restarted.application; fixture.application = restarted.application; fixture.page = restarted.page;
      } };
    await callback(fixture);
    expect(errors).toEqual([]);
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible()))).toBe(false);
  } finally {
    if (application) {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([application.close(), new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error("fixture close timed out")), 15_000); })]);
      } catch { application.process().kill("SIGKILL"); }
      finally { if (deadline) clearTimeout(deadline); }
    }
    const cleanup = new AppRepository(databasePath);
    const ownedIds = cleanup.environments.listInternal().map(environment => environment.id);
    cleanup.close();
    const docker = new DockerDriver();
    await docker.probe();
    for (const id of ownedIds) {
      // These IDs come only from this fixture's private database. Never sweep Docker resources globally.
      await docker.stop(id);
      await docker.remove(id);
      const context = Reflect.get(docker, "context") as string;
      const cliEnvironment = { ...process.env };
      delete cliEnvironment.DOCKER_HOST; delete cliEnvironment.DOCKER_CONTEXT;
      execFileSync("docker", ["--context", context, "volume", "rm", `aevoren-work-${id}`, `aevoren-state-${id}`], { env: cliEnvironment, stdio: "pipe" });
    }
    removeTestDirectory(data);
  }
}

test.describe("actual Linux Docker through hidden Electron", () => {
  test.skip(process.env.AEVOREN_DOCKER_INTEGRATION !== "1", "Requires explicit opt-in and an actual local Linux Docker engine; no simulated worker is substituted.");

  test("executes Node/Python, saves/uploads/downloads real files and cancels only its selected foreground task", async () => {
    await withEnvironment(async f => {
      const bot = f.bots[0]!;
      const scope = { sessionId: bot.sessionId, executorBotId: bot.id };
      await f.page.getByRole("listitem", { name: bot.name, exact: true }).click();
      await openInspector(f.page);
      const contact = f.page.getByRole("main", { name: "联系人资料", exact: true });
      await selectDetailsTab(contact, "执行环境");
      const panel = contact.getByRole("region", { name: "执行环境", exact: true });
      await expect(panel.getByRole("button", { name: "启动环境", exact: true })).toBeEnabled();
      await panel.getByRole("button", { name: "启动环境", exact: true }).click();
      await expect(panel.getByRole("status").first()).toHaveText("运行中", { timeout: 30_000 });
      const command = `node -e 'console.log("NODE_UI_ACTUAL_42=" + (6 * 7))'; python3 -c 'print("PYTHON_UI_ACTUAL_42=" + str(6 * 7))'`;
      await panel.getByLabel("执行命令", { exact: true }).fill(command);
      await panel.getByRole("button", { name: "运行命令", exact: true }).click();
      await expect.poll(async () => (await executionList(f.page, scope)).find(task => task.command === command)?.state, { timeout: 20_000 }).toBe("completed");
      await expect(panel.getByRole("log")).toContainText("NODE_UI_ACTUAL_42=42");
      await expect(panel.getByRole("log")).toContainText("PYTHON_UI_ACTUAL_42=42");
      const completed = (await executionList(f.page, scope)).find(task => task.command === command)!;
      expect(completed.exitCode).toBe(0);
      expect((await executionLogs(f.page, scope, completed.id)).logs.map(log => log.text).join("")).toContain("PYTHON_UI_ACTUAL_42=42");

      await panel.getByLabel("环境文件路径", { exact: true }).fill("saved-by-ui.md");
      await panel.getByLabel("环境文件内容", { exact: true }).fill("Actual environment text\n");
      await panel.getByRole("button", { name: "保存文本文件", exact: true }).click();
      await expect(panel.getByRole("status")).toContainText(["运行中", "已保存 saved-by-ui.md"]);
      const saved = value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.execution.readFile(input), { ...scope, path: "saved-by-ui.md" }));
      expect(saved.content).toBe("Actual environment text\n");
      await panel.getByRole("button", { name: "上传文件", exact: true }).click();
      await expect(panel.getByRole("status")).toContainText(["运行中", "已上传 1 个文件"]);
      const uploaded = value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.execution.readFile(input), { ...scope, path: "actual-upload.bin" }));
      expect(Buffer.from(uploaded.content, uploaded.encoding === "base64" ? "base64" : "utf8")).toEqual(f.uploadBytes);
      await panel.getByLabel("环境文件路径", { exact: true }).fill("actual-upload.bin");
      await panel.getByRole("button", { name: "下载文件", exact: true }).click();
      await expect(panel.getByRole("status")).toContainText(["运行中", "已下载 actual-upload.bin"]);
      expect(readFileSync(f.downloadPath)).toEqual(f.uploadBytes);

      const forever = `node -e 'console.log("ENV_UI_CANCEL_STARTED"); setInterval(() => {}, 1000)'`;
      await panel.getByLabel("执行命令", { exact: true }).fill(forever);
      await panel.getByRole("button", { name: "运行命令", exact: true }).click();
      await expect(panel.getByRole("log")).toContainText("ENV_UI_CANCEL_STARTED");
      await panel.getByRole("button", { name: "停止此任务", exact: true }).click();
      await expect.poll(async () => (await executionList(f.page, scope)).find(task => task.command === forever)?.state).toBe("cancelled");
      expect((await executionList(f.page, scope)).find(task => task.id === completed.id)?.state).toBe("completed");
      const other = f.bots[1]!;
      expect(value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.environments.get(input), { sessionId: other.sessionId, executorBotId: other.id }))).toBeNull();
    });
  });

  test("keeps group member drafts and environments isolated while a real background service remains live and registers its port", async () => {
    await withEnvironment(async f => {
      const first = f.bots[0]!;
      const second = f.bots[1]!;
      const secondScope = { sessionId: f.room.sessionId, executorBotId: second.id };
      await f.page.getByRole("listitem", { name: f.room.name, exact: true }).click();
      await openInspector(f.page);
      const dialog = f.page.getByRole("dialog", { name: "群聊设置", exact: true });
      await selectDetailsTab(dialog, "执行环境");
      const member = dialog.getByLabel("执行环境成员", { exact: true });
      const panel = dialog.getByRole("region", { name: "执行环境", exact: true });
      const firstDraft = "printf 'GROUP_A_DRAFT_PRESERVED\\n'";
      const secondDraft = "printf 'GROUP_B_DRAFT_PRESERVED\\n'";
      await member.selectOption(first.id);
      await panel.getByLabel("执行命令", { exact: true }).fill(firstDraft);
      await member.selectOption(second.id);
      await expect(panel.getByLabel("执行命令", { exact: true })).toHaveValue("");
      await panel.getByLabel("执行命令", { exact: true }).fill(secondDraft);
      await member.selectOption(first.id);
      await expect(panel.getByLabel("执行命令", { exact: true })).toHaveValue(firstDraft);
      await member.selectOption(second.id);
      await expect(panel.getByLabel("执行命令", { exact: true })).toHaveValue(secondDraft);
      await expect(panel.getByRole("button", { name: "启动环境", exact: true })).toBeEnabled();
      await panel.getByRole("button", { name: "启动环境", exact: true }).click();
      await expect(panel.getByRole("button", { name: "运行命令", exact: true })).toBeEnabled({ timeout: 30_000 });
      const command = "python3 -u -m http.server 8128 --bind 0.0.0.0";
      await panel.getByLabel("执行命令", { exact: true }).fill(command);
      await panel.getByRole("button", { name: "后台运行", exact: true }).click();
      await expect(panel.getByRole("log")).toContainText("Serving HTTP", { timeout: 20_000 });
      const background = value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.processes.list(input), secondScope));
      expect(background).toHaveLength(1);
      expect(background[0]?.state).toBe("running");
      await panel.getByLabel("端口所属进程", { exact: true }).selectOption(background[0]!.id);
      await panel.getByLabel("环境服务端口", { exact: true }).fill("8128");
      await panel.getByLabel("环境服务名称", { exact: true }).fill("实际 Python 服务");
      await panel.getByRole("button", { name: "登记端口", exact: true }).click();
      await expect(panel.locator(".environment-port-list")).toContainText("实际 Python 服务 · 8128 · 正在监听");
      expect(value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.processes.listPorts(input), secondScope))[0]?.state).toBe("listening");
      await expect(panel.locator(".environment-port-list a")).toHaveCount(0);
      await member.selectOption(first.id);
      await expect(panel.getByLabel("执行命令", { exact: true })).toHaveValue(firstDraft);
      expect(value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.processes.list(input), secondScope))[0]?.state).toBe("running");
      expect(value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.environments.get(input), { sessionId: f.room.sessionId, executorBotId: first.id }))).toBeNull();
      expect(value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.environments.get(input), { sessionId: second.sessionId, executorBotId: second.id }))).toBeNull();
      await member.selectOption(second.id);
      await expect(panel.getByLabel("执行命令", { exact: true })).toHaveValue(command);
      expect(value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.processes.list(input), secondScope))).toHaveLength(1);
      await panel.getByRole("button", { name: "停止后台进程", exact: true }).click();
      await expect.poll(async () => value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.processes.list(input), secondScope))[0]?.state).toBe("cancelled");
      await expect.poll(async () => value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.processes.listPorts(input), secondScope))[0]?.state).toBe("stopped");
    });
  });

  test("recovers a real foreground after app crash while its registered background service stays live and no command is replayed", async () => {
    await withEnvironment(async f => {
      const bot = f.bots[0]!;
      const scope = { sessionId: bot.sessionId, executorBotId: bot.id };
      await f.page.getByRole("listitem", { name: bot.name, exact: true }).click();
      await openInspector(f.page);
      const contact = (): ReturnType<Page["getByRole"]> => f.page.getByRole("main", { name: "联系人资料", exact: true });
      await selectDetailsTab(contact(), "执行环境");
      const panel = (): ReturnType<Page["getByRole"]> => contact().getByRole("region", { name: "执行环境", exact: true });
      await expect(panel().getByRole("button", { name: "启动环境", exact: true })).toBeEnabled();
      await panel().getByRole("button", { name: "启动环境", exact: true }).click();
      await expect(panel().getByRole("status").first()).toHaveText("运行中", { timeout: 30_000 });
      const serviceCommand = "python3 -u -m http.server 8129 --bind 0.0.0.0";
      await panel().getByLabel("执行命令", { exact: true }).fill(serviceCommand);
      await panel().getByRole("button", { name: "后台运行", exact: true }).click();
      await expect(panel().getByRole("log")).toContainText("Serving HTTP", { timeout: 20_000 });
      const background = value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.processes.list(input), scope))[0]!;
      await panel().getByLabel("端口所属进程", { exact: true }).selectOption(background.id);
      await panel().getByLabel("环境服务端口", { exact: true }).fill("8129");
      await panel().getByLabel("环境服务名称", { exact: true }).fill("重启保持服务");
      await panel().getByRole("button", { name: "登记端口", exact: true }).click();
      await expect(panel().locator(".environment-port-list")).toContainText("重启保持服务 · 8129 · 正在监听");
      const foregroundCommand = `node -e 'console.log("FOREGROUND_BEFORE_APP_CRASH"); setInterval(() => {}, 1000)'`;
      await panel().getByLabel("执行命令", { exact: true }).fill(foregroundCommand);
      await panel().getByRole("button", { name: "运行命令", exact: true }).click();
      await expect(panel().getByRole("log")).toContainText("FOREGROUND_BEFORE_APP_CRASH");
      const before = await executionList(f.page, scope);
      const foreground = before.find(task => task.command === foregroundCommand)!;
      expect(foreground.state).toBe("running");
      expect(before).toHaveLength(2);

      await f.crashRestart();

      await expect.poll(async () => value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.execution.get(input), { ...scope, id: foreground.id })).state, { timeout: 30_000 }).toBe("cancelled");
      const preserved = value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.processes.list(input), scope));
      expect(preserved).toHaveLength(1); expect(preserved[0]?.id).toBe(background.id); expect(preserved[0]?.state).toBe("running");
      expect(await executionList(f.page, scope)).toHaveLength(2);
      expect(value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.processes.listPorts(input), scope))[0]?.state).toBe("listening");
      await f.page.getByRole("listitem", { name: bot.name, exact: true }).click();
      await openInspector(f.page);
      await selectDetailsTab(contact(), "执行环境");
      const afterCommand = `node -e 'console.log("NEW_FOREGROUND_AFTER_RESTART=" + (6 * 7 + 1))'`;
      await panel().getByLabel("执行命令", { exact: true }).fill(afterCommand);
      await panel().getByRole("button", { name: "运行命令", exact: true }).click();
      await expect.poll(async () => (await executionList(f.page, scope)).find(task => task.command === afterCommand)?.state, { timeout: 20_000 }).toBe("completed");
      await expect(panel().getByRole("log")).toContainText("NEW_FOREGROUND_AFTER_RESTART=43");
      expect(await executionList(f.page, scope)).toHaveLength(3);
      expect(value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.processes.list(input), scope))[0]?.state).toBe("running");
      await panel().getByRole("button", { name: "停止后台进程", exact: true }).click();
      await expect.poll(async () => value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.processes.list(input), scope))[0]?.state).toBe("cancelled");
    });
  });
});
