import { z } from "zod";
import { environmentScopeSchema } from "./environment-schemas";
const id=z.string().uuid(),version=z.number().int().positive(),digest=z.string().regex(/^[a-f0-9]{64}$/u),toolName=z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/u);
export const mcpJsonArgumentsSchema=z.record(z.string(),z.json()).refine(value=>new TextEncoder().encode(JSON.stringify(value)).byteLength<=128000,"Arguments exceed 128 KB");
export const mcpToolCatalogSchema=environmentScopeSchema.extend({serverId:id,expectedServerVersion:version}).strict();
export const mcpToolGrantSchema=mcpToolCatalogSchema.extend({toolName,schemaDigest:digest,expectedVersion:version.optional()}).strict();
export const mcpWriteIdSchema=environmentScopeSchema.extend({id,expectedVersion:version}).strict();
export const mcpWritePrepareSchema=environmentScopeSchema.extend({grantId:id,expectedGrantVersion:version,arguments:mcpJsonArgumentsSchema,
  targetPreview:z.string().trim().min(1).max(2000),clientNonce:id}).strict();
export const mcpWriteReviewSchema=z.object({kind:z.literal("mcp-write"),intentId:id,expectedIntentVersion:version,serverId:id,serverName:z.string().min(1).max(32),
  serverVersion:version,transport:z.enum(["stdio","streamable-http"]),accountNotice:z.string().max(300),toolName,schemaDigest:digest,grantId:id,grantVersion:version,
  arguments:mcpJsonArgumentsSchema,argumentsDigest:digest,targetPreview:z.string().min(1).max(2000)}).strict();
export const mcpAppCloseSchema=environmentScopeSchema.extend({id,expectedEpoch:version}).strict();
