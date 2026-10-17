import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon } from "./Icons";

type Tab = { id: string; label: string };
type Props = {
  idPrefix: string;
  label: string;
  tabs: readonly Tab[];
  primary: readonly string[];
  value: string;
  disabled?: boolean;
  onChange(value: string): Promise<boolean>;
};

export function DetailsTabs({ idPrefix, label, tabs, primary, value, disabled, onChange }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const visible = tabs.filter(tab => primary.includes(tab.id) || tab.id === value);
  const extra = tabs.filter(tab => !primary.includes(tab.id));
  function focusTab(id: string, owner: Element | null): void {
    requestAnimationFrame(() => {
      if (!rootRef.current?.getClientRects().length || document.activeElement !== owner && document.activeElement !== document.body) return;
      document.getElementById(`${idPrefix}-${id}-tab`)?.focus();
    });
  }
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent): void => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    rootRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  return <div className="detail-tabs-root" ref={rootRef}>
    <div className="detail-primary-tabs" role="tablist" aria-label={label}>
      {visible.map(tab => <button key={tab.id} type="button" role="tab" id={`${idPrefix}-${tab.id}-tab`} aria-selected={tab.id === value} aria-controls={`${idPrefix}-${tab.id}-panel`} tabIndex={tab.id === value ? 0 : -1} disabled={disabled} onClick={() => void onChange(tab.id)} onKeyDown={event => {
        const index = visible.indexOf(tab);
        const next = event.key === "ArrowRight" ? visible[(index + 1) % visible.length] : event.key === "ArrowLeft" ? visible[(index + visible.length - 1) % visible.length] : event.key === "Home" ? visible[0] : event.key === "End" ? visible.at(-1) : undefined;
        if (!next) return;
        event.preventDefault();
        const owner = document.activeElement;
        void onChange(next.id).then(changed => { if (changed) focusTab(next.id, owner); });
      }}>{tab.label}</button>)}
    </div>
    {extra.length ? <div className="detail-extra-tabs"><button ref={triggerRef} className="detail-more-trigger" type="button" aria-label="更多详情功能" aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen(current => !current)}>更多<ChevronDownIcon size={12} /></button>
      <div className="detail-more-menu" role="menu" aria-label="更多详情功能" hidden={!open} onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); triggerRef.current?.focus(); }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
        }
      }}>{extra.map(tab => <button key={tab.id} type="button" role="menuitem" id={tab.id === value ? undefined : `${idPrefix}-${tab.id}-tab`} aria-controls={`${idPrefix}-${tab.id}-panel`} onClick={() => { const owner = document.activeElement; void onChange(tab.id).then(changed => { if (changed) { setOpen(false); focusTab(tab.id, owner); } }); }}>{tab.label}</button>)}</div>
    </div> : null}
  </div>;
}
