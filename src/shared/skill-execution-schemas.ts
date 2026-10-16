import { mcpWriteReviewSchema } from "./mcp-write-schemas";
import { demonstrationApprovalReviewSchema } from "./demonstration-schemas";
import { externalDraftReviewSnapshotSchema } from "./native-outbound-schemas";
import { z } from "zod";
import { environmentDirectoryPathSchema, environmentScopeSchema } from "./environment-schemas";
import { ENV_EXECUTION_MAX_TIMEOUT_MS, ENV_FOREGROUND_TIMEOUT_MS, ENV_FILE_MAX_BYTES } from "./environment-contracts";
import { resourceFileRefSchema, resourceReferenceSchema } from "./library-schemas";
import { SKILL_PACKAGE_MAX_BYTES, SKILL_PACKAGE_MAX_FILES } from "./skill-execution-contracts";

const id = z.string().uuid();
const version = z.number().int().positive();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const imageDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const workerVersion = z.string().max(120).regex(/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/);
export const skillInterpreterSchema = z.enum(["bash", "python", "node"]);
export const skillEntryPathSchema = resourceFileRefSchema.shape.relativePath.refine(path => path.startsWith("scripts/"), "Script entry must be inside scripts/");
export const skillArgsSchema = z.array(z.string().max(4_096).refine(value => !value.includes("\0") &&
  new TextDecoder("utf-8", { ignoreBOM: true }).decode(new TextEncoder().encode(value)) === value, "Arguments need a stable UTF-8 identity without NUL")).max(64)
  .refine(args => args.reduce((size, value) => size + new TextEncoder().encode(value).byteLength, 0) <= 48_000 &&
    new TextEncoder().encode(JSON.stringify(args)).byteLength <= 48_000, "Serialized arguments exceed 48 KB");
const invocation = { args: skillArgsSchema.default([]), cwd: environmentDirectoryPathSchema.default("."),
  timeoutMs: z.number().int().positive().max(ENV_EXECUTION_MAX_TIMEOUT_MS).default(ENV_FOREGROUND_TIMEOUT_MS) };
export const skillScriptsSchema = environmentScopeSchema.extend({ reference: resourceReferenceSchema }).strict();
export const skillGrantsSchema = environmentScopeSchema.extend({ resourceId: id.optional(), includeRevoked: z.boolean().optional() }).strict();
export const skillGrantSchema = skillScriptsSchema.extend({ environmentId: id, expectedImageDigest: imageDigest, expectedWorkerVersion: workerVersion,
  entryPath: skillEntryPathSchema, interpreter: skillInterpreterSchema, expectedVersion: version.optional() }).strict();
export const skillRevokeSchema = environmentScopeSchema.extend({ id, expectedVersion: version }).strict();
export const skillRunSchema = environmentScopeSchema.extend({ clientNonce: id, grantId: id, expectedGrantVersion: version, ...invocation }).strict();
export const skillExecutionInputSchema = environmentScopeSchema.extend({ id }).strict();
export const skillGrantRecordSchema = environmentScopeSchema.extend({ id, environmentId: id, imageDigest, workerVersion, reference: resourceReferenceSchema,
  entryPath: skillEntryPathSchema, entrySha256: digest, interpreter: skillInterpreterSchema, version,
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), revokedAt: z.string().datetime().nullable() }).strict();
export const skillScriptReviewSnapshotSchema = z.object({ kind: z.literal("skill-script"), resourceName: z.string().min(1).max(120), revisionNumber: version,
  target: z.object({ grantId: id, grantVersion: version, environmentId: id, imageDigest, workerVersion, reference: resourceReferenceSchema,
    entryPath: skillEntryPathSchema, entrySha256: digest, interpreter: skillInterpreterSchema, ...invocation }).strict() }).strict();
export const approvalReviewSnapshotSchema = z.discriminatedUnion("kind", [skillScriptReviewSnapshotSchema, externalDraftReviewSnapshotSchema, demonstrationApprovalReviewSchema, mcpWriteReviewSchema]);
export const approvalReviewInputSchema = environmentScopeSchema.extend({ id, expectedVersion: version }).strict();
const base64 = z.string().max(Math.ceil(ENV_FILE_MAX_BYTES / 3) * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export const workerSkillInstallSchema = z.object({ id, reference: resourceReferenceSchema,
  files: z.array(resourceFileRefSchema.extend({ dataBase64: base64,
    relativePath: resourceFileRefSchema.shape.relativePath.refine(path => new TextDecoder("utf-8", { ignoreBOM: true }).decode(new TextEncoder().encode(path)) === path, "Path must have a stable UTF-8 identity") }).strict()).min(1).max(SKILL_PACKAGE_MAX_FILES)
    .refine(files => new Set(files.map(file => file.relativePath)).size === files.length, "Package paths must be unique")
    .refine(files => files.reduce((size, file) => size + file.size, 0) <= SKILL_PACKAGE_MAX_BYTES, "Package exceeds 4 MiB")
    .refine(files => files.some(file => file.relativePath === "SKILL.md"), "Package needs SKILL.md") }).strict();
export const workerSkillPackageSchema = z.object({ id, reference: resourceReferenceSchema, packageDigest: digest,
  fileCount: z.number().int().positive().max(SKILL_PACKAGE_MAX_FILES), size: z.number().int().nonnegative().max(SKILL_PACKAGE_MAX_BYTES) }).strict();
export const workerSkillRunSchema = z.object({ id, sessionId: id, runtimeRunId: id.nullable(), packageId: id, packageDigest: digest,
  interpreter: skillInterpreterSchema, entryPath: skillEntryPathSchema, ...invocation }).strict();
