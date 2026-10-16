import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Microphone, Stop } from "@phosphor-icons/react";
import type { VoiceCaptureBegin, VoiceCaptureIntent, VoiceConfiguration, VoiceTask } from "@shared/voice-contracts";
import "../styles/voice.css";

const MAX_RECORDING_BYTES = 16 * 1_048_576;
function base64(blob: Blob): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1] ?? ""); reader.onerror = () => reject(new Error("无法读取录音")); reader.readAsDataURL(blob); }); }

export function VoiceCapturePanel({ sessionId, active, readDraft, onTask }: { sessionId: string; active: boolean; readDraft(): Promise<VoiceCaptureBegin>; onTask(task: VoiceTask): void }): React.JSX.Element {
  const [configuration, setConfiguration] = useState<VoiceConfiguration | null>(null);
  const [phase, setPhase] = useState<"idle" | "starting" | "recording" | "committing">("idle");
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const intentRef = useRef<VoiceCaptureIntent | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const committedRef = useRef(false);
  const durationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void window.aevorenBot.voice.configurations().then(result => { if (!cancelled && result.ok) setConfiguration(result.data.find(item => item.kind === "stt") ?? null); });
    return () => { cancelled = true; };
  }, [active]);
  function stopTracks(): void { if (durationTimer.current) clearTimeout(durationTimer.current); durationTimer.current = null; streamRef.current?.getTracks().forEach(track => track.stop()); streamRef.current = null; }
  function releaseCapture(): void {
    generationRef.current += 1;
    if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
    recorderRef.current = null; stopTracks();
    const intent = intentRef.current; intentRef.current = null;
    if (intent && !committedRef.current) void window.aevorenBot.voice.cancelCapture({ sessionId: intent.sessionId, captureId: intent.captureId });
  }
  function cancel(): void { releaseCapture(); if (mountedRef.current) setPhase("idle"); }
  const cancelCurrent = useEffectEvent(releaseCapture);
  useEffect(() => { if (!active) { cancelCurrent(); queueMicrotask(() => { if (mountedRef.current) setPhase("idle"); }); } }, [active]);
  useEffect(() => {
    mountedRef.current = true;
    const hidden = (): void => { if (document.visibilityState === "hidden") { cancelCurrent(); setPhase("idle"); } };
    document.addEventListener("visibilitychange", hidden);
    return () => { mountedRef.current = false; document.removeEventListener("visibilitychange", hidden); cancelCurrent(); };
  }, []);
  async function start(): Promise<void> {
    if (phase !== "idle" || !active || !configuration?.enabled || !configuration.keyConfigured) return;
    const generation = ++generationRef.current; committedRef.current = false; setPhase("starting"); setError(null);
    try {
      const origin = await readDraft();
      if (!mountedRef.current || generation !== generationRef.current) return;
      const prepared = await window.aevorenBot.voice.beginCapture(origin);
      if (!prepared.ok) throw new Error(prepared.error.safeMessage);
      if (!mountedRef.current || generation !== generationRef.current) { void window.aevorenBot.voice.cancelCapture({ sessionId, captureId: prepared.data.captureId }); return; }
      intentRef.current = prepared.data;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (!mountedRef.current || generation !== generationRef.current) { stream.getTracks().forEach(track => track.stop()); return; }
      streamRef.current = stream;
      const mimeType = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/wav"].find(type => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error("当前运行环境没有支持的录音格式。");
      const recorder = new MediaRecorder(stream, { mimeType }); recorderRef.current = recorder;
      const chunks: Blob[] = []; let size = 0;
      recorder.ondataavailable = event => {
        if (generation !== generationRef.current || !event.data.size) return;
        if (size + event.data.size > MAX_RECORDING_BYTES) { cancel(); setError("录音超过 16 MiB，已停止且未提交。"); return; }
        size += event.data.size; chunks.push(event.data);
      };
      recorder.onerror = () => { if (generation !== generationRef.current) return; cancel(); if (mountedRef.current) setError("录音失败，麦克风已关闭。"); };
      recorder.onstop = () => {
        stream.getTracks().forEach(track => track.stop());
        if (streamRef.current === stream) stopTracks();
        if (recorderRef.current === recorder) recorderRef.current = null;
        if (generation !== generationRef.current || !mountedRef.current) return;
        setPhase("committing");
        void (async () => {
          try {
            const blob = new Blob(chunks, { type: recorder.mimeType || mimeType }); chunks.length = 0;
            if (!blob.size || blob.size > MAX_RECORDING_BYTES) throw new Error("录音为空或超过本地上限。");
            const dataBase64 = await base64(blob);
            if (generation !== generationRef.current || !mountedRef.current) return;
            const { captureId, draftVersion, baseDigest } = prepared.data;
            const committed = await window.aevorenBot.voice.commitCapture({ sessionId, captureId, draftVersion, baseDigest, mimeType: blob.type, dataBase64 });
            if (!committed.ok) throw new Error(committed.error.safeMessage);
            committedRef.current = true; intentRef.current = null;
            if (generation !== generationRef.current || !mountedRef.current) return;
            const result = await window.aevorenBot.voice.transcribe({ sessionId, clientNonce: crypto.randomUUID(), expectedConfigVersion: configuration.version, media: committed.data, capture: { captureId, draftVersion, baseDigest } });
            if (!result.ok) throw new Error(result.error.safeMessage);
            if (generation === generationRef.current && mountedRef.current) onTask(result.data);
          } catch (failure) { if (generation === generationRef.current && mountedRef.current) { setError(failure instanceof Error ? failure.message : "录音转写未完成。"); const intent = intentRef.current; intentRef.current = null; if (intent) void window.aevorenBot.voice.cancelCapture({ sessionId, captureId: intent.captureId }); } }
          finally { if (generation === generationRef.current && mountedRef.current) setPhase("idle"); }
        })();
      };
      recorder.start(1000); setPhase("recording");
      durationTimer.current = setTimeout(() => { cancel(); if (mountedRef.current) setError("录音达到 120 秒上限，已停止且未提交。"); }, 120_000);
    } catch (failure) { if (generation === generationRef.current && mountedRef.current) { cancel(); setError(failure instanceof Error ? failure.message : "无法开始录音。"); } }
  }
  return <section className="voice-capture" aria-label="录音转写"><div className="voice-actions">{phase === "idle" ? <button className="text-button" type="button" disabled={!active || !configuration?.enabled || !configuration.keyConfigured} onClick={() => void start()}><Microphone />录音转写</button> : <><span role="status">{phase === "recording" ? "正在录音 · 仅麦克风" : phase === "starting" ? "正在请求麦克风…" : "正在保存录音…"}</span>{phase === "recording" ? <button className="text-button" type="button" onClick={() => { setPhase("committing"); recorderRef.current?.stop(); }}><Stop />停止录音并转写</button> : null}<button className="text-button" type="button" onClick={cancel}>取消录音</button></>}{!configuration?.enabled || !configuration.keyConfigured ? <span className="voice-note">请先在设置 → 语音中配置独立 STT。</span> : null}</div>{error ? <p className="library-error" role="alert">{error}</p> : null}</section>;
}
