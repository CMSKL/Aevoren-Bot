import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type {
  Environment, EnvironmentPlatform, EnvironmentScope, EnvironmentState, Execution, ExecutionKind,
  ExecutionLogsPage, ExecutionSession, ExecutionState, InternalEnvironmentRecord, RegisteredPort, WorkerLog,
} from "@shared/environment-contracts";
import { ENV_LOG_MAX_BYTES, ENV_FOREGROUND_TIMEOUT_MS } from "@shared/environment-contracts";
import {
  environmentScopeSchema, environmentSchema, executionCommandSchema, environmentDirectoryPathSchema,
  executionStateSchema, workerLogSchema, registerPortSchema, registeredPortSchema,
} from "@shared/environment-schemas";
import { AevorenBotError } from "./errors";

export const ENVIRONMENT_MIGRATION = {
  version: 35,
  sql: `
    CREATE TABLE environments (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), executor_bot_id TEXT NOT NULL REFERENCES bots(id),
      version INTEGER NOT NULL CHECK(version > 0), state TEXT NOT NULL CHECK(state IN ('starting','running','stopped','error','unknown')),
      worker_version TEXT NOT NULL, image_ref TEXT NOT NULL, image_digest TEXT NOT NULL, platform TEXT NOT NULL CHECK(platform IN ('linux/arm64','linux/amd64')),
      container_id TEXT, worker_port INTEGER, encrypted_token TEXT, boot_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(session_id, executor_bot_id)
    );
    CREATE TABLE execution_sessions (
      id TEXT PRIMARY KEY, environment_id TEXT NOT NULL REFERENCES environments(id), runtime_run_id TEXT,
      created_at TEXT NOT NULL, UNIQUE(environment_id,runtime_run_id)
    );
    CREATE TABLE environment_executions (
      id TEXT PRIMARY KEY, environment_id TEXT NOT NULL REFERENCES environments(id), execution_session_id TEXT NOT NULL REFERENCES execution_sessions(id),
      runtime_run_id TEXT, client_nonce TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0),
      kind TEXT NOT NULL CHECK(kind IN ('foreground','background')), command TEXT NOT NULL, cwd TEXT NOT NULL, timeout_ms INTEGER,
      state TEXT NOT NULL CHECK(state IN ('running','completed','failed','cancelled','interrupted','unknown')),
      pid INTEGER, exit_code INTEGER, signal TEXT, error_code TEXT, created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT,
      last_seq INTEGER NOT NULL DEFAULT 0, first_seq INTEGER NOT NULL DEFAULT 0, log_bytes INTEGER NOT NULL DEFAULT 0,
      truncated INTEGER NOT NULL DEFAULT 0 CHECK(truncated IN (0,1)), UNIQUE(environment_id,client_nonce)
    );
    CREATE TABLE environment_logs (
      execution_id TEXT NOT NULL REFERENCES environment_executions(id), seq INTEGER NOT NULL CHECK(seq > 0),
      stream TEXT NOT NULL CHECK(stream IN ('stdout','stderr','state')), text TEXT NOT NULL, bytes_base64 TEXT, at TEXT NOT NULL,
      PRIMARY KEY(execution_id,seq)
    );
    CREATE TABLE environment_ports (
      id TEXT PRIMARY KEY, environment_id TEXT NOT NULL REFERENCES environments(id), process_id TEXT NOT NULL REFERENCES environment_executions(id),
      port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535), label TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('listening','stopped','unknown')),
      checked_at TEXT, UNIQUE(environment_id,process_id,port)
    );
    CREATE INDEX environment_execution_runtime ON environment_executions(runtime_run_id,kind,state);
    CREATE INDEX environment_execution_order ON environment_executions(environment_id,created_at,id);
  `,
} as const;

type EnvironmentRow = { id: string; session_id: string; executor_bot_id: string; version: number; state: EnvironmentState; worker_version: string;
  image_ref: string; image_digest: string; platform: EnvironmentPlatform; container_id: string | null; worker_port: number | null;
  encrypted_token: string | null; boot_id: string | null; created_at: string; updated_at: string };
type SessionRow = { id: string; environment_id: string; runtime_run_id: string | null; created_at: string };
type ExecutionRow = { id: string; environment_id: string; execution_session_id: string; runtime_run_id: string | null; client_nonce: string; version: number;
  kind: ExecutionKind; command: string; cwd: string; timeout_ms: number | null; state: ExecutionState; pid: number | null; exit_code: number | null;
  signal: string | null; error_code: string | null; created_at: string; started_at: string | null; ended_at: string | null; last_seq: number; first_seq: number; log_bytes: number; truncated: number };
type LogRow = { seq: number; execution_id: string; stream: WorkerLog["stream"]; text: string; bytes_base64: string | null; at: string };
type PortRow = { id: string; environment_id: string; process_id: string; port: number; label: string; state: RegisteredPort["state"]; checked_at: string | null };
export type EnvironmentConfiguration = Pick<Environment, "workerVersion" | "imageRef" | "imageDigest" | "platform"> & { id?: string };
export type EnvironmentPatch = Partial<Pick<InternalEnvironmentRecord, "state" | "workerVersion" | "imageRef" | "imageDigest" | "platform" | "containerId" | "workerPort" | "encryptedToken" | "bootId">>;
export type ExecutionCreateInput = { id?: string; executionSessionId: string; clientNonce: string; kind: ExecutionKind; command: string; cwd?: string; timeoutMs?: number };
export type ExecutionPatch = Partial<Pick<Execution, "state" | "pid" | "exitCode" | "signal" | "startedAt" | "endedAt" | "lastSeq" | "truncated">> & { errorCode?: string | null };

const uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const configurationSchema = z.object({ id: uuid.optional(), workerVersion: z.string().min(1).max(80), imageRef: z.string().min(1).max(256),
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), platform: z.enum(["linux/arm64", "linux/amd64"]) }).strict();
const environmentPatchSchema = z.object({ state: z.enum(["starting", "running", "stopped", "error", "unknown"]).optional(),
  workerVersion: configurationSchema.shape.workerVersion.optional(), imageRef: configurationSchema.shape.imageRef.optional(),
  imageDigest: configurationSchema.shape.imageDigest.optional(), platform: configurationSchema.shape.platform.optional(),
  containerId: z.string().max(200).nullable().optional(), workerPort: z.number().int().min(1).max(65_535).nullable().optional(),
  encryptedToken: z.string().max(8_192).nullable().optional(), bootId: uuid.nullable().optional() }).strict().refine((input) => Object.keys(input).length > 0);
const executionCreateSchema = z.object({ id: uuid.optional(), executionSessionId: uuid, clientNonce: uuid, kind: z.enum(["foreground", "background"]),
  command: executionCommandSchema, cwd: environmentDirectoryPathSchema.optional(), timeoutMs: z.number().int().min(1).max(3_600_000).optional() }).strict();
const executionPatchSchema = z.object({ state: executionStateSchema.optional(), pid: z.number().int().positive().nullable().optional(), exitCode: z.number().int().nullable().optional(),
  signal: z.string().max(80).nullable().optional(), startedAt: timestamp.nullable().optional(), endedAt: timestamp.nullable().optional(),
  lastSeq: z.number().int().min(0).optional(), truncated: z.boolean().optional(), errorCode: z.string().max(120).nullable().optional() }).strict().refine((input) => Object.values(input).some((value) => value !== undefined));
const terminal = new Set<ExecutionState>(["completed", "failed", "cancelled", "interrupted"]);

function environment(row: EnvironmentRow): Environment {
  return { id: row.id, sessionId: row.session_id, executorBotId: row.executor_bot_id, version: row.version, state: row.state,
    workerVersion: row.worker_version, imageRef: row.image_ref, imageDigest: row.image_digest, platform: row.platform,
    createdAt: row.created_at, updatedAt: row.updated_at };
}
function internal(row: EnvironmentRow): InternalEnvironmentRecord {
  return { ...environment(row), containerId: row.container_id, workerPort: row.worker_port, encryptedToken: row.encrypted_token, bootId: row.boot_id };
}
function execution(row: ExecutionRow): Execution {
  return { id: row.id, environmentId: row.environment_id, executionSessionId: row.execution_session_id, runtimeRunId: row.runtime_run_id,
    version: row.version, kind: row.kind, command: row.command, cwd: row.cwd, state: row.state, pid: row.pid, exitCode: row.exit_code,
    signal: row.signal, createdAt: row.created_at, startedAt: row.started_at, endedAt: row.ended_at, lastSeq: row.last_seq,
    truncated: Boolean(row.truncated), ...(row.error_code ? { errorCode: row.error_code } : {}) };
}
function log(row: LogRow): WorkerLog {
  return { seq: row.seq, executionId: row.execution_id, stream: row.stream, text: row.text, at: row.at, ...(row.bytes_base64 !== null ? { bytesBase64: row.bytes_base64 } : {}) };
}
function port(row: PortRow): RegisteredPort {
  return { id: row.id, processId: row.process_id, port: row.port, label: row.label, state: row.state, checkedAt: row.checked_at };
}

export class EnvironmentRepository {
  private transactionSequence = 0;
  constructor(private readonly database: DatabaseSync, private readonly assertScope: (scope: EnvironmentScope) => void) {}

  transaction<T>(operation: () => T): T {
    const savepoint = `aevoren_environment_${++this.transactionSequence}`;
    this.database.exec(`SAVEPOINT ${savepoint};`);
    try { const result = operation(); this.database.exec(`RELEASE SAVEPOINT ${savepoint};`); return result; }
    catch (error) { this.database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint};`); throw error; }
  }

  private scope(input: EnvironmentScope): EnvironmentScope {
    const scope = environmentScopeSchema.parse({ sessionId: input.sessionId, executorBotId: input.executorBotId });
    this.assertScope(scope);
    return scope;
  }
  get(input: EnvironmentScope): Environment | null {
    const scope = this.scope(input);
    const row = this.database.prepare("SELECT * FROM environments WHERE session_id=? AND executor_bot_id=?").get(scope.sessionId, scope.executorBotId) as EnvironmentRow | undefined;
    return row ? environmentSchema.parse(environment(row)) : null;
  }
  list(scope: EnvironmentScope): Environment[] { const value = this.get(scope); return value ? [value] : []; }
  getInternal(input: EnvironmentScope): InternalEnvironmentRecord | null {
    const scope = this.scope(input);
    const row = this.database.prepare("SELECT * FROM environments WHERE session_id=? AND executor_bot_id=?").get(scope.sessionId, scope.executorBotId) as EnvironmentRow | undefined;
    return row ? internal(row) : null;
  }
  /** Host startup reconciliation only; transport handlers never expose these records. */
  listInternal(): InternalEnvironmentRecord[] { return (this.database.prepare("SELECT * FROM environments ORDER BY created_at,id").all() as EnvironmentRow[]).map(internal); }

  /** Host hard-delete hook after container release. Working volumes are managed outside SQLite. */
  deleteSession(sessionId: string): number {
    uuid.parse(sessionId);
    const ids = (this.database.prepare("SELECT id FROM environments WHERE session_id=?").all(sessionId) as { id: string }[]).map((row) => row.id);
    return this.deleteEnvironmentIds(ids);
  }

  /** Also retires the deleted Bot's group environments without touching its former peers. */
  deleteExecutor(executorBotId: string): number {
    uuid.parse(executorBotId);
    const ids = (this.database.prepare("SELECT id FROM environments WHERE executor_bot_id=?").all(executorBotId) as { id: string }[]).map((row) => row.id);
    return this.deleteEnvironmentIds(ids);
  }

  /** The host releases this container before revoking the member's live scope. */
  deleteScope(input: EnvironmentScope): number {
    const scope = this.scope(input);
    const rows = this.database.prepare("SELECT id FROM environments WHERE session_id = ? AND executor_bot_id = ?")
      .all(scope.sessionId, scope.executorBotId) as Array<{ id: string }>;
    return this.deleteEnvironmentIds(rows.map(row => row.id));
  }

  private deleteEnvironmentIds(ids: string[]): number {
    if (!ids.length) return 0;
    const placeholders = ids.map(() => "?").join(",");
    return this.transaction(() => {
      this.database.prepare(`DELETE FROM environment_ports WHERE environment_id IN (${placeholders})`).run(...ids);
      this.database.prepare(`DELETE FROM environment_logs WHERE execution_id IN
        (SELECT id FROM environment_executions WHERE environment_id IN (${placeholders}))`).run(...ids);
      this.database.prepare(`DELETE FROM environment_executions WHERE environment_id IN (${placeholders})`).run(...ids);
      this.database.prepare(`DELETE FROM execution_sessions WHERE environment_id IN (${placeholders})`).run(...ids);
      return Number(this.database.prepare(`DELETE FROM environments WHERE id IN (${placeholders})`).run(...ids).changes);
    });
  }

  ensure(input: EnvironmentScope, config: EnvironmentConfiguration): Environment {
    const scope = this.scope(input);
    const parsed = configurationSchema.parse(config);
    return this.transaction(() => {
      const old = this.getInternal(scope);
      if (old) return this.get(scope)!;
      const now = new Date().toISOString();
      this.database.prepare(`INSERT INTO environments(id,session_id,executor_bot_id,version,state,worker_version,image_ref,image_digest,platform,created_at,updated_at)
        VALUES(?,?,?,1,'stopped',?,?,?,?,?,?)`).run(parsed.id ?? randomUUID(), scope.sessionId, scope.executorBotId, parsed.workerVersion, parsed.imageRef, parsed.imageDigest, parsed.platform, now, now);
      return this.get(scope)!;
    });
  }

  update(input: EnvironmentScope, expectedVersion: number, patch: EnvironmentPatch): Environment {
    const scope = this.scope(input);
    z.number().int().positive().parse(expectedVersion);
    const parsed = environmentPatchSchema.parse(patch);
    return this.transaction(() => {
      const current = this.requireEnvironment(scope);
      if (current.version !== expectedVersion) throw new AevorenBotError("ENVIRONMENT_VERSION_CONFLICT", undefined, undefined, { currentVersion: current.version });
      const columns: Record<keyof EnvironmentPatch, string> = { state: "state", workerVersion: "worker_version", imageRef: "image_ref", imageDigest: "image_digest", platform: "platform",
        containerId: "container_id", workerPort: "worker_port", encryptedToken: "encrypted_token", bootId: "boot_id" };
      const entries = Object.entries(parsed).filter(([, value]) => value !== undefined) as [keyof EnvironmentPatch, string | number | null][];
      if (!entries.length) throw new AevorenBotError("INVALID_REQUEST");
      this.database.prepare(`UPDATE environments SET ${entries.map(([key]) => `${columns[key]}=?`).join(",")},version=version+1,updated_at=? WHERE id=? AND version=?`)
        .run(...entries.map(([, value]) => value), new Date().toISOString(), current.id, expectedVersion);
      return this.get(scope)!;
    });
  }

  createSession(input: EnvironmentScope, runtimeRunId: string | null, id = randomUUID()): ExecutionSession {
    const scope = this.scope(input);
    uuid.parse(id); uuid.nullable().parse(runtimeRunId);
    const env = this.requireEnvironment(scope);
    if (runtimeRunId) {
      const runtime = this.database.prepare("SELECT session_id,executor_bot_id FROM runtime_runs WHERE id=?").get(runtimeRunId) as { session_id: string; executor_bot_id: string } | undefined;
      if (!runtime || runtime.session_id !== scope.sessionId || runtime.executor_bot_id !== scope.executorBotId) throw new AevorenBotError("ENVIRONMENT_SCOPE_INVALID");
      const old = this.database.prepare("SELECT * FROM execution_sessions WHERE environment_id=? AND runtime_run_id=?").get(env.id, runtimeRunId) as SessionRow | undefined;
      if (old) return { id: old.id, environmentId: old.environment_id, runtimeRunId: old.runtime_run_id, createdAt: old.created_at };
    }
    const createdAt = new Date().toISOString();
    this.database.prepare("INSERT INTO execution_sessions(id,environment_id,runtime_run_id,created_at) VALUES(?,?,?,?)").run(id, env.id, runtimeRunId, createdAt);
    return { id, environmentId: env.id, runtimeRunId, createdAt };
  }

  createExecution(input: EnvironmentScope, command: ExecutionCreateInput): { disposition: "created" | "existing"; execution: Execution } {
    const scope = this.scope(input);
    const parsed = executionCreateSchema.parse(command);
    return this.transaction(() => {
      const env = this.requireEnvironment(scope);
      const executionSession = this.database.prepare("SELECT * FROM execution_sessions WHERE id=? AND environment_id=?").get(parsed.executionSessionId, env.id) as SessionRow | undefined;
      if (!executionSession) throw new AevorenBotError("ENVIRONMENT_SCOPE_INVALID");
      const old = this.database.prepare("SELECT * FROM environment_executions WHERE environment_id=? AND client_nonce=?").get(env.id, parsed.clientNonce) as ExecutionRow | undefined;
      const cwd = parsed.cwd ?? ".";
      const timeoutMs = parsed.timeoutMs ?? (parsed.kind === "foreground" ? ENV_FOREGROUND_TIMEOUT_MS : null);
      if (old) {
        if (old.kind !== parsed.kind || old.command !== parsed.command || old.cwd !== cwd || old.timeout_ms !== timeoutMs) throw new AevorenBotError("ENVIRONMENT_EXECUTION_CONFLICT");
        return { disposition: "existing", execution: execution(old) };
      }
      const id = parsed.id ?? randomUUID();
      this.database.prepare(`INSERT INTO environment_executions(id,environment_id,execution_session_id,runtime_run_id,client_nonce,version,kind,command,cwd,timeout_ms,state,created_at)
        VALUES(?,?,?,?,?,1,?,?,?,?,'unknown',?)`).run(id, env.id, executionSession.id, executionSession.runtime_run_id, parsed.clientNonce, parsed.kind, parsed.command, cwd, timeoutMs, new Date().toISOString());
      return { disposition: "created", execution: this.getExecution(scope, id) };
    });
  }

  getExecution(input: EnvironmentScope, id: string): Execution { return execution(this.executionRow(this.scope(input), uuid.parse(id))); }
  findExecutionByNonce(input: EnvironmentScope, nonce: string): Execution | null {
    const scope = this.scope(input); uuid.parse(nonce);
    const env = this.getInternal(scope);
    if (!env) return null;
    const row = this.database.prepare("SELECT * FROM environment_executions WHERE environment_id=? AND client_nonce=?").get(env.id, nonce) as ExecutionRow | undefined;
    return row ? execution(row) : null;
  }
  listExecutions(input: EnvironmentScope, filter: { kind?: ExecutionKind; state?: ExecutionState } = {}): Execution[] {
    const scope = this.scope(input);
    z.object({ kind: z.enum(["foreground", "background"]).optional(), state: executionStateSchema.optional() }).strict().parse(filter);
    const env = this.getInternal(scope);
    if (!env) return [];
    return (this.database.prepare("SELECT * FROM environment_executions WHERE environment_id=? ORDER BY created_at DESC,id").all(env.id) as ExecutionRow[])
      .filter((row) => (!filter.kind || row.kind === filter.kind) && (!filter.state || row.state === filter.state)).slice(0, 500).map(execution);
  }
  /** Host cancellation hook queries the original Runtime ownership, never a model-provided scope. */
  listRuntimeExecutions(runtimeRunId: string): Execution[] { uuid.parse(runtimeRunId); return (this.database.prepare("SELECT * FROM environment_executions WHERE runtime_run_id=? ORDER BY created_at,id").all(runtimeRunId) as ExecutionRow[]).map(execution); }

  updateExecution(input: EnvironmentScope, id: string, expectedVersion: number, patch: ExecutionPatch): Execution {
    const scope = this.scope(input); uuid.parse(id); z.number().int().positive().parse(expectedVersion);
    const parsed = executionPatchSchema.parse(patch);
    return this.transaction(() => {
      const current = this.executionRow(scope, id);
      if (current.version !== expectedVersion) throw new AevorenBotError("ENVIRONMENT_VERSION_CONFLICT", undefined, undefined, { currentVersion: current.version });
      if (parsed.state && parsed.state !== current.state && terminal.has(current.state)) throw new AevorenBotError("ENVIRONMENT_EXECUTION_STATE_INVALID");
      if (parsed.lastSeq !== undefined && parsed.lastSeq < current.last_seq) throw new AevorenBotError("ENVIRONMENT_EXECUTION_STATE_INVALID");
      const values: ExecutionPatch = { ...parsed, ...(parsed.state && terminal.has(parsed.state) && parsed.endedAt === undefined ? { endedAt: new Date().toISOString() } : {}) };
      const columns: Record<keyof ExecutionPatch, string> = { state: "state", pid: "pid", exitCode: "exit_code", signal: "signal", startedAt: "started_at", endedAt: "ended_at", lastSeq: "last_seq", truncated: "truncated", errorCode: "error_code" };
      const entries = Object.entries(values).filter(([, value]) => value !== undefined) as [keyof ExecutionPatch, string | number | boolean | null][];
      this.database.prepare(`UPDATE environment_executions SET ${entries.map(([key]) => `${columns[key]}=?`).join(",")},version=version+1 WHERE id=? AND version=?`)
        .run(...entries.map(([, value]) => typeof value === "boolean" ? Number(value) : value), id, expectedVersion);
      if (parsed.state && terminal.has(parsed.state)) this.database.prepare("UPDATE environment_ports SET state='stopped',checked_at=? WHERE process_id=?").run(new Date().toISOString(), id);
      return this.getExecution(scope, id);
    });
  }

  appendLogs(input: EnvironmentScope, id: string, logs: WorkerLog[]): ExecutionLogsPage {
    const scope = this.scope(input); uuid.parse(id); const parsed = z.array(workerLogSchema).max(500).parse(logs);
    return this.transaction(() => {
      let current = this.executionRow(scope, id);
      let changed = false;
      for (const item of parsed) {
        if (item.executionId !== id) throw new AevorenBotError("ENVIRONMENT_SCOPE_INVALID");
        const existing = this.database.prepare("SELECT * FROM environment_logs WHERE execution_id=? AND seq=?").get(id, item.seq) as LogRow | undefined;
        if (existing) {
          if (existing.stream !== item.stream || existing.text !== item.text || existing.bytes_base64 !== (item.bytesBase64 ?? null) || existing.at !== item.at) throw new AevorenBotError("ENVIRONMENT_EXECUTION_CONFLICT");
          continue;
        }
        if (current.truncated && current.first_seq > 0 && item.seq < current.first_seq) continue;
        const size = item.bytesBase64 ? Buffer.from(item.bytesBase64, "base64").length : Buffer.byteLength(item.text, "utf8");
        this.database.prepare("INSERT INTO environment_logs(execution_id,seq,stream,text,bytes_base64,at) VALUES(?,?,?,?,?,?)")
          .run(id, item.seq, item.stream, item.text, item.bytesBase64 ?? null, item.at);
        changed = true;
        this.database.prepare("UPDATE environment_executions SET last_seq=MAX(last_seq,?),log_bytes=log_bytes+? WHERE id=?").run(item.seq, size, id);
        current = this.executionRow(scope, id);
        while (current.log_bytes > ENV_LOG_MAX_BYTES) {
          const oldest = this.database.prepare("SELECT * FROM environment_logs WHERE execution_id=? ORDER BY seq LIMIT 1").get(id) as LogRow;
          const removedBytes = oldest.bytes_base64 ? Buffer.from(oldest.bytes_base64, "base64").length : Buffer.byteLength(oldest.text, "utf8");
          this.database.prepare("DELETE FROM environment_logs WHERE execution_id=? AND seq=?").run(id, oldest.seq);
          this.database.prepare("UPDATE environment_executions SET log_bytes=log_bytes-?,truncated=1,first_seq=COALESCE((SELECT MIN(seq) FROM environment_logs WHERE execution_id=?),0) WHERE id=?").run(removedBytes, id, id);
          current = this.executionRow(scope, id);
        }
      }
      const first = this.database.prepare("SELECT MIN(seq) AS seq FROM environment_logs WHERE execution_id=?").get(id) as { seq: number | null };
      if (changed) this.database.prepare("UPDATE environment_executions SET first_seq=?,version=version+1 WHERE id=?").run(first.seq ?? 0, id);
      return this.logs(scope, id, { afterSeq: Math.max(0, (first.seq ?? 1) - 1), maxBytes: 262_144 });
    });
  }

  logs(input: EnvironmentScope, id: string, options: { afterSeq?: number; limit?: number; maxBytes?: number } = {}): ExecutionLogsPage {
    const scope = this.scope(input); uuid.parse(id);
    const parsed = z.object({ afterSeq: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(500).optional(), maxBytes: z.number().int().min(1).max(262_144).optional() }).strict()
      .parse({ afterSeq: options.afterSeq, limit: options.limit, maxBytes: options.maxBytes });
    const current = this.executionRow(scope, id);
    const requestedAfter = parsed.afterSeq ?? 0;
    const afterSeq = requestedAfter === 0 ? Math.max(0, current.first_seq - 1) : requestedAfter;
    if (requestedAfter > 0 && current.first_seq > 1 && afterSeq < current.first_seq - 1) throw new AevorenBotError("ENVIRONMENT_LOG_CURSOR_EXPIRED", undefined, undefined, { firstSeq: current.first_seq });
    const rows = this.database.prepare("SELECT * FROM environment_logs WHERE execution_id=? AND seq>? ORDER BY seq LIMIT ?").all(id, afterSeq, parsed.limit ?? 200) as LogRow[];
    const selected: WorkerLog[] = []; let size = 0;
    for (const row of rows) { const value = log(row); const bytes = Buffer.byteLength(JSON.stringify(value), "utf8"); if (size + bytes > (parsed.maxBytes ?? 65_536) && selected.length) break; selected.push(value); size += bytes; }
    return { executionId: id, logs: selected, firstSeq: current.first_seq, lastSeq: current.last_seq, truncated: Boolean(current.truncated) || (selected.at(-1)?.seq ?? afterSeq) < current.last_seq };
  }

  upsertPort(input: EnvironmentScope, value: { id?: string; processId: string; port: number; label?: string; state?: RegisteredPort["state"]; checkedAt?: string | null }): RegisteredPort {
    const scope = this.scope(input);
    const fields = registerPortSchema.parse({ ...scope, processId: value.processId, port: value.port, label: value.label });
    const process = this.executionRow(scope, fields.processId);
    if (process.kind !== "background") throw new AevorenBotError("ENVIRONMENT_SCOPE_INVALID");
    const record = registeredPortSchema.parse({ id: value.id ?? randomUUID(), processId: fields.processId, port: fields.port, label: fields.label ?? "", state: value.state ?? "unknown", checkedAt: value.checkedAt ?? null });
    if (record.state === "listening" && process.state !== "running") throw new AevorenBotError("ENVIRONMENT_EXECUTION_STATE_INVALID");
    this.database.prepare(`INSERT INTO environment_ports(id,environment_id,process_id,port,label,state,checked_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(environment_id,process_id,port) DO UPDATE SET label=excluded.label,state=excluded.state,checked_at=excluded.checked_at`)
      .run(record.id, process.environment_id, record.processId, record.port, record.label, record.state, record.checkedAt);
    const row = this.database.prepare("SELECT * FROM environment_ports WHERE environment_id=? AND process_id=? AND port=?").get(process.environment_id, record.processId, record.port) as PortRow;
    return port(row);
  }
  listPorts(input: EnvironmentScope): RegisteredPort[] {
    const scope = this.scope(input); const env = this.getInternal(scope); if (!env) return [];
    return (this.database.prepare("SELECT * FROM environment_ports WHERE environment_id=? ORDER BY port,id").all(env.id) as PortRow[]).map(port);
  }

  private requireEnvironment(scope: EnvironmentScope): InternalEnvironmentRecord {
    const value = this.getInternal(scope); if (!value) throw new AevorenBotError("ENVIRONMENT_NOT_FOUND"); return value;
  }
  private executionRow(scope: EnvironmentScope, id: string): ExecutionRow {
    const env = this.requireEnvironment(scope);
    const row = this.database.prepare("SELECT * FROM environment_executions WHERE id=? AND environment_id=?").get(id, env.id) as ExecutionRow | undefined;
    if (!row) throw new AevorenBotError("ENVIRONMENT_EXECUTION_NOT_FOUND");
    return row;
  }
}
