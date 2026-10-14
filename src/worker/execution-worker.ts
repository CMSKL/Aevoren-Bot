import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { chown, lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { WorkerExecution, WorkerExecutionRequest, WorkerLog, RegisteredPort as WorkerPort, WorkerPendingCancelAck } from "@shared/environment-contracts";
import { ENV_HTTP_BODY_MAX_BYTES } from "@shared/environment-contracts";
import { WorkerError } from "./worker-error";
import { WorkerStore } from "./worker-store";

const JOB_UIDS = Array.from({ length: 32 }, (_, index) => 1_010 + index);
const GID = 1_000;
const ACTIVE = new Set(["running"]);
type LiveJob = { child: ChildProcessWithoutNullStreams; uid: number; parentExit?: { code: number | null; signal: string | null };
  finish?: Promise<void>; timer?: ReturnType<typeof setTimeout>; home: string };
export type WorkerOptions = { environmentId: string; stateDirectory: string; workspaceDirectory: string; helperPath: string };

export async function processesByUid(): Promise<Map<number, number[]>> {
  const result = new Map<number, number[]>();
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/u.test(name)) continue;
    try {
      const status = await readFile(`/proc/${name}/status`, "utf8");
      if (/^State:\s+Z/mu.test(status)) continue;
      const uid = /^Uid:\s+(\d+)/mu.exec(status)?.[1];
      if (uid && JOB_UIDS.includes(Number(uid))) result.set(Number(uid), [...result.get(Number(uid)) ?? [], Number(name)]);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && ["ENOENT", "ESRCH"].includes(String(error.code)))) throw error;
    }
  }
  return result;
}

async function terminateUid(uid: number, signal: NodeJS.Signals): Promise<void> {
  if (!((await processesByUid()).get(uid)?.length)) return;
  // Kernel permission checks enforce the UID at delivery time. A recycled PID
  // cannot make a root kill accidentally target another job or the supervisor.
  const child = spawn("/usr/bin/setpriv", ["--reuid", String(uid), "--regid", String(GID), "--clear-groups", "--no-new-privs",
    "/bin/bash", "--noprofile", "--norc", "-c", 'kill -s "$1" -- -1 2>/dev/null || true', "aevoren-cleanup", signal],
    { cwd: "/", stdio: "ignore", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } });
  await once(child, "close");
}

export async function uidOwnsListeningPort(uid: number, port: number): Promise<boolean> {
  for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const rows = (await readFile(path, "utf8")).split("\n").slice(1);
    if (rows.some(row => {
      const fields = row.trim().split(/\s+/u);
      return fields[3] === "0A" && Number(fields[7]) === uid && Number.parseInt(fields[1]?.split(":").at(-1) ?? "", 16) === port;
    })) return true;
  }
  return false;
}

export class ExecutionWorker {
  readonly bootId = randomUUID();
  readonly events = new EventEmitter();
  readonly store: WorkerStore;
  private readonly live = new Map<string, LiveJob>();
  private readonly reservedUids = new Set<number>();
  private monitor?: ReturnType<typeof setInterval>;
  private checking = false;
  private shuttingDown = false;
  private readonly closedSessions = new Set<string>();

  constructor(readonly options: WorkerOptions) {
    this.store = new WorkerStore(join(options.stateDirectory, "worker.sqlite"), options.environmentId, this.bootId);
  }

  async initialize(): Promise<void> {
    if (process.platform !== "linux" || process.getuid?.() !== 0) throw new WorkerError("WORKER_SUPERVISOR_REQUIRED", 503);
    await mkdir(this.options.workspaceDirectory, { recursive: true });
    if ((await lstat(this.options.workspaceDirectory)).isSymbolicLink()) throw new WorkerError("WORKER_WORKSPACE_INVALID", 503);
    await chown(this.options.workspaceDirectory, 1_000, GID);
    await this.file({ action: "initialize" });
    // A supervisor restart never adopts an unidentified old job or replays it.
    const deadline = Date.now() + 5_000;
    while ((await processesByUid()).size > 0 && Date.now() < deadline) {
      await Promise.all(JOB_UIDS.map(uid => terminateUid(uid, "SIGKILL")));
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if ((await processesByUid()).size > 0) throw new WorkerError("WORKER_BOOT_CLEANUP_INCOMPLETE", 503);
    this.monitor = setInterval(() => { void this.inspectJobs(); }, 100);
    this.monitor.unref();
  }

  private log(id: string, stream: WorkerLog["stream"], text: string, bytes?: Buffer): void {
    const log = this.store.append(id, stream, text, bytes);
    this.events.emit(`log:${id}`, log);
  }

  private async cwd(path: string): Promise<string> {
    const root = await realpath(this.options.workspaceDirectory);
    const candidate = resolve(root, path);
    const offset = relative(root, candidate);
    if (isAbsolute(path) || offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw new WorkerError("WORKER_PATH_INVALID");
    // Validation runs as the unprivileged file helper, so a symlink race cannot
    // turn the root supervisor into a privileged arbitrary-file reader.
    const result = await this.file({ action: "directory", path });
    if (!result || typeof result !== "object" || !("path" in result)) throw new WorkerError("WORKER_PATH_INVALID");
    return candidate;
  }

  async start(input: WorkerExecutionRequest): Promise<WorkerExecution> {
    if (this.shuttingDown) throw new WorkerError("WORKER_STOPPING", 503);
    const request: WorkerExecutionRequest = { id: input.id, sessionId: input.sessionId, runtimeRunId: input.runtimeRunId,
      kind: input.kind, command: input.command, cwd: input.cwd,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : input.kind === "foreground" ? { timeoutMs: 120_000 } : {}) };
    const existing = this.store.existing(request);
    if (existing) return existing;
    if (this.store.idCancelled(request.id)) throw new WorkerError("WORKER_JOB_CANCELLED", 409);
    if (this.closedSessions.has(request.sessionId) || this.store.sessionCancelled(request.sessionId)) throw new WorkerError("WORKER_SESSION_CANCELLED", 409);
    const uid = JOB_UIDS.find(candidate => !this.reservedUids.has(candidate));
    if (!uid) throw new WorkerError("WORKER_CAPACITY_EXCEEDED", 409);
    this.reservedUids.add(uid);
    try {
      await this.cwd(request.cwd);
      if (this.shuttingDown || this.closedSessions.has(request.sessionId)) throw new WorkerError("WORKER_SESSION_CANCELLED", 409);
      const raced = this.store.existing(request);
      if (raced) { this.reservedUids.delete(uid); return raced; }
      const home = join("/tmp", `aevoren-job-${request.id}`);
      await mkdir(home, { mode: 0o700 });
      await chown(home, uid, GID);
      if (this.shuttingDown || this.closedSessions.has(request.sessionId) || this.store.sessionCancelled(request.sessionId)) throw new WorkerError("WORKER_SESSION_CANCELLED", 409);
      if (this.store.idCancelled(request.id)) throw new WorkerError("WORKER_JOB_CANCELLED", 409);
      this.store.create(request, uid);
      const child = spawn("/usr/bin/setpriv", ["--reuid", String(uid), "--regid", String(GID), "--clear-groups", "--no-new-privs",
        "/bin/bash", "--noprofile", "--norc", "-c", 'cd -- "/workspace/$1" || exit 125; umask 0007; exec /bin/bash --noprofile --norc -c "$2"', "aevoren-job", request.cwd, request.command],
        { cwd: "/", detached: true, stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", HOME: home, AEVOREN_EXECUTION_ID: request.id } });
      child.stdin.end();
      const job: LiveJob = { child, uid, home };
      this.live.set(request.id, job);
      for (const stream of ["stdout", "stderr"] as const) {
        const decoder = new StringDecoder("utf8");
        child[stream].on("data", (buffer: Buffer) => {
          for (let offset = 0; offset < buffer.length; offset += 16_384) {
            const bytes = buffer.subarray(offset, offset + 16_384);
            this.log(request.id, stream, decoder.write(bytes), bytes);
          }
        });
        child[stream].on("end", () => { const tail = decoder.end(); if (tail) this.log(request.id, stream, tail); });
      }
      child.on("exit", (code, signal) => { job.parentExit = { code, signal }; void this.inspectJobs(); });
      child.on("error", () => { job.parentExit = { code: null, signal: "spawn_error" }; void this.finish(request.id, "failed", "WORKER_SPAWN_FAILED"); });
      await once(child, "spawn");
      this.store.running(request.id, child.pid!);
      this.log(request.id, "state", "running");
      if (request.timeoutMs) job.timer = setTimeout(() => { void this.finish(request.id, "failed", "WORKER_COMMAND_TIMEOUT"); }, request.timeoutMs);
      return this.store.get(request.id);
    } catch (error) {
      if (!this.live.has(request.id)) this.reservedUids.delete(uid);
      throw error;
    }
  }

  private async inspectJobs(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      for (const [id, job] of this.live) {
        if (job.finish || !job.parentExit) continue;
        const current = this.store.get(id);
        const descendants = (await processesByUid()).get(job.uid) ?? [];
        if (current.kind === "background" && job.parentExit.code === 0 && descendants.length) {
          this.store.setPid(id, descendants[0]!);
          continue;
        }
        const detached = current.kind === "background" && current.pid !== job.child.pid;
        await this.finish(id, detached ? "interrupted" : job.parentExit.code === 0 ? "completed" : "failed", detached ? "WORKER_BACKGROUND_EXIT_UNKNOWN" : undefined);
      }
    } catch { /* A failed observation does not release a UID or claim completion. */ }
    finally { this.checking = false; }
  }

  private async finish(id: string, state: WorkerExecution["state"], errorCode?: string): Promise<void> {
    const job = this.live.get(id);
    if (!job) return;
    if (job.finish) return job.finish;
    job.finish = (async () => {
      if (job.timer) clearTimeout(job.timer);
      if (job.child.exitCode === null && job.child.signalCode === null) job.child.kill("SIGTERM");
      await terminateUid(job.uid, "SIGTERM");
      const grace = Date.now() + 500;
      while (Date.now() < grace && ((await processesByUid()).get(job.uid)?.length ?? 0) > 0) await new Promise(resolve => setTimeout(resolve, 20));
      const deadline = Date.now() + 5_000;
      while (((await processesByUid()).get(job.uid)?.length ?? 0) > 0 && Date.now() < deadline) {
        await terminateUid(job.uid, "SIGKILL");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const remained = ((await processesByUid()).get(job.uid)?.length ?? 0) > 0;
      const detached = this.store.get(id).pid !== job.child.pid;
      const current = this.store.finish(id, remained ? "interrupted" : state, detached ? null : job.parentExit?.code ?? null, detached ? null : job.parentExit?.signal ?? null,
        remained ? "WORKER_CLEANUP_INCOMPLETE" : errorCode);
      this.log(id, "state", current.state);
      this.live.delete(id);
      if (!remained) this.reservedUids.delete(job.uid);
      this.events.emit(`end:${id}`, this.store.get(id));
    })();
    return job.finish;
  }

  async cancel(id: string, kind: WorkerExecutionRequest["kind"] = "foreground"): Promise<WorkerExecution | WorkerPendingCancelAck> {
    const current = this.store.find(id);
    if (!current) { this.store.cancelPending(id, kind); return { id, state: "cancelled", pending: true }; }
    if (current.kind !== kind) throw new WorkerError("WORKER_IDEMPOTENCY_CONFLICT", 409);
    if (ACTIVE.has(current.state)) await this.finish(id, "cancelled");
    return this.store.get(id);
  }

  async cancelSession(sessionId: string): Promise<WorkerExecution[]> {
    this.closedSessions.add(sessionId);
    this.store.cancelSession(sessionId);
    const jobs = this.store.list("foreground").filter(job => job.executionSessionId === sessionId);
    await Promise.all(jobs.map(job => this.cancel(job.id)));
    return jobs.map(job => this.store.get(job.id));
  }

  async file(input: unknown): Promise<unknown> {
    const child = spawn("/usr/bin/setpriv", ["--reuid", "1000", "--regid", "1000", "--clear-groups", "--no-new-privs", "/usr/local/bin/node", this.options.helperPath],
      { cwd: "/", stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", AEVOREN_WORKSPACE_ROOT: this.options.workspaceDirectory } });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > ENV_HTTP_BODY_MAX_BYTES) child.kill("SIGKILL"); else chunks.push(chunk); });
    child.stderr.resume();
    child.stdin.end(JSON.stringify(input));
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      await once(child, "close");
      if (size > ENV_HTTP_BODY_MAX_BYTES) throw new WorkerError("WORKER_FILE_TOO_LARGE", 413);
      const result = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { ok: boolean; result?: unknown; error?: { code: string; status: number } };
      if (!result.ok) throw new WorkerError(result.error?.code ?? "WORKER_FILE_FAILED", result.error?.status ?? 400);
      return result.result;
    } finally { clearTimeout(timer); }
  }

  async registerPort(input: { id: string; processId: string; port: number; label: string }): Promise<WorkerPort> {
    const job = this.store.get(input.processId);
    if (input.port === 8_080 || job.kind !== "background" || job.state !== "running" || !this.live.has(job.id) || !await uidOwnsListeningPort(this.store.uid(job.id), input.port)) {
      throw new WorkerError("WORKER_PORT_NOT_OWNED", 409);
    }
    return this.store.savePort({ ...input, state: "listening", checkedAt: new Date().toISOString() });
  }

  async ports(): Promise<WorkerPort[]> {
    for (const port of this.store.ports()) {
      const job = this.store.get(port.processId);
      this.store.savePort({ ...port, state: job.state !== "running" ? "stopped" : await uidOwnsListeningPort(this.store.uid(job.id), port.port) ? "listening" : "unknown", checkedAt: new Date().toISOString() });
    }
    return this.store.ports();
  }

  async close(): Promise<void> {
    this.shuttingDown = true;
    if (this.monitor) clearInterval(this.monitor);
    await Promise.all([...this.live.keys()].map(id => this.cancel(id, this.store.get(id).kind)));
    this.store.close();
  }
}
