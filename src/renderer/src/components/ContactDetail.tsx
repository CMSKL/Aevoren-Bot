import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { AppError, Bot, Room } from "@shared/contracts";
import type { ResourceReference } from "@shared/library-contracts";
import type { MessageMediaReference } from "@shared/media-contracts";
import type { EnvironmentScope } from "@shared/environment-contracts";
import { DetailsTabs } from "./DetailsTabs";
import { BotAvatarIcon } from "./BotAvatarIcon";
import { CheckIcon, ChevronDownIcon, CloseIcon, MenuIcon, RoomIcon } from "./Icons";
import { ProfileInspector, type ProfileInspectorHandle, type SaveStatus } from "./ProfileInspector";
import { LibraryPanel, type LibraryPanelHandle } from "./LibraryPanel";
import { MediaLibraryPanel } from "./MediaLibraryPanel";
import { EnvironmentPanel } from "./EnvironmentPanel";
import { ComputerPanel } from "./ComputerPanel";
import { ConnectorPanel, type ConnectorPanelHandle } from "./ConnectorPanel";
import { McpToolPanel } from "./McpToolPanel";
import { ScopedAppsApprovalHost } from "./ScopedAppsApprovalHost";
import "../styles/contacts.css";

type ProfileTab = "profile" | "models" | "memory" | "library" | "skill" | "environment" | "browser" | "computer" | "apps";

export type ContactDetailHandle = {
  flush(): Promise<boolean>;
  focusName(): void;
};

type Props = {
  bot: Bot | null;
  active?: boolean;
  rooms: Room[];
  busy: boolean;
  workspaceIds: string[];
  editingRequested?: number;
  librarySessionId?: string;
  onUseResource?(reference: ResourceReference, text?: string): void;
  onUseMedia?(reference: MessageMediaReference): void;
  onSend(bot: Bot): Promise<boolean>;
  onBotUpdated(bot: Bot): void;
  onAddToRoom(bot: Bot, roomId: string): Promise<boolean>;
  onOpenBots(): void;
  onClose?(): void;
  onError?(error: AppError | null): void;
};

type ContactProfileProps = Props & {
  bot: Bot;
  onLocalError(error: AppError | null): void;
  onSaveStatusChange(status: SaveStatus): void;
};

const ContactProfile = forwardRef<ContactDetailHandle, ContactProfileProps>(function ContactProfile(
  { bot, active = true, rooms, busy, workspaceIds, librarySessionId, onUseResource, onUseMedia, onBotUpdated, onAddToRoom, onLocalError, onSaveStatusChange }, ref,
) {
  const [selectedRoomId, setSelectedRoomId] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<ProfileTab>("profile");
  const [editing, setEditing] = useState(false);
  const [previewPageId, setPreviewPageId] = useState<string>();
  const [scriptExecution, setScriptExecution] = useState<EnvironmentScope & { id: string }>();
  const [changingTab, setChangingTab] = useState(false);
  const tabChangeRef = useRef(false);
  const profileElementRef = useRef<HTMLElement>(null);
  const editorRef = useRef<ProfileInspectorHandle>(null);
  const documentsRef = useRef<LibraryPanelHandle>(null);
  const skillsRef = useRef<LibraryPanelHandle>(null);
  const appsRef = useRef<ConnectorPanelHandle>(null);
  const availableRooms = rooms.filter((room) => room.archivedAt === null);
  const selectedRoom = availableRooms.find((room) => room.id === selectedRoomId);
  const disabled = busy || pending;

  async function flush(): Promise<boolean> {
    if (!(await editorRef.current?.flush() ?? true)) return false;
    if (tab === "library") return await documentsRef.current?.flush() ?? true;
    if (tab === "skill") return await skillsRef.current?.flush() ?? true;
    if (tab === "apps") return await appsRef.current?.flush() ?? true;
    return true;
  }

  function focusName(): void {
    const focusOwner = document.activeElement;
    void flush().then((saved) => {
      if (!saved) return;
      setTab("profile");
      setEditing(true);
      requestAnimationFrame(() => {
        if (document.activeElement !== focusOwner || !profileElementRef.current?.getClientRects().length) return;
        editorRef.current?.focusName();
      });
    });
  }

  useImperativeHandle(ref, () => ({ flush, focusName }));

  async function changeTab(next: ProfileTab): Promise<boolean> {
    if (next === tab) return true;
    if (tabChangeRef.current) return false;
    tabChangeRef.current = true;
    setChangingTab(true);
    try {
      if (!(await flush())) return false;
      setTab(next);
      return true;
    } finally { tabChangeRef.current = false; setChangingTab(false); }
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
    <section ref={profileElementRef} className="contact-profile-panel" aria-label="联系人资料">
      <div className="contact-profile-hero">
        <BotAvatarIcon shape={bot.avatarShape} color={bot.avatarColor} size={64} title={`${bot.name}头像`} />
        <div><h2>{bot.name}</h2><p>{bot.label || "Bot"}</p></div>
        {tab === "profile" ? <button className="text-button contact-edit-button" type="button" disabled={pending} onClick={() => {
          if (editing) void flush().then((saved) => { if (saved) setEditing(false); });
          else focusName();
        }}>{editing ? "完成编辑" : "编辑资料"}</button> : null}
      </div>
      <DetailsTabs idPrefix={`contact-${bot.id}`} label="联系人配置" tabs={[
        { id: "profile", label: "详情" }, { id: "library", label: "资料库" }, { id: "computer", label: "电脑" },
        { id: "models", label: "模型与能力" }, { id: "memory", label: "记忆" }, { id: "skill", label: "Skill" },
        { id: "environment", label: "执行环境" }, { id: "browser", label: "浏览器" }, { id: "apps", label: "应用" },
      ]} primary={["profile", "library", "computer"]} value={tab} disabled={changingTab} onChange={next => changeTab(next as ProfileTab)} />
      <div hidden={tab === "library" || tab === "skill" || tab === "environment" || tab === "browser" || tab === "computer" || tab === "apps"}><ProfileInspector ref={editorRef} bot={bot} workspaceIds={workspaceIds} activeTab={tab === "models" || tab === "memory" ? tab : "profile"} editing={editing} onBotUpdated={onBotUpdated} onError={onLocalError} onSaveStatusChange={onSaveStatusChange} /></div>
      <div id={`contact-${bot.id}-library-panel`} role="tabpanel" aria-labelledby={`contact-${bot.id}-library-tab`} hidden={tab !== "library"} className="contact-tab-panel">
        {librarySessionId ? <LibraryPanel ref={documentsRef} sessionId={librarySessionId} kind="document" active={active && tab === "library"} busy={!onUseResource} onUse={(reference, text) => onUseResource?.(reference, text)} /> : <p className="library-empty" role="status">正在读取当前 Bot 的私聊资料范围…</p>}
        {librarySessionId ? <MediaLibraryPanel key={librarySessionId} sessionId={librarySessionId} active={active && tab === "library"} busy={!onUseMedia} onUse={reference => onUseMedia?.(reference)} /> : null}
      </div>
      <div id={`contact-${bot.id}-skill-panel`} role="tabpanel" aria-labelledby={`contact-${bot.id}-skill-tab`} hidden={tab !== "skill"} className="contact-tab-panel">
        {librarySessionId ? <LibraryPanel ref={skillsRef} sessionId={librarySessionId} executorBotId={bot.id} ownerName={bot.name} kind="skill" active={active && tab === "skill"} busy={!onUseResource} onUse={(reference, text) => onUseResource?.(reference, text)} onOpenExecution={execution => { if (execution.sessionId !== librarySessionId || execution.executorBotId !== bot.id) return; setScriptExecution(execution); void changeTab("environment"); }} /> : <p className="library-empty" role="status">正在读取当前 Bot 的私聊 Skill 范围…</p>}
      </div>
      <div id={`contact-${bot.id}-environment-panel`} role="tabpanel" aria-labelledby={`contact-${bot.id}-environment-tab`} hidden={tab !== "environment"} className="contact-tab-panel">
        {librarySessionId ? <EnvironmentPanel sessionId={librarySessionId} executorBotId={bot.id} ownerName={bot.name} active={active && tab === "environment"} initialExecutionId={scriptExecution?.sessionId === librarySessionId && scriptExecution.executorBotId === bot.id ? scriptExecution.id : undefined} onOpenPreview={pageId => { setPreviewPageId(pageId); void changeTab("browser"); }} /> : <p className="library-empty" role="status">正在读取当前 Bot 的私聊执行范围…</p>}
      </div>
      {(["browser", "computer"] as const).map(mode => <div key={mode} id={`contact-${bot.id}-${mode}-panel`} role="tabpanel" aria-labelledby={`contact-${bot.id}-${mode}-tab`} hidden={tab !== mode} className="contact-tab-panel">
        {librarySessionId ? <ComputerPanel sessionId={librarySessionId} executorBotId={bot.id} ownerName={bot.name} mode={mode} initialPageId={previewPageId} active={active && tab === mode} /> : <p className="library-empty" role="status">正在读取当前 Bot 的私聊浏览器范围…</p>}
      </div>)}
      <div id={`contact-${bot.id}-apps-panel`} role="tabpanel" aria-labelledby={`contact-${bot.id}-apps-tab`} hidden={tab !== "apps"} className="contact-tab-panel">
        {librarySessionId ? <ConnectorPanel key={`${librarySessionId}:${bot.id}`} ref={appsRef} sessionId={librarySessionId} executorBotId={bot.id} ownerName={bot.name} active={active && tab === "apps"} /> : <p className="library-empty" role="status">正在读取当前 Bot 的私聊应用范围…</p>}
        {librarySessionId ? <McpToolPanel key={`mcp:${librarySessionId}:${bot.id}`} sessionId={librarySessionId} executorBotId={bot.id} ownerName={bot.name} active={active && tab === "apps"} /> : null}
        {librarySessionId ? <ScopedAppsApprovalHost key={`approvals:${librarySessionId}:${bot.id}`} sessionId={librarySessionId} executorBotId={bot.id} ownerName={bot.name} active={active && tab === "apps"} /> : null}
      </div>
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
    <main id={props.onClose ? "conversation-inspector" : undefined} className={`contact-detail${props.onClose ? " contact-detail-drawer" : ""}`} aria-label="联系人资料">
      <header className="contact-detail-header">
        <button className="mobile-panel-button" type="button" aria-label="打开 Bot 列表" onClick={props.onOpenBots}><MenuIcon /></button>
        <div className="contact-detail-title"><h1>联系人资料</h1></div>
        {props.bot ? <div className="contact-header-actions">
          <div className={`save-status status-${status}`} data-testid="profile-save-status" role="status">
            {status === "saving" ? "保存中…" : status === "dirty" ? "未保存" : status === "failed" ? "保存失败" : <><CheckIcon />Bot 资料已保存</>}
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
        {props.onClose ? <button className="icon-button" type="button" aria-label="关闭详情" onClick={props.onClose}><CloseIcon /></button> : null}
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
