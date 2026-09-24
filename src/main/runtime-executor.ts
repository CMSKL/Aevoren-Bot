import type {
  AppError,
  Bot,
  CapabilityPromptSnapshot,
  ExecutionEvidenceReceipt,
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
    description?: string;
    membershipVersion: number;
    sourceTurnId: string;
    roster?: RoomPeer[];
    orchestrationEnabled?: boolean;
  };
  incomingHandoff?: ModelRunContext["incomingHandoff"];
  executionReceipt?: ExecutionEvidenceReceipt;
  onRunCreated?(run: RuntimeRun): void;
  onDispatchStart?(): void;
  onProviderStarted?(requestId: string): void;
  onHandoff?(event: Extract<ModelEvent, { type: "handoff" }>): boolean | void;
};

export type RuntimeExecutionResult = {
  run: RuntimeRun;
  error?: AppError;
  handoffError?: AppError;
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
  fixedRoomRouting: boolean;
  evidenceCorrectionAttempts: number;
  providerContext: ModelRunContext;
  executorBotName: string;
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
  handoffError: AppError | null;
  evidenceRequestText: string;
  rootRequirements: string;
  maxWorkspaceWrites: number | null;
  maxToolRounds: number;
  maxTextMeasures: number | null;
  completeAfterSuccessfulWorkspaceWrite: boolean;
  forceCompleteAfterToolRound: boolean;
  requiredMeasurementRanges: Array<{ min: number; max: number }>;
};

export const STALE_AFTER_MS = 30_000;
const DELTA_FLUSH_MS = 50;
const DELTA_FLUSH_CHARS = 512;
const SHUTDOWN_DRAIN_MS = 2_000;
const MAX_TOOL_ROUNDS = 16;
const MAX_MEASUREMENT_TOOL_ROUNDS = 32;
const CONTENT_TEAM_ROLES = new Set(["情报侦察员", "选题策划师", "内容主笔", "事实编辑", "数据复盘师"]);

function claimsWorkspaceRead(body: string): boolean {
  return /(?:已|已经|成功|完成|真实).{0,16}(?:读取|打开|解析).{0,32}(?:文件|CSV|工作区)|(?:文件|CSV).{0,16}(?:已读取|读取成功)|(?:workspace_read).{0,20}(?:成功|完成|已调用)|\b(?:file|csv|draft|brief|profile)\s+(?:was\s+)?read\b|\b(?:loaded|parsed)\s+(?:the\s+)?(?:file|csv)\b/iu.test(body);
}

function claimsRemoteEvidence(body: string): boolean {
  return /(?:已|已经|成功|完成|真实).{0,16}(?:抓取|访问|联网搜索|核验).{0,32}(?:网页|页面|链接|来源)|(?:web_fetch|web_search).{0,20}(?:成功|完成|已调用)|\b(?:fetched|verified)\s+(?:the\s+)?(?:page|url|source)\b/iu.test(body);
}

function claimsWorkspaceWrite(body: string): boolean {
  return /(?:已|已经|成功|完成|真实).{0,16}(?:写入|保存|落盘|生成).{0,32}(?:文件|Markdown|工作区|草稿|审校稿|Brief|报告)|(?:文件|Markdown|草稿|审校稿|Brief|报告).{0,20}(?:已|已经|成功|完成|真实).{0,8}(?:写入|保存|落盘|生成)|(?:workspace_write).{0,20}(?:成功|完成|已调用)|\b(?:wrote|saved|created)\s+(?:the\s+)?(?:file|markdown|draft|brief|report)\b/iu.test(body);
}

function requestsCsvAnalysis(value: string): boolean {
  return /csv/iu.test(value) && /分析|计算|汇总|复盘|指标|浏览|互动|转化|engagement|analyse|analyze|calculate|metrics?/iu.test(value);
}

function containsDataConclusion(body: string): boolean {
  return /(?:总计|合计|总浏览|总互动|均值|平均|最高|最低|加权|互动率|转化率|浏览量|互动量|engagement|average|highest|lowest|total).{0,40}\d|\d+(?:\.\d+)?%/iu.test(body);
}

function requestsExactMeasurement(value: string): boolean {
  return /字符数|字数|非空白字符|长度|word count|character count/iu.test(value);
}

function requiresToolCall(value: string): boolean {
  const explicitlyNoTools = /(?:不要|不得|禁止|无需|不需要|不允许).{0,20}(?:调用工具|读取|抓取|搜索|写入)|(?:do not|don't|must not).{0,20}(?:use tools?|read|fetch|search|write)/iu.test(value);
  if (explicitlyNoTools) return false;
  return /(?:请|需要|必须|先|重新|实际|真实).{0,24}(?:读取|打开|解析|列出|搜索|抓取|访问|核验|写入|保存|计算|统计)|\b(?:read|fetch|search|verify|write|save|calculate|measure)\b|https?:\/\/|\.csv\b/iu.test(value);
}

function requiredToolNames(value: string): string[] {
  const names = new Set<string>();
  if (/https?:\/\/|抓取|访问网页|web_fetch/iu.test(value)) names.add("web_fetch");
  if (/workspace_read|读取.{0,24}(?:文件|CSV|Brief|草稿|voice)|read.{0,24}(?:file|csv|brief|draft)/iu.test(value)) names.add("workspace_read");
  if (/workspace_write|写入|落盘|(?:保存|创建|新建).{0,24}(?:文件|Markdown|CSV|[^\s，。；]+\.(?:md|csv))|write.{0,24}(?:file|markdown|csv)/iu.test(value)) names.add("workspace_write");
  if (requestsExactMeasurement(value) || /text_measure/iu.test(value)) names.add("text_measure");
  return [...names];
}

function requestsNetworkTools(value: string): boolean {
  return /https?:\/\/|web_(?:fetch|search)|联网|网页|公开来源|来源 URL|抓取|网络搜索|检索公开|fetch|search the web/iu.test(value);
}

function requestsMcpTools(value: string): boolean {
  return /\bMCP\b|连接器|connector/iu.test(value);
}

function requestsDeviceTools(value: string): boolean {
  return /clipboard|剪贴板/iu.test(value);
}

function containsMeasurementConclusion(body: string): boolean {
  return /\d+\s*(?:个)?(?:非空白字符|字符|字|词|bytes?|行)|(?:字符数|字数|非空白字符|长度|word count|character count).{0,24}\d/iu.test(body);
}

function configuredWorkspaceWriteLimit(instructions: string): number | null {
  if (/CSV.{0,120}(?:最终)?报告.{0,80}各一个|CSV.{0,80}(?:and|与).{0,40}report.{0,80}(?:one|各一)/iu.test(instructions)) return 2;
  if (/每次任务只创建.{0,40}一个|只创建.{0,40}(?:一个|唯一)|唯一\s*Brief|一个正式(?:线索|草稿|审校|文件)/iu.test(instructions)) return 1;
  return null;
}

function configuredTextMeasureLimit(bot: Bot): number | null {
  return bot.name === "内容主笔" ? 6 : null;
}

function requiredMeasurementRanges(bot: Bot, request: string): Array<{ min: number; max: number }> {
  if (bot.name !== "事实编辑") return [];
  // Do not treat UUID/path fragments such as `a281-46c4` as text-length
  // requirements. A range must have a semantic length/version label before
  // it or an explicit unit after it.
  const labelled = [...request.matchAll(/(?:短帖|展开版|短版|长版|短文|长文|正文|版本|字符数|字数|长度|非空白字符|word count|character count|range)[^\d\r\n]{0,24}(\d{1,6})\s*[–—-]\s*(\d{1,6})/giu)];
  const unitBound = [...request.matchAll(/(\d{1,6})\s*[–—-]\s*(\d{1,6})\s*(?:个)?(?:非空白字符|字符|字|词|words?|characters?)/giu)];
  const ranges = [...labelled, ...unitBound]
    .map((match) => ({ min: Number(match[1]), max: Number(match[2]) }))
    .filter((range) => Number.isInteger(range.min) && Number.isInteger(range.max) && range.min >= 0 && range.max > range.min && range.max <= 1_000_000);
  return [...new Map(ranges.map((range) => [`${range.min}:${range.max}`, range])).values()];
}

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
            roomDescription: input.room.description ?? "",
            roomMembershipVersion: input.room.membershipVersion,
            sourceTurnId: input.room.sourceTurnId,
            orchestrationEnabled: input.room.orchestrationEnabled,
            ...(input.room.roster ? { roomRoster: input.room.roster } : {}),
            ...(input.incomingHandoff ? { handoff: input.incomingHandoff } : {}),
            ...(input.executionReceipt ? { executionReceipt: input.executionReceipt } : {}),
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
    const evidenceRequestText = input.incomingHandoff?.task ?? user.body;
    const rootRequirements = input.executionReceipt?.taskRequirements.text ?? user.body;
    const evidenceToolNames = new Set(input.room && !input.incomingHandoff ? [] : requiredToolNames(evidenceRequestText));
    if (input.executionReceipt?.artifacts.length) evidenceToolNames.add("workspace_read");
    if (bot.name === "事实编辑" && /审校|审查|review/iu.test(evidenceRequestText)) {
      evidenceToolNames.add("workspace_write");
    }
    const isScopedHandoff = Boolean(input.incomingHandoff);
    const allowNetworkTools = providerCapabilities?.networkTools === true && (!isScopedHandoff || requestsNetworkTools(evidenceRequestText));
    const allowMcpTools = providerCapabilities?.networkTools === true && (!isScopedHandoff || requestsMcpTools(evidenceRequestText));
    const allowDeviceTools = providerCapabilities?.networkTools === true && (!isScopedHandoff || requestsDeviceTools(evidenceRequestText));
    if (/text_measure/iu.test(bot.instructions) && /写|草稿|审校|长度|draft|review/iu.test(evidenceRequestText)) {
      evidenceToolNames.add("text_measure");
    }
    if (input.room?.orchestrationEnabled) {
      const requiredByRole: Record<string, string[]> = {
        情报侦察员: ["web_fetch", "workspace_write"],
        选题策划师: ["workspace_read", "workspace_write"],
        内容主笔: ["workspace_read", "text_measure", "workspace_write"],
        事实编辑: ["workspace_read", "web_fetch", "text_measure", "workspace_write"],
        数据复盘师: ["workspace_read", "workspace_write"],
      };
      for (const name of requiredByRole[bot.name] ?? []) evidenceToolNames.add(name);
    }
    const active: ActiveRun = {
      controller: new AbortController(),
      runId: run.id,
      clientNonce: input.clientNonce,
      sessionId: session.id,
      messages: prompt.messages,
      modelSelection,
      attribution: input.attribution,
      fixedRoomRouting: input.room?.orchestrationEnabled === false,
      evidenceCorrectionAttempts: 0,
      providerContext: {
        executorBotId: bot.id,
        executionKey: input.executionKey,
        ...(input.room ? { roomId: input.room.id, sourceTurnId: input.room.sourceTurnId } : {}),
        ...(input.room?.roster ? { roomRoster: input.room.roster } : {}),
        ...(input.incomingHandoff ? { incomingHandoff: input.incomingHandoff } : {}),
        ...(input.executionReceipt ? { executionReceipt: input.executionReceipt } : {}),
        workspaces: providerCapabilities?.workspaceTools === true
          ? this.repository.listWorkspaces().map(({ id, name, writeEnabled, automationEnabled }) => ({ id, name, writeEnabled, automationEnabled }))
          : [],
        networkTools: allowNetworkTools,
        mcpTools: allowMcpTools ? this.mcpTools?.availableTools(bot.id) ?? [] : [],
        deviceTools: allowDeviceTools,
        requireToolCall: requiresToolCall(evidenceRequestText) || Boolean(input.executionReceipt?.artifacts.length),
        textMeasureTools: evidenceToolNames.has("text_measure"),
        requiredToolNames: [...evidenceToolNames],
      },
      executorBotName: bot.name,
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
      handoffError: null,
      evidenceRequestText,
      rootRequirements,
      maxWorkspaceWrites: configuredWorkspaceWriteLimit(bot.instructions),
      maxToolRounds: requestsExactMeasurement(evidenceRequestText) ? MAX_MEASUREMENT_TOOL_ROUNDS : MAX_TOOL_ROUNDS,
      maxTextMeasures: configuredTextMeasureLimit(bot),
      completeAfterSuccessfulWorkspaceWrite: bot.name === "选题策划师" && (Boolean(input.onHandoff) || isWaitingForHumanApproval(evidenceRequestText, "")),
      forceCompleteAfterToolRound: false,
      requiredMeasurementRanges: requiredMeasurementRanges(bot, `${rootRequirements}\n${evidenceRequestText}`),
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
      const pendingHandoffs = new Map<string, Extract<ModelEvent, { type: "handoff" }>>();
      while (!completed) {
        const roundActions: Array<
          | { kind: "handoff"; event: Extract<ModelEvent, { type: "handoff" }> }
          | { kind: "tool"; call: Extract<ChatMessage, { role: "assistant" }>["tool_calls"][number]; result: Extract<ChatMessage, { role: "tool" }> }
        > = [];
        let roundToolCount = 0;
        let roundCompleted = false;
        let roundProviderStarted = false;
        let rejectedFixedHandoff = false;
        let retryAfterEvidenceRepair = false;
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
          if (!active.providerStarted) throw new AevorenBotError("RUNTIME_STATE_INVALID");
          if (!active.onHandoff) {
            if (!active.fixedRoomRouting) throw new AevorenBotError("RUNTIME_STATE_INVALID");
            if (roundToolCount === 0) {
              if (toolRounds >= active.maxToolRounds) throw new AevorenBotError("TOOL_ROUND_LIMIT_EXCEEDED");
              toolRounds += 1;
            }
            roundToolCount += 1;
            rejectedFixedHandoff = true;
            roundActions.push({
              kind: "tool",
              call: {
                id: event.toolCallId,
                type: "function",
                function: {
                  name: "handoff_to_agent",
                  arguments: JSON.stringify({
                    toAgentId: event.toAgentId,
                    task: event.task,
                    contextRefs: event.contextRefs,
                    visibility: event.visibility,
                  }),
                },
              },
              result: {
                role: "tool",
                tool_call_id: event.toolCallId,
                content: JSON.stringify({
                  ok: false,
                  code: "ROOM_HANDOFF_DISABLED",
                  safeMessage: "当前是固定响应模式，本回合不能转交其他 Bot。请完成自己的回复，不要声称其他 Bot 已接力。",
                }),
              },
            });
            run = this.repository.touchRuntimeRun(runId);
            this.emitRuntime(run);
            this.armStaleTimer(active);
            continue;
          }
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
          const previous = pendingHandoffs.get(event.toolCallId);
          if (previous && JSON.stringify(previous) !== JSON.stringify(event)) throw new AevorenBotError("MODEL_HANDOFF_INVALID");
          pendingHandoffs.set(event.toolCallId, event);
          roundActions.push({ kind: "handoff", event });
          run = this.repository.touchRuntimeRun(runId);
          this.emitRuntime(run);
          this.armStaleTimer(active);
          continue;
        }
        if (event.type === "tool-rejection") {
          if (!active.providerStarted) throw new AevorenBotError("RUNTIME_STATE_INVALID");
          if (roundToolCount === 0) {
            if (toolRounds >= active.maxToolRounds) throw new AevorenBotError("TOOL_ROUND_LIMIT_EXCEEDED");
            toolRounds += 1;
          }
          roundToolCount += 1;
          roundActions.push({
            kind: "tool",
            call: {
              id: event.toolCallId,
              type: "function",
              function: { name: event.providerToolName, arguments: event.arguments },
            },
            result: {
              role: "tool",
              tool_call_id: event.toolCallId,
              content: JSON.stringify({ ok: false, code: event.code, safeMessage: event.safeMessage }),
            },
          });
          run = this.repository.touchRuntimeRun(runId);
          this.emitRuntime(run);
          this.armStaleTimer(active);
          continue;
        }
        if (event.type === "workspace-tool" || event.type === "network-tool" || event.type === "mcp-tool" || event.type === "device-tool" || event.type === "computation-tool") {
          if (!active.providerStarted || !this.workspaceTools) throw new AevorenBotError("RUNTIME_STATE_INVALID");
          if (active.forceCompleteAfterToolRound) {
            roundToolCount += 1;
            const functionName = event.providerToolName ?? event.tool.kind.replaceAll("-", "_");
            const argumentsValue = Object.fromEntries(Object.entries(event.tool).filter(([key]) => key !== "kind"));
            roundActions.push({
              kind: "tool",
              call: {
                id: event.toolCallId,
                type: "function",
                function: { name: functionName, arguments: JSON.stringify(argumentsValue) },
              },
              result: {
                role: "tool",
                tool_call_id: event.toolCallId,
                content: JSON.stringify({
                  ok: false,
                  code: "TASK_STAGE_ALREADY_COMPLETE",
                  safeMessage: "Brief 已成功写入，本阶段已经完成。后续工具调用已停止，等待用户批准。",
                }),
              },
            });
            continue;
          }
          if (event.type === "workspace-tool" && event.tool.kind === "workspace-write" && active.executorBotName === "数据复盘师") {
            const validation = this.validateCsvReport(active, event.tool.content);
            if (!validation.ok) {
              if (roundToolCount === 0) {
                if (toolRounds >= active.maxToolRounds) throw new AevorenBotError("TOOL_ROUND_LIMIT_EXCEEDED");
                toolRounds += 1;
              }
              roundToolCount += 1;
              roundActions.push({
                kind: "tool",
                call: {
                  id: event.toolCallId,
                  type: "function",
                  function: { name: event.providerToolName ?? "workspace_write", arguments: JSON.stringify({ workspaceId: event.tool.workspaceId, path: event.tool.path, content: event.tool.content }) },
                },
                result: {
                  role: "tool",
                  tool_call_id: event.toolCallId,
                  content: JSON.stringify({
                    ok: false,
                    code: "DATA_SUMMARY_MISMATCH",
                    safeMessage: validation.reason,
                    expectedMetrics: validation.expected,
                  }),
                },
              });
              continue;
            }
          }
          if (event.type === "workspace-tool" && event.tool.kind === "workspace-write" && active.requiredMeasurementRanges.length > 0) {
            const measuredValues = this.repository.listToolInvocations(active.sessionId)
              .filter((invocation) => invocation.runtimeRunId === active.runId && invocation.toolKind === "text-measure" && invocation.state === "succeeded")
              .map((invocation) => Number(invocation.resultMetadata?.nonWhitespaceCharacters))
              .filter(Number.isFinite);
            const missingRanges = active.requiredMeasurementRanges.filter((range) => !measuredValues.some((value) => value >= range.min && value <= range.max));
            if (missingRanges.length > 0) {
              if (roundToolCount === 0) {
                if (toolRounds >= active.maxToolRounds) throw new AevorenBotError("TOOL_ROUND_LIMIT_EXCEEDED");
                toolRounds += 1;
              }
              roundToolCount += 1;
              const argumentsValue = Object.fromEntries(Object.entries(event.tool).filter(([key]) => key !== "kind"));
              roundActions.push({
                kind: "tool",
                call: {
                  id: event.toolCallId,
                  type: "function",
                  function: { name: event.providerToolName ?? "workspace_write", arguments: JSON.stringify(argumentsValue) },
                },
                result: {
                  role: "tool",
                  tool_call_id: event.toolCallId,
                  content: JSON.stringify({
                    ok: false,
                    code: "MEASUREMENT_RANGE_NOT_SATISFIED",
                    safeMessage: "正式审校稿写入前，所有长度区间都必须有当前 Runtime 的 text_measure 成功结果。请修订缺失版本、重新测量，再尝试写入。",
                    measuredNonWhitespaceCharacters: measuredValues,
                    missingRanges,
                  }),
                },
              });
              run = this.repository.touchRuntimeRun(runId);
              this.emitRuntime(run);
              this.armStaleTimer(active);
              continue;
            }
          }
          if (event.type === "workspace-tool" && event.tool.kind === "workspace-write") {
            this.assertReceiptReads(active);
            if (active.executorBotName === "数据复盘师") {
              const hasCsv = this.repository.listToolInvocations(active.sessionId).some((tool) =>
                tool.runtimeRunId === active.runId && tool.toolKind === "workspace-read" && tool.state === "succeeded" &&
                tool.targetPath.toLowerCase().endsWith(".csv") && tool.resultMetadata?.truncated === false,
              );
              if (!hasCsv) throw new AevorenBotError("DATA_EVIDENCE_REQUIRED", undefined, true, { requirement: "csv-read-before-report-write" });
            }
            const alreadyProduced = this.repository.listToolInvocations(active.sessionId).some((invocation) => (
              invocation.toolKind === "workspace-write" &&
              invocation.state === "succeeded" &&
              invocation.workspaceId === event.tool.workspaceId &&
              invocation.targetPath === event.tool.path
            ));
            if (alreadyProduced) {
              if (roundToolCount === 0) {
                if (toolRounds >= active.maxToolRounds) throw new AevorenBotError("TOOL_ROUND_LIMIT_EXCEEDED");
                toolRounds += 1;
              }
              roundToolCount += 1;
              const argumentsValue = Object.fromEntries(Object.entries(event.tool).filter(([key]) => key !== "kind"));
              roundActions.push({
                kind: "tool",
                call: {
                  id: event.toolCallId,
                  type: "function",
                  function: { name: event.providerToolName ?? "workspace_write", arguments: JSON.stringify(argumentsValue) },
                },
                result: {
                  role: "tool",
                  tool_call_id: event.toolCallId,
                  content: JSON.stringify({
                    ok: false,
                    code: "WORKSPACE_ARTIFACT_ALREADY_EXISTS",
                    safeMessage: "该路径已有成功写入的权威工件。不得重写；请使用 workspace_read 读取后继续当前阶段。",
                  }),
                },
              });
              run = this.repository.touchRuntimeRun(runId);
              this.emitRuntime(run);
              this.armStaleTimer(active);
              continue;
            }
          }
          if (event.type === "computation-tool" && event.tool.kind === "text-measure" && active.maxTextMeasures !== null) {
            const succeededMeasures = this.repository.listToolInvocations(active.sessionId).filter((invocation) => (
              invocation.runtimeRunId === active.runId &&
              invocation.toolKind === "text-measure" &&
              invocation.state === "succeeded"
            )).length;
            if (succeededMeasures >= active.maxTextMeasures) {
              if (roundToolCount === 0) {
                if (toolRounds >= active.maxToolRounds) throw new AevorenBotError("TOOL_ROUND_LIMIT_EXCEEDED");
                toolRounds += 1;
              }
              roundToolCount += 1;
              roundActions.push({
                kind: "tool",
                call: {
                  id: event.toolCallId,
                  type: "function",
                  function: { name: event.providerToolName ?? "text_measure", arguments: JSON.stringify({ text: event.tool.text }) },
                },
                result: {
                  role: "tool",
                  tool_call_id: event.toolCallId,
                  content: JSON.stringify({
                    ok: false,
                    code: "TEXT_MEASURE_DRAFT_LIMIT_REACHED",
                    safeMessage: "主笔阶段已完成 6 次真实测量。请将当前最佳版本写入唯一草稿并转交事实编辑；最终长度收敛由事实编辑完成。",
                  }),
                },
              });
              run = this.repository.touchRuntimeRun(runId);
              this.emitRuntime(run);
              this.armStaleTimer(active);
              continue;
            }
          }
          if (event.type === "workspace-tool" && event.tool.kind === "workspace-write" && active.maxWorkspaceWrites !== null) {
            const succeededWrites = this.repository.listToolInvocations(active.sessionId).filter((invocation) => (
              invocation.runtimeRunId === active.runId &&
              invocation.toolKind === "workspace-write" &&
              invocation.state === "succeeded"
            )).length;
            if (succeededWrites >= active.maxWorkspaceWrites) {
              if (roundToolCount === 0) {
                if (toolRounds >= active.maxToolRounds) throw new AevorenBotError("TOOL_ROUND_LIMIT_EXCEEDED");
                toolRounds += 1;
              }
              roundToolCount += 1;
              const argumentsValue = Object.fromEntries(Object.entries(event.tool).filter(([key]) => key !== "kind"));
              roundActions.push({
                kind: "tool",
                call: {
                  id: event.toolCallId,
                  type: "function",
                  function: { name: event.providerToolName ?? "workspace_write", arguments: JSON.stringify(argumentsValue) },
                },
                result: {
                  role: "tool",
                  tool_call_id: event.toolCallId,
                  content: JSON.stringify({
                    ok: false,
                    code: "WORKSPACE_WRITE_LIMIT_REACHED",
                    safeMessage: `本阶段已完成 ${active.maxWorkspaceWrites} 个正式文件写入。请停止额外写入并继续下一阶段或结束。`,
                  }),
                },
              });
              run = this.repository.touchRuntimeRun(runId);
              this.emitRuntime(run);
              this.armStaleTimer(active);
              continue;
            }
          }
          if (!event.respond && roundToolCount === 0) {
            if (toolRounds >= active.maxToolRounds) throw new AevorenBotError("TOOL_ROUND_LIMIT_EXCEEDED");
            toolRounds += 1;
          }
          roundToolCount += 1;
          const outcome = await this.workspaceTools.requestAndWait(
            runId,
            event.toolCallId,
            event.tool,
            active.controller.signal,
          );
          let providerOutcomeContent = outcome.content;
          if (event.type === "computation-tool" && event.tool.kind === "text-measure" && active.requiredMeasurementRanges.length > 0) {
            const measuredValues = this.repository.listToolInvocations(active.sessionId)
              .filter((invocation) => invocation.runtimeRunId === active.runId && invocation.toolKind === "text-measure" && invocation.state === "succeeded")
              .map((invocation) => Number(invocation.resultMetadata?.nonWhitespaceCharacters))
              .filter(Number.isFinite);
            const missingRanges = active.requiredMeasurementRanges.filter((range) => !measuredValues.some((value) => value >= range.min && value <= range.max));
            try {
              const parsedOutcome = JSON.parse(outcome.content) as Record<string, unknown>;
              providerOutcomeContent = JSON.stringify({
                ...parsedOutcome,
                acceptance: {
                  requiredRanges: active.requiredMeasurementRanges,
                  measuredNonWhitespaceCharacters: measuredValues,
                  missingRanges,
                  nextAction: missingRanges.length > 0
                    ? `仍缺少 ${missingRanges.map((range) => `${range.min}-${range.max}`).join("、")} 区间的独立文本。请创建对应版本并调用 text_measure；不要重复测量未变化的文本。`
                    : "所有长度区间已由真实测量命中。立即停止测量并调用 workspace_write 写入正式审校稿。",
                },
              });
            } catch {
              // The executor owns the canonical failure response; leave it unchanged if it is not JSON.
            }
          }
          if (
            event.type === "workspace-tool" &&
            event.tool.kind === "workspace-write" &&
            event.tool.path.startsWith("02-briefs/") &&
            active.completeAfterSuccessfulWorkspaceWrite &&
            toolOutcomeSucceeded(outcome.content)
          ) {
            active.forceCompleteAfterToolRound = true;
          }
          if (event.respond) {
            await event.respond(providerOutcomeContent);
            run = this.repository.touchRuntimeRun(runId);
            this.emitRuntime(run);
            this.armStaleTimer(active);
            continue;
          }
          const functionName = event.providerToolName ?? event.tool.kind.replaceAll("-", "_");
          const argumentsValue = Object.fromEntries(Object.entries(event.tool).filter(([key]) => key !== "kind"));
          roundActions.push({
            kind: "tool",
            call: {
              id: event.toolCallId,
              type: "function",
              function: { name: functionName, arguments: JSON.stringify(argumentsValue) },
            },
            result: { role: "tool", tool_call_id: outcome.toolCallId, content: providerOutcomeContent },
          });
          run = this.repository.touchRuntimeRun(runId);
          this.emitRuntime(run);
          this.armStaleTimer(active);
          continue;
        }
        if (event.type === "completed") {
          roundCompleted = true;
          if (active.forceCompleteAfterToolRound) {
            const status = "已完成唯一 Brief 写入，当前等待人工选题批准。";
            active.providerBody = `${active.providerBody.trimEnd()}${active.providerBody.trim().length > 0 ? "\n\n" : ""}${status}`;
            active.body = active.attribution ? sanitizeRoomSpeakerOutput(active.providerBody, true) : active.providerBody;
            this.assertToolEvidence(active);
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
          const toolActions = roundActions.filter((action) => action.kind === "tool");
          if (toolActions.length > 0) {
            const protocolActions = roundActions.map((action) => action.kind === "tool"
              ? action
              : {
                  kind: "tool" as const,
                  call: {
                    id: action.event.toolCallId,
                    type: "function" as const,
                    function: {
                      name: "handoff_to_agent",
                      arguments: JSON.stringify({
                        toAgentId: action.event.toAgentId,
                        task: action.event.task,
                        contextRefs: action.event.contextRefs,
                        visibility: action.event.visibility,
                      }),
                    },
                  },
                  result: {
                    role: "tool" as const,
                    tool_call_id: action.event.toolCallId,
                    content: JSON.stringify({ ok: true, accepted: false, status: "deferred-until-source-completed" }),
                  },
                });
            active.messages.push({
              role: "assistant",
              content: active.providerBody.slice(roundBodyStart),
              tool_calls: protocolActions.map((action) => action.call),
            });
            active.messages.push(...protocolActions.map((action) => action.result));
            if (rejectedFixedHandoff) {
              active.providerBody = active.providerBody.slice(0, roundBodyStart);
              active.body = active.attribution
                ? sanitizeRoomSpeakerOutput(active.providerBody, true)
                : active.providerBody;
              this.flush(active, "streaming");
            }
            break;
          }
          try {
            this.assertToolEvidence(active);
          } catch (error) {
            const appError = asAppError(error);
            if (!active.fixedRoomRouting || appError.code !== "TOOL_EVIDENCE_REQUIRED" || active.evidenceCorrectionAttempts >= 1) {
              throw error;
            }
            active.evidenceCorrectionAttempts += 1;
            active.messages.push({ role: "assistant", content: active.providerBody.slice(roundBodyStart) });
            active.messages.push({
              role: "system",
              content: JSON.stringify({
                notice: "FIXED_ROOM_EVIDENCE_REPAIR",
                reason: "The preceding draft claimed a tool action without a matching successful Tool Journal record in this Runtime.",
                rules: [
                  "Do not repeat or imply that unverified action succeeded.",
                  "If the current request needs a file, network, or other tool result and the tool is available, perform that action now and rely only on its successful result.",
                  "If the source, permission, or tool is unavailable, explicitly state that the action was not completed and identify the missing input or authorization.",
                ],
              }),
            });
            active.providerBody = active.providerBody.slice(0, roundBodyStart);
            active.body = active.attribution
              ? sanitizeRoomSpeakerOutput(active.providerBody, true)
              : active.providerBody;
            this.flush(active, "streaming");
            retryAfterEvidenceRepair = true;
            break;
          }
          // A provider can still fail after announcing a handoff. Only commit its
          // successor after the complete source result and tool evidence passed.
          for (const handoff of pendingHandoffs.values()) {
            const accepted = active.onHandoff?.(handoff) !== false;
            active.handoffEmitted = accepted || active.handoffEmitted;
          }
          pendingHandoffs.clear();
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
        if (retryAfterEvidenceRepair) continue;
        if (!roundCompleted) throw new AevorenBotError("MODEL_STREAM_TRUNCATED");
      }
      const current = this.repository.getRuntimeRun(runId);
      if (!["completed", "failed", "cancelled", "interrupted"].includes(current.state)) {
        throw new AevorenBotError("MODEL_STREAM_TRUNCATED");
      }
      return {
        run: current,
        ...(active.handoffError ? { handoffError: active.handoffError } : {}),
        providerStarted: active.providerStarted,
      };
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

  private assertToolEvidence(active: ActiveRun): void {
    this.assertReceiptReads(active);
    const succeeded = this.repository.listToolInvocations(active.sessionId)
      .filter((invocation) => invocation.runtimeRunId === active.runId && invocation.state === "succeeded");
    const hasKind = (...kinds: Array<(typeof succeeded)[number]["toolKind"]>): boolean =>
      succeeded.some((invocation) => kinds.includes(invocation.toolKind));
    const explicitlyUnable = /无法|未能|没有权限|尚未读取|尚未抓取|尚未写入|不能确认|unable|could not|no access|not read|not fetched|not written/iu.test(active.body);
    if (claimsWorkspaceRead(active.body) && !hasKind("workspace-read") && !explicitlyUnable) {
      throw new AevorenBotError("TOOL_EVIDENCE_REQUIRED", undefined, true, { requirement: "workspace-read" });
    }
    if (claimsRemoteEvidence(active.body) && !hasKind("web-fetch", "web-search") && !explicitlyUnable) {
      throw new AevorenBotError("TOOL_EVIDENCE_REQUIRED", undefined, true, { requirement: "network-read" });
    }
    if (claimsWorkspaceWrite(active.body) && !hasKind("workspace-write") && !explicitlyUnable) {
      throw new AevorenBotError("TOOL_EVIDENCE_REQUIRED", undefined, true, { requirement: "workspace-write" });
    }
    if (
      (active.executorBotName === "数据复盘师"
        ? requestsCsvAnalysis(active.rootRequirements)
        : !CONTENT_TEAM_ROLES.has(active.executorBotName) && requestsCsvAnalysis(active.evidenceRequestText)) &&
      containsDataConclusion(active.body) &&
      !succeeded.some((invocation) => invocation.toolKind === "workspace-read" && invocation.targetPath.toLocaleLowerCase("en-US").endsWith(".csv"))
    ) {
      throw new AevorenBotError("DATA_EVIDENCE_REQUIRED", undefined, true, { requirement: "workspace-read-csv" });
    }
    if (active.providerContext.textMeasureTools && containsMeasurementConclusion(active.body) && !hasKind("text-measure")) {
      throw new AevorenBotError("MEASUREMENT_EVIDENCE_REQUIRED", undefined, true, { requirement: "text-measure" });
    }
    if (active.providerContext.requireToolCall && succeeded.length === 0 && !explicitlyUnable) {
      throw new AevorenBotError("TOOL_EVIDENCE_REQUIRED", undefined, true, { requirement: "successful-tool-call" });
    }
  }

  private assertReceiptReads(active: ActiveRun): void {
    const receipt = active.providerContext.executionReceipt;
    if (!receipt) return;
    const required = receipt.artifacts.filter((artifact) => artifact.sourceRuntimeRunId === receipt.sourceRuntimeRunId);
    const reads = this.repository.listToolInvocations(active.sessionId).filter((tool) => (
      tool.runtimeRunId === active.runId && tool.toolKind === "workspace-read" && tool.state === "succeeded"
    ));
    for (const artifact of required) {
      if (!reads.some((read) => read.workspaceId === artifact.workspaceId && read.targetPath === artifact.path &&
        read.resultMetadata?.truncated === false && read.resultMetadata.sha256 === artifact.sha256)) {
        throw new AevorenBotError("TOOL_EVIDENCE_REQUIRED", undefined, true, { requirement: "verified-upstream-artifact-read" });
      }
    }
  }

  private validateCsvReport(active: ActiveRun, content: string):
    | { ok: true }
    | { ok: false; reason: string; expected: Record<string, number> } {
    const csvRead = this.repository.listToolInvocations(active.sessionId).toReversed().find((tool) =>
      tool.runtimeRunId === active.runId && tool.toolKind === "workspace-read" && tool.state === "succeeded" &&
      tool.targetPath.toLowerCase().endsWith(".csv") && tool.resultMetadata?.truncated === false &&
      typeof tool.resultMetadata.csvRowCount === "number" && typeof tool.resultMetadata.csvNumericSums === "string",
    );
    if (!csvRead) return { ok: false, reason: "写入复盘报告前必须完整读取 CSV 并取得 Host 计算的 csvSummary。", expected: {} };
    let sums: Record<string, number>;
    try {
      sums = JSON.parse(String(csvRead.resultMetadata!.csvNumericSums)) as Record<string, number>;
    } catch {
      return { ok: false, reason: "CSV 汇总结果无效，请重新读取真实 CSV。", expected: {} };
    }
    const expected: Record<string, number> = {};
    if (/\basset_count\b/iu.test(active.rootRequirements)) expected.asset_count = Number(csvRead.resultMetadata!.csvRowCount);
    for (const [column, sum] of Object.entries(sums)) {
      const key = `total_${column}`;
      if (active.rootRequirements.includes(key)) expected[key] = sum;
    }
    if (Object.keys(expected).length === 0) return { ok: true };
    const requestsDerivedMetrics = /(?:占比|百分比|增长率|转化率|换算|MiB|MB|GiB|GB|elapsed|percentage|ratio|conversion)/iu.test(active.rootRequirements);
    if (!requestsDerivedMetrics && /(?:≈|约\s*\d|\d+(?:\.\d+)?\s*(?:MiB|MB|GiB|GB)|\d+(?:\.\d+)?%)/u.test(content)) {
      return {
        ok: false,
        reason: "原始任务未要求单位换算、百分比或耗时推算。请删除这些心算派生值，只保留 expectedMetrics 与真实字段口径后重新写入。",
        expected,
      };
    }
    const candidates = [...content.matchAll(/```json\s*([\s\S]*?)```/giu)].flatMap((match) => {
      try {
        const parsed = JSON.parse(match[1]!) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? [parsed as Record<string, unknown>] : [];
      } catch { return []; }
    });
    const valid = candidates.some((candidate) => Object.entries(expected).every(([key, value]) => candidate[key] === value));
    return valid
      ? { ok: true }
      : { ok: false, reason: "报告中的确定性指标与 Host 从真实 CSV 计算的结果不一致。请使用 expectedMetrics 原值修正 JSON 和正文后重新写入。", expected };
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
    if (
      active.handoffEmitted ||
      !active.onHandoff ||
      !roster
    ) return null;
    const deterministic = this.contentTeamContinuation(active, roster);
    if (deterministic) {
      void this.recordHandoffShadow(active, deterministic, roster);
      return deterministic;
    }
    if (CONTENT_TEAM_ROLES.has(active.executorBotName)) return null;
    if (isWaitingForHumanApproval(active.evidenceRequestText, active.body)) return null;
    const selector = provider.selectRoomContinuation;
    if (!selector || !mentionsAnotherRoomPeer(active.body, active.providerContext.executorBotId, roster)) return null;
    try {
      const continuation = await selector.call(
        provider,
        active.body,
        active.providerContext.executorBotId,
        roster,
        active.controller.signal,
      );
      void this.recordHandoffShadow(active, continuation, roster);
      return continuation;
    } catch (error) {
      active.handoffError = asAppError(error);
      return null;
    }
  }

  private contentTeamContinuation(active: ActiveRun, roster: readonly RoomPeer[]): RoomContinuationDecision | null {
    if (["内容主笔", "事实编辑"].includes(active.executorBotName) && !active.providerContext.executionReceipt?.approvedBrief) return null;
    const transition = (() => {
      if (active.executorBotName === "情报侦察员") return { target: "选题策划师", prefix: "01-inbox/", next: "读取已验证线索和 voice.md，生成三个互斥候选并写入唯一 Brief；随后等待用户批准。" };
      if (active.executorBotName === "内容主笔") return { target: "事实编辑", prefix: "03-drafts/", next: "读取已批准 Brief、当前草稿和 voice.md，使用 web_fetch 复核公开来源，完成事实、风格与长度审校并写入唯一审校稿。" };
      if (active.executorBotName === "事实编辑" && requestsCsvAnalysis(active.rootRequirements)) return { target: "数据复盘师", prefix: "04-review/", next: "读取审校稿；只处理原始任务明确授权的 CSV。只有成功读取该 CSV 后才能写入复盘报告，并逐字采用 Host 返回的 csvSummary 指标。不得心算或追加未经用户要求和确定性工具验证的换算、占比或派生指标；没有 CSV 时明确停止。不得发布或执行任何外部写操作。" };
      return null;
    })();
    if (!transition) return null;
    const targets = roster.filter((peer) => peer.name === transition.target);
    if (targets.length !== 1) return null;
    const target = targets[0]!;
    const writes = this.repository.listToolInvocations(active.sessionId).filter((invocation) => (
      invocation.runtimeRunId === active.runId &&
      invocation.toolKind === "workspace-write" &&
      invocation.state === "succeeded" &&
      invocation.workspaceId !== null &&
      invocation.targetPath.startsWith(transition.prefix)
    ));
    const artifact = writes.at(-1);
    if (!artifact?.workspaceId) return null;
    return {
      action: "handoff",
      toAgentId: target.id,
      task: `当前阶段任务：先使用 workspace_read 读取 workspaceId=${artifact.workspaceId} path=${artifact.targetPath}。${transition.next} 使用交接凭证中的原始任务确定本阶段输出路径与要求。其他阶段的批准或停止规则仅在对应阶段生效；不要重复执行上游任务。`,
      contextRefs: [],
      visibility: "room",
      reason: `${active.executorBotName} 已产生 ${artifact.targetPath}，按内容团队规则进入 ${transition.target}。`,
    };
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

function isWaitingForHumanApproval(request: string, body: string): boolean {
  const combined = `${request}\n${body}`;
  const explicitlyApproved = /\bAPPROVED\b|(?:我|用户)?(?:已|明确)?批准(?:候选|选题|方案|第)|选择.{0,8}(?:候选|选题|方案|第)/iu.test(request);
  if (explicitlyApproved) return false;
  return /(?:等待|待)(?:用户|人工|人类).{0,16}(?:批准|审批|确认|选择)|(?:用户|人工|人类).{0,16}(?:门禁|批准|审批).{0,16}(?:等待|待定|pending)|WAITING_(?:TOPIC_)?APPROVAL|HUMAN_(?:TOPIC_)?APPROVAL/iu.test(combined);
}

function toolOutcomeSucceeded(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as { ok?: unknown };
    return parsed.ok === true;
  } catch {
    return false;
  }
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
