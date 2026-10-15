import type { ApiResult, MediaRef } from "./contracts";
import type { MessageMediaReference } from "./media-contracts";

export type VoiceConfigurationKind = "stt" | "tts" | "realtime";
/** No secret or account key is returned through this DTO. */
export type VoiceConfiguration = {
  kind: VoiceConfigurationKind; version: number; provider: "openai"; enabled: boolean;
  model: string; voice: string; keyConfigured: boolean; updatedAt: string;
};
/** Trusted settings IPC only; never included in the model's product schemas. */
export type VoiceConfigurationSave = {
  kind: VoiceConfigurationKind; expectedVersion: number; enabled: boolean; model: string; voice: string;
  apiKey?: string; clearApiKey?: boolean;
};
export type VoiceScope = { sessionId: string };
export type VoiceCaptureOrigin = { captureId: string; draftVersion: number; baseDigest: string };
export type VoiceCaptureIntent = VoiceScope & VoiceCaptureOrigin & { expiresAt: string };
export type VoiceCaptureBegin = VoiceScope & { draftVersion: number; baseDigest: string };
export type VoiceCaptureCommit = VoiceScope & VoiceCaptureOrigin & { mimeType: string; dataBase64: string };
export type VoiceTaskState = "prepared" | "running" | "completed" | "failed" | "cancelled" | "interrupted_unknown";
export type VoiceTaskSource = { kind: "media"; reference: MessageMediaReference } | { kind: "entry"; entryId: string; digest: string } | { kind: "text"; digest: string };
export type VoiceTask = {
  id: string; sessionId: string; executorBotId: string | null; runtimeRunId: string | null; inputGeneration: number;
  kind: "transcription" | "speech"; clientNonce: string; source: VoiceTaskSource; capture: VoiceCaptureOrigin | null;
  configurationVersion: number; model: string; voice: string; state: VoiceTaskState; version: number;
  transcript: string | null; audio: MediaRef | null; lastErrorCode: string | null; createdAt: string; updatedAt: string;
};
export type VoiceTranscribeInput = VoiceScope & {
  clientNonce: string; expectedConfigVersion: number; media: MessageMediaReference; capture?: VoiceCaptureOrigin;
};
export type VoiceSpeechInput = VoiceScope & {
  clientNonce: string; expectedConfigVersion: number; source: { entryId: string; digest: string } | { text: string };
};
export type VoiceTaskInput = VoiceScope & { id: string };
export type VoiceTaskListInput = VoiceScope & { limit?: number };
export type VoiceAudio = { task: VoiceTask; reference: MediaRef; dataBase64: string };
export type VoiceEvent = { task: VoiceTask; delta?: string };
export type VoiceApi = {
  configurations(): Promise<ApiResult<VoiceConfiguration[]>>;
  saveConfiguration(input: VoiceConfigurationSave): Promise<ApiResult<VoiceConfiguration>>;
  beginCapture(input: VoiceCaptureBegin): Promise<ApiResult<VoiceCaptureIntent>>;
  commitCapture(input: VoiceCaptureCommit): Promise<ApiResult<MessageMediaReference>>;
  cancelCapture(input: VoiceScope & { captureId: string }): Promise<ApiResult<void>>;
  transcribe(input: VoiceTranscribeInput): Promise<ApiResult<VoiceTask>>;
  speak(input: VoiceSpeechInput): Promise<ApiResult<VoiceTask>>;
  get(input: VoiceTaskInput): Promise<ApiResult<VoiceTask>>;
  list(input: VoiceTaskListInput): Promise<ApiResult<VoiceTask[]>>;
  stop(input: VoiceTaskInput): Promise<ApiResult<VoiceTask>>;
  audio(input: VoiceTaskInput): Promise<ApiResult<VoiceAudio>>;
  onChanged(listener: (event: VoiceEvent) => void): () => void;
};
