import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { UpdateState } from "@shared/contracts";
import { UpdateStatusNotice } from "./UpdateStatusNotice";
import { UPDATE_TASKS_RUNNING_MESSAGE, type UpdateAction } from "../update-actions";

const base: UpdateState = {
  channel: "stable",
  status: "idle",
  currentVersion: "1.0.0",
  availableVersion: null,
  progress: null,
  checkedAt: null,
  error: null,
};

function render(state: UpdateState | null, restartBlocked = false, actionPending?: UpdateAction, actionError?: string): string {
  return renderToStaticMarkup(
    <UpdateStatusNotice state={state} restartBlocked={restartBlocked} actionPending={actionPending} actionError={actionError} onRetry={() => undefined} onInstall={() => undefined} />,
  );
}

describe("UpdateStatusNotice", () => {
  it.each(["disabled", "idle", "checking", "available", "downloading", "installing", "install-interrupted", "up-to-date", "updated", "error"] as const)("does not interrupt the user in %s state", (status) => {
    expect(render({ ...base, status, availableVersion: "1.1.0" })).toBe("");
  });

  it("requires an actual ready version", () => {
    expect(render(null)).toBe("");
    expect(render({ ...base, status: "downloaded" })).toBe("");
  });

  it("only shows the minimal ready notification", () => {
    const html = render({ ...base, status: "downloaded", availableVersion: "1.1.0" });
    expect(html).toContain("新版本已就绪");
    expect(html).toContain("v1.1.0");
    expect(html).toContain("重启更新");
    expect(html).toContain('aria-label="关闭更新提示"');
    expect(html).not.toContain("稍后");
    expect(html).not.toContain("查看更新内容");
    expect(html).not.toContain("自动更新失败");
  });

  it("blocks restarting while a task is active without adding explanatory content", () => {
    const html = render({ ...base, status: "downloaded", availableVersion: "1.1.0" }, true);
    expect(html).toContain("disabled");
    expect(html).toContain('title="当前任务完成后可重启更新"');
  });

  it("does not display manual checking or download progress globally", () => {
    expect(render({ ...base, status: "checking" }, false, "retry")).toBe("");
    expect(render({ ...base, status: "downloading", availableVersion: "1.1.0", progress: { percent: 42, bytesPerSecond: 10, transferred: 42, total: 100 } }, false, "retry")).toBe("");
  });

  it("keeps a preparing action visible and disabled while saving data", () => {
    const html = render({ ...base, status: "downloaded", availableVersion: "1.1.0" }, false, "install");
    expect(html).toContain("准备中…");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('title="正在保存资料并准备更新"');
    expect(html.match(/disabled/g)).toHaveLength(2);
  });

  it("preserves a ready version after failed installation and never claims completion", () => {
    const html = render({ ...base, status: "downloaded", availableVersion: "1.1.0" }, false, undefined, "资料未能保存，请先保存后再重启更新。");
    expect(html).toContain("新版本已就绪");
    expect(html).toContain("更新未能启动，请重试。");
    expect(html).toContain("重启更新");
    expect(html).not.toContain("已更新至");
  });

  it("never exposes technical error details in the compact notification", () => {
    const html = render({ ...base, status: "downloaded", availableVersion: "1.1.0" }, false, undefined, "Error: No handler registered at /private/internal/path");
    expect(html).toContain("更新未能启动，请重试。");
    expect(html).not.toContain("No handler registered");
    expect(html).not.toContain("/private/internal/path");
  });

  it("gives a minimal actionable hint when a different conversation is running", () => {
    const html = render({ ...base, status: "downloaded", availableVersion: "1.1.0" }, false, undefined, UPDATE_TASKS_RUNNING_MESSAGE);
    expect(html).toContain("任务完成后再更新");
    expect(html).not.toContain("更新未能启动，请重试。");
    expect(html).not.toContain("已更新至");
  });
});
