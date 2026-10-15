import { z } from "zod";
import { environmentScopeSchema } from "./environment-schemas";
import { connectorDraftContentSchema, connectorIdentitySchema } from "./native-connector-schemas";
const id = z.string().uuid(), version = z.number().int().positive(), digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const nativeWriteOperationSchema = z.enum(["gmail-send", "drive-create-text", "drive-update-text", "notion-create-page"]);
export const nativeWriteGrantSchema = environmentScopeSchema.extend({ connectionId: id, expectedAuthVersion: version, operation: nativeWriteOperationSchema,
  targetIds: z.array(z.string().min(1).max(320).refine(value => !/[\r\n\0]/u.test(value))).max(500), expectedVersion: version.optional() }).strict();
export const nativeWriteRevokeSchema = environmentScopeSchema.extend({ id, expectedVersion: version }).strict();
export const nativeOutboundPrepareSchema = environmentScopeSchema.extend({ draftId: id, revisionId: id, expectedDraftVersion: version, grantId: id, expectedGrantVersion: version }).strict();
export const nativeOutboundIdSchema = environmentScopeSchema.extend({ id, expectedVersion: version }).strict();
export const externalDraftReviewSnapshotSchema = z.object({ kind: z.literal("external-draft"), connectionName: z.string().min(1).max(200), provider: z.enum(["gmail", "drive", "notion"]),
  account: connectorIdentitySchema, connectionId: id, authVersion: version, grantId: id, grantVersion: version, draftId: id,
  revisionId: id, revisionNumber: version, revisionDigest: digest, operation: nativeWriteOperationSchema, targetIds: z.array(z.string().max(320)).max(500),
  content: connectorDraftContentSchema, intentId: id, expectedIntentVersion: version, observedTargetVersion: z.string().max(30).optional(), targetDigest: digest }).strict()
  .refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 360_000, "Approval review exceeds 360 KB");
