import { useEffect, useState } from "react";
import type { AppError, Bot, Routine, RoutineRun, RoutineSchedule } from "@shared/contracts";
import { BellIcon, RefreshIcon, TrashIcon } from "./Icons";

type RoutinesSettingsPanelProps = { active: boolean };

function scheduleLabel(schedule: RoutineSchedule): string {
  if (schedule.type === "once") return `一次 · ${new Date(schedule.at).toLocaleString("zh-CN")}`;
  if (schedule.type === "interval") return `每 ${schedule.everyMinutes} 分钟`;
  return `Cron · ${schedule.expression} · ${schedule.timeZone}`;
}

export function RoutinesSettingsPanel({ active }: RoutinesSettingsPanelProps): React.JSX.Element {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [runs, setRuns] = useState<RoutineRun[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [botId, setBotId] = useState("");
  const [scheduleType, setScheduleType] = useState<"once" | "interval" | "cron">("once");
  const [onceAt, setOnceAt] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState("60");
  const [cronExpression, setCronExpression] = useState("0 9 * * 1-5");
  const [timeZone, setTimeZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);

  const load = async (): Promise<void> => {
    setBusy("load");
    const [routineResult, runResult, botResult] = await Promise.all([
      window.aevorenBot.routines.list(), window.aevorenBot.routines.listRuns(), window.aevorenBot.bots.list(),
    ]);
    if (routineResult.ok) setRoutines(routineResult.data); else setError(routineResult.error);
    if (runResult.ok) setRuns(runResult.data); else setError(runResult.error);
    if (botResult.ok) {
      const visible = botResult.data.filter((bot) => bot.hiddenAt === null);
      setBots(visible);
      setBotId((current) => current || visible[0]?.id || "");
    } else setError(botResult.error);
    setBusy(null);
  };

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void Promise.all([window.aevorenBot.routines.list(), window.aevorenBot.routines.listRuns(), window.aevorenBot.bots.list()]).then(([routineResult, runResult, botResult]) => {
      if (cancelled) return;
      if (routineResult.ok) setRoutines(routineResult.data); else setError(routineResult.error);
      if (runResult.ok) setRuns(runResult.data); else setError(runResult.error);
      if (botResult.ok) {
        const visible = botResult.data.filter((bot) => bot.hiddenAt === null);
        setBots(visible);
        setBotId((current) => current || visible[0]?.id || "");
      } else setError(botResult.error);
    });
    return () => { cancelled = true; };
  }, [active]);

  const create = async (): Promise<void> => {
    let schedule: RoutineSchedule;
    if (scheduleType === "once") {
      const at = Date.parse(onceAt);
      if (!Number.isFinite(at)) return;
      schedule = { type: "once", at };
    } else if (scheduleType === "interval") {
      schedule = { type: "interval", everyMinutes: Number(intervalMinutes), anchorAt: Date.now() };
    } else schedule = { type: "cron", expression: cronExpression, timeZone };
    setBusy("create");
    setError(null);
    const result = await window.aevorenBot.routines.create({ name, prompt, botId, schedule, enabled: false });
    setBusy(null);
    if (!result.ok) { setError(result.error); return; }
    setRoutines((current) => [...current, result.data]);
    setName(""); setPrompt(""); setOnceAt("");
  };

  const toggle = async (routine: Routine): Promise<void> => {
    setBusy(routine.id);
    const result = await window.aevorenBot.routines.setEnabled({ id: routine.id, expectedVersion: routine.version, enabled: !routine.enabled });
    setBusy(null);
    if (result.ok) setRoutines((current) => current.map((item) => item.id === result.data.id ? result.data : item)); else setError(result.error);
  };

  const runNow = async (routine: Routine): Promise<void> => {
    setBusy(routine.id);
    const result = await window.aevorenBot.routines.runNow(routine.id);
    setBusy(null);
    if (result.ok) setRuns((current) => [result.data, ...current.filter((run) => run.id !== result.data.id)]); else setError(result.error);
  };

  const remove = async (routine: Routine): Promise<void> => {
    if (!window.confirm(`删除 Routine“${routine.name}”？`)) return;
    setBusy(routine.id);
    const result = await window.aevorenBot.routines.delete({ id: routine.id, expectedVersion: routine.version });
    setBusy(null);
    if (result.ok) setRoutines((current) => current.filter((item) => item.id !== routine.id)); else setError(result.error);
  };

  return <div className="settings-panel-form routines-settings-panel">
    <div className="settings-section-heading capability-heading"><span><h2>主动服务</h2><p>创建一次性、周期或 Cron Routine。新任务默认暂停；启用后关闭窗口仍会在后台等待触发。</p></span><button className="secondary-button" type="button" onClick={() => void load()} disabled={busy !== null}><RefreshIcon />刷新</button></div>
    <div className="settings-card routine-editor">
      <label className="settings-field-row"><span><strong>名称</strong></span><input aria-label="Routine 名称" value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label className="mcp-text-field"><span>任务提示</span><textarea aria-label="Routine 提示" rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
      <label className="settings-field-row"><span><strong>Bot</strong></span><select aria-label="Routine Bot" value={botId} onChange={(event) => setBotId(event.target.value)}>{bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>
      <label className="settings-field-row"><span><strong>计划类型</strong></span><select aria-label="Routine 计划类型" value={scheduleType} onChange={(event) => setScheduleType(event.target.value as typeof scheduleType)}><option value="once">一次</option><option value="interval">周期</option><option value="cron">Cron</option></select></label>
      {scheduleType === "once" ? <label className="settings-field-row"><span><strong>执行时间</strong></span><input aria-label="Routine 执行时间" type="datetime-local" value={onceAt} onChange={(event) => setOnceAt(event.target.value)} /></label> : null}
      {scheduleType === "interval" ? <label className="settings-field-row"><span><strong>间隔分钟</strong><small>5～43200</small></span><input aria-label="Routine 间隔分钟" type="number" min={5} max={43200} value={intervalMinutes} onChange={(event) => setIntervalMinutes(event.target.value)} /></label> : null}
      {scheduleType === "cron" ? <><label className="settings-field-row"><span><strong>Cron</strong><small>五段表达式</small></span><input aria-label="Routine Cron" value={cronExpression} onChange={(event) => setCronExpression(event.target.value)} /></label><label className="settings-field-row"><span><strong>时区</strong></span><input aria-label="Routine 时区" value={timeZone} onChange={(event) => setTimeZone(event.target.value)} /></label></> : null}
      <div className="settings-panel-actions"><button className="primary-button" type="button" disabled={busy !== null || !name.trim() || !prompt.trim() || !botId} onClick={() => void create()}>{busy === "create" ? "创建中…" : "创建为暂停状态"}</button></div>
    </div>
    <div className="routine-list">{routines.map((routine) => <article className="settings-card routine-card" key={routine.id}><header><span><strong>{routine.name}</strong><small>{scheduleLabel(routine.schedule)}</small></span><span className={`capability-state ${routine.enabled ? "capability-state-granted" : ""}`}>{routine.enabled ? "已启用" : "已暂停"}</span></header><p>{routine.prompt}</p><small>下次：{routine.nextRunAt ? new Date(routine.nextRunAt).toLocaleString("zh-CN") : "—"}</small><footer><button className="secondary-button" type="button" disabled={busy !== null} onClick={() => void runNow(routine)}>立即运行</button><button className="secondary-button" type="button" disabled={busy !== null} onClick={() => void toggle(routine)}>{routine.enabled ? "暂停" : "启用"}</button><button className="icon-button danger" type="button" aria-label={`删除 Routine ${routine.name}`} disabled={busy !== null} onClick={() => void remove(routine)}><TrashIcon /></button></footer></article>)}</div>
    <h3 className="capability-section-title">最近运行</h3>
    <div className="settings-card routine-run-list">{runs.length === 0 ? <div className="workspace-empty">尚无运行记录。</div> : runs.slice(0, 20).map((run) => <div className="settings-row" key={run.id}><span><strong>{run.routineName}</strong><small>{new Date(run.scheduledFor).toLocaleString("zh-CN")} · {run.trigger}</small></span><span className={`settings-status settings-status-${run.state === "completed" ? "updated" : run.state === "failed" ? "error" : "idle"}`}>{run.state}</span></div>)}</div>
    <p className="settings-security-note"><BellIcon /> 后台 Routine 遇到工具审批时会暂停并通知，不会自动放行。</p>
    {error ? <div className="dialog-error" role="alert">{error.safeMessage}</div> : null}
  </div>;
}
