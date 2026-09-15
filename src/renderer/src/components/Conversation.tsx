import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  AppError,
  Bot,
  RoomBatch,
  RoomDetail,
  RoomHandoffRejectionView,
  RoomHandoffView,
  RoomTurn,
  RuntimeRun,
  SessionLiveState,
  SessionLiveStateName,
  TranscriptEntry,
  UserRoomRoutingMode,
} from "@shared/contracts";
import { sanitizeRoomSpeakerOutput } from "@shared/room-speaker-envelope";
import { buildBotIdentityMap, buildSnapshotIdentityMap } from "../bot-identity";
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
import { AssistantMarkdown } from "./AssistantMarkdown";
import { BotIcon, MenuIcon, PanelIcon, SendIcon, SettingsIcon, StopIcon } from "./Icons";

const timeFormatter = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" });

const liveLabels: Record<Exclude<SessionLiveStateName, "idle">, string> = {
  starting: "正在连接模型",
  running: "模型已接受，正在运行",
  composing: "正在生成回复",
  retrying: "正在重新生成",
  cancelling: "正在取消",
  stale: "连接可能已停滞，仍可停止本次运行",
};

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

function summarizeHandoffTask(task: string): string {
  const compact = task.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 119)}…` : compact;
}

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

type TranscriptItemProps = {
  entry: TranscriptEntry;
  run: RuntimeRun | null;
  canRegenerate: boolean;
  canRetryRoomTurn: boolean;
  groupedWithPrevious: boolean;
  groupedWithNext: boolean;
  speakerDisplayName: string | null;
  routeDisplayNames: string[];
  routeMode: UserRoomRoutingMode | "legacy" | null;
  routeReason: string | null;
  handoffs: HandoffDisplay[];
  handoffRejections: HandoffRejectionDisplay[];
  onRetryMessage(clientNonce: string): void;
  onRetryRun(runId: string): void;
  onRetryRoomTurn(turnId: string): void;
  onOpenSpeaker(botId: string): void;
};

const TranscriptItem = memo(function TranscriptItem({
  entry,
  run,
  canRegenerate,
  canRetryRoomTurn,
  groupedWithPrevious,
  groupedWithNext,
  speakerDisplayName,
  routeDisplayNames,
  routeMode,
  routeReason,
  handoffs,
  handoffRejections,
  onRetryMessage,
  onRetryRun,
  onRetryRoomTurn,
  onOpenSpeaker,
}: TranscriptItemProps): React.JSX.Element {
  const failedBeforeAcceptance = entry.sendState === "failed-before-acceptance";
  const interrupted = run?.state === "interrupted";
  const cancelled = entry.status === "cancelled";
  const failed = entry.status === "failed";
  const assistantBody = entry.role === "assistant" && entry.speakerBotId
    ? sanitizeRoomSpeakerOutput(entry.body, entry.status === "streaming")
    : entry.body;
  const longAssistant = entry.role === "assistant" && assistantBody.length > 160;
  const hasVisibleBody = entry.role === "user" || assistantBody.trim().length > 0;
  const speakerName = entry.role === "assistant" ? speakerDisplayName ?? entry.speakerNameSnapshot ?? "Aevoren Bot" : "你";

  return (
    <article
      className={`message message-${entry.role}${longAssistant ? " message-long" : ""}${groupedWithPrevious ? " message-group-continuation" : ""}${groupedWithNext ? " message-group-has-next" : ""}`}
      data-status={entry.status}
    >
      <div className="message-row">
        {entry.role === "assistant" ? (
          <span className={`message-avatar${groupedWithPrevious ? " message-avatar-placeholder" : ""}`} aria-hidden="true">
            {groupedWithPrevious ? null : <BotIcon />}
          </span>
        ) : null}
        <div className="message-stack">
          {!groupedWithPrevious ? (
            <header className="message-meta">
              {entry.speakerBotId ? (
                <button className="speaker-link" type="button" onClick={() => onOpenSpeaker(entry.speakerBotId!)}>{speakerName}</button>
              ) : <strong>{speakerName}</strong>}
              <time>{timeFormatter.format(new Date(entry.createdAt))}</time>
            </header>
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
          </div> : null}
          {handoffs.length > 0 ? (
            <div className="message-handoffs" aria-label="Agent 任务转交" data-testid="room-handoff-list">
              {handoffs.map((handoff) => (
                <div className={`room-handoff-row handoff-${handoff.state} handoff-tone-${handoff.progress.tone}`} key={handoff.id}>
                  <span className="room-handoff-route">{handoff.fromName}<span aria-hidden="true">→</span>{handoff.toName}</span>
                  <span className="room-handoff-task" title={handoff.task}>{summarizeHandoffTask(handoff.task)}</span>
                  <span className="room-handoff-status">
                    <span>投递：{handoff.progress.deliveryLabel}</span>
                    {handoff.progress.executionLabel ? <span>执行：{handoff.progress.executionLabel}</span> : null}
                  </span>
                </div>
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
          {entry.status === "streaming"
            ? <div className="streaming-indicator">正在生成<span /></div>
            : null}
          {entry.role === "assistant" && entry.status === "completed"
            ? <div className="entry-note success">已完成</div>
            : null}
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
          {failed ? (
            <div className={"entry-note " + (interrupted || entry.sendState === "interrupted-unknown" ? "warning" : "error")}>
              {entry.role === "assistant"
                ? interrupted
                  ? "运行被应用中断，没有自动重新发送。"
                  : "回复生成失败，已保留可用的部分内容。"
                : entry.sendState === "interrupted-unknown"
                  ? "应用中断，模型可能已接受该消息；不会自动重发。"
                  : "消息未成功发送。"}
              {failedBeforeAcceptance && entry.clientNonce ? (
                <button type="button" className="text-button" onClick={() => onRetryMessage(entry.clientNonce!)}>
                  安全重试发送
                </button>
              ) : null}
              {canRegenerate && run ? (
                <button type="button" className="text-button" onClick={() => onRetryRun(run.id)}>重新生成回复</button>
              ) : null}
              {canRetryRoomTurn && entry.sourceTurnId ? (
                <button type="button" className="text-button" onClick={() => onRetryRoomTurn(entry.sourceTurnId!)}>重试此成员</button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
});

type ConversationProps = {
  bot: Bot | null;
  room: RoomDetail | null;
  roomBatches: RoomBatch[];
  roomTurns: RoomTurn[];
  roomHandoffs: RoomHandoffView[];
  roomHandoffRejections: RoomHandoffRejectionView[];
  entries: TranscriptEntry[];
  runs: RuntimeRun[];
  liveState: SessionLiveState | null;
  loading: boolean;
  submitting: boolean;
  error: AppError | null;
  closeNotice: string | null;
  onOpenBots(): void;
  onOpenProfile(): void;
  onOpenSettings(): void;
  onSend(text: string, targetBotIds?: string[], routingMode?: UserRoomRoutingMode): Promise<boolean>;
  onRetryMessage(clientNonce: string): void;
  onRetryRun(runId: string): void;
  onCancelRun(runId: string): void;
  onCancelRoomBatch(batchId: string): void;
  onRetryRoomTurn(turnId: string): void;
  onContinueRoomBatch(batchId: string): void;
  onOpenSpeaker(botId: string): void;
};

export function Conversation({
  bot,
  room,
  roomBatches,
  roomTurns,
  roomHandoffs,
  roomHandoffRejections,
  entries,
  runs,
  liveState,
  loading,
  submitting,
  error,
  closeNotice,
  onOpenBots,
  onOpenProfile,
  onOpenSettings,
  onSend,
  onRetryMessage,
  onRetryRun,
  onCancelRun,
  onCancelRoomBatch,
  onRetryRoomTurn,
  onContinueRoomBatch,
  onOpenSpeaker,
}: ConversationProps): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const [roomMentions, setRoomMentions] = useState<RoomMention[]>([]);
  const [mentionQuery, setMentionQuery] = useState<ActiveMentionQuery | null>(null);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const transcriptRef = useRef<HTMLElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const pendingComposerCaretRef = useRef<number | null>(null);
  const dismissedMentionStartRef = useRef<number | null>(null);
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
  const subjectName = bot?.name ?? room?.room.name ?? "Aevoren Bot";
  const latestUserNonce = useMemo(
    () => entries.toReversed().find((entry) => entry.role === "user")?.clientNonce ?? null,
    [entries],
  );
  const runsByAssistant = useMemo(
    () => new Map(runs.filter((run) => run.assistantEntryId).map((run) => [run.assistantEntryId, run])),
    [runs],
  );
  const latestTurns = useMemo(() => {
    if (!latestBatch) return [];
    return latestRoomTurnsByLogicalTurn(roomTurns, latestBatch.id);
  }, [latestBatch, roomTurns]);
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
      const sourceTurn = roomTurnState.byId.get(handoff.fromTurnId);
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
  }, [entries]);

  useLayoutEffect(() => {
    const caret = pendingComposerCaretRef.current;
    if (caret === null) return;
    pendingComposerCaretRef.current = null;
    composerInputRef.current?.focus();
    composerInputRef.current?.setSelectionRange(caret, caret);
  }, [draft, roomMentions]);

  async function submit(): Promise<void> {
    const text = draft.trim();
    if (!text || (!bot && !room) || busy || hasInvalidRoomMentions) return;
    followTranscriptTailRef.current = true;
    const routingMode: UserRoomRoutingMode | undefined = !room
      ? undefined
      : effectiveRoomMentions.length === 0
        ? "automatic"
        : effectiveRoomMentions.some((mention) => mention.kind === "everyone")
          ? "everyone"
          : "explicit";
    const accepted = await onSend(text, room ? targetBotIds : undefined, routingMode);
    if (accepted) {
      setDraft("");
      setRoomMentions([]);
      setMentionQuery(null);
      dismissedMentionStartRef.current = null;
    }
  }

  function refreshMentionQuery(text: string, caret: number): void {
    if (!room) return;
    const next = findActiveMentionQuery(text, caret);
    if (!next) {
      dismissedMentionStartRef.current = null;
      setMentionQuery(null);
      return;
    }
    if (dismissedMentionStartRef.current === next.start) {
      setMentionQuery(null);
      return;
    }
    dismissedMentionStartRef.current = null;
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
    pendingComposerCaretRef.current = nextDraft.caret;
    setDraft(nextDraft.text);
    setMentionQuery(null);
    dismissedMentionStartRef.current = null;
  }

  return (
    <main className="conversation">
      <header className="conversation-header">
        <button className="mobile-panel-button" type="button" aria-label="打开 Bot 列表" onClick={onOpenBots}>
          <MenuIcon />
        </button>
        <div className="conversation-title">
          <h1>{subjectName}</h1>
          <p>{room?.room.description || bot?.description || (room ? `${room.members.length} 个 Bot 协作，未点名时自动选择。` : bot ? "为这个 Bot 定义职责，然后开始对话。" : "创建一个 Bot，让它持续完成一类工作。")}</p>
        </div>
        <div className="conversation-actions">
          <button className="secondary-button model-settings-button" type="button" aria-label="模型设置" title="模型设置" onClick={onOpenSettings}>
            <SettingsIcon />
            <span>模型设置</span>
          </button>
          <button className="mobile-panel-button" type="button" aria-label="打开 Bot 设置" onClick={onOpenProfile}>
            <PanelIcon />
          </button>
        </div>
      </header>

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
            <strong>从创建第一个 Bot 开始</strong>
            <span>明确选择创建后，再为它定义名称和职责。</span>
          </div>
        ) : null}
        {!loading && (bot || room) && entries.length === 0 ? (
          <div className="center-state">
            <strong>开始对话</strong>
            <span>{room ? "输入 @ 指定 Bot；未指定时自动选择最合适的 Bot。" : "告诉这个 Bot 你希望它完成什么。"}</span>
          </div>
        ) : null}
        {entries.map((entry, index) => {
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
            <TranscriptItem
              key={entry.id}
              entry={entry}
              run={run}
              canRegenerate={canRegenerate}
              canRetryRoomTurn={canRetryRoomTurn}
              groupedWithPrevious={entries[index - 1]?.role === entry.role && entries[index - 1]?.speakerBotId === entry.speakerBotId}
              groupedWithNext={entries[index + 1]?.role === entry.role && entries[index + 1]?.speakerBotId === entry.speakerBotId}
              speakerDisplayName={entry.speakerBotId
                ? roomMemberIdentities.get(entry.speakerBotId)?.inline ?? snapshotIdentities.get(entry.speakerBotId) ?? null
                : null}
              routeDisplayNames={entry.role === "user" && entry.clientNonce
                ? roomRoutesByNonce.get(entry.clientNonce)?.names ?? []
                : []}
              routeMode={entry.role === "user" && entry.clientNonce
                ? roomRoutesByNonce.get(entry.clientNonce)?.mode ?? null
                : null}
              routeReason={entry.role === "user" && entry.clientNonce
                ? roomRoutesByNonce.get(entry.clientNonce)?.reason ?? null
                : null}
              handoffs={handoffsByAssistantEntry.get(entry.id) ?? []}
              handoffRejections={handoffRejectionsByAssistantEntry.get(entry.id) ?? []}
              onRetryMessage={onRetryMessage}
              onRetryRun={onRetryRun}
              onRetryRoomTurn={onRetryRoomTurn}
              onOpenSpeaker={onOpenSpeaker}
            />
          );
        })}
      </section>

      <footer className="composer-wrap">
        {closeNotice ? <div className="composer-notice" role="alert">{closeNotice}</div> : null}
        {error ? <div className="composer-error" role="alert">{error.safeMessage}</div> : null}
        {submitting ? <div className="send-state">正在准备</div> : null}
        {!submitting && liveState && liveState.state !== "idle"
          ? <div className={"send-state runtime-" + liveState.state}>{liveLabels[liveState.state]}</div>
          : null}
        {room && latestBatch ? (
          <div className={`room-batch-state batch-${latestBatch.state}`} data-testid="room-batch-state">
            <span>{latestBatch.state === "running" ? `正在按顺序执行 ${latestTurns.length} 个协作回合` : `本批状态：${latestBatch.state}`}</span>
            {latestTurns.map((turn) => (
              <span className={`room-turn-state turn-${turn.state}`} key={turn.id}>
                {roomMemberIdentities.get(turn.memberBotId)?.inline ?? snapshotIdentities.get(turn.memberBotId) ?? turn.memberNameSnapshot}：{turn.state}
                {(turn.state === "failed" || turn.state === "cancelled" || turn.state === "interrupted" && turn.promptCutoffSeq !== null) && !busy ? (
                  <button className="text-button" type="button" onClick={() => onRetryRoomTurn(turn.id)}>重试</button>
                ) : null}
              </span>
            ))}
            {["interrupted", "partial"].includes(latestBatch.state) && latestTurns.some((turn) => turn.state === "interrupted" && turn.promptCutoffSeq === null) ? (
              <button className="text-button" type="button" onClick={() => onContinueRoomBatch(latestBatch.id)}>继续未开始成员</button>
            ) : null}
          </div>
        ) : null}
        {room ? <div className={`room-routing-hint${hasInvalidRoomMentions ? " invalid" : ""}`} role={hasInvalidRoomMentions ? "alert" : undefined}>
          {hasInvalidRoomMentions
            ? `${invalidRoomMentions.map((mention) => mention.kind === "bot" ? `@${mention.label}` : "").join("、")} 已不在群聊，请移除后重新选择`
            : effectiveRoomMentions.length === 0
            ? "未 @ 时，自动选择最合适的 Bot"
            : effectiveRoomMentions.some((mention) => mention.kind === "everyone")
              ? `已 @所有人，将调用 ${room.members.length} 个 Bot`
              : `将调用 ${targetBotIds.length} 个被 @ 的 Bot`}
        </div> : null}
        <div className="composer">
          {room && mentionQuery ? (
            <div className="mention-menu" role="listbox" aria-label="提及 Bot" id="room-mention-menu">
              <div className="mention-menu-header">提及</div>
              {mentionCandidates.length === 0 ? (
                <div className="mention-empty">未找到与“{mentionQuery.query}”匹配的 Bot <span>按 Esc 关闭</span></div>
              ) : mentionCandidates.map((item, index) => {
                const selected = effectiveRoomMentions.some((mention) => mention.id === item.id);
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
                    <span className="mention-option-icon"><BotIcon /></span>
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
          <div className="composer-editor">
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
                    onClick={() => setRoomMentions((current) => current.filter((item) => item.id !== mention.id))}
                  >@{label}<span aria-hidden="true">×</span></button>
                );
              })}
            </div> : null}
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
                    dismissedMentionStartRef.current = mentionQuery.start;
                    setMentionQuery(null);
                    return;
                  }
                }
                if (event.key === "Backspace" && event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0 && draft.length === 0 && roomMentions.length > 0) {
                  event.preventDefault();
                  setRoomMentions((current) => current.slice(0, -1));
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
              disabled={!bot && !room}
              rows={2}
            />
          </div>
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
              disabled={(!bot && !room) || !draft.trim() || busy || hasInvalidRoomMentions}
              aria-label="发送"
            >
              <SendIcon />
            </button>
          )}
        </div>
        <div className="composer-hint">Enter 发送 · Shift + Enter 换行</div>
      </footer>
    </main>
  );
}
