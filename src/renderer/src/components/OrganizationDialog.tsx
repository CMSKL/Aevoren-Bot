import { useEffect, useMemo, useRef, useState } from "react";
import type { ApiResult, Bot, ConversationSummary, Room } from "@shared/contracts";
import type { OrganizationPreferences, OrganizationSnapshot } from "@shared/organization-contracts";
import { groupSidebarConversations, organizationPreferencesPatch, rebaseOrganizationPreferences, rebaseSectionNames } from "../organization-state";
import { CloseIcon } from "./Icons";
import "../styles/organization.css";

type Props = { snapshot: OrganizationSnapshot; bots: Bot[]; rooms: Room[]; conversations: ConversationSummary[]; onAccepted(snapshot: OrganizationSnapshot): void; onClose(): void };
const notificationLabels = { approvals: "审批请求", taskCompletion: "任务完成", taskFailure: "任务失败", routines: "主动服务" } as const;

export function OrganizationDialog({ snapshot, bots, rooms, conversations, onAccepted, onClose }: Props): React.JSX.Element {
  const [base, setBase] = useState(snapshot);
  const [names, setNames] = useState<Record<string, string>>(() => Object.fromEntries(snapshot.sections.map(section => [section.id, section.name])));
  const [preferences, setPreferences] = useState<OrganizationPreferences>(() => structuredClone(snapshot.preferences));
  const [moves, setMoves] = useState<Record<string, string | null>>(() => Object.fromEntries(snapshot.assignments.map(item => [item.sessionId, item.sectionId])));
  const [newName, setNewName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null), firstRef = useRef<HTMLInputElement>(null), mounted = useRef(true);
  const grouped = useMemo(() => groupSidebarConversations(conversations, base), [conversations, base]);
  const labels = useMemo(() => new Map(conversations.map(item => [item.sessionId, item.kind === "TASK" ? `任务：${item.title ?? "未命名任务"}` : bots.find(bot => bot.id === item.botId)?.name ?? rooms.find(room => room.id === item.roomId)?.name ?? "聊天"])), [conversations, bots, rooms]);
  const preferencePatch = organizationPreferencesPatch(base.preferences, preferences);
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    firstRef.current?.focus();
    return () => { mounted.current = false; if (previous?.isConnected) previous.focus(); };
  }, []);

  function accept(next: OrganizationSnapshot): void {
    setNames(current => rebaseSectionNames(base.sections, current, next.sections));
    setPreferences(current => rebaseOrganizationPreferences(base.preferences, current, next.preferences));
    const oldMoves = new Map(base.assignments.map(item => [item.sessionId, item.sectionId])), latestMoves = new Map(next.assignments.map(item => [item.sessionId, item.sectionId]));
    setMoves(current => Object.fromEntries(conversations.map(item => [item.sessionId, current[item.sessionId] === undefined || current[item.sessionId] === (oldMoves.get(item.sessionId) ?? null) ? latestMoves.get(item.sessionId) ?? null : current[item.sessionId]!] )));
    setBase(next); onAccepted(next); setError(null);
  }
  async function mutate(action: (version: number) => Promise<ApiResult<OrganizationSnapshot>>, after?: () => void): Promise<void> {
    if (busy) return;
    setBusy(true); setError(null);
    try { const result = await action(base.version); if (!mounted.current) return; if (!result.ok) { setError(`${result.error.safeMessage} 当前编辑已保留，请读取最新版本后重试。`); return; } accept(result.data); after?.(); }
    catch { if (mounted.current) setError("暂时无法保存，当前编辑已保留。请读取最新版本后核对。"); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function refresh(): Promise<void> { if (busy) return; setBusy(true); try { const result = await window.aevorenBot.organization.snapshot(); if (mounted.current) { if (result.ok) accept(result.data); else setError(result.error.safeMessage); } } catch { if (mounted.current) setError("暂时无法读取最新版本，当前编辑仍保留。"); } finally { if (mounted.current) setBusy(false); } }
  function reorder(index: number, direction: -1 | 1): void {
    const ids = base.sections.map(section => section.id), target = index + direction;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    void mutate(expectedVersion => window.aevorenBot.organization.reorderSections({ expectedVersion, sectionIds: ids }));
  }
  function conversationRow(item: ConversationSummary, index: number, group: readonly ConversationSummary[], sectionId: string | null): React.JSX.Element {
    const target = moves[item.sessionId] ?? null, label = labels.get(item.sessionId)!;
    return <div className="organization-chat-row" key={item.sessionId}>
      <div className="organization-chat-label"><strong>{label}</strong><small>{item.kind === "TASK" ? "独立任务线程" : "主会话"}{item.hiddenAt ? " · 已移除" : ""}</small></div>
      <label><span className="sr-only">移动聊天 {label}</span><select aria-label={`移动聊天 ${label}`} disabled={busy} value={target ?? ""} onChange={event => setMoves(current => ({ ...current, [item.sessionId]: event.target.value || null }))}><option value="">未分组</option>{target && !base.sections.some(section => section.id === target) ? <option value={target} disabled>原分区已删除（选择保留）</option> : null}{base.sections.map(section => <option key={section.id} value={section.id}>{section.name}</option>)}</select></label>
      <button type="button" className="secondary-button" disabled={busy || target === sectionId} onClick={() => void mutate(expectedVersion => window.aevorenBot.organization.moveSession({ expectedVersion, sessionId: item.sessionId, sectionId: target }))}>保存归属</button>
      {sectionId ? <div className="organization-order"><button type="button" className="secondary-button" aria-label={`上移聊天 ${label}`} disabled={busy || index === 0 || target !== sectionId} onClick={() => void mutate(expectedVersion => window.aevorenBot.organization.moveSession({ expectedVersion, sessionId: item.sessionId, sectionId, position: index - 1 }))}>↑</button><button type="button" className="secondary-button" aria-label={`下移聊天 ${label}`} disabled={busy || index === group.length - 1 || target !== sectionId} onClick={() => void mutate(expectedVersion => window.aevorenBot.organization.moveSession({ expectedVersion, sessionId: item.sessionId, sectionId, position: index + 1 }))}>↓</button></div> : null}
    </div>;
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={dialogRef} className="settings-dialog organization-dialog" role="dialog" aria-modal="true" aria-labelledby="organization-dialog-title" onKeyDown={event => {
      if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); }
      if (event.key !== "Tab") return;
      const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), summary") ?? [])].filter(item => item.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <header><div><h2 id="organization-dialog-title">聊天整理与通知</h2><p>分区只整理列表，不会共享聊天内容、资料或权限。</p></div><button type="button" className="icon-button" aria-label="关闭聊天整理" disabled={busy} onClick={onClose}><CloseIcon /></button></header>
      <div className="organization-scroll">
        {snapshot.version > base.version ? <div className="organization-version-notice" role="status">设置在别处发生修改，当前编辑已保留。<button type="button" className="text-button" disabled={busy} onClick={() => void refresh()}>读取最新版本，保留编辑</button></div> : null}
        {error ? <p role="alert" className="dialog-error">{error}<button type="button" className="text-button" disabled={busy} onClick={() => void refresh()}>读取最新版本，保留编辑</button></p> : null}
        <h3>聊天分区</h3><div className="organization-create"><input ref={firstRef} aria-label="新分区名称" placeholder="新分区名称" maxLength={80} value={newName} disabled={busy} onChange={event => setNewName(event.target.value)} /><button className="primary-button" type="button" disabled={busy || !newName.trim()} onClick={() => void mutate(expectedVersion => window.aevorenBot.organization.createSection({ expectedVersion, name: newName.trim() }), () => setNewName(""))}>创建分区</button></div>
        {base.sections.map((section, index) => <div className="organization-section-editor" key={section.id}><label><span className="sr-only">分区名称 {section.name}</span><input aria-label={`分区名称 ${section.name}`} value={names[section.id] ?? section.name} maxLength={80} disabled={busy} onChange={event => setNames(current => ({ ...current, [section.id]: event.target.value }))} /></label><button type="button" className="secondary-button" aria-label={`保存分区 ${section.name}`} disabled={busy || !(names[section.id] ?? "").trim() || names[section.id] === section.name} onClick={() => void mutate(expectedVersion => window.aevorenBot.organization.renameSection({ expectedVersion, id: section.id, name: names[section.id]!.trim() }))}>保存名称</button><button type="button" className="secondary-button" aria-label={`上移分区 ${section.name}`} disabled={busy || index === 0} onClick={() => reorder(index, -1)}>↑</button><button type="button" className="secondary-button" aria-label={`下移分区 ${section.name}`} disabled={busy || index === base.sections.length - 1} onClick={() => reorder(index, 1)}>↓</button><button type="button" className="text-button danger-text-button" aria-label={`删除分区 ${section.name}`} disabled={busy} onClick={() => setDeleteTarget(section.id)}>删除</button>
          {deleteTarget === section.id ? <div className="organization-delete-confirmation" role="alert"><p>删除此分区？区内聊天回到未分组，聊天和权限保留。</p><button type="button" className="secondary-button" disabled={busy} onClick={() => setDeleteTarget(null)}>返回</button><button type="button" className="danger-button" disabled={busy} onClick={() => void mutate(expectedVersion => window.aevorenBot.organization.deleteSection({ expectedVersion, id: section.id }), () => setDeleteTarget(null))}>确认删除分区</button></div> : null}
        </div>)}
        {Object.entries(names).filter(([id]) => !base.sections.some(section => section.id === id)).map(([id, name]) => <label className="field organization-orphaned-draft" key={id}><span>已删除分区的名称草稿（可复制后新建）</span><input aria-label="已删除分区的名称草稿" readOnly value={name} /></label>)}
        <h3>聊天归属</h3>
        {grouped.sections.map(({ section, items }) => <section className="organization-chat-group" key={section.id} aria-label={`整理分区 ${section.name}`}><h4>{section.name}</h4>{items.map((item, index) => conversationRow(item, index, items, section.id))}{items.length === 0 ? <p>此分区还没有聊天。</p> : null}</section>)}
        <section className="organization-chat-group" aria-label="整理未分组"><h4>未分组</h4>{grouped.unassigned.map((item, index) => conversationRow(item, index, grouped.unassigned, null))}</section>
        <h3>默认助理与通知</h3><label className="field"><span>默认助理</span><select aria-label="默认助理" value={preferences.defaultAssistantBotId ?? ""} disabled={busy} onChange={event => setPreferences(current => ({ ...current, defaultAssistantBotId: event.target.value || null }))}><option value="">不指定</option>{preferences.defaultAssistantBotId && !bots.some(bot => bot.id === preferences.defaultAssistantBotId) ? <option value={preferences.defaultAssistantBotId} disabled>原助理已不可用（选择保留）</option> : null}{bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select><small>仅在启动时没有可恢复的当前聊天时打开；不会替换已选聊天或改变权限。</small></label>
        {Object.entries(notificationLabels).map(([key, label]) => <label className="organization-notification" key={key}><input type="checkbox" checked={preferences.notifications[key as keyof typeof notificationLabels]} disabled={busy} onChange={event => setPreferences(current => ({ ...current, notifications: { ...current.notifications, [key]: event.target.checked } }))} />{label}通知</label>)}
        <label className="organization-notification"><input type="checkbox" checked={preferences.sound} disabled={busy} onChange={event => setPreferences(current => ({ ...current, sound: event.target.checked }))} />通知声音</label><p className="organization-note">实际通知仍遵循系统权限与当前应用状态。</p>
        <button type="button" className="primary-button" disabled={busy || Object.keys(preferencePatch).length === 0} onClick={() => void mutate(expectedVersion => window.aevorenBot.organization.savePreferences({ expectedVersion, patch: preferencePatch }))}>保存偏好</button>
      </div><footer><span className="organization-note">版本 {base.version}</span><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>完成</button></footer>
    </section>
  </div>;
}
