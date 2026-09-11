import type { RefObject } from "react";
import type { Bot } from "@shared/contracts";
import { BotIcon, CloseIcon, PlusIcon } from "./Icons";

type SidebarProps = {
  bots: Bot[];
  selectedBotId: string | null;
  busy: boolean;
  mobileOpen: boolean;
  createButtonRef: RefObject<HTMLButtonElement | null>;
  onCreate(): void;
  onMobileClose(): void;
  onSelect(bot: Bot): void;
};

export function Sidebar({
  bots,
  selectedBotId,
  busy,
  mobileOpen,
  createButtonRef,
  onCreate,
  onMobileClose,
  onSelect,
}: SidebarProps): React.JSX.Element {
  return (
    <aside className={`sidebar${mobileOpen ? " mobile-open" : ""}`} aria-label="Bot 列表">
      <div className="sidebar-header">
        <div className="brand">MS-Bot</div>
        <button className="drawer-close-button" type="button" aria-label="关闭 Bot 列表" onClick={onMobileClose}>
          <CloseIcon />
        </button>
      </div>
      <button ref={createButtonRef} className="new-bot-button" type="button" onClick={onCreate} disabled={busy}>
        <PlusIcon />
        新建聊天
      </button>
      <div className="bot-list" role="list">
        {bots.length === 0 ? (
          <div className="bot-list-empty">还没有 Bot。新建一个 Bot 开始工作。</div>
        ) : (
          bots.map((bot) => (
            <button
              type="button"
              className={`bot-row${bot.id === selectedBotId ? " selected" : ""}`}
              key={bot.id}
              onClick={() => onSelect(bot)}
              role="listitem"
            >
              <span className="bot-icon"><BotIcon /></span>
              <span className="bot-copy">
                <strong>{bot.name}</strong>
                <small>{bot.label || "未设置标签"}</small>
              </span>
            </button>
          ))
        )}
      </div>
    </aside>
  );
}
