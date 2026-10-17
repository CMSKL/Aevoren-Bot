import { useEffect, useMemo, useRef, useState } from "react";
import type { Bot, Room } from "@shared/contracts";
import { BotAvatarIcon } from "./BotAvatarIcon";
import { RoomIcon, SearchIcon } from "./Icons";

type Result = { kind: "bot"; bot: Bot; name: string; description: string } | { kind: "room"; room: Room; name: string; description: string };

type Props = {
  bots: Bot[];
  rooms: Room[];
  onSelectBot(bot: Bot): void;
  onSelectRoom(room: Room): void;
  onClose(): void;
};

export function ChatSearchDialog({ bots, rooms, onSelectBot, onSelectRoom, onClose }: Props): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => {
    const candidates: Result[] = [
      ...bots.map(bot => ({ kind: "bot" as const, bot, name: bot.name, description: bot.label || bot.description })),
      ...rooms.filter(room => room.archivedAt === null).map(room => ({ kind: "room" as const, room, name: room.name, description: room.description || "群聊" })),
    ];
    const search = query.trim().toLocaleLowerCase();
    return candidates.filter(item => `${item.name}\n${item.description}`.toLocaleLowerCase().includes(search));
  }, [bots, rooms, query]);

  useEffect(() => {
    const previous = document.activeElement;
    inputRef.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);

  useEffect(() => {
    document.getElementById(`chat-search-${selected}`)?.scrollIntoView({ block: "nearest" });
  }, [selected, results]);

  function choose(result: Result): void {
    onClose();
    if (result.kind === "bot") onSelectBot(result.bot);
    else onSelectRoom(result.room);
  }

  return <div className="chat-search-backdrop" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}>
    <section className="chat-search-dialog" role="dialog" aria-modal="true" aria-label="搜索" onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key === "Tab") { event.preventDefault(); inputRef.current?.focus(); }
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && results.length) {
        event.preventDefault();
        setSelected(index => (index + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
      }
      if (event.key === "Enter" && results[selected]) { event.preventDefault(); choose(results[selected]); }
    }}>
      <div className="chat-search-field"><SearchIcon size={16} /><input ref={inputRef} role="combobox" aria-label="搜索 Bot 和群聊" aria-expanded="true" aria-controls="chat-search-results" aria-activedescendant={results[selected] ? `chat-search-${selected}` : undefined} autoComplete="off" placeholder="搜索" value={query} onChange={event => { setQuery(event.target.value); setSelected(0); }} /></div>
      <div className="chat-search-results" id="chat-search-results" role="listbox" aria-label="搜索结果">
        {results.map((result, index) => <button type="button" role="option" aria-selected={index === selected} id={`chat-search-${index}`} key={`${result.kind}:${result.kind === "bot" ? result.bot.id : result.room.id}`} onClick={() => choose(result)}>
          {result.kind === "bot" ? <BotAvatarIcon shape={result.bot.avatarShape} color={result.bot.avatarColor} size={24} /> : <RoomIcon size={24} />}
          <span><strong>{result.name}</strong>{result.description ? <small>{result.description}</small> : null}</span>
        </button>)}
        {results.length === 0 ? <p className="chat-search-empty">没有搜索结果</p> : null}
      </div>
    </section>
  </div>;
}
