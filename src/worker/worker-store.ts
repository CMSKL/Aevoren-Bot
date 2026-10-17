import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { WorkerExecution, WorkerExecutionRequest, WorkerLog, RegisteredPort as WorkerPort } from "@shared/environment-contracts";
import type { WorkerSkillRunRequest } from "@shared/skill-execution-contracts";
import { WorkerError } from "./worker-error";

export const MAX_JOB_LOG_BYTES = 1_048_576;
export type WorkerJobRequest = WorkerExecutionRequest & { skill?: WorkerSkillRunRequest };
type JobRow = { id: string; request_json: string; digest: string; uid: number; state: WorkerExecution["state"] | "queued"; pid: number | null;
  exit_code: number | null; signal: string | null; error_code: string | null; created_at: string; started_at: string | null; ended_at: string | null; last_seq: number; truncated: number; boot_id: string };

export class WorkerStore {
  private readonly database: DatabaseSync;
  constructor(filename: string, private readonly environmentId: string, private readonly bootId: string) {
    this.database = new DatabaseSync(filename);
    this.database.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, request_json TEXT NOT NULL, digest TEXT NOT NULL, uid INTEGER NOT NULL,
        state TEXT NOT NULL, pid INTEGER, exit_code INTEGER, signal TEXT, error_code TEXT, created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT,
        last_seq INTEGER NOT NULL DEFAULT 0, truncated INTEGER NOT NULL DEFAULT 0, boot_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS logs(execution_id TEXT NOT NULL REFERENCES jobs(id), seq INTEGER NOT NULL, stream TEXT NOT NULL,
        text TEXT NOT NULL, bytes_base64 TEXT, at TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(execution_id, seq));
      CREATE TABLE IF NOT EXISTS ports(id TEXT PRIMARY KEY, process_id TEXT NOT NULL REFERENCES jobs(id), port INTEGER NOT NULL,
        label TEXT NOT NULL, state TEXT NOT NULL, checked_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS execution_sessions(id TEXT PRIMARY KEY, runtime_run_id TEXT, cancelled INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS pending_cancellations(id TEXT PRIMARY KEY,kind TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS worker_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    const identity = this.database.prepare("SELECT value FROM worker_metadata WHERE key='environment_id'").get() as { value: string } | undefined;
    if (identity && identity.value !== environmentId) { this.database.close(); throw new WorkerError("WORKER_STATE_SCOPE_INVALID", 503); }
    this.database.prepare("INSERT INTO worker_metadata(key,value) VALUES('environment_id',?) ON CONFLICT(key) DO NOTHING").run(environmentId);
    this.database.prepare("UPDATE jobs SET state='interrupted', ended_at=? WHERE state IN ('queued','running')").run(new Date().toISOString());
    this.database.exec("UPDATE ports SET state='unknown';");
  }

  get(id: string): WorkerExecution {
    const row = this.row(id);
    const request = JSON.parse(row.request_json) as WorkerExecutionRequest;
    return { id, environmentId: this.environmentId, executionSessionId: request.sessionId, runtimeRunId: request.runtimeRunId,
      kind: request.kind, command: request.command, cwd: request.cwd, state: row.state === "queued" ? "running" : row.state, pid: row.pid, exitCode: row.exit_code,
      signal: row.signal, createdAt: row.created_at, startedAt: row.started_at, endedAt: row.ended_at,
      lastSeq: row.last_seq, truncated: Boolean(row.truncated), ...(row.error_code ? { errorCode: row.error_code } : {}) };
  }

  private row(id: string): JobRow {
    const row = this.database.prepare("SELECT * FROM jobs WHERE id=?").get(id) as JobRow | undefined;
    if (!row) throw new WorkerError("WORKER_JOB_NOT_FOUND", 404);
    return row;
  }

  uid(id: string): number { return this.row(id).uid; }
  find(id: string): WorkerExecution | null { return this.database.prepare("SELECT 1 FROM jobs WHERE id=?").get(id) ? this.get(id) : null; }
  cancelPending(id: string, kind: WorkerExecutionRequest["kind"]): void {
    const existing = this.database.prepare("SELECT kind FROM pending_cancellations WHERE id=?").get(id) as { kind: WorkerExecutionRequest["kind"] } | undefined;
    if (existing && existing.kind !== kind) throw new WorkerError("WORKER_IDEMPOTENCY_CONFLICT", 409);
    this.database.prepare("INSERT INTO pending_cancellations(id,kind,created_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING").run(id, kind, new Date().toISOString());
  }
  idCancelled(id: string): boolean { return Boolean(this.database.prepare("SELECT 1 FROM pending_cancellations WHERE id=?").get(id)); }
  list(kind?: WorkerExecutionRequest["kind"]): WorkerExecution[] {
    return (this.database.prepare("SELECT id FROM jobs ORDER BY created_at, id").all() as { id: string }[])
      .map(row => this.get(row.id)).filter(job => !kind || job.kind === kind);
  }

  existing(request: WorkerJobRequest): WorkerExecution | null {
    const row = this.database.prepare("SELECT * FROM jobs WHERE id=?").get(request.id) as JobRow | undefined;
    if (!row) return null;
    const digest = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    if (row.digest !== digest) throw new WorkerError("WORKER_IDEMPOTENCY_CONFLICT", 409);
    return this.get(request.id);
  }

  create(request: WorkerJobRequest, uid: number): WorkerExecution {
    if (this.idCancelled(request.id)) throw new WorkerError("WORKER_JOB_CANCELLED", 409);
    const session = this.database.prepare("SELECT * FROM execution_sessions WHERE id=?").get(request.sessionId) as { runtime_run_id: string | null; cancelled: number } | undefined;
    if (session?.cancelled) throw new WorkerError("WORKER_SESSION_CANCELLED", 409);
    if (session && session.runtime_run_id !== request.runtimeRunId) throw new WorkerError("WORKER_SESSION_SCOPE_INVALID", 409);
    this.database.prepare("INSERT INTO execution_sessions(id,runtime_run_id) VALUES(?,?) ON CONFLICT(id) DO NOTHING").run(request.sessionId, request.runtimeRunId);
    const digest = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    this.database.prepare("INSERT INTO jobs(id,request_json,digest,uid,state,created_at,boot_id) VALUES(?,?,?,?,'queued',?,?)")
      .run(request.id, JSON.stringify(request), digest, uid, new Date().toISOString(), this.bootId);
    return this.get(request.id);
  }

  cancelSession(id: string): void { this.database.prepare("INSERT INTO execution_sessions(id,cancelled) VALUES(?,1) ON CONFLICT(id) DO UPDATE SET cancelled=1").run(id); }
  sessionCancelled(id: string): boolean { return Boolean((this.database.prepare("SELECT cancelled FROM execution_sessions WHERE id=?").get(id) as { cancelled: number } | undefined)?.cancelled); }
  firstSeq(id: string): number { return (this.database.prepare("SELECT coalesce(min(seq),0) AS seq FROM logs WHERE execution_id=?").get(id) as { seq: number }).seq; }

  running(id: string, pid: number): WorkerExecution {
    this.database.prepare("UPDATE jobs SET state='running',pid=?,started_at=? WHERE id=? AND state='queued'").run(pid, new Date().toISOString(), id);
    return this.get(id);
  }

  setPid(id: string, pid: number): void { this.database.prepare("UPDATE jobs SET pid=? WHERE id=? AND state='running'").run(pid, id); }

  finish(id: string, state: WorkerExecution["state"], exitCode: number | null, signal: string | null, errorCode?: string): WorkerExecution {
    this.database.prepare("UPDATE jobs SET state=?,exit_code=?,signal=?,error_code=?,ended_at=? WHERE id=? AND state IN ('queued','running')")
      .run(state, exitCode, signal, errorCode ?? null, new Date().toISOString(), id);
    return this.get(id);
  }

  append(id: string, stream: WorkerLog["stream"], text: string, bytes?: Buffer): WorkerLog {
    this.database.exec("SAVEPOINT append_log;");
    try {
    const seq = this.row(id).last_seq + 1;
    const at = new Date().toISOString();
    const size = Math.max(Buffer.byteLength(text), bytes?.length ?? 0);
    this.database.prepare("INSERT INTO logs(execution_id,seq,stream,text,bytes_base64,at,size) VALUES(?,?,?,?,?,?,?)")
      .run(id, seq, stream, text, bytes?.toString("base64") ?? null, at, size);
    this.database.prepare("UPDATE jobs SET last_seq=? WHERE id=?").run(seq, id);
    let total = (this.database.prepare("SELECT coalesce(sum(size),0) AS size FROM logs WHERE execution_id=?").get(id) as { size: number }).size;
    while (total > MAX_JOB_LOG_BYTES) {
      const oldest = this.database.prepare("SELECT seq,size FROM logs WHERE execution_id=? ORDER BY seq LIMIT 1").get(id) as { seq: number; size: number };
      this.database.prepare("DELETE FROM logs WHERE execution_id=? AND seq=?").run(id, oldest.seq);
      total -= oldest.size;
      this.database.prepare("UPDATE jobs SET truncated=1 WHERE id=?").run(id);
    }
    this.database.exec("RELEASE SAVEPOINT append_log;");
    return { executionId: id, seq, stream, text, at, ...(bytes ? { bytesBase64: bytes.toString("base64") } : {}) };
    } catch (error) {
      this.database.exec("ROLLBACK TO SAVEPOINT append_log; RELEASE SAVEPOINT append_log;");
      throw error;
    }
  }

  logs(id: string, after: number, limit = 256): WorkerLog[] {
    const job = this.get(id);
    const first = this.database.prepare("SELECT min(seq) AS seq FROM logs WHERE execution_id=?").get(id) as { seq: number | null };
    if (after !== 0 && job.truncated && first.seq !== null && after < first.seq - 1) throw new WorkerError("WORKER_LOG_CURSOR_EXPIRED", 410, undefined, { firstSeq: first.seq });
    const rows = this.database.prepare("SELECT * FROM logs WHERE execution_id=? AND seq>? ORDER BY seq LIMIT ?").all(id, after, limit) as {
      execution_id: string; seq: number; stream: WorkerLog["stream"]; text: string; bytes_base64: string | null; at: string;
    }[];
    return rows.map(row => ({ executionId: row.execution_id, seq: row.seq, stream: row.stream, text: row.text, at: row.at,
      ...(row.bytes_base64 ? { bytesBase64: row.bytes_base64 } : {}) }));
  }

  savePort(port: WorkerPort): WorkerPort {
    const previous = this.database.prepare("SELECT * FROM ports WHERE id=?").get(port.id) as { process_id: string; port: number; label: string } | undefined;
    if (previous && (previous.process_id !== port.processId || previous.port !== port.port || previous.label !== port.label)) throw new WorkerError("WORKER_IDEMPOTENCY_CONFLICT", 409);
    this.database.prepare("INSERT INTO ports(id,process_id,port,label,state,checked_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,checked_at=excluded.checked_at")
      .run(port.id, port.processId, port.port, port.label, port.state, port.checkedAt);
    return port;
  }

  ports(): WorkerPort[] {
    return (this.database.prepare("SELECT * FROM ports ORDER BY id").all() as { id: string; process_id: string; port: number; label: string; state: WorkerPort["state"]; checked_at: string }[])
      .map(row => ({ id: row.id, processId: row.process_id, port: row.port, label: row.label, state: row.state, checkedAt: row.checked_at }));
  }
  close(): void { this.database.close(); }
}
