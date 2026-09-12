import type {
  AppError,
  RuntimeEvent,
  RuntimeRun,
  SendCommand,
  SendResult,
  SendState,
  SendStateEvent,
  SessionRuntimeSnapshot,
  TranscriptEvent,
} from "@shared/contracts";
import { asAppError, MsBotError } from "./errors";
import type { AppRepository } from "./database";
import type { ModelProvider } from "./model";
import { RuntimeExecutor, type RuntimeExecutionResult } from "./runtime-executor";
import type { ModelSettingsService } from "./settings";

export type WorkerEvents = {
  transcript: (event: TranscriptEvent) => void;
  sendState: (event: SendStateEvent) => void;
  runtime: (event: RuntimeEvent) => void;
};

export class RuntimeCoordinator {
  readonly executor: RuntimeExecutor;
  private shuttingDown = false;

  constructor(
    private readonly repository: AppRepository,
    settings: ModelSettingsService,
    private readonly events: WorkerEvents,
    forceFakeProvider = false,
    providerOverride?: ModelProvider,
    executorOverride?: RuntimeExecutor,
  ) {
    this.executor = executorOverride ?? new RuntimeExecutor(
      repository,
      settings,
      { transcript: events.transcript, runtime: events.runtime },
      forceFakeProvider,
      providerOverride,
    );
  }

  send(command: SendCommand): SendResult {
    if (this.shuttingDown) throw new MsBotError("APP_INTERRUPTED");
    const session = this.repository.getSession(command.sessionId);
    if (!session.botId || session.roomId) throw new MsBotError("SESSION_NOT_FOUND");
    const prepared = this.repository.prepareMessage(command);
    if (prepared.disposition === "duplicate") {
      const existingRun = this.repository.getLatestRuntimeRun(command.clientNonce);
      if (!existingRun) throw new MsBotError("RUNTIME_NOT_FOUND");
      return {
        clientNonce: command.clientNonce,
        runId: existingRun.id,
        disposition: "duplicate",
        state: prepared.journal.state,
      };
    }
    this.events.transcript({ sessionId: command.sessionId, entry: this.repository.getUserMessage(command.clientNonce) });
    this.repository.setSendState(command.clientNonce, "queued");
    this.emitSendState(command.sessionId, command.clientNonce, "queued");
    return this.startDirect(command.clientNonce);
  }

  retry(clientNonce: string): SendResult {
    if (this.shuttingDown) throw new MsBotError("APP_INTERRUPTED");
    const journal = this.repository.queueRetry(clientNonce);
    const session = this.repository.getSession(journal.sessionId);
    if (!session.botId || session.roomId) throw new MsBotError("MESSAGE_RETRY_UNSAFE");
    this.emitSendState(journal.sessionId, clientNonce, "queued");
    return this.startDirect(clientNonce);
  }

  retryRun(runId: string): SendResult {
    if (this.shuttingDown) throw new MsBotError("APP_INTERRUPTED");
    const previous = this.repository.assertRuntimeRetryEligible(runId);
    const session = this.repository.getSession(previous.sessionId);
    if (!session.botId || session.roomId) {
      throw new MsBotError("RUNTIME_RETRY_UNSAFE", undefined, undefined, { reason: "room-run" });
    }
    const result = this.startDirect(previous.clientNonce, previous.inputSeq);
    return { ...result, state: this.repository.getSendOrThrow(previous.clientNonce).state };
  }

  cancel(clientNonce: string): void {
    const journal = this.repository.getSendOrThrow(clientNonce);
    const session = this.repository.getSession(journal.sessionId);
    if (!session.botId || session.roomId) throw new MsBotError("RUNTIME_CONTROL_SCOPE_INVALID");
    const run = this.repository.getLatestRuntimeRun(clientNonce);
    if (!run || ["completed", "failed", "cancelled", "interrupted"].includes(run.state)) {
      throw new MsBotError("MESSAGE_NOT_RUNNING");
    }
    this.cancelRun(run.id);
  }

  cancelRun(runId: string): RuntimeRun {
    const run = this.repository.getRuntimeRun(runId);
    const session = this.repository.getSession(run.sessionId);
    if (!session.botId || session.roomId) throw new MsBotError("RUNTIME_CONTROL_SCOPE_INVALID");
    return this.executor.cancelRun(runId);
  }

  getSessionSnapshot(sessionId: string): SessionRuntimeSnapshot {
    const session = this.repository.getSession(sessionId);
    return {
      sessionId,
      generation: session.generation,
      transcriptCursor: this.repository.getTranscriptCursor(sessionId),
      entries: this.repository.listTranscript(sessionId),
      runs: this.repository.listRuntimeRuns(sessionId),
      liveState: this.executor.getLiveState(sessionId),
    };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.executor.shutdown();
  }

  private startDirect(clientNonce: string, inputSeq?: number): SendResult {
    const journal = this.repository.getSendOrThrow(clientNonce);
    const session = this.repository.getSession(journal.sessionId);
    if (!session.botId) throw new MsBotError("SESSION_NOT_FOUND");
    let started: ReturnType<RuntimeExecutor["start"]>;
    try {
      started = this.executor.start({
        clientNonce,
        executorBotId: session.botId,
        executionKey: clientNonce,
        inputSeq,
        onDispatchStart: () => this.markDirectDispatching(clientNonce),
        onProviderStarted: (requestId) => this.acknowledgeDirect(clientNonce, requestId),
      });
    } catch (error) {
      this.failBeforeRun(clientNonce, error);
    }
    void started.completion.then((result) => this.settleDirect(clientNonce, result));
    return { clientNonce, runId: started.run.id, disposition: "accepted", state: "queued" };
  }

  private markDirectDispatching(clientNonce: string): void {
    const journal = this.repository.getSendOrThrow(clientNonce);
    if (journal.state === "acked" || journal.state === "dispatching") return;
    this.repository.setSendState(clientNonce, "dispatching");
    this.emitSendState(journal.sessionId, clientNonce, "dispatching");
  }

  private acknowledgeDirect(clientNonce: string, requestId: string): void {
    const journal = this.repository.getSendOrThrow(clientNonce);
    if (journal.state === "acked") return;
    this.repository.setSendProviderRequestId(clientNonce, requestId);
    this.repository.setSendState(clientNonce, "accepted-awaiting-echo");
    this.emitSendState(journal.sessionId, clientNonce, "accepted-awaiting-echo");
    const user = this.repository.acknowledgeUserMessage(clientNonce);
    this.events.transcript({ sessionId: journal.sessionId, entry: user });
    this.emitSendState(journal.sessionId, clientNonce, "acked");
  }

  private settleDirect(clientNonce: string, result: RuntimeExecutionResult): void {
    if (!result.error) return;
    const journal = this.repository.getSendOrThrow(clientNonce);
    if (journal.state === "acked") return;
    const targetState = result.run.state;
    const sendState: SendState = targetState === "cancelled"
      ? "cancelled"
      : result.error.code === "MODEL_REQUEST_REFUSED" && !result.error.retryable
        ? "refused"
        : targetState === "interrupted"
          ? "interrupted-unknown"
          : "failed-before-acceptance";
    this.repository.setSendState(clientNonce, sendState, result.error.code);
    const user = this.repository.setUserMessageStatus(clientNonce, targetState === "cancelled" ? "cancelled" : "failed");
    this.events.transcript({ sessionId: journal.sessionId, entry: user });
    this.emitSendState(journal.sessionId, clientNonce, sendState, result.error);
  }

  private failBeforeRun(clientNonce: string, error: unknown): never {
    const appError = asAppError(error);
    const journal = this.repository.setSendState(clientNonce, "failed-before-acceptance", appError.code);
    const user = this.repository.setUserMessageStatus(clientNonce, "failed");
    this.events.transcript({ sessionId: journal.sessionId, entry: user });
    this.emitSendState(journal.sessionId, clientNonce, "failed-before-acceptance", appError);
    throw error;
  }

  private emitSendState(sessionId: string, clientNonce: string, state: SendState, error?: AppError): void {
    this.events.sendState({ sessionId, clientNonce, state, ...(error ? { error } : {}) });
  }
}

export { RuntimeCoordinator as SendWorker };
