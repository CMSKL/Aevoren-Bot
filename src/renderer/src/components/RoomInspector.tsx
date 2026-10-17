import { PRODUCT_VIEW_DOM_EVENT, type ProductViewEvent } from "@shared/product-view";
import { useEffectEvent, forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { AppError, Bot, ProviderInstanceInfo, RoomDetail, RoomPatch, UserProfile } from "@shared/contracts";
import type { ResourceReference } from "@shared/library-contracts";
import type { MessageMediaReference } from "@shared/media-contracts";
import type { EnvironmentScope } from "@shared/environment-contracts";
import { eligibleRoomLeads } from "../room-leads";
import { buildBotIdentityMap } from "../bot-identity";
import { DetailsTabs } from "./DetailsTabs";
import { RoomAvatar } from "./RoomAvatar";
import { BotAvatarIcon } from "./BotAvatarIcon";
import { CheckIcon, CloseIcon } from "./Icons";
import { ConversationWorkspace, type ConversationWorkspaceProps } from "./ConversationWorkspace";
import { LibraryPanel, type LibraryPanelHandle } from "./LibraryPanel";
import { MediaLibraryPanel } from "./MediaLibraryPanel";
import { EnvironmentPanel } from "./EnvironmentPanel";
import { ComputerPanel } from "./ComputerPanel";
import { ConnectorPanel, type ConnectorPanelHandle } from "./ConnectorPanel";
import { McpToolPanel } from "./McpToolPanel";
import { ScopedAppsApprovalHost } from "./ScopedAppsApprovalHost";

type Draft = Pick<RoomDetail["room"], "name" | "description"> & { leadBotId: string | null };
type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "failed";
type InspectorTab = "details" | "members" | "library" | "skill" | "environment" | "browser" | "computer" | "apps";

export type RoomInspectorHandle = { flush(): Promise<boolean> };

type Props = {
  id?: string;
  detail: RoomDetail | null;
  bots: Bot[];
  userProfile?: UserProfile;
  conversationWorkspace: ConversationWorkspaceProps;
  active: boolean;
  mobileOpen: boolean;
  surfaceActive?: boolean;
  error?: AppError | null;
  onDetailUpdated(detail: RoomDetail): void;
  onError(error: AppError | null): void;
  onOpenBot(bot: Bot): void;
  onMobileClose(): void;
  onUseResource?(reference: ResourceReference, text?: string): void;
  onUseMedia?(reference: MessageMediaReference): void;
};

function toDraft(detail: RoomDetail): Draft {
  return { name: detail.room.name, description: detail.room.description, leadBotId: detail.room.leadBotId ?? null };
}

function same(left: Draft, right: Draft): boolean {
  return left.name === right.name && left.description === right.description && left.leadBotId === right.leadBotId;
}

export const RoomInspector = forwardRef<RoomInspectorHandle, Props>(function RoomInspector(
  { id, detail, bots, userProfile, conversationWorkspace, active, mobileOpen, surfaceActive = true, error, onDetailUpdated, onError, onOpenBot, onMobileClose, onUseResource, onUseMedia },
  ref,
) {
  const [draft, setDraft] = useState<Draft | null>(detail ? toDraft(detail) : null);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [selectedBotId, setSelectedBotId] = useState("");
  const [memberPending, setMemberPending] = useState(false);
  const [tab, setTab] = useState<InspectorTab>("details");
  const [environmentBotId, setEnvironmentBotId] = useState("");
  const [previewPageId, setPreviewPageId] = useState<string>();
  const [scriptExecution, setScriptExecution] = useState<EnvironmentScope & { id: string }>();
  const [changingTab, setChangingTab] = useState(false);
  const tabChangeRef = useRef(false);
  const documentsRef = useRef<LibraryPanelHandle>(null);
  const skillsRef = useRef<LibraryPanelHandle>(null);
  const appsRef = useRef<ConnectorPanelHandle>(null);
  const handleProductView = useEffectEvent((event: Event) => {
    const { request, respond } = (event as CustomEvent<ProductViewEvent>).detail;
    if (request.input.action !== "room_members") return;
    if (!surfaceActive || !detail || request.input.roomId && request.input.roomId !== detail.room.id) { respond({ status: "waiting_user", reason: "请先打开指定群聊设置。" }); return; }
    void changeTab(request.input.expanded === false ? "details" : "members").then(changed => respond(changed ? { status: "completed" } : { status: "waiting_user", reason: "当前编辑尚未保存，请完成后重试。" }));
  });
  useEffect(() => { const handler = (event: Event): void => handleProductView(event); window.addEventListener(PRODUCT_VIEW_DOM_EVENT, handler); return () => window.removeEventListener(PRODUCT_VIEW_DOM_EVENT, handler); }, []);
  const [providers, setProviders] = useState<ProviderInstanceInfo[] | null>(null);
  const [providerLoadFailed, setProviderLoadFailed] = useState(false);
  const draftRef = useRef(draft);
  const savedRef = useRef<Draft | null>(detail ? toDraft(detail) : null);
  const detailRef = useRef(detail);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savePromiseRef = useRef<Promise<boolean> | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!mobileOpen) return;
    const frame = requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLButtonElement>('[aria-label="关闭群聊设置"]')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [mobileOpen]);
  const availableBots = useMemo(
    () => bots.filter((bot) => !detail?.members.some((member) => member.botId === bot.id)),
    [bots, detail],
  );
  const botIdentities = useMemo(() => buildBotIdentityMap([
    ...new Map([...bots, ...(detail?.members.map((member) => member.bot) ?? [])].map((bot) => [bot.id, bot])).values(),
  ]), [bots, detail]);
  const eligibleLeads = eligibleRoomLeads(detail?.members.map(member => member.bot) ?? [], providers ?? []);
  const environmentMember = detail?.members.find(member => member.botId === environmentBotId) ?? detail?.members[0];
  useEffect(() => {
    let cancelled = false;
    let request = 0;
    const load = (): void => {
      const currentRequest = ++request;
      setProviders(null);
      setProviderLoadFailed(false);
      void window.aevorenBot.providers.list().then(result => {
        if (cancelled || currentRequest !== request) return;
        if (result.ok) setProviders(result.data);
        else { setProviders([]); setProviderLoadFailed(true); onError(result.error); }
      }).catch(failure => {
        if (cancelled || currentRequest !== request) return;
        console.error("Room coordinator capabilities could not be loaded", failure);
        setProviders([]);
        setProviderLoadFailed(true);
        onError({ domain: "runtime", code: "INTERNAL_ERROR", retryable: true, safeMessage: "暂时无法读取协调能力，请重新打开群聊设置后重试。" });
      });
    };
    load();
    window.addEventListener("aevoren:providers-changed", load);
    return () => { cancelled = true; window.removeEventListener("aevoren:providers-changed", load); };
  }, [onError]);

  async function saveCurrent(): Promise<boolean> {
    const currentDetail = detailRef.current;
    if (!currentDetail || !draftRef.current || !savedRef.current || same(draftRef.current, savedRef.current)) return true;
    if (savePromiseRef.current) {
      const succeeded = await savePromiseRef.current;
      return succeeded ? saveCurrent() : false;
    }
    const snapshot = { ...draftRef.current };
    setStatus("saving");
    onError(null);
    const operation = window.aevorenBot.rooms.update({
      id: currentDetail.room.id,
      expectedVersion: currentDetail.room.version,
      patch: {
        name: snapshot.name,
        description: snapshot.description,
        ...(snapshot.leadBotId !== savedRef.current.leadBotId ? { leadBotId: snapshot.leadBotId } : {}),
      } as RoomPatch,
    }).then((result) => {
      if (!result.ok) {
        setStatus("failed");
        onError(result.error);
        return false;
      }
      const nextDetail = { ...currentDetail, room: result.data };
      detailRef.current = nextDetail;
      savedRef.current = snapshot;
      onDetailUpdated(nextDetail);
      setStatus(draftRef.current && same(draftRef.current, snapshot) ? "saved" : "dirty");
      return true;
    });
    savePromiseRef.current = operation;
    try {
      return await operation;
    } finally {
      savePromiseRef.current = null;
    }
  }

  async function flush(): Promise<boolean> {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    const saved = await saveCurrent();
    if (!saved) return false;
    if (draftRef.current && savedRef.current && !same(draftRef.current, savedRef.current)) return flush();
    if (tab === "library") return await documentsRef.current?.flush() ?? true;
    if (tab === "skill") return await skillsRef.current?.flush() ?? true;
    if (tab === "apps") return await appsRef.current?.flush() ?? true;
    return true;
  }

  useImperativeHandle(ref, () => ({ flush }));

  async function changeTab(next: InspectorTab): Promise<boolean> {
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

  function closeInspector(): void {
    void flush().then(saved => { if (saved) onMobileClose(); });
  }

  function update<K extends keyof Draft>(field: K, value: Draft[K]): void {
    if (!draftRef.current) return;
    const next = { ...draftRef.current, [field]: value };
    draftRef.current = next;
    setDraft(next);
    setStatus("dirty");
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void saveCurrent();
    }, 400);
  }

  async function changeMember(operation: "add" | "remove", botId: string): Promise<void> {
    const current = detailRef.current;
    if (!current || memberPending || active) return;
    setMemberPending(true);
    onError(null);
    const input = { roomId: current.room.id, botId, expectedMembershipVersion: current.room.membershipVersion };
    const result = operation === "add" ? await window.aevorenBot.rooms.addMember(input) : await window.aevorenBot.rooms.removeMember(input);
    setMemberPending(false);
    if (!result.ok) {
      onError(result.error);
      return;
    }
    detailRef.current = result.data;
    setSelectedBotId("");
    onDetailUpdated(result.data);
  }

  if (!detail || !draft) return <aside id={id} className={`inspector inspector-empty${mobileOpen ? " mobile-open" : ""}`} aria-label="群聊设置">
    <button className="drawer-close-button dialog-close-button" type="button" aria-label="关闭群聊设置" title="关闭群聊设置" onClick={onMobileClose}><CloseIcon /></button>
    <span>选择群聊后，可在这里查看成员和协作设置。</span>
  </aside>;

  return (
    <aside ref={dialogRef} id={id} className={`inspector${mobileOpen ? " mobile-open" : ""}`} role="dialog" aria-modal="false" aria-label="群聊设置">
      <header className="inspector-header">
        <h2>群聊详情</h2>
        <div className="inspector-header-actions">
          <div className={`save-status status-${status}`} data-testid="room-save-status">
            {status === "saving" ? "保存中…" : null}
            {status === "dirty" ? "未保存" : null}
            {status === "failed" ? "保存失败" : null}
            {status === "idle" || status === "saved" ? <><CheckIcon />已保存</> : null}
          </div>
          <button className="drawer-close-button dialog-close-button" type="button" aria-label="关闭群聊设置" title="关闭群聊设置" onClick={closeInspector}><CloseIcon /></button>
        </div>
      </header>
      {error ? <div className="dialog-error" role="alert">{error.safeMessage}</div> : null}
      <div className="room-detail-identity"><RoomAvatar bots={detail.members.map(member => member.bot)} userProfile={userProfile} size={64} /><h3>{detail.room.name}</h3></div>
      <DetailsTabs idPrefix={`room-${detail.room.id}`} label="群聊配置" tabs={[
        { id: "details", label: "详情" }, { id: "library", label: "资料库" }, { id: "members", label: "成员" },
        { id: "skill", label: "Skill" }, { id: "environment", label: "高级工具" }, { id: "browser", label: "电脑工具" }, { id: "computer", label: "电脑" }, { id: "apps", label: "应用" },
      ]} primary={["details", "library", "members"]} value={tab} disabled={changingTab} onChange={next => changeTab(next as InspectorTab)} />
      <div id={`room-${detail.room.id}-details-panel`} role="tabpanel" aria-labelledby={`room-${detail.room.id}-details-tab`} hidden={tab !== "details"}>
      <ConversationWorkspace {...conversationWorkspace} />
      <section className="inspector-group inspector-profile-fields" aria-label="群聊资料">
      <label className="field inspector-primary-field">
        <span>群协调者</span>
        <select aria-label="群协调者" value={draft.leadBotId ?? ""} disabled={active || memberPending || status === "saving" || providers === null} onChange={(event) => update("leadBotId", event.target.value || null)} onBlur={() => void flush()}>
          <option value="">单人自动回复（不设协调者）</option>
          {draft.leadBotId && !eligibleLeads.some(bot => bot.id === draft.leadBotId)
            ? <option value={draft.leadBotId} disabled>{detail.members.find(member => member.botId === draft.leadBotId)?.bot.name ?? "原协调者"} · {providers === null ? "正在确认" : providerLoadFailed ? "能力未确认" : "当前不可用"}</option> : null}
          {eligibleLeads.map(bot => <option key={bot.id} value={bot.id}>{botIdentities.get(bot.id)?.inline ?? bot.name}</option>)}
        </select>
        <small>{draft.leadBotId
          ? providers !== null && !providerLoadFailed && !eligibleLeads.some(bot => bot.id === draft.leadBotId)
            ? "当前协调者不可用。请检查其模型配置，或选择单人自动回复；系统不会自行更换协调者。"
            : "协调者负责分工并汇总结果；明确 @成员时直接交给该成员。"
          : "每轮自动选一位 Bot 回复，不自动接力；也可 @ 指定或让全员分别回复。"}</small>
        {providers === null ? <small role="status">正在确认成员的协调能力…</small> : providerLoadFailed ? <small role="alert">协调能力未确认，请重新打开群聊设置后重试。</small> : eligibleLeads.length === 0 ? <small>配置支持协作的 API 联系人后，可设为固定协调者。</small> : null}
      </label>
      <button
        className="room-avatar-stack"
        type="button"
        aria-label={`管理群聊成员 ${detail.members.length}/6`}
        aria-expanded={tab === "members"}
        aria-controls={`room-members-${detail.room.id}`}
        onClick={() => void changeTab("members")}
      >
        {detail.members.slice(0, 3).map((member) => (
          <BotAvatarIcon key={member.botId} shape={member.bot.avatarShape} color={member.bot.avatarColor} size={60} title={member.bot.name} />
        ))}
        {detail.members.length > 3 ? <span className="room-avatar-count">+{detail.members.length - 3}</span> : null}
      </button>
      <label className="field inspector-primary-field">
        <span>名称</span>
        <input value={draft.name} maxLength={72} onChange={(event) => update("name", event.target.value)} onBlur={() => void flush()} />
      </label>
      <label className="field inspector-primary-field">
        <span>描述</span>
        <textarea value={draft.description} maxLength={2_000} rows={4} placeholder="说明这个群聊的协作目标" onChange={(event) => update("description", event.target.value)} onBlur={() => void flush()} />
      </label>
      </section>
      {status === "failed" ? <button className="secondary-button full-width" type="button" onClick={() => void flush()}>重试保存</button> : null}

      </div>
      <div id={`room-${detail.room.id}-members-panel`} role="tabpanel" aria-labelledby={`room-${detail.room.id}-members-tab`} hidden={tab !== "members"}>
      <section className="room-members-manager settings-list" id={`room-members-${detail.room.id}`} aria-label="群聊成员">
            <h3 className="inspector-section-title">成员</h3>
            {detail.members.map((member) => {
              const identity = botIdentities.get(member.botId)!;
              return <div className="room-member-row settings-list-row" key={member.botId}>
                <button className="member-main-link" type="button" title={identity.inline} onClick={() => { void flush().then(saved => { if (saved) onOpenBot(member.bot); }); }}>
                  <BotAvatarIcon shape={member.bot.avatarShape} color={member.bot.avatarColor} size={20} />
                  <span>{identity.inline}</span>
                </button>
                <button
                  className="text-button danger-button"
                  type="button"
                  disabled={active || memberPending || detail.members.length <= 2}
                  onClick={() => void changeMember("remove", member.botId)}
                >移除</button>
              </div>;
            })}
            {detail.members.length < 6 && availableBots.length > 0 ? (
              <div className="room-add-member">
                <select aria-label="选择要添加的 Bot" value={selectedBotId} onChange={(event) => setSelectedBotId(event.target.value)} disabled={active || memberPending}>
                  <option value="">选择 Bot…</option>
                  {availableBots.map((bot) => <option value={bot.id} key={bot.id}>{botIdentities.get(bot.id)!.inline}</option>)}
                </select>
                <button className="secondary-button" type="button" disabled={!selectedBotId || active || memberPending} onClick={() => void changeMember("add", selectedBotId)}>添加</button>
              </div>
            ) : null}
            {active ? <p className="room-lock-note">本批回复完成或取消后才能修改成员。</p> : null}
      </section>
      </div>
      <div id={`room-${detail.room.id}-library-panel`} role="tabpanel" aria-labelledby={`room-${detail.room.id}-library-tab`} hidden={tab !== "library"}>
        <LibraryPanel ref={documentsRef} sessionId={detail.session.id} kind="document" active={surfaceActive && tab === "library"} busy={!onUseResource} onUse={(reference, text) => onUseResource?.(reference, text)} />
        <MediaLibraryPanel key={detail.session.id} sessionId={detail.session.id} active={surfaceActive && mobileOpen && tab === "library"} busy={!onUseMedia} onUse={reference => onUseMedia?.(reference)} />
      </div>
      <div id={`room-${detail.room.id}-skill-panel`} role="tabpanel" aria-labelledby={`room-${detail.room.id}-skill-tab`} hidden={tab !== "skill"}>
        <label className="field environment-member-selector"><span>Skill 脚本执行成员</span><select aria-label="Skill 脚本执行成员" value={environmentMember?.botId ?? ""} onChange={event => setEnvironmentBotId(event.target.value)}>{detail.members.map(member => <option key={member.botId} value={member.botId}>{botIdentities.get(member.botId)?.inline ?? member.bot.name}</option>)}</select></label>
        <LibraryPanel ref={skillsRef} sessionId={detail.session.id} executorBotId={environmentMember?.botId} ownerName={`${detail.room.name} · ${environmentMember ? botIdentities.get(environmentMember.botId)?.inline ?? environmentMember.bot.name : "未选择成员"}`} kind="skill" active={surfaceActive && tab === "skill"} busy={!onUseResource} onUse={(reference, text) => onUseResource?.(reference, text)} onOpenExecution={execution => { if (execution.sessionId !== detail.session.id || execution.executorBotId !== environmentMember?.botId) return; setScriptExecution(execution); void changeTab("environment"); }} />
      </div>
      <div id={`room-${detail.room.id}-environment-panel`} role="tabpanel" aria-labelledby={`room-${detail.room.id}-environment-tab`} hidden={tab !== "environment"}>
        <label className="field environment-member-selector"><span>查看成员的执行环境</span><select aria-label="执行环境成员" value={environmentMember?.botId ?? ""} onChange={event => setEnvironmentBotId(event.target.value)}>{detail.members.map(member => <option key={member.botId} value={member.botId}>{botIdentities.get(member.botId)?.inline ?? member.bot.name}</option>)}</select></label>
        {environmentMember ? <EnvironmentPanel sessionId={detail.session.id} executorBotId={environmentMember.botId} ownerName={`${detail.room.name} · ${botIdentities.get(environmentMember.botId)?.inline ?? environmentMember.bot.name}`} active={surfaceActive && tab === "environment"} initialExecutionId={scriptExecution?.sessionId === detail.session.id && scriptExecution.executorBotId === environmentMember.botId ? scriptExecution.id : undefined} onOpenPreview={pageId => { setPreviewPageId(pageId); void changeTab("browser"); }} /> : <p className="library-empty">当前群聊没有可用成员。</p>}
      </div>
      <div id={`room-${detail.room.id}-apps-panel`} role="tabpanel" aria-labelledby={`room-${detail.room.id}-apps-tab`} hidden={tab !== "apps"}>
        <label className="field environment-member-selector"><span>应用执行成员</span><select aria-label="应用执行成员" value={environmentMember?.botId ?? ""} disabled={changingTab} onChange={event => { const botId = event.target.value; void appsRef.current?.flush().then(saved => { if (saved) setEnvironmentBotId(botId); }); }}>{detail.members.map(member => <option key={member.botId} value={member.botId}>{botIdentities.get(member.botId)?.inline ?? member.bot.name}</option>)}</select></label>
        {environmentMember ? <ConnectorPanel ref={appsRef} sessionId={detail.session.id} executorBotId={environmentMember.botId} ownerName={`${detail.room.name} · ${botIdentities.get(environmentMember.botId)?.inline ?? environmentMember.bot.name}`} active={surfaceActive && tab === "apps"} /> : <p className="library-empty">当前群聊没有可用成员。</p>}
        {environmentMember ? <McpToolPanel key={`mcp:${detail.session.id}:${environmentMember.botId}`} sessionId={detail.session.id} executorBotId={environmentMember.botId} ownerName={`${detail.room.name} · ${botIdentities.get(environmentMember.botId)?.inline ?? environmentMember.bot.name}`} active={surfaceActive && tab === "apps"} /> : null}
        {environmentMember ? <ScopedAppsApprovalHost key={`approvals:${detail.session.id}:${environmentMember.botId}`} sessionId={detail.session.id} executorBotId={environmentMember.botId} ownerName={`${detail.room.name} · ${botIdentities.get(environmentMember.botId)?.inline ?? environmentMember.bot.name}`} active={surfaceActive && tab === "apps"} /> : null}
      </div>
      {(["browser", "computer"] as const).map(mode => <div key={mode} id={`room-${detail.room.id}-${mode}-panel`} role="tabpanel" aria-labelledby={`room-${detail.room.id}-${mode}-tab`} hidden={tab !== mode}>
        <label className="field environment-member-selector"><span>查看成员的{mode === "browser" ? "浏览器" : "电脑"}</span><select aria-label={mode === "browser" ? "浏览器成员" : "电脑成员"} value={environmentMember?.botId ?? ""} onChange={event => setEnvironmentBotId(event.target.value)}>{detail.members.map(member => <option key={member.botId} value={member.botId}>{botIdentities.get(member.botId)?.inline ?? member.bot.name}</option>)}</select></label>
        {environmentMember ? <ComputerPanel sessionId={detail.session.id} executorBotId={environmentMember.botId} ownerName={`${detail.room.name} · ${botIdentities.get(environmentMember.botId)?.inline ?? environmentMember.bot.name}`} mode={mode} initialPageId={previewPageId} active={surfaceActive && tab === mode} /> : <p className="library-empty">当前群聊没有可用成员。</p>}
      </div>)}
    </aside>
  );
});
