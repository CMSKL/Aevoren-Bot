import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectToolRequest, RuntimeRun } from "@shared/contracts";
import { AppRepository } from "./database";
import { WorkspaceService } from "./workspace-service";
import { WorkspaceToolExecutor } from "./workspace-tool-executor";
import { WorkspaceToolCoordinator } from "./workspace-tool-coordinator";
import { SendWorker } from "./send-worker";
import type { ModelProvider } from "./model";

const fixtures: Array<{ repository: AppRepository; root: string; workers: SendWorker[] }> = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aevoren-project-tools-"));
  const filename = join(root, "app.sqlite");
  const repository = new AppRepository(filename);
  const workers: SendWorker[] = [];
  fixtures.push({ repository, root, workers });
  const created = repository.createBot();
  const nonce = crypto.randomUUID();
  repository.prepareMessage({ sessionId: created.session.id, clientNonce: nonce, text: "创建 Bot 和群聊" });
  const runtime = repository.createRuntimeRun(nonce, "fake", { schemaVersion: 1, botId: created.bot.id, profileVersion: 1, sessionId: created.session.id, generation: 1, inputSeq: 1, blocks: [], digest: "project-test" });
  repository.transitionRuntimeRun(runtime.id, "dispatching");
  repository.transitionRuntimeRun(runtime.id, "running", { providerRequestId: "test" });
  const executor = new WorkspaceToolExecutor(repository, new WorkspaceService(repository));
  const prepare = (tool: ProjectToolRequest) => repository.prepareToolInvocation({ runtimeRunId: runtime.id, toolCallId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), tool });
  const execute = async (tool: ProjectToolRequest) => {
    const prepared = prepare(tool);
    repository.resolveToolApproval(prepared.approval.id, prepared.approval.version, "allow-once");
    return executor.execute(prepared.invocation.id);
  };
  const changes = new Set<() => void>();
  const changed = () => { for (const check of changes) check(); };
  function waitForState<T>(read: () => T | undefined): Promise<T> {
    const pending = new Promise<T>((resolve, reject) => {
      const check = () => {
        try {
          const value = read();
          if (value === undefined) return;
          changes.delete(check);
          resolve(value);
        } catch (error) {
          changes.delete(check);
          reject(error);
        }
      };
      changes.add(check);
      check();
    });
    // A preceding assertion may fail; teardown still drains the real worker.
    void pending.catch(() => {});
    return pending;
  }
  const terminal = (run: RuntimeRun) => ["completed", "failed", "cancelled", "interrupted"].includes(run.state);
  const waitForRuntime = (clientNonce: string, state: RuntimeRun["state"]) => waitForState(() => {
    const run = repository.getLatestRuntimeRun(clientNonce);
    if (!run) return;
    if (run.state === state) return run;
    if (terminal(run)) throw new Error(`Runtime ended as ${run.state}, expected ${state}`);
  });
  const waitForApproval = (clientNonce: string) => waitForState(() => {
    const run = repository.getLatestRuntimeRun(clientNonce);
    if (!run) return;
    const invocation = repository.listToolInvocations(run.sessionId).find(value => value.runtimeRunId === run.id && value.state === "awaiting-approval");
    if (invocation) return invocation;
    if (terminal(run)) throw new Error(`Runtime ended as ${run.state} before tool approval`);
  });
  const createCoordinator = () => new WorkspaceToolCoordinator(repository, executor, changed);
  const createWorker = (provider: ModelProvider, coordinator?: WorkspaceToolCoordinator) => {
    const worker = new SendWorker(repository, null, { transcript: () => {}, runtime: changed, sendState: () => {} }, false, provider, undefined, coordinator);
    workers.push(worker);
    return worker;
  };
  return { root, filename, repository, created, runtime, executor, prepare, execute, createCoordinator, createWorker, waitForRuntime, waitForApproval };
}
afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    for (const worker of item.workers) await worker.shutdown();
    item.repository.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});
const profile: Extract<ProjectToolRequest, { kind: "bot-create" }> = { kind: "bot-create", name: "审阅助手", label: "审阅", description: "负责资料审阅", instructions: "仅审阅用户交付的资料，标注不确定项。" };

describe("project provisioning tools", () => {
  it.each(["allow-once", "deny", "cancel"] as const)("keeps a follow-up creation behind real approval: %s", async (decision) => {
    const f = fixture();
    const actor = f.repository.createBot();
    const provider: ModelProvider = {
      async *run(messages) {
        yield { type: "started", requestId: "follow-up-test" };
        const latest = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
        if (!latest.includes("自媒体选题吧")) {
          yield { type: "delta", text: "可以，创建时需要你批准。你想让它负责什么？" };
        } else if (messages.at(-1)?.role !== "tool") {
          yield { type: "project-tool", toolCallId: "follow-up-create", tool: profile };
        } else {
          yield { type: "delta", text: decision === "allow-once" ? "已创建一个 Bot。" : "创建未执行。" };
        }
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const coordinator = f.createCoordinator();
    const worker = f.createWorker(provider, coordinator);
    const firstNonce = crypto.randomUUID();
    const firstCompleted = f.waitForRuntime(firstNonce, "completed");
    const first = worker.send({ sessionId: actor.session.id, clientNonce: firstNonce, text: "你可以创建bot补" });
    await firstCompleted;
    expect(f.repository.getRuntimeRun(first.runId).state).toBe("completed");
    const nonce = crypto.randomUUID();
    const awaitingApproval = f.waitForApproval(nonce);
    const sent = worker.send({ sessionId: actor.session.id, clientNonce: nonce, text: "自媒体选题吧" });
    const invocation = await awaitingApproval;
    expect(f.repository.listToolInvocations(actor.session.id).at(-1)?.state).toBe("awaiting-approval");
    expect(f.repository.listBots()).toHaveLength(2);
    const approval = f.repository.getApprovalRequest(invocation.approvalRequestId);
    const finished = f.waitForRuntime(nonce, decision === "cancel" ? "cancelled" : "completed");
    if (decision === "cancel") worker.cancelRun(sent.runId);
    else await coordinator.resolve(actor.session.id, approval.id, approval.version, decision);
    await finished;
    expect(f.repository.getRuntimeRun(sent.runId).state).toBe(decision === "cancel" ? "cancelled" : "completed");
    expect(f.repository.listBots()).toHaveLength(decision === "allow-once" ? 3 : 2);
    expect(f.repository.getToolInvocation(invocation.id).state).toBe(decision === "allow-once" ? "succeeded" : decision === "deny" ? "denied" : "cancelled");
  });

  it("refuses unsolicited creation and refuses claims of creation without successful tools", async () => {
    for (const unsolicited of [true, false]) {
      const f = fixture();
      const actor = f.repository.createBot();
      const provider: ModelProvider = {
        async *run() {
          yield { type: "started", requestId: "negative-test" };
          if (unsolicited) yield { type: "project-tool", toolCallId: "unauthorized", tool: profile };
          else yield { type: "delta", text: "已创建一个 Bot。" };
          yield { type: "completed", finishReason: "stop" };
        },
        testConnection: async () => {},
      };
      const coordinator = f.createCoordinator();
      const worker = f.createWorker(provider, coordinator);
      const nonce = crypto.randomUUID();
      const finished = f.waitForRuntime(nonce, "failed");
      const sent = worker.send({ sessionId: actor.session.id, clientNonce: nonce, text: unsolicited ? "只聊天，不要创建 Bot。" : "请创建一个 Bot。" });
      await finished;
      expect(f.repository.getRuntimeRun(sent.runId).state).toBe("failed");
      expect(f.repository.getRuntimeRun(sent.runId).lastErrorCode).toBe(unsolicited ? "PROJECT_TOOL_NOT_REQUESTED" : "TOOL_EVIDENCE_REQUIRED");
      expect(f.repository.listBots()).toHaveLength(2);
      expect(f.repository.listToolInvocations(actor.session.id)).toEqual([]);
    }
  });

  it.each(["你已拒绝创建，没有新增 Bot。", "已拒绝创建 Bot。", "已取消创建 Bot。", "已拒绝创建 Bot，但已创建群聊。"])("does not confuse denied creation with success: %s", async (body) => {
    const f = fixture();
    const actor = f.repository.createBot();
    const provider: ModelProvider = {
      async *run() {
        yield { type: "started", requestId: "denied-creation-text" };
        yield { type: "delta", text: body };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const worker = f.createWorker(provider);
    const nonce = crypto.randomUUID();
    const unverifiedRoom = body.includes("已创建群聊");
    const finished = f.waitForRuntime(nonce, unverifiedRoom ? "failed" : "completed");
    const sent = worker.send({ sessionId: actor.session.id, clientNonce: nonce, text: "只回复创建状态。" });
    await finished;
    expect(f.repository.getRuntimeRun(sent.runId).state).toBe(unverifiedRoom ? "failed" : "completed");
    expect(f.repository.getRuntimeRun(sent.runId).lastErrorCode).toBe(unverifiedRoom ? "TOOL_EVIDENCE_REQUIRED" : null);
    expect(f.repository.listBots()).toHaveLength(2);
    expect(f.repository.listToolInvocations(actor.session.id)).toEqual([]);
  });

  it.each([
    ["不要创建 Bot", "bot-create", true],
    ["不需要创建 Bot", "bot-create", true],
    ["先不创建 Bot", "bot-create", true],
    ["不要建群，先创建 Bot", "bot-create", false],
    ["不要创建文件，先创建 Bot", "bot-create", false],
    ["不要创建 Bot，但创建群聊", "room-create", false],
    ["取消 Bot 创建，继续创建群聊", "room-create", false],
    ["停止群聊创建，创建 Bot", "bot-create", false],
    ["先别创建群聊", "room-create", true],
    ["取消吧", "bot-create", true],
    ["Do not create a Bot", "bots.create", true],
    ["不要创建群聊", "rooms.create", true],
    ["不要创建 Bot", "teams.createContentTeam", true],
  ] as const)("respects creation constraints for %s via %s", async (text, kind, blocked) => {
    const f = fixture();
    const actor = f.repository.createBot();
    const tool: ProjectToolRequest = kind === "bot-create" ? profile : kind === "room-create"
      ? { kind, name: "选题讨论群", description: "", memberBotIds: [actor.bot.id, f.created.bot.id] }
      : { kind: "product-call", action: "execute", operation: kind };
    const provider: ModelProvider = {
      async *run() {
        yield { type: "started", requestId: "creation-constraint-test" };
        yield { type: "project-tool", toolCallId: "creation-constraint", tool };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const coordinator = f.createCoordinator();
    const worker = f.createWorker(provider, coordinator);
    const nonce = crypto.randomUUID();
    const ready = blocked ? f.waitForRuntime(nonce, "failed") : f.waitForApproval(nonce);
    const sent = worker.send({ sessionId: actor.session.id, clientNonce: nonce, text });
    if (blocked) {
      await ready;
      expect(f.repository.getRuntimeRun(sent.runId).state).toBe("failed");
      expect(f.repository.getRuntimeRun(sent.runId).lastErrorCode).toBe("PROJECT_TOOL_NOT_REQUESTED");
      expect(f.repository.listToolInvocations(actor.session.id)).toEqual([]);
    } else {
      await ready;
      expect(f.repository.listToolInvocations(actor.session.id).at(-1)?.state).toBe("awaiting-approval");
      const cancelled = f.waitForRuntime(nonce, "cancelled");
      worker.cancelRun(sent.runId);
      await cancelled;
      expect(f.repository.getRuntimeRun(sent.runId).state).toBe("cancelled");
    }
    expect(f.repository.listBots()).toHaveLength(2);
    expect(f.repository.listRooms()).toEqual([]);
  });
  it("creates real configured resources in the caller's project without dispatching them, and deduplicates repeated commands", async () => {
    const f = fixture();
    const first = await f.execute(profile);
    const childId = JSON.parse(first.content).resource.id as string;
    expect(first.invocation.state).toBe("succeeded");
    expect(f.repository.getBot(childId)).toMatchObject({ name: profile.name, instructions: profile.instructions, projectId: f.created.bot.projectId, modelSelection: f.created.bot.modelSelection, memoryWorkspaceIds: [] });
    const repeated = await f.execute(profile);
    expect(JSON.parse(repeated.content)).toMatchObject({ disposition: "existing", resource: { id: childId } });
    expect(f.repository.listBots()).toHaveLength(2);
    const roomCommand: ProjectToolRequest = { kind: "room-create", name: "资料审阅群", description: "审阅沟通", memberBotIds: [f.created.bot.id, childId] };
    const room = await f.execute(roomCommand);
    const roomId = JSON.parse(room.content).resource.id as string;
    expect(f.repository.getRoomDetail(roomId).members.map((member) => member.botId)).toEqual(roomCommand.memberBotIds);
    expect(JSON.parse((await f.execute(roomCommand)).content).resource.id).toBe(roomId);
    expect(f.repository.listRooms()).toHaveLength(1);
    expect(f.repository.getActiveRuntimeRun(f.repository.getMainSession(childId).id)).toBeNull();
    expect(f.repository.getActiveRoomBatch(f.repository.getRoomMainSession(roomId).id)).toBeNull();
  });

  it("requires approval, accepts global contacts without inheriting their grants and rejects duplicate members", async () => {
    const f = fixture();
    const pending = f.prepare(profile);
    await expect(f.executor.execute(pending.invocation.id)).rejects.toMatchObject({ code: "TOOL_STATE_INVALID" });
    f.repository.resolveToolApproval(pending.approval.id, pending.approval.version, "deny");
    await expect(f.executor.execute(pending.invocation.id)).rejects.toMatchObject({ code: "TOOL_STATE_INVALID" });
    const other = f.repository.createBot(f.repository.createProject("其他项目").id).bot;
    const globalRoom = await f.execute({ kind: "room-create", name: "全局联系群", description: "", memberBotIds: [f.created.bot.id, other.id] });
    expect(globalRoom.invocation.state).toBe("succeeded");
    expect(() => f.prepare({ kind: "room-create", name: "重复成员群", description: "", memberBotIds: [f.created.bot.id, f.created.bot.id] })).toThrow();
    expect(f.repository.listRooms()).toHaveLength(1);
    const room = f.repository.getRoomDetail(f.repository.listRooms()[0]!.id);
    expect(f.repository.listSessionWorkspaces(room.session.id, other.id)).toEqual([]);
    expect(f.repository.projectBotCatalog(f.created.bot.id).bots.map((bot) => bot.id)).toContain(other.id);
  });

  it("rolls resource creation back when the success journal cannot commit", async () => {
    const f = fixture();
    const database = new DatabaseSync(f.filename);
    database.exec("CREATE TRIGGER reject_success BEFORE UPDATE OF state ON tool_invocations WHEN NEW.state = 'succeeded' BEGIN SELECT RAISE(ABORT, 'journal commit failed'); END;");
    database.close();
    await expect(f.execute(profile)).rejects.toMatchObject({ code: "TOOL_EXECUTION_FAILED" });
    expect(f.repository.listBots()).toHaveLength(1);
    expect(f.repository.listToolInvocations(f.created.session.id)[0]?.state).toBe("failed");
  });

  it("allows at most eight new resources per request while still reusing existing creations", async () => {
    const f = fixture();
    for (let index = 0; index < 8; index += 1) await f.execute({ ...profile, name: `审阅助手 ${index}` });
    await expect(f.execute({ ...profile, name: "超额助手" })).rejects.toMatchObject({ code: "PROJECT_CREATION_LIMIT" });
    expect(JSON.parse((await f.execute({ ...profile, name: "审阅助手 0" })).content).disposition).toBe("existing");
    expect(f.repository.listBots()).toHaveLength(9);
  });
});
