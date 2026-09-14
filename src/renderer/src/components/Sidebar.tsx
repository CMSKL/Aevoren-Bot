import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Bot, Room } from "@shared/contracts";
import { buildBotIdentityMap } from "../bot-identity";
import { BotContextMenu } from "./BotContextMenu";
import { BotIcon, CloseIcon, PinIcon, PlusIcon, RoomIcon } from "./Icons";

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
  onPinBot(bot: Bot, pinned: boolean): Promise<boolean>;
  onMarkBotUnread(bot: Bot, unread: boolean): Promise<boolean>;
  onRenameBot(bot: Bot, name: string): Promise<boolean>;
  onEditBot(bot: Bot): void;
  onDuplicateBot(bot: Bot): Promise<boolean>;
  onCopyBotId(bot: Bot): Promise<boolean>;
  onHideBot(bot: Bot, hidden: boolean): Promise<boolean>;
  onDeleteBot(bot: Bot): Promise<boolean>;
};

type ContextMenuState = { botId: string; x: number; y: number };

function orderVisibleBots(bots: Bot[]): Bot[] {
  return [...bots].sort((left, right) => {
    if (left.pinnedAt && right.pinnedAt) return left.pinnedAt.localeCompare(right.pinnedAt);
    if (left.pinnedAt) return -1;
    if (right.pinnedAt) return 1;
    return left.createdAt.localeCompare(right.createdAt);
  });
}

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
  onPinBot,
  onMarkBotUnread,
  onRenameBot,
  onEditBot,
  onDuplicateBot,
  onCopyBotId,
  onHideBot,
  onDeleteBot,
}: SidebarProps): React.JSX.Element {
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [pendingBotId, setPendingBotId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Bot | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const renameRef = useRef<HTMLInputElement>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const deleteConfirmRef = useRef<HTMLButtonElement>(null);
  const renameInFlightRef = useRef(false);
  const botIdentities = useMemo(() => buildBotIdentityMap(bots), [bots]);
  const activeRooms = rooms.filter((room) => room.archivedAt === null);
  const archivedRooms = rooms.filter((room) => room.archivedAt !== null);
  const visibleBots = useMemo(() => orderVisibleBots(bots.filter((bot) => bot.hiddenAt === null)), [bots]);
  const hiddenBots = useMemo(() => bots.filter((bot) => bot.hiddenAt !== null), [bots]);
  const contextBot = contextMenu ? bots.find((bot) => bot.id === contextMenu.botId) ?? null : null;

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2_400);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!deleteTarget) return;
    deleteCancelRef.current?.focus();
    function cancelFromEscape(event: KeyboardEvent): void {
      if (event.key !== "Escape" || pendingBotId === deleteTarget?.id) return;
      event.preventDefault();
      setDeleteTarget(null);
    }
    window.addEventListener("keydown", cancelFromEscape);
    return () => window.removeEventListener("keydown", cancelFromEscape);
  }, [deleteTarget, pendingBotId]);

  const closeContextMenu = useCallback((returnFocus = false): void => {
    const botId = contextMenu?.botId;
    setContextMenu(null);
    if (returnFocus && botId) requestAnimationFrame(() => rowRefs.current.get(botId)?.focus());
  }, [contextMenu?.botId]);

  function openContextMenu(event: React.MouseEvent<HTMLButtonElement>, bot: Bot): void {
    event.preventDefault();
    event.stopPropagation();
    showContextMenu(bot, event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
  }

  function showContextMenu(bot: Bot, clientX: number, clientY: number, fallback: DOMRect): void {
    if (busy || pendingBotId) return;
    const width = 218;
    const height = bot.hiddenAt ? 310 : 350;
    const preferredX = clientX || fallback.right;
    const preferredY = clientY || fallback.top;
    setContextMenu({
      botId: bot.id,
      x: Math.max(8, Math.min(preferredX, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(preferredY, window.innerHeight - height - 8)),
    });
  }

  async function perform(bot: Bot, operation: () => Promise<boolean>, successMessage: string): Promise<boolean> {
    if (pendingBotId) return false;
    setPendingBotId(bot.id);
    setNotice(null);
    const succeeded = await operation();
    setPendingBotId(null);
    setNotice(succeeded ? successMessage : "操作未完成，请重试。");
    return succeeded;
  }

  function beginRename(bot: Bot): void {
    setRenamingId(bot.id);
    setRenameDraft(bot.name);
    requestAnimationFrame(() => {
      renameRef.current?.focus();
      renameRef.current?.select();
    });
  }

  async function commitRename(bot: Bot): Promise<void> {
    if (renameInFlightRef.current) return;
    const nextName = renameDraft.replace(/\s+/g, " ").trim();
    if (!nextName || nextName === bot.name) {
      setRenamingId(null);
      return;
    }
    renameInFlightRef.current = true;
    setPendingBotId(bot.id);
    const succeeded = await onRenameBot(bot, nextName);
    renameInFlightRef.current = false;
    setPendingBotId(null);
    if (succeeded) {
      setRenamingId(null);
      setNotice("Bot 已重命名。");
    } else {
      setNotice("重命名失败，请重试。");
      requestAnimationFrame(() => renameRef.current?.focus());
    }
  }

  function renderBotRow(bot: Bot): React.JSX.Element {
    const identity = botIdentities.get(bot.id)!;
    if (renamingId === bot.id) {
      return (
        <div className={`bot-row renaming${bot.id === selectedBotId ? " selected" : ""}`} key={bot.id} role="listitem">
          <span className="bot-icon"><BotIcon /></span>
          <input
            ref={renameRef}
            className="bot-rename-input"
            aria-label="重命名 Bot"
            maxLength={80}
            disabled={pendingBotId === bot.id}
            value={renameDraft}
            onChange={(event) => setRenameDraft(event.target.value)}
            onBlur={() => void commitRename(bot)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setRenamingId(null);
                requestAnimationFrame(() => rowRefs.current.get(bot.id)?.focus());
              }
            }}
          />
        </div>
      );
    }
    return (
      <button
        ref={(element) => {
          if (element) rowRefs.current.set(bot.id, element);
          else rowRefs.current.delete(bot.id);
        }}
        type="button"
        className={`bot-row${bot.id === selectedBotId ? " selected" : ""}`}
        key={bot.id}
        onClick={() => onSelectBot(bot)}
        onContextMenu={(event) => openContextMenu(event, bot)}
        onKeyDown={(event) => {
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          event.preventDefault();
          showContextMenu(bot, 0, 0, event.currentTarget.getBoundingClientRect());
        }}
        role="listitem"
        aria-label={identity.inline}
        aria-haspopup="menu"
      >
        <span className="bot-icon"><BotIcon /></span>
        <span className="bot-copy">
          <strong>{identity.primary}</strong>
          <small>{identity.secondary}</small>
        </span>
        <span className="bot-row-state" aria-hidden="true">
          {bot.pinnedAt ? <PinIcon /> : null}
          {bot.hasUnread ? <i /> : null}
        </span>
      </button>
    );
  }

  return (
    <aside className={`sidebar${mobileOpen ? " mobile-open" : ""}`} aria-label="聊天列表">
      <div className="sidebar-header">
        <div className="brand">MS-Bot</div>
        <div className="sidebar-header-actions">
          <button ref={createButtonRef} className="new-bot-button" type="button" aria-label="新建聊天" onClick={onCreate} disabled={busy}>
            <PlusIcon />
            <span>新建聊天</span>
          </button>
          <button className="drawer-close-button" type="button" aria-label="关闭 Bot 列表" onClick={onMobileClose}>
            <CloseIcon />
          </button>
        </div>
      </div>
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
            {visibleBots.length > 0 ? <div className="sidebar-label">Bot</div> : null}
            {visibleBots.map(renderBotRow)}
            {hiddenBots.length > 0 ? (
              <>
                <button className="archived-toggle" type="button" aria-expanded={hiddenOpen} onClick={() => setHiddenOpen((open) => !open)}>
                  已隐藏 ({hiddenBots.length})
                </button>
                {hiddenOpen ? hiddenBots.map(renderBotRow) : null}
              </>
            ) : null}
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

      {notice ? <div className="bot-action-notice" role="status">{notice}</div> : null}
      {contextBot && contextMenu ? (
        <BotContextMenu
          bot={contextBot}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={closeContextMenu}
          onPin={() => void perform(contextBot, () => onPinBot(contextBot, !contextBot.pinnedAt), contextBot.pinnedAt ? "已取消置顶。" : "Bot 已置顶。")}
          onUnread={() => void perform(contextBot, () => onMarkBotUnread(contextBot, !contextBot.hasUnread), contextBot.hasUnread ? "已标为已读。" : "已标为未读。")}
          onRename={() => beginRename(contextBot)}
          onEdit={() => onEditBot(contextBot)}
          onDuplicate={() => void perform(contextBot, () => onDuplicateBot(contextBot), "副本已创建。")}
          onCopyId={() => void perform(contextBot, () => onCopyBotId(contextBot), "对话 ID 已复制。")}
          onHide={() => void perform(contextBot, () => onHideBot(contextBot, !contextBot.hiddenAt), contextBot.hiddenAt ? "Bot 已恢复。" : "Bot 已隐藏。")}
          onDelete={() => setDeleteTarget(contextBot)}
        />
      ) : null}

      {deleteTarget ? (
        <div className="bot-delete-backdrop" role="presentation">
          <section
            className="bot-delete-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="bot-delete-title"
            aria-describedby="bot-delete-description"
            onKeyDown={(event) => {
              if (event.key !== "Tab") return;
              if (event.shiftKey && document.activeElement === deleteCancelRef.current) {
                event.preventDefault();
                deleteConfirmRef.current?.focus();
              } else if (!event.shiftKey && document.activeElement === deleteConfirmRef.current) {
                event.preventDefault();
                deleteCancelRef.current?.focus();
              }
            }}
          >
            <h2 id="bot-delete-title">删除“{deleteTarget.name}”？</h2>
            <p id="bot-delete-description">这会永久删除该 Bot 的单聊记录，并将它移出群聊。群聊历史发言仍会保留。</p>
            <div className="bot-delete-actions">
              <button ref={deleteCancelRef} type="button" className="secondary-button" disabled={pendingBotId === deleteTarget.id} onClick={() => setDeleteTarget(null)}>取消</button>
              <button
                ref={deleteConfirmRef}
                type="button"
                className="danger-confirm-button"
                disabled={pendingBotId === deleteTarget.id}
                onClick={() => void perform(deleteTarget, () => onDeleteBot(deleteTarget), "Bot 已删除。").then((succeeded) => {
                  if (succeeded) setDeleteTarget(null);
                })}
              >{pendingBotId === deleteTarget.id ? "删除中…" : "删除"}</button>
            </div>
          </section>
        </div>
      ) : null}
    </aside>
  );
}
