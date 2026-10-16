import type { ApiResult, ResourceReference } from "./contracts";
import type { MessageMediaReference } from "./media-contracts";

export type RealtimeState = "connecting" | "ready" | "listening" | "transcribing" | "responding" | "delegating" | "interrupting" | "stopped" | "failed" | "interrupted_unknown";
export type RealtimeTaskLink = { kind: "runtime" | "room"; id: string };
export type RealtimeSession = {
  id: string; sessionId: string; executorBotId: string; inputGeneration: number;
  configurationVersion: number; model: string; voice: string; protocol: "realtime-v1";
  state: RealtimeState; version: number; captureId: string; currentTurnId: string | null;
  playbackEpoch: number; responseId: string | null; itemId: string | null; contentIndex: number | null;
  receivedSamples: number; playedSamples: number; linkedTask: RealtimeTaskLink | null;
  lastErrorCode: string | null; createdAt: string; updatedAt: string;
};
export type RealtimeTurn = {
  id: string; voiceSessionId: string; index: number;
  state: "recording" | "transcribing" | "ready" | "responding" | "delegating" | "completed" | "cancelled" | "failed" | "interrupted_unknown";
  inputItemId: string | null; transcript: string | null; transcriptDigest: string | null;
  linkedTask: RealtimeTaskLink | null; createdAt: string; updatedAt: string;
};
/** Routing and references are explicitly selected by the human before capture. */
export type RealtimeStartInput = {
  sessionId: string; executorBotId: string; expectedConfigVersion: number;
  routingMode: "automatic" | "explicit" | "everyone"; targetBotIds: string[];
  resourceRefs?: ResourceReference[]; mediaRefs?: MessageMediaReference[];
};
export type RealtimeInput = { sessionId: string; id: string };
export type RealtimeAppendInput = RealtimeInput & { captureId: string; sequence: number; dataBase64: string };
export type RealtimeCommitInput = RealtimeInput & { captureId: string; lastSequence: number };
export type RealtimePlaybackAck = RealtimeInput & {
  playbackEpoch: number; responseId: string; itemId: string; contentIndex: number; playedSamples: number;
};
export type RealtimeSnapshot = { session: RealtimeSession; turns: RealtimeTurn[] };
/** PCM is transient transport data; it is never a durable receipt or transcript entry. */
export type RealtimeEvent =
  | { type: "snapshot"; snapshot: RealtimeSnapshot }
  | { type: "audio"; sessionId: string; id: string; playbackEpoch: number; responseId: string; itemId: string; contentIndex: number; dataBase64: string };
export type RealtimeApi = {
  start(input: RealtimeStartInput): Promise<ApiResult<RealtimeSnapshot>>;
  append(input: RealtimeAppendInput): Promise<ApiResult<void>>;
  commitTurn(input: RealtimeCommitInput): Promise<ApiResult<RealtimeSnapshot>>;
  playbackAck(input: RealtimePlaybackAck): Promise<ApiResult<void>>;
  interrupt(input: RealtimePlaybackAck): Promise<ApiResult<RealtimeSnapshot>>;
  stop(input: RealtimeInput): Promise<ApiResult<RealtimeSnapshot>>;
  snapshot(input: RealtimeInput): Promise<ApiResult<RealtimeSnapshot>>;
  stopTask(input: RealtimeInput): Promise<ApiResult<RealtimeSnapshot>>;
  onChanged(listener: (event: RealtimeEvent) => void): () => void;
};
