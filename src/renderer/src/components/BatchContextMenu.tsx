import { useEffect, useRef } from "react";
import { TrashIcon } from "./Icons";

type Props = {
  label: string;
  x: number;
  y: number;
  onClose(returnFocus?: boolean): void;
  onDelete(): void;
};

export function BatchContextMenu({ label, x, y, onClose, onDelete }: Props): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    function closeFromOutside(event: PointerEvent): void {
      if (!menuRef.current?.contains(event.target as Node)) onClose(false);
    }
    function closeFromViewport(): void {
      onClose(false);
    }
    document.addEventListener("pointerdown", closeFromOutside, true);
    document.addEventListener("scroll", closeFromViewport, true);
    window.addEventListener("resize", closeFromViewport);
    window.addEventListener("blur", closeFromViewport);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside, true);
      document.removeEventListener("scroll", closeFromViewport, true);
      window.removeEventListener("resize", closeFromViewport);
      window.removeEventListener("blur", closeFromViewport);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="bot-context-menu batch-context-menu"
      role="menu"
      aria-label="批量操作"
      style={{ left: x, top: y }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClose(true);
      }}
    >
      <div className="bot-context-section">
        <button
          className="bot-context-item danger"
          type="button"
          role="menuitem"
          onClick={() => {
            onClose(false);
            onDelete();
          }}
        >
          <span className="bot-context-icon"><TrashIcon /></span>
          <span>{label}</span>
        </button>
      </div>
    </div>
  );
}
