import { useEffect, useState } from "react";
import type { VoiceConfiguration, VoiceConfigurationKind } from "@shared/voice-contracts";
import "../styles/voice.css";

const labels: Record<VoiceConfigurationKind, string> = { stt: "转写 STT", tts: "朗读 TTS", realtime: "实时语音 Realtime" };

function ConfigurationCard({ configuration, onSaved }: { configuration: VoiceConfiguration; onSaved(value: VoiceConfiguration): void }): React.JSX.Element {
  const [model, setModel] = useState(configuration.model);
  const [voice, setVoice] = useState(configuration.voice);
  const [enabled, setEnabled] = useState(configuration.enabled);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(): Promise<void> {
    if (pending) return;
    setPending(true); setError(null);
    try {
      const result = await window.aevorenBot.voice.saveConfiguration({ kind: configuration.kind, expectedVersion: configuration.version, model, voice, enabled,
        ...(clearKey ? { clearApiKey: true } : apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
      if (!result.ok) { setError(result.error.safeMessage); return; }
      setApiKey(""); onSaved(result.data);
    } catch { setError("语音配置未保存，请重试。"); }
    finally { setPending(false); }
  }
  return <section className="settings-card voice-configuration" aria-label={`${labels[configuration.kind]} 配置`}>
    <h3>{labels[configuration.kind]}</h3><p>OpenAI · 独立配置，不使用 Bot 的模型密钥。</p>
    {configuration.kind === "tts" ? <p className="voice-note">当前使用 Speech 接口。相关旧模型、2025 快照与 tts-1 系列计划于 2027-01-06 移除；请核对所填模型。系统不会把 Realtime 替代模型自动改用于 Speech。</p> : configuration.kind === "realtime" ? <p className="voice-note">Realtime V1 · 手动分轮。请在聊天中点击连接；业务操作交给所选 Bot，停止通话和停止任务分别控制。</p> : <p className="voice-note">转写返回待插入文字，不会自动发送消息。模型名称可明确编辑。</p>}
    <label className="field"><span>模型</span><input aria-label={`${labels[configuration.kind]} 模型`} value={model} maxLength={100} disabled={pending} onChange={event => setModel(event.target.value)} /></label>
    {configuration.kind !== "stt" ? <label className="field"><span>音色</span><input aria-label={`${labels[configuration.kind]} 音色`} value={voice} maxLength={100} disabled={pending} onChange={event => setVoice(event.target.value)} /></label> : null}
    <label className="field"><span>独立 API Key · {configuration.keyConfigured ? "已安全保存，留空不替换" : "尚未配置"}</span><input type="password" autoComplete="off" aria-label={`${labels[configuration.kind]} API Key`} value={apiKey} maxLength={1024} disabled={pending || clearKey} onChange={event => setApiKey(event.target.value)} /></label>
    <label className="voice-checkbox"><input type="checkbox" checked={enabled} disabled={pending} onChange={event => setEnabled(event.target.checked)} />启用此配置</label>
    <label className="voice-checkbox"><input type="checkbox" checked={clearKey} disabled={pending || !configuration.keyConfigured} onChange={event => { setClearKey(event.target.checked); setApiKey(""); }} />清除此配置保存的密钥</label>
    {error ? <p className="library-error" role="alert">{error}</p> : null}
    <button className="secondary-button" type="button" disabled={pending || !model.trim() || !voice.trim()} onClick={() => void save()}>{pending ? "保存中…" : `保存${labels[configuration.kind]}配置`}</button>
    <p className="voice-note">保存配置不代表已连接。密钥只通过可信设置保存，不向 AI 返回。</p>
  </section>;
}

export function VoiceSettingsPanel(): React.JSX.Element {
  const [configurations, setConfigurations] = useState<VoiceConfiguration[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.aevorenBot.voice.configurations().then(result => {
      if (cancelled) return;
      if (result.ok) setConfigurations(result.data); else setError(result.error.safeMessage);
    }).catch(() => { if (!cancelled) setError("无法读取语音配置。"); });
    return () => { cancelled = true; };
  }, []);
  return <section aria-label="语音设置"><div className="settings-section-heading"><h2>语音</h2><p>转写、朗读和实时语音分别配置；普通业务仍使用当前 Bot。</p></div>{error ? <p role="alert" className="library-error">{error}</p> : null}{!error && !configurations.length ? <p role="status">正在读取语音配置…</p> : null}{(["stt", "tts", "realtime"] as const).map(kind => { const configuration = configurations.find(item => item.kind === kind); return configuration ? <ConfigurationCard key={`${kind}:${configuration.version}`} configuration={configuration} onSaved={saved => setConfigurations(current => current.map(item => item.kind === saved.kind ? saved : item))} /> : null; })}</section>;
}
