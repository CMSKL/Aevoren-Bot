import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AppError, Bot, SendState, TranscriptEntry } from "@shared/contracts";
import { SendIcon, SettingsIcon, StopIcon } from "./Icons";

const timeFormatter = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" });

const sendLabels: Partial<Record<SendState, string>> = {
  prepared: "正在准备",
  queued: "等待发送",
  dispatching: "正在连接模型",
  "accepted-awaiting-echo": "模型已接受，等待确认",
  acked: "正在生成",
  "failed-before-acceptance": "发送失败",
  "interrupted-unknown": "结果未知，请勿重复发送",
  cancelled: "已取消",
};

function StructuredText({ body }: { body: string }): React.JSX.Element {
  const lines = useMemo(() => body.split("\n"), [body]);
  return (
    <div className="structured-text">
      {lines.map((line, index) => {
        const key = `${index}-${line.slice(0, 12)}`;
        if (line.startsWith("## ")) return <h3 key={key}>{line.slice(3)}</h3>;
        if (/^\d+\.\s/.test(line)) return <p className="numbered-line" key={key}>{line}</p>;
        if (line.trim().length === 0) return <span className="text-gap" key={key} aria-hidden="true" />;
        return <p key={key}>{line}</p>;
      })}
    </div>
  );
}

function TranscriptItem({ entry, onRetry }: { entry: TranscriptEntry; onRetry(clientNonce: string): void }): React.JSX.Element {
  const failedBeforeAcceptance = entry.sendState === "failed-before-acceptance";
  return (
    <article className={`message message-${entry.role}`} data-status={entry.status}>
      <header>
        <strong>{entry.role === "user" ? "你" : "MS-Bot"}</strong>
        <time>{timeFormatter.format(new Date(entry.createdAt))}</time>
      </header>
      {entry.role === "assistant" ? <StructuredText body={entry.body} /> : <p className="user-message-body">{entry.body}</p>}
      {entry.status === "streaming" ? <div className="streaming-indicator">正在生成<span /></div> : null}
      {entry.status === "cancelled" ? <div className="entry-note">回复已停止</div> : null}
      {entry.status === "failed" ? (
        <div className={`entry-note ${entry.sendState === "interrupted-unknown" ? "warning" : "error"}`}>
          {entry.sendState === "interrupted-unknown" ? "应用中断，模型可能已接受该消息；不会自动重发。" : "消息未成功发送。"}
          {failedBeforeAcceptance && entry.clientNonce ? (
            <button type="button" className="text-button" onClick={() => onRetry(entry.clientNonce!)}>安全重试</button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

type ConversationProps = {
  bot: Bot | null;
  entries: TranscriptEntry[];
  loading: boolean;
  activeNonce: string | null;
  activeState: SendState | null;
  error: AppError | null;
  onOpenSettings(): void;
  onSend(text: string): Promise<boolean>;
  onRetry(clientNonce: string): void;
  onCancel(clientNonce: string): void;
};

export function Conversation({
  bot,
  entries,
  loading,
  activeNonce,
  activeState,
  error,
  onOpenSettings,
  onSend,
  onRetry,
  onCancel,
}: ConversationProps): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const transcriptRef = useRef<HTMLElement>(null);
  const followTranscriptTailRef = useRef(true);
  const busy = activeNonce !== null;

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
          <h1>{bot?.name ?? "产品需求分析助手"}</h1>
          <p>{bot?.description ?? "创建一个 Bot，将模糊想法转化为结构化、可执行的产品需求。"}</p>
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
        {!loading && !bot ? <div className="center-state"><strong>从创建第一个 Bot 开始</strong><span>它会使用预设的产品需求分析方法工作。</span></div> : null}
        {!loading && bot && entries.length === 0 ? (
          <div className="center-state"><strong>描述一个产品想法</strong><span>MS-Bot 会整理背景、范围、需求、验收标准与风险。</span></div>
        ) : null}
        {entries.map((entry) => <TranscriptItem key={entry.id} entry={entry} onRetry={onRetry} />)}
      </section>

      <footer className="composer-wrap">
        {error ? <div className="composer-error" role="alert">{error.safeMessage}</div> : null}
        {activeState ? <div className="send-state">{sendLabels[activeState] ?? activeState}</div> : null}
        <div className="composer">
          <textarea
            aria-label="产品想法"
            placeholder="描述你的产品想法…"
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
          {activeNonce ? (
            <button className="send-button stop" type="button" onClick={() => onCancel(activeNonce)} aria-label="停止回复">
              <StopIcon />
            </button>
          ) : (
            <button className="send-button" type="button" onClick={() => void submit()} disabled={!bot || !draft.trim()} aria-label="发送">
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
