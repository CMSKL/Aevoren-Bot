import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { BrowserWorkerError } from "./worker-error";

export type ControlRecord = { owner: "ai" | "user"; epoch: number; needsObservation: boolean };
export type DownloadRecord = { id: string; pageId: string; name: string; size: number; sha256: string; createdAt: string };
export type DownloadFailure = { id: string; pageId: string; name: string; errorCode: string; createdAt: string };

/** This database is on the root-only state volume, never in the Chromium profile. */
export class BrowserStateStore {
  readonly database: DatabaseSync;

  constructor(path: string, readonly browserSessionId: string) {
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id=1), browser_session_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS control (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, epoch INTEGER NOT NULL, needs_observation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS downloads (id TEXT PRIMARY KEY, page_id TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, digest TEXT NOT NULL, state TEXT NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS download_errors (id TEXT PRIMARY KEY, page_id TEXT NOT NULL, name TEXT NOT NULL, error_code TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cancelled_operations (id TEXT PRIMARY KEY);
    `);
    const identity = this.database.prepare("SELECT browser_session_id FROM identity WHERE id=1").get() as { browser_session_id: string } | undefined;
    if (identity && identity.browser_session_id !== browserSessionId) { this.database.close(); throw new BrowserWorkerError("BROWSER_IDENTITY_INVALID", 409); }
    this.database.prepare("INSERT INTO identity VALUES (1,?) ON CONFLICT(id) DO NOTHING").run(browserSessionId);
    this.database.prepare("INSERT INTO control VALUES (1,'ai',0,1) ON CONFLICT(id) DO NOTHING").run();
    // A restart invalidates pending requests and observations, without returning human control.
    this.database.exec("UPDATE control SET epoch=epoch+1, needs_observation=1 WHERE id=1");
  }

  control(): ControlRecord {
    const value = this.database.prepare("SELECT owner,epoch,needs_observation FROM control WHERE id=1").get() as { owner: ControlRecord["owner"]; epoch: number; needs_observation: number };
    return { owner: value.owner, epoch: value.epoch, needsObservation: Boolean(value.needs_observation) };
  }

  assertAI(expectedEpoch: number): void {
    this.assertAccess(expectedEpoch, "ai");
  }

  assertAccess(expectedEpoch: number, actor: "ai" | "user"): void {
    const control = this.control();
    if (actor === "ai" && control.owner !== "ai") throw new BrowserWorkerError("BROWSER_USER_CONTROL", 409);
    if (control.epoch !== expectedEpoch) throw new BrowserWorkerError("BROWSER_CONTROL_CHANGED", 409);
  }

  transition(owner: ControlRecord["owner"], expectedEpoch: number): ControlRecord {
    const current = this.control();
    if (current.epoch !== expectedEpoch) throw new BrowserWorkerError("BROWSER_CONTROL_CHANGED", 409);
    this.database.prepare("UPDATE control SET owner=?,epoch=epoch+1,needs_observation=1 WHERE id=1").run(owner);
    return this.control();
  }

  observed(epoch: number): void {
    this.assertAI(epoch);
    this.database.prepare("UPDATE control SET needs_observation=0 WHERE id=1 AND epoch=?").run(epoch);
  }

  addDownload(record: DownloadRecord): void {
    this.database.prepare("INSERT INTO downloads VALUES (?,?,?,?,?,?)").run(record.id, record.pageId, record.name, record.size, record.sha256, record.createdAt);
  }

  download(id: string): DownloadRecord {
    const value = this.database.prepare("SELECT * FROM downloads WHERE id=?").get(id) as { id: string; page_id: string; name: string; size: number; sha256: string; created_at: string } | undefined;
    if (!value) throw new BrowserWorkerError("BROWSER_DOWNLOAD_NOT_FOUND", 404);
    return { id: value.id, pageId: value.page_id, name: value.name, size: value.size, sha256: value.sha256, createdAt: value.created_at };
  }

  listDownloads(): DownloadRecord[] {
    return (this.database.prepare("SELECT id FROM downloads ORDER BY created_at,id").all() as { id: string }[]).map(value => this.download(value.id));
  }

  addDownloadFailure(record: DownloadFailure): void {
    this.database.prepare("INSERT INTO download_errors VALUES (?,?,?,?,?)").run(record.id, record.pageId, record.name, record.errorCode, record.createdAt);
  }

  listDownloadFailures(): DownloadFailure[] {
    return (this.database.prepare("SELECT * FROM download_errors ORDER BY created_at,id").all() as { id: string; page_id: string; name: string; error_code: string; created_at: string }[])
      .map(value => ({ id: value.id, pageId: value.page_id, name: value.name, errorCode: value.error_code, createdAt: value.created_at }));
  }

  beginOperation(id: string, action: string, input: Record<string, unknown>): { reused: boolean; result?: unknown } {
    const digest = createHash("sha256").update(JSON.stringify({ action, input })).digest("hex");
    const existing = this.database.prepare("SELECT digest,state,result FROM operations WHERE id=?").get(id) as { digest: string; state: string; result: string | null } | undefined;
    if (existing) {
      if (existing.digest !== digest) throw new BrowserWorkerError("BROWSER_OPERATION_CONFLICT", 409);
      if (existing.state !== "completed") throw new BrowserWorkerError("BROWSER_OPERATION_UNKNOWN", 409);
      return { reused: true, result: JSON.parse(existing.result!) as unknown };
    }
    this.assertOperation(id);
    this.database.prepare("INSERT INTO operations VALUES (?,?,'unknown',NULL)").run(id, digest);
    return { reused: false };
  }

  completeOperation(id: string, result: unknown): void {
    this.database.prepare("UPDATE operations SET state='completed',result=? WHERE id=? AND state='unknown'").run(JSON.stringify(result), id);
  }

  assertOperation(id: string): void {
    if (this.database.prepare("SELECT 1 FROM cancelled_operations WHERE id=?").get(id)) throw new BrowserWorkerError("BROWSER_OPERATION_CANCELLED", 409);
  }

  cancelOperation(id: string): "cancelled" | "unknown" | "completed" {
    const existing = this.database.prepare("SELECT state FROM operations WHERE id=?").get(id) as { state: "unknown" | "completed" } | undefined;
    if (existing?.state === "completed") return "completed";
    this.database.prepare("INSERT INTO cancelled_operations VALUES (?) ON CONFLICT(id) DO NOTHING").run(id);
    return existing ? "unknown" : "cancelled";
  }

  close(): void { this.database.close(); }
}
