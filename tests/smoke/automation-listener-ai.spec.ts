import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync } from "node:fs";
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

type CloseProbe = { record(phase: string): void; phases: Record<string, unknown>[]; owned: ReturnType<ElectronApplication["process"]>; detach(): void };
const CLOSE_PHASE_PREFIX = "AEVOREN_CLOSE_PHASE ";

/** Fixture-owned, bounded diagnostics only; no process arguments or application data. */
async function installCloseProbe(application: ElectronApplication): Promise<CloseProbe> {
  const owned = application.process(), started = performance.now(), phases: Record<string, unknown>[] = [];
  let exitSeen = false, closeSeen = false, buffered = "";
  const record = (phase: string): void => {
    if (phases.length >= 120) return;
    phases.push({ phase, elapsedMs: Math.round(performance.now() - started), pid: owned.pid ?? null, exitCode: owned.exitCode, signalCode: owned.signalCode,
      killed: owned.killed, exitSeen, closeSeen, stdio: owned.stdio.map(stream => stream ? { destroyed: stream.destroyed } : null) });
  };
  const exited = (): void => { exitSeen = true; record("owned-exit"); };
  const closed = (): void => { closeSeen = true; record("owned-close"); };
  const streams = owned.stdio.flatMap((stream, index) => stream ? [{ stream, listener: () => record(`stdio-${index}-close`) }] : []);
  const stderr = (chunk: Buffer): void => {
    buffered += chunk.toString("utf8"); const lines = buffered.split("\n"); buffered = lines.pop() ?? "";
    for (const line of lines) if (line.startsWith(CLOSE_PHASE_PREFIX) && phases.length < 120) {
      try { phases.push({ source: "main", ...JSON.parse(line.slice(CLOSE_PHASE_PREFIX.length)) as Record<string, unknown> }); } catch { record("invalid-main-phase"); }
    }
    if (buffered.length > 4_096) buffered = "";
  };
  owned.once("exit", exited); owned.once("close", closed); owned.stderr?.on("data", stderr);
  for (const { stream, listener } of streams) stream.once("close", listener);
  record("probe-installed");
  try {
    await application.evaluate(({ app, BrowserWindow, ipcMain }) => {
      const started = performance.now();
      const record = (phase: string, state: Record<string, unknown> = {}): void => {
        try { console.error("AEVOREN_CLOSE_PHASE " + JSON.stringify({ phase, elapsedMs: Math.round(performance.now() - started), ...state })); } catch { /* Diagnostics must not change application close behavior. */ }
      };
      const resources = (): Record<string, number> => {
        const counts: Record<string, number> = {};
        for (const name of process.getActiveResourcesInfo()) {
          if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(name) || !(name in counts) && Object.keys(counts).length >= 20) continue;
          counts[name] = (counts[name] ?? 0) + 1;
        }
        return counts;
      };
      app.on("before-quit", () => record("app-before-quit", { windows: BrowserWindow.getAllWindows().length }));
      app.on("will-quit", () => record("app-will-quit", { resources: resources() }));
      app.on("quit", (_event, exitCode) => record("app-quit", { exitCode, resources: resources() }));
      app.on("window-all-closed", () => record("app-window-all-closed", { windows: BrowserWindow.getAllWindows().length }));
      process.on("beforeExit", () => record("node-before-exit", { resources: resources() }));
      try {
        const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
        const original = DatabaseSync.prototype.close;
        DatabaseSync.prototype.close = function(this: import("node:sqlite").DatabaseSync, ...args: Parameters<typeof original>): ReturnType<typeof original> {
          const began = performance.now(); let ok = false;
          record("database-close-begin");
          try { const value = Reflect.apply(original, this, args); ok = true; return value; }
          catch (error) {
            const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^(?:ERR_SQLITE_[A-Z0-9_]+|ERR_INVALID_STATE|SQLITE_BUSY|SQLITE_LOCKED)$/u.test(error.code) ? error.code : "unknown";
            record("database-close-error", { code }); throw error;
          } finally { DatabaseSync.prototype.close = original; record("database-close-end", { ok, durationMs: Math.round(performance.now() - began) }); }
        };
        record("database-close-probe-installed");
      } catch { record("database-close-probe-unavailable"); }
      for (const window of BrowserWindow.getAllWindows()) {
        const contents = window.webContents, send = contents.send.bind(contents);
        contents.send = (channel, ...args) => {
          if (channel === "app:before-close" || channel === "app:close-blocked") record(channel, { loading: contents.isLoadingMainFrame(), destroyed: contents.isDestroyed() });
          return send(channel, ...args);
        };
        window.on("close", () => record("window-close", { loading: contents.isLoadingMainFrame() })); window.on("closed", () => record("window-closed"));
        contents.on("did-navigate", () => record("main-navigation-committed")); contents.on("did-stop-loading", () => record("loading-stopped"));
        contents.on("render-process-gone", (_event, details) => record("renderer-gone", { reason: details.reason, exitCode: details.exitCode }));
      }
      ipcMain.on("app:renderer-ready", event => record("renderer-ready", { mainFrame: event.senderFrame === event.sender.mainFrame }));
      ipcMain.on("app:confirm-close", (event, value: unknown) => record("flush-ack", { mainFrame: event.senderFrame === event.sender.mainFrame, canClose: value === true }));
    });
  } catch { record("main-probe-unavailable"); }
  return { record, phases, owned, detach() { owned.removeListener("exit", exited); owned.removeListener("close", closed); owned.stderr?.removeListener("data", stderr); for (const { stream, listener } of streams) stream.removeListener("close", listener); } };
}


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
  let application: ElectronApplication | undefined, closeProbe: CloseProbe | undefined, passed = false;
  try {
    const app = application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : ["."], cwd: process.cwd(), env: { ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith("AEVOREN_"))), AEVOREN_BOT_USER_DATA_DIR: directory, AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_FAKE_PROVIDER: "0", AEVOREN_BOT_DISABLE_UPDATES: "1" } });
    closeProbe = await installCloseProbe(app);
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
      const process = closeProbe?.owned ?? application.process();
      closeProbe?.record("fixture-close-requested");
      try {
        const target = application;
        await closeTestApplication({ close: async () => { closeProbe?.record("close-transport-called"); try { await target.close(); closeProbe?.record("close-transport-resolved"); } catch (error) { closeProbe?.record("close-transport-rejected"); throw error; } }, process: () => process });
        closeProbe?.record("fixture-close-returned"); expect({ code: process.exitCode, signal: process.signalCode }).toEqual({ code: 0, signal: null }); normalClose = true;
      } catch (error) { closeProbe?.record("fixture-close-failed"); closeFailure = error; }
    }
    try {
      const diagnostic = { businessPassed: passed, normalClose, phases: closeProbe?.phases ?? [] };
      await test.info().attach("listener-close-diagnostics", { body: JSON.stringify(diagnostic), contentType: "application/json" });
      if (process.env.AEVOREN_LISTENER_CLOSE_EVIDENCE_PATH) appendFileSync(process.env.AEVOREN_LISTENER_CLOSE_EVIDENCE_PATH, JSON.stringify(diagnostic) + "\n", { encoding: "utf8", mode: 0o600 });
      closeProbe?.detach();
      if (passed && normalClose) {
        const database = new DatabaseSync(filename, { readOnly: true });
        try { const receipts = database.prepare("SELECT state,product_result_content FROM tool_invocations WHERE tool_kind='product-call'").all() as { state: string; product_result_content: string }[]; expect(receipts).toHaveLength(2); expect(receipts.every(receipt => receipt.state === "succeeded" && JSON.parse(receipt.product_result_content).result.host === "127.0.0.1")).toBe(true); }
        finally { database.close(); }
      } else {
        const copy = test.info().outputPath("owned-listener.sqlite"); copyFileSync(filename, copy); await test.info().attach("owned-listener-database", { path: copy, contentType: "application/octet-stream" });
      }
    } finally {
      closeProbe?.detach();
      await finishOwnedCleanup();
    }
    async function finishOwnedCleanup(): Promise<void> {
      let cleanupFailure: unknown;
      try { model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); } catch (error) { cleanupFailure = error; }
      try { removeTestDirectory(directory); } catch (error) { cleanupFailure ??= error; }
      if (closeFailure) throw closeFailure;
      if (cleanupFailure) throw cleanupFailure;
    }
  }
});
