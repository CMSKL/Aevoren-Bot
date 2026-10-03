import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { AevorenBotApi } from "../../src/shared/contracts";
import { AppRepository } from "../../src/main/database";
import { WorkspaceService } from "../../src/main/workspace-service";
import { removeTestDirectory } from "./test-cleanup";

test("creates a real project Bot and Room through authenticated Codex CLI, approvals and Tool Journal", async () => {
  test.skip(process.env.AEVOREN_BOT_REAL_PROJECT_CLI !== "1", "requires explicit local real CLI verification");
  test.setTimeout(240_000);
  const data = mkdtempSync(join(tmpdir(), "aevoren-real-project-tools-"));
  const root = join(data, "项目评审");
  mkdirSync(root);
  const repository = new AppRepository(join(data, "aevoren-bot.sqlite"));
  const registered = await new WorkspaceService(repository).registerRoot(root);
  const created = repository.createBot(registered.project.id);
  repository.updateBot(created.bot.id, created.bot.version, { name: "团队配置助手", mcpServerIds: [], instructions: "按用户要求创建项目内角色与群聊。先调用 project_list_bots 获取真实成员 ID，调用 bot_create 创建角色，再使用返回的真实 resource.id 调用 room_create。每项均以工具成功结果为准，失败不能声称已创建。不要执行新建角色的任务。" });
  repository.setSetting("appearance.theme", "dark", false);
  repository.close();
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !["AEVOREN_BOT_FAKE_PROVIDER", "AEVOREN_BOT_DB_PATH", "AEVOREN_BOT_USER_DATA_DIR"].includes(entry[0])));
  environment.AEVOREN_BOT_USER_DATA_DIR = data;
  environment.AEVOREN_BOT_TEST_HIDDEN = "1";
  const application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment });
  const diagnostics: string[] = [];
  application.process().stderr?.on("data", (chunk: Buffer) => { const text = chunk.toString(); if (text.includes("[codex-runtime]")) diagnostics.push(text); });
  application.process().stdout?.on("data", (chunk: Buffer) => { const text = chunk.toString(); if (text.includes("[codex-runtime]")) diagnostics.push(text); });
  try {
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(page.getByRole("heading", { name: "团队配置助手", exact: true })).toBeVisible();
    let provider = await page.evaluate(async () => {
      const result = await (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.providers.list();
      return result.ok ? result.data.find((item) => item.id === "codex.default") : null;
    });
    if (process.env.AEVOREN_BOT_REAL_PROJECT_CLI_PATH && provider) {
      const configured = await page.evaluate(async (input) => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.providers.saveCli(input), { instanceId: provider.id, expectedVersion: provider.version, cliPath: process.env.AEVOREN_BOT_REAL_PROJECT_CLI_PATH });
      expect(configured.ok, configured.ok ? undefined : configured.error.safeMessage).toBe(true);
      if (configured.ok) provider = configured.data;
    }
    expect(provider?.authenticated, "installed Codex CLI must have actual usable authentication").toBe(true);
    expect(provider?.status).toBe("available");
    const update = await page.evaluate(async ({ id, modelId }) => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const listed = await api.bots.list();
      if (!listed.ok) return listed;
      const bot = listed.data.find((item) => item.id === id)!;
      return api.bots.update({ id, expectedVersion: bot.version, patch: { modelSelection: { providerInstanceId: "codex.default", modelId } } });
    }, { id: created.bot.id, modelId: provider!.models.default });
    expect(update.ok).toBe(true);
    await page.reload();
    await expect(page.getByRole("heading", { name: "团队配置助手", exact: true })).toBeVisible();
    await page.getByLabel("消息").fill("请真实创建一个 Bot，名称必须为‘项目评审助手’，职责是审阅项目资料、核对来源并标注不确定项。然后真实创建‘项目评审讨论群’，成员必须仅为当前团队配置助手与你刚创建的项目评审助手两个 Bot。先查询实际成员，再依次创建 Bot 和群聊。不要启动任务，不要修改文件，不要进行联网搜索或外部操作。成功后给出实际 Bot ID、群聊 ID 和所属项目；没有成功工具记录就明确失败，不要虚构成功。");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const deadline = Date.now() + 180_000;
    let completed = false;
    while (Date.now() < deadline) {
      const state = await page.evaluate(async (sessionId) => {
        const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
        return { approvals: await api.approvals.listPending({ sessionId }), snapshot: await api.runtime.getSessionSnapshot(sessionId), tools: await api.tools.list({ sessionId }) };
      }, created.session.id);
      if (state.approvals.ok) for (const approval of state.approvals.data) {
        const result = await page.evaluate(async (input) => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.approvals.resolve(input), { sessionId: created.session.id, id: approval.id, expectedVersion: approval.version, resolution: "allow-once" as const });
        expect(result.ok).toBe(true);
      }
      if (state.snapshot.ok && state.snapshot.data.runs.some((run) => run.state === "completed")) { completed = true; break; }
      if (state.snapshot.ok && state.snapshot.data.runs.some((run) => run.state === "failed" || run.state === "interrupted")) {
        throw new Error(`Real CLI run failed: ${state.snapshot.data.runs.map((run) => run.lastErrorCode).join(",")} ${diagnostics.join(" ")}`);
      }
      await page.waitForTimeout(500);
    }
    expect(completed, "real model must finish after actual tool creation").toBe(true);
    const result = await page.evaluate(async (sessionId) => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      return { bots: await api.bots.list(), rooms: await api.rooms.list(), tools: await api.tools.list({ sessionId }), snapshot: await api.runtime.getSessionSnapshot(sessionId) };
    }, created.session.id);
    expect(result.bots.ok && result.rooms.ok && result.tools.ok && result.snapshot.ok).toBe(true);
    if (!result.bots.ok || !result.rooms.ok || !result.tools.ok || !result.snapshot.ok) throw new Error("Real result unavailable");
    const child = result.bots.data.find((bot) => bot.name === "项目评审助手")!;
    const room = result.rooms.data.find((item) => item.name === "项目评审讨论群")!;
    expect(child.projectId).toBe(registered.project.id);
    expect(child.instructions || child.description).toBeTruthy();
    expect(child.modelSelection.providerInstanceId).toBe("codex.default");
    expect(room.projectId).toBe(registered.project.id);
    const detail = await page.evaluate(async (id) => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.rooms.get(id), room.id);
    expect(detail.ok && detail.data.members.map((member) => member.botId).toSorted()).toEqual([created.bot.id, child.id].toSorted());
    for (const kind of ["project-bots", "bot-create", "room-create"]) expect(result.tools.data.some((tool) => tool.toolKind === kind && tool.state === "succeeded" && tool.resultDigest)).toBe(true);
    await expect(page.getByRole("listitem", { name: "项目评审助手" })).toBeVisible();
    await expect(page.getByRole("listitem", { name: "项目评审讨论群" })).toBeVisible();
    const childSession = await page.evaluate(async (id) => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.sessions.getMain(id), child.id);
    if (childSession.ok) {
      const childSnapshot = await page.evaluate(async (id) => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.runtime.getSessionSnapshot(id), childSession.data.id);
      expect(childSnapshot.ok && childSnapshot.data.runs).toEqual([]);
    }
    expect(errors).toEqual([]);
    writeFileSync("/tmp/aevoren-real-project-tools-result.json", JSON.stringify({ provider: "codex.default", model: provider!.models.default, completed: true, projectId: registered.project.id, bots: result.bots.data.map(({ id, name, projectId }) => ({ id, name, projectId })), room: { id: room.id, name: room.name, projectId: room.projectId }, tools: result.tools.data.map(({ id, toolKind, state, resultDigest }) => ({ id, toolKind, state, resultDigest })) }, null, 2), "utf8");
  } finally {
    await application.close();
    removeTestDirectory(data);
  }
});
