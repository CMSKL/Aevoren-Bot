import type {
  AppError,
  RuntimeEvent,
  RuntimeRoute,
  RuntimeRun,
  SessionLiveState,
  TranscriptEvent,
  TranscriptStatus,
} from "@shared/contracts";
import { sanitizeRoomSpeakerOutput } from "@shared/room-speaker-envelope";
import { asAppError, MsBotError } from "./errors";
import type { AppRepository } from "./database";
import { FakeModelProvider, OpenAiCompatibleProvider, type ChatMessage, type ModelProvider } from "./model";
import { buildPrompt } from "./prompt";
import type { ModelSettingsService } from "./settings";

export type RuntimeExecutorEvents = {
  transcript: (event: TranscriptEvent) => void;
  runtime: (event: RuntimeEvent) => void;
};

export type RuntimeExecutionInput = {
  clientNonce: string;
  executorBotId: string;
  executionKey: string;
  inputSeq?: number;
  promptCutoffSeq?: number;
  attribution?: {
    speakerBotId: string;
    speakerNameSnapshot: string;
    sourceTurnId: string;
  };
  room?: {
    id: string;
    membershipVersion: number;
    sourceTurnId: string;
  };
  onDispatchStart?(): void;
  onProviderStarted?(requestId: string): void;
};

export type RuntimeExecutionResult = {
  run: RuntimeRun;
  error?: AppError;
  providerStarted: boolean;
};

type AbortReason = "user" | "app-shutdown";

type ActiveRun = {
  controller: AbortController;
  runId: string;
  clientNonce: string;
  sessionId: string;
  messages: ChatMessage[];
  attribution?: RuntimeExecutionInput["attribution"];
  onDispatchStart?: RuntimeExecutionInput["onDispatchStart"];
  onProviderStarted?: RuntimeExecutionInput["onProviderStarted"];
  providerBody: string;
  body: string;
  persistedBody: string;
  assistantEntryId: string | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
  staleTimer: ReturnType<typeof setTimeout> | null;
  abortReason: AbortReason | null;
  providerStarted: boolean;
};

export const STALE_AFTER_MS = 30_000;
const DELTA_FLUSH_MS = 50;
const DELTA_FLUSH_CHARS = 512;
const SHUTDOWN_DRAIN_MS = 2_000;

export class RuntimeExecutor {
  private readonly active = new Map<string, ActiveRun>();
  private readonly inFlight = new Map<string, Promise<RuntimeExecutionResult>>();
  private shuttingDown = false;

  constructor(
    private readonly repository: AppRepository,
    private readonly settings: ModelSettingsService,
    private readonly events: RuntimeExecutorEvents,
    private readonly forceFakeProvider = false,
    private readonly providerOverride?: ModelProvider,
  ) {}

  start(input: RuntimeExecutionInput): { run: RuntimeRun; completion: Promise<RuntimeExecutionResult> } {
    if (this.shuttingDown) throw new MsBotError("APP_INTERRUPTED");
    const journal = this.repository.getSendOrThrow(input.clientNonce);
    const session = this.repository.getSession(journal.sessionId);
    const bot = this.repository.getBot(input.executorBotId);
    const user = this.repository.getUserMessage(input.clientNonce);
    const inputSeq = input.inputSeq ?? user.seq;
    const promptCutoffSeq = input.promptCutoffSeq ?? inputSeq;
    const prompt = buildPrompt(
      bot,
      session,
      this.repository.listPromptEntries(session.id, promptCutoffSeq),
      inputSeq,
      input.room
        ? {
            promptCutoffSeq,
            roomId: input.room.id,
            roomMembershipVersion: input.room.membershipVersion,
            sourceTurnId: input.room.sourceTurnId,
          }
        : undefined,
    );
    const run = this.repository.createRuntimeRun(input.clientNonce, this.route(), prompt.manifest, {
      executorBotId: bot.id,
      executionKey: input.executionKey,
      promptCutoffSeq,
    });
    const active: ActiveRun = {
      controller: new AbortController(),
      runId: run.id,
      clientNonce: input.clientNonce,
      sessionId: session.id,
      messages: prompt.messages,
      attribution: input.attribution,
      onDispatchStart: input.onDispatchStart,
      onProviderStarted: input.onProviderStarted,
      providerBody: "",
      body: "",
      persistedBody: "",
      assistantEntryId: null,
      flushTimer: null,
      staleTimer: null,
      abortReason: null,
      providerStarted: false,
    };
    this.active.set(run.id, active);
    this.emitRuntime(run);
    this.armStaleTimer(active);
    const completion = this.dispatch(run.id).finally(() => this.inFlight.delete(run.id));
    this.inFlight.set(run.id, completion);
    return { run, completion };
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

  getLiveState(sessionId: string): SessionLiveState {
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

  async shutdown(): Promise<void> {
    if (this.shuttingDown && this.inFlight.size === 0) return;
    this.shuttingDown = true;
    for (const active of this.active.values()) {
      this.flush(active, "streaming");
      active.abortReason ??= "app-shutdown";
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
        const userCancelled = active.abortReason === "user" || run.state === "cancel-requested";
        const error = new MsBotError(userCancelled ? "MESSAGE_CANCELLED" : "APP_INTERRUPTED").toAppError();
        const settled = this.repository.transitionRuntimeRun(run.id, userCancelled ? "cancelled" : "interrupted", {
          errorCode: error.code,
        });
        this.finalizeAssistant(active, userCancelled ? "cancelled" : "failed");
        this.emitRuntime(settled, error);
      }
    }
  }

  private route(): RuntimeRoute {
    return this.forceFakeProvider || this.providerOverride ? "fake" : "openai-compatible";
  }

  private async dispatch(runId: string): Promise<RuntimeExecutionResult> {
    const active = this.active.get(runId);
    if (!active) throw new MsBotError("RUNTIME_NOT_FOUND");
    let run = this.repository.transitionRuntimeRun(runId, "dispatching");
    this.emitRuntime(run);
    try {
      active.onDispatchStart?.();
      const provider = this.createProvider();
      for await (const event of provider.run(active.messages, active.controller.signal)) {
        if (active.controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
        if (event.type === "started") {
          active.providerStarted = true;
          run = this.repository.transitionRuntimeRun(runId, "running", { providerRequestId: event.requestId });
          active.onProviderStarted?.(event.requestId);
          const assistant = this.repository.createAssistantEntry(active.sessionId, active.attribution);
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
          active.providerBody += event.text;
          active.body = active.attribution
            ? sanitizeRoomSpeakerOutput(active.providerBody, true)
            : active.providerBody;
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
      const current = this.repository.getRuntimeRun(runId);
      if (!["completed", "failed", "cancelled", "interrupted"].includes(current.state)) {
        throw new MsBotError("MODEL_STREAM_TRUNCATED");
      }
      return { run: current, providerStarted: active.providerStarted };
    } catch (error) {
      const appError = this.handleFailure(active, error);
      return { run: this.repository.getRuntimeRun(runId), error: appError, providerStarted: active.providerStarted };
    } finally {
      this.clearTimers(active);
      this.active.delete(runId);
    }
  }

  private handleFailure(active: ActiveRun, error: unknown): AppError {
    const current = this.repository.getRuntimeRun(active.runId);
    if (["completed", "failed", "cancelled", "interrupted"].includes(current.state)) {
      return asAppError(error);
    }
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
    this.emitRuntime(run, appError);
    return appError;
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
    if (active.attribution) active.body = sanitizeRoomSpeakerOutput(active.providerBody, true);
    if (active.assistantEntryId) this.flush(active, status);
  }

  private createProvider(): ModelProvider {
    if (this.providerOverride) return this.providerOverride;
    if (this.forceFakeProvider) return new FakeModelProvider();
    const configuration = this.settings.getConfiguration();
    if (!configuration.modelId || !configuration.apiKeyConfigured) throw new MsBotError("MODEL_NOT_CONFIGURED");
    return new OpenAiCompatibleProvider(configuration.baseUrl, configuration.modelId, this.settings.getApiKey());
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
      this.emitRuntime(this.repository.bumpRuntimeVersion(active.runId));
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
