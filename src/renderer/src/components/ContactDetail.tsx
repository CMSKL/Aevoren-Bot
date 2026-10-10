import { useEffect, useState } from "react";
import type { Bot, ProviderInstanceInfo, Room } from "@shared/contracts";
import { BotAvatarIcon } from "./BotAvatarIcon";
import { MenuIcon } from "./Icons";
import { ProviderStatusPill } from "./ProviderPresentation";

type ProviderLoadState = "loading" | "ready" | "failed";
const PROVIDERS_CHANGED_EVENT = "aevoren:providers-changed";

type Props = {
  bot: Bot | null;
  rooms: Room[];
  busy: boolean;
  error?: string | null;
  onSend(bot: Bot): void;
  onEdit(bot: Bot): void;
  onAddToRoom(bot: Bot, roomId: string): Promise<boolean>;
  onOpenBots(): void;
};

function ContactProfile({ bot, rooms, busy, provider, providerLoadState, onSend, onEdit, onAddToRoom }: Props & {
  bot: Bot;
  provider: ProviderInstanceInfo | undefined;
  providerLoadState: ProviderLoadState;
}): React.JSX.Element {
  const [selectedRoomId, setSelectedRoomId] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const availableRooms = rooms.filter((room) => room.archivedAt === null);
  const selectedRoom = availableRooms.find((room) => room.id === selectedRoomId);
  const disabled = busy || pending;
  const providerName = provider?.driverKind === "openai-compatible" ? "API"
    : provider?.driverKind === "claude-cli" ? "Claude Code"
      : provider?.driverKind === "codex-cli" ? "Codex"
        : provider?.displayName ?? "模型来源";
  const modelName = provider?.models.options.find((model) => model.id === bot.modelSelection.modelId)?.label
    ?? (bot.modelSelection.modelId || "默认模型");

  async function addToRoom(): Promise<void> {
    if (!selectedRoom || disabled) return;
    setPending(true);
    setNotice("");
    try {
      const added = await onAddToRoom(bot, selectedRoom.id);
      setNotice(added ? `已加入「${selectedRoom.name}」。` : "未能加入群聊，请查看错误提示后重试。");
      if (added) setSelectedRoomId("");
    } catch {
      setNotice("未能加入群聊，请稍后重试。");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="contact-detail-card contact-profile-panel" aria-label="联系人资料">
      <div className="contact-detail-identity">
        <BotAvatarIcon shape={bot.avatarShape} color={bot.avatarColor} size={72} title={`${bot.name}头像`} />
        <h2>{bot.name}</h2>
        {bot.label ? <p className="contact-detail-label">{bot.label}</p> : null}
      </div>
      <p className="contact-detail-description">{bot.description || "暂未填写描述。"}</p>
      <p className="contact-detail-label" aria-label="模型来源与可用状态" title={provider?.reason ?? undefined}>
        {providerName} · {modelName} · {providerLoadState === "ready" && provider ? (
          <ProviderStatusPill provider={provider} />
        ) : providerLoadState === "loading" ? "读取状态中…" : providerLoadState === "failed" ? "状态读取失败" : "待配置"}
      </p>
      <div className="contact-detail-actions">
        <button className="primary-button" type="button" disabled={disabled} onClick={() => onSend(bot)}>发消息</button>
        <button className="secondary-button" type="button" disabled={disabled} onClick={() => onEdit(bot)}>编辑资料</button>
      </div>
      <section className="contact-room-group settings-form-group" aria-label="加入群聊">
      <label className="field">
        <span>加入已有群聊</span>
        <select
          aria-label="选择已有群聊"
          value={selectedRoom?.id ?? ""}
          disabled={disabled || availableRooms.length === 0}
          onChange={(event) => {
            setSelectedRoomId(event.target.value);
            setNotice("");
          }}
        >
          <option value="">{availableRooms.length === 0 ? "暂无可加入的群聊" : "选择群聊…"}</option>
          {availableRooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
        </select>
      </label>
      <button className="secondary-button" type="button" disabled={disabled || !selectedRoom} onClick={() => void addToRoom()}>
        {pending ? "加入中…" : "加入群聊"}
      </button>
      </section>
      <p className="contact-detail-notice" role="status">{notice}</p>
    </section>
  );
}

export function ContactDetail(props: Props): React.JSX.Element {
  const [providerState, setProviderState] = useState<{ providers: ProviderInstanceInfo[]; status: ProviderLoadState }>({
    providers: [],
    status: "loading",
  });
  const provider = providerState.providers.find((item) => item.id === props.bot?.modelSelection.providerInstanceId);

  useEffect(() => {
    let requestVersion = 0;
    const loadProviders = (): void => {
      const version = ++requestVersion;
      setProviderState((current) => ({ ...current, status: "loading" }));
      void window.aevorenBot.providers.list().then((result) => {
        if (version !== requestVersion) return;
        setProviderState({ providers: result.ok ? result.data : [], status: result.ok ? "ready" : "failed" });
      }).catch(() => {
        if (version === requestVersion) setProviderState({ providers: [], status: "failed" });
      });
    };
    loadProviders();
    window.addEventListener(PROVIDERS_CHANGED_EVENT, loadProviders);
    return () => {
      requestVersion += 1;
      window.removeEventListener(PROVIDERS_CHANGED_EVENT, loadProviders);
    };
  }, []);

  return (
    <main className="conversation contact-detail">
      <header className="conversation-header">
        <button className="mobile-panel-button" type="button" aria-label="打开 Bot 列表" onClick={props.onOpenBots}>
          <MenuIcon />
        </button>
        <div className="conversation-title">
          <h1>联系人</h1>
          <p>查看 Bot 资料，发起聊天或加入群聊。</p>
        </div>
      </header>
      <div className="contact-detail-body">
        {props.error ? <div className="dialog-error" role="alert">{props.error}</div> : null}
        {props.bot ? (
          <ContactProfile key={props.bot.id} {...props} bot={props.bot} provider={provider} providerLoadState={providerState.status} />
        ) : (
          <div className="contact-detail-empty">
            <h2>选择一位联系人</h2>
            <p>从列表选择 Bot，查看资料或开始聊天。</p>
          </div>
        )}
      </div>
    </main>
  );
}
