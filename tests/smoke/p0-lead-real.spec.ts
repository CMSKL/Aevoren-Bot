import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { AevorenBotApi } from "../../src/shared/contracts";
import { AppRepository } from "../../src/main/database";
import { WorkspaceService } from "../../src/main/workspace-service";
import { copyRealApiProfile } from "./real-api-profile";
import { removeTestDirectory } from "./test-cleanup";
import { openMessageEvidence } from "./navigation";

for (const { workerSource, restoreMissingSource } of [
  { workerSource: "openai-compatible.default", restoreMissingSource: false },
  { workerSource: "claude.default", restoreMissingSource: false },
  { workerSource: "codex.default", restoreMissingSource: false },
  { workerSource: "openai-compatible.default", restoreMissingSource: true },
] as const) {
  test(`real fixed lead delegates to ${workerSource}, transfers files, and summarizes without tools${restoreMissingSource ? " after a missing-source retry" : ""}`, async ({ playwright }, testInfo) => {
    const sourcePath = process.env.AEVOREN_P0_REAL_SOURCE_DB;
    test.skip(!sourcePath, "requires the real installed API profile and authenticated local CLIs");
    test.setTimeout(540_000);
    const directory = mkdtempSync(join(tmpdir(), "aevoren-p0-real-lead-"));
    const databasePath = join(directory, "aevoren-bot.sqlite");
    const modelId = copyRealApiProfile(sourcePath!, databasePath);
    const repository = new AppRepository(databasePath);
    const root = join(directory, "公开项目资料");
    mkdirSync(root);
    if (!restoreMissingSource) copyFileSync(join(process.cwd(), "LICENSE"), join(root, "LICENSE.md"));
    copyFileSync(join(process.cwd(), "docs", "USER_GUIDE.md"), join(root, "USER_GUIDE.md"));
    const registration = await new WorkspaceService(repository).registerRoot(root);
    repository.updateWorkspacePermissions(registration.workspace.id, registration.workspace.version, { writeEnabled: true, automationEnabled: true });
    repository.setDefaultModelSelection({ providerInstanceId: "openai-compatible.default", modelId });
    repository.setSetting("memory.capture.enabled", "false", false);
    repository.setSetting("appearance.theme", "dark", false);
    const create = (name: string, instructions: string) => {
      const created = repository.createBot(registration.project.id);
      return repository.updateBot(created.bot.id, created.bot.version, { name, instructions });
    };
    const lead = create("项目协调员", "按用户要求安排明确分工和顺序，成员完成后依据真实执行结果汇总。保持简洁，不代替成员声称执行，不要求用户重复提供已交接的路径或资料。");
    const reader = create("许可证研究员", "只处理当前分配给自己的工作。使用真实文件工具读取指定原文，写入用户指定的唯一输出文件。不要联网或发布，不能把文字声明当作读写完成。");
    const editor = create("发布编辑", "只处理当前分配给自己的工作。必须实际读取上游交付文件和指定资料，再写入用户指定的唯一文件。不要重复上游工作，不联网、不发布。");
    const room = repository.createRoom({ name: "公开资料协作", projectId: registration.project.id, memberBotIds: [lead.id, reader.id, editor.id], leadBotId: lead.id });
    repository.close();
    const env: Record<string, string> = {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      AEVOREN_BOT_USER_DATA_DIR: directory, AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_DISABLE_UPDATES: "1", AEVOREN_BOT_USE_SYSTEM_SAFE_STORAGE: "1",
    };
    delete env.AEVOREN_BOT_FAKE_PROVIDER; delete env.AEVOREN_BOT_DB_PATH;
    const app = await playwright._electron.launch({ args: ["."], cwd: process.cwd(), env });
    try {
      // Transparent observation of real planner responses, not a replacement or
      // fixture. Keep this isolated task's decision evidence without headers.
      await app.evaluate(() => {
        const state = globalThis as typeof globalThis & { __leadPlanEvidence?: unknown[] };
        state.__leadPlanEvidence = [];
        const original = globalThis.fetch.bind(globalThis);
        globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
          const response = await original(...args);
          const body = args[1]?.body;
          if (typeof body === "string" && body.includes('"select_room_lead_plan"')) {
            try {
              const request = JSON.parse(body);
              const result = await response.clone().json();
              state.__leadPlanEvidence!.push({ messages: request.messages, status: response.status, result });
            } catch { state.__leadPlanEvidence!.push({ observationFailed: true, status: response.status }); }
          }
          return response;
        };
      });
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      if (workerSource !== "openai-compatible.default") {
        const switched = await page.evaluate(async ({ botId, source }) => {
          const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
          const catalog = await api.providers.scan();
          if (!catalog.ok) throw new Error(catalog.error.code);
          const provider = catalog.data.find(provider => provider.id === source);
          if (!provider || provider.status !== "available" || !provider.capabilities.workspaceTools) throw new Error(`Real ${source} is not authenticated or tool-capable`);
          const bots = await api.bots.list();
          if (!bots.ok) throw new Error(bots.error.code);
          const bot = bots.data.find(bot => bot.id === botId)!;
          return api.bots.update({ id: bot.id, expectedVersion: bot.version, patch: { modelSelection: { providerInstanceId: source, modelId: provider.models.default } } });
        }, { botId: reader.id, source: workerSource });
        expect(switched.ok).toBe(true);
        await page.reload();
      }
      await page.getByRole("tab", { name: "聊天", exact: true }).click();
      await page.locator(".bot-row").filter({ hasText: "公开资料协作" }).click();
      await expect(page.getByRole("heading", { name: "公开资料协作", exact: true })).toBeVisible();
      await page.getByLabel("消息", { exact: true }).fill("请你协调两位成员连续完成这个任务：许可证研究员先真实读取当前工作区的 LICENSE.md，将许可证名称和第一段摘要新建为 license-note.md；然后发布编辑真实读取 license-note.md 和 USER_GUIDE.md，将该产品的三个用途整理为 guide-note.md。两人完成后由项目协调员汇总两份真实文件路径与完成情况，不再重复读写。只创建这两个文件，不联网、不发布，不需要我再手工指定成员或补充路径。");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      const snapshot = () => page.evaluate(async ({ roomId, sessionId }) => {
        const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
        return { runtime: await api.roomRuntime.getSnapshot(roomId), tools: await api.tools.list({ sessionId }) };
      }, { roomId: room.room.id, sessionId: room.session.id });
      try {
        if (restoreMissingSource) {
          // A real missing file, not a mocked tool failure. Repair only the
          // environment, then use the ordinary Retry action without resending
          // the request, supplying context, or manually dispatching the editor.
          await expect.poll(async () => {
            const initial = await snapshot();
            return initial.runtime.ok ? initial.runtime.data.batches.at(-1)?.state : undefined;
          }, { timeout: 180_000, intervals: [1000] }).toBe("partial");
          const initial = await snapshot();
          if (!initial.runtime.ok || !initial.tools.ok) throw new Error("Missing-source evidence unavailable");
          await testInfo.attach("before-source-restoration.json", { body: Buffer.from(JSON.stringify(initial, null, 2)), contentType: "application/json" });
          expect(initial.runtime.data.turns.find(turn => turn.memberBotId === reader.id)).toMatchObject({ state: "failed", turnPurpose: "work" });
          expect(initial.runtime.data.turns.find(turn => turn.memberBotId === editor.id)).toMatchObject({ state: "cancelled", runtimeRunId: null, lastErrorCode: "ROOM_DEPENDENCY_FAILED" });
          expect(initial.tools.data.length).toBeGreaterThan(0);
          expect(initial.tools.data.some(tool => tool.toolKind === "workspace-write" && tool.state === "succeeded")).toBe(false);
          expect(existsSync(join(root, "license-note.md"))).toBe(false);
          expect(existsSync(join(root, "guide-note.md"))).toBe(false);
          copyFileSync(join(process.cwd(), "LICENSE"), join(root, "LICENSE.md"));
          await page.locator('article.message-assistant[data-turn-purpose="work"][data-status="failed"]')
            .getByRole("button", { name: "重试此步骤", exact: true }).click();
          await expect.poll(async () => {
            const retried = await snapshot();
            return retried.runtime.ok && retried.runtime.data.turns.some(turn => turn.memberBotId === reader.id && turn.attemptNo === 2);
          }, { timeout: 10_000 }).toBe(true);
        }
        await expect.poll(async () => {
          const state = await snapshot();
          if (!state.runtime.ok) throw new Error(state.runtime.error.code);
          const batch = state.runtime.data.batches.at(-1);
          if (batch && ["partial", "cancelled", "interrupted"].includes(batch.state)) throw new Error(`Real lead chain failed: ${JSON.stringify({ state: batch.state, summary: batch.summaryState, coordination: batch.coordinationErrorCode, turns: state.runtime.data.turns.map(turn => ({ state: turn.state, code: turn.lastErrorCode, purpose: turn.turnPurpose })) })}`);
          return batch?.state;
        }, { timeout: 420_000, intervals: [1000] }).toBe("completed");
        const state = await snapshot();
        if (!state.runtime.ok || !state.tools.ok) throw new Error("Real evidence is unavailable");
        const batch = state.runtime.data.batches.at(-1)!;
        expect(batch.leadBotId).toBe(lead.id);
        expect(batch.summaryState).toBe("completed");
        const allTurns = state.runtime.data.turns.filter(turn => turn.batchId === batch.id);
        const latest = new Map<string, (typeof allTurns)[number]>();
        for (const turn of allTurns) if (!latest.has(turn.logicalTurnId) || latest.get(turn.logicalTurnId)!.attemptNo < turn.attemptNo) latest.set(turn.logicalTurnId, turn);
        const turns = [...latest.values()];
        expect(turns.filter(turn => turn.turnPurpose === "coordinate")).toHaveLength(1);
        expect(turns.filter(turn => turn.turnPurpose === "work")).toHaveLength(2);
        const summaries = turns.filter(turn => turn.turnPurpose === "summary");
        expect(summaries).toHaveLength(1);
        expect(summaries[0]?.memberBotId).toBe(lead.id);
        expect(state.tools.data.filter(tool => tool.runtimeRunId === summaries[0]?.runtimeRunId)).toHaveLength(0);
        expect(state.runtime.data.runs.every(run => run.route !== "fake")).toBe(true);
        expect(turns.every(turn => turn.state === "completed")).toBe(true);
        if (!restoreMissingSource) expect(state.runtime.data.runs.every(run => run.state === "completed")).toBe(true);
        else {
          expect(turns.find(turn => turn.memberBotId === reader.id)?.attemptNo).toBe(2);
          expect(turns.find(turn => turn.memberBotId === editor.id)?.attemptNo).toBe(2);
          expect(state.runtime.data.entries.filter(entry => entry.role === "user")).toHaveLength(1);
          expect(batch.coordinationErrorCode).toBeNull();
        }
        expect(state.runtime.data.runs.some(run => run.executorBotId === reader.id && run.providerInstanceId === workerSource)).toBe(true);
        expect(state.runtime.data.handoffs.filter(handoff => (handoff.deliveryAttempt?.state ?? handoff.state) === "accepted").length).toBeGreaterThanOrEqual(2);
        if (restoreMissingSource) {
          const editorTurn = turns.find(turn => turn.memberBotId === editor.id)!;
          const delivery = state.runtime.data.handoffs.find(handoff => handoff.deliveryAttempt?.turnId === editorTurn.id);
          const editorRun = state.runtime.data.runs.find(run => run.id === editorTurn.runtimeRunId)!;
          expect(delivery).toMatchObject({ state: "cancelled", deliveryAttempt: { attemptNo: 2, turnId: editorTurn.id, state: "accepted", acceptedAt: editorRun.acceptedAt } });
          expect(editorRun.acceptedAt).not.toBeNull();
          await openMessageEvidence(page);
          await expect(page.getByText(/重试 1 · 已接收/u).first()).toBeVisible();
        }
        const editorWrite = state.tools.data.find(tool => tool.executorBotId === editor.id && tool.toolKind === "workspace-write" && tool.targetPath === "guide-note.md" && tool.state === "succeeded");
        for (const sourceFile of ["license-note.md", "USER_GUIDE.md"]) {
          const sourceRead = state.tools.data.find(tool => tool.executorBotId === editor.id && tool.toolKind === "workspace-read" && tool.targetPath === sourceFile && tool.state === "succeeded");
          expect(sourceRead).toBeDefined();
          expect(sourceRead?.finishedAt && editorWrite?.startedAt && Date.parse(sourceRead.finishedAt) <= Date.parse(editorWrite.startedAt)).toBe(true);
        }
        for (const path of ["license-note.md", "guide-note.md"]) {
          expect(existsSync(join(root, path))).toBe(true);
          const bytes = readFileSync(join(root, path));
          const written = state.tools.data.filter(tool => tool.toolKind === "workspace-write" && tool.targetPath === path);
          expect(written).toHaveLength(1);
          expect(written[0]?.state).toBe("succeeded");
          expect(written[0]?.resultMetadata?.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
          await testInfo.attach(path, { body: bytes, contentType: "text/markdown" });
        }
        expect(readFileSync(join(root, "license-note.md"), "utf8")).toMatch(/Apache/iu);
        const summaryEntry = state.runtime.data.entries.find(entry => entry.sourceTurnId === summaries[0]?.id);
        expect(summaryEntry?.body).toContain("license-note.md");
        expect(summaryEntry?.body).toContain("guide-note.md");
        expect(summaryEntry?.body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b(?:Runtime|Host|invocationId|coordinationErrorCode)\b/iu);
        expect(errors).toEqual([]);
        await page.screenshot({ path: join(tmpdir(), `aevoren-p0-lead-${workerSource}.png`) });
      } finally {
        await testInfo.attach("execution-evidence.json", { body: Buffer.from(JSON.stringify(await snapshot(), null, 2)), contentType: "application/json" });
        const decisions = await app.evaluate(() => (globalThis as typeof globalThis & { __leadPlanEvidence?: unknown[] }).__leadPlanEvidence);
        await testInfo.attach("real-plan-decisions.json", { body: Buffer.from(JSON.stringify(decisions, null, 2)), contentType: "application/json" });
      }
    } finally { await app.close(); removeTestDirectory(directory); }
  });
}
