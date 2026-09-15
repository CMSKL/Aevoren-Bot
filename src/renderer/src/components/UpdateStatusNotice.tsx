import type { UpdateState } from "@shared/contracts";

type UpdateStatusNoticeProps = {
  state: UpdateState | null;
  restartBlocked: boolean;
  onRetry(): void;
  onInstall(): void;
};

export function UpdateStatusNotice({ state, restartBlocked, onRetry, onInstall }: UpdateStatusNoticeProps): React.JSX.Element | null {
  if (!state || ["disabled", "idle", "checking", "up-to-date"].includes(state.status)) return null;

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
      <aside className="update-status-notice" role="status" aria-live="polite">
        <div className="update-status-copy">
          <strong>v{state.availableVersion} 已准备好</strong>
          <span>{restartBlocked ? "当前任务完成后即可重启更新" : "可立即重启，或在下次正常退出时自动安装"}</span>
        </div>
        <button type="button" className="update-action" disabled={restartBlocked} onClick={onInstall}>重启更新</button>
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

  return (
    <aside className="update-status-notice update-status-error" role="alert">
      <div className="update-status-copy"><strong>自动更新失败</strong><span>{state.error?.safeMessage ?? "当前版本可继续使用。"}</span></div>
      <button type="button" className="update-action" onClick={onRetry}>重试</button>
    </aside>
  );
}
