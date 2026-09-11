import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  AppError,
  Bot,
  RuntimeRun,
  SessionLiveState,
  SessionLiveStateName,
  TranscriptEntry,
} from "@shared/contracts";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { SendIcon, SettingsIcon, StopIcon } from "./Icons";

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
  onRetryMessage(clientNonce: string): void;
  onRetryRun(runId: string): void;
};

const TranscriptItem = memo(function TranscriptItem({
  entry,
  run,
  canRegenerate,
  onRetryMessage,
  onRetryRun,
}: TranscriptItemProps): React.JSX.Element {
  const failedBeforeAcceptance = entry.sendState === "failed-before-acceptance";
  const interrupted = run?.state === "interrupted";
  const cancelled = entry.status === "cancelled";
  const failed = entry.status === "failed";

  return (
    <article className={"message message-" + entry.role} data-status={entry.status}>
      <header>
        <strong>{entry.role === "user" ? "你" : "MS-Bot"}</strong>
        <time>{timeFormatter.format(new Date(entry.createdAt))}</time>
      </header>
      {entry.role === "assistant"
        ? <AssistantMarkdown body={entry.body} />
        : <p className="user-message-body">{entry.body}</p>}
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
        </div>
      ) : null}
    </article>
  );
});

type ConversationProps = {
  bot: Bot | null;
  entries: TranscriptEntry[];
  runs: RuntimeRun[];
  liveState: SessionLiveState | null;
  loading: boolean;
  submitting: boolean;
  error: AppError | null;
  closeNotice: string | null;
  onOpenSettings(): void;
  onSend(text: string): Promise<boolean>;
  onRetryMessage(clientNonce: string): void;
  onRetryRun(runId: string): void;
  onCancelRun(runId: string): void;
};

export function Conversation({
  bot,
  entries,
  runs,
  liveState,
  loading,
  submitting,
  error,
  closeNotice,
  onOpenSettings,
  onSend,
  onRetryMessage,
  onRetryRun,
  onCancelRun,
}: ConversationProps): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const transcriptRef = useRef<HTMLElement>(null);
  const followTranscriptTailRef = useRef(true);
  const activeRunId = liveState?.activeRunId ?? null;
  const busy = submitting || activeRunId !== null;
  const latestUserNonce = useMemo(
    () => entries.toReversed().find((entry) => entry.role === "user")?.clientNonce ?? null,
    [entries],
  );
  const runsByAssistant = useMemo(
    () => new Map(runs.filter((run) => run.assistantEntryId).map((run) => [run.assistantEntryId, run])),
    [runs],
  );

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript && followTranscriptTailRef.current) transcript.scrollTop = transcript.scrollHeight;
  }, [entries]);

  async function submit(): Promise<void> {
    const text = draft.trim();
    if (!text || !bot || busy) return;
    followTranscriptTailRef.current = true;
    const accepted = await onSend(text);
    if (accepted) setDraft("");
  }

  return (
    <main className="conversation">
      <header className="conversation-header">
        <div>
          <h1>{bot?.name ?? "MS-Bot"}</h1>
          <p>{bot?.description || (bot ? "为这个 Bot 定义职责，然后开始对话。" : "创建一个 Bot，让它持续完成一类工作。")}</p>
        </div>
        <button className="secondary-button" type="button" onClick={onOpenSettings}>
          <SettingsIcon />
          模型设置
        </button>
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
        {!loading && !bot ? (
          <div className="center-state">
            <strong>从创建第一个 Bot 开始</strong>
            <span>明确选择创建后，再为它定义名称和职责。</span>
          </div>
        ) : null}
        {!loading && bot && entries.length === 0 ? (
          <div className="center-state">
            <strong>开始对话</strong>
            <span>告诉这个 Bot 你希望它完成什么。</span>
          </div>
        ) : null}
        {entries.map((entry) => {
          const run = runsByAssistant.get(entry.id) ?? null;
          const canRegenerate = Boolean(
            run &&
            ["failed", "cancelled", "interrupted"].includes(run.state) &&
            run.clientNonce === latestUserNonce &&
            !busy,
          );
          return (
            <TranscriptItem
              key={entry.id}
              entry={entry}
              run={run}
              canRegenerate={canRegenerate}
              onRetryMessage={onRetryMessage}
              onRetryRun={onRetryRun}
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
        <div className="composer">
          <textarea
            aria-label="消息"
            placeholder={bot ? `给 ${bot.name} 发消息…` : "给 Bot 发消息…"}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            disabled={!bot}
            rows={3}
          />
          {activeRunId ? (
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
              disabled={!bot || !draft.trim() || busy}
              aria-label="发送"
            >
              <SendIcon />
              <span>发送</span>
            </button>
          )}
        </div>
        <div className="composer-hint">Enter 发送 · Shift + Enter 换行</div>
      </footer>
    </main>
  );
}
