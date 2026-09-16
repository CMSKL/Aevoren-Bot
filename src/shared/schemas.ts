import { z } from "zod";

const nonEmptyText = z.string().trim().min(1).max(20_000);

export const botUpdateSchema = z.object({
  id: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  patch: z
    .object({
      name: z.string().trim().min(1).max(80).optional(),
      label: z.string().trim().max(120).optional(),
      description: z.string().trim().max(2_000).optional(),
      instructions: z.string().trim().max(20_000).optional(),
    })
    .refine((patch) => Object.keys(patch).length > 0, "At least one field is required"),
});

export const botIdSchema = z.string().uuid();
export const botPinnedSchema = z.object({ id: botIdSchema, pinned: z.boolean() });
export const botUnreadSchema = z.object({ id: botIdSchema, unread: z.boolean() });
export const botHiddenSchema = z.object({ id: botIdSchema, hidden: z.boolean() });
export const memoryIdSchema = z.string().uuid();
const memoryContentSchema = z.string().trim().min(1).max(4_000);
export const memoryListSchema = z.object({
  botId: botIdSchema,
  includeDeleted: z.boolean().optional(),
}).strict();
export const memoryCreateSchema = z.object({
  botId: botIdSchema,
  content: memoryContentSchema,
}).strict();
export const memoryUpdateSchema = z.object({
  id: memoryIdSchema,
  expectedVersion: z.number().int().positive(),
  content: memoryContentSchema,
}).strict();
export const memoryMutationSchema = z.object({
  id: memoryIdSchema,
  expectedVersion: z.number().int().positive(),
}).strict();
export const sessionIdSchema = z.string().uuid();
export const nonceSchema = z.string().uuid();
export const runIdSchema = z.string().uuid();
export const toolInvocationIdSchema = z.string().uuid();
export const approvalIdSchema = z.string().uuid();
export const workspaceIdSchema = z.string().uuid();
export const workspaceMutationSchema = z.object({
  id: workspaceIdSchema,
  expectedVersion: z.number().int().positive(),
}).strict();
export const workspaceRelativePathSchema = z
  .string()
  .max(1_024)
  .superRefine((value, context) => {
    if (value.startsWith("/") || value.includes("\\") || value.includes("\0")) {
      context.addIssue({ code: "custom", message: "Path must be relative and use POSIX separators" });
      return;
    }
    if (value !== "" && value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
      context.addIssue({ code: "custom", message: "Path contains an unsafe segment" });
    }
  })
  .transform((value) => value.normalize("NFC"));
export const workspaceToolRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("workspace-list"),
    workspaceId: workspaceIdSchema,
    path: workspaceRelativePathSchema,
    maxEntries: z.number().int().min(1).max(500),
  }).strict(),
  z.object({
    kind: z.literal("workspace-read"),
    workspaceId: workspaceIdSchema,
    path: workspaceRelativePathSchema,
    maxBytes: z.number().int().min(1).max(1_048_576),
  }).strict(),
  z.object({
    kind: z.literal("workspace-search"),
    workspaceId: workspaceIdSchema,
    path: workspaceRelativePathSchema,
    query: z.string().trim().min(1).max(500),
    maxMatches: z.number().int().min(1).max(200),
  }).strict(),
]);
export const toolInvocationCommandSchema = z.object({
  runtimeRunId: runIdSchema,
  toolCallId: z.string().trim().min(1).max(200),
  idempotencyKey: z.string().uuid(),
  tool: workspaceToolRequestSchema,
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
export const roomIdSchema = z.string().uuid();
export const batchIdSchema = z.string().uuid();
export const turnIdSchema = z.string().uuid();

export const sendCommandSchema = z.object({
  sessionId: sessionIdSchema,
  clientNonce: nonceSchema,
  text: nonEmptyText,
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

export const modelConfigurationSchema = z.object({
  baseUrl: z
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
    }, "Use HTTPS, or HTTP only for a loopback address"),
  modelId: z.string().trim().min(1).max(200),
  apiKey: z.string().trim().min(1).max(8_192).optional(),
});

export const generalSettingsSchema = z.object({
  theme: z.enum(["system", "light", "dark"]),
}).strict();
