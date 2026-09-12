import { useEffect, useMemo, useRef, useState } from "react";
import type { AppError, Bot } from "@shared/contracts";
import { BotIcon, PlusIcon, RoomIcon } from "./Icons";

type NewBotChooserProps = {
  bots: Bot[];
  creating: boolean;
  error: AppError | null;
  onClose(): void;
  onCreate(): void;
  onCreateRoom(botIds: string[]): void;
  onSelect(bot: Bot): void;
};

export function NewBotChooser({
  bots,
  creating,
  error,
  onClose,
  onCreate,
  onCreateRoom,
  onSelect,
}: NewBotChooserProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [groupMode, setGroupMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const createRef = useRef<HTMLButtonElement>(null);
  const filteredBots = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return bots;
    return bots.filter((bot) => `${bot.name}\n${bot.label}`.toLocaleLowerCase().includes(normalized));
  }, [bots, query]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape" || creating) return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [creating, onClose]);

  return (
    <div
      className="new-bot-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !creating) onClose();
      }}
    >
      <section className="new-bot-chooser" role="dialog" aria-modal="true" aria-label="新建聊天">
        <header className="recipient-header">
          <span>收件人：</span>
          <input
            autoFocus
            aria-label="搜索或创建 Bot"
            placeholder="搜索或创建 Bot"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !creating && !groupMode) {
                event.preventDefault();
                onCreate();
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                createRef.current?.focus();
              }
            }}
          />
          <button
            type="button"
            className="icon-button"
            aria-label="关闭新聊天"
            disabled={creating}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="recipient-options">
          <button
            ref={createRef}
            className="recipient-option create-option"
            type="button"
            disabled={creating}
            onClick={onCreate}
          >
            <span className="recipient-option-icon"><PlusIcon /></span>
            <span>{creating ? "创建中…" : "创建新 Bot"}</span>
          </button>
          <button
            className={`recipient-option${groupMode ? " selected" : ""}`}
            type="button"
            disabled={creating || bots.length < 2}
            onClick={() => {
              setGroupMode(true);
              setQuery("");
            }}
          >
            <span className="recipient-option-icon"><RoomIcon /></span>
            <span className="recipient-option-copy"><strong>创建群聊</strong><small>选择 2～6 个现有 Bot</small></span>
          </button>
          {filteredBots.map((bot) => (
            <button
              className={`recipient-option${selectedIds.has(bot.id) ? " selected" : ""}`}
              type="button"
              key={bot.id}
              aria-label={bot.name}
              disabled={creating || (groupMode && selectedIds.size >= 6 && !selectedIds.has(bot.id))}
              onClick={() => {
                if (!groupMode) {
                  onSelect(bot);
                  return;
                }
                setSelectedIds((current) => {
                  const next = new Set(current);
                  if (next.has(bot.id)) next.delete(bot.id);
                  else next.add(bot.id);
                  return next;
                });
              }}
            >
              <span className="recipient-option-icon"><BotIcon /></span>
              <span className="recipient-option-copy">
                <strong>{groupMode ? `${selectedIds.has(bot.id) ? "✓ " : ""}${bot.name}` : bot.name}</strong>
                {bot.label ? <small>{bot.label}</small> : null}
              </span>
            </button>
          ))}
          {query.trim() && filteredBots.length === 0 ? (
            <div className="recipient-empty">没有匹配的现有 Bot。</div>
          ) : null}
        </div>
        {groupMode ? (
          <footer className="recipient-footer">
            <span>已选择 {selectedIds.size}/6 个 Bot</span>
            <button
              className="primary-button"
              type="button"
              disabled={creating || selectedIds.size < 2}
              onClick={() => onCreateRoom(bots.filter((bot) => selectedIds.has(bot.id)).map((bot) => bot.id))}
            >{creating ? "创建中…" : "创建群聊"}</button>
          </footer>
        ) : null}
        {error ? <div className="chooser-error" role="alert">{error.safeMessage}</div> : null}
      </section>
    </div>
  );
}
