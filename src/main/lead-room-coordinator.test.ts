import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoomSendCommand, RoomTurnPurpose } from "@shared/contracts";
import { AppRepository } from "./database";
import { AevorenBotError } from "./errors";
import { RoomCoordinator } from "./room-coordinator";
import { RuntimeExecutor } from "./runtime-executor";
import type { ModelProvider, ModelRunContext, RoomLeadPlan } from "./model";
import type { ProviderResolver } from "./providers/contracts";
import { WorkspaceService } from "./workspace-service";
import { WorkspaceToolExecutor } from "./workspace-tool-executor";
import { WorkspaceToolCoordinator } from "./workspace-tool-coordinator";
import { MemoryCaptureService } from "./memory-capture-service";

const cleanup: Array<{ repository: AppRepository; root: string; coordinator: RoomCoordinator }> = [];

async function fixture(options: { memberCount?: number; files?: boolean; firstFails?: boolean; summaryUsesTool?: boolean; holdWork?: boolean } = {}) {
  const repository = new AppRepository(":memory:");
  const root = mkdtempSync(join(tmpdir(), "aevoren-lead-room-"));
  const service = new WorkspaceService(repository);
  const registered = await service.registerRoot(root);
  repository.updateWorkspacePermissions(registered.workspace.id, registered.workspace.version, { writeEnabled: true, automationEnabled: true });
  const bots = Array.from({ length: options.memberCount ?? 3 }, (_, index) => {
    const created = repository.createBot();
    return repository.updateBot(created.bot.id, created.bot.version, {
      name: index === 0 ? "协调者" : `成员 ${index}`,
      modelSelection: { providerInstanceId: index === 0 ? "openai-compatible.default" : "codex.default", modelId: index === 0 ? "lead" : "worker" },
    });
  });
  const detail = repository.createRoom({ projectId: registered.project.id, memberBotIds: bots.map((bot) => bot.id), leadBotId: bots[0]!.id });
  const calls: Array<{ botId: string; purpose: RoomTurnPurpose; context: ModelRunContext }> = [];
  const summaryInputs: string[] = [];
  const plan = vi.fn(async (): Promise<RoomLeadPlan> => ({
    assignments: bots.slice(1).map((bot, index) => ({
      toAgentId: bot.id,
      task: options.files
        ? index === 0 ? "请用 workspace_write 保存 result.md，正文为 VERIFIED_TEAM_OUTPUT。" : "请用 workspace_read 读取上游 result.md 并报告其内容。"
        : `完成成员 ${index + 1} 的文字分析。`,
      dependsOnPrevious: index > 0,
    })),
    reason: "按顺序完成任务，再汇总实际结果。",
  }));
  const leadProvider: ModelProvider = {
    async *run(messages, _signal, context) {
      calls.push({ botId: context!.executorBotId, purpose: context!.roomTurnPurpose ?? "work", context: context! });
      yield { type: "started", requestId: `lead-${calls.length}` };
      if (context?.roomTurnPurpose === "coordinate") {
        yield { type: "delta", text: "我会安排成员依次处理，最后汇总实际完成情况。" };
      } else if (context?.roomTurnPurpose === "summary") {
        summaryInputs.push(messages.map((message) => message.content).join("\n"));
        if (options.summaryUsesTool) {
          yield { type: "workspace-tool", toolCallId: "forbidden-summary-write", tool: { kind: "workspace-write", workspaceId: registered.workspace.id, path: "summary.md", content: "must never exist" } };
        }
        yield { type: "delta", text: context.roomRunSummary?.coordinationErrorCode === "TASK_REQUIREMENTS_UNMET"
          ? "已有成果保留，原任务仍有未完成项。"
          : options.firstFails ? "第一位成员失败，后续依赖任务未执行。" : options.files ? "成员 1 已写入 result.md，成员 2 已读取该工件。" : "成员任务均有回复，这是本轮结果汇总。" };
      } else yield { type: "delta", text: "独立回复。" };
      yield { type: "completed", finishReason: "stop" };
    },
    selectLeadPlan: plan,
    testConnection: async () => {},
  };
  // The members intentionally have no native handoff or continuation interface.
  const workerProvider: ModelProvider = {
    async *run(messages, signal, context) {
      calls.push({ botId: context!.executorBotId, purpose: context!.roomTurnPurpose ?? "work", context: context! });
      yield { type: "started", requestId: `worker-${calls.length}` };
      if (options.holdWork) {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }
      if (options.firstFails && context?.executorBotId === bots[1]!.id) throw new AevorenBotError("MODEL_TRANSPORT_ERROR");
      if (options.files && !messages.some((message) => message.role === "tool")) {
        yield context?.executorBotId === bots[1]!.id
          ? { type: "workspace-tool", toolCallId: "worker-write", tool: { kind: "workspace-write", workspaceId: registered.workspace.id, path: "result.md", content: "VERIFIED_TEAM_OUTPUT" } }
          : { type: "workspace-tool", toolCallId: "worker-read", tool: { kind: "workspace-read", workspaceId: registered.workspace.id, path: "result.md", maxBytes: 4096 } };
        yield { type: "completed", finishReason: "tool_calls" };
        return;
      }
      yield { type: "delta", text: options.files ? context?.executorBotId === bots[1]!.id ? "文件已写入 result.md。" : "文件已读取，内容为 VERIFIED_TEAM_OUTPUT。" : "这项分析已完成。" };
      yield { type: "completed", finishReason: "stop" };
    },
    testConnection: async () => {},
  };
  const providers: ProviderResolver = {
    getRoute: (selection) => selection.modelId === "lead" ? "openai-compatible" : "codex-cli",
    getCapabilities: (selection) => ({ roomOwnerSelection: selection.modelId === "lead", handoff: selection.modelId === "lead", workspaceTools: true, networkTools: false }),
    createProvider: (selection) => selection.modelId === "lead" ? leadProvider : workerProvider,
  };
  const memoryCapture = new MemoryCaptureService(repository, providers);
  const capture = vi.spyOn(memoryCapture, "enqueue").mockImplementation(() => {});
  const tools = new WorkspaceToolCoordinator(repository, new WorkspaceToolExecutor(repository, service), vi.fn());
  const executor = new RuntimeExecutor(repository, providers, { runtime: vi.fn(), transcript: vi.fn() }, false, undefined, tools, undefined, undefined, undefined, memoryCapture);
  const coordinator = new RoomCoordinator(repository, executor, { roomRuntime: vi.fn(), transcript: vi.fn() });
  cleanup.push({ repository, root, coordinator });
  const command: RoomSendCommand = { roomId: detail.room.id, sessionId: detail.session.id, clientNonce: crypto.randomUUID(), text: options.files ? "请先保存 result.md，再由另一位成员读取核验，最后协调者汇总。" : "请成员依次完成分析并由协调者汇总。", targetBotIds: [], routingMode: "automatic" };
  return { repository, root, bots, detail, calls, summaryInputs, plan, leadProvider, workerProvider, providers, executor, coordinator, capture, command };
}

afterEach(async () => {
  for (const item of cleanup.splice(0)) {
    await item.coordinator.shutdown();
    item.repository.close();
    rmSync(item.root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

async function settled(f: Awaited<ReturnType<typeof fixture>>, batchId: string) {
  await vi.waitFor(() => expect(["completed", "partial", "cancelled", "interrupted"]).toContain(f.repository.getRoomBatch(batchId).state));
  return f.repository.getRoomBatch(batchId);
}

describe("fixed lead coordination", () => {
  it("answers a greeting once when the lead explicitly needs no delegated work", async () => {
    const f = await fixture();
    f.plan.mockResolvedValue({ assignments: [], reason: "直接回复问候，无需成员任务。", incompleteReason: null });
    const run = vi.spyOn(f.leadProvider, "run").mockImplementation(async function* () {
      yield { type: "started", requestId: "greeting" };
      yield { type: "delta", text: "你好，很高兴和你交流。" };
      yield { type: "completed", finishReason: "stop" };
    });
    const sent = await f.coordinator.routeAndSend({ ...f.command, text: "你好" }, { maxTurns: 2, maxHops: 0 });
    expect(await settled(f, sent.batchId)).toMatchObject({ state: "completed", summaryState: "not-required" });
    expect(f.repository.listRoomTurns(sent.batchId)).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(f.capture).not.toHaveBeenCalled();
  });

  it("plans two CLI members, reads and writes real files in order, then runs one tool-free summary", async () => {
    const f = await fixture({ files: true });
    const sent = await f.coordinator.routeAndSend(f.command);
    expect(await settled(f, sent.batchId)).toMatchObject({ state: "completed", summaryState: "completed", leadBotId: f.bots[0]!.id });
    expect(f.repository.listRoomTurns(sent.batchId).map((turn) => turn.turnPurpose)).toEqual(["coordinate", "work", "work", "summary"]);
    expect(readFileSync(join(f.root, "result.md"), "utf8")).toBe("VERIFIED_TEAM_OUTPUT");
    const invocations = f.repository.listToolInvocations(f.detail.session.id);
    expect(invocations.map((tool) => [tool.toolKind, tool.state])).toEqual([["workspace-write", "succeeded"], ["workspace-read", "succeeded"]]);
    const summary = f.calls.find((call) => call.purpose === "summary")!;
    expect(summary.context).toMatchObject({ workspaces: [], mcpTools: [], networkTools: false, deviceTools: false, projectTools: false, textMeasureTools: false, requireToolCall: false });
    expect(summary.context.executionReceipt).toBeUndefined();
    expect(summary.context.roomRunSummary?.results.filter((result) => result.turnPurpose === "work").map((result) => result.state)).toEqual(["completed", "completed"]);
    expect(summary.context.roomRunSummary?.results.flatMap((result) => result.artifacts)).toMatchObject([{ path: "result.md", sourceRuntimeRunId: invocations[0]!.runtimeRunId }]);
    expect(f.plan).toHaveBeenCalledTimes(1);
    expect(f.capture).toHaveBeenCalledTimes(2);
    expect((await f.coordinator.routeAndSend(f.command)).disposition).toBe("duplicate");
    expect(f.calls.filter((call) => call.purpose === "summary")).toHaveLength(1);
  });

  it("executes all five members within the original eight-turn and per-source budgets", async () => {
    const f = await fixture({ memberCount: 6 });
    const sent = await f.coordinator.routeAndSend(f.command);
    expect(await settled(f, sent.batchId)).toMatchObject({ state: "completed", usedTurns: 7, maxTurns: 8, maxTargetsPerTurn: 2 });
    expect(f.calls.filter((call) => call.purpose === "work").map((call) => call.botId)).toEqual(f.bots.slice(1).map((bot) => bot.id));
    const sources = f.repository.listHandoffs(sent.batchId).map((handoff) => handoff.fromTurnId);
    expect(new Set(sources).size).toBe(5);
    expect(f.calls.filter((call) => call.purpose === "summary")).toHaveLength(1);
  });

  it.each(["handoff", "tool-rejection"] as const)("corrects an extra %s after real work without erasing results or dispatching twice", async (type) => {
    const f = await fixture({ files: true });
    const original = f.workerProvider.run.bind(f.workerProvider);
    let rejected = false;
    f.workerProvider.run = async function* (messages, signal, context) {
      const hasWriteResult = messages.some((message) => message.role === "tool");
      if (context!.executorBotId === f.bots[1]!.id && hasWriteResult && !rejected) {
        rejected = true;
        yield { type: "started", requestId: "extra-retired-transfer" };
        yield { type: "delta", text: "文件已写入 result.md。" };
        yield type === "handoff"
          ? { type: "handoff", toolCallId: "extra-transfer", toAgentId: f.bots[2]!.id, task: "再次交给下游。", contextRefs: [], visibility: "room" }
          : { type: "tool-rejection", toolCallId: "extra-transfer", providerToolName: "handoff_to_agent", arguments: "{}", code: "ROOM_HANDOFF_DISABLED", safeMessage: "后续已按计划安排，请完成自己的回复。" };
        yield { type: "completed", finishReason: "tool_calls" };
        return;
      }
      if (context!.executorBotId === f.bots[1]!.id && rejected) {
        expect(messages.some((message) => message.role === "tool" && message.content.includes("ROOM_HANDOFF_DISABLED"))).toBe(true);
      }
      yield* original(messages, signal, context);
    };
    const sent = await f.coordinator.routeAndSend(f.command);
    expect(await settled(f, sent.batchId)).toMatchObject({ state: "completed", summaryState: "completed" });
    expect(f.repository.listRoomTurns(sent.batchId)).toHaveLength(4);
    expect(f.repository.listHandoffs(sent.batchId)).toHaveLength(2);
    expect(f.repository.listToolInvocations(f.detail.session.id).map((tool) => tool.toolKind)).toEqual(["workspace-write", "workspace-read"]);
    const writer = f.repository.listRoomTurns(sent.batchId).find((turn) => turn.agentId === f.bots[1]!.id)!;
    expect(f.repository.getRuntimeRun(writer.runtimeRunId!).state).toBe("completed");
    expect(f.repository.listTranscript(f.detail.session.id).find((entry) => entry.sourceTurnId === writer.id)?.body).toContain("文件已写入 result.md");
    expect(readFileSync(join(f.root, "result.md"), "utf8")).toBe("VERIFIED_TEAM_OUTPUT");
  });

  it("reports an over-budget plan as partial without silently executing a truncated plan", async () => {
    const f = await fixture({ memberCount: 6 });
    const sent = await f.coordinator.routeAndSend(f.command, { maxTurns: 4 });
    expect(await settled(f, sent.batchId)).toMatchObject({ state: "partial", coordinationErrorCode: "ROOM_RUN_LIMIT_EXCEEDED", summaryState: "skipped" });
    expect(f.calls.map((call) => call.purpose)).toEqual(["coordinate"]);
    expect(f.repository.listHandoffs(sent.batchId)).toEqual([]);
  });

  it("cannot wash an explicitly incomplete or empty file plan into success", async () => {
    for (const incompleteReason of [null, "还有三名成员的工作无法放入本轮预算。"] as const) {
      const f = await fixture({ files: true });
      f.plan.mockResolvedValue({ assignments: [], reason: "没有可执行的完整计划。", incompleteReason });
      const sent = await f.coordinator.routeAndSend(f.command);
      expect(await settled(f, sent.batchId)).toMatchObject({ state: "partial", coordinationErrorCode: incompleteReason ? "ROOM_RUN_LIMIT_EXCEEDED" : "ROOM_LEAD_PLAN_INVALID" });
      expect(f.repository.listHandoffs(sent.batchId)).toEqual([]);
      expect(existsSync(join(f.root, "result.md"))).toBe(false);
    }
  });

  it("checks the original tool and output requirements across member results before accepting summary", async () => {
    const f = await fixture();
    const sent = await f.coordinator.routeAndSend({ ...f.command, text: "请使用 workspace_write 保存 required.md。" });
    expect(await settled(f, sent.batchId)).toMatchObject({ state: "partial", summaryState: "completed", coordinationErrorCode: "TASK_REQUIREMENTS_UNMET" });
    expect(f.repository.listToolInvocations(f.detail.session.id)).toEqual([]);
    expect(f.repository.listRoomTurns(sent.batchId).at(-1)).toMatchObject({ state: "completed", lastErrorCode: null });
    expect(f.calls.find((call) => call.purpose === "summary")?.context.roomRunSummary?.coordinationErrorCode).toBe("TASK_REQUIREMENTS_UNMET");
    expect(f.summaryInputs[0]).toContain("尚未生成要求的成果文件 required.md");

    const files = await fixture({ files: true });
    const partial = await files.coordinator.routeAndSend({ ...files.command, text: "请使用 workspace_write 新建为 result.md，并整理为 missing.md。" });
    expect(await settled(files, partial.batchId)).toMatchObject({ state: "partial", summaryState: "completed", coordinationErrorCode: "TASK_REQUIREMENTS_UNMET" });
    expect(existsSync(join(files.root, "result.md"))).toBe(true);
    expect(existsSync(join(files.root, "missing.md"))).toBe(false);
  });

  it("still fails a summary that falsely calls an incomplete root task fully complete", async () => {
    const f = await fixture();
    const original = f.leadProvider.run.bind(f.leadProvider);
    f.leadProvider.run = async function* (messages, signal, context) {
      if (context?.roomTurnPurpose === "summary") {
        yield { type: "started", requestId: "false-final-success" };
        yield { type: "delta", text: "全部任务已完成。" };
        yield { type: "completed", finishReason: "stop" };
        return;
      }
      yield* original(messages, signal, context);
    };
    const sent = await f.coordinator.routeAndSend({ ...f.command, text: "请新建文件 missing.md。" });
    expect(await settled(f, sent.batchId)).toMatchObject({ state: "partial", summaryState: "failed", coordinationErrorCode: "TASK_REQUIREMENTS_UNMET" });
    expect(f.repository.listRoomTurns(sent.batchId).at(-1)?.lastErrorCode).toBe("TOOL_EVIDENCE_REQUIRED");
  });

  it("requires root source coverage even if a nonempty plan omitted that source", async () => {
    const f = await fixture({ files: true });
    const sent = await f.coordinator.routeAndSend({ ...f.command, text: "请保存 result.md，然后真实读取 missing-source.md 并汇总。" });
    expect(await settled(f, sent.batchId)).toMatchObject({ state: "partial", summaryState: "completed", coordinationErrorCode: "TASK_REQUIREMENTS_UNMET" });
    expect(f.repository.listRoomTurns(sent.batchId).at(-1)).toMatchObject({ state: "completed", lastErrorCode: null });
    expect(readFileSync(join(f.root, "result.md"), "utf8")).toBe("VERIFIED_TEAM_OUTPUT");
  });

  it("blocks a downstream write when a real source read does not match the inherited artifact hash", async () => {
    const f = await fixture({ files: true });
    f.plan.mockResolvedValue({ reason: "写入后由下游读取并审阅。", assignments: [
      { toAgentId: f.bots[1]!.id, task: "请用 workspace_write 保存 result.md。", dependsOnPrevious: false },
      { toAgentId: f.bots[2]!.id, task: "请读取 result.md，再写入 review.md。", dependsOnPrevious: true },
    ] });
    let rejectedHash: string | undefined;
    f.workerProvider.run = async function* (messages, _signal, context) {
      yield { type: "started", requestId: `hash-${messages.length}` };
      const results = messages.filter((message) => message.role === "tool");
      const workspaceId = context!.workspaces![0]!.id;
      if (context!.executorBotId === f.bots[1]!.id && results.length === 0) {
        yield { type: "workspace-tool", toolCallId: "upstream-file", tool: { kind: "workspace-write", workspaceId, path: "result.md", content: "VERIFIED_TEAM_OUTPUT" } };
      } else if (context!.executorBotId === f.bots[2]!.id && results.length === 0) {
        writeFileSync(join(f.root, "result.md"), "MODIFIED_SOURCE");
        yield { type: "workspace-tool", toolCallId: "changed-source", tool: { kind: "workspace-read", workspaceId, path: "result.md", maxBytes: 4096 } };
      } else if (context!.executorBotId === f.bots[2]!.id && results.length === 1) {
        yield { type: "workspace-tool", toolCallId: "unverified-review", tool: { kind: "workspace-write", workspaceId, path: "review.md", content: "Unverified review." } };
      } else {
        if (context!.executorBotId === f.bots[2]!.id) {
          const rejected = JSON.parse(results.at(-1)!.content) as { code: string; missingSources: Array<{ sha256: string }> };
          expect(rejected.code).toBe("WORKSPACE_SOURCE_READ_REQUIRED");
          rejectedHash = rejected.missingSources[0]!.sha256;
        }
        yield { type: "delta", text: context!.executorBotId === f.bots[1]!.id ? "文件已写入 result.md。" : "来源内容已变化，尚未写入审阅结果。" };
        yield { type: "completed", finishReason: "stop" };
        return;
      }
      yield { type: "completed", finishReason: "tool_calls" };
    };
    const sent = await f.coordinator.routeAndSend(f.command);
    expect((await settled(f, sent.batchId)).state).toBe("partial");
    const writes = f.repository.listToolInvocations(f.detail.session.id).filter((tool) => tool.toolKind === "workspace-write");
    expect(writes).toHaveLength(1);
    expect(rejectedHash).toBe(writes[0]!.resultMetadata!.sha256);
    expect(existsSync(join(f.root, "review.md"))).toBe(false);
  });

  it("retries an interrupted coordinator without losing its persisted unstarted plan or duplicating files", async () => {
    const f = await fixture({ files: true });
    const createPlan = f.repository.createLeadAssignments.bind(f.repository);
    let failAfterPlan = true;
    vi.spyOn(f.repository, "createLeadAssignments").mockImplementation((...args) => {
      const result = createPlan(...args);
      if (failAfterPlan) { failAfterPlan = false; throw new AevorenBotError("INTERNAL_ERROR"); }
      return result;
    });
    const sent = await f.coordinator.routeAndSend(f.command);
    expect(await settled(f, sent.batchId)).toMatchObject({ state: "partial", summaryState: "skipped", windingDown: false });
    expect(f.calls.some((call) => call.purpose === "work")).toBe(false);
    const coordinate = f.repository.listRoomTurns(sent.batchId).find((turn) => turn.turnPurpose === "coordinate")!;
    f.coordinator.retryTurn(coordinate.id);
    expect(await settled(f, sent.batchId)).toMatchObject({ state: "completed", summaryState: "completed", coordinationErrorCode: null, usedTurns: 4 });
    expect(f.repository.listToolInvocations(f.detail.session.id).map((tool) => tool.toolKind)).toEqual(["workspace-write", "workspace-read"]);
    expect(readFileSync(join(f.root, "result.md"), "utf8")).toBe("VERIFIED_TEAM_OUTPUT");
    expect(f.calls.filter((call) => call.purpose === "summary")).toHaveLength(1);
  });

  it("keeps a failed member and skipped dependency visible even when summary completes", async () => {
    const f = await fixture({ firstFails: true });
    const sent = await f.coordinator.routeAndSend(f.command);
    expect(await settled(f, sent.batchId)).toMatchObject({ state: "partial", summaryState: "completed" });
    const summary = f.calls.find((call) => call.purpose === "summary")!.context.roomRunSummary!;
    expect(summary.results.filter((result) => result.turnPurpose === "work")).toMatchObject([
      { state: "failed", errorCode: "MODEL_TRANSPORT_ERROR", body: "" },
      { state: "cancelled", errorCode: "ROOM_DEPENDENCY_FAILED", outcome: { kind: "skipped" } },
    ]);
    expect(f.calls.some((call) => call.botId === f.bots[2]!.id)).toBe(false);
  });

  it.each([3, 4])("resumes all unstarted dependencies after worker retry with %s members without repeating completed work", async (memberCount) => {
    const options = { files: true, firstFails: true, memberCount };
    const f = await fixture(options);
    const sent = await f.coordinator.routeAndSend(f.command);
    expect(await settled(f, sent.batchId)).toMatchObject({ state: "partial", summaryState: "completed" });
    const original = f.repository.listRoomTurns(sent.batchId);
    const worker = original.find((turn) => turn.memberBotId === f.bots[1]!.id)!;
    const oldSummary = original.find((turn) => turn.turnPurpose === "summary")!;
    expect(original.filter((turn) => turn.lastErrorCode === "ROOM_DEPENDENCY_FAILED")).toHaveLength(memberCount - 2);
    expect(f.repository.listToolInvocations(f.detail.session.id)).toEqual([]);

    options.firstFails = false;
    f.coordinator.retryTurn(worker.id);
    expect(await settled(f, sent.batchId)).toMatchObject({ state: "completed", summaryState: "completed", usedTurns: memberCount + 1 });
    const turns = f.repository.listRoomTurns(sent.batchId);
    expect(turns.filter((turn) => turn.turnPurpose === "coordinate")).toHaveLength(1);
    expect(turns.filter((turn) => turn.turnPurpose === "work" && turn.attemptNo === 2))
      .toHaveLength(memberCount - 1);
    expect(turns.filter((turn) => turn.turnPurpose === "work" && turn.attemptNo === 2)
      .every((turn) => turn.state === "completed")).toBe(true);
    for (const prior of original) expect(f.repository.getRoomTurn(prior.id)).toEqual(prior);
    const finalSummary = f.repository.getRoomTurn(f.repository.getRoomRun(sent.batchId).summaryTurnId!);
    expect(finalSummary).toMatchObject({ logicalTurnId: oldSummary.logicalTurnId, attemptNo: 2, state: "completed" });
    expect(turns.filter((turn) => turn.turnPurpose === "summary")).toHaveLength(2);
    expect(f.calls.filter((call) => call.purpose === "summary")).toHaveLength(2);
    const tools = f.repository.listToolInvocations(f.detail.session.id);
    expect(tools.filter((tool) => tool.toolKind === "workspace-write")).toHaveLength(1);
    expect(tools.filter((tool) => tool.toolKind === "workspace-read")).toHaveLength(memberCount - 2);
    expect(tools.every((tool) => tool.state === "succeeded")).toBe(true);
    expect(readFileSync(join(f.root, "result.md"), "utf8")).toBe("VERIFIED_TEAM_OUTPUT");
    const snapshot = f.coordinator.getSnapshot(f.detail.room.id);
    const recoveredDelivery = snapshot.handoffs.find((handoff) => handoff.toAgentId === f.bots[2]!.id)!;
    const recoveredTurn = turns.find((turn) => turn.memberBotId === f.bots[2]!.id && turn.attemptNo === 2)!;
    expect(recoveredDelivery).toMatchObject({ state: "cancelled", targetTurnId: original.find((turn) => turn.memberBotId === f.bots[2]!.id)!.id,
      deliveryAttempt: { turnId: recoveredTurn.id, attemptNo: 2, state: "accepted",
        acceptedAt: f.repository.getRuntimeRun(recoveredTurn.runtimeRunId!).acceptedAt } });
    expect(recoveredDelivery.deliveryAttempt!.acceptedAt).not.toBeNull();
  });

  it("replaces a failed summary with one final effective summary after the worker and its dependency recover", async () => {
    const options = { firstFails: true, summaryUsesTool: true };
    const f = await fixture(options);
    const sent = await f.coordinator.routeAndSend(f.command);
    expect(await settled(f, sent.batchId)).toMatchObject({ state: "partial", summaryState: "failed" });
    const previous = f.repository.listRoomTurns(sent.batchId);
    const failedSummary = previous.find((turn) => turn.turnPurpose === "summary")!;
    options.firstFails = false;
    options.summaryUsesTool = false;
    f.coordinator.retryTurn(previous.find((turn) => turn.memberBotId === f.bots[1]!.id)!.id);
    expect(await settled(f, sent.batchId)).toMatchObject({ state: "completed", summaryState: "completed" });
    const summaries = f.repository.listRoomTurns(sent.batchId).filter((turn) => turn.turnPurpose === "summary");
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toEqual(failedSummary);
    expect(summaries[1]).toMatchObject({ logicalTurnId: failedSummary.logicalTurnId, attemptNo: 2, state: "completed" });
    expect(f.repository.getRoomRun(sent.batchId).summaryTurnId).toBe(summaries[1]!.id);
    expect(f.calls.filter((call) => call.purpose === "summary")).toHaveLength(2);
  });

  it("rejects summary tool events before filesystem execution and preserves completed artifacts", async () => {
    const f = await fixture({ files: true, summaryUsesTool: true });
    const sent = await f.coordinator.routeAndSend(f.command);
    expect(await settled(f, sent.batchId)).toMatchObject({ state: "partial", summaryState: "failed" });
    expect(existsSync(join(f.root, "summary.md"))).toBe(false);
    expect(readFileSync(join(f.root, "result.md"), "utf8")).toBe("VERIFIED_TEAM_OUTPUT");
    expect(f.repository.listToolInvocations(f.detail.session.id)).toHaveLength(2);
    expect(f.repository.listRoomTurns(sent.batchId).at(-1)).toMatchObject({ turnPurpose: "summary", lastErrorCode: "ROOM_SUMMARY_TOOLS_DISABLED" });
  });

  it("does not let a preplanned successor bypass the content planner's human approval gate", async () => {
    const f = await fixture({ files: true });
    f.repository.updateBot(f.bots[1]!.id, f.bots[1]!.version, { name: "选题策划师" });
    const sent = await f.coordinator.routeAndSend(f.command);
    expect(await settled(f, sent.batchId)).toMatchObject({ state: "partial", summaryState: "skipped" });
    expect(readFileSync(join(f.root, "result.md"), "utf8")).toBe("VERIFIED_TEAM_OUTPUT");
    expect(f.calls.some((call) => call.botId === f.bots[2]!.id)).toBe(false);
    expect(f.repository.listRoomTurns(sent.batchId).at(-1)).toMatchObject({ state: "cancelled", lastErrorCode: "HUMAN_APPROVAL_REQUIRED" });
  });

  it.each(["explicit", "everyone"] as const)("keeps %s fanout independent even when a lead is configured", async (routingMode) => {
    const f = await fixture();
    const targetBotIds = routingMode === "everyone" ? f.bots.map((bot) => bot.id) : [f.bots[1]!.id];
    const sent = await f.coordinator.routeAndSend({ ...f.command, routingMode, targetBotIds });
    expect(await settled(f, sent.batchId)).toMatchObject({ state: "completed", leadBotId: null, summaryState: "not-required", orchestrationEnabled: false });
    expect(f.plan).not.toHaveBeenCalled();
    expect(f.calls.map((call) => call.botId)).toEqual(targetBotIds);
    expect(f.repository.listHandoffs(sent.batchId)).toEqual([]);
  });

  it("does not silently replace a lead whose selected provider lost coordination support", async () => {
    const f = await fixture();
    vi.spyOn(f.providers, "getCapabilities").mockReturnValue({ roomOwnerSelection: false, handoff: false, workspaceTools: true });
    await expect(f.coordinator.routeAndSend(f.command)).rejects.toMatchObject({ code: "ROOM_LEAD_UNAVAILABLE" });
    expect(f.repository.listRoomBatches(f.detail.room.id)).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it("does not start a summary after cancellation or a hard deadline", async () => {
    for (const deadline of [false, true]) {
      const f = await fixture({ holdWork: true });
      const sent = await f.coordinator.routeAndSend(f.command, deadline ? { deadlineMs: 100 } : {});
      await vi.waitFor(() => expect(f.calls.some((call) => call.purpose === "work")).toBe(true));
      if (!deadline) f.coordinator.cancel(sent.batchId);
      const batch = await settled(f, sent.batchId);
      expect(batch.state).toBe(deadline ? "partial" : "cancelled");
      expect(batch.summaryState).toBe("skipped");
      expect(f.calls.some((call) => call.purpose === "summary")).toBe(false);
    }
  });
});
