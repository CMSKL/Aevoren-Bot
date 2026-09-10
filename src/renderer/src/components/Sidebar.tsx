import type { Bot } from "@shared/contracts";
import { BotIcon, PlusIcon } from "./Icons";

type SidebarProps = {
  bots: Bot[];
  selectedBotId: string | null;
  busy: boolean;
  onCreate(): void;
  onSelect(bot: Bot): void;
};

export function Sidebar({ bots, selectedBotId, busy, onCreate, onSelect }: SidebarProps): React.JSX.Element {
  return (
    <aside className="sidebar" aria-label="Bot 列表">
      <div className="brand">MS-Bot</div>
      <button className="new-bot-button" type="button" onClick={onCreate} disabled={busy}>
        <PlusIcon />
        新建 Bot
      </button>
      <div className="bot-list" role="list">
        {bots.length === 0 ? (
          <div className="sidebar-empty">还没有 Bot。创建一个产品需求分析助手开始工作。</div>
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
