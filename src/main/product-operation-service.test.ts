import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserProfileService } from "./user-profile-service";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductToolRequest, ResourceReference } from "@shared/contracts";
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
import { DemonstrationService } from "./demonstration-service";
import { LibraryService } from "./library-service";
import { MediaService } from "./media-service";
import type { MediaParserAdapter } from "./media-parser-types";
import { writeLibraryExport } from "./library-export";
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
  const workspaceService = new WorkspaceService(repository);
  const libraryService = new LibraryService(repository, join(root, "owned"), { workspaceService });
  const dependencies = { repository, libraryService, workspaceToolCoordinator: coordinator, sendWorker: worker, roomCoordinator: new RoomCoordinator(repository, worker.executor, { transcript: () => {}, roomRuntime: () => {} }), generalSettings: new GeneralSettingsService(repository), providers: { list: async () => [], isSupported: () => true }, updateService: {}, workspaceService, productChanged: vi.fn() } as unknown as ProductDependencies;
  const service = new ProductOperationService(dependencies);
  executor.setProductOperations(service);
  const prepare = (tool: ProductToolRequest, runtimeRunId = runtime.id) => repository.prepareToolInvocation({ runtimeRunId, toolCallId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), tool }, undefined, undefined, service.approvalReview(tool, runtimeRunId));
  const execute = async (tool: ProductToolRequest, runtimeRunId = runtime.id) => {
    const prepared = prepare(tool, runtimeRunId);
    repository.resolveToolApproval(prepared.approval.id, prepared.approval.version, "allow-once");
    return executor.execute(prepared.invocation.id);
  };
  return { root, repository, actor, runtime, executor, coordinator, service, prepare, execute, worker, dependencies, libraryService };
}
afterEach(async () => { for (const item of fixtures.splice(0)) { item.repository.close(); rmSync(item.root, { recursive: true, force: true }); } });
const call = (operation: string, input?: unknown): ProductToolRequest => ({ kind: "product-call", action: "execute", operation, ...(input === undefined ? {} : { input }) });

function libraryRuntime(repository: AppRepository, actor: ReturnType<AppRepository["createBot"]>, resourceRefs: ResourceReference[] = []) {
  const nonce = crypto.randomUUID();
  repository.prepareMessage({ sessionId: actor.session.id, clientNonce: nonce, text: "使用本轮资料", resourceRefs });
  const entry = repository.getUserMessage(nonce);
  const runtime = repository.createRuntimeRun(nonce, "fake", { schemaVersion: 1, botId: actor.bot.id, profileVersion: actor.bot.version,
    sessionId: actor.session.id, generation: actor.session.generation, inputSeq: entry.seq, blocks: [], digest: "library-tool-test" });
  repository.transitionRuntimeRun(runtime.id, "dispatching");
  return repository.transitionRuntimeRun(runtime.id, "running", { providerRequestId: "library-tool-test" });
}

describe("media product transport", () => {
  it("shares scoped UI handlers but keeps AI text outside durable tool receipts and rechecks revocation", async () => {
    const f = fixture();
    const text = "PRIVATE_EXTRACTED_TEXT";
    const parser: MediaParserAdapter = {
      parse: async () => ({ kind: "pdf", width: null, height: null, parserName: "controlled-unit-parser", parserVersion: "1",
        extraction: { text, spans: [{ kind: "page", index: 0, start: 0, end: text.length }], warningCodes: [] } }),
      renderPdfPage: async () => { throw new Error("not used"); }, shutdown: async () => {},
    };
    const media = new MediaService(f.repository, join(f.root, "media"), parser);
    const source = join(f.root, "private.pdf"); writeFileSync(source, "%PDF-1.7 controlled unit fixture");
    try {
      const item = (await media.importPaths(f.actor.session.id, [source])).imported[0]!;
      f.repository.transitionRuntimeRun(f.runtime.id, "completed");
      const runtime = libraryRuntime(f.repository, f.actor);
      f.dependencies.mediaService = media;
      const service = new ProductOperationService(f.dependencies);
      f.executor.setProductOperations(service);
      const tool = call("media.read", { id: item.reference.mediaId });
      const prepared = f.repository.prepareToolInvocation({ runtimeRunId: runtime.id, toolCallId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), tool });
      f.repository.resolveToolApproval(prepared.approval.id, prepared.approval.version, "allow-once");
      const result = await f.executor.execute(prepared.invocation.id);
      expect(result.modelText?.text).toBe(text);
      expect(result.modelText?.isAuthorized()).toBe(true);
      expect(result.content).not.toContain(text);
      expect(JSON.stringify(f.repository.getToolInvocation(prepared.invocation.id))).not.toContain(text);
      expect(service.requiresApproval(call("media.available"))).toBe(true);
      expect(service.requiresApproval(tool)).toBe(false);
      const ui = await service.handlers.get("media:read")!({ sessionId: f.actor.session.id, id: item.reference.mediaId });
      expect(ui).toMatchObject({ text });
      const other = f.repository.createBot();
      expect(() => service.validate(call("media.read", { sessionId: other.session.id, id: item.reference.mediaId }), runtime.id)).toThrow();
      media.unbind({ sessionId: f.actor.session.id, id: item.reference.mediaId });
      expect(result.modelText?.isAuthorized()).toBe(false);
      expect(() => service.validate(tool, runtime.id)).toThrow();
    } finally { await media.shutdown(); }
  });
});

describe("product operations", () => {
  it.each(["allow-once", "deny"] as const)("uses genuine approval for creation after a short reply: %s", async (decision) => {
    const provider: ModelProvider = {
      async *run(messages) {
        yield { type: "started", requestId: "product-follow-up" };
        if (messages.at(-1)?.role !== "tool") yield { type: "project-tool", toolCallId: "product-create", tool: call("bots.create") };
        else yield { type: "delta", text: decision === "allow-once" ? "已创建一个 Bot。" : "创建未执行。" };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const f = fixture(provider);
    const actor = f.repository.createBot();
    const sent = f.worker.send({ sessionId: actor.session.id, clientNonce: crypto.randomUUID(), text: "自媒体选题吧" });
    await expect.poll(() => f.repository.listToolInvocations(actor.session.id).at(-1)?.state).toBe("awaiting-approval");
    expect(f.repository.listBots()).toHaveLength(2);
    const invocation = f.repository.listToolInvocations(actor.session.id).at(-1)!;
    const approval = f.repository.getApprovalRequest(invocation.approvalRequestId);
    await f.coordinator.resolve(actor.session.id, approval.id, approval.version, decision);
    await expect.poll(() => f.repository.getRuntimeRun(sent.runId).state).toBe("completed");
    expect(f.repository.listBots()).toHaveLength(decision === "allow-once" ? 3 : 2);
    expect(f.repository.getToolInvocation(invocation.id).state).toBe(decision === "allow-once" ? "succeeded" : "denied");
  });

  it("discovers every UI operation and describes actual field constraints without keyword gating", async () => {
    const f = fixture();
    const catalog = JSON.parse((await f.execute({ kind: "product-call", action: "catalog" })).content);
    expect(catalog.operations).toHaveLength(PRODUCT_OPERATIONS.length);
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

  it.each(["library.read", "documents.read", "skills.read", "skills.load", "skills.readFile"])("pins implicit %s to this message's selected revision and permits an explicit other version", async (operation) => {
    const f = fixture();
    const first = f.libraryService.create({ sessionId: f.actor.session.id, kind: operation.startsWith("documents.") ? "document" : "skill", name: "Pinned resource", body: "PINNED_V1" });
    f.repository.transitionRuntimeRun(f.runtime.id, "completed");
    const runtime = libraryRuntime(f.repository, f.actor, [first.reference]);
    const second = f.libraryService.update({ sessionId: f.actor.session.id, id: first.resource.id, expectedVersion: 1, body: "EDITED_V2" });
    const input = { id: first.resource.id, ...(operation === "skills.readFile" ? { path: "SKILL.md" } : {}) };
    const implicit = JSON.parse((await f.execute(call(operation, input), runtime.id)).content).result;
    if (operation === "skills.readFile") expect(implicit.data).toBe("PINNED_V1");
    else expect(implicit.revision).toMatchObject({ id: first.revision.id, body: "PINNED_V1", digest: first.reference.digest });
    const explicit = JSON.parse((await f.execute(call(operation, { ...input, revisionId: second.revision.id }), runtime.id)).content).result;
    if (operation === "skills.readFile") expect(explicit.data).toBe("EDITED_V2");
    else expect(explicit.revision).toMatchObject({ id: second.revision.id, body: "EDITED_V2" });
    f.repository.library.unbind({ sessionId: f.actor.session.id, id: first.resource.id });
    await expect(f.execute(call(operation, input), runtime.id)).rejects.toMatchObject({ code: "LIBRARY_NOT_BOUND" });
  });

  it.each([
    ["unbind", "LIBRARY_NOT_BOUND"], ["disable", "LIBRARY_DISABLED"], ["delete", "LIBRARY_NOT_FOUND"],
  ])("refuses cached created document bodies after %s without creating another resource", async (change, code) => {
    const f = fixture();
    const command = call("documents.create", { name: "Receipt resource", body: "REVOKED_BODY_CANARY" });
    const created = JSON.parse((await f.execute(command)).content).result;
    const mutation = { sessionId: f.actor.session.id, id: created.resource.id, expectedVersion: created.resource.version };
    if (change === "unbind") f.repository.library.unbind({ sessionId: mutation.sessionId, id: mutation.id });
    else if (change === "disable") f.repository.library.setEnabled({ ...mutation, enabled: false });
    else f.repository.library.delete(mutation);
    await expect(f.execute(command)).rejects.toMatchObject({ code });
    expect(f.repository.library.available({ includeDisabled: true, includeDeleted: true })).toHaveLength(1);
    expect(f.repository.productResourceCount(f.runtime.clientNonce)).toBe(1);
  });

  it("refuses cached update and restored-version bodies after revocation without writing another revision", async () => {
    const f = fixture();
    const original = f.libraryService.create({ sessionId: f.actor.session.id, kind: "document", name: "Versions", body: "VERSION_ONE" });
    const update = call("documents.update", { id: original.resource.id, expectedVersion: 1, body: "VERSION_TWO" });
    const second = JSON.parse((await f.execute(update)).content).result;
    f.repository.library.unbind({ sessionId: f.actor.session.id, id: original.resource.id });
    await expect(f.execute(update)).rejects.toMatchObject({ code: "LIBRARY_NOT_BOUND" });
    f.repository.library.bind({ sessionId: f.actor.session.id, id: original.resource.id });
    expect(f.repository.library.versions({ sessionId: f.actor.session.id, id: original.resource.id })).toHaveLength(2);
    const restore = call("documents.restoreVersion", { id: original.resource.id, expectedVersion: second.resource.version, revisionId: original.revision.id });
    const restored = JSON.parse((await f.execute(restore)).content).result;
    f.repository.library.setEnabled({ sessionId: f.actor.session.id, id: original.resource.id, expectedVersion: restored.resource.version, enabled: false });
    await expect(f.execute(restore)).rejects.toMatchObject({ code: "LIBRARY_DISABLED" });
    expect(f.repository.library.versions({ sessionId: f.actor.session.id, id: original.resource.id, includeDisabled: true })).toHaveLength(3);
  });

  it("rechecks every cached import body and refuses a revoked member of the imported array", async () => {
    const f = fixture();
    const source = join(f.root, "sources");
    mkdirSync(join(source, "batch"), { recursive: true });
    writeFileSync(join(source, "batch", "one.md"), "IMPORTED_ONE");
    writeFileSync(join(source, "batch", "two.md"), "IMPORTED_TWO");
    const registration = await f.dependencies.workspaceService.registerRoot(source);
    const actor = f.repository.createBot(registration.project.id);
    const runtime = libraryRuntime(f.repository, actor);
    const command = call("documents.import", { workspaceId: registration.workspace.id, path: "batch" });
    const first = JSON.parse((await f.execute(command, runtime.id)).content).result;
    f.repository.library.unbind({ sessionId: actor.session.id, id: first.imported[0].resource.id });
    rmSync(source, { recursive: true });
    await expect(f.execute(command, runtime.id)).rejects.toMatchObject({ code: "LIBRARY_NOT_BOUND" });
    expect(f.repository.library.available()).toHaveLength(2);
  });

  it("exports the current message's selected version by default while accepting an explicit later version", async () => {
    const f = fixture();
    const first = f.libraryService.create({ sessionId: f.actor.session.id, kind: "document", name: "Pinned export", body: "EXPORT_V1" });
    f.repository.transitionRuntimeRun(f.runtime.id, "completed");
    const runtime = libraryRuntime(f.repository, f.actor, [first.reference]);
    const second = f.libraryService.update({ sessionId: f.actor.session.id, id: first.resource.id, expectedVersion: 1, body: "EXPORT_V2" });
    f.dependencies.exportLibraryResource = vi.fn(async (input, signal) => {
      const snapshot = await f.libraryService.prepareExport(input, signal);
      const path = await writeLibraryExport(snapshot, join(f.root, `${crypto.randomUUID()}.md`), signal,
        () => { f.repository.library.read(input, f.actor.bot.id); });
      return { path, resourceId: snapshot.resourceId, revisionId: snapshot.revisionId };
    });
    const implicit = JSON.parse((await f.execute(call("documents.export", { id: first.resource.id }), runtime.id)).content).result;
    expect(implicit.revisionId).toBe(first.revision.id);
    expect(readFileSync(implicit.path, "utf8")).toBe("EXPORT_V1");
    const explicit = JSON.parse((await f.execute(call("documents.export", { id: first.resource.id, revisionId: second.revision.id }), runtime.id)).content).result;
    expect(explicit.revisionId).toBe(second.revision.id);
    expect(readFileSync(explicit.path, "utf8")).toBe("EXPORT_V2");
  });

  it.each(["library.export", "documents.export", "skills.export"])("reports repeated %s only as a historical receipt after the actual output is deleted", async (operation) => {
    const f = fixture();
    const content = f.libraryService.create({ sessionId: f.actor.session.id, kind: operation === "skills.export" ? "skill" : "document", name: "Export receipt", body: "EXPORTED_CONTENT" });
    f.dependencies.exportLibraryResource = vi.fn(async (input, signal) => {
      const snapshot = await f.libraryService.prepareExport(input, signal);
      const path = await writeLibraryExport(snapshot, join(f.root, snapshot.kind === "skill" ? "exported-skill" : "exported.md"), signal,
        () => { f.repository.library.read(input, f.actor.bot.id); });
      return { path, resourceId: snapshot.resourceId, revisionId: snapshot.revisionId };
    });
    const command = call(operation, { id: content.resource.id });
    const first = JSON.parse((await f.execute(command)).content);
    expect(existsSync(first.result.path)).toBe(true);
    rmSync(first.result.path, { recursive: true });
    const replay = await f.execute(command);
    const output = JSON.parse(replay.content);
    expect(output).toMatchObject({ status: "previously_completed", reused: true, outputVerification: "not_rechecked", result: first.result });
    expect(replay.invocation.resultMetadata).toMatchObject({ status: "previously_completed", reused: true, outputVerification: "not_rechecked" });
    expect(f.dependencies.exportLibraryResource).toHaveBeenCalledTimes(1);
    expect(existsSync(output.result.path)).toBe(false);
  });

  it("keeps a cancelled export cancelled when its receipt is reused", async () => {
    const f = fixture();
    const content = f.libraryService.create({ sessionId: f.actor.session.id, kind: "document", name: "Cancelled export", body: "content" });
    f.dependencies.exportLibraryResource = vi.fn(async () => null);
    const command = call("documents.export", { id: content.resource.id });
    expect(JSON.parse((await f.execute(command)).content).status).toBe("cancelled");
    expect(JSON.parse((await f.execute(command)).content)).toMatchObject({ status: "cancelled", reused: true, result: null });
    expect(f.dependencies.exportLibraryResource).toHaveBeenCalledTimes(1);
  });

  it("marks cached binding metadata as a prior receipt without silently granting access again", async () => {
    const f = fixture();
    const content = f.libraryService.create({ sessionId: f.actor.session.id, kind: "document", name: "Binding receipt", body: "body" });
    const command = call("library.bind", { id: content.resource.id });
    const first = JSON.parse((await f.execute(command)).content);
    f.repository.library.unbind({ sessionId: f.actor.session.id, id: content.resource.id });
    const replay = JSON.parse((await f.execute(command)).content);
    expect(replay).toMatchObject({ reused: true, result: first.result });
    expect(replay.receiptNotice).toContain("首次操作回执");
    expect(() => f.repository.library.read({ sessionId: f.actor.session.id, id: content.resource.id })).toThrow(/未授权/);
  });
});


describe("demonstration product approvals", () => {
  it("requires genuine approval and publishes a fixed saved draft once, initially disabled", async () => {
    const f = fixture();
    f.dependencies.demonstrationService = new DemonstrationService(f.repository, { demonstrationRequest: async () => null }, f.libraryService);
    const now = new Date().toISOString(), scope = { sessionId: f.actor.session.id, executorBotId: f.actor.bot.id };
    const draft = f.repository.demonstrations.create(scope, { id: crypto.randomUUID(), browserSessionId: crypto.randomUUID(), epoch: 2, state: "stopped", reason: null, events: [{ kind: "redacted-text" }], eventCount: 1, createdAt: now, updatedAt: now });
    const tool = call("demonstrations.publish", { id: draft.id, expectedVersion: 1, expectedDigest: draft.digest });
    expect(f.service.requiresApproval(tool)).toBe(true); expect(f.service.requiresApproval(call("demonstrations.readDraft", { id: draft.id }))).toBe(false);
    const pending = f.prepare(tool);
    expect(await f.service.handlers.get("approvals:review")!({ ...scope, id: pending.approval.id, expectedVersion: pending.approval.version })).toMatchObject({ executable: true, snapshot: { kind: "demonstration-skill", resourceName: draft.name, target: { body: draft.body, draftDigest: draft.digest, initiallyEnabled: false } } });
    await expect(f.executor.execute(pending.invocation.id)).rejects.toMatchObject({ code: "TOOL_STATE_INVALID" }); expect(f.repository.library.list({ sessionId: scope.sessionId, includeDisabled: true })).toHaveLength(0);
    f.repository.resolveToolApproval(pending.approval.id, pending.approval.version, "allow-once"); const receipt = JSON.parse((await f.executor.execute(pending.invocation.id)).content); expect(receipt.result.resource.enabled).toBe(false); expect(receipt.result.revision.body).toBe(draft.body);
    const replay = JSON.parse((await f.execute(tool)).content); expect(replay.status).toBe("previously_completed"); expect(replay.result.resource.id).toBe(receipt.result.resource.id); expect(f.repository.library.list({ sessionId: scope.sessionId, includeDisabled: true })).toHaveLength(1);
    const request = await f.execute(call("demonstrations.start", { id: crypto.randomUUID(), expectedEpoch: 2 })); expect(JSON.parse(request.content).status).toBe("waiting_user");
  });
  it("a saved draft edit after approval invalidates the old digest without publishing", async () => {
    const f = fixture(); f.dependencies.demonstrationService = new DemonstrationService(f.repository, { demonstrationRequest: async () => null }, f.libraryService);
    const scope = { sessionId: f.actor.session.id, executorBotId: f.actor.bot.id }, now = new Date().toISOString(); const draft = f.repository.demonstrations.create(scope, { id: crypto.randomUUID(), browserSessionId: crypto.randomUUID(), epoch: 2, state: "stopped", reason: null, events: [], eventCount: 0, createdAt: now, updatedAt: now });
    const pending = f.prepare(call("demonstrations.publish", { id: draft.id, expectedVersion: 1, expectedDigest: draft.digest })); f.repository.resolveToolApproval(pending.approval.id, pending.approval.version, "allow-once");
    f.repository.demonstrations.update({ ...scope, id: draft.id, expectedVersion: 1, name: "Changed draft", body: draft.body + "\nCHANGED_AFTER_APPROVAL" });
    await expect(f.executor.execute(pending.invocation.id)).rejects.toMatchObject({ code: "DEMONSTRATION_VERSION_CONFLICT" }); expect(f.repository.library.list({ sessionId: scope.sessionId, includeDisabled: true })).toHaveLength(0);
  });
  it.each(["unbind", "delete"] as const)("rechecks the original published Skill before a cached receipt after %s", async change => {
    const f = fixture(); f.dependencies.demonstrationService = new DemonstrationService(f.repository, { demonstrationRequest: async () => null }, f.libraryService);
    const scope = { sessionId: f.actor.session.id, executorBotId: f.actor.bot.id }, now = new Date().toISOString();
    const draft = f.repository.demonstrations.create(scope, { id: crypto.randomUUID(), browserSessionId: crypto.randomUUID(), epoch: 2, state: "stopped", reason: null, events: [], eventCount: 0, createdAt: now, updatedAt: now });
    const tool = call("demonstrations.publish", { id: draft.id, expectedVersion: draft.version, expectedDigest: draft.digest });
    const first = JSON.parse((await f.execute(tool)).content).result as import("@shared/library-contracts").LibraryContent;
    const edited = f.repository.library.update({ sessionId: scope.sessionId, id: first.resource.id, expectedVersion: first.resource.version, body: draft.body + "\nLATER_LIBRARY_EDIT" });
    const replay = JSON.parse((await f.execute(tool)).content).result as import("@shared/library-contracts").LibraryContent;
    expect(replay.revision.id).toBe(first.revision.id); expect(replay.revision.body).toBe(draft.body); expect(replay.resource.enabled).toBe(false);
    if (change === "unbind") f.repository.library.unbind({ sessionId: scope.sessionId, id: first.resource.id });
    else f.repository.library.delete({ sessionId: scope.sessionId, id: first.resource.id, expectedVersion: edited.resource.version });
    await expect(f.execute(tool)).rejects.toBeDefined();
    const saved = f.repository.demonstrations.read(scope, draft.id); expect(saved.publishedResourceId).toBe(first.resource.id);
    const resources = f.repository.library.available({ includeDeleted: true, includeDisabled: true });
    expect(resources).toHaveLength(1); expect(resources[0]?.enabled).toBe(false);
  });
});
