import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Bot, ConversationBatchDeleteInput, Room } from "@shared/contracts";
import { buildBotIdentityMap } from "../bot-identity";
import { BatchContextMenu } from "./BatchContextMenu";
import { BotAvatarIcon } from "./BotAvatarIcon";
import { BotContextMenu } from "./BotContextMenu";
import { CheckIcon, CloseIcon, FolderIcon, PinIcon, PlusIcon, RoomIcon, SettingsIcon, TrashIcon } from "./Icons";
import { RoomContextMenu } from "./RoomContextMenu";

type SidebarProps = {
  bots: Bot[];
  rooms: Room[];
  selectedBotId: string | null;
  selectedRoomId: string | null;
  busy: boolean;
  mobileOpen: boolean;
  createButtonRef: RefObject<HTMLButtonElement | null>;
  onCreate(): void;
  onOpenSettings(): void;
  onMobileClose(): void;
  onSelectBot(bot: Bot): void;
  onSelectRoom(room: Room): void;
  onRestoreRoom(room: Room): void;
  onRenameRoom(room: Room, name: string): Promise<boolean>;
  onCopyRoomId(room: Room): Promise<boolean>;
  onArchiveRoom(room: Room): Promise<boolean>;
  onPinRoom(room: Room, pinned: boolean): Promise<boolean>;
  onMarkRoomUnread(room: Room, unread: boolean): Promise<boolean>;
  onHideRoom(room: Room, hidden: boolean): Promise<boolean>;
  onDeleteRoom(room: Room): Promise<boolean>;
  onDeleteBatch(input: ConversationBatchDeleteInput): Promise<boolean>;
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
type ConversationKey = `bot:${string}` | `room:${string}`;
type BatchContextMenuState = { keys: ConversationKey[]; triggerKey: ConversationKey; x: number; y: number };

const EMPTY_SELECTION = new Set<ConversationKey>();

function botKey(id: string): ConversationKey {
  return `bot:${id}`;
}

function roomKey(id: string): ConversationKey {
  return `room:${id}`;
}

function batchInput(keys: readonly ConversationKey[]): ConversationBatchDeleteInput {
  return keys.reduce<ConversationBatchDeleteInput>((result, key) => {
    if (key.startsWith("bot:")) result.botIds.push(key.slice(4));
    else result.roomIds.push(key.slice(5));
    return result;
  }, { botIds: [], roomIds: [] });
}

function batchDeleteLabel(input: ConversationBatchDeleteInput): string {
  const count = input.botIds.length + input.roomIds.length;
  if (input.roomIds.length === 0) return `删除 ${count} 个 Bot`;
  if (input.botIds.length === 0) return `删除 ${count} 个群聊`;
  return `删除 ${count} 个项目`;
}

function orderVisibleBots(bots: Bot[]): Bot[] {
  return [...bots].sort((left, right) => {
    if (left.pinnedAt && right.pinnedAt) return left.pinnedAt.localeCompare(right.pinnedAt);
    if (left.pinnedAt) return -1;
    if (right.pinnedAt) return 1;
    return left.createdAt.localeCompare(right.createdAt);
  });
}

function orderVisibleRooms(rooms: Room[]): Room[] {
  return [...rooms].sort((left, right) => {
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
  onOpenSettings,
  onMobileClose,
  onSelectBot,
  onSelectRoom,
  onRestoreRoom,
  onRenameRoom,
  onCopyRoomId,
  onArchiveRoom,
  onPinRoom,
  onMarkRoomUnread,
  onHideRoom,
  onDeleteRoom,
  onDeleteBatch,
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
  const [workspaceExpanded, setWorkspaceExpanded] = useState(true);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [roomContextMenu, setRoomContextMenu] = useState<{ roomId: string; x: number; y: number } | null>(null);
  const [batchContextMenu, setBatchContextMenu] = useState<BatchContextMenuState | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<ConversationKey>>(EMPTY_SELECTION);
  const [batchDeleteTarget, setBatchDeleteTarget] = useState<ConversationKey[] | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renamingRoomId, setRenamingRoomId] = useState<string | null>(null);
  const [roomRenameDraft, setRoomRenameDraft] = useState("");
  const [pendingBotId, setPendingBotId] = useState<string | null>(null);
  const [pendingRoomId, setPendingRoomId] = useState<string | null>(null);
  const [batchDeletePending, setBatchDeletePending] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Bot | null>(null);
  const [roomDeleteTarget, setRoomDeleteTarget] = useState<Room | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const roomRowRefs = useRef(new Map<string, HTMLButtonElement>());
  const renameRef = useRef<HTMLInputElement>(null);
  const roomRenameRef = useRef<HTMLInputElement>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const deleteConfirmRef = useRef<HTMLButtonElement>(null);
  const roomDeleteCancelRef = useRef<HTMLButtonElement>(null);
  const roomDeleteConfirmRef = useRef<HTMLButtonElement>(null);
  const batchDeleteCancelRef = useRef<HTMLButtonElement>(null);
  const batchDeleteConfirmRef = useRef<HTMLButtonElement>(null);
  const selectionAnchorRef = useRef<ConversationKey | null>(null);
  const renameInFlightRef = useRef(false);
  const roomRenameInFlightRef = useRef(false);
  const botIdentities = useMemo(() => buildBotIdentityMap(bots), [bots]);
  const activeRooms = useMemo(
    () => orderVisibleRooms(rooms.filter((room) => room.archivedAt === null && room.hiddenAt === null)),
    [rooms],
  );
  const hiddenRooms = useMemo(
    () => rooms.filter((room) => room.archivedAt === null && room.hiddenAt !== null),
    [rooms],
  );
  const archivedRooms = rooms.filter((room) => room.archivedAt !== null);
  const visibleBots = useMemo(() => orderVisibleBots(bots.filter((bot) => bot.hiddenAt === null)), [bots]);
  const hiddenBots = useMemo(() => bots.filter((bot) => bot.hiddenAt !== null), [bots]);
  const contextBot = contextMenu ? bots.find((bot) => bot.id === contextMenu.botId) ?? null : null;
  const contextRoom = roomContextMenu ? rooms.find((room) => room.id === roomContextMenu.roomId) ?? null : null;
  const conversationOrder = useMemo<ConversationKey[]>(() => [
    ...activeRooms.map((room) => roomKey(room.id)),
    ...visibleBots.map((bot) => botKey(bot.id)),
  ], [activeRooms, visibleBots]);
  const visibleSelectedKeys = useMemo(() => {
    const available = new Set(conversationOrder);
    return new Set([...selectedKeys].filter((key) => available.has(key)));
  }, [conversationOrder, selectedKeys]);
  const batchMenuInput = batchContextMenu ? batchInput(batchContextMenu.keys) : null;
  const batchDialogInput = batchDeleteTarget ? batchInput(batchDeleteTarget) : null;
  const batchDialogCount = batchDialogInput ? batchDialogInput.botIds.length + batchDialogInput.roomIds.length : 0;
  const batchDialogTitle = batchDialogInput
    ? batchDialogInput.roomIds.length === 0
      ? `删除 ${batchDialogCount} 个 Bot？`
      : batchDialogInput.botIds.length === 0
        ? `删除 ${batchDialogCount} 个群聊？`
        : `删除 ${batchDialogCount} 个项目？`
    : "";
  const batchDialogDescription = batchDialogInput
    ? batchDialogInput.roomIds.length === 0
      ? "这会永久删除所选 Bot 的单聊记录，并将它们移出群聊。群聊历史发言仍会保留。"
      : batchDialogInput.botIds.length === 0
        ? "这会永久删除所选群聊及其聊天历史。群聊中的 Bot 不会被删除，此操作无法撤销。"
        : "这会永久删除所选 Bot、群聊及对应单聊/群聊记录。未被选择的 Bot 和群聊仍会保留，此操作无法撤销。"
    : "";

  const clearMultiSelection = useCallback((): void => {
    selectionAnchorRef.current = null;
    setSelectedKeys(EMPTY_SELECTION);
    setBatchContextMenu(null);
  }, []);

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

  useEffect(() => {
    if (!roomDeleteTarget) return;
    roomDeleteCancelRef.current?.focus();
    function cancelFromEscape(event: KeyboardEvent): void {
      if (event.key !== "Escape" || pendingRoomId === roomDeleteTarget?.id) return;
      event.preventDefault();
      setRoomDeleteTarget(null);
    }
    window.addEventListener("keydown", cancelFromEscape);
    return () => window.removeEventListener("keydown", cancelFromEscape);
  }, [roomDeleteTarget, pendingRoomId]);

  useEffect(() => {
    if (!batchDeleteTarget) return;
    batchDeleteCancelRef.current?.focus();
    function cancelFromEscape(event: KeyboardEvent): void {
      if (event.key !== "Escape" || batchDeletePending) return;
      event.preventDefault();
      setBatchDeleteTarget(null);
    }
    window.addEventListener("keydown", cancelFromEscape);
    return () => window.removeEventListener("keydown", cancelFromEscape);
  }, [batchDeletePending, batchDeleteTarget]);

  useEffect(() => {
    if (visibleSelectedKeys.size === 0) return;
    function handleSelectionKey(event: KeyboardEvent): void {
      if (event.defaultPrevented || batchDeleteTarget || contextMenu || roomContextMenu || batchContextMenu) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key === "Escape") {
        event.preventDefault();
        clearMultiSelection();
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        setBatchDeleteTarget(conversationOrder.filter((key) => visibleSelectedKeys.has(key)));
      }
    }
    window.addEventListener("keydown", handleSelectionKey);
    return () => window.removeEventListener("keydown", handleSelectionKey);
  }, [batchContextMenu, batchDeleteTarget, clearMultiSelection, contextMenu, conversationOrder, roomContextMenu, visibleSelectedKeys]);

  const closeContextMenu = useCallback((returnFocus = false): void => {
    const botId = contextMenu?.botId;
    setContextMenu(null);
    if (returnFocus && botId) requestAnimationFrame(() => rowRefs.current.get(botId)?.focus());
  }, [contextMenu?.botId]);

  const closeRoomContextMenu = useCallback((returnFocus = false): void => {
    const roomId = roomContextMenu?.roomId;
    setRoomContextMenu(null);
    if (returnFocus && roomId) requestAnimationFrame(() => roomRowRefs.current.get(roomId)?.focus());
  }, [roomContextMenu?.roomId]);

  const closeBatchContextMenu = useCallback((returnFocus = false): void => {
    const triggerKey = batchContextMenu?.triggerKey;
    setBatchContextMenu(null);
    if (!returnFocus || !triggerKey) return;
    requestAnimationFrame(() => {
      if (triggerKey.startsWith("bot:")) rowRefs.current.get(triggerKey.slice(4))?.focus();
      else roomRowRefs.current.get(triggerKey.slice(5))?.focus();
    });
  }, [batchContextMenu?.triggerKey]);

  function handleSelection(
    event: React.MouseEvent<HTMLButtonElement>,
    key: ConversationKey,
    open: () => void,
  ): void {
    if (event.metaKey || event.ctrlKey) {
      selectionAnchorRef.current = key;
      setSelectedKeys((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next.size === 0 ? EMPTY_SELECTION : next;
      });
      return;
    }
    if (event.shiftKey) {
      const targetIndex = conversationOrder.indexOf(key);
      const anchor = selectionAnchorRef.current;
      const anchorIndex = anchor ? conversationOrder.indexOf(anchor) : -1;
      if (targetIndex < 0) return;
      if (anchorIndex < 0) {
        selectionAnchorRef.current = key;
        setSelectedKeys(new Set([key]));
        return;
      }
      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      setSelectedKeys(new Set(conversationOrder.slice(start, end + 1)));
      return;
    }
    selectionAnchorRef.current = key;
    setSelectedKeys(EMPTY_SELECTION);
    open();
  }

  function showBatchContextMenu(
    key: ConversationKey,
    clientX: number,
    clientY: number,
    fallback: DOMRect,
  ): boolean {
    if (!visibleSelectedKeys.has(key) || visibleSelectedKeys.size < 2) return false;
    const keys = conversationOrder.filter((candidate) => visibleSelectedKeys.has(candidate));
    if (keys.length < 2) return false;
    const width = 218;
    const height = 52;
    const preferredX = clientX || fallback.right;
    const preferredY = clientY || fallback.top;
    setContextMenu(null);
    setRoomContextMenu(null);
    setBatchContextMenu({
      keys,
      triggerKey: key,
      x: Math.max(8, Math.min(preferredX, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(preferredY, window.innerHeight - height - 8)),
    });
    return true;
  }

  function openContextMenu(event: React.MouseEvent<HTMLButtonElement>, bot: Bot): void {
    event.preventDefault();
    event.stopPropagation();
    if (showBatchContextMenu(botKey(bot.id), event.clientX, event.clientY, event.currentTarget.getBoundingClientRect())) return;
    setRoomContextMenu(null);
    setBatchContextMenu(null);
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

  function openRoomContextMenu(event: React.MouseEvent<HTMLButtonElement>, room: Room): void {
    event.preventDefault();
    event.stopPropagation();
    if (showBatchContextMenu(roomKey(room.id), event.clientX, event.clientY, event.currentTarget.getBoundingClientRect())) return;
    setContextMenu(null);
    setBatchContextMenu(null);
    showRoomContextMenu(room, event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
  }

  function showRoomContextMenu(room: Room, clientX: number, clientY: number, fallback: DOMRect): void {
    if (busy || pendingRoomId) return;
    const width = 218;
    const height = room.hiddenAt ? 220 : 290;
    const preferredX = clientX || fallback.right;
    const preferredY = clientY || fallback.top;
    setRoomContextMenu({
      roomId: room.id,
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

  async function performRoom(room: Room, operation: () => Promise<boolean>, successMessage: string): Promise<boolean> {
    if (pendingRoomId) return false;
    setPendingRoomId(room.id);
    setNotice(null);
    const succeeded = await operation();
    setPendingRoomId(null);
    setNotice(succeeded ? successMessage : "操作未完成，请重试。");
    return succeeded;
  }

  async function performBatchDelete(): Promise<void> {
    if (!batchDialogInput || batchDeletePending) return;
    setBatchDeletePending(true);
    setNotice(null);
    const succeeded = await onDeleteBatch(batchDialogInput);
    setBatchDeletePending(false);
    if (!succeeded) {
      setNotice("批量删除未完成，请重试。");
      return;
    }
    const count = batchDialogInput.botIds.length + batchDialogInput.roomIds.length;
    setBatchDeleteTarget(null);
    clearMultiSelection();
    setNotice(`已删除 ${count} 个项目。`);
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

  function beginRoomRename(room: Room): void {
    setRenamingRoomId(room.id);
    setRoomRenameDraft(room.name);
    requestAnimationFrame(() => {
      roomRenameRef.current?.focus();
      roomRenameRef.current?.select();
    });
  }

  async function commitRoomRename(room: Room): Promise<void> {
    if (roomRenameInFlightRef.current) return;
    const nextName = roomRenameDraft.replace(/\s+/g, " ").trim();
    if (!nextName || nextName === room.name) {
      setRenamingRoomId(null);
      return;
    }
    roomRenameInFlightRef.current = true;
    setPendingRoomId(room.id);
    const succeeded = await onRenameRoom(room, nextName);
    roomRenameInFlightRef.current = false;
    setPendingRoomId(null);
    if (succeeded) {
      setRenamingRoomId(null);
      setNotice("群聊已重命名。");
    } else {
      setNotice("重命名失败，请重试。");
      requestAnimationFrame(() => roomRenameRef.current?.focus());
    }
  }

  function renderRoomRow(room: Room): React.JSX.Element {
    const key = roomKey(room.id);
    const batchSelectable = conversationOrder.includes(key);
    const multiSelected = visibleSelectedKeys.has(key);
    if (renamingRoomId === room.id) {
      return (
        <div className={`bot-row renaming${room.id === selectedRoomId ? " selected" : ""}`} key={room.id} role="listitem">
          <span className="bot-icon"><RoomIcon /></span>
          <input
            ref={roomRenameRef}
            className="bot-rename-input"
            aria-label="重命名聊天"
            maxLength={72}
            disabled={pendingRoomId === room.id}
            value={roomRenameDraft}
            onChange={(event) => setRoomRenameDraft(event.target.value)}
            onBlur={() => void commitRoomRename(room)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setRenamingRoomId(null);
                requestAnimationFrame(() => roomRowRefs.current.get(room.id)?.focus());
              }
            }}
          />
        </div>
      );
    }
    return (
      <button
        ref={(element) => {
          if (element) roomRowRefs.current.set(room.id, element);
          else roomRowRefs.current.delete(room.id);
        }}
        type="button"
        className={`bot-row${room.id === selectedRoomId ? " selected" : ""}${multiSelected ? " multi-selected" : ""}`}
        key={room.id}
        onClick={(event) => {
          if (batchSelectable) handleSelection(event, key, () => onSelectRoom(room));
          else {
            clearMultiSelection();
            onSelectRoom(room);
          }
        }}
        onContextMenu={(event) => openRoomContextMenu(event, room)}
        onKeyDown={(event) => {
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          event.preventDefault();
          if (!showBatchContextMenu(key, 0, 0, event.currentTarget.getBoundingClientRect())) {
            setBatchContextMenu(null);
            showRoomContextMenu(room, 0, 0, event.currentTarget.getBoundingClientRect());
          }
        }}
        role="listitem"
        aria-label={room.name}
        aria-haspopup="menu"
        data-multi-selected={multiSelected ? "true" : undefined}
      >
        <span className="bot-icon">{multiSelected ? <CheckIcon /> : <RoomIcon />}</span>
        <span className="bot-copy"><strong>{room.name}</strong><small>多 Bot 群聊</small></span>
        <span className="bot-row-state" aria-hidden="true">
          {room.pinnedAt ? <PinIcon /> : null}
          {room.hasUnread ? <i /> : null}
        </span>
      </button>
    );
  }

  function renderBotRow(bot: Bot): React.JSX.Element {
    const identity = botIdentities.get(bot.id)!;
    const key = botKey(bot.id);
    const batchSelectable = conversationOrder.includes(key);
    const multiSelected = visibleSelectedKeys.has(key);
    if (renamingId === bot.id) {
      return (
        <div className={`bot-row renaming${bot.id === selectedBotId ? " selected" : ""}`} key={bot.id} role="listitem">
          <span className="bot-icon bot-avatar-container"><BotAvatarIcon shape={bot.avatarShape} color={bot.avatarColor} size={28} /></span>
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
        className={`bot-row${bot.id === selectedBotId ? " selected" : ""}${multiSelected ? " multi-selected" : ""}`}
        key={bot.id}
        onClick={(event) => {
          if (batchSelectable) handleSelection(event, key, () => onSelectBot(bot));
          else {
            clearMultiSelection();
            onSelectBot(bot);
          }
        }}
        onContextMenu={(event) => openContextMenu(event, bot)}
        onKeyDown={(event) => {
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          event.preventDefault();
          if (!showBatchContextMenu(key, 0, 0, event.currentTarget.getBoundingClientRect())) {
            setBatchContextMenu(null);
            showContextMenu(bot, 0, 0, event.currentTarget.getBoundingClientRect());
          }
        }}
        role="listitem"
        aria-label={identity.inline}
        aria-haspopup="menu"
        data-multi-selected={multiSelected ? "true" : undefined}
      >
        <span className={`bot-icon${multiSelected ? "" : " bot-avatar-container"}`}>
          {multiSelected ? <CheckIcon /> : <BotAvatarIcon shape={bot.avatarShape} color={bot.avatarColor} size={28} />}
        </span>
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
        {visibleSelectedKeys.size > 0 ? (
          <>
            <div className="brand sidebar-selection-count">已选择 {visibleSelectedKeys.size} 项</div>
            <div className="sidebar-header-actions sidebar-selection-actions">
              <button
                className="sidebar-selection-action danger"
                type="button"
                aria-label={`删除已选择的 ${visibleSelectedKeys.size} 项`}
                onClick={() => setBatchDeleteTarget(conversationOrder.filter((key) => visibleSelectedKeys.has(key)))}
                disabled={batchDeletePending}
              >
                <TrashIcon />
              </button>
              <button className="sidebar-selection-action" type="button" aria-label="清除多选" onClick={clearMultiSelection} disabled={batchDeletePending}>
                <CloseIcon />
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="brand">Aevoren Bot</div>
            <div className="sidebar-header-actions">
              <button ref={createButtonRef} className="new-bot-button" type="button" aria-label="新建聊天" onClick={onCreate} disabled={busy}>
                <PlusIcon />
                <span>新建聊天</span>
              </button>
              <button className="drawer-close-button" type="button" aria-label="关闭 Bot 列表" onClick={onMobileClose}>
                <CloseIcon />
              </button>
            </div>
          </>
        )}
      </div>
      <div className="bot-list">
        <details
          className="sidebar-workspace"
          open={workspaceExpanded}
          onToggle={(event) => setWorkspaceExpanded(event.currentTarget.open)}
        >
          <summary className="sidebar-workspace-summary" aria-controls="sidebar-workspace-content">
            <span className="sidebar-workspace-title">工作区</span>
          </summary>
          <div className="sidebar-workspace-content" id="sidebar-workspace-content">
            <section className="sidebar-workspace-section" aria-label="群聊">
              <h3 className="sidebar-workspace-section-heading">
                <FolderIcon />
                <span>群聊</span>
              </h3>
              <div className="sidebar-workspace-items" id="sidebar-room-items" role="list">
                {activeRooms.length > 0 ? activeRooms.map(renderRoomRow) : <div className="bot-list-empty">暂无群聊</div>}
              </div>
            </section>
            <section className="sidebar-workspace-section" aria-label="Bot">
              <h3 className="sidebar-workspace-section-heading">
                <FolderIcon />
                <span>Bot</span>
              </h3>
              <div className="sidebar-workspace-items" id="sidebar-bot-items" role="list">
                {visibleBots.length > 0
                  ? visibleBots.map(renderBotRow)
                  : <div className="bot-list-empty">还没有 Bot。新建一个 Bot 开始工作。</div>}
              </div>
            </section>
            {hiddenBots.length + hiddenRooms.length > 0 ? (
              <>
                <button className="archived-toggle" type="button" aria-expanded={hiddenOpen} onClick={() => setHiddenOpen((open) => !open)}>
                  已隐藏 ({hiddenBots.length + hiddenRooms.length})
                </button>
                {hiddenOpen ? <div className="sidebar-workspace-items" role="list">{hiddenRooms.map(renderRoomRow)}{hiddenBots.map(renderBotRow)}</div> : null}
              </>
            ) : null}
            {archivedRooms.length > 0 ? (
              <>
                <button className="archived-toggle" type="button" aria-expanded={archivedOpen} onClick={() => setArchivedOpen((open) => !open)}>
                  已归档 ({archivedRooms.length})
                </button>
                {archivedOpen ? <div className="sidebar-workspace-items">{archivedRooms.map((room) => (
                  <div className="archived-room-row" key={room.id}>
                    <span>{room.name}</span>
                    <button className="text-button" type="button" onClick={() => onRestoreRoom(room)}>恢复</button>
                  </div>
                ))}</div> : null}
              </>
            ) : null}
          </div>
        </details>
      </div>

      <div className="sidebar-footer">
        <button className="sidebar-settings-button" type="button" onClick={onOpenSettings}>
          <SettingsIcon />
          <span>设置</span>
        </button>
      </div>

      {notice ? <div className="bot-action-notice" role="status">{notice}</div> : null}
      {batchContextMenu && batchMenuInput ? (
        <BatchContextMenu
          label={batchDeleteLabel(batchMenuInput)}
          x={batchContextMenu.x}
          y={batchContextMenu.y}
          onClose={closeBatchContextMenu}
          onDelete={() => setBatchDeleteTarget(batchContextMenu.keys)}
        />
      ) : null}
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
      {contextRoom && roomContextMenu ? (
        <RoomContextMenu
          room={contextRoom}
          x={roomContextMenu.x}
          y={roomContextMenu.y}
          onClose={closeRoomContextMenu}
          onPin={() => void performRoom(contextRoom, () => onPinRoom(contextRoom, !contextRoom.pinnedAt), contextRoom.pinnedAt ? "已取消置顶。" : "群聊已置顶。")}
          onUnread={() => void performRoom(contextRoom, () => onMarkRoomUnread(contextRoom, !contextRoom.hasUnread), contextRoom.hasUnread ? "已标为已读。" : "已标为未读。")}
          onRename={() => beginRoomRename(contextRoom)}
          onCopyId={() => void performRoom(contextRoom, () => onCopyRoomId(contextRoom), "对话 ID 已复制。")}
          onHide={() => void performRoom(contextRoom, () => onHideRoom(contextRoom, !contextRoom.hiddenAt), contextRoom.hiddenAt ? "群聊已恢复。" : "群聊已隐藏。")}
          onArchive={() => void performRoom(contextRoom, () => onArchiveRoom(contextRoom), "群聊已归档。")}
          onDelete={() => setRoomDeleteTarget(contextRoom)}
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

      {roomDeleteTarget ? (
        <div className="bot-delete-backdrop" role="presentation">
          <section
            className="bot-delete-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="room-delete-title"
            aria-describedby="room-delete-description"
            onKeyDown={(event) => {
              if (event.key !== "Tab") return;
              if (event.shiftKey && document.activeElement === roomDeleteCancelRef.current) {
                event.preventDefault();
                roomDeleteConfirmRef.current?.focus();
              } else if (!event.shiftKey && document.activeElement === roomDeleteConfirmRef.current) {
                event.preventDefault();
                roomDeleteCancelRef.current?.focus();
              }
            }}
          >
            <h2 id="room-delete-title">删除“{roomDeleteTarget.name}”？</h2>
            <p id="room-delete-description">这会永久删除该群聊及聊天历史。群聊中的 Bot 不会被删除，此操作无法撤销。</p>
            <div className="bot-delete-actions">
              <button ref={roomDeleteCancelRef} type="button" className="secondary-button" disabled={pendingRoomId === roomDeleteTarget.id} onClick={() => setRoomDeleteTarget(null)}>取消</button>
              <button
                ref={roomDeleteConfirmRef}
                type="button"
                className="danger-confirm-button"
                disabled={pendingRoomId === roomDeleteTarget.id}
                onClick={() => void performRoom(roomDeleteTarget, () => onDeleteRoom(roomDeleteTarget), "群聊已删除。").then((succeeded) => {
                  if (succeeded) setRoomDeleteTarget(null);
                })}
              >{pendingRoomId === roomDeleteTarget.id ? "删除中…" : "删除"}</button>
            </div>
          </section>
        </div>
      ) : null}

      {batchDeleteTarget && batchDialogInput ? (
        <div className="bot-delete-backdrop" role="presentation">
          <section
            className="bot-delete-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="batch-delete-title"
            aria-describedby="batch-delete-description"
            onKeyDown={(event) => {
              if (event.key !== "Tab") return;
              if (event.shiftKey && document.activeElement === batchDeleteCancelRef.current) {
                event.preventDefault();
                batchDeleteConfirmRef.current?.focus();
              } else if (!event.shiftKey && document.activeElement === batchDeleteConfirmRef.current) {
                event.preventDefault();
                batchDeleteCancelRef.current?.focus();
              }
            }}
          >
            <h2 id="batch-delete-title">{batchDialogTitle}</h2>
            <p id="batch-delete-description">{batchDialogDescription}</p>
            <div className="bot-delete-actions">
              <button
                ref={batchDeleteCancelRef}
                type="button"
                className="secondary-button"
                disabled={batchDeletePending}
                onClick={() => setBatchDeleteTarget(null)}
              >取消</button>
              <button
                ref={batchDeleteConfirmRef}
                type="button"
                className="danger-confirm-button"
                disabled={batchDeletePending}
                onClick={() => void performBatchDelete()}
              >{batchDeletePending ? "删除中…" : "删除"}</button>
            </div>
          </section>
        </div>
      ) : null}
    </aside>
  );
}
