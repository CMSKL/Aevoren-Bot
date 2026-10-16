import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Routine } from "@shared/contracts";
import type { EventDelivery, EventDeliveryState, EventSubscription, EventSubscriptionCreate, EventSubscriptionUpdate } from "@shared/event-contracts";
import { eventCreateSchema, eventIdempotencySchema, eventUpdateSchema } from "@shared/event-schemas";

export type EventErrorCode = "EVENT_NOT_FOUND" | "EVENT_VERSION_CONFLICT" | "EVENT_UNAUTHORIZED" | "EVENT_STOPPED" | "EVENT_LIMIT" | "EVENT_LOOP" | "EVENT_INVALID";
export class EventStateError extends Error {
  constructor(public readonly code: EventErrorCode, public readonly currentVersion?: number) { super(code); this.name = "EventStateError"; }
}
export const AUTOMATION_EVENT_MIGRATION = { version: 49, sql: `
 CREATE TABLE event_subscriptions(
  id TEXT PRIMARY KEY,name TEXT NOT NULL,source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,routine_version INTEGER NOT NULL,
  target_json TEXT NOT NULL CHECK(json_valid(target_json)),enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),
  version INTEGER NOT NULL CHECK(version>0),encrypted_token TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
 );
 CREATE TABLE event_deliveries(
  id TEXT PRIMARY KEY,subscription_id TEXT NOT NULL REFERENCES event_subscriptions(id) ON DELETE CASCADE,
  subscription_version INTEGER NOT NULL,routine_id TEXT NOT NULL,routine_version INTEGER NOT NULL,
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),target_json TEXT NOT NULL CHECK(json_valid(target_json)),
  event_id TEXT NOT NULL,payload_digest TEXT NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  ancestry_json TEXT NOT NULL CHECK(json_valid(ancestry_json)),trigger_key TEXT NOT NULL UNIQUE,
  attachment_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL CHECK(state IN('accepted','dispatching','dispatched','cancel-requested','cancelled','failed','unknown')),
  routine_run_id TEXT,version INTEGER NOT NULL CHECK(version>0),error_code TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
  UNIQUE(subscription_id,event_id)
 );
 CREATE INDEX event_deliveries_recent ON event_deliveries(created_at DESC,id);
 CREATE INDEX event_deliveries_routine_run ON event_deliveries(routine_run_id);
` } as const;

type HookRow = { id: string; name: string; source_json: string; routine_id: string; routine_version: number; target_json: string; enabled: number; version: number; encrypted_token: string | null; created_at: string; updated_at: string };
type DeliveryRow = { id: string; subscription_id: string; subscription_version: number; routine_id: string; routine_version: number; source_json: string; target_json: string; event_id: string; payload_digest: string; payload_json: string; ancestry_json: string; trigger_key: string; attachment_id: string; state: EventDeliveryState; routine_run_id: string | null; version: number; error_code: string | null; created_at: string; updated_at: string };
/** Deterministic JSON without invoking user-provided toJSON or accepting non-JSON values. */
export function canonicalEventPayload(value: unknown): string {
  let count = 0;
  const visit = (item: unknown, depth: number): string => {
    if (++count > 10_000 || depth > 32) throw new EventStateError("EVENT_INVALID");
    if (item === null || typeof item === "boolean" || typeof item === "string") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(child => visit(child, depth + 1)).join(",")}]`;
    if (item && typeof item === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(item))) return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${visit((item as Record<string, unknown>)[key], depth + 1)}`).join(",")}}`;
    throw new EventStateError("EVENT_INVALID");
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EventStateError("EVENT_INVALID");
  const result = visit(value, 0);
  if (Buffer.byteLength(result, "utf8") > 65_536) throw new EventStateError("EVENT_LIMIT");
  return result;
}
export const eventDigest = (value: string) => createHash("sha256").update(value).digest("hex");
function hookDto(row: HookRow): EventSubscription {
  return { id: row.id, name: row.name, source: JSON.parse(row.source_json), routineId: row.routine_id, routineVersion: row.routine_version, targetSnapshot: JSON.parse(row.target_json), enabled: Boolean(row.enabled), version: row.version, hasToken: Boolean(row.encrypted_token), webhookPath: JSON.parse(row.source_json).kind === "webhook" ? `/hooks/${row.id}/${row.version}` : null, createdAt: row.created_at, updatedAt: row.updated_at };
}
function deliveryDto(row: DeliveryRow): EventDelivery {
  return { id: row.id, subscriptionId: row.subscription_id, subscriptionVersion: row.subscription_version, routineId: row.routine_id, routineVersion: row.routine_version, source: JSON.parse(row.source_json), targetSnapshot: JSON.parse(row.target_json), eventId: row.event_id, payloadDigest: row.payload_digest, ancestry: JSON.parse(row.ancestry_json), state: row.state, routineRunId: row.routine_run_id, version: row.version, errorCode: row.error_code, createdAt: row.created_at, updatedAt: row.updated_at };
}
export class EventRepository {
  constructor(private readonly database: DatabaseSync) {}
  private hook(id: string): HookRow {
    const row = this.database.prepare("SELECT * FROM event_subscriptions WHERE id=?").get(id) as HookRow | undefined;
    if (!row) throw new EventStateError("EVENT_NOT_FOUND");
    return row;
  }
  private row(id: string): DeliveryRow {
    const row = this.database.prepare("SELECT * FROM event_deliveries WHERE id=?").get(id) as DeliveryRow | undefined;
    if (!row) throw new EventStateError("EVENT_NOT_FOUND");
    return row;
  }
  get(id: string): EventSubscription { return hookDto(this.hook(id)); }
  getDelivery(id: string): EventDelivery { return deliveryDto(this.row(id)); }
  list(): EventSubscription[] { return (this.database.prepare("SELECT * FROM event_subscriptions ORDER BY created_at,id").all() as HookRow[]).map(hookDto); }
  deliveries(subscriptionId?: string): EventDelivery[] {
    return (this.database.prepare(`SELECT * FROM event_deliveries ${subscriptionId ? "WHERE subscription_id=?" : ""} ORDER BY created_at DESC,id DESC LIMIT 500`).all(...(subscriptionId ? [subscriptionId] : [])) as DeliveryRow[]).map(deliveryDto);
  }
  pending(subscriptionId?: string): EventDelivery[] {
    return (this.database.prepare(`SELECT * FROM event_deliveries WHERE state IN('accepted','dispatching','dispatched','cancel-requested','unknown') ${subscriptionId ? "AND subscription_id=?" : ""} ORDER BY created_at,id`).all(...(subscriptionId ? [subscriptionId] : [])) as DeliveryRow[]).map(deliveryDto);
  }
  private assertVersion(row: HookRow, expected: number): void { if (row.version !== expected) throw new EventStateError("EVENT_VERSION_CONFLICT", row.version); }
  create(input: EventSubscriptionCreate, routine: Routine): EventSubscription {
    const parsed = eventCreateSchema.parse(input);
    if (this.list().length >= 100) throw new EventStateError("EVENT_LIMIT");
    if (routine.id !== parsed.routineId || routine.version !== parsed.expectedRoutineVersion || !routine.enabled) throw new EventStateError("EVENT_VERSION_CONFLICT");
    const id = randomUUID(), now = new Date().toISOString();
    this.database.prepare("INSERT INTO event_subscriptions(id,name,source_json,routine_id,routine_version,target_json,enabled,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,?,?)").run(id, parsed.name, JSON.stringify(parsed.source), routine.id, routine.version, JSON.stringify(routine.targetSnapshot), Number(parsed.enabled ?? false), now, now);
    return this.get(id);
  }
  update(input: EventSubscriptionUpdate, routine: Routine): EventSubscription {
    const parsed = eventUpdateSchema.parse(input), row = this.hook(parsed.id); this.assertVersion(row, parsed.expectedVersion);
    const current = hookDto(row), { patch } = parsed;
    const routineId = patch.routineId ?? row.routine_id, routineVersion = patch.expectedRoutineVersion ?? row.routine_version;
    const stopping = patch.enabled === false && Object.keys(patch).length === 1;
    if (!stopping && (routine.id !== routineId || routine.version !== routineVersion || !routine.enabled)) throw new EventStateError("EVENT_VERSION_CONFLICT");
    this.database.prepare("UPDATE event_subscriptions SET name=?,source_json=?,routine_id=?,routine_version=?,target_json=?,enabled=?,version=version+1,updated_at=? WHERE id=? AND version=?").run(patch.name ?? row.name, JSON.stringify(patch.source ?? current.source), routineId, routineVersion, stopping ? row.target_json : JSON.stringify(routine.targetSnapshot), Number(patch.enabled ?? current.enabled), new Date().toISOString(), row.id, row.version);
    return this.get(row.id);
  }
  setToken(id: string, expectedVersion: number, encrypted: string | null): EventSubscription {
    const row = this.hook(id); this.assertVersion(row, expectedVersion);
    this.database.prepare("UPDATE event_subscriptions SET encrypted_token=?,enabled=CASE WHEN ? IS NULL THEN 0 ELSE enabled END,version=version+1,updated_at=? WHERE id=? AND version=?").run(encrypted, encrypted, new Date().toISOString(), id, expectedVersion);
    return this.get(id);
  }
  token(id: string): string | null { return this.hook(id).encrypted_token; }
  assertAccepting(id: string, version: number): EventSubscription {
    const hook = this.hook(id); this.assertVersion(hook, version);
    if (!hook.enabled) throw new EventStateError("EVENT_STOPPED");
    return hookDto(hook);
  }
  accept(hook: EventSubscription, eventId: string, payload: unknown, ancestry: string[]): EventDelivery {
    eventId = eventIdempotencySchema.parse(eventId); this.assertAccepting(hook.id, hook.version);
    const content = canonicalEventPayload(payload), digest = eventDigest(content);
    const existing = this.database.prepare("SELECT * FROM event_deliveries WHERE subscription_id=? AND event_id=?").get(hook.id, eventId) as DeliveryRow | undefined;
    if (existing) {
      if (existing.payload_digest !== digest || JSON.stringify(ancestry) !== existing.ancestry_json) throw new EventStateError("EVENT_VERSION_CONFLICT");
      return deliveryDto(existing);
    }
    if (ancestry.length > 4 || new Set(ancestry).size !== ancestry.length || ancestry.at(-1) !== hook.id) throw new EventStateError("EVENT_LOOP");
    const active = this.database.prepare("SELECT count(*) AS n FROM event_deliveries WHERE state IN('accepted','dispatching')").get() as { n: number };
    if (active.n >= 100) throw new EventStateError("EVENT_LIMIT");
    const id = randomUUID(), at = new Date().toISOString();
    this.database.prepare("INSERT INTO event_deliveries(id,subscription_id,subscription_version,routine_id,routine_version,source_json,target_json,event_id,payload_digest,payload_json,ancestry_json,trigger_key,attachment_id,state,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'accepted',1,?,?)").run(id, hook.id, hook.version, hook.routineId, hook.routineVersion, JSON.stringify(hook.source), JSON.stringify(hook.targetSnapshot), eventId, digest, content, JSON.stringify(ancestry), `event:${id}`, randomUUID(), at, at);
    return this.getDelivery(id);
  }
  transition(id: string, state: EventDeliveryState, options: { runId?: string; errorCode?: string } = {}): EventDelivery {
    const row = this.row(id);
    if (["cancelled", "failed", "unknown"].includes(row.state) || row.state === "dispatched" && state !== "cancel-requested") return deliveryDto(row);
    this.database.prepare("UPDATE event_deliveries SET state=?,routine_run_id=COALESCE(?,routine_run_id),error_code=?,version=version+1,updated_at=? WHERE id=? AND version=?").run(state, options.runId ?? null, options.errorCode ?? null, new Date().toISOString(), id, row.version);
    return this.getDelivery(id);
  }
  link(id: string, runId: string): EventDelivery {
    const row = this.row(id);
    this.database.prepare("UPDATE event_deliveries SET routine_run_id=?,state=CASE WHEN state IN('cancel-requested','cancelled') THEN state ELSE 'dispatched' END,version=version+1,updated_at=? WHERE id=? AND version=?").run(runId, new Date().toISOString(), id, row.version);
    return this.getDelivery(id);
  }
  privateData(id: string): { payload: unknown; triggerKey: string; attachmentId: string } {
    const row = this.row(id), payload = JSON.parse(row.payload_json);
    if (eventDigest(canonicalEventPayload(payload)) !== row.payload_digest) throw new EventStateError("EVENT_INVALID");
    return { payload, triggerKey: row.trigger_key, attachmentId: row.attachment_id };
  }
  ancestryForRun(runId: string): string[] {
    const row = this.database.prepare("SELECT ancestry_json FROM event_deliveries WHERE routine_run_id=?").get(runId) as { ancestry_json: string } | undefined;
    return row ? JSON.parse(row.ancestry_json) as string[] : [];
  }
}
