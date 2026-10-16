import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { RealtimeEvent, RealtimePlaybackAck, RealtimeSnapshot, RealtimeStartInput, RealtimeState } from "@shared/realtime-contracts";
import type { VoiceConfiguration } from "@shared/voice-contracts";
import { REALTIME_CAPTURE_MAX_DURATION_MS } from "@shared/realtime-channels";
import { pcmBase64, pcmBytes, RealtimeAudio } from "../realtime-audio";
import type { RenderedAudio } from "../realtime-pcm";
import "../styles/voice.css";

const labels: Record<RealtimeState, string> = { connecting: "正在连接", ready: "已就绪", listening: "正在接收录音", transcribing: "正在转写", responding: "正在语音回复", delegating: "正在委派业务任务", interrupting: "正在打断", stopped: "通话已停止", failed: "连接失败", interrupted_unknown: "连接中断，结果未知" };
const terminal = (state: RealtimeState): boolean => ["stopped", "failed", "interrupted_unknown"].includes(state);
type Identity = Omit<RealtimePlaybackAck, "playedSamples">;
type Props = { sessionId: string; sessionGeneration: number; active: boolean; executors: { id: string; name: string }[]; readSelection(executorBotId: string): Omit<RealtimeStartInput, "expectedConfigVersion">; onActiveChange(value: boolean): void };

export function RealtimeVoicePanel({ sessionId, sessionGeneration, active, executors, readSelection, onActiveChange }: Props): React.JSX.Element {
  const [configuration, setConfiguration] = useState<VoiceConfiguration | null>(null);
  const [snapshot, setSnapshot] = useState<RealtimeSnapshot | null>(null);
  const [executorId, setExecutorId] = useState(executors[0]?.id ?? "");
  const [pending, setPending] = useState(false), [recording, setRecording] = useState(false), [blocked, setBlocked] = useState(false);
  const [localStopped, setLocalStopped] = useState(true);
  const [outputPending, setOutputPending] = useState(false);
  const [hasAudio, setHasAudio] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audio = useRef<RealtimeAudio | null>(null), current = useRef<RealtimeSnapshot | null>(null);
  const lifetime = useRef(0), mounted = useRef(true), capturing = useRef(false);
  const nextSequence = useRef(0), acceptedSequence = useRef(-1), appendCount = useRef(0);
  const committedSequence = useRef(-1);
  const appending = useRef<Promise<void>>(Promise.resolve()), acknowledging = useRef<Promise<void>>(Promise.resolve());
  const identities = useRef(new Map<string, Identity>()), latestAudio = useRef<string | null>(null);
  const mutedEpoch = useRef(-1);
  const receivedAudio = useRef(new Map<string, number>()), renderedAudio = useRef(new Map<string, number>());
  const lease = useRef<ReturnType<typeof setTimeout> | null>(null);
  function release(): void {
    lifetime.current += 1; capturing.current = false; audio.current?.close(); audio.current = null;
    if (lease.current) clearTimeout(lease.current); lease.current = null;
    identities.current.clear(); latestAudio.current = null;
    receivedAudio.current.clear(); renderedAudio.current.clear();
  }
  function end(update = true): void {
    const owned = current.current?.session; release();
    if (owned && !terminal(owned.state)) void window.aevorenBot.voice.realtime.stop({ sessionId, id: owned.id }).then(result => { if (mounted.current && current.current?.session.id === owned.id) { if (result.ok) apply(result.data); else setError(result.error.safeMessage); } }).catch(() => { if (mounted.current && current.current?.session.id === owned.id) setError("本地音频已停止，连接状态尚未确认。"); });
    if (update && mounted.current) { setLocalStopped(true); setHasAudio(false); setOutputPending(false); setRecording(false); setPending(false); setBlocked(false); onActiveChange(false); }
  }
  function fail(failure: unknown): void { end(); if (mounted.current) setError(failure instanceof Error ? failure.message : "实时语音已停止，请手动重新连接。"); }
  function apply(value: RealtimeSnapshot): void {
    const item = value.session, previous = current.current?.session;
    if (!mounted.current || item.sessionId !== sessionId || item.inputGeneration !== sessionGeneration || previous && (previous.id !== item.id || previous.version > item.version)) return;
    current.current = value; setSnapshot(value);
    if (terminal(item.state)) { release(); setLocalStopped(true); setHasAudio(false); setRecording(false); setPending(false); onActiveChange(false); }
  }
  function report(played: RenderedAudio[]): void {
    const token = lifetime.current;
    for (const rendered of played) {
      const identity = identities.current.get(rendered.key); if (!identity) continue;
      if (rendered.playedSamples <= (renderedAudio.current.get(rendered.key) ?? 0)) continue;
      renderedAudio.current.set(rendered.key, rendered.playedSamples);
      acknowledging.current = acknowledging.current.then(async () => {
        if (token !== lifetime.current) return;
        const result = await window.aevorenBot.voice.realtime.playbackAck({ ...identity, playedSamples: rendered.playedSamples });
        if (!result.ok && token === lifetime.current) throw new Error(result.error.safeMessage);
      }).catch(failure => { if (token === lifetime.current) fail(failure); });
    }
    setOutputPending([...receivedAudio.current].some(([key, received]) => received > (renderedAudio.current.get(key) ?? 0)));
  }
  const changed = useEffectEvent((event: RealtimeEvent): void => {
    if (event.type === "snapshot") { if (event.snapshot.session.id === current.current?.session.id) apply(event.snapshot); return; }
    const owned = current.current?.session;
    if (!owned || terminal(owned.state) || event.sessionId !== sessionId || event.id !== owned.id || event.playbackEpoch !== owned.playbackEpoch || event.playbackEpoch <= mutedEpoch.current || !audio.current) return;
    try {
      const { playbackEpoch, responseId, itemId, contentIndex } = event;
      const key = JSON.stringify([playbackEpoch, responseId, itemId, contentIndex]);
      identities.current.set(key, { sessionId, id: owned.id, playbackEpoch, responseId, itemId, contentIndex }); latestAudio.current = key;
      const bytes = pcmBytes(event.dataBase64); receivedAudio.current.set(key, (receivedAudio.current.get(key) ?? 0) + bytes.length / 2); setHasAudio(true); setOutputPending(true);
      audio.current.append(key, bytes);
    } catch (failure) { fail(failure); }
  });
  useEffect(() => window.aevorenBot.voice.realtime.onChanged(event => changed(event)), []);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void window.aevorenBot.voice.configurations().then(result => { if (!cancelled && result.ok) setConfiguration(result.data.find(item => item.kind === "realtime") ?? null); });
    return () => { cancelled = true; };
  }, [active]);
  const stopCurrent = useEffectEvent(() => end(false));
  useEffect(() => {
    if (!active) { stopCurrent(); queueMicrotask(() => { if (mounted.current) { setLocalStopped(true); setRecording(false); setPending(false); onActiveChange(false); } }); }
  }, [active, onActiveChange]);
  useEffect(() => {
    mounted.current = true;
    const hidden = (): void => { if (document.visibilityState === "hidden") { stopCurrent(); setLocalStopped(true); setRecording(false); setPending(false); onActiveChange(false); } };
    document.addEventListener("visibilitychange", hidden);
    return () => { mounted.current = false; document.removeEventListener("visibilitychange", hidden); stopCurrent(); };
  }, [onActiveChange]);

  async function start(): Promise<void> {
    if (pending || !active || !executorId || !configuration?.enabled || !configuration.keyConfigured) return;
    release(); current.current = null; setSnapshot(null); nextSequence.current = 0; acceptedSequence.current = -1; committedSequence.current = -1; appendCount.current = 0; mutedEpoch.current = -1; appending.current = Promise.resolve(); acknowledging.current = Promise.resolve();
    const token = lifetime.current; setLocalStopped(false); setHasAudio(false); setOutputPending(false); setPending(true); setError(null); onActiveChange(true);
    try {
      const local = new RealtimeAudio({ capture(bytes) {
        if (token !== lifetime.current || !capturing.current) return;
        const owned = current.current?.session; if (!owned) return;
        if (++appendCount.current > 50) { fail(new Error("录音传输积压，通话已停止。")); return; }
        const sequence = nextSequence.current++; const dataBase64 = pcmBase64(bytes);
        appending.current = appending.current.then(async () => {
          if (token !== lifetime.current) return;
          const result = await window.aevorenBot.voice.realtime.append({ sessionId, id: owned.id, captureId: owned.captureId, sequence, dataBase64 });
          if (!result.ok) throw new Error(result.error.safeMessage); acceptedSequence.current = sequence;
        }).catch(failure => { if (token === lifetime.current) fail(failure); }).finally(() => { if (token === lifetime.current) appendCount.current -= 1; });
      }, played: values => { if (token === lifetime.current) report(values); }, blocked: value => { if (token === lifetime.current && mounted.current) setBlocked(value); }, error: failure => { if (token === lifetime.current) fail(failure); } });
      audio.current = local;
      const selection = readSelection(executorId);
      if (token !== lifetime.current) return;
      const result = await window.aevorenBot.voice.realtime.start({ ...selection, expectedConfigVersion: configuration.version });
      if (!result.ok) throw new Error(result.error.safeMessage);
      if (token !== lifetime.current || !mounted.current) { void window.aevorenBot.voice.realtime.stop({ sessionId, id: result.data.session.id }); return; }
      apply(result.data); await local.prepareMicrophone();
      if (token !== lifetime.current) return;
      const fresh = await window.aevorenBot.voice.realtime.snapshot({ sessionId, id: result.data.session.id }); if (!fresh.ok) throw new Error(fresh.error.safeMessage); apply(fresh.data);
      lease.current = setTimeout(() => fail(new Error("本次通话已达到 15 分钟，请手动重新连接。")), REALTIME_CAPTURE_MAX_DURATION_MS);
    } catch (failure) { if (token === lifetime.current) fail(failure); }
    finally { if (token === lifetime.current && mounted.current) setPending(false); }
  }
  async function record(): Promise<void> {
    if (!audio.current || pending || current.current?.session.state !== "ready") return;
    const token = lifetime.current; setPending(true); setError(null);
    try { await acknowledging.current; if (token !== lifetime.current) return; await audio.current.startMicrophone(); if (token === lifetime.current) { capturing.current = true; setRecording(true); } }
    catch (failure) { if (token === lifetime.current) fail(failure); }
    finally { if (token === lifetime.current && mounted.current) setPending(false); }
  }
  async function commit(): Promise<void> {
    const owned = current.current?.session; if (!owned || !audio.current || pending || !recording) return;
    const token = lifetime.current; setPending(true); setError(null);
    try {
      await audio.current.commit(); capturing.current = false; setRecording(false); await appending.current;
      if (token !== lifetime.current) return;
      if (acceptedSequence.current <= committedSequence.current) { setError("尚未收到录音，请开始说话后再提交。"); return; }
      const result = await window.aevorenBot.voice.realtime.commitTurn({ sessionId, id: owned.id, captureId: owned.captureId, lastSequence: acceptedSequence.current });
      if (!result.ok) throw new Error(result.error.safeMessage); if (token === lifetime.current) { committedSequence.current = acceptedSequence.current; apply(result.data); }
    } catch (failure) { if (token === lifetime.current) fail(failure); }
    finally { if (token === lifetime.current && mounted.current) setPending(false); }
  }
  async function interrupt(): Promise<void> {
    if (!audio.current || pending || !latestAudio.current) return;
    const token = lifetime.current; mutedEpoch.current = Math.max(current.current?.session.playbackEpoch ?? -1, identities.current.get(latestAudio.current)?.playbackEpoch ?? -1); setPending(true);
    try {
      const played = await audio.current.interrupt(); if (token !== lifetime.current) return;
      report(played); await acknowledging.current; if (token !== lifetime.current) return;
      const latest = played.at(-1), key = latest?.key ?? latestAudio.current, identity = key ? identities.current.get(key) : undefined; if (!identity) return;
      const result = await window.aevorenBot.voice.realtime.interrupt({ ...identity, playedSamples: latest?.playedSamples ?? 0 });
      if (!result.ok) throw new Error(result.error.safeMessage); identities.current.clear(); latestAudio.current = null; receivedAudio.current.clear(); renderedAudio.current.clear(); setHasAudio(false); setOutputPending(false); apply(result.data);
    } catch (failure) { if (token === lifetime.current) fail(failure); }
    finally { if (token === lifetime.current && mounted.current) setPending(false); }
  }
  async function stopTask(): Promise<void> {
    const owned = current.current?.session; if (!owned || pending) return; const token = lifetime.current; setPending(true);
    try { const result = await window.aevorenBot.voice.realtime.stopTask({ sessionId, id: owned.id }); if (token === lifetime.current) { if (result.ok) apply(result.data); else setError(result.error.safeMessage); } }
    catch { if (token === lifetime.current) setError("业务任务尚未确认停止，请在任务面板中检查。"); } finally { if (mounted.current && token === lifetime.current) setPending(false); }
  }
  const connected = snapshot && !localStopped && !terminal(snapshot.session.state);
  return <section className="realtime-voice-panel" aria-label="实时语音"><div className="voice-actions"><strong>实时语音</strong><span className="voice-note">AI 合成语音 · 手动分轮 · 最长 15 分钟；按开始说话才发送录音</span></div>{!connected ? <div className="voice-actions"><select aria-label="实时语音业务 Bot" value={executorId} disabled={pending} onChange={event => setExecutorId(event.target.value)}>{executors.map(executor => <option key={executor.id} value={executor.id}>{executor.name}</option>)}</select><button className="text-button" type="button" disabled={!active || pending || !configuration?.enabled || !configuration.keyConfigured || !executorId} onClick={() => void start()}>连接实时语音</button>{pending ? <button className="text-button" type="button" onClick={() => end()}>取消连接</button> : null}{!configuration?.enabled || !configuration.keyConfigured ? <span className="voice-note">请先在设置 → 语音中配置独立 Realtime。</span> : null}</div> : <div className="voice-actions"><span role="status">{recording ? "正在录音 · 仅麦克风" : labels[snapshot.session.state]}</span>{recording ? <button className="secondary-button" type="button" disabled={pending} onClick={() => void commit()}>结束本轮并提交</button> : <button className="secondary-button" type="button" disabled={pending || blocked || outputPending || snapshot.session.state !== "ready"} onClick={() => void record()}>开始说话</button>}<button className="text-button" type="button" disabled={pending || blocked || !hasAudio} onClick={() => void interrupt()}>打断语音</button><button className="text-button" type="button" onClick={() => end()}>停止语音通话</button></div>}{blocked && connected ? <button className="secondary-button" type="button" onClick={() => { void audio.current?.resume().catch(fail); }}>启用音频</button> : null}{snapshot?.session.linkedTask ? <div className="voice-actions"><span className="voice-note">已委派{snapshot.session.linkedTask.kind === "room" ? "群聊" : "Bot"}任务；停止通话后任务仍可继续。</span><button className="text-button" type="button" disabled={pending} onClick={() => void stopTask()}>停止已委派任务</button></div> : null}{snapshot?.turns.map(turn => <article className="voice-task" key={turn.id}><strong>语音第 {turn.index + 1} 轮</strong><span className="voice-note"> · {turn.state}</span>{turn.transcript ? <pre className="voice-transcript">{turn.transcript}</pre> : null}</article>)}{error ? <p className="library-error" role="alert">{error}</p> : null}{snapshot && terminal(snapshot.session.state) ? <p role="status">{labels[snapshot.session.state]}，不会自动重连。</p> : null}</section>;
}
