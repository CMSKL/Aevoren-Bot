import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type {
  Environment, EnvironmentChangedEvent, EnvironmentFileContent, EnvironmentFileList, EnvironmentFileReadInput,
  EnvironmentFileWriteInput, EnvironmentFileWriteResult, EnvironmentInitializeResult, EnvironmentMutationInput, EnvironmentProbe, EnvironmentScope,
  Execution, ExecutionIdInput, ExecutionListInput, ExecutionLogsInput, ExecutionLogsPage, ExecutionRunInput, ProcessStartInput, RegisteredPort, RegisterPortInput, WorkerExecution, WorkerLog,
} from "@shared/environment-contracts";
import {
  environmentDirectoryPathSchema, environmentFileContentSchema, environmentFileReadSchema, environmentFileSchema, environmentFileWriteSchema,
  environmentMutationSchema, environmentScopeSchema, executionIdSchema, executionListSchema, executionLogsSchema, executionRunSchema,
  processStartSchema, registeredPortSchema, registerPortSchema, workerExecutionSchema, workerHealthSchema, workerLogSchema, workerLogsPageSchema, workerPendingCancelAckSchema,
} from "@shared/environment-schemas";
import { ENV_WORKER_VERSION } from "@shared/environment-contracts";
import type { EnvironmentRepository } from "./environment-repository";
import type { SecretCodec } from "./settings";
import { AevorenBotError } from "./errors";
import { DockerCommandError, DockerDriver, EXECUTION_IMAGE_REF, type DockerImage } from "./docker-driver";
import { ExecutionWorkerClient, ExecutionWorkerError } from "./execution-worker-client";

const executionPreviewSchema = z.object({ id: z.string().uuid(), registeredPortId: z.string().uuid(), processId: z.string().uuid(),
  port: z.number().int().min(1).max(65_535), host: z.string().min(1).max(256), expiresAt: z.string().datetime({ offset: true }) }).strict();
export type ExecutionPreview = z.infer<typeof executionPreviewSchema>;

function failure(error: unknown): AevorenBotError {
  if (error instanceof AevorenBotError) return error;
  if (error instanceof DockerCommandError && /OWNERSHIP|IMAGE_INVALID/.test(error.code)) return new AevorenBotError("ENVIRONMENT_IMAGE_INVALID");
  if (error instanceof ExecutionWorkerError && error.status === 409) return new AevorenBotError("ENVIRONMENT_EXECUTION_CONFLICT");
  if (error instanceof ExecutionWorkerError && error.status === 404) return new AevorenBotError("ENVIRONMENT_EXECUTION_NOT_FOUND");
  return new AevorenBotError("ENVIRONMENT_UNAVAILABLE");
}

/** Shares one host-owned business service between IPC and Runtime operations. */
export class EnvironmentService {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly watchers = new Map<string, AbortController>();
  private readonly retiringSessions = new Set<string>();
  private readonly retiringExecutors = new Set<string>();
  private readonly retiringScopes = new Set<string>();
  private initializing?: Promise<EnvironmentInitializeResult>;
  private companionLifecycle?: (scope: EnvironmentScope, remove: boolean) => Promise<void>;

  setCompanionLifecycle(callback: (scope: EnvironmentScope, remove: boolean) => Promise<void>): void { this.companionLifecycle = callback; }

  constructor(private readonly repository: EnvironmentRepository, private readonly codec: SecretCodec, private readonly contextPath: string,
    private readonly changed: (event: EnvironmentChangedEvent) => void = () => undefined, private readonly docker: DockerDriver = new DockerDriver()) {}

  private async locked<T>(scope: EnvironmentScope, work: () => Promise<T>): Promise<T> {
    const key = `${scope.sessionId}:${scope.executorBotId}`;
    const previous = this.locks.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(work);
    this.locks.set(key, result);
    try { return await result; } finally { if (this.locks.get(key) === result) this.locks.delete(key); }
  }

  private emit(scope: EnvironmentScope, environmentId: string, type: EnvironmentChangedEvent["type"], executionId?: string, log?: WorkerLog): void {
    this.changed({ ...scope, environmentId, type, ...(executionId ? { executionId } : {}), ...(log ? { log } : {}) });
  }

  private assertActive(scope: EnvironmentScope): void {
    if (this.retiringSessions.has(scope.sessionId) || this.retiringExecutors.has(scope.executorBotId) || this.retiringScopes.has(`${scope.sessionId}:${scope.executorBotId}`)) throw new AevorenBotError("ENVIRONMENT_SCOPE_INVALID");
    this.repository.get(scope);
  }

  /** Holds admission and scope locks through the host's final deletion transaction. */
  async retire<T>(sessionIds: string[], executorBotIds: string[], preflight: () => void, commit: () => T, scopes: EnvironmentScope[] = []): Promise<T> {
    preflight();
    sessionIds.forEach(id => this.retiringSessions.add(id));
    executorBotIds.forEach(id => this.retiringExecutors.add(id));
    scopes.forEach(scope => this.retiringScopes.add(`${scope.sessionId}:${scope.executorBotId}`));
    const records = this.repository.listInternal().filter(record => sessionIds.includes(record.sessionId) || executorBotIds.includes(record.executorBotId)
      || scopes.some(scope => record.sessionId === scope.sessionId && record.executorBotId === scope.executorBotId));
    const acquire = async (index: number): Promise<T> => {
      if (index < records.length) return this.locked(records[index]!, () => acquire(index + 1));
      preflight();
      for (const record of records) {
        await this.companionLifecycle?.(record, true);
        await this.docker.stop(record.id);
        await this.docker.remove(record.id);
        for (const execution of this.repository.listExecutions(record)) this.watchers.get(execution.id)?.abort();
      }
      return commit();
    };
    try { return await acquire(0); } catch (error) { throw failure(error); }
    finally {
      sessionIds.forEach(id => this.retiringSessions.delete(id));
      executorBotIds.forEach(id => this.retiringExecutors.delete(id));
      scopes.forEach(scope => this.retiringScopes.delete(`${scope.sessionId}:${scope.executorBotId}`));
    }
  }

  private async bundleDigest(): Promise<string> {
    const hash = createHash("sha256");
    for (const name of ["index.mjs", "file-helper.mjs", "Dockerfile"]) { hash.update(name); hash.update(await readFile(join(this.contextPath, name))); }
    return hash.digest("hex");
  }

  async probe(signal?: AbortSignal): Promise<EnvironmentProbe> {
    const result = await this.docker.probe(signal);
    let image: DockerImage | null = null;
    if (result.status === "ready") {
      try { image = await this.docker.inspectImage(undefined, signal); } catch { /* No image is advertised until it can be inspected. */ }
    }
    return { available: result.status === "ready", dockerInstalled: result.status !== "missing", daemonReachable: result.status === "ready",
      serverVersion: result.version, platform: result.platform, workerImagePresent: image !== null, reason: result.reason };
  }

  initialize(signal?: AbortSignal): Promise<EnvironmentInitializeResult> {
    if (this.initializing) return this.initializing;
    const task = (async () => {
      try {
        const digest = await this.bundleDigest();
        const existing = await this.docker.inspectImage(undefined, signal);
        const image = existing?.bundleSha256 === digest && existing.workerVersion === ENV_WORKER_VERSION ? existing : await this.docker.initialize(this.contextPath, digest, signal);
        signal?.throwIfAborted();
        return { probe: await this.probe(signal), imageRef: EXECUTION_IMAGE_REF, imageDigest: image.id, workerVersion: image.workerVersion };
      } catch (error) { signal?.throwIfAborted(); throw failure(error); }
    })();
    this.initializing = task;
    void task.finally(() => { if (this.initializing === task) this.initializing = undefined; }).catch(() => undefined);
    return task;
  }

  list(input: EnvironmentScope): Environment[] { return this.repository.list(environmentScopeSchema.parse(input)); }

  private async client(scope: EnvironmentScope): Promise<ExecutionWorkerClient> {
    const value = this.repository.getInternal(scope);
    if (!value) throw new AevorenBotError("ENVIRONMENT_NOT_FOUND");
    if (value.state !== "running" || !value.workerPort || !value.encryptedToken) throw new AevorenBotError("ENVIRONMENT_UNAVAILABLE");
    let token: string;
    try { token = this.codec.decrypt(value.encryptedToken); } catch { throw new AevorenBotError("ENVIRONMENT_UNAVAILABLE"); }
    return new ExecutionWorkerClient(value.workerPort, token, value.id);
  }

  async get(input: EnvironmentScope): Promise<Environment | null> {
    const scope = environmentScopeSchema.parse(input);
    const current = this.repository.get(scope);
    if (!current) return null;
    if (this.locks.has(`${scope.sessionId}:${scope.executorBotId}`)) return current;
    try {
      const container = await this.docker.inspect(current.id);
      if (!container || container.state !== "running") {
        if (current.state !== "stopped") this.repository.update(scope, current.version, { state: "stopped", workerPort: null });
      } else {
        const record = this.repository.getInternal(scope)!;
        if (!record.encryptedToken || container.imageId !== current.imageDigest) throw new AevorenBotError("ENVIRONMENT_IMAGE_INVALID");
        const connection = new ExecutionWorkerClient(container.workerPort!, this.codec.decrypt(record.encryptedToken), current.id);
        const health = workerHealthSchema.parse(await connection.health());
        if (health.workerVersion !== current.workerVersion) throw new AevorenBotError("ENVIRONMENT_IMAGE_INVALID");
        if (current.state !== "running" || record.workerPort !== container.workerPort || record.bootId !== health.bootId) this.repository.update(scope, current.version, {
          state: "running", workerPort: container.workerPort, containerId: container.id, bootId: health.bootId,
        });
      }
    } catch {
      const actual = this.repository.get(scope)!;
      if (actual.state !== "unknown") this.repository.update(scope, actual.version, { state: "unknown" });
    }
    return this.repository.get(scope);
  }

  /** Host-only: attaching a companion can reallocate a Linux Docker published port. */
  async reconcileBinding(input: EnvironmentScope, signal?: AbortSignal): Promise<Environment> {
    const scope = environmentScopeSchema.parse(input); this.assertActive(scope);
    const before = this.repository.getInternal(scope);
    if (!before || before.state !== "running" || !before.encryptedToken) throw new AevorenBotError("ENVIRONMENT_UNAVAILABLE");
    try {
      const container = await this.docker.inspect(before.id, signal); this.assertActive(scope);
      if (!container || container.state !== "running" || !container.workerPort) throw new AevorenBotError("ENVIRONMENT_UNAVAILABLE");
      if (container.imageId !== before.imageDigest || container.id !== before.containerId) throw new AevorenBotError("ENVIRONMENT_IMAGE_INVALID");
      const connection = new ExecutionWorkerClient(container.workerPort, this.codec.decrypt(before.encryptedToken), before.id);
      const health = workerHealthSchema.parse(await connection.health(signal)); this.assertActive(scope); signal?.throwIfAborted();
      if (health.workerVersion !== before.workerVersion) throw new AevorenBotError("ENVIRONMENT_IMAGE_INVALID");
      const current = this.repository.getInternal(scope)!;
      if (current.id !== before.id || current.imageDigest !== before.imageDigest || current.containerId !== before.containerId || current.encryptedToken !== before.encryptedToken) throw new AevorenBotError("ENVIRONMENT_VERSION_CONFLICT");
      if (current.state !== "running") throw new AevorenBotError("ENVIRONMENT_UNAVAILABLE");
      if (current.version !== before.version && (current.workerPort !== container.workerPort || current.bootId !== health.bootId)) throw new AevorenBotError("ENVIRONMENT_VERSION_CONFLICT");
      if (current.workerPort !== container.workerPort || current.bootId !== health.bootId) this.repository.update(scope, current.version, { workerPort: container.workerPort, bootId: health.bootId });
      return this.repository.get(scope)!;
    } catch (error) { signal?.throwIfAborted(); throw failure(error); }
  }

  start(input: EnvironmentMutationInput, signal?: AbortSignal): Promise<Environment> {
    const parsed = environmentMutationSchema.parse(input);
    return this.locked(parsed, () => this.startUnlocked(parsed, signal));
  }

  private async startUnlocked(parsed: EnvironmentMutationInput, signal?: AbortSignal): Promise<Environment> {
      this.assertActive(parsed);
      signal?.throwIfAborted();
      let current = this.repository.getInternal(parsed);
      if (current && parsed.expectedVersion !== undefined && current.version !== parsed.expectedVersion) throw new AevorenBotError("ENVIRONMENT_VERSION_CONFLICT");
      if (!this.codec.isAvailable()) throw new AevorenBotError("ENVIRONMENT_UNAVAILABLE", "宿主密钥库尚未就绪。");
      const image = current ? await this.docker.inspectImage(current.imageDigest, signal) : await this.docker.inspectImage(undefined, signal);
      if (!image) throw new AevorenBotError("ENVIRONMENT_UNAVAILABLE", "请先初始化 Worker 镜像。");
      if (!current) {
        await this.bundleDigest().then(digest => { if (digest !== image.bundleSha256) throw new AevorenBotError("ENVIRONMENT_IMAGE_INVALID"); });
        this.assertActive(parsed);
        this.repository.ensure(parsed, { workerVersion: image.workerVersion, imageRef: EXECUTION_IMAGE_REF, imageDigest: image.id, platform: image.platform });
        current = this.repository.getInternal(parsed)!;
      }
      const token = current.encryptedToken ? this.codec.decrypt(current.encryptedToken) : randomBytes(32).toString("hex");
      this.repository.update(parsed, current.version, { state: "starting", encryptedToken: this.codec.encrypt(token) });
      try {
        const existing = await this.docker.inspect(current.id, signal);
        if (existing && existing.imageId !== current.imageDigest) throw new AevorenBotError("ENVIRONMENT_IMAGE_INVALID");
        const container = existing?.state === "running" ? existing : existing ? await this.docker.start(current.id, signal) : await this.docker.create(current.id, image, token, signal);
        const connection = new ExecutionWorkerClient(container.workerPort!, token, current.id);
        const health = workerHealthSchema.parse(await connection.waitHealthy(signal));
        if (health.workerVersion !== current.workerVersion) throw new AevorenBotError("ENVIRONMENT_IMAGE_INVALID");
        const now = this.repository.getInternal(parsed)!;
        const ready = this.repository.update(parsed, now.version, { state: "running", containerId: container.id, workerPort: container.workerPort, bootId: health.bootId });
        this.emit(parsed, ready.id, "environment");
        return ready;
      } catch (error) {
        const now = this.repository.getInternal(parsed);
        if (now) this.repository.update(parsed, now.version, { state: "unknown" });
        signal?.throwIfAborted(); throw failure(error);
      }
  }

  stop(input: EnvironmentMutationInput, signal?: AbortSignal): Promise<Environment> {
    const parsed = environmentMutationSchema.parse(input);
    return this.locked(parsed, () => this.stopUnlocked(parsed, signal));
  }

  private async stopUnlocked(parsed: EnvironmentMutationInput, signal?: AbortSignal): Promise<Environment> {
      const value = this.repository.get(parsed);
      if (!value) throw new AevorenBotError("ENVIRONMENT_NOT_FOUND");
      if (parsed.expectedVersion !== undefined && value.version !== parsed.expectedVersion) throw new AevorenBotError("ENVIRONMENT_VERSION_CONFLICT");
      await this.companionLifecycle?.(parsed, false);
      try { await this.docker.stop(value.id, signal); } catch (error) { throw failure(error); }
      const current = this.repository.get(parsed)!;
      const result = this.repository.update(parsed, current.version, { state: "stopped", workerPort: null });
      for (const execution of this.repository.listExecutions(parsed)) if (execution.state === "running" || execution.state === "unknown") {
        this.repository.updateExecution(parsed, execution.id, execution.version, { state: "interrupted", endedAt: new Date().toISOString(), errorCode: "ENVIRONMENT_STOPPED" });
      }
      this.emit(parsed, result.id, "environment");
      return result;
  }

  async rebuild(input: EnvironmentMutationInput, signal?: AbortSignal): Promise<Environment> {
    const parsed = environmentMutationSchema.parse(input);
    return this.locked(parsed, async () => {
    const current = this.repository.get(parsed);
    if (!current) return this.startUnlocked(parsed, signal);
    if (parsed.expectedVersion !== undefined && current.version !== parsed.expectedVersion) throw new AevorenBotError("ENVIRONMENT_VERSION_CONFLICT");
    const image = await this.docker.inspectImage(undefined, signal);
    if (!image || image.bundleSha256 !== await this.bundleDigest()) throw new AevorenBotError("ENVIRONMENT_IMAGE_INVALID");
    await this.stopUnlocked(parsed, signal);
    await this.companionLifecycle?.(parsed, true);
    await this.docker.remove(current.id, signal);
    const stopped = this.repository.get(parsed)!;
    this.repository.update(parsed, stopped.version, { workerVersion: image.workerVersion, imageRef: image.ref, imageDigest: image.id, platform: image.platform,
      encryptedToken: null, containerId: null, workerPort: null, bootId: null });
    return this.startUnlocked({ ...parsed, expectedVersion: this.repository.get(parsed)!.version }, signal);
    });
  }

  private saveWire(scope: EnvironmentScope, value: unknown): Execution {
    const wire: WorkerExecution = workerExecutionSchema.parse(value);
    const existing = this.repository.getExecution(scope, wire.id);
    if (wire.environmentId !== existing.environmentId || wire.executionSessionId !== existing.executionSessionId || wire.runtimeRunId !== existing.runtimeRunId
      || wire.kind !== existing.kind || wire.command !== existing.command || wire.cwd !== existing.cwd) throw new AevorenBotError("ENVIRONMENT_SCOPE_INVALID");
    if (existing.lastSeq > wire.lastSeq || ["completed", "failed", "cancelled", "interrupted"].includes(existing.state) && wire.state === "running") return existing;
    if (existing.state === wire.state && existing.pid === wire.pid && existing.exitCode === wire.exitCode && existing.signal === wire.signal
      && existing.startedAt === wire.startedAt && existing.endedAt === wire.endedAt && existing.lastSeq === wire.lastSeq
      && (!wire.truncated || existing.truncated) && existing.errorCode === wire.errorCode) return existing;
    const updated = this.repository.updateExecution(scope, existing.id, existing.version, {
      state: wire.state, pid: wire.pid, exitCode: wire.exitCode, signal: wire.signal, startedAt: wire.startedAt, endedAt: wire.endedAt,
      lastSeq: wire.lastSeq, truncated: existing.truncated || wire.truncated, errorCode: wire.errorCode ?? null,
    });
    this.emit(scope, updated.environmentId, "execution", updated.id);
    return updated;
  }

  private watch(scope: EnvironmentScope, execution: Execution): void {
    if (this.watchers.has(execution.id) || execution.state !== "running") return;
    const controller = new AbortController();
    this.watchers.set(execution.id, controller);
    void (async () => {
      const client = await this.client(scope);
      await client.events(`/v1/${execution.kind === "background" ? "processes" : "executions"}/${execution.id}/events?after=${execution.lastSeq}`, (event, value) => {
        if (event === "end") { this.saveWire(scope, value); return; }
        if (event !== "log" && event !== "message") return;
        const log = workerLogSchema.parse(value);
        if (log.executionId !== execution.id) throw new AevorenBotError("ENVIRONMENT_SCOPE_INVALID");
        this.repository.appendLogs(scope, execution.id, [log]);
        this.emit(scope, execution.environmentId, "log", execution.id, log);
      }, controller.signal);
    })().catch(() => {
      if (controller.signal.aborted) return;
      try {
        const current = this.repository.getExecution(scope, execution.id);
        if (current.state === "running") this.repository.updateExecution(scope, current.id, current.version, { state: "unknown", errorCode: "WORKER_DISCONNECTED" });
        this.emit(scope, current.environmentId, "execution", current.id);
      } catch { /* Revocation blocks further observations. */ }
    }).finally(() => { if (this.watchers.get(execution.id) === controller) this.watchers.delete(execution.id); });
  }

  async run(input: ExecutionRunInput | ProcessStartInput, runtimeRunId: string | null = null, background = false, signal?: AbortSignal): Promise<Execution> {
    const parsed = (background ? processStartSchema : executionRunSchema).parse(input);
    return this.locked(parsed, () => this.runUnlocked(parsed, runtimeRunId, background, signal));
  }

  private async runUnlocked(parsed: ExecutionRunInput | ProcessStartInput, runtimeRunId: string | null, background: boolean, signal?: AbortSignal): Promise<Execution> {
    this.assertActive(parsed);
    const environment = this.repository.get(parsed);
    if (!environment || environment.state !== "running") throw new AevorenBotError("ENVIRONMENT_UNAVAILABLE");
    const session = this.repository.createSession(parsed, runtimeRunId);
    const timeoutMs = "timeoutMs" in parsed && typeof parsed.timeoutMs === "number" ? parsed.timeoutMs : undefined;
    const prepared = this.repository.createExecution(parsed, { executionSessionId: session.id, clientNonce: parsed.clientNonce,
      kind: background ? "background" : "foreground", command: parsed.command, cwd: parsed.cwd ?? ".", ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
    if (prepared.disposition === "existing") return this.getExecution({ sessionId: parsed.sessionId, executorBotId: parsed.executorBotId, id: prepared.execution.id });
    try {
      signal?.throwIfAborted();
      const client = await this.client(parsed);
      const wire = await client.request(`/v1/${background ? "processes" : "executions"}`, "POST", {
        id: prepared.execution.id, sessionId: session.id, runtimeRunId, kind: background ? "background" : "foreground",
        command: parsed.command, cwd: parsed.cwd ?? ".", ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      }, signal);
      const execution = this.saveWire(parsed, wire);
      this.watch(parsed, execution);
      return execution;
    } catch (error) {
      const existing = this.repository.getExecution(parsed, prepared.execution.id);
      if (["running", "unknown"].includes(existing.state)) {
        this.repository.updateExecution(parsed, existing.id, existing.version, { state: "unknown", errorCode: "EXECUTION_START_UNCONFIRMED" });
        this.emit(parsed, environment.id, "execution", existing.id);
      }
      if (signal?.aborted) await this.cancel({ sessionId: parsed.sessionId, executorBotId: parsed.executorBotId, id: existing.id }).catch(() => undefined);
      signal?.throwIfAborted(); throw failure(error);
    }
  }

  async getExecution(input: ExecutionIdInput): Promise<Execution> {
    const parsed = executionIdSchema.parse(input), existing = this.repository.getExecution(parsed, parsed.id);
    try {
      const client = await this.client(parsed);
      const result = this.saveWire(parsed, await client.request(`/v1/${existing.kind === "background" ? "processes" : "executions"}/${existing.id}`));
      this.watch(parsed, result); return result;
    } catch {
      const current = this.repository.getExecution(parsed, parsed.id);
      if (current.state === "running") return this.repository.updateExecution(parsed, current.id, current.version, { state: "unknown", errorCode: "WORKER_DISCONNECTED" });
      return current;
    }
  }

  async listExecutions(input: ExecutionListInput, kind?: "foreground" | "background"): Promise<Execution[]> {
    const parsed = executionListSchema.parse(input);
    if (!this.repository.get(parsed)) return [];
    const values = this.repository.listExecutions(parsed, { ...(kind ? { kind } : {}), ...(parsed.state ? { state: parsed.state } : {}) });
    return Promise.all(values.map(value => this.getExecution({ sessionId: parsed.sessionId, executorBotId: parsed.executorBotId, id: value.id })));
  }

  async cancel(input: ExecutionIdInput, signal?: AbortSignal): Promise<Execution> {
    const parsed = executionIdSchema.parse(input), current = this.repository.getExecution(parsed, parsed.id);
    const client = await this.client(parsed);
    try {
      const result = await client.request<unknown>(`/v1/${current.kind === "background" ? "processes" : "executions"}/${current.id}/${current.kind === "background" ? "stop" : "cancel"}`, "POST", {}, signal);
      if (result && typeof result === "object" && "pending" in result) {
        const acknowledgement = workerPendingCancelAckSchema.parse(result);
        if (acknowledgement.id !== current.id) throw new AevorenBotError("ENVIRONMENT_SCOPE_INVALID");
        const actual = this.repository.getExecution(parsed, current.id);
        if (!["running", "unknown"].includes(actual.state)) return actual;
        const cancelled = this.repository.updateExecution(parsed, current.id, actual.version, { state: "cancelled", endedAt: new Date().toISOString(), errorCode: "EXECUTION_CANCELLED_BEFORE_START" });
        this.emit(parsed, cancelled.environmentId, "execution", cancelled.id);
        return cancelled;
      }
      return this.saveWire(parsed, result);
    }
    catch (error) { signal?.throwIfAborted(); throw failure(error); }
  }

  async logs(input: ExecutionLogsInput): Promise<ExecutionLogsPage> {
    const parsed = executionLogsSchema.parse(input), execution = this.repository.getExecution(parsed, parsed.id);
    try {
      const client = await this.client(parsed);
      const query = new URLSearchParams({ after: String(parsed.afterSeq ?? 0), limit: String(parsed.limit ?? 100), maxBytes: String(parsed.maxBytes ?? 65_536) });
      const result = workerLogsPageSchema.parse(await client.request(`/v1/${execution.kind === "background" ? "processes" : "executions"}/${execution.id}/logs?${query}`));
      if (result.executionId !== execution.id) throw new AevorenBotError("ENVIRONMENT_SCOPE_INVALID");
      this.repository.appendLogs(parsed, execution.id, result.logs);
      return result;
    } catch (error) {
      if (error instanceof ExecutionWorkerError && error.code === "WORKER_LOG_CURSOR_EXPIRED") {
        throw new AevorenBotError("ENVIRONMENT_LOG_CURSOR_EXPIRED", undefined, undefined, error.firstSeq ? { firstSeq: error.firstSeq } : undefined);
      }
      return this.repository.logs(parsed, execution.id, parsed);
    }
  }

  async listFiles(input: EnvironmentScope & { path?: string }): Promise<EnvironmentFileList> {
    const scope = environmentScopeSchema.parse({ sessionId: input.sessionId, executorBotId: input.executorBotId });
    const path = environmentDirectoryPathSchema.parse(input.path ?? ".");
    const client = await this.client(scope);
    const result = await client.request<EnvironmentFileList>(`/v1/files?path=${encodeURIComponent(path)}`);
    if (result.path !== path || !Array.isArray(result.entries) || typeof result.truncated !== "boolean") throw new AevorenBotError("ENVIRONMENT_FILE_INVALID");
    this.repository.get(scope);
    return { ...result, entries: result.entries.map(entry => environmentFileSchema.parse(entry)) };
  }

  async readFile(input: EnvironmentFileReadInput): Promise<EnvironmentFileContent> {
    const parsed = environmentFileReadSchema.parse(input), client = await this.client(parsed);
    const result = environmentFileContentSchema.parse(await client.request(`/v1/files/content?path=${encodeURIComponent(parsed.path)}`));
    const bytes = Buffer.from(result.content, result.encoding === "base64" ? "base64" : "utf8");
    if (result.path !== parsed.path || bytes.length !== result.size || createHash("sha256").update(bytes).digest("hex") !== result.sha256) throw new AevorenBotError("ENVIRONMENT_FILE_INVALID");
    this.repository.get(parsed);
    return result;
  }

  async writeFile(input: EnvironmentFileWriteInput, signal?: AbortSignal): Promise<EnvironmentFileWriteResult> {
    const parsed = environmentFileWriteSchema.parse(input), client = await this.client(parsed);
    const bytes = Buffer.from(parsed.content, parsed.encoding === "base64" ? "base64" : "utf8"), digest = createHash("sha256").update(bytes).digest("hex");
    const result = await client.request<EnvironmentFileWriteResult>(`/v1/files/content?path=${encodeURIComponent(parsed.path)}`, "PUT", {
      path: parsed.path, content: parsed.content, encoding: parsed.encoding ?? "utf8", ...(parsed.expectedSha256 ? { expectedSha256: parsed.expectedSha256 } : {}),
    }, signal);
    if (result.path !== parsed.path || result.sha256 !== digest || result.size !== bytes.length) throw new AevorenBotError("ENVIRONMENT_FILE_INVALID");
    this.repository.get(parsed); signal?.throwIfAborted();
    return result;
  }

  async registerPort(input: RegisterPortInput, signal?: AbortSignal): Promise<RegisteredPort> {
    const parsed = registerPortSchema.parse(input), process = this.repository.getExecution(parsed, parsed.processId);
    if (process.kind !== "background") throw new AevorenBotError("ENVIRONMENT_EXECUTION_STATE_INVALID");
    const existing = this.repository.listPorts(parsed).find(port => port.processId === parsed.processId && port.port === parsed.port);
    const id = existing?.id ?? globalThis.crypto.randomUUID();
    let wire: unknown;
    try {
      const client = await this.client(parsed);
      wire = await client.request("/v1/ports", "POST", { id, processId: parsed.processId, port: parsed.port, label: parsed.label ?? "" }, signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof ExecutionWorkerError && error.code === "WORKER_PORT_NOT_OWNED") throw new AevorenBotError("ENVIRONMENT_PORT_NOT_FOUND");
      throw failure(error);
    }
    const result = registeredPortSchema.parse(wire);
    if (result.id !== id || result.processId !== parsed.processId || result.port !== parsed.port) throw new AevorenBotError("ENVIRONMENT_SCOPE_INVALID");
    return this.repository.upsertPort(parsed, result);
  }

  async listPorts(input: EnvironmentScope): Promise<RegisteredPort[]> {
    const scope = environmentScopeSchema.parse(input);
    if (!this.repository.get(scope)) return [];
    try {
      const client = await this.client(scope);
      const values = await client.request<RegisteredPort[]>("/v1/ports");
      return values.map(value => {
        const port = registeredPortSchema.parse(value);
        if (this.repository.getExecution(scope, port.processId).kind !== "background") throw new AevorenBotError("ENVIRONMENT_SCOPE_INVALID");
        return this.repository.upsertPort(scope, port);
      });
    } catch { return this.repository.listPorts(scope).map(port => ({ ...port, state: "unknown" })); }
  }

  async cancelRuntime(runtimeRunId: string): Promise<void> {
    const records = this.repository.listRuntimeExecutions(runtimeRunId);
    const sessions = new Map<string, Execution>();
    for (const record of records) if (record.kind === "foreground" && ["running", "unknown"].includes(record.state)) sessions.set(record.executionSessionId, record);
    await Promise.allSettled([...sessions.values()].map(async record => {
      const scope = this.repository.listInternal().find(environment => environment.id === record.environmentId);
      if (!scope) return;
      const client = await this.client(scope);
      const wire = await client.request<unknown>(`/v1/execution-sessions/${record.executionSessionId}/cancel`, "POST", {});
      if (!Array.isArray(wire)) throw new AevorenBotError("ENVIRONMENT_SCOPE_INVALID");
      for (const value of wire) {
        const execution = workerExecutionSchema.parse(value);
        if (execution.kind !== "foreground" || execution.executionSessionId !== record.executionSessionId) throw new AevorenBotError("ENVIRONMENT_SCOPE_INVALID");
        this.saveWire(scope, execution);
      }
      for (const pending of records) if (pending.kind === "foreground" && pending.executionSessionId === record.executionSessionId) {
        const current = this.repository.getExecution(scope, pending.id);
        if (["running", "unknown"].includes(current.state)) {
          this.repository.updateExecution(scope, current.id, current.version, { state: "cancelled", endedAt: new Date().toISOString(), errorCode: "EXECUTION_SESSION_CANCELLED" });
          this.emit(scope, current.environmentId, "execution", current.id);
        }
      }
    }));
  }

  async createPreview(input: EnvironmentScope, id: string, registeredPortId: string, signal?: AbortSignal): Promise<ExecutionPreview> {
    const parsed = environmentScopeSchema.parse(input); z.string().uuid().parse(id); z.string().uuid().parse(registeredPortId);
    const actual = (await this.listPorts(parsed)).find(port => port.id === registeredPortId && port.state === "listening");
    if (!actual) throw new AevorenBotError("PREVIEW_UNAVAILABLE");
    const client = await this.client(parsed);
    try {
      const preview = executionPreviewSchema.parse(await client.request("/v1/previews", "POST", { id, registeredPortId }, signal));
      const environment = this.repository.get(parsed)!;
      if (preview.id !== id || preview.registeredPortId !== registeredPortId || preview.processId !== actual.processId || preview.port !== actual.port
        || !new RegExp(`^[a-f0-9]{32}\\.[a-f0-9]{32}\\.aevoren-preview-${environment.id}\\.internal$`).test(preview.host)) throw new AevorenBotError("ENVIRONMENT_SCOPE_INVALID");
      return preview;
    } catch (error) {
      if (error instanceof ExecutionWorkerError && error.status === 404) throw new AevorenBotError("PREVIEW_UNAVAILABLE", "当前执行镜像未提供受控预览；请在停止相关服务后明确重建环境。");
      signal?.throwIfAborted(); throw failure(error);
    }
  }

  async closePreview(input: EnvironmentScope, id: string): Promise<void> {
    const parsed = environmentScopeSchema.parse(input); z.string().uuid().parse(id);
    await (await this.client(parsed)).request(`/v1/previews/${id}/close`, "POST", {});
  }

  async recover(): Promise<void> {
    const records: { record: import("@shared/environment-contracts").InternalEnvironmentRecord; foreground: Execution[] }[] = [];
    for (const record of this.repository.listInternal()) {
      try { records.push({ record, foreground: this.repository.listExecutions(record, { kind: "foreground" })
        .filter(execution => ["running", "unknown"].includes(execution.state)) }); } catch { /* An unavailable scope cannot block sibling recovery. */ }
    }
    for (const { record, foreground } of records) {
      const scope = { sessionId: record.sessionId, executorBotId: record.executorBotId };
      try {
        await this.get(scope);
        for (const execution of foreground) await this.cancel({ ...scope, id: execution.id }).catch(() => undefined);
        await this.listExecutions(scope);
      } catch { /* No task is replayed to recover an unavailable environment. */ }
    }
  }

  async shutdown(): Promise<void> {
    const foreground: { environment: import("@shared/environment-contracts").InternalEnvironmentRecord; execution: Execution }[] = [];
    for (const environment of this.repository.listInternal()) {
      try { foreground.push(...this.repository.listExecutions(environment, { kind: "foreground" })
        .filter(execution => ["running", "unknown"].includes(execution.state)).map(execution => ({ environment, execution }))); }
      catch { /* Revoked or deleted scopes cannot prevent cleanup of valid tasks. */ }
    }
    await Promise.allSettled(foreground.map(({ environment, execution }) => this.cancel({ sessionId: environment.sessionId, executorBotId: environment.executorBotId, id: execution.id })));
    for (const watcher of this.watchers.values()) watcher.abort();
    this.watchers.clear();
  }
}
