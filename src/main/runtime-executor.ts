import type {
  AppError,
  CapabilityPromptSnapshot,
  ModelSelection,
  RuntimeEvent,
  RuntimeRoute,
  RuntimeRun,
  SessionLiveState,
  TranscriptEvent,
  TranscriptStatus,
} from "@shared/contracts";
import { sanitizeRoomSpeakerOutput } from "@shared/room-speaker-envelope";
import { asAppError, AevorenBotError } from "./errors";
import type { AppRepository } from "./database";
import {
  FakeModelProvider,
  selectDeterministicRoomOwner,
  type ChatMessage,
  type ModelEvent,
  type ModelProvider,
  type ModelRunContext,
  type RoomPeer,
  type RoomContinuationDecision,
  type RoomOwnerSelection,
} from "./model";
import { buildPrompt } from "./prompt";
import type { ProviderResolver } from "./providers/contracts";
import type { WorkspaceToolCoordinator } from "./workspace-tool-coordinator";
import type { McpService } from "./mcp-service";
import { choiceQuestion, type DecisionService } from "./decision-service";
import type { MemoryCaptureService } from "./memory-capture-service";

export type RuntimeExecutorEvents = {
  transcript: (event: TranscriptEvent) => void;
  runtime: (event: RuntimeEvent) => void;
};

export type RuntimeExecutionInput = {
  clientNonce: string;
  executorBotId: string;
  executionKey: string;
  modelSelection?: ModelSelection;
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
    roster?: RoomPeer[];
  };
  incomingHandoff?: ModelRunContext["incomingHandoff"];
  onRunCreated?(run: RuntimeRun): void;
  onDispatchStart?(): void;
  onProviderStarted?(requestId: string): void;
  onHandoff?(event: Extract<ModelEvent, { type: "handoff" }>): boolean | void;
};

export type RuntimeExecutionResult = {
  run: RuntimeRun;
  error?: AppError;
  providerStarted: boolean;
};

export type CapabilitySnapshotSource = {
  forPrompt(botId: string, selection: ModelSelection, room: boolean): CapabilityPromptSnapshot;
};

type AbortReason = "user" | "deadline" | "app-shutdown";

type ActiveRun = {
  controller: AbortController;
  runId: string;
  clientNonce: string;
  sessionId: string;
  messages: ChatMessage[];
  modelSelection: ModelSelection;
  attribution?: RuntimeExecutionInput["attribution"];
  providerContext: ModelRunContext;
  onDispatchStart?: RuntimeExecutionInput["onDispatchStart"];
  onProviderStarted?: RuntimeExecutionInput["onProviderStarted"];
  onHandoff?: RuntimeExecutionInput["onHandoff"];
  providerBody: string;
  body: string;
  persistedBody: string;
  assistantEntryId: string | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
  staleTimer: ReturnType<typeof setTimeout> | null;
  abortReason: AbortReason | null;
  providerStarted: boolean;
  handoffEmitted: boolean;
};

export const STALE_AFTER_MS = 30_000;
const DELTA_FLUSH_MS = 50;
const DELTA_FLUSH_CHARS = 512;
const SHUTDOWN_DRAIN_MS = 2_000;

export class RuntimeExecutor {
  private readonly active = new Map<string, ActiveRun>();
  private readonly inFlight = new Map<string, Promise<RuntimeExecutionResult>>();
  private shuttingDown = false;
  private readonly fakeProvider: FakeModelProvider | null;

  constructor(
    private readonly repository: AppRepository,
    private readonly providers: ProviderResolver | null,
    private readonly events: RuntimeExecutorEvents,
    private readonly forceFakeProvider = false,
    private readonly providerOverride?: ModelProvider,
    private readonly workspaceTools?: WorkspaceToolCoordinator,
    private readonly capabilitySnapshots?: CapabilitySnapshotSource,
    private readonly mcpTools?: Pick<McpService, "availableTools">,
    private readonly decisions?: DecisionService,
    private readonly memoryCapture?: MemoryCaptureService,
  ) {
    this.fakeProvider = forceFakeProvider && !providerOverride ? new FakeModelProvider() : null;
  }

  start(input: RuntimeExecutionInput): { run: RuntimeRun; completion: Promise<RuntimeExecutionResult> } {
    if (this.shuttingDown) throw new AevorenBotError("APP_INTERRUPTED");
    const journal = this.repository.getSendOrThrow(input.clientNonce);
    const session = this.repository.getSession(journal.sessionId);
    const bot = this.repository.getBot(input.executorBotId);
    const user = this.repository.getUserMessage(input.clientNonce);
    const inputSeq = input.inputSeq ?? user.seq;
    const promptCutoffSeq = input.promptCutoffSeq ?? inputSeq;
    const modelSelection = input.modelSelection ?? bot.modelSelection;
    const capabilitySnapshot = this.capabilitySnapshots?.forPrompt(bot.id, modelSelection, Boolean(input.room));
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
            ...(input.room.roster ? { roomRoster: input.room.roster } : {}),
            ...(input.incomingHandoff ? { handoff: input.incomingHandoff } : {}),
          }
        : undefined,
      this.repository.listRuntimeMemories(bot.id),
      capabilitySnapshot,
    );
    const route = this.route(modelSelection);
    const providerCapabilities = this.forceFakeProvider
      ? { roomOwnerSelection: true, handoff: true, workspaceTools: true, networkTools: true }
      : this.providerOverride
        ? { roomOwnerSelection: true, handoff: true, workspaceTools: true, networkTools: false }
        : this.providers?.getCapabilities(modelSelection);
    const run = this.repository.createRuntimeRun(input.clientNonce, route, prompt.manifest, {
      executorBotId: bot.id,
      executionKey: input.executionKey,
      inputSeq,
      promptCutoffSeq,
      providerInstanceId: route === "fake" ? "fake" : modelSelection.providerInstanceId,
      providerModelId: route === "fake" ? "" : modelSelection.modelId,
    });
    try {
      input.onRunCreated?.(run);
    } catch (error) {
      this.repository.transitionRuntimeRun(run.id, "failed", { errorCode: asAppError(error).code });
      throw error;
    }
    const active: ActiveRun = {
      controller: new AbortController(),
      runId: run.id,
      clientNonce: input.clientNonce,
      sessionId: session.id,
      messages: prompt.messages,
      modelSelection,
      attribution: input.attribution,
      providerContext: {
        executorBotId: bot.id,
        executionKey: input.executionKey,
        ...(input.room ? { roomId: input.room.id, sourceTurnId: input.room.sourceTurnId } : {}),
        ...(input.room?.roster ? { roomRoster: input.room.roster } : {}),
        ...(input.incomingHandoff ? { incomingHandoff: input.incomingHandoff } : {}),
        workspaces: providerCapabilities?.workspaceTools === true
          ? this.repository.listWorkspaces().map(({ id, name }) => ({ id, name }))
          : [],
        networkTools: providerCapabilities?.networkTools === true,
        mcpTools: providerCapabilities?.networkTools === true ? this.mcpTools?.availableTools(bot.id) ?? [] : [],
        deviceTools: providerCapabilities?.networkTools === true,
      },
      onDispatchStart: input.onDispatchStart,
      onProviderStarted: input.onProviderStarted,
      onHandoff: input.onHandoff,
      providerBody: "",
      body: "",
      persistedBody: "",
      assistantEntryId: null,
      flushTimer: null,
      staleTimer: null,
      abortReason: null,
      providerStarted: false,
      handoffEmitted: false,
    };
    this.active.set(run.id, active);
    this.emitRuntime(run);
    this.armStaleTimer(active);
    const completion = this.dispatch(run.id).finally(() => this.inFlight.delete(run.id));
    this.inFlight.set(run.id, completion);
    return { run, completion };
  }

  cancelRun(runId: string, reason: "user" | "deadline" = "user"): RuntimeRun {
    const current = this.repository.getRuntimeRun(runId);
    if (["completed", "failed", "cancelled", "interrupted", "cancel-requested"].includes(current.state)) return current;
    const active = this.active.get(runId);
    let effectiveReason: AbortReason = reason;
    if (active) {
      active.abortReason ??= reason;
      effectiveReason = active.abortReason;
      active.controller.abort(effectiveReason);
    }
    if (effectiveReason !== "user") return current;
    const updated = this.repository.transitionRuntimeRun(runId, "cancel-requested");
    this.emitRuntime(updated);
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

  async selectRoomOwner(text: string, roster: readonly RoomPeer[], signal: AbortSignal): Promise<RoomOwnerSelection> {
    if (this.shuttingDown) throw new AevorenBotError("APP_INTERRUPTED");
    const selection = this.repository.getDefaultModelSelection();
    const usesOverride = Boolean(this.providerOverride || this.fakeProvider);
    const capabilities = usesOverride ? { roomOwnerSelection: true } : this.providers?.getCapabilities(selection);
    if (!capabilities?.roomOwnerSelection) return selectDeterministicRoomOwner(text, roster);
    const provider = this.createProvider(selection);
    const selector = provider.selectRoomOwner;
    if (!selector) {
      if (usesOverride) throw new AevorenBotError("MODEL_ROUTER_UNSUPPORTED");
      return selectDeterministicRoomOwner(text, roster);
    }
    const result = await selector.call(provider, text, roster, signal);
    if (this.shuttingDown) throw new AevorenBotError("APP_INTERRUPTED");
    return result;
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
        const error = new AevorenBotError(userCancelled ? "MESSAGE_CANCELLED" : "APP_INTERRUPTED").toAppError();
        const settled = this.repository.transitionRuntimeRun(run.id, userCancelled ? "cancelled" : "interrupted", {
          errorCode: error.code,
        });
        this.finalizeAssistant(active, userCancelled ? "cancelled" : "failed");
        this.emitRuntime(settled, error);
      }
    }
  }

  private route(selection: ModelSelection): RuntimeRoute {
    if (this.forceFakeProvider || this.providerOverride) return "fake";
    if (!this.providers) throw new AevorenBotError("MODEL_NOT_CONFIGURED");
    return this.providers.getRoute(selection);
  }

  private async dispatch(runId: string): Promise<RuntimeExecutionResult> {
    const active = this.active.get(runId);
    if (!active) throw new AevorenBotError("RUNTIME_NOT_FOUND");
    let run = this.repository.transitionRuntimeRun(runId, "dispatching");
    let iterator: AsyncIterator<ModelEvent> | null = null;
    this.emitRuntime(run);
    try {
      active.onDispatchStart?.();
      const provider = this.createProvider(active.modelSelection);
      let toolRounds = 0;
      let completed = false;
      while (!completed) {
        let workspaceContinuation = false;
        let roundCompleted = false;
        let roundProviderStarted = false;
        const roundBodyStart = active.providerBody.length;
        iterator = provider.run(active.messages, active.controller.signal, active.providerContext)[Symbol.asyncIterator]();
        while (true) {
        const next = await nextModelEvent(
          iterator,
          active.controller.signal,
          () => active.abortReason !== "user",
        );
        if (next.done) break;
        const event = next.value;
        if (active.controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
        const persistedRun = this.repository.getRuntimeRun(runId);
        if (["completed", "failed", "cancelled", "interrupted"].includes(persistedRun.state)) {
          return { run: persistedRun, providerStarted: active.providerStarted };
        }
        if (event.type === "started") {
          if (roundProviderStarted) throw new AevorenBotError("RUNTIME_STATE_INVALID");
          roundProviderStarted = true;
          if (active.providerStarted) {
            run = this.repository.touchRuntimeRun(runId);
            this.emitRuntime(run);
            this.armStaleTimer(active);
            continue;
          }
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
          if (!active.assistantEntryId) throw new AevorenBotError("RUNTIME_STATE_INVALID");
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
        if (event.type === "handoff") {
          if (!active.providerStarted || !active.onHandoff) throw new AevorenBotError("RUNTIME_STATE_INVALID");
          const roster = active.providerContext.roomRoster;
          if (roster && event.visibility === "room") {
            void this.recordHandoffShadow(active, {
              action: "handoff",
              toAgentId: event.toAgentId,
              task: event.task,
              contextRefs: event.contextRefs,
              visibility: event.visibility,
              reason: "provider structured Handoff",
            }, roster);
          }
          active.handoffEmitted = active.onHandoff(event) !== false || active.handoffEmitted;
          run = this.repository.touchRuntimeRun(runId);
          this.emitRuntime(run);
          this.armStaleTimer(active);
          continue;
        }
        if (event.type === "workspace-tool" || event.type === "network-tool" || event.type === "mcp-tool" || event.type === "device-tool") {
          if (!active.providerStarted || !this.workspaceTools) throw new AevorenBotError("RUNTIME_STATE_INVALID");
          if (workspaceContinuation) throw new AevorenBotError("MODEL_WORKSPACE_TOOL_INVALID");
          if (toolRounds >= 4) throw new AevorenBotError("TOOL_ROUND_LIMIT_EXCEEDED");
          toolRounds += 1;
          const outcome = await this.workspaceTools.requestAndWait(
            runId,
            event.toolCallId,
            event.tool,
            active.controller.signal,
          );
          if (event.respond) {
            await event.respond(outcome.content);
            run = this.repository.touchRuntimeRun(runId);
            this.emitRuntime(run);
            this.armStaleTimer(active);
            continue;
          }
          const functionName = event.providerToolName ?? event.tool.kind.replaceAll("-", "_");
          const argumentsValue = Object.fromEntries(Object.entries(event.tool).filter(([key]) => key !== "kind"));
          active.messages.push({
            role: "assistant",
            content: active.providerBody.slice(roundBodyStart),
            tool_calls: [{
              id: event.toolCallId,
              type: "function",
              function: { name: functionName, arguments: JSON.stringify(argumentsValue) },
            }],
          });
          active.messages.push({ role: "tool", tool_call_id: outcome.toolCallId, content: outcome.content });
          workspaceContinuation = true;
          run = this.repository.touchRuntimeRun(runId);
          this.emitRuntime(run);
          this.armStaleTimer(active);
          continue;
        }
        if (event.type === "completed") {
          roundCompleted = true;
          if (workspaceContinuation) break;
          const continuation = await this.selectRoomContinuation(provider, active);
          if (continuation?.action === "handoff") {
            const accepted = active.onHandoff?.({
              type: "handoff",
              toolCallId: `continuation:${active.runId}`,
              toAgentId: continuation.toAgentId,
              task: continuation.task,
              contextRefs: continuation.contextRefs,
              visibility: continuation.visibility,
            });
            active.handoffEmitted = accepted !== false || active.handoffEmitted;
          }
          this.finalizeAssistant(active, "completed");
          run = this.repository.transitionRuntimeRun(runId, "completed");
          this.emitRuntime(run);
          const user = this.repository.getUserMessage(active.clientNonce);
          this.memoryCapture?.enqueue({
            botId: active.providerContext.executorBotId,
            sourceEntryId: user.id,
            userText: user.body,
          });
          completed = true;
          break;
        }
      }
        closeIterator(iterator);
        iterator = null;
        if (!roundCompleted) throw new AevorenBotError("MODEL_STREAM_TRUNCATED");
      }
      const current = this.repository.getRuntimeRun(runId);
      if (!["completed", "failed", "cancelled", "interrupted"].includes(current.state)) {
        throw new AevorenBotError("MODEL_STREAM_TRUNCATED");
      }
      return { run: current, providerStarted: active.providerStarted };
    } catch (error) {
      const appError = this.handleFailure(active, error);
      return { run: this.repository.getRuntimeRun(runId), error: appError, providerStarted: active.providerStarted };
    } finally {
      closeIterator(iterator);
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
      ? new AevorenBotError(
          active.abortReason === "app-shutdown"
            ? "APP_INTERRUPTED"
            : active.abortReason === "deadline"
              ? "MODEL_RUN_TIMEOUT"
              : "MESSAGE_CANCELLED",
        ).toAppError()
      : asAppError(error);
    const targetState = active.abortReason === "app-shutdown"
      ? "interrupted"
      : active.abortReason === "deadline"
        ? "failed"
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

  private async selectRoomContinuation(
    provider: ModelProvider,
    active: ActiveRun,
  ): Promise<RoomContinuationDecision | null> {
    const roster = active.providerContext.roomRoster;
    const selector = provider.selectRoomContinuation;
    if (
      active.handoffEmitted ||
      !active.onHandoff ||
      !selector ||
      !roster ||
      !mentionsAnotherRoomPeer(active.body, active.providerContext.executorBotId, roster)
    ) return null;
    const continuation = await selector.call(
      provider,
      active.body,
      active.providerContext.executorBotId,
      roster,
      active.controller.signal,
    );
    void this.recordHandoffShadow(active, continuation, roster);
    return continuation;
  }

  private async recordHandoffShadow(
    active: ActiveRun,
    existingContinuation: RoomContinuationDecision,
    roster: readonly RoomPeer[],
  ): Promise<void> {
    if (!this.decisions?.isEnabled()) return;
    try {
      const evaluation = await this.decisions.evaluate({
        policyId: "room-handoff-shadow",
        policyVersion: 1,
        state: {
          assistantDraft: active.body,
          executorBotId: active.providerContext.executorBotId,
          roster,
          existingContinuation,
        },
        questions: {
          action: choiceQuestion(
            { complete: "完成当前任务并停止", handoff: "将当前任务转交给下一个 Bot" },
            "判断当前草稿是否明确要求现在把任务交给另一个 Room Bot。",
            "仅当草稿明确要求立即转交时选择 handoff。等待用户批准时选择 complete。",
          ),
          nextOwner: choiceQuestion(
            Object.fromEntries(roster
              .filter((peer) => peer.id !== active.providerContext.executorBotId)
              .map((peer) => [peer.id, `${peer.name} · ${peer.label}`])),
            "如果需要转交，选择最适合的下一个 Room Bot。",
            "只能从提供的候选中选择。",
          ),
          needsHumanApproval: choiceQuestion(
            { yes: "需要人工确认", no: "不需要人工确认" },
            "判断当前任务是否必须等待人工门禁。",
            "如果草稿要求用户批准、补充真实经验或亲自发布，选择 yes。",
          ),
        },
        idempotencyKey: `room-handoff-shadow:${active.runId}`,
      });
      if (evaluation.disposition !== "completed" || !evaluation.result) return;
      this.repository.updateDecisionJournal(evaluation.journal.id, {
        answers: {
          ...evaluation.result.answers,
          existingContinuation: { value: existingContinuation },
        },
      });
    } catch {
      // Shadow evaluation must never change the accepted Handoff decision.
    }
  }

  private createProvider(selection: ModelSelection): ModelProvider {
    if (this.providerOverride) return this.providerOverride;
    if (this.fakeProvider) return this.fakeProvider;
    if (!this.providers) throw new AevorenBotError("MODEL_NOT_CONFIGURED");
    return this.providers.createProvider(selection);
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

function mentionsAnotherRoomPeer(body: string, executorBotId: string, roster: readonly RoomPeer[]): boolean {
  return roster.some((peer) => peer.id !== executorBotId && peer.name.trim().length > 0 && body.includes(peer.name.trim()));
}

function closeIterator(iterator: AsyncIterator<ModelEvent> | null): void {
  if (!iterator?.return) return;
  try {
    void Promise.resolve(iterator.return()).catch(() => undefined);
  } catch {
    // Provider cleanup is best-effort and must never replace the persisted result.
  }
}

function nextModelEvent(
  iterator: AsyncIterator<ModelEvent>,
  signal: AbortSignal,
  shouldInterrupt: () => boolean,
): Promise<IteratorResult<ModelEvent>> {
  if (signal.aborted && shouldInterrupt()) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled || !shouldInterrupt()) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void Promise.resolve(iterator.next()).then(
      (result) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function isTerminalTranscript(status: TranscriptStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
