import { describe, expect, it } from "vitest";
import { z } from "zod";
import { asAppError, ERROR_REGISTRY, MsBotError } from "./errors";

describe("error registry", () => {
  it("maps schema errors to a stable validation envelope", () => {
    const parsed = z.string().uuid().safeParse("not-a-uuid");
    if (parsed.success) throw new Error("expected validation failure");
    expect(asAppError(parsed.error)).toEqual({
      code: "INVALID_REQUEST",
      domain: "validation",
      retryable: false,
      safeMessage: "请求参数不符合要求。",
    });
  });

  it("allows only registered detail keys across the error boundary", () => {
    expect(new MsBotError("BOT_VERSION_CONFLICT", undefined, undefined, {
      currentVersion: 2,
      sql: "SELECT secret",
    }).toAppError()).toEqual({
      code: "BOT_VERSION_CONFLICT",
      domain: "bot",
      retryable: true,
      safeMessage: "Bot 已在别处更新，请重新确认后再保存。",
      details: { currentVersion: 2 },
    });
  });

  it("has a descriptor for every typed error code", () => {
    expect(Object.keys(ERROR_REGISTRY).length).toBeGreaterThan(20);
    for (const descriptor of Object.values(ERROR_REGISTRY)) {
      expect(descriptor.safeMessage.length).toBeGreaterThan(0);
      expect(Array.isArray(descriptor.allowedDetailKeys)).toBe(true);
    }
  });

  it("reclassifies arbitrary errors without leaking their content", () => {
    expect(asAppError(new Error("/secret/path SELECT token"))).toEqual({
      code: "INTERNAL_ERROR",
      domain: "internal",
      retryable: false,
      safeMessage: "操作失败，请稍后重试。",
    });
  });
});
