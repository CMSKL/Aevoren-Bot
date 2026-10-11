import { describe, expect, it } from "vitest";
import type { AppError, RuntimeRun, TranscriptEntry } from "@shared/contracts";
import { latestRuntimeAttempts, mergeRuntimeRun, mergeTranscriptEntry, recoveredRuntimeError, runtimeTaskKey } from "./runtime-state";

function entry(updatedSeq: number, body: string): TranscriptEntry {
  return {
    id: "entry",
    sessionId: "session",
    generation: 1,
    seq: 1,
    clientNonce: null,
    role: "assistant",
    body,
    status: "streaming",
    sendState: null,
    speakerBotId: null,
    speakerNameSnapshot: null,
    sourceTurnId: null,
    updatedSeq,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function run(version: number, state: RuntimeRun["state"]): RuntimeRun {
  return {
    id: "run",
    sessionId: "session",
    clientNonce: "nonce",
    executorBotId: "bot",
    executionKey: "nonce",
    attemptNo: 1,
    state,
    route: "fake",
    providerInstanceId: "fake",
    providerModelId: "",
    inputGeneration: 1,
    inputSeq: 1,
    promptCutoffSeq: 1,
    assistantEntryId: "entry",
    providerRequestId: "request",
    promptManifest: {
      schemaVersion: 1,
      botId: "bot",
      profileVersion: 1,
      sessionId: "session",
      generation: 1,
      inputSeq: 1,
      blocks: [],
      digest: "digest",
    },
    version,
    lastErrorCode: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    acceptedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    finishedAt: null,
  };
}

describe("renderer runtime reconciliation", () => {
  it("uses the latest attempt for each task without merging sessions or peer executions", () => {
    const failed = run(4, "failed");
    const retried = { ...run(2, "completed"), id: "retry", attemptNo: 2 };
    const anotherSession = { ...failed, id: "other-session", sessionId: "another-session" };
    const peer = { ...failed, id: "peer", executionKey: "peer-execution" };
    const latest = latestRuntimeAttempts([retried, peer, failed, anotherSession]);
    expect(latest.size).toBe(3);
    expect(latest.get(runtimeTaskKey(failed))).toBe(retried);
    expect(latest.get(runtimeTaskKey(peer))).toBe(peer);
    expect(latest.get(runtimeTaskKey(anotherSession))).toBe(anotherSession);
    expect(runtimeTaskKey({ ...failed, executionKey: "" })).toBe(runtimeTaskKey(failed));
  });

  it("clears only the exact error recovered by a successful attempt of the same task", () => {
    const error: AppError = { domain: "runtime", code: "MODEL_FAILED", safeMessage: "未完成", retryable: true };
    const source = { error, run: run(2, "failed") };
    const success = { ...run(4, "completed"), id: "retry", attemptNo: 2 };
    expect(recoveredRuntimeError(error, source, success)).toBeNull();
    expect(recoveredRuntimeError({ ...error }, source, success)).toEqual(error);
    expect(recoveredRuntimeError(error, source, { ...success, sessionId: "other" })).toBe(error);
    expect(recoveredRuntimeError(error, source, { ...success, executionKey: "other-task" })).toBe(error);
    expect(recoveredRuntimeError(error, source, { ...success, state: "running" })).toBe(error);
    expect(recoveredRuntimeError(error, source, { ...success, state: "failed" })).toBe(error);
    expect(recoveredRuntimeError(error, { error, run: { ...source.run, attemptNo: 3 } }, success)).toBe(error);
    expect(recoveredRuntimeError(error, null, success)).toBe(error);
    const sendError = { ...error };
    const beforeRun = { sessionId: "session", clientNonce: "nonce", executionKey: "nonce", attemptNo: 0 };
    expect(recoveredRuntimeError(sendError, { error: sendError, run: beforeRun }, success)).toBeNull();
    expect(recoveredRuntimeError(error, { error: sendError, run: beforeRun }, success)).toBe(error);
  });

  it("ignores 100 duplicate and stale transcript updates", () => {
    let entries = [entry(2, "new")];
    for (let index = 0; index < 100; index += 1) entries = mergeTranscriptEntry(entries, entry(1, "old"));
    expect(entries).toEqual([entry(2, "new")]);
  });

  it("never lets an older runtime version reverse a terminal state", () => {
    let runs = [run(4, "completed")];
    for (let index = 0; index < 100; index += 1) runs = mergeRuntimeRun(runs, run(3, "streaming"));
    expect(runs[0]).toMatchObject({ version: 4, state: "completed" });
  });
});
