import { useCallback, useEffect, useState } from "react";
import type { AppError, Bot, Routine, RoutineRun, RoutineSchedule, Session } from "@shared/contracts";
import type { RoutineTarget, RoutineUpdatePatch } from "@shared/routine-contracts";
import { BellIcon, RefreshIcon, TrashIcon } from "./Icons";

type RoutinesSettingsPanelProps = { active: boolean };
type TargetChoice = {
  key: string;
  label: string;
  target: RoutineTarget;
  generation: number;
  membershipVersion: number | null;
  profileVersions: { botId: string; version: number }[];
  members: { id: string; name: string }[];
};
type TargetReview = Pick<TargetChoice, "target" | "generation" | "membershipVersion" | "profileVersions">;

const routineRunLabels: Record<RoutineRun["state"], string> = {
  queued: "待处理", waiting: "等待中", dispatching: "正在派发", running: "运行中", "cancel-requested": "正在取消",
  completed: "已完成", failed: "失败", cancelled: "已取消", missed: "错过执行时间", unknown: "结果未知",
};
const cancellableStates: RoutineRun["state"][] = ["queued", "waiting", "dispatching", "running"];

function scheduleLabel(schedule: RoutineSchedule): string {
  if (schedule.type === "once") return `一次 · ${new Date(schedule.at).toLocaleString("zh-CN")}`;
  if (schedule.type === "interval") return `每 ${schedule.everyMinutes} 分钟`;
  return `Cron · ${schedule.expression} · ${schedule.timeZone}`;
}
function targetKey(target: RoutineTarget): string { return target.kind === "bot" ? `bot:${target.botId}` : `room:${target.roomId}`; }
function targetBotIds(target: RoutineTarget): string[] { return target.kind === "bot" ? [target.botId] : target.targetBotIds; }
function targetChanged(review: TargetReview, current?: TargetChoice): boolean {
  return !current || review.target.sessionId !== current.target.sessionId || review.generation !== current.generation
    || review.membershipVersion !== current.membershipVersion || targetBotIds(review.target).some(id => !current.members.some(member => member.id === id))
    || review.profileVersions.some(profile => targetBotIds(review.target).includes(profile.botId) && !current.profileVersions.some(value => value.botId === profile.botId && value.version === profile.version));
}
function botChoice(bot: Bot, session: Session): TargetChoice {
  return { key: `bot:${bot.id}`, label: `Bot · ${bot.name}`, target: { kind: "bot", sessionId: session.id, botId: bot.id }, generation: session.generation, membershipVersion: null, profileVersions: [{ botId: bot.id, version: bot.version }], members: [{ id: bot.id, name: bot.name }] };
}
async function readChoice(key: string): Promise<{ choice: TargetChoice | null; error: AppError | null }> {
  const id = key.slice(key.indexOf(":") + 1);
  if (key.startsWith("bot:")) {
    const [bots, session] = await Promise.all([window.aevorenBot.bots.list(), window.aevorenBot.sessions.getMain(id)]);
    if (!bots.ok) return { choice: null, error: bots.error };
    if (!session.ok) return { choice: null, error: session.error };
    const bot = bots.data.find(value => value.id === id && value.hiddenAt === null);
    return { choice: bot && session.data.kind === "MAIN" ? botChoice(bot, session.data) : null, error: null };
  }
  const result = await window.aevorenBot.rooms.get(id);
  if (!result.ok) return { choice: null, error: result.error };
  const { room, session, members } = result.data;
  if (session.kind !== "MAIN" || room.archivedAt || room.hiddenAt) return { choice: null, error: null };
  return { choice: { key, label: `群聊 · ${room.name}`, target: { kind: "room", roomId: room.id, sessionId: session.id, routingMode: "everyone", targetBotIds: members.map(member => member.botId), expectedMembershipVersion: room.membershipVersion }, generation: session.generation, membershipVersion: room.membershipVersion, profileVersions: members.map(member => ({ botId: member.botId, version: member.bot.version })), members: members.map(member => ({ id: member.botId, name: member.bot.name })) }, error: null };
}
async function readPanel() {
  const [routines, runs, bots, rooms] = await Promise.all([window.aevorenBot.routines.list(), window.aevorenBot.routines.listRuns(), window.aevorenBot.bots.list(), window.aevorenBot.rooms.list()]);
  const choices = await Promise.all([
    ...(bots.ok ? bots.data.filter(bot => bot.hiddenAt === null).map(async bot => { const session = await window.aevorenBot.sessions.getMain(bot.id); return { choice: session.ok && session.data.kind === "MAIN" ? botChoice(bot, session.data) : null, error: session.ok ? null : session.error }; }) : []),
    ...(rooms.ok ? rooms.data.filter(room => !room.archivedAt && !room.hiddenAt).map(room => readChoice(`room:${room.id}`)) : []),
  ]);
  return { routines, runs, choices: choices.flatMap(value => value.choice ? [value.choice] : []), error: [routines, runs, bots, rooms].find(result => !result.ok)?.error ?? choices.find(value => value.error)?.error ?? null };
}

export function RoutineTargetFields({ choices, review, busy, requiresReselection = false, onSelect, onReviewChange, onReselect }: {
  choices: TargetChoice[]; review: TargetReview | null; busy: boolean; requiresReselection?: boolean;
  onSelect: (key: string) => void; onReviewChange: (review: TargetReview) => void; onReselect: () => void;
}): React.JSX.Element {
  const current = review ? choices.find(choice => choice.key === targetKey(review.target)) : undefined;
  const stale = requiresReselection || (review ? targetChanged(review, current) : false);
  const target = review?.target;
  return <>
    <label className="settings-field-row"><span><strong>执行目标</strong><small>仅 Bot / 群聊主会话</small></span><select aria-label="Routine 执行目标" disabled={busy} value={target ? targetKey(target) : ""} onChange={event => onSelect(event.target.value)}><option value="" disabled>选择主会话</option>{target && !current ? <option value={targetKey(target)}>已不可用的目标</option> : null}{choices.map(choice => <option key={choice.key} value={choice.key}>{choice.label}</option>)}</select></label>
    {target?.kind === "room" && review ? <fieldset className="mcp-tool-trust" disabled={busy || stale}><legend>固定执行成员</legend><label><span>路由</span><select aria-label="Routine 群聊路由" value={target.routingMode} onChange={event => onReviewChange({ ...review, target: { ...target, routingMode: event.target.value as "everyone" | "explicit", targetBotIds: current?.members.map(member => member.id) ?? target.targetBotIds } })}><option value="everyone">Everyone · 保存当前全部成员</option><option value="explicit">只运行勾选成员</option></select></label><p>保存固定名单；后来加入的成员不会自动执行。成员变更后需重新选择并保存。</p>{(current?.members ?? target.targetBotIds.map(id => ({ id, name: id }))).map(member => <label key={member.id}><input type="checkbox" aria-label={`Routine 成员 ${member.name}`} checked={target.targetBotIds.includes(member.id)} disabled={target.routingMode === "everyone"} onChange={() => onReviewChange({ ...review, target: { ...target, targetBotIds: target.targetBotIds.includes(member.id) ? target.targetBotIds.filter(id => id !== member.id) : [...target.targetBotIds, member.id] } })} /><span>{member.name}</span></label>)}<small>已审阅成员版本：v{review.membershipVersion}</small></fieldset> : null}
    {review ? <div className="settings-security-note"><p>主会话第 {review.generation} 代{review.membershipVersion === null ? "" : ` · 固定成员版本 v${review.membershipVersion}`}</p>{stale ? <p role="status">目标或成员资料已变化。请重新选择目标、核对成员，再保存；当前草稿已保留。</p> : null}<button className="secondary-button" type="button" disabled={busy} onClick={onReselect}>重新选择并审阅目标</button></div> : null}
  </>;
}

export function RoutineDefinitionCard({ routine, choices, busy, onEdit, onRun, onToggle, onRemove }: {
  routine: Routine; choices: TargetChoice[]; busy: boolean; onEdit: () => void; onRun: () => void; onToggle: () => void; onRemove: () => void;
}): React.JSX.Element {
  const current = choices.find(choice => choice.key === targetKey(routine.target));
  const stale = targetChanged(routine.targetSnapshot, current);
  const names = targetBotIds(routine.target).map(id => current?.members.find(member => member.id === id)?.name ?? id);
  return <article className="settings-card routine-card settings-list-row"><header><span><strong>{routine.name}</strong><small>{scheduleLabel(routine.schedule)} · 定义 v{routine.version}</small></span><span className={`capability-state ${routine.enabled ? "capability-state-granted" : ""}`}>{routine.enabled ? "已启用" : "已暂停"}</span></header><p>{routine.prompt}</p><small>目标：{current?.label ?? "已不可用的主会话"} · 保存时第 {routine.targetSnapshot.generation} 代</small><p>{routine.target.kind === "room" ? `固定名单（${routine.target.routingMode === "everyone" ? "Everyone" : "指定成员"}）：` : "执行成员："}{names.join("、")}{routine.targetSnapshot.membershipVersion === null ? "" : ` · 保存时成员版本 v${routine.targetSnapshot.membershipVersion}`}</p><small>固定资料 {routine.targetSnapshot.resourceRefs.length} 项 · 媒体 {routine.targetSnapshot.mediaRefs.length} 项 · 下次：{routine.nextRunAt ? new Date(routine.nextRunAt).toLocaleString("zh-CN") : "—"}</small>{stale ? <p role="status">目标或成员资料已变化，请编辑并重新选择目标后保存。</p> : null}<footer><button className="secondary-button" type="button" disabled={busy} onClick={onEdit}>编辑</button><button className="secondary-button" type="button" disabled={busy || stale} onClick={onRun}>立即运行</button><button className="secondary-button" type="button" disabled={busy || (!routine.enabled && stale)} onClick={onToggle}>{routine.enabled ? "暂停" : "启用"}</button><button className="icon-button danger" type="button" aria-label={`删除 Routine ${routine.name}`} disabled={busy} onClick={onRemove}><TrashIcon /></button></footer></article>;
}

export function RoutineRunItem({ run, busy, onCancel }: { run: RoutineRun; busy: boolean; onCancel: () => void }): React.JSX.Element {
  return <div className="settings-row"><span><strong>{run.routineName}</strong><small>{new Date(run.scheduledFor).toLocaleString("zh-CN")} · {run.trigger === "manual" ? "手动触发" : run.trigger === "event" ? "事件触发" : "计划触发"}</small>{run.state === "unknown" ? <small>结果未知，请先核验实际执行情况。</small> : null}{run.lastErrorCode ? <small>错误：{run.lastErrorCode}</small> : null}</span><span className={`settings-status settings-status-${run.state === "completed" ? "updated" : run.state === "failed" || run.state === "unknown" ? "error" : "idle"}`}>{routineRunLabels[run.state]}</span>{cancellableStates.includes(run.state) ? <button className="secondary-button" type="button" disabled={busy} aria-label={`取消 Routine 运行 ${run.routineName}`} onClick={onCancel}>取消本次运行</button> : null}</div>;
}

export function RoutinesSettingsPanel({ active }: RoutinesSettingsPanelProps): React.JSX.Element {
  const [routines, setRoutines] = useState<Routine[]>([]), [runs, setRuns] = useState<RoutineRun[]>([]);
  const [choices, setChoices] = useState<TargetChoice[]>([]), [review, setReview] = useState<TargetReview | null>(null);
  const [editing, setEditing] = useState<Routine | null>(null), [reselected, setReselected] = useState(false), [requiresReselection, setRequiresReselection] = useState(false);
  const [name, setName] = useState(""), [prompt, setPrompt] = useState("");
  const [scheduleType, setScheduleType] = useState<"once" | "interval" | "cron">("once");
  const [onceAt, setOnceAt] = useState(""), [intervalMinutes, setIntervalMinutes] = useState("60");
  const [cronExpression, setCronExpression] = useState("0 9 * * 1-5"), [timeZone, setTimeZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<AppError | null>(null), [notice, setNotice] = useState<string | null>(null);

  const applyPanel = useCallback((result: Awaited<ReturnType<typeof readPanel>>): void => {
    if (result.routines.ok) setRoutines(result.routines.data);
    if (result.runs.ok) setRuns(result.runs.data);
    setChoices(result.choices); setReview(current => current ?? result.choices[0] ?? null); setError(result.error);
  }, []);
  const load = async (): Promise<void> => { setBusy("load"); applyPanel(await readPanel()); setBusy(null); };
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void readPanel().then(result => { if (!cancelled) applyPanel(result); });
    return () => { cancelled = true; };
  }, [active, applyPanel]);

  const selectTarget = async (key: string, preserveSubset = false): Promise<void> => {
    setBusy("target"); setNotice(null);
    const result = await readChoice(key);
    if (result.error) setError(result.error);
    if (result.choice) {
      setChoices(current => [...current.filter(choice => choice.key !== key), result.choice!]);
      const choice = result.choice;
      const previousTarget = review?.target;
      setReview(preserveSubset && previousTarget?.kind === "room" && previousTarget.routingMode === "explicit" && choice.target.kind === "room"
        ? { ...choice, target: { ...choice.target, routingMode: "explicit", targetBotIds: previousTarget.targetBotIds.filter(id => choice.members.some(member => member.id === id)) } } : choice);
      setReselected(true); setRequiresReselection(false);
    } else { setRequiresReselection(true); setNotice("目标已不可用，请选择其他主会话。草稿已保留。"); }
    setBusy(null);
  };
  const reset = (): void => { setEditing(null); setName(""); setPrompt(""); setOnceAt(""); setReview(choices[0] ?? null); setReselected(false); setRequiresReselection(false); setNotice(null); };
  const edit = (routine: Routine): void => {
    setEditing(routine); setName(routine.name); setPrompt(routine.prompt); setReview(routine.targetSnapshot); setReselected(false); setRequiresReselection(false); setNotice(null); setError(null);
    const schedule = routine.schedule; setScheduleType(schedule.type);
    if (schedule.type === "once") { const date = new Date(schedule.at); setOnceAt(new Date(schedule.at - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)); }
    else if (schedule.type === "interval") setIntervalMinutes(String(schedule.everyMinutes));
    else { setCronExpression(schedule.expression); setTimeZone(schedule.timeZone); }
  };
  const save = async (): Promise<void> => {
    if (!review || requiresReselection) return;
    let schedule: RoutineSchedule;
    if (scheduleType === "once") { const at = Date.parse(onceAt); if (!Number.isFinite(at)) { setNotice("请选择有效的执行时间。"); return; } schedule = { type: "once", at }; }
    else if (scheduleType === "interval") schedule = { type: "interval", everyMinutes: Number(intervalMinutes), anchorAt: editing?.schedule.type === "interval" ? editing.schedule.anchorAt : Date.now() };
    else schedule = { type: "cron", expression: cronExpression, timeZone };
    setBusy("save"); setError(null); setNotice(null);
    const fresh = await readChoice(targetKey(review.target));
    if (fresh.error) { setError(fresh.error); setBusy(null); return; }
    if (fresh.choice) setChoices(current => [...current.filter(choice => choice.key !== fresh.choice!.key), fresh.choice!]);
    if (targetChanged(review, fresh.choice ?? undefined)) { setRequiresReselection(true); setNotice("目标已变化，请重新选择并审阅后保存。草稿已保留。"); setBusy(null); return; }
    const patch: RoutineUpdatePatch = { name, prompt, schedule };
    if (reselected) { patch.target = review.target; if (editing && editing.target.sessionId !== review.target.sessionId) { patch.resourceRefs = []; patch.mediaRefs = []; } }
    const result = editing ? await window.aevorenBot.routines.update({ id: editing.id, expectedVersion: editing.version, patch }) : await window.aevorenBot.routines.create({ name, prompt, target: review.target, schedule, enabled: false });
    setBusy(null);
    if (!result.ok) { setError(result.error); if (result.error.code === "ROUTINE_VERSION_CONFLICT") setNotice("此 Routine 已有新版本，请刷新列表后重新打开编辑。当前草稿已保留。"); if (["ROOM_MEMBERSHIP_CHANGED", "APPROVAL_SCOPE_INVALID"].includes(result.error.code)) { setRequiresReselection(true); setNotice("目标授权已变化，请重新选择并审阅目标后保存。草稿已保留。"); } return; }
    setRoutines(current => [...current.filter(item => item.id !== result.data.id), result.data]); reset();
  };
  const toggle = async (routine: Routine): Promise<void> => {
    setBusy(routine.id); setError(null);
    const result = await window.aevorenBot.routines.setEnabled({ id: routine.id, expectedVersion: routine.version, enabled: !routine.enabled });
    setBusy(null); if (result.ok) setRoutines(current => current.map(item => item.id === result.data.id ? result.data : item)); else setError(result.error);
  };
  const runNow = async (routine: Routine): Promise<void> => {
    setBusy(routine.id); setError(null);
    const result = await window.aevorenBot.routines.runNow({ id: routine.id, expectedVersion: routine.version });
    setBusy(null); if (result.ok) setRuns(current => [result.data, ...current.filter(run => run.id !== result.data.id)]); else setError(result.error);
  };
  const cancelRun = async (run: RoutineRun): Promise<void> => {
    setBusy(run.id); setError(null);
    const result = await window.aevorenBot.routines.cancelRun({ runId: run.id, expectedVersion: run.version });
    setBusy(null); if (result.ok) setRuns(current => current.map(item => item.id === result.data.id ? result.data : item)); else setError(result.error);
  };
  const remove = async (routine: Routine): Promise<void> => {
    if (!window.confirm(`删除 Routine“${routine.name}”？`)) return;
    setBusy(routine.id); setError(null);
    const result = await window.aevorenBot.routines.delete({ id: routine.id, expectedVersion: routine.version });
    setBusy(null); if (result.ok) { setRoutines(current => current.filter(item => item.id !== routine.id)); if (editing?.id === routine.id) reset(); } else setError(result.error);
  };
  const staleDraft = requiresReselection || (review ? targetChanged(review, choices.find(choice => choice.key === targetKey(review.target))) : true);
  return <div className="settings-panel-form routines-settings-panel">
    <div className="settings-section-heading capability-heading"><span><h2>主动服务</h2><p>创建一次性、周期或 Cron Routine，发送到 Bot 或群聊主会话。新任务默认暂停。</p></span><button className="secondary-button" type="button" onClick={() => void load()} disabled={busy !== null}><RefreshIcon />刷新</button></div>
    <div className="settings-card settings-form-group routine-editor"><h3>{editing ? `编辑 ${editing.name} · v${editing.version}` : "新建 Routine"}</h3>
      <label className="settings-field-row"><span><strong>名称</strong></span><input aria-label="Routine 名称" value={name} onChange={event => setName(event.target.value)} /></label>
      <label className="mcp-text-field"><span>任务提示</span><textarea aria-label="Routine 提示" rows={4} value={prompt} onChange={event => setPrompt(event.target.value)} /></label>
      <RoutineTargetFields choices={choices} review={review} busy={busy !== null} requiresReselection={requiresReselection} onSelect={key => void selectTarget(key)} onReviewChange={value => { setReview(value); setReselected(true); }} onReselect={() => { if (review) void selectTarget(targetKey(review.target), true); }} />
      {editing && review && editing.target.sessionId !== review.target.sessionId ? <p className="settings-security-note">更换主会话后会清空此 Routine 的固定资料与媒体引用。</p> : null}
      <label className="settings-field-row"><span><strong>计划类型</strong></span><select aria-label="Routine 计划类型" value={scheduleType} onChange={event => setScheduleType(event.target.value as typeof scheduleType)}><option value="once">一次</option><option value="interval">周期</option><option value="cron">Cron</option></select></label>
      {scheduleType === "once" ? <label className="settings-field-row"><span><strong>执行时间</strong></span><input aria-label="Routine 执行时间" type="datetime-local" value={onceAt} onChange={event => setOnceAt(event.target.value)} /></label> : null}
      {scheduleType === "interval" ? <label className="settings-field-row"><span><strong>间隔分钟</strong><small>5～43200</small></span><input aria-label="Routine 间隔分钟" type="number" min={5} max={43200} value={intervalMinutes} onChange={event => setIntervalMinutes(event.target.value)} /></label> : null}
      {scheduleType === "cron" ? <><label className="settings-field-row"><span><strong>Cron</strong><small>五段表达式</small></span><input aria-label="Routine Cron" value={cronExpression} onChange={event => setCronExpression(event.target.value)} /></label><label className="settings-field-row"><span><strong>时区</strong></span><input aria-label="Routine 时区" value={timeZone} onChange={event => setTimeZone(event.target.value)} /></label></> : null}
      <div className="settings-panel-actions">{editing ? <button className="secondary-button" type="button" disabled={busy !== null} onClick={reset}>取消编辑</button> : null}<button className="primary-button" type="button" disabled={busy !== null || !name.trim() || !prompt.trim() || staleDraft || !review || targetBotIds(review.target).length === 0} onClick={() => void save()}>{busy === "save" ? "保存中…" : editing ? "保存修改" : "创建为暂停状态"}</button></div>
    </div>
    <div className="routine-list settings-list">{routines.map(routine => <RoutineDefinitionCard key={routine.id} routine={routine} choices={choices} busy={busy !== null} onEdit={() => edit(routine)} onRun={() => void runNow(routine)} onToggle={() => void toggle(routine)} onRemove={() => void remove(routine)} />)}</div>
    <h3 className="capability-section-title">最近运行</h3><div className="settings-card settings-form-group routine-run-list">{runs.length === 0 ? <div className="workspace-empty">尚无运行记录。</div> : runs.slice(0, 20).map(run => <RoutineRunItem key={run.id} run={run} busy={busy !== null} onCancel={() => void cancelRun(run)} />)}</div>
    <p className="settings-security-note"><BellIcon /> 群聊按已保存名单并行运行；取消仅停止该次运行。工具审批不会自动放行。</p>
    {notice ? <div className="dialog-error" role="status">{notice}</div> : null}{error ? <div className="dialog-error" role="alert">{error.safeMessage}</div> : null}
  </div>;
}
