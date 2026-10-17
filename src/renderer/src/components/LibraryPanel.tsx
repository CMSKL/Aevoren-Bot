import { forwardRef, useCallback, useEffect, useEffectEvent, useImperativeHandle, useRef, useState } from "react";
import type { ApiResult } from "@shared/contracts";
import type { LibraryContent, LibraryResource, LibraryResourceKind, ResourceReference, ResourceRevisionSummary } from "@shared/library-contracts";
import type { EnvironmentScope } from "@shared/environment-contracts";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { SkillScriptsSection } from "./SkillScriptsSection";
import "../styles/library.css";

type Draft = { name: string; description: string; body: string };
type CachedEditor = { content: LibraryContent | null; draft: Draft | null; creating: boolean };
export type LibraryPanelHandle = { flush(): Promise<boolean> };
export type LibraryPanelProps = {
  sessionId: string;
  kind: LibraryResourceKind;
  active?: boolean;
  busy?: boolean;
  executorBotId?: string;
  ownerName?: string;
  onOpenExecution?(input: EnvironmentScope & { id: string }): void;
  onUse(reference: ResourceReference, text?: string): void;
};

function toDraft(content: LibraryContent): Draft {
  return { name: content.revision.name, description: content.revision.description, body: content.revision.body };
}

function differs(draft: Draft | null, content: LibraryContent | null, creating: boolean): boolean {
  if (!draft) return false;
  if (creating) return Boolean(draft.name || draft.description || draft.body);
  return Boolean(content && (draft.name !== content.revision.name || draft.description !== content.revision.description || draft.body !== content.revision.body));
}

export const LibraryPanel = forwardRef<LibraryPanelHandle, LibraryPanelProps>(function LibraryPanel(
  { sessionId, kind, active = true, busy = false, executorBotId, ownerName, onOpenExecution, onUse }, ref,
) {
  const scope = `${sessionId}:${kind}`;
  const [editorScope, setEditorScope] = useState(scope);
  const [items, setItems] = useState<LibraryResource[]>([]);
  const [content, setContent] = useState<LibraryContent | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [preview, setPreview] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [versions, setVersions] = useState<ResourceRevisionSummary[] | null>(null);
  const [available, setAvailable] = useState<LibraryResource[] | null>(null);
  const [confirmation, setConfirmation] = useState<{ message: string; action: () => Promise<void> } | null>(null);
  const [navigation, setNavigation] = useState<(() => void) | null>(null);
  const navigationActionRef = useRef<(() => void) | null>(null);
  const replaceNavigation = useCallback((action: (() => void) | null): void => {
    navigationActionRef.current = action;
    setNavigation(() => action);
  }, []);
  const cacheRef = useRef(new Map<string, CachedEditor>());
  const scopeRef = useRef(scope);
  const mountedRef = useRef(true);
  const editorRef = useRef<CachedEditor>({ content, draft, creating });
  const listRequestRef = useRef(0);
  const readRequestRef = useRef(0);
  const savePromiseRef = useRef<Promise<boolean> | null>(null);
  const leaveRef = useRef<{ promise: Promise<boolean>; resolve: (saved: boolean) => void } | null>(null);
  const pendingCountRef = useRef(0);
  const dirty = differs(draft, content, creating);
  const label = kind === "skill" ? "Skill" : "资料";
  const isCurrent = useCallback((requestScope: string): boolean => mountedRef.current && scopeRef.current === requestScope, []);
  const beginPending = useCallback((): void => { pendingCountRef.current += 1; setPending(true); }, []);
  const endPending = useCallback((requestScope: string): void => {
    if (!isCurrent(requestScope)) return;
    pendingCountRef.current = Math.max(0, pendingCountRef.current - 1);
    setPending(pendingCountRef.current > 0);
  }, [isCurrent]);

  const replaceEditor = useCallback((next: CachedEditor): void => {
    editorRef.current = next;
    cacheRef.current.set(scopeRef.current, next);
    setContent(next.content);
    setDraft(next.draft);
    setCreating(next.creating);
  }, []);

  const loadList = useCallback(async (): Promise<void> => {
    if (!active) return;
    const requestScope = scope;
    const request = ++listRequestRef.current;
    setLoading(true);
    try {
      const result = await window.aevorenBot.library.list({ sessionId, kind, query, includeDisabled: true, includeDeleted });
      if (!isCurrent(requestScope) || request !== listRequestRef.current) return;
      if (result.ok) setItems(result.data);
      else setError(result.error.safeMessage);
    } catch {
      if (isCurrent(requestScope) && request === listRequestRef.current) setError("暂时无法加载资料库，请重试。");
    } finally {
      if (isCurrent(requestScope) && request === listRequestRef.current) setLoading(false);
    }
  }, [active, scope, sessionId, kind, query, includeDeleted, isCurrent]);

  const readSelection = useCallback(async (id: string): Promise<void> => {
    const requestScope = scope;
    const request = ++readRequestRef.current;
    beginPending();
    setError(null);
    setVersions(null);
    try {
      const result = await window.aevorenBot.library.read({ sessionId, id, includeDisabled: true, includeDeleted: true });
      if (!isCurrent(requestScope) || request !== readRequestRef.current) return;
      if (result.ok) replaceEditor({ content: result.data, draft: toDraft(result.data), creating: false });
      else setError(result.error.safeMessage);
    } catch {
      if (isCurrent(requestScope) && request === readRequestRef.current) setError("暂时无法读取这份资源，请重试。");
    } finally {
      endPending(requestScope);
    }
  }, [scope, sessionId, isCurrent, replaceEditor, beginPending, endPending]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; listRequestRef.current += 1; readRequestRef.current += 1; leaveRef.current?.resolve(false); leaveRef.current = null; };
  }, []);

  useEffect(() => {
    scopeRef.current = scope;
    listRequestRef.current += 1;
    readRequestRef.current += 1;
    setEditorScope(scope);
    replaceEditor(cacheRef.current.get(scope) ?? { content: null, draft: null, creating: false });
    setItems([]);
    setQuery("");
    setIncludeDeleted(false);
    setVersions(null);
    setAvailable(null);
    setConfirmation(null);
    replaceNavigation(null);
    leaveRef.current?.resolve(false);
    leaveRef.current = null;
    setError(null);
    setNotice(null);
    setPending(false);
    pendingCountRef.current = 0;
    setPreview(false);
  }, [scope, replaceEditor, replaceNavigation]);

  useEffect(() => { void loadList(); }, [loadList]);

  const refreshSelection = useEffectEvent((): void => {
    const current = editorRef.current;
    if (active && current.content && !differs(current.draft, current.content, current.creating)) void readSelection(current.content.resource.id);
  });
  useEffect(() => { refreshSelection(); }, [scope, active]);

  const changed = useEffectEvent((event: { sessionId: string; resourceId: string; action: string }): void => {
    if (!active) return;
    // Shared resources may change in another conversation. Refresh metadata without replacing a local draft.
    void loadList();
    if (event.resourceId !== editorRef.current.content?.resource.id) return;
    if (differs(editorRef.current.draft, editorRef.current.content, editorRef.current.creating)) {
      setNotice("这份资源已发生变化。你的草稿已保留；保存时会核对版本。");
    } else if (event.action === "unbound" && event.sessionId === sessionId) {
      replaceEditor({ content: null, draft: null, creating: false });
    } else {
      void readSelection(event.resourceId);
    }
  });
  useEffect(() => window.aevorenBot.library.onChanged(event => changed(event)), []);

  async function save(): Promise<boolean> {
    if (savePromiseRef.current) return savePromiseRef.current;
    const current = editorRef.current;
    if (!differs(current.draft, current.content, current.creating)) return true;
    if (!current.draft?.name.trim()) { setError(`请输入${label}名称。`); return false; }
    const requestScope = scope;
    const submitted = { ...current.draft };
    beginPending();
    setError(null);
    const promise = (async (): Promise<boolean> => {
      try {
        const result = current.creating
          ? await window.aevorenBot.library.create({ sessionId, kind, ...submitted })
          : await window.aevorenBot.library.update({ sessionId, id: current.content!.resource.id, expectedVersion: current.content!.resource.version, ...submitted });
        if (!isCurrent(requestScope)) return false;
        if (!result.ok) { setError(`${result.error.safeMessage} 草稿已保留。`); return false; }
        replaceEditor({ content: result.data, draft: toDraft(result.data), creating: false });
        setNotice("已保存新版本。");
        setVersions(null);
        void loadList();
        return true;
      } catch {
        if (isCurrent(requestScope)) setError("保存失败，草稿已保留。请重试。");
        return false;
      } finally {
        endPending(requestScope);
      }
    })();
    savePromiseRef.current = promise;
    try { return await promise; } finally { savePromiseRef.current = null; }
  }
  function requestLeave(): Promise<boolean> {
    if (leaveRef.current) return leaveRef.current.promise;
    const current = editorRef.current;
    if (!differs(current.draft, current.content, current.creating)) return Promise.resolve(true);
    let resolveLeave!: (saved: boolean) => void;
    const promise = new Promise<boolean>(resolve => { resolveLeave = resolve; });
    leaveRef.current = { promise, resolve: resolveLeave };
    replaceNavigation(() => {
      leaveRef.current?.resolve(true);
      leaveRef.current = null;
    });
    return promise;
  }
  useImperativeHandle(ref, () => ({ flush: requestLeave }));

  function navigate(action: () => void): void {
    if (leaveRef.current) return;
    if (differs(editorRef.current.draft, editorRef.current.content, editorRef.current.creating)) replaceNavigation(action);
    else action();
  }

  async function perform<T>(operation: () => Promise<ApiResult<T>>, apply?: (data: T) => void): Promise<void> {
    const requestScope = scope;
    beginPending();
    setError(null);
    try {
      const result = await operation();
      if (!isCurrent(requestScope)) return;
      if (!result.ok) { setError(result.error.safeMessage); return; }
      apply?.(result.data);
      void loadList();
    } catch {
      if (isCurrent(requestScope)) setError("操作失败，请重试。已有草稿仍然保留。");
    } finally {
      endPending(requestScope);
    }
  }

  function newResource(): void {
    navigate(() => {
      readRequestRef.current += 1;
      replaceEditor({ content: null, draft: { name: "", description: "", body: "" }, creating: true });
      setVersions(null); setError(null); setNotice(null); setPreview(false);
    });
  }

  function askMutation(message: string, action: () => Promise<void>): void {
    navigate(() => setConfirmation({ message, action }));
  }

  async function importResource(directory: boolean): Promise<void> {
    await perform(() => window.aevorenBot.library.pickImport({ sessionId, kind, directory }), (result) => {
      if (!result) return;
      const imported = result.imported[0];
      if (imported) replaceEditor({ content: imported, draft: toDraft(imported), creating: false });
      setNotice(`已导入 ${result.imported.length} 份${label}${result.skipped.length ? `；${result.skipped.map(item => `${item.name}：${item.reason}`).join("；")}` : "。"}`);
    });
  }

  async function referenceResource(): Promise<void> {
    if (busy || !(await save())) return;
    if (!isCurrent(scope)) return;
    const current = editorRef.current.content;
    if (!current || current.resource.deletedAt || !current.resource.enabled) return;
    onUse(current.reference, kind === "skill" ? `请使用「${current.revision.name}」完成以下任务：` : undefined);
  }

  if (!active) return <section hidden className="library-panel" aria-label={`${label}库`} />;
  if (editorScope !== scope) return <section className="library-panel" aria-label={`${label}库`}><p role="status">正在切换会话…</p></section>;
  const deleted = content?.resource.deletedAt !== null && Boolean(content);
  const editable = Boolean(draft) && !deleted;
  return (
    <section className="library-panel" aria-label={`${label}库`} data-testid="library-panel">
      <header className="library-panel-heading"><h3>{kind === "skill" ? "Skill" : "资料库"}</h3><span role="status">{pending ? "处理中…" : dirty ? "未保存" : "已保存"}</span></header>
      <p className="library-scope-note">仅当前会话绑定的{label}可供本次对话使用。将 Bot 加入群聊不会自动共享它的私聊资源。</p>
      <div className="library-toolbar">
        <button type="button" className="secondary-button" disabled={pending} onClick={newResource}>新建{label}</button>
        <button type="button" className="text-button" disabled={pending} onClick={() => navigate(() => void importResource(false))}>导入文件</button>
        {kind === "skill" ? <button type="button" className="text-button" disabled={pending} onClick={() => navigate(() => void importResource(true))}>导入技能目录</button> : null}
        <button type="button" className="text-button" disabled={pending} onClick={() => void perform(async () => {
          const [resources, bound] = await Promise.all([window.aevorenBot.library.available({ kind, includeDisabled: true }), window.aevorenBot.library.list({ sessionId, kind, includeDisabled: true, includeDeleted: true })]);
          if (!resources.ok) return resources;
          if (!bound.ok) return bound;
          const ids = new Set(bound.data.map(item => item.id));
          return { ok: true, data: resources.data.filter(item => !ids.has(item.id)) };
        }, setAvailable)}>添加已有{label}</button>
      </div>
      {error ? <div><p className="library-error" role="alert">{error}</p>{content ? <button type="button" className="text-button" disabled={pending} onClick={() => void perform(() => window.aevorenBot.library.read({ sessionId, id: content.resource.id, includeDisabled: true, includeDeleted: true }), data => {
        replaceEditor({ content: data, draft: editorRef.current.draft ?? toDraft(data), creating: false });
        setNotice("已读取最新保存版本，草稿仍然保留。展开“当前保存内容”核对后再保存。");
      })}>读取最新版本，保留草稿</button> : null}</div> : null}
      {notice ? <p className="library-notice" role="status">{notice}</p> : null}
      {navigation ? <div className="library-confirm" role="alert"><p>当前草稿尚未保存。</p><div className="library-actions">
        <button className="primary-button" type="button" disabled={pending} onClick={() => { const action = navigation; void save().then(saved => { if (saved && navigationActionRef.current === action) { replaceNavigation(null); action(); } }); }}>保存并继续</button>
        <button className="text-button danger-text-button" type="button" disabled={pending} onClick={() => { const action = navigation; replaceEditor({ content, draft: content ? toDraft(content) : null, creating: false }); replaceNavigation(null); action(); }}>丢弃草稿并继续</button>
        <button className="text-button" type="button" onClick={() => { replaceNavigation(null); leaveRef.current?.resolve(false); leaveRef.current = null; }}>继续编辑</button>
      </div></div> : null}
      {confirmation ? <div className="library-confirm" role="alert"><p>{confirmation.message}</p><div className="library-actions"><button type="button" className="secondary-button" disabled={pending} onClick={() => { const action = confirmation.action; setConfirmation(null); void action(); }}>确认</button><button className="text-button" type="button" onClick={() => setConfirmation(null)}>取消</button></div></div> : null}
      {available ? <div className="library-available" aria-label={`添加已有${label}`}><header><strong>选择要绑定到当前会话的{label}</strong><button className="text-button" type="button" onClick={() => setAvailable(null)}>关闭</button></header>
        {available.map(item => <div className="library-available-item" key={item.id}><div><strong>{item.name}</strong><small>{item.description || `${label} · v${item.version}`}{!item.enabled ? " · 已停用" : ""}</small></div><button className="secondary-button" type="button" disabled={pending} onClick={() => void perform(() => window.aevorenBot.library.bind({ sessionId, id: item.id }), () => setAvailable(current => current?.filter(resource => resource.id !== item.id) ?? null))}>添加到当前会话</button></div>)}
        {available.length === 0 ? <p className="library-empty">暂无未绑定的{label}。</p> : null}
      </div> : null}
      <label className="field library-search"><span>搜索{label}</span><input value={query} maxLength={200} onChange={event => setQuery(event.target.value)} placeholder="搜索名称或正文" aria-label={`搜索${label}`} /></label>
      <div className="library-list-options"><button className="text-button" type="button" aria-pressed={includeDeleted} onClick={() => setIncludeDeleted(value => !value)}>{includeDeleted ? "隐藏已删除" : "显示已删除"}</button><button className="text-button" type="button" disabled={loading} onClick={() => void loadList()}>刷新列表</button></div>
      <div className="library-resource-list" aria-label={`当前会话${label}`}>
        {loading ? <p className="library-empty" role="status">正在加载…</p> : items.length === 0 ? <p className="library-empty">{query ? "没有匹配的资源。" : `当前会话尚未绑定${label}。`}</p> : null}
        {items.map(item => <button className={`library-resource-row${content?.resource.id === item.id ? " selected" : ""}`} type="button" key={item.id} disabled={pending} aria-pressed={content?.resource.id === item.id} onClick={() => navigate(() => void readSelection(item.id))}><strong>{item.name}</strong><span>{item.description}</span><small>v{item.version}{item.deletedAt ? " · 已删除" : !item.enabled ? " · 已停用" : ""}</small></button>)}
      </div>
      {draft ? <article className="library-editor" aria-label={`${label}编辑器`}>
        <div className="library-editor-heading"><strong>{creating ? `新建${label}` : content?.resource.name}</strong><span>{content ? `v${content.resource.version}` : "新草稿"}</span></div>
        <label className="field"><span>名称</span><input value={draft.name} maxLength={120} aria-label={`${label}名称`} disabled={!editable || pending} onChange={event => replaceEditor({ content, draft: { ...draft, name: event.target.value }, creating })} /></label>
        <label className="field"><span>描述</span><textarea value={draft.description} maxLength={2000} rows={2} aria-label={`${label}描述`} disabled={!editable || pending} onChange={event => replaceEditor({ content, draft: { ...draft, description: event.target.value }, creating })} /></label>
        <div className="library-editor-mode" role="group" aria-label="正文显示方式"><button className="text-button" type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>编辑 Markdown</button><button className="text-button" type="button" aria-pressed={preview} onClick={() => setPreview(true)}>预览</button></div>
        {preview ? <div className="library-preview" aria-label={`${label}预览`}><AssistantMarkdown body={draft.body} /></div> : <label className="field"><span>{kind === "skill" ? "Skill 指令（Markdown）" : "正文（Markdown）"}</span><textarea className="library-body" rows={12} maxLength={1048576} value={draft.body} aria-label={`${label}正文`} disabled={!editable || pending} onChange={event => replaceEditor({ content, draft: { ...draft, body: event.target.value }, creating })} /></label>}
        {dirty && content ? <details className="library-files"><summary>当前保存内容 · v{content.resource.version}</summary><strong>{content.revision.name}</strong><p>{content.revision.description}</p><div className="library-preview"><AssistantMarkdown body={content.revision.body} /></div></details> : null}
        {content?.revision.files.length ? <details className="library-files"><summary>包含 {content.revision.files.length} 个已保存的资源文件</summary><ul>{content.revision.files.map(file => <li key={file.relativePath}>{file.relativePath}<small>{file.size} bytes · {file.mimeType}</small></li>)}</ul></details> : null}
        {kind === "skill" ? <p className="library-scope-note">添加到消息后，点击发送才会启动任务。文本指令按需加载；脚本需为当前聊天与执行成员单独授权，只在指定 Linux 环境运行。元信息不会授予工具权限。</p> : null}
        <div className="library-actions"><button type="button" className="primary-button" disabled={pending || !editable || !dirty || !draft.name.trim()} onClick={() => void save()}>保存{label}</button><button type="button" className="secondary-button" disabled={busy || pending || deleted || !draft.name.trim() || content?.resource.enabled === false} onClick={() => void referenceResource()}>{kind === "skill" ? "添加 Skill 到消息" : "引用到消息"}</button>
          {dirty ? <button type="button" className="text-button" disabled={pending} onClick={() => setConfirmation({ message: "丢弃当前未保存的草稿？", action: async () => { replaceEditor({ content, draft: content ? toDraft(content) : null, creating: false }); setError(null); } })}>丢弃草稿</button> : null}
        </div>
        {content ? <div className="library-resource-actions">
          <button type="button" className="text-button" disabled={pending} onClick={() => void perform(() => window.aevorenBot.library.versions({ sessionId, id: content.resource.id, includeDisabled: true, includeDeleted: true }), setVersions)}>版本记录</button>
          <button type="button" className="text-button" disabled={pending} onClick={() => void perform(() => window.aevorenBot.library.export({ sessionId, id: content.resource.id, revisionId: content.revision.id }), result => { if (result) setNotice("已导出当前保存版本。"); })}>导出保存版本</button>
          {!deleted && kind === "skill" ? <button type="button" className="text-button" disabled={pending} onClick={() => askMutation(content.resource.enabled ? "停用后，此 Skill 将无法再被加载。当前草稿需要先保存或丢弃。" : "启用此 Skill？", async () => perform(() => window.aevorenBot.library.setEnabled({ sessionId, id: content.resource.id, expectedVersion: editorRef.current.content?.resource.version ?? content.resource.version, enabled: !content.resource.enabled }), () => void readSelection(content.resource.id)))}>{content.resource.enabled ? "停用 Skill" : "启用 Skill"}</button> : null}
          <button type="button" className="text-button" disabled={pending} onClick={() => askMutation("仅从当前会话移出；其他会话的绑定和资源本身会保留。", async () => perform(() => window.aevorenBot.library.unbind({ sessionId, id: content.resource.id }), () => { replaceEditor({ content: null, draft: null, creating: false }); setNotice("已从当前会话移出。"); }))}>移出当前会话</button>
          {deleted ? <button type="button" className="text-button" disabled={pending} onClick={() => void perform(() => window.aevorenBot.library.restore({ sessionId, id: content.resource.id, expectedVersion: content.resource.version }), () => void readSelection(content.resource.id))}>恢复资源</button> : <button type="button" className="text-button danger-text-button" disabled={pending} onClick={() => askMutation("删除资源会影响所有已绑定会话。内容和版本保留，可在“显示已删除”中恢复；只移出当前会话请使用“移出当前会话”按钮。", async () => perform(() => window.aevorenBot.library.delete({ sessionId, id: content.resource.id, expectedVersion: editorRef.current.content?.resource.version ?? content.resource.version }), () => void readSelection(content.resource.id)))}>删除资源</button>}
        </div> : null}
        {kind === "skill" && content && executorBotId ? <SkillScriptsSection sessionId={sessionId} executorBotId={executorBotId} reference={content.reference} resourceName={content.revision.name} revisionNumber={content.revision.number} ownerName={ownerName} active={active} disabled={dirty || pending || deleted || !content.resource.enabled} onOpenExecution={onOpenExecution} /> : null}
        {versions && content ? <section className="library-versions" aria-label="资源版本记录"><header><strong>版本记录</strong><button className="text-button" type="button" onClick={() => setVersions(null)}>收起</button></header>{versions.map(version => <div key={version.id}><span>v{version.number} · {version.name}<small>{new Date(version.createdAt).toLocaleString()} · {version.fileCount} 个文件</small></span><button type="button" className="text-button" disabled={pending || deleted || version.id === content.revision.id} onClick={() => askMutation(`将 v${version.number} 的内容恢复为一个新版本？`, async () => perform(() => window.aevorenBot.library.restoreVersion({ sessionId, id: content.resource.id, expectedVersion: editorRef.current.content?.resource.version ?? content.resource.version, revisionId: version.id }), data => { replaceEditor({ content: data, draft: toDraft(data), creating: false }); setVersions(null); setNotice("已恢复为新版本。"); }))}>恢复此版本</button></div>)}</section> : null}
      </article> : null}
    </section>
  );
});
