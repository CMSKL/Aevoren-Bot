import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { EnvironmentScope } from "@shared/environment-contracts";
import type { ConnectorBinding, ConnectorDraft, ConnectorDraftContent, ConnectorDraftResult, ConnectorReadResult, ConnectorSearchResult, NativeConnection } from "@shared/native-connector-contracts";
import { ConnectorRequestGate, connectorDraftDirty, connectorDraftTitle, connectorEditorContent, connectorLabels, connectorStateLabels, emptyConnectorDraft, emptyNotionDraft, type ConnectorEditor, type NotionDraftKind } from "../connector-ui-state";
import "../styles/connectors.css";
import { ConnectorOutboundSection } from "./ConnectorOutboundSection";
import { NotionDraftEditor } from "./NotionDraftEditor";

export type ConnectorPanelHandle = { flush(): Promise<boolean> };
type Props = EnvironmentScope & { active?: boolean; ownerName?: string };

export const ConnectorPanel = forwardRef<ConnectorPanelHandle, Props>(function ConnectorPanel({ sessionId, executorBotId, active = true, ownerName }, ref) {
  const scopeKey = `${sessionId}:${executorBotId}`;
  const scope = { sessionId, executorBotId };
  const [connections, setConnections] = useState<NativeConnection[]>([]);
  const [bindings, setBindings] = useState<ConnectorBinding[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [searchResult, setSearchResult] = useState<ConnectorSearchResult | null>(null);
  const [readResult, setReadResult] = useState<ConnectorReadResult | null>(null);
  const [drafts, setDrafts] = useState<ConnectorDraft[]>([]);
  const [editor, setEditor] = useState<ConnectorEditor | null>(null);
  const [versions, setVersions] = useState<Omit<ConnectorDraftResult["revision"], "content">[] | null>(null);
  const [pending, setPending] = useState(false);
  const [reading, setReading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [leavePrompt, setLeavePrompt] = useState(false);
  const editorRef = useRef(editor);
  const draftCache = useRef(new Map<string, ConnectorEditor | null>());
  const currentKey = useRef(scopeKey);
  const mounted = useRef(true);
  const gate = useRef(new ConnectorRequestGate());
  const readGate = useRef(new ConnectorRequestGate());
  const leave = useRef<{ promise: Promise<boolean>; resolve(value: boolean): void } | null>(null);
  const savePromise = useRef<Promise<boolean> | null>(null);
  const connection = connections.find(item => item.id === connectionId) ?? null;
  const binding = bindings.find(item => item.connectionId === connection?.id && item.revokedAt === null) ?? null;
  const authorized = Boolean(connection?.state === "connected" && binding?.authVersion === connection.authVersion);
  const dirty = connectorDraftDirty(editor);
  const busy = pending || reading;
  const current = useCallback((key: string): boolean => mounted.current && currentKey.current === key, []);

  const replaceEditor = useCallback((next: ConnectorEditor | null): void => {
    editorRef.current = next;
    draftCache.current.set(currentKey.current, next);
    setEditor(next); setVersions(null); setConfirmDelete(false);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    if (!active) return;
    const key = scopeKey;
    const valid = gate.current.begin();
    readGate.current.invalidate();
    setLoading(true); setReading(false); setReadResult(null); setSearchResult(null);
    try {
      const [list, grants, localDrafts] = await Promise.all([
        window.aevorenBot.connectors.list({}),
        window.aevorenBot.connectors.bindings({ sessionId, executorBotId, includeRevoked: true }),
        window.aevorenBot.drafts.list({ sessionId, executorBotId }),
      ]);
      if (!valid() || !current(key)) return;
      if (list.ok) setConnections(list.data); else setError(list.error.safeMessage);
      if (grants.ok) setBindings(grants.data); else setError(grants.error.safeMessage);
      if (localDrafts.ok) setDrafts(localDrafts.data); else setError(localDrafts.error.safeMessage);
    } catch { if (valid() && current(key)) setError("暂时无法读取当前成员的应用授权。"); }
    finally { if (valid() && current(key)) setLoading(false); }
  }, [active, scopeKey, sessionId, executorBotId, current]);

  useEffect(() => {
    mounted.current = true;
    const listRequests = gate.current;
    const readRequests = readGate.current;
    return () => { mounted.current = false; listRequests.invalidate(); readRequests.invalidate(); leave.current?.resolve(false); };
  }, []);
  useEffect(() => {
    const listRequests = gate.current;
    const readRequests = readGate.current;
    if (currentKey.current !== scopeKey) {
      draftCache.current.set(currentKey.current, editorRef.current);
      currentKey.current = scopeKey;
      const cached = draftCache.current.get(scopeKey) ?? null;
      editorRef.current = cached; setEditor(cached);
      setConnectionId(cached?.connectionId ?? ""); setConnections([]); setBindings([]); setDrafts([]);
      setQuery(""); setSelectedFiles([]); setVersions(null); setReadResult(null); setSearchResult(null); setPending(false); setReading(false); setError(null); setNotice(null); setConfirmRevoke(false); setConfirmDelete(false);
      leave.current?.resolve(false); leave.current = null; setLeavePrompt(false);
    }
    if (!active) { listRequests.invalidate(); readRequests.invalidate(); return; }
    void load();
    return () => { listRequests.invalidate(); readRequests.invalidate(); };
  }, [scopeKey, active, load]);
  useEffect(() => {
    readGate.current.invalidate(); setSearchResult(null); setReadResult(null); setReading(false);
    setSelectedFiles(binding?.allowedResourceIds ?? []);
  }, [connectionId, connection?.authVersion, connection?.state, binding?.id, binding?.version, binding?.revokedAt, binding?.allowedResourceIds]);
  const authKey = connection && binding ? `${connection.id}:${connection.state}:${connection.authVersion}:${binding.id}:${binding.version}:${binding.revokedAt}` : "";
  useEffect(() => {
    if (!active || !connectionId) return;
    let disposed = false;
    let inFlight = false;
    const refresh = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const [list, grants] = await Promise.all([
          window.aevorenBot.connectors.list({}),
          window.aevorenBot.connectors.bindings({ sessionId, executorBotId, includeRevoked: true }),
        ]);
        if (disposed || !current(scopeKey) || !list.ok || !grants.ok) return;
        const nextConnection = list.data.find(item => item.id === connectionId);
        const nextBinding = grants.data.find(item => item.connectionId === connectionId && item.revokedAt === null);
        const nextKey = nextConnection && nextBinding ? `${nextConnection.id}:${nextConnection.state}:${nextConnection.authVersion}:${nextBinding.id}:${nextBinding.version}:${nextBinding.revokedAt}` : "";
        if (nextKey !== authKey) {
          readGate.current.invalidate(); setReadResult(null); setSearchResult(null); setReading(false);
          setConnections(list.data); setBindings(grants.data);
          setNotice("连接或成员授权已变化，请确认当前读取范围。");
        }
      } catch { /* The host still checks every read; offline status never grants access. */ }
      finally { inFlight = false; }
    };
    const timer = setInterval(() => void refresh(), 3000);
    return () => { disposed = true; clearInterval(timer); };
  }, [active, connectionId, authKey, sessionId, executorBotId, scopeKey, current]);

  function access(): (EnvironmentScope & { connectionId: string; expectedAuthVersion: number; expectedBindingVersion: number }) | null {
    return connection && binding && authorized ? { ...scope, connectionId: connection.id, expectedAuthVersion: connection.authVersion, expectedBindingVersion: binding.version } : null;
  }

  async function grant(): Promise<void> {
    if (!connection || connection.state !== "connected" || pending) return;
    const key = scopeKey; setPending(true); setError(null); setNotice(null); readGate.current.invalidate(); setReading(false); setReadResult(null); setSearchResult(null);
    try {
      const previous = bindings.find(item => item.connectionId === connection.id);
      const result = await window.aevorenBot.connectors.bind({ ...scope, connectionId: connection.id, expectedAuthVersion: connection.authVersion, ...(previous ? { expectedVersion: previous.version } : {}), ...(connection.provider === "drive" ? { allowedResourceIds: selectedFiles } : {}) });
      if (!current(key)) return;
      if (result.ok) { setNotice("已授权此聊天中的当前成员读取所选范围。"); await load(); } else setError(result.error.safeMessage);
    } catch { if (current(key)) setError("读取授权未能保存。"); }
    finally { if (current(key)) setPending(false); }
  }

  async function revoke(): Promise<void> {
    if (!binding || pending) return;
    const key = scopeKey; setPending(true); setError(null); setConfirmRevoke(false); readGate.current.invalidate(); setReading(false); setReadResult(null); setSearchResult(null);
    try {
      const result = await window.aevorenBot.connectors.unbind({ ...scope, id: binding.id, expectedVersion: binding.version });
      if (!current(key)) return;
      if (result.ok) { setNotice("当前成员的读取授权已撤销。"); await load(); } else setError(result.error.safeMessage);
    } catch { if (current(key)) setError("撤销未完成，请刷新查看授权状态。"); }
    finally { if (current(key)) setPending(false); }
  }

  async function search(cursor?: string): Promise<void> {
    const input = access(); if (!input || busy) return;
    const key = scopeKey; const valid = readGate.current.begin(); setReading(true); setError(null); setReadResult(null);
    try {
      const result = await window.aevorenBot.connectors.search({ ...input, query, ...(cursor ? { cursor } : {}), limit: 20 });
      if (!current(key) || !valid()) return;
      if (result.ok) setSearchResult(result.data); else { setSearchResult(null); setError(result.error.safeMessage); }
    } catch { if (current(key) && valid()) setError("搜索未完成。"); }
    finally { if (current(key) && valid()) setReading(false); }
  }

  async function read(resourceId: string): Promise<void> {
    const input = access(); if (!input || busy) return;
    const key = scopeKey; const valid = readGate.current.begin(); setReading(true); setError(null); setReadResult(null);
    try {
      const result = await window.aevorenBot.connectors.read({ ...input, resourceId });
      if (!current(key) || !valid()) return;
      if (result.ok) setReadResult(result.data); else setError(result.error.safeMessage);
    } catch { if (current(key) && valid()) setError("内容读取未完成。"); }
    finally { if (current(key) && valid()) setReading(false); }
  }

  async function save(): Promise<boolean> {
    if (savePromise.current) return savePromise.current;
    const editing = editorRef.current;
    if (!editing || !connectorDraftDirty(editing)) return true;
    const input = access();
    if (!editing.saved && (!input || input.connectionId !== editing.connectionId)) { setError("请先授权当前成员，再保存新的本地草稿。"); return false; }
    const key = scopeKey;
    const promise = (async (): Promise<boolean> => {
      setPending(true); setError(null); setNotice(null);
      try {
        const result = editing.saved
          ? await window.aevorenBot.drafts.update({ ...scope, id: editing.saved.draft.id, expectedVersion: editing.saved.draft.version, content: connectorEditorContent(editing) })
          : await window.aevorenBot.drafts.create({ ...input!, ...(editing.clientNonce ? { clientNonce: editing.clientNonce } : {}), content: connectorEditorContent(editing) });
        if (!current(key)) return false;
        if (!result.ok) { setError(`${result.error.safeMessage} 当前草稿仍保留在编辑器中。`); return false; }
        replaceEditor({ connectionId: result.data.draft.connectionId, saved: result.data, content: result.data.revision.content });
        setNotice(`本地草稿已保存 · 版本 ${result.data.revision.number}。尚未向外部应用提交。`);
        await load(); return true;
      } catch { if (current(key)) setError("草稿未能保存。当前文字仍保留在编辑器中。"); return false; }
      finally { if (current(key)) setPending(false); }
    })();
    savePromise.current = promise;
    try { return await promise; } finally { if (savePromise.current === promise) savePromise.current = null; }
  }

  function flush(): Promise<boolean> {
    if (!connectorDraftDirty(editorRef.current)) return savePromise.current ?? Promise.resolve(true);
    if (leave.current) return leave.current.promise;
    let resolve!: (value: boolean) => void;
    const promise = new Promise<boolean>(done => { resolve = done; });
    leave.current = { promise, resolve }; setLeavePrompt(true); return promise;
  }
  function finishLeave(value: boolean): void { leave.current?.resolve(value); leave.current = null; setLeavePrompt(false); }
  useImperativeHandle(ref, () => ({ flush }));

  async function openDraft(draft: ConnectorDraft): Promise<void> {
    if (busy || !(await flush())) return;
    const key = scopeKey; setPending(true); setError(null); setNotice(null);
    try {
      const result = await window.aevorenBot.drafts.read({ ...scope, id: draft.id });
      if (!current(key)) return;
      if (result.ok) { setConnectionId(draft.connectionId); replaceEditor({ connectionId: result.data.draft.connectionId, saved: result.data, content: result.data.revision.content }); }
      else setError(result.error.safeMessage);
    } catch { if (current(key)) setError("暂时无法读取本地草稿。"); }
    finally { if (current(key)) setPending(false); }
  }
  async function newDraft(): Promise<void> {
    if (!connection || !authorized || busy || !(await flush())) return;
    replaceEditor({ connectionId: connection.id, saved: null, clientNonce: crypto.randomUUID(), content: emptyConnectorDraft(connection.provider) }); setError(null); setNotice(null);
  }
  async function showVersions(): Promise<void> {
    const saved = editorRef.current?.saved; if (!saved || pending) return;
    const key = scopeKey; setPending(true); setError(null);
    try {
      const result = await window.aevorenBot.drafts.versions({ ...scope, id: saved.draft.id });
      if (!current(key) || editorRef.current?.saved?.draft.id !== saved.draft.id) return;
      if (result.ok) setVersions(result.data); else setError(result.error.safeMessage);
    } catch { if (current(key)) setError("暂时无法读取草稿版本。"); }
    finally { if (current(key)) setPending(false); }
  }
  async function readVersion(revisionId: string): Promise<void> {
    const saved = editorRef.current?.saved; if (!saved || pending || !(await flush())) return;
    const key = scopeKey; setPending(true); setError(null);
    try {
      const result = await window.aevorenBot.drafts.read({ ...scope, id: saved.draft.id, revisionId });
      if (!current(key) || editorRef.current?.saved?.draft.id !== saved.draft.id) return;
      if (result.ok) { replaceEditor({ connectionId: saved.draft.connectionId, saved, content: result.data.revision.content }); setNotice(`版本 ${result.data.revision.number} 已载入编辑器。再次保存将产生新版本。`); } else setError(result.error.safeMessage);
    } catch { if (current(key)) setError("暂时无法读取草稿版本。"); }
    finally { if (current(key)) setPending(false); }
  }
  async function deleteDraft(): Promise<void> {
    const saved = editorRef.current?.saved; if (!saved || pending) return;
    const key = scopeKey; setPending(true); setError(null); setConfirmDelete(false);
    try {
      const result = await window.aevorenBot.drafts.delete({ ...scope, id: saved.draft.id, expectedVersion: saved.draft.version });
      if (!current(key)) return;
      if (result.ok) { replaceEditor(null); setNotice("本地草稿已删除。"); await load(); } else setError(`${result.error.safeMessage} 当前草稿仍保留。`);
    } catch { if (current(key)) setError("草稿未能删除。"); }
    finally { if (current(key)) setPending(false); }
  }
  function edit(content: ConnectorDraftContent): void { if (editor) replaceEditor({ ...editor, content }); }
  async function changeNotionKind(kind: NotionDraftKind): Promise<void> {
    const editing = editorRef.current;
    const key = scopeKey;
    if (!editing || editing.saved || busy || !(await flush())) return;
    if (!current(key)) return;
    replaceEditor({ connectionId: editing.connectionId, saved: null, clientNonce: crypto.randomUUID(), content: emptyNotionDraft(kind) });
  }

  if (!active) return <section hidden aria-label="聊天应用" />;
  if (currentKey.current !== scopeKey) return <section className="connector-panel" aria-label="聊天应用"><p className="connector-note" role="status">正在切换当前成员的应用范围…</p></section>;
  return <section className="connector-panel" aria-label="聊天应用">
    <div className="connector-heading"><h3>应用</h3><span>{loading ? "正在读取授权…" : authorized ? "当前成员已授权" : "尚未授权读取"}</span></div>
    <p className="connector-note">{ownerName ?? "当前成员"} · 连接授权仅属于当前聊天与执行成员。加入群聊不会带入私聊授权。</p>
    <p className="connector-note">授权后，此成员可读取范围内的内容，并将读取内容交给其当前配置的模型处理。其他成员仍需单独授权；写入权限需另行授予。</p>
    <p className="connector-note">请先在设置中的「应用连接」配置账号。在此读取已授权内容、保存草稿，并逐次审批外发。</p>
    {error ? <p className="connector-error" role="alert">{error}</p> : null}
    {notice ? <p className="connector-note" role="status">{notice}</p> : null}
    {leavePrompt ? <div className="connector-confirm" role="group" aria-label="未保存应用草稿"><p>当前应用草稿尚未保存。保存或丢弃后继续。</p><div className="connector-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => void save().then(saved => { if (saved) finishLeave(true); })}>保存草稿并继续</button><button type="button" className="secondary-button" disabled={busy} onClick={() => { const saved = editorRef.current?.saved; replaceEditor(saved ? { connectionId: saved.draft.connectionId, saved, content: saved.revision.content } : null); finishLeave(true); }}>丢弃修改并继续</button><button type="button" className="secondary-button" disabled={busy} onClick={() => finishLeave(false)}>继续编辑</button></div></div> : null}
    <label className="field"><span>应用连接</span><select aria-label="当前聊天的应用连接" value={connectionId} disabled={busy} onChange={event => { const id = event.target.value; void flush().then(allowed => { if (allowed) { setConnectionId(id); replaceEditor(null); setError(null); setNotice(null); setConfirmRevoke(false); } }); }}><option value="">选择应用连接…</option>{connections.map(item => <option key={item.id} value={item.id}>{item.name} · {connectorLabels[item.provider]} · {connectorStateLabels[item.state]}</option>)}</select></label>
    <div className="connector-actions"><button className="secondary-button" type="button" disabled={pending || loading} onClick={() => void load()}>刷新授权</button></div>
    {connection ? <section aria-label="成员读取授权">
      <p className="connector-note">账号：{connection.account?.email ?? connection.account?.displayName ?? "尚未确认"} · {connectorStateLabels[connection.state]}</p>
      <p className="connector-note">读取范围：{connection.provider === "gmail" ? "此账号的邮件，需逐个聊天成员授权。" : connection.provider === "drive" ? "下方明确选择的文件；未选择的文件不可读取。" : "已共享给此内部连接的页面；搜索仅匹配页面标题。"}</p>
      {connection.provider === "drive" ? <div aria-label="Drive 成员文件范围">{[...new Set([...connection.selectedFileIds, ...connection.createdFileIds])].map(id => <label className="connector-file-selection" key={id}><input type="checkbox" checked={selectedFiles.includes(id)} disabled={busy || connection.state !== "connected"} onChange={event => setSelectedFiles(files => event.target.checked ? [...files, id] : files.filter(file => file !== id))} /><span>{id}</span></label>)}{!connection.selectedFileIds.length && !connection.createdFileIds.length ? <p className="connector-note">尚未选择文件，请在应用连接设置中重新授权并选择。</p> : null}</div> : null}
      <div className="connector-actions"><button className="secondary-button" type="button" disabled={pending || connection.state !== "connected" || (connection.provider === "drive" && selectedFiles.length === 0)} onClick={() => void grant()}>{authorized ? "更新当前成员读取范围" : "授权当前成员读取"}</button>{authorized ? <button className="text-button danger" type="button" disabled={pending} onClick={() => setConfirmRevoke(true)}>撤销成员读取授权</button> : null}</div>
      {confirmRevoke ? <div className="connector-confirm" role="group" aria-label="确认撤销成员授权"><p>撤销后，当前聊天中的此成员不能继续读取该连接。本地草稿仍保留。</p><div className="connector-actions"><button className="secondary-button danger" type="button" disabled={pending} onClick={() => void revoke()}>确认撤销成员授权</button><button className="secondary-button" type="button" onClick={() => setConfirmRevoke(false)}>保留读取授权</button></div></div> : null}
    </section> : null}
    <section className="connector-section" aria-label="应用内容搜索"><h4>搜索与读取</h4><label className="field"><span>搜索内容</span><input aria-label="应用搜索内容" maxLength={2000} value={query} disabled={busy || !authorized} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Enter") void search(); }} /></label><button className="secondary-button" type="button" disabled={busy || !authorized} onClick={() => void search()}>搜索应用内容</button>
      {searchResult ? <><p className="connector-note">{searchResult.scopeNotice}</p><div className="connector-results">{searchResult.items.map(item => <button className="connector-result" type="button" disabled={busy || !authorized} key={item.id} onClick={() => void read(item.id)}>{item.title}<small>{item.kind}{item.modifiedAt ? ` · ${item.modifiedAt}` : ""}</small></button>)}</div>{searchResult.items.length === 0 ? <p className="connector-note">当前授权范围内没有匹配内容。</p> : null}{searchResult.nextCursor ? <button className="secondary-button" type="button" disabled={busy} onClick={() => void search(searchResult.nextCursor!)}>下一页结果</button> : null}</> : null}
      {readResult ? <article className="connector-read" aria-label="应用读取结果"><h4>{readResult.title}</h4><pre>{readResult.text || "此内容没有可显示的文本。"}</pre>{readResult.truncated ? <p className="connector-note">文本已截断。</p> : null}<dl>{Object.entries(readResult.metadata).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value ?? "")}</dd></div>)}</dl>{readResult.attachments?.length ? <><p className="connector-note">附件仅显示元信息，此阶段未下载或解析附件内容。</p><ul>{readResult.attachments.map(item => <li key={item.id}>{item.filename} · {item.mimeType} · {item.size} 字节</li>)}</ul></> : null}{typeof readResult.metadata.binaryBytesRead === "number" ? <p className="connector-note">此资源含二进制内容，此阶段没有传送图像或解析二进制文件。</p> : null}</article> : null}
    </section>
    <section className="connector-section" aria-label="本地应用草稿"><div className="connector-heading"><h4>本地草稿</h4><span>{dirty ? "未保存" : editor?.saved ? `已保存 · 版本 ${editor.saved.revision.number}` : ""}</span></div><p className="connector-note">保存仅写入本机，不会发送邮件、上传 Drive 文件或更新 Notion 页面。</p><button className="secondary-button" type="button" disabled={busy || !authorized} onClick={() => void newDraft()}>新建本地草稿</button>
      <div className="connector-draft-list">{drafts.filter(item => !connectionId || item.connectionId === connectionId).map(item => <button className={`connector-result${editor?.saved?.draft.id === item.id ? " selected" : ""}`} key={item.id} type="button" disabled={busy} onClick={() => void openDraft(item)}>{editor?.saved?.draft.id === item.id ? connectorDraftTitle(editor.content) : `本地草稿 · ${item.updatedAt}`}<small>版本 {item.version} · {connections.some(value => value.id === item.connectionId && value.authVersion === item.authVersion && value.state === "connected") && bindings.some(value => value.connectionId === item.connectionId && value.authVersion === item.authVersion && value.revokedAt === null) ? "读取授权有效" : "授权已失效，草稿保留"}</small></button>)}</div>
      {editor ? <section aria-label="应用草稿编辑器">
        {editor.content.kind === "gmail-message" ? <><label className="field"><span>收件人（逗号分隔）</span><input aria-label="草稿收件人" value={editor.toText ?? editor.content.to.join(", ")} disabled={busy} onChange={event => { if (editor.content.kind === "gmail-message") replaceEditor({ ...editor, toText: event.target.value }); }} /></label><label className="field"><span>抄送（逗号分隔）</span><input aria-label="草稿抄送" value={editor.ccText ?? editor.content.cc.join(", ")} disabled={busy} onChange={event => { if (editor.content.kind === "gmail-message") replaceEditor({ ...editor, ccText: event.target.value }); }} /></label><label className="field"><span>主题</span><input aria-label="邮件草稿主题" maxLength={998} value={editor.content.subject} disabled={busy} onChange={event => { if (editor.content.kind === "gmail-message") edit({ ...editor.content, subject: event.target.value }); }} /></label><label className="field"><span>正文</span><textarea aria-label="邮件草稿正文" maxLength={100_000} value={editor.content.body} disabled={busy} onChange={event => { if (editor.content.kind === "gmail-message") edit({ ...editor.content, body: event.target.value }); }} /></label></> : editor.content.kind === "drive-text" ? <><label className="field"><span>目标文件 ID（留空为新文件草稿）</span><input aria-label="Drive 草稿目标文件" maxLength={256} value={editor.content.targetFileId ?? ""} disabled={busy} onChange={event => { if (editor.content.kind === "drive-text") edit({ ...editor.content, targetFileId: event.target.value || null }); }} /></label><label className="field"><span>标题</span><input aria-label="文件草稿标题" maxLength={1024} value={editor.content.title} disabled={busy} onChange={event => { if (editor.content.kind === "drive-text") edit({ ...editor.content, title: event.target.value }); }} /></label><label className="field"><span>正文</span><textarea aria-label="文件草稿正文" maxLength={100_000} value={editor.content.text} disabled={busy} onChange={event => { if (editor.content.kind === "drive-text") edit({ ...editor.content, text: event.target.value }); }} /></label></> : <NotionDraftEditor content={editor.content} saved={Boolean(editor.saved)} busy={busy} onChange={edit} onKindChange={kind => void changeNotionKind(kind)} />}
        <div className="connector-actions"><button className="secondary-button" type="button" disabled={busy || !dirty} onClick={() => void save()}>{busy ? "处理中…" : "保存本地草稿"}</button>{editor.saved ? <><button className="secondary-button" type="button" disabled={busy} onClick={() => void showVersions()}>查看草稿版本</button><button className="text-button danger" type="button" disabled={busy} onClick={() => setConfirmDelete(true)}>删除本地草稿</button></> : null}</div>
        {versions ? <div aria-label="草稿版本列表">{versions.map(version => <button className="connector-result" type="button" key={version.id} disabled={busy} onClick={() => void readVersion(version.id)}>版本 {version.number} · {version.createdAt}</button>)}</div> : null}
        {confirmDelete ? <div className="connector-confirm" role="group" aria-label="确认删除本地草稿"><p>删除此本地草稿；外部应用内容不受影响。</p><div className="connector-actions"><button className="secondary-button danger" type="button" disabled={busy} onClick={() => void deleteDraft()}>确认删除本地草稿</button><button className="secondary-button" type="button" onClick={() => setConfirmDelete(false)}>保留草稿</button></div></div> : null}
      </section> : null}
    </section>
    <ConnectorOutboundSection key={`${scopeKey}:${connectionId}`} sessionId={sessionId} executorBotId={executorBotId} connection={connection} saved={editor?.saved ?? null} dirty={dirty} active={active} ownerName={ownerName} />
  </section>;
});
