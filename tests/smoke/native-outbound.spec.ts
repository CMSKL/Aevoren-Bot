import { createServer, type ServerResponse } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { AevorenBotApi, ApiResult } from "../../src/shared/contracts";
import type { ConnectorDraftResult, NativeConnection } from "../../src/shared/native-connector-contracts";
import type { NativeOutboundIntent } from "../../src/shared/native-outbound-contracts";
import { AppRepository } from "../../src/main/database";
import { closeTestApplication, disposeTestApplication, removeTestDirectory } from "./test-cleanup";
import { openInspector, selectDetailsTab, selectNavigationTab } from "./navigation";

const parentId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const createdId = "33333333-3333-4333-8333-333333333333";
const targetPageId = "55555555-5555-4555-8555-555555555555";
const blockId = "44444444-4444-4444-8444-444444444444";
function unwrap<T>(result: ApiResult<T>): T { if (!result.ok) throw new Error(result.error.code); return result.data; }
function json(response: ServerResponse, value: unknown, status = 200): void { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); }
type FixtureBot = { id: string; sessionId: string; name: string };
type Fixture = { application: ElectronApplication; page: Page; bot: FixtureBot; bots: FixtureBot[]; room: { id: string; sessionId: string; name: string }; writes: Record<string, unknown>[]; mode(value: "confirmed" | "ambiguous"): void; restart(): Promise<void> };
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

async function withOutbound(callback: (fixture: Fixture) => Promise<void>): Promise<void> {
  const data = mkdtempSync(join(tmpdir(), "aevoren-native-outbound-"));
  const repository = new AppRepository(join(data, "aevoren-bot.sqlite"));
  const bots = Array.from({ length: 6 }, (_, index) => {
    const created = repository.createBot(); const bot = repository.updateBot(created.bot.id, created.bot.version, { name: index === 0 ? "外发验收成员" : `外发验收成员${index + 1}` });
    return { id: bot.id, sessionId: created.session.id, name: bot.name };
  });
  const room = repository.createRoom({ name: "外发并行验收群", memberBotIds: bots.map(bot => bot.id), leadBotId: null });
  repository.setSetting("memory.capture.enabled", "false", false); repository.close();
  const writes: Record<string, unknown>[] = []; const errors: string[] = []; let mode: "confirmed" | "ambiguous" = "confirmed"; let targetTitle = "ORIGINAL_TARGET_TITLE"; let appendedText = "";
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.headers["x-aevoren-native-host"] !== "api.notion.com" || request.headers.authorization !== "Bearer outbound-fixture-token" || request.headers["notion-version"] !== "2026-03-11") throw new Error("Unexpected provider credentials");
      if (url.pathname === "/v1/users/me") json(response, { type: "bot", id: accountId, name: "fixture", bot: { workspace_name: "Fixed fixture account" } });
      else if (url.pathname === `/v1/pages/${targetPageId}`) {
        if (request.method === "PATCH") {
          let body = ""; for await (const chunk of request) body += chunk;
          const content = JSON.parse(body) as Record<string, unknown>; writes.push(content);
          targetTitle = (content.properties as { "frozen-title-id": { title: { text: { content: string } }[] } })["frozen-title-id"].title[0]!.text.content;
          if (mode === "ambiguous") { json(response, { additional_data: { retry_guidance: "read_object" } }, 503); return; }
        }
        json(response, { object: "page", id: targetPageId, parent: { type: "data_source_id", data_source_id: parentId }, last_edited_time: "2026-10-14T00:00:00.000Z", properties: { CustomName: { id: "frozen-title-id", type: "title", title: [{ type: "text", text: { content: targetTitle }, plain_text: targetTitle }] } } });
      } else if (url.pathname === `/v1/blocks/${targetPageId}/children` && request.method === "PATCH") {
        let body = ""; for await (const chunk of request) body += chunk;
        const content = JSON.parse(body) as Record<string, unknown>; writes.push(content);
        appendedText = (content.children as { paragraph: { rich_text: { text: { content: string } }[] } }[])[0]!.paragraph.rich_text[0]!.text.content;
        json(response, { additional_data: { committed_resource_id: targetPageId, committed_child_ids: [blockId], retry_guidance: "read_object" } }, 503);
      } else if (url.pathname === `/v1/blocks/${blockId}` && request.method === "GET") {
        json(response, { object: "block", id: blockId, parent: { type: "page_id", page_id: targetPageId }, type: "paragraph", has_children: false, paragraph: { rich_text: [{ type: "text", text: { content: appendedText }, plain_text: appendedText }] } });
      } else if (url.pathname === "/v1/pages" && request.method === "POST") {
        let body = ""; for await (const chunk of request) body += chunk;
        const content = JSON.parse(body) as Record<string, unknown>; writes.push(content);
        if (mode === "confirmed") json(response, { id: createdId, object: "page" });
        else json(response, { object: "error", code: "service_unavailable", additional_data: { committed_resource_id: createdId, retry_guidance: "reconcile" } }, 503);
      } else if (url.pathname === `/v1/pages/${createdId}`) {
        const content = writes.at(-1)!;
        const properties = content.properties as Record<string, unknown>;
        const sourceTitle = properties.title as { title: { text: { content: string } }[] };
        json(response, { id: createdId, object: "page", parent: { type: "page_id", page_id: parentId }, in_trash: false, properties: { title: { type: "title", title: [{ plain_text: sourceTitle.title[0]!.text.content }] } } });
      } else if (url.pathname === `/v1/blocks/${createdId}/children`) {
        const content = writes.at(-1)!; const children = content.children as { paragraph: { rich_text: { text: { content: string } }[] } }[];
        json(response, { has_more: false, results: children.map(child => ({ id: blockId, type: "paragraph", has_children: false, paragraph: { rich_text: [{ plain_text: child.paragraph.rich_text[0]!.text.content }] } })) });
      } else throw new Error(`Unexpected provider operation ${request.method} ${url.pathname}`);
    } catch (error) { errors.push(String(error)); response.writeHead(500); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture unavailable"); const fixturePort = address.port;
  let application: ElectronApplication | undefined; let page: Page;
  const probes = new WeakMap<ElectronApplication, CloseProbe>(), installedProbes: CloseProbe[] = []; let closeAttempt = 0;
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith("AEVOREN_BOT_")));
  const executablePath = process.env.AEVOREN_PACKAGED_APP_PATH ?? process.env.AEVOREN_BOT_PACKAGED_EXECUTABLE;
  async function launch(): Promise<void> {
    application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : ["."], cwd: process.cwd(), env: { ...environment, AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_USER_DATA_DIR: data, AEVOREN_BOT_FAKE_PROVIDER: "1", AEVOREN_BOT_DISABLE_UPDATES: "1", AEVOREN_BOT_NATIVE_TEST_ORIGIN: `http://127.0.0.1:${fixturePort}` } });
    page = await application.firstWindow(); page.on("pageerror", error => errors.push(error.message)); await expect(page.locator(".app-shell")).toBeVisible();
    const probe = await installCloseProbe(application); probes.set(application, probe); installedProbes.push(probe);
    if (executablePath) {
      const runtime = await application.evaluate(({ app }) => ({ isPackaged: app.isPackaged, version: app.getVersion(), resourcesPath: process.resourcesPath }));
      expect(runtime.isPackaged).toBe(true);
      expect(runtime.version).toBe(JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version);
      expect(existsSync(join(runtime.resourcesPath, "docs", "NATIVE_OUTBOUND.md"))).toBe(true);
      await test.info().attach("actual-native-outbound-package", { body: JSON.stringify(runtime), contentType: "application/json" });
    }
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1182, 804));
  }
  async function closeOwned(phase: "restart" | "cleanup"): Promise<void> {
    const owned = application!, probe = probes.get(owned), attempt = ++closeAttempt; probe?.record(`${phase}-close-request`);
    try {
      if (phase === "restart") { await closeTestApplication(owned); probe?.record("restart-close-resolved"); }
      else { const graceful = await disposeTestApplication(owned); probe?.record(graceful ? "cleanup-close-resolved" : "cleanup-disposed-after-close-failure"); }
    }
    catch (error) { probe?.record(`${phase}-close-rejected`); throw error; }
    finally { if (probe) await test.info().attach(`native-outbound-close-${attempt}-${phase}`, { body: JSON.stringify({ phase, phases: probe.phases }), contentType: "application/json" }); }
  }
  try {
    await launch();
    const fixture: Fixture = { application: application!, page: page!, bot: bots[0]!, bots, room: { id: room.room.id, sessionId: room.session.id, name: room.room.name }, writes, mode(value) { mode = value; }, async restart() { await closeOwned("restart"); await launch(); fixture.application = application!; fixture.page = page; } };
    await callback(fixture); expect(errors).toEqual([]); expect(await application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible()))).toBe(false);
  } finally { server.closeAllConnections(); try { if (application) await closeOwned("cleanup"); } finally { installedProbes.forEach(probe => probe.detach()); } await new Promise<void>(resolve => server.close(() => resolve())); removeTestDirectory(data); }
}

async function setup(f: Fixture): Promise<NativeConnection> {
  const { page } = f;
  const connection = unwrap(await page.evaluate(async () => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.connectors.configure({ provider: "notion", name: "Outbound fixture", token: "outbound-fixture-token" })));
  const verified = unwrap(await page.evaluate(async input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.connectors.authorize(input), { id: connection.id, expectedVersion: connection.version }));
  unwrap(await page.evaluate(async input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.connectors.bind(input), { sessionId: f.bot.sessionId, executorBotId: f.bot.id, connectionId: verified.id, expectedAuthVersion: verified.authVersion }));
  await openApps(f, verified.id); return verified;
}
async function openApps(f: Fixture, connectionId: string): Promise<void> {
  await selectNavigationTab(f.page, "联系人"); await f.page.locator(".sidebar").getByRole("listitem", { name: f.bot.name, exact: true }).click(); await selectDetailsTab(f.page, "应用"); await f.page.getByLabel("当前聊天的应用连接").selectOption(connectionId);
}
async function saveDraft(f: Fixture, title: string, scope = { sessionId: f.bot.sessionId, executorBotId: f.bot.id }): Promise<ConnectorDraftResult> {
  await f.page.getByRole("button", { name: "新建本地草稿", exact: true }).click(); await f.page.getByLabel("Notion 草稿父页面").fill(parentId); await f.page.getByLabel("文件草稿标题").fill(title); await f.page.getByLabel("文件草稿正文").fill("FROZEN_BODY <script>no execution</script>"); await f.page.getByRole("button", { name: "保存本地草稿", exact: true }).click(); await expect(f.page.getByText("本地草稿已保存 · 版本 1。尚未向外部应用提交。", { exact: true })).toBeVisible();
  return f.page.evaluate(async scope => { const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot; const result = await api.drafts.list(scope); if (!result.ok) throw new Error(result.error.code); const read = await api.drafts.read({ ...scope, id: result.data[0]!.id }); if (!read.ok) throw new Error(read.error.code); return read.data; }, scope);
}
async function grantAndPrepare(f: Fixture): Promise<void> {
  await f.page.getByRole("button", { name: "授权当前成员写入此目标", exact: true }).click(); await f.page.getByRole("button", { name: "确认成员写授权", exact: true }).click(); await expect(f.page.getByText("已授权此账号、操作和目标；每次外发仍需批准固定内容。", { exact: true })).toBeVisible(); await f.page.getByRole("button", { name: "准备此保存版本外发", exact: true }).click(); await expect(f.page.getByRole("article", { name: "准备外发的固定版本" })).toBeVisible();
}
async function intents(f: Fixture): Promise<NativeOutboundIntent[]> { return unwrap(await f.page.evaluate(async scope => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.outbound.list(scope), { sessionId: f.bot.sessionId, executorBotId: f.bot.id })); }

test("approved native outbound uses one frozen revision and invalidates an edited pending approval", async () => {
  test.setTimeout(90_000);
  await withOutbound(async f => {
    await setup(f); const draft = await saveDraft(f, "FROZEN_TITLE"); await grantAndPrepare(f);
    expect(f.writes).toHaveLength(0);
    await f.page.getByRole("button", { name: "审阅并批准此版本", exact: true }).click();
    const dialog = f.page.getByTestId("tool-permission-dialog"); await expect(dialog.getByRole("region", { name: "本次外发固定快照" })).toBeVisible();
    await expect(dialog).toContainText("FROZEN_TITLE"); await expect(dialog).toContainText("Fixed fixture account");
    await expect(dialog.getByRole("button", { name: "仅允许一次", exact: true })).toBeEnabled();
    unwrap(await f.page.evaluate(async input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.drafts.update(input), { sessionId: f.bot.sessionId, executorBotId: f.bot.id, id: draft.draft.id, expectedVersion: draft.draft.version, content: { kind: "notion-page" as const, parentPageId: parentId, title: "LATER_CHANGED_TITLE", text: "LATER_CHANGED_BODY" } }));
    await expect(dialog.getByRole("button", { name: "仅允许一次", exact: true })).toBeDisabled();
    await expect(dialog).toContainText("FROZEN_TITLE"); expect(f.writes).toHaveLength(0);
    await dialog.getByRole("button", { name: "拒绝", exact: true }).click(); await expect(dialog).toHaveCount(0);
    expect(f.writes).toHaveLength(0);
  });
});

test("unknown native outcome reconciles read-only after restart and never resends", async () => {
  test.setTimeout(90_000);
  await withOutbound(async f => {
    const connection = await setup(f); await saveDraft(f, "UNKNOWN_FROZEN_TITLE"); await grantAndPrepare(f); f.mode("ambiguous");
    await f.page.getByRole("button", { name: "审阅并批准此版本", exact: true }).click(); const dialog = f.page.getByTestId("tool-permission-dialog"); await expect(dialog.getByRole("button", { name: "仅允许一次", exact: true })).toBeEnabled(); await dialog.getByRole("button", { name: "仅允许一次", exact: true }).click(); await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await intents(f))[0]?.state).toBe("unknown"); expect(f.writes).toHaveLength(1);
    await expect(f.page.getByRole("button", { name: "只读核对此次结果", exact: true })).toBeVisible(); await expect(f.page.getByRole("button", { name: "准备此保存版本外发", exact: true })).toBeDisabled();
    await f.restart(); await openApps(f, connection.id); await expect(f.page.getByRole("button", { name: "只读核对此次结果", exact: true })).toBeVisible();
    await f.page.getByRole("button", { name: "只读核对此次结果", exact: true }).click(); await expect.poll(async () => (await intents(f))[0]?.state).toBe("confirmed"); expect(f.writes).toHaveLength(1);
    await expect(f.page.getByText(`第三方结果 ID：${createdId}`, { exact: true })).toBeVisible(); await expect(f.page.getByRole("button", { name: "只读核对此次结果", exact: true })).toHaveCount(0);
    const sentTitle = ((f.writes[0]!.properties as { title: { title: { text: { content: string } }[] } }).title.title[0]!.text.content); expect(sentTitle).toBe("UNKNOWN_FROZEN_TITLE");
    // Match native read diagnostics: hidden Windows capture is optional;
    // receipt, no-resend and hidden-window assertions remain mandatory.
    if (process.platform !== "win32") await f.page.screenshot({ path: join(tmpdir(), "aevoren-native-outbound-confirmed.png") });
  });
});

test("one approved saved revision submits once, and a revoked grant blocks a later approval", async () => {
  test.setTimeout(90_000);
  await withOutbound(async f => {
    await setup(f); await saveDraft(f, "CONFIRMED_FROZEN_TITLE"); await grantAndPrepare(f);
    await f.page.getByRole("button", { name: "审阅并批准此版本", exact: true }).click();
    const dialog = f.page.getByTestId("tool-permission-dialog"); await expect(dialog.getByRole("button", { name: "仅允许一次", exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: "仅允许一次", exact: true }).click();
    await expect.poll(async () => (await intents(f))[0]?.state).toBe("confirmed"); expect(f.writes).toHaveLength(1);
    await expect(f.page.getByRole("button", { name: "准备此保存版本外发", exact: true })).toBeDisabled();
    await f.page.getByRole("button", { name: "刷新外发状态", exact: true }).click(); expect(f.writes).toHaveLength(1);
    await saveDraft(f, "REVOKED_FROZEN_TITLE");
    await f.page.getByRole("button", { name: "准备此保存版本外发", exact: true }).click();
    await f.page.getByRole("button", { name: "审阅并批准此版本", exact: true }).click(); await expect(dialog.getByRole("button", { name: "仅允许一次", exact: true })).toBeEnabled();
    const grants = unwrap(await f.page.evaluate(async scope => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.outbound.writeGrants(scope), { sessionId: f.bot.sessionId, executorBotId: f.bot.id }));
    const grant = grants.find(value => value.revokedAt === null)!;
    unwrap(await f.page.evaluate(async input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.outbound.revokeWrite(input), { sessionId: f.bot.sessionId, executorBotId: f.bot.id, id: grant.id, expectedVersion: grant.version }));
    await expect(dialog.getByRole("button", { name: "仅允许一次", exact: true })).toBeDisabled();
    await expect(dialog).toContainText("REVOKED_FROZEN_TITLE"); expect(f.writes).toHaveLength(1);
    await dialog.getByRole("button", { name: "拒绝", exact: true }).click();
    expect(f.writes).toHaveLength(1);
  });
});

test("six group outbound approvals start together and stopping one preserves the other five", async () => {
  test.setTimeout(90_000);
  await withOutbound(async f => {
    const connection = await setup(f);
    const prepared = await f.page.evaluate(async input => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const intents = await Promise.all(input.botIds.map(async (executorBotId, index) => {
        const scope = { sessionId: input.sessionId, executorBotId };
        const binding = await api.connectors.bind({ ...scope, connectionId: input.connectionId, expectedAuthVersion: input.authVersion });
        if (!binding.ok) throw new Error(binding.error.code);
        const grant = await api.outbound.grantWrite({ ...scope, connectionId: input.connectionId, expectedAuthVersion: input.authVersion, operation: "notion-create-page", targetIds: [input.parentId] });
        if (!grant.ok) throw new Error(grant.error.code);
        const draft = await api.drafts.create({ ...scope, connectionId: input.connectionId, expectedAuthVersion: input.authVersion, expectedBindingVersion: binding.data.version, content: { kind: "notion-page", parentPageId: input.parentId, title: `GROUP_FIXED_${index + 1}`, text: `GROUP_BODY_${index + 1}` } });
        if (!draft.ok) throw new Error(draft.error.code);
        const intent = await api.outbound.prepare({ ...scope, draftId: draft.data.draft.id, revisionId: draft.data.revision.id, expectedDraftVersion: draft.data.draft.version, grantId: grant.data.id, expectedGrantVersion: grant.data.version });
        if (!intent.ok) throw new Error(intent.error.code);
        return intent.data;
      }));
      return Promise.all(intents.map(async intent => {
        const approval = await api.outbound.requestApproval({ sessionId: intent.sessionId, executorBotId: intent.executorBotId, id: intent.id, expectedVersion: intent.version });
        if (!approval.ok) throw new Error(approval.error.code);
        return { intentId: intent.id, runId: approval.data.invocation.runtimeRunId };
      }));
    }, { botIds: f.bots.map(bot => bot.id), sessionId: f.room.sessionId, connectionId: connection.id, authVersion: connection.authVersion, parentId });
    expect(prepared).toHaveLength(6);
    expect(f.writes).toHaveLength(0);
    const snapshot = async () => unwrap(await f.page.evaluate(async roomId => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.roomRuntime.getSnapshot(roomId), f.room.id));
    const before = await snapshot();
    expect(before.runs).toHaveLength(6);
    expect(before.runs.every(run => run.route === "host-outbound" && run.state === "running")).toBe(true);
    await selectNavigationTab(f.page, "聊天");
    await f.page.locator(".bot-row").filter({ hasText: f.room.name }).click();
    const dialog = f.page.getByTestId("tool-permission-dialog");
    await expect(dialog).toHaveCount(1);
    await expect(dialog.getByRole("button", { name: "仅允许一次", exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: "停止任务", exact: true }).click();
    await expect.poll(async () => (await snapshot()).runs.filter(run => run.state === "cancelled").length).toBe(1);
    const stopped = await snapshot();
    expect(stopped.runs.filter(run => run.state === "running")).toHaveLength(5);
    expect(f.writes).toHaveLength(0);
    for (let completed = 1; completed <= 5; completed += 1) {
      await expect(dialog.getByRole("button", { name: "仅允许一次", exact: true })).toBeEnabled();
      await dialog.getByRole("button", { name: "仅允许一次", exact: true }).click();
      await expect.poll(async () => (await snapshot()).runs.filter(run => run.state === "completed").length).toBe(completed);
    }
    await expect(dialog).toHaveCount(0);
    expect(f.writes).toHaveLength(5);
    const final = await snapshot();
    expect(final.runs.filter(run => run.state === "cancelled")).toHaveLength(1);
    expect(final.runs.filter(run => run.state === "completed")).toHaveLength(5);
    // Start another host action while the group is already open. Its Runtime
    // need not have arrived in the renderer before the approval's Stop button.
    await f.page.evaluate(async input => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const scope = { sessionId: input.sessionId, executorBotId: input.botId };
      const bindings = await api.connectors.bindings(scope); const grants = await api.outbound.writeGrants(scope);
      if (!bindings.ok || !grants.ok) throw new Error("Scope unavailable");
      const binding = bindings.data.find(value => value.connectionId === input.connectionId)!;
      const grant = grants.data.find(value => value.connectionId === input.connectionId && value.revokedAt === null)!;
      const draft = await api.drafts.create({ ...scope, connectionId: input.connectionId, expectedAuthVersion: input.authVersion, expectedBindingVersion: binding.version, content: { kind: "notion-page", parentPageId: input.parentId, title: "STOP_WHILE_GROUP_OPEN", text: "Never send this body" } });
      if (!draft.ok) throw new Error(draft.error.code);
      const intent = await api.outbound.prepare({ ...scope, draftId: draft.data.draft.id, revisionId: draft.data.revision.id, expectedDraftVersion: draft.data.draft.version, grantId: grant.id, expectedGrantVersion: grant.version });
      if (!intent.ok) throw new Error(intent.error.code);
      const approval = await api.outbound.requestApproval({ ...scope, id: intent.data.id, expectedVersion: intent.data.version });
      if (!approval.ok) throw new Error(approval.error.code);
    }, { botId: f.bots[0]!.id, sessionId: f.room.sessionId, connectionId: connection.id, authVersion: connection.authVersion, parentId });
    await expect(dialog).toHaveCount(1);
    await expect(dialog).toContainText("STOP_WHILE_GROUP_OPEN");
    await dialog.getByRole("button", { name: "停止任务", exact: true }).click();
    await expect.poll(async () => (await snapshot()).runs.filter(run => run.state === "cancelled").length).toBe(2);
    await expect(dialog).toHaveCount(0);
    expect(f.writes).toHaveLength(5);
  });
});

test("group Apps defers its approval behind modal settings and restores exactly one portal", async () => {
  test.setTimeout(90_000);
  await withOutbound(async f => {
    const connection = await setup(f);
    await selectNavigationTab(f.page, "聊天");
    await f.page.locator(".bot-row").filter({ hasText: f.room.name }).click();
    await openInspector(f.page);
    const inspector = f.page.getByRole("dialog", { name: "群聊设置", exact: true });
    await selectDetailsTab(inspector, "应用");
    await inspector.getByLabel("应用执行成员").selectOption(f.bot.id);
    await inspector.getByLabel("当前聊天的应用连接").selectOption(connection.id);
    await inspector.getByRole("button", { name: "授权当前成员读取", exact: true }).click();
    await expect(inspector.getByText("当前成员已授权", { exact: true })).toBeVisible();
    const draft = await saveDraft(f, "GROUP_MODAL_FIXED_TITLE", { sessionId: f.room.sessionId, executorBotId: f.bot.id });
    expect(draft.draft.sessionId).toBe(f.room.sessionId);
    expect(draft.draft.executorBotId).toBe(f.bot.id);
    await grantAndPrepare(f);
    await f.page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(f.page.getByRole("dialog", { name: "设置", exact: true })).toBeVisible();
    // A real host request can arrive while Settings covers the group Apps pane.
    const pending = unwrap(await f.page.evaluate(async scope => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const listed = await api.outbound.list(scope);
      if (!listed.ok || !listed.data[0]) throw new Error("Missing fixed group intent");
      const intent = listed.data[0];
      return api.outbound.requestApproval({ ...scope, id: intent.id, expectedVersion: intent.version });
    }, { sessionId: f.room.sessionId, executorBotId: f.bot.id }));
    expect(pending.approval).toMatchObject({ state: "pending" });
    const dialog = f.page.getByTestId("tool-permission-dialog");
    await expect(dialog).toHaveCount(0);
    await f.page.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(dialog).toHaveCount(1);
    await expect(dialog).toContainText(f.bot.name);
    await expect(dialog).toContainText("GROUP_MODAL_FIXED_TITLE");
    await expect(dialog.getByRole("button", { name: "仅允许一次", exact: true })).toBeEnabled();
    expect(f.writes).toHaveLength(0);
    await dialog.getByRole("button", { name: "拒绝", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(f.writes).toHaveLength(0);
    await inspector.getByRole("button", { name: "关闭群聊设置", exact: true }).click();
    await expect(inspector).toBeHidden();
  });
});


test("Notion title update approval pins actual title property and rejects later edits", async () => {
  test.setTimeout(90_000);
  await withOutbound(async f => {
    await setup(f);
    await f.page.getByRole("button", { name: "新建本地草稿", exact: true }).click();
    await f.page.getByLabel("Notion 草稿操作").selectOption("notion-page-title");
    await f.page.getByLabel("Notion 草稿目标页面").fill(targetPageId);
    await f.page.getByLabel("Notion 草稿新标题").fill("FIXED_NEW_TITLE");
    await f.page.getByRole("button", { name: "保存本地草稿", exact: true }).click();
    await expect(f.page.getByLabel("Notion 草稿操作")).toBeDisabled();
    await grantAndPrepare(f);
    await f.page.getByRole("button", { name: "审阅并批准此版本", exact: true }).click();
    const dialog = f.page.getByTestId("tool-permission-dialog");
    await expect(dialog.getByRole("button", { name: "仅允许一次", exact: true })).toBeEnabled();
    await expect(dialog).toContainText("frozen-title-id"); await expect(dialog).toContainText("ORIGINAL_TARGET_TITLE");
    const list = unwrap(await f.page.evaluate(async scope => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.drafts.list(scope), { sessionId: f.bot.sessionId, executorBotId: f.bot.id }));
    unwrap(await f.page.evaluate(async input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.drafts.update(input), { sessionId: f.bot.sessionId, executorBotId: f.bot.id, id: list[0]!.id, expectedVersion: 1, content: { kind: "notion-page-title" as const, pageId: targetPageId, title: "CHANGED_AFTER_APPROVAL" } }));
    await expect(dialog.getByRole("button", { name: "仅允许一次", exact: true })).toBeDisabled(); await expect(dialog).toContainText("FIXED_NEW_TITLE"); expect(f.writes).toHaveLength(0);
    await dialog.getByRole("button", { name: "拒绝", exact: true }).click();
    await f.page.getByRole("button", { name: "新建本地草稿", exact: true }).click();
    await f.page.getByLabel("Notion 草稿操作").selectOption("notion-page-title"); await f.page.getByLabel("Notion 草稿目标页面").fill(targetPageId); await f.page.getByLabel("Notion 草稿新标题").fill("APPROVED_NEW_TITLE"); await f.page.getByRole("button", { name: "保存本地草稿", exact: true }).click();
    await f.page.getByRole("button", { name: "准备此保存版本外发", exact: true }).click(); await f.page.getByRole("button", { name: "审阅并批准此版本", exact: true }).click(); await expect(dialog.getByRole("button", { name: "仅允许一次", exact: true })).toBeEnabled(); await dialog.getByRole("button", { name: "仅允许一次", exact: true }).click();
    await expect.poll(async () => (await intents(f)).find(item => item.review.content.kind === "notion-page-title" && item.state === "confirmed")?.state).toBe("confirmed"); expect(f.writes).toEqual([{ properties: { "frozen-title-id": { type: "title", title: [{ type: "text", text: { content: "APPROVED_NEW_TITLE" } }] } } }]);
  });
});

test("Notion append unknown survives restart and exact child proof never repeats PATCH", async () => {
  test.setTimeout(90_000);
  await withOutbound(async f => {
    const connection = await setup(f);
    await f.page.getByRole("button", { name: "新建本地草稿", exact: true }).click(); await f.page.getByLabel("Notion 草稿操作").selectOption("notion-page-append"); await f.page.getByLabel("Notion 草稿目标页面").fill(targetPageId); await f.page.getByLabel("Notion 草稿追加正文").fill("FIXED_APPEND_BODY"); await f.page.getByRole("button", { name: "保存本地草稿", exact: true }).click(); await grantAndPrepare(f);
    await f.page.getByRole("button", { name: "审阅并批准此版本", exact: true }).click(); const dialog = f.page.getByTestId("tool-permission-dialog"); await expect(dialog).toContainText("FIXED_APPEND_BODY"); await expect(dialog).toContainText("末尾追加"); await expect(dialog.getByRole("button", { name: "仅允许一次", exact: true })).toBeEnabled(); await dialog.getByRole("button", { name: "仅允许一次", exact: true }).click();
    await expect.poll(async () => (await intents(f))[0]?.state).toBe("unknown"); expect(f.writes).toHaveLength(1); expect(Object.keys(f.writes[0]!)).toEqual(["children"]);
    await f.restart(); await openApps(f, connection.id);
    await expect(f.page.getByRole("button", { name: "只读核对此次结果", exact: true })).toBeVisible(); await f.page.getByRole("button", { name: "只读核对此次结果", exact: true }).click(); await expect.poll(async () => (await intents(f))[0]?.state).toBe("confirmed"); expect(f.writes).toHaveLength(1);
    await expect(f.page.getByText(`第三方结果 ID：${targetPageId}`, { exact: true })).toBeVisible();
  });
});
