import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppError, CapabilityAvailability, CapabilitySnapshot } from "@shared/contracts";
import { CheckIcon, RefreshIcon } from "./Icons";

type CapabilitiesSettingsPanelProps = {
  active: boolean;
  botId: string | null;
};

const categoryLabels: Record<CapabilitySnapshot["capabilities"][number]["category"], string> = {
  conversation: "对话与协作",
  memory: "记忆",
  workspace: "本地数据",
  network: "联网与实时数据",
  device: "设备与系统",
  automation: "主动服务",
  multimodal: "多模态",
  external: "外部能力",
};

const availabilityLabels: Record<CapabilityAvailability, string> = {
  available: "可用",
  unavailable: "当前不可用",
  "permission-required": "需要授权",
  "not-supported": "尚未支持",
};

const toolLabels: Record<string, string> = {
  workspace_list: "查看工作区目录",
  workspace_read: "读取工作区文件",
  workspace_search: "搜索工作区文件",
  workspace_write: "新建工作区文件",
  web_search: "联网搜索",
  web_fetch: "读取公开网页",
  weather_current: "查询天气",
  time_now: "查询时间",
  clipboard_read: "读取剪贴板",
  text_measure: "精确计算文本长度",
};

export function CapabilitiesSettingsPanel({ active, botId }: CapabilitiesSettingsPanelProps): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<CapabilitySnapshot | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    const result = await window.aevorenBot.capabilities.getSnapshot(botId ? { botId } : undefined);
    if (result.ok) setSnapshot(result.data);
    else setError(result.error);
    setLoading(false);
  }, [botId]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void window.aevorenBot.capabilities.getSnapshot(botId ? { botId } : undefined).then((result) => {
      if (cancelled) return;
      if (result.ok) setSnapshot(result.data);
      else setError(result.error);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [active, botId]);

  const groups = useMemo(() => {
    if (!snapshot) return [];
    return Object.entries(categoryLabels).flatMap(([category, label]) => {
      const items = snapshot.capabilities.filter((capability) => capability.category === category);
      return items.length > 0 ? [{ category, label, items }] : [];
    });
  }, [snapshot]);

  return (
    <div className="settings-panel-form capability-settings-panel">
      <div className="settings-section-heading capability-heading">
        <span>
          <h2>能力与权限</h2>
          <p>由本机运行时实时生成。Bot 只能使用这里显示为可用、且已经获得授权的能力。</p>
        </span>
        <button className="secondary-button" type="button" disabled={loading} onClick={() => void load()}>
          <RefreshIcon />{loading ? "刷新中…" : "刷新状态"}
        </button>
      </div>

      {snapshot ? <>
        <h3>当前运行状态</h3>
        <div className="settings-card capability-runtime-card">
          <div className="settings-row">
            <span><strong>应用环境</strong><small>本地桌面应用 · {snapshot.backgroundMode === "foreground-only" ? "仅前台运行" : "支持后台运行"}</small></span>
            <span className="settings-value">v{snapshot.app.version}</span>
          </div>
          <div className="settings-row">
            <span><strong>{botId ? "当前 Bot 模型" : "默认模型"}</strong><small>{snapshot.model.providerName} · {snapshot.model.providerStatus === "available" ? "来源可用" : snapshot.model.providerStatus === "unknown" ? "状态未知" : "来源不可用"}</small></span>
            <span className="settings-value" title={snapshot.model.modelId}>{snapshot.model.modelId || "未选择"}</span>
          </div>
          <div className="settings-row">
            <span><strong>时间与时区</strong><small>{snapshot.timezone} · UTC{snapshot.utcOffsetMinutes >= 0 ? "+" : ""}{snapshot.utcOffsetMinutes / 60}</small></span>
            <span className="settings-value">{new Date(snapshot.generatedAt).toLocaleString("zh-CN")}</span>
          </div>
          <div className="settings-row">
            <span><strong>当前可调用工具</strong><small>{snapshot.workspaceCount} 个工作区 · {snapshot.connections.filter((item) => item.status === "available").length}/{snapshot.connections.length} 个模型来源可用</small></span>
            <span className="settings-value">{snapshot.availableTools.length > 0 ? snapshot.availableTools.map((tool) => toolLabels[tool] ?? "外部工具").join("、") : "无"}</span>
          </div>
        </div>

        <h3 className="capability-section-title">权限</h3>
        <div className="settings-card">
          {snapshot.permissions.map((permission) => (
            <div className="settings-row" key={permission.id}>
              <span><strong>{permission.name}</strong><small>{permission.scopeSummary} · {permission.revocable ? "可撤销" : "不可撤销"}</small></span>
              <span className={`capability-state capability-state-${permission.state}`}>{permission.state === "granted" ? <CheckIcon /> : null}{permission.state === "granted" ? "已授权" : permission.state === "not-granted" ? "未授权" : "不支持"}</span>
            </div>
          ))}
        </div>

        {groups.map((group) => (
          <section className="capability-group" key={group.category} aria-labelledby={`capability-${group.category}`}>
            <div className="provider-engine-group-heading">
              <h3 id={`capability-${group.category}`}>{group.label}</h3>
              <span>{group.items.filter((item) => item.availability === "available").length}/{group.items.length} 可用</span>
            </div>
            <div className="capability-grid">
              {group.items.map((capability) => (
                <article className="settings-card capability-card" key={capability.id} data-capability={capability.id} data-availability={capability.availability}>
                  <header>
                    <strong>{capability.name}</strong>
                    <span className={`capability-state capability-state-${capability.availability}`}>{capability.availability === "available" ? <CheckIcon /> : null}{availabilityLabels[capability.availability]}</span>
                  </header>
                  <p>{capability.description}</p>
                  {capability.reason ? <small>{capability.reason}</small> : (
                    <details className="capability-technical-details">
                      <summary>技术详情</summary>
                      <code>{capability.adapterKind} · {capability.effectClass}</code>
                    </details>
                  )}
                </article>
              ))}
            </div>
          </section>
        ))}
      </> : loading ? <div className="workspace-empty">正在读取能力状态…</div> : null}

      {error ? <div className="dialog-error" role="alert">{error.safeMessage}</div> : null}
    </div>
  );
}
