import type {
  AppError,
  Bot,
  CapabilityPromptSnapshot,
  ExecutionEvidenceReceipt,
  ModelSelection,
  RuntimeEvent,
  RuntimeRoute,
  RuntimeRun,
  RoomRunSummary,
  RoomTurnPurpose,
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
  isDirectLeadConversationRequest,
  type ChatMessage,
  type ModelEvent,
  type ModelProvider,
  type ModelRunContext,
  type RoomPeer,
  type RoomContinuationDecision,
  type RoomOwnerSelection,
  type RoomLeadPlan,
} from "./model";
import { buildPrompt } from "./prompt";
import type { ProviderResolver } from "./providers/contracts";
import type { WorkspaceToolCoordinator } from "./workspace-tool-coordinator";
import type { McpService } from "./mcp-service";
import { choiceQuestion, type DecisionService } from "./decision-service";
import type { MemoryCaptureService } from "./memory-capture-service";
import { requestedReadPaths } from "./workspace-read-requirements";
import { requestedWritePaths } from "./workspace-write-requirements";
import { workspaceRelativePathSchema } from "@shared/schemas";

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
    leadBotId?: string | null;
    turnPurpose?: RoomTurnPurpose;
    maxAssignments?: number;
    runSummary?: RoomRunSummary;
  };
  incomingHandoff?: ModelRunContext["incomingHandoff"];
  executionReceipt?: ExecutionEvidenceReceipt;
  onRunCreated?(run: RuntimeRun): void;
  onDispatchStart?(): void;
  onProviderStarted?(requestId: string): void;
  onHandoff?(event: Extract<ModelEvent, { type: "handoff" }>): boolean | void;
  onLeadPlan?(plan: RoomLeadPlan): void;
};

export type RuntimeExecutionResult = {
  run: RuntimeRun;
  error?: AppError;
  handoffError?: AppError;
  providerStarted: boolean;
};

export type CapabilitySnapshotSource = {
  forPrompt(botId: string, selection: ModelSelection, room: boolean, sessionId?: string): CapabilityPromptSnapshot;
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
  turnPurpose: RoomTurnPurpose;
  maxAssignments: number;
  onLeadPlan?: RuntimeExecutionInput["onLeadPlan"];
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
  summaryMissingRequirements: string[];
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
const ROOM_LEAD_PLAN_TIMEOUT_MS = 30_000;
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

function coordinationProseForEvidence(body: string): string {
  return body.replace(/```([a-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/giu, (block, language: string, source: string) => {
    if (/^(?:javascript|typescript|js|ts|python|py|bash|sh|sql)$/iu.test(language)) return "\n（代码引用）\n";
    if (language && language.toLowerCase() !== "json") return block;
    try {
      const value: unknown = JSON.parse(source);
      if (!value || typeof value !== "object" || Array.isArray(value)) return block;
      const plan = value as Record<string, unknown>;
      if (!Array.isArray(plan.assignments) || !plan.assignments.every((assignment) => assignment &&
        typeof assignment === "object" && !Array.isArray(assignment) && typeof assignment.task === "string")) return block;
      // Only task instructions inside an explicit plan are quotations. Keep all
      // other fields and surrounding prose subject to the completion-claim guard.
      return JSON.stringify({ ...plan, assignments: plan.assignments.map((assignment: Record<string, unknown>) => ({
        ...assignment, task: "（待执行的成员任务引用）",
      })) }, null, 2);
    } catch { return block; }
  });
}

function claimsCompletedCoordinationAction(body: string): boolean {
  // A plan can contain imperative tool steps and conditional completion. Inspect
  // each predicate, never let another sentence's "not completed" waive a claim.
  const text = coordinationProseForEvidence(body).replace(/`([^`\n]+)`/gu, (_quoted, value: string) => /\.[a-z]{1,10}$/iu.test(value) ? "文件" : value)
    .replace(/\b(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:md|csv|txt|json|pdf|html?)\b/giu, "file")
    .replace(/\*\*|__/gu, "");
  const clauses = text.split(/[\n。！？!?；;，,]+|\.(?=\s|$)|但是|不过|然而|但|并且|而且|并(?=已)|\b(?:but|however)\b|\band\s+(?=(?:I|we|they|he|she|the\s+(?:file|report|agent|editor))\b)/giu);
  const actionPattern = /读取|读入|阅读|打开|解析|写入|保存|落盘|生成|创建|核验|验证|抓取|访问|检索|\b(?:workspace_read|workspace_write|web_fetch|web_search|read|reading|wrote|written|saved|saving|created|creating|fetched|verified|loaded|parsed|opened)\b/giu;
  for (const clause of clauses) {
    const actions = [...clause.matchAll(actionPattern)];
    for (const [index, action] of actions.entries()) {
      const start = action.index!;
      const end = start + action[0].length;
      const before = clause.slice(0, start).split(/[:：]/u).at(-1)!;
      const after = clause.slice(end);
      const next = clause.slice(end, actions[index + 1]?.index);
      const predicate = before.slice(-60);
      const prerequisite = /(?:完成|成功|完毕|结束|就绪)(?:之后|以后|后|时)([^。；;,]{0,30})$/u.exec(before);
      const followsPrerequisite = prerequisite && !/(?:已经|已)|\b(?:have|has|had|was|were)\b/iu.test(prerequisite[1]!);
      if (/^\s*(?:如果|若|假如|一旦|只要|当|等到|待|if\b|once\b|when\b|after\b|before\b|until\b)/iu.test(before) ||
        followsPrerequisite ||
        /(?<![稍随])(?:之后|以后|后)(?!续|台|面|者)|(?:成功|完成|完毕)时/u.test(after)) continue;
      if (/(?:未|没有|没|无法|不能|不曾|不代表|不表示|不意味着|不(?:要|得)?声称)[^。；;，,]{0,18}$/u.test(predicate) ||
        /\b(?:not|never|neither|cannot|can't|haven't|hasn't|hadn't|didn't|unable\s+to)\b[^.!?;,]{0,28}$/iu.test(predicate) ||
        /^\s*(?:尚未|未|没有|不曾|无法)/u.test(next)) continue;

      const aspects = [...predicate.matchAll(/已经|已/gu)];
      const aspect = aspects.at(-1);
      const gap = aspect ? predicate.slice(aspect.index! + aspect[0].length) : "";
      const delegated = /^(?:按.{0,8})?(?:安排|派发|分配|计划|要求|请|让|准备|等待|通知|建议|决定|承诺|委托)/u.test(gap.trim());
      const strongPast = Boolean(aspect && gap.length <= 30 && !delegated);
      const future = /将|会|拟|计划|准备|打算|安排|派发|分配|要求|让|建议|请|需要|应当|应该|必须|\b(?:will|shall|would|should|must|may|might|can|could|plan|planning|intend|propose|please|to)\b/iu.test(predicate);
      const chineseCompleted = strongPast || !future && (
        /(?:成功|完成)[^。；;，,]{0,18}$/u.test(predicate) ||
        /(?:均|都)?(?:已(?:经)?)?(?:成功|完成|完毕|好了|了)\s*$/u.test(next)
      );
      const englishCompleted = !future && (
        /^(?:wrote|written|saved|created|fetched|verified|loaded|parsed|opened)$/iu.test(action[0]) ||
        /\b(?:have|has|had|was|were|been)(?:\s+(?:already|successfully|fully|been))*\s*$/iu.test(predicate) ||
        /^read$/iu.test(action[0]) && /\b(?:I|we|they|he|she|the\s+(?:agent|researcher|editor|member))(?:\s+already)?\s*$/iu.test(predicate) ||
        /^\s*(?:the\s+)?(?:file|report|document|source)?\s*(?:is|are|was|were)?\s*(?:complete|completed|done|successful)\s*$/iu.test(next)
      );
      if (!chineseCompleted && !englishCompleted) continue;
      if (/^(?:生成|创建|created|creating)$/iu.test(action[0]) &&
        !/文件|文档|报告|草稿|成果|CSV|Markdown|Brief|\b(?:file|document|report|draft|artifact)\b/iu.test(clause)) continue;
      if (/^(?:读取|阅读|read|reading)$/iu.test(action[0]) &&
        /^(?:了)?\s*(?:(?:你|用户|当前|本次)的?)?(?:请求|要求|问题|消息|指令)|^\s*(?:(?:the|your|user's|current)\s+)*(?:request|instructions?|message)\b/iu.test(after) &&
        !/文件|文档|\bfile\b/iu.test(after)) continue;
      return true;
    }
  }
  return false;
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

function requestsLiveResearch(value: string): boolean {
  if (/(?:不要|不得|禁止|无需|不需要|不允许).{0,12}(?:联网|外网|搜索|调用工具)|不联网|(?:只|仅).{0,8}(?:群内|本地|已提供)/iu.test(value)) return false;
  return /(?:去|联网|真实|实际)调研|调研一下|(?:请|帮我|帮我们)(?:你|先)?调研|research the (?:web|latest|current)/iu.test(value);
}

function requiresToolCall(value: string): boolean {
  const explicitlyNoTools = /(?:不要|不得|禁止|无需|不需要|不允许).{0,20}(?:调用工具|读取|抓取|搜索|写入)|(?:do not|don't|must not).{0,20}(?:use tools?|read|fetch|search|write)/iu.test(value);
  if (explicitlyNoTools) return false;
  if (requestsLiveResearch(value)) return true;
  return /(?:请|需要|必须|先|重新|实际|真实).{0,24}(?:读取|打开|解析|列出|搜索|抓取|访问|核验|写入|保存|计算|统计)|\b(?:read|fetch|search|verify|write|save|calculate|measure)\b|https?:\/\/|\.csv\b/iu.test(value);
}

function requestsProjectManagement(value: string): boolean {
  if (/(?:不要|禁止|不允许|不得).{0,12}(?:创建|新建|组建|添加).{0,24}(?:Bot|机器人|智能体|群聊)/iu.test(value)) return false;
  return /(?:创建|新建|组建|添加|建立).{0,60}(?:Bot|机器人|智能体|群聊|团队)|(?:查看|列出|查询).{0,24}(?:项目成员|Bot)|project_list_bots|bot_create|room_create|\b(?:create|add|list)\b.{0,40}\b(?:bot|agent|room|group|team)\b/iu.test(value);
}

function requiredToolNames(value: string): string[] {
  const names = new Set<string>();
  if (requestsLiveResearch(value)) { names.add("web_search"); names.add("web_fetch"); }
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
    const turnPurpose = input.room?.turnPurpose ?? "work";
    const toolsAllowed = turnPurpose === "work";
    let roomSummary = input.room?.runSummary;
    const summaryMissingRequirements = turnPurpose === "summary" && roomSummary
      ? this.missingTeamRequirements(session.id, roomSummary)
      : [];
    if (turnPurpose === "summary" && roomSummary) {
      const batch = this.repository.getRoomRun(roomSummary.runId);
      if (batch.sessionId !== session.id || batch.leadBotId !== bot.id) throw new AevorenBotError("HANDOFF_CONTEXT_INVALID");
      const updated = this.repository.setRoomTaskRequirementsMet(roomSummary.runId, summaryMissingRequirements.length === 0);
      roomSummary = { ...roomSummary, coordinationErrorCode: updated.coordinationErrorCode ?? null };
    }
    if (input.room?.leadBotId && !toolsAllowed) this.assertLeadAvailable(input.room.leadBotId, modelSelection);
    this.repository.assertSessionExecutor(session.id, bot.id);
    const availableCapabilities = this.capabilitySnapshots?.forPrompt(bot.id, modelSelection, Boolean(input.room), session.id);
    const capabilitySnapshot = availableCapabilities && !toolsAllowed
      ? { ...availableCapabilities, availableTools: [], capabilities: availableCapabilities.capabilities.map((capability) => ({
          ...capability, availability: "unavailable" as const, reason: "当前回合仅协调或汇总，不执行工具。",
        })) }
      : availableCapabilities;
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
            turnPurpose,
            ...(input.room.leadBotId ? { leadBotId: input.room.leadBotId } : {}),
            ...(roomSummary ? { roomRunSummary: roomSummary, summaryMissingRequirements } : {}),
            ...(input.room.roster ? { roomRoster: input.room.roster } : {}),
            ...(input.incomingHandoff ? { handoff: input.incomingHandoff } : {}),
            ...(toolsAllowed && input.executionReceipt ? { executionReceipt: input.executionReceipt } : {}),
          }
        : undefined,
      turnPurpose === "summary" ? [] : this.repository.listRuntimeMemories(bot.id, session.id),
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
    const evidenceRequestText = toolsAllowed ? input.incomingHandoff?.task ?? user.body : "";
    const rootRequirements = input.executionReceipt?.taskRequirements.text ?? user.body;
    const evidenceToolNames = new Set(input.room && !input.incomingHandoff ? [] : requiredToolNames(evidenceRequestText));
    if (toolsAllowed && requestedReadPaths(evidenceRequestText).length > 0) evidenceToolNames.add("workspace_read");
    if (input.executionReceipt?.artifacts.length) evidenceToolNames.add("workspace_read");
    if (bot.name === "事实编辑" && /审校|审查|review/iu.test(evidenceRequestText)) {
      evidenceToolNames.add("workspace_write");
    }
    const isScopedHandoff = Boolean(input.incomingHandoff);
    const allowNetworkTools = toolsAllowed && providerCapabilities?.networkTools === true && (!isScopedHandoff || requestsNetworkTools(evidenceRequestText));
    const allowMcpTools = toolsAllowed && providerCapabilities?.networkTools === true && (!isScopedHandoff || requestsMcpTools(evidenceRequestText));
    const allowDeviceTools = toolsAllowed && providerCapabilities?.networkTools === true && (!isScopedHandoff || requestsDeviceTools(evidenceRequestText));
    if (/text_measure/iu.test(bot.instructions) && /写|草稿|审校|长度|draft|review/iu.test(evidenceRequestText)) {
      evidenceToolNames.add("text_measure");
    }
    if (toolsAllowed && input.room?.orchestrationEnabled) {
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
      turnPurpose,
      maxAssignments: input.room?.maxAssignments ?? 0,
      onLeadPlan: input.onLeadPlan,
      evidenceCorrectionAttempts: 0,
      providerContext: {
        supportedToolNames: providerCapabilities?.supportedToolNames,
        requestedWritePaths: requestedWritePaths(evidenceRequestText),
        executorBotId: bot.id,
        executionKey: input.executionKey,
        ...(input.room ? {
          roomId: input.room.id, sourceTurnId: input.room.sourceTurnId, roomTurnPurpose: turnPurpose,
          ...(input.room.leadBotId ? { roomLeadBotId: input.room.leadBotId } : {}),
          ...(roomSummary ? { roomRunSummary: roomSummary } : {}),
        } : {}),
        ...(input.room?.roster ? { roomRoster: input.room.roster } : {}),
        ...(input.incomingHandoff ? { incomingHandoff: input.incomingHandoff } : {}),
        ...(toolsAllowed && input.executionReceipt ? { executionReceipt: input.executionReceipt } : {}),
        workspaces: toolsAllowed && providerCapabilities?.workspaceTools === true
          ? this.repository.listSessionWorkspaces(session.id, bot.id).map(({ id, name, writeEnabled, automationEnabled }) => ({ id, name, writeEnabled, automationEnabled }))
          : [],
        networkTools: allowNetworkTools,
        mcpTools: allowMcpTools ? this.mcpTools?.availableTools(bot.id) ?? [] : [],
        deviceTools: allowDeviceTools,
        requireToolCall: toolsAllowed && (requiresToolCall(evidenceRequestText) || Boolean(input.executionReceipt?.artifacts.length)),
        textMeasureTools: toolsAllowed && evidenceToolNames.has("text_measure"),
        projectTools: toolsAllowed && (providerCapabilities?.workspaceTools === true || providerCapabilities?.networkTools === true) && requestsProjectManagement(rootRequirements),
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
      summaryMissingRequirements,
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

  assertLeadAvailable(botId: string, selection = this.repository.getBot(botId).modelSelection): void {
    try {
      if (!this.providerOverride && !this.fakeProvider) {
        const metadata = this.providers?.getCached?.(selection.providerInstanceId);
        if (!selection.modelId || !this.providers?.getCapabilities(selection).handoff ||
          metadata && (!metadata.enabled || metadata.status !== "available" ||
            !metadata.models.options.some((model) => model.id === selection.modelId))) {
          throw new AevorenBotError("ROOM_LEAD_UNAVAILABLE");
        }
      }
      if (!this.createProvider(selection).selectLeadPlan) throw new AevorenBotError("ROOM_LEAD_UNAVAILABLE");
    } catch {
      throw new AevorenBotError("ROOM_LEAD_UNAVAILABLE");
    }
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
        if (active.turnPurpose !== "work" && (event.type.endsWith("-tool") || event.type === "handoff" || event.type === "tool-rejection")) {
          throw new AevorenBotError("ROOM_SUMMARY_TOOLS_DISABLED");
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
            const plannedWork = Boolean(active.providerContext.roomLeadBotId) && active.turnPurpose === "work";
            if (!active.fixedRoomRouting && !plannedWork) throw new AevorenBotError("RUNTIME_STATE_INVALID");
            if (roundToolCount === 0) {
              if (toolRounds >= active.maxToolRounds) throw new AevorenBotError("TOOL_ROUND_LIMIT_EXCEEDED");
              toolRounds += 1;
            }
            roundToolCount += 1;
            rejectedFixedHandoff = active.fixedRoomRouting;
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
                  safeMessage: plannedWork
                    ? "后续成员已按本轮计划安排，本回合不能重复转交。请保留已经完成的成果并完成自己的简短回复，不要重复执行工具。"
                    : "当前是固定响应模式，本回合不能转交其他 Bot。请完成自己的回复，不要声称其他 Bot 已接力。",
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
        if (event.type === "workspace-tool" || event.type === "network-tool" || event.type === "mcp-tool" || event.type === "device-tool" || event.type === "computation-tool" || event.type === "project-tool") {
          if (!active.providerStarted || !this.workspaceTools) throw new AevorenBotError("RUNTIME_STATE_INVALID");
          if (event.type === "project-tool" && !active.providerContext.projectTools) throw new AevorenBotError("PROJECT_TOOL_NOT_REQUESTED");
          const recordOrRespond = async (action: Extract<(typeof roundActions)[number], { kind: "tool" }>): Promise<void> => {
            if (event.respond) await event.respond(action.result.content);
            else roundActions.push(action);
          };
          if (active.forceCompleteAfterToolRound) {
            roundToolCount += 1;
            const functionName = event.providerToolName ?? event.tool.kind.replaceAll("-", "_");
            const argumentsValue = Object.fromEntries(Object.entries(event.tool).filter(([key]) => key !== "kind"));
            await recordOrRespond({
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
          if (event.type === "workspace-tool" && event.tool.kind === "workspace-write") {
            const path = workspaceRelativePathSchema.safeParse(event.tool.path);
            const expectedPaths = active.providerContext.requestedWritePaths ?? [];
            if (!path.success || expectedPaths.length > 0 && !expectedPaths.includes(path.data)) {
              if (roundToolCount === 0) {
                if (toolRounds >= active.maxToolRounds) throw new AevorenBotError("TOOL_ROUND_LIMIT_EXCEEDED");
                toolRounds += 1;
              }
              roundToolCount += 1;
              const argumentsValue = Object.fromEntries(Object.entries(event.tool).filter(([key]) => key !== "kind"));
              await recordOrRespond({
                kind: "tool",
                call: { id: event.toolCallId, type: "function", function: {
                  name: event.providerToolName ?? "workspace_write", arguments: JSON.stringify(argumentsValue),
                } },
                result: { role: "tool", tool_call_id: event.toolCallId, content: JSON.stringify({
                  ok: false,
                  code: path.success ? "WORKSPACE_WRITE_PATH_REQUIRED" : "WORKSPACE_TOOL_ARGUMENTS_INVALID",
                  safeMessage: path.success
                    ? "文件尚未写入。请使用当前任务明确指定的输出路径，重新提交完整写入参数。不能用其他文件名代替所需成果。"
                    : "文件尚未写入。相对路径不能包含换行、控制字符、绝对路径或越界片段；请修正路径后重新提交，不要声称文件已创建。",
                  ...(expectedPaths.length > 0 ? { expectedPaths } : {}),
                }) },
              });
              run = this.repository.touchRuntimeRun(runId);
              this.emitRuntime(run);
              this.armStaleTimer(active);
              continue;
            }
          }
          if (event.type === "workspace-tool" && event.tool.kind === "workspace-write" && active.executorBotName === "数据复盘师") {
            const validation = this.validateCsvReport(active, event.tool.content);
            if (!validation.ok) {
              if (roundToolCount === 0) {
                if (toolRounds >= active.maxToolRounds) throw new AevorenBotError("TOOL_ROUND_LIMIT_EXCEEDED");
                toolRounds += 1;
              }
              roundToolCount += 1;
              await recordOrRespond({
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
              await recordOrRespond({
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
            const missingSources = this.missingSourceReads(active, event.tool.path);
            if (missingSources.length > 0) {
              if (roundToolCount === 0) {
                if (toolRounds >= active.maxToolRounds) throw new AevorenBotError("TOOL_ROUND_LIMIT_EXCEEDED");
                toolRounds += 1;
              }
              roundToolCount += 1;
              const argumentsValue = Object.fromEntries(Object.entries(event.tool).filter(([key]) => key !== "kind"));
              await recordOrRespond({
                kind: "tool",
                call: { id: event.toolCallId, type: "function", function: {
                  name: event.providerToolName ?? "workspace_write", arguments: JSON.stringify(argumentsValue),
                } },
                result: { role: "tool", tool_call_id: event.toolCallId, content: JSON.stringify({
                  ok: false, code: "WORKSPACE_SOURCE_READ_REQUIRED",
                  safeMessage: "文件尚未写入。请先在本回合使用 workspace_read 读取以下来源，再依据真实内容生成并写入成果。继承的文件须完整读取且与既有工件校验值一致。不要再次提交未经来源核验的内容。",
                  missingSources,
                }) },
              });
              run = this.repository.touchRuntimeRun(runId);
              this.emitRuntime(run);
              this.armStaleTimer(active);
              continue;
            }
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
              await recordOrRespond({
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
              await recordOrRespond({
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
              await recordOrRespond({
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
          let outcome;
          try {
            outcome = await this.workspaceTools.requestAndWait(
              runId,
              event.toolCallId,
              event.tool,
              event.toolSignal ? AbortSignal.any([active.controller.signal, event.toolSignal]) : active.controller.signal,
            );
          } catch (error) {
            if (!event.toolSignal || !event.respond || active.controller.signal.aborted) throw error;
            const failed = asAppError(error);
            await event.respond(JSON.stringify({ ok: false, code: failed.code, safeMessage: failed.safeMessage }));
            continue;
          }
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
            if (event.toolSignal) {
              const argumentsValue = Object.fromEntries(Object.entries(event.tool).filter(([key]) => key !== "kind"));
              active.messages.push({ role: "assistant", content: "", tool_calls: [{ id: event.toolCallId, type: "function", function: { name: event.providerToolName ?? event.tool.kind.replaceAll("-", "_"), arguments: JSON.stringify(argumentsValue) } }] }, { role: "tool", tool_call_id: outcome.toolCallId, content: providerOutcomeContent });
            }
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
            if (active.turnPurpose === "work") this.memoryCapture?.enqueue({
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
            const coordinating = active.turnPurpose === "coordinate";
            if ((!active.fixedRoomRouting && !coordinating) || appError.code !== "TOOL_EVIDENCE_REQUIRED" || active.evidenceCorrectionAttempts >= 1) {
              throw error;
            }
            active.evidenceCorrectionAttempts += 1;
            active.messages.push({ role: "assistant", content: active.providerBody.slice(roundBodyStart) });
            active.messages.push({
              role: "system",
              content: JSON.stringify({
                notice: coordinating ? "COORDINATE_EVIDENCE_REPAIR" : "FIXED_ROOM_EVIDENCE_REPAIR",
                reason: "The preceding draft claimed a tool action without a matching successful Tool Journal record in this Runtime.",
                rules: coordinating ? [
                  "This is the only correction attempt. Do not repeat any claim that a tool action has already succeeded.",
                  "You still have no tools. Do not read, write, fetch, verify, or dispatch anything during this reply.",
                  isDirectLeadConversationRequest(active.rootRequirements, active.executorBotName)
                    ? "The user only requested a greeting or your own introduction. Answer directly in one or two sentences using your own configured identity; do not introduce or assign other members."
                    : "Rewrite as only one or two natural sentences in the user's language: say you are preparing to ask the named members to perform their assigned work in order. Use future intent, not completed-action statements.",
                  "Do not output JSON, code blocks, technical status tables, or requests for repeated confirmation. An explicit human approval gate must still be respected.",
                ] : [
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
          if (active.turnPurpose === "coordinate") await this.dispatchLeadPlan(provider, active);
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
          if (active.turnPurpose === "work") this.memoryCapture?.enqueue({
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
    if (active.turnPurpose === "coordinate") {
      if (claimsCompletedCoordinationAction(active.body)) {
        throw new AevorenBotError("TOOL_EVIDENCE_REQUIRED", undefined, true, { requirement: "coordinate-unverified-action" });
      }
      return;
    }
    if (active.turnPurpose !== "work") {
      const evidence = active.providerContext.roomRunSummary?.results.flatMap((result) => result.tools ?? []) ?? [];
      const hasKind = (...kinds: string[]): boolean => evidence.some((tool) => kinds.includes(tool.kind));
      if (active.turnPurpose === "summary" && !active.body.trim()) throw new AevorenBotError("MODEL_STREAM_INVALID");
      if (active.turnPurpose === "summary" && active.summaryMissingRequirements.length > 0 &&
        /(?:全部|所有)(?:的)?(?:任务|工作)(?:都|均)?(?:已|已经)完成|\ball\s+(?:requested\s+)?(?:tasks|work)\s+(?:are\s+|is\s+)?(?:completed|complete|done)\b/iu.test(active.body) &&
        !/尚未|未完成|未执行|失败|\b(?:not|failed|incomplete)\b/iu.test(active.body)) {
        throw new AevorenBotError("TOOL_EVIDENCE_REQUIRED", undefined, true, { requirement: "accurate-team-summary" });
      }
      const unable = /无法|未能|尚未|没有权限|未完成|未执行|失败|unable|not completed|failed/iu.test(active.body);
      if (!unable && (claimsWorkspaceRead(active.body) && !hasKind("workspace-read") ||
        claimsWorkspaceWrite(active.body) && !hasKind("workspace-write") ||
        claimsRemoteEvidence(active.body) && !hasKind("web-search", "web-fetch"))) {
        throw new AevorenBotError("TOOL_EVIDENCE_REQUIRED");
      }
      return;
    }
    this.assertReceiptReads(active);
    if (this.missingSourceReads(active).length > 0) {
      throw new AevorenBotError("TOOL_EVIDENCE_REQUIRED", undefined, true, { requirement: "required-source-read" });
    }
    const succeeded = this.repository.listToolInvocations(active.sessionId)
      .filter((invocation) => invocation.runtimeRunId === active.runId && invocation.state === "succeeded");
    const hasKind = (...kinds: Array<(typeof succeeded)[number]["toolKind"]>): boolean =>
      succeeded.some((invocation) => kinds.includes(invocation.toolKind));
    const explicitRequirements = requiresToolCall(active.evidenceRequestText) ? requiredToolNames(active.evidenceRequestText) : [];
    const requiredKinds: Record<string, (typeof succeeded)[number]["toolKind"]> = { web_search: "web-search", web_fetch: "web-fetch", workspace_read: "workspace-read", workspace_write: "workspace-write", text_measure: "text-measure" };
    for (const name of explicitRequirements) {
      const kind = requiredKinds[name];
      if (kind && !hasKind(kind)) throw new AevorenBotError("TASK_REQUIREMENTS_UNMET", undefined, true, { requirement: name });
    }
    for (const path of active.providerContext.requestedWritePaths ?? []) {
      const written = succeeded.find(tool => tool.toolKind === "workspace-write" && tool.targetPath === path);
      if (!written) throw new AevorenBotError("TASK_REQUIREMENTS_UNMET", undefined, true, { requirement: "requested-artifact-path" });
      if (/保存后.{0,16}读取|回读|read.{0,12}back/iu.test(active.evidenceRequestText) && !succeeded.some(tool => tool.toolKind === "workspace-read" && tool.targetPath === path && tool.workspaceId === written.workspaceId && tool.resultMetadata?.sha256 === written.resultMetadata?.sha256 && tool.resultMetadata?.truncated === false)) {
        throw new AevorenBotError("TASK_REQUIREMENTS_UNMET", undefined, true, { requirement: "artifact-readback" });
      }
    }
    const explicitlyUnable = /无法|未能|没有权限|尚未读取|尚未抓取|尚未写入|不能确认|unable|could not|no access|not read|not fetched|not written/iu.test(active.body);
    const creationClaims = active.body.split(/[。！？\n]/u).filter((sentence) => !/尚未|未创建|未能创建|无法创建|创建失败|not created|failed to create|unable to create/iu.test(sentence)).join("\n");
    if (/(?:已|已经|成功).{0,12}(?:创建|新建).{0,24}(?:Bot|机器人|智能体)|(?:Bot|机器人|智能体).{0,12}(?:已创建|创建成功)|\bcreated\s+(?:an?\s+)?(?:bot|agent)\b/iu.test(creationClaims) && !hasKind("bot-create")) {
      throw new AevorenBotError("TOOL_EVIDENCE_REQUIRED", undefined, true, { requirement: "bot-create" });
    }
    if (/(?:已|已经|成功).{0,12}(?:创建|新建|组建).{0,24}群聊|群聊.{0,12}(?:已创建|创建成功)|\bcreated\s+(?:an?\s+)?(?:room|group)\b/iu.test(creationClaims) && !hasKind("room-create")) {
      throw new AevorenBotError("TOOL_EVIDENCE_REQUIRED", undefined, true, { requirement: "room-create" });
    }
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

  private missingTeamRequirements(sessionId: string, summary: RoomRunSummary): string[] {
    const text = summary.request.text;
    const evidence = summary.results.flatMap((result) => result.tools ?? []);
    const hasKind = (kind: string): boolean => evidence.some((tool) => tool.kind === kind);
    const kinds: Record<string, { kind: string; label: string }> = {
      web_search: { kind: "web-search", label: "公开资料检索" },
      web_fetch: { kind: "web-fetch", label: "网页读取" },
      workspace_read: { kind: "workspace-read", label: "来源文件读取" },
      workspace_write: { kind: "workspace-write", label: "成果文件保存" },
      text_measure: { kind: "text-measure", label: "确定性文字计数" },
    };
    const missing: string[] = [];
    for (const name of requiresToolCall(text) ? requiredToolNames(text) : []) {
      if (kinds[name] && !hasKind(kinds[name].kind)) missing.push(`尚未完成原任务要求的${kinds[name].label}。`);
    }
    const artifacts = summary.results.flatMap((result) => result.artifacts);
    const sourceRuns = new Set(summary.results.flatMap((result) => {
      const turn = this.repository.getRoomTurn(result.turnId);
      return turn.runtimeRunId ? [turn.runtimeRunId] : [];
    }));
    const verifiedDigests = new Set(evidence.map((tool) => tool.resultDigest));
    const reads = this.repository.listToolInvocations(sessionId).filter((tool) => (
      sourceRuns.has(tool.runtimeRunId) && tool.toolKind === "workspace-read" && tool.state === "succeeded" &&
      tool.resultDigest !== null && verifiedDigests.has(tool.resultDigest)
    ));
    for (const path of requestedReadPaths(text)) {
      const artifact = artifacts.find((candidate) => candidate.path === path);
      if (!reads.some((read) => read.targetPath === path && (!artifact ||
        read.workspaceId === artifact.workspaceId && read.resultMetadata?.truncated === false && read.resultMetadata.sha256 === artifact.sha256))) {
        missing.push(`尚未完成来源文件 ${path} 的有效读取。`);
      }
    }
    for (const path of requestedWritePaths(text)) {
      if (!artifacts.some((artifact) => artifact.path === path)) missing.push(`尚未生成要求的成果文件 ${path}。`);
    }
    if (requiresToolCall(text) && evidence.length === 0) missing.push("原任务要求的实际操作尚未完成。");
    return missing;
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

  private missingSourceReads(active: ActiveRun, outputPath?: string): Array<{ path: string; workspaceId?: string; sha256?: string }> {
    const paths = requestedReadPaths(active.evidenceRequestText).filter((path) => path !== outputPath);
    const receipt = active.providerContext.executionReceipt;
    const inherited = receipt?.artifacts.filter((artifact) => artifact.sourceRuntimeRunId === receipt.sourceRuntimeRunId) ?? [];
    const summary = active.providerContext.roomRunSummary;
    const dependency = summary && active.providerContext.sourceTurnId
      ? this.repository.getRoomTurn(active.providerContext.sourceTurnId).dependencyLogicalTurnId
      : null;
    const supplied = (summary?.results ?? []).flatMap((result) => result.artifacts.filter((artifact) =>
      result.logicalTurnId === dependency || paths.includes(artifact.path) || active.evidenceRequestText.includes(artifact.path),
    ));
    const specific = [...inherited, ...supplied].filter((artifact) => artifact.path !== outputPath);
    const required = [
      ...paths.filter((path) => !specific.some((artifact) => artifact.path === path)).map((path) => ({ path })),
      ...specific.map(({ path, workspaceId, sha256 }) => ({ path, workspaceId, sha256 })),
    ];
    const reads = this.repository.listToolInvocations(active.sessionId).filter((tool) =>
      tool.runtimeRunId === active.runId && tool.toolKind === "workspace-read" && tool.state === "succeeded",
    );
    return [...new Map(required.map((source) => [`${"workspaceId" in source ? source.workspaceId : ""}:${source.path}`, source])).values()]
      .filter((source) => !reads.some((read) => read.targetPath === source.path &&
        (!("workspaceId" in source) || read.workspaceId === source.workspaceId) &&
        (!("sha256" in source) || read.resultMetadata?.truncated === false && read.resultMetadata.sha256 === source.sha256)));
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
      active.turnPurpose !== "work" ||
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

  private async dispatchLeadPlan(provider: ModelProvider, active: ActiveRun): Promise<void> {
    const selector = provider.selectLeadPlan;
    const roster = active.providerContext.roomRoster;
    if (active.maxAssignments < 0) throw new AevorenBotError("ROOM_RUN_LIMIT_EXCEEDED", undefined, undefined, { reason: "summary-reserve" });
    if (!selector || !roster || !active.onLeadPlan) {
      throw new AevorenBotError("ROOM_LEAD_PLAN_INVALID");
    }
    if (isDirectLeadConversationRequest(active.rootRequirements, active.executorBotName)) {
      active.onLeadPlan({ assignments: [], reason: "当前用户只要求协调者本人问候或自我介绍，无需成员任务。", incompleteReason: null });
      return;
    }
    const signal = AbortSignal.any([active.controller.signal, AbortSignal.timeout(ROOM_LEAD_PLAN_TIMEOUT_MS)]);
    let abort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new AevorenBotError(signal.reason?.name === "TimeoutError" ? "MODEL_ROUTER_TIMEOUT" : "MESSAGE_CANCELLED"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    let observedPlan: RoomLeadPlan | undefined;
    try {
      const plan = await Promise.race([
        selector.call(provider, { rootRequest: active.rootRequirements, coordinationDraft: active.body },
          active.providerContext.executorBotId, roster, active.maxAssignments, signal),
        aborted,
      ]);
      observedPlan = plan;
      if (active.controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (plan?.incompleteReason) throw new AevorenBotError("ROOM_RUN_LIMIT_EXCEEDED", undefined, undefined, { reason: "incomplete-plan" });
      if (plan && Array.isArray(plan.assignments) && plan.assignments.length > active.maxAssignments) {
        throw new AevorenBotError("ROOM_RUN_LIMIT_EXCEEDED", undefined, undefined, { reason: "max-assignments" });
      }
      if (!plan || !Array.isArray(plan.assignments) ||
        plan.assignments.length === 0 && requiresToolCall(active.rootRequirements)) {
        throw new AevorenBotError("ROOM_LEAD_PLAN_INVALID");
      }
      active.onLeadPlan(plan);
    } catch (error) {
      if (active.controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const reportedReason = error instanceof AevorenBotError ? error.details?.reason : undefined;
      const reason = typeof reportedReason === "string" && [
        "summary-reserve", "incomplete-plan", "max-assignments", "max-turns", "max-hops", "max-targets-per-turn", "deadline", "winding-down", "run-state",
      ].includes(reportedReason) ? reportedReason : "validation";
      console.warn("[lead-plan-validation] rejected", {
        code: error instanceof AevorenBotError ? error.code : "UNEXPECTED_PLAN_ERROR",
        reason,
        assignmentLimit: active.maxAssignments,
        returnedAssignments: Array.isArray(observedPlan?.assignments) ? observedPlan.assignments.length : null,
        incompleteReasonCharacters: typeof observedPlan?.incompleteReason === "string" ? observedPlan.incompleteReason.length : 0,
      });
      if (error instanceof AevorenBotError && ["ROOM_RUN_LIMIT_EXCEEDED", "HUMAN_APPROVAL_REQUIRED", "MODEL_ROUTER_TIMEOUT"].includes(error.code)) throw error;
      throw new AevorenBotError("ROOM_LEAD_PLAN_INVALID");
    } finally {
      signal.removeEventListener("abort", abort);
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
