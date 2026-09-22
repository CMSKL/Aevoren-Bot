import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ModelEvent, ModelProvider, ModelRunContext, RoomOwnerSelection } from "./model";
import { AppRepository } from "./database";
import { RoomCoordinator } from "./room-coordinator";
import { RuntimeExecutor } from "./runtime-executor";
import { WorkspaceService } from "./workspace-service";
import { WorkspaceToolCoordinator } from "./workspace-tool-coordinator";
import { WorkspaceToolExecutor } from "./workspace-tool-executor";

const repositories: AppRepository[] = [];
const directories: string[] = [];

afterEach(() => {
  while (repositories.length > 0) repositories.pop()?.close();
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function toolResults(messages: ChatMessage[]): number {
  return messages.filter((message) => message.role === "tool").length;
}

function receiptArtifact(messages: ChatMessage[]): { workspaceId: string; path: string } {
  const message = messages.find((candidate) => candidate.role === "system" && candidate.content.includes("AUTHORITATIVE_EXECUTION_HANDOFF_RECEIPT"));
  if (!message) throw new Error("missing execution receipt");
  const parsed = JSON.parse(message.content) as { receipt: { artifacts: Array<{ workspaceId: string; path: string }> } };
  const artifact = parsed.receipt.artifacts.at(-1);
  if (!artifact) throw new Error("missing receipt artifact");
  return artifact;
}

function eventsFor(
  name: string,
  messages: ChatMessage[],
  context: ModelRunContext,
): ModelEvent[] {
  const count = toolResults(messages);
  const workspaceId = context.workspaces![0]!.id;
  const started: ModelEvent = { type: "started", requestId: `${name}:${count}` };
  const completed: ModelEvent = { type: "completed", finishReason: "tool_calls" };
  if (name === "情报侦察员") {
    if (count === 0) return [started, {
      type: "workspace-tool",
      toolCallId: "research-write",
      providerToolName: "workspace_write",
      tool: { kind: "workspace-write", workspaceId, path: "01-inbox/research.md", content: "# 已核验线索\n来源：https://example.com/source\n" },
    }, completed];
    return [started, { type: "delta", text: "研究工件已由真实工具写入。" }, { type: "completed", finishReason: "stop" }];
  }
  if (name === "选题策划师") {
    const artifact = receiptArtifact(messages);
    if (count === 0) return [started, {
      type: "workspace-tool",
      toolCallId: "brief-read-research",
      providerToolName: "workspace_read",
      tool: { kind: "workspace-read", workspaceId: artifact.workspaceId, path: artifact.path, maxBytes: 65_536 },
    }, completed];
    return [started, {
      type: "workspace-tool",
      toolCallId: "brief-write",
      providerToolName: "workspace_write",
      tool: {
        kind: "workspace-write",
        workspaceId,
        path: "02-briefs/options.md",
        content: "## 候选 A\n标题：证据链\n核心角度：真实执行\n证据来源：research.md\n风险：范围有限\n推荐理由：链路最完整\n\n## 候选 B\n标题：自动接力\n\n## 候选 C\n标题：人工门禁\n",
      },
    }, completed];
  }
  if (name === "内容主笔") {
    const artifact = receiptArtifact(messages);
    if (count === 0) return [started, {
      type: "workspace-tool",
      toolCallId: "draft-read-brief",
      providerToolName: "workspace_read",
      tool: { kind: "workspace-read", workspaceId: artifact.workspaceId, path: artifact.path, maxBytes: 65_536 },
    }, completed];
    if (count === 1) return [started, {
      type: "computation-tool",
      toolCallId: "draft-measure",
      providerToolName: "text_measure",
      tool: { kind: "text-measure", text: "这是基于已批准 Brief 的真实草稿。" },
    }, completed];
    if (count === 2) return [started, {
      type: "workspace-tool",
      toolCallId: "draft-write",
      providerToolName: "workspace_write",
      tool: { kind: "workspace-write", workspaceId, path: "03-drafts/draft.md", content: "# 草稿\n这是基于已批准 Brief 的真实草稿。\n" },
    }, completed];
    return [started, { type: "delta", text: "草稿已生成并由真实工具写入。" }, { type: "completed", finishReason: "stop" }];
  }
  if (name === "事实编辑") {
    const artifact = receiptArtifact(messages);
    if (count === 0) return [started, {
      type: "workspace-tool",
      toolCallId: "review-read-draft",
      providerToolName: "workspace_read",
      tool: { kind: "workspace-read", workspaceId: artifact.workspaceId, path: artifact.path, maxBytes: 65_536 },
    }, completed];
    if (count === 1) return [started, {
      type: "computation-tool",
      toolCallId: "review-measure",
      providerToolName: "text_measure",
      tool: { kind: "text-measure", text: "这是完成事实核验后的正式审校稿。" },
    }, completed];
    if (count === 2) return [started, {
      type: "workspace-tool",
      toolCallId: "review-write",
      providerToolName: "workspace_write",
      tool: { kind: "workspace-write", workspaceId, path: "04-review/review.md", content: "# 审校稿\n这是完成事实核验后的正式审校稿。\n" },
    }, completed];
    return [started, { type: "delta", text: "审校稿已由真实工具写入。" }, { type: "completed", finishReason: "stop" }];
  }
  if (name === "数据复盘师") {
    const artifact = receiptArtifact(messages);
    if (count === 0) return [started, {
      type: "workspace-tool",
      toolCallId: "report-read-review",
      providerToolName: "workspace_read",
      tool: { kind: "workspace-read", workspaceId: artifact.workspaceId, path: artifact.path, maxBytes: 65_536 },
    }, completed];
    if (count === 1) return [started, {
      type: "workspace-tool",
      toolCallId: "report-read-csv",
      providerToolName: "workspace_read",
      tool: { kind: "workspace-read", workspaceId, path: "05-data/analytics.csv", maxBytes: 65_536 },
    }, completed];
    if (count === 2) return [started, {
      type: "workspace-tool",
      toolCallId: "report-write-wrong-sum",
      providerToolName: "workspace_write",
      tool: { kind: "workspace-write", workspaceId, path: "06-reports/report.md", content: "```json\n{\"asset_count\":2,\"total_views\":999,\"total_engagement\":13}\n```\n" },
    }, completed];
    if (count === 3) return [started, {
      type: "workspace-tool",
      toolCallId: "report-write-unrequested-derived",
      providerToolName: "workspace_write",
      tool: { kind: "workspace-write", workspaceId, path: "06-reports/report.md", content: "约 4 小时；```json\n{\"asset_count\":2,\"total_views\":300,\"total_engagement\":13}\n```\n" },
    }, completed];
    if (count === 4) return [started, {
      type: "workspace-tool",
      toolCallId: "report-write",
      providerToolName: "workspace_write",
      tool: { kind: "workspace-write", workspaceId, path: "06-reports/report.md", content: "# 复盘\n```json\n{\"asset_count\":2,\"total_views\":300,\"total_engagement\":13}\n```\n" },
    }, completed];
    return [started, { type: "delta", text: "复盘只基于已读取的真实 CSV，并已写入报告。" }, { type: "completed", finishReason: "stop" }];
  }
  throw new Error(`unexpected bot ${name}`);
}

describe("content-team Host orchestration", () => {
  it("carries verified artifacts across Runtimes and completes the full chain with only the Brief approval gate", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const root = mkdtempSync(join(tmpdir(), "aevoren-content-team-chain-"));
    directories.push(root);
    for (const folder of ["01-inbox", "02-briefs", "03-drafts", "04-review", "05-data", "06-reports"]) mkdirSync(join(root, folder));
    writeFileSync(join(root, "05-data", "analytics.csv"), "id,views,engagement\nA,100,5\nB,200,8\n", "utf8");
    const workspaceService = new WorkspaceService(repository);
    const registered = await workspaceService.registerRoot(root);
    repository.updateWorkspacePermissions(registered.workspace.id, registered.workspace.version, { writeEnabled: true, automationEnabled: true });
    const team = repository.createContentTeamTemplate();
    const names = new Map(team.bots.map((bot) => [bot.id, bot.name]));
    const contexts: ModelRunContext[] = [];
    const provider: ModelProvider = {
      async *run(messages, _signal, context) {
        contexts.push(context!);
        for (const event of eventsFor(names.get(context!.executorBotId)!, messages, context!)) yield event;
      },
      testConnection: async () => {},
      async selectRoomOwner(): Promise<RoomOwnerSelection> {
        const investigator = team.bots.find((bot) => bot.name === "情报侦察员")!;
        return { ownerAgentId: investigator.id, reason: "从研究阶段开始。" };
      },
    };
    const toolCoordinator = new WorkspaceToolCoordinator(
      repository,
      new WorkspaceToolExecutor(repository, workspaceService),
      () => undefined,
    );
    const executor = new RuntimeExecutor(repository, null, { transcript: vi.fn(), runtime: vi.fn() }, false, provider, toolCoordinator);
    const coordinator = new RoomCoordinator(repository, executor, { roomRuntime: vi.fn(), transcript: vi.fn() });

    const research = await coordinator.routeAndSend({
      roomId: team.room.room.id,
      sessionId: team.room.session.id,
      clientNonce: crypto.randomUUID(),
      text: "从研究开始，研究后交给策划，Brief 后等待用户批准；批准后主笔写草稿并交事实编辑，最后使用 05-data/analytics.csv 做复盘，报告必须包含 asset_count、total_views、total_engagement。",
      targetBotIds: [],
      routingMode: "automatic",
    });
    await vi.waitFor(() => expect(repository.getRoomRun(research.batchId).state).toBe("completed"), { timeout: 10_000 });
    expect(repository.listAgentTurns(research.batchId).map((turn) => [turn.memberNameSnapshot, turn.state])).toEqual([
      ["情报侦察员", "completed"],
      ["选题策划师", "completed"],
    ]);
    expect(existsSync(join(root, "01-inbox", "research.md"))).toBe(true);
    expect(existsSync(join(root, "02-briefs", "options.md"))).toBe(true);

    const source = repository.findLatestCompletedWorkspaceArtifact(team.room.session.id, "02-briefs/")!;
    const briefFile = readFileSync(join(root, source.invocation.targetPath));
    const sha256 = createHash("sha256").update(briefFile).digest("hex");
    expect(source.invocation.resultMetadata?.sha256).toBe(sha256);
    const approval = await coordinator.approveBrief({
      roomId: team.room.room.id,
      clientNonce: crypto.randomUUID(),
      sourceRuntimeRunId: source.run.id,
      briefInvocationId: source.invocation.id,
      sha256,
      candidate: "A",
    });
    await vi.waitFor(() => expect(repository.getRoomRun(approval.batchId).state).toBe("completed"), { timeout: 10_000 });
    await vi.waitFor(() => expect(repository.listAgentTurns(approval.batchId)).toHaveLength(3), { timeout: 10_000 }).catch((cause: unknown) => {
      const turns = repository.listAgentTurns(approval.batchId);
      throw new Error(JSON.stringify({
        batch: repository.getRoomRun(approval.batchId),
        turns: turns.map((turn) => ({
          name: turn.memberNameSnapshot,
          state: turn.state,
          error: turn.lastErrorCode,
          outcome: turn.outcome,
          runtime: turn.runtimeRunId ? repository.getRuntimeRun(turn.runtimeRunId) : null,
        })),
        handoffs: repository.listHandoffs(approval.batchId),
        rejections: repository.listHandoffRejections(approval.batchId),
        tools: repository.listToolInvocations(team.room.session.id).map((tool) => ({
          runtimeRunId: tool.runtimeRunId,
          kind: tool.toolKind,
          state: tool.state,
          error: tool.lastErrorCode,
          path: tool.targetPath,
        })),
        contexts: contexts.map((context) => ({
          bot: names.get(context.executorBotId),
          task: context.executionReceipt?.taskRequirements.text ?? null,
          approved: context.executionReceipt?.approvedBrief?.candidate ?? null,
        })),
      }), { cause });
    });
    for (const context of contexts.filter((context) => context.executionReceipt?.approvedBrief)) {
      expect(context.executionReceipt!.taskRequirements.text).toContain("05-data/analytics.csv");
    }
    expect(repository.listAgentTurns(approval.batchId).map((turn) => [turn.memberNameSnapshot, turn.state])).toEqual([
      ["内容主笔", "completed"],
      ["事实编辑", "completed"],
      ["数据复盘师", "completed"],
    ]);
    for (const path of ["03-drafts/draft.md", "04-review/review.md", "06-reports/report.md"]) {
      expect(existsSync(join(root, path))).toBe(true);
    }
    expect(readFileSync(join(root, "06-reports", "report.md"), "utf8")).toContain('"total_views":300');
    expect(repository.listHandoffs(research.batchId)).toHaveLength(1);
    expect(repository.listHandoffs(approval.batchId)).toHaveLength(2);
    expect(repository.listHandoffs(research.batchId).every((handoff) => handoff.state === "accepted")).toBe(true);
    expect(repository.listHandoffs(approval.batchId).every((handoff) => handoff.state === "accepted")).toBe(true);
    const approvalTurns = repository.listAgentTurns(approval.batchId);
    expect(approvalTurns.every((turn) => repository.getExecutionEvidenceReceipt(turn.id) !== null)).toBe(true);
    for (const turn of approvalTurns) {
      const receipt = repository.getExecutionEvidenceReceipt(turn.id)!;
      expect(receipt.approvedBrief).toMatchObject({ candidate: "A", briefInvocationId: source.invocation.id, sha256 });
      expect(receipt.taskRequirements.text).toContain("05-data/analytics.csv");
      expect(receipt.taskRequirements.text).toContain("Brief 后等待用户批准");
      expect(receipt.artifacts.some((artifact) => artifact.path === "01-inbox/research.md")).toBe(true);
      expect(receipt.artifacts.some((artifact) => artifact.path === "02-briefs/options.md")).toBe(true);
      expect(new Set(receipt.tools.map((tool) => tool.invocationId)).size).toBe(receipt.tools.length);
    }
    expect(repository.listToolInvocations(team.room.session.id).filter((tool) => tool.state !== "succeeded")).toEqual([]);
    expect(repository.listToolInvocations(team.room.session.id).map((tool) => tool.toolKind)).toEqual(expect.arrayContaining([
      "workspace-read", "workspace-write", "text-measure",
    ]));
    expect(contexts.every((context) => !JSON.stringify(context).includes("handoff_to_agent"))).toBe(true);
  }, 20_000);
});
