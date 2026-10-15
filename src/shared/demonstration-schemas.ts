import { z } from "zod";
import { browserScopeSchema } from "./browser-schemas";
import { DEMONSTRATION_MAX_EVENTS } from "./demonstration-contracts";
export const demonstrationEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pointer"), x: z.number().int().min(0).max(65535), y: z.number().int().min(0).max(65535), buttons: z.number().int().min(0).max(511) }).strict(),
  z.object({ kind: z.literal("key"), key: z.enum(["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]), down: z.boolean() }).strict(),
  z.object({ kind: z.literal("redacted-text") }).strict(),
]);
export const demonstrationCaptureSchema = z.object({ id: z.string().uuid(), browserSessionId: z.string().uuid(), epoch: z.number().int().positive(), state: z.enum(["recording", "stopped", "interrupted"]), reason: z.enum(["disconnect", "control-changed", "restart", "limit", "unsupported-input"]).nullable(), eventCount: z.number().int().min(0).max(DEMONSTRATION_MAX_EVENTS), createdAt: z.string().datetime(), updatedAt: z.string().datetime() }).strict();
export const demonstrationSnapshotSchema = demonstrationCaptureSchema.extend({ events: z.array(demonstrationEventSchema).max(DEMONSTRATION_MAX_EVENTS) }).strict().refine(value => value.eventCount === value.events.length);
export const demonstrationRecordSchema = browserScopeSchema.extend({ expectedEpoch: z.number().int().positive(), id: z.string().uuid() }).strict();
export const demonstrationDraftInputSchema = browserScopeSchema.extend({ id: z.string().uuid() }).strict();
export const demonstrationDeleteSchema = demonstrationDraftInputSchema.extend({ expectedVersion: z.number().int().positive() }).strict();
export const demonstrationUpdateSchema = demonstrationDraftInputSchema.extend({ expectedVersion: z.number().int().positive(), name: z.string().trim().min(1).max(120), body: z.string().max(64000) }).strict();
export const demonstrationPublishSchema = demonstrationDraftInputSchema.extend({ expectedVersion: z.number().int().positive(), expectedDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();

export const demonstrationApprovalReviewSchema = z.object({ kind: z.literal("demonstration-skill"), resourceName: z.string().min(1).max(120), revisionNumber: z.number().int().positive(), target: browserScopeSchema.extend({ draftId: z.string().uuid(), draftVersion: z.number().int().positive(), draftDigest: z.string().regex(/^[a-f0-9]{64}$/u), body: z.string().max(64000), initiallyEnabled: z.literal(false) }).strict() }).strict();
