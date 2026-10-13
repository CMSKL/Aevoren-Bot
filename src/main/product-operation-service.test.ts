import { mkdtempSync, rmSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserProfileService } from "./user-profile-service";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductToolRequest } from "@shared/contracts";
import { PRODUCT_OPERATIONS } from "@shared/product-operations";
import { AppRepository } from "./database";
import { ProductOperationService } from "./product-operation-service";
import type { ProductDependencies } from "./product-handlers";
import { GeneralSettingsService } from "./settings";
import { WorkspaceService } from "./workspace-service";
import { WorkspaceToolExecutor } from "./workspace-tool-executor";
import { WorkspaceToolCoordinator } from "./workspace-tool-coordinator";
import { SendWorker } from "./send-worker";
import { RoomCoordinator } from "./room-coordinator";
import type { ModelProvider } from "./model";
vi.mock("electron", () => ({ clipboard: { writeText: vi.fn() } }));

const fixtures: Array<{ repository: AppRepository; root: string }> = [];
function fixture(provider?: ModelProvider) {
  const root = mkdtempSync(join(tmpdir(), "aevoren-product-"));
  const repository = new AppRepository(join(root, "app.sqlite"));
  fixtures.push({ repository, root });
  const actor = repository.createBot();
  const nonce = crypto.randomUUID();
  repository.prepareMessage({ sessionId: actor.session.id, clientNonce: nonce, text: "创建自媒体群并管理设置" });
  const runtime = repository.createRuntimeRun(nonce, "fake", { schemaVersion: 1, botId: actor.bot.id, profileVersion: 1, sessionId: actor.session.id, generation: 1, inputSeq: 1, blocks: [], digest: "product-test" });
  repository.transitionRuntimeRun(runtime.id, "dispatching");
  repository.transitionRuntimeRun(runtime.id, "running", { providerRequestId: "test" });
  const executor = new WorkspaceToolExecutor(repository, new WorkspaceService(repository));
  const coordinator = new WorkspaceToolCoordinator(repository, executor, () => {});
  const worker = new SendWorker(repository, null, { transcript: () => {}, sendState: () => {}, runtime: () => {} }, false, provider, undefined, coordinator);
  const dependencies = { repository, workspaceToolCoordinator: coordinator, sendWorker: worker, roomCoordinator: new RoomCoordinator(repository, worker.executor, { transcript: () => {}, roomRuntime: () => {} }), generalSettings: new GeneralSettingsService(repository), providers: { list: async () => [], isSupported: () => true }, updateService: {}, workspaceService: new WorkspaceService(repository), productChanged: vi.fn() } as unknown as ProductDependencies;
  const service = new ProductOperationService(dependencies);
  executor.setProductOperations(service);
  const prepare = (tool: ProductToolRequest) => repository.prepareToolInvocation({ runtimeRunId: runtime.id, toolCallId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), tool });
  const execute = async (tool: ProductToolRequest) => {
    const prepared = prepare(tool);
    repository.resolveToolApproval(prepared.approval.id, prepared.approval.version, "allow-once");
    return executor.execute(prepared.invocation.id);
  };
  return { root, repository, actor, runtime, executor, coordinator, service, prepare, execute, worker, dependencies };
}
afterEach(async () => { for (const item of fixtures.splice(0)) { item.repository.close(); rmSync(item.root, { recursive: true, force: true }); } });
const call = (operation: string, input?: unknown): ProductToolRequest => ({ kind: "product-call", action: "execute", operation, ...(input === undefined ? {} : { input }) });

describe("product operations", () => {
  it("discovers every UI operation and describes actual field constraints without keyword gating", async () => {
    const f = fixture();
    const catalog = JSON.parse((await f.execute({ kind: "product-call", action: "catalog" })).content);
    expect(catalog.operations).toHaveLength(103);
    expect(new Set(catalog.operations.map((op: { name: string }) => op.name))).toEqual(new Set(PRODUCT_OPERATIONS.map((op) => op.name)));
    const description = JSON.parse((await f.execute({ kind: "product-call", action: "describe", operation: "settings.saveGeneral" })).content);
    expect(description.inputSchema.properties.theme.enum).toEqual(["system", "light", "dark"]);
    expect(description.approvalRequired).toBe(true);
    expect(JSON.stringify(catalog)).not.toContain('"channel"');
  });
  it("does not mutate settings before genuine user approval and records the actual persisted value", async () => {
    const f = fixture();
    const pending = f.prepare(call("settings.saveGeneral", { theme: "dark" }));
    await expect(f.executor.execute(pending.invocation.id)).rejects.toMatchObject({ code: "TOOL_STATE_INVALID" });
    expect(f.dependencies.generalSettings.getConfiguration().theme).toBe("system");
    f.repository.resolveToolApproval(pending.approval.id, pending.approval.version, "allow-once");
    const changed = await f.executor.execute(pending.invocation.id);
    expect(JSON.parse(changed.content)).toMatchObject({ status: "completed", result: { theme: "dark" } });
    expect(changed.invocation.effectClass).toBe("write-reversible");
    expect(f.dependencies.generalSettings.getConfiguration().theme).toBe("dark");
  });
  it("creates an actual team and group atomically and reuses an identical request", async () => {
    const f = fixture();
    const command = call("teams.createContentTeam", {});
    const first = JSON.parse((await f.execute(command)).content);
    const second = JSON.parse((await f.execute(command)).content);
    expect(second).toEqual(first);
    expect(f.repository.listBots()).toHaveLength(6);
    expect(f.repository.listRooms()).toHaveLength(1);
    expect(f.repository.listRoomMembers(f.repository.listRooms()[0]!.id)).toHaveLength(5);
  });
  it("normalizes defaults and JSON field order before mutating requests are journaled", async () => {
    const f = fixture();
    const first = await f.execute(call("bots.create"));
    const second = await f.execute(call("bots.create", {}));
    expect(second.content).toEqual(first.content);
    const a = await f.execute(call("settings.saveGeneral", { theme: "dark", memoryCaptureEnabled: false }));
    const b = await f.execute(call("settings.saveGeneral", { memoryCaptureEnabled: false, theme: "dark" }));
    expect(b.content).toEqual(a.content);
    expect(f.repository.listBots()).toHaveLength(2);
    const unknown = f.prepare(call("bots.create", { projectId: undefined }));
    f.repository.resolveToolApproval(unknown.approval.id, unknown.approval.version, "allow-once");
    f.repository.transitionToolInvocation(unknown.invocation.id, "dispatching");
    f.repository.transitionToolInvocation(unknown.invocation.id, "running");
    const raw = new DatabaseSync(join(f.root, "app.sqlite"));
    raw.prepare("UPDATE tool_invocations SET state = 'interrupted-unknown' WHERE id = ?").run(unknown.invocation.id); raw.close();
    expect(() => f.repository.assertProductReplaySafe(f.runtime.clientNonce, call("bots.create", null))).toThrow();
  });
  it("shares the creation budget with legacy tools and does not count reused resources", async () => {
    const f = fixture();
    await f.execute(call("teams.createContentTeam", {}));
    const legacy = (name: string) => {
      const prepared = f.repository.prepareToolInvocation({ runtimeRunId: f.runtime.id, toolCallId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), tool: { kind: "bot-create", name, label: "", description: "", instructions: "" } });
      f.repository.resolveToolApproval(prepared.approval.id, prepared.approval.version, "allow-once");
      f.repository.transitionToolInvocation(prepared.invocation.id, "dispatching");
      f.repository.transitionToolInvocation(prepared.invocation.id, "running");
      return f.repository.executeProjectCreation(prepared.invocation.id);
    };
    legacy("one"); legacy("one"); legacy("two");
    expect(f.repository.productResourceCount(f.runtime.clientNonce)).toBe(8);
    expect(() => legacy("three")).toThrowError(expect.objectContaining({ code: "PROJECT_CREATION_LIMIT" }));
  });
  it("updates only the nickname while keeping the locally stored avatar", async () => {
    const f = fixture();
    const chunk = (type: string, bytes: Buffer) => {
      const block = Buffer.alloc(bytes.length + 12); block.writeUInt32BE(bytes.length); block.write(type, 4); bytes.copy(block, 8);
      let crc = 0xffffffff;
      for (const byte of block.subarray(4, -4)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
      block.writeUInt32BE((crc ^ 0xffffffff) >>> 0, block.length - 4); return block;
    };
    const header = Buffer.alloc(13); header.writeUInt32BE(256); header.writeUInt32BE(256, 4); header[8] = 8; header[9] = 6;
    const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.alloc(256 * (256 * 4 + 1)))), chunk("IEND", Buffer.alloc(0))]);
    const profile = new UserProfileService(f.repository);
    profile.update({ name: "原名", avatarUrl: `data:image/png;base64,${png.toString("base64")}` });
    const before = profile.get().avatarUrl;
    const output = await f.execute(call("userProfile.update", { name: "新名" }));
    expect(JSON.parse(output.content).result).toEqual({ name: "新名", hasAvatar: true });
    expect(output.content).not.toContain("data:image/");
    expect(profile.get()).toEqual({ name: "新名", avatarUrl: before });
  });
  it("cancels live descendants even after the intermediate sender has completed", () => {
    const f = fixture();
    const child = (parent: typeof f.runtime, depth: number) => {
      const bot = f.repository.createBot(); const nonce = crypto.randomUUID();
      f.repository.prepareMessage({ sessionId: bot.session.id, clientNonce: nonce, text: "委派任务" }, { kind: "ai-delegation", fromBotId: parent.executorBotId, fromSessionId: parent.sessionId, fromRuntimeRunId: parent.id, rootClientNonce: f.runtime.clientNonce, depth, ancestorRunIds: ["forged"] });
      const run = f.repository.createRuntimeRun(nonce, "fake", { schemaVersion: 1, botId: bot.bot.id, profileVersion: 1, sessionId: bot.session.id, generation: 1, inputSeq: 1, blocks: [], digest: "delegation-test" });
      f.repository.transitionRuntimeRun(run.id, "dispatching");
      return f.repository.transitionRuntimeRun(run.id, "running", { providerRequestId: "test" });
    };
    const b = child(f.runtime, 1); const c = child(b, 2);
    expect(f.repository.getUserMessage(c.clientNonce).origin?.ancestorRunIds).toEqual([f.runtime.id, b.id]);
    f.repository.transitionRuntimeRun(b.id, "completed");
    f.worker.executor.setDelegationCancellation((id) => { for (const item of f.repository.listDelegatedRuntimeRuns(id)) f.worker.executor.cancelRun(item.id); });
    f.worker.executor.cancelRun(b.id);
    expect(f.repository.getRuntimeRun(c.id).state).toBe("cancel-requested");
    expect(f.repository.listDelegatedRuntimeRuns(f.runtime.id).map((item) => item.id)).toContain(c.id);
  });
  it("schedules an approved update instead of blocking on the source Runtime", async () => {
    const f = fixture();
    f.dependencies.requestUpdateAfterRun = vi.fn(() => ({ status: "running" as const, result: { scheduled: true } }));
    expect(JSON.parse((await f.execute(call("updates.installAndRestart"))).content)).toMatchObject({ status: "running", result: { scheduled: true } });
    expect(f.dependencies.requestUpdateAfterRun).toHaveBeenCalledWith(f.runtime.id);
  });
  it("rolls the whole team back if the success receipt fails to commit", async () => {
    const f = fixture();
    const raw = new DatabaseSync(join(f.root, "app.sqlite"));
    raw.exec("CREATE TRIGGER reject_product_success BEFORE UPDATE OF state ON tool_invocations WHEN NEW.state = 'succeeded' BEGIN SELECT RAISE(ABORT, 'receipt failed'); END;");
    raw.close();
    await expect(f.execute(call("teams.createContentTeam", {}))).rejects.toMatchObject({ code: "TOOL_EXECUTION_FAILED" });
    expect(f.repository.listBots()).toHaveLength(1);
    expect(f.repository.listRooms()).toHaveLength(0);
  });
  it("keeps private metadata and folder paths out of automatic directory reads", async () => {
    const f = fixture();
    const other = f.repository.createBot();
    f.repository.updateBot(other.bot.id, other.bot.version, { instructions: "private role instructions" });
    const output = JSON.parse((await f.execute(call("bots.list"))).content);
    expect(output.result).toHaveLength(2);
    expect(JSON.stringify(output)).not.toContain("private role instructions");
    expect(f.service.requiresApproval(call("transcript.list", other.session.id))).toBe(true);
  });
  it("rejects unknown actions, model-supplied identity and raw API credentials before execution", () => {
    const f = fixture();
    expect(() => f.service.validate(call("system.shell", {}), f.runtime.id)).toThrow();
    expect(() => f.service.validate(call("capabilities.getSnapshot", { botId: crypto.randomUUID() }), f.runtime.id)).toThrow();
    expect(() => f.service.validate(call("providers.saveOpenAiCompatible", { instanceId: "openai-compatible.default", expectedVersion: 1, baseUrl: "https://example.com/v1", apiKey: "do-not-log-this" }), f.runtime.id)).toThrow();
  });
  it("forwards an exact genuine user decision but never grants approval without it", async () => {
    const f = fixture();
    const waiting = f.coordinator.requestAndWait(f.runtime.id, "target-theme", call("settings.saveGeneral", { theme: "dark" }), new AbortController().signal);
    const target = f.repository.listPendingApprovalRequests(f.actor.session.id)[0]!;
    const requested = f.prepare(call("approvals.resolve", { sessionId: f.actor.session.id, id: target.id, expectedVersion: target.version, resolution: "allow-once" }));
    await expect(f.executor.execute(requested.invocation.id)).rejects.toMatchObject({ code: "TOOL_STATE_INVALID" });
    expect(f.repository.getApprovalRequest(target.id).state).toBe("pending");
    f.repository.resolveToolApproval(requested.approval.id, requested.approval.version, "allow-once");
    const output = JSON.parse((await f.executor.execute(requested.invocation.id)).content);
    expect(output.status).toBe("completed");
    expect(JSON.parse((await waiting).content).result.theme).toBe("dark");
    expect(f.repository.getApprovalRequest(target.id).state).toBe("allowed");
  });

  it("returns only the owned group batch and its real member replies", async () => {
    const provider: ModelProvider = { async *run() { yield { type: "started", requestId: "member" }; yield { type: "delta", text: "成员测试回复" }; yield { type: "completed", finishReason: "stop" }; }, testConnection: async () => {} };
    const f = fixture(provider);
    const b = f.repository.createBot(); const c = f.repository.createBot();
    const room = f.repository.createRoom({ memberBotIds: [b.bot.id, c.bot.id], name: "委派测试群" });
    const sent = JSON.parse((await f.execute(call("roomRuntime.send", { roomId: room.room.id, sessionId: room.session.id, text: "请回复问候", targetBotIds: [b.bot.id, c.bot.id], routingMode: "explicit" }))).content);
    const output = JSON.parse((await f.execute(call("tasks.waitRoomResult", { batchId: sent.result.batchId, timeoutMs: 5_000 }))).content);
    expect(output.result.state).toBe("completed");
    expect(output.result.replies).toHaveLength(2);
    expect(output.result.replies.every((reply: { response: { body: string } }) => reply.response.body === "成员测试回复")).toBe(true);
    const other = f.repository.createRoom({ memberBotIds: [f.actor.bot.id, b.bot.id] });
    const run = await f.dependencies.roomCoordinator.routeAndSend({ roomId: other.room.id, sessionId: other.session.id, clientNonce: crypto.randomUUID(), text: "其他群任务", targetBotIds: [b.bot.id], routingMode: "explicit" });
    expect(() => f.service.validate(call("tasks.getRoomResult", { batchId: run.batchId }), f.runtime.id)).toThrow();
    await f.worker.shutdown(); await f.dependencies.roomCoordinator.shutdown();
  });
  it("returns invalid product parameters to the model so it can recover without failing the Runtime", async () => {
    let round = 0;
    const outcomes: string[] = [];
    const provider: ModelProvider = { async *run(messages) {
      outcomes.push(JSON.stringify(messages)); yield { type: "started", requestId: "validation-recovery" };
      round += 1;
      if (round <= 2) {
        yield { type: "project-tool", toolCallId: `recovery-${round}`, providerToolName: round === 1 ? "product_execute" : "product_catalog", tool: round === 1 ? call("settings.saveGeneral", { theme: "purple" }) : { kind: "product-call", action: "catalog" } };
        yield { type: "completed", finishReason: "tool_calls" };
      } else { yield { type: "delta", text: "已取得实际功能目录" }; yield { type: "completed", finishReason: "stop" }; }
    }, testConnection: async () => {} };
    const f = fixture(provider); const bot = f.repository.createBot();
    const sent = f.worker.send({ sessionId: bot.session.id, clientNonce: crypto.randomUUID(), text: "查询产品功能目录" });
    await expect.poll(() => f.repository.getRuntimeRun(sent.runId).state).toBe("completed");
    expect(outcomes.at(-1)).toContain("INVALID_REQUEST");
    expect(f.repository.listPendingApprovalRequests(bot.session.id)).toEqual([]);
    expect(f.dependencies.generalSettings.getConfiguration().theme).toBe("system");
    await f.worker.shutdown();
  });
  it("persists delegated identity and sends only the delegated task to the recipient model", async () => {
    let prompt = "";
    const provider: ModelProvider = { async *run(messages) { prompt = JSON.stringify(messages); yield { type: "started", requestId: "recipient" }; yield { type: "delta", text: "实际回复：脚本已起草" }; yield { type: "completed", finishReason: "stop" }; }, testConnection: async () => {} };
    const f = fixture(provider);
    const recipient = f.repository.createBot();
    const old = crypto.randomUUID();
    f.repository.prepareMessage({ sessionId: recipient.session.id, clientNonce: old, text: "PRIVATE_HISTORY_DO_NOT_SHARE" });
    f.repository.createMemory(recipient.bot.id, "PRIVATE_MEMORY_DO_NOT_SHARE");
    const output = JSON.parse((await f.execute(call("messages.send", { sessionId: recipient.session.id, text: "请起草自媒体脚本" }))).content);
    await expect.poll(() => f.repository.getRuntimeRun(output.result.runId).state).toBe("completed");
    const input = f.repository.getUserMessage(output.result.clientNonce);
    expect(input.origin).toMatchObject({ kind: "ai-delegation", fromBotId: f.actor.bot.id, depth: 1 });
    expect(prompt).toContain("AI_DELEGATED_TASK");
    expect(prompt).not.toContain("PRIVATE_HISTORY_DO_NOT_SHARE");
    expect(prompt).not.toContain("PRIVATE_MEMORY_DO_NOT_SHARE");
    expect(f.repository.getRuntimeRun(output.result.runId).assistantEntryId).toBeTruthy();
    const receipt = JSON.parse((await f.execute(call("tasks.getResult", { runId: output.result.runId }))).content);
    expect(receipt.result.response.body).toContain("实际回复");
    const other = f.repository.createBot();
    const another = f.worker.send({ sessionId: other.session.id, clientNonce: crypto.randomUUID(), text: "private task" });
    expect(() => f.service.validate(call("tasks.getResult", { runId: another.runId }), f.runtime.id)).toThrow();
    await f.worker.shutdown();
  });
});
