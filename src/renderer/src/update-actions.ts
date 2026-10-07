import type { AppError } from "@shared/contracts";

export type UpdateAction = "check" | "retry" | "install";

const messages = {
  UPDATE_NOT_READY: "更新尚未下载完成，请稍后重试。",
  UPDATE_CHECK_FAILED: "检查更新失败，当前版本可继续使用。",
  UPDATE_DOWNLOAD_FAILED: "更新下载失败，当前版本可继续使用。",
  UPDATE_INSTALL_FAILED: "更新安装未能启动，当前版本可继续使用。",
  UPDATE_INSTALL_INTERRUPTED: "上次更新没有完成，当前版本仍可使用。",
} as const;

export function updateActionErrorMessage(action: UpdateAction, error?: AppError): string {
  const known = error?.domain === "update" && Object.hasOwn(messages, error.code) ? messages[error.code as keyof typeof messages] : undefined;
  return known ?? (action === "install" ? messages.UPDATE_INSTALL_FAILED : messages.UPDATE_CHECK_FAILED);
}
