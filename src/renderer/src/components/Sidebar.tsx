import { useState, type RefObject } from "react";
import type { Bot, Room } from "@shared/contracts";
import { BotIcon, CloseIcon, PlusIcon, RoomIcon } from "./Icons";

type SidebarProps = {
  bots: Bot[];
  rooms: Room[];
  selectedBotId: string | null;
  selectedRoomId: string | null;
  busy: boolean;
  mobileOpen: boolean;
  createButtonRef: RefObject<HTMLButtonElement | null>;
  onCreate(): void;
  onMobileClose(): void;
  onSelectBot(bot: Bot): void;
  onSelectRoom(room: Room): void;
  onRestoreRoom(room: Room): void;
};

export function Sidebar({
  bots,
  rooms,
  selectedBotId,
  selectedRoomId,
  busy,
  mobileOpen,
  createButtonRef,
  onCreate,
  onMobileClose,
  onSelectBot,
  onSelectRoom,
  onRestoreRoom,
}: SidebarProps): React.JSX.Element {
  const [archivedOpen, setArchivedOpen] = useState(false);
  const activeRooms = rooms.filter((room) => room.archivedAt === null);
  const archivedRooms = rooms.filter((room) => room.archivedAt !== null);
  return (
    <aside className={`sidebar${mobileOpen ? " mobile-open" : ""}`} aria-label="聊天列表">
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
        {bots.length === 0 && activeRooms.length === 0 && archivedRooms.length === 0 ? (
          <div className="bot-list-empty">还没有 Bot。新建一个 Bot 开始工作。</div>
        ) : (
          <>
          {activeRooms.length > 0 ? <div className="sidebar-label">群聊</div> : null}
          {activeRooms.map((room) => (
            <button
              type="button"
              className={`bot-row${room.id === selectedRoomId ? " selected" : ""}`}
              key={room.id}
              onClick={() => onSelectRoom(room)}
              role="listitem"
            >
              <span className="bot-icon"><RoomIcon /></span>
              <span className="bot-copy"><strong>{room.name}</strong><small>多 Bot 群聊</small></span>
            </button>
          ))}
          {bots.length > 0 ? <div className="sidebar-label">Bot</div> : null}
          {bots.map((bot) => (
            <button
              type="button"
              className={`bot-row${bot.id === selectedBotId ? " selected" : ""}`}
              key={bot.id}
              onClick={() => onSelectBot(bot)}
              role="listitem"
            >
              <span className="bot-icon"><BotIcon /></span>
              <span className="bot-copy">
                <strong>{bot.name}</strong>
                <small>{bot.label || "未设置标签"}</small>
              </span>
            </button>
          ))}
          {archivedRooms.length > 0 ? (
            <>
              <button className="archived-toggle" type="button" aria-expanded={archivedOpen} onClick={() => setArchivedOpen((open) => !open)}>
                已归档 ({archivedRooms.length})
              </button>
              {archivedOpen ? archivedRooms.map((room) => (
                <div className="archived-room-row" key={room.id}>
                  <span>{room.name}</span>
                  <button className="text-button" type="button" onClick={() => onRestoreRoom(room)}>恢复</button>
                </div>
              )) : null}
            </>
          ) : null}
          </>
        )}
      </div>
    </aside>
  );
}
