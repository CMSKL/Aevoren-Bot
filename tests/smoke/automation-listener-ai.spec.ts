import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import type { AevorenBotApi, ApiResult } from "../../src/shared/contracts";
import type { EventListenerControl } from "../../src/shared/event-contracts";
import { AppRepository } from "../../src/main/database";
import { closeTestApplication, removeTestDirectory } from "./test-cleanup";
const data = <T>(result: ApiResult<T>): T => { if (!result.ok) throw Error(result.error.code); return result.data; };

test("requires actual AI approval for a fixed application listener port and verifies ingress stops", async () => {
  test.setTimeout(90_000);
  const directory = mkdtempSync(join(tmpdir(), "aevoren-listener-ai-")), filename = join(directory, "aevoren-bot.sqlite"), repository = new AppRepository(filename), actor = repository.createBot();
  repository.updateBot(actor.bot.id, actor.bot.version, { name: "Listener AI fixture", mcpServerIds: [], modelSelection: { providerInstanceId: "openai-compatible.default", modelId: "listener-fixture-model" } }); repository.setSetting("memory.capture.enabled", "false", false); repository.close();
  const failures: string[] = [], toolResults: string[] = [], operations: string[] = [];
  const model = createServer(async (request, response) => {
    try {
      let body = ""; for await (const chunk of request) body += chunk;
      const command = JSON.parse(body) as { model: string; messages: { role: string; content: string }[] };
      if (request.headers.authorization !== "Bearer listener-model-fixture-key" || command.model !== "listener-fixture-model") throw Error("Unexpected controlled provider request");
      const last = command.messages.at(-1)!; const tools = last.role !== "tool";
      const user = command.messages.filter(message => message.role === "user").at(-1)!;
      const input = JSON.parse(user.content.slice(user.content.indexOf("LISTENER_CASE:") + 14));
      if (tools) operations.push(input.operation); else toolResults.push(last.content);
      const delta = tools ? { tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: { name: "product_execute", arguments: JSON.stringify(input) } }] } : { content: "Controlled listener action completed." };
      response.writeHead(200, { "Content-Type": "text/event-stream" }); response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: tools ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) { failures.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve)); const modelAddress = model.address(); if (!modelAddress || typeof modelAddress === "string") throw Error("No controlled model port");
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve)); const address = probe.address(); if (!address || typeof address === "string") throw Error("No controlled listener port"); const port = address.port; await new Promise<void>(resolve => probe.close(() => resolve()));
  const executablePath = process.env.AEVOREN_PACKAGED_APP_PATH;
  let application: ElectronApplication | undefined, passed = false;
  try {
    const app = application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : ["."], cwd: process.cwd(), env: { ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith("AEVOREN_"))), AEVOREN_BOT_USER_DATA_DIR: directory, AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_FAKE_PROVIDER: "0", AEVOREN_BOT_DISABLE_UPDATES: "1" } });
    const page = await app.firstWindow(); await page.waitForURL(pathToFileURL(join(await app.evaluate(({ app }) => app.getAppPath()), "out/renderer/index.html")).href, { waitUntil: "domcontentloaded" }); page.on("pageerror", error => failures.push(error.message)); await expect(page.getByRole("heading", { name: "Listener AI fixture", exact: true })).toBeVisible();
    if (executablePath) expect(await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion() }))).toEqual({ packaged: true, version: JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version });
    data(await page.evaluate(async baseUrl => { const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot, list = await api.providers.list(); if (!list.ok) throw Error(list.error.code); const provider = list.data.find(item => item.id === "openai-compatible.default")!; return api.providers.saveOpenAiCompatible({ instanceId: provider.id, expectedVersion: provider.version, baseUrl, apiKey: "listener-model-fixture-key" }); }, `http://127.0.0.1:${modelAddress.port}/v1`));
    const snapshot = async () => data(await page.evaluate(() => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.automationEvents.snapshot()));
    const run = async (operation: string, input: EventListenerControl, beforeListening: boolean) => {
      const sent = data(await page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.messages.send(input), { sessionId: actor.session.id, clientNonce: randomUUID(), text: `LISTENER_CASE:${JSON.stringify({ operation, input })}` }));
      const dialog = page.getByTestId("tool-permission-dialog"); await expect(dialog).toBeVisible(); await expect(dialog).toContainText(`127.0.0.1:${port}`); await expect(dialog).toContainText("影响全部会话"); await expect(dialog).toContainText("不会取消已交给 Routine");
      expect((await snapshot()).listener.listening).toBe(beforeListening);
      await dialog.getByRole("button", { name: "仅允许一次", exact: true }).click();
      await expect.poll(async () => { const result = data(await page.evaluate(sessionId => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.runtime.getSessionSnapshot(sessionId), actor.session.id)); return result.runs.find(run => run.id === sent.runId)?.state; }).toBe("completed");
    };
    const original = (await snapshot()).listener; expect(original).toMatchObject({ listening: false, busy: false });
    await run("automationEvents.startListener", { expectedRevision: original.revision, port }, false);
    const live = (await snapshot()).listener; expect(live).toMatchObject({ listening: true, host: "127.0.0.1", port, busy: false }); expect(live.revision).not.toBe(original.revision);
    const rejected = await fetch(`http://127.0.0.1:${port}/hooks/${randomUUID()}/1`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "controlled" }, body: "{}" }); expect(rejected.status).toBe(401); await rejected.arrayBuffer(); expect((await snapshot()).deliveries).toHaveLength(0);
    await run("automationEvents.stopListener", { expectedRevision: live.revision, port }, true);
    expect((await snapshot()).listener).toMatchObject({ listening: false, port: null, busy: false }); await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow();
    expect(operations).toEqual(["automationEvents.startListener", "automationEvents.stopListener"]); expect(toolResults).toHaveLength(2); expect(toolResults.every(result => JSON.parse(result).status === "completed")).toBe(true); expect(JSON.stringify(toolResults)).not.toContain("listener-model-fixture-key"); expect(failures).toEqual([]);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()))).toBe(true); passed = true;
  } finally {
    let closeFailure: unknown, normalClose = false;
    if (application) {
      const process = application.process();
      try { await closeTestApplication(application); expect({ code: process.exitCode, signal: process.signalCode }).toEqual({ code: 0, signal: null }); normalClose = true; }
      catch (error) { closeFailure = error; }
    }
    try {
      if (passed && normalClose) {
        const database = new DatabaseSync(filename, { readOnly: true });
        try { const receipts = database.prepare("SELECT state,product_result_content FROM tool_invocations WHERE tool_kind='product-call'").all() as { state: string; product_result_content: string }[]; expect(receipts).toHaveLength(2); expect(receipts.every(receipt => receipt.state === "succeeded" && JSON.parse(receipt.product_result_content).result.host === "127.0.0.1")).toBe(true); }
        finally { database.close(); }
      } else {
        const copy = test.info().outputPath("owned-listener.sqlite"); copyFileSync(filename, copy); await test.info().attach("owned-listener-database", { path: copy, contentType: "application/octet-stream" });
      }
    } finally {
      try { model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); }
      finally { try { removeTestDirectory(directory); } finally { if (closeFailure) throw closeFailure; } }
    }
  }
});
