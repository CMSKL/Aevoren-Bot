import { z } from "zod";
import { environmentScopeSchema } from "./environment-schemas";

const id = z.string().uuid();
const version = z.number().int().positive();
const resourceId = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/u);
export const connectorProviderSchema = z.enum(["gmail", "drive", "notion"]);
export const connectorConfigureSchema = z.object({ id: id.optional(), expectedVersion: version.optional(), provider: connectorProviderSchema,
  name: z.string().trim().min(1).max(200), clientId: z.string().min(1).max(300).optional(), clientSecret: z.string().min(1).max(2048).optional(),
  token: z.string().min(1).max(4096).optional() }).strict().superRefine((input, ctx) => {
    if (Boolean(input.id) !== Boolean(input.expectedVersion)) ctx.addIssue({ code: "custom", message: "Version required for existing connection" });
    if (input.provider === "notion" ? !input.token || input.clientId !== undefined || input.clientSecret !== undefined : !input.clientId || input.token !== undefined)
      ctx.addIssue({ code: "custom", message: "Provider credentials required" });
  });
export const connectorIdSchema = z.object({ id, expectedVersion: version }).strict();
export const connectorListSchema = z.object({ provider: connectorProviderSchema.optional() }).strict();
export const connectorBindingsSchema = environmentScopeSchema.extend({ includeRevoked: z.boolean().optional() }).strict();
export const connectorBindSchema = environmentScopeSchema.extend({ connectionId: id, expectedAuthVersion: version,
  allowedResourceIds: z.array(resourceId).max(500).optional(), expectedVersion: version.optional() }).strict();
export const connectorUnbindSchema = environmentScopeSchema.extend({ id, expectedVersion: version }).strict();
export const connectorAccessSchema = environmentScopeSchema.extend({ connectionId: id, expectedAuthVersion: version, expectedBindingVersion: version }).strict();
export const connectorSearchSchema = connectorAccessSchema.extend({ query: z.string().max(2000).refine(value => !value.includes("\0")), cursor: z.string().max(2048).optional(), limit: z.number().int().min(1).max(100).optional() }).strict();
export const connectorReadSchema = connectorAccessSchema.extend({ resourceId }).strict();
const address = z.string().max(320).email().refine(value => !/[\r\n]/u.test(value));
export const connectorDraftContentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("gmail-message"), to: z.array(address).min(1).max(100), cc: z.array(address).max(100), subject: z.string().max(998).refine(value => !/[\r\n\0]/u.test(value)), body: z.string().max(100_000) }).strict(),
  z.object({ kind: z.literal("drive-text"), targetFileId: resourceId.nullable(), title: z.string().min(1).max(1024), text: z.string().max(100_000) }).strict(),
  z.object({ kind: z.literal("notion-page"), parentPageId: z.string().regex(/^[A-Fa-f0-9]{32}$|^[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}$/u), title: z.string().min(1).max(1024), text: z.string().max(100_000) }).strict(),
]);
export const connectorDraftCreateSchema = connectorAccessSchema.extend({ content: connectorDraftContentSchema, clientNonce: id.optional() }).strict();
export const connectorDraftUpdateSchema = environmentScopeSchema.extend({ id, expectedVersion: version, content: connectorDraftContentSchema }).strict();
export const connectorDraftReadSchema = environmentScopeSchema.extend({ id, revisionId: id.optional() }).strict();
export const connectorDraftDeleteSchema = environmentScopeSchema.extend({ id, expectedVersion: version }).strict();

export const connectorIdentitySchema = z.object({ accountId: z.string().min(1).max(256), displayName: z.string().max(512), email: z.string().email().max(320).optional() }).strict();
