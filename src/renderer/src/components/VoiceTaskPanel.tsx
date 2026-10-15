import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MediaItem } from "@shared/media-contracts";
import type { VoiceTask } from "@shared/voice-contracts";
import { mergeVoiceTask } from "../voice-ui-state";
import "../styles/voice.css";

const states: Record<VoiceTask["state"], string> = { prepared: "已准备", running: "处理中", completed: "已完成", failed: "失败", cancelled: "已停止", interrupted_unknown: "结果未知，未自动重试" };
export function VoiceTaskPanel({ sessionId, sessionGeneration, active = true, latestTask, onInsert, onPlay }: { sessionId: string; sessionGeneration: number; active?: boolean; latestTask: VoiceTask | null; onInsert(task: VoiceTask, useCurrentDraft: boolean, isCurrent: () => boolean): Promise<boolean>; onPlay(task: VoiceTask): void }): React.JSX.Element {
  const [tasks, setTasks] = useState<VoiceTask[]>([]);
  const [deltas, setDeltas] = useState<Record<string, string>>({});
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [selectedMedia, setSelectedMedia] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [inserted, setInserted] = useState<string[]>([]);
  const requestRef = useRef(0);
  const activeRef = useRef(active), interactionRef = useRef(0);
  useLayoutEffect(() => { activeRef.current = active; interactionRef.current += 1; requestRef.current += 1; }, [active]);
  const recordsRef = useRef(new Map<string, VoiceTask>());
  const revokedRef = useRef(new Set<string>());
  const accept = useCallback((task: VoiceTask, delta?: string): void => {
    const previous = recordsRef.current.get(task.id);
    if (task.sessionId !== sessionId || task.inputGeneration !== sessionGeneration || revokedRef.current.has(task.id) || (previous && previous.version > task.version)) return;
    recordsRef.current.set(task.id, task);
    setTasks(current => mergeVoiceTask(current, task));
    if (delta && task.state === "running") setDeltas(current => ({ ...current, [task.id]: `${current[task.id] ?? ""}${delta}` }));
    if (task.state !== "running" && task.state !== "prepared") setDeltas(current => { const next = { ...current }; delete next[task.id]; return next; });
  }, [sessionId, sessionGeneration]);
  const remove = useCallback((ids: string[]): void => {
    for (const id of ids) { revokedRef.current.add(id); recordsRef.current.delete(id); }
    setTasks(current => current.filter(task => !ids.includes(task.id)));
    setDeltas(current => { const next = { ...current }; for (const id of ids) delete next[id]; return next; });
  }, []);
  const load = useCallback(async (): Promise<void> => {
    if (!activeRef.current) return;
    const request = ++requestRef.current;
    try {
      const [listed, resources] = await Promise.all([window.aevorenBot.voice.list({ sessionId, limit: 100 }), window.aevorenBot.media.list({ sessionId })]);
      if (request !== requestRef.current) return;
      if (listed.ok) listed.data.forEach(task => accept(task)); else setError(listed.error.safeMessage);
      if (resources.ok) {
        const available = resources.data.filter(item => /^(audio|video)\//u.test(item.asset.reference.mimeType) && item.asset.enabled && !item.asset.deletedAt);
        setMedia(available); setSelectedMedia(current => available.some(item => item.asset.reference.id === current) ? current : "");
      }
    } catch { if (request === requestRef.current) setError("无法读取语音任务。"); }
  }, [sessionId, accept]);
  useEffect(() => { let cancelled = false; queueMicrotask(() => { if (!cancelled) { setPending(null); if (active) void load(); } }); return () => { cancelled = true; }; }, [active, load]);
  useEffect(() => {
    const unsubscribe = window.aevorenBot.voice.onChanged(event => accept(event.task, event.delta));
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) void load(); });
    return () => { cancelled = true; requestRef.current += 1; unsubscribe(); };
  }, [load, accept]);
  useEffect(() => { let cancelled = false; queueMicrotask(() => { if (!cancelled && latestTask?.sessionId === sessionId) { accept(latestTask); setExpanded(true); } }); return () => { cancelled = true; }; }, [sessionId, latestTask, accept]);
  useEffect(() => window.aevorenBot.media.onChanged(event => {
    if (event.sessionId !== sessionId && ["bound", "unbound"].includes(event.action)) return;
    requestRef.current += 1;
    if (["unbound", "enabled", "deleted", "restored"].includes(event.action)) remove([...recordsRef.current.values()].filter(task => task.source.kind === "media" && task.source.reference.mediaId === event.mediaId).map(task => task.id));
    void load();
  }), [sessionId, load, remove]);
  useEffect(() => window.aevorenBot.events.subscribeTranscript(event => {
    if (event.sessionId !== sessionId) return;
    const affected = [...recordsRef.current.values()].filter(task => task.source.kind === "entry" && task.source.entryId === event.entry.id);
    if (!affected.length) return;
    void Promise.all(affected.map(async task => {
      const result = await window.aevorenBot.voice.get({ sessionId, id: task.id });
      if (result.ok) accept(result.data); else remove([task.id]);
    }));
  }), [sessionId, accept, remove]);
  async function transcribe(): Promise<void> {
    const item = media.find(candidate => candidate.asset.reference.id === selectedMedia);
    if (!activeRef.current || !item || pending) return;
    const interaction = interactionRef.current;
    setPending("new"); setError(null);
    try {
      const configurations = await window.aevorenBot.voice.configurations(); if (!configurations.ok) throw new Error(configurations.error.safeMessage);
      const configuration = configurations.data.find(value => value.kind === "stt" && value.enabled && value.keyConfigured); if (!configuration) throw new Error("请先配置独立 STT。");
      if (!activeRef.current || interactionRef.current !== interaction) return;
      const result = await window.aevorenBot.voice.transcribe({ sessionId, clientNonce: crypto.randomUUID(), expectedConfigVersion: configuration.version, media: item.reference });
      if (!result.ok) throw new Error(result.error.safeMessage);
      if (activeRef.current && interactionRef.current === interaction) { accept(result.data); setExpanded(true); }
    } catch (failure) { if (activeRef.current && interactionRef.current === interaction) setError(failure instanceof Error ? failure.message : "转写未开始。"); }
    finally { if (interactionRef.current === interaction) setPending(null); }
  }
  async function insert(task: VoiceTask, fresh: boolean): Promise<void> {
    if (!activeRef.current) return;
    const interaction = interactionRef.current;
    setPending(task.id); setError(null);
    try {
      const inserted = await onInsert(task, fresh, () => activeRef.current && interactionRef.current === interaction && !revokedRef.current.has(task.id) && recordsRef.current.get(task.id)?.state === "completed");
      if (!activeRef.current || interactionRef.current !== interaction) return;
      if (inserted) { setInserted(current => [...current, task.id]); setConflicts(current => current.filter(id => id !== task.id)); }
      else setConflicts(current => [...new Set([...current, task.id])]);
    } catch (failure) {
      if (!activeRef.current || interactionRef.current !== interaction) return;
      try { const current = await window.aevorenBot.voice.get({ sessionId, id: task.id }); if (!current.ok) remove([task.id]); }
      catch { remove([task.id]); }
      setError(failure instanceof Error ? failure.message : "无法读取这份转写。");
    }
    finally { if (interactionRef.current === interaction) setPending(null); }
  }
  async function query(task: VoiceTask, stop: boolean): Promise<void> {
    if (!activeRef.current) return;
    const interaction = interactionRef.current;
    setPending(task.id); setError(null);
    try { const result = await (stop ? window.aevorenBot.voice.stop({ sessionId, id: task.id }) : window.aevorenBot.voice.get({ sessionId, id: task.id })); if (!activeRef.current || interactionRef.current !== interaction) return; if (result.ok) accept(result.data); else { remove([task.id]); setError(result.error.safeMessage); } }
    catch { if (activeRef.current && interactionRef.current === interaction) setError("语音任务操作未完成。"); }
    finally { if (interactionRef.current === interaction) setPending(null); }
  }
  return <section className="voice-task-panel" aria-label="语音任务"><button className="text-button" type="button" aria-expanded={expanded} onClick={() => setExpanded(current => !current)}>语音任务 · {tasks.length}</button>{expanded ? <><div className="voice-actions"><button className="text-button" type="button" onClick={() => void load()}>刷新语音任务</button><select aria-label="选择要转写的媒体" value={selectedMedia} onChange={event => setSelectedMedia(event.target.value)}><option value="">选择当前会话音视频</option>{media.map(item => <option key={item.asset.reference.id} value={item.asset.reference.id}>{item.asset.reference.name}</option>)}</select><button className="text-button" type="button" disabled={!selectedMedia || pending !== null} onClick={() => void transcribe()}>转写所选媒体</button></div>{error ? <p className="library-error" role="alert">{error}</p> : null}{tasks.map(task => <article className="voice-task" key={task.id} aria-label={`${task.kind === "speech" ? "朗读" : "转写"}任务 ${task.id}`}><div><strong>{task.kind === "speech" ? "AI 合成语音" : "转写文字"}</strong><span role="status">{states[task.state]}</span></div><p className="voice-note">{task.model}{task.kind === "speech" ? ` · ${task.voice}` : ""}</p>{task.transcript || deltas[task.id] ? <pre className="voice-transcript">{task.transcript ?? deltas[task.id]}</pre> : null}{conflicts.includes(task.id) ? <p role="status">录音后的草稿已变化。转写仍保留，未覆盖或发送。</p> : null}{inserted.includes(task.id) ? <p role="status">已插入草稿，尚未发送。</p> : null}<div className="voice-actions"><button className="text-button" type="button" disabled={pending !== null} onClick={() => void query(task, false)}>查询任务</button>{["prepared", "running"].includes(task.state) ? <button className="text-button" type="button" disabled={pending !== null} onClick={() => void query(task, true)}>停止此语音任务</button> : null}{task.kind === "transcription" && task.state === "completed" && task.transcript && !inserted.includes(task.id) ? <button className="text-button" type="button" disabled={pending !== null} onClick={() => void insert(task, conflicts.includes(task.id) || task.capture === null)}>{conflicts.includes(task.id) || task.capture === null ? "插入当前草稿" : "插入转写"}</button> : null}{task.kind === "speech" && task.state === "completed" && task.audio ? <button className="text-button" type="button" onClick={() => onPlay(task)}>加入朗读队列</button> : null}</div></article>)}</> : null}</section>;
}
