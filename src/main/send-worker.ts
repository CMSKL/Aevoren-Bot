import type { SendCommand, SendResult, SendStateEvent, TranscriptEvent } from "@shared/contracts";
import { asAppError, MsBotError } from "./errors";
import type { AppRepository } from "./database";
import type { ModelSettingsService } from "./settings";
import { FakeModelProvider, OpenAiCompatibleProvider, type ChatMessage, type ModelProvider } from "./model";

type WorkerEvents = {
  transcript: (event: TranscriptEvent) => void;
  sendState: (event: SendStateEvent) => void;
};

type ActiveSend = {
  controller: AbortController;
  assistantEntryId?: string;
};

export class SendWorker {
  private readonly active = new Map<string, ActiveSend>();
  private readonly activeSessions = new Set<string>();

  constructor(
    private readonly repository: AppRepository,
    private readonly settings: ModelSettingsService,
    private readonly events: WorkerEvents,
    private readonly forceFakeProvider = false,
    private readonly providerOverride?: ModelProvider,
  ) {}

  send(command: SendCommand): SendResult {
    const prepared = this.repository.prepareMessage(command);
    if (prepared.disposition === "duplicate") {
      return { clientNonce: command.clientNonce, disposition: "duplicate", state: prepared.journal.state };
    }
    this.events.transcript({
      sessionId: command.sessionId,
      entry: this.repository.getUserMessage(command.clientNonce),
    });
    this.repository.setSendState(command.clientNonce, "queued");
    this.emitState(command.sessionId, command.clientNonce, "queued");
    void this.dispatch(command.clientNonce);
    return { clientNonce: command.clientNonce, disposition: "accepted", state: "queued" };
  }

  retry(clientNonce: string): SendResult {
    const journal = this.repository.queueRetry(clientNonce);
    this.emitState(journal.sessionId, clientNonce, "queued");
    void this.dispatch(clientNonce);
    return { clientNonce, disposition: "accepted", state: "queued" };
  }

  cancel(clientNonce: string): void {
    const active = this.active.get(clientNonce);
    if (!active) throw new MsBotError("MESSAGE_NOT_RUNNING", "这条消息当前没有正在运行的请求。");
    active.controller.abort();
  }

  private async dispatch(clientNonce: string): Promise<void> {
    const journal = this.repository.getSendOrThrow(clientNonce);
    if (this.activeSessions.has(journal.sessionId)) {
      this.repository.setSendState(clientNonce, "failed-before-acceptance", "SESSION_BUSY");
      const entry = this.repository.setUserMessageStatus(clientNonce, "failed");
      this.events.transcript({ sessionId: journal.sessionId, entry });
      this.emitState(journal.sessionId, clientNonce, "failed-before-acceptance", {
        code: "SESSION_BUSY",
        retryable: true,
        safeMessage: "该 Bot 正在回复，请稍后重试。",
      });
      return;
    }

    const active: ActiveSend = { controller: new AbortController() };
    this.active.set(clientNonce, active);
    this.activeSessions.add(journal.sessionId);
    let accepted = false;
    try {
      this.repository.setSendState(clientNonce, "dispatching");
      this.emitState(journal.sessionId, clientNonce, "dispatching");

      const provider = this.createProvider();
      const messages = this.buildPrompt(journal.sessionId);
      const stream = await provider.start(messages, active.controller.signal);
      accepted = true;
      this.repository.setSendState(clientNonce, "accepted-awaiting-echo");
      this.emitState(journal.sessionId, clientNonce, "accepted-awaiting-echo");

      const userEntry = this.repository.acknowledgeUserMessage(clientNonce);
      this.events.transcript({ sessionId: journal.sessionId, entry: userEntry });
      this.emitState(journal.sessionId, clientNonce, "acked");

      let assistant = this.repository.createAssistantEntry(journal.sessionId);
      active.assistantEntryId = assistant.id;
      this.events.transcript({ sessionId: journal.sessionId, entry: assistant });
      let body = "";
      for await (const chunk of stream.chunks) {
        if (active.controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
        body += chunk;
        assistant = this.repository.updateTranscriptEntry(assistant.id, body, "streaming");
        this.events.transcript({ sessionId: journal.sessionId, entry: assistant });
      }
      assistant = this.repository.updateTranscriptEntry(assistant.id, body, "completed");
      this.events.transcript({ sessionId: journal.sessionId, entry: assistant });
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === "AbortError";
      const appError = aborted
        ? { code: "MESSAGE_CANCELLED", retryable: false, safeMessage: "已停止本次回复。" }
        : asAppError(error);
      if (active.assistantEntryId) {
        const assistant = this.repository.getTranscriptEntry(active.assistantEntryId);
        const updated = this.repository.updateTranscriptEntry(
          assistant.id,
          assistant.body,
          aborted ? "cancelled" : "failed",
        );
        this.events.transcript({ sessionId: journal.sessionId, entry: updated });
      } else {
        const state = accepted ? "interrupted-unknown" : aborted ? "cancelled" : "failed-before-acceptance";
        this.repository.setSendState(clientNonce, state, appError.code);
        const userEntry = this.repository.setUserMessageStatus(clientNonce, aborted ? "cancelled" : "failed");
        this.events.transcript({ sessionId: journal.sessionId, entry: userEntry });
        this.emitState(journal.sessionId, clientNonce, state, appError);
      }
    } finally {
      this.active.delete(clientNonce);
      this.activeSessions.delete(journal.sessionId);
    }
  }

  private buildPrompt(sessionId: string): ChatMessage[] {
    const bot = this.repository.getBotForSession(sessionId);
    const transcript = this.repository.listPromptEntries(sessionId);
    return [
      { role: "system", content: bot.instructions },
      ...transcript.map((entry) => ({ role: entry.role, content: entry.body })),
    ];
  }

  private createProvider(): ModelProvider {
    if (this.providerOverride) return this.providerOverride;
    if (this.forceFakeProvider) return new FakeModelProvider();
    const configuration = this.settings.getConfiguration();
    if (!configuration.modelId || !configuration.apiKeyConfigured) {
      throw new MsBotError("MODEL_NOT_CONFIGURED", "请先完成模型设置。", false);
    }
    return new OpenAiCompatibleProvider(
      configuration.baseUrl,
      configuration.modelId,
      this.settings.getApiKey(),
    );
  }

  private emitState(
    sessionId: string,
    clientNonce: string,
    state: SendStateEvent["state"],
    error?: SendStateEvent["error"],
  ): void {
    this.events.sendState({ sessionId, clientNonce, state, ...(error ? { error } : {}) });
  }
}
