import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRepository } from "./database";
import type { ChatMessage, ModelProvider, ModelStream } from "./model";
import { SendWorker } from "./send-worker";
import { ModelSettingsService, type SecretCodec } from "./settings";

const repositories: AppRepository[] = [];
const codec: SecretCodec = {
  isAvailable: () => true,
  encrypt: (value) => value,
  decrypt: (value) => value,
};

afterEach(() => {
  while (repositories.length > 0) repositories.pop()?.close();
});

class TestProvider implements ModelProvider {
  constructor(private readonly output: string[] = ["A", "B"]) {}

  async start(_messages: ChatMessage[], _signal: AbortSignal): Promise<ModelStream> {
    const output = this.output;
    return {
      requestId: "test-request",
      chunks: (async function* () {
        for (const chunk of output) yield chunk;
      })(),
    };
  }

  async testConnection(_signal: AbortSignal): Promise<void> {}
}

function createWorker(provider: ModelProvider = new TestProvider()): {
  repository: AppRepository;
  worker: SendWorker;
} {
  const repository = new AppRepository(":memory:");
  repositories.push(repository);
  const settings = new ModelSettingsService(repository, codec);
  const worker = new SendWorker(
    repository,
    settings,
    { transcript: vi.fn(), sendState: vi.fn() },
    false,
    provider,
  );
  return { repository, worker };
}

describe("SendWorker", () => {
  it("streams into one assistant entry and acknowledges one logical user message", async () => {
    const { repository, worker } = createWorker();
    const { session } = repository.createBot();
    const command = { sessionId: session.id, clientNonce: crypto.randomUUID(), text: "分析这个需求" };

    expect(worker.send(command).disposition).toBe("accepted");
    await vi.waitFor(() => expect(repository.listTranscript(session.id)).toHaveLength(2));
    await vi.waitFor(() => expect(repository.listTranscript(session.id)[1]?.status).toBe("completed"));

    const transcript = repository.listTranscript(session.id);
    expect(transcript[0]).toMatchObject({ role: "user", status: "completed", sendState: "acked" });
    expect(transcript[1]).toMatchObject({ role: "assistant", body: "AB", status: "completed" });
    expect(worker.send(command).disposition).toBe("duplicate");
    expect(repository.listTranscript(session.id)).toHaveLength(2);
  });

  it("marks a provider start failure as safely retryable before acceptance", async () => {
    const provider: ModelProvider = {
      start: async () => {
        throw new Error("network details must not escape");
      },
      testConnection: async () => {},
    };
    const { repository, worker } = createWorker(provider);
    const { session } = repository.createBot();
    const nonce = crypto.randomUUID();

    worker.send({ sessionId: session.id, clientNonce: nonce, text: "test" });
    await vi.waitFor(() => expect(repository.getSendOrThrow(nonce).state).toBe("failed-before-acceptance"));
    expect(repository.getUserMessage(nonce).status).toBe("failed");
  });

  it("cancels an accepted stream without appending later chunks", async () => {
    const provider: ModelProvider = {
      async start(_messages, signal) {
        return {
          requestId: "cancel-test",
          chunks: (async function* () {
            yield "first";
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
            });
            yield "never";
          })(),
        };
      },
      testConnection: async () => {},
    };
    const { repository, worker } = createWorker(provider);
    const { session } = repository.createBot();
    const nonce = crypto.randomUUID();
    worker.send({ sessionId: session.id, clientNonce: nonce, text: "cancel" });
    await vi.waitFor(() => expect(repository.listTranscript(session.id)[1]?.body).toBe("first"));
    worker.cancel(nonce);
    await vi.waitFor(() => expect(repository.listTranscript(session.id)[1]?.status).toBe("cancelled"));
    expect(repository.listTranscript(session.id)[1]?.body).toBe("first");
  });
});
