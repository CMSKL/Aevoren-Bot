import type {
  AppError,
  RuntimeEvent,
  RuntimeRoute,
  RuntimeRun,
  SendCommand,
  SendResult,
  SendState,
  SendStateEvent,
  SessionLiveState,
  SessionRuntimeSnapshot,
  TranscriptEvent,
  TranscriptStatus,
} from "@shared/contracts";
import { asAppError, MsBotError } from "./errors";
import type { AppRepository } from "./database";
import type { ModelSettingsService } from "./settings";
import { FakeModelProvider, OpenAiCompatibleProvider, type ChatMessage, type ModelProvider } from "./model";
import { buildPrompt } from "./prompt";

type WorkerEvents = {
  transcript: (event: TranscriptEvent) => void;
  sendState: (event: SendStateEvent) => void;
  runtime: (event: RuntimeEvent) => void;
};

type AbortReason = "user" | "app-shutdown";

type ActiveRun = {
  controller: AbortController;
  runId: string;
  clientNonce: string;
  sessionId: string;
  messages: ChatMessage[];
  body: string;
  persistedBody: string;
  assistantEntryId: string | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
  staleTimer: ReturnType<typeof setTimeout> | null;
  abortReason: AbortReason | null;
};

const STALE_AFTER_MS = 30_000;
const DELTA_FLUSH_MS = 50;
const DELTA_FLUSH_CHARS = 512;
const SHUTDOWN_DRAIN_MS = 2_000;

export class RuntimeCoordinator {
  private readonly active = new Map<string, ActiveRun>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private shuttingDown = false;

  constructor(
    private readonly repository: AppRepository,
    private readonly settings: ModelSettingsService,
    private readonly events: WorkerEvents,
    private readonly forceFakeProvider = false,
    private readonly providerOverride?: ModelProvider,
  ) {}

  send(command: SendCommand): SendResult {
    if (this.shuttingDown) throw new MsBotError("APP_INTERRUPTED");
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
    let run: RuntimeRun;
    try {
      run = this.createRun(command.clientNonce);
    } catch (error) {
      this.failBeforeRun(command.clientNonce, error);
    }
    this.startDispatch(run);
    return { clientNonce: command.clientNonce, runId: run.id, disposition: "accepted", state: "queued" };
  }

  retry(clientNonce: string): SendResult {
    if (this.shuttingDown) throw new MsBotError("APP_INTERRUPTED");
    const journal = this.repository.queueRetry(clientNonce);
    this.emitSendState(journal.sessionId, clientNonce, "queued");
    let run: RuntimeRun;
    try {
      run = this.createRun(clientNonce);
    } catch (error) {
      this.failBeforeRun(clientNonce, error);
    }
    this.startDispatch(run);
    return { clientNonce, runId: run.id, disposition: "accepted", state: "queued" };
  }

  retryRun(runId: string): SendResult {
    if (this.shuttingDown) throw new MsBotError("APP_INTERRUPTED");
    const previous = this.repository.assertRuntimeRetryEligible(runId);
    const run = this.createRun(previous.clientNonce, previous.inputSeq);
    this.startDispatch(run);
    return {
      clientNonce: previous.clientNonce,
      runId: run.id,
      disposition: "accepted",
      state: this.repository.getSendOrThrow(previous.clientNonce).state,
    };
  }

  cancel(clientNonce: string): void {
    const run = this.repository.getLatestRuntimeRun(clientNonce);
    if (!run || ["completed", "failed", "cancelled", "interrupted"].includes(run.state)) {
      throw new MsBotError("MESSAGE_NOT_RUNNING");
    }
    this.cancelRun(run.id);
  }

  cancelRun(runId: string): RuntimeRun {
    const current = this.repository.getRuntimeRun(runId);
    if (["completed", "failed", "cancelled", "interrupted", "cancel-requested"].includes(current.state)) return current;
    const updated = this.repository.transitionRuntimeRun(runId, "cancel-requested");
    this.emitRuntime(updated);
    const active = this.active.get(runId);
    if (active) {
      active.abortReason = "user";
      active.controller.abort("user");
    }
    return updated;
  }

  getSessionSnapshot(sessionId: string): SessionRuntimeSnapshot {
    const session = this.repository.getSession(sessionId);
    return {
      sessionId,
      generation: session.generation,
      transcriptCursor: this.repository.getTranscriptCursor(sessionId),
      entries: this.repository.listTranscript(sessionId),
      runs: this.repository.listRuntimeRuns(sessionId),
      liveState: this.getLiveState(sessionId),
    };
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown && this.inFlight.size === 0) return;
    this.shuttingDown = true;
    for (const active of this.active.values()) {
      this.flush(active, "streaming");
      active.abortReason = "app-shutdown";
      active.controller.abort("app-shutdown");
    }
    const pending = [...this.inFlight.values()];
    if (pending.length > 0) {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_MS)),
      ]);
    }
    for (const active of this.active.values()) {
      this.clearTimers(active);
      const run = this.repository.getRuntimeRun(active.runId);
      if (!["completed", "failed", "cancelled", "interrupted"].includes(run.state)) {
        const interrupted = this.repository.transitionRuntimeRun(run.id, "interrupted", { errorCode: "APP_INTERRUPTED" });
        this.finalizeAssistant(active, "failed");
        this.emitRuntime(interrupted, new MsBotError("APP_INTERRUPTED").toAppError());
      }
    }
  }

  private route(): RuntimeRoute {
    return this.forceFakeProvider || this.providerOverride ? "fake" : "openai-compatible";
  }

  private createRun(clientNonce: string, inputSeq?: number): RuntimeRun {
    const journal = this.repository.getSendOrThrow(clientNonce);
    const session = this.repository.getSession(journal.sessionId);
    const bot = this.repository.getBotForSession(journal.sessionId);
    const input = this.repository.getUserMessage(clientNonce);
    const cutoff = inputSeq ?? input.seq;
    const prompt = buildPrompt(bot, session, this.repository.listPromptEntries(session.id, cutoff), cutoff);
    const run = this.repository.createRuntimeRun(clientNonce, this.route(), prompt.manifest);
    const active: ActiveRun = {
      controller: new AbortController(),
      runId: run.id,
      clientNonce,
      sessionId: journal.sessionId,
      messages: prompt.messages,
      body: "",
      persistedBody: "",
      assistantEntryId: null,
      flushTimer: null,
      staleTimer: null,
      abortReason: null,
    };
    this.active.set(run.id, active);
    this.emitRuntime(run);
    this.armStaleTimer(active);
    return run;
  }

  private startDispatch(run: RuntimeRun): void {
    const promise = this.dispatch(run.id).finally(() => this.inFlight.delete(run.id));
    this.inFlight.set(run.id, promise);
  }

  private failBeforeRun(clientNonce: string, error: unknown): never {
    const appError = asAppError(error);
    const journal = this.repository.setSendState(clientNonce, "failed-before-acceptance", appError.code);
    const user = this.repository.setUserMessageStatus(clientNonce, "failed");
    this.events.transcript({ sessionId: journal.sessionId, entry: user });
    this.emitSendState(journal.sessionId, clientNonce, "failed-before-acceptance", appError);
    throw error;
  }

  private async dispatch(runId: string): Promise<void> {
    const active = this.active.get(runId);
    if (!active) return;
    let run = this.repository.transitionRuntimeRun(runId, "dispatching");
    this.emitRuntime(run);
    const journalAtStart = this.repository.getSendOrThrow(active.clientNonce);
    const messageNeedsAck = journalAtStart.state !== "acked";
    if (messageNeedsAck) {
      this.repository.setSendState(active.clientNonce, "dispatching");
      this.emitSendState(active.sessionId, active.clientNonce, "dispatching");
    }

    try {
      const provider = this.createProvider();
      for await (const event of provider.run(active.messages, active.controller.signal)) {
        if (active.controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
        if (event.type === "started") {
          run = this.repository.transitionRuntimeRun(runId, "running", { providerRequestId: event.requestId });
          if (messageNeedsAck) {
            this.repository.setSendProviderRequestId(active.clientNonce, event.requestId);
            this.repository.setSendState(active.clientNonce, "accepted-awaiting-echo");
            this.emitSendState(active.sessionId, active.clientNonce, "accepted-awaiting-echo");
            const user = this.repository.acknowledgeUserMessage(active.clientNonce);
            this.events.transcript({ sessionId: active.sessionId, entry: user });
            this.emitSendState(active.sessionId, active.clientNonce, "acked");
          }
          const assistant = this.repository.createAssistantEntry(active.sessionId);
          active.assistantEntryId = assistant.id;
          run = this.repository.attachAssistantEntry(run.id, assistant.id);
          this.events.transcript({ sessionId: active.sessionId, entry: assistant });
          this.emitRuntime(run);
          this.armStaleTimer(active);
          continue;
        }
        if (event.type === "activity") {
          run = this.repository.touchRuntimeRun(runId);
          this.emitRuntime(run);
          this.armStaleTimer(active);
          continue;
        }
        if (event.type === "delta") {
          if (!active.assistantEntryId) throw new MsBotError("RUNTIME_STATE_INVALID");
          if (run.state === "running") {
            run = this.repository.transitionRuntimeRun(runId, "streaming");
            this.emitRuntime(run);
          }
          active.body += event.text;
          if (active.body.length - active.persistedBody.length >= DELTA_FLUSH_CHARS) this.flush(active, "streaming");
          else this.scheduleFlush(active);
          this.armStaleTimer(active);
          continue;
        }
        if (event.type === "completed") {
          this.finalizeAssistant(active, "completed");
          run = this.repository.transitionRuntimeRun(runId, "completed");
          this.emitRuntime(run);
          break;
        }
      }
      if (!["completed", "failed", "cancelled", "interrupted"].includes(this.repository.getRuntimeRun(runId).state)) {
        throw new MsBotError("MODEL_STREAM_TRUNCATED");
      }
    } catch (error) {
      this.handleFailure(active, error, messageNeedsAck);
    } finally {
      this.clearTimers(active);
      this.active.delete(runId);
    }
  }

  private handleFailure(active: ActiveRun, error: unknown, messageNeedsAck: boolean): void {
    const current = this.repository.getRuntimeRun(active.runId);
    if (["completed", "failed", "cancelled", "interrupted"].includes(current.state)) return;
    const aborted = error instanceof DOMException && error.name === "AbortError";
    const appError = aborted
      ? new MsBotError(active.abortReason === "app-shutdown" ? "APP_INTERRUPTED" : "MESSAGE_CANCELLED").toAppError()
      : asAppError(error);
    const targetState = active.abortReason === "app-shutdown"
      ? "interrupted"
      : aborted || current.state === "cancel-requested"
        ? "cancelled"
        : current.providerRequestId
          ? "failed"
          : appError.code === "MODEL_TRANSPORT_ERROR" || appError.code === "MODEL_CONNECTION_TIMEOUT"
            ? "interrupted"
            : "failed";
    const run = this.repository.transitionRuntimeRun(active.runId, targetState, { errorCode: appError.code });
    if (active.assistantEntryId) this.finalizeAssistant(active, targetState === "cancelled" ? "cancelled" : "failed");

    if (messageNeedsAck && this.repository.getSendOrThrow(active.clientNonce).state !== "acked") {
      const sendState: SendState = targetState === "cancelled"
        ? "cancelled"
        : appError.code === "MODEL_REQUEST_REFUSED" && !appError.retryable
          ? "refused"
          : targetState === "interrupted"
            ? "interrupted-unknown"
            : "failed-before-acceptance";
      this.repository.setSendState(active.clientNonce, sendState, appError.code);
      const user = this.repository.setUserMessageStatus(active.clientNonce, targetState === "cancelled" ? "cancelled" : "failed");
      this.events.transcript({ sessionId: active.sessionId, entry: user });
      this.emitSendState(active.sessionId, active.clientNonce, sendState, appError);
    }
    this.emitRuntime(run, appError);
  }

  private scheduleFlush(active: ActiveRun): void {
    if (active.flushTimer) return;
    active.flushTimer = setTimeout(() => {
      active.flushTimer = null;
      this.flush(active, "streaming");
    }, DELTA_FLUSH_MS);
  }

  private flush(active: ActiveRun, status: TranscriptStatus): void {
    if (!active.assistantEntryId || active.persistedBody === active.body && status === "streaming") return;
    if (active.flushTimer) {
      clearTimeout(active.flushTimer);
      active.flushTimer = null;
    }
    const entry = this.repository.updateTranscriptEntry(active.assistantEntryId, active.body, status);
    active.persistedBody = active.body;
    this.events.transcript({ sessionId: active.sessionId, entry });
    if (!isTerminalTranscript(status)) {
      const run = this.repository.touchRuntimeRun(active.runId);
      this.emitRuntime(run);
    }
  }

  private finalizeAssistant(active: ActiveRun, status: TranscriptStatus): void {
    if (!active.assistantEntryId) return;
    this.flush(active, status);
  }

  private createProvider(): ModelProvider {
    if (this.providerOverride) return this.providerOverride;
    if (this.forceFakeProvider) return new FakeModelProvider();
    const configuration = this.settings.getConfiguration();
    if (!configuration.modelId || !configuration.apiKeyConfigured) throw new MsBotError("MODEL_NOT_CONFIGURED");
    return new OpenAiCompatibleProvider(configuration.baseUrl, configuration.modelId, this.settings.getApiKey());
  }

  private getLiveState(sessionId: string): SessionLiveState {
    const run = this.repository.getActiveRuntimeRun(sessionId);
    if (!run) {
      return {
        sessionId,
        state: "idle",
        activeRunId: null,
        activeClientNonce: null,
        lastActivityAt: null,
        staleAfterMs: STALE_AFTER_MS,
      };
    }
    const stale = Date.now() - new Date(run.lastActivityAt).getTime() >= STALE_AFTER_MS;
    const state = stale
      ? "stale"
      : run.state === "cancel-requested"
        ? "cancelling"
        : run.state === "streaming"
          ? "composing"
          : run.attemptNo > 1
            ? "retrying"
            : run.state === "running"
              ? "running"
              : "starting";
    return {
      sessionId,
      state,
      activeRunId: run.id,
      activeClientNonce: run.clientNonce,
      lastActivityAt: run.lastActivityAt,
      staleAfterMs: STALE_AFTER_MS,
    };
  }

  private emitSendState(sessionId: string, clientNonce: string, state: SendState, error?: AppError): void {
    this.events.sendState({ sessionId, clientNonce, state, ...(error ? { error } : {}) });
  }

  private emitRuntime(run: RuntimeRun, error?: AppError): void {
    this.events.runtime({
      sessionId: run.sessionId,
      run,
      liveState: this.getLiveState(run.sessionId),
      ...(error ? { error } : {}),
    });
  }

  private armStaleTimer(active: ActiveRun): void {
    if (active.staleTimer) clearTimeout(active.staleTimer);
    active.staleTimer = setTimeout(() => {
      const current = this.repository.getRuntimeRun(active.runId);
      if (["completed", "failed", "cancelled", "interrupted"].includes(current.state)) return;
      const bumped = this.repository.bumpRuntimeVersion(active.runId);
      this.emitRuntime(bumped);
    }, STALE_AFTER_MS);
  }

  private clearTimers(active: ActiveRun): void {
    if (active.flushTimer) clearTimeout(active.flushTimer);
    if (active.staleTimer) clearTimeout(active.staleTimer);
    active.flushTimer = null;
    active.staleTimer = null;
  }
}

function isTerminalTranscript(status: TranscriptStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export { RuntimeCoordinator as SendWorker };
