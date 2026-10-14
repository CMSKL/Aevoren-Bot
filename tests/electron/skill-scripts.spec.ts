import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { AevorenBotApi, ApiResult } from "../../src/shared/contracts";
import type { LibraryContent } from "../../src/shared/library-contracts";
import type { EnvironmentScope } from "../../src/shared/environment-contracts";
import type { ApprovalReviewResult, SkillExecutionGrant } from "../../src/shared/skill-execution-contracts";
import { IPC } from "../../src/shared/channels";
import { AppRepository } from "../../src/main/database";
import { WorkspaceService } from "../../src/main/workspace-service";
import { DockerDriver } from "../../src/main/docker-driver";
import { openInspector } from "../smoke/navigation";
import { closeTestApplication, removeTestDirectory } from "../smoke/test-cleanup";

function value<T>(result: ApiResult<T>): T { if (!result.ok) throw new Error(`${result.error.code}: ${result.error.safeMessage}`); return result.data; }
type HeldMain = { skillReviewDelay?: { entered: boolean; release?: () => void; returned: boolean; captured?: ApiResult<ApprovalReviewResult> } };
type Fixture = { page: Page; application: ElectronApplication; scope: EnvironmentScope; bots: { id: string; sessionId: string; name: string }[]; room: { id: string; sessionId: string; name: string }; content: LibraryContent; setModelGrant(grant: SkillExecutionGrant): void };

async function withScripts(callback: (fixture: Fixture) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "aevoren-skill-scripts-")); const source = join(directory, "source"); const packagePath = join(source, "skill");
  mkdirSync(join(packagePath, "scripts"), { recursive: true }); mkdirSync(join(packagePath, "assets"));
  writeFileSync(join(packagePath, "SKILL.md"), "---\nname: script-acceptance\ndescription: Actual script acceptance fixture\n---\nRun only the selected approved script.\n");
  writeFileSync(join(packagePath, "assets", "value.txt"), "SKILL_ASSET_ACTUAL\n");
  writeFileSync(join(packagePath, "scripts", "main.sh"), "#!/bin/bash\nprintf 'BASH_SCRIPT_ACTUAL:%s\\n' \"$1\"\nprintf '%s' \"$1\" > bash-receipt.txt\n");
  writeFileSync(join(packagePath, "scripts", "main.py"), "import json,sys\nfrom pathlib import Path\nprint('PYTHON_SCRIPT_ACTUAL:'+json.dumps(sys.argv[1:]))\nprint((Path(__file__).parent.parent/'assets/value.txt').read_text())\nPath('python-receipt.txt').write_text(json.dumps(sys.argv[1:]))\n");
  writeFileSync(join(packagePath, "scripts", "main.js"), "const fs=require('node:fs'),path=require('node:path');\nconsole.log('NODE_SCRIPT_ACTUAL:'+JSON.stringify(process.argv.slice(2)));\nconsole.log(fs.readFileSync(path.join(__dirname,'../assets/value.txt'),'utf8'));\nfs.writeFileSync('node-receipt.txt',JSON.stringify(process.argv.slice(2)));\n");
  const databasePath = join(directory, "aevoren-bot.sqlite"); const repository = new AppRepository(databasePath);
  const registration = await new WorkspaceService(repository).registerRoot(source);
  const bots = ["脚本验收成员 A", "脚本验收成员 B"].map(name => { const created = repository.createBot(registration.project.id); const bot = repository.updateBot(created.bot.id, created.bot.version, { name, mcpServerIds: [], modelSelection: { providerInstanceId: "openai-compatible.default", modelId: "script-fixture-model" } }); return { id: bot.id, sessionId: created.session.id, name }; });
  const room = repository.createRoom({ name: "脚本验收群", memberBotIds: bots.map(bot => bot.id), leadBotId: null, projectId: registration.project.id });
  repository.setSetting("memory.capture.enabled", "false", false); repository.close();
  let modelGrant: SkillExecutionGrant | null = null;
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const command = JSON.parse(body) as { messages: { role: string }[] };
    const tool = command.messages.at(-1)?.role !== "tool";
    if (tool && !modelGrant) { response.writeHead(500).end(); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: tool ? { tool_calls: [{ index: 0, id: "actual-script-call", type: "function", function: { name: "product_execute", arguments: JSON.stringify({ operation: "skills.runScript", input: { grantId: modelGrant!.id, expectedGrantVersion: modelGrant!.version, args: ["ORIGINAL_APPROVAL_ARGUMENT"], cwd: ".", timeoutMs: 120000 } }) } }] } : { content: "本次脚本操作已结束。" }, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  let application: ElectronApplication | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error("Model fixture port unavailable");
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key, data]) => data !== undefined && !key.startsWith("AEVOREN_BOT_")));
    const executablePath = process.env.AEVOREN_PACKAGED_APP_PATH;
    application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : ["."], cwd: process.cwd(), env: { ...environment, AEVOREN_BOT_USER_DATA_DIR: directory, AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_DISABLE_UPDATES: "1", AEVOREN_BOT_FAKE_PROVIDER: "0" } });
    if (executablePath) expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
    const page = await application.firstWindow(); const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await expect(page.locator(".app-shell")).toBeVisible();
    await page.evaluate(async baseUrl => { const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot; const listed = await api.providers.list(); if (!listed.ok) throw new Error(listed.error.code); const provider = listed.data.find(item => item.id === "openai-compatible.default")!; const saved = await api.providers.saveOpenAiCompatible({ instanceId: provider.id, expectedVersion: provider.version, baseUrl, apiKey: "script-fixture-token" }); if (!saved.ok) throw new Error(saved.error.code); }, `http://127.0.0.1:${address.port}/v1`);
    const scope = { sessionId: bots[0]!.sessionId, executorBotId: bots[0]!.id };
    const initialized = value(await page.evaluate(() => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.environments.initialize())); expect(initialized.probe.available).toBe(true);
    value(await page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.environments.start(input), scope));
    const imported = value(await page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.library.importPath(input), { sessionId: scope.sessionId, kind: "skill" as const, workspaceId: registration.workspace.id, path: "skill" }));
    const content = imported.imported[0]!;
    await callback({ page, application, scope, bots, room: { id: room.room.id, sessionId: room.session.id, name: room.room.name }, content, setModelGrant(grant) { modelGrant = grant; } });
    expect(errors).toEqual([]); expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible()))).toBe(false);
  } finally {
    if (application) { await application.evaluate(() => (globalThis as HeldMain).skillReviewDelay?.release?.()).catch(() => undefined); await closeTestApplication(application); }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    const cleanup = new AppRepository(databasePath); const environments = cleanup.environments.listInternal(); cleanup.close();
    const docker = new DockerDriver(); await docker.probe(); const cliEnvironment = { ...process.env }; delete cliEnvironment.DOCKER_HOST; delete cliEnvironment.DOCKER_CONTEXT;
    for (const environment of environments) { await docker.stop(environment.id); await docker.remove(environment.id); execFileSync("docker", ["--context", Reflect.get(docker, "context") as string, "volume", "rm", `aevoren-work-${environment.id}`, `aevoren-state-${environment.id}`], { env: cliEnvironment, stdio: "pipe" }); }
    removeTestDirectory(directory);
  }
}

test.describe("actual Skill scripts through hidden Electron", () => {
  test.skip(process.env.AEVOREN_DOCKER_INTEGRATION !== "1" || process.env.AEVOREN_SKILL_SCRIPT_INTEGRATION !== "1", "Requires explicit real Docker/Skill-script opt-in; no execution or approval result is simulated.");
  test.setTimeout(180_000);
  test("reviews fixed source and runs Bash, Python and Node with real files and output; group grants and argument drafts stay scoped", async () => {
    await withScripts(async f => {
      await f.page.getByRole("listitem", { name: f.bots[0]!.name, exact: true }).click(); await openInspector(f.page);
      const contact = f.page.getByRole("main", { name: "联系人资料", exact: true }); await contact.getByRole("tab", { name: "Skill", exact: true }).click();
      const library = contact.getByRole("region", { name: "Skill库", exact: true }); await library.getByRole("button", { name: f.content.resource.name, exact: false }).click();
      const panel = library.getByRole("region", { name: "Skill 脚本", exact: true });
      for (const [path, marker, file, prefix] of [["scripts/main.sh", "UI_BASH_LITERAL;$(not-evaluated)", "bash-receipt.txt", "BASH_SCRIPT_ACTUAL"], ["scripts/main.py", "UI_PYTHON_LITERAL;$(not-evaluated)", "python-receipt.txt", "PYTHON_SCRIPT_ACTUAL"], ["scripts/main.js", "UI_NODE_LITERAL;$(not-evaluated)", "node-receipt.txt", "NODE_SCRIPT_ACTUAL"]]) {
        await panel.getByLabel("Skill 脚本入口", { exact: true }).selectOption(path!);
        const grantButton = panel.getByRole("button", { name: "授权此保存版本脚本", exact: true }); await expect(grantButton).toBeEnabled();
        await expect(panel.locator(".skill-script-code pre").first()).toContainText(prefix!);
        await grantButton.click(); const confirmation = panel.getByRole("group", { name: "确认脚本操作", exact: true }); await expect(confirmation).toContainText(path!); await confirmation.getByRole("button", { name: "确认脚本操作", exact: true }).click();
        const run = panel.getByRole("button", { name: "运行已授权脚本", exact: true }); await expect(run).toBeEnabled(); await panel.getByLabel("Skill 脚本参数", { exact: true }).fill(JSON.stringify([marker])); await run.click();
        await expect(confirmation).toContainText(marker!); await confirmation.getByRole("button", { name: "确认脚本操作", exact: true }).click();
        await expect.poll(async () => value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.execution.list(input), f.scope)).filter(task => task.state === "completed").length).toBe((file === "bash-receipt.txt" ? 1 : file === "python-receipt.txt" ? 2 : 3));
        const receipt = value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.execution.readFile(input), { ...f.scope, path: file! }));
        expect(file === "bash-receipt.txt" ? receipt.content : JSON.parse(receipt.content)[0]).toBe(marker);
        await panel.getByRole("button", { name: "查看脚本输出", exact: true }).click(); const output = contact.getByRole("log"); await expect(output).toContainText(prefix!); if (file !== "bash-receipt.txt") await expect(output).toContainText("SKILL_ASSET_ACTUAL");
        await contact.getByRole("tab", { name: "Skill", exact: true }).click();
      }
      value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.library.bind(input), { sessionId: f.room.sessionId, id: f.content.resource.id }));
      const groupScope = { sessionId: f.room.sessionId, executorBotId: f.bots[0]!.id }; value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.environments.start(input), groupScope));
      await contact.getByRole("button", { name: "发消息", exact: true }).click(); await f.page.getByRole("listitem", { name: f.room.name, exact: true }).click(); await openInspector(f.page);
      const room = f.page.getByRole("dialog", { name: "群聊设置", exact: true }); await room.getByRole("tab", { name: "Skill", exact: true }).click(); const member = room.getByLabel("Skill 脚本执行成员", { exact: true }); await member.selectOption(f.bots[0]!.id);
      const groupLibrary = room.getByRole("region", { name: "Skill库", exact: true }); await groupLibrary.getByRole("button", { name: f.content.resource.name, exact: false }).click(); const args = groupLibrary.getByLabel("Skill 脚本参数", { exact: true });
      await args.fill('["GROUP_A_UNSENT"]'); await member.selectOption(f.bots[1]!.id); await expect(args).toHaveValue("[]"); await args.fill('["GROUP_B_UNSENT"]'); await member.selectOption(f.bots[0]!.id); await expect(args).toHaveValue('["GROUP_A_UNSENT"]');
      expect(value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.skillsExecution.executionGrants(input), groupScope))).toEqual([]);
      const privateGrant = value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.skillsExecution.executionGrants(input), f.scope))[0]!;
      const denied = await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.skillsExecution.runScript(input), { ...groupScope, grantId: privateGrant.id, expectedGrantVersion: privateGrant.version, clientNonce: crypto.randomUUID(), args: [] }); expect(denied.ok).toBe(false);
      expect(value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.execution.list(input), groupScope))).toEqual([]);
    });
  });

  test("keeps a delayed executable review disabled after revocation and renders the original frozen name and arguments", async () => {
    await withScripts(async f => {
      const environment = value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.environments.get(input), f.scope))!;
      const grant = value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.skillsExecution.grantExecution(input), { ...f.scope, environmentId: environment.id, expectedImageDigest: environment.imageDigest, expectedWorkerVersion: environment.workerVersion, reference: f.content.reference, entryPath: "scripts/main.js", interpreter: "node" as const })); f.setModelGrant(grant);
      await f.application.evaluate(({ ipcMain }, channel) => {
        const globals = globalThis as HeldMain; globals.skillReviewDelay = { entered: false, returned: false };
        const original = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers.get(channel)!;
        ipcMain.removeHandler(channel); ipcMain.handle(channel, async (...args: unknown[]) => { const result = await original(...args); if (globals.skillReviewDelay!.entered) return result; globals.skillReviewDelay!.captured = result as ApiResult<ApprovalReviewResult>; globals.skillReviewDelay!.entered = true; await new Promise<void>(resolve => { globals.skillReviewDelay!.release = resolve; }); globals.skillReviewDelay!.returned = true; return result; });
      }, IPC.approvalsReview);
      await f.page.getByRole("listitem", { name: f.bots[0]!.name, exact: true }).click(); await f.page.getByLabel("消息", { exact: true }).fill("请运行已授权的 Node Skill 脚本，参数 ORIGINAL_APPROVAL_ARGUMENT。请提交宿主审批。"); await f.page.getByRole("button", { name: "发送", exact: true }).click();
      const permission = f.page.getByTestId("tool-permission-dialog"); const allow = permission.getByRole("button", { name: "仅允许一次", exact: true }); await expect(permission).toBeVisible();
      await expect.poll(() => f.application.evaluate(() => Boolean((globalThis as HeldMain).skillReviewDelay?.entered))).toBe(true); await expect(allow).toBeDisabled();
      expect(await f.application.evaluate(() => (globalThis as HeldMain).skillReviewDelay?.captured)).toMatchObject({ ok: true, data: { executable: true, snapshot: { kind: "skill-script", target: { grantId: grant.id, grantVersion: grant.version } } } });
      value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.skillsExecution.revokeExecution(input), { ...f.scope, id: grant.id, expectedVersion: grant.version }));
      value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.library.update(input), { sessionId: f.scope.sessionId, id: f.content.resource.id, expectedVersion: f.content.resource.version, name: "LATEST_TITLE_MUST_NOT_REPLACE" }));
      await f.application.evaluate(() => (globalThis as HeldMain).skillReviewDelay?.release?.()); await expect.poll(() => f.application.evaluate(() => Boolean((globalThis as HeldMain).skillReviewDelay?.returned))).toBe(true);
      await expect(permission.getByRole("region", { name: "本次脚本执行快照", exact: true })).toContainText(f.content.revision.name); await expect(permission).toContainText("ORIGINAL_APPROVAL_ARGUMENT"); await expect(permission).not.toContainText("LATEST_TITLE_MUST_NOT_REPLACE"); await expect(allow).toBeDisabled(); await expect(permission.getByRole("alert")).toBeVisible();
      expect(value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.execution.list(input), f.scope))).toEqual([]);
      await permission.getByRole("button", { name: "停止任务", exact: true }).click(); await expect(permission).toBeHidden();
    });
  });
});
