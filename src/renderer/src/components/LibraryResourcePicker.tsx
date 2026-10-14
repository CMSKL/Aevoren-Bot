import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import type { LibraryResource, LibraryResourceKind, ResourceReference } from "@shared/library-contracts";
import "../styles/library.css";

export type LibraryResourcePickerProps = {
  sessionId: string;
  kind: LibraryResourceKind;
  open: boolean;
  query?: string;
  onSelect(reference: ResourceReference, resource: LibraryResource): void;
  onClose?(): void;
};

/** Selection resolves an immutable revision through the host; names are display text only. */
export function LibraryResourcePicker({ sessionId, kind, open, query = "", onSelect, onClose }: LibraryResourcePickerProps): React.JSX.Element | null {
  const [items, setItems] = useState<LibraryResource[]>([]);
  const [loading, setLoading] = useState(false);
  const [selecting, setSelecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const selectRequestRef = useRef(0);
  const label = kind === "skill" ? "Skill" : "资料";
  const load = useCallback(async (): Promise<void> => {
    const request = ++requestRef.current;
    setItems([]);
    setSelecting(null);
    setLoading(true);
    setError(null);
    try {
      const result = await window.aevorenBot.library.list({ sessionId, kind, query });
      if (request !== requestRef.current) return;
      if (result.ok) setItems(result.data.filter(item => item.enabled && !item.deletedAt));
      else { setItems([]); setError(result.error.safeMessage); }
    } catch {
      if (request === requestRef.current) { setItems([]); setError("暂时无法读取会话资源。"); }
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [sessionId, kind, query]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => { if (open && !cancelled) void load(); });
    return () => { cancelled = true; requestRef.current += 1; selectRequestRef.current += 1; };
  }, [open, load]);
  const changed = useEffectEvent((): void => { if (open) void load(); });
  useEffect(() => window.aevorenBot.library.onChanged(() => changed()), []);

  async function select(resource: LibraryResource): Promise<void> {
    const request = ++selectRequestRef.current;
    setSelecting(resource.id);
    setError(null);
    try {
      const result = await window.aevorenBot.library.read({ sessionId, id: resource.id });
      if (request !== selectRequestRef.current) return;
      if (!result.ok) { setError(result.error.safeMessage); return; }
      onSelect(result.data.reference, result.data.resource);
    } catch {
      if (request === selectRequestRef.current) setError("这份资源暂时无法引用，请重试。");
    } finally {
      if (request === selectRequestRef.current) setSelecting(null);
    }
  }

  if (!open) return null;
  return <div className="library-resource-picker" aria-label={`选择当前会话${label}`} onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); onClose?.(); }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-library-option]"));
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "ArrowDown" ? index + 1 : index < 0 ? buttons.length - 1 : index - 1;
      buttons[(next + buttons.length) % buttons.length]?.focus();
    }
  }}>
    <div className="library-picker-heading"><span>当前会话{label}</span>{onClose ? <button type="button" className="text-button" onClick={onClose}>关闭</button> : null}</div>
    {error ? <p className="library-error" role="alert">{error}</p> : null}
    {loading ? <p className="library-empty" role="status">正在读取…</p> : items.length === 0 ? <p className="library-empty">{query ? `没有匹配的${label}。` : `请先在${kind === "skill" ? "Skill" : "资料库"}中添加到当前会话。`}</p> : null}
    {items.map(resource => <button type="button" className="library-picker-option" key={resource.id} data-library-option={resource.id} disabled={selecting !== null} onClick={() => void select(resource)}><span><strong>{resource.name}</strong><small>{resource.description || "暂无描述"}</small></span><small>{selecting === resource.id ? "读取中…" : `v${resource.version}`}</small></button>)}
  </div>;
}
