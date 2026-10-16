import { describe, expect, it, vi } from "vitest";
import type { ApiResult } from "@shared/contracts";
import type { VoiceApi, VoiceEvent, VoiceTask } from "@shared/voice-contracts";
import { mergeVoiceTask, voiceTextDigest, waitForVoiceTask } from "./voice-ui-state";

function task(patch: Partial<VoiceTask> = {}): VoiceTask {
  return { id: "voice-1", sessionId: "session-1", executorBotId: null, runtimeRunId: null, inputGeneration: 1, kind: "speech", clientNonce: "nonce-1", source: { kind: "text", digest: "a".repeat(64) }, capture: null, configurationVersion: 1, model: "test-speech", voice: "alloy", state: "running", version: 1, transcript: null, audio: null, lastErrorCode: null, createdAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T00:00:00.000Z", ...patch };
}
function fixture(): { api: Pick<VoiceApi, "get" | "onChanged">; emit(event: VoiceEvent): void; reply(value: ApiResult<VoiceTask>): void; unsubscribe: ReturnType<typeof vi.fn> } {
  let listener: ((event: VoiceEvent) => void) | undefined;
  let reply!: (value: ApiResult<VoiceTask>) => void;
  const response = new Promise<ApiResult<VoiceTask>>(resolve => { reply = resolve; });
  const unsubscribe = vi.fn(() => { listener = undefined; });
  const api: Pick<VoiceApi, "get" | "onChanged"> = { get: vi.fn(() => response), onChanged: callback => { listener = callback; return unsubscribe; } };
  return { api, emit: event => listener?.(event), reply, unsubscribe };
}

describe("voice UI state", () => {
  it("hashes the exact raw message text, including whitespace", async () => {
    expect(await voiceTextDigest("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await voiceTextDigest("abc\n")).not.toBe(await voiceTextDigest("abc"));
  });
  it("keeps a terminal task when an older running snapshot arrives", () => {
    const completed = task({ state: "completed", version: 3 });
    const current = [completed];
    expect(mergeVoiceTask(current, task({ version: 2 }))).toBe(current);
    expect(mergeVoiceTask(current, task({ version: 4, state: "cancelled" }))[0]?.state).toBe("cancelled");
  });
  it("receives completion while the initial get is still pending and unsubscribes", async () => {
    const f = fixture(), completed = task({ state: "completed", version: 2 });
    const pending = waitForVoiceTask(f.api, { sessionId: "session-1", id: "voice-1" }, new AbortController().signal);
    f.emit({ task: completed });
    await expect(pending).resolves.toEqual(completed);
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    f.reply({ ok: true, data: task() });
  });
  it("accepts a completed persisted snapshot without requiring a new event", async () => {
    const f = fixture(), completed = task({ state: "completed", version: 2 });
    const pending = waitForVoiceTask(f.api, { sessionId: "session-1", id: "voice-1" }, new AbortController().signal);
    f.reply({ ok: true, data: completed });
    await expect(pending).resolves.toEqual(completed);
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });
  it("ignores another session and task, and rejects a real failed terminal state", async () => {
    const f = fixture();
    const pending = waitForVoiceTask(f.api, { sessionId: "session-1", id: "voice-1" }, new AbortController().signal);
    f.emit({ task: task({ sessionId: "session-2", state: "completed" }) });
    f.emit({ task: task({ id: "voice-2", state: "completed" }) });
    f.reply({ ok: true, data: task() });
    f.emit({ task: task({ state: "interrupted_unknown", version: 2, lastErrorCode: "VOICE_RESULT_UNKNOWN" }) });
    await expect(pending).rejects.toThrow("VOICE_RESULT_UNKNOWN");
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });
  it("aborts locally without waiting for a remote response and removes its listener", async () => {
    const f = fixture(), controller = new AbortController();
    const pending = waitForVoiceTask(f.api, { sessionId: "session-1", id: "voice-1" }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    f.reply({ ok: true, data: task({ state: "completed" }) });
  });
});
