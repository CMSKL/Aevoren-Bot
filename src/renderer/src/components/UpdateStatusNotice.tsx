import type { UpdateState } from "@shared/contracts";
import type { UpdateAction } from "../update-actions";

type UpdateStatusNoticeProps = {
  state: UpdateState | null;
  restartBlocked: boolean;
  actionPending?: UpdateAction | null;
  actionError?: string | null;
  onRetry(): void;
  onInstall(): void;
};

export function UpdateStatusNotice({ state, restartBlocked, actionPending, actionError, onRetry, onInstall }: UpdateStatusNoticeProps): React.JSX.Element | null {
  if (actionPending && (actionPending === "install" ? state?.status !== "installing" : !["available", "downloading", "downloaded"].includes(state?.status ?? ""))) {
    const installing = actionPending === "install";
    return (
      <aside className="update-status-notice" role="status" aria-live="polite" aria-busy="true">
        <div className="update-status-copy">
          <strong>{installing ? "正在准备重启更新…" : "正在检查更新…"}</strong>
          <span>{installing ? "正在保存资料，保存完成后继续" : "应用可继续使用，请稍候"}</span>
        </div>
        <button type="button" className="update-action" disabled>{installing ? "准备中…" : "检查中…"}</button>
      </aside>
    );
  }
  if (!state || (["disabled", "idle", "checking", "up-to-date"].includes(state.status) && !actionError)) return null;

  if (state.status === "available" || state.status === "downloading") {
    const percent = Math.round(state.progress?.percent ?? 0);
    return (
      <aside className="update-status-notice" role="status" aria-live="polite">
        <div className="update-status-copy">
          <strong>正在下载 Aevoren Bot {state.availableVersion ? `v${state.availableVersion}` : "更新"}</strong>
          <span>{percent}% · 下载完成后将在正常退出时自动安装</span>
        </div>
        <div className="update-progress" aria-label={`更新下载进度 ${percent}%`}>
          <span style={{ width: `${percent}%` }} />
        </div>
      </aside>
    );
  }

  if (state.status === "downloaded") {
    return (
      <aside className={`update-status-notice${actionError ? " update-status-error" : ""}`} role={actionError ? "alert" : "status"} aria-live="polite">
        <div className="update-status-copy">
          <strong>v{state.availableVersion} 已准备好</strong>
          <span>{actionError ?? (restartBlocked ? "当前任务完成后即可重启更新" : "可立即重启，或在下次正常退出时自动安装")}</span>
        </div>
        <button type="button" className="update-action" disabled={restartBlocked || Boolean(actionPending)} onClick={onInstall}>重启更新</button>
      </aside>
    );
  }

  if (state.status === "installing") {
    return (
      <aside className="update-status-notice" role="status" aria-live="assertive">
        <div className="update-status-copy"><strong>正在重启并安装更新…</strong><span>请勿强制结束应用</span></div>
      </aside>
    );
  }

  if (state.status === "updated") {
    return (
      <aside className="update-status-notice update-status-success" role="status">
        <div className="update-status-copy"><strong>已更新至 v{state.currentVersion}</strong><span>新版本已成功启动</span></div>
      </aside>
    );
  }

  const interrupted = state.status === "install-interrupted";
  return (
    <aside className="update-status-notice update-status-error" role="alert">
      <div className="update-status-copy"><strong>{actionError ? "更新操作未完成" : interrupted ? "上次更新未完成" : "自动更新失败"}</strong><span>{actionError ?? state.error?.safeMessage ?? "当前版本可继续使用。"}</span></div>
      <button type="button" className="update-action" onClick={onRetry}>{interrupted ? "重新下载" : "重试"}</button>
    </aside>
  );
}
