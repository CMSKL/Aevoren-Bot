import { PRODUCT_VIEW_DOM_EVENT, type ProductViewEvent } from "@shared/product-view";
import { useEffect, useEffectEvent, useState } from "react";
import type { UpdateState } from "@shared/contracts";
import { UPDATE_TASKS_RUNNING_MESSAGE, type UpdateAction } from "../update-actions";
import { CloseIcon } from "./Icons";
import "../styles/update-notice.css";

type UpdateStatusNoticeProps = {
  state: UpdateState | null;
  restartBlocked: boolean;
  actionPending?: UpdateAction | null;
  actionError?: string | null;
  onRetry(): void;
  onInstall(): void;
};

const dismissedVersionsKey = "aevoren.update-notice.dismissed-versions.v1";

export function UpdateStatusNotice({ state, restartBlocked, actionPending, actionError, onInstall }: UpdateStatusNoticeProps): React.JSX.Element | null {
  const [dismissedVersions, setDismissedVersions] = useState<string[]>(() => {
    try {
      if (typeof window === "undefined") return [];
      const saved: unknown = JSON.parse(window.sessionStorage.getItem(dismissedVersionsKey) ?? "[]");
      return Array.isArray(saved) ? saved.filter((version): version is string => typeof version === "string") : [];
    } catch {
      return [];
    }
  });
  const handleProductView = useEffectEvent((event: Event) => {
    const { request, respond } = (event as CustomEvent<ProductViewEvent>).detail;
    if (request.input.action !== "dismiss_update") return;
    if (state?.status === "downloaded" && state.availableVersion) {
      setDismissedVersions((current) => {
        const next = [...new Set([...current, state.availableVersion!])];
        try { window.sessionStorage.setItem(dismissedVersionsKey, JSON.stringify(next)); } catch { /* In-memory state still applies. */ }
        return next;
      });
    }
    respond({ status: "completed" });
  });
  useEffect(() => { const handler = (event: Event): void => handleProductView(event); window.addEventListener(PRODUCT_VIEW_DOM_EVENT, handler); return () => window.removeEventListener(PRODUCT_VIEW_DOM_EVENT, handler); }, []);
  if (state?.status !== "downloaded" || !state.availableVersion || dismissedVersions.includes(state.availableVersion)) return null;
  const availableVersion = state.availableVersion;

  function dismiss(): void {
    const next = [...dismissedVersions, availableVersion];
    setDismissedVersions(next);
    try {
      window.sessionStorage.setItem(dismissedVersionsKey, JSON.stringify(next));
    } catch {
      // The in-memory dismissal remains effective if storage is unavailable.
    }
  }

  const preparing = Boolean(actionPending);
  const waitingForTasks = actionError === UPDATE_TASKS_RUNNING_MESSAGE;
  return (
    <aside className="update-status-notice update-ready-notice" role="status" aria-live="polite" aria-busy={preparing}>
      <div className="update-status-copy">
        <strong>新版本已就绪</strong>
        <span title={`v${state.availableVersion}`}>v{state.availableVersion}</span>
        {actionError ? <small className="update-ready-error" role="alert" title={waitingForTasks ? "请完成或停止运行中的任务" : "可在设置的版本更新中查看并重试"}>{waitingForTasks ? "任务完成后再更新" : "更新未能启动，请重试。"}</small> : null}
      </div>
      <button type="button" className="update-action" disabled={restartBlocked || preparing} title={restartBlocked ? "当前任务完成后可重启更新" : preparing ? "正在保存资料并准备更新" : "重启并安装已下载的更新"} onClick={onInstall}>{preparing ? "准备中…" : "重启更新"}</button>
      <button type="button" className="update-notice-close" aria-label="关闭更新提示" title="关闭更新提示" disabled={preparing} onClick={dismiss}><CloseIcon /></button>
    </aside>
  );
}
