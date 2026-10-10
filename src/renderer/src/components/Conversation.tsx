import { Fragment, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  AppError,
  AttachmentDraft,
  ApprovalRequest,
  ApprovalResolution,
  Bot,
  RoomBatch,
  RoomDetail,
  RoomHandoffRejectionView,
  RoomHandoffView,
  RoomTurn,
  RuntimeRun,
  SessionLiveState,
  ToolInvocation,
  TranscriptEntry,
  UserRoomRoutingMode,
} from "@shared/contracts";
import { sanitizeRoomSpeakerOutput } from "@shared/room-speaker-envelope";
import { buildBotIdentityMap, buildSnapshotIdentityMap } from "../bot-identity";
import { shouldShowBriefApproval } from "../brief-approval-state";
import { initialRoomRouteAgentIds, latestRoomTurnsByLogicalTurn, roomHandoffProgress } from "../room-runtime-state";
import {
  EVERYONE_MENTION_ID,
  addRoomMention,
  filterMentionItems,
  findActiveMentionQuery,
  removeMentionQuery,
  resolveRoomTargetIds,
  type ActiveMentionQuery,
  type RoomMention,
} from "../room-mentions";
import { conversationArtifacts, groupToolActivity } from "../conversation-view-model";
import { BotAvatarIcon } from "./BotAvatarIcon";
import { UserAvatar } from "./UserAvatar";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { AtIcon, AttachmentIcon, CheckIcon, CloseIcon, DocumentIcon, FolderIcon, MoreIcon, PanelIcon, StopIcon } from "./Icons";
import { HeaderModelPicker } from "./HeaderModelPicker";
import { ExpandableTrace, type ExpandableTraceKind, type ExpandableTraceTone } from "./ExpandableTrace";
import { ToolPermissionDialog } from "./ToolPermissionDialog";
import {
  ArtifactStatusBar,
  ArtifactCard,
  BriefApprovalCard,
  HandoffEventCard,
  RunFailureCard,
  type WorkflowAction,
} from "./CollaborationFeedback";

const timeFormatter = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" });
const dateFormatter = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" });
const defaultUserProfile = { name: "你", avatarUrl: null };

function localDayKey(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function conversationDateLabel(value: string, today: Date): string {
  const day = localDayKey(value);
  if (day === localDayKey(today)) return "今天";
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  return day === localDayKey(yesterday) ? "昨天" : dateFormatter.format(new Date(value));
}

type ConversationUserProfile = { name: string; avatarUrl: string | null };

const handoffRejectionMessages: Record<string, string> = {
  INVALID_REQUEST: "任务转交格式不受支持，未执行。",
  BOT_NOT_FOUND: "目标 Bot 不存在，未执行任务转交。",
  ROOM_ARCHIVED: "群聊已归档，未执行任务转交。",
  ROOM_MEMBERSHIP_CONFLICT: "群聊成员已变化，未执行任务转交。",
  ROOM_MEMBER_INVALID: "目标 Bot 不在当前群聊中，未执行任务转交。",
  ROOM_RUN_LIMIT_EXCEEDED: "已达到本轮协作限制，未继续转交。",
  AGENT_TURN_CONFLICT: "成员运行状态冲突，未执行任务转交。",
  HANDOFF_TARGET_CONFLICT: "已存在发往该 Bot 的任务，未重复转交。",
  HANDOFF_CYCLE: "已阻止重复任务形成 Agent 调用循环。",
  HANDOFF_CONTEXT_INVALID: "转交引用了非当前群聊上下文，未执行。",
  RUNTIME_STATE_INVALID: "当前运行状态不允许继续转交。",
};

type HandoffDisplay = RoomHandoffView & {
  fromName: string;
  toName: string;
  progress: ReturnType<typeof roomHandoffProgress>;
};

type HandoffRejectionDisplay = RoomHandoffRejectionView & {
  fromName: string;
  toName: string;
  message: string;
};

const emptyToolInvocations: ToolInvocation[] = [];
const emptyHandoffs: HandoffDisplay[] = [];
const emptyHandoffRejections: HandoffRejectionDisplay[] = [];
const emptyRouteDisplayNames: string[] = [];

type TranscriptItemProps = {
  entry: TranscriptEntry;
  run: RuntimeRun | null;
  canRegenerate: boolean;
  canRetryRoomTurn: boolean;
  busy: boolean;
  groupedWithPrevious: boolean;
  groupedWithNext: boolean;
  isSuperseded: boolean;
  speakerBot: Bot | null;
  speakerDisplayName: string | null;
  userProfile: ConversationUserProfile;
  routeDisplayNames: string[];
  routeMode: UserRoomRoutingMode | "legacy" | null;
  routeReason: string | null;
  handoffs: HandoffDisplay[];
  handoffRejections: HandoffRejectionDisplay[];
  coordinationErrorCode: string | null;
  turnPurpose: RoomTurn["turnPurpose"];
  taskPartial: boolean;
  toolInvocations: ToolInvocation[];
  briefApproval: { roomId: string; sourceRuntimeRunId: string; briefInvocationId: string } | null;
  onRetryMessage(clientNonce: string): void;
  onRetryRun(runId: string): void;
  onRetryRoomTurn(turnId: string): void;
  onOpenSpeaker(botId: string): void;
  onRevealWorkspaceArtifact(workspaceId: string, path: string): void;
  onOpenWorkspaces(): void;
  onWorkflowAction(action: WorkflowAction): Promise<boolean>;
};

const toolStateLabels: Record<ToolInvocation["state"], string> = {
  prepared: "正在准备",
  "awaiting-approval": "等待你的确认",
  approved: "已允许，准备执行",
  dispatching: "正在执行",
  running: "正在执行",
  succeeded: "执行完成",
  failed: "执行失败",
  denied: "已拒绝",
  expired: "确认已过期",
  cancelled: "已取消",
  "failed-before-execution": "执行前失败",
  "interrupted-unknown": "执行被中断",
};

const roomBatchLabels: Record<RoomBatch["state"], string> = {
  queued: "待处理", running: "处理中", completed: "已完成", partial: "部分完成", cancelled: "已停止", interrupted: "已中断",
};
const roomTurnLabels: Record<RoomTurn["state"], string> = {
  queued: "待执行", running: "处理中", completed: "已完成", failed: "未完成", cancelled: "已停止", interrupted: "已中断",
};

function toolActionLabel(invocation: ToolInvocation): string {
  if (invocation.toolKind === "workspace-list") return "查看目录";
  if (invocation.toolKind === "workspace-read") return "读取文件";
  if (invocation.toolKind === "workspace-search") return "搜索文件";
  if (invocation.toolKind === "workspace-write") return "新建文件";
  if (invocation.toolKind === "web-search") return "联网搜索";
  if (invocation.toolKind === "web-fetch") return "读取网页";
  if (invocation.toolKind === "weather-current") return "查询当前天气";
  if (invocation.toolKind === "mcp-call") return `外部工具 · ${invocation.arguments.kind === "mcp-call" ? invocation.arguments.toolName : "工具"}`;
  if (invocation.toolKind === "clipboard-read") return "读取剪贴板";
  if (invocation.toolKind === "text-measure") return "精确计算文本长度";
  if (invocation.toolKind === "project-bots") return "查看项目 Bot";
  if (invocation.toolKind === "bot-create") return "创建 Bot";
  if (invocation.toolKind === "room-create") return "创建群聊";
  return "查询当前时间";
}

const activeToolStates = new Set<ToolInvocation["state"]>(["prepared", "approved", "dispatching", "running"]);

function toolTraceKind(invocation: ToolInvocation): ExpandableTraceKind {
  if (["web-search", "web-fetch", "weather-current", "time-now"].includes(invocation.toolKind)) return "search";
  if (["workspace-list", "workspace-read", "workspace-search"].includes(invocation.toolKind)) return "coding";
  return "steps";
}

function toolTraceTone(invocation: ToolInvocation): ExpandableTraceTone {
  if (activeToolStates.has(invocation.state)) return "working";
  if (invocation.state === "succeeded") return "success";
  if (["awaiting-approval", "denied", "expired", "cancelled"].includes(invocation.state)) return "attention";
  if (["failed", "failed-before-execution", "interrupted-unknown"].includes(invocation.state)) return "error";
  return "neutral";
}

function activeTraceLabel(kind: ExpandableTraceKind): string {
  if (kind === "search") return "正在搜索";
  if (kind === "coding") return "正在运行工具";
  if (kind === "reasoning") return "正在思考";
  return "正在执行步骤";
}

function completedTraceLabel(kind: ExpandableTraceKind): string {
  if (kind === "search") return "已完成搜索";
  if (kind === "coding") return "已运行工具";
  if (kind === "reasoning") return "思考完成";
  return "步骤已完成";
}

const ToolActivity = memo(function ToolActivity({
  invocation,
}: {
  invocation: ToolInvocation;
}): React.JSX.Element {
  const query = invocation.arguments.kind === "workspace-search" || invocation.arguments.kind === "web-search"
    ? invocation.arguments.query
    : null;
  const targetLabel = invocation.arguments.kind === "mcp-call"
    ? `Server ${invocation.arguments.serverId.slice(0, 8)}…`
    : invocation.targetPath || "文件夹根目录";
  const resultProvider = typeof invocation.resultMetadata?.provider === "string"
    ? invocation.resultMetadata.provider
    : typeof invocation.resultMetadata?.server === "string"
      ? invocation.resultMetadata.server
      : null;
  const resultTime = typeof invocation.resultMetadata?.observedAt === "string"
    ? invocation.resultMetadata.observedAt
    : typeof invocation.resultMetadata?.retrievedAt === "string"
      ? invocation.resultMetadata.retrievedAt
      : null;
  const traceKind = toolTraceKind(invocation);
  const active = activeToolStates.has(invocation.state);
  const settledLabel = invocation.state === "succeeded"
    ? completedTraceLabel(traceKind)
    : toolStateLabels[invocation.state];

  return (
    <ExpandableTrace
      active={active}
      activeLabel={activeTraceLabel(traceKind)}
      autoExpanded={false}
      className={`tool-${invocation.state}`}
      kind={traceKind}
      rows={[{
        id: invocation.id,
        primary: toolActionLabel(invocation),
        secondary: `${targetLabel}${query ? ` · “${query}”` : ""}`,
        trailing: toolStateLabels[invocation.state],
        mono: traceKind === "coding",
      }]}
      settledLabel={settledLabel}
      testId="workspace-tool-activity"
      tone={toolTraceTone(invocation)}
    >
      <div className="expandable-trace-meta">
        <time dateTime={invocation.createdAt}>调用于 {timeFormatter.format(new Date(invocation.createdAt))}</time>
        {invocation.state === "succeeded" && resultProvider ? <span>来源：{resultProvider}</span> : null}
        {invocation.state === "succeeded" && resultTime ? <span>结果时间：{resultTime}</span> : null}
      </div>
    </ExpandableTrace>
  );
});

const ToolActivityList = memo(function ToolActivityList({
  invocations,
}: {
  invocations: ToolInvocation[];
}): React.JSX.Element {
  const items = useMemo(() => groupToolActivity(invocations), [invocations]);
  return (
    <div className="message-tools" aria-label="工具活动">
      {items.map((item) => item.kind === "run" ? (
        <details className="tool-activity-run" key={item.id} data-testid="tool-activity-run">
          <summary>
            <span className="tool-run-check" aria-hidden="true"><CheckIcon /></span>
            <span>已完成 {item.invocations.length} 个步骤</span>
            <small>{item.invocations.slice(0, 3).map(toolActionLabel).join("、")}{item.invocations.length > 3 ? ` 等 ${item.invocations.length} 项` : ""}</small>
            <span className="tool-run-chevron" aria-hidden="true">›</span>
          </summary>
          <div className="tool-activity-run-items">
            {item.invocations.map((invocation) => (
              <ToolActivity
                invocation={invocation}
                key={invocation.id}
              />
            ))}
          </div>
        </details>
      ) : (
        <ToolActivity
          invocation={item.invocation}
          key={item.id}
        />
      ))}
    </div>
  );
});

const TranscriptItem = memo(function TranscriptItem({
  entry,
  run,
  canRegenerate,
  canRetryRoomTurn,
  busy,
  groupedWithPrevious,
  groupedWithNext,
  isSuperseded,
  speakerBot,
  speakerDisplayName,
  userProfile,
  routeDisplayNames,
  routeMode,
  routeReason,
  handoffs,
  handoffRejections,
  coordinationErrorCode,
  turnPurpose,
  taskPartial,
  toolInvocations,
  briefApproval,
  onRetryMessage,
  onRetryRun,
  onRetryRoomTurn,
  onOpenSpeaker,
  onRevealWorkspaceArtifact,
  onOpenWorkspaces,
  onWorkflowAction,
}: TranscriptItemProps): React.JSX.Element {
  const evidenceId = useId();
  const [evidenceExpanded, setEvidenceExpanded] = useState(false);
  const failedBeforeAcceptance = entry.sendState === "failed-before-acceptance";
  const interrupted = run?.state === "interrupted";
  const cancelled = entry.status === "cancelled";
  const failed = entry.status === "failed";
  const assistantBody = entry.role === "assistant" && entry.speakerBotId
    ? sanitizeRoomSpeakerOutput(entry.body, entry.status === "streaming")
    : entry.body;
  const longAssistant = entry.role === "assistant" && assistantBody.length > 160;
  const hasVisibleBody = entry.role === "user" || assistantBody.trim().length > 0;
  const speakerName = entry.role === "assistant"
    ? speakerDisplayName ?? speakerBot?.name ?? entry.speakerNameSnapshot ?? "Bot"
    : userProfile.name;
  const hasEvidence = toolInvocations.length > 0 || handoffs.length > 0 || handoffRejections.length > 0 || coordinationErrorCode !== null;
  const hasCollaboration = handoffs.length > 0 || handoffRejections.length > 0 || turnPurpose !== undefined;

  return (
    <article
      className={`message message-${entry.role}${longAssistant ? " message-long" : ""}${groupedWithPrevious ? " message-group-continuation" : ""}${groupedWithNext ? " message-group-has-next" : ""}${isSuperseded ? " message-superseded" : ""}`}
      data-status={entry.status}
      data-turn-purpose={turnPurpose}
    >
      <div className="message-row">
        {entry.role === "assistant" ? (
          <span
            className={`message-avatar message-avatar-with-bot${groupedWithPrevious ? " message-avatar-placeholder" : ""}`}
            aria-hidden="true"
          >
            {groupedWithPrevious ? null : <BotAvatarIcon shape={speakerBot?.avatarShape} color={speakerBot?.avatarColor} size={48} />}
          </span>
        ) : null}
        <div className="message-stack">
          {!groupedWithPrevious || hasEvidence ? (
            <header className={`message-meta${entry.role === "user" ? " message-meta-user" : ""}`}>
              {entry.speakerBotId ? (
                <button className="speaker-link" type="button" onClick={() => onOpenSpeaker(entry.speakerBotId!)}>{speakerName}</button>
              ) : <strong>{speakerName}</strong>}
              <time dateTime={entry.createdAt}>{timeFormatter.format(new Date(entry.createdAt))}</time>
              {turnPurpose === "summary" ? <span>汇总</span> : turnPurpose === "coordinate" ? <span>协调</span> : null}
              {hasEvidence ? (
                <button
                  className="message-evidence-toggle"
                  type="button"
                  aria-controls={evidenceId}
                  aria-expanded={evidenceExpanded}
                  onClick={() => setEvidenceExpanded((current) => !current)}
                >
                  {hasCollaboration ? "查看协作详情" : "查看工具活动"}
                  <span aria-hidden="true">›</span>
                </button>
              ) : null}
            </header>
          ) : null}
          {isSuperseded ? <div className="superseded-attempt-note"><span aria-hidden="true">↻</span>较早失败版本，已由后续重试替代</div> : null}
          {hasEvidence && evidenceExpanded ? (
            <section className="message-evidence-panel" id={evidenceId} aria-label={`${speakerName} 的执行详情`}>
              {toolInvocations.length > 0 ? <ToolActivityList invocations={toolInvocations} /> : null}
              {handoffs.length > 0 ? (
                <div className="message-handoffs" aria-label="Agent 任务转交" data-testid="room-handoff-list">
                  {handoffs.map((handoff) => (
                    <HandoffEventCard
                      key={handoff.id}
                      fromName={handoff.fromName}
                      toName={handoff.toName}
                      task={handoff.task}
                      delivery={handoff.progress.deliveryLabel}
                      execution={handoff.progress.executionLabel}
                      tone={handoff.progress.tone}
                      createdAt={handoff.deliveryAttempt?.acceptedAt ?? handoff.createdAt}
                    />
                  ))}
                </div>
              ) : null}
              {handoffRejections.length > 0 ? (
                <div className="message-handoff-rejections" aria-label="未执行的 Agent 任务转交" data-testid="room-handoff-rejection-list">
                  {handoffRejections.map((rejection) => (
                    <div className="room-handoff-rejection-row" key={rejection.id}>
                      <span className="room-handoff-route">{rejection.fromName}<span aria-hidden="true">→</span>{rejection.toName}</span>
                      <span className="room-handoff-rejection-message">{rejection.message}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              {coordinationErrorCode ? (
                <div className="handoff-status-card" role="status">
                  <strong>下一阶段交接未完成</strong>
                  <span>文字{entry.status === "completed" ? "已生成" : "尚未完整生成"}；工具成功 {toolInvocations.filter((item) => item.state === "succeeded").length} 次；文件已保存 {toolInvocations.filter((item) => item.toolKind === "workspace-write" && item.state === "succeeded").length} 个。</span>
                  <span>已有成功结果仍然保留。下一位 Bot 尚未启动，需要处理交接。</span>
                  <details><summary>技术详情</summary><code>{coordinationErrorCode}</code></details>
                </div>
              ) : null}
            </section>
          ) : null}
          {hasVisibleBody ? <div className={`message-bubble${longAssistant ? " message-bubble-long" : ""}`}>
            {entry.role === "user" && (routeDisplayNames.length > 0 || routeMode === "automatic") ? (
              <div className="message-route" aria-label={`响应 Bot：${routeDisplayNames.join("、")}`}>
                <span>{routeMode === "automatic" ? "自动选择" : "响应"}</span>
                {routeDisplayNames.map((name, index) => <span className="message-route-chip" key={`${index}:${name}`}>@{name}</span>)}
                {routeMode === "automatic" && routeReason ? <span className="message-route-reason">{routeReason}</span> : null}
              </div>
            ) : null}
          {entry.role === "assistant"
              ? <AssistantMarkdown body={assistantBody} />
              : <p className="user-message-body">{entry.body}</p>}
            {entry.attachments && entry.attachments.length > 0 ? (
              <div className="message-attachments" aria-label="消息附件">
                {entry.attachments.map((attachment) => (
                  <span className="message-attachment" key={attachment.id}>
                    <AttachmentIcon />
                    <span>{attachment.name}</span>
                    <small>{Math.max(1, Math.round(attachment.size / 1024))} KB</small>
                  </span>
                ))}
              </div>
            ) : null}
          </div> : null}
          {entry.role === "assistant"
            ? <ArtifactStatusBar
                writes={toolInvocations}
                onRevealWorkspace={onRevealWorkspaceArtifact}
                onOpenWorkspaces={onOpenWorkspaces}
              />
            : null}
          {briefApproval ? (
            <BriefApprovalCard key={briefApproval.briefInvocationId} {...briefApproval} busy={busy} onAction={onWorkflowAction} />
          ) : null}
          {turnPurpose === "summary" && entry.status === "completed" && taskPartial ? (
            <div className="entry-note warning" role="status">本轮仅部分完成。以上汇总不代表所有成员任务成功；已保存成果仍可在任务详情中查看。</div>
          ) : null}
          {cancelled ? (
            <div className="entry-note warning">
              {entry.role === "assistant" ? "回复已停止。" : "消息已取消。"}
              {canRegenerate && run ? (
                <button type="button" className="text-button" onClick={() => onRetryRun(run.id)}>重新生成回复</button>
              ) : null}
              {canRetryRoomTurn && entry.sourceTurnId ? (
                <button type="button" className="text-button" onClick={() => onRetryRoomTurn(entry.sourceTurnId!)}>重试此成员</button>
              ) : null}
            </div>
          ) : null}
          {failed && entry.role === "assistant" && turnPurpose === "summary" ? (
            <div className="entry-note warning" role="status">
              汇总未完成，成员已经完成的工作和保存的文件仍然保留。
              {canRetryRoomTurn && entry.sourceTurnId ? <button type="button" className="text-button" disabled={busy} onClick={() => onRetryRoomTurn(entry.sourceTurnId!)}>重试汇总</button> : null}
            </div>
          ) : failed && entry.role === "assistant" ? (
            canRetryRoomTurn && entry.sourceTurnId ? (
              <div className="room-inline-failure" data-testid="room-batch-state">
                <RunFailureCard
                  step={speakerName}
                  errorCode={run?.lastErrorCode}
                  invocations={toolInvocations}
                  canRetry={canRetryRoomTurn}
                  onRetry={() => onRetryRoomTurn(entry.sourceTurnId!)}
                />
              </div>
            ) : isSuperseded ? (
              <details className="superseded-attempt-details">
                <summary>查看较早失败详情</summary>
                <RunFailureCard step={speakerName} errorCode={run?.lastErrorCode} invocations={toolInvocations} canRetry={false} onRetry={() => undefined} />
              </details>
            ) : <RunFailureCard
              step={speakerName}
              errorCode={run?.lastErrorCode}
              invocations={toolInvocations}
              canRetry={Boolean(canRegenerate && run)}
              onRetry={() => { if (canRegenerate && run) onRetryRun(run.id); }}
            />
          ) : failed ? (
            <div className={"entry-note " + (interrupted || entry.sendState === "interrupted-unknown" ? "warning" : "error")}>
              {entry.sendState === "interrupted-unknown" ? "应用中断，模型可能已接受该消息；不会自动重发。" : "消息未成功发送。"}
              {failedBeforeAcceptance && entry.clientNonce ? <button type="button" className="text-button" onClick={() => onRetryMessage(entry.clientNonce!)}>安全重试发送</button> : null}
            </div>
          ) : null}
        </div>
        {entry.role === "user" ? <span className="message-avatar message-avatar-user"><UserAvatar name={userProfile.name} avatarUrl={userProfile.avatarUrl} size={48} /></span> : null}
      </div>
    </article>
  );
});

type ConversationProps = {
  userProfile?: ConversationUserProfile;
  bot: Bot | null;
  room: RoomDetail | null;
  roomBatches: RoomBatch[];
  roomTurns: RoomTurn[];
  roomHandoffs: RoomHandoffView[];
  roomHandoffRejections: RoomHandoffRejectionView[];
  entries: TranscriptEntry[];
  runs: RuntimeRun[];
  toolInvocations: ToolInvocation[];
  approvalRequests: ApprovalRequest[];
  liveState: SessionLiveState | null;
  loading: boolean;
  submitting: boolean;
  error: AppError | null;
  closeNotice: string | null;
  onOpenBots(): void;
  onOpenProfile(): void;
  inspectorCollapsed: boolean;
  onToggleInspector(): void;
  onOpenWorkspaces(): void;
  onPickAttachments(): Promise<AttachmentDraft[]>;
  onBotUpdated(bot: Bot): void;
  onError(error: AppError | null): void;
  onResolveApproval(approval: ApprovalRequest, resolution: ApprovalResolution): Promise<boolean>;
  onRememberPublicRead?(approval: ApprovalRequest): Promise<boolean>;
  onRevealWorkspaceArtifact(workspaceId: string, path: string): Promise<boolean>;
  onSend(text: string, targetBotIds?: string[], routingMode?: UserRoomRoutingMode, attachments?: AttachmentDraft[]): Promise<boolean>;
  onApproveBrief?(input: { roomId: string; sourceRuntimeRunId: string; briefInvocationId: string; sha256: string; candidate: "A" | "B" | "C"; clientNonce: string }): Promise<boolean>;
  onRetryMessage(clientNonce: string): void;
  onRetryRun(runId: string): void;
  onCancelRun(runId: string): void;
  onCancelRoomBatch(batchId: string): void;
  onRetryRoomTurn(turnId: string): Promise<boolean>;
  onContinueRoomBatch(batchId: string): void;
  onOpenSpeaker(botId: string): void;
};

export function Conversation({
  userProfile = defaultUserProfile,
  bot,
  room,
  roomBatches,
  roomTurns,
  roomHandoffs,
  roomHandoffRejections,
  entries,
  runs,
  toolInvocations,
  approvalRequests,
  liveState,
  loading,
  submitting,
  error,
  closeNotice,
  onOpenBots,
  onOpenProfile,
  inspectorCollapsed,
  onToggleInspector,
  onOpenWorkspaces,
  onPickAttachments,
  onBotUpdated,
  onError,
  onResolveApproval,
  onRememberPublicRead,
  onRevealWorkspaceArtifact,
  onSend,
  onApproveBrief,
  onRetryMessage,
  onRetryRun,
  onCancelRun,
  onCancelRoomBatch,
  onRetryRoomTurn,
  onContinueRoomBatch,
  onOpenSpeaker,
}: ConversationProps): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [roomMentions, setRoomMentions] = useState<RoomMention[]>([]);
  const [routingPreference, setRoutingPreference] = useState<UserRoomRoutingMode>("automatic");
  const [menuScopeId, setMenuScopeId] = useState<string | null>(null);
  const [artifactShelfScopeId, setArtifactShelfScopeId] = useState<string | null>(null);
  const [taskDetailsTab, setTaskDetailsTab] = useState<"artifacts" | "records">("artifacts");
  const [retriedTurnIds, setRetriedTurnIds] = useState<Set<string>>(() => new Set());
  const [mentionQuery, setMentionQuery] = useState<ActiveMentionQuery | null>(null);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const transcriptRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const pendingComposerCaretRef = useRef<number | null>(null);
  const dismissedMentionRef = useRef<{ start: number; text: string } | null>(null);
  const approvalNonceRef = useRef<{ key: string; nonce: string } | null>(null);
  const followTranscriptTailRef = useRef(true);
  const activeRunId = liveState?.activeRunId ?? null;
  const activeBatch = roomBatches.toReversed().find((batch) => batch.state === "queued" || batch.state === "running") ?? null;
  const latestBatch = roomBatches.at(-1) ?? null;
  const busy = submitting || activeRunId !== null || activeBatch !== null;
  const memberBotIds = useMemo(() => room?.members.map((member) => member.botId) ?? [], [room]);
  const effectiveRoomMentions = roomMentions.filter((mention) => mention.kind === "everyone" || memberBotIds.includes(mention.id));
  const invalidRoomMentions = roomMentions.filter((mention) => mention.kind === "bot" && !memberBotIds.includes(mention.id));
  const hasInvalidRoomMentions = invalidRoomMentions.length > 0;
  const targetBotIds = room ? resolveRoomTargetIds(roomMentions, memberBotIds) : [];
  const explicitRoutingBlocked = Boolean(room && routingPreference === "explicit" && targetBotIds.length === 0);
  const subjectName = bot?.name ?? room?.room.name ?? "选择对话";
  const currentDate = new Date();
  const conversationScopeId = room?.room.id ?? bot?.id ?? null;
  const conversationMenuScopeId = conversationScopeId ?? "empty-conversation";
  const menuOpen = menuScopeId === conversationMenuScopeId;
  const artifactShelfOpen = conversationScopeId !== null && artifactShelfScopeId === conversationScopeId;
  const artifacts = useMemo(() => conversationArtifacts(toolInvocations), [toolInvocations]);
  const entryDays = useMemo(() => entries.map((entry) => localDayKey(entry.createdAt)), [entries]);
  const latestUserNonce = useMemo(
    () => entries.toReversed().find((entry) => entry.role === "user")?.clientNonce ?? null,
    [entries],
  );
  const runsByAssistant = useMemo(
    () => new Map(runs.filter((run) => run.assistantEntryId).map((run) => [run.assistantEntryId, run])),
    [runs],
  );
  const runsById = useMemo(() => new Map(runs.map((run) => [run.id, run])), [runs]);
  const toolsByAssistant = useMemo(() => {
    const result = new Map<string, ToolInvocation[]>();
    for (const invocation of toolInvocations) {
      const assistantEntryId = runsById.get(invocation.runtimeRunId)?.assistantEntryId;
      if (!assistantEntryId) continue;
      result.set(assistantEntryId, [...(result.get(assistantEntryId) ?? []), invocation]);
    }
    return result;
  }, [runsById, toolInvocations]);
  const briefApproval = useMemo(() => {
    if (!room || !shouldShowBriefApproval(toolInvocations, entries)) return null;
    const latestBriefWrite = toolInvocations
      .filter((invocation) => invocation.toolKind === "workspace-write" && invocation.state === "succeeded" && invocation.targetPath.startsWith("02-briefs/"))
      .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
      .at(-1);
    const sourceRun = latestBriefWrite ? runsById.get(latestBriefWrite.runtimeRunId) : null;
    const sourceTurn = latestBriefWrite ? roomTurns.find((turn) => turn.runtimeRunId === latestBriefWrite.runtimeRunId) : null;
    if (sourceRun?.state !== "completed" || sourceTurn?.state !== "completed") return null;
    const assistantEntryId = sourceRun.assistantEntryId;
    return latestBriefWrite && assistantEntryId ? {
      entryId: assistantEntryId,
      roomId: room.room.id,
      sourceRuntimeRunId: latestBriefWrite.runtimeRunId,
      briefInvocationId: latestBriefWrite.id,
    } : null;
  }, [entries, room, roomTurns, runsById, toolInvocations]);
  const pendingTool = useMemo(() => {
    const pending = new Map(approvalRequests.filter(approval => approval.state === "pending").map(approval => [approval.toolInvocationId, approval]));
    const invocation = toolInvocations.find(tool => tool.state === "awaiting-approval" && pending.has(tool.id));
    return invocation ? { invocation, approval: pending.get(invocation.id)! } : null;
  }, [approvalRequests, toolInvocations]);
  const permissionBotName = pendingTool && room
    ? room.members.find(member => member.botId === pendingTool.invocation.executorBotId)?.bot.name ?? subjectName
    : subjectName;

  useEffect(() => {
    if (!menuOpen) return;
    const closeOutside = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target instanceof Node ? event.target : null)) setMenuScopeId(null);
    };
    const closeEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setMenuScopeId(null);
      menuTriggerRef.current?.focus();
    };
    menuRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled), .header-model-trigger:not(:disabled)")?.focus();
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeEscape);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!artifactShelfOpen) return;
    const close = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setArtifactShelfScopeId(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [artifactShelfOpen]);
  const latestTurns = useMemo(() => {
    if (!latestBatch) return [];
    return latestRoomTurnsByLogicalTurn(roomTurns, latestBatch.id);
  }, [latestBatch, roomTurns]);
  const latestFailedTurn = latestTurns.toReversed().find((turn) => ["failed", "cancelled", "interrupted"].includes(turn.state)) ?? null;
  const latestFailedTurnHasMessage = latestFailedTurn
    ? entries.some((entry) => entry.role === "assistant" && entry.sourceTurnId === latestFailedTurn.id)
    : false;
  const canContinueRoomBatch = Boolean(
    latestBatch && ["interrupted", "partial"].includes(latestBatch.state) &&
    latestTurns.some((turn) => turn.state === "interrupted" && turn.promptCutoffSeq === null),
  );
  const latestFailedRun = latestFailedTurn?.runtimeRunId ? runsById.get(latestFailedTurn.runtimeRunId) ?? null : null;
  const latestRetryRun = !room
    ? runs.toReversed().find((run) => ["failed", "cancelled", "interrupted"].includes(run.state) && run.clientNonce === latestUserNonce) ?? null
    : null;
  const retryableUserEntry = entries.toReversed().find((entry) => entry.role === "user" && entry.sendState === "failed-before-acceptance" && entry.clientNonce === latestUserNonce) ?? null;
  const latestFailedTools = latestFailedRun ? toolInvocations.filter((invocation) => invocation.runtimeRunId === latestFailedRun.id) : [];
  const waitingForBriefApproval = latestTurns.some(turn => turn.lastErrorCode === "HUMAN_APPROVAL_REQUIRED") && briefApproval !== null;
  const roomTurnState = useMemo(() => {
    const byId = new Map(roomTurns.map((turn) => [turn.id, turn]));
    const latestByLogicalTurn = new Map<string, RoomTurn>();
    for (const turn of roomTurns) {
      const key = `${turn.batchId}:${turn.logicalTurnId}`;
      const current = latestByLogicalTurn.get(key);
      if (!current || current.attemptNo < turn.attemptNo) latestByLogicalTurn.set(key, turn);
    }
    return { byId, latestByLogicalTurn };
  }, [roomTurns]);
  const roomMemberIdentities = useMemo(
    () => buildBotIdentityMap(room?.members.map((member) => member.bot) ?? []),
    [room],
  );
  const snapshotIdentities = useMemo(() => buildSnapshotIdentityMap([
    ...entries.flatMap((entry) => entry.speakerBotId && entry.speakerNameSnapshot
      ? [{ id: entry.speakerBotId, name: entry.speakerNameSnapshot }]
      : []),
    ...roomTurns.map((turn) => ({ id: turn.memberBotId, name: turn.memberNameSnapshot })),
  ]), [entries, roomTurns]);
  const handoffsByAssistantEntry = useMemo(() => {
    const runsById = new Map(runs.map((run) => [run.id, run]));
    const result = new Map<string, HandoffDisplay[]>();
    for (const handoff of roomHandoffs.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))) {
      const originalSourceTurn = roomTurnState.byId.get(handoff.fromTurnId);
      const sourceTurn = handoff.deliveryAttempt && originalSourceTurn
        ? roomTurnState.latestByLogicalTurn.get(`${originalSourceTurn.batchId}:${originalSourceTurn.logicalTurnId}`) ?? originalSourceTurn
        : originalSourceTurn;
      const targetTurn = roomTurnState.byId.get(handoff.targetTurnId);
      const latestTargetTurn = targetTurn
        ? roomTurnState.latestByLogicalTurn.get(`${targetTurn.batchId}:${targetTurn.logicalTurnId}`) ?? targetTurn
        : undefined;
      const assistantEntryId = sourceTurn?.runtimeRunId ? runsById.get(sourceTurn.runtimeRunId)?.assistantEntryId : null;
      if (!sourceTurn || !assistantEntryId) continue;
      const display: HandoffDisplay = {
        ...handoff,
        fromName: snapshotIdentities.get(sourceTurn.memberBotId) ?? sourceTurn.memberNameSnapshot,
        toName: targetTurn
          ? snapshotIdentities.get(targetTurn.memberBotId) ?? targetTurn.memberNameSnapshot
          : snapshotIdentities.get(handoff.toAgentId) ?? "未知 Bot",
        progress: roomHandoffProgress(handoff, latestTargetTurn),
      };
      result.set(assistantEntryId, [...(result.get(assistantEntryId) ?? []), display]);
    }
    return result;
  }, [roomHandoffs, roomTurnState, runs, snapshotIdentities]);
  const handoffRejectionsByAssistantEntry = useMemo(() => {
    const runsById = new Map(runs.map((run) => [run.id, run]));
    const result = new Map<string, HandoffRejectionDisplay[]>();
    for (const rejection of roomHandoffRejections) {
      const sourceTurn = roomTurnState.byId.get(rejection.fromTurnId);
      const assistantEntryId = sourceTurn?.runtimeRunId ? runsById.get(sourceTurn.runtimeRunId)?.assistantEntryId : null;
      if (!sourceTurn || !assistantEntryId) continue;
      const display: HandoffRejectionDisplay = {
        ...rejection,
        fromName: snapshotIdentities.get(sourceTurn.memberBotId) ?? sourceTurn.memberNameSnapshot,
        toName: roomMemberIdentities.get(rejection.attemptedToAgentId)?.inline
          ?? snapshotIdentities.get(rejection.attemptedToAgentId)
          ?? "未知 Bot",
        message: handoffRejectionMessages[rejection.errorCode] ?? "任务转交未被接受。",
      };
      result.set(assistantEntryId, [...(result.get(assistantEntryId) ?? []), display]);
    }
    return result;
  }, [roomHandoffRejections, roomMemberIdentities, roomTurnState, runs, snapshotIdentities]);
  const mentionItems = useMemo(() => room ? [
    {
      id: EVERYONE_MENTION_ID,
      label: "所有人",
      keywords: ["all", "everyone", "全部", "全员"],
    },
    ...room.members.map((member) => {
      const identity = roomMemberIdentities.get(member.botId)!;
      return {
        id: member.botId,
        label: identity.inline,
        keywords: [member.bot.name, member.bot.label, identity.secondary],
      };
    }),
  ] : [], [room, roomMemberIdentities]);
  const mentionCandidates = useMemo(
    () => mentionQuery ? filterMentionItems(mentionItems, mentionQuery.query) : [],
    [mentionItems, mentionQuery],
  );
  const roomRoutesByNonce = useMemo(() => {
    const result = new Map<string, { names: string[]; mode: RoomBatch["routingMode"]; reason: string | null }>();
    for (const batch of roomBatches) {
      const names = initialRoomRouteAgentIds(roomTurns, batch.id).map((agentId) => (
        roomMemberIdentities.get(agentId)?.inline ?? snapshotIdentities.get(agentId) ?? "未知 Bot"
      ));
      result.set(batch.clientNonce, { names, mode: batch.routingMode, reason: batch.routingReason });
    }
    return result;
  }, [roomBatches, roomMemberIdentities, roomTurns, snapshotIdentities]);

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript && followTranscriptTailRef.current) transcript.scrollTop = transcript.scrollHeight;
  }, [entries, toolInvocations]);

  useLayoutEffect(() => {
    const caret = pendingComposerCaretRef.current;
    if (caret === null) return;
    pendingComposerCaretRef.current = null;
    composerInputRef.current?.focus();
    composerInputRef.current?.setSelectionRange(caret, caret);
  }, [draft, roomMentions]);

  const handleWorkflowAction = useCallback(async (action: WorkflowAction): Promise<boolean> => {
    if (!room || busy) return false;
    if (action.kind === "approve") {
      if (!onApproveBrief) return false;
      const key = `${room.room.id}:${action.sourceRuntimeRunId}:${action.briefInvocationId}:${action.sha256}:${action.candidate}`;
      if (approvalNonceRef.current?.key !== key) approvalNonceRef.current = { key, nonce: crypto.randomUUID() };
      return onApproveBrief({
        roomId: room.room.id,
        sourceRuntimeRunId: action.sourceRuntimeRunId,
        briefInvocationId: action.briefInvocationId,
        sha256: action.sha256,
        candidate: action.candidate,
        clientNonce: approvalNonceRef.current.nonce,
      });
    }
    const planner = room.members.find((member) => member.bot.name === "选题策划师");
    const text = action.kind === "return"
        ? "RETURN：退回补证。请检查当前 Brief 的证据缺口，并结构化交给情报侦察员补充后重新提交。"
        : "放弃本轮 Brief，本次任务停止，不再交给下游 Bot。";
    if (action.kind === "return") return onSend(text, [], "automatic");
    const targetIds = planner ? [planner.botId] : [];
    return onSend(text, targetIds, targetIds.length > 0 ? "explicit" : "automatic");
  }, [room, busy, onApproveBrief, onSend]);

  const retryRoomTurn = useCallback(async (turnId: string): Promise<void> => {
    if (await onRetryRoomTurn(turnId)) {
      setRetriedTurnIds((current) => new Set(current).add(turnId));
    }
  }, [onRetryRoomTurn]);

  const retryRoomTurnFromMessage = useCallback((turnId: string): void => { void retryRoomTurn(turnId); }, [retryRoomTurn]);
  const revealWorkspaceArtifact = useCallback((workspaceId: string, path: string): void => { void onRevealWorkspaceArtifact(workspaceId, path); }, [onRevealWorkspaceArtifact]);

  async function submit(): Promise<void> {
    const text = draft.trim();
    if (!text || (!bot && !room) || busy || hasInvalidRoomMentions || explicitRoutingBlocked) return;
    followTranscriptTailRef.current = true;
    const routingMode: UserRoomRoutingMode | undefined = !room
      ? undefined
      : routingPreference;
    const routedTargetIds = !room
      ? undefined
      : routingPreference === "everyone"
        ? memberBotIds
        : routingPreference === "explicit"
          ? targetBotIds
          : [];
    const accepted = await onSend(text, routedTargetIds, routingMode, attachments);
    if (accepted) {
      setDraft("");
      setAttachments([]);
      setRoomMentions([]);
      setRoutingPreference("automatic");
      setMentionQuery(null);
      dismissedMentionRef.current = null;
    }
  }

  function refreshMentionQuery(text: string, caret: number): void {
    if (!room) return;
    const next = findActiveMentionQuery(text, caret);
    if (!next) {
      dismissedMentionRef.current = null;
      setMentionQuery(null);
      return;
    }
    if (dismissedMentionRef.current?.start === next.start && dismissedMentionRef.current.text === text) {
      setMentionQuery(null);
      return;
    }
    dismissedMentionRef.current = null;
    setActiveMentionIndex(0);
    setMentionQuery(next);
  }

  function selectMention(itemId: string): void {
    if (!mentionQuery) return;
    const selectedItem = mentionItems.find((item) => item.id === itemId);
    if (!selectedItem) return;
    const nextDraft = removeMentionQuery(draft, mentionQuery);
    setRoomMentions((current) => addRoomMention(
      current,
      itemId === EVERYONE_MENTION_ID
        ? { kind: "everyone", id: EVERYONE_MENTION_ID }
        : { kind: "bot", id: itemId, label: selectedItem.label },
    ));
    setRoutingPreference(itemId === EVERYONE_MENTION_ID ? "everyone" : "explicit");
    pendingComposerCaretRef.current = nextDraft.caret;
    setDraft(nextDraft.text);
    setMentionQuery(null);
    dismissedMentionRef.current = null;
  }

  function openTaskDetails(tab: "artifacts" | "records"): void {
    setTaskDetailsTab(tab);
    setArtifactShelfScopeId(conversationScopeId);
    setMenuScopeId(null);
  }

  function openMentionPicker(): void {
    if (!room || busy) return;
    const textarea = composerInputRef.current;
    const caret = textarea?.selectionStart ?? draft.length;
    const nextDraft = `${draft.slice(0, caret)}@${draft.slice(caret)}`;
    setDraft(nextDraft);
    pendingComposerCaretRef.current = caret + 1;
    refreshMentionQuery(nextDraft, caret + 1);
  }

  return (
    <main className="conversation">
      <header className="conversation-header">
        {room ? (
          <span className="conversation-group-avatar" aria-label={`${room.members.length} 位 Agent 和你`}>
            {room.members.slice(0, 3).map((member) => <BotAvatarIcon shape={member.bot.avatarShape} color={member.bot.avatarColor} size={24} key={member.botId} />)}
            <UserAvatar name={userProfile.name} avatarUrl={userProfile.avatarUrl} size={24} />
          </span>
        ) : bot ? <span className="conversation-bot-avatar"><BotAvatarIcon shape={bot.avatarShape} color={bot.avatarColor} size={48} /></span> : null}
        <div className="conversation-title">
          <h1>{subjectName}</h1>
          {room ? <p className="conversation-header-counts">{room.members.length} 位 Agent</p> : bot ? <p className="conversation-header-counts">Bot</p> : null}
        </div>
        <div className="conversation-menu-anchor" ref={menuRef}>
          <button
            className="conversation-menu-trigger"
            type="button"
            ref={menuTriggerRef}
            aria-label="聊天选项"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            onClick={() => setMenuScopeId((current) => current === conversationMenuScopeId ? null : conversationMenuScopeId)}
          >
            <MoreIcon />
          </button>
          {menuOpen ? (
            <div className="conversation-menu" id={menuId} role="menu" aria-label="聊天选项" onKeyDown={(event) => {
              if (event.target instanceof Element && event.target.closest(".header-model-popover")) return;
              if (event.key === "Tab") {
                event.preventDefault();
                setMenuScopeId(null);
                if (event.shiftKey) menuTriggerRef.current?.focus();
                else composerInputRef.current?.focus();
                return;
              }
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled), .header-model-trigger:not(:disabled)")];
              const index = items.indexOf(document.activeElement as HTMLButtonElement);
              const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
              items[next]?.focus();
            }}>
              {bot || room ? <>
              {bot ? <div className="conversation-menu-section" role="group" aria-label="模型设置"><span className="conversation-menu-label">模型设置</span><HeaderModelPicker bot={bot} busy={busy} onBotUpdated={onBotUpdated} onError={onError} /></div> : (
                <button className="conversation-menu-item" type="button" role="menuitem" onClick={() => { setMenuScopeId(null); onOpenProfile(); }}><PanelIcon /><span>模型设置</span></button>
              )}
              <button className="conversation-menu-item" type="button" role="menuitem" aria-label={artifacts.length > 0 ? `打开会话成果，共 ${artifacts.length} 个` : "打开任务详情"} aria-expanded={artifactShelfOpen} onClick={() => openTaskDetails("artifacts")}><FolderIcon /><span>{room ? "群文件" : "会话文件"}</span><small>{artifacts.length}</small></button>
              <button className="conversation-menu-item" type="button" role="menuitem" onClick={() => openTaskDetails("records")}><span>执行记录</span><small>{toolInvocations.length}</small></button>
              <button className="conversation-menu-item" type="button" role="menuitem" onClick={() => { setMenuScopeId(null); onOpenProfile(); }}><PanelIcon /><span>{room ? "成员详情" : "Bot 设置"}</span></button>
              <button className="conversation-menu-item" type="button" role="menuitem" aria-controls="conversation-inspector" aria-expanded={!inspectorCollapsed} onClick={() => { setMenuScopeId(null); onToggleInspector(); }}><PanelIcon /><span>{inspectorCollapsed ? "展开详情面板" : "收起详情面板"}</span></button>
              {latestFailedTurn ? <button className="conversation-menu-item" type="button" role="menuitem" disabled={busy} onClick={() => { setMenuScopeId(null); void retryRoomTurn(latestFailedTurn.id); }}>重试{latestFailedTurn.turnPurpose === "summary" ? "汇总" : "此成员"}</button> : null}
              {latestRetryRun ? <button className="conversation-menu-item" type="button" role="menuitem" disabled={busy} onClick={() => { setMenuScopeId(null); onRetryRun(latestRetryRun.id); }}>重新生成回复</button> : null}
              {retryableUserEntry?.clientNonce ? <button className="conversation-menu-item" type="button" role="menuitem" disabled={busy} onClick={() => { setMenuScopeId(null); onRetryMessage(retryableUserEntry.clientNonce!); }}>安全重试发送</button> : null}
              {canContinueRoomBatch && latestBatch ? <button className="conversation-menu-item" type="button" role="menuitem" disabled={busy} onClick={() => { setMenuScopeId(null); onContinueRoomBatch(latestBatch.id); }}>继续未开始成员</button> : null}
              </> : null}
              <button className={`conversation-menu-item${bot || room ? " conversation-menu-mobile-item" : ""}`} type="button" role="menuitem" onClick={() => { setMenuScopeId(null); onOpenBots(); }}>打开 Bot 列表</button>
            </div>
          ) : null}
        </div>
      </header>

      {artifactShelfOpen ? (
        <>
          <button className="artifact-shelf-backdrop" type="button" aria-label="关闭会话成果" onClick={() => setArtifactShelfScopeId(null)} />
          <aside className="artifact-shelf task-details-shelf" aria-label="会话成果">
            <header>
              <div><span>{subjectName}</span><strong>任务详情</strong></div>
              <button className="artifact-shelf-close" type="button" aria-label="关闭会话成果" onClick={() => setArtifactShelfScopeId(null)}><CloseIcon /></button>
            </header>
            <div className="task-details-navigation">
              <div role="tablist" aria-label="任务详情内容">
                <button type="button" role="tab" id="task-artifacts-tab" aria-selected={taskDetailsTab === "artifacts"} aria-controls="task-details-content" onClick={() => setTaskDetailsTab("artifacts")}>成果 {artifacts.length}</button>
                <button type="button" role="tab" id="task-records-tab" aria-selected={taskDetailsTab === "records"} aria-controls="task-details-content" onClick={() => setTaskDetailsTab("records")}>执行记录 {toolInvocations.length}</button>
              </div>
              <p>{taskDetailsTab === "artifacts" ? "这里只显示真实工具保存的文件。" : "记录来自实际工具调用，模型文字不会自动成为执行证据。"}</p>
            </div>
            <div className="artifact-shelf-list task-details-content" role="tabpanel" id="task-details-content" aria-labelledby={taskDetailsTab === "artifacts" ? "task-artifacts-tab" : "task-records-tab"}>
              {taskDetailsTab === "records" ? <ToolActivityList invocations={toolInvocations} /> : artifacts.length === 0 ? <p className="task-details-empty">尚无已保存成果</p> : artifacts.map((artifact) => (
                <ArtifactCard
                  artifact={artifact}
                  key={artifact.id}
                  onOpen={() => artifact.invocation.workspaceId
                    ? void onRevealWorkspaceArtifact(artifact.invocation.workspaceId, artifact.invocation.targetPath)
                    : onOpenWorkspaces()}
                />
              ))}
            </div>
            <footer><button type="button" className="secondary-button" onClick={onOpenWorkspaces}>管理文件夹</button></footer>
          </aside>
        </>
      ) : null}

      <section
        ref={transcriptRef}
        className="transcript"
        aria-live="polite"
        onScroll={(event) => {
          const transcript = event.currentTarget;
          followTranscriptTailRef.current = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 96;
        }}
      >
        {loading ? <div className="center-state">正在加载会话…</div> : null}
        {!loading && !bot && !room ? (
          <div className="center-state">
            <strong>选择一个聊天</strong>
            <span>从联系人发消息，或点击“+”创建 Bot 或群聊。</span>
          </div>
        ) : null}
        {!loading && (bot || room) && entries.length === 0 ? (
          <div className="center-state">
            <strong>开始对话</strong>
            <span>{room ? "自动安排成员协作，或输入 @ 指定回复的 Bot。" : "告诉这个 Bot 你希望它完成什么。"}</span>
          </div>
        ) : null}
        {entries.map((entry, index) => {
          const previousEntry = entries[index - 1];
          const nextEntry = entries[index + 1];
          const entryDay = entryDays[index]!;
          const samePreviousDay = previousEntry !== undefined && entryDays[index - 1] === entryDay;
          const sameNextDay = nextEntry !== undefined && entryDays[index + 1] === entryDay;
          const run = runsByAssistant.get(entry.id) ?? null;
          const canRegenerate = Boolean(
            !room &&
            run &&
            ["failed", "cancelled", "interrupted"].includes(run.state) &&
            run.clientNonce === latestUserNonce &&
            !busy,
          );
          const sourceTurn = entry.sourceTurnId ? roomTurnState.byId.get(entry.sourceTurnId) : undefined;
          const canRetryRoomTurn = Boolean(
            sourceTurn &&
            sourceTurn.batchId === latestBatch?.id &&
            roomTurnState.latestByLogicalTurn.get(`${sourceTurn.batchId}:${sourceTurn.logicalTurnId}`)?.id === sourceTurn.id &&
            ["failed", "cancelled", "interrupted"].includes(sourceTurn.state) &&
            !busy,
          );
          return (
            <Fragment key={entry.id}>
            {!samePreviousDay ? (
              <div className="conversation-date-separator">
                <time dateTime={entryDay}>{conversationDateLabel(entry.createdAt, currentDate)}</time>
              </div>
            ) : null}
            <TranscriptItem
              key={entry.id}
              entry={entry}
              run={run}
              canRegenerate={canRegenerate}
              canRetryRoomTurn={canRetryRoomTurn}
              busy={busy}
              groupedWithPrevious={samePreviousDay && previousEntry?.role === entry.role && previousEntry?.speakerBotId === entry.speakerBotId}
              groupedWithNext={sameNextDay && nextEntry?.role === entry.role && nextEntry?.speakerBotId === entry.speakerBotId}
              isSuperseded={Boolean(sourceTurn && (retriedTurnIds.has(sourceTurn.id) || roomTurnState.latestByLogicalTurn.get(`${sourceTurn.batchId}:${sourceTurn.logicalTurnId}`)?.id !== sourceTurn.id))}
              speakerBot={entry.role === "assistant"
                ? entry.speakerBotId
                  ? room?.members.find((member) => member.botId === entry.speakerBotId)?.bot ?? (bot?.id === entry.speakerBotId ? bot : null)
                  : bot
                : null}
              speakerDisplayName={entry.speakerBotId
                ? roomMemberIdentities.get(entry.speakerBotId)?.inline ?? snapshotIdentities.get(entry.speakerBotId) ?? null
                : null}
              userProfile={userProfile}
              routeDisplayNames={entry.role === "user" && entry.clientNonce
                ? roomRoutesByNonce.get(entry.clientNonce)?.names ?? emptyRouteDisplayNames
                : emptyRouteDisplayNames}
              routeMode={entry.role === "user" && entry.clientNonce
                ? roomRoutesByNonce.get(entry.clientNonce)?.mode ?? null
                : null}
              routeReason={entry.role === "user" && entry.clientNonce
                ? roomRoutesByNonce.get(entry.clientNonce)?.reason ?? null
                : null}
              handoffs={handoffsByAssistantEntry.get(entry.id) ?? emptyHandoffs}
              handoffRejections={handoffRejectionsByAssistantEntry.get(entry.id) ?? emptyHandoffRejections}
              coordinationErrorCode={sourceTurn?.outcome?.summary?.startsWith("handoff-failed:")
                ? sourceTurn.outcome.summary.slice("handoff-failed:".length)
                : null}
              turnPurpose={sourceTurn?.turnPurpose}
              taskPartial={Boolean(sourceTurn && roomBatches.find(batch => batch.id === sourceTurn.batchId)?.state === "partial")}
              toolInvocations={toolsByAssistant.get(entry.id) ?? emptyToolInvocations}
              briefApproval={entry.id === briefApproval?.entryId ? briefApproval : null}
              onRetryMessage={onRetryMessage}
              onRetryRun={onRetryRun}
              onRetryRoomTurn={retryRoomTurnFromMessage}
              onOpenSpeaker={onOpenSpeaker}
              onRevealWorkspaceArtifact={revealWorkspaceArtifact}
              onOpenWorkspaces={onOpenWorkspaces}
              onWorkflowAction={handleWorkflowAction}
            />
            </Fragment>
          );
        })}
      </section>

      {pendingTool ? <ToolPermissionDialog
        key={pendingTool.approval.id}
        {...pendingTool}
        botName={permissionBotName}
        label={toolActionLabel(pendingTool.invocation)}
        onResolve={onResolveApproval}
        onRememberPublicRead={onRememberPublicRead}
        onStop={() => {
          if (activeBatch) onCancelRoomBatch(activeBatch.id);
          else onCancelRun(pendingTool.invocation.runtimeRunId);
        }}
      /> : null}

      <footer className="composer-wrap">
        {closeNotice ? <div className="composer-notice" role="alert">{closeNotice}</div> : null}
        {error && !(waitingForBriefApproval && error.code === "HUMAN_APPROVAL_REQUIRED") ? <div className="composer-error" role="alert">{error.safeMessage}</div> : null}
        {!room && liveState?.state === "stale"
          ? <div className="send-state runtime-stale" role="status">连接可能已停滞，仍可停止本次运行</div>
          : null}
        {room && waitingForBriefApproval ? (
          <div className="composer-notice" role="status">等待你批准选题。已生成的 Brief 保留，批准后继续后续工作。</div>
        ) : room && latestBatch && latestFailedTurn && (!latestFailedTurnHasMessage || canContinueRoomBatch) ? (
          <div className="composer-run-status" data-testid="room-batch-state">
            {!latestFailedTurnHasMessage && latestFailedTurn.turnPurpose === "summary" ? <div className="entry-note warning" role="status">
              汇总未完成，成员的有效结果和文件已保留。
              <button className="text-button" type="button" disabled={busy} onClick={() => void retryRoomTurn(latestFailedTurn.id)}>重试汇总</button>
            </div> : !latestFailedTurnHasMessage ? <RunFailureCard
              step={roomMemberIdentities.get(latestFailedTurn.memberBotId)?.inline ?? latestFailedTurn.memberNameSnapshot}
              errorCode={latestFailedTurn.lastErrorCode ?? latestFailedRun?.lastErrorCode}
              invocations={latestFailedTools}
              canRetry={!busy}
              onRetry={() => void retryRoomTurn(latestFailedTurn.id)}
            /> : null}
            {canContinueRoomBatch ? (
              <button className="secondary-button continue-room-button" type="button" disabled={busy} onClick={() => onContinueRoomBatch(latestBatch.id)}>继续未开始成员</button>
            ) : null}
          </div>
        ) : room && latestBatch && !["completed", "running", "queued"].includes(latestBatch.state) ? (
          <details className={`room-batch-state batch-${latestBatch.state}`} data-testid="room-batch-state">
            <summary>
              <span className="room-presence-dot" aria-hidden="true" />
              <strong>本轮状态：{roomBatchLabels[latestBatch.state]}</strong>
              <span className="room-batch-chevron" aria-hidden="true">›</span>
            </summary>
            <div className="room-turn-list">
              {latestTurns.map((turn) => (
                <span className={`room-turn-state turn-${turn.state}`} key={turn.id}>
                  {roomMemberIdentities.get(turn.memberBotId)?.inline ?? snapshotIdentities.get(turn.memberBotId) ?? turn.memberNameSnapshot}{turn.turnPurpose === "summary" ? " · 汇总" : ""}：{roomTurnLabels[turn.state]}
                  {(turn.state === "failed" || turn.state === "cancelled" || turn.state === "interrupted" && turn.promptCutoffSeq !== null) && !busy ? (
                    <button className="text-button" type="button" onClick={() => onRetryRoomTurn(turn.id)}>重试</button>
                  ) : null}
                </span>
              ))}
            </div>
            {canContinueRoomBatch ? (
              <button className="text-button" type="button" onClick={() => onContinueRoomBatch(latestBatch.id)}>继续未开始成员</button>
            ) : null}
          </details>
        ) : null}
        {room && (hasInvalidRoomMentions || explicitRoutingBlocked) ? (
          <div className="room-routing-hint invalid" role="alert">
            {hasInvalidRoomMentions
              ? `${invalidRoomMentions.map((mention) => mention.kind === "bot" ? `@${mention.label}` : "").join("、")} 已不在群聊，请移除后重新选择`
              : "请先输入 @ 并选择要响应的 Bot"}
          </div>
        ) : null}
        <div className="composer">
          {room && mentionQuery ? (
            <div className="mention-menu" role="listbox" aria-label="提及 Bot" id="room-mention-menu">
              <div className="mention-menu-header">提及</div>
              {mentionCandidates.length === 0 ? (
                <div className="mention-empty">未找到与“{mentionQuery.query}”匹配的 Bot <span>按 Esc 关闭</span></div>
              ) : mentionCandidates.map((item, index) => {
                const selected = effectiveRoomMentions.some((mention) => mention.id === item.id);
                const mentionBot = item.id === EVERYONE_MENTION_ID
                  ? null
                  : room.members.find((member) => member.botId === item.id)?.bot ?? null;
                return (
                  <button
                    className={`mention-option${index === activeMentionIndex ? " active" : ""}${selected ? " selected" : ""}`}
                    id={`room-mention-option-${index}`}
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectMention(item.id)}
                  >
                    <span className="mention-option-icon bot-avatar-container"><BotAvatarIcon shape={mentionBot?.avatarShape} color={mentionBot?.avatarColor} size={24} /></span>
                    <span className="mention-option-copy">
                      <strong>{item.label}</strong>
                      <small>{item.id === EVERYONE_MENTION_ID ? "Bot · 群聊中的全部成员" : "Bot"}</small>
                    </span>
                    {selected ? <span className="mention-selected">已选择</span> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
          <div className="composer-toolbar">
            <button
              className="attachment-button"
              type="button"
              aria-label="添加文本附件"
              title="添加文本附件"
              disabled={busy || attachments.length >= 6 || (!bot && !room)}
              onClick={() => void onPickAttachments().then((picked) => {
                if (picked.length === 0) return;
                setAttachments((current) => [...current, ...picked.filter((item) => !current.some((existing) => existing.sha256 === item.sha256))].slice(0, 6));
              })}
            ><AttachmentIcon /></button>
            {room ? (
              <>
                <button className="composer-mention-button" type="button" aria-label="提及 Bot" title="提及 Bot" disabled={busy} onClick={openMentionPicker}><AtIcon /></button>
                <label className="composer-routing-control" title="群聊默认响应方式">
                  <select
                    aria-label="群聊默认响应方式"
                    disabled={busy}
                    value={routingPreference}
                    onChange={(event) => {
                      const mode = event.target.value as UserRoomRoutingMode;
                      setRoutingPreference(mode);
                      if (mode !== "explicit") setRoomMentions([]);
                      setMentionQuery(null);
                    }}
                  >
                    <option value="automatic">自动</option>
                    <option value="explicit">@ 指定</option>
                    <option value="everyone">全员</option>
                  </select>
                </label>
              </>
            ) : null}
            {attachments.length > 0 ? <div className="attachment-chips" aria-label="已添加的附件">
              {attachments.map((attachment) => (
                <button
                  className="attachment-chip"
                  type="button"
                  key={attachment.id}
                  aria-label={`移除附件 ${attachment.name}`}
                  disabled={busy}
                  onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
                >
                  <DocumentIcon weight="duotone" />
                  <span>{attachment.name}</span>
                  <small>{Math.max(1, Math.round(attachment.size / 1024))} KB</small>
                  <span aria-hidden="true">×</span>
                </button>
              ))}
            </div> : null}
            {roomMentions.length > 0 ? <div className="mention-chips" aria-label="已提及的 Bot">
              {roomMentions.map((mention) => {
                const invalid = mention.kind === "bot" && !memberBotIds.includes(mention.id);
                const label = mention.kind === "everyone"
                  ? "所有人"
                  : roomMemberIdentities.get(mention.id)?.inline ?? mention.label;
                return (
                  <button
                    className={`mention-chip${invalid ? " invalid" : ""}`}
                    type="button"
                    key={`${mention.kind}:${mention.id}`}
                    aria-label={`移除 @${label}`}
                    aria-invalid={invalid || undefined}
                    disabled={busy}
                    onClick={() => setRoomMentions((current) => {
                      const next = current.filter((item) => item.id !== mention.id);
                      if (next.length === 0) setRoutingPreference("automatic");
                      return next;
                    })}
                  >@{label}<span aria-hidden="true">×</span></button>
                );
              })}
            </div> : null}
          </div>
          <div className="composer-editor">
            <textarea
              ref={composerInputRef}
              aria-label="消息"
              aria-autocomplete={room ? "list" : undefined}
              aria-controls={mentionQuery ? "room-mention-menu" : undefined}
              aria-expanded={room ? Boolean(mentionQuery) : undefined}
              aria-activedescendant={mentionQuery && mentionCandidates.length > 0 ? `room-mention-option-${activeMentionIndex}` : undefined}
              placeholder={room ? `给 ${room.room.name} 发消息，输入 @ 指定 Bot…` : bot ? `给 ${bot.name} 发消息…` : "给 Bot 发消息…"}
              value={draft}
              onChange={(event) => {
                setDraft(event.currentTarget.value);
                refreshMentionQuery(event.currentTarget.value, event.currentTarget.selectionStart);
              }}
              onClick={(event) => refreshMentionQuery(event.currentTarget.value, event.currentTarget.selectionStart)}
              onFocus={(event) => refreshMentionQuery(event.currentTarget.value, event.currentTarget.selectionStart)}
              onBlur={() => setMentionQuery(null)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  const { selectionStart, selectionEnd } = event.currentTarget;
                  const nextDraft = `${draft.slice(0, selectionStart)}\n${draft.slice(selectionEnd)}`;
                  setDraft(nextDraft);
                  pendingComposerCaretRef.current = selectionStart + 1;
                  refreshMentionQuery(nextDraft, selectionStart + 1);
                  return;
                }
                if (mentionQuery) {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    if (mentionCandidates.length > 0) setActiveMentionIndex((current) => (
                      current + (event.key === "ArrowDown" ? 1 : -1) + mentionCandidates.length
                    ) % mentionCandidates.length);
                    return;
                  }
                  if (event.key === "Enter") {
                    event.preventDefault();
                    const selectedCandidate = mentionCandidates[activeMentionIndex];
                    if (selectedCandidate) selectMention(selectedCandidate.id);
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    dismissedMentionRef.current = { start: mentionQuery.start, text: draft };
                    setMentionQuery(null);
                    return;
                  }
                }
                if (event.key === "Backspace" && event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0 && draft.length === 0 && roomMentions.length > 0) {
                  event.preventDefault();
                  setRoomMentions((current) => current.slice(0, -1));
                  if (roomMentions.length === 1) setRoutingPreference("automatic");
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
              disabled={!bot && !room}
              rows={3}
            />
          </div>
          <div className="composer-footer-actions">
            <span className="composer-hint">Enter 发送 · Shift + Enter 换行</span>
          {activeBatch ? (
            <button className="send-button stop" type="button" onClick={() => onCancelRoomBatch(activeBatch.id)} aria-label="停止群聊回复"><StopIcon /></button>
          ) : activeRunId ? (
            <button
              className="send-button stop"
              type="button"
              onClick={() => onCancelRun(activeRunId)}
              aria-label="停止回复"
            >
              <StopIcon />
            </button>
          ) : (
            <button
              className="send-button"
              type="button"
              onClick={() => void submit()}
              disabled={(!bot && !room) || !draft.trim() || busy || hasInvalidRoomMentions || explicitRoutingBlocked}
              aria-label="发送"
            >
              发送
            </button>
          )}
          </div>
        </div>
      </footer>
    </main>
  );
}
