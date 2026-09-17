import { describe, expect, it } from "vitest";
import type { RuntimeRun, TranscriptEntry } from "@shared/contracts";
import { mergeRuntimeRun, mergeTranscriptEntry } from "./runtime-state";

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
