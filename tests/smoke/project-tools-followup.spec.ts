import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { AevorenBotApi } from "../../src/shared/contracts";
import { AppRepository } from "../../src/main/database";
import { removeTestDirectory } from "./test-cleanup";

// A local API fixture validates the real host approval and creation flow without
// touching the user's profile, native windows, or authenticated model accounts.
for (const resolution of ["allow-once", "deny"] as const) {
  test(`keeps Bot creation available after a clarification reply (${resolution})`, async () => {
    test.setTimeout(90_000);
    const data = mkdtempSync(join(tmpdir(), "aevoren-project-followup-"));
    const repository = new AppRepository(join(data, "aevoren-bot.sqlite"));
    const actor = repository.createBot();
    repository.updateBot(actor.bot.id, actor.bot.version, {
      name: "张三",
      mcpServerIds: [],
      modelSelection: { providerInstanceId: "openai-compatible.default", modelId: "fixture-followup-model" },
    });
    repository.setSetting("memory.capture.enabled", "false", false);
    const initialBotCount = repository.listBots().length;
    repository.close();
    const offeredTools: string[][] = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const command = JSON.parse(body) as {
        messages: Array<{ role: string; content: string }>;
        tools?: Array<{ function: { name: string } }>;
      };
      offeredTools.push(command.tools?.map((tool) => tool.function.name) ?? []);
      const userText = command.messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
      const toolResult = command.messages.at(-1)?.role === "tool";
      const creating = userText.includes("自媒体选题吧") && !toolResult;
      const delta = creating ? {
        content: "我会创建一个「自媒体选题助手」，负责挖掘选题、分析受众，并给出标题和内容切入角度。应用会要求你批准这次创建。",
        tool_calls: [{ index: 0, id: "followup-bot-create", type: "function", function: {
          name: "bot_create",
          arguments: JSON.stringify({ name: "自媒体选题助手", description: "挖掘自媒体选题，分析受众，给出标题与内容切入角度。" }),
        } }],
      } : { content: toolResult ? resolution === "allow-once" ? "自媒体选题助手已创建。" : "你已拒绝创建，没有新增 Bot。" : "可以，我能在当前项目里实际创建 Bot。你想让它负责什么？" };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: creating ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server unavailable");
    const executablePath = process.env.AEVOREN_PACKAGED_APP_PATH;
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("AEVOREN_BOT_FAKE_") && !["AEVOREN_BOT_DB_PATH", "AEVOREN_BOT_USER_DATA_DIR"].includes(key)));
    const application = await electron.launch({
      ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : ["."], cwd: process.cwd(),
      env: { ...environment, AEVOREN_BOT_FAKE_PROVIDER: "0", AEVOREN_BOT_USER_DATA_DIR: data, AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_DISABLE_UPDATES: "1" },
    });
    try {
      const page = await application.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await expect(page.getByRole("heading", { name: "张三", exact: true })).toBeVisible();
      await page.evaluate(async (baseUrl) => {
        const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
        const listed = await api.providers.list();
        const provider = listed.ok ? listed.data.find((item) => item.id === "openai-compatible.default") : undefined;
        if (!provider) throw new Error("API source unavailable");
        const saved = await api.providers.saveOpenAiCompatible({ instanceId: provider.id, expectedVersion: provider.version, baseUrl, apiKey: "followup-fixture-token" });
        if (!saved.ok) throw new Error(saved.error.code);
      }, `http://127.0.0.1:${address.port}/v1`);
      const snapshot = async () => page.evaluate(async (sessionId) => {
        const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
        return { runtime: await api.runtime.getSessionSnapshot(sessionId), bots: await api.bots.list(), tools: await api.tools.list({ sessionId }), approvals: await api.approvals.listPending({ sessionId }) };
      }, actor.session.id);
      const send = async (text: string) => {
        await page.getByLabel("消息", { exact: true }).fill(text);
        await page.getByRole("button", { name: "发送", exact: true }).click();
      };
      await send("你可以创建bot补");
      await expect.poll(async () => {
        const current = await snapshot();
        return current.runtime.ok ? current.runtime.data.runs.filter((run) => run.state === "completed").length : 0;
      }).toBe(1);
      await expect(page.locator("article.message-assistant")).toContainText("你想让它负责什么");
      await send("自媒体选题吧");
      const permission = page.getByTestId("tool-permission-dialog");
      await expect(permission).toBeVisible();
      await expect(permission).toContainText("自媒体选题助手");
      const pending = await snapshot();
      expect(pending.bots.ok && pending.bots.data.length).toBe(initialBotCount);
      expect(pending.approvals.ok && pending.approvals.data.map((item) => item.actionKind)).toEqual(["bot-create"]);
      expect(offeredTools.at(-1)).toContain("bot_create");
      await permission.getByRole("button", { name: resolution === "allow-once" ? "仅允许一次" : "拒绝", exact: true }).click();
      await expect(permission).toBeHidden();
      await expect.poll(async () => {
        const current = await snapshot();
        return current.runtime.ok ? current.runtime.data.runs.filter((run) => run.state === "completed").length : 0;
      }).toBe(2);
      const result = await snapshot();
      if (!result.bots.ok || !result.tools.ok || !result.runtime.ok || !result.approvals.ok) throw new Error("Follow-up result unavailable");
      const created = result.bots.data.filter((bot) => bot.name === "自媒体选题助手");
      expect(created).toHaveLength(resolution === "allow-once" ? 1 : 0);
      expect(result.bots.data).toHaveLength(initialBotCount + (resolution === "allow-once" ? 1 : 0));
      expect(result.tools.data.filter((tool) => tool.toolKind === "bot-create").map((tool) => tool.state)).toEqual([resolution === "allow-once" ? "succeeded" : "denied"]);
      expect(result.runtime.data.runs.every((run) => run.state === "completed" && run.lastErrorCode === null)).toBe(true);
      expect(result.approvals.data).toEqual([]);
      if (resolution === "allow-once") {
        expect(created[0]?.projectId).toBe(actor.bot.projectId);
        await expect(page.getByRole("listitem", { name: "自媒体选题助手", exact: true })).toBeVisible();
      } else await expect(page.getByRole("listitem", { name: "自媒体选题助手", exact: true })).toHaveCount(0);
      await expect(page.locator('article.message-assistant[data-status="failed"]')).toHaveCount(0);
      expect(errors).toEqual([]);
      expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isVisible()))).toBe(false);
      // Optional screenshot capture is unreliable in hidden Windows CI windows.
      const hiddenWindowsCi = process.platform === "win32" && Boolean(process.env.CI) && process.env.AEVOREN_BOT_TEST_HIDDEN === "1";
      if (resolution === "allow-once" && !hiddenWindowsCi) await page.screenshot({ path: join(process.env.AEVOREN_PRODUCT_EVIDENCE_DIR ?? tmpdir(), "aevoren-followup-creation-fixed.png") });
    } finally {
      await application.close().catch(() => application.process().kill("SIGKILL"));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      removeTestDirectory(data);
    }
  });
}
