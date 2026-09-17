import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bot, RoomDetail, RoomSendCommand } from "@shared/contracts";
import { AppRepository } from "./database";
import { AevorenBotError } from "./errors";
import type { ChatMessage, ModelEvent, ModelProvider, ModelRunContext } from "./model";
import { ScriptedFakeModelProvider } from "./model";
import { RoomCoordinator } from "./room-coordinator";
import { RuntimeExecutor } from "./runtime-executor";

const repositories: AppRepository[] = [];
const temporaryDirectories: string[] = [];

type Harness = {
  repository: AppRepository;
  bots: Bot[];
  detail: RoomDetail;
  coordinator: RoomCoordinator;
  executor: RuntimeExecutor;
  roomEvents: ReturnType<typeof vi.fn>;
};

afterEach(() => {
  vi.useRealTimers();
  while (repositories.length > 0) repositories.pop()?.close();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

function harness(
  providerFactory: (fixture: Pick<Harness, "repository" | "bots" | "detail">) => ModelProvider,
  memberCount = 3,
  filename = ":memory:",
): Harness {
  const repository = new AppRepository(filename);
  repositories.push(repository);
  const bots = Array.from({ length: memberCount }, (_, index) => {
    const created = repository.createBot();
    return repository.updateBot(created.bot.id, created.bot.version, {
      name: `Agent ${String.fromCharCode(65 + index)}`,
      instructions: `PROFILE_${String.fromCharCode(65 + index)}`,
    });
  });
  const detail = repository.createRoom({ memberBotIds: bots.map((bot) => bot.id), name: "M2 Room" });
  const provider = providerFactory({ repository, bots, detail });
  const roomEvents = vi.fn();
  const executor = new RuntimeExecutor(
    repository,
    null,
    { transcript: vi.fn(), runtime: vi.fn() },
    false,
    provider,
  );
  const coordinator = new RoomCoordinator(repository, executor, { roomRuntime: roomEvents, transcript: vi.fn() });
  return { repository, bots, detail, coordinator, executor, roomEvents };
}

function command(detail: RoomDetail, agentId: string, text = "ROOT_QUESTION"): RoomSendCommand {
  return {
    roomId: detail.room.id,
    sessionId: detail.session.id,
    clientNonce: randomUUID(),
    text,
    targetBotIds: [agentId],
    routingMode: "explicit",
  };
}

function handoff(
  toAgentId: string,
  task: string,
  options: Partial<Extract<ModelEvent, { type: "handoff" }>> = {},
): Extract<ModelEvent, { type: "handoff" }> {
  return {
    type: "handoff",
    toolCallId: `tool:${task}`,
    toAgentId,
    task,
    contextRefs: [],
    visibility: "room",
    ...options,
  };
}

function completedSteps(text: string): ModelEvent[] {
  return [
    { type: "started", requestId: randomUUID() },
    { type: "delta", text },
    { type: "completed", finishReason: "stop" },
  ];
}

function expectRoomRosterMessage(message: ChatMessage, bots: Bot[]): void {
  expect(message.role).toBe("system");
  const parsed = JSON.parse(message.content) as { notice: string; peers: Array<Record<string, string>> };
  expect(parsed.notice).toContain("UNTRUSTED_ROOM_PEER_DATA");
  expect(parsed.peers).toEqual(bots.map((bot) => ({
    id: bot.id,
    name: bot.name,
    label: bot.label,
    description: bot.description,
  })));
  expect(message.content).not.toMatch(/PROFILE_[ABC]/);
}

function expectRoomHandoffContractMessage(message: ChatMessage, incomingFromAgentId?: string): void {
  expect(message.role).toBe("system");
  const parsed = JSON.parse(message.content) as { notice: string; rules: string[]; incomingFromAgentId?: string };
  expect(parsed.notice).toBe("ROOM_HANDOFF_EXECUTION_CONTRACT");
  expect(parsed.rules).toEqual(expect.arrayContaining([
    expect.stringContaining("Only a successful handoff_to_agent function call"),
    expect.stringContaining("never starts another agent"),
  ]));
  if (incomingFromAgentId) {
    expect(parsed.incomingFromAgentId).toBe(incomingFromAgentId);
    expect(parsed.rules).toEqual(expect.arrayContaining([
      expect.stringContaining("INCOMING_HANDOFF"),
      expect.stringContaining("distinct next step"),
    ]));
  }
}

function synchronousThrowingReturnProvider(mode: "completed" | "pending"): ModelProvider {
  return {
    run(): AsyncIterable<ModelEvent> {
      let index = 0;
      const iterator: AsyncIterator<ModelEvent> = {
        next() {
          index += 1;
          if (index === 1) return Promise.resolve({ done: false, value: { type: "started", requestId: "manual" } });
          if (mode === "pending") return new Promise<IteratorResult<ModelEvent>>(() => {});
          if (index === 2) return Promise.resolve({ done: false, value: { type: "completed", finishReason: "stop" } });
          return Promise.resolve({ done: true, value: undefined });
        },
        return(): Promise<IteratorResult<ModelEvent>> {
          throw new Error("synchronous iterator cleanup failure");
        },
      };
      return { [Symbol.asyncIterator]: () => iterator };
    },
    testConnection: async () => {},
  };
}

async function waitForBatch(repository: AppRepository, id: string, states: string[] = ["completed", "partial", "cancelled"]): Promise<void> {
  await vi.waitFor(() => expect(states).toContain(repository.getRoomRun(id).state));
}

function errorCodes(roomEvents: ReturnType<typeof vi.fn>): string[] {
  return roomEvents.mock.calls
    .map(([event]) => (event as { error?: { code: string } }).error?.code)
    .filter((code): code is string => Boolean(code));
}

function errors(roomEvents: ReturnType<typeof vi.fn>): Array<{ code: string; details?: Record<string, unknown> }> {
  return roomEvents.mock.calls
    .map(([event]) => (event as { error?: { code: string; details?: Record<string, unknown> } }).error)
    .filter((error): error is { code: string; details?: Record<string, unknown> } => Boolean(error));
}

describe("M2 bounded Fake multi-Agent orchestrator", () => {
  it("runs only the initially mentioned Agent when no structured Handoff is emitted", async () => {
    const calls: string[] = [];
    const value = harness(() => new ScriptedFakeModelProvider(({ context }) => {
      calls.push(context!.executorBotId);
      return completedSteps("A_VISIBLE");
    }));
    const sent = value.coordinator.sendCoordinated(command(value.detail, value.bots[0]!.id));
    await waitForBatch(value.repository, sent.batchId, ["completed"]);

    expect(calls).toEqual([value.bots[0]!.id]);
    expect(value.repository.listAgentTurns(sent.batchId)).toHaveLength(1);
    expect(value.repository.listTranscript(value.detail.session.id).map((entry) => entry.body)).toEqual([
      "ROOT_QUESTION",
      "A_VISIBLE",
    ]);
  });

  it("uses a structured continuation decision when a completed draft assigns immediate work to a peer", async () => {
    const calls: string[] = [];
    const continuationDrafts: string[] = [];
    const value = harness(({ bots }) => ({
      async *run(_messages, _signal, context) {
        calls.push(context!.executorBotId);
        yield { type: "started", requestId: randomUUID() } as const;
        yield {
          type: "delta",
          text: context!.executorBotId === bots[0]!.id
            ? "ASSIGN：请 Agent B 立即复核当前结果。"
            : "B_VISIBLE",
        } as const;
        yield { type: "completed", finishReason: "stop" } as const;
      },
      testConnection: async () => {},
      async selectRoomContinuation(draft) {
        continuationDrafts.push(draft);
        return {
          action: "handoff" as const,
          toAgentId: bots[1]!.id,
          task: "通过 handoff_to_agent 复核当前结果。",
          contextRefs: [],
          visibility: "room" as const,
          reason: "草稿明确要求 Agent B 立即复核。",
        };
      },
    }), 2);

    const sent = value.coordinator.sendCoordinated(command(value.detail, value.bots[0]!.id));
    await waitForBatch(value.repository, sent.batchId, ["completed"]);

    expect(continuationDrafts).toEqual(["ASSIGN：请 Agent B 立即复核当前结果。"]);
    expect(calls).toEqual([value.bots[0]!.id, value.bots[1]!.id]);
    expect(value.repository.listAgentTurns(sent.batchId).map((turn) => [turn.origin, turn.agentId, turn.state])).toEqual([
      ["initial", value.bots[0]!.id, "completed"],
      ["handoff", value.bots[1]!.id, "completed"],
    ]);
    expect(value.repository.listHandoffs(sent.batchId)).toHaveLength(1);
    expect(value.repository.listHandoffs(sent.batchId)[0]).toMatchObject({
      toAgentId: value.bots[1]!.id,
      task: "通过 结构化转交 复核当前结果。",
      state: "accepted",
    });
    expect(JSON.stringify(value.repository.listTranscript(value.detail.session.id))).not.toContain("handoff_to_agent");
  });

  it("does not let a rejected Provider Handoff suppress the structured continuation fallback", async () => {
    const value = harness(({ bots }) => ({
      async *run(_messages, _signal, context) {
        yield { type: "started", requestId: randomUUID() } as const;
        if (context!.executorBotId === bots[0]!.id) {
          yield { type: "delta", text: "ASSIGN：请 Agent B 立即复核。" } as const;
          yield {
            type: "handoff",
            toolCallId: "provider-invalid-context",
            toAgentId: bots[1]!.id,
            task: "复核",
            contextRefs: ["not-a-transcript-entry"],
            visibility: "room",
          } as const;
        } else {
          yield { type: "delta", text: "B_DONE" } as const;
        }
        yield { type: "completed", finishReason: "stop" } as const;
      },
      testConnection: async () => {},
      async selectRoomContinuation() {
        return {
          action: "handoff" as const,
          toAgentId: bots[1]!.id,
          task: "复核",
          contextRefs: [],
          visibility: "room" as const,
          reason: "立即转交 Agent B。",
        };
      },
    }), 2);

    const sent = value.coordinator.sendCoordinated(command(value.detail, value.bots[0]!.id));
    await waitForBatch(value.repository, sent.batchId, ["completed"]);

    expect(value.repository.listHandoffRejections(sent.batchId)).toHaveLength(1);
    expect(value.repository.listHandoffRejections(sent.batchId)[0]).toMatchObject({ errorCode: "HANDOFF_CONTEXT_INVALID" });
    expect(value.repository.listHandoffs(sent.batchId)).toHaveLength(1);
    expect(value.repository.listHandoffs(sent.batchId)[0]).toMatchObject({ toAgentId: value.bots[1]!.id, state: "accepted" });
  });

  it("does not continue past a structured human-approval decision", async () => {
    let continuationChecks = 0;
    const value = harness(() => ({
      async *run() {
        yield { type: "started", requestId: randomUUID() } as const;
        yield { type: "delta", text: "等待用户批准后再交给 Agent B；当前停止。" } as const;
        yield { type: "completed", finishReason: "stop" } as const;
      },
      testConnection: async () => {},
      async selectRoomContinuation() {
        continuationChecks += 1;
        return { action: "complete" as const, reason: "当前处于人工批准门禁。" };
      },
    }), 2);

    const sent = value.coordinator.sendCoordinated(command(value.detail, value.bots[0]!.id));
    await waitForBatch(value.repository, sent.batchId, ["completed"]);

    expect(continuationChecks).toBe(1);
    expect(value.repository.listAgentTurns(sent.batchId)).toHaveLength(1);
    expect(value.repository.listHandoffs(sent.batchId)).toHaveLength(0);
  });

  it("reuses the persisted root policy/nonces for exact duplicates without another provider call", async () => {
    let calls = 0;
    const value = harness(() => new ScriptedFakeModelProvider(() => {
      calls += 1;
      return completedSteps("ONLY_ONCE");
    }), 2);
    const input = command(value.detail, value.bots[0]!.id);
    const first = value.coordinator.sendCoordinated(input, { deadlineMs: 60_000 });
    const original = value.repository.getRoomRun(first.batchId);
    expect(value.coordinator.sendCoordinated(input, { deadlineMs: 1 })).toMatchObject({
      disposition: "duplicate",
      batchId: first.batchId,
    });
    await waitForBatch(value.repository, first.batchId, ["completed"]);
    expect(value.coordinator.sendCoordinated(input)).toMatchObject({ disposition: "duplicate" });

    expect(calls).toBe(1);
    expect(value.repository.getRoomRun(first.batchId).deadlineAt).toBe(original.deadlineAt);
    expect(value.repository.listAgentTurns(first.batchId)).toHaveLength(1);
    expect(() => value.coordinator.sendCoordinated({ ...input, text: "CHANGED" })).toThrowError(
      expect.objectContaining({ code: "MESSAGE_NONCE_CONFLICT" }),
    );
  });

  it("persists A to B as FIFO queued/dispatching/accepted and projects only frozen Room context plus the task", async () => {
    const calls: string[] = [];
    let bMessages: ChatMessage[] = [];
    let bContext: ModelRunContext | undefined;
    let beforeStarted = "";
    let afterStarted = "";
    const rootCommandNonce = randomUUID();
    const provider: ModelProvider = {
      async *run(messages, _signal, context) {
        calls.push(context!.executorBotId);
        if (context!.executorBotId === value.bots[0]!.id) {
          yield { type: "started", requestId: "request-a" };
          yield { type: "delta", text: "A_FUTURE_SIBLING_MARKER" };
          const root = value.repository.getRoomBatchByNonce(rootCommandNonce)!;
          yield handoff(value.bots[1]!.id, "HANDOFF_TASK_FOR_B", {
            toolCallId: "TOOL_CALL_SECRET",
            contextRefs: [root.triggerMessageId],
          });
          yield { type: "completed", finishReason: "stop" };
          return;
        }
        bMessages = messages;
        bContext = context;
        beforeStarted = value.repository.listHandoffs(value.repository.getRoomBatchByNonce(rootCommandNonce)!.id)[0]!.state;
        yield { type: "started", requestId: "request-b" };
        afterStarted = value.repository.listHandoffs(value.repository.getRoomBatchByNonce(rootCommandNonce)!.id)[0]!.state;
        yield { type: "delta", text: "B_VISIBLE" };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const value = harness(() => provider, 3);

    for (const [bot, marker] of [[value.bots[0]!, "A_PRIVATE_MARKER"], [value.bots[1]!, "B_PRIVATE_MARKER"]] as const) {
      const privateNonce = randomUUID();
      const sessionId = value.repository.getMainSession(bot.id).id;
      value.repository.prepareMessage({ sessionId, clientNonce: privateNonce, text: marker });
      value.repository.acknowledgeUserMessage(privateNonce);
    }
    const otherRoom = value.repository.createRoom({
      memberBotIds: [value.bots[1]!.id, value.bots[2]!.id],
      name: "Other Room",
    });
    const otherNonce = randomUUID();
    value.repository.prepareMessage({ sessionId: otherRoom.session.id, clientNonce: otherNonce, text: "OTHER_ROOM_MARKER" });
    value.repository.acknowledgeUserMessage(otherNonce);

    const input = {
      ...command(value.detail, value.bots[0]!.id),
      clientNonce: rootCommandNonce,
    };
    const sent = value.coordinator.sendCoordinated(input);
    await waitForBatch(value.repository, sent.batchId, ["completed"]);

    expect(calls).toEqual([value.bots[0]!.id, value.bots[1]!.id]);
    expect(beforeStarted).toBe("dispatching");
    expect(afterStarted).toBe("accepted");
    const turns = value.repository.listAgentTurns(sent.batchId);
    expect(turns.map((turn) => [turn.agentId, turn.position, turn.state])).toEqual([
      [value.bots[0]!.id, 0, "completed"],
      [value.bots[1]!.id, 1, "completed"],
    ]);
    const persistedHandoff = value.repository.listHandoffs(sent.batchId)[0]!;
    expect(persistedHandoff).toMatchObject({ state: "accepted", targetTurnId: turns[1]!.id });
    expect(turns[1]!.nonce).toBe("TOOL_CALL_SECRET");
    expect(bMessages).toHaveLength(5);
    expect(bMessages[0]).toEqual({ role: "system", content: "PROFILE_B" });
    expectRoomHandoffContractMessage(bMessages[1]!, value.bots[0]!.id);
    expectRoomRosterMessage(bMessages[2]!, value.bots);
    expect(bMessages[3]).toEqual({ role: "user", content: "ROOT_QUESTION" });
    expect(bMessages[4]?.role).toBe("user");
    expect(JSON.parse(bMessages[4]!.content)).toMatchObject({
      notice: "INCOMING_HANDOFF_TASK",
      fromAgentId: value.bots[0]!.id,
      task: "HANDOFF_TASK_FOR_B",
    });
    expect(bContext?.incomingHandoff).toMatchObject({
      id: persistedHandoff.id,
      fromAgentId: value.bots[0]!.id,
      task: "HANDOFF_TASK_FOR_B",
      contextRefs: [value.repository.getRoomRun(sent.batchId).triggerMessageId],
    });
    const bRun = value.repository.listRuntimeRuns(value.detail.session.id).find((run) => run.executorBotId === value.bots[1]!.id)!;
    expect(bRun.promptCutoffSeq).toBe(1);
    expect(bRun.promptManifest.handoff).toMatchObject({
      id: persistedHandoff.id,
      fromAgentId: value.bots[0]!.id,
      contextRefs: [value.repository.getRoomRun(sent.batchId).triggerMessageId],
    });
    expect(JSON.stringify(bRun.promptManifest)).not.toContain("HANDOFF_TASK_FOR_B");
    expect(JSON.stringify(bMessages)).not.toMatch(/A_PRIVATE_MARKER|B_PRIVATE_MARKER|OTHER_ROOM_MARKER|A_FUTURE_SIBLING_MARKER/);
    const transcript = JSON.stringify(value.repository.listTranscript(value.detail.session.id));
    expect(transcript).not.toMatch(/HANDOFF_TASK_FOR_B|TOOL_CALL_SECRET|"type":"handoff"/);
  });

  it("freezes a multi-initial source authority cursor for B to C context projection", async () => {
    const calls: string[] = [];
    let cMessages: ChatMessage[] = [];
    const provider: ModelProvider = {
      async *run(messages, _signal, context) {
        const agentId = context!.executorBotId;
        calls.push(agentId);
        if (agentId === value.bots[0]!.id) {
          yield { type: "started", requestId: "a" };
          yield { type: "delta", text: "A_AUTHORITY_OUTPUT" };
          yield { type: "completed", finishReason: "stop" };
          return;
        }
        if (agentId === value.bots[1]!.id) {
          const aEntry = value.repository.listTranscript(value.detail.session.id).find(
            (entry) => entry.speakerBotId === value.bots[0]!.id && entry.status === "completed",
          )!;
          yield { type: "started", requestId: "b" };
          yield { type: "delta", text: "B_FUTURE_OUTPUT" };
          yield handoff(value.bots[2]!.id, "C_REVIEW_TASK", {
            toolCallId: "b-to-c-tool",
            contextRefs: [aEntry.id],
          });
          yield { type: "completed", finishReason: "stop" };
          return;
        }
        cMessages = messages;
        yield { type: "started", requestId: "c" };
        yield { type: "delta", text: "C_DONE" };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const value = harness(() => provider, 3);
    for (const [bot, marker] of [[value.bots[0]!, "A_MAIN_PRIVATE"], [value.bots[2]!, "C_MAIN_PRIVATE"]] as const) {
      const nonce = randomUUID();
      value.repository.prepareMessage({
        sessionId: value.repository.getMainSession(bot.id).id,
        clientNonce: nonce,
        text: marker,
      });
      value.repository.acknowledgeUserMessage(nonce);
    }
    const otherRoom = value.repository.createRoom({
      memberBotIds: [value.bots[0]!.id, value.bots[2]!.id],
      name: "Other authority",
    });
    const otherNonce = randomUUID();
    value.repository.prepareMessage({ sessionId: otherRoom.session.id, clientNonce: otherNonce, text: "OTHER_ROOM_PRIVATE" });
    value.repository.acknowledgeUserMessage(otherNonce);
    const input = command(value.detail, value.bots[0]!.id);
    input.targetBotIds = [value.bots[0]!.id, value.bots[1]!.id];
    const sent = value.coordinator.sendCoordinated(input);
    await waitForBatch(value.repository, sent.batchId, ["completed"]);

    expect(calls).toEqual([value.bots[0]!.id, value.bots[1]!.id, value.bots[2]!.id]);
    const turns = value.repository.listAgentTurns(sent.batchId);
    const bTurn = turns.find((turn) => turn.agentId === value.bots[1]!.id)!;
    const cTurn = turns.find((turn) => turn.agentId === value.bots[2]!.id)!;
    const aEntry = value.repository.listTranscript(value.detail.session.id).find(
      (entry) => entry.speakerBotId === value.bots[0]!.id,
    )!;
    expect(bTurn.promptCutoffSeq).toBe(aEntry.seq);
    expect(cTurn).toMatchObject({ inputSeq: bTurn.promptCutoffSeq, promptCutoffSeq: bTurn.promptCutoffSeq });
    expect(cMessages).toHaveLength(6);
    expect(cMessages[0]).toEqual({ role: "system", content: "PROFILE_C" });
    expectRoomHandoffContractMessage(cMessages[1]!, value.bots[1]!.id);
    expectRoomRosterMessage(cMessages[2]!, value.bots);
    expect(cMessages.slice(3, 5)).toEqual([
      { role: "user", content: "ROOT_QUESTION" },
      { role: "assistant", content: `[room-speaker id="${value.bots[0]!.id}" name="Agent A"]\nA_AUTHORITY_OUTPUT` },
    ]);
    expect(cMessages[5]?.role).toBe("user");
    expect(JSON.parse(cMessages[5]!.content)).toMatchObject({
      notice: "INCOMING_HANDOFF_TASK",
      fromAgentId: value.bots[1]!.id,
      task: "C_REVIEW_TASK",
    });
    expect(JSON.stringify(cMessages)).not.toMatch(/B_FUTURE_OUTPUT|A_MAIN_PRIVATE|C_MAIN_PRIVATE|OTHER_ROOM_PRIVATE/);
    const cRun = value.repository.getRuntimeRun(cTurn.runtimeRunId!);
    expect(cRun).toMatchObject({ inputSeq: bTurn.promptCutoffSeq, promptCutoffSeq: bTurn.promptCutoffSeq });
    expect(cRun.promptManifest).toMatchObject({
      inputSeq: bTurn.promptCutoffSeq,
      promptCutoffSeq: bTurn.promptCutoffSeq,
      handoff: { contextRefs: [aEntry.id], taskDigest: expect.any(String) },
    });
  });

  it("deduplicates the same Handoff event without duplicating its target turn or provider call", async () => {
    const calls: string[] = [];
    const value = harness(({ bots }) => {
      const event = handoff(bots[1]!.id, "SAME_TASK");
      return new ScriptedFakeModelProvider(({ context }) => {
        calls.push(context!.executorBotId);
        return context!.executorBotId === bots[0]!.id
          ? [{ type: "started", requestId: "a" }, event, event, { type: "completed", finishReason: "stop" }]
          : completedSteps("B_DONE");
      });
    }, 2);
    const sent = value.coordinator.sendCoordinated(command(value.detail, value.bots[0]!.id));
    await waitForBatch(value.repository, sent.batchId, ["completed"]);

    expect(calls).toEqual([value.bots[0]!.id, value.bots[1]!.id]);
    expect(value.repository.listHandoffs(sent.batchId)).toHaveLength(1);
    expect(value.repository.listAgentTurns(sent.batchId)).toHaveLength(2);
  });

  it("rejects a second task for the same source/target pair without replacing the accepted task", async () => {
    const calls: string[] = [];
    const value = harness(({ bots }) => new ScriptedFakeModelProvider(({ context }) => {
      calls.push(context!.executorBotId);
      return context!.executorBotId === bots[0]!.id
        ? [
            { type: "started", requestId: "a" },
            handoff(bots[1]!.id, "FIRST_TASK"),
            handoff(bots[1]!.id, "CONFLICTING_TASK", { toolCallId: "conflicting-tool" }),
            { type: "completed", finishReason: "stop" },
          ]
        : completedSteps("B_DONE");
    }), 2);
    const sent = value.coordinator.sendCoordinated(command(value.detail, value.bots[0]!.id));
    await waitForBatch(value.repository, sent.batchId, ["completed"]);

    expect(calls).toEqual([value.bots[0]!.id, value.bots[1]!.id]);
    expect(value.repository.listHandoffs(sent.batchId)).toMatchObject([{ task: "FIRST_TASK", state: "accepted" }]);
    expect(errorCodes(value.roomEvents)).toContain("HANDOFF_TARGET_CONFLICT");
  });

  it("rejects a context reference outside the frozen Room authority cursor", async () => {
    let privateEntryId = "";
    const calls: string[] = [];
    const value = harness(({ bots, repository }) => {
      const privateNonce = randomUUID();
      repository.prepareMessage({
        sessionId: repository.getMainSession(bots[0]!.id).id,
        clientNonce: privateNonce,
        text: "PRIVATE_CONTEXT",
      });
      repository.acknowledgeUserMessage(privateNonce);
      privateEntryId = repository.getUserMessage(privateNonce).id;
      return new ScriptedFakeModelProvider(({ context }) => {
        calls.push(context!.executorBotId);
        return [
          { type: "started", requestId: "a" },
          handoff(bots[1]!.id, "BAD_CONTEXT", { contextRefs: [privateEntryId] }),
          { type: "completed", finishReason: "stop" },
        ];
      });
    }, 2);
    const sent = value.coordinator.sendCoordinated(command(value.detail, value.bots[0]!.id));
    await waitForBatch(value.repository, sent.batchId, ["completed"]);

    expect(calls).toEqual([value.bots[0]!.id]);
    expect(value.repository.listHandoffs(sent.batchId)).toHaveLength(0);
    expect(value.repository.listAgentTurns(sent.batchId)).toHaveLength(1);
    expect(value.repository.listHandoffRejections(sent.batchId)).toMatchObject([
      { errorCode: "HANDOFF_CONTEXT_INVALID", attemptedToAgentId: value.bots[1]!.id },
    ]);
    expect(errorCodes(value.roomEvents)).toContain("HANDOFF_CONTEXT_INVALID");
  });

  it("blocks an identical-digest A to B to A cycle with an observable stable error", async () => {
    const calls: string[] = [];
    const value = harness(({ bots }) => new ScriptedFakeModelProvider(({ context }) => {
      const agent = context!.executorBotId;
      calls.push(agent);
      return agent === bots[0]!.id
        ? [{ type: "started", requestId: "a" }, handoff(bots[1]!.id, "SAME_DIGEST"), { type: "completed", finishReason: "stop" }]
        : [{ type: "started", requestId: "b" }, handoff(bots[0]!.id, "SAME_DIGEST"), { type: "completed", finishReason: "stop" }];
    }), 2);
    const sent = value.coordinator.sendCoordinated(command(value.detail, value.bots[0]!.id));
    await waitForBatch(value.repository, sent.batchId, ["completed"]);

    expect(calls).toEqual([value.bots[0]!.id, value.bots[1]!.id]);
    expect(value.repository.listAgentTurns(sent.batchId)).toHaveLength(2);
    expect(value.repository.listHandoffRejections(sent.batchId)).toMatchObject([
      { errorCode: "HANDOFF_CYCLE", attemptedToAgentId: value.bots[0]!.id },
    ]);
    expect(errorCodes(value.roomEvents)).toContain("HANDOFF_CYCLE");
  });

  it("allows a different-task A to B to A chain and terminates after exactly three FIFO turns", async () => {
    const calls: string[] = [];
    const value = harness(({ bots }) => new ScriptedFakeModelProvider(({ callIndex, context }) => {
      calls.push(context!.executorBotId);
      if (callIndex === 0) {
        return [{ type: "started", requestId: "a1" }, handoff(bots[1]!.id, "TASK_ONE"), { type: "completed", finishReason: "stop" }];
      }
      if (callIndex === 1) {
        return [{ type: "started", requestId: "b" }, handoff(bots[0]!.id, "TASK_TWO"), { type: "completed", finishReason: "stop" }];
      }
      return completedSteps("A_FINAL");
    }), 2);
    const sent = value.coordinator.sendCoordinated(command(value.detail, value.bots[0]!.id));
    await waitForBatch(value.repository, sent.batchId, ["completed"]);

    expect(calls).toEqual([value.bots[0]!.id, value.bots[1]!.id, value.bots[0]!.id]);
    expect(value.repository.listAgentTurns(sent.batchId).map((turn) => turn.position)).toEqual([0, 1, 2]);
    expect(value.repository.listHandoffs(sent.batchId).map((item) => item.state)).toEqual(["accepted", "accepted"]);
  });

  it.each([
    ["max-turns", { maxTurns: 1 }, "ROOM_RUN_LIMIT_EXCEEDED"],
    ["max-hops", { maxHops: 0 }, "ROOM_RUN_LIMIT_EXCEEDED"],
  ] as const)("stops %s before expanding the provider call count", async (_name, policy, code) => {
    const calls: string[] = [];
    const value = harness(({ bots }) => new ScriptedFakeModelProvider(({ context }) => {
      calls.push(context!.executorBotId);
      return context!.executorBotId === bots[0]!.id
        ? [{ type: "started", requestId: "a" }, handoff(bots[1]!.id, "LIMITED"), { type: "completed", finishReason: "stop" }]
        : completedSteps("UNEXPECTED");
    }), 2);
    const sent = value.coordinator.sendCoordinated(command(value.detail, value.bots[0]!.id), policy);
    await waitForBatch(value.repository, sent.batchId, ["completed"]);

    expect(calls).toEqual([value.bots[0]!.id]);
    expect(value.repository.listAgentTurns(sent.batchId)).toHaveLength(1);
    expect(value.repository.listHandoffRejections(sent.batchId)).toHaveLength(1);
    expect(value.repository.listHandoffRejections(sent.batchId)[0]).toMatchObject({ errorCode: code });
    expect(errorCodes(value.roomEvents)).toContain(code);
    expect(errors(value.roomEvents)).toContainEqual(expect.objectContaining({
      code,
      details: { reason: _name },
    }));
  });

  it("enforces maxTargetsPerTurn without scheduling a third Agent", async () => {
    const calls: string[] = [];
    const value = harness(({ bots }) => new ScriptedFakeModelProvider(({ context }) => {
      calls.push(context!.executorBotId);
      return context!.executorBotId === bots[0]!.id
        ? [
            { type: "started", requestId: "a" },
            handoff(bots[1]!.id, "FIRST_TARGET"),
            handoff(bots[2]!.id, "SECOND_TARGET"),
            { type: "completed", finishReason: "stop" },
          ]
        : completedSteps("TARGET_DONE");
    }));
    const sent = value.coordinator.sendCoordinated(
      command(value.detail, value.bots[0]!.id),
      { maxTargetsPerTurn: 1 },
    );
    await waitForBatch(value.repository, sent.batchId, ["completed"]);

    expect(calls).toEqual([value.bots[0]!.id, value.bots[1]!.id]);
    expect(value.repository.listAgentTurns(sent.batchId)).toHaveLength(2);
    expect(value.repository.listHandoffRejections(sent.batchId)).toMatchObject([
      { errorCode: "ROOM_RUN_LIMIT_EXCEEDED", attemptedToAgentId: value.bots[2]!.id },
    ]);
    expect(errorCodes(value.roomEvents)).toContain("ROOM_RUN_LIMIT_EXCEEDED");
    expect(errors(value.roomEvents)).toContainEqual(expect.objectContaining({
      code: "ROOM_RUN_LIMIT_EXCEEDED",
      details: { reason: "max-targets-per-turn" },
    }));
  });

  it("keeps a failed delivery attempt while a retry completes the same logical target Turn", async () => {
    const calls: string[] = [];
    const value = harness(({ bots }) => new ScriptedFakeModelProvider(({ callIndex, context }) => {
      calls.push(context!.executorBotId);
      if (context!.executorBotId === bots[0]!.id) {
        return [{ type: "started", requestId: "a" }, handoff(bots[1]!.id, "B_FAILS"), { type: "completed", finishReason: "stop" }];
      }
      return callIndex === 1
        ? [{ type: "failure", error: new Error("before-start") }]
        : completedSteps("B_RECOVERED");
    }), 2);
    const sent = value.coordinator.sendCoordinated(command(value.detail, value.bots[0]!.id));
    await waitForBatch(value.repository, sent.batchId, ["partial"]);

    expect(calls).toEqual([value.bots[0]!.id, value.bots[1]!.id]);
    expect(value.repository.listHandoffs(sent.batchId)).toMatchObject([{ state: "failed" }]);
    expect(value.repository.listAgentTurns(sent.batchId).map((turn) => turn.state)).toEqual(["completed", "failed"]);

    const failedTarget = value.repository.listAgentTurns(sent.batchId)[1]!;
    const retry = value.coordinator.retryTurn(failedTarget.id);
    await waitForBatch(value.repository, sent.batchId, ["completed"]);
    expect(calls).toEqual([value.bots[0]!.id, value.bots[1]!.id, value.bots[1]!.id]);
    expect(value.repository.listHandoffs(sent.batchId)).toMatchObject([{ state: "failed", targetTurnId: failedTarget.id }]);
    expect(value.repository.listAgentTurns(sent.batchId)).toMatchObject([
      { id: value.repository.listAgentTurns(sent.batchId)[0]!.id, state: "completed" },
      { id: failedTarget.id, logicalTurnId: failedTarget.logicalTurnId, state: "failed", attemptNo: 1 },
      { id: retry.id, logicalTurnId: failedTarget.logicalTurnId, state: "completed", attemptNo: 2 },
    ]);
  });

  it.each([
    ["self", (bots: Bot[]) => handoff(bots[0]!.id, "SELF"), "HANDOFF_CYCLE"],
    ["invalid", (_bots: Bot[]) => handoff(randomUUID(), "INVALID"), "BOT_NOT_FOUND"],
    ["direct", (bots: Bot[]) => handoff(bots[1]!.id, "DIRECT", { visibility: "direct" }), "INVALID_REQUEST"],
  ] as const)("fails closed for a %s target without fallback", async (_name, eventFactory, expectedCode) => {
    const calls: string[] = [];
    const value = harness(({ bots }) => new ScriptedFakeModelProvider(({ context }) => {
      calls.push(context!.executorBotId);
      return [
        { type: "started", requestId: "a" },
        eventFactory(bots),
        { type: "completed", finishReason: "stop" },
      ];
    }), 2);
    const sent = value.coordinator.sendCoordinated(command(value.detail, value.bots[0]!.id));
    await waitForBatch(value.repository, sent.batchId, ["completed"]);

    expect(calls).toEqual([value.bots[0]!.id]);
    expect(value.repository.listAgentTurns(sent.batchId)).toHaveLength(1);
    expect(value.repository.listHandoffs(sent.batchId)).toHaveLength(0);
    expect(value.repository.listHandoffRejections(sent.batchId)).toMatchObject([{
      errorCode: expectedCode,
      attemptedToAgentId: expect.any(String),
      toolCallKey: expect.stringMatching(/^[a-f0-9]{64}$/),
    }]);
    expect(JSON.stringify(value.repository.listHandoffRejections(sent.batchId))).not.toMatch(/"task"|SELF|DIRECT|tool:/);
    const publicRejection = value.coordinator.getSnapshot(value.detail.room.id).rejections[0]!;
    expect(publicRejection).not.toHaveProperty("toolCallKey");
    expect(errorCodes(value.roomEvents)).toContain(expectedCode);
  });

  it("journals a repeated rejected tool call exactly once", async () => {
    const value = harness(({ bots }) => new ScriptedFakeModelProvider(() => {
      const rejected = handoff(bots[0]!.id, "REJECTED_SECRET", { toolCallId: "same-rejected-tool" });
      return [{ type: "started", requestId: "a" }, rejected, rejected, { type: "completed", finishReason: "stop" }];
    }), 2);
    const sent = value.coordinator.sendCoordinated(command(value.detail, value.bots[0]!.id));
    await waitForBatch(value.repository, sent.batchId, ["completed"]);

    expect(value.repository.listHandoffRejections(sent.batchId)).toHaveLength(1);
    expect(JSON.stringify(value.repository.listHandoffRejections(sent.batchId))).not.toMatch(/same-rejected-tool|REJECTED_SECRET/);
  });

  it("revalidates membership before dispatch and never falls back to the remaining Room members", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-m2-membership-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const value = harness(({ bots }) => ({
      async *run(_messages, _signal, context) {
        calls.push(context!.executorBotId);
        yield { type: "started", requestId: "a" } as ModelEvent;
        yield handoff(bots[1]!.id, "MEMBERSHIP_CHANGED");
        await gate;
        yield { type: "completed", finishReason: "stop" } as ModelEvent;
      },
      testConnection: async () => {},
    }), 3, filename);
    const sent = value.coordinator.sendCoordinated(command(value.detail, value.bots[0]!.id));
    await vi.waitFor(() => expect(value.repository.listHandoffs(sent.batchId)).toHaveLength(1));
    const injector = new DatabaseSync(filename);
    injector.prepare("DELETE FROM room_members WHERE room_id = ? AND bot_id = ?").run(
      value.detail.room.id,
      value.bots[1]!.id,
    );
    injector.prepare("UPDATE rooms SET membership_version = membership_version + 1 WHERE id = ?").run(value.detail.room.id);
    injector.close();
    release();
    await waitForBatch(value.repository, sent.batchId, ["partial"]);

    expect(calls).toEqual([value.bots[0]!.id]);
    expect(value.repository.listAgentTurns(sent.batchId).map((turn) => turn.state)).toEqual(["completed", "cancelled"]);
    expect(value.repository.listHandoffs(sent.batchId)[0]!.state).toBe("cancelled");
    expect(errorCodes(value.roomEvents)).toContain("ROOM_MEMBERSHIP_CONFLICT");
  });

  it("cancels a queued successor and drops ignore-Abort late Handoff/delta/completed events", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const value = harness(({ bots }) => ({
      async *run(_messages, _signal, context) {
        calls.push(context!.executorBotId);
        yield { type: "started", requestId: "a" } as ModelEvent;
        yield handoff(bots[1]!.id, "QUEUED_B");
        yield { type: "delta", text: "BEFORE_CANCEL" } as ModelEvent;
        await gate;
        yield handoff(bots[2]!.id, "LATE_C");
        yield { type: "delta", text: "LATE_DELTA" } as ModelEvent;
        yield { type: "completed", finishReason: "stop" } as ModelEvent;
      },
      testConnection: async () => {},
    }));
    const sent = value.coordinator.sendCoordinated(command(value.detail, value.bots[0]!.id));
    await vi.waitFor(() => expect(value.repository.listHandoffs(sent.batchId)).toHaveLength(1));
    value.coordinator.cancel(sent.batchId);
    release();
    await vi.waitFor(() => expect(value.repository.listAgentTurns(sent.batchId)[0]!.state).toBe("cancelled"));

    expect(calls).toEqual([value.bots[0]!.id]);
    expect(value.repository.listAgentTurns(sent.batchId).map((turn) => turn.state)).toEqual(["cancelled", "cancelled"]);
    expect(value.repository.listHandoffs(sent.batchId)).toMatchObject([{ state: "cancelled" }]);
    expect(JSON.stringify(value.repository.listTranscript(value.detail.session.id))).not.toContain("LATE_DELTA");
  });

  it("keeps user cancellation observable until an Abort-ignoring Provider yields again", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const value = harness(() => ({
      async *run() {
        yield { type: "started", requestId: "user-cancel-gate" } as ModelEvent;
        await gate;
        yield { type: "delta", text: "AFTER_USER_CANCEL" } as ModelEvent;
        yield { type: "completed", finishReason: "stop" } as ModelEvent;
      },
      testConnection: async () => {},
    }), 2);
    const sent = value.coordinator.sendCoordinated(command(value.detail, value.bots[0]!.id));
    await vi.waitFor(() => expect(value.repository.listAgentTurns(sent.batchId)[0]!.runtimeRunId).not.toBeNull());
    const turn = value.repository.listAgentTurns(sent.batchId)[0]!;
    const runtimeId = turn.runtimeRunId!;
    await vi.waitFor(() => expect(value.repository.getRuntimeRun(runtimeId).state).toBe("running"));
    value.coordinator.cancel(sent.batchId);

    expect(value.repository.getRuntimeRun(runtimeId).state).toBe("cancel-requested");
    expect(value.executor.getLiveState(value.detail.session.id).state).toBe("cancelling");
    expect(value.repository.getRoomTurn(turn.id).state).toBe("running");
    release();
    await vi.waitFor(() => expect(value.repository.getRuntimeRun(runtimeId).state).toBe("cancelled"));

    expect(value.repository.getRoomTurn(turn.id)).toMatchObject({
      state: "cancelled",
      outcome: { kind: "cancelled", errorCode: "MESSAGE_CANCELLED" },
    });
    expect(JSON.stringify(value.repository.listTranscript(value.detail.session.id))).not.toContain("AFTER_USER_CANCEL");
  });

  it("recovers a persisted Direct cancel-requested Runtime as interrupted without replay", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const value = harness(() => ({
      async *run() {
        calls += 1;
        yield { type: "started", requestId: "direct-cancel-recovery" } as ModelEvent;
        await gate;
        yield { type: "completed", finishReason: "stop" } as ModelEvent;
      },
      testConnection: async () => {},
    }), 2);
    const nonce = randomUUID();
    const session = value.repository.getMainSession(value.bots[0]!.id);
    value.repository.prepareMessage({ sessionId: session.id, clientNonce: nonce, text: "DIRECT_CANCEL_RECOVERY" });
    value.repository.acknowledgeUserMessage(nonce);
    const started = value.executor.start({
      clientNonce: nonce,
      executorBotId: value.bots[0]!.id,
      executionKey: nonce,
    });
    await vi.waitFor(() => expect(value.repository.getRuntimeRun(started.run.id).state).toBe("running"));
    value.executor.cancelRun(started.run.id);
    expect(value.repository.getRuntimeRun(started.run.id).state).toBe("cancel-requested");
    expect(value.executor.getLiveState(session.id).state).toBe("cancelling");

    expect(value.repository.recoverInterruptedRuntimeRuns()).toBe(1);
    expect(value.repository.getRuntimeRun(started.run.id)).toMatchObject({
      state: "interrupted",
      lastErrorCode: "APP_INTERRUPTED",
    });
    release();
    const result = await started.completion;

    expect(result.run.state).toBe("interrupted");
    expect(calls).toBe(1);
    expect(value.repository.listRuntimeRuns(session.id)).toHaveLength(1);
  });

  it("actively winds down at the root deadline and drops every late successor event", async () => {
    const calls: string[] = [];
    const value = harness(({ bots }) => new ScriptedFakeModelProvider(({ context }) => {
      calls.push(context!.executorBotId);
      return [
        { type: "started", requestId: "a" },
        handoff(bots[1]!.id, "DEADLINE_B"),
        { type: "delay", milliseconds: 40, ignoreAbort: true },
        handoff(bots[2]!.id, "LATE_DEADLINE_C"),
        { type: "delta", text: "LATE_DEADLINE_DELTA" },
        { type: "completed", finishReason: "stop" },
      ];
    }));
    const sent = value.coordinator.sendCoordinated(
      command(value.detail, value.bots[0]!.id),
      { deadlineMs: 10 },
    );
    await waitForBatch(value.repository, sent.batchId, ["partial"]);

    expect(calls).toEqual([value.bots[0]!.id]);
    expect(value.repository.getRoomRun(sent.batchId).windingDown).toBe(true);
    expect(value.repository.listAgentTurns(sent.batchId).map((turn) => [turn.state, turn.outcome?.kind])).toEqual([
      ["failed", "timeout"],
      ["cancelled", "cancelled"],
    ]);
    const timedOutRuntime = value.repository.getRuntimeRun(value.repository.listAgentTurns(sent.batchId)[0]!.runtimeRunId!);
    expect(timedOutRuntime).toMatchObject({ state: "failed", lastErrorCode: "MODEL_RUN_TIMEOUT" });
    expect(value.repository.listHandoffs(sent.batchId)).toMatchObject([{ state: "cancelled" }]);
    expect(errorCodes(value.roomEvents)).toContain("ROOM_RUN_LIMIT_EXCEEDED");
    expect(JSON.stringify(value.repository.listTranscript(value.detail.session.id))).not.toContain("LATE_DEADLINE_DELTA");
  });

  it("hard-stops a Provider permanently awaiting next and releases the Room for a new batch", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const value = harness(({ bots }) => ({
      async *run(_messages, _signal, context) {
        calls.push(context!.executorBotId);
        if (calls.length > 1) {
          yield { type: "started", requestId: "next-batch" } as ModelEvent;
          yield { type: "delta", text: "NEXT_BATCH_DONE" } as ModelEvent;
          yield { type: "completed", finishReason: "stop" } as ModelEvent;
          return;
        }
        yield { type: "started", requestId: "forever" } as ModelEvent;
        yield handoff(bots[1]!.id, "NEVER_DISPATCH_B");
        await new Promise<void>(() => {});
      },
      testConnection: async () => {},
    }), 3);
    const first = value.coordinator.sendCoordinated(
      command(value.detail, value.bots[0]!.id, "FOREVER_ROOT"),
      { deadlineMs: 5_000 },
    );
    for (let attempt = 0; attempt < 100 && value.repository.listHandoffs(first.batchId).length === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(value.repository.listHandoffs(first.batchId)).toHaveLength(1);
    expect(value.repository.listAgentTurns(first.batchId)[0]?.runtimeRunId).not.toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    for (let attempt = 0; attempt < 100 && value.repository.getRoomRun(first.batchId).state !== "partial"; attempt += 1) {
      await Promise.resolve();
    }
    expect(value.repository.getRoomRun(first.batchId).state).toBe("partial");

    const firstTurns = value.repository.listAgentTurns(first.batchId);
    const firstRuntime = value.repository.getRuntimeRun(firstTurns[0]!.runtimeRunId!);
    expect(firstRuntime).toMatchObject({ state: "failed", lastErrorCode: "MODEL_RUN_TIMEOUT" });
    expect(value.repository.getTranscriptEntry(firstRuntime.assistantEntryId!)).toMatchObject({ status: "failed" });
    expect(firstTurns.map((turn) => [turn.state, turn.outcome?.kind])).toEqual([
      ["failed", "timeout"],
      ["cancelled", "cancelled"],
    ]);
    expect(value.repository.listHandoffs(first.batchId)).toMatchObject([{ state: "cancelled" }]);
    expect(value.repository.getRoomRun(first.batchId)).toMatchObject({ state: "partial", windingDown: true });
    expect(value.repository.getActiveRuntimeRun(value.detail.session.id)).toBeNull();

    vi.useRealTimers();
    const second = value.coordinator.sendCoordinated(command(value.detail, value.bots[0]!.id, "NEXT_ROOT"));
    await waitForBatch(value.repository, second.batchId, ["completed"]);
    expect(calls).toEqual([value.bots[0]!.id, value.bots[0]!.id]);
  });

  it("keeps completed Room and Direct results when iterator return throws synchronously", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const value = harness(() => synchronousThrowingReturnProvider("completed"), 2);
      const room = value.coordinator.sendCoordinated(command(value.detail, value.bots[0]!.id));
      await waitForBatch(value.repository, room.batchId, ["completed"]);

      const directNonce = randomUUID();
      const directSession = value.repository.getMainSession(value.bots[1]!.id);
      value.repository.prepareMessage({ sessionId: directSession.id, clientNonce: directNonce, text: "DIRECT_ROOT" });
      value.repository.acknowledgeUserMessage(directNonce);
      const direct = value.executor.start({
        clientNonce: directNonce,
        executorBotId: value.bots[1]!.id,
        executionKey: directNonce,
      });
      const result = await direct.completion;
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(value.repository.getRoomRun(room.batchId).state).toBe("completed");
      expect(value.repository.listAgentTurns(room.batchId).map((turn) => turn.state)).toEqual(["completed"]);
      expect(result.run.state).toBe("completed");
      expect(value.repository.getRuntimeRun(direct.run.id).state).toBe("completed");
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("keeps timeout authority when pending iterator return throws synchronously", async () => {
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const value = harness(() => synchronousThrowingReturnProvider("pending"), 2);
      const sent = value.coordinator.sendCoordinated(
        command(value.detail, value.bots[0]!.id),
        { deadlineMs: 5_000 },
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const runtimeId = value.repository.listAgentTurns(sent.batchId)[0]?.runtimeRunId;
        if (runtimeId && value.repository.getRuntimeRun(runtimeId).state === "running") break;
        await Promise.resolve();
      }
      const started = value.repository.listAgentTurns(sent.batchId)[0]!;
      expect(started.runtimeRunId).not.toBeNull();
      expect(value.repository.getRuntimeRun(started.runtimeRunId!).state).toBe("running");
      await vi.advanceTimersByTimeAsync(5_000);
      for (let attempt = 0; attempt < 100 && value.repository.getRoomRun(sent.batchId).state !== "partial"; attempt += 1) {
        await Promise.resolve();
      }
      expect(value.repository.getRoomRun(sent.batchId).state).toBe("partial");
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const turn = value.repository.listAgentTurns(sent.batchId)[0]!;
      expect(value.repository.getRuntimeRun(turn.runtimeRunId!)).toMatchObject({
        state: "failed",
        lastErrorCode: "MODEL_RUN_TIMEOUT",
      });
      expect(turn).toMatchObject({ state: "failed", outcome: { kind: "timeout", errorCode: "MODEL_RUN_TIMEOUT" } });
      expect(value.repository.getRoomRun(sent.batchId)).toMatchObject({ state: "partial", windingDown: true });
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("preserves Coordinator-level deadline then cancel as partial timeout", async () => {
    vi.useFakeTimers();
    const value = harness(() => ({
      async *run() {
        yield { type: "started", requestId: "deadline-first" } as ModelEvent;
        await new Promise<void>(() => {});
      },
      testConnection: async () => {},
    }), 2);
    const sent = value.coordinator.sendCoordinated(
      command(value.detail, value.bots[0]!.id),
      { deadlineMs: 5_000 },
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runtimeId = value.repository.listAgentTurns(sent.batchId)[0]?.runtimeRunId;
      if (runtimeId && value.repository.getRuntimeRun(runtimeId).state === "running") break;
      await Promise.resolve();
    }
    const started = value.repository.listAgentTurns(sent.batchId)[0]!;
    expect(started.runtimeRunId).not.toBeNull();
    expect(value.repository.getRuntimeRun(started.runtimeRunId!).state).toBe("running");
    await vi.advanceTimersByTimeAsync(5_000);
    for (let attempt = 0; attempt < 100 && !value.repository.getRoomRun(sent.batchId).windingDown; attempt += 1) {
      await Promise.resolve();
    }
    expect(value.repository.getRoomRun(sent.batchId).windingDown).toBe(true);
    value.coordinator.cancel(sent.batchId);
    for (let attempt = 0; attempt < 100 && value.repository.getRoomRun(sent.batchId).state !== "partial"; attempt += 1) {
      await Promise.resolve();
    }
    expect(value.repository.getRoomRun(sent.batchId).state).toBe("partial");

    const turn = value.repository.listAgentTurns(sent.batchId)[0]!;
    expect(value.repository.getRoomRun(sent.batchId)).toMatchObject({ state: "partial", windingDown: true });
    expect(turn).toMatchObject({ state: "failed", outcome: { kind: "timeout", errorCode: "MODEL_RUN_TIMEOUT" } });
    vi.useRealTimers();
  });

  it("preserves Coordinator-level cancel then deadline as cancelled", async () => {
    const value = harness(() => ({
      async *run() {
        yield { type: "started", requestId: "user-first" } as ModelEvent;
        await new Promise<void>(() => {});
      },
      testConnection: async () => {},
    }), 2);
    const sent = value.coordinator.sendCoordinated(
      command(value.detail, value.bots[0]!.id),
      { deadlineMs: 60 },
    );
    await vi.waitFor(() => expect(value.repository.listAgentTurns(sent.batchId)[0]!.runtimeRunId).not.toBeNull());
    value.coordinator.cancel(sent.batchId);
    await new Promise((resolve) => setTimeout(resolve, 90));

    expect(value.repository.getRoomRun(sent.batchId)).toMatchObject({ state: "cancelled", windingDown: false });
    expect(value.repository.listAgentTurns(sent.batchId)[0]).toMatchObject({
      state: "cancelled",
      outcome: { kind: "cancelled", errorCode: "MESSAGE_CANCELLED" },
    });
  });

  it("settles a synchronous target start failure with no Provider call or dangling Runtime", async () => {
    const calls: string[] = [];
    const value = harness(({ bots }) => new ScriptedFakeModelProvider(({ context }) => {
      calls.push(context!.executorBotId);
      return [
        { type: "started", requestId: "a" },
        handoff(bots[1]!.id, "START_FAIL_B"),
        { type: "completed", finishReason: "stop" },
      ];
    }), 2);
    const originalAttach = value.repository.attachRoomTurnRuntime.bind(value.repository);
    let attachments = 0;
    value.repository.attachRoomTurnRuntime = (turnId, runtimeRunId) => {
      attachments += 1;
      if (attachments === 2) throw new AevorenBotError("INTERNAL_ERROR");
      return originalAttach(turnId, runtimeRunId);
    };
    const sent = value.coordinator.sendCoordinated(command(value.detail, value.bots[0]!.id));
    await waitForBatch(value.repository, sent.batchId, ["partial"]);

    expect(calls).toEqual([value.bots[0]!.id]);
    expect(value.repository.listHandoffs(sent.batchId)).toMatchObject([{ state: "failed" }]);
    const target = value.repository.listAgentTurns(sent.batchId)[1]!;
    expect(target).toMatchObject({ state: "failed", outcome: { kind: "error", errorCode: "INTERNAL_ERROR" } });
    const targetRuntime = value.repository.listRuntimeRuns(value.detail.session.id).find(
      (runtime) => runtime.executorBotId === value.bots[1]!.id,
    )!;
    expect(targetRuntime).toMatchObject({ state: "failed", lastErrorCode: "INTERNAL_ERROR" });
    expect(value.repository.getActiveRuntimeRun(value.detail.session.id)).toBeNull();
  });

  it("runs a dynamic A to B to C FIFO chain stably for 20 rounds", async () => {
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const calls: string[] = [];
      const value = harness(({ bots }) => new ScriptedFakeModelProvider(({ context }) => {
        const agentId = context!.executorBotId;
        calls.push(agentId);
        if (agentId === bots[0]!.id) {
          return [{ type: "started", requestId: "a" }, handoff(bots[1]!.id, "TO_B"), { type: "completed", finishReason: "stop" }];
        }
        if (agentId === bots[1]!.id) {
          return [{ type: "started", requestId: "b" }, handoff(bots[2]!.id, "TO_C"), { type: "completed", finishReason: "stop" }];
        }
        return completedSteps("C_DONE");
      }));
      const sent = value.coordinator.sendCoordinated(command(value.detail, value.bots[0]!.id));
      await waitForBatch(value.repository, sent.batchId, ["completed"]);
      expect(calls).toEqual(value.bots.map((bot) => bot.id));
      expect(value.repository.listAgentTurns(sent.batchId).map((turn) => turn.position)).toEqual([0, 1, 2]);
      value.repository.close();
      repositories.pop();
    }
  });

  it("deduplicates a replayed source Handoff after retry without calling the target twice", async () => {
    const calls: string[] = [];
    const provider = new ScriptedFakeModelProvider(({ callIndex, context }) => {
      calls.push(context!.executorBotId);
      const replay = handoff(value.bots[1]!.id, "REPLAYED_TASK", { toolCallId: "stable-replay-tool" });
      if (callIndex === 0) {
        return [
          { type: "started", requestId: "a-first" },
          replay,
          { type: "failure", error: new AevorenBotError("MODEL_STREAM_TRUNCATED") },
        ];
      }
      if (callIndex === 1) return completedSteps("B_ONCE");
      return [{ type: "started", requestId: "a-retry" }, replay, { type: "completed", finishReason: "stop" }];
    });
    const value = harness(() => provider, 2);
    const sent = value.coordinator.sendCoordinated(command(value.detail, value.bots[0]!.id));
    await waitForBatch(value.repository, sent.batchId, ["partial"]);
    const failedSource = value.repository.listAgentTurns(sent.batchId).find(
      (turn) => turn.agentId === value.bots[0]!.id && turn.state === "failed",
    )!;
    value.coordinator.retryTurn(failedSource.id);
    await waitForBatch(value.repository, sent.batchId, ["completed"]);

    expect(calls).toEqual([value.bots[0]!.id, value.bots[1]!.id, value.bots[0]!.id]);
    expect(value.repository.listHandoffs(sent.batchId)).toHaveLength(1);
    expect(value.repository.getRoomRun(sent.batchId).usedTurns).toBe(2);
    expect(value.repository.listAgentTurns(sent.batchId)).toHaveLength(3);
    expect(value.repository.listAgentTurns(sent.batchId).filter((turn) => turn.agentId === value.bots[1]!.id)).toHaveLength(1);
  });

  it("fails a Handoff emitted before started without creating any target", async () => {
    const value = harness(({ bots }) => new ScriptedFakeModelProvider(() => [
      handoff(bots[1]!.id, "BEFORE_STARTED"),
      { type: "started", requestId: "too-late" },
      { type: "completed", finishReason: "stop" },
    ]), 2);
    const sent = value.coordinator.sendCoordinated(command(value.detail, value.bots[0]!.id));
    await waitForBatch(value.repository, sent.batchId, ["partial"]);

    expect(value.repository.listHandoffs(sent.batchId)).toHaveLength(0);
    expect(value.repository.listAgentTurns(sent.batchId)).toMatchObject([
      { state: "failed", outcome: { kind: "error", errorCode: "RUNTIME_STATE_INVALID" } },
    ]);
  });

  it("fails a malformed structured Handoff closed while allowing the current Turn to finish", async () => {
    const malformed = {
      type: "handoff",
      toolCallId: "malformed",
      toAgentId: "not-used",
      task: "MALFORMED_TASK",
      contextRefs: null,
      visibility: "room",
    } as unknown as ModelEvent;
    const value = harness(() => new ScriptedFakeModelProvider(() => [
      { type: "started", requestId: "a" },
      malformed,
      { type: "delta", text: "A_STILL_DONE" },
      { type: "completed", finishReason: "stop" },
    ]), 2);
    const sent = value.coordinator.sendCoordinated(command(value.detail, value.bots[0]!.id));
    await waitForBatch(value.repository, sent.batchId, ["completed"]);

    expect(value.repository.listHandoffs(sent.batchId)).toHaveLength(0);
    expect(value.repository.listAgentTurns(sent.batchId)).toHaveLength(1);
    expect(errorCodes(value.roomEvents)).toContain("INVALID_REQUEST");
    expect(JSON.stringify(value.repository.listTranscript(value.detail.session.id))).not.toContain("MALFORMED_TASK");
  });

  it.each([
    ["deadline", "user", "failed", "timeout", "MODEL_RUN_TIMEOUT", "partial"],
    ["user", "deadline", "cancelled", "cancelled", "MESSAGE_CANCELLED", "cancelled"],
  ] as const)(
    "keeps the first %s cancellation reason when %s arrives immediately after",
    async (firstReason, secondReason, runtimeState, outcome, errorCode, batchState) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const value = harness(() => ({
        async *run() {
          yield { type: "started", requestId: "race" } as ModelEvent;
          await gate;
          yield { type: "delta", text: "LATE_RACE_DELTA" } as ModelEvent;
          yield { type: "completed", finishReason: "stop" } as ModelEvent;
        },
        testConnection: async () => {},
      }), 2);
      const sent = value.coordinator.sendCoordinated(command(value.detail, value.bots[0]!.id));
      await vi.waitFor(() => expect(value.repository.listAgentTurns(sent.batchId)[0]!.runtimeRunId).not.toBeNull());
      const turn = value.repository.listAgentTurns(sent.batchId)[0]!;
      const runtimeId = turn.runtimeRunId!;
      await vi.waitFor(() => expect(value.repository.getRuntimeRun(runtimeId).state).toBe("running"));
      value.executor.cancelRun(runtimeId, firstReason);
      value.executor.cancelRun(runtimeId, secondReason);
      release();
      await waitForBatch(value.repository, sent.batchId, [batchState]);

      expect(value.repository.getRuntimeRun(runtimeId)).toMatchObject({ state: runtimeState, lastErrorCode: errorCode });
      expect(value.repository.getRoomTurn(turn.id)).toMatchObject({
        state: runtimeState,
        outcome: { kind: outcome, errorCode },
      });
      expect(JSON.stringify(value.repository.listTranscript(value.detail.session.id))).not.toContain("LATE_RACE_DELTA");
    },
  );

  it.each(["queued", "dispatching", "accepted"] as const)(
    "recovers a %s Handoff without an automatic provider call and preserves only accepted",
    async (handoffState) => {
      const directory = mkdtempSync(join(tmpdir(), `aevoren-bot-m2-recovery-${handoffState}-`));
      temporaryDirectories.push(directory);
      const filename = join(directory, "app.sqlite");
      const initial = new AppRepository(filename);
      const bots = Array.from({ length: 2 }, () => initial.createBot().bot);
      const detail = initial.createRoom({ memberBotIds: bots.map((bot) => bot.id) });
      const input = command(detail, bots[0]!.id);
      const created = initial.createRoomRunWithInitialTurns({
        ...input,
        membershipVersion: detail.room.membershipVersion,
        maxTurns: 8,
        maxHops: 6,
        maxTargetsPerTurn: 2,
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        initialTurns: [{ agentId: bots[0]!.id, nonce: "initial" }],
      });
      initial.transitionRoomRun(created.run.id, "running");
      initial.transitionAgentTurn(created.turns[0]!.id, "running", { promptCutoffSeq: 1 });
      const createdHandoff = initial.createHandoff({
        runId: created.run.id,
        fromTurnId: created.turns[0]!.id,
        toAgentId: bots[1]!.id,
        task: "RECOVER_TASK",
        contextRefs: [],
        visibility: "room",
        targetTurnNonce: "target",
        inputGeneration: 1,
        inputSeq: 1,
      });
      if (handoffState !== "queued") {
        initial.transitionHandoff(createdHandoff.handoff.id, "dispatching");
        initial.transitionAgentTurn(createdHandoff.targetTurn.id, "running", { promptCutoffSeq: 1 });
      }
      if (handoffState === "accepted") initial.transitionHandoff(createdHandoff.handoff.id, "accepted");
      initial.close();

      const reopened = new AppRepository(filename);
      repositories.push(reopened);
      expect(reopened.recoverInterruptedRooms()).toBe(1);
      let providerCalls = 0;
      const provider = new ScriptedFakeModelProvider(() => {
        providerCalls += 1;
        return completedSteps("SHOULD_NOT_RUN");
      });
      const executor = new RuntimeExecutor(
        reopened,
        null,
        { transcript: vi.fn(), runtime: vi.fn() },
        false,
        provider,
      );
      new RoomCoordinator(reopened, executor, { roomRuntime: vi.fn(), transcript: vi.fn() });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(providerCalls).toBe(0);
      expect(reopened.getHandoff(createdHandoff.handoff.id).state).toBe(
        handoffState === "accepted" ? "accepted" : "cancelled",
      );
      expect(reopened.listAgentTurns(created.run.id).map((turn) => turn.state)).toEqual(["interrupted", "interrupted"]);
      expect(reopened.getRoomRun(created.run.id).state).toBe("interrupted");
    },
  );

  it("restores a bounded root without Handoffs and keeps explicit Continue coordinated", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-m2-root-continue-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    const initial = new AppRepository(filename);
    const bots = Array.from({ length: 2 }, () => initial.createBot().bot);
    const detail = initial.createRoom({ memberBotIds: bots.map((bot) => bot.id) });
    const input = command(detail, bots[0]!.id);
    const created = initial.createRoomRunWithInitialTurns({
      ...input,
      membershipVersion: detail.room.membershipVersion,
      maxTurns: 8,
      maxHops: 6,
      maxTargetsPerTurn: 2,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      initialTurns: [{ agentId: bots[0]!.id, nonce: "initial-a" }],
    });
    initial.transitionRoomRun(created.run.id, "running");
    initial.close();

    const reopened = new AppRepository(filename);
    repositories.push(reopened);
    expect(reopened.recoverInterruptedRooms()).toBe(1);
    const calls: string[] = [];
    const provider = new ScriptedFakeModelProvider(({ context }) => {
      calls.push(context!.executorBotId);
      return context!.executorBotId === bots[0]!.id
        ? [{ type: "started", requestId: "a" }, handoff(bots[1]!.id, "AFTER_REOPEN"), { type: "completed", finishReason: "stop" }]
        : completedSteps("B_DONE");
    });
    const executor = new RuntimeExecutor(
      reopened,
      null,
      { transcript: vi.fn(), runtime: vi.fn() },
      false,
      provider,
    );
    const coordinator = new RoomCoordinator(reopened, executor, { roomRuntime: vi.fn(), transcript: vi.fn() });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual([]);

    coordinator.continue(created.run.id);
    await waitForBatch(reopened, created.run.id, ["completed"]);

    expect(calls).toEqual([bots[0]!.id, bots[1]!.id]);
    expect(reopened.isCoordinatedRoomRun(created.run.id)).toBe(true);
    expect(reopened.listHandoffs(created.run.id)).toMatchObject([{ state: "accepted", task: "AFTER_REOPEN" }]);
    expect(new Set(reopened.listAgentTurns(created.run.id).map((turn) => turn.logicalTurnId)).size).toBe(2);
  });

  it("re-arms the persisted root deadline when an interrupted coordinated root is explicitly continued", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-m2-root-deadline-rearm-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    const initial = new AppRepository(filename);
    const bots = Array.from({ length: 2 }, () => initial.createBot().bot);
    const detail = initial.createRoom({ memberBotIds: bots.map((bot) => bot.id) });
    const input = command(detail, bots[0]!.id);
    const created = initial.createRoomRunWithInitialTurns({
      ...input,
      membershipVersion: detail.room.membershipVersion,
      maxTurns: 8,
      maxHops: 6,
      maxTargetsPerTurn: 2,
      deadlineAt: new Date(Date.now() + 250).toISOString(),
      initialTurns: [{ agentId: bots[0]!.id, nonce: "initial-a" }],
    });
    initial.transitionRoomRun(created.run.id, "running");
    initial.close();

    const reopened = new AppRepository(filename);
    repositories.push(reopened);
    reopened.recoverInterruptedRooms();
    const provider = new ScriptedFakeModelProvider(() => [
      { type: "started", requestId: "continued-a" },
      { type: "delay", milliseconds: 350, ignoreAbort: true },
      { type: "delta", text: "TOO_LATE" },
      { type: "completed", finishReason: "stop" },
    ]);
    const executor = new RuntimeExecutor(
      reopened,
      null,
      { transcript: vi.fn(), runtime: vi.fn() },
      false,
      provider,
    );
    const coordinator = new RoomCoordinator(reopened, executor, { roomRuntime: vi.fn(), transcript: vi.fn() });
    coordinator.continue(created.run.id);
    await waitForBatch(reopened, created.run.id, ["partial"]);

    const latest = reopened.listAgentTurns(created.run.id).at(-1)!;
    expect(reopened.getRoomRun(created.run.id)).toMatchObject({ state: "partial", windingDown: true });
    expect(latest).toMatchObject({ state: "failed", outcome: { kind: "timeout", errorCode: "MODEL_RUN_TIMEOUT" } });
    expect(reopened.getRuntimeRun(latest.runtimeRunId!)).toMatchObject({
      state: "failed",
      lastErrorCode: "MODEL_RUN_TIMEOUT",
    });
    expect(JSON.stringify(reopened.listTranscript(detail.session.id))).not.toContain("TOO_LATE");
  });

  it("continues one recovered queued Handoff target once without recreating its audit record", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-m2-handoff-continue-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    const initial = new AppRepository(filename);
    const bots = Array.from({ length: 2 }, () => initial.createBot().bot);
    const detail = initial.createRoom({ memberBotIds: bots.map((bot) => bot.id) });
    const input = command(detail, bots[0]!.id);
    const created = initial.createRoomRunWithInitialTurns({
      ...input,
      membershipVersion: detail.room.membershipVersion,
      maxTurns: 8,
      maxHops: 6,
      maxTargetsPerTurn: 2,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      initialTurns: [{ agentId: bots[0]!.id, nonce: "initial-a" }],
    });
    initial.transitionRoomRun(created.run.id, "running");
    initial.transitionAgentTurn(created.turns[0]!.id, "running", { promptCutoffSeq: 1 });
    const originalHandoff = initial.createHandoff({
      runId: created.run.id,
      fromTurnId: created.turns[0]!.id,
      toAgentId: bots[1]!.id,
      task: "RECOVERED_QUEUED_TASK",
      contextRefs: [created.run.triggerMessageId],
      visibility: "room",
      targetTurnNonce: "tool-recovered-queued",
      inputGeneration: 1,
      inputSeq: 1,
    });
    initial.transitionAgentTurn(created.turns[0]!.id, "completed", { outcome: { kind: "sent" } });
    initial.close();

    const reopened = new AppRepository(filename);
    repositories.push(reopened);
    expect(reopened.recoverInterruptedRooms()).toBe(1);
    expect(reopened.getHandoff(originalHandoff.handoff.id).state).toBe("cancelled");
    let calls = 0;
    let receivedTask = "";
    const provider = new ScriptedFakeModelProvider(({ context }) => {
      calls += 1;
      receivedTask = context?.incomingHandoff?.task ?? "";
      return completedSteps("RECOVERED_B_DONE");
    });
    const executor = new RuntimeExecutor(
      reopened,
      null,
      { transcript: vi.fn(), runtime: vi.fn() },
      false,
      provider,
    );
    const coordinator = new RoomCoordinator(reopened, executor, { roomRuntime: vi.fn(), transcript: vi.fn() });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(0);

    coordinator.continue(created.run.id);
    await waitForBatch(reopened, created.run.id, ["completed"]);

    expect(calls).toBe(1);
    expect(receivedTask).toBe("RECOVERED_QUEUED_TASK");
    expect(reopened.listHandoffs(created.run.id)).toHaveLength(1);
    expect(reopened.getHandoff(originalHandoff.handoff.id).state).toBe("cancelled");
    expect(reopened.getRoomRun(created.run.id).usedTurns).toBe(2);
    expect(reopened.listAgentTurns(created.run.id)).toHaveLength(3);
  });

  it.each(["dispatching", "accepted"] as const)(
    "retries one recovered %s Handoff target once without changing terminal delivery state",
    async (handoffState) => {
      const directory = mkdtempSync(join(tmpdir(), `aevoren-bot-m2-handoff-retry-${handoffState}-`));
      temporaryDirectories.push(directory);
      const filename = join(directory, "app.sqlite");
      const initial = new AppRepository(filename);
      const bots = Array.from({ length: 2 }, () => initial.createBot().bot);
      const detail = initial.createRoom({ memberBotIds: bots.map((bot) => bot.id) });
      const input = command(detail, bots[0]!.id);
      const created = initial.createRoomRunWithInitialTurns({
        ...input,
        membershipVersion: detail.room.membershipVersion,
        maxTurns: 8,
        maxHops: 6,
        maxTargetsPerTurn: 2,
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        initialTurns: [{ agentId: bots[0]!.id, nonce: "initial-a" }],
      });
      initial.transitionRoomRun(created.run.id, "running");
      initial.transitionAgentTurn(created.turns[0]!.id, "running", { promptCutoffSeq: 1 });
      const originalHandoff = initial.createHandoff({
        runId: created.run.id,
        fromTurnId: created.turns[0]!.id,
        toAgentId: bots[1]!.id,
        task: `RECOVERED_${handoffState.toUpperCase()}_TASK`,
        contextRefs: [],
        visibility: "room",
        targetTurnNonce: `tool-${handoffState}`,
        inputGeneration: 1,
        inputSeq: 1,
      });
      initial.transitionAgentTurn(created.turns[0]!.id, "completed", { outcome: { kind: "sent" } });
      initial.transitionHandoff(originalHandoff.handoff.id, "dispatching");
      if (handoffState === "accepted") initial.transitionHandoff(originalHandoff.handoff.id, "accepted");
      initial.transitionAgentTurn(originalHandoff.targetTurn.id, "running", { promptCutoffSeq: 1 });
      initial.close();

      const reopened = new AppRepository(filename);
      repositories.push(reopened);
      expect(reopened.recoverInterruptedRooms()).toBe(1);
      const recoveredDeliveryState = handoffState === "accepted" ? "accepted" : "cancelled";
      expect(reopened.getHandoff(originalHandoff.handoff.id).state).toBe(recoveredDeliveryState);
      let calls = 0;
      const provider = new ScriptedFakeModelProvider(() => {
        calls += 1;
        return completedSteps("RETRIED_B_DONE");
      });
      const executor = new RuntimeExecutor(
        reopened,
        null,
        { transcript: vi.fn(), runtime: vi.fn() },
        false,
        provider,
      );
      const coordinator = new RoomCoordinator(reopened, executor, { roomRuntime: vi.fn(), transcript: vi.fn() });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls).toBe(0);

      coordinator.retryTurn(originalHandoff.targetTurn.id);
      await waitForBatch(reopened, created.run.id, ["completed"]);

      expect(calls).toBe(1);
      expect(reopened.getHandoff(originalHandoff.handoff.id).state).toBe(recoveredDeliveryState);
      expect(reopened.listHandoffs(created.run.id)).toHaveLength(1);
      expect(reopened.getRoomRun(created.run.id).usedTurns).toBe(2);
    },
  );

  it("does not let a late provider result overwrite recovered terminal Runtime/Turn/Transcript state", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const value = harness(() => ({
      async *run() {
        yield { type: "started", requestId: "late" } as ModelEvent;
        yield { type: "delta", text: "PERSISTED_PARTIAL" } as ModelEvent;
        await gate;
        yield { type: "delta", text: "LATE_OVERWRITE" } as ModelEvent;
        yield { type: "completed", finishReason: "stop" } as ModelEvent;
      },
      testConnection: async () => {},
    }), 2);
    const sent = value.coordinator.sendCoordinated(command(value.detail, value.bots[0]!.id));
    await vi.waitFor(() => expect(value.repository.listTranscript(value.detail.session.id).at(-1)).toMatchObject({
      body: "PERSISTED_PARTIAL",
      status: "streaming",
    }));
    expect(value.repository.recoverInterruptedRooms()).toBe(1);
    expect(value.repository.recoverInterruptedRuntimeRuns()).toBe(1);
    const turnBefore = value.repository.listAgentTurns(sent.batchId)[0]!;
    const runBefore = value.repository.getRuntimeRun(turnBefore.runtimeRunId!);
    const transcriptBefore = value.repository.getTranscriptEntry(runBefore.assistantEntryId!);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(value.repository.getRoomRun(sent.batchId).state).toBe("interrupted");
    expect(value.repository.getRoomTurn(turnBefore.id)).toMatchObject({ state: "interrupted" });
    expect(value.repository.getRuntimeRun(runBefore.id)).toMatchObject({ state: "interrupted" });
    expect(value.repository.getTranscriptEntry(transcriptBefore.id)).toMatchObject({
      body: "PERSISTED_PARTIAL",
      status: "failed",
    });
  });

  it("fails a turn on a second provider started event without duplicating the assistant entry", async () => {
    const value = harness(() => new ScriptedFakeModelProvider(() => [
      { type: "started", requestId: "first" },
      { type: "started", requestId: "second" },
      { type: "delta", text: "SHOULD_NOT_PERSIST" },
      { type: "completed", finishReason: "stop" },
    ]), 2);
    const sent = value.coordinator.sendCoordinated(command(value.detail, value.bots[0]!.id));
    await waitForBatch(value.repository, sent.batchId, ["partial"]);

    expect(value.repository.listAgentTurns(sent.batchId)[0]).toMatchObject({ state: "failed" });
    expect(value.repository.listTranscript(value.detail.session.id).filter((entry) => entry.role === "assistant")).toHaveLength(1);
    expect(JSON.stringify(value.repository.listTranscript(value.detail.session.id))).not.toContain("SHOULD_NOT_PERSIST");
  });
});
