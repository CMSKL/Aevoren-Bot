import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRepository } from "./database";
import { RuntimeExecutor } from "./runtime-executor";
import type { ChatMessage, ModelProvider, ModelRunContext } from "./model";

const repositories: AppRepository[] = [];
const executors: RuntimeExecutor[] = [];

const originalRequest = "请你协调两位成员连续完成这个任务：许可证研究员先真实读取当前工作区的 LICENSE.md，将许可证名称和第一段摘要新建为 license-note.md；然后发布编辑真实读取 license-note.md 和 USER_GUIDE.md，将该产品的三个用途整理为 guide-note.md。两人完成后由项目协调员汇总两份真实文件路径与完成情况，不再重复读写。只创建这两个文件，不联网、不发布，不需要我再手工指定成员或补充路径。";
const originalFailedPlan = [
  "已按顺序安排好两位成员的工作，均使用当前工作区现有路径，无需你补充信息。",
  "",
  "**拟派发的任务（按顺序执行）**",
  "",
  "1. **许可证研究员**：真实读取当前工作区的 `LICENSE.md`，把许可证名称和第一段摘要写入新建的 `license-note.md`。",
  "2. **发布编辑**（依赖任务 1 的输出）：真实读取任务 1 产出的 `license-note.md` 以及当前工作区的 `USER_GUIDE.md`，把该产品的三个用途整理写入新建的 `guide-note.md`。",
  "",
  "约束：全程只创建 `license-note.md` 和 `guide-note.md` 这两个文件，不联网、不发布。",
  "",
  "两位成员完成后，我（项目协调员）把两份真实文件的路径与完成情况汇总给你，不重复读写任何文件。以上为拟派发安排，待 Host 校验后才会实际派发成员任务。",
].join("\n");

const observedFailedPlan = [
  "我来说明这次协作的安排。", "", "**执行计划**", "",
  "请**许可证研究员**先真实读取工作区里的 LICENSE.md，把许可证名称和第一段摘要写入新建的 license-note.md；完成后由**发布编辑**读取 license-note.md 与 USER_GUIDE.md，把产品的三个用途整理进新建的 guide-note.md。两人交回真实文件后，我再汇总两份文件的路径与完成情况，不重复读写，全程不联网、不发布。",
  "", "```json",
  JSON.stringify({ assignments: [
    { toAgentId: "2bb9fc25-e8b9-46ea-8f1b-a385d98230a3", task: "真实读取当前工作区的 LICENSE.md，提取许可证名称与第一段摘要，新建并写入 license-note.md（仅此一个文件，不联网、不发布）。完成后回报 license-note.md 的路径与执行结果。", dependsOn: [] },
    { toAgentId: "4d5c78b3-6125-4293-96ef-d594f26bfa95", task: "待上一任务完成后，真实读取 license-note.md 与 USER_GUIDE.md，将产品的三个用途整理并新建写入 guide-note.md（仅此一个文件，不联网、不发布）。完成后回报 guide-note.md 的路径与执行结果。", dependsOn: ["2bb9fc25-e8b9-46ea-8f1b-a385d98230a3"] },
  ], incompleteReason: null }, null, 2),
  "```", "", "两项任务都由成员真实执行，文件路径沿用你已给出的名称，无需你再指定成员或补充资料。",
].join("\n");

const taskReferenceFailedPlan = [
  "**提议的任务顺序（尚未派发，等待 Host 校验后执行）**", "",
  "1. **许可证研究员**：真实读取工作区根目录的 `LICENSE.md`，把许可证名称与第一段摘要写入新建的 `license-note.md`（仅此一个新文件，不联网、不发布）。",
  "2. **发布编辑**（依赖第 1 步产出的 `license-note.md`）：真实读取 `license-note.md` 与 `USER_GUIDE.md`，把该产品的三个用途整理到新建的 `guide-note.md`（不联网、不发布）。",
  "3. 两份文件都完成后，由我在后续回合汇总两份真实文件路径与完成情况，不重复读写。该汇总不是可派发的成员任务，因此不列入清单。", "", "```json",
  JSON.stringify({ assignments: [
    { toAgentId: "f0cadc32-1d87-4cb9-b2d5-111f3db38a1c", name: "许可证研究员", task: "真实读取工作区根目录 LICENSE.md，新建 license-note.md，内容包含该许可证的名称与 LICENSE.md 第一段摘要。仅创建该文件，不联网、不发布、不修改其他文件。完成后回报实际读取路径与已创建文件路径。", dependsOn: null },
    { toAgentId: "5dc21a16-4418-4db7-a8ba-07dd45a3b22c", name: "发布编辑", task: "依赖上一步产出的 license-note.md：真实读取 license-note.md 与工作区根目录 USER_GUIDE.md，新建 guide-note.md，整理该产品的三个用途。仅创建该文件，不联网、不发布、不修改其他文件。完成后回报实际读取路径与已创建文件路径。", dependsOn: "许可证研究员的 license-note.md 产出" },
  ], incompleteReason: null }, null, 2),
  "```", "", "后续汇总回合将由我核对两位成员回报的 `license-note.md` 与 `guide-note.md` 真实路径及完成情况；无需你再指定成员或补充路径。",
].join("\n");

async function runBody(body: string, purpose: "coordinate" | "work" = "coordinate", incompleteReason: string | null = null,
  options: { secondBody?: string; request?: string } = {}) {
  const repository = new AppRepository(":memory:");
  repositories.push(repository);
  const bots = ["项目协调员", "许可证研究员", "发布编辑"].map((name) => {
    const { bot } = repository.createBot();
    return repository.updateBot(bot.id, bot.version, { name });
  });
  const lead = bots[0]!;
  const room = repository.createRoom({ memberBotIds: bots.map((bot) => bot.id), leadBotId: lead.id });
  const clientNonce = randomUUID();
  const batch = repository.createRoomRunWithInitialTurns({
    roomId: room.room.id, sessionId: room.session.id, clientNonce,
    text: options.request ?? (purpose === "coordinate" ? originalRequest : "回应当前问题。"),
    membershipVersion: room.room.membershipVersion, routingMode: "automatic", routingReason: "固定协调者证据回归",
    leadBotId: purpose === "coordinate" ? lead.id : null,
    maxTurns: 4, maxHops: 3, maxTargetsPerTurn: 2, deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    initialTurns: [{ agentId: lead.id, nonce: randomUUID(), turnPurpose: purpose }],
  });
  repository.transitionRoomRun(batch.run.id, "running");
  const turn = repository.transitionRoomTurn(batch.turns[0]!.id, "running", { promptCutoffSeq: 1 });
  const selectLeadPlan = vi.fn(async (_input: unknown) => ({ assignments: [
    { toAgentId: bots[1]!.id, task: "读取 LICENSE.md 并写入 license-note.md。", dependsOnPrevious: false },
    { toAgentId: bots[2]!.id, task: "读取 license-note.md 和 USER_GUIDE.md 并写入 guide-note.md。", dependsOnPrevious: true },
  ], reason: "按顺序安排明确任务。", incompleteReason }));
  const calls: Array<{ messages: ChatMessage[]; context?: ModelRunContext }> = [];
  const provider: ModelProvider = {
    async *run(messages, _signal, context) {
      calls.push({ messages: structuredClone(messages), context: structuredClone(context) });
      yield { type: "started", requestId: "coordinate-evidence-fixture" };
      yield { type: "delta", text: calls.length > 1 ? options.secondBody ?? body : body };
      yield { type: "completed", finishReason: "stop" };
    },
    testConnection: async () => {},
    selectLeadPlan,
  };
  const executor = new RuntimeExecutor(repository, null, { runtime: vi.fn(), transcript: vi.fn() }, false, provider);
  executors.push(executor);
  const started = executor.start({
    clientNonce, executorBotId: lead.id, executionKey: `${batch.run.id}:${turn.logicalTurnId}`,
    inputSeq: 1, promptCutoffSeq: 1,
    attribution: { speakerBotId: lead.id, speakerNameSnapshot: lead.name, sourceTurnId: turn.id },
    room: { id: room.room.id, membershipVersion: room.room.membershipVersion, sourceTurnId: turn.id,
      leadBotId: purpose === "coordinate" ? lead.id : null, turnPurpose: purpose, orchestrationEnabled: true,
      maxAssignments: 2, roster: bots.map(({ id, name, label, description }) => ({ id, name, label, description })) },
    onRunCreated: (run) => { repository.attachRoomTurnRuntime(turn.id, run.id); },
    onLeadPlan: (plan) => { repository.createLeadAssignments(batch.run.id, turn.id, plan.assignments); },
  });
  const result = await started.completion;
  return { repository, room, batch, selectLeadPlan, calls, result };
}

afterEach(async () => {
  for (const executor of executors.splice(0)) await executor.shutdown();
  for (const repository of repositories.splice(0)) repository.close();
});

describe("coordinate-only execution evidence", () => {
  it("accepts the exact real failed plan and original user request without inventing a tool result", async () => {
    const f = await runBody(originalFailedPlan);
    expect(f.result.run.state).toBe("completed");
    expect(f.selectLeadPlan).toHaveBeenCalledTimes(1);
    expect(f.selectLeadPlan.mock.calls[0]![0]).toEqual({ rootRequest: originalRequest, coordinationDraft: originalFailedPlan });
    expect(f.repository.listHandoffs(f.batch.run.id)).toHaveLength(2);
    expect(f.repository.listToolInvocations(f.room.session.id)).toEqual([]);
  });

  it("accepts the observed prerequisite-before-action plan with its fenced task list", async () => {
    const f = await runBody(observedFailedPlan);
    expect(f.result.run.state).toBe("completed");
    expect(f.selectLeadPlan).toHaveBeenCalledTimes(1);
    expect(f.repository.listHandoffs(f.batch.run.id)).toHaveLength(2);
    expect(f.repository.listToolInvocations(f.room.session.id)).toEqual([]);
  });

  it("accepts the exact real task-reference failure without treating instructions as completed actions", async () => {
    const f = await runBody(taskReferenceFailedPlan);
    expect(f.result.run.state).toBe("completed");
    expect(f.calls).toHaveLength(1);
    expect(f.selectLeadPlan).toHaveBeenCalledTimes(1);
    expect(f.repository.listHandoffs(f.batch.run.id)).toHaveLength(2);
    expect(f.repository.listToolInvocations(f.room.session.id)).toEqual([]);
  });

  it("accepts quoted program text but does not exempt a completed claim outside that code", async () => {
    const code = "准备向成员解释这段示例。\n```js\nconsole.log('文件已读取，报告已保存。');\n```";
    const allowed = await runBody(code);
    expect(allowed.result.run.state).toBe("completed");
    expect(allowed.calls).toHaveLength(1);
    const denied = await runBody(`${code}\n我已读取 LICENSE.md。`);
    expect(denied.result.run).toMatchObject({ state: "failed", lastErrorCode: "TOOL_EVIDENCE_REQUIRED" });
    expect(denied.calls).toHaveLength(2);
    expect(denied.selectLeadPlan).not.toHaveBeenCalled();
  });

  it.each([
    `${taskReferenceFailedPlan}\n我已经保存报告。`,
    '```json\n{"assignments":[{"task":"完成后回报已创建文件路径"}],"result":"文件已读取，报告已保存。"}\n```',
    '```json\n{"result":"我已经核验来源。"}\n```',
  ])("keeps prose and non-task JSON assertions checked alongside plan references", async (body) => {
    const f = await runBody(body);
    expect(f.result.run).toMatchObject({ state: "failed", lastErrorCode: "TOOL_EVIDENCE_REQUIRED" });
    expect(f.calls).toHaveLength(2);
    expect(f.selectLeadPlan).not.toHaveBeenCalled();
    expect(f.repository.listHandoffs(f.batch.run.id)).toEqual([]);
    expect(f.repository.listToolInvocations(f.room.session.id)).toEqual([]);
  });

  it("gives a coordinate claim one bounded tool-free correction before dispatching its valid plan", async () => {
    const corrected = "准备请许可证研究员先读取许可证并整理摘要，再请发布编辑读取摘要和使用说明整理用途。成员完成后，我会汇总结果。";
    const f = await runBody("我已经读取 LICENSE.md 并保存报告。", "coordinate", null, { secondBody: corrected });
    expect(f.result.run.state).toBe("completed");
    expect(f.calls).toHaveLength(2);
    const repair = f.calls[1]!.messages.find((message) => message.role === "system" && message.content.includes("COORDINATE_EVIDENCE_REPAIR"));
    expect(repair?.content).toContain("only one or two natural sentences");
    for (const call of f.calls) {
      expect(call.context?.roomTurnPurpose).toBe("coordinate");
      expect(call.context).toMatchObject({ workspaces: [], mcpTools: [], networkTools: false, deviceTools: false,
        textMeasureTools: false, projectTools: false, requireToolCall: false, requiredToolNames: [] });
    }
    expect(f.selectLeadPlan).toHaveBeenCalledTimes(1);
    expect(f.selectLeadPlan.mock.calls[0]![0]).toEqual({ rootRequest: originalRequest, coordinationDraft: corrected });
    expect(f.repository.listTranscript(f.room.session.id).filter((entry) => entry.role === "assistant").map((entry) => entry.body)).toEqual([corrected]);
    expect(f.repository.listToolInvocations(f.room.session.id)).toEqual([]);
    expect(f.repository.listHandoffs(f.batch.run.id)).toHaveLength(2);
  });

  it("stops after the second unsupported coordinate claim without dispatching or resetting its budget", async () => {
    const f = await runBody("我已经读取 LICENSE.md 并保存报告。", "coordinate", null, { secondBody: "报告已经生成。" });
    expect(f.result.run).toMatchObject({ state: "failed", lastErrorCode: "TOOL_EVIDENCE_REQUIRED" });
    expect(f.calls).toHaveLength(2);
    expect(f.selectLeadPlan).not.toHaveBeenCalled();
    expect(f.repository.listRoomTurns(f.batch.run.id)).toHaveLength(1);
    expect(f.repository.listHandoffs(f.batch.run.id)).toEqual([]);
  });

  it.each([
    "你好，请用你配置中的 Bot 名称和负责的领域简短介绍你自己，不介绍其他成员。",
    "你好，项目协调员！",
  ])("does not ask the selector to invent assignments for a direct lead conversation: %s", async (request) => {
    const f = await runBody("我是项目协调员，负责产品协调。许可证研究由许可证研究员负责。", "coordinate", null, { request });
    expect(f.result.run.state).toBe("completed");
    expect(f.calls).toHaveLength(1);
    expect(f.selectLeadPlan).not.toHaveBeenCalled();
    expect(f.repository.listRoomTurns(f.batch.run.id)).toHaveLength(1);
    expect(f.repository.getRoomRun(f.batch.run.id).summaryState).toBe("not-required");
    expect(f.repository.listHandoffs(f.batch.run.id)).toEqual([]);
  });

  it.each([
    "你好，请读取 LICENSE.md 并写入 license-note.md。",
    "你好，请各位成员分别介绍自己。",
    "请先介绍你自己，再与其他成员评审首月预算。",
  ])("does not bypass planning for a greeting mixed with actual work: %s", async (request) => {
    const f = await runBody("我会安排成员依次处理。", "coordinate", null, { request });
    expect(f.result.run.state).toBe("completed");
    expect(f.selectLeadPlan).toHaveBeenCalledTimes(1);
    expect(f.repository.listHandoffs(f.batch.run.id)).toHaveLength(2);
  });

  it("keeps a real incomplete decision blocked and logs only bounded reason metadata", async () => {
    const reason = "PRIVATE_DECISION_TEXT: a third business task cannot fit.";
    const diagnostic = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const f = await runBody(originalFailedPlan, "coordinate", reason);
      expect(f.result.run).toMatchObject({ state: "failed", lastErrorCode: "ROOM_RUN_LIMIT_EXCEEDED" });
      expect(f.repository.listHandoffs(f.batch.run.id)).toEqual([]);
      expect(diagnostic).toHaveBeenCalledWith("[lead-plan-validation] rejected", {
        code: "ROOM_RUN_LIMIT_EXCEEDED", reason: "incomplete-plan", assignmentLimit: 2,
        returnedAssignments: 2, incompleteReasonCharacters: reason.length,
      });
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(reason);
      expect(JSON.stringify(f.result.error)).not.toContain(reason);
    } finally { diagnostic.mockRestore(); }
  });

  it.each([
    "研究员将真实读取 LICENSE.md，再写入新文件。",
    "先读取 LICENSE.md，然后保存 license-note.md。",
    "分工已确定：A 将读取文件，B 将保存报告。",
    "已安排研究员完成文件读取，再由编辑写入新文件。",
    "成员完成读取并保存文件后，我再汇总。",
    "文件读取成功后，再写入报告。",
    "完成后由发布编辑读取 LICENSE.md，再保存报告。",
    "如果文件已读取，则保存报告。",
    "A 尚未读取文件；B 尚未保存报告。",
    "尚未读取 LICENSE.md，也未生成报告。",
    "我已阅读你的要求，准备安排任务。",
    "The researcher will read LICENSE.md and create a file.",
    "Read LICENSE.md, then save license-note.md.",
    "The plan is complete: A will read the file and B will save the report.",
    "After the members have read and saved the files, I will summarize.",
    "Once the file has been read, the editor will save the report.",
    "A has not read the file; B has not saved the report.",
    "I have neither read LICENSE.md nor created the report.",
  ])("allows a plan, condition or scoped noncompletion: %s", async (body) => {
    const f = await runBody(body);
    expect(f.result.run.state).toBe("completed");
    expect(f.selectLeadPlan).toHaveBeenCalledTimes(1);
    expect(f.repository.listToolInvocations(f.room.session.id)).toEqual([]);
  });

  it.each([
    "我已真实读取 LICENSE.md，并写入新文件。",
    "LICENSE.md 读取成功，license-note.md 已保存。",
    "成员已经读取并保存文件，现在我来汇总。",
    "读取和保存均已完成。",
    "我已经核验来源。",
    "A 尚未读取文件；B 已保存报告。",
    "尚未读取 LICENSE.md，但报告已经生成。",
    "接下来将读取文件；报告我已经保存了。",
    "拟派发任务：研究员将读取文件。另，报告已保存。",
    "我已写入文件，但来源核验尚未完成。",
    "计划：我已经完成文件读取。",
    "任务完成后我已经读取文件。",
    "待上一任务完成后，编辑已保存报告。",
    "I have read LICENSE.md and created the file.",
    "LICENSE.md was read successfully; license-note.md has been saved.",
    "Reading the file and saving the report are complete.",
    "I have verified the source.",
    "A has not read the file; B has saved the report.",
    "I have not read LICENSE.md, but the report has been created.",
    "Next I will read the file; I already saved the report.",
    "The researcher loaded the file and the editor saved the report.",
  ])("blocks an unsupported completed-action claim despite nearby plans or failures: %s", async (body) => {
    const f = await runBody(body);
    expect(f.result.run).toMatchObject({ state: "failed", lastErrorCode: "TOOL_EVIDENCE_REQUIRED" });
    expect(f.selectLeadPlan).not.toHaveBeenCalled();
    expect(f.repository.listHandoffs(f.batch.run.id)).toEqual([]);
    expect(f.repository.listToolInvocations(f.room.session.id)).toEqual([]);
  });

  it("keeps the existing work evidence gate unchanged", async () => {
    const f = await runBody("文件已读取，报告已写入。", "work");
    expect(f.result.run).toMatchObject({ state: "failed", lastErrorCode: "TOOL_EVIDENCE_REQUIRED" });
    expect(f.selectLeadPlan).not.toHaveBeenCalled();
  });
});
