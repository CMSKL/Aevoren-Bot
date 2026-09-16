import { useEffect, useState } from "react";
import type { AppError, ModelConfiguration } from "@shared/contracts";

type ModelSettingsPanelProps = {
  open: boolean;
};

export function ModelSettingsPanel({ open }: ModelSettingsPanelProps): React.JSX.Element {
  const [configuration, setConfiguration] = useState<ModelConfiguration | null>(null);
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<AppError | null>(null);
  const [status, setStatus] = useState<"loading" | "idle" | "saving" | "testing" | "success">("loading");

  useEffect(() => {
    if (!open) return;
    void window.aevorenBot.settings.getModelConfiguration().then((result) => {
      if (!result.ok) {
        setError(result.error);
        setStatus("idle");
        return;
      }
      setConfiguration(result.data);
      setBaseUrl(result.data.baseUrl);
      setModelId(result.data.modelId);
      setApiKey("");
      setError(null);
      setStatus("idle");
    });
  }, [open]);

  async function save(): Promise<boolean> {
    setStatus("saving");
    setError(null);
    const result = await window.aevorenBot.settings.saveModelConfiguration({
      baseUrl,
      modelId,
      ...(apiKey.trim() ? { apiKey } : {}),
    });
    if (!result.ok) {
      setError(result.error);
      setStatus("idle");
      return false;
    }
    setConfiguration(result.data);
    setApiKey("");
    setStatus("success");
    return true;
  }

  async function test(): Promise<void> {
    const saved = await save();
    if (!saved) return;
    setStatus("testing");
    const result = await window.aevorenBot.settings.testModelConnection();
    if (!result.ok) {
      setError(result.error);
      setStatus("idle");
      return;
    }
    setStatus("success");
  }

  const pending = status === "loading" || status === "saving" || status === "testing";

  return (
    <div className="settings-panel-form">
      <div className="settings-section-heading">
        <h2>模型配置</h2>
        <p>连接支持 OpenAI Chat Completions 的模型服务。</p>
      </div>
      <div className="settings-card settings-model-card">
        <label className="settings-field-row">
          <span><strong>Base URL</strong><small>模型服务的兼容接口地址</small></span>
          <input aria-label="Base URL" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" disabled={pending} />
        </label>
        <label className="settings-field-row">
          <span><strong>Model ID</strong><small>服务商提供的模型标识</small></span>
          <input aria-label="Model ID" value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="输入模型标识" disabled={pending} />
        </label>
        <label className="settings-field-row">
          <span><strong>API Key</strong><small>{configuration?.apiKeyConfigured ? "已安全保存；留空表示不替换" : "尚未配置"}</small></span>
          <input aria-label="API Key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={configuration?.apiKeyConfigured ? "••••••••" : "输入 API Key"} autoComplete="off" disabled={pending} />
        </label>
      </div>
      <p className="settings-security-note">API Key 只会发送到可信 Main 进程，并使用 macOS 系统安全存储加密。</p>
      {error ? <div className="dialog-error" role="alert">{error.safeMessage}</div> : null}
      {status === "success" ? <div className="dialog-success" role="status">设置已保存。</div> : null}
      <div className="settings-panel-actions">
        <button className="secondary-button" type="button" onClick={() => void test()} disabled={!baseUrl || !modelId || pending}>
          {status === "testing" ? "测试中…" : "保存并测试"}
        </button>
        <button className="primary-button" type="button" onClick={() => void save()} disabled={!baseUrl || !modelId || pending}>
          {status === "saving" ? "保存中…" : "保存"}
        </button>
      </div>
    </div>
  );
}
