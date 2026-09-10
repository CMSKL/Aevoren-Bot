import { useEffect, useState } from "react";
import type { AppError, ModelConfiguration } from "@shared/contracts";

type ModelSettingsDialogProps = {
  open: boolean;
  onClose(): void;
};

export function ModelSettingsDialog({ open, onClose }: ModelSettingsDialogProps): React.JSX.Element | null {
  const [configuration, setConfiguration] = useState<ModelConfiguration | null>(null);
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<AppError | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "testing" | "success">("idle");

  useEffect(() => {
    if (!open) return;
    void window.msBot.settings.getModelConfiguration().then((result) => {
      if (!result.ok) {
        setError(result.error);
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

  if (!open) return null;

  async function save(): Promise<boolean> {
    setStatus("saving");
    setError(null);
    const result = await window.msBot.settings.saveModelConfiguration({
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
    const result = await window.msBot.settings.testModelConnection();
    if (!result.ok) {
      setError(result.error);
      setStatus("idle");
      return;
    }
    setStatus("success");
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="model-settings-title">
        <header>
          <div>
            <h2 id="model-settings-title">模型设置</h2>
            <p>连接一个支持 OpenAI Chat Completions 的模型服务。</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭">×</button>
        </header>
        <label className="field">
          <span>Base URL</span>
          <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" />
        </label>
        <label className="field">
          <span>Model ID</span>
          <input value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="输入模型标识" />
        </label>
        <label className="field">
          <span>API Key</span>
          <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={configuration?.apiKeyConfigured ? "已安全保存；留空表示不替换" : "输入 API Key"} autoComplete="off" />
        </label>
        <div className="security-note">API Key 只会发送到可信 Main 进程，并使用系统安全存储加密。</div>
        {error ? <div className="dialog-error" role="alert">{error.safeMessage}</div> : null}
        {status === "success" ? <div className="dialog-success">设置已保存。</div> : null}
        <footer>
          <button className="secondary-button" type="button" onClick={() => void test()} disabled={!baseUrl || !modelId || status === "saving" || status === "testing"}>
            {status === "testing" ? "测试中…" : "保存并测试"}
          </button>
          <button className="primary-button" type="button" onClick={() => void save()} disabled={!baseUrl || !modelId || status === "saving" || status === "testing"}>
            {status === "saving" ? "保存中…" : "保存"}
          </button>
        </footer>
      </section>
    </div>
  );
}
