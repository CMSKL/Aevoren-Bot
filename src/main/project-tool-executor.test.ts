import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectToolRequest } from "@shared/contracts";
import { AppRepository } from "./database";
import { WorkspaceService } from "./workspace-service";
import { WorkspaceToolExecutor } from "./workspace-tool-executor";
import { WorkspaceToolCoordinator } from "./workspace-tool-coordinator";
import { SendWorker } from "./send-worker";
import type { ModelProvider } from "./model";

const fixtures: Array<{ repository: AppRepository; root: string }> = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aevoren-project-tools-"));
  const filename = join(root, "app.sqlite");
  const repository = new AppRepository(filename);
  fixtures.push({ repository, root });
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
  return { root, filename, repository, created, runtime, executor, prepare, execute };
}
afterEach(() => { for (const item of fixtures.splice(0)) { item.repository.close(); rmSync(item.root, { recursive: true, force: true }); } });
const profile: Extract<ProjectToolRequest, { kind: "bot-create" }> = { kind: "bot-create", name: "审阅助手", label: "审阅", description: "负责资料审阅", instructions: "仅审阅用户交付的资料，标注不确定项。" };

describe("project provisioning tools", () => {
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
      const coordinator = new WorkspaceToolCoordinator(f.repository, f.executor, () => {});
      const worker = new SendWorker(f.repository, null, { transcript: () => {}, runtime: () => {}, sendState: () => {} }, false, provider, undefined, coordinator);
      const sent = worker.send({ sessionId: actor.session.id, clientNonce: crypto.randomUUID(), text: unsolicited ? "只聊天，不要创建 Bot。" : "请创建一个 Bot。" });
      await expect.poll(() => f.repository.getRuntimeRun(sent.runId).state).toBe("failed");
      expect(f.repository.getRuntimeRun(sent.runId).lastErrorCode).toBe(unsolicited ? "PROJECT_TOOL_NOT_REQUESTED" : "TOOL_EVIDENCE_REQUIRED");
      expect(f.repository.listBots()).toHaveLength(2);
      expect(f.repository.listToolInvocations(actor.session.id)).toEqual([]);
    }
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

  it("does not create before approval or after denial, rejects cross-project members and duplicate members", async () => {
    const f = fixture();
    const pending = f.prepare(profile);
    await expect(f.executor.execute(pending.invocation.id)).rejects.toMatchObject({ code: "TOOL_STATE_INVALID" });
    f.repository.resolveToolApproval(pending.approval.id, pending.approval.version, "deny");
    await expect(f.executor.execute(pending.invocation.id)).rejects.toMatchObject({ code: "TOOL_STATE_INVALID" });
    const other = f.repository.createBot(f.repository.createProject("其他项目").id).bot;
    await expect(f.execute({ kind: "room-create", name: "越界群", description: "", memberBotIds: [f.created.bot.id, other.id] })).rejects.toMatchObject({ code: "ROOM_PROJECT_MISMATCH" });
    expect(() => f.prepare({ kind: "room-create", name: "重复成员群", description: "", memberBotIds: [f.created.bot.id, f.created.bot.id] })).toThrow();
    expect(f.repository.listRooms()).toEqual([]);
    expect(f.repository.projectBotCatalog(f.created.bot.id).bots.map((bot) => bot.id)).not.toContain(other.id);
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
