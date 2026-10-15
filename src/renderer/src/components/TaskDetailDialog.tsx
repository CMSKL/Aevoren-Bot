import { useEffect, useRef, useState } from "react";
import type { TaskDetail } from "@shared/task-session-contracts";
import { CloseIcon } from "./Icons";

type Props = { task: TaskDetail; onClose(): void; onChanged(task: TaskDetail): void; onDeleted(sessionId: string): void; onRevise(): void };

export function TaskDetailDialog({ task, onClose, onChanged, onDeleted, onRevise }: Props): React.JSX.Element {
  const [title, setTitle] = useState(task.title);
  const [expectedVersion, setExpectedVersion] = useState(task.version);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<"cancel" | "delete" | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  async function act(action: "rename" | "cancel" | "delete"): Promise<void> {
    if (busy || (action === "rename" && !title.trim())) return;
    setBusy(true); setError(null);
    try {
      if (action === "delete") {
        const result = await window.aevorenBot.sessions.deleteTask({ sessionId: task.session.id, expectedVersion });
        if (!result.ok) { setError(result.error.safeMessage); return; }
        onDeleted(task.session.id);
      } else {
        const result = action === "rename" ? await window.aevorenBot.sessions.updateTask({ sessionId: task.session.id, expectedVersion, title: title.trim() })
          : await window.aevorenBot.sessions.cancelTask({ sessionId: task.session.id, expectedVersion });
        if (!result.ok) { setError(`${result.error.safeMessage} 当前名称草稿仍保留。`); return; }
        setExpectedVersion(result.data.version); onChanged(result.data); setConfirmation(null);
      }
    } catch { setError("操作暂未完成，请核对当前任务后重试。"); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="settings-dialog task-session-dialog" role="dialog" aria-modal="true" aria-labelledby="task-detail-title" onKeyDown={event => {
      if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); }
      if (event.key !== "Tab") return;
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")].filter(control => control.getClientRects().length > 0);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <header><div><h2 id="task-detail-title">任务线程详情</h2><p>此线程拥有独立的历史、草稿、运行与明确授权。</p></div><button type="button" className="icon-button" disabled={busy} onClick={onClose} aria-label="关闭任务线程详情"><CloseIcon /></button></header>
      <div className="task-session-scroll">
        <label className="field"><span>任务名称</span><input ref={inputRef} aria-label="修改任务名称" value={title} maxLength={120} disabled={busy} onChange={event => setTitle(event.target.value)} /></label>
        <button type="button" className="secondary-button" disabled={busy || !title.trim() || title.trim() === task.title} onClick={() => void act("rename")}>保存任务名称</button>
        {task.version !== expectedVersion ? <p className="task-scope-note">任务已有其他修改。当前草稿及其原始版本保留；关闭后重新打开可读取最新版本。</p> : null}
        <dl className="task-session-metadata"><dt>任务会话 ID</dt><dd>{task.session.id}</dd><dt>父会话 ID</dt><dd>{task.parentSessionId ?? "无"}</dd><dt>任务版本</dt><dd>{task.version}</dd><dt>授权版本</dt><dd>{task.scopeVersion}</dd><dt>执行成员</dt><dd>{task.admittedExecutorBotIds.join("、")}</dd></dl>
        <h3>固定授权摘要</h3>
        <ul className="task-selection-digests">{task.selectionDigests.map(selection => <li key={selection.executorBotId}><strong>{selection.executorBotId} · v{selection.version}</strong><code>{selection.digest}</code></li>)}</ul>
        <button className="secondary-button" type="button" disabled={busy} onClick={onRevise}>修改任务授权</button>
        <p>新增或变更授权需在单独选择窗口审阅；不会自动同步父聊天或其他任务的权限。</p>
        {confirmation ? <div className="task-confirmation" role="alert"><p>{confirmation === "cancel" ? "停止此任务线程中正在运行的任务？其他聊天及兄弟任务会继续。" : "永久删除此任务线程及其历史？Bot 联系人与原群聊仍保留。"}</p><button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirmation(null)}>返回</button><button type="button" className="danger-button" disabled={busy} onClick={() => void act(confirmation)}>{confirmation === "cancel" ? "确认停止此任务" : "确认删除此任务线程"}</button></div> : <div className="task-session-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirmation("cancel")}>停止此任务</button><button type="button" className="danger-button" disabled={busy} onClick={() => setConfirmation("delete")}>删除此任务线程</button></div>}
        {error ? <p className="dialog-error" role="alert">{error}</p> : null}
      </div><footer><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>完成</button></footer>
    </section>
  </div>;
}
