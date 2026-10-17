import type { ApiResult } from "./contracts";

export const ENV_WORKER_VERSION = "1.2.0";
export const ENV_PROTOCOL_VERSION = 1;
export const ENV_FILE_MAX_BYTES = 1_048_576;
export const ENV_COMMAND_MAX_BYTES = 65_536;
export const ENV_LOG_MAX_BYTES = 1_048_576;
export const ENV_LOG_CHUNK_MAX_BYTES = 16_384;
export const ENV_HTTP_BODY_MAX_BYTES = ENV_FILE_MAX_BYTES * 6 + 65_536;
export const ENV_FOREGROUND_TIMEOUT_MS = 120_000;
export const ENV_EXECUTION_MAX_TIMEOUT_MS = 3_600_000;

export type EnvironmentScope = { sessionId: string; executorBotId: string };
export type EnvironmentPlatform = "linux/arm64" | "linux/amd64";
export type EnvironmentState = "starting" | "running" | "stopped" | "error" | "unknown";
export type Environment = EnvironmentScope & {
  id: string;
  version: number;
  state: EnvironmentState;
  workerVersion: string;
  imageRef: string;
  imageDigest: string;
  platform: EnvironmentPlatform;
  createdAt: string;
  updatedAt: string;
};

/** Host-private connection material is never returned by the public APIs. */
export type InternalEnvironmentRecord = Environment & {
  containerId: string | null;
  workerPort: number | null;
  encryptedToken: string | null;
  bootId: string | null;
};
export type EnvironmentProbe = {
  available: boolean;
  dockerInstalled: boolean;
  daemonReachable: boolean;
  serverVersion: string | null;
  platform: EnvironmentPlatform | null;
  workerImagePresent: boolean;
  reason: string | null;
};
export type EnvironmentInitializeResult = { probe: EnvironmentProbe; imageRef: string; imageDigest: string; workerVersion: string };
export type EnvironmentMutationInput = EnvironmentScope & { expectedVersion?: number };
export type ExecutionSession = { id: string; environmentId: string; runtimeRunId: string | null; createdAt: string };
export type ExecutionKind = "foreground" | "background";
export type ExecutionState = "running" | "completed" | "failed" | "cancelled" | "interrupted" | "unknown";
export type Execution = {
  id: string;
  environmentId: string;
  executionSessionId: string;
  runtimeRunId: string | null;
  version: number;
  kind: ExecutionKind;
  command: string;
  cwd: string;
  state: ExecutionState;
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  lastSeq: number;
  truncated: boolean;
  errorCode?: string;
};
export type BackgroundProcess = Execution & { kind: "background" };
export type ExecutionRunInput = EnvironmentScope & { clientNonce: string; command: string; cwd?: string; timeoutMs?: number };
export type ProcessStartInput = EnvironmentScope & { clientNonce: string; command: string; cwd?: string };
export type ExecutionIdInput = EnvironmentScope & { id: string };
export type ExecutionListInput = EnvironmentScope & { state?: ExecutionState };
export type WorkerLog = { seq: number; executionId: string; stream: "stdout" | "stderr" | "state"; text: string; bytesBase64?: string; at: string };
export type ExecutionLogsInput = ExecutionIdInput & { afterSeq?: number; limit?: number; maxBytes?: number };
export type ExecutionLogsPage = { executionId: string; logs: WorkerLog[]; firstSeq: number; lastSeq: number; truncated: boolean };
export type EnvironmentFile = { path: string; type: "file" | "directory"; size: number; modifiedAt: string };
export type EnvironmentFileList = { path: string; entries: EnvironmentFile[]; truncated: boolean };
export type EnvironmentFileContent = { path: string; size: number; sha256: string; mimeType: string; encoding: "utf8" | "base64"; content: string };
export type EnvironmentFileReadInput = EnvironmentScope & { path: string };
export type EnvironmentFileWriteInput = EnvironmentFileReadInput & { content: string; encoding?: "utf8" | "base64"; expectedSha256?: string };
export type EnvironmentFileWriteResult = { path: string; size: number; sha256: string };
export type EnvironmentFileDownloadResult = { path: string; name: string; size: number };
export type PortState = "listening" | "stopped" | "unknown";
export type RegisteredPort = { id: string; processId: string; port: number; label: string; state: PortState; checkedAt: string | null };
export type RegisterPortInput = EnvironmentScope & { processId: string; port: number; label?: string };
export type EnvironmentChangedEvent = EnvironmentScope & { type: "environment" | "execution" | "log" | "port"; environmentId: string; executionId?: string; log?: WorkerLog };

export type EnvironmentsApi = {
  probe(): Promise<ApiResult<EnvironmentProbe>>;
  initialize(): Promise<ApiResult<EnvironmentInitializeResult>>;
  list(input: EnvironmentScope): Promise<ApiResult<Environment[]>>;
  get(input: EnvironmentScope): Promise<ApiResult<Environment | null>>;
  start(input: EnvironmentMutationInput): Promise<ApiResult<Environment>>;
  stop(input: EnvironmentMutationInput): Promise<ApiResult<Environment>>;
  rebuild(input: EnvironmentMutationInput): Promise<ApiResult<Environment>>;
  onChanged(listener: (event: EnvironmentChangedEvent) => void): () => void;
};
export type ExecutionApi = {
  list(input: ExecutionListInput): Promise<ApiResult<Execution[]>>;
  get(input: ExecutionIdInput): Promise<ApiResult<Execution>>;
  run(input: ExecutionRunInput): Promise<ApiResult<Execution>>;
  cancel(input: ExecutionIdInput): Promise<ApiResult<Execution>>;
  logs(input: ExecutionLogsInput): Promise<ApiResult<ExecutionLogsPage>>;
  listFiles(input: EnvironmentScope & { path?: string }): Promise<ApiResult<EnvironmentFileList>>;
  readFile(input: EnvironmentFileReadInput): Promise<ApiResult<EnvironmentFileContent>>;
  writeFile(input: EnvironmentFileWriteInput): Promise<ApiResult<EnvironmentFileWriteResult>>;
  pickUpload(input: EnvironmentScope & { directory?: string }): Promise<ApiResult<EnvironmentFileWriteResult[] | null>>;
  downloadFile(input: EnvironmentFileReadInput): Promise<ApiResult<EnvironmentFileDownloadResult | null>>;
  onChanged(listener: (event: EnvironmentChangedEvent) => void): () => void;
};
export type ProcessesApi = {
  list(input: EnvironmentScope): Promise<ApiResult<BackgroundProcess[]>>;
  start(input: ProcessStartInput): Promise<ApiResult<BackgroundProcess>>;
  stop(input: ExecutionIdInput): Promise<ApiResult<BackgroundProcess>>;
  registerPort(input: RegisterPortInput): Promise<ApiResult<RegisteredPort>>;
  listPorts(input: EnvironmentScope): Promise<ApiResult<RegisteredPort[]>>;
  onChanged(listener: (event: EnvironmentChangedEvent) => void): () => void;
};

/** Worker sessionId is an ExecutionSession id; conversation identity stays in the host. */
export type WorkerHealth = { environmentId: string; bootId: string; protocolVersion: number; workerVersion: string; capabilities: string[] };
export type WorkerExecutionRequest = { id: string; sessionId: string; runtimeRunId: string | null; kind: ExecutionKind; command: string; cwd: string; timeoutMs?: number };
export type WorkerExecution = Omit<Execution, "version">;
export type WorkerPendingCancelAck = { id: string; state: "cancelled"; pending: true };
export type WorkerFileReadRequest = { path: string };
export type WorkerFileListRequest = { path?: string };
export type WorkerFileWriteRequest = { path: string; content: string; encoding?: "utf8" | "base64"; expectedSha256?: string };
export type WorkerRegisterPortRequest = { id: string; processId: string; port: number; label?: string };
