import { useEffect, useMemo, useRef, useState } from "react";
import type { AppError, Bot, ProviderInstanceInfo } from "@shared/contracts";
import { eligibleRoomLeads } from "../room-leads";
import { buildBotIdentityMap } from "../bot-identity";
import { BotAvatarIcon } from "./BotAvatarIcon";
import { PlusIcon, RoomIcon } from "./Icons";

type NewBotChooserProps = {
  bots: Bot[];
  initialGroupMode?: boolean;
  creating: boolean;
  error: AppError | null;
  onClose(): void;
  onCreate(): void;
  onCreateRoom(botIds: string[], leadBotId?: string | null): void;
  onCreateContentTeam(): void;
  onSelect(bot: Bot): void;
};

export function NewBotChooser({
  bots,
  initialGroupMode = false,
  creating,
  error,
  onClose,
  onCreate,
  onCreateRoom,
  onCreateContentTeam,
  onSelect,
}: NewBotChooserProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [groupMode, setGroupMode] = useState(initialGroupMode);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [providers, setProviders] = useState<ProviderInstanceInfo[]>([]);
  const [leadChoice, setLeadChoice] = useState("default");
  const createRef = useRef<HTMLButtonElement>(null);
  const visibleBots = bots;
  const filteredBots = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return visibleBots;
    return visibleBots.filter((bot) => `${bot.name}\n${bot.label}`.toLocaleLowerCase().includes(normalized));
  }, [query, visibleBots]);
  const botIdentities = useMemo(() => buildBotIdentityMap(visibleBots), [visibleBots]);
  const eligibleLeads = eligibleRoomLeads(visibleBots.filter(bot => selectedIds.has(bot.id)), providers);
  const selectedLead = leadChoice === "none" || eligibleLeads.some(bot => bot.id === leadChoice) ? leadChoice : "default";

  useEffect(() => {
    if (!groupMode) return;
    let cancelled = false;
    void window.aevorenBot.providers.list().then(result => { if (!cancelled && result.ok) setProviders(result.data); });
    return () => { cancelled = true; };
  }, [groupMode]);

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
      <section className="new-bot-chooser" role="dialog" aria-modal="true" aria-label={initialGroupMode ? "新建群聊" : "新建聊天"}>
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
          {!initialGroupMode ? <button
            ref={createRef}
            className="recipient-option create-option"
            type="button"
            disabled={creating}
            onClick={onCreate}
          >
            <span className="recipient-option-icon"><PlusIcon /></span>
            <span>{creating ? "创建中…" : "创建新 Bot"}</span>
          </button> : null}
          {!initialGroupMode ? <button
            className={`recipient-option${groupMode ? " selected" : ""}`}
            type="button"
            disabled={creating || visibleBots.length < 2}
            onClick={() => {
              setGroupMode(true);
              setQuery("");
            }}
          >
            <span className="recipient-option-icon"><RoomIcon /></span>
            <span className="recipient-option-copy"><strong>创建群聊</strong><small>选择 2～6 个现有 Bot</small></span>
          </button> : null}
          {!initialGroupMode ? <button
            className="recipient-option"
            type="button"
            disabled={creating}
            onClick={onCreateContentTeam}
          >
            <span className="recipient-option-icon"><RoomIcon /></span>
            <span className="recipient-option-copy"><strong>一键创建内容团队</strong><small>创建研究、策划、写作、审校、复盘 5 个 Bot 与群聊</small></span>
          </button> : null}
          {initialGroupMode && visibleBots.length < 2 ? <div className="recipient-empty">至少需要 2 个联系人才能创建群聊。请先创建 Bot。</div> : null}
          {filteredBots.map((bot) => {
            const identity = botIdentities.get(bot.id)!;
            return (
              <button
                className={`recipient-option${selectedIds.has(bot.id) ? " selected" : ""}`}
                type="button"
                key={bot.id}
                aria-label={identity.inline}
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
                <span className="recipient-option-icon bot-avatar-container"><BotAvatarIcon shape={bot.avatarShape} color={bot.avatarColor} size={28} /></span>
                <span className="recipient-option-copy">
                  <strong>{groupMode ? `${selectedIds.has(bot.id) ? "✓ " : ""}${identity.primary}` : identity.primary}</strong>
                  {bot.label || identity.disambiguated ? <small>{identity.secondary}</small> : null}
                </span>
              </button>
            );
          })}
          {query.trim() && filteredBots.length === 0 ? (
            <div className="recipient-empty">没有匹配的现有 Bot。</div>
          ) : null}
        </div>
        {groupMode ? <label className="field recipient-lead">
          <span>群协调者</span>
          <select aria-label="新群协调者" value={selectedLead} disabled={creating} onChange={(event) => setLeadChoice(event.target.value)}>
            <option value="default">自动设置协调者</option>
            <option value="none">每轮自动选择负责人</option>
            {eligibleLeads.map(bot => <option key={bot.id} value={bot.id}>{botIdentities.get(bot.id)?.inline ?? bot.name}</option>)}
          </select>
          <small>协调者负责分工与汇总，可在群详情中更换。</small>
        </label> : null}
        {groupMode ? (
          <footer className="recipient-footer">
            <span>已选择 {selectedIds.size}/6 个 Bot</span>
            <button
              className="primary-button"
              type="button"
              disabled={creating || selectedIds.size < 2}
              onClick={() => onCreateRoom(visibleBots.filter((bot) => selectedIds.has(bot.id)).map((bot) => bot.id), selectedLead === "default" ? undefined : selectedLead === "none" ? null : selectedLead)}
            >{creating ? "创建中…" : "创建群聊"}</button>
          </footer>
        ) : null}
        {error ? <div className="chooser-error" role="alert">{error.safeMessage}</div> : null}
      </section>
    </div>
  );
}
