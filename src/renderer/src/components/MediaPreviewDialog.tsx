import { useCallback, useEffect, useRef, useState } from "react";
import type { MediaItem, MediaPreview, MediaTextPage, MessageMediaReference } from "@shared/media-contracts";
import { CloseIcon } from "./Icons";
import "../styles/media.css";

export function MediaPreviewDialog({ sessionId, reference, onClose }: { sessionId: string; reference: MessageMediaReference; onClose(): void }): React.JSX.Element {
  const referenceKey = JSON.stringify(reference);
  const [item, setItem] = useState<MediaItem | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [offset, setOffset] = useState(0);
  const [image, setImage] = useState<{ key: string; value: MediaPreview } | null>(null);
  const [text, setText] = useState<{ key: string; value: MediaTextPage } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const requestRef = useRef(0);
  const playerRef = useRef<HTMLMediaElement | null>(null);
  const playbackUrl = useRef<string | null>(null);
  const [playback, setPlayback] = useState<{ key: string; url: string; kind: "audio" | "video" } | null>(null);
  const clearPlayback = useCallback(() => {
    const player = playerRef.current;
    if (player) { player.pause(); player.removeAttribute("src"); player.load(); }
    if (playbackUrl.current) URL.revokeObjectURL(playbackUrl.current);
    playbackUrl.current = null;
  }, []);
  const setPlayer = useCallback((node: HTMLMediaElement | null) => {
    if (!node) clearPlayback();
    playerRef.current = node;
  }, [clearPlayback]);
  const [previousOffsets, setPreviousOffsets] = useState<number[]>([]);
  const closeRef = useRef<HTMLButtonElement>(null);
  const viewKey = `${sessionId}:${referenceKey}:${pageIndex}:${offset}`;

  useEffect(() => {
    const original = document.activeElement;
    closeRef.current?.focus();
    return () => { if (original instanceof HTMLElement && original.isConnected) original.focus(); };
  }, []);
  useEffect(() => {
    const request = ++requestRef.current;
    const fixed = JSON.parse(referenceKey) as MessageMediaReference;
    queueMicrotask(() => {
      if (request !== requestRef.current) return;
      clearPlayback(); setPlayback(null); setImage(null); setText(null); setError(null); setLoading(true);
      void (async () => {
      try {
        const metadata = await window.aevorenBot.media.metadata({ sessionId, id: fixed.mediaId });
        if (request !== requestRef.current) return;
        if (!metadata.ok) { setError(metadata.error.safeMessage); return; }
        if (!metadata.data.asset.enabled || metadata.data.asset.deletedAt || metadata.data.asset.reference.sha256 !== fixed.sha256) { setError("媒体已停用、删除或引用不匹配，无法预览。"); return; }
        setItem(metadata.data);
        if (metadata.data.asset.kind === "docx") {
          const result = await window.aevorenBot.media.read({ sessionId, id: fixed.mediaId, reference: fixed, offset, maxCharacters: 16_000 });
          if (request !== requestRef.current) return;
          if (result.ok) setText({ key: viewKey, value: result.data });
          else setError(result.error.safeMessage);
        } else {
          const result = await window.aevorenBot.media.preview({ sessionId, id: fixed.mediaId, reference: fixed, ...(metadata.data.asset.kind === "pdf" ? { pageIndex } : {}) });
          if (request !== requestRef.current) return;
          if (!result.ok) { setError(result.error.safeMessage); return; }
          if ("media" in result.data) {
            const kind = metadata.data.asset.kind;
            if ((kind !== "audio" && kind !== "video") || result.data.media.sha256 !== fixed.sha256) { setError("预览格式不受支持。"); return; }
            const bytes = Uint8Array.from(atob(result.data.dataBase64), character => character.charCodeAt(0));
            clearPlayback();
            const url = URL.createObjectURL(new Blob([bytes], { type: result.data.media.mimeType }));
            playbackUrl.current = url; setPlayback({ key: viewKey, url, kind });
          } else {
            if (!["image/png", "image/jpeg"].includes(result.data.image.mimeType)) { setError("预览格式不受支持。"); return; }
            setImage({ key: viewKey, value: result.data });
          }
        }
      } catch { if (request === requestRef.current) setError("媒体预览未完成，请重试。"); }
      finally { if (request === requestRef.current) setLoading(false); }
      })();
    });
    return () => { requestRef.current += 1; clearPlayback(); };
  }, [sessionId, referenceKey, pageIndex, offset, viewKey, clearPlayback]);
  useEffect(() => window.aevorenBot.media.onChanged(event => {
    if (event.mediaId !== reference.mediaId || (["bound", "unbound"].includes(event.action) && event.sessionId !== sessionId)) return;
    requestRef.current += 1;
    clearPlayback(); setPlayback(null); setImage(null); setText(null); setLoading(false);
    setError("媒体授权或状态已变化，预览内容已清除。请关闭后重新打开。");
  }), [sessionId, reference.mediaId, clearPlayback]);

  const shownImage = image?.key === viewKey && "image" in image.value ? image.value : null;
  const shownPlayback = playback?.key === viewKey ? playback : null;
  const shownText = text?.key === viewKey ? text.value : null;
  return <div className="modal-backdrop media-preview-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="media-preview-dialog" role="dialog" aria-modal="true" aria-label="媒体预览" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
      <header><div><h2>{item?.asset.reference.name ?? "媒体预览"}</h2><p>当前会话的固定媒体引用</p></div><button ref={closeRef} className="icon-button" type="button" aria-label="关闭媒体预览" onClick={onClose}><CloseIcon /></button></header>
      {loading ? <p role="status">正在读取媒体预览…</p> : null}
      {error ? <p className="library-error" role="alert">{error}</p> : null}
      {shownImage ? <img className="media-preview-image" alt={item?.asset.reference.name ?? "媒体预览"} src={`data:${shownImage.image.mimeType};base64,${shownImage.dataBase64}`} /> : null}
      {shownPlayback ? <><p className="field-help">{shownPlayback.kind === "video" ? "此处仅本地预览，聊天模型不直接接收视频画面。转写须另行授权。" : "本地音频预览；转写需另行启用语音服务。"} 时长 {Math.ceil((item?.asset.durationMs ?? 0) / 1000)} 秒，导入上限 10 分钟 / 16 MiB。</p>{shownPlayback.kind === "video" ? <video ref={setPlayer} controls preload="metadata" src={shownPlayback.url} style={{ maxWidth: "100%", maxHeight: "60vh" }} onError={() => setError("当前系统无法播放此音视频编码。请换用受支持的编码。")} /> : <audio ref={setPlayer} controls preload="metadata" src={shownPlayback.url} onError={() => setError("当前系统无法播放此音频编码。请换用受支持的编码。")} />}</> : null}
      {item?.asset.kind === "pdf" && !error ? <nav className="media-preview-navigation" aria-label="PDF 分页"><button className="text-button" type="button" disabled={loading || pageIndex === 0} onClick={() => setPageIndex(current => current - 1)}>上一页</button><span>第 {pageIndex + 1} / {item.extraction?.spanCount ?? 1} 页</span><button className="text-button" type="button" disabled={loading || pageIndex + 1 >= (item.extraction?.spanCount ?? 1)} onClick={() => setPageIndex(current => current + 1)}>下一页</button></nav> : null}
      {shownText ? <><p className="field-help">DOCX 文字分节预览，不代表物理分页。{shownText.spans.length ? `当前包含第 ${shownText.spans.map(span => span.index + 1).join("、")} 节。` : ""}</p><pre className="media-preview-text">{shownText.text || "此范围没有可提取文字。"}</pre><nav className="media-preview-navigation" aria-label="文档文字范围"><button className="text-button" type="button" disabled={loading || previousOffsets.length === 0} onClick={() => { setOffset(previousOffsets.at(-1) ?? 0); setPreviousOffsets(current => current.slice(0, -1)); }}>上一段文字</button><span>{shownText.offset}–{shownText.nextOffset ?? shownText.totalCharacters} / {shownText.totalCharacters}</span><button className="text-button" type="button" disabled={loading || shownText.nextOffset === null} onClick={() => { setPreviousOffsets(current => [...current, offset]); setOffset(shownText.nextOffset!); }}>下一段文字</button></nav></> : null}
      {item?.extraction?.warningCodes.length ? <p className="field-help">解析提示：{item.extraction.warningCodes.join("、")}</p> : null}
    </section>
  </div>;
}
