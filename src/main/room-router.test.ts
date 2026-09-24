import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bot, RoomDetail, RoomSendCommand } from "@shared/contracts";
import { AppRepository } from "./database";
import { OpenAiCompatibleProvider, type ChatMessage, type ModelEvent, type ModelProvider, type RoomOwnerSelection } from "./model";
import { RoomCoordinator } from "./room-coordinator";
import { RuntimeExecutor } from "./runtime-executor";
const repositories: AppRepository[] = [];

afterEach(() => {
  vi.useRealTimers();
  while (repositories.length > 0) repositories.pop()?.close();
});

function setup(provider?: ModelProvider, memberCount = 3): {
  repository: AppRepository;
  bots: Bot[];
  detail: RoomDetail;
  coordinator: RoomCoordinator;
} {
  const repository = new AppRepository(":memory:");
  repositories.push(repository);
  const bots = Array.from({ length: memberCount }, (_, index) => {
    const created = repository.createBot();
    return repository.updateBot(created.bot.id, created.bot.version, {
      name: `Agent ${String.fromCharCode(65 + index)}`,
      label: index === 1 ? "风险审查" : `角色 ${index + 1}`,
      description: index === 1 ? "负责质量复核" : "负责常规工作",
      instructions: `PRIVATE_${index + 1}`,
    });
  });
  const detail = repository.createRoom({ memberBotIds: bots.map((bot) => bot.id), name: "Router Room" });
  const executor = new RuntimeExecutor(
    repository,
    null,
    { transcript: vi.fn(), runtime: vi.fn() },
    provider === undefined,
    provider,
  );
  const coordinator = new RoomCoordinator(repository, executor, { transcript: vi.fn(), roomRuntime: vi.fn() });
  return { repository, bots, detail, coordinator };
}

function command(
  detail: RoomDetail,
  routingMode: "automatic" | "explicit" | "everyone",
  targetBotIds: string[],
  text = "请做风险审查",
): RoomSendCommand {
  return {
    roomId: detail.room.id,
    sessionId: detail.session.id,
    clientNonce: crypto.randomUUID(),
    text,
    targetBotIds,
    routingMode,
  };
}

async function waitForTerminal(repository: AppRepository, batchId: string): Promise<void> {
  await vi.waitFor(() => expect(["completed", "partial", "cancelled"]).toContain(repository.getRoomRun(batchId).state));
}

function completed(text: string): ModelEvent[] {
  return [
    { type: "started", requestId: crypto.randomUUID() },
    { type: "delta", text },
    { type: "completed", finishReason: "stop" },
  ];
}

describe("M4 no-mention central router", () => {
  it("routes a mock OpenAI selector to B and runs only B without leaking peer instructions", async () => {
    const fetchMock = vi.fn().mockImplementation(() => {
      if (fetchMock.mock.calls.length === 1) {
        return Promise.resolve(new Response(JSON.stringify({
          choices: [{ message: { tool_calls: [{
            type: "function",
            function: {
              name: "select_room_owner",
              arguments: JSON.stringify({ ownerAgentId: value.bots[1]!.id, reason: "B matches" }),
            },
          }] } }],
        }), { status: 200 }));
      }
      const encoder = new TextEncoder();
      return Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"B_REPLY"},"finish_reason":"stop"}]}\n\n'));
          controller.close();
        },
      }), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const value = setup(new OpenAiCompatibleProvider("https://example.com/v1", "model", "key"));
    const sent = await value.coordinator.routeAndSend(command(value.detail, "automatic", []));
    await waitForTerminal(value.repository, sent.batchId);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(value.repository.listAgentTurns(sent.batchId).map((turn) => turn.agentId)).toEqual([value.bots[1]!.id]);
    expect(value.repository.listRuntimeRuns(value.detail.session.id)).toHaveLength(1);
    const selectorRequest = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as Record<string, unknown>;
    expect(JSON.stringify(selectorRequest)).not.toContain("PRIVATE_1");
    expect(JSON.stringify(selectorRequest)).not.toContain("PRIVATE_2");
    expect(JSON.stringify(selectorRequest)).not.toContain("PRIVATE_3");
    expect(value.repository.listTranscript(value.detail.session.id).map((entry) => entry.body)).toEqual([
      "请做风险审查",
      "B_REPLY",
    ]);
  });

  it("selects exactly one matching owner, persists a bounded reason, and reuses it for duplicates", async () => {
    const value = setup();
    const input = command(value.detail, "automatic", []);
    const first = await value.coordinator.routeAndSend(input);
    await waitForTerminal(value.repository, first.batchId);
    const run = value.repository.getRoomRun(first.batchId);
    expect(run).toMatchObject({ routingMode: "automatic" });
    expect(run.routingReason).toMatch(/匹配/);
    expect(run.routingReason!.length).toBeLessThanOrEqual(240);
    expect(value.repository.listAgentTurns(first.batchId).map((turn) => turn.agentId)).toEqual([value.bots[1]!.id]);
    expect(value.repository.listTranscript(value.detail.session.id)).toHaveLength(2);

    await expect(value.coordinator.routeAndSend(input)).resolves.toMatchObject({
      disposition: "duplicate",
      batchId: first.batchId,
    });
    expect(value.repository.listAgentTurns(first.batchId)).toHaveLength(1);
    await expect(value.coordinator.routeAndSend({
      ...input,
      routingMode: "explicit",
      targetBotIds: [value.bots[0]!.id],
    })).rejects.toMatchObject({ code: "MESSAGE_NONCE_CONFLICT" });
  });

  it("keeps explicit and everyone routing exact and never invokes the selector", async () => {
    const ownerSelector = vi.fn<(...args: never[]) => Promise<RoomOwnerSelection>>();
    const calls: string[] = [];
    const provider: ModelProvider = {
      async *run(_messages, _signal, context) {
        calls.push(context!.executorBotId);
        for (const event of completed("DONE")) yield event;
      },
      selectRoomOwner: ownerSelector,
      testConnection: async () => {},
    };
    const value = setup(provider);
    const explicitCommand = command(value.detail, "explicit", [value.bots[2]!.id]);
    const explicit = await value.coordinator.routeAndSend(explicitCommand);
    await waitForTerminal(value.repository, explicit.batchId);
    const everyoneCommand = command(
      value.detail,
      "everyone",
      value.bots.map((bot) => bot.id),
      "通知所有人",
    );
    const everyone = await value.coordinator.routeAndSend(everyoneCommand);
    await waitForTerminal(value.repository, everyone.batchId);
    expect(ownerSelector).not.toHaveBeenCalled();
    expect(calls).toEqual([value.bots[2]!.id, ...value.bots.map((bot) => bot.id)]);
    expect(value.repository.getRoomRun(explicit.batchId).routingMode).toBe("explicit");
    expect(value.repository.getRoomRun(everyone.batchId).routingMode).toBe("everyone");

    value.repository.removeRoomMember(value.detail.room.id, value.bots[0]!.id, value.detail.room.membershipVersion);
    await expect(value.coordinator.routeAndSend(explicitCommand)).resolves.toMatchObject({ disposition: "duplicate" });
    await expect(value.coordinator.routeAndSend(everyoneCommand)).resolves.toMatchObject({ disposition: "duplicate" });
    expect(ownerSelector).not.toHaveBeenCalled();
  });

  it("keeps everyone fan-out prompts on the original batch cutoff instead of exposing peer replies", async () => {
    const botIds: string[] = [];
    const captured = new Map<string, ChatMessage[]>();
    const provider: ModelProvider = {
      async *run(messages, _signal, context) {
        const executorBotId = context!.executorBotId;
        captured.set(executorBotId, messages);
        yield { type: "started", requestId: `everyone-${executorBotId}` };
        const seesEarlierReply = messages.some((message) => (
          typeof message.content === "string" && message.content.includes("FIRST_PEER_RESPONSE_MARKER")
        ));
        yield {
          type: "delta",
          text: executorBotId === botIds[0]
            ? "FIRST_PEER_RESPONSE_MARKER"
            : seesEarlierReply ? "文件已读取并完成分析。" : "尚未读取文件，无法核验。",
        };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const value = setup(provider, 2);
    botIds.push(...value.bots.map((bot) => bot.id));
    const input = command(
      value.detail,
      "everyone",
      value.bots.map((bot) => bot.id),
      "请每个 Bot 独立给出一句简短观点，不要转交其他 Bot",
    );
    const sent = await value.coordinator.routeAndSend(input);
    await waitForTerminal(value.repository, sent.batchId);

    const user = value.repository.getUserMessage(input.clientNonce);
    const turns = value.repository.listAgentTurns(sent.batchId);
    expect(value.repository.getRoomRun(sent.batchId).state).toBe("completed");
    expect(turns.map((turn) => turn.promptCutoffSeq)).toEqual([user.seq, user.seq]);
    expect(captured.get(value.bots[1]!.id)?.some((message) => (
      typeof message.content === "string" && message.content.includes("FIRST_PEER_RESPONSE_MARKER")
    ))).toBe(false);
    expect(value.repository.listHandoffs(sent.batchId)).toEqual([]);
  });

  it("repairs one unverified tool claim in fixed routing without marking the original claim successful", async () => {
    const calls = new Map<string, number>();
    const botIds: string[] = [];
    const provider: ModelProvider = {
      async *run(messages, _signal, context) {
        const executorBotId = context!.executorBotId;
        const attempt = (calls.get(executorBotId) ?? 0) + 1;
        calls.set(executorBotId, attempt);
        yield { type: "started", requestId: `evidence-repair-${executorBotId}-${attempt}` };
        if (executorBotId === botIds[0] && attempt === 1) {
          yield { type: "delta", text: "我已经读取文件并完成分析。" };
        } else {
          if (executorBotId === botIds[0]) {
            expect(messages.some((message) => message.role === "system" && message.content.includes("FIXED_ROOM_EVIDENCE_REPAIR"))).toBe(true);
          }
          yield { type: "delta", text: "尚未读取文件，无法核验。请提供文件路径。" };
        }
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const value = setup(provider, 2);
    botIds.push(...value.bots.map((bot) => bot.id));
    const input = command(value.detail, "everyone", value.bots.map((bot) => bot.id), "说明现有资料的情况");
    const sent = await value.coordinator.routeAndSend(input);
    await waitForTerminal(value.repository, sent.batchId);

    const responses = value.repository.listTranscript(value.detail.session.id).filter((entry) => entry.role === "assistant");
    expect([...calls.values()].reduce((total, count) => total + count, 0)).toBe(3);
    expect(calls.get(value.bots[0]!.id)).toBe(2);
    expect(value.repository.getRoomRun(sent.batchId).state).toBe("completed");
    expect(responses.map((response) => response.body)).toEqual([
      "尚未读取文件，无法核验。请提供文件路径。",
      "尚未读取文件，无法核验。请提供文件路径。",
    ]);
    expect(JSON.stringify(responses)).not.toContain("已读取文件");
    expect(value.repository.listToolInvocations(value.detail.session.id)).toHaveLength(0);
  });

  it("rejects an internal Handoff in fixed routing and lets the current Agent finish without a second Bot dispatch", async () => {
    const botIds: string[] = [];
    const calls: string[] = [];
    let fixedHandoffRejected = false;
    const provider: ModelProvider = {
      async *run(messages, _signal, context) {
        const executorBotId = context!.executorBotId;
        calls.push(executorBotId);
        yield { type: "started", requestId: `fixed-handoff-${calls.length}` };
        if (executorBotId === botIds[0] && calls.filter((id) => id === executorBotId).length === 1) {
          yield { type: "delta", text: "我准备把任务交给 Agent B。" };
          yield {
            type: "handoff",
            toolCallId: "unexpected-fixed-handoff",
            toAgentId: botIds[1]!,
            task: "继续处理",
            contextRefs: [],
            visibility: "room",
          };
        } else if (executorBotId === botIds[0]) {
          fixedHandoffRejected = messages.some((message) => message.role === "tool" && message.content.includes("ROOM_HANDOFF_DISABLED"));
          yield { type: "delta", text: "当前是固定响应模式，我会独立完成本回合。" };
        } else {
          yield { type: "delta", text: "Agent B 已独立完成回复。" };
        }
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const value = setup(provider, 2);
    botIds.push(...value.bots.map((bot) => bot.id));
    const input = command(value.detail, "everyone", value.bots.map((bot) => bot.id), "请所有 Bot 各自简短回应");
    const sent = await value.coordinator.routeAndSend(input);
    await waitForTerminal(value.repository, sent.batchId);

    const replies = value.repository.listTranscript(value.detail.session.id).filter((entry) => entry.role === "assistant");
    expect(calls).toEqual([value.bots[0]!.id, value.bots[0]!.id, value.bots[1]!.id]);
    expect(fixedHandoffRejected).toBe(true);
    expect(value.repository.getRoomRun(sent.batchId).state).toBe("completed");
    expect(value.repository.listHandoffs(sent.batchId)).toEqual([]);
    expect(replies.map((entry) => entry.body)).toEqual([
      "当前是固定响应模式，我会独立完成本回合。",
      "Agent B 已独立完成回复。",
    ]);
  });

  it("fails closed before persistence when the adapter cannot select or returns invalid data", async () => {
    const unsupported = setup({ async *run() {}, testConnection: async () => {} });
    await expect(unsupported.coordinator.routeAndSend(command(unsupported.detail, "automatic", []))).rejects.toMatchObject({
      code: "MODEL_ROUTER_UNSUPPORTED",
    });
    expect(unsupported.repository.listTranscript(unsupported.detail.session.id)).toEqual([]);
    expect(unsupported.repository.listRoomBatches(unsupported.detail.room.id)).toEqual([]);

    const invalid = setup({
      async *run() {},
      selectRoomOwner: async () => ({ ownerAgentId: crypto.randomUUID(), reason: "invalid" }),
      testConnection: async () => {},
    });
    await expect(invalid.coordinator.routeAndSend(command(invalid.detail, "automatic", []))).rejects.toMatchObject({
      code: "MODEL_ROUTER_INVALID",
    });
    expect(invalid.repository.listTranscript(invalid.detail.session.id)).toEqual([]);
    expect(invalid.repository.listRoomBatches(invalid.detail.room.id)).toEqual([]);
  });

  it.each([
    ["null", null],
    ["array", []],
    ["missing reason", { ownerAgentId: crypto.randomUUID() }],
    ["non-string reason", { ownerAgentId: crypto.randomUUID(), reason: 1 }],
    ["extra field", { ownerAgentId: crypto.randomUUID(), reason: "reason", extra: true }],
  ])("maps an untrusted adapter's %s selection to a stable error with zero writes", async (_name, result) => {
    const value = setup({
      async *run() {},
      selectRoomOwner: async () => result as never,
      testConnection: async () => {},
    });
    await expect(value.coordinator.routeAndSend(command(value.detail, "automatic", []))).rejects.toMatchObject({
      code: "MODEL_ROUTER_INVALID",
    });
    expect(value.repository.listTranscript(value.detail.session.id)).toEqual([]);
    expect(value.repository.listRoomBatches(value.detail.room.id)).toEqual([]);
    expect(value.repository.listRuntimeRuns(value.detail.session.id)).toEqual([]);
  });

  it("single-flights the same nonce, rejects a concurrent changed command, and calls the owner once", async () => {
    let release!: (selection: RoomOwnerSelection) => void;
    let selectorCalls = 0;
    let ownerCalls = 0;
    const provider: ModelProvider = {
      async *run() {
        ownerCalls += 1;
        for (const event of completed("DONE")) yield event;
      },
      selectRoomOwner: async () => {
        selectorCalls += 1;
        return new Promise((resolve) => { release = resolve; });
      },
      testConnection: async () => {},
    };
    const value = setup(provider);
    const input = command(value.detail, "automatic", []);
    const first = value.coordinator.routeAndSend(input);
    const duplicate = value.coordinator.routeAndSend(input);
    await expect(value.coordinator.routeAndSend({ ...input, text: "changed" })).rejects.toMatchObject({
      code: "MESSAGE_NONCE_CONFLICT",
    });
    release({ ownerAgentId: value.bots[0]!.id, reason: "selected" });
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
    expect(duplicateResult.batchId).toBe(firstResult.batchId);
    await waitForTerminal(value.repository, firstResult.batchId);
    await expect(value.coordinator.routeAndSend(input)).resolves.toMatchObject({
      disposition: "duplicate",
      batchId: firstResult.batchId,
    });
    expect(selectorCalls).toBe(1);
    expect(ownerCalls).toBe(1);
  });

  it("rejects membership changes after selection with zero message/run/turn writes", async () => {
    let release!: (selection: RoomOwnerSelection) => void;
    const provider: ModelProvider = {
      async *run() {},
      selectRoomOwner: async () => new Promise((resolve) => { release = resolve; }),
      testConnection: async () => {},
    };
    const value = setup(provider);
    const pending = value.coordinator.routeAndSend(command(value.detail, "automatic", []));
    value.repository.removeRoomMember(value.detail.room.id, value.bots[2]!.id, value.detail.room.membershipVersion);
    release({ ownerAgentId: value.bots[0]!.id, reason: "selected" });
    await expect(pending).rejects.toMatchObject({ code: "ROOM_MEMBERSHIP_CONFLICT" });
    expect(value.repository.listTranscript(value.detail.session.id)).toEqual([]);
    expect(value.repository.listRoomBatches(value.detail.room.id)).toEqual([]);
    expect(value.repository.listRuntimeRuns(value.detail.session.id)).toEqual([]);
  });

  it("aborts a pending selector on shutdown and ignores a late completion without persistence", async () => {
    let release!: (selection: RoomOwnerSelection) => void;
    const provider: ModelProvider = {
      async *run() {},
      selectRoomOwner: async () => new Promise((resolve) => { release = resolve; }),
      testConnection: async () => {},
    };
    const value = setup(provider);
    const pending = value.coordinator.routeAndSend(command(value.detail, "automatic", []));
    value.coordinator.beginShutdown();
    await expect(pending).rejects.toMatchObject({ code: "APP_INTERRUPTED" });
    release({ ownerAgentId: value.bots[0]!.id, reason: "late" });
    await Promise.resolve();
    expect(value.repository.listTranscript(value.detail.session.id)).toEqual([]);
    expect(value.repository.listRoomBatches(value.detail.room.id)).toEqual([]);
  });

  it("hard-times out an Abort-ignoring selector, releases single-flight state, and permits retry", async () => {
    vi.useFakeTimers();
    let selectorCalls = 0;
    const provider: ModelProvider = {
      async *run() {
        for (const event of completed("DONE")) yield event;
      },
      selectRoomOwner: async (_text, roster) => {
        selectorCalls += 1;
        if (selectorCalls === 1) return new Promise<RoomOwnerSelection>(() => {});
        return { ownerAgentId: roster[0]!.id, reason: "retry selected" };
      },
      testConnection: async () => {},
    };
    const value = setup(provider);
    const input = command(value.detail, "automatic", []);
    const timedOut = value.coordinator.routeAndSend(input);
    const timeoutExpectation = expect(timedOut).rejects.toMatchObject({ code: "MODEL_ROUTER_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(30_000);
    await timeoutExpectation;
    expect(value.repository.listTranscript(value.detail.session.id)).toEqual([]);
    expect(value.repository.listRoomBatches(value.detail.room.id)).toEqual([]);

    const retry = await value.coordinator.routeAndSend(input);
    expect(retry.disposition).toBe("accepted");
    await vi.advanceTimersByTimeAsync(1);
    expect(selectorCalls).toBe(2);
    expect(value.repository.listAgentTurns(retry.batchId)).toHaveLength(1);
  });

  it("keeps structured handoffs working after automatic owner selection", async () => {
    const calls: string[] = [];
    const provider: ModelProvider = {
      async *run(_messages, _signal, context) {
        calls.push(context!.executorBotId);
        yield { type: "started", requestId: crypto.randomUUID() };
        if (!context?.incomingHandoff) {
          yield {
            type: "handoff",
            toolCallId: "auto-to-b",
            toAgentId: value.bots[1]!.id,
            task: "复核",
            contextRefs: [],
            visibility: "room",
          };
        }
        yield { type: "completed", finishReason: "stop" };
      },
      selectRoomOwner: async () => ({ ownerAgentId: value.bots[0]!.id, reason: "A owns this" }),
      testConnection: async () => {},
    };
    const value = setup(provider);
    const sent = await value.coordinator.routeAndSend(command(value.detail, "automatic", [], "coordinate"));
    await waitForTerminal(value.repository, sent.batchId);
    expect(calls).toEqual([value.bots[0]!.id, value.bots[1]!.id]);
    expect(value.repository.listHandoffs(sent.batchId)).toMatchObject([{ toAgentId: value.bots[1]!.id, state: "accepted" }]);
  });
});
