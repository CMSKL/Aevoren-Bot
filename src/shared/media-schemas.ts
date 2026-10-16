import { z } from "zod";

export const MEDIA_MAX_FILES = 6;
export const MEDIA_IMPORT_MAX_BYTES = 32 * 1_048_576;
export const MEDIA_IMAGE_MAX_BYTES = 2 * 1_048_576;
export const MEDIA_PDF_MAX_BYTES = 16 * 1_048_576;
export const MEDIA_DOCX_MAX_BYTES = 8 * 1_048_576;
export const MEDIA_AV_MAX_BYTES = 16 * 1_048_576;
export const MEDIA_AV_MAX_DURATION_MS = 600_000;
export const MEDIA_TEXT_MAX_BYTES = 512 * 1_024;
export const MEDIA_MAX_IMAGE_PIXELS = 16_000_000;
export const MEDIA_MAX_PDF_PAGES = 200;
export const MEDIA_PARSE_TIMEOUT_MS = 30_000;
export const MEDIA_ZIP_MAX_ENTRIES = 2_000;
export const MEDIA_ZIP_ENTRY_MAX_BYTES = 16 * 1_048_576;
export const MEDIA_ZIP_TOTAL_MAX_BYTES = 64 * 1_048_576;
const id = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
export const supportedMediaMimeSchema = z.enum(["image/png", "image/jpeg", "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "audio/wav", "audio/mpeg", "audio/ogg", "video/ogg", "audio/webm", "video/webm", "audio/mp4", "video/mp4"]);
export const messageMediaReferenceSchema = z.object({ mediaId: id, sha256, extraction: z.object({ id, digest: sha256 }).strict().optional() }).strict();
export const messageMediaReferencesSchema = z.array(messageMediaReferenceSchema).max(MEDIA_MAX_FILES)
  .refine(refs => new Set(refs.map(ref => ref.mediaId)).size === refs.length, "Media references must be unique");
export const mediaSpanSchema = z.object({ kind: z.enum(["page", "section"]), index: z.number().int().min(0), start: z.number().int().min(0), end: z.number().int().min(0) }).strict()
  .refine(span => span.end >= span.start, "Invalid media text span");
export const mediaTextSchema = z.string().max(MEDIA_TEXT_MAX_BYTES).refine(text => {
  const bytes = new TextEncoder().encode(text);
  return bytes.byteLength <= MEDIA_TEXT_MAX_BYTES && new TextDecoder("utf-8", { fatal: true }).decode(bytes) === text;
}, "Media text exceeds its budget or is not well-formed Unicode");
export const mediaScopeSchema = z.object({ sessionId: id }).strict();
export const mediaListSchema = mediaScopeSchema.extend({ query: z.string().trim().max(200).optional(), includeDisabled: z.boolean().optional(), includeDeleted: z.boolean().optional() });
export const mediaAvailableSchema = mediaListSchema.omit({ sessionId: true });
export const mediaIdSchema = mediaScopeSchema.extend({ id });
export const mediaReadSchema = mediaIdSchema.extend({ reference: messageMediaReferenceSchema.optional(), offset: z.number().int().min(0).max(MEDIA_TEXT_MAX_BYTES).optional(), maxCharacters: z.number().int().min(1).max(32_000).optional() })
  .refine(input => !input.reference || input.reference.mediaId === input.id, "Media reference must match its ID");
export const mediaPreviewSchema = mediaIdSchema.extend({ reference: messageMediaReferenceSchema.optional(), pageIndex: z.number().int().min(0).max(MEDIA_MAX_PDF_PAGES - 1).optional() })
  .refine(input => !input.reference || input.reference.mediaId === input.id, "Media reference must match its ID");
export const mediaMutationSchema = mediaIdSchema.extend({ expectedVersion: z.number().int().positive() });
export const mediaSetEnabledSchema = mediaMutationSchema.extend({ enabled: z.boolean() });
export const mediaImportPathSchema = mediaScopeSchema.extend({ workspaceId: id, path: z.string().min(1).max(500) });
