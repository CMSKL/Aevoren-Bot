import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductToolRequest } from "@shared/contracts";
import { PRODUCT_OPERATIONS } from "@shared/product-operations";
import { AppRepository, MIGRATIONS } from "./database";
import { EventHttpServer } from "./event-http-server";
import { AUTOMATION_EVENT_CHANNELS } from "@shared/event-channels";
import { EventService } from "./event-service";
import { RoutineService } from "./routine-service";
import { SendWorker } from "./send-worker";
import { ProductOperationService } from "./product-operation-service";
import type { ProductDependencies } from "./product-handlers";
import { emitAutomationRuntime } from "./event-runtime";
import { apiResult } from "./errors";
import { WorkspaceService } from "./workspace-service";
import { WorkspaceToolExecutor } from "./workspace-tool-executor";
import { WorkspaceToolCoordinator } from "./workspace-tool-coordinator";
import { RoomCoordinator } from "./room-coordinator";
import { GeneralSettingsService } from "./settings";
import type { ModelProvider } from "./model";

const cleanup: Array<() => void | Promise<void>> = [];
vi.mock("electron", () => ({ clipboard: { writeText: vi.fn() } }));
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture(modelRun?: ModelProvider["run"]) {
  const root = mkdtempSync(join(tmpdir(), "aevoren-event-host-")), path = join(root, "app.sqlite"), repository = new AppRepository(path);
  const worker = new SendWorker(repository, null, { transcript: () => {}, sendState: () => {}, runtime: () => {} }, false, { run: modelRun ?? async function* () { yield { type: "started", requestId: randomUUID() }; yield { type: "completed", finishReason: "stop" }; }, testConnection: async () => {} });
  const routines = new RoutineService(repository, worker, () => {}), events = new EventService(repository.automationEvents, routines, { isAvailable: () => true, encrypt: value => `test-sealed:${value}`, decrypt: value => value.slice(12) }, () => {}, { assertSourceSession: id => { repository.getSession(id); } });
  cleanup.push(async () => { await events.shutdown(); await routines.shutdown(); await worker.shutdown(); repository.close(); rmSync(root, { recursive: true, force: true }); });
  const owner = repository.createBot(), other = repository.createBot();
  const saved = routines.create({ name: "Current", prompt: "Saved instruction", botId: owner.bot.id, enabled: true, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } });
  return { root, path, repository, worker, routines, events, owner, other, saved };
}
const call = (operation: string, input?: unknown): ProductToolRequest => ({ kind: "product-call", action: "execute", operation, ...(input === undefined ? {} : { input }) });
function runtime(f: ReturnType<typeof fixture>, sessionId = f.owner.session.id, text = "Instruction") {
  const nonce = randomUUID(); f.repository.prepareMessage({ clientNonce: nonce, sessionId, text }); const entry = f.repository.getUserMessage(nonce);
  const run = f.repository.createRuntimeRun(nonce, "fake", { schemaVersion: 1, botId: f.owner.bot.id, profileVersion: f.owner.bot.version, sessionId, generation: entry.generation, inputSeq: entry.seq, blocks: [], digest: "event-test" }, { executorBotId: f.owner.bot.id });
  f.repository.transitionRuntimeRun(run.id, "dispatching"); return f.repository.transitionRuntimeRun(run.id, "running");
}

describe("automation host integration", () => {
  it("shares reviewed listener controls while excluding credentials and preserving Runtime events", () => {
    const names = PRODUCT_OPERATIONS.filter(item => item.name.startsWith("automationEvents.")).map(item => item.name);
    expect(names).toEqual(["automationEvents.snapshot", "automationEvents.create", "automationEvents.update", "automationEvents.revoke", "automationEvents.cancel", "automationEvents.startListener", "automationEvents.stopListener"]);
    for (const secret of ["rotateToken", "emitRuntime", "authenticate"]) expect(PRODUCT_OPERATIONS.some(item => item.name.endsWith(`.${secret}`))).toBe(false);
  });

  it("rejects unknown trusted source sessions and maps event conflicts to useful structured errors", async () => {
    const f = fixture();
    expect(() => f.events.create({ name: "Missing", source: { kind: "runtime.completed", sessionId: randomUUID() }, routineId: f.saved.id, expectedRoutineVersion: f.saved.version })).toThrowError(expect.objectContaining({ code: "SESSION_NOT_FOUND" }));
    const hook = f.events.create({ name: "Current", source: { kind: "webhook" }, routineId: f.saved.id, expectedRoutineVersion: f.saved.version });
    const result = await apiResult(() => f.events.revoke({ id: hook.id, expectedVersion: hook.version + 1 }));
    expect(result).toMatchObject({ ok: false, error: { code: "EVENT_VERSION_CONFLICT", details: { currentVersion: hook.version } } });
  });

  it("scopes shared Product reads and mutations before approval and rejects TASK actors", async () => {
    const f = fixture(), run = runtime(f);
    const product = new ProductOperationService({ repository: f.repository, routineService: f.routines, automationEventService: f.events } as ProductDependencies);
    const current = f.events.create({ name: "Visible", source: { kind: "webhook" }, routineId: f.saved.id, expectedRoutineVersion: f.saved.version });
    const foreignRule = f.routines.create({ name: "Other", prompt: "PRIVATE_OTHER_PROMPT", botId: f.other.bot.id, enabled: true, schedule: f.saved.schedule });
    const foreign = f.events.create({ name: "PRIVATE_OTHER_HOOK", source: { kind: "webhook" }, routineId: foreignRule.id, expectedRoutineVersion: foreignRule.version });
    expect(() => product.validate(call("automationEvents.snapshot"), run.id)).not.toThrow();
    expect(() => product.validate(call("automationEvents.revoke", { id: foreign.id, expectedVersion: foreign.version }), run.id)).toThrowError(expect.objectContaining({ code: "APPROVAL_SCOPE_INVALID" }));
    expect(product.requiresApproval(call("automationEvents.create", {}))).toBe(true); expect(product.requiresApproval(call("automationEvents.snapshot"))).toBe(false);
    expect(f.events.snapshot({ sessionId: f.owner.session.id }).subscriptions.map(item => item.id)).toEqual([current.id]);
    const task = f.repository.tasks.create({ parentSessionId: f.owner.session.id, expectedScopeVersion: f.repository.tasks.scopeVersion(f.owner.session.id), clientNonce: randomUUID(), title: "Task", selections: [{ executorBotId: f.owner.bot.id, memories: [], history: [], workspaces: [], mcp: [], resourceRefs: [], mediaRefs: [], productOperations: ["automationEvents.snapshot"], network: false, clipboard: false }] });
    const taskRun = runtime(f, task.session.id);
    expect(() => product.validate(call("automationEvents.snapshot"), taskRun.id)).toThrowError(expect.objectContaining({ code: "RUNTIME_CONTROL_SCOPE_INVALID" }));
  });

  it("emits only opaque terminal metadata from a real Runtime, never the private user body", async () => {
    const f = fixture(), run = runtime(f, f.owner.session.id, "PRIVATE_USER_BODY_AND_MEMORY"), completed = f.repository.transitionRuntimeRun(run.id, "completed");
    const emit = vi.spyOn(f.events, "emitRuntime").mockResolvedValue([]);
    await emitAutomationRuntime(f.repository, f.events, completed);
    expect(emit).toHaveBeenCalledExactlyOnceWith({ eventId: `runtime:${run.id}:completed`, sessionId: f.owner.session.id, runtimeRunId: run.id, state: "completed" });
    expect(JSON.stringify(emit.mock.calls)).not.toContain("PRIVATE_USER_BODY");
    await emitAutomationRuntime(f.repository, f.events, { ...completed, version: completed.version - 1 }); expect(emit).toHaveBeenCalledTimes(1);
  });

  it("commits AI mutation receipts atomically and reuses the original update result on retry", async () => {
    const f = fixture(), run = runtime(f), workspace = new WorkspaceService(f.repository), executor = new WorkspaceToolExecutor(f.repository, workspace), tools = new WorkspaceToolCoordinator(f.repository, executor, () => {}), rooms = new RoomCoordinator(f.repository, f.worker.executor, { transcript: () => {}, roomRuntime: () => {} });
    cleanup.push(() => rooms.shutdown());
    const product = new ProductOperationService({ repository: f.repository, routineService: f.routines, automationEventService: f.events, workspaceService: workspace, workspaceToolCoordinator: tools, sendWorker: f.worker, roomCoordinator: rooms, generalSettings: new GeneralSettingsService(f.repository), providers: { list: async () => [], isSupported: () => true }, updateService: {}, productChanged: () => {} } as unknown as ProductDependencies); executor.setProductOperations(product);
    const execute = async (tool: ProductToolRequest) => {
      product.validate(tool, run.id);
      const prepared = f.repository.prepareToolInvocation({ runtimeRunId: run.id, toolCallId: randomUUID(), idempotencyKey: randomUUID(), tool });
      f.repository.resolveToolApproval(prepared.approval.id, prepared.approval.version, "allow-once");
      return JSON.parse((await executor.execute(prepared.invocation.id)).content).result;
    };
    const create = call("automationEvents.create", { name: "Atomic", source: { kind: "webhook" }, routineId: f.saved.id, expectedRoutineVersion: f.saved.version, enabled: false });
    const created = await execute(create); expect(await execute(create)).toEqual(created); expect(f.events.snapshot().subscriptions).toHaveLength(1);
    const update = call("automationEvents.update", { id: created.id, expectedVersion: created.version, patch: { name: "One version only" } });
    const changed = await execute(update); expect(changed.version).toBe(created.version + 1); expect(await execute(update)).toEqual(changed); expect(f.events.snapshot().subscriptions[0]!.version).toBe(changed.version);
    const complete = vi.spyOn(f.repository, "completeProductToolInvocation").mockImplementationOnce(() => { throw new Error("controlled receipt commit failure"); });
    await expect(execute(call("automationEvents.create", { name: "Must rollback", source: { kind: "webhook" }, routineId: f.saved.id, expectedRoutineVersion: f.saved.version }))).rejects.toThrow(); complete.mockRestore();
    expect(f.events.snapshot().subscriptions.map(hook => hook.name)).toEqual(["One version only"]);
  });

  it("requires gateway approval for application listener controls and replays receipts without restoring stopped ingress", async () => {
    const f = fixture(), run = runtime(f), http = new EventHttpServer(f.events), workspace = new WorkspaceService(f.repository), executor = new WorkspaceToolExecutor(f.repository, workspace), tools = new WorkspaceToolCoordinator(f.repository, executor, () => {}), rooms = new RoomCoordinator(f.repository, f.worker.executor, { transcript: () => {}, roomRuntime: () => {} });
    cleanup.push(async () => { await http.shutdown(); await rooms.shutdown(); });
    const product = new ProductOperationService({ repository: f.repository, routineService: f.routines, automationEventService: f.events, automationEventHttp: http, workspaceService: workspace, workspaceToolCoordinator: tools, sendWorker: f.worker, roomCoordinator: rooms, generalSettings: new GeneralSettingsService(f.repository), providers: { list: async () => [], isSupported: () => true }, updateService: {} } as unknown as ProductDependencies); executor.setProductOperations(product);
    const probe = await http.start(); await http.stop();
    const input = { expectedRevision: http.snapshot().revision, port: probe.port! }, tool = call("automationEvents.startListener", input), start = vi.spyOn(http, "startControlled");
    expect(product.requiresApproval(tool, run.id)).toBe(true); expect(product.preview(tool)).toContain(`127.0.0.1:${input.port}`);
    const request = tools.requestAndWait(run.id, randomUUID(), tool, new AbortController().signal);
    expect(http.snapshot().listening).toBe(false); expect(start).not.toHaveBeenCalled();
    const approval = f.repository.listPendingApprovalRequests(run.sessionId)[0]!;
    await tools.resolve(run.sessionId, approval.id, approval.version, "allow-once");
    const first = JSON.parse((await request).content); expect(first).toMatchObject({ status: "completed", result: { listening: true, port: input.port, busy: false } });
    expect(f.repository.findProductOperationResult(run.clientNonce, tool, run.executorBotId)).not.toBeNull();
    const live = http.snapshot();
    await product.handlers.get(AUTOMATION_EVENT_CHANNELS.stopListener)!({ expectedRevision: live.revision, port: live.port });
    const replay = JSON.parse((await tools.requestAndWait(run.id, randomUUID(), tool, new AbortController().signal)).content);
    expect(replay).toMatchObject({ status: "previously_completed", reused: true, currentListener: { listening: false } }); expect(start).toHaveBeenCalledTimes(1); expect(f.repository.listPendingApprovalRequests(run.sessionId)).toHaveLength(0);
    expect(JSON.stringify(replay)).not.toContain("test-sealed");
    expect(() => product.validate(call("automationEvents.startListener", { expectedRevision: http.snapshot().revision, port: 0 }), run.id)).toThrowError(expect.objectContaining({ issues: expect.any(Array) }));
    const staleTool = call("automationEvents.startListener", { expectedRevision: http.snapshot().revision, port: input.port });
    const stale = tools.requestAndWait(run.id, randomUUID(), staleTool, new AbortController().signal), pending = f.repository.listPendingApprovalRequests(run.sessionId)[0]!;
    const ui = await product.handlers.get(AUTOMATION_EVENT_CHANNELS.startListener)!({ expectedRevision: http.snapshot().revision, port: 0 });
    expect(ui).toMatchObject({ listening: true });
    await tools.resolve(run.sessionId, pending.id, pending.version, "allow-once");
    expect(JSON.parse((await stale).content)).toMatchObject({ ok: false, error: { code: "EVENT_VERSION_CONFLICT" } }); expect(start).toHaveBeenCalledTimes(2);
    const stillLive = http.snapshot(); expect(stillLive.listening).toBe(true);
    const stop = call("automationEvents.stopListener", { expectedRevision: stillLive.revision, port: stillLive.port! });
    const stopping = tools.requestAndWait(run.id, randomUUID(), stop, new AbortController().signal), stopApproval = f.repository.listPendingApprovalRequests(run.sessionId)[0]!;
    await tools.resolve(run.sessionId, stopApproval.id, stopApproval.version, "allow-once"); expect(JSON.parse((await stopping).content)).toMatchObject({ result: { listening: false } });
    const controller = new AbortController(), cancelledTool = call("automationEvents.startListener", { expectedRevision: http.snapshot().revision, port: input.port });
    const cancelled = tools.requestAndWait(run.id, randomUUID(), cancelledTool, controller.signal); controller.abort(); await expect(cancelled).rejects.toThrow(); expect(http.snapshot().listening).toBe(false);
    const unknownTool = call("automationEvents.startListener", { expectedRevision: http.snapshot().revision, port: input.port });
    const interrupted = f.repository.prepareToolInvocation({ runtimeRunId: run.id, toolCallId: randomUUID(), idempotencyKey: randomUUID(), tool: unknownTool });
    f.repository.resolveToolApproval(interrupted.approval.id, interrupted.approval.version, "allow-once");
    f.repository.transitionToolInvocation(interrupted.invocation.id, "dispatching"); f.repository.transitionToolInvocation(interrupted.invocation.id, "running");
    f.repository.interruptProductToolInvocation(interrupted.invocation.id, JSON.stringify({ status: "unknown" }));
    expect(() => product.validate(unknownTool, run.id)).toThrowError(expect.objectContaining({ code: "TOOL_STATE_INVALID" })); expect(http.snapshot().listening).toBe(false);
    const task = f.repository.tasks.create({ title: "No global listener permission", parentSessionId: f.owner.session.id, expectedScopeVersion: f.repository.tasks.scopeVersion(f.owner.session.id), clientNonce: randomUUID(), selections: [{ executorBotId: f.owner.bot.id, memories: [], history: [], workspaces: [], mcp: [], resourceRefs: [], mediaRefs: [], productOperations: ["automationEvents.startListener"], network: false, clipboard: false }] });
    expect(() => product.validate(call("automationEvents.startListener", { expectedRevision: http.snapshot().revision, port: input.port }), runtime(f, task.session.id).id)).toThrowError(expect.objectContaining({ code: "RUNTIME_CONTROL_SCOPE_INVALID" }));
    f.repository.transitionRuntimeRun(run.id, "completed"); expect(() => product.validate(tool, run.id)).toThrowError(expect.objectContaining({ code: "TOOL_EXECUTION_CANCELLED" }));
  });

  it("rechecks actual group membership after bind before exposing the listener", async () => {
    const f = fixture(), third = f.repository.createBot(), room = f.repository.createRoom({ name: "Scope review", leadBotId: null, memberBotIds: [f.owner.bot.id, f.other.bot.id, third.bot.id] }), run = runtime(f, room.session.id), http = new EventHttpServer(f.events), workspace = new WorkspaceService(f.repository), executor = new WorkspaceToolExecutor(f.repository, workspace), tools = new WorkspaceToolCoordinator(f.repository, executor, () => {}), rooms = new RoomCoordinator(f.repository, f.worker.executor, { transcript: () => {}, roomRuntime: () => {} });
    cleanup.push(async () => { await http.shutdown(); await rooms.shutdown(); });
    const product = new ProductOperationService({ repository: f.repository, routineService: f.routines, automationEventService: f.events, automationEventHttp: http, workspaceService: workspace, workspaceToolCoordinator: tools, sendWorker: f.worker, roomCoordinator: rooms, generalSettings: new GeneralSettingsService(f.repository), providers: { list: async () => [], isSupported: () => true }, updateService: {} } as unknown as ProductDependencies); executor.setProductOperations(product);
    const probe = await http.start(); await http.stop();
    const tool = call("automationEvents.startListener", { expectedRevision: http.snapshot().revision, port: probe.port! });
    product.validate(tool, run.id);
    const prepared = f.repository.prepareToolInvocation({ runtimeRunId: run.id, toolCallId: randomUUID(), idempotencyKey: randomUUID(), tool });
    f.repository.resolveToolApproval(prepared.approval.id, prepared.approval.version, "allow-once");
    const executing = executor.execute(prepared.invocation.id), server = Reflect.get(http, "server") as import("node:http").Server;
    expect(server).not.toBeNull();
    server.once("listening", () => {
      // Force the real persisted retirement boundary while the approved OS bind is pending.
      const concurrent = new DatabaseSync(f.path); concurrent.prepare("DELETE FROM room_members WHERE room_id=? AND bot_id=?").run(room.room.id, f.owner.bot.id); concurrent.close();
    });
    await expect(executing).rejects.toThrow(); expect(http.snapshot()).toMatchObject({ listening: false, port: null, busy: false }); expect(server.listening).toBe(false);
  });

  it("retains durable event ancestry through an actual Routine and approved AI delegation", async () => {
    let release!: () => void, parentBotId = ""; const gate = new Promise<void>(resolve => { release = resolve; });
    const f = fixture(async function* (_messages, _signal, context) { yield { type: "started", requestId: randomUUID() }; if (context?.executorBotId === parentBotId) await gate; yield { type: "completed", finishReason: "stop" }; }); parentBotId = f.owner.bot.id;
    const origin = f.events.create({ name: "Origin", source: { kind: "webhook" }, routineId: f.saved.id, expectedRoutineVersion: f.saved.version, enabled: true }), credential = await f.events.rotateToken({ id: origin.id, expectedVersion: origin.version });
    const third = f.repository.createBot(), target = f.routines.create({ name: "Downstream", prompt: "Metadata only", botId: third.bot.id, enabled: true, schedule: f.saved.schedule });
    const downstream = f.events.create({ name: "Delegated completion", source: { kind: "runtime.completed", sessionId: f.other.session.id }, routineId: target.id, expectedRoutineVersion: target.version, enabled: true });
    try {
      const receipt = await f.events.receiveWebhook({ id: origin.id, version: credential.subscription.version, bearer: credential.token, eventId: "origin", payload: { data: "untrusted" } }), parent = f.repository.getRoutineRun(receipt.routineRunId!);
      await vi.waitFor(() => expect(f.repository.getRuntimeRun(parent.runtimeRunId!).state).toBe("running"));
      const workspace = new WorkspaceService(f.repository), executor = new WorkspaceToolExecutor(f.repository, workspace), tools = new WorkspaceToolCoordinator(f.repository, executor, () => {}), rooms = new RoomCoordinator(f.repository, f.worker.executor, { transcript: () => {}, roomRuntime: () => {} }); cleanup.push(() => rooms.shutdown());
      const product = new ProductOperationService({ repository: f.repository, routineService: f.routines, automationEventService: f.events, workspaceService: workspace, workspaceToolCoordinator: tools, sendWorker: f.worker, roomCoordinator: rooms, generalSettings: new GeneralSettingsService(f.repository), providers: { list: async () => [], isSupported: () => true }, updateService: {} } as unknown as ProductDependencies); executor.setProductOperations(product);
      const tool = call("messages.send", { sessionId: f.other.session.id, text: "Delegated task without forged provenance" }); product.validate(tool, parent.runtimeRunId!);
      const prepared = f.repository.prepareToolInvocation({ runtimeRunId: parent.runtimeRunId!, toolCallId: randomUUID(), idempotencyKey: randomUUID(), tool }); f.repository.resolveToolApproval(prepared.approval.id, prepared.approval.version, "allow-once");
      const child = JSON.parse((await executor.execute(prepared.invocation.id)).content).result as { runId: string; clientNonce: string };
      await vi.waitFor(() => expect(f.repository.getRuntimeRun(child.runId).state).toBe("completed"));
      expect(f.repository.getUserMessage(child.clientNonce).origin).toMatchObject({ kind: "ai-delegation", fromRuntimeRunId: parent.runtimeRunId, rootClientNonce: parent.clientNonce });
      const emit = vi.spyOn(f.events, "emitRuntime"); await emitAutomationRuntime(f.repository, f.events, f.repository.getRuntimeRun(child.runId));
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({ originRoutineRunId: parent.id }));
      expect(f.events.snapshot().deliveries.find(item => item.subscriptionId === downstream.id)).toMatchObject({ ancestry: [origin.id, downstream.id], state: "dispatched", routineRunId: expect.any(String) });
    } finally { release(); }
  });

  it("backs up and fills a later lower-numbered migration without losing existing higher versions or chat data", () => {
    const root = mkdtempSync(join(tmpdir(), "aevoren-event-gap-")), path = join(root, "app.sqlite");
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    let repository = new AppRepository(path); const owner = repository.createBot(); repository.close();
    const before = new DatabaseSync(path), oldRows = before.prepare("SELECT * FROM sessions ORDER BY id").all();
    expect(before.prepare("SELECT version FROM schema_migrations WHERE version>=46 ORDER BY version").all()).toEqual([{ version: 46 }, { version: 47 }, { version: 49 }]); before.close();
    const migrations = MIGRATIONS as unknown as Array<{ version: number; sql: string }>, index = migrations.findIndex(item => item.version === 49);
    migrations.splice(index, 0, { version: 48, sql: "CREATE TABLE event_gap_probe(id TEXT PRIMARY KEY)" });
    try {
      repository = new AppRepository(path); expect(repository.getSession(owner.session.id)).toEqual(owner.session); repository.close();
      const after = new DatabaseSync(path);
      expect(after.prepare("SELECT * FROM sessions ORDER BY id").all()).toEqual(oldRows);
      expect(after.prepare("SELECT version FROM schema_migrations WHERE version>=46 ORDER BY version").all()).toEqual([{ version: 46 }, { version: 47 }, { version: 48 }, { version: 49 }]);
      expect(after.prepare("PRAGMA foreign_key_check").all()).toEqual([]); after.close();
      expect(readdirSync(join(root, "Backups")).filter(name => name.endsWith(".sqlite"))).toHaveLength(1);
    } finally { migrations.splice(index, 1); }
  });
});
