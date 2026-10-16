import type { ApiResult } from "./contracts";
import { ENV_HTTP_BODY_MAX_BYTES, type EnvironmentScope, type Execution, type WorkerExecution } from "./environment-contracts";
import type { ResourceFileRef, ResourceReference } from "./library-contracts";

export const SKILL_SCRIPT_WORKER_VERSION = "1.2.0";
export const SKILL_SCRIPT_CAPABILITY = "skill-script";
export const SKILL_PACKAGE_MAX_FILES = 251;
export const SKILL_PACKAGE_MAX_BYTES = 4 * 1_048_576;
export const SKILL_INSTALL_HTTP_MAX_BYTES = ENV_HTTP_BODY_MAX_BYTES;
export type SkillScriptInterpreter = "bash" | "python" | "node";
export type SkillScriptDescriptor = {
  reference: ResourceReference;
  entryPath: string;
  entrySha256: string;
  interpreter: SkillScriptInterpreter;
  size: number;
  mimeType: string;
};
export type SkillExecutionGrant = EnvironmentScope & {
  id: string;
  environmentId: string;
  imageDigest: string;
  workerVersion: string;
  reference: ResourceReference;
  entryPath: string;
  entrySha256: string;
  interpreter: SkillScriptInterpreter;
  version: number;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
};
export type SkillScriptsInput = EnvironmentScope & { reference: ResourceReference };
export type SkillGrantsInput = EnvironmentScope & { resourceId?: string; includeRevoked?: boolean };
export type SkillGrantInput = SkillScriptsInput & {
  environmentId: string;
  expectedImageDigest: string;
  expectedWorkerVersion: string;
  entryPath: string;
  interpreter: SkillScriptInterpreter;
  expectedVersion?: number;
};
export type SkillRevokeInput = EnvironmentScope & { id: string; expectedVersion: number };
export type SkillScriptRunInput = EnvironmentScope & {
  clientNonce: string;
  grantId: string;
  expectedGrantVersion: number;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
};
export type SkillScriptExecution = {
  grantId: string;
  grantVersion: number;
  environmentId: string;
  imageDigest: string;
  workerVersion: string;
  reference: ResourceReference;
  entryPath: string;
  entrySha256: string;
  interpreter: SkillScriptInterpreter;
  args: string[];
  cwd: string;
  timeoutMs: number;
  execution: Execution;
};
export type SkillScriptExecutionInput = EnvironmentScope & { id: string };
export type SkillExecutionChangedEvent = EnvironmentScope & { grantId: string; type: "granted" | "revoked" | "execution"; executionId?: string };
export type SkillScriptReviewSnapshot = {
  kind: "skill-script";
  resourceName: string;
  revisionNumber: number;
  target: {
    grantId: string;
    grantVersion: number;
    environmentId: string;
    imageDigest: string;
    workerVersion: string;
    reference: ResourceReference;
    entryPath: string;
    entrySha256: string;
    interpreter: SkillScriptInterpreter;
    args: string[];
    cwd: string;
    timeoutMs: number;
  };
};
export type ApprovalReviewSnapshot = import("./template-export-contracts").TemplateApprovalReview | SkillScriptReviewSnapshot | import("./native-outbound-contracts").ExternalDraftReviewSnapshot | import("./mcp-write-contracts").McpWriteReview | import("./demonstration-contracts").DemonstrationApprovalReviewSnapshot;
export type ApprovalReviewInput = EnvironmentScope & { id: string; expectedVersion: number };
export type ApprovalReviewResult = { snapshot: ApprovalReviewSnapshot | null; executable: boolean; reason?: string };
export type SkillExecutionApi = {
  scripts(input: SkillScriptsInput): Promise<ApiResult<SkillScriptDescriptor[]>>;
  executionGrants(input: SkillGrantsInput): Promise<ApiResult<SkillExecutionGrant[]>>;
  grantExecution(input: SkillGrantInput): Promise<ApiResult<SkillExecutionGrant>>;
  revokeExecution(input: SkillRevokeInput): Promise<ApiResult<SkillExecutionGrant>>;
  runScript(input: SkillScriptRunInput): Promise<ApiResult<SkillScriptExecution>>;
  scriptExecution(input: SkillScriptExecutionInput): Promise<ApiResult<SkillScriptExecution>>;
  onChanged(listener: (event: SkillExecutionChangedEvent) => void): () => void;
};

/** Installation bytes come only from the host-owned, exact Library revision. */
export type WorkerSkillInstallRequest = { id: string; reference: ResourceReference; files: (ResourceFileRef & { dataBase64: string })[] };
export type WorkerSkillPackage = { id: string; reference: ResourceReference; packageDigest: string; fileCount: number; size: number };
export type WorkerSkillRunRequest = {
  id: string;
  sessionId: string;
  runtimeRunId: string | null;
  packageId: string;
  packageDigest: string;
  interpreter: SkillScriptInterpreter;
  entryPath: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
};
export type WorkerSkillExecution = WorkerExecution;

export function skillPackageDescriptor(input: Pick<WorkerSkillInstallRequest, "reference" | "files">): string {
  const reference = { resourceId: input.reference.resourceId, revisionId: input.reference.revisionId, digest: input.reference.digest };
  const files = input.files.map(({ relativePath, size, mimeType, sha256 }) => ({ relativePath, size, mimeType, sha256 }))
    .sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);
  return JSON.stringify({ reference, files });
}

/** A display/provenance descriptor; it is never executable shell text. */
export function skillScriptCommand(input: Pick<WorkerSkillRunRequest, "packageId" | "packageDigest" | "interpreter" | "entryPath" | "args">): string {
  return JSON.stringify({ kind: "skill-script", packageId: input.packageId, packageDigest: input.packageDigest,
    interpreter: input.interpreter, entryPath: input.entryPath, args: input.args });
}
