import { describe, expect, it, vi } from "vitest";
import { DeviceToolExecutor } from "./device-tool-executor";

describe("DeviceToolExecutor", () => {
  it("reads bounded clipboard text with provenance and no hidden persistence", async () => {
    const read = vi.fn().mockResolvedValue("SECRET_CLIPBOARD_TEXT");
    const result = await new DeviceToolExecutor(read, () => new Date("2026-09-17T08:00:00.000Z")).run(
      { kind: "clipboard-read", maxCharacters: 6 },
      new AbortController().signal,
    );
    expect(JSON.parse(result.content)).toEqual({
      untrusted: true,
      source: "system-clipboard",
      retrievedAt: "2026-09-17T08:00:00.000Z",
      text: "SECRET",
      truncated: true,
    });
    expect(result.metadata).toEqual({
      kind: "clipboard-read",
      provider: "system-clipboard",
      retrievedAt: "2026-09-17T08:00:00.000Z",
      characters: 6,
      truncated: true,
    });
    expect(read).toHaveBeenCalledOnce();
  });

  it("does not read after cancellation", async () => {
    const read = vi.fn();
    const controller = new AbortController();
    controller.abort();
    await expect(new DeviceToolExecutor(read).run({ kind: "clipboard-read", maxCharacters: 10 }, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(read).not.toHaveBeenCalled();
  });
});
