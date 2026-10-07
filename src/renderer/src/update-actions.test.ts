import { describe, expect, it } from "vitest";
import { updateActionErrorMessage } from "./update-actions";

describe("update action messages", () => {
  it("uses a known safe update message instead of returned technical details", () => {
    expect(updateActionErrorMessage("install", {
      code: "UPDATE_NOT_READY", domain: "update", retryable: false,
      safeMessage: "Error: raw stack at https://private.invalid/?token=secret",
    })).toBe("更新尚未下载完成，请稍后重试。");
  });

  it.each(["check", "retry", "install"] as const)("handles rejected %s requests without exposing exceptions", (action) => {
    const message = updateActionErrorMessage(action);
    expect(message).toContain("当前版本可继续使用");
    expect(message).not.toContain("Error");
  });

  it("does not trust an unknown error code or domain", () => {
    expect(updateActionErrorMessage("retry", {
      code: "UNKNOWN", domain: "internal", retryable: false, safeMessage: "debug details",
    })).toBe("检查更新失败，当前版本可继续使用。");
    expect(updateActionErrorMessage("retry", {
      code: "toString", domain: "update", retryable: false, safeMessage: "debug details",
    })).toBe("检查更新失败，当前版本可继续使用。");
  });
});
