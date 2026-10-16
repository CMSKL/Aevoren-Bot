import { useEffect, useRef, useState } from "react";
import type { TaskDetail, TaskExecutorSelection, TaskOptions } from "@shared/task-session-contracts";
import { emptyTaskSelection, toggleTaskItem } from "../task-session-state";
import { CloseIcon } from "./Icons";

type Props = { parentSessionId: string; task?: TaskDetail; onClose(): void; onSaved(task: TaskDetail): void };

export function TaskSessionDialog({ parentSessionId, task, onClose, onSaved }: Props): React.JSX.Element {
  const [options, setOptions] = useState<TaskOptions | null>(null);
  const [title, setTitle] = useState(task?.title ?? "");
  const [selections, setSelections] = useState<TaskExecutorSelection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nonce = useRef(crypto.randomUUID());
  const active = useRef(true);
  const titleRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    active.current = true;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let cancelled = false;
    void window.aevorenBot.sessions.taskOptions({ sessionId: task?.session.id ?? parentSessionId }).then(result => {
      if (cancelled) return;
      if (!result.ok) { setError(result.error.safeMessage); return; }
      setOptions(result.data);
      // Revisions start from the task's explicit saved selection, never the parent.
      setSelections(task ? structuredClone(result.data.currentSelections ?? []) : []);
      (titleRef.current ?? dialogRef.current?.querySelector<HTMLButtonElement>("button"))?.focus();
    }).catch(() => { if (!cancelled) setError("暂时无法读取任务授权选项，请关闭后重试。"); });
    return () => { cancelled = true; active.current = false; if (previous?.isConnected) previous.focus(); };
  }, [parentSessionId, task]);

  function update(id: string, change: (current: TaskExecutorSelection) => TaskExecutorSelection): void {
    setSelections(current => current.map(item => item.executorBotId === id ? change(item) : item));
  }
  async function save(): Promise<void> {
    if (!options || busy || selections.length === 0 || (!task && !title.trim())) return;
    setBusy(true); setError(null);
    try {
      const result = task ? await window.aevorenBot.sessions.reviseTaskSelection({ sessionId: task.session.id, expectedVersion: task.version, selections })
        : await window.aevorenBot.sessions.createTask({ parentSessionId, expectedScopeVersion: options.scopeVersion, clientNonce: nonce.current, title: title.trim(), selections });
      if (!active.current) return;
      if (!result.ok) { setError(`${result.error.safeMessage} 当前选择已保留，请核对后重试。`); return; }
      onSaved(result.data);
    } catch { if (active.current) setError("操作结果暂未确认，当前选择已保留。请重试查询同一次创建。"); }
    finally { if (active.current) setBusy(false); }
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={dialogRef} className="settings-dialog task-session-dialog" role="dialog" aria-modal="true" aria-labelledby="task-session-title" onKeyDown={event => {
      if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); }
      if (event.key !== "Tab") return;
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), summary")].filter(control => control.getClientRects().length > 0);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <header><div><h2 id="task-session-title">{task ? "修改任务授权" : "新建任务线程"}</h2><p>只使用明确勾选的上下文与权限；创建后打开独立聊天，不自动运行。</p></div><button className="icon-button" type="button" aria-label="关闭任务选择" disabled={busy} onClick={onClose}><CloseIcon /></button></header>
      <div className="task-session-scroll">
        {!task ? <label className="field"><span>任务名称</span><input ref={titleRef} aria-label="任务名称" maxLength={120} value={title} disabled={busy} onChange={event => setTitle(event.target.value)} /></label> : <p>修改会生成新的授权版本；现有任务历史不会从父聊天动态同步。</p>}
        {options ? <p className="task-scope-note">来源会话 {options.session.id} · 授权版本 {options.scopeVersion}。未勾选的记忆、历史、资料、文件夹、MCP 和工具均不带入。</p> : !error ? <p role="status">正在读取可选授权…</p> : null}
        {options?.executors.map(executor => {
          const selection = selections.find(item => item.executorBotId === executor.id);
          return <fieldset className="task-executor" key={executor.id} disabled={busy}>
            <legend><label><input type="checkbox" aria-label={`任务执行成员 ${executor.name}`} checked={!!selection} onChange={() => setSelections(current => selection ? current.filter(item => item.executorBotId !== executor.id) : [...current, emptyTaskSelection(executor.id)])} />{executor.name}</label></legend>
            {selection ? <>
              <details><summary>记忆与历史 ({selection.memories.length + selection.history.length})</summary>
                {executor.memories.map(memory => <label className="task-option" key={memory.id}><input type="checkbox" checked={selection.memories.some(item => item.id === memory.id)} onChange={() => update(executor.id, current => ({ ...current, memories: toggleTaskItem(current.memories, { id: memory.id, version: memory.version, digest: memory.contentDigest }, item => item.id) }))} /><span>{memory.content} <small>v{memory.version}</small></span></label>)}
                {options.history.map(entry => <label className="task-option" key={entry.entryId}><input type="checkbox" checked={selection.history.some(item => item.entryId === entry.entryId)} onChange={() => update(executor.id, current => ({ ...current, history: toggleTaskItem(current.history, { entryId: entry.entryId, generation: entry.generation, digest: entry.digest }, item => item.entryId) }))} /><span>{entry.role === "user" ? "你" : "Bot"}：{entry.body.slice(0, 240)}</span></label>)}
                {executor.memories.length + options.history.length === 0 ? <p>没有可选择的记忆或历史。</p> : null}
              </details>
              <details><summary>资料、Skill 与媒体 ({selection.resourceRefs.length + selection.mediaRefs.length})</summary>
                {options.resources.map(resource => <label className="task-option" key={resource.reference.resourceId}><input type="checkbox" checked={selection.resourceRefs.some(item => item.resourceId === resource.reference.resourceId)} onChange={() => update(executor.id, current => ({ ...current, resourceRefs: toggleTaskItem(current.resourceRefs, resource.reference, item => item.resourceId) }))} /><span>{resource.kind === "skill" ? "Skill" : "资料"}：{resource.name}<small>{resource.reference.revisionId}</small></span></label>)}
                {options.media.map(media => <label className="task-option" key={media.reference.mediaId}><input type="checkbox" checked={selection.mediaRefs.some(item => item.mediaId === media.reference.mediaId)} onChange={() => update(executor.id, current => ({ ...current, mediaRefs: toggleTaskItem(current.mediaRefs, media.reference, item => item.mediaId) }))} /><span>{media.asset.reference.name}<small>{media.reference.sha256}</small></span></label>)}
              </details>
              <details><summary>文件夹 ({selection.workspaces.length})</summary>{executor.workspaces.map(workspace => {
                const selected = selection.workspaces.find(item => item.id === workspace.id);
                return <div className="task-workspace" key={workspace.id}><label className="task-option"><input type="checkbox" checked={!!selected} onChange={() => update(executor.id, current => ({ ...current, workspaces: toggleTaskItem(current.workspaces, { id: workspace.id, read: true, write: false, automation: false }, item => item.id) }))} /><span>{workspace.name} · 读取</span></label>{selected ? <>
                  <label className="task-option"><input type="checkbox" checked={selected.write} disabled={!workspace.writeEnabled} onChange={event => update(executor.id, current => ({ ...current, workspaces: current.workspaces.map(item => item.id === workspace.id ? { ...item, write: event.target.checked, automation: event.target.checked && item.automation } : item) }))} />允许受限写入</label>
                  <label className="task-option"><input type="checkbox" checked={selected.automation} disabled={!selected.write || !workspace.automationEnabled} onChange={event => update(executor.id, current => ({ ...current, workspaces: current.workspaces.map(item => item.id === workspace.id ? { ...item, automation: event.target.checked } : item) }))} />允许该文件夹自动化</label>
                </> : null}</div>;
              })}</details>
              <details><summary>MCP 工具 ({selection.mcp.reduce((count, item) => count + item.toolNames.length, 0)})</summary>{executor.mcpTools.map(tool => <label className="task-option" key={`${tool.serverId}:${tool.name}`}><input type="checkbox" checked={selection.mcp.some(item => item.serverId === tool.serverId && item.toolNames.includes(tool.name))} onChange={() => update(executor.id, current => {
                const existing = current.mcp.find(item => item.serverId === tool.serverId), names = toggleTaskItem(existing?.toolNames ?? [], tool.name, item => item);
                return { ...current, mcp: [...current.mcp.filter(item => item.serverId !== tool.serverId), ...(names.length ? [{ serverId: tool.serverId, expectedVersion: tool.serverVersion, toolNames: names }] : [])] };
              })} /><span>{tool.serverName} · {tool.name}</span></label>)}</details>
              <details><summary>产品操作 ({selection.productOperations.length})</summary>{options.productOperations.map(operation => <label className="task-option" key={operation.name}><input type="checkbox" checked={selection.productOperations.includes(operation.name)} onChange={() => update(executor.id, current => ({ ...current, productOperations: toggleTaskItem(current.productOperations, operation.name, item => item) }))} /><span>{operation.name}<small>{operation.description}</small></span></label>)}</details>
              <label className="task-option"><input type="checkbox" checked={selection.network} onChange={event => update(executor.id, current => ({ ...current, network: event.target.checked }))} />允许联网工具（每次调用仍受现有审批约束）</label>
              <label className="task-option"><input type="checkbox" checked={selection.clipboard} onChange={event => update(executor.id, current => ({ ...current, clipboard: event.target.checked }))} />允许剪贴板工具（每次调用仍受现有审批约束）</label>
            </> : null}
          </fieldset>;
        })}
        {error ? <p className="dialog-error" role="alert">{error}</p> : null}
      </div>
      <footer><button className="secondary-button" type="button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" type="button" disabled={busy || !options || selections.length === 0 || (!task && !title.trim())} onClick={() => void save()}>{busy ? "保存中…" : task ? "保存新的授权版本" : "创建任务线程"}</button></footer>
    </section>
  </div>;
}
