import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _electron as electron, expect, test } from "@playwright/test";
import type { AevorenBotApi } from "../../src/shared/contracts";
import { AppRepository } from "../../src/main/database";
import { copyRealApiProfile } from "./real-api-profile";
import { removeTestDirectory } from "./test-cleanup";

for (const driver of ["api", "codex", "claude"] as const) {
  test(`real ${driver} uses product discovery, settings and team creation with actual receipts`, async () => {
    test.skip(process.env.AEVOREN_REAL_PRODUCT_TOOLS !== "1", "explicit real model validation only");
    test.setTimeout(300_000);
    const data = mkdtempSync(join(tmpdir(), `aevoren-product-real-${driver}-`));
    const evidence = process.env.AEVOREN_PRODUCT_EVIDENCE_DIR ?? tmpdir();
    mkdirSync(evidence, { recursive: true });
    const apiModel = driver === "api" ? copyRealApiProfile(process.env.AEVOREN_REAL_API_PROFILE_DB ?? "/Users/machao/Library/Application Support/Aevoren Bot/aevoren-bot.sqlite", join(data, "aevoren-bot.sqlite")) : undefined;
    const repository = new AppRepository(join(data, "aevoren-bot.sqlite"));
    const created = repository.createBot();
    const name = `能力验收 ${driver}`;
    repository.updateBot(created.bot.id, created.bot.version, { name, mcpServerIds: [], instructions: "执行当前用户明确指定的产品配置或委派验收。配置验收先用 product_catalog 查功能，再用 product_describe 查 settings.saveGeneral 与 teams.createContentTeam 的输入，然后用 product_execute 执行。这两个功能都必须用新版产品入口，不使用旧 bot_create/room_create。查询真实结果再回复；目录或参数说明不能算执行完成。禁止联网、文件或其他设置变更，只有用户明确指定委派时才发消息。" });
    repository.setSetting("appearance.theme", "light", false);
    repository.setSetting("memory.capture.enabled", "false", false);
    repository.close();
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !["AEVOREN_BOT_FAKE_PROVIDER", "AEVOREN_BOT_USER_DATA_DIR", "AEVOREN_BOT_DB_PATH", "AEVOREN_DECISION_SHADOW"].includes(entry[0])));
    env.AEVOREN_BOT_USER_DATA_DIR = data; env.AEVOREN_BOT_TEST_HIDDEN = "1"; env.AEVOREN_BOT_DISABLE_UPDATES = "1";
    if (driver === "api") env.AEVOREN_BOT_USE_SYSTEM_SAFE_STORAGE = "1";
    const executablePath = process.env.AEVOREN_PACKAGED_APP_PATH;
    const application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : ["."], cwd: process.cwd(), env });
    try {
      const page = await application.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
      expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isVisible()))).toBe(false);
      const instanceId = driver === "api" ? "openai-compatible.default" : `${driver}.default`;
      const configured = await page.evaluate(async ({ id, instanceId, apiModel }) => {
        const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
        const providers = await api.providers.list();
        const provider = providers.ok ? providers.data.find((item) => item.id === instanceId) : undefined;
        if (!provider || !provider.authenticated || provider.status !== "available") throw new Error(`Actual ${instanceId} authentication unavailable`);
        const bots = await api.bots.list();
        const bot = bots.ok ? bots.data.find((item) => item.id === id) : undefined;
        if (!bot) throw new Error("Bot missing");
        const selected = await api.bots.update({ id, expectedVersion: bot.version, patch: { modelSelection: { providerInstanceId: instanceId, modelId: apiModel ?? provider.models.default } } });
        if (!selected.ok) throw new Error(selected.error.code);
        return selected.data.modelSelection;
      }, { id: created.bot.id, instanceId, apiModel });
      await page.reload();
      await page.getByLabel("消息", { exact: true }).fill("请先查询产品功能目录和具体参数，再把本应用主题改成暗黑，使用现有的一键内容团队模板创建自媒体团队。只配置，不发群消息，不启动新建 Bot，不访问文件，不联网。必须用 product_execute 的 settings.saveGeneral 和 teams.createContentTeam，完成后据真实回执简短回复。");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      const deadline = Date.now() + 240_000;
      let completed = false;
      while (Date.now() < deadline) {
        const state = await page.evaluate(async (sessionId) => {
          const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
          return { approvals: await api.approvals.listPending({ sessionId }), tools: await api.tools.list({ sessionId }), snapshot: await api.runtime.getSessionSnapshot(sessionId) };
        }, created.session.id);
        if (state.approvals.ok && state.tools.ok) for (const approval of state.approvals.data) {
          const invocation = state.tools.data.find((item) => item.id === approval.toolInvocationId);
          const command = invocation?.arguments;
          if (command?.kind !== "product-call" || command.action !== "execute" || !["settings.saveGeneral", "teams.createContentTeam"].includes(command.operation)) throw new Error("Unexpected write proposed during real validation");
          const resolved = await page.evaluate(async (input) => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.approvals.resolve(input), { sessionId: created.session.id, id: approval.id, expectedVersion: approval.version, resolution: "allow-once" as const });
          expect(resolved.ok).toBe(true);
        }
        if (state.snapshot.ok && state.snapshot.data.runs.some((run) => ["failed", "interrupted", "cancelled"].includes(run.state))) throw new Error(`Actual ${driver} failed: ${state.snapshot.data.runs.map((run) => run.lastErrorCode).join(",")}`);
        if (state.snapshot.ok && state.snapshot.data.runs.some((run) => run.state === "completed")) { completed = true; break; }
        await page.waitForTimeout(300);
      }
      expect(completed, "actual model must complete the operations").toBe(true);
      const result = await page.evaluate(async (sessionId) => {
        const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
        return { settings: await api.settings.getGeneral(), bots: await api.bots.list(), rooms: await api.rooms.list(), tools: await api.tools.list({ sessionId }), snapshot: await api.runtime.getSessionSnapshot(sessionId) };
      }, created.session.id);
      if (!result.settings.ok || !result.bots.ok || !result.rooms.ok || !result.tools.ok || !result.snapshot.ok) throw new Error("Actual result missing");
      expect(result.settings.data.theme).toBe("dark"); expect(result.bots.data).toHaveLength(6); expect(result.rooms.data).toHaveLength(1);
      expect(result.bots.data.every((bot) => bot.modelSelection.providerInstanceId === instanceId)).toBe(true);
      const tools = result.tools.data.filter((tool) => tool.state === "succeeded");
      expect(tools.some((tool) => tool.arguments.kind === "product-call" && tool.arguments.action === "catalog")).toBe(true);
      expect(tools.some((tool) => tool.arguments.kind === "product-call" && tool.arguments.action === "describe")).toBe(true);
      for (const operation of ["settings.saveGeneral", "teams.createContentTeam"]) expect(tools.some((tool) => tool.arguments.kind === "product-call" && tool.arguments.action === "execute" && tool.arguments.operation === operation && tool.resultDigest)).toBe(true);
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      const recipient = await page.evaluate(async (selection) => {
        const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
        const created = await api.bots.create(); if (!created.ok) throw new Error(created.error.code);
        const configured = await api.bots.update({ id: created.data.bot.id, expectedVersion: created.data.bot.version, patch: { name: "委派回复验收", modelSelection: selection, mcpServerIds: [], instructions: "仅回复当前委派任务要求的公开短词 REAL_DELEGATION_REPLY。不调用工具，不访问历史、长期记忆、文件或网络，不假装自己是发送者。" } });
        if (!configured.ok) throw new Error(configured.error.code);
        return created.data.session.id;
      }, configured);
      const request = await page.evaluate(async ({ source, target }) => {
        const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
        return api.messages.send({ sessionId: source, clientNonce: crypto.randomUUID(), text: `请通过 product_execute 的 messages.send 给会话 ${target} 发消息，让他仅回答公开短词 REAL_DELEGATION_REPLY；随后通过 tasks.waitResult 取得该任务的实际回答，再简短回复我。先用 product_describe 查这两个动作输入，messages.send 不传clientNonce，不虚构来源。不要调用旧创建工具，不创建资源，不改设置，不读历史、Memory、文件，不联网。只有取得真实回答才算完成。` });
      }, { source: created.session.id, target: recipient });
      if (!request.ok) throw new Error(request.error.code);
      const delegationDeadline = Date.now() + 180_000;
      let delegationComplete = false;
      while (Date.now() < delegationDeadline) {
        const state = await page.evaluate(async (sessionId) => {
          const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
          return { approvals: await api.approvals.listPending({ sessionId }), tools: await api.tools.list({ sessionId }), snapshot: await api.runtime.getSessionSnapshot(sessionId) };
        }, created.session.id);
        if (state.approvals.ok && state.tools.ok) for (const approval of state.approvals.data) {
          const command = state.tools.data.find((item) => item.id === approval.toolInvocationId)?.arguments;
          if (command?.kind !== "product-call" || command.action !== "execute" || command.operation !== "messages.send") throw new Error("Unexpected operation during delegation validation");
          await page.evaluate(async (input) => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.approvals.resolve(input), { sessionId: created.session.id, id: approval.id, expectedVersion: approval.version, resolution: "allow-once" as const });
        }
        const current = state.snapshot.ok ? state.snapshot.data.runs.find((run) => run.id === request.data.runId) : undefined;
        if (current?.state === "completed") { delegationComplete = true; break; }
        if (current && ["failed", "cancelled", "interrupted"].includes(current.state)) throw new Error(`Delegation failed: ${current.lastErrorCode}`);
        await page.waitForTimeout(300);
      }
      expect(delegationComplete).toBe(true);
      const delegated = await page.evaluate(async (sessionId) => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.runtime.getSessionSnapshot(sessionId), recipient);
      if (!delegated.ok) throw new Error("Recipient receipt missing");
      expect(delegated.data.entries.some((entry) => entry.role === "user" && entry.origin?.kind === "ai-delegation")).toBe(true);
      expect(delegated.data.entries.some((entry) => entry.role === "assistant" && entry.status === "completed" && entry.body.includes("REAL_DELEGATION_REPLY"))).toBe(true);
      writeFileSync(join(evidence, `product-delegation-${driver}.json`), JSON.stringify({ driver, senderState: "completed", recipientState: delegated.data.runs.at(-1)?.state, replyReceived: true, origin: "ai-delegation" }, null, 2));
      expect(errors).toEqual([]);
      await page.screenshot({ path: join(evidence, `product-real-${driver}.png`) });
      writeFileSync(join(evidence, `product-real-${driver}.json`), JSON.stringify({ driver, model: configured.modelId, route: result.snapshot.data.runs.at(-1)?.route, state: result.snapshot.data.runs.at(-1)?.state, theme: result.settings.data.theme, botCount: result.bots.data.length, roomCount: result.rooms.data.length, tools: tools.map((tool) => ({ kind: tool.toolKind, operation: tool.arguments.kind === "product-call" ? tool.arguments.action === "catalog" ? "catalog" : tool.arguments.operation : tool.toolKind, state: tool.state, digest: tool.resultDigest })), pageErrors: errors }, null, 2));
    } finally {
      await application.close().catch(() => application.process().kill("SIGKILL"));
      removeTestDirectory(data);
    }
  });
}
