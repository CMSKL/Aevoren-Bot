import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DemonstrationCapture, DemonstrationEvent, DemonstrationSnapshot } from "@shared/demonstration-contracts";
import { DEMONSTRATION_MAX_EVENTS } from "@shared/demonstration-contracts";
import { demonstrationEventSchema } from "@shared/demonstration-schemas";
import { BrowserWorkerError } from "./worker-error";
type Row = { id: string; browser_session_id: string; epoch: number; state: DemonstrationCapture["state"]; reason: DemonstrationCapture["reason"]; events: string; created_at: string; updated_at: string };
export class DemonstrationStore {
  constructor(private readonly db: DatabaseSync, private readonly browserSessionId: string) {
    db.exec("CREATE TABLE IF NOT EXISTS demonstrations (id TEXT PRIMARY KEY,browser_session_id TEXT NOT NULL,epoch INTEGER NOT NULL,state TEXT NOT NULL,reason TEXT,events TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)");
    this.interrupt("restart");
  }
  private row(id?: string): Row | undefined { return this.db.prepare(id ? "SELECT * FROM demonstrations WHERE id=?" : "SELECT * FROM demonstrations ORDER BY rowid DESC LIMIT 1").get(...(id ? [id] : [])) as Row | undefined; }
  private snapshot(row: Row): DemonstrationSnapshot { const events = JSON.parse(row.events) as DemonstrationEvent[]; return { id: row.id, browserSessionId: row.browser_session_id, epoch: row.epoch, state: row.state, reason: row.reason, events, eventCount: events.length, createdAt: row.created_at, updatedAt: row.updated_at }; }
  private capture(snapshot: DemonstrationSnapshot): DemonstrationCapture { return { id: snapshot.id, browserSessionId: snapshot.browserSessionId, epoch: snapshot.epoch, state: snapshot.state, reason: snapshot.reason, eventCount: snapshot.eventCount, createdAt: snapshot.createdAt, updatedAt: snapshot.updatedAt }; }
  get(id: string): DemonstrationCapture | null { const row = this.row(id); return row ? this.capture(this.snapshot(row)) : null; }
  status(): DemonstrationCapture | null { const row = this.row(); if (!row) return null; return this.capture(this.snapshot(row)); }
  start(id: string, epoch: number): DemonstrationCapture {
    const old = this.row(id); if (old) { if (old.epoch !== epoch || old.state !== "recording") throw new BrowserWorkerError("DEMONSTRATION_STATE_INVALID", 409); return this.capture(this.snapshot(old)); }
    if (this.db.prepare("SELECT 1 FROM demonstrations WHERE state='recording'").get()) throw new BrowserWorkerError("DEMONSTRATION_STATE_INVALID", 409);
    if ((this.db.prepare("SELECT count(*) AS n FROM demonstrations").get() as { n: number }).n >= 100) throw new BrowserWorkerError("DEMONSTRATION_LIMIT", 409);
    const date = new Date().toISOString(); this.db.prepare("INSERT INTO demonstrations VALUES (?,?,?,'recording',NULL,'[]',?,?)").run(id || randomUUID(), this.browserSessionId, epoch, date, date); return this.capture(this.snapshot(this.row(id)!));
  }
  accepted(epoch: number, event: DemonstrationEvent): void {
    const row = this.db.prepare("SELECT * FROM demonstrations WHERE state='recording' AND epoch=?").get(epoch) as Row | undefined; if (!row) return;
    const snapshot = this.snapshot(row), parsed = demonstrationEventSchema.parse(event);
    if (parsed.kind === "redacted-text" && snapshot.events.at(-1)?.kind === "redacted-text") return;
    snapshot.events.push(parsed); const limited = snapshot.events.length >= DEMONSTRATION_MAX_EVENTS;
    this.db.prepare("UPDATE demonstrations SET events=?,updated_at=?,state=?,reason=? WHERE id=? AND state='recording'").run(JSON.stringify(snapshot.events), new Date().toISOString(), limited ? "interrupted" : "recording", limited ? "limit" : null, row.id);
  }
  interrupt(reason: Exclude<DemonstrationCapture["reason"], null>): void { this.db.prepare("UPDATE demonstrations SET state='interrupted',reason=?,updated_at=? WHERE state='recording'").run(reason, new Date().toISOString()); }
  stop(id: string): DemonstrationSnapshot { const row = this.row(id); if (!row) throw new BrowserWorkerError("DEMONSTRATION_NOT_FOUND", 404); this.db.prepare("UPDATE demonstrations SET state='stopped',updated_at=? WHERE id=? AND state='recording'").run(new Date().toISOString(), id); return this.snapshot(this.row(id)!); }
  discard(id: string): boolean { return this.db.prepare("DELETE FROM demonstrations WHERE id=?").run(id).changes > 0; }
}
