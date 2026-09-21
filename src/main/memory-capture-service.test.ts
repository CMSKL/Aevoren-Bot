import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRepository } from "./database";
import { MemoryCaptureService } from "./memory-capture-service";
import type { ChatMessage, ModelEvent, ModelProvider } from "./model";
import type { ProviderResolver } from "./providers/contracts";
import { RuntimeCoordinator } from "./send-worker";

const repositories: AppRepository[] = [];

afterEach(() => {
  while (repositories.length > 0) repositories.pop()?.close();
});

class CaptureProvider implements ModelProvider {
  constructor(private readonly response: string) {}

  async *run(_messages: ChatMessage[], _signal: AbortSignal): AsyncIterable<ModelEvent> {
    yield { type: "started", requestId: "memory-capture" };
    yield { type: "delta", text: this.response };
    yield { type: "completed", finishReason: "stop" };
  }

  async testConnection(_signal: AbortSignal): Promise<void> {}
}

const unusedResolver: ProviderResolver = {
  createProvider: () => { throw new Error("not used"); },
  getRoute: () => "fake",
  getCapabilities: () => ({ roomOwnerSelection: false, handoff: false, workspaceTools: false, networkTools: false }),
};

function fixture(response: object): {
  repository: AppRepository;
  service: MemoryCaptureService;
  botId: string;
  entryId: string;
  text: string;
} {
  const repository = new AppRepository(":memory:");
  repositories.push(repository);
  const { bot, session } = repository.createBot();
  const text = "以后所有回答请先给结论，再补充依据。";
  const nonce = crypto.randomUUID();
  repository.prepareMessage({ sessionId: session.id, clientNonce: nonce, text });
  const entryId = repository.getUserMessage(nonce).id;
  return {
    repository,
    service: new MemoryCaptureService(repository, unusedResolver, new CaptureProvider(JSON.stringify(response))),
    botId: bot.id,
    entryId,
    text,
  };
}

describe("MemoryCaptureService", () => {
  it("does not call the Provider when background capture is disabled", async () => {
    const value = fixture({ candidates: [{
      scope: "bot", scopeKey: "unused", kind: "fact", content: "unused", reason: "unused",
    }] });
    value.repository.setSetting("memory.capture.enabled", "false", false);
    value.service.enqueue({ botId: value.botId, sourceEntryId: value.entryId, userText: value.text });
    await value.service.flush();
    expect(value.repository.listMemoryProposals()).toEqual([]);
  });

  it("runs after a completed reply without changing the reply or run state", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const created = repository.createBot();
    const capture = new MemoryCaptureService(repository, unusedResolver, new CaptureProvider(JSON.stringify({
      candidates: [{
        scope: "bot",
        scopeKey: created.bot.id,
        kind: "preference",
        content: "用户偏好先看到结论。",
        reason: "用户明确表达了稳定的回答偏好。",
      }],
    })));
    const reply = new CaptureProvider("正式回复");
    const worker = new RuntimeCoordinator(
      repository,
      null,
      { transcript: () => {}, sendState: () => {}, runtime: () => {} },
      false,
      reply,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      capture,
    );

    const sent = worker.send({
      sessionId: created.session.id,
      clientNonce: crypto.randomUUID(),
      text: "以后请先给结论。",
    });
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("completed"));
    await capture.flush();

    expect(repository.getRuntimeRun(sent.runId)).toMatchObject({ state: "completed" });
    expect(repository.listTranscript(created.session.id).at(-1)).toMatchObject({ role: "assistant", body: "正式回复", status: "completed" });
    expect(repository.listMemoryProposals({ state: "pending" })).toHaveLength(1);
  });

  it("creates a reviewable candidate without activating it, then accepts an edited version", async () => {
    const value = fixture({
      candidates: [{
        scope: "user",
        scopeKey: "user",
        kind: "preference",
        content: "用户偏好回答先给结论，再补充依据。",
        reason: "用户明确表达了跨 Bot 的长期回答偏好。",
        supersedesMemoryId: null,
        expiresAt: null,
      }],
    });

    await value.service.capture({ botId: value.botId, sourceEntryId: value.entryId, userText: value.text });

    const [proposal] = value.repository.listMemoryProposals({ state: "pending" });
    expect(proposal).toMatchObject({ scope: "user", kind: "preference", state: "pending", sourceEntryId: value.entryId });
    expect(value.repository.listRuntimeMemories(value.botId)).toEqual([]);

    const accepted = value.repository.acceptMemoryProposal(proposal!.id, proposal!.version, {
      content: "用户偏好先看结论，再看简短依据。",
    });
    expect(accepted.proposal.state).toBe("accepted");
    expect(accepted.memory).toMatchObject({ source: "model-captured", kind: "preference", sourceEntryId: value.entryId });
    expect(value.repository.listRuntimeMemories(value.botId).map((item) => item.content))
      .toEqual(["用户偏好先看结论，再看简短依据。"]);
  });

  it("rejects candidates without changing active Memory and ignores secret-like output", async () => {
    const rejected = fixture({
      candidates: [{
        scope: "bot", scopeKey: "will-be-replaced", kind: "fact", content: "safe", reason: "test",
      }],
    });
    const response = {
      candidates: [{
        scope: "bot",
        scopeKey: rejected.botId,
        kind: "fact",
        content: "API_KEY=sk-super-secret-value-123456789",
        reason: "must not persist",
      }],
    };
    const service = new MemoryCaptureService(rejected.repository, unusedResolver, new CaptureProvider(JSON.stringify(response)));
    await service.capture({ botId: rejected.botId, sourceEntryId: rejected.entryId, userText: rejected.text });
    expect(rejected.repository.listMemoryProposals()).toEqual([]);

    const normal = fixture({ candidates: [{
      scope: "bot", scopeKey: "placeholder", kind: "fact", content: "placeholder", reason: "placeholder",
    }] });
    const direct = normal.repository.createMemoryProposal({
      botId: normal.botId,
      scope: "bot",
      scopeKey: normal.botId,
      kind: "fact",
      content: "用户的工作日从周一开始。",
      reason: "稳定事实",
      sourceEntryId: normal.entryId,
    });
    expect(direct).not.toBeNull();
    const declined = normal.repository.rejectMemoryProposal(direct!.id, direct!.version);
    expect(declined.state).toBe("rejected");
    expect(normal.repository.listRuntimeMemories(normal.botId)).toEqual([]);
  });

  it("applies a correction atomically and excludes expired Memory", () => {
    const value = fixture({ candidates: [] });
    const old = value.repository.createMemory(value.botId, "办公室在上海。", { kind: "fact" });
    const proposal = value.repository.createMemoryProposal({
      botId: value.botId,
      scope: "bot",
      scopeKey: value.botId,
      kind: "fact",
      content: "办公室已经迁到杭州。",
      reason: "用户明确更正办公地点。",
      sourceEntryId: value.entryId,
      supersedesMemoryId: old.id,
    });
    value.repository.acceptMemoryProposal(proposal!.id, proposal!.version);
    expect(value.repository.getMemory(old.id).deletedAt).not.toBeNull();
    expect(value.repository.listRuntimeMemories(value.botId).map((item) => item.content)).toEqual(["办公室已经迁到杭州。"]);

    value.repository.createMemory(value.botId, "已经过期的临时安排", { expiresAt: "2020-01-01T00:00:00.000Z" });
    expect(value.repository.listRuntimeMemories(value.botId).map((item) => item.content)).toEqual(["办公室已经迁到杭州。"]);
  });
});
