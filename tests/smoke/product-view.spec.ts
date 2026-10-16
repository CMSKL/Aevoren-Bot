import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _electron as electron, expect, test } from "@playwright/test";
import type { AevorenBotApi } from "../../src/shared/contracts";
import { PRODUCT_VIEW_DOM_EVENT, type ProductViewInput, type ProductViewResult } from "../../src/shared/product-view";
import { AppRepository } from "../../src/main/database";
import { removeTestDirectory } from "./test-cleanup";

// Browser plugin not available. Hidden Electron validates actual Renderer/IPC state;
// this deterministic HTTP fixture makes no claim of a real model response.
test("runs semantic view operations through host approval and preserves changed drafts", async () => {
  test.setTimeout(120_000);
  const data = mkdtempSync(join(tmpdir(), "aevoren-product-view-"));
  const repository = new AppRepository(join(data, "aevoren-bot.sqlite"));
  const actor = repository.createBot();
  repository.updateBot(actor.bot.id, actor.bot.version, { name: "界面操作验收", modelSelection: { providerInstanceId: "openai-compatible.default", modelId: "fixture-view-model" } });
  repository.setSetting("memory.capture.enabled", "false", false);
  repository.close();
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const command = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
    const user = command.messages.filter((message) => message.role === "user").at(-1)!;
    const input = JSON.parse(user.content.slice(user.content.indexOf("UICASE:") + 7)) as ProductViewInput;
    const tools = command.messages.at(-1)?.role !== "tool";
    response.writeHead(200, { "content-type": "text/event-stream" });
    const delta = tools ? { tool_calls: [{ index: 0, id: crypto.randomUUID(), type: "function", function: { name: "product_execute", arguments: JSON.stringify({ operation: "view.request", input }) } }] } : { content: "界面请求已处理。" };
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: tools ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture server unavailable");
  const executablePath = process.env.AEVOREN_PACKAGED_APP_PATH;
  const application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : ["."], cwd: process.cwd(), env: { ...process.env, AEVOREN_BOT_FAKE_PROVIDER: "0", AEVOREN_BOT_USER_DATA_DIR: data, AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_DISABLE_UPDATES: "1" } });
  try {
    const page = await application.firstWindow();
    if (executablePath) expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    await expect(page.getByRole("heading", { name: "界面操作验收", exact: true })).toBeVisible();
    await page.evaluate(async (baseUrl) => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const providers = await api.providers.list(); const provider = providers.ok ? providers.data.find((item) => item.id === "openai-compatible.default") : undefined;
      if (!provider) throw new Error("API source unavailable");
      const result = await api.providers.saveOpenAiCompatible({ instanceId: provider.id, expectedVersion: provider.version, baseUrl, apiKey: "view-fixture-token" });
      if (!result.ok) throw new Error(result.error.code);
    }, `http://127.0.0.1:${address.port}/v1`);
    const run = async (input: ProductViewInput) => {
      const sent = await page.evaluate(async ({ sessionId, input }) => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.messages.send({ sessionId, clientNonce: crypto.randomUUID(), text: `UICASE:${JSON.stringify(input)}` }), { sessionId: actor.session.id, input });
      if (!sent.ok) throw new Error(sent.error.code);
      await expect.poll(async () => {
        const approvals = await page.evaluate(async (sessionId) => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.approvals.listPending({ sessionId }), actor.session.id);
        return approvals.ok ? approvals.data.length : 0;
      }).toBeGreaterThan(0);
      const approvals = await page.evaluate(async (sessionId) => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.approvals.listPending({ sessionId }), actor.session.id);
      if (!approvals.ok) throw new Error("Approval missing");
      for (const approval of approvals.data) await page.evaluate(async (input) => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.approvals.resolve(input), { sessionId: actor.session.id, id: approval.id, expectedVersion: approval.version, resolution: "allow-once" as const });
      await expect.poll(async () => {
        const snapshot = await page.evaluate(async (sessionId) => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.runtime.getSessionSnapshot(sessionId), actor.session.id);
        return snapshot.ok ? snapshot.data.runs.find((item) => item.id === sent.data.runId)?.state : null;
      }).toBe("completed");
    };
    await run({ action: "open_settings", section: "capabilities" });
    await expect(page.getByRole("heading", { name: "能力与权限", exact: true })).toBeVisible();
    await expect(page.locator('[data-capability="product.operations"]')).toContainText("可用");
    await run({ action: "open_chats" });
    await expect(page.getByLabel("消息", { exact: true })).toBeVisible();
    await run({ action: "sidebar_search", query: "界面操作验收" });
    await expect(page.getByLabel("搜索聊天")).toHaveValue("界面操作验收");
    await run({ action: "task_details", sessionId: actor.session.id, tab: "records" });
    await expect(page.getByRole("tab", { name: /^执行记录/u })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("complementary", { name: "会话成果", exact: true }).getByRole("button", { name: "关闭会话成果", exact: true }).click();
    await page.getByLabel("消息", { exact: true }).fill("用户尚未发送的草稿");
    const currentDraft = await page.evaluate(name => new Promise<ProductViewResult>(resolve => {
      window.dispatchEvent(new CustomEvent(name, { detail: { request: { id: crypto.randomUUID(), input: { action: "draft_get" } }, respond: resolve } }));
    }), PRODUCT_VIEW_DOM_EVENT);
    expect(currentDraft.status).toBe("completed");
    const draftVersion = (currentDraft.result as { draftVersion: number }).draftVersion;
    expect(typeof draftVersion).toBe("number");
    await run({ action: "draft_update", sessionId: actor.session.id, expectedDigest: "0".repeat(64), expectedDraftVersion: draftVersion, text: "不应覆盖用户草稿" });
    await expect(page.getByLabel("消息", { exact: true })).toHaveValue("用户尚未发送的草稿");
    expect(errors).toEqual([]);
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isVisible()))).toBe(false);
    await page.screenshot({ path: join(process.env.AEVOREN_PRODUCT_EVIDENCE_DIR ?? tmpdir(), "product-view-draft-protection.png") });
  } finally {
    await application.close().catch(() => application.process().kill("SIGKILL"));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    removeTestDirectory(data);
  }
});
