import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRepository } from "./database";
import { AevorenBotError } from "./errors";
import type { ChatMessage, ModelEvent, ModelProvider } from "./model";
import type { ProviderResolver } from "./providers/contracts";
import { RuntimeCoordinator } from "./send-worker";

const repositories: AppRepository[] = [];
afterEach(() => {
  while (repositories.length > 0) repositories.pop()?.close();
});

class TestProvider implements ModelProvider {
  constructor(private readonly output: readonly string[] = ["A", "B"]) {}

  async *run(_messages: ChatMessage[], _signal: AbortSignal): AsyncIterable<ModelEvent> {
    yield { type: "started", requestId: "test-request" };
    for (const text of this.output) yield { type: "delta", text };
    yield { type: "completed", finishReason: "stop" };
  }

  async testConnection(_signal: AbortSignal): Promise<void> {}
}

function createWorker(provider: ModelProvider = new TestProvider()): {
  repository: AppRepository;
  worker: RuntimeCoordinator;
  runtimeEvents: ReturnType<typeof vi.fn>;
  sendStateEvents: ReturnType<typeof vi.fn>;
} {
  const repository = new AppRepository(":memory:");
  repositories.push(repository);
  const runtimeEvents = vi.fn();
  const sendStateEvents = vi.fn();
  const worker = new RuntimeCoordinator(
    repository,
    null,
    { transcript: vi.fn(), sendState: sendStateEvents, runtime: runtimeEvents },
    false,
    provider,
  );
  return { repository, worker, runtimeEvents, sendStateEvents };
}

describe("RuntimeCoordinator", () => {
  it("injects only the executor Bot active Memory into a Direct run", async () => {
    const captured: ChatMessage[][] = [];
    const provider: ModelProvider = {
      async *run(messages) {
        captured.push(messages);
        yield { type: "started", requestId: "memory-direct" };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const { repository, worker } = createWorker(provider);
    const first = repository.createBot();
    const second = repository.createBot();
    repository.createMemory(first.bot.id, "DIRECT_MEMORY_A");
    repository.createMemory(second.bot.id, "DIRECT_MEMORY_B");
    const deleted = repository.createMemory(first.bot.id, "DELETED_MEMORY");
    repository.deleteMemory(deleted.id, deleted.version);

    const sent = worker.send({ sessionId: first.session.id, clientNonce: crypto.randomUUID(), text: "当前问题" });
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("completed"));
    const serialized = JSON.stringify(captured);
    expect(serialized).toContain("DIRECT_MEMORY_A");
    expect(serialized).not.toContain("DIRECT_MEMORY_B");
    expect(serialized).not.toContain("DELETED_MEMORY");
    expect(repository.getRuntimeRun(sent.runId).promptManifest).toMatchObject({ schemaVersion: 3 });
    expect(JSON.stringify(repository.getRuntimeRun(sent.runId).promptManifest)).not.toContain("DIRECT_MEMORY_A");
  });

  it("persists Direct dispatching before the Provider request starts", async () => {
    const dispatchContext: { repository?: AppRepository; nonce: string } = { nonce: "" };
    let journalStateAtDispatch: string | undefined;
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const provider: ModelProvider = {
      async *run() {
        journalStateAtDispatch = dispatchContext.repository?.getSendOrThrow(dispatchContext.nonce).state;
        await providerGate;
        yield { type: "started", requestId: "dispatch-gate" };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const { repository, worker, sendStateEvents } = createWorker(provider);
    dispatchContext.repository = repository;
    const { session } = repository.createBot();
    dispatchContext.nonce = crypto.randomUUID();

    const sent = worker.send({ sessionId: session.id, clientNonce: dispatchContext.nonce, text: "dispatch boundary" });
    await vi.waitFor(() => expect(journalStateAtDispatch).toBe("dispatching"));
    expect(repository.getSendOrThrow(dispatchContext.nonce).state).toBe("dispatching");
    expect(repository.getUserMessage(dispatchContext.nonce).status).toBe("pending");
    expect(sendStateEvents.mock.calls.map(([event]) => event.state)).toEqual(["queued", "dispatching"]);

    releaseProvider();
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("completed"));
    expect(repository.getSendOrThrow(dispatchContext.nonce).state).toBe("acked");
  });

  it("persists one completed run and one assistant for one logical message", async () => {
    const { repository, worker } = createWorker();
    const { session } = repository.createBot();
    const command = { sessionId: session.id, clientNonce: crypto.randomUUID(), text: "分析这个需求" };

    const sent = worker.send(command);
    expect(sent).toMatchObject({ disposition: "accepted", runId: expect.any(String) });
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("completed"));

    const transcript = repository.listTranscript(session.id);
    expect(transcript[0]).toMatchObject({ role: "user", status: "completed", sendState: "acked" });
    expect(transcript[1]).toMatchObject({ role: "assistant", body: "AB", status: "completed" });
    expect(repository.getRuntimeRun(sent.runId)).toMatchObject({
      state: "completed",
      providerRequestId: "test-request",
      attemptNo: 1,
      assistantEntryId: transcript[1]?.id,
    });
    expect(worker.send(command)).toMatchObject({ disposition: "duplicate", runId: sent.runId });
    expect(repository.listTranscript(session.id)).toHaveLength(2);
    expect(() => worker.retryRun(sent.runId)).toThrowError(expect.objectContaining({ code: "RUNTIME_RETRY_UNSAFE" }));
    expect(worker.cancelRun(sent.runId).state).toBe("completed");
    expect(() => worker.cancel(sent.clientNonce)).toThrowError(expect.objectContaining({ code: "MESSAGE_NOT_RUNNING" }));
  });

  it("keeps a known pre-acceptance failure safely retryable", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async *run() {
        calls += 1;
        if (calls === 1) {
          yield* [];
          throw new AevorenBotError("MODEL_NOT_CONFIGURED");
        }
        yield { type: "started", requestId: "retried" };
        yield { type: "delta", text: "ok" };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const { repository, worker } = createWorker(provider);
    const { session } = repository.createBot();
    const nonce = crypto.randomUUID();

    worker.send({ sessionId: session.id, clientNonce: nonce, text: "test" });
    await vi.waitFor(() => expect(repository.getSendOrThrow(nonce).state).toBe("failed-before-acceptance"));
    expect(repository.getUserMessage(nonce).status).toBe("failed");
    expect(repository.getLatestRuntimeRun(nonce)?.state).toBe("failed");
    const retried = worker.retry(nonce);
    await vi.waitFor(() => expect(repository.getRuntimeRun(retried.runId).state).toBe("completed"));
    expect(repository.getSendOrThrow(nonce).attemptCount).toBe(1);
    expect(repository.listTranscript(session.id).filter((entry) => entry.role === "user")).toHaveLength(1);
  });

  it("marks a transport failure before acceptance as unknown and never retries automatically", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async *run() {
        calls += 1;
        yield* [];
        throw new AevorenBotError("MODEL_TRANSPORT_ERROR");
      },
      testConnection: async () => {},
    };
    const { repository, worker } = createWorker(provider);
    const { session } = repository.createBot();
    const nonce = crypto.randomUUID();
    worker.send({ sessionId: session.id, clientNonce: nonce, text: "unknown" });
    await vi.waitFor(() => expect(repository.getSendOrThrow(nonce).state).toBe("interrupted-unknown"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(1);
    const run = repository.getLatestRuntimeRun(nonce);
    expect(run).not.toBeNull();
    expect(() => worker.retryRun(run!.id)).toThrowError(expect.objectContaining({ code: "RUNTIME_RETRY_UNSAFE" }));
    expect(calls).toBe(1);
  });

  it("cancels an accepted stream idempotently without appending later chunks", async () => {
    let aborts = 0;
    const provider: ModelProvider = {
      async *run(_messages, signal) {
        yield { type: "started", requestId: "cancel-test" };
        yield { type: "delta", text: "first" };
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborts += 1;
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
        yield { type: "delta", text: "never" };
      },
      testConnection: async () => {},
    };
    const { repository, worker } = createWorker(provider);
    const { session } = repository.createBot();
    const sent = worker.send({ sessionId: session.id, clientNonce: crypto.randomUUID(), text: "cancel" });
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("streaming"));
    worker.cancelRun(sent.runId);
    worker.cancelRun(sent.runId);
    worker.cancelRun(sent.runId);
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("cancelled"));
    expect(repository.listTranscript(session.id)[1]).toMatchObject({ body: "first", status: "cancelled" });
    expect(aborts).toBe(1);
  });

  it("regenerates only the latest acked failed run without duplicating the user entry", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async *run() {
        calls += 1;
        yield { type: "started", requestId: `request-${calls}` };
        if (calls === 1) throw new AevorenBotError("MODEL_STREAM_TRUNCATED");
        yield { type: "delta", text: "recovered" };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const { repository, worker } = createWorker(provider);
    const { session } = repository.createBot();
    const first = worker.send({ sessionId: session.id, clientNonce: crypto.randomUUID(), text: "retry" });
    await vi.waitFor(() => expect(repository.getRuntimeRun(first.runId).state).toBe("failed"));
    const second = worker.retryRun(first.runId);
    expect(second.state).toBe("acked");
    await vi.waitFor(() => expect(repository.getRuntimeRun(second.runId).state).toBe("completed"));

    expect(repository.listTranscript(session.id).filter((entry) => entry.role === "user")).toHaveLength(1);
    expect(repository.listRuntimeRuns(session.id).map((run) => run.attemptNo)).toEqual([1, 2]);
    expect(repository.listTranscript(session.id).at(-1)).toMatchObject({ body: "recovered", status: "completed" });
    expect(repository.getSendOrThrow(first.clientNonce).providerRequestId).toBe("request-1");
  });

  it("keeps the original Provider and model snapshot when a failed run is retried", async () => {
    const selections: Array<{ providerInstanceId: string; modelId: string }> = [];
    let originalCalls = 0;
    const resolver: ProviderResolver = {
      getRoute: (selection) => selection.providerInstanceId === "codex.default" ? "codex-cli" : "openai-compatible",
      getCapabilities: () => ({ roomOwnerSelection: false, handoff: false, workspaceTools: false }),
      createProvider: (selection) => {
        selections.push(selection);
        return {
          async *run() {
            yield { type: "started", requestId: `snapshot-${selections.length}` };
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
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const worker = new RuntimeCoordinator(
      repository,
      resolver,
      { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() },
    );
    const created = repository.createBot();
    const original = repository.updateBot(created.bot.id, created.bot.version, {
      modelSelection: { providerInstanceId: "openai-compatible.default", modelId: "model-a" },
    });
    const first = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: "retry snapshot" });
    await vi.waitFor(() => expect(repository.getRuntimeRun(first.runId).state).toBe("failed"));
    repository.updateBot(original.id, original.version, {
      modelSelection: { providerInstanceId: "codex.default", modelId: "model-b" },
    });

    const retried = worker.retryRun(first.runId);
    await vi.waitFor(() => expect(repository.getRuntimeRun(retried.runId).state).toBe("completed"));

    expect(selections).toEqual([
      { providerInstanceId: "openai-compatible.default", modelId: "model-a" },
      { providerInstanceId: "openai-compatible.default", modelId: "model-a" },
    ]);
    expect(repository.getRuntimeRun(retried.runId)).toMatchObject({
      providerInstanceId: "openai-compatible.default",
      providerModelId: "model-a",
    });
    expect(repository.listTranscript(created.session.id).at(-1)).toMatchObject({ body: "model-a", status: "completed" });
  });

  it("rejects a second active send before adding another user entry", async () => {
    const provider: ModelProvider = {
      async *run(_messages, signal) {
        yield { type: "started", requestId: "busy" };
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      },
      testConnection: async () => {},
    };
    const { repository, worker } = createWorker(provider);
    const { session } = repository.createBot();
    const first = worker.send({ sessionId: session.id, clientNonce: crypto.randomUUID(), text: "first" });
    await vi.waitFor(() => expect(repository.getRuntimeRun(first.runId).state).toBe("running"));
    expect(() => worker.send({ sessionId: session.id, clientNonce: crypto.randomUUID(), text: "second" })).toThrowError(
      expect.objectContaining({ code: "SESSION_BUSY" }),
    );
    expect(repository.listTranscript(session.id).filter((entry) => entry.role === "user")).toHaveLength(1);
    worker.cancelRun(first.runId);
  });

  it("refuses to regenerate a failed run after a newer user message exists", async () => {
    const provider: ModelProvider = {
      async *run() {
        yield { type: "started", requestId: crypto.randomUUID() };
        throw new AevorenBotError("MODEL_STREAM_TRUNCATED");
      },
      testConnection: async () => {},
    };
    const { repository, worker } = createWorker(provider);
    const { session } = repository.createBot();
    const first = worker.send({ sessionId: session.id, clientNonce: crypto.randomUUID(), text: "first" });
    await vi.waitFor(() => expect(repository.getRuntimeRun(first.runId).state).toBe("failed"));
    const second = worker.send({ sessionId: session.id, clientNonce: crypto.randomUUID(), text: "second" });
    await vi.waitFor(() => expect(repository.getRuntimeRun(second.runId).state).toBe("failed"));
    expect(() => worker.retryRun(first.runId)).toThrowError(expect.objectContaining({ code: "RUNTIME_RETRY_UNSAFE" }));
    expect(repository.listRuntimeRuns(session.id)).toHaveLength(2);
  });

  it("coalesces 2,000 single-character deltas into one exact assistant entry", async () => {
    const provider: ModelProvider = {
      async *run() {
        yield { type: "started", requestId: "many-deltas" };
        for (let index = 0; index < 2_000; index += 1) yield { type: "delta", text: "x" };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const { repository, worker } = createWorker(provider);
    const { session } = repository.createBot();
    const sent = worker.send({ sessionId: session.id, clientNonce: crypto.randomUUID(), text: "large" });
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("completed"));
    const assistant = repository.listTranscript(session.id).find((entry) => entry.role === "assistant");
    expect(assistant).toMatchObject({ body: "x".repeat(2_000), status: "completed" });
    expect(repository.getTranscriptCursor(session.id)).toBeLessThanOrEqual(8);
  });

  it("shuts down an active run as interrupted and preserves partial text", async () => {
    const provider: ModelProvider = {
      async *run(_messages, signal) {
        yield { type: "started", requestId: "shutdown" };
        yield { type: "delta", text: "partial" };
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      },
      testConnection: async () => {},
    };
    const { repository, worker } = createWorker(provider);
    const { session } = repository.createBot();
    const sent = worker.send({ sessionId: session.id, clientNonce: crypto.randomUUID(), text: "shutdown" });
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("streaming"));
    await worker.shutdown();
    expect(repository.getRuntimeRun(sent.runId).state).toBe("interrupted");
    expect(repository.listTranscript(session.id)[1]).toMatchObject({ body: "partial", status: "failed" });
  });
});
