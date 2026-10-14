import { z } from "zod";
import {
  ENV_COMMAND_MAX_BYTES, ENV_FILE_MAX_BYTES, ENV_LOG_CHUNK_MAX_BYTES,
  ENV_PROTOCOL_VERSION, ENV_FOREGROUND_TIMEOUT_MS, ENV_EXECUTION_MAX_TIMEOUT_MS,
} from "./environment-contracts";

const id = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const nullableTimestamp = z.string().datetime({ offset: true }).nullable();
export const environmentPlatformSchema = z.enum(["linux/arm64", "linux/amd64"]);
export const environmentStateSchema = z.enum(["starting", "running", "stopped", "error", "unknown"]);
export const executionStateSchema = z.enum(["running", "completed", "failed", "cancelled", "interrupted", "unknown"]);
export const executionKindSchema = z.enum(["foreground", "background"]);
export const environmentScopeSchema = z.object({ sessionId: id, executorBotId: id }).strict();
export const environmentMutationSchema = environmentScopeSchema.extend({ expectedVersion: z.number().int().positive().optional() });

function safeRelativePath(path: string): boolean {
  return !path.startsWith("/") && !/^[a-z]:/i.test(path) && !path.includes("\\")
    && Array.from(path).every((character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127)
    && path.split("/").every((part) => part.length > 0 && part !== "." && part !== ".." && new TextEncoder().encode(part).length <= 255);
}
export const environmentFilePathSchema = z.string().min(1).max(1_024).refine(safeRelativePath, "Use a relative POSIX file path without unsafe segments");
export const environmentDirectoryPathSchema = z.string().min(1).max(1_024).refine((path) => path === "." || safeRelativePath(path), "Use '.' or a relative POSIX directory path");
export const executionCommandSchema = z.string().min(1).max(ENV_COMMAND_MAX_BYTES)
  .refine((command) => command.trim().length > 0 && !command.includes("\0") && new TextEncoder().encode(command).length <= ENV_COMMAND_MAX_BYTES, "Command exceeds 64 KiB or is empty/invalid");
const timeoutMs = z.number().int().min(1).max(ENV_EXECUTION_MAX_TIMEOUT_MS);

export const executionIdSchema = environmentScopeSchema.extend({ id });
export const executionListSchema = environmentScopeSchema.extend({ state: executionStateSchema.optional() });
export const executionRunSchema = environmentScopeSchema.extend({ clientNonce: id, command: executionCommandSchema, cwd: environmentDirectoryPathSchema.default("."), timeoutMs: timeoutMs.default(ENV_FOREGROUND_TIMEOUT_MS) });
export const processStartSchema = environmentScopeSchema.extend({ clientNonce: id, command: executionCommandSchema, cwd: environmentDirectoryPathSchema.default(".") });
export const executionLogsSchema = executionIdSchema.extend({ afterSeq: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(500).optional(), maxBytes: z.number().int().min(1).max(262_144).optional() });
export const executionWaitSchema = executionIdSchema.extend({ timeoutMs: z.number().int().min(0).max(10_000).optional() });
export const environmentFileListSchema = environmentScopeSchema.extend({ path: environmentDirectoryPathSchema.optional() });
export const environmentFileReadSchema = environmentScopeSchema.extend({ path: environmentFilePathSchema });

export function environmentContentBytes(content: string, encoding: "utf8" | "base64"): number {
  if (encoding === "utf8") return new TextEncoder().encode(content).length;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) return Infinity;
  return content.length * 3 / 4 - (content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0);
}
const fileWriteFields = {
  path: environmentFilePathSchema, content: z.string().max(Math.ceil(ENV_FILE_MAX_BYTES / 3) * 4),
  encoding: z.enum(["utf8", "base64"]).optional(), expectedSha256: sha256.optional(),
};
const validFileContent = (input: { content: string; encoding?: "utf8" | "base64" }): boolean => environmentContentBytes(input.content, input.encoding ?? "utf8") <= ENV_FILE_MAX_BYTES;
export const environmentFileWriteSchema = environmentScopeSchema.extend(fileWriteFields).refine(validFileContent, "File exceeds 1 MiB or has invalid encoding");
export const environmentPickUploadSchema = environmentScopeSchema.extend({ directory: environmentDirectoryPathSchema.optional() });
export const registerPortSchema = environmentScopeSchema.extend({ processId: id, port: z.number().int().min(1).max(65_535), label: z.string().trim().max(120).optional() });

export const environmentSchema = environmentScopeSchema.extend({ id, version: z.number().int().positive(), state: environmentStateSchema,
  workerVersion: z.string().min(1).max(80), imageRef: z.string().min(1).max(256), imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  platform: environmentPlatformSchema, createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }) });
export const executionSchema = z.object({ id, environmentId: id, executionSessionId: id, runtimeRunId: id.nullable(), version: z.number().int().positive(),
  kind: executionKindSchema, command: executionCommandSchema, cwd: environmentDirectoryPathSchema, state: executionStateSchema,
  pid: z.number().int().positive().nullable(), exitCode: z.number().int().nullable(), signal: z.string().max(80).nullable(),
  createdAt: z.string().datetime({ offset: true }), startedAt: nullableTimestamp, endedAt: nullableTimestamp,
  lastSeq: z.number().int().min(0), truncated: z.boolean(), errorCode: z.string().max(120).optional() }).strict();
export const workerLogSchema = z.object({ seq: z.number().int().positive(), executionId: id, stream: z.enum(["stdout", "stderr", "state"]),
  // StringDecoder can carry three bytes from the prior chunk; invalid UTF-8 expands to replacement characters.
  text: z.string().max(ENV_LOG_CHUNK_MAX_BYTES + 3).refine((text) => new TextEncoder().encode(text).length <= ENV_LOG_CHUNK_MAX_BYTES * 3 + 9),
  bytesBase64: z.string().max(Math.ceil(ENV_LOG_CHUNK_MAX_BYTES / 3) * 4).refine((bytes) => environmentContentBytes(bytes, "base64") <= ENV_LOG_CHUNK_MAX_BYTES).optional(),
  at: z.string().datetime({ offset: true }) }).strict();
export const workerLogsPageSchema = z.object({ executionId: id, logs: z.array(workerLogSchema).max(500), firstSeq: z.number().int().min(0),
  lastSeq: z.number().int().min(0), truncated: z.boolean() }).strict();
export const environmentFileSchema = z.object({ path: environmentFilePathSchema, type: z.enum(["file", "directory"]),
  size: z.number().int().min(0), modifiedAt: z.string().datetime({ offset: true }) }).strict();
export const environmentFileContentSchema = z.object({ path: environmentFilePathSchema, size: z.number().int().min(0).max(ENV_FILE_MAX_BYTES),
  sha256, mimeType: z.string().min(1).max(120), encoding: z.enum(["utf8", "base64"]), content: fileWriteFields.content }).strict().refine(validFileContent);
export const registeredPortSchema = z.object({ id, processId: id, port: z.number().int().min(1).max(65_535), label: z.string().max(120),
  state: z.enum(["listening", "stopped", "unknown"]), checkedAt: nullableTimestamp }).strict();

export const workerHealthSchema = z.object({ environmentId: id, bootId: id, protocolVersion: z.literal(ENV_PROTOCOL_VERSION),
  workerVersion: z.string().max(80).regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/), capabilities: z.array(z.string().min(1).max(80)).max(32) }).strict();
export const workerExecutionRequestSchema = z.object({ id, sessionId: id, runtimeRunId: id.nullable(), kind: executionKindSchema,
  command: executionCommandSchema, cwd: environmentDirectoryPathSchema.default("."), timeoutMs: timeoutMs.optional() }).strict()
  .transform((request) => request.kind === "foreground" && request.timeoutMs === undefined ? { ...request, timeoutMs: ENV_FOREGROUND_TIMEOUT_MS } : request);
export const workerExecutionSchema = executionSchema.omit({ version: true }).extend({ state: z.enum(["running", "completed", "failed", "cancelled", "interrupted"]) });
export const workerPendingCancelAckSchema = z.object({ id, state: z.literal("cancelled"), pending: z.literal(true) }).strict();
export const workerFileReadSchema = z.object({ path: environmentFilePathSchema }).strict();
export const workerFileListSchema = z.object({ path: environmentDirectoryPathSchema.optional() }).strict();
export const workerFileWriteSchema = z.object(fileWriteFields).strict().refine(validFileContent, "File exceeds 1 MiB or has invalid encoding");
export const workerRegisterPortSchema = z.object({ id, processId: id, port: z.number().int().min(1).max(65_535), label: z.string().trim().max(120).optional() }).strict();
