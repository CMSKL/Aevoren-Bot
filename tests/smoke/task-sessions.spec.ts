import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { AevorenBotApi, ApiResult, RoomRuntimeSnapshot, SessionRuntimeSnapshot } from "../../src/shared/contracts";
import type { TaskDetail, TaskExecutorSelection, TaskOptions } from "../../src/shared/task-session-contracts";
import { AppRepository } from "../../src/main/database";
import { WorkspaceService } from "../../src/main/workspace-service";
import { closeTestApplication, removeTestDirectory } from "./test-cleanup";

type Wire = { model: string; messages: Array<{ role: string; content: unknown }>; tools?: unknown[] };
type Capture = { command: Wire; response: ServerResponse; released: boolean; aborted: boolean };
type Bot = { id: string; name: string; sessionId: string; model: string };
type Fixture = {
  app: ElectronApplication; page: Page; data: string; bots: Bot[];
  room: { id: string; name: string; sessionId: string }; workspaceId: string;
  document: { id: string; reference: { resourceId: string; revisionId: string; digest: string } };
  captures: Capture[]; handler: (capture: Capture) => void; restart(): Promise<void>;
};
function value<T>(result: ApiResult<T>): T { if (!result.ok) throw new Error(`${result.error.code}: ${result.error.safeMessage}`); return result.data; }
function selection(executorBotId: string, patch: Partial<TaskExecutorSelection> = {}): TaskExecutorSelection {
  return { executorBotId, memories: [], history: [], workspaces: [], mcp: [], resourceRefs: [], mediaRefs: [], productOperations: [], network: false, clipboard: false, ...patch };
}
function text(capture: Capture, body: string): void {
  if (capture.released || capture.aborted) throw new Error("Controlled reply is not available");
  capture.released = true; if (!capture.response.headersSent) capture.response.writeHead(200, { "content-type": "text/event-stream" });
  capture.response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: body }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
}
function tool(capture: Capture, operation: string, input: unknown): void {
  capture.released = true; capture.response.writeHead(200, { "content-type": "text/event-stream" });
  capture.response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: { name: "product_execute", arguments: JSON.stringify({ operation, input }) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
}
async function options(page: Page, sessionId: string): Promise<TaskOptions> { return value(await page.evaluate(sessionId => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.sessions.taskOptions({ sessionId }), sessionId)); }
async function createTask(page: Page, parentSessionId: string, title: string, selections: TaskExecutorSelection[]): Promise<TaskDetail> {
  const scope = await options(page, parentSessionId);
  return value(await page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.sessions.createTask(input), { parentSessionId, expectedScopeVersion: scope.scopeVersion, clientNonce: randomUUID(), title, selections }));
}
async function snapshot(page: Page, sessionId: string): Promise<SessionRuntimeSnapshot> { return value(await page.evaluate(sessionId => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.runtime.getSessionSnapshot(sessionId), sessionId)); }
async function roomSnapshot(f: Fixture, sessionId: string): Promise<RoomRuntimeSnapshot> { return value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.roomRuntime.getSnapshot(input), { roomId: f.room.id, sessionId })); }
async function openTask(f: Fixture, task: TaskDetail): Promise<void> { await f.page.getByRole("listitem", { name: `任务：${task.title}`, exact: true }).click(); await expect(f.page.getByRole("heading", { name: task.title, exact: true })).toBeVisible(); }

// All model responses are controlled loopback fixtures. Host validation,
// migrations, transport, prompt construction, task effects and results remain real.
async function withTasks(work: (f: Fixture) => Promise<void>, mcp = false): Promise<void> {
  const data = mkdtempSync(join(tmpdir(), "aevoren-task-sessions-")), root = join(data, "source"); mkdirSync(root);
  writeFileSync(join(root, "picture.png"), readFileSync(join(process.cwd(), "resources/icon.png")));
  writeFileSync(join(root, "private.md"), "TASK_PARENT_WORKSPACE_PRIVATE");
  const repository = new AppRepository(join(data, "aevoren-bot.sqlite")), registration = await new WorkspaceService(repository).registerRoot(root);
  const bots = Array.from({ length: 6 }, (_, index) => {
    const made = repository.createBot(registration.project.id), model = `task-fixture-${index + 1}`;
    const bot = repository.updateBot(made.bot.id, made.bot.version, { name: `线程成员${index + 1}`, mcpServerIds: mcp ? null : [], modelSelection: { providerInstanceId: "openai-compatible.default", modelId: model } });
    repository.createMemory(bot.id, `parent bot memory number ${index + 1} stays private`);
    return { id: bot.id, name: bot.name, sessionId: made.session.id, model };
  });
  repository.createScopedMemory({ scope: "user", scopeKey: "user" }, "parent global memory stays outside empty tasks");
  const room = repository.createRoom({ name: "线程并行群", memberBotIds: bots.map(bot => bot.id), leadBotId: null, projectId: registration.project.id });
  const document = repository.library.create({ sessionId: bots[0]!.sessionId, kind: "document", name: "父会话私有资料", body: "TASK_PARENT_DOCUMENT_PRIVATE" });
  repository.setSetting("memory.capture.enabled", "false", false); repository.close();
  const captures: Capture[] = [], fixtureErrors: string[] = [], pageErrors: string[] = [];
  const remotes: McpServer[] = [], transports = new Map<string, StreamableHTTPServerTransport>();
  const server = createServer(async (request, response) => {
    try {
      let body = ""; for await (const chunk of request) body += chunk;
      const command = body ? JSON.parse(body) : undefined;
      if (request.url === "/mcp") {
        const id = request.headers["mcp-session-id"], existing = typeof id === "string" ? transports.get(id) : undefined;
        if (existing) { await existing.handleRequest(request, response, command); return; }
        if (request.method !== "POST" || command?.method !== "initialize") { response.writeHead(404).end(); return; }
        const remote = new McpServer({ name: "task-read-fixture", version: "1" }); remotes.push(remote);
        remote.registerTool("read_fixture", { description: "Read the controlled fixture marker", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: "text", text: "TASK_PARENT_MCP_PRIVATE" }] }));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: id => { transports.set(id, transport); } });
        await remote.connect(transport); await transport.handleRequest(request, response, command); return;
      }
      if (request.headers.authorization !== "Bearer task-fixture-token" || !bots.some(bot => bot.model === command.model)) throw new Error("Unexpected controlled model request");
      const capture = { command: command as Wire, response, released: false, aborted: false }; captures.push(capture);
      response.on("close", () => { if (!capture.released) capture.aborted = true; });
      f.handler(capture);
    } catch (error) { fixtureErrors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Controlled server has no port");
  const executablePath = process.env.AEVOREN_PACKAGED_APP_PATH;
  async function launch(): Promise<void> {
    const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : ["."], cwd: process.cwd(), env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key, item]) => item !== undefined && !key.startsWith("AEVOREN_"))),
      AEVOREN_BOT_USER_DATA_DIR: data, AEVOREN_BOT_FAKE_PROVIDER: "0", AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_DISABLE_UPDATES: "1",
    } });
    f.app = app;
    if (executablePath) expect(await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion() }))).toEqual({ packaged: true, version: JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version });
    f.page = await app.firstWindow(); await expect(f.page.locator(".app-shell")).toBeVisible(); f.page.on("pageerror", error => pageErrors.push(error.message));
  }
  async function close(): Promise<void> {
    const owned = f.app.process(); await closeTestApplication(f.app); expect({ code: owned.exitCode, signal: owned.signalCode }).toEqual({ code: 0, signal: null });
  }
  const f: Fixture = { app: undefined as unknown as ElectronApplication, page: undefined as unknown as Page, data, bots, room: { id: room.room.id, name: room.room.name, sessionId: room.session.id }, workspaceId: registration.workspace.id,
    document: { id: document.resource.id, reference: document.reference }, captures, handler: capture => text(capture, "CONTROLLED_TASK_REPLY"), restart: async () => { await close(); await launch(); } };
  let completed = false;
  try {
    await launch();
    value(await f.page.evaluate(async baseUrl => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot, providers = await api.providers.list();
      const provider = providers.ok ? providers.data.find(item => item.id === "openai-compatible.default") : null;
      if (!provider) throw new Error("Controlled API provider missing");
      return api.providers.saveOpenAiCompatible({ instanceId: provider.id, expectedVersion: provider.version, baseUrl, apiKey: "task-fixture-token" });
    }, `http://127.0.0.1:${address.port}/v1`));
    if (mcp) {
      const url = `http://127.0.0.1:${address.port}/mcp`;
      const saved = value(await f.page.evaluate(url => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.mcp.save({ name: "task-read-fixture", config: { transport: "streamable-http", url, headers: {} } }), url));
      const probed = value(await f.page.evaluate(id => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.mcp.probe(id), saved.id));
      expect(probed.tools.find(tool => tool.name === "read_fixture")?.claimedReadOnly).toBe(true);
      const trusted = value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.mcp.save(input), { id: probed.id, expectedVersion: probed.version, name: probed.name, trustedReadOnlyTools: ["read_fixture"], config: { transport: "streamable-http" as const, url, headers: {} } }));
      value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.mcp.setEnabled(input), { id: trusted.id, expectedVersion: trusted.version, enabled: true }));
      await expect.poll(async () => (await options(f.page, bots[0]!.sessionId)).executors[0]?.mcpTools.map(item => item.name)).toContain("read_fixture");
    }
    await work(f);
    expect(fixtureErrors).toEqual([]); expect(pageErrors).toEqual([]);
    expect(await f.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible()))).toBe(false);
    const database = new DatabaseSync(join(data, "aevoren-bot.sqlite"), { readOnly: true });
    try { expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]); } finally { database.close(); }
    completed = true;
  } finally {
    if (!completed && f.page && !f.page.isClosed()) {
      try {
        const journals = await f.page.evaluate(async () => {
          const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot, listed = await api.conversations.list();
          if (!listed.ok) return { error: listed.error };
          return Promise.all(listed.data.map(async item => ({ sessionId: item.sessionId, tools: await api.tools.list({ sessionId: item.sessionId }), runtime: await api.runtime.getSessionSnapshot(item.sessionId) })));
        });
        const json = JSON.stringify({ fixtureErrors, pageErrors, captures: captures.map(item => ({ command: item.command, released: item.released, aborted: item.aborted })), journals });
        const body = json.length <= 2_000_000 ? json : JSON.stringify({ truncated: true, preview: json.slice(0, 2_000_000) });
        await test.info().attach("controlled-task-provider-and-journals", { body, contentType: "application/json" });
      } catch { /* Preserve the original failure if its owned Renderer already exited. */ }
    }
    server.closeAllConnections();
    if (f.app) await close();
    if (!completed) copyFileSync(join(data, "aevoren-bot.sqlite"), test.info().outputPath("isolated-task-journal.sqlite"));
    await Promise.allSettled(remotes.map(remote => remote.close()));
    await new Promise<void>(resolve => server.close(() => resolve())); removeTestDirectory(data);
  }
}

test("creates explicit empty task scopes through UI and keeps sibling drafts, history, CAS title and owner identity separate", async () => {
  test.setTimeout(90_000);
  await withTasks(async f => {
    const bot = f.bots[0]!;
    await f.page.getByRole("listitem", { name: bot.name, exact: true }).click();
    await f.page.getByLabel("消息", { exact: true }).fill("TASK_PARENT_HISTORY_PRIVATE"); await f.page.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(async () => (await snapshot(f.page, bot.sessionId)).runs.at(-1)?.state).toBe("completed");
    const imported = value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.media.importPath(input), { sessionId: bot.sessionId, workspaceId: f.workspaceId, path: "picture.png" })); expect(imported.imported).toHaveLength(1);
    const parent = await options(f.page, bot.sessionId);
    expect(parent.executors[0]!.memories.map(item => item.content)).toContain("parent bot memory number 1 stays private"); expect(parent.history.length).toBeGreaterThan(0);
    expect(parent.resources).toHaveLength(1); expect(parent.media).toHaveLength(1); expect(parent.executors[0]!.workspaces).toHaveLength(1); expect(parent.executors[0]!.mcpTools).toHaveLength(1);
    await f.page.getByRole("button", { name: "新建任务", exact: true }).click();
    const dialog = f.page.getByRole("dialog", { name: "新建任务线程", exact: true });
    await expect(dialog.getByRole("button", { name: "创建任务线程", exact: true })).toBeDisabled(); await dialog.getByLabel("任务名称", { exact: true }).fill("独立任务甲");
    await dialog.getByLabel(`任务执行成员 ${bot.name}`, { exact: true }).check();
    expect(await dialog.locator('input[type="checkbox"]:checked').count()).toBe(1);
    await dialog.getByRole("button", { name: "创建任务线程", exact: true }).click(); await expect(f.page.getByRole("heading", { name: "独立任务甲", exact: true })).toBeVisible();
    const listed = value(await f.page.evaluate(parentSessionId => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.sessions.listTasks({ parentSessionId }), bot.sessionId));
    const first = listed.find(task => task.title === "独立任务甲")!; expect(first.session.kind).toBe("TASK");
    const empty = await options(f.page, first.session.id); expect(empty.currentSelections).toEqual([selection(bot.id)]);
    expect(empty.history).toEqual([]); expect(empty.resources).toEqual([]); expect(empty.media).toEqual([]); expect(empty.executors[0]!.memories).toEqual([]); expect(empty.executors[0]!.workspaces).toEqual([]); expect(empty.executors[0]!.mcpTools).toEqual([]);
    const second = await createTask(f.page, bot.sessionId, "独立任务乙", [selection(bot.id)]);
    await f.page.getByLabel("消息", { exact: true }).fill("TASK_A_DRAFT"); await openTask(f, second); await expect(f.page.getByLabel("消息", { exact: true })).toHaveValue("");
    await f.page.getByLabel("消息", { exact: true }).fill("TASK_B_DRAFT"); await openTask(f, first); await expect(f.page.getByLabel("消息", { exact: true })).toHaveValue("TASK_A_DRAFT");
    const before = f.captures.length; await f.page.getByLabel("消息", { exact: true }).fill("TASK_A_ONLY_MESSAGE"); await f.page.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(async () => (await snapshot(f.page, first.session.id)).runs.at(-1)?.state).toBe("completed"); expect(f.captures).toHaveLength(before + 1);
    const wire = JSON.stringify(f.captures.at(-1)!.command); for (const privateText of ["TASK_PARENT_HISTORY_PRIVATE", "parent bot memory number 1 stays private", "parent global memory stays outside empty tasks", "TASK_PARENT_DOCUMENT_PRIVATE", "TASK_PARENT_WORKSPACE_PRIVATE", "read_fixture"]) expect(wire).not.toContain(privateText);
    expect((await snapshot(f.page, bot.sessionId)).entries.filter(item => item.role === "user").map(item => item.body)).toEqual(["TASK_PARENT_HISTORY_PRIVATE"]);
    await openTask(f, second); await expect(f.page.getByLabel("消息", { exact: true })).toHaveValue("TASK_B_DRAFT");
    await f.page.getByRole("button", { name: "任务详情", exact: true }).click(); const details = f.page.getByRole("dialog", { name: "任务线程详情", exact: true }); await details.getByLabel("修改任务名称", { exact: true }).fill("冲突后保留的任务名称");
    value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.sessions.updateTask(input), { sessionId: second.session.id, expectedVersion: second.version, title: "另一个保存版本" }));
    await details.getByRole("button", { name: "保存任务名称", exact: true }).click(); await expect(details.getByRole("alert")).toBeVisible(); await expect(details.getByLabel("修改任务名称", { exact: true })).toHaveValue("冲突后保留的任务名称");
    await details.getByRole("button", { name: "完成", exact: true }).click(); await f.page.getByRole("button", { name: "任务详情", exact: true }).click(); await details.getByLabel("修改任务名称", { exact: true }).fill("独立任务乙已命名"); await details.getByRole("button", { name: "保存任务名称", exact: true }).click(); await expect(f.page.getByRole("heading", { name: "独立任务乙已命名", exact: true })).toBeVisible(); await details.getByRole("button", { name: "完成", exact: true }).click();
    await f.page.reload(); await expect(f.page.getByRole("heading", { name: "独立任务乙已命名", exact: true })).toBeVisible();
    await f.restart(); await openTask(f, { ...second, title: "独立任务乙已命名" }); expect((await snapshot(f.page, second.session.id)).entries).toEqual([]);
    await openTask(f, first); await expect(f.page.locator("article.message-user")).toContainText("TASK_A_ONLY_MESSAGE"); await expect(f.page.locator("article.message-user")).not.toContainText("TASK_PARENT_HISTORY_PRIVATE");
    await f.page.getByRole("listitem", { name: "任务：独立任务乙已命名", exact: true }).click(); await f.page.getByRole("button", { name: "任务详情", exact: true }).click(); await details.getByRole("button", { name: "删除此任务线程", exact: true }).click(); await details.getByRole("button", { name: "确认删除此任务线程", exact: true }).click(); await expect(details).toBeHidden();
    const contacts = value(await f.page.evaluate(() => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.bots.list())); expect(contacts.find(item => item.id === bot.id)?.name).toBe(bot.name);
    expect(value(await f.page.evaluate(botId => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.sessions.getMain(botId), bot.id)).id).toBe(bot.sessionId);
    expect(value(await f.page.evaluate(sessionId => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.sessions.getTask({ sessionId }), first.session.id)).title).toBe(first.title);
  }, true);
});

test("starts all six Task Room members before any result and cancels one without stopping its five peers or sibling thread", async () => {
  test.setTimeout(90_000);
  await withTasks(async f => {
    f.handler = capture => { capture.response.writeHead(200, { "content-type": "text/event-stream" }); capture.response.flushHeaders(); };
    const task = await createTask(f.page, f.room.sessionId, "六成员任务", f.bots.map(bot => selection(bot.id)));
    const sibling = await createTask(f.page, f.room.sessionId, "兄弟任务", [selection(f.bots[0]!.id)]);
    const sent = value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.roomRuntime.send(input), { roomId: f.room.id, sessionId: task.session.id, clientNonce: randomUUID(), text: "TASK_GROUP_ALL", routingMode: "everyone" as const, targetBotIds: f.bots.map(bot => bot.id) }));
    await expect.poll(() => f.captures.length, { timeout: 15_000 }).toBe(6); expect(f.captures.every(capture => !capture.released)).toBe(true);
    let group = await roomSnapshot(f, task.session.id); expect(group.detail.session.id).toBe(task.session.id); expect(group.runs).toHaveLength(6); expect(group.turns.every(turn => turn.state === "running")).toBe(true);
    value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.roomRuntime.send(input), { roomId: f.room.id, sessionId: sibling.session.id, clientNonce: randomUUID(), text: "TASK_SIBLING_ACTIVE", routingMode: "everyone" as const, targetBotIds: [f.bots[0]!.id] }));
    await expect.poll(() => f.captures.length).toBe(7);
    const cancelled = group.runs.find(run => run.executorBotId === f.bots[0]!.id)!;
    value(await f.page.evaluate(runId => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.roomRuntime.cancelMember(runId), cancelled.id));
    await expect.poll(() => f.captures.filter(capture => capture.aborted).length).toBe(1);
    await expect.poll(async () => (await roomSnapshot(f, sibling.session.id)).runs[0]?.state).toBe("running");
    for (const capture of f.captures.slice(0, 6).filter(capture => !capture.aborted)) text(capture, `TASK_GROUP_DONE_${capture.command.model}`);
    await expect.poll(async () => (await roomSnapshot(f, task.session.id)).turns.filter(turn => turn.state === "completed").length).toBe(5);
    group = await roomSnapshot(f, task.session.id); expect(group.turns.filter(turn => turn.state === "cancelled")).toHaveLength(1); expect(group.runs.every(run => run.sessionId === task.session.id)).toBe(true);
    expect((await roomSnapshot(f, sibling.session.id)).runs[0]?.state).toBe("running"); expect((await roomSnapshot(f, f.room.sessionId)).entries).toEqual([]);
    text(f.captures[6]!, "TASK_SIBLING_DONE"); await expect.poll(async () => (await roomSnapshot(f, sibling.session.id)).runs[0]?.state).toBe("completed");
    await openTask(f, task); await expect(f.page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(5); await expect(f.page.locator(".conversation")).not.toContainText("TASK_SIBLING_DONE");
    expect(sent.batchId).toBe(group.batches[0]?.id);
  });
});

test("filters actor task reads through real tools and keeps parent resources private across task revocation and rebind", async () => {
  test.setTimeout(90_000);
  await withTasks(async f => {
    const actor = f.bots[0]!, other = f.bots[1]!;
    const hidden = await createTask(f.page, f.room.sessionId, "OTHER_MEMBER_TASK_PRIVATE", [selection(other.id)]);
    const visible = await createTask(f.page, f.room.sessionId, "ACTOR_ADMITTED_TASK", [selection(actor.id)]);
    const outputs: string[] = [];
    f.handler = capture => {
      if (capture.command.messages.at(-1)?.role === "tool") { outputs.push(JSON.stringify(capture.command.messages.at(-1)!.content)); text(capture, "ACTOR_TOOL_ROUNDTRIP_DONE"); return; }
      const body = JSON.stringify(capture.command.messages.filter(message => message.role === "user").at(-1)?.content);
      if (body.includes("ACTOR_LIST")) tool(capture, "sessions.listTasks", {});
      else if (body.includes("ACTOR_SCOPE")) tool(capture, "sessions.taskOptions", {});
      else if (body.includes("ACTOR_GET_HIDDEN")) tool(capture, "sessions.getTask", { sessionId: hidden.session.id });
      else text(capture, "CONTROLLED_TASK_REPLY");
    };
    for (const marker of ["ACTOR_LIST", "ACTOR_SCOPE", "ACTOR_GET_HIDDEN"]) {
      const sent = value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.roomRuntime.send(input), { roomId: f.room.id, sessionId: f.room.sessionId, clientNonce: randomUUID(), text: `请使用对应任务查询工具检查当前执行成员的任务范围，不修改任何数据。 ${marker}`, routingMode: "explicit" as const, targetBotIds: [actor.id] }));
      await expect.poll(async () => (await roomSnapshot(f, f.room.sessionId)).batches.find(batch => batch.id === sent.batchId)?.state, { timeout: 15_000 }).toBe("completed");
    }
    expect(outputs[0]).toContain(visible.session.id); expect(outputs.join("\n")).not.toContain("OTHER_MEMBER_TASK_PRIVATE"); expect(outputs[0]).not.toContain(hidden.session.id);
    expect(outputs[1]).toContain(actor.name); expect(outputs[1]).not.toContain(other.name); expect(outputs[2]).toMatch(/APPROVAL_SCOPE_INVALID|RUNTIME_CONTROL_SCOPE_INVALID/u);
    const selected = await createTask(f.page, actor.sessionId, "资料授权撤销任务", [selection(actor.id, { resourceRefs: [f.document.reference] })]);
    value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.library.unbind(input), { sessionId: selected.session.id, id: f.document.id }));
    value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.library.bind(input), { sessionId: selected.session.id, id: f.document.id }));
    const before = f.captures.length, refused = await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.messages.send(input), { sessionId: selected.session.id, clientNonce: randomUUID(), text: "TASK_REVOKED_RESOURCE_MUST_NOT_TRANSMIT" });
    if (refused.ok) await expect.poll(async () => (await snapshot(f.page, selected.session.id)).runs.find(run => run.id === refused.data.runId)?.state).toBe("failed");
    else expect(["APPROVAL_SCOPE_INVALID", "LIBRARY_NOT_BOUND"]).toContain(refused.error.code);
    expect(f.captures).toHaveLength(before);
    const parent = value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.library.read(input), { sessionId: actor.sessionId, id: f.document.id, revisionId: f.document.reference.revisionId })); expect(parent.revision.body).toBe("TASK_PARENT_DOCUMENT_PRIVATE");
  });
});
