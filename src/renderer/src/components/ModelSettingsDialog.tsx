import { useEffect, useMemo, useState } from "react";
import type { AppError, ProviderInstanceInfo } from "@shared/contracts";
import { ProviderMark, ProviderStatusPill } from "./ProviderPresentation";
import { providerDisplayState, providerStateLabel, providerSubtitle } from "./provider-presentation";

type ModelSettingsPanelProps = {
  open: boolean;
};

type Operation = "loading" | "idle" | "saving" | "testing" | "refreshing" | "scanning";
const PROVIDERS_CHANGED_EVENT = "aevoren:providers-changed";

function replaceProvider(current: ProviderInstanceInfo[], next: ProviderInstanceInfo): ProviderInstanceInfo[] {
  return current.map((provider) => provider.id === next.id ? next : provider);
}

function cliDrafts(providers: ProviderInstanceInfo[]): Record<string, string> {
  return Object.fromEntries(providers.filter((provider) => provider.cliDefault).map((provider) => [
    provider.id,
    provider.manualCliPath || provider.cliDefault || "",
  ]));
}

function notifyProviderChange(): void {
  window.dispatchEvent(new Event(PROVIDERS_CHANGED_EVENT));
}

export function ModelSettingsPanel({ open }: ModelSettingsPanelProps): React.JSX.Element {
  const [providers, setProviders] = useState<ProviderInstanceInfo[]>([]);
  const [manualPaths, setManualPaths] = useState<Record<string, string>>({});
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [apiKey, setApiKey] = useState("");
  const [operation, setOperation] = useState<Operation>("loading");
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>(null);
  const [manualFallbackProviderId, setManualFallbackProviderId] = useState<string | null>(null);
  const compatible = useMemo(
    () => providers.find((provider) => provider.driverKind === "openai-compatible") ?? null,
    [providers],
  );
  const groupedProviders = useMemo(() => {
    const ready = providers.filter((provider) => providerDisplayState(provider) === "ready");
    const needsSetup = providers.filter((provider) => providerDisplayState(provider) !== "ready");
    return [
      { id: "ready", label: "已就绪", providers: ready },
      { id: "needs-setup", label: "需要设置", providers: needsSetup },
    ].filter((group) => group.providers.length > 0);
  }, [providers]);

  useEffect(() => {
    if (!open) return;
    void window.aevorenBot.providers.list().then((result) => {
      if (!result.ok) {
        setError(result.error);
        setOperation("idle");
        return;
      }
      setProviders(result.data);
      setManualPaths(cliDrafts(result.data));
      const nextCompatible = result.data.find((provider) => provider.driverKind === "openai-compatible");
      setBaseUrl(nextCompatible?.baseUrl || "https://api.openai.com/v1");
      setApiKey("");
      setOperation("idle");
    });
  }, [open]);

  async function scanAll(): Promise<void> {
    if (operation !== "idle") return;
    setOperation("scanning");
    setActiveProviderId("all");
    setError(null);
    setNotice(null);
    const result = await window.aevorenBot.providers.scan();
    if (result.ok) {
      setProviders(result.data);
      setManualPaths(cliDrafts(result.data));
      setNotice(`扫描完成：发现 ${result.data.filter((provider) => provider.status === "available").length} 个可用模型来源。`);
      notifyProviderChange();
    } else setError(result.error);
    setActiveProviderId(null);
    setOperation("idle");
  }

  async function saveCli(provider: ProviderInstanceInfo, cliPath: string): Promise<void> {
    if (!provider.cliDefault || operation !== "idle" || !cliPath.trim()) return;
    setOperation("saving");
    setActiveProviderId(provider.id);
    setError(null);
    setNotice(null);
    const result = await window.aevorenBot.providers.saveCli({
      instanceId: provider.id,
      expectedVersion: provider.version,
      cliPath: cliPath.trim(),
    });
    if (result.ok) {
      setProviders((current) => replaceProvider(current, result.data));
      setManualPaths((current) => ({
        ...current,
        [provider.id]: result.data.manualCliPath || result.data.cliDefault || "",
      }));
      setNotice(result.data.discoveryMode === "automatic"
        ? `${provider.displayName} 已恢复自动发现。`
        : `${provider.displayName} 手动路径已保存。`);
      notifyProviderChange();
    } else setError(result.error);
    setActiveProviderId(null);
    setOperation("idle");
  }

  async function saveCompatible(): Promise<void> {
    if (!compatible || operation !== "idle") return;
    setOperation("saving");
    setActiveProviderId(compatible.id);
    setError(null);
    setNotice(null);
    const result = await window.aevorenBot.providers.saveOpenAiCompatible({
      instanceId: compatible.id,
      expectedVersion: compatible.version,
      baseUrl,
      ...(apiKey.trim() ? { apiKey } : {}),
    });
    if (result.ok) {
      setProviders((current) => replaceProvider(current, result.data));
      setBaseUrl(result.data.baseUrl || "https://api.openai.com/v1");
      setApiKey("");
      setNotice("API 配置已保存。");
      notifyProviderChange();
    } else setError(result.error);
    setActiveProviderId(null);
    setOperation("idle");
  }

  async function verify(provider: ProviderInstanceInfo): Promise<void> {
    if (operation !== "idle") return;
    setOperation("testing");
    setActiveProviderId(provider.id);
    setError(null);
    setNotice(null);
    const result = await window.aevorenBot.providers.test(provider.id);
    const refreshed = await window.aevorenBot.providers.list();
    if (refreshed.ok) setProviders(refreshed.data);
    if (result.ok) setNotice(`${provider.displayName} 已完成真实最小请求。`);
    else setError(result.error);
    setActiveProviderId(null);
    setOperation("idle");
  }

  async function refresh(provider: ProviderInstanceInfo): Promise<void> {
    if (operation !== "idle") return;
    setOperation("refreshing");
    setActiveProviderId(provider.id);
    setError(null);
    setNotice(null);
    const result = await window.aevorenBot.providers.refresh(provider.id);
    if (result.ok) {
      setProviders((current) => replaceProvider(current, result.data));
      setNotice(`${provider.displayName} 状态和模型目录已刷新。`);
      notifyProviderChange();
    } else setError(result.error);
    setActiveProviderId(null);
    setOperation("idle");
  }

  const pending = operation !== "idle";
  const actionLabel = (providerId: string, idle: string): string => {
    if (activeProviderId !== providerId) return idle;
    if (operation === "saving") return "保存中…";
    if (operation === "testing") return "测试中…";
    if (operation === "refreshing") return "刷新中…";
    return idle;
  };

  return (
    <div className="settings-panel-form">
      <div className="settings-section-heading provider-scan-heading">
        <span>
          <h2>模型与 CLI</h2>
          <p>第一阶段支持 API、Claude Code 和 Codex CLI；切换后请求会直接走对应调用链路。</p>
        </span>
        <button className="secondary-button" type="button" disabled={pending} onClick={() => void scanAll()}>
          {operation === "scanning" ? "扫描中…" : "重新扫描"}
        </button>
      </div>

      <div className="provider-engine-grid">
        {groupedProviders.flatMap((group, groupIndex) => [
          <div className={`provider-engine-group-heading ${groupIndex > 0 ? "spaced" : ""}`} key={`heading-${group.id}`}>
            <h3>{group.label}</h3>
            <span>{group.providers.length} 个</span>
          </div>,
          ...group.providers.map((provider) => {
            const isCompatible = provider.driverKind === "openai-compatible";
            const state = providerDisplayState(provider);
            return (
              <div
                className="settings-card settings-model-card provider-settings-card provider-engine-card"
                data-expanded={expandedProviderId === provider.id}
                data-provider-state={state}
                key={provider.id}
              >
                <button
                  className="provider-engine-summary"
                  type="button"
                  aria-label={`管理 ${provider.displayName}`}
                  aria-expanded={expandedProviderId === provider.id}
                  onClick={() => setExpandedProviderId((current) => current === provider.id ? null : provider.id)}
                >
                  <div className="provider-engine-identity">
                    <ProviderMark provider={provider} size="large" />
                    <span>
                      <strong title={provider.displayName}>{provider.displayName}</strong>
                      <small>{providerSubtitle(provider)}</small>
                    </span>
                    <span className="provider-engine-chevron" aria-hidden="true">⌄</span>
                  </div>
                  <div className="provider-engine-status-row">
                    <ProviderStatusPill provider={provider} />
                    {state === "ready" ? (
                      <small>{provider.runtimeVersion ? `v${provider.runtimeVersion.replace(/^v/u, "")}` : `${provider.models.options.length} 个模型`}</small>
                    ) : (
                      <small className="provider-engine-setup">设置 ↗</small>
                    )}
                  </div>
                </button>
                {expandedProviderId === provider.id ? <div className="provider-engine-details">
                  <dl className="provider-discovery-details">
                    <div><dt>状态</dt><dd>{providerStateLabel(provider)}</dd></div>
                    <div><dt>发现方式</dt><dd>{provider.discoveryMode === "manual" ? "手动兜底" : provider.discoveryMode === "automatic" ? "自动扫描" : "手动配置"}</dd></div>
                    {!isCompatible ? <div><dt>位置</dt><dd title={provider.cliPath || undefined}>{provider.cliPath || "未找到可执行文件"}</dd></div> : null}
                    <div><dt>模型</dt><dd>{provider.models.options.length > 0 ? `${provider.models.options.length} 个，默认 ${provider.models.default}` : "尚无可用模型"}</dd></div>
                  </dl>
                  {provider.reason ? <p className="provider-settings-reason">{provider.reason}</p> : null}

                  {isCompatible ? <>
                    <label className="settings-field-row">
                      <span><strong>Base URL</strong><small>HTTPS，或仅限本机回环 HTTP</small></span>
                      <input aria-label="Base URL" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" disabled={pending} />
                    </label>
                    <label className="settings-field-row">
                      <span><strong>API Key</strong><small>{compatible?.apiKeyConfigured ? "已安全保存；留空表示不替换" : "尚未配置"}</small></span>
                      <input aria-label="API Key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={compatible?.apiKeyConfigured ? "••••••••" : "输入 API Key"} autoComplete="off" disabled={pending} />
                    </label>
                    <p className="settings-security-note">API Key 由系统 safeStorage 加密且不会返回 Renderer；测试会发送一次最小真实请求。</p>
                    <div className="settings-panel-actions">
                      <button className="secondary-button" type="button" disabled={pending || !provider.apiKeyConfigured} onClick={() => void refresh(provider)}>{actionLabel(provider.id, "刷新模型")}</button>
                      <button className="secondary-button" type="button" disabled={pending || !provider.apiKeyConfigured} onClick={() => void verify(provider)}>测试真实请求</button>
                      <button className="primary-button" type="button" disabled={pending || !baseUrl.trim()} onClick={() => void saveCompatible()}>{actionLabel(provider.id, "保存 API 配置")}</button>
                    </div>
                  </> : <>
                    <p className="settings-security-note">Aevoren 不读取或保存该 CLI 的明文密钥；模型调用继续使用 CLI 自己的登录与配置。</p>
                    <div className="settings-panel-actions">
                      <button className="secondary-button" type="button" disabled={pending} onClick={() => void refresh(provider)}>{actionLabel(provider.id, "检查")}</button>
                      <button className="secondary-button" type="button" disabled={pending || !provider.cliPath || !provider.authenticated || !provider.models.default} onClick={() => void verify(provider)}>测试真实请求</button>
                    </div>
                    <div className="provider-manual-fallback" data-expanded={manualFallbackProviderId === provider.id}>
                      <button
                        className="provider-manual-summary"
                        type="button"
                        aria-expanded={manualFallbackProviderId === provider.id}
                        onClick={() => setManualFallbackProviderId((current) => current === provider.id ? null : provider.id)}
                      >
                        高级：手动指定 CLI 路径
                      </button>
                      {manualFallbackProviderId === provider.id ? <>
                      <label className="settings-field-row">
                        <span><strong>CLI 路径</strong><small>仅在自动扫描找不到 CLI 时使用</small></span>
                        <input
                          aria-label={`${provider.displayName} 手动 CLI 路径`}
                          value={manualPaths[provider.id] ?? provider.cliDefault ?? ""}
                          onChange={(event) => setManualPaths((current) => ({ ...current, [provider.id]: event.target.value }))}
                          placeholder={provider.cliDefault || undefined}
                          disabled={pending}
                        />
                      </label>
                      <div className="settings-panel-actions">
                        <button className="secondary-button" type="button" disabled={pending || provider.discoveryMode === "automatic"} onClick={() => void saveCli(provider, provider.cliDefault || "")}>恢复自动发现</button>
                        <button className="primary-button" type="button" disabled={pending || !(manualPaths[provider.id] ?? "").trim()} onClick={() => void saveCli(provider, manualPaths[provider.id] ?? "")}>{actionLabel(provider.id, "保存兜底路径")}</button>
                      </div>
                      </> : null}
                    </div>
                  </>}
                </div> : null}
              </div>
            );
          }),
        ])}
        {providers.length === 0 && operation === "idle" ? <p className="provider-engine-empty">尚未发现模型来源，请重新扫描。</p> : null}
      </div>

      {error ? <div className="dialog-error" role="alert">{error.safeMessage}</div> : null}
      {notice ? <div className="dialog-success" role="status">{notice}</div> : null}
    </div>
  );
}
