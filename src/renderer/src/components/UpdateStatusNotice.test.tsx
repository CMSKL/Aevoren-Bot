import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { UpdateState } from "@shared/contracts";
import { UpdateStatusNotice } from "./UpdateStatusNotice";

const base: UpdateState = {
  channel: "stable",
  status: "idle",
  currentVersion: "1.0.0",
  availableVersion: null,
  progress: null,
  checkedAt: null,
  error: null,
};

function render(state: UpdateState, restartBlocked = false): string {
  return renderToStaticMarkup(
    <UpdateStatusNotice state={state} restartBlocked={restartBlocked} onRetry={() => undefined} onInstall={() => undefined} />,
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
});
