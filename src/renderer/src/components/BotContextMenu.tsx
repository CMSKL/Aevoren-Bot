import { useEffect, useRef } from "react";
import type { Bot } from "@shared/contracts";
import {
  BellIcon,
  BotIcon,
  CopyIcon,
  DuplicateIcon,
  EyeIcon,
  EyeOffIcon,
  PencilIcon,
  PinIcon,
  TrashIcon,
} from "./Icons";

type Props = {
  bot: Bot;
  x: number;
  y: number;
  onClose(returnFocus?: boolean): void;
  onPin(): void;
  onUnread(): void;
  onRename(): void;
  onEdit(): void;
  onDuplicate(): void;
  onCopyId(): void;
  onHide(): void;
  onDelete(): void;
};

type ItemProps = {
  children: React.ReactNode;
  danger?: boolean;
  icon: React.ReactNode;
  onSelect(): void;
};

function MenuItem({ children, danger = false, icon, onSelect }: ItemProps): React.JSX.Element {
  return (
    <button className={`bot-context-item${danger ? " danger" : ""}`} type="button" role="menuitem" onClick={onSelect}>
      <span className="bot-context-icon">{icon}</span>
      <span>{children}</span>
    </button>
  );
}

export function BotContextMenu({
  bot,
  x,
  y,
  onClose,
  onPin,
  onUnread,
  onRename,
  onEdit,
  onDuplicate,
  onCopyId,
  onHide,
  onDelete,
}: Props): React.JSX.Element {
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

  function select(action: () => void): void {
    onClose(false);
    action();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose(true);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const direction = event.key === "ArrowDown" ? 1 : -1;
    items[(current + direction + items.length) % items.length]?.focus();
  }

  return (
    <div
      ref={menuRef}
      className="bot-context-menu"
      role="menu"
      aria-label="Bot 操作"
      style={{ left: x, top: y }}
      onKeyDown={handleKeyDown}
    >
      <div className="bot-context-section">
        {bot.hiddenAt ? (
          <MenuItem icon={<EyeIcon />} onSelect={() => select(onHide)}>恢复到侧边栏</MenuItem>
        ) : (
          <MenuItem icon={<PinIcon />} onSelect={() => select(onPin)}>{bot.pinnedAt ? "取消置顶" : "置顶"}</MenuItem>
        )}
        <MenuItem icon={<BellIcon />} onSelect={() => select(onUnread)}>{bot.hasUnread ? "标为已读" : "标为未读"}</MenuItem>
      </div>
      <div className="bot-context-section">
        <MenuItem icon={<PencilIcon />} onSelect={() => select(onRename)}>重命名 Bot</MenuItem>
        <MenuItem icon={<BotIcon />} onSelect={() => select(onEdit)}>编辑资料</MenuItem>
        <MenuItem icon={<DuplicateIcon />} onSelect={() => select(onDuplicate)}>创建副本</MenuItem>
      </div>
      <div className="bot-context-section">
        <MenuItem icon={<CopyIcon />} onSelect={() => select(onCopyId)}>复制对话 ID</MenuItem>
      </div>
      <div className="bot-context-section">
        {!bot.hiddenAt ? <MenuItem icon={<EyeOffIcon />} onSelect={() => select(onHide)}>从侧边栏隐藏</MenuItem> : null}
        <MenuItem danger icon={<TrashIcon />} onSelect={() => select(onDelete)}>删除</MenuItem>
      </div>
    </div>
  );
}
