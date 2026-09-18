import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ModelEvent, ModelProvider } from "./model";
import { AppRepository } from "./database";
import { AevorenBotError } from "./errors";
import { RoomCoordinator } from "./room-coordinator";
import { RuntimeExecutor } from "./runtime-executor";
import { RuntimeCoordinator } from "./send-worker";
import type { ProviderResolver } from "./providers/contracts";

const repositories: AppRepository[] = [];

afterEach(() => {
  while (repositories.length > 0) repositories.pop()?.close();
});

function setup(provider: ModelProvider, memberCount = 3) {
  const repository = new AppRepository(":memory:");
  repositories.push(repository);
  const bots = Array.from({ length: memberCount }, (_, index) => {
    const created = repository.createBot();
    const bot = repository.updateBot(created.bot.id, created.bot.version, {
      name: `Member ${index + 1}`,
      instructions: `identity-${index + 1}`,
    });
    return { ...created, bot };
  });
  const detail = repository.createRoom({ memberBotIds: bots.map(({ bot }) => bot.id), name: "Test Room" });
  const transcriptEvents = vi.fn();
  const executor = new RuntimeExecutor(
    repository,
    null,
    { transcript: transcriptEvents, runtime: vi.fn() },
    false,
    provider,
  );
  const roomEvents = vi.fn();
  const coordinator = new RoomCoordinator(repository, executor, { roomRuntime: roomEvents, transcript: vi.fn() });
  return { repository, bots, detail, executor, coordinator, roomEvents, transcriptEvents };
}

function command(detail: ReturnType<AppRepository["createRoom"]>, targetBotIds: string[]) {
  return {
    roomId: detail.room.id,
    sessionId: detail.session.id,
    clientNonce: crypto.randomUUID(),
    text: "共同分析",
    targetBotIds,
  };
}

describe("RoomCoordinator", () => {
  it("injects each Room executor's own Memory without leaking peer Memory", async () => {
    const captured: ChatMessage[][] = [];
    const provider: ModelProvider = {
      async *run(messages) {
        captured.push(messages);
        yield { type: "started", requestId: `memory-room-${captured.length}` };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const { repository, bots, detail, coordinator } = setup(provider, 2);
    repository.createMemory(bots[0]!.bot.id, "ROOM_MEMORY_A");
    repository.createMemory(bots[1]!.bot.id, "ROOM_MEMORY_B");

    const sent = coordinator.send(command(detail, bots.map(({ bot }) => bot.id)));
    await vi.waitFor(() => expect(repository.getRoomBatch(sent.batchId).state).toBe("completed"));
    expect(JSON.stringify(captured[0])).toContain("ROOM_MEMORY_A");
    expect(JSON.stringify(captured[0])).not.toContain("ROOM_MEMORY_B");
    expect(JSON.stringify(captured[1])).toContain("ROOM_MEMORY_B");
    expect(JSON.stringify(captured[1])).not.toContain("ROOM_MEMORY_A");
    expect(repository.listRuntimeRuns(detail.session.id).every((run) => run.promptManifest.schemaVersion === 3)).toBe(true);
  });

  it("deduplicates the same command and rejects a changed command before another provider call", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async *run() {
        calls += 1;
        yield { type: "started", requestId: "one" };
        yield { type: "delta", text: "done" };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const { repository, bots, detail, coordinator } = setup(provider, 2);
    const input = command(detail, bots.map(({ bot }) => bot.id));
    const first = coordinator.send(input);
    expect(coordinator.send(input)).toMatchObject({ disposition: "duplicate", batchId: first.batchId });
    expect(() => coordinator.send({ ...input, text: "changed" })).toThrowError(
      expect.objectContaining({ code: "MESSAGE_NONCE_CONFLICT" }),
    );
    await vi.waitFor(() => expect(repository.getRoomBatch(first.batchId).state).toBe("completed"));
    expect(calls).toBe(2);
    expect(repository.listTranscript(detail.session.id).filter((entry) => entry.role === "user")).toHaveLength(1);
  });

  it("runs three members in roster order 20 out of 20 times", async () => {
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const calls: string[] = [];
      const provider: ModelProvider = {
        async *run(messages) {
          calls.push(messages[0]!.content);
          yield { type: "started", requestId: crypto.randomUUID() };
          yield { type: "delta", text: `reply-${calls.length}` };
          yield { type: "completed", finishReason: "stop" };
        },
        testConnection: async () => {},
      };
      const { repository, bots, detail, coordinator } = setup(provider);
      const sent = coordinator.send(command(detail, bots.toReversed().map(({ bot }) => bot.id)));
      await vi.waitFor(() => expect(repository.getRoomBatch(sent.batchId).state).toBe("completed"));
      expect(calls).toEqual(["identity-1", "identity-2", "identity-3"]);
      repository.close();
      repositories.pop();
    }
  });

  it("includes an attributed first reply in the second member prompt and persists speaker identity", async () => {
    const captured: ChatMessage[][] = [];
    const provider: ModelProvider = {
      async *run(messages) {
        captured.push(messages);
        yield { type: "started", requestId: `request-${captured.length}` };
        yield { type: "delta", text: captured.length === 1 ? "first answer" : "second answer" };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const { repository, bots, detail, coordinator } = setup(provider, 2);
    const sent = coordinator.send(command(detail, bots.map(({ bot }) => bot.id)));
    await vi.waitFor(() => expect(repository.getRoomBatch(sent.batchId).state).toBe("completed"));

    expect(captured[1]!.some((message) =>
      message.content === `[room-speaker id="${bots[0]!.bot.id}" name="Member 1"]\nfirst answer`,
    )).toBe(true);
    const assistants = repository.listTranscript(detail.session.id).filter((entry) => entry.role === "assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants.map((entry) => [entry.speakerBotId, entry.speakerNameSnapshot, Boolean(entry.sourceTurnId)])).toEqual([
      [bots[0]!.bot.id, "Member 1", true],
      [bots[1]!.bot.id, "Member 2", true],
    ]);
    const secondRun = repository.listRuntimeRuns(detail.session.id)[1]!;
    expect(secondRun.promptManifest).toMatchObject({
      schemaVersion: 2,
      roomId: detail.room.id,
      executorBotId: bots[1]!.bot.id,
      roomMembershipVersion: 1,
    });
    expect(JSON.stringify(secondRun.promptManifest)).not.toContain("first answer");
  });

  it("removes a leaked attribution envelope before persistence and subsequent Room prompts", async () => {
    const captured: ChatMessage[][] = [];
    let leakedMarker = "";
    const provider: ModelProvider = {
      async *run(messages) {
        captured.push(messages);
        yield { type: "started", requestId: `request-${captured.length}` };
        const reply = captured.length === 1 ? `intro\n${leakedMarker} first answer\n[/room-speaker]` : "second answer";
        yield { type: "delta", text: reply.slice(0, 18) };
        yield { type: "delta", text: reply.slice(18) };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const { repository, bots, detail, coordinator, transcriptEvents } = setup(provider, 2);
    leakedMarker = `[room-speaker id="${bots[1]!.bot.id}" name="Member 2"]`;
    const sent = coordinator.send(command(detail, bots.map(({ bot }) => bot.id)));
    await vi.waitFor(() => expect(repository.getRoomBatch(sent.batchId).state).toBe("completed"));

    const assistants = repository.listTranscript(detail.session.id).filter((entry) => entry.role === "assistant");
    expect(assistants.map((entry) => entry.body)).toEqual(["intro\nfirst answer", "second answer"]);
    expect(JSON.stringify(transcriptEvents.mock.calls)).not.toContain("room-speaker");
    expect(captured[1]!.some((message) => message.content === leakedMarker)).toBe(false);
    expect(captured[1]!.some((message) =>
      message.content === `[room-speaker id="${bots[0]!.bot.id}" name="Member 1"]\nintro\nfirst answer`,
    )).toBe(true);
  });

  it("continues after a middle member failure and marks the batch partial", async () => {
    const calls: string[] = [];
    const provider: ModelProvider = {
      async *run(messages) {
        const identity = messages[0]!.content;
        calls.push(identity);
        yield { type: "started", requestId: identity };
        if (identity === "identity-2") throw new AevorenBotError("MODEL_STREAM_TRUNCATED");
        yield { type: "delta", text: identity };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const { repository, bots, detail, coordinator } = setup(provider);
    const sent = coordinator.send(command(detail, bots.map(({ bot }) => bot.id)));
    await vi.waitFor(() => expect(repository.getRoomBatch(sent.batchId).state).toBe("partial"));
    expect(calls).toEqual(["identity-1", "identity-2", "identity-3"]);
    expect(repository.listRoomTurns(sent.batchId).map((turn) => turn.state)).toEqual(["completed", "failed", "completed"]);
    expect(repository.listTranscript(detail.session.id).filter((entry) => entry.status === "completed")).toHaveLength(3);
  });

  it("cancels one active run exactly once and cancels every queued turn", async () => {
    let aborts = 0;
    const provider: ModelProvider = {
      async *run(_messages, signal): AsyncIterable<ModelEvent> {
        signal.addEventListener("abort", () => {
          aborts += 1;
        }, { once: true });
        yield { type: "started", requestId: "cancel" };
        yield { type: "delta", text: "partial" };
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
      },
      testConnection: async () => {},
    };
    const { repository, bots, detail, coordinator } = setup(provider);
    const sent = coordinator.send(command(detail, bots.map(({ bot }) => bot.id)));
    await vi.waitFor(() => expect(repository.listTranscript(detail.session.id).at(-1)).toMatchObject({ body: "partial", status: "streaming" }));
    coordinator.cancel(sent.batchId);
    coordinator.cancel(sent.batchId);
    coordinator.cancel(sent.batchId);
    await vi.waitFor(() => expect(repository.listRoomTurns(sent.batchId)[0]?.state).toBe("cancelled"));
    expect(aborts).toBe(1);
    expect(repository.listRoomTurns(sent.batchId).map((turn) => turn.state)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(repository.listTranscript(detail.session.id).at(-1)).toMatchObject({ body: "partial", status: "cancelled" });
  });

  it("rejects generic message and runtime cancellation for a Room-owned run", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async *run(_messages, signal) {
        calls += 1;
        yield { type: "started", requestId: "room-only" };
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      },
      testConnection: async () => {},
    };
    const { repository, bots, detail, executor, coordinator } = setup(provider, 2);
    const sent = coordinator.send(command(detail, bots.map(({ bot }) => bot.id)));
    await vi.waitFor(() => expect(repository.listRoomTurns(sent.batchId)[0]?.runtimeRunId).not.toBeNull());
    const runId = repository.listRoomTurns(sent.batchId)[0]!.runtimeRunId!;
    const direct = new RuntimeCoordinator(
      repository,
      null,
      { transcript: vi.fn(), runtime: vi.fn(), sendState: vi.fn() },
      false,
      undefined,
      executor,
    );
    expect(() => direct.cancel(sent.clientNonce)).toThrowError(expect.objectContaining({ code: "RUNTIME_CONTROL_SCOPE_INVALID" }));
    expect(() => direct.cancelRun(runId)).toThrowError(expect.objectContaining({ code: "RUNTIME_CONTROL_SCOPE_INVALID" }));
    expect(calls).toBe(1);
    coordinator.cancel(sent.batchId);
  });

  it("retries only one failed member with the original cutoff and no duplicate user", async () => {
    let memberTwoCalls = 0;
    const provider: ModelProvider = {
      async *run(messages) {
        const identity = messages[0]!.content;
        yield { type: "started", requestId: crypto.randomUUID() };
        if (identity === "identity-2" && memberTwoCalls++ === 0) throw new AevorenBotError("MODEL_STREAM_TRUNCATED");
        yield { type: "delta", text: `${identity}-ok` };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const { repository, bots, detail, coordinator } = setup(provider, 2);
    const sent = coordinator.send(command(detail, bots.map(({ bot }) => bot.id)));
    await vi.waitFor(() => expect(repository.getRoomBatch(sent.batchId).state).toBe("partial"));
    const failed = repository.listRoomTurns(sent.batchId).find((turn) => turn.state === "failed")!;
    const retried = coordinator.retryTurn(failed.id);
    await vi.waitFor(() => expect(repository.getRoomTurn(retried.id).state).toBe("completed"));
    expect(repository.getRoomTurn(retried.id).promptCutoffSeq).toBe(failed.promptCutoffSeq);
    expect(repository.getRoomBatch(sent.batchId).state).toBe("completed");
    expect(repository.listTranscript(detail.session.id).filter((entry) => entry.role === "user")).toHaveLength(1);
    expect(repository.listRoomTurns(sent.batchId).filter((turn) => turn.memberBotId === failed.memberBotId)).toHaveLength(2);
    expect(repository.listRuntimeRuns(detail.session.id).filter((run) => run.executorBotId === failed.memberBotId).map((run) => run.attemptNo)).toEqual([1, 2]);
  });

  it("keeps a Room turn retry on the original Provider and model snapshot", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const firstCreated = repository.createBot();
    const firstBot = repository.updateBot(firstCreated.bot.id, firstCreated.bot.version, {
      name: "Snapshot member",
      modelSelection: { providerInstanceId: "openai-compatible.default", modelId: "room-model-a" },
    });
    const secondCreated = repository.createBot();
    const detail = repository.createRoom({
      name: "Snapshot room",
      memberBotIds: [firstBot.id, secondCreated.bot.id],
    });
    const selections: Array<{ providerInstanceId: string; modelId: string }> = [];
    let originalCalls = 0;
    const resolver: ProviderResolver = {
      getRoute: (selection) => selection.providerInstanceId === "codex.default" ? "codex-cli" : "openai-compatible",
      getCapabilities: () => ({ roomOwnerSelection: false, handoff: false, workspaceTools: false }),
      createProvider: (selection) => {
        selections.push(selection);
        return {
          async *run() {
            yield { type: "started", requestId: `room-snapshot-${selections.length}` };
            if (selection.providerInstanceId === "openai-compatible.default" && originalCalls++ === 0) {
              throw new AevorenBotError("MODEL_STREAM_TRUNCATED");
            }
            yield { type: "delta", text: selection.modelId };
            yield { type: "completed", finishReason: "stop" };
          },
          testConnection: async () => {},
        };
      },
    };
    const executor = new RuntimeExecutor(repository, resolver, { transcript: vi.fn(), runtime: vi.fn() });
    const coordinator = new RoomCoordinator(repository, executor, { roomRuntime: vi.fn(), transcript: vi.fn() });
    const sent = coordinator.send(command(detail, [firstBot.id]));
    await vi.waitFor(() => expect(repository.getRoomBatch(sent.batchId).state).toBe("partial"));
    const failed = repository.listRoomTurns(sent.batchId)[0]!;
    const latestBot = repository.getBot(firstBot.id);
    repository.updateBot(latestBot.id, latestBot.version, {
      modelSelection: { providerInstanceId: "codex.default", modelId: "room-model-b" },
    });

    const retry = coordinator.retryTurn(failed.id);
    await vi.waitFor(() => expect(repository.getRoomTurn(retry.id).state).toBe("completed"));

    expect(selections).toEqual([
      { providerInstanceId: "openai-compatible.default", modelId: "room-model-a" },
      { providerInstanceId: "openai-compatible.default", modelId: "room-model-a" },
    ]);
    expect(repository.getRuntimeRun(repository.getRoomTurn(retry.id).runtimeRunId!)).toMatchObject({
      providerInstanceId: "openai-compatible.default",
      providerModelId: "room-model-a",
    });
  });

  it("refuses to append a retry from an older Room batch after a newer user message", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async *run() {
        calls += 1;
        yield* [];
        throw new AevorenBotError("MODEL_CONNECTION_FAILED");
      },
      testConnection: async () => {},
    };
    const { repository, bots, detail, coordinator } = setup(provider, 2);
    const first = coordinator.send(command(detail, [bots[0]!.bot.id]));
    await vi.waitFor(() => expect(repository.getRoomBatch(first.batchId).state).toBe("partial"));
    const oldTurn = repository.listRoomTurns(first.batchId)[0]!;
    const second = coordinator.send(command(detail, [bots[0]!.bot.id]));
    await vi.waitFor(() => expect(repository.getRoomBatch(second.batchId).state).toBe("partial"));
    expect(() => coordinator.retryTurn(oldTurn.id)).toThrowError(
      expect.objectContaining({ code: "ROOM_TURN_RETRY_UNSAFE" }),
    );
    expect(calls).toBe(2);
  });

  it("recovers running and queued turns as interrupted without starting another provider call", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async *run(_messages, signal) {
        calls += 1;
        yield { type: "started", requestId: "running" };
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      },
      testConnection: async () => {},
    };
    const { repository, bots, detail, executor, coordinator } = setup(provider);
    const sent = coordinator.send(command(detail, bots.map(({ bot }) => bot.id)));
    await vi.waitFor(() => expect(repository.listRoomTurns(sent.batchId)[0]?.state).toBe("running"));
    coordinator.beginShutdown();
    await executor.shutdown();
    await coordinator.shutdown();
    expect(repository.getRoomBatch(sent.batchId).state).toBe("interrupted");
    expect(repository.listRoomTurns(sent.batchId).map((turn) => turn.state)).toEqual(["interrupted", "interrupted", "interrupted"]);
    expect(calls).toBe(1);

    let resumedCalls = 0;
    const resumedProvider: ModelProvider = {
      async *run() {
        resumedCalls += 1;
        yield { type: "started", requestId: `resumed-${resumedCalls}` };
        yield { type: "delta", text: "resumed" };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const resumedExecutor = new RuntimeExecutor(
      repository,
      null,
      { transcript: vi.fn(), runtime: vi.fn() },
      false,
      resumedProvider,
    );
    const resumed = new RoomCoordinator(repository, resumedExecutor, { roomRuntime: vi.fn(), transcript: vi.fn() });
    repository.archiveRoom(detail.room.id, true);
    expect(() => resumed.continue(sent.batchId)).toThrowError(expect.objectContaining({ code: "ROOM_ARCHIVED" }));
    expect(resumedCalls).toBe(0);
    repository.archiveRoom(detail.room.id, false);
    resumed.continue(sent.batchId);
    await vi.waitFor(() => expect(repository.getRoomBatch(sent.batchId).state).toBe("partial"));
    expect(resumedCalls).toBe(2);
    const interruptedActive = repository.listRoomTurns(sent.batchId).find(
      (turn) => turn.state === "interrupted" && turn.promptCutoffSeq !== null,
    )!;
    resumed.retryTurn(interruptedActive.id);
    await vi.waitFor(() => expect(repository.getRoomBatch(sent.batchId).state).toBe("completed"));
    expect(resumedCalls).toBe(3);
  });

  it("bounds shutdown even when a Provider ignores Abort forever", async () => {
    let waitingForever = false;
    const provider: ModelProvider = {
      async *run() {
        yield { type: "started", requestId: "never" };
        waitingForever = true;
        await new Promise<void>(() => {});
      },
      testConnection: async () => {},
    };
    const { repository, bots, detail, executor, coordinator } = setup(provider, 2);
    const sent = coordinator.send(command(detail, bots.map(({ bot }) => bot.id)));
    await vi.waitFor(() => expect(waitingForever).toBe(true));
    const startedAt = Date.now();
    coordinator.beginShutdown();
    await executor.shutdown();
    await coordinator.shutdown();
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(repository.getRoomBatch(sent.batchId).state).toBe("interrupted");
    expect(repository.listRoomTurns(sent.batchId).map((turn) => turn.state)).toEqual(["interrupted", "interrupted"]);
    expect(repository.getRuntimeRun(repository.listRoomTurns(sent.batchId)[0]!.runtimeRunId!).state).toBe("interrupted");
  }, 8_000);

  it("preserves an explicit Room cancel while shutting down an Abort-ignoring Provider", async () => {
    let waitingForever = false;
    const provider: ModelProvider = {
      async *run() {
        yield { type: "started", requestId: "cancel-forever" };
        yield { type: "delta", text: "partial" };
        waitingForever = true;
        await new Promise<void>(() => {});
      },
      testConnection: async () => {},
    };
    const { repository, bots, detail, executor, coordinator } = setup(provider, 2);
    const sent = coordinator.send(command(detail, bots.map(({ bot }) => bot.id)));
    await vi.waitFor(() => expect(waitingForever).toBe(true));
    coordinator.cancel(sent.batchId);
    coordinator.beginShutdown();
    await executor.shutdown();
    await coordinator.shutdown();

    const turns = repository.listRoomTurns(sent.batchId);
    const run = repository.getRuntimeRun(turns[0]!.runtimeRunId!);
    expect(repository.getRoomBatch(sent.batchId).state).toBe("cancelled");
    expect(turns.map((turn) => turn.state)).toEqual(["cancelled", "cancelled"]);
    expect(run.state).toBe("cancelled");
    expect(repository.getTranscriptEntry(run.assistantEntryId!)).toMatchObject({ body: "partial", status: "cancelled" });
  }, 10_000);
});
