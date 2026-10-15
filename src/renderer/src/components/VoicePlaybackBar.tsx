import { forwardRef, useEffect, useEffectEvent, useImperativeHandle, useRef, useState } from "react";
import type { TranscriptEntry } from "@shared/contracts";
import type { VoiceTask } from "@shared/voice-contracts";
import { voiceTextDigest, waitForVoiceTask } from "../voice-ui-state";
import "../styles/voice.css";

type QueueItem = { entry?: TranscriptEntry; task?: VoiceTask; label: string };
export type VoicePlaybackHandle = { enqueue(entry: TranscriptEntry): void; play(task: VoiceTask): void; stop(): void };
export const VoicePlaybackBar = forwardRef<VoicePlaybackHandle, { sessionId: string; active: boolean; entries: TranscriptEntry[]; speakerName(entry: TranscriptEntry): string }>(function VoicePlaybackBar({ sessionId, active, entries, speakerName }, ref) {
  const [autoRead, setAutoRead] = useState(false);
  const [count, setCount] = useState(0);
  const [label, setLabel] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queue = useRef<QueueItem[]>([]);
  const generation = useRef(0);
  const processing = useRef(false);
  const mounted = useRef(true);
  const currentItem = useRef<QueueItem | null>(null);
  const currentTask = useRef<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const audioUrl = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const playbackDone = useRef<(() => void) | null>(null);
  const seen = useRef(new Map<string, string>());
  function releaseAudio(): void { const element = audio.current; audio.current = null; if (element) { element.pause(); element.removeAttribute("src"); element.load(); } if (audioUrl.current) URL.revokeObjectURL(audioUrl.current); audioUrl.current = null; playbackDone.current?.(); playbackDone.current = null; }
  function stopResources(): void {
    generation.current += 1; controller.current?.abort(); controller.current = null; releaseAudio();
    const ids = [currentTask.current, ...queue.current.map(item => item.task?.id)].filter((id): id is string => Boolean(id));
    queue.current = []; currentTask.current = null; currentItem.current = null;
    for (const id of new Set(ids)) void window.aevorenBot.voice.stop({ sessionId, id });
  }
  function stop(): void { stopResources(); if (mounted.current) { setCount(0); setLabel(""); setBlocked(false); setAutoRead(false); } }
  async function process(): Promise<void> {
    if (processing.current) return;
    processing.current = true;
    const token = generation.current;
    try {
      while (queue.current.length && token === generation.current && mounted.current) {
        const item = queue.current.shift()!; currentItem.current = item; setLabel(item.label); setCount(queue.current.length + 1); setError(null);
        const aborter = new AbortController(); controller.current = aborter;
        try {
          let task = item.task;
          if (!task && item.entry) {
            const configurations = await window.aevorenBot.voice.configurations();
            if (!configurations.ok) throw new Error(configurations.error.safeMessage);
            const configuration = configurations.data.find(value => value.kind === "tts" && value.enabled && value.keyConfigured); if (!configuration) throw new Error("请先在设置 → 语音中配置独立 TTS。");
            const digest = await voiceTextDigest(item.entry.body);
            if (token !== generation.current) break;
            const result = await window.aevorenBot.voice.speak({ sessionId, clientNonce: crypto.randomUUID(), expectedConfigVersion: configuration.version, source: { entryId: item.entry.id, digest } });
            if (!result.ok) throw new Error(result.error.safeMessage);
            task = result.data;
          }
          if (!task) continue;
          if (token !== generation.current) { void window.aevorenBot.voice.stop({ sessionId, id: task.id }); break; }
          currentTask.current = task.id;
          await waitForVoiceTask(window.aevorenBot.voice, { sessionId, id: task.id }, aborter.signal);
          const result = await window.aevorenBot.voice.audio({ sessionId, id: task.id });
          if (!result.ok) throw new Error(result.error.safeMessage);
          if (token !== generation.current || !mounted.current) break;
          if (!["audio/wav", "audio/x-wav"].includes(result.data.reference.mimeType)) throw new Error("朗读返回了不支持的音频格式。");
          const binary = atob(result.data.dataBase64), bytes = new Uint8Array(binary.length); for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
          if (bytes.length !== result.data.reference.size) throw new Error("朗读音频内容不完整。");
          const url = URL.createObjectURL(new Blob([bytes], { type: result.data.reference.mimeType })); audioUrl.current = url;
          const element = new Audio(url); audio.current = element;
          await new Promise<void>((resolve, reject) => {
            playbackDone.current = resolve;
            element.onended = () => resolve(); element.onerror = () => reject(new Error("无法播放这段语音。"));
            void element.play().catch(failure => { if (token !== generation.current || !mounted.current) return; if (failure instanceof DOMException && failure.name === "NotAllowedError") setBlocked(true); else reject(failure); });
          });
        } catch (failure) { if (token === generation.current && mounted.current && !(failure instanceof DOMException && failure.name === "AbortError")) setError(failure instanceof Error ? failure.message : "朗读未完成。"); }
        finally { releaseAudio(); if (token === generation.current) { currentTask.current = null; currentItem.current = null; setBlocked(false); } }
      }
    } finally { processing.current = false; if (token === generation.current && mounted.current) { setCount(0); setLabel(""); } if (queue.current.length && mounted.current) void process(); }
  }
  function enqueue(item: QueueItem): void { queue.current.push(item); setCount(queue.current.length + (currentItem.current ? 1 : 0)); void process(); }
  useImperativeHandle(ref, () => ({ enqueue(entry) { if (active && entry.sessionId === sessionId && entry.role === "assistant" && entry.status === "completed" && entry.body.trim()) { seen.current.set(entry.id, entry.body); enqueue({ entry, label: speakerName(entry) }); } }, play(task) { if (active && task.sessionId === sessionId && task.kind === "speech") { const source = task.source, entry = source.kind === "entry" ? entries.find(entry => entry.id === source.entryId) : undefined; enqueue({ task, entry, label: entry ? speakerName(entry) : task.voice || "AI" }); } }, stop }));
  const completed = useEffectEvent((entry: TranscriptEntry): void => {
    if (entry.sessionId !== sessionId) return;
    const original = currentItem.current?.entry;
    if (original?.id === entry.id && (original.body !== entry.body || entry.status !== "completed")) stop();
    if (!autoRead || !active || entry.role !== "assistant" || entry.status !== "completed" || !entry.body.trim()) return;
    if (seen.current.get(entry.id) === entry.body) return;
    seen.current.set(entry.id, entry.body); enqueue({ entry, label: speakerName(entry) });
  });
  useEffect(() => window.aevorenBot.events.subscribeTranscript(event => completed(event.entry)), []);
  const roomChanged = useEffectEvent((event: { sessionId: string; batch: { state: string } }): void => {
    if (event.sessionId === sessionId && event.batch.state === "cancelled") stop();
  });
  useEffect(() => window.aevorenBot.events.subscribeRoomRuntime(event => roomChanged(event)), []);
  const stopCurrent = useEffectEvent(stopResources);
  useEffect(() => { if (!active) { stopCurrent(); queueMicrotask(() => { if (mounted.current) { setAutoRead(false); setCount(0); setLabel(""); setBlocked(false); } }); } }, [active]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stopCurrent(); }; }, []);
  async function resume(): Promise<void> { try { await audio.current?.play(); setBlocked(false); } catch { setError("浏览器仍未允许播放，请检查设备后再次点击。"); } }
  return <section className="voice-playback" aria-label="语音朗读"><label className="voice-checkbox"><input type="checkbox" checked={autoRead} disabled={!active} onChange={event => setAutoRead(event.target.checked)} />自动朗读本会话新回复</label>{count ? <div className="voice-actions"><span role="status">AI 合成语音 · {label} · 队列 {count}</span>{blocked ? <button className="secondary-button" type="button" onClick={() => void resume()}>播放语音</button> : null}<button className="text-button" type="button" onClick={stop}>停止朗读</button></div> : <span className="voice-note">AI 合成语音；不会自动重播历史回复。</span>}{error ? <p className="library-error" role="alert">{error}</p> : null}</section>;
});
