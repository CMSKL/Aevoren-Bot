import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  AppError,
  Bot,
  RoomBatch,
  RoomDetail,
  RoomTurn,
  RuntimeRun,
  SessionLiveState,
  SessionLiveStateName,
  TranscriptEntry,
} from "@shared/contracts";
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

type TranscriptItemProps = {
  entry: TranscriptEntry;
  run: RuntimeRun | null;
  canRegenerate: boolean;
  canRetryRoomTurn: boolean;
  groupedWithPrevious: boolean;
  groupedWithNext: boolean;
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
  onRetryMessage,
  onRetryRun,
  onRetryRoomTurn,
  onOpenSpeaker,
}: TranscriptItemProps): React.JSX.Element {
  const failedBeforeAcceptance = entry.sendState === "failed-before-acceptance";
  const interrupted = run?.state === "interrupted";
  const cancelled = entry.status === "cancelled";
  const failed = entry.status === "failed";
  const longAssistant = entry.role === "assistant" && entry.body.length > 160;
  const speakerName = entry.role === "assistant" ? entry.speakerNameSnapshot ?? "MS-Bot" : "你";

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
          <div className={`message-bubble${longAssistant ? " message-bubble-long" : ""}`}>
            {entry.role === "assistant"
              ? <AssistantMarkdown body={entry.body} />
              : <p className="user-message-body">{entry.body}</p>}
          </div>
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
  roomTargetBotIds: string[];
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
  onSend(text: string, targetBotIds?: string[]): Promise<boolean>;
  onRetryMessage(clientNonce: string): void;
  onRetryRun(runId: string): void;
  onCancelRun(runId: string): void;
  onCancelRoomBatch(batchId: string): void;
  onRetryRoomTurn(turnId: string): void;
  onContinueRoomBatch(batchId: string): void;
  onOpenSpeaker(botId: string): void;
  onRoomTargetBotIdsChange(botIds: string[]): void;
};

export function Conversation({
  bot,
  room,
  roomBatches,
  roomTurns,
  roomTargetBotIds,
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
  onRoomTargetBotIdsChange,
}: ConversationProps): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const transcriptRef = useRef<HTMLElement>(null);
  const followTranscriptTailRef = useRef(true);
  const activeRunId = liveState?.activeRunId ?? null;
  const activeBatch = roomBatches.toReversed().find((batch) => batch.state === "queued" || batch.state === "running") ?? null;
  const latestBatch = roomBatches.at(-1) ?? null;
  const busy = submitting || activeRunId !== null || activeBatch !== null;
  const targetBotIds = room ? roomTargetBotIds : [];
  const subjectName = bot?.name ?? room?.room.name ?? "MS-Bot";
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
    const byMember = new Map<string, RoomTurn>();
    for (const turn of roomTurns.filter((item) => item.batchId === latestBatch.id)) {
      const current = byMember.get(turn.memberBotId);
      if (!current || current.attemptNo < turn.attemptNo) byMember.set(turn.memberBotId, turn);
    }
    return [...byMember.values()].toSorted((left, right) => left.position - right.position);
  }, [latestBatch, roomTurns]);
  const roomTurnState = useMemo(() => {
    const byId = new Map(roomTurns.map((turn) => [turn.id, turn]));
    const latestByMember = new Map<string, RoomTurn>();
    for (const turn of roomTurns) {
      const key = `${turn.batchId}:${turn.memberBotId}`;
      const current = latestByMember.get(key);
      if (!current || current.attemptNo < turn.attemptNo) latestByMember.set(key, turn);
    }
    return { byId, latestByMember };
  }, [roomTurns]);

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript && followTranscriptTailRef.current) transcript.scrollTop = transcript.scrollHeight;
  }, [entries]);

  async function submit(): Promise<void> {
    const text = draft.trim();
    if (!text || (!bot && !room) || busy || (room && targetBotIds.length === 0)) return;
    followTranscriptTailRef.current = true;
    const accepted = await onSend(text, room ? targetBotIds : undefined);
    if (accepted) setDraft("");
  }

  return (
    <main className="conversation">
      <header className="conversation-header">
        <button className="mobile-panel-button" type="button" aria-label="打开 Bot 列表" onClick={onOpenBots}>
          <MenuIcon />
        </button>
        <div className="conversation-title">
          <h1>{subjectName}</h1>
          <p>{room?.room.description || bot?.description || (room ? `${room.members.length} 个 Bot 按成员顺序协作。` : bot ? "为这个 Bot 定义职责，然后开始对话。" : "创建一个 Bot，让它持续完成一类工作。")}</p>
        </div>
        <div className="conversation-actions">
          <button className="secondary-button model-settings-button" type="button" onClick={onOpenSettings}>
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
            <span>{room ? "选择回复成员，然后发出第一条协作消息。" : "告诉这个 Bot 你希望它完成什么。"}</span>
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
            roomTurnState.latestByMember.get(`${sourceTurn.batchId}:${sourceTurn.memberBotId}`)?.id === sourceTurn.id &&
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
            <span>{latestBatch.state === "running" ? `正在按顺序调用 ${latestTurns.length} 个 Bot` : `本批状态：${latestBatch.state}`}</span>
            {latestTurns.map((turn) => (
              <span className={`room-turn-state turn-${turn.state}`} key={turn.id}>
                {turn.memberNameSnapshot}：{turn.state}
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
        {room ? (
          <div className="room-targets" aria-label="选择回复成员">
            <span>回复成员</span>
            {room.members.map((member) => {
              const selected = targetBotIds.includes(member.botId);
              return (
                <button
                  type="button"
                  className={`target-chip${selected ? " selected" : ""}`}
                  aria-pressed={selected}
                  disabled={busy}
                  key={member.botId}
                  onClick={() => onRoomTargetBotIdsChange(
                    selected ? targetBotIds.filter((id) => id !== member.botId) : [...targetBotIds, member.botId],
                  )}
                >{member.bot.name}</button>
              );
            })}
            <small>将调用 {targetBotIds.length} 个 Bot</small>
          </div>
        ) : null}
        <div className="composer">
          <textarea
            aria-label="消息"
            placeholder={room ? `给 ${room.room.name} 发消息…` : bot ? `给 ${bot.name} 发消息…` : "给 Bot 发消息…"}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            disabled={!bot && !room}
            rows={2}
          />
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
              disabled={(!bot && !room) || !draft.trim() || busy || Boolean(room && targetBotIds.length === 0)}
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
