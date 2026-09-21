import { useCallback, useEffect, useRef, useState } from "react";
import type { AppearanceTheme, AppError, LoginItemStatus, UpdateState } from "@shared/contracts";
import { BellIcon, BotIcon, CloseIcon, EyeIcon, PanelIcon, RefreshIcon, SettingsIcon } from "./Icons";
import { ModelSettingsPanel } from "./ModelSettingsDialog";
import { CapabilitiesSettingsPanel } from "./CapabilitiesSettingsPanel";
import { McpSettingsPanel } from "./McpSettingsPanel";
import { ScopedMemorySettingsPanel } from "./ScopedMemorySettingsPanel";
import { RoutinesSettingsPanel } from "./RoutinesSettingsPanel";

type SettingsSection = "general" | "capabilities" | "memory" | "model" | "mcp" | "routines" | "updates";

type SettingsDialogProps = {
  open: boolean;
  theme: AppearanceTheme;
  launchAtLogin: boolean;
  launchAtLoginSupported: boolean;
  launchAtLoginStatus: LoginItemStatus;
  updateState: UpdateState | null;
  restartBlocked: boolean;
  activeBotId: string | null;
  onClose(): void;
  onThemeChange(theme: AppearanceTheme): Promise<AppError | null>;
  onLaunchAtLoginChange(enabled: boolean): Promise<AppError | null>;
  onCheckUpdate(): void;
  onRetryUpdate(): void;
  onInstallUpdate(): void;
};

const themeLabels: Record<AppearanceTheme, string> = {
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
};

const loginItemStatusLabels: Record<LoginItemStatus, string> = {
  unsupported: "当前开发版不可用",
  "not-registered": "未启用",
  enabled: "已启用",
  "requires-approval": "需要在系统设置中批准",
  "not-found": "系统未找到启动项",
};

const updateStatusLabels: Record<UpdateState["status"], string> = {
  disabled: "开发环境未启用",
  idle: "尚未检查",
  checking: "正在检查更新…",
  available: "发现新版本",
  downloading: "正在下载…",
  downloaded: "更新已准备好",
  installing: "正在重启安装…",
  "install-interrupted": "上次更新未完成",
  "up-to-date": "当前已是最新版本",
  updated: "更新已完成",
  error: "更新失败",
};

export function SettingsDialog({
  open,
  theme,
  launchAtLogin,
  launchAtLoginSupported,
  launchAtLoginStatus,
  updateState,
  restartBlocked,
  activeBotId,
  onClose,
  onThemeChange,
  onLaunchAtLoginChange,
  onCheckUpdate,
  onRetryUpdate,
  onInstallUpdate,
}: SettingsDialogProps): React.JSX.Element | null {
  const [section, setSection] = useState<SettingsSection>("general");
  const [themePending, setThemePending] = useState(false);
  const [themeError, setThemeError] = useState<AppError | null>(null);
  const [launchPending, setLaunchPending] = useState(false);
  const [launchError, setLaunchError] = useState<AppError | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const close = useCallback((): void => {
    setSection("general");
    setThemeError(null);
    setLaunchError(null);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => closeButtonRef.current?.focus());
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, close]);

  if (!open) return null;

  async function changeTheme(nextTheme: AppearanceTheme): Promise<void> {
    if (themePending || nextTheme === theme) return;
    setThemePending(true);
    setThemeError(null);
    const error = await onThemeChange(nextTheme);
    setThemeError(error);
    setThemePending(false);
  }

  async function changeLaunchAtLogin(enabled: boolean): Promise<void> {
    if (launchPending || !launchAtLoginSupported || enabled === launchAtLogin) return;
    setLaunchPending(true);
    setLaunchError(null);
    const error = await onLaunchAtLoginChange(enabled);
    setLaunchError(error);
    setLaunchPending(false);
  }

  const progress = Math.round(updateState?.progress?.percent ?? 0);
  const updateBusy = updateState ? ["checking", "available", "downloading", "installing"].includes(updateState.status) : true;

  return (
    <div className="modal-backdrop settings-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className="settings-dialog settings-hub" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <aside className="settings-nav" aria-label="设置分类">
          <div className="settings-nav-title" id="settings-title">设置</div>
          <nav>
            <button type="button" aria-label="通用" className={section === "general" ? "selected" : ""} aria-current={section === "general" ? "page" : undefined} onClick={() => setSection("general")}><SettingsIcon /><span>通用</span></button>
            <button type="button" aria-label="能力与权限" className={section === "capabilities" ? "selected" : ""} aria-current={section === "capabilities" ? "page" : undefined} onClick={() => setSection("capabilities")}><EyeIcon /><span>能力与权限</span></button>
            <button type="button" aria-label="长期记忆" className={section === "memory" ? "selected" : ""} aria-current={section === "memory" ? "page" : undefined} onClick={() => setSection("memory")}><BotIcon /><span>长期记忆</span></button>
            <button type="button" aria-label="模型与 CLI" className={section === "model" ? "selected" : ""} aria-current={section === "model" ? "page" : undefined} onClick={() => setSection("model")}><BotIcon /><span>模型与 CLI</span></button>
            <button type="button" aria-label="MCP" className={section === "mcp" ? "selected" : ""} aria-current={section === "mcp" ? "page" : undefined} onClick={() => setSection("mcp")}><PanelIcon /><span>MCP</span></button>
            <button type="button" aria-label="主动服务" className={section === "routines" ? "selected" : ""} aria-current={section === "routines" ? "page" : undefined} onClick={() => setSection("routines")}><BellIcon /><span>主动服务</span></button>
            <button type="button" aria-label="版本更新" className={section === "updates" ? "selected" : ""} aria-current={section === "updates" ? "page" : undefined} onClick={() => setSection("updates")}><RefreshIcon /><span>版本更新</span></button>
          </nav>
        </aside>

        <div className="settings-content">
          <button ref={closeButtonRef} className="settings-close-button" type="button" aria-label="关闭设置" onClick={close}><CloseIcon /></button>

          {section === "general" ? <section className="settings-panel" aria-labelledby="settings-general-title">
            <div className="settings-section-heading">
              <h2 id="settings-general-title">通用</h2>
              <p>调整 Aevoren Bot 在这台电脑上的基础偏好。</p>
            </div>
            <h3>外观</h3>
            <div className="settings-card">
              <label className="settings-row">
                <span><strong>主题</strong><small>选择界面的明暗外观</small></span>
                <select aria-label="外观主题" value={theme} disabled={themePending} onChange={(event) => void changeTheme(event.target.value as AppearanceTheme)}>
                  {(Object.keys(themeLabels) as AppearanceTheme[]).map((value) => <option key={value} value={value}>{themeLabels[value]}</option>)}
                </select>
              </label>
            </div>
            {themeError ? <div className="dialog-error" role="alert">{themeError.safeMessage}</div> : null}
            <h3>后台与启动</h3>
            <div className="settings-card">
              <label className="settings-row">
                <span>
                  <strong>登录时启动</strong>
                  <small>{launchAtLoginSupported ? `让 Routine 在重新登录后恢复 · ${loginItemStatusLabels[launchAtLoginStatus]}` : "当前仅 macOS 打包版支持；Windows 启动任务适配尚未启用"}</small>
                </span>
                <input
                  aria-label="登录时启动"
                  type="checkbox"
                  checked={launchAtLogin}
                  disabled={!launchAtLoginSupported || launchPending}
                  onChange={(event) => void changeLaunchAtLogin(event.target.checked)}
                />
              </label>
            </div>
            {launchError ? <div className="dialog-error" role="alert">{launchError.safeMessage}</div> : null}
          </section> : null}

          {section === "capabilities" ? <section className="settings-panel" aria-label="能力与权限">
            <CapabilitiesSettingsPanel active={open && section === "capabilities"} botId={activeBotId} />
          </section> : null}

          {section === "memory" ? <section className="settings-panel" aria-label="长期记忆">
            <ScopedMemorySettingsPanel active={open && section === "memory"} />
          </section> : null}

          {section === "model" ? <section className="settings-panel" aria-label="模型与 CLI">
            <ModelSettingsPanel open={open && section === "model"} />
          </section> : null}

          {section === "mcp" ? <section className="settings-panel" aria-label="MCP">
            <McpSettingsPanel active={open && section === "mcp"} />
          </section> : null}

          {section === "routines" ? <section className="settings-panel" aria-label="主动服务">
            <RoutinesSettingsPanel active={open && section === "routines"} />
          </section> : null}

          {section === "updates" ? <section className="settings-panel" aria-labelledby="settings-update-title">
            <div className="settings-section-heading">
              <h2 id="settings-update-title">版本更新</h2>
              <p>检查并安装可信来源发布的 Aevoren Bot 新版本。</p>
            </div>
            <div className="settings-card">
              <div className="settings-row">
                <span><strong>当前版本</strong><small>{updateState?.channel === "development" ? "开发环境" : updateState?.channel === "beta" ? "Beta 渠道" : "Stable 渠道"}</small></span>
                <span className="settings-value">v{updateState?.currentVersion ?? "—"}</span>
              </div>
              <div className="settings-row">
                <span><strong>更新状态</strong><small>{updateState?.checkedAt ? `上次检查：${new Date(updateState.checkedAt).toLocaleString("zh-CN")}` : "尚无检查记录"}</small></span>
                <span className={`settings-status settings-status-${updateState?.status ?? "idle"}`}>{updateState ? updateStatusLabels[updateState.status] : "正在读取…"}</span>
              </div>
              {updateState?.availableVersion ? (
                <div className="settings-row">
                  <span><strong>可用版本</strong><small>{updateState.status === "downloaded" ? "下载完成，等待重启" : "检测到较新的版本"}</small></span>
                  <span className="settings-value">v{updateState.availableVersion}</span>
                </div>
              ) : null}
            </div>
            {updateState?.status === "downloading" || updateState?.status === "available" ? (
              <div className="settings-update-progress" role="status" aria-label={`更新下载进度 ${progress}%`}><span style={{ width: `${progress}%` }} /></div>
            ) : null}
            {updateState?.status === "disabled" ? <p className="settings-security-note">未打包的开发版本不会连接更新服务器，也不会自动下载。</p> : null}
            {updateState?.error ? <div className="dialog-error" role="alert">{updateState.error.safeMessage}</div> : null}
            <div className="settings-panel-actions">
              {updateState?.status === "downloaded" ? (
                <button className="primary-button" type="button" disabled={restartBlocked} onClick={onInstallUpdate}>{restartBlocked ? "任务完成后可重启" : "重启并更新"}</button>
              ) : updateState?.status === "error" || updateState?.status === "install-interrupted" ? (
                <button className="primary-button" type="button" onClick={onRetryUpdate}>重试</button>
              ) : (
                <button className="secondary-button" type="button" disabled={updateBusy || updateState?.status === "disabled"} onClick={onCheckUpdate}>{updateState?.status === "checking" ? "检查中…" : "检查更新"}</button>
              )}
            </div>
          </section> : null}
        </div>
      </section>
    </div>
  );
}
