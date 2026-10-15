import { z } from "zod";
import { messageMediaReferenceSchema } from "./media-schemas";
import { SEARCH_KINDS } from "./search-contracts";
const id = z.string().uuid(), digest = z.string().regex(/^[a-f0-9]{64}$/u), positive = z.number().int().positive();
const base = { sessionId: id, authorityDigest: digest };
export const searchScopeSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("all") }).strict(), z.object({ kind: z.literal("session"), sessionId: id }).strict(), z.object({ kind: z.literal("project"), projectId: id }).strict()]);
export const searchQuerySchema = z.object({ query: z.string().trim().min(1).max(200), scope: searchScopeSchema.optional(), kinds: z.array(z.enum(SEARCH_KINDS)).min(1).max(7).refine(items => new Set(items).size === items.length).optional(), cursor: z.string().min(1).max(2048).optional(), limit: z.number().int().min(1).max(100).optional() }).strict();
export const searchSourceSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("message"), id, generation: positive, seq: positive, digest }).strict(),
  z.object({ ...base, type: z.literal("document"), id, revisionId: id, digest }).strict(),
  z.object({ ...base, type: z.literal("skill"), id, revisionId: id, digest }).strict(),
  z.object({ ...base, type: z.literal("media"), id, reference: messageMediaReferenceSchema, digest }).strict(),
  z.object({ ...base, type: z.literal("voice-transcript"), id, generation: positive, digest }).strict(),
  z.object({ ...base, type: z.literal("realtime-transcript"), id, voiceSessionId: id, generation: positive, digest }).strict(),
  z.object({ ...base, type: z.literal("task"), id, version: positive, digest }).strict(),
  z.object({ ...base, type: z.literal("routine"), id, version: positive, digest }).strict(),
  z.object({ ...base, type: z.literal("local-draft"), id, revisionId: id, executorBotId: id, digest }).strict(),
]);
export const searchOpenSchema = z.object({ source: searchSourceSchema }).strict();
