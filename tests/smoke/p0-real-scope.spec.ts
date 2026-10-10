import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test } from "@playwright/test";
import type { AevorenBotApi } from "../../src/shared/contracts";
import { AppRepository } from "../../src/main/database";
import { WorkspaceService } from "../../src/main/workspace-service";
import { removeTestDirectory } from "./test-cleanup";
import { copyRealApiProfile } from "./real-api-profile";

test("real API uses the current group's files when the same contact joins two workspaces", async () => {
  const sourcePath = process.env.AEVOREN_P0_REAL_SOURCE_DB;
  test.skip(!sourcePath, "requires an explicitly selected installed profile; no fake Provider is accepted");
  test.setTimeout(420_000);
  const directory = mkdtempSync(join(tmpdir(), "aevoren-p0-real-scope-"));
  const databasePath = join(directory, "aevoren-bot.sqlite");
  // Reuse only the selected API configuration and its encrypted credential. No
  // private conversations, memories, Routines or MCP connections enter this app.
  const modelId = copyRealApiProfile(sourcePath!, databasePath);
  const repository = new AppRepository(databasePath);
  const firstRoot = join(directory, "license-project");
  const secondRoot = join(directory, "guide-project");
  mkdirSync(firstRoot); mkdirSync(secondRoot);
  copyFileSync(join(process.cwd(), "LICENSE"), join(firstRoot, "LICENSE.md"));
  copyFileSync(join(process.cwd(), "docs", "USER_GUIDE.md"), join(secondRoot, "USER_GUIDE.md"));
  const service = new WorkspaceService(repository);
  const first = await service.registerRoot(firstRoot);
  const second = await service.registerRoot(secondRoot);
  for (const registered of [first, second]) repository.updateWorkspacePermissions(registered.workspace.id, registered.workspace.version, { writeEnabled: true, automationEnabled: true });
  repository.setDefaultModelSelection({ providerInstanceId: "openai-compatible.default", modelId });
  repository.setSetting("memory.capture.enabled", "false", false);
  repository.setSetting("appearance.theme", "dark", false);
  const created = repository.createBot(first.project.id);
  const bot = repository.updateBot(created.bot.id, created.bot.version, { name: "文档研究员", instructions: "根据用户要求使用真实工作区工具读取文件，结果只依据工具返回的原文。不要联网、不要调用其他Agent、不执行用户没有要求的步骤。写入只生成指定的一个Markdown文件。" });
  const peer = repository.createBot(first.project.id).bot;
  const firstRoom = repository.createRoom({ name: "许可证资料", projectId: first.project.id, memberBotIds: [bot.id, peer.id] });
  const secondRoom = repository.createRoom({ name: "使用指南资料", projectId: second.project.id, memberBotIds: [bot.id, peer.id] });
  repository.close();
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), AEVOREN_BOT_USER_DATA_DIR: directory, AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_DISABLE_UPDATES: "1", AEVOREN_BOT_USE_SYSTEM_SAFE_STORAGE: "1" };
  delete env.AEVOREN_BOT_FAKE_PROVIDER; delete env.AEVOREN_BOT_DB_PATH;
  const app = await electron.launch({ args: ["."], cwd: process.cwd(), env });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    for (const [room, workspaceId, prompt] of [
      [firstRoom, first.workspace.id, "请真实读取当前群工作区的 LICENSE.md，回复文件开头的许可证名称。只读取，不写文件、不联网。"],
      [secondRoom, second.workspace.id, "请真实读取当前群工作区的 USER_GUIDE.md，根据原文把三个核心用途写入 guide-summary.md，然后真实读取新文件核对。只创建这一个文件，不联网。"],
    ] as const) {
      const result = await page.evaluate(async ({ room, botId, prompt }) => {
        const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
        return api.roomRuntime.send({ roomId: room.room.id, sessionId: room.session.id, clientNonce: crypto.randomUUID(), text: prompt, routingMode: "explicit", targetBotIds: [botId] });
      }, { room, botId: bot.id, prompt });
      if (!result.ok) throw new Error(`Real send failed: ${result.error.code}`);
      await expect.poll(async () => page.evaluate(async (roomId) => {
        const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
        const snapshot = await api.roomRuntime.getSnapshot(roomId);
        if (!snapshot.ok) throw new Error(snapshot.error.code);
        const batch = snapshot.data.batches.at(-1);
        if (batch && ["partial", "cancelled", "interrupted"].includes(batch.state)) throw new Error(`Real group failed: ${snapshot.data.turns.map(turn => turn.lastErrorCode).join(",")}`);
        return batch?.state;
      }, room.room.id), { timeout: 180_000, intervals: [500] }).toBe("completed");
      const tools = await page.evaluate(async (sessionId) => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.tools.list({ sessionId }), room.session.id);
      if (!tools.ok) throw new Error(tools.error.code);
      expect(tools.data.some(tool => tool.toolKind === "workspace-read" && tool.state === "succeeded" && tool.resultDigest)).toBe(true);
      expect(tools.data.filter(tool => tool.workspaceId).every(tool => tool.workspaceId === workspaceId)).toBe(true);
      expect(tools.data.every(tool => tool.state === "succeeded")).toBe(true);
    }
    expect(readFileSync(join(secondRoot, "guide-summary.md"), "utf8").trim().length).toBeGreaterThan(50);
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM runtime_runs WHERE route <> 'openai-compatible' OR state <> 'completed'").get()).toEqual({ count: 0 });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.close(); }
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestDirectory(directory);
  }
});
