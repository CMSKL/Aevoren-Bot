import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import type { ApiResult } from "@shared/contracts";
import type { MediaAsset, MediaItem, MessageMediaReference } from "@shared/media-contracts";
import { MediaPreviewDialog } from "./MediaPreviewDialog";
import "../styles/library.css";
import "../styles/media.css";

export function MediaLibraryPanel({ sessionId, active = true, busy = false, onUse }: { sessionId: string; active?: boolean; busy?: boolean; onUse(reference: MessageMediaReference): void }): React.JSX.Element {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [available, setAvailable] = useState<MediaItem[] | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<MessageMediaReference | null>(null);
  const [confirmation, setConfirmation] = useState<{ item: MediaItem; action: "delete" | "unbind" } | null>(null);
  const scopeRef = useRef({ sessionId, active });
  useLayoutEffect(() => { scopeRef.current = { sessionId, active }; }, [sessionId, active]);
  const requestRef = useRef(0);
  const mountedRef = useRef(true);
  const current = useCallback((scope: string): boolean => mountedRef.current && scopeRef.current.active && scopeRef.current.sessionId === scope, []);
  const load = useCallback(async (): Promise<void> => {
    if (!active) return;
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const result = await window.aevorenBot.media.list({ sessionId, query, includeDisabled: true, includeDeleted: true });
      if (!current(sessionId) || request !== requestRef.current) return;
      if (result.ok) setItems(result.data); else setError(result.error.safeMessage);
    } catch { if (current(sessionId) && request === requestRef.current) setError("无法读取当前会话媒体，请重试。"); }
    finally { if (current(sessionId) && request === requestRef.current) setLoading(false); }
  }, [sessionId, query, active, current]);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; requestRef.current += 1; }; }, []);
  useEffect(() => { let cancelled = false; queueMicrotask(() => { if (cancelled) return; setItems([]); setAvailable(null); setPreview(null); setConfirmation(null); setError(null); setNotice(null); setPending(false); void load(); }); return () => { cancelled = true; requestRef.current += 1; }; }, [load]);
  const changed = useEffectEvent((): void => { if (active) void load(); });
  useEffect(() => window.aevorenBot.media.onChanged(() => changed()), []);

  async function perform<T>(work: () => Promise<ApiResult<T>>, apply?: (value: T) => void): Promise<void> {
    if (pending || !active) return;
    const scope = sessionId;
    setPending(true); setError(null);
    try {
      const result = await work();
      if (!current(scope)) return;
      if (result.ok) { apply?.(result.data); void load(); }
      else setError(result.error.safeMessage);
    } catch { if (current(scope)) setError("媒体操作未完成，请重试。"); }
    finally { if (current(scope)) setPending(false); }
  }
  async function chooseExisting(): Promise<void> {
    await perform(async () => {
      const [all, bound] = await Promise.all([window.aevorenBot.media.available({ includeDisabled: true }), window.aevorenBot.media.list({ sessionId, includeDisabled: true, includeDeleted: true })]);
      if (!all.ok) return all;
      if (!bound.ok) return bound;
      const ids = new Set(bound.data.map(item => item.asset.reference.id));
      return { ok: true as const, data: all.data.filter(item => !ids.has(item.asset.reference.id)) };
    }, setAvailable);
  }
  return <section className="library-panel media-library-panel" aria-label="媒体资料库" hidden={!active}>
    {active ? <><header className="library-panel-heading"><div><h3>媒体资料</h3><p className="field-help">仅当前会话已绑定的媒体可供 AI 读取。Bot 加入群聊不会共享私聊媒体。</p></div></header>
      <div className="library-actions"><button className="secondary-button" type="button" disabled={pending} onClick={() => void perform(() => window.aevorenBot.media.pickImport({ sessionId }), result => { if (!result) return; setNotice(`已导入 ${result.imported.length} 个媒体${result.failed.length ? `；${result.failed.map(item => `${item.name}：${item.reason}`).join("；")}` : "。"}`); })}>导入媒体文件</button><button className="text-button" type="button" disabled={pending} onClick={() => void chooseExisting()}>添加已有媒体</button></div>
      <p className="field-help">支持 PNG、JPEG、PDF、DOCX 和可解码音视频；音视频限 16 MiB、10 分钟，视频仅供本地预览。单条消息最多 6 个媒体、合计 32 MiB。导入后由应用保存真实内容，移动原文件仍可读取。</p>
      <label className="field"><span>搜索当前会话媒体</span><input aria-label="搜索当前会话媒体" value={query} onChange={event => setQuery(event.target.value)} /></label>
      {error ? <p className="library-error" role="alert">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}{loading ? <p role="status">正在读取媒体…</p> : null}
      {available ? <div className="library-available" aria-label="选择要绑定的媒体"><header><strong>选择媒体并明确授权到当前会话</strong><button className="text-button" type="button" onClick={() => setAvailable(null)}>关闭选择</button></header>{available.map(item => <div className="library-available-item" key={item.asset.reference.id}><span>{item.asset.reference.name} · {item.asset.kind.toUpperCase()}{!item.asset.enabled ? " · 已停用" : ""}</span><button className="secondary-button" type="button" disabled={pending} onClick={() => void perform(() => window.aevorenBot.media.bind({ sessionId, id: item.asset.reference.id }), () => setAvailable(previous => previous?.filter(candidate => candidate.asset.reference.id !== item.asset.reference.id) ?? null))}>添加到当前会话</button></div>)}{available.length === 0 ? <p className="library-empty">暂无未绑定的媒体。</p> : null}</div> : null}
      <div className="media-library-list">{items.map(item => { const asset = item.asset, unavailable = !asset.enabled || Boolean(asset.deletedAt); return <article className="media-library-item" key={asset.reference.id}><div><strong>{asset.reference.name}</strong><small>{asset.kind.toUpperCase()} · {Math.max(1, Math.round(asset.reference.size / 1024))} KB{asset.deletedAt ? " · 已删除" : !asset.enabled ? " · 已停用" : ""}</small></div><div className="library-actions"><button className="text-button" type="button" disabled={pending || unavailable} onClick={() => setPreview(item.reference)}>预览 {asset.reference.name}</button><button className="secondary-button" type="button" disabled={pending || busy || unavailable} onClick={() => onUse(item.reference)}>引用媒体到消息</button>{asset.deletedAt ? <button className="text-button" type="button" disabled={pending} onClick={() => void perform(() => window.aevorenBot.media.restore({ sessionId, id: asset.reference.id, expectedVersion: asset.version }))}>恢复媒体</button> : <><button className="text-button" type="button" disabled={pending} onClick={() => void perform(() => window.aevorenBot.media.setEnabled({ sessionId, id: asset.reference.id, expectedVersion: asset.version, enabled: !asset.enabled }))}>{asset.enabled ? "停用媒体" : "启用媒体"}</button><button className="text-button danger-text-button" type="button" disabled={pending} onClick={() => setConfirmation({ item, action: "delete" })}>删除媒体</button></>}<button className="text-button" type="button" disabled={pending} onClick={() => setConfirmation({ item, action: "unbind" })}>移出当前会话</button></div></article>; })}</div>
      {!loading && items.length === 0 ? <p className="library-empty">当前会话没有匹配的媒体。</p> : null}
      {confirmation ? <div className="library-confirm" role="alert"><p>{confirmation.action === "delete" ? "删除媒体会阻止所有已绑定会话后续读取；可从当前会话恢复。" : "仅撤销当前会话的媒体绑定，其他会话不受影响。"}</p><button className="secondary-button" type="button" disabled={pending} onClick={() => { const target = confirmation; setConfirmation(null); void perform<MediaAsset | boolean>(() => target.action === "delete" ? window.aevorenBot.media.delete({ sessionId, id: target.item.asset.reference.id, expectedVersion: target.item.asset.version }) : window.aevorenBot.media.unbind({ sessionId, id: target.item.asset.reference.id })); }}>确认媒体操作</button><button className="text-button" type="button" onClick={() => setConfirmation(null)}>取消</button></div> : null}
      {preview ? <MediaPreviewDialog key={JSON.stringify(preview)} sessionId={sessionId} reference={preview} onClose={() => setPreview(null)} /> : null}
    </> : null}
  </section>;
}
