import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { AppError, Bot, Room } from "@shared/contracts";
import { BotAvatarIcon } from "./BotAvatarIcon";
import { CheckIcon, ChevronDownIcon, MenuIcon, RoomIcon } from "./Icons";
import { ProfileInspector, type ProfileInspectorHandle, type SaveStatus } from "./ProfileInspector";
import "../styles/contacts.css";

type ProfileTab = "profile" | "models" | "memory";

export type ContactDetailHandle = {
  flush(): Promise<boolean>;
  focusName(): void;
};

type Props = {
  bot: Bot | null;
  rooms: Room[];
  busy: boolean;
  workspaceIds: string[];
  editingRequested?: number;
  onSend(bot: Bot): Promise<boolean>;
  onBotUpdated(bot: Bot): void;
  onAddToRoom(bot: Bot, roomId: string): Promise<boolean>;
  onOpenBots(): void;
  onError?(error: AppError | null): void;
};

type ContactProfileProps = Props & {
  bot: Bot;
  onLocalError(error: AppError | null): void;
  onSaveStatusChange(status: SaveStatus): void;
};

const ContactProfile = forwardRef<ContactDetailHandle, ContactProfileProps>(function ContactProfile(
  { bot, rooms, busy, workspaceIds, onBotUpdated, onAddToRoom, onLocalError, onSaveStatusChange }, ref,
) {
  const [selectedRoomId, setSelectedRoomId] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<ProfileTab>("profile");
  const [editing, setEditing] = useState(false);
  const editorRef = useRef<ProfileInspectorHandle>(null);
  const availableRooms = rooms.filter((room) => room.archivedAt === null);
  const selectedRoom = availableRooms.find((room) => room.id === selectedRoomId);
  const disabled = busy || pending;

  async function flush(): Promise<boolean> { return await editorRef.current?.flush() ?? true; }

  function focusName(): void {
    void flush().then((saved) => {
      if (!saved) return;
      setTab("profile");
      setEditing(true);
      requestAnimationFrame(() => editorRef.current?.focusName());
    });
  }

  useImperativeHandle(ref, () => ({ flush, focusName }));

  async function changeTab(next: ProfileTab): Promise<boolean> {
    if (next === tab) return true;
    if (!(await flush())) return false;
    setTab(next);
    return true;
  }

  async function addToRoom(): Promise<void> {
    if (!selectedRoom || disabled || !(await flush())) return;
    setPending(true);
    setNotice("");
    onLocalError(null);
    try {
      const added = await onAddToRoom(bot, selectedRoom.id);
      setNotice(added ? `已加入「${selectedRoom.name}」。` : "未能加入群聊，请稍后重试。");
      if (added) setSelectedRoomId("");
    } catch (error: unknown) {
      console.warn("Contact add to room failed", error);
      setNotice("未能加入群聊，请稍后重试。");
    } finally { setPending(false); }
  }

  return (
    <section className="contact-profile-panel" aria-label="联系人资料">
      <div className="contact-profile-hero">
        <BotAvatarIcon shape={bot.avatarShape} color={bot.avatarColor} size={92} title={`${bot.name}头像`} />
        <div><h2>{bot.name}</h2><p>{bot.label || "Bot"}</p></div>
        {tab === "profile" ? <button className="text-button contact-edit-button" type="button" disabled={pending} onClick={() => {
          if (editing) void flush().then((saved) => { if (saved) setEditing(false); });
          else focusName();
        }}>{editing ? "完成编辑" : "编辑资料"}</button> : null}
      </div>
      <div className="contact-profile-tabs" role="tablist" aria-label="联系人配置">
        {([ ["profile", "资料"], ["models", "模型与能力"], ["memory", "记忆"] ] as const).map(([value, label]) => (
          <button key={value} id={`contact-${bot.id}-${value}-tab`} role="tab" tabIndex={tab === value ? 0 : -1} aria-selected={tab === value} aria-controls={`contact-${bot.id}-${value}-panel`} type="button" onClick={() => void changeTab(value)} onKeyDown={(event) => {
            const tabs: ProfileTab[] = ["profile", "models", "memory"];
            const index = tabs.indexOf(value);
            const next = event.key === "ArrowRight" ? tabs[(index + 1) % tabs.length] : event.key === "ArrowLeft" ? tabs[(index + tabs.length - 1) % tabs.length] : event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1] : null;
            if (!next) return;
            event.preventDefault();
            void changeTab(next).then((changed) => { if (changed) document.getElementById(`contact-${bot.id}-${next}-tab`)?.focus(); });
          }}>{label}</button>
        ))}
      </div>
      <ProfileInspector ref={editorRef} bot={bot} workspaceIds={workspaceIds} activeTab={tab} editing={editing} onBotUpdated={onBotUpdated} onError={onLocalError} onSaveStatusChange={onSaveStatusChange} />
      {tab === "profile" ? <details className="contact-section-disclosure contact-room-disclosure">
        <summary><RoomIcon /><strong>加入群聊</strong><ChevronDownIcon className="contact-disclosure-chevron" /></summary>
        <div className="contact-room-group">
          <label className="field"><span>加入已有群聊</span><select aria-label="选择已有群聊" value={selectedRoom?.id ?? ""} disabled={disabled || availableRooms.length === 0} onChange={(event) => { setSelectedRoomId(event.target.value); setNotice(""); }}>
            <option value="">{availableRooms.length === 0 ? "暂无可加入的群聊" : "选择群聊…"}</option>
            {availableRooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
          </select></label>
          <button className="secondary-button" type="button" disabled={disabled || !selectedRoom} onClick={() => void addToRoom()}>{pending ? "加入中…" : "加入群聊"}</button>
        </div>
        {notice ? <p className="contact-detail-notice" role="status">{notice}</p> : null}
      </details> : null}
    </section>
  );
});

export const ContactDetail = forwardRef<ContactDetailHandle, Props>(function ContactDetail(props, ref) {
  const profileRef = useRef<ContactDetailHandle>(null);
  const latestBotRef = useRef(props.bot);
  const editingRequestRef = useRef(props.editingRequested);
  const [error, setError] = useState<AppError | null>(null);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [opening, setOpening] = useState(false);
  const reportExternalError = props.onError;
  const reportError = useCallback((next: AppError | null): void => {
    setError(next);
    reportExternalError?.(next);
  }, [reportExternalError]);
  const externalBotUpdated = props.onBotUpdated;
  const botUpdated = useCallback((bot: Bot): void => {
    latestBotRef.current = bot;
    externalBotUpdated(bot);
  }, [externalBotUpdated]);

  useEffect(() => { latestBotRef.current = props.bot; }, [props.bot]);
  useEffect(() => { setError(null); setStatus("idle"); }, [props.bot?.id]);
  useEffect(() => {
    if (props.editingRequested === undefined || props.editingRequested === editingRequestRef.current) return;
    editingRequestRef.current = props.editingRequested;
    profileRef.current?.focusName();
  }, [props.editingRequested]);

  useImperativeHandle(ref, () => ({
    async flush(): Promise<boolean> { return await profileRef.current?.flush() ?? true; },
    focusName(): void { profileRef.current?.focusName(); },
  }));

  return (
    <main className="contact-detail" aria-label="联系人资料">
      <header className="contact-detail-header">
        <button className="mobile-panel-button" type="button" aria-label="打开 Bot 列表" onClick={props.onOpenBots}><MenuIcon /></button>
        <div className="contact-detail-title"><h1>联系人资料</h1></div>
        {props.bot ? <div className="contact-header-actions">
          <div className={`save-status status-${status}`} data-testid="profile-save-status" role="status">
            {status === "saving" ? "保存中…" : status === "dirty" ? "未保存" : status === "failed" ? "保存失败" : <><CheckIcon />已保存</>}
          </div>
          <button className="secondary-button" type="button" disabled={props.busy || opening} onClick={() => {
            if (!props.bot || opening) return;
            const bot = props.bot;
            setOpening(true);
            void (async () => {
              try {
                if (!(await profileRef.current?.flush())) return;
                const latest = latestBotRef.current;
                if (!latest || latest.id !== bot.id) return;
                if (!(await props.onSend(latest))) reportError({ code: "CONTACT_CHAT_OPEN_FAILED", domain: "bot", retryable: true, safeMessage: "暂时无法打开聊天，请稍后重试。" });
              } catch (failure: unknown) {
                console.warn("Contact chat open failed", failure);
                reportError({ code: "CONTACT_CHAT_OPEN_FAILED", domain: "bot", retryable: true, safeMessage: "暂时无法打开聊天，请稍后重试。" });
              } finally { setOpening(false); }
            })();
          }}>{opening ? "打开中…" : "发消息"}</button>
        </div> : null}
      </header>
      <div className="contact-detail-body">
        {error ? <div className="dialog-error contact-local-error" role="alert">{error.safeMessage}</div> : null}
        {props.bot ? <ContactProfile key={props.bot.id} ref={profileRef} {...props} bot={props.bot} onBotUpdated={botUpdated} onLocalError={reportError} onSaveStatusChange={setStatus} /> : (
          <div className="contact-detail-empty"><h2>选择一位联系人</h2><p>从列表选择 Bot，编辑资料、配置模型或开始聊天。</p></div>
        )}
      </div>
    </main>
  );
});
