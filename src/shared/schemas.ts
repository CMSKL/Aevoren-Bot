import { z } from "zod";
import { BOT_AVATAR_COLORS, BOT_AVATAR_SHAPES } from "./bot-avatar";

const nonEmptyText = z.string().trim().min(1).max(20_000);
const providerInstanceIdSchema = z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9._-]*$/i);
export const workspaceIdSchema = z.string().uuid();
export const modelSelectionSchema = z.object({
  providerInstanceId: providerInstanceIdSchema,
  modelId: z.string().trim().max(200),
}).strict();

export const botUpdateSchema = z.object({
  id: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  patch: z
    .object({
      name: z.string().trim().min(1).max(80).optional(),
      label: z.string().trim().max(120).optional(),
      description: z.string().trim().max(2_000).optional(),
      instructions: z.string().trim().max(20_000).optional(),
      modelSelection: modelSelectionSchema.optional(),
      avatarShape: z.enum(BOT_AVATAR_SHAPES).optional(),
      avatarColor: z.enum(BOT_AVATAR_COLORS).optional(),
      mcpServerIds: z.array(z.string().uuid()).max(20).refine((ids) => new Set(ids).size === ids.length, "MCP server ids must be unique").nullable().optional(),
      memoryWorkspaceIds: z.array(workspaceIdSchema).max(20).refine((ids) => new Set(ids).size === ids.length, "Memory workspace ids must be unique").optional(),
    })
    .refine((patch) => Object.keys(patch).length > 0, "At least one field is required"),
});

export const botIdSchema = z.string().uuid();
export const capabilitySnapshotInputSchema = z.object({
  botId: botIdSchema.optional(),
}).strict().optional();
export const conversationBatchDeleteSchema = z.object({
  botIds: z.array(botIdSchema).max(200),
  roomIds: z.array(z.string().uuid()).max(200),
}).strict().superRefine((input, context) => {
  const count = input.botIds.length + input.roomIds.length;
  if (count < 2 || count > 200) {
    context.addIssue({ code: "custom", message: "Batch delete requires between 2 and 200 conversations" });
  }
  if (new Set(input.botIds).size !== input.botIds.length || new Set(input.roomIds).size !== input.roomIds.length) {
    context.addIssue({ code: "custom", message: "Batch delete ids must be unique" });
  }
});
export const botPinnedSchema = z.object({ id: botIdSchema, pinned: z.boolean() });
export const botUnreadSchema = z.object({ id: botIdSchema, unread: z.boolean() });
export const botHiddenSchema = z.object({ id: botIdSchema, hidden: z.boolean() });
export const memoryIdSchema = z.string().uuid();
const memoryContentSchema = z.string().trim().min(1).max(4_000);
export const memoryKindSchema = z.enum(["fact", "preference", "decision", "procedure"]);
const memoryExpiresAtSchema = z.string().datetime({ offset: true }).nullable();
const legacyMemoryListSchema = z.object({
  botId: botIdSchema,
  includeDeleted: z.boolean().optional(),
}).strict();
const legacyMemoryCreateSchema = z.object({
  botId: botIdSchema,
  content: memoryContentSchema,
  kind: memoryKindSchema.optional(),
  expiresAt: memoryExpiresAtSchema.optional(),
}).strict();
export const memoryScopeSelectorSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("user"), scopeKey: z.literal("user") }).strict(),
  z.object({ scope: z.literal("bot"), scopeKey: botIdSchema }).strict(),
  z.object({ scope: z.literal("workspace"), scopeKey: workspaceIdSchema }).strict(),
]);
export const memoryListSchema = z.union([
  legacyMemoryListSchema,
  memoryScopeSelectorSchema.and(z.object({ includeDeleted: z.boolean().optional() })),
]);
export const memoryCreateSchema = z.union([
  legacyMemoryCreateSchema,
  memoryScopeSelectorSchema.and(z.object({
    content: memoryContentSchema,
    kind: memoryKindSchema.optional(),
    expiresAt: memoryExpiresAtSchema.optional(),
  })),
]);
export const memoryUpdateSchema = z.object({
  id: memoryIdSchema,
  expectedVersion: z.number().int().positive(),
  content: memoryContentSchema,
  kind: memoryKindSchema.optional(),
  expiresAt: memoryExpiresAtSchema.optional(),
}).strict();
export const memoryMutationSchema = z.object({
  id: memoryIdSchema,
  expectedVersion: z.number().int().positive(),
}).strict();
export const memoryProposalListSchema = z.object({
  botId: botIdSchema.optional(),
  state: z.enum(["pending", "accepted", "rejected"]).optional(),
}).strict().optional();
export const memoryProposalAcceptSchema = z.object({
  id: memoryIdSchema,
  expectedVersion: z.number().int().positive(),
  content: memoryContentSchema.optional(),
  kind: memoryKindSchema.optional(),
  expiresAt: memoryExpiresAtSchema.optional(),
}).strict();
export const sessionIdSchema = z.string().uuid();
export const nonceSchema = z.string().uuid();
export const runIdSchema = z.string().uuid();
export const toolInvocationIdSchema = z.string().uuid();
export const approvalIdSchema = z.string().uuid();
export const workspaceMutationSchema = z.object({
  id: workspaceIdSchema,
  expectedVersion: z.number().int().positive(),
}).strict();
export const workspacePermissionsSchema = z.object({
  id: workspaceIdSchema,
  expectedVersion: z.number().int().positive(),
  writeEnabled: z.boolean(),
  automationEnabled: z.boolean(),
}).strict();
export const workspaceRevealSchema = z.object({
  workspaceId: workspaceIdSchema,
  path: z.string().min(1).max(1_024),
}).strict();
export const workspaceRelativePathSchema = z
  .string()
  .max(1_024)
  .superRefine((value, context) => {
    if (value.startsWith("/") || value.startsWith("./") || value.includes("\\") || value.includes("\0")) {
      context.addIssue({ code: "custom", message: "Path must be relative and use POSIX separators" });
      return;
    }
    if (value !== "" && value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
      context.addIssue({ code: "custom", message: "Path contains an unsafe segment" });
    }
  })
  .transform((value) => value.normalize("NFC"));
const workspaceDirectoryPathSchema = z.preprocess(
  (value) => value === "." ? "" : value,
  workspaceRelativePathSchema,
);
export const workspaceToolRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("workspace-list"),
    workspaceId: workspaceIdSchema,
    path: workspaceDirectoryPathSchema.default(""),
    maxEntries: z.number().int().min(1).max(500).default(100),
  }).strict(),
  z.object({
    kind: z.literal("workspace-read"),
    workspaceId: workspaceIdSchema,
    path: workspaceRelativePathSchema,
    maxBytes: z.number().int().min(1).max(1_048_576).default(1_048_576),
  }).strict(),
  z.object({
    kind: z.literal("workspace-search"),
    workspaceId: workspaceIdSchema,
    path: workspaceDirectoryPathSchema.default(""),
    query: z.string().trim().min(1).max(500),
    maxMatches: z.number().int().min(1).max(200).default(50),
  }).strict(),
  z.object({
    kind: z.literal("workspace-write"),
    workspaceId: workspaceIdSchema,
    path: workspaceRelativePathSchema.refine((value) => value.length > 0 && /\.(?:md|csv)$/iu.test(value), "Only Markdown or CSV files are writable"),
    content: z.string().min(1).max(262_144),
  }).strict(),
]);
export const networkToolRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("web-search"),
    query: z.string().trim().min(1).max(500),
    maxResults: z.number().int().min(1).max(10).default(5),
  }).strict(),
  z.object({
    kind: z.literal("web-fetch"),
    url: z.string().trim().url().max(2_048),
    maxCharacters: z.number().int().min(1).max(100_000).default(50_000),
  }).strict(),
  z.object({
    kind: z.literal("weather-current"),
    location: z.string().trim().min(1).max(200),
  }).strict(),
  z.object({
    kind: z.literal("time-now"),
    timezone: z.string().trim().min(1).max(100).optional(),
  }).strict(),
]);
const mcpArgumentsSchema = z.record(z.string(), z.unknown()).refine(
  (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 12_000,
  "MCP arguments are too large",
);
export const mcpToolRequestSchema = z.object({
  kind: z.literal("mcp-call"),
  serverId: z.string().uuid(),
  toolName: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_.-]+$/u),
  arguments: mcpArgumentsSchema,
  readOnly: z.literal(true),
}).strict();
export const deviceToolRequestSchema = z.object({
  kind: z.literal("clipboard-read"),
  maxCharacters: z.number().int().min(1).max(20_000),
}).strict();
export const computationToolRequestSchema = z.object({
  kind: z.literal("text-measure"),
  text: z.string().max(100_000),
}).strict();
export const toolRequestSchema = z.union([workspaceToolRequestSchema, networkToolRequestSchema, mcpToolRequestSchema, deviceToolRequestSchema, computationToolRequestSchema]);
export const toolInvocationCommandSchema = z.object({
  runtimeRunId: runIdSchema,
  toolCallId: z.string().trim().min(1).max(200),
  idempotencyKey: z.string().uuid(),
  tool: toolRequestSchema,
}).strict();
export const approvalResolutionSchema = z.object({
  sessionId: sessionIdSchema,
  id: approvalIdSchema,
  expectedVersion: z.number().int().positive(),
  resolution: z.enum(["allow-once", "deny"]),
}).strict();
export const toolSessionScopeSchema = z.object({
  sessionId: sessionIdSchema,
}).strict();
export const attachmentDraftSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  mimeType: z.string().trim().min(1).max(120),
  size: z.number().int().min(0).max(1_048_576),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  kind: z.literal("text"),
  content: z.string().max(1_048_576),
}).strict();
export const artifactSaveSchema = z.object({
  name: z.string().trim().min(1).max(160),
  content: z.string().max(2 * 1_048_576),
}).strict();
export const artifactRevealSchema = z.string().min(1).max(4_096);
export const messageAttachmentsSchema = z.array(attachmentDraftSchema).max(6).superRefine((attachments, context) => {
  const total = attachments.reduce((sum, attachment) => sum + new TextEncoder().encode(attachment.content).byteLength, 0);
  if (total > 4 * 1_048_576) context.addIssue({ code: "custom", message: "Attachments are too large" });
});
export const roomIdSchema = z.string().uuid();
export const batchIdSchema = z.string().uuid();
export const turnIdSchema = z.string().uuid();
export const briefApprovalReadSchema = z.object({ roomId: roomIdSchema, sourceRuntimeRunId: z.string().uuid() }).strict();
export const briefApprovalCommandSchema = briefApprovalReadSchema.extend({
  briefInvocationId: z.string().uuid(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  clientNonce: nonceSchema,
  candidate: z.enum(["A", "B", "C"]),
}).strict();

export const sendCommandSchema = z.object({
  sessionId: sessionIdSchema,
  clientNonce: nonceSchema,
  text: nonEmptyText,
  attachments: messageAttachmentsSchema.optional(),
});

const roomMemberIdsSchema = z.array(botIdSchema).min(2).max(6).refine(
  (ids) => new Set(ids).size === ids.length,
  "Room members must be unique",
);

export const roomCreateSchema = z.object({
  memberBotIds: roomMemberIdsSchema,
  name: z.string().trim().min(1).max(72).optional(),
  description: z.string().trim().max(2_000).optional(),
});

export const roomUpdateSchema = z.object({
  id: roomIdSchema,
  expectedVersion: z.number().int().positive(),
  patch: z.object({
    name: z.string().trim().min(1).max(72).optional(),
    description: z.string().trim().max(2_000).optional(),
  }).refine((patch) => Object.keys(patch).length > 0, "At least one field is required"),
});

export const roomArchiveSchema = z.object({ id: roomIdSchema, archived: z.boolean() });
export const roomPinnedSchema = z.object({ id: roomIdSchema, pinned: z.boolean() });
export const roomUnreadSchema = z.object({ id: roomIdSchema, unread: z.boolean() });
export const roomHiddenSchema = z.object({ id: roomIdSchema, hidden: z.boolean() });
export const roomListSchema = z.object({ includeArchived: z.boolean().optional() }).optional();
export const roomMembershipSchema = z.object({
  roomId: roomIdSchema,
  botId: botIdSchema,
  expectedMembershipVersion: z.number().int().positive(),
});

const uniqueRoomTargets = z.array(botIdSchema).max(6).refine(
  (ids) => new Set(ids).size === ids.length,
  "Room targets must be unique",
);

export const roomSendCommandSchema = sendCommandSchema.extend({
  roomId: roomIdSchema,
  targetBotIds: uniqueRoomTargets,
  routingMode: z.enum(["automatic", "explicit", "everyone"]),
}).superRefine((command, context) => {
  if (command.routingMode === "automatic" && command.targetBotIds.length !== 0) {
    context.addIssue({ code: "custom", path: ["targetBotIds"], message: "Automatic routing cannot declare targets" });
  }
  if (command.routingMode !== "automatic" && command.targetBotIds.length === 0) {
    context.addIssue({ code: "custom", path: ["targetBotIds"], message: "Explicit routing requires targets" });
  }
});

export const providerBaseUrlSchema = z
    .string()
    .trim()
    .url()
    .max(2_048)
    .refine((value) => {
      const url = new URL(value);
      if (url.username || url.password) return false;
      if (url.protocol === "https:") return true;
      const hostname = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
      return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(hostname);
    }, "Use HTTPS, or HTTP only for a loopback address");

export const providerInstanceIdInputSchema = providerInstanceIdSchema;
export const saveOpenAiCompatibleProviderSchema = z.object({
  instanceId: providerInstanceIdSchema,
  expectedVersion: z.number().int().positive(),
  baseUrl: providerBaseUrlSchema,
  apiKey: z.string().trim().min(1).max(8_192).optional(),
}).strict();
export const saveCliProviderSchema = z.object({
  instanceId: providerInstanceIdSchema,
  expectedVersion: z.number().int().positive(),
  cliPath: z.string().trim().min(1).max(2_048).refine((value) => !/[\r\n\0]/u.test(value), "CLI path contains an unsafe character"),
}).strict();

const mcpServerNameSchema = z.string().trim().min(1).max(32).regex(/^[a-z][a-z0-9_-]*$/u);
export const mcpServerIdSchema = z.string().uuid();
const mcpSecretValueSchema = z.union([z.string().max(16_384), z.literal(true)]);
const mcpEnvNameSchema = z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/u).refine(
  (value) => value !== "ELECTRON_RUN_AS_NODE" && !value.startsWith("AEVOREN_") && !value.startsWith("OMB_") && !value.startsWith("OGB_"),
  "Reserved environment variable",
);
const mcpHeaderNameSchema = z.string().min(1).max(128).regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u);
const mcpToolNameSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_.-]+$/u);
const mcpEnvSchema = z.record(mcpEnvNameSchema, mcpSecretValueSchema);
const mcpHeadersSchema = z.record(mcpHeaderNameSchema, mcpSecretValueSchema);
const mcpRemoteUrlSchema = providerBaseUrlSchema.refine((value) => {
  const parsed = new URL(value);
  return parsed.protocol === "https:" || ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname.replace(/^\[(.*)\]$/u, "$1"));
}, "Remote MCP requires HTTPS, except for loopback development");
export const mcpServerMutationSchema = z.object({
  id: mcpServerIdSchema.optional(),
  expectedVersion: z.number().int().positive().optional(),
  name: mcpServerNameSchema,
  enabled: z.boolean().optional(),
  trustedReadOnlyTools: z.array(mcpToolNameSchema).max(100).refine((names) => new Set(names).size === names.length, "Trusted MCP tool names must be unique").optional(),
  config: z.discriminatedUnion("transport", [
    z.object({
      transport: z.literal("stdio"),
      command: z.string().trim().min(1).max(1_024).refine((value) => !/[\r\n\0]/u.test(value)),
      args: z.array(z.string().max(4_096).refine((value) => !/[\r\n\0]/u.test(value))).max(64),
      env: mcpEnvSchema,
    }).strict(),
    z.object({
      transport: z.literal("streamable-http"),
      url: mcpRemoteUrlSchema,
      headers: mcpHeadersSchema,
    }).strict(),
  ]),
}).strict().superRefine((value, context) => {
  if ((value.id === undefined) !== (value.expectedVersion === undefined)) {
    context.addIssue({ code: "custom", message: "id and expectedVersion must be provided together" });
  }
});
export const mcpServerEnabledSchema = z.object({
  id: mcpServerIdSchema,
  expectedVersion: z.number().int().positive(),
  enabled: z.boolean(),
}).strict();
export const mcpServerMutationIdSchema = z.object({
  id: mcpServerIdSchema,
  expectedVersion: z.number().int().positive(),
}).strict();

export const routineIdSchema = z.string().uuid();
export const routineScheduleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("once"), at: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("interval"), everyMinutes: z.number().int().min(5).max(43_200), anchorAt: z.number().int().positive() }).strict(),
  z.object({
    type: z.literal("cron"),
    expression: z.string().trim().min(1).max(256).refine((value) => value.split(/\s+/u).length === 5 && !value.includes("@"), "Use five-field cron"),
    timeZone: z.string().trim().min(1).max(128),
  }).strict(),
]);
export const routineCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(20_000),
  botId: botIdSchema,
  schedule: routineScheduleSchema,
  enabled: z.boolean().optional(),
}).strict();
export const routineUpdateSchema = z.object({
  id: routineIdSchema,
  expectedVersion: z.number().int().positive(),
  patch: z.object({
    name: z.string().trim().min(1).max(120).optional(),
    prompt: z.string().trim().min(1).max(20_000).optional(),
    schedule: routineScheduleSchema.optional(),
  }).strict().refine((value) => Object.keys(value).length > 0),
}).strict();
export const routineEnabledSchema = z.object({ id: routineIdSchema, expectedVersion: z.number().int().positive(), enabled: z.boolean() }).strict();
export const routineMutationSchema = z.object({ id: routineIdSchema, expectedVersion: z.number().int().positive() }).strict();

export const generalSettingsSchema = z.object({
  theme: z.enum(["system", "light", "dark"]).optional(),
  memoryCaptureEnabled: z.boolean().optional(),
  autoApprovePublicReadTools: z.boolean().optional(),
  launchAtLogin: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one general setting is required");
