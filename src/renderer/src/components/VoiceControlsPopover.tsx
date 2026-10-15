import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

export function VoiceControlsPopover({ id, open, trigger, onClose, children }: { id: string; open: boolean; trigger: RefObject<HTMLButtonElement | null>; onClose(): void; children: ReactNode }): React.JSX.Element {
  const panel = useRef<HTMLElement>(null), close = useRef<HTMLButtonElement>(null);
  const [bounds, setBounds] = useState({ left: 8, top: 8, width: 480, maxHeight: 480 });
  useLayoutEffect(() => {
    if (!open) return;
    let cancelled = false;
    const place = (): void => {
      const anchor = trigger.current?.getBoundingClientRect(); if (!anchor || cancelled) return;
      const width = Math.min(520, window.innerWidth - 16), maxHeight = Math.min(480, window.innerHeight - 16);
      const height = Math.min(maxHeight, panel.current?.getBoundingClientRect().height ?? maxHeight);
      const next = { width, maxHeight, left: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)), top: Math.max(8, Math.min(anchor.top - height - 8, window.innerHeight - height - 8)) };
      setBounds(current => Object.keys(next).every(key => current[key as keyof typeof next] === next[key as keyof typeof next]) ? current : next);
    };
    queueMicrotask(place); close.current?.focus();
    const observer = new ResizeObserver(place); if (panel.current) observer.observe(panel.current);
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { cancelled = true; observer.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, trigger]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (target instanceof Element && target.closest(".message-read-aloud")) return;
      const editing = target instanceof Element ? target.closest(".composer-editor, .composer-footer-actions") : null;
      if (editing && trigger.current?.closest(".composer")?.contains(editing)) return;
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) onClose();
    };
    const escape = (event: KeyboardEvent): void => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open, trigger, onClose]);
  return createPortal(<section id={id} ref={panel} hidden={!open} className="voice-controls-popover" role="dialog" aria-label="语音控制" style={bounds} onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
    if (event.key === "Tab") {
      const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? [])].filter(element => element.getClientRects().length > 0);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}><header><strong>语音</strong><button ref={close} className="text-button" type="button" aria-label="关闭语音控制" onClick={onClose}>关闭</button></header>{children}</section>, document.body);
}
