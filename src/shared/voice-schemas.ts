import { z } from "zod";
import { messageMediaReferenceSchema } from "./media-schemas";
export const VOICE_AUDIO_MAX_BYTES = 16 * 1_048_576;
export const VOICE_TEXT_MAX_CHARACTERS = 8_000;
export const VOICE_TRANSCRIPT_MAX_CHARACTERS = 100_000;
const id = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const voiceScopeSchema = z.object({ sessionId: id }).strict();
export const voiceConfigurationKindSchema = z.enum(["stt", "tts", "realtime"]);
export const voiceConfigurationSaveSchema = z.object({ kind: voiceConfigurationKindSchema, expectedVersion: z.number().int().positive(),
  enabled: z.boolean(), model: z.string().trim().min(1).max(100), voice: z.string().trim().min(1).max(100),
  apiKey: z.string().trim().min(1).max(1_024).optional(), clearApiKey: z.boolean().optional(),
}).strict().refine(input => !input.apiKey || !input.clearApiKey, "Choose a key or clear it");
/** Model-visible settings patch preserves the existing host key reference. */
export const voiceConfigurationPatchSchema = z.object({
  kind: voiceConfigurationSaveSchema.shape.kind, expectedVersion: voiceConfigurationSaveSchema.shape.expectedVersion,
  enabled: voiceConfigurationSaveSchema.shape.enabled, model: voiceConfigurationSaveSchema.shape.model, voice: voiceConfigurationSaveSchema.shape.voice,
}).strict();
export const voiceCaptureOriginSchema = z.object({ captureId: id, draftVersion: z.number().int().nonnegative(), baseDigest: digest }).strict();
export const voiceCaptureBeginSchema = voiceScopeSchema.extend({ draftVersion: z.number().int().nonnegative(), baseDigest: digest });
export const voiceCaptureCommitSchema = voiceScopeSchema.extend({ ...voiceCaptureOriginSchema.shape, mimeType: z.string().min(1).max(100),
  dataBase64: z.string().min(1).max(Math.ceil(VOICE_AUDIO_MAX_BYTES / 3) * 4) });
export const voiceCaptureCancelSchema = voiceScopeSchema.extend({ captureId: id });
export const voiceTranscribeSchema = voiceScopeSchema.extend({ clientNonce: id, expectedConfigVersion: z.number().int().positive(), media: messageMediaReferenceSchema, capture: voiceCaptureOriginSchema.optional() });
export const voiceSpeechSchema = voiceScopeSchema.extend({ clientNonce: id, expectedConfigVersion: z.number().int().positive(),
  source: z.union([z.object({ entryId: id, digest }).strict(), z.object({ text: z.string().trim().min(1).max(VOICE_TEXT_MAX_CHARACTERS) }).strict()]) });
export const voiceTaskSchema = voiceScopeSchema.extend({ id });
export const voiceTaskListSchema = voiceScopeSchema.extend({ limit: z.number().int().min(1).max(100).optional() });
