import { useCallback, useEffect, useRef, useState } from "react";
import type { AppError, Bot, ConversationSummary, Routine, Room } from "@shared/contracts";
import type { EventDelivery, EventSnapshot, EventSubscription, EventSubscriptionCreate, EventTokenReceipt } from "@shared/event-contracts";
import { BellIcon, RefreshIcon } from "./Icons";

const labels: Record<EventDelivery["state"], string> = { accepted: "已接收", dispatching: "正在派发", dispatched: "已交给 Routine", "cancel-requested": "正在取消", cancelled: "已取消", failed: "未派发", unknown: "结果未知" };
const emptySnapshot: EventSnapshot = { subscriptions: [], deliveries: [], listener: { listening: false, host: "127.0.0.1", port: null, revision: "", busy: false } };
function sourceName(source: EventSubscription["source"]): string { return source.kind === "webhook" ? "本机 Webhook" : `${source.kind === "runtime.completed" ? "任务完成" : "任务失败"} · ${source.sessionId}`; }
function sessionName(item: ConversationSummary, bots: Bot[], rooms: Room[]): string { return item.title ?? (item.botId ? bots.find(bot => bot.id === item.botId)?.name : rooms.find(room => room.id === item.roomId)?.name) ?? item.sessionId; }

export function AutomationEventReceipt({ delivery, busy, onCancel }: { delivery: EventDelivery; busy: boolean; onCancel(): void }): React.JSX.Element {
  return <article className="settings-card automation-event-card"><strong>{labels[delivery.state]}</strong><small>事件 {delivery.eventId} · 订阅 v{delivery.subscriptionVersion} · Routine v{delivery.routineVersion}</small><small>摘要 {delivery.payloadDigest}</small>{delivery.routineRunId ? <small>Routine 运行 {delivery.routineRunId}</small> : null}{delivery.errorCode ? <p role="status">{delivery.errorCode}</p> : null}{delivery.state === "unknown" ? <p>上次是否接收尚未确认。应用只核验原回执，不会自动重新派发。</p> : null}{["accepted", "dispatching", "dispatched"].includes(delivery.state) ? <button className="secondary-button" type="button" disabled={busy} onClick={onCancel}>取消所属运行</button> : null}</article>;
}

export function AutomationEventsPanel({ active }: { active: boolean }): React.JSX.Element {
  const [snapshot, setSnapshot] = useState(emptySnapshot), [routines, setRoutines] = useState<Routine[]>([]);
  const [sources, setSources] = useState<ConversationSummary[]>([]), [bots, setBots] = useState<Bot[]>([]), [rooms, setRooms] = useState<Room[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState<AppError | null>(null), [port, setPort] = useState("0");
  const [editing, setEditing] = useState<EventSubscription | null>(null), [name, setName] = useState("");
  const [sourceKind, setSourceKind] = useState<"webhook" | "runtime.completed" | "runtime.failed">("webhook"), [sourceSessionId, setSourceSessionId] = useState("");
  const [reviewed, setReviewed] = useState<Routine | null>(null), [enabled, setEnabled] = useState(false), [token, setToken] = useState<EventTokenReceipt | null>(null);
  const [confirm, setConfirm] = useState<{ action: "rotate" | "revoke"; hook: EventSubscription } | null>(null), request = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++request.current;
    const results = await Promise.all([window.aevorenBot.automationEvents.snapshot(), window.aevorenBot.routines.list(), window.aevorenBot.conversations.list(), window.aevorenBot.bots.list(), window.aevorenBot.rooms.list()]);
    if (current !== request.current) return;
    const [events, rules, chats, botList, roomList] = results;
    if (events.ok) setSnapshot(events.data); if (rules.ok) setRoutines(rules.data); if (chats.ok) setSources(chats.data); if (botList.ok) setBots(botList.data); if (roomList.ok) setRooms(roomList.data);
    const failed = results.find(result => !result.ok); if (failed && !failed.ok) setError(failed.error);
  }, []);
  useEffect(() => { if (!active) return; let stopped = false; void Promise.resolve().then(() => { if (!stopped) return refresh(); }); const off = window.aevorenBot.automationEvents.onChanged(() => { void refresh(); }); return () => { stopped = true; off(); }; }, [active, refresh]);
  async function action<T>(operation: () => Promise<import("@shared/contracts").ApiResult<T>>, accepted?: (value: T) => void): Promise<void> {
    setBusy(true); setError(null);
    try { const result = await operation(); if (result.ok) accepted?.(result.data); else setError(result.error); await refresh(); } finally { setBusy(false); }
  }
  function edit(hook: EventSubscription): void {
    setEditing(hook); setName(hook.name); setSourceKind(hook.source.kind); setSourceSessionId(hook.source.kind === "webhook" ? "" : hook.source.sessionId); setEnabled(hook.enabled);
    const saved = routines.find(routine => routine.id === hook.routineId);
    setReviewed(saved?.version === hook.routineVersion ? saved : null); setError(null);
  }
  const latestReview = reviewed ? routines.find(rule => rule.id === reviewed.id) : null;
  const staleReview = !reviewed || !latestReview?.enabled || latestReview.version !== reviewed.version;
  const staleEdit = editing ? snapshot.subscriptions.find(hook => hook.id === editing.id)?.version !== editing.version : false;
  function save(): void {
    if (!reviewed || staleReview || !name.trim() || sourceKind !== "webhook" && !sourceSessionId) return;
    const configuration: EventSubscriptionCreate = { name: name.trim(), source: sourceKind === "webhook" ? { kind: "webhook" } : { kind: sourceKind, sessionId: sourceSessionId }, routineId: reviewed.id, expectedRoutineVersion: reviewed.version, enabled };
    void action(() => editing ? window.aevorenBot.automationEvents.update({ id: editing.id, expectedVersion: editing.version, patch: configuration }) : window.aevorenBot.automationEvents.create(configuration), () => { setEditing(null); setName(""); setReviewed(null); setEnabled(false); });
  }
  return <div className="automation-events-panel">
    <header className="settings-panel-heading"><span><BellIcon /><h3>事件与 Webhook</h3></span><button className="icon-button" type="button" aria-label="刷新事件订阅" disabled={busy} onClick={() => { void refresh(); }}><RefreshIcon /></button></header>
    <p>事件只触发已经保存的 Bot 或群聊 MAIN Routine。载荷作为不可信 JSON 附件，不会变成用户指令、审批或工具权限。内部任务事件只传递 ID 和状态。</p>
    {error ? <p className="settings-error" role="alert">{error.safeMessage}</p> : null}
    <section className="settings-card"><h4>本机监听</h4><p role="status">{snapshot.listener.busy ? "正在变更监听状态…" : snapshot.listener.listening ? `正在监听 127.0.0.1:${snapshot.listener.port}` : "监听已停止 · 默认不启动"}</p><label className="settings-field-row"><span>端口（0 自动选择）</span><input aria-label="Webhook 监听端口" inputMode="numeric" value={port} disabled={busy || snapshot.listener.listening} onChange={event => setPort(event.target.value)} /></label><button className="secondary-button" type="button" disabled={busy || snapshot.listener.busy || !snapshot.listener.revision || !/^[0-9]+$/.test(port) || Number(port) > 65535} onClick={() => { void action(() => snapshot.listener.listening ? window.aevorenBot.automationEvents.stopListener({ expectedRevision: snapshot.listener.revision, port: snapshot.listener.port! }) : window.aevorenBot.automationEvents.startListener({ expectedRevision: snapshot.listener.revision, port: Number(port) })); }}>{snapshot.listener.listening ? "停止监听" : "启动本机监听"}</button><small>应用级监听，影响全部会话。只开放 127.0.0.1。应用重启后仍保持停止；停止监听不会撤销已交给 Routine 的任务。</small></section>
    {token ? <section className="settings-card" aria-label="一次性 Webhook 密钥"><h4>密钥仅显示这一次</h4><p>旧 URL 和旧密钥已经失效。请复制后关闭；应用不会再次展示或把它提供给 AI。</p><label>Bearer token<textarea readOnly value={token.token} aria-label="一次性 Bearer token" /></label><small>{snapshot.listener.listening ? `http://127.0.0.1:${snapshot.listener.port}${token.subscription.webhookPath}` : token.subscription.webhookPath}</small><button className="secondary-button" type="button" onClick={() => setToken(null)}>关闭密钥显示</button></section> : null}
    {confirm ? <section className="settings-card" aria-label="确认事件变更"><p>{confirm.action === "rotate" ? "更换密钥会使旧 URL 和密钥立即失效，并取消这项订阅已接收的活动运行。" : "撤销会暂停这项订阅、禁用密钥，并取消它的活动运行。"}目标：{confirm.hook.name} · Routine {confirm.hook.routineId} v{confirm.hook.routineVersion} · 会话 {confirm.hook.targetSnapshot.target.sessionId}</p><button className="secondary-button" type="button" disabled={busy} onClick={() => setConfirm(null)}>返回</button><button className="primary-button" type="button" disabled={busy} onClick={() => { const selected = confirm; setConfirm(null); if (selected.action === "rotate") void action(() => window.aevorenBot.automationEvents.rotateToken({ id: selected.hook.id, expectedVersion: selected.hook.version }), setToken); else void action(() => window.aevorenBot.automationEvents.revoke({ id: selected.hook.id, expectedVersion: selected.hook.version })); }}>确认{confirm.action === "rotate" ? "更换密钥" : "撤销"}</button></section> : null}
    <section className="settings-card"><h4>{editing ? "编辑事件订阅" : "新建事件订阅"}</h4>
      <label className="settings-field-row"><span>名称</span><input aria-label="事件订阅名称" value={name} maxLength={120} disabled={busy} onChange={event => setName(event.target.value)} /></label>
      <label className="settings-field-row"><span>来源</span><select aria-label="事件来源" value={sourceKind} disabled={busy} onChange={event => setSourceKind(event.target.value as typeof sourceKind)}><option value="webhook">本机 Webhook</option><option value="runtime.completed">任务完成 · 元数据</option><option value="runtime.failed">任务失败 · 元数据</option></select></label>
      {sourceKind !== "webhook" ? <label className="settings-field-row"><span>来源会话</span><select aria-label="事件来源会话" value={sourceSessionId} disabled={busy} onChange={event => setSourceSessionId(event.target.value)}><option value="">明确选择会话</option>{sourceSessionId && !sources.some(item => item.sessionId === sourceSessionId) ? <option value={sourceSessionId}>原来源会话已不可用</option> : null}{sources.map(item => <option key={item.sessionId} value={item.sessionId}>{item.kind === "TASK" ? "任务" : "主会话"} · {sessionName(item, bots, rooms)}</option>)}</select></label> : null}
      <label className="settings-field-row"><span>已保存的 Routine</span><select aria-label="事件目标 Routine" disabled={busy} value={reviewed?.id ?? ""} onChange={event => setReviewed(routines.find(rule => rule.id === event.target.value) ?? null)}><option value="">选择并审阅已启用的 Routine</option>{routines.map(rule => <option key={rule.id} value={rule.id} disabled={!rule.enabled}>{rule.name} · v{rule.version}{rule.enabled ? "" : "（已暂停）"}</option>)}</select></label>
      {reviewed ? <div className="settings-security-note"><strong>{reviewed.name} · Routine v{reviewed.version}</strong><p>{reviewed.prompt}</p><small>{reviewed.target.kind === "room" ? "群聊" : "Bot"} MAIN · 会话 {reviewed.target.sessionId} · 第 {reviewed.targetSnapshot.generation} 代</small>{reviewed.target.kind === "room" ? <small>固定成员 {reviewed.target.targetBotIds.join("、")} · v{reviewed.targetSnapshot.membershipVersion}</small> : null}<small>资料 {reviewed.targetSnapshot.resourceRefs.length} · 媒体 {reviewed.targetSnapshot.mediaRefs.length}</small></div> : null}
      {staleReview && reviewed ? <p role="status">Routine 已变化或暂停，当前编辑保留。请重新审阅后保存。</p> : null}
      {reviewed ? <button className="secondary-button" type="button" disabled={busy || !latestReview?.enabled} onClick={() => setReviewed(latestReview ?? null)}>重新审阅 Routine</button> : null}
      <label className="settings-toggle-row"><span>启用订阅</span><input type="checkbox" aria-label="启用事件订阅" checked={enabled} disabled={busy} onChange={event => setEnabled(event.target.checked)} /></label>
      {staleEdit ? <p role="status">订阅版本已变化，当前编辑未被覆盖。<button className="secondary-button" type="button" disabled={busy} onClick={() => { const current = snapshot.subscriptions.find(hook => hook.id === editing?.id); if (current) setEditing(current); }}>读取最新版本，保留编辑</button></p> : null}
      <button className="primary-button" type="button" disabled={busy || !name.trim() || staleReview || sourceKind !== "webhook" && !sourceSessionId} onClick={save}>保存事件订阅</button>{editing ? <button className="secondary-button" type="button" disabled={busy} onClick={() => { setEditing(null); setName(""); setReviewed(null); setEnabled(false); }}>取消编辑</button> : null}
    </section>
    <section aria-label="已保存事件订阅"><h4>已保存订阅</h4>{snapshot.subscriptions.length ? snapshot.subscriptions.map(hook => <article key={hook.id} className="settings-card automation-event-card"><strong>{hook.name} · v{hook.version} · {hook.enabled ? "已启用" : "已暂停"}</strong><small>{sourceName(hook.source)}</small><small>Routine {routines.find(rule => rule.id === hook.routineId)?.name ?? hook.routineId} v{hook.routineVersion} · 会话 {hook.targetSnapshot.target.sessionId}</small>{hook.source.kind === "webhook" ? <><small>{snapshot.listener.listening ? `http://127.0.0.1:${snapshot.listener.port}${hook.webhookPath}` : hook.webhookPath}</small><small>{hook.hasToken ? "密钥已配置，不再展示" : "尚未配置有效密钥"} · POST application/json · Bearer · Idempotency-Key</small></> : null}<footer><button className="secondary-button" type="button" disabled={busy} onClick={() => edit(hook)}>编辑订阅</button>{hook.enabled ? <button className="secondary-button" type="button" disabled={busy} onClick={() => { void action(() => window.aevorenBot.automationEvents.update({ id: hook.id, expectedVersion: hook.version, patch: { enabled: false } })); }}>暂停订阅</button> : null}{hook.source.kind === "webhook" ? <button className="secondary-button" type="button" disabled={busy} onClick={() => setConfirm({ action: "rotate", hook })}>更换密钥</button> : null}<button className="secondary-button" type="button" disabled={busy} onClick={() => setConfirm({ action: "revoke", hook })}>撤销订阅</button></footer></article>) : <p>尚无事件订阅。</p>}</section>
    <section aria-label="事件接收历史"><h4>接收回执</h4>{snapshot.deliveries.map(delivery => <AutomationEventReceipt key={delivery.id} delivery={delivery} busy={busy} onCancel={() => { void action(() => window.aevorenBot.automationEvents.cancel({ id: delivery.id, expectedVersion: delivery.version })); }} />)}{snapshot.deliveries.length === 0 ? <p>尚未接收事件。</p> : null}<small>仅展示元数据与摘要；“已交给 Routine”表示派发回执，执行结果请在主动服务的 Routine 历史中核验。</small></section>
  </div>;
}
