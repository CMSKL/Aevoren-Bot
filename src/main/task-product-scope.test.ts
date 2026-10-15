import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductToolRequest, RuntimeRun } from "@shared/contracts";
import type { TaskExecutorSelection } from "@shared/task-session-contracts";
import { AppRepository } from "./database";
import { ProductOperationService } from "./product-operation-service";
import type { ProductDependencies } from "./product-handlers";
import { GeneralSettingsService } from "./settings";
import { WorkspaceService } from "./workspace-service";
import { WorkspaceToolExecutor } from "./workspace-tool-executor";
import { WorkspaceToolCoordinator } from "./workspace-tool-coordinator";
import { SendWorker } from "./send-worker";
import { RoomCoordinator } from "./room-coordinator";
vi.mock("electron", () => ({ clipboard: { writeText: vi.fn() } }));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const operations = ["transcript.list", "transcript.page", "runtime.getSessionSnapshot", "roomRuntime.getSnapshot", "messages.getStatus", "runtime.cancel", "memories.list"];
const call = (operation: string, input: unknown): ProductToolRequest => ({ kind: "product-call", action: "execute", operation, input });
function fixture(patch: Partial<TaskExecutorSelection> = {}) {
  const repository = new AppRepository(":memory:"), owner = repository.createBot();
  const executor = new WorkspaceToolExecutor(repository, new WorkspaceService(repository));
  const tools = new WorkspaceToolCoordinator(repository, executor, () => {});
  const worker = new SendWorker(repository, null, { transcript: () => {}, sendState: () => {}, runtime: () => {} });
  const rooms = new RoomCoordinator(repository, worker.executor, { transcript: () => {}, roomRuntime: () => {} });
  cleanup.push(async () => { await worker.shutdown(); await rooms.shutdown(); repository.close(); });
  const service = new ProductOperationService({ repository, workspaceService: new WorkspaceService(repository), workspaceToolCoordinator: tools, sendWorker: worker, roomCoordinator: rooms,
    generalSettings: new GeneralSettingsService(repository), providers: { list: async () => [], isSupported: () => true }, updateService: {}, productChanged: () => {} } as unknown as ProductDependencies);
  executor.setProductOperations(service);
  const selection = (changes: Partial<TaskExecutorSelection> = {}): TaskExecutorSelection => ({ executorBotId: owner.bot.id, memories: [], history: [], workspaces: [], mcp: [], resourceRefs: [], mediaRefs: [], productOperations: operations, network: false, clipboard: false, ...patch, ...changes });
  const create = (changes: Partial<TaskExecutorSelection> = {}) => repository.tasks.create({ parentSessionId: owner.session.id, expectedScopeVersion: repository.tasks.scopeVersion(owner.session.id), clientNonce: randomUUID(), title: "Scoped product task", selections: [selection(changes)] });
  const runtime = (sessionId: string, text = "CURRENT_TASK_ONLY"): RuntimeRun => {
    const nonce = randomUUID(); repository.prepareMessage({ sessionId, clientNonce: nonce, text }); const entry = repository.getUserMessage(nonce);
    const run = repository.createRuntimeRun(nonce, "fake", { schemaVersion: 1, botId: owner.bot.id, profileVersion: owner.bot.version, sessionId, generation: entry.generation, inputSeq: entry.seq, blocks: [], digest: "task-product-test" });
    repository.transitionRuntimeRun(run.id, "dispatching"); return repository.transitionRuntimeRun(run.id, "running", { providerRequestId: "controlled" });
  };
  const execute = async (tool: ProductToolRequest, run: RuntimeRun) => {
    service.validate(tool, run.id);
    const prepared = repository.prepareToolInvocation({ runtimeRunId: run.id, toolCallId: randomUUID(), idempotencyKey: randomUUID(), tool });
    repository.resolveToolApproval(prepared.approval.id, prepared.approval.version, "allow-once");
    return executor.execute(prepared.invocation.id);
  };
  return { repository, owner, worker, rooms, service, create, runtime, execute };
}

describe("TASK product inputs preserve the current thread and selected context", () => {
  it.each(["MAIN", "sibling TASK"])("rejects history, state and cancellation targets from %s before approval", targetKind => {
    const f = fixture(), child = f.create(), current = f.runtime(child.session.id);
    const other = targetKind === "MAIN" ? f.owner.session : f.create().session;
    const target = f.runtime(other.id, "PRIVATE_OTHER_THREAD");
    const secondBot = f.repository.createBot(), otherRoom = f.repository.createRoom({ memberBotIds: [f.owner.bot.id, secondBot.bot.id] });
    for (const tool of [
      call("transcript.list", other.id), call("transcript.page", { sessionId: other.id }),
      call("runtime.getSessionSnapshot", other.id), call("messages.getStatus", target.clientNonce),
      call("runtime.cancel", target.id), call("roomRuntime.getSnapshot", otherRoom.room.id),
    ]) expect(() => f.service.validate(tool, current.id), tool.action === "execute" ? tool.operation : "operation").toThrowError(expect.objectContaining({ code: "RUNTIME_CONTROL_SCOPE_INVALID" }));
    expect(f.repository.getRuntimeRun(target.id).state).toBe("running");
    expect(f.repository.listToolInvocations(child.session.id)).toEqual([]); expect(f.repository.listPendingApprovalRequests(child.session.id)).toEqual([]);
  });

  it("still reads the current Task history and Runtime snapshot through actual shared handlers", async () => {
    const f = fixture(), child = f.create(), current = f.runtime(child.session.id);
    f.runtime(f.owner.session.id, "PRIVATE_MAIN_HISTORY");
    for (const operation of ["transcript.list", "runtime.getSessionSnapshot"]) {
      const result = await f.execute(call(operation, child.session.id), current);
      expect(result.content).toContain("CURRENT_TASK_ONLY"); expect(result.content).not.toContain("PRIVATE_MAIN_HISTORY");
    }
  });

  it("returns the explicitly selected original memory snapshot instead of the Bot's live memory list", async () => {
    const f = fixture(), original = f.repository.createMemory(f.owner.bot.id, "SELECTED_MEMORY_ORIGINAL"), child = f.create({ memories: [{ id: original.id, version: original.version, digest: original.contentDigest }] });
    f.repository.updateMemory(original.id, original.version, "UNSELECTED_MEMORY_EDIT"); f.repository.createMemory(f.owner.bot.id, "UNSELECTED_MAIN_MEMORY");
    const current = f.runtime(child.session.id), result = await f.execute(call("memories.list", { botId: f.owner.bot.id }), current);
    expect(result.content).toContain("SELECTED_MEMORY_ORIGINAL"); expect(result.content).not.toMatch(/UNSELECTED_MEMORY_EDIT|UNSELECTED_MAIN_MEMORY/);
  });

  it("does not read implicit global user memory even when an ordinary memory operation is approved", async () => {
    const f = fixture(), child = f.create(), current = f.runtime(child.session.id);
    f.repository.createScopedMemory({ scope: "user", scopeKey: "user" }, "PRIVATE_UNSELECTED_GLOBAL_MEMORY");
    try {
      const result = await f.execute(call("memories.list", { scope: "user", scopeKey: "user" }), current);
      expect(result.content).not.toContain("PRIVATE_UNSELECTED_GLOBAL_MEMORY");
      expect(JSON.parse(result.content).result).toEqual([]);
    } catch (error) { expect(error).toMatchObject({ code: "APPROVAL_SCOPE_INVALID" }); }
  });

  it("denies another Bot's memory scope before creating a one-time approval", () => {
    const f = fixture(), child = f.create(), current = f.runtime(child.session.id), other = f.repository.createBot();
    f.repository.createMemory(other.bot.id, "PRIVATE_OTHER_MEMBER_MEMORY");
    expect(() => f.service.validate(call("memories.list", { botId: other.bot.id }), current.id)).toThrowError(expect.objectContaining({ code: "APPROVAL_SCOPE_INVALID" }));
    expect(f.repository.listToolInvocations(child.session.id)).toEqual([]);
  });
});
