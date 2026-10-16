import { appendFileSync, copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { AevorenBotApi, ApiResult } from "../../src/shared/contracts";
import type { EventSnapshot } from "../../src/shared/event-contracts";
import { AppRepository } from "../../src/main/database";
import { closeTestApplication, removeTestDirectory } from "./test-cleanup";

const data = <T>(result: ApiResult<T>): T => { if (!result.ok) throw Error(`${result.error.code}: ${result.error.safeMessage}`); return result.data; };
type Capture = { model: string; input: unknown; response: ServerResponse; released: boolean; aborted: boolean };
const snapshot = async (page: Page): Promise<EventSnapshot> => data(await page.evaluate(() => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.automationEvents.snapshot()));
function release(capture: Capture, content = "Verified fixture completion"): void { capture.released = true; capture.response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`); }

type CloseProbe = { record(phase: string): void; phases: Record<string, unknown>[]; detach(): void };
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
      const record = (phase: string, state: Record<string, string | number | boolean> = {}): void => {
        console.error("AEVOREN_CLOSE_PHASE " + JSON.stringify({ phase, elapsedMs: Math.round(performance.now() - started), ...state }));
      };
      app.on("before-quit", () => record("app-before-quit")); app.on("will-quit", () => record("app-will-quit")); app.on("quit", () => record("app-quit"));
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
  return { record, phases, detach() { owned.removeListener("exit", exited); owned.removeListener("close", closed); owned.stderr?.removeListener("data", stderr); for (const { stream, listener } of streams) stream.removeListener("close", listener); } };
}


async function fixture(work: (f: { page: Page; app: ElectronApplication; captures: Capture[]; bots: { id: string; sessionId: string; model: string }[]; roomRoutineId: string; botRoutineId: string; taskSessionId: string; restart(): Promise<Page> }) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "aevoren-events-ui-")), path = join(directory, "aevoren-bot.sqlite"), repository = new AppRepository(path);
  const bots = Array.from({ length: 7 }, (_, index) => { const made = repository.createBot(), model = `event-fixture-${index}`; repository.updateBot(made.bot.id, made.bot.version, { name: `事件成员${index}`, mcpServerIds: [], modelSelection: { providerInstanceId: "openai-compatible.default", modelId: model } }); return { id: made.bot.id, sessionId: made.session.id, model }; });
  const room = repository.createRoom({ name: "事件六人群", leadBotId: null, memberBotIds: bots.slice(1).map(bot => bot.id) });
  const schedule = { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } as const;
  const group = repository.createRoutine({ name: "Webhook 六人 Routine", prompt: "SAVED_GROUP_PROMPT", target: { kind: "room", roomId: room.room.id, sessionId: room.session.id, routingMode: "everyone", targetBotIds: bots.slice(1).map(bot => bot.id), expectedMembershipVersion: room.room.membershipVersion }, schedule, enabled: true, nextRunAt: schedule.anchorAt });
  const botRule = repository.createRoutine({ name: "内部事件 Routine", prompt: "SAVED_METADATA_ONLY_PROMPT", botId: bots[1]!.id, schedule, enabled: true, nextRunAt: schedule.anchorAt });
  const task = repository.tasks.create({ title: "私有来源任务", parentSessionId: bots[0]!.sessionId, expectedScopeVersion: repository.tasks.scopeVersion(bots[0]!.sessionId), clientNonce: randomUUID(), selections: [{ executorBotId: bots[0]!.id, memories: [], history: [], workspaces: [], mcp: [], resourceRefs: [], mediaRefs: [], productOperations: [], network: false, clipboard: false }] });
  repository.setSetting("memory.capture.enabled", "false", false); repository.close();
  const captures: Capture[] = [], serverErrors: string[] = [], pageErrors: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      let content = ""; for await (const chunk of request) content += chunk;
      const input = JSON.parse(content); if (request.headers.authorization !== "Bearer event-model-fixture-token" || !bots.some(bot => bot.model === input.model)) throw Error("Unexpected controlled model request");
      const capture: Capture = { model: input.model, input, response, released: false, aborted: false }; captures.push(capture); response.on("close", () => { if (!capture.released) capture.aborted = true; });
      response.writeHead(200, { "Content-Type": "text/event-stream" }); response.flushHeaders(); response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: null }] })}\n\n`);
    } catch (error) { serverErrors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw Error("Missing controlled model port");
  const executablePath = process.env.AEVOREN_PACKAGED_APP_PATH;
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith("AEVOREN_"))), AEVOREN_BOT_USER_DATA_DIR: directory, AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_FAKE_PROVIDER: "0", AEVOREN_BOT_DISABLE_UPDATES: "1", AEVOREN_BOT_ROUTINE_TICK_MS: "100" };
  let app!: ElectronApplication, page!: Page, passed = false;
  let closeProbe: CloseProbe | null = null;
  let closeFailure:unknown;
  const start = async (): Promise<Page> => {
    app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : ["."], cwd: process.cwd(), env }); page = await app.firstWindow();
    page.on("pageerror", error => pageErrors.push(error.message)); await expect(page.locator(".app-shell")).toBeVisible();
    if (executablePath) expect(await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion() }))).toEqual({ packaged: true, version: JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version });
    closeProbe=await installCloseProbe(app);
    return page;
  };
  const close = async (): Promise<void> => {
    const owned = app.process(), probe=closeProbe;probe?.record("fixture-close-requested");
    const current=await snapshot(page).catch(()=>null);
    const runtimeStates=await page.evaluate(async()=>{const api=(window as unknown as {aevorenBot:AevorenBotApi}).aevorenBot,conversations=await api.conversations.list();if(!conversations.ok)return [];const results=await Promise.all(conversations.data.map(item=>api.runtime.getSessionSnapshot(item.sessionId)));return results.flatMap(result=>result.ok?result.data.runs.map(run=>({id:run.id,state:run.state,sessionId:run.sessionId})):[]);}).catch(()=>[]);
    await test.info().attach("event-before-close-state",{body:JSON.stringify({listener:current?.listener??null,deliveries:current?.deliveries.map(item=>({id:item.id,state:item.state}))??[],runtimeStates,captures:captures.map(({model,released,aborted})=>({model,released,aborted}))}),contentType:"application/json"});
    try { await closeTestApplication(app);probe?.record("fixture-close-returned");expect({ code: owned.exitCode, signal: owned.signalCode }).toEqual({ code: 0, signal: null }); }
    finally {
      const phases=probe?.phases??[];
      await test.info().attach("event-close-phases",{body:JSON.stringify(phases),contentType:"application/json"});
      const evidencePath=process.env.AEVOREN_EVENT_CLOSE_EVIDENCE_PATH;
      if(evidencePath)appendFileSync(evidencePath,JSON.stringify({test:test.info().title,phases,state:{listener:current?.listener??null,deliveries:current?.deliveries.map(item=>({id:item.id,state:item.state}))??[],runtimeStates,captures:captures.map(({model,released,aborted})=>({model,released,aborted}))}})+"\n",{encoding:"utf8",mode:0o600});
      probe?.detach();closeProbe=null;
    }
  };
  try {
    await start();
    data(await page.evaluate(async baseUrl => { const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot, providers = dataProvider(await api.providers.list()); function dataProvider<T>(result: ApiResult<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; } const provider = providers.find(item => item.id === "openai-compatible.default")!; return api.providers.saveOpenAiCompatible({ instanceId: provider.id, expectedVersion: provider.version, baseUrl, apiKey: "event-model-fixture-token" }); }, `http://127.0.0.1:${address.port}/v1`));
    await page.getByRole("button", { name: "设置", exact: true }).click(); await page.getByRole("button", { name: "事件与 Webhook", exact: true }).click();
    await work({ page, app, captures, bots, roomRoutineId: group.id, botRoutineId: botRule.id, taskSessionId: task.session.id, restart: async () => { await close(); return start(); } });
    expect(serverErrors).toEqual([]); expect(pageErrors).toEqual([]); expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()))).toBe(true); passed = true;
  } finally {
    if (!passed && page && !page.isClosed()) await test.info().attach("event-controlled-states", { body: JSON.stringify({ captures: captures.map(({ model, input, released, aborted }) => ({ model, input, released, aborted })), snapshot: await snapshot(page).catch(() => null) }), contentType: "application/json" });
    for (const capture of captures) capture.response.destroy();
    try { if (app && app.process().exitCode === null) await close(); }
    catch(error) { passed=false;closeFailure=error; }
    finally {
      if (!passed) { const copy = test.info().outputPath("owned-event.sqlite"); copyFileSync(path, copy); await test.info().attach("owned-event-database", { path: copy, contentType: "application/octet-stream" }); }
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); removeTestDirectory(directory);
    }
  }
  if(closeFailure)throw closeFailure;
}

test("routes authenticated Webhook data to all six saved members once and revokes only that batch", async () => {
  test.setTimeout(90_000);
  await fixture(async ({ page, captures, bots, roomRoutineId, restart }) => {
    await expect(page.getByText("监听已停止 · 默认不启动", { exact: true })).toBeVisible();
    await page.getByLabel("事件订阅名称", { exact: true }).fill("本机六人事件"); await page.getByLabel("事件目标 Routine", { exact: true }).selectOption(roomRoutineId); await page.getByLabel("启用事件订阅", { exact: true }).check(); await page.getByRole("button", { name: "保存事件订阅", exact: true }).click();
    const card = page.locator(".automation-event-card").filter({ has: page.getByText(/^本机六人事件 · v/) }); await expect(card).toContainText("已启用"); await card.getByRole("button", { name: "更换密钥", exact: true }).click(); await page.getByRole("button", { name: "确认更换密钥", exact: true }).click();
    const token = await page.getByLabel("一次性 Bearer token", { exact: true }).inputValue(); expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); await page.getByRole("button", { name: "关闭密钥显示", exact: true }).click(); await expect(page.getByLabel("一次性 Bearer token", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "启动本机监听", exact: true }).click(); await expect.poll(async () => (await snapshot(page)).listener.listening).toBe(true);
    const ready = await snapshot(page), hook = ready.subscriptions.find(hook => hook.name === "本机六人事件")!, url = `http://127.0.0.1:${ready.listener.port}${hook.webhookPath}`;
    expect(JSON.stringify(ready)).not.toContain(token); expect((await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "fixture:bad", Authorization: "Bearer wrong" }, body: "invalid" })).status).toBe(401);
    const oversized = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "fixture:oversized", Authorization: `Bearer ${token}` }, body: JSON.stringify({ value: "x".repeat(65_536) }) });
    expect(oversized.status).toBe(413); await oversized.arrayBuffer(); expect(captures).toHaveLength(0); expect((await snapshot(page)).deliveries).toHaveLength(0);
    const options = { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "fixture:one", Authorization: `Bearer ${token}` }, body: JSON.stringify({ instruction: "UNTRUSTED_EVENT_PAYLOAD", approval: true }) };
    const first = await fetch(url, options); expect(first.status).toBe(202); const receipt = await first.json() as { id: string };
    const again = await fetch(url, options); expect(again.status).toBe(202); expect((await again.json() as { id: string }).id).toBe(receipt.id);
    await expect.poll(() => captures.length).toBe(6); expect(captures.every(capture => !capture.released && !capture.aborted)).toBe(true); expect(new Set(captures.map(capture => capture.model)).size).toBe(6);
    for (const capture of captures) { const content = JSON.stringify(capture.input); expect(content).toContain("SAVED_GROUP_PROMPT"); expect(content).toContain("automation-event.json"); expect(content).toContain("UNTRUSTED_EVENT_PAYLOAD"); }
    data(await page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.messages.send(input), { sessionId: bots[0]!.sessionId, clientNonce: randomUUID(), text: "Independent sibling task" })); await expect.poll(() => captures.length).toBe(7);
    await card.getByRole("button", { name: "更换密钥", exact: true }).click(); await page.getByRole("button", { name: "确认更换密钥", exact: true }).click(); await expect.poll(() => captures.slice(0, 6).every(capture => capture.aborted)).toBe(true); expect(captures[6]!.aborted).toBe(false);
    expect((await fetch(url, options)).status).toBe(401); release(captures[6]!);
    await expect.poll(async () => (await snapshot(page)).deliveries.find(item => item.id === receipt.id)?.state).toBe("cancelled"); await page.getByRole("button", { name: "关闭密钥显示", exact: true }).click();
    await page.reload(); await expect(page.locator(".app-shell")).toBeVisible(); expect((await snapshot(page)).listener.listening).toBe(true); expect((await snapshot(page)).deliveries).toHaveLength(1);
    page = await restart(); expect((await snapshot(page)).listener).toMatchObject({ listening: false, host: "127.0.0.1", port: null, busy: false }); expect((await snapshot(page)).deliveries).toHaveLength(1); expect((await snapshot(page)).subscriptions[0]!.hasToken).toBe(true);
  });
});

test("emits private TASK completion as metadata only and preserves a stale subscription editor", async () => {
  test.setTimeout(90_000);
  await fixture(async ({ page, captures, bots, botRoutineId, taskSessionId }) => {
    await page.getByLabel("事件订阅名称", { exact: true }).fill("私有任务完成事件"); await page.getByLabel("事件来源", { exact: true }).selectOption("runtime.completed"); await page.getByLabel("事件来源会话", { exact: true }).selectOption(taskSessionId); await page.getByLabel("事件目标 Routine", { exact: true }).selectOption(botRoutineId); await page.getByLabel("启用事件订阅", { exact: true }).check(); await page.getByRole("button", { name: "保存事件订阅", exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).subscriptions.length).toBe(1);
    data(await page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.messages.send(input), { sessionId: taskSessionId, clientNonce: randomUUID(), text: "PRIVATE_TASK_USER_CONTENT" })); await expect.poll(() => captures.length).toBe(1); expect(captures[0]!.model).toBe(bots[0]!.model); release(captures[0]!, "PRIVATE_TASK_ASSISTANT_CONTENT");
    await expect.poll(() => captures.length).toBe(2); expect(captures[1]!.model).toBe(bots[1]!.model); const forwarded = JSON.stringify(captures[1]!.input); expect(forwarded).toContain("SAVED_METADATA_ONLY_PROMPT"); expect(forwarded).toContain("automation-event.json"); expect(forwarded).toContain(taskSessionId); expect(forwarded).not.toContain("PRIVATE_TASK_USER_CONTENT"); expect(forwarded).not.toContain("PRIVATE_TASK_ASSISTANT_CONTENT"); release(captures[1]!);
    await expect.poll(async () => (await snapshot(page)).deliveries.length).toBe(1); await page.getByRole("button", { name: "编辑订阅", exact: true }).click(); await page.getByLabel("事件订阅名称", { exact: true }).fill("保留正在编辑的事件名称");
    const old = (await snapshot(page)).subscriptions[0]!; data(await page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.automationEvents.update(input), { id: old.id, expectedVersion: old.version, patch: { name: "后台修改名称" } }));
    await expect(page.getByText("订阅版本已变化，当前编辑未被覆盖。", { exact: false })).toBeVisible(); await page.getByRole("button", { name: "保存事件订阅", exact: true }).click(); await expect(page.getByRole("alert")).toContainText("版本已变化"); await expect(page.getByLabel("事件订阅名称", { exact: true })).toHaveValue("保留正在编辑的事件名称");
    await page.getByRole("button", { name: "读取最新版本，保留编辑", exact: true }).click(); await page.getByRole("button", { name: "保存事件订阅", exact: true }).click(); await expect.poll(async () => (await snapshot(page)).subscriptions[0]!.name).toBe("保留正在编辑的事件名称"); expect(captures).toHaveLength(2);
    await page.setViewportSize({ width: 620, height: 820 }); expect(await page.locator(".automation-events-panel").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  });
});
