import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { UpdateState } from "@shared/contracts";
import { UpdateStatusNotice } from "./UpdateStatusNotice";
import type { UpdateAction } from "../update-actions";

const base: UpdateState = {
  channel: "stable",
  status: "idle",
  currentVersion: "1.0.0",
  availableVersion: null,
  progress: null,
  checkedAt: null,
  error: null,
};

function render(state: UpdateState, restartBlocked = false, actionPending?: UpdateAction, actionError?: string): string {
  return renderToStaticMarkup(
    <UpdateStatusNotice state={state} restartBlocked={restartBlocked} actionPending={actionPending} actionError={actionError} onRetry={() => undefined} onInstall={() => undefined} />,
  );
}

describe("UpdateStatusNotice", () => {
  it.each(["disabled", "idle", "checking", "up-to-date"] as const)("stays unobtrusive in %s state", (status) => {
    expect(render({ ...base, status })).toBe("");
  });

  it("renders bounded download progress", () => {
    const html = render({
      ...base,
      status: "downloading",
      availableVersion: "1.1.0",
      progress: { percent: 51.5, bytesPerSecond: 100, transferred: 515, total: 1_000 },
    });
    expect(html).toContain("v1.1.0");
    expect(html).toContain("52%");
    expect(html).toContain("width:52%");
  });

  it("blocks restart while a conversation is active", () => {
    const html = render({ ...base, status: "downloaded", availableVersion: "1.1.0" }, true);
    expect(html).toContain("disabled");
    expect(html).toContain("当前任务完成后即可重启更新");
  });

  it("shows a safe retry action without raw updater details", () => {
    const html = render({
      ...base,
      status: "error",
      error: { code: "UPDATE_DOWNLOAD_FAILED", domain: "update", retryable: true, safeMessage: "更新下载失败，当前版本可继续使用。" },
    });
    expect(html).toContain("自动更新失败");
    expect(html).toContain("重试");
    expect(html).not.toContain("https://");
  });

  it("explains an interrupted install without claiming the update succeeded", () => {
    const html = render({
      ...base,
      status: "install-interrupted",
      availableVersion: "1.1.0",
      error: { code: "UPDATE_INSTALL_INTERRUPTED", domain: "update", retryable: true, safeMessage: "上次更新没有完成，当前版本仍可使用。" },
    });
    expect(html).toContain("上次更新未完成");
    expect(html).toContain("重新下载");
    expect(html).not.toContain("已更新至");
  });

  it("keeps manual checking visible and prevents duplicate actions", () => {
    const html = render({ ...base, status: "checking" }, false, "retry");
    expect(html).toContain("正在检查更新");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("disabled");
    expect(html).not.toContain("自动更新失败");
  });

  it("keeps real download progress visible while a manual check awaits download", () => {
    const html = render({ ...base, status: "downloading", availableVersion: "1.1.0", progress: { percent: 42, bytesPerSecond: 10, transferred: 42, total: 100 } }, false, "retry");
    expect(html).toContain("42%");
    expect(html).not.toContain("检查中");
    expect(render({ ...base, status: "installing" }, false, "install")).toContain("正在重启并安装更新");
  });

  it("explains that restart is waiting for saved data", () => {
    const html = render({ ...base, status: "downloaded", availableVersion: "1.1.0" }, false, "install");
    expect(html).toContain("正在准备重启更新");
    expect(html).toContain("正在保存资料");
    expect(html).toContain("disabled");
  });

  it("preserves the ready update and displays a failed save", () => {
    const html = render({ ...base, status: "downloaded", availableVersion: "1.1.0" }, false, undefined, "资料未能保存，请先保存后再重启更新。");
    expect(html).toContain("v1.1.0 已准备好");
    expect(html).toContain("资料未能保存");
    expect(html).toContain("重启更新");
    expect(html).not.toContain("正在重启并安装更新");
  });
});
