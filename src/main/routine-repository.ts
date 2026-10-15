import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AttachmentDraft, Routine, RoutineRun, TranscriptEntry } from "@shared/contracts";
import type { RoutineCreateInput, RoutineTarget, RoutineTargetSnapshot, RoutineTriggerInput, RoutineUpdatePatch } from "@shared/routine-contracts";
import type { ResourceReference } from "@shared/library-contracts";
import type { MessageMediaReference } from "@shared/media-contracts";
import { routineTargetSchema, routineTriggerSchema } from "@shared/routine-schemas";
import { resourceReferencesSchema } from "@shared/library-schemas";
import { messageMediaReferencesSchema } from "@shared/media-schemas";
import { attachmentDraftSchema } from "@shared/schemas";
import type { AppRepository } from "./database";
import { AevorenBotError } from "./errors";

const uuidSql = "lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-'||substr('89ab',(random() & 3)+1,1)||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6)))";
const zeroDigest = "0".repeat(64);
export const GROUP_ROUTINE_MIGRATION = {
  version: 47, foreignKeysOff: true, sql: `
 PRAGMA legacy_alter_table=ON;
 INSERT INTO sessions(id,bot_id,room_id,kind,generation,created_at,updated_at)
 SELECT ${uuidSql},bot_id,NULL,'MAIN',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM routines
 WHERE NOT EXISTS(SELECT 1 FROM sessions WHERE sessions.bot_id=routines.bot_id AND kind='MAIN') GROUP BY bot_id;
 CREATE TABLE routines_v47 (
  id TEXT PRIMARY KEY,name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),prompt TEXT NOT NULL CHECK(length(prompt) BETWEEN 1 AND 20000),
  bot_id TEXT REFERENCES bots(id) ON DELETE CASCADE,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  target_json TEXT NOT NULL CHECK(json_valid(target_json)),authority_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(authority_json)),authority_digest TEXT NOT NULL DEFAULT '${zeroDigest}',
  authority_revoked INTEGER NOT NULL DEFAULT 0 CHECK(authority_revoked IN(0,1)),schedule_json TEXT NOT NULL CHECK(json_valid(schedule_json)),
  enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),next_run_at INTEGER,version INTEGER NOT NULL CHECK(version>0),created_at TEXT NOT NULL,updated_at TEXT NOT NULL
 );
 INSERT INTO routines_v47(id,name,prompt,bot_id,session_id,target_json,schedule_json,enabled,next_run_at,version,created_at,updated_at)
 SELECT r.id,r.name,r.prompt,r.bot_id,s.id,json_object('kind','bot','sessionId',s.id,'botId',r.bot_id),r.schedule_json,r.enabled,r.next_run_at,r.version,r.created_at,r.updated_at
 FROM routines r JOIN sessions s ON s.bot_id=r.bot_id AND s.kind='MAIN';
 CREATE TABLE routine_runs_v47 (
  id TEXT PRIMARY KEY,routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,routine_name TEXT NOT NULL,bot_id TEXT REFERENCES bots(id) ON DELETE CASCADE,
  prompt_snapshot TEXT NOT NULL,schedule_snapshot_json TEXT NOT NULL CHECK(json_valid(schedule_snapshot_json)),trigger TEXT NOT NULL CHECK(trigger IN('schedule','manual','event')),
  trigger_key TEXT NOT NULL UNIQUE,scheduled_for INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN('queued','waiting','dispatching','running','cancel-requested','completed','failed','cancelled','missed','unknown')),
  client_nonce TEXT NOT NULL UNIQUE,runtime_run_id TEXT REFERENCES runtime_runs(id) ON DELETE SET NULL,batch_id TEXT REFERENCES room_batches(id) ON DELETE SET NULL,
  target_snapshot_json TEXT NOT NULL CHECK(json_valid(target_snapshot_json)),authority_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(authority_json)),authority_revoked INTEGER NOT NULL DEFAULT 0,
  request_digest TEXT NOT NULL DEFAULT '${zeroDigest}',event_attachment_json TEXT CHECK(event_attachment_json IS NULL OR json_valid(event_attachment_json)),routine_version INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),last_error_code TEXT,
  created_at TEXT NOT NULL,started_at TEXT,finished_at TEXT
 );
 INSERT INTO routine_runs_v47(id,routine_id,routine_name,bot_id,prompt_snapshot,schedule_snapshot_json,trigger,trigger_key,scheduled_for,state,client_nonce,runtime_run_id,target_snapshot_json,routine_version,last_error_code,created_at,started_at,finished_at)
 SELECT x.id,x.routine_id,x.routine_name,x.bot_id,x.prompt_snapshot,x.schedule_snapshot_json,x.trigger,x.trigger_key,x.scheduled_for,x.state,x.client_nonce,x.runtime_run_id,
  json_object('target',json(r.target_json),'generation',COALESCE((SELECT input_generation FROM runtime_runs WHERE id=x.runtime_run_id),(SELECT generation FROM sessions WHERE id=r.session_id)),
    'scopeVersion',COALESCE((SELECT scope_version FROM runtime_session_scopes WHERE runtime_run_id=x.runtime_run_id),(SELECT version FROM conversation_scope_versions WHERE session_id=r.session_id)),
    'membershipVersion',NULL,'profileVersions',json('[]'),'resourceRefs',json('[]'),'mediaRefs',json('[]'),'admissionDigest','${zeroDigest}','legacy',json('true')),
  r.version,x.last_error_code,x.created_at,x.started_at,x.finished_at FROM routine_runs x JOIN routines_v47 r ON r.id=x.routine_id;
 DROP TABLE routine_runs; DROP TABLE routines;
 ALTER TABLE routines_v47 RENAME TO routines; ALTER TABLE routine_runs_v47 RENAME TO routine_runs;
 CREATE INDEX routines_due ON routines(enabled,next_run_at,id);
 CREATE UNIQUE INDEX routine_one_active_run ON routine_runs(routine_id) WHERE state IN('queued','waiting','dispatching','running','cancel-requested');
 CREATE INDEX routine_runs_history ON routine_runs(routine_id,scheduled_for DESC,id DESC);
 CREATE TRIGGER retire_routine_resource AFTER UPDATE OF enabled,deleted_at ON library_resources WHEN (OLD.enabled=1 AND NEW.enabled=0) OR (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) BEGIN
  UPDATE routines SET authority_revoked=1 WHERE EXISTS(SELECT 1 FROM json_tree(authority_json,'$.grants') WHERE key='resourceId' AND value=NEW.id);
  UPDATE routine_runs SET authority_revoked=1 WHERE EXISTS(SELECT 1 FROM json_tree(authority_json,'$.grants') WHERE key='resourceId' AND value=NEW.id);
 END;
` } as const;

type Authority = { snapshot: RoutineTargetSnapshot; grants: unknown[]; resourceBindings: Array<{ reference: ResourceReference; bindingVersion: number }>; mediaBindings: Array<{ reference: MessageMediaReference; incarnation: string }> };
type RoutineRow = { id: string; name: string; prompt: string; bot_id: string | null; session_id: string; target_json: string; authority_json: string; authority_digest: string; authority_revoked: number; schedule_json: string; enabled: number; next_run_at: number | null; version: number; created_at: string; updated_at: string };
type RunRow = { id: string; routine_id: string; routine_name: string; bot_id: string | null; prompt_snapshot: string; schedule_snapshot_json: string; trigger: RoutineRun["trigger"]; trigger_key: string; scheduled_for: number; state: RoutineRun["state"]; client_nonce: string; runtime_run_id: string | null; batch_id: string | null; target_snapshot_json: string; authority_json: string; authority_revoked: number; request_digest: string; event_attachment_json: string | null; routine_version: number; version: number; last_error_code: string | null; created_at: string; started_at: string | null; finished_at: string | null };
const active = new Set<RoutineRun["state"]>(["queued", "waiting", "dispatching", "running", "cancel-requested"]);
const terminal = new Set<RoutineRun["state"]>(["completed", "failed", "cancelled", "missed", "unknown"]);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",") + "}";
  return JSON.stringify(value);

}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const authorityDigest = (authority: Authority) => hash({ ...authority, snapshot: { ...authority.snapshot, admissionDigest: "" } });
function eventData(value: AttachmentDraft | undefined): AttachmentDraft | undefined {
  if (value === undefined) return undefined;
  const attachment = attachmentDraftSchema.parse(value), bytes = Buffer.from(attachment.content, "utf8");
  if (attachment.name !== "automation-event.json" || attachment.mimeType !== "application/json" || bytes.toString("utf8") !== attachment.content || bytes.length > 65_536 || bytes.length !== attachment.size || createHash("sha256").update(bytes).digest("hex") !== attachment.sha256) throw new AevorenBotError("INVALID_REQUEST", "事件附件无效。");
  try {
    JSON.parse(attachment.content);
  } catch {
    throw new AevorenBotError("INVALID_REQUEST", "事件附件必须包含有效 JSON。");
  }
  return attachment;

}
const stale = () => new AevorenBotError("APPROVAL_SCOPE_INVALID", "自动任务的成员、配置或授权已变化，请重新选择目标与资料后保存。");

export class RoutineRepository {
  private sequence = 0;
  constructor(private readonly database: DatabaseSync, private readonly host: AppRepository) {
    this.backfill();
  }
  private transaction<T>(work: () => T): T {
    const key = `routine_${++this.sequence}`;
    this.database.exec(`SAVEPOINT ${key}`);
    try {
      const result = work();
      this.database.exec(`RELEASE SAVEPOINT ${key}`);
      return result;
    } catch (error) {
      this.database.exec(`ROLLBACK TO SAVEPOINT ${key};RELEASE SAVEPOINT ${key}`);
      throw error;
    }
  }
  private row(id: string): RoutineRow {
    const row = this.database.prepare("SELECT * FROM routines WHERE id=?").get(id) as RoutineRow | undefined;
    if (!row) throw new AevorenBotError("ROUTINE_NOT_FOUND");
    return row;
  }
  private runRow(id: string): RunRow {
    const row = this.database.prepare("SELECT * FROM routine_runs WHERE id=?").get(id) as RunRow | undefined;
    if (!row) throw new AevorenBotError("ROUTINE_RUN_NOT_FOUND");
    return row;
  }
  private dto(row: RoutineRow): Routine {
    return { id: row.id, name: row.name, prompt: row.prompt, botId: row.bot_id, target: JSON.parse(row.target_json), targetSnapshot: (JSON.parse(row.authority_json) as Authority).snapshot, enabled: Boolean(row.enabled), schedule: JSON.parse(row.schedule_json), nextRunAt: row.next_run_at, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  private runDto(row: RunRow): RoutineRun {
    return { id: row.id, routineId: row.routine_id, routineName: row.routine_name, botId: row.bot_id, promptSnapshot: row.prompt_snapshot, scheduleSnapshot: JSON.parse(row.schedule_snapshot_json), trigger: row.trigger, triggerKey: row.trigger_key, scheduledFor: row.scheduled_for, state: row.state, clientNonce: row.client_nonce, runtimeRunId: row.runtime_run_id, batchId: row.batch_id, targetSnapshot: JSON.parse(row.target_snapshot_json), version: row.version, lastErrorCode: row.last_error_code, createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at };
  }
  private target(target: RoutineTarget): { target: RoutineTarget; actors: string[]; membershipVersion: number | null } {
    target = routineTargetSchema.parse(target);
    const session = this.host.getSession(target.sessionId);
    if (session.kind !== "MAIN") throw new AevorenBotError("INVALID_REQUEST", "自动任务目前仅支持 Bot 和群聊的主会话。");
    if (target.kind === "bot") {
      if (session.botId !== target.botId || session.roomId) throw stale();
      this.host.getBot(target.botId);
      return { target, actors: [target.botId], membershipVersion: null };
    }
    if (session.roomId !== target.roomId || session.botId) throw stale();
    const detail = this.host.getRoomDetail(target.roomId, target.sessionId);
    if (detail.room.archivedAt) throw stale();
    const ids = detail.members.map(member => member.botId);
    if (target.targetBotIds.some(id => !ids.includes(id)) || target.routingMode === "everyone" && (ids.length !== target.targetBotIds.length || ids.some(id => !target.targetBotIds.includes(id)))) throw stale();
    return { target, actors: [...target.targetBotIds].sort(), membershipVersion: detail.room.membershipVersion };
  }
  private grants(sessionId: string, botId: string): unknown {
    const bot = this.host.getBot(botId), servers = this.host.listMcpServerConfigs().filter(server => server.enabled && (bot.mcpServerIds === null || bot.mcpServerIds === undefined || bot.mcpServerIds.includes(server.id)));
    return {      
botId, workspaces: this.host.listSessionWorkspaces(sessionId, botId).map(value => ({ id: value.id, version: value.version, write: value.writeEnabled, automation: value.automationEnabled })).sort((a, b) => a.id.localeCompare(b.id)),
      library: (this.database.prepare("SELECT resource_id AS resourceId,version FROM session_resource_bindings WHERE session_id=? AND revoked_at IS NULL ORDER BY resource_id").all(sessionId)),
      media: (this.database.prepare("SELECT media_id AS mediaId,incarnation FROM session_media_bindings WHERE session_id=? AND revoked_at IS NULL ORDER BY media_id").all(sessionId)),
      native: this.host.connectors.bindings({ sessionId, executorBotId: botId }).map(value => ({ id: value.id, version: value.version, authVersion: value.authVersion, connection: this.host.connectors.get(value.connectionId).authVersion })).sort((a, b) => a.id.localeCompare(b.id)),
      scripts: this.host.skillExecutions.list({ sessionId, executorBotId: botId }).map(value => ({ id: value.id, version: value.version })).sort((a, b) => a.id.localeCompare(b.id)),
      mcp: servers.map(server => ({ id: server.id, version: server.version, config: hash(server.config), credentials: hash([this.host.getSetting(`mcp.server.${server.id}.secrets`)?.value ?? null, this.host.getSetting(`mcp.server.${server.id}.oauth`)?.value ?? null]) })).sort((a, b) => a.id.localeCompare(b.id)),
      publicRead: this.host.getSetting("tools.autoApprovePublicRead")?.value === "true"    
};
  }
  private capture(target: RoutineTarget, resourceRefs: ResourceReference[] = [], mediaRefs: MessageMediaReference[] = []): Authority {
    const scoped = this.target(target), session = this.host.getSession(target.sessionId);
    resourceRefs = resourceReferencesSchema.parse(resourceRefs);
    mediaRefs = messageMediaReferencesSchema.parse(mediaRefs);
    for (const actor of scoped.actors) {
      this.host.library.assertReferences(target.sessionId, resourceRefs, actor);
      this.host.media.captureSendReferences(target.sessionId, mediaRefs, actor);
    }
    const snapshot: RoutineTargetSnapshot = { target: scoped.target, generation: session.generation, scopeVersion: this.host.tasks.scopeVersion(target.sessionId), membershipVersion: scoped.membershipVersion, profileVersions: scoped.actors.map(botId => ({ botId, version: this.host.getBot(botId).version })), resourceRefs, mediaRefs, admissionDigest: "" };
    const authority: Authority = { snapshot, grants: scoped.actors.map(id => this.grants(target.sessionId, id)), resourceBindings: this.host.library.captureReferenceBindings(target.sessionId, resourceRefs), mediaBindings: this.host.media.captureSendReferences(target.sessionId, mediaRefs) };
    snapshot.admissionDigest = authorityDigest(authority);
    return authority;
  }
  private assertAuthority(authority: Authority): void {
    const snapshot = authority.snapshot, scoped = this.target(snapshot.target), session = this.host.getSession(snapshot.target.sessionId);
    if (authorityDigest(authority) !== snapshot.admissionDigest || session.generation !== snapshot.generation || this.host.tasks.scopeVersion(session.id) !== snapshot.scopeVersion || scoped.membershipVersion !== snapshot.membershipVersion || snapshot.profileVersions.some(value => this.host.getBot(value.botId).version !== value.version) || hash(scoped.actors.map(id => this.grants(session.id, id))) !== hash(authority.grants)) throw stale();
    this.host.library.assertReferenceBindings(session.id, authority.resourceBindings);
    const current = this.host.media.captureSendReferences(session.id, snapshot.mediaRefs);
    if (current.some((value, index) => value.incarnation !== authority.mediaBindings[index]?.incarnation)) throw stale();
  }
  private backfill(): void {
    this.transaction(() => {
      for (const row of this.database.prepare("SELECT * FROM routines WHERE authority_digest=?").all(zeroDigest) as RoutineRow[]) {
        let authority: Authority, revoked = 0;
        try {
          authority = this.capture(JSON.parse(row.target_json));
        } catch (error) {
          if (!(error instanceof AevorenBotError) || !["BOT_NOT_FOUND", "ROOM_NOT_FOUND", "SESSION_NOT_FOUND"].includes(error.code)) throw error;
          revoked = 1;
          authority = { snapshot: { target: JSON.parse(row.target_json), generation: this.host.getSession(row.session_id).generation, scopeVersion: this.host.tasks.scopeVersion(row.session_id), membershipVersion: null, profileVersions: [], resourceRefs: [], mediaRefs: [], admissionDigest: zeroDigest, legacy: true }, grants: [], resourceBindings: [], mediaBindings: [] };
        }
        this.database.prepare("UPDATE routines SET authority_json=?,authority_digest=?,authority_revoked=?,enabled=CASE WHEN ? THEN 0 ELSE enabled END,next_run_at=CASE WHEN ? THEN NULL ELSE next_run_at END WHERE id=?").run(canonical(authority), authority.snapshot.admissionDigest, revoked, revoked, revoked, row.id);
      }

      for (const row of this.database.prepare("SELECT * FROM routine_runs WHERE authority_json='{}'").all() as RunRow[]) {
        const parent = this.row(row.routine_id), authority = JSON.parse(parent.authority_json) as Authority;
        this.database.prepare("UPDATE routine_runs SET authority_json=? WHERE id=?").run(canonical(authority), row.id);
      }
    });
  }
  list(): Routine[] {
    return (this.database.prepare("SELECT * FROM routines ORDER BY created_at,id").all() as RoutineRow[]).map(row => this.dto(row));
  }
  get(id: string): Routine {
    return this.dto(this.row(id));
  }
  create(input: RoutineCreateInput & { enabled: boolean; nextRunAt: number | null }): Routine {
    return this.transaction(() => {
      const target = "target" in input && input.target ? input.target : { kind: "bot" as const, botId: input.botId!, sessionId: this.host.getMainSession(input.botId!).id };
      const authority = this.capture(target, input.resourceRefs, input.mediaRefs), id = randomUUID(), at = new Date().toISOString();
      this.database.prepare("INSERT INTO routines(id,name,prompt,bot_id,session_id,target_json,authority_json,authority_digest,schedule_json,enabled,next_run_at,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?)").run(id, input.name, input.prompt, target.kind === "bot" ? target.botId : null, target.sessionId, canonical(target), canonical(authority), authority.snapshot.admissionDigest, canonical(input.schedule), Number(input.enabled), input.nextRunAt, at, at);
      return this.get(id);
    });
  }
  update(id: string, expectedVersion: number, patch: RoutineUpdatePatch, nextRunAt: number | null): Routine {
    return this.transaction(() => {
      const row = this.row(id);
      if (row.version !== expectedVersion) throw this.conflict(row);
      const previous = JSON.parse(row.authority_json) as Authority, reselect = patch.target !== undefined || patch.resourceRefs !== undefined || patch.mediaRefs !== undefined;
      const authority = reselect ? this.capture(patch.target ?? previous.snapshot.target, patch.resourceRefs ?? previous.snapshot.resourceRefs, patch.mediaRefs ?? previous.snapshot.mediaRefs) : previous, target = authority.snapshot.target;
      this.database.prepare("UPDATE routines SET name=?,prompt=?,schedule_json=?,bot_id=?,session_id=?,target_json=?,authority_json=?,authority_digest=?,authority_revoked=CASE WHEN ? THEN 0 ELSE authority_revoked END,next_run_at=?,version=version+1,updated_at=? WHERE id=?").run(patch.name ?? row.name, patch.prompt ?? row.prompt, patch.schedule ? canonical(patch.schedule) : row.schedule_json, target.kind === "bot" ? target.botId : null, target.sessionId, canonical(target), canonical(authority), authority.snapshot.admissionDigest, Number(reselect), nextRunAt, new Date().toISOString(), id);
      return this.get(id);
    });
  }
  setEnabled(id: string, expectedVersion: number, enabled: boolean, nextRunAt: number | null): Routine {
    const row = this.row(id);
    if (row.version !== expectedVersion) throw this.conflict(row);
    if (enabled) this.assertRoutine(id);
    this.database.prepare("UPDATE routines SET enabled=?,next_run_at=?,version=version+1,updated_at=? WHERE id=? AND version=?").run(Number(enabled), nextRunAt, new Date().toISOString(), id, expectedVersion);
    return this.get(id);
  }
  delete(id: string, expectedVersion: number): void {
    const row = this.row(id);
    if (row.version !== expectedVersion) throw this.conflict(row);
    if (this.pending().some(run => run.routineId === id)) throw new AevorenBotError("ROUTINE_BUSY");
    this.database.prepare("DELETE FROM routines WHERE id=? AND version=?").run(id, expectedVersion);
  }
  private conflict(row: RoutineRow): AevorenBotError {
    return new AevorenBotError("ROUTINE_VERSION_CONFLICT", undefined, undefined, { currentVersion: row.version });
  }
  assertRoutine(id: string): void {
    const row = this.row(id);
    if (row.authority_revoked) throw stale();
    this.assertAuthority(JSON.parse(row.authority_json));
  }
  assertRun(id: string): RoutineRun {
    const row = this.runRow(id);
    if (row.authority_revoked || !active.has(row.state) || row.state === "cancel-requested") throw stale();
    this.assertAuthority(JSON.parse(row.authority_json));
    return this.runDto(row);
  }
  assertRuntime(runtimeId: string): void {
    const found = this.database.prepare("SELECT rr.id FROM routine_runs rr JOIN runtime_runs r ON r.client_nonce=rr.client_nonce WHERE r.id=?").get(runtimeId) as { id: string } | undefined;
    if (found) {
      const row = this.runRow(found.id);
      if (row.authority_revoked || row.state !== "completed" && (!active.has(row.state) || row.state === "cancel-requested")) throw stale();
      this.assertAuthority(JSON.parse(row.authority_json));
      this.assertReceipt(row.id, { runtimeRunId: runtimeId });
    }
  }
  eventAttachment(id: string): AttachmentDraft | undefined {
    const value = this.runRow(id).event_attachment_json;
    return value ? JSON.parse(value) as AttachmentDraft : undefined;
  }
  assertMessage(id: string, message: TranscriptEntry): void {
    const run = this.getRun(id), attachment = this.eventAttachment(id), metadata = attachment ? { id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size, sha256: attachment.sha256, kind: attachment.kind } : null;
    if (message.clientNonce !== run.clientNonce || message.sessionId !== run.targetSnapshot.target.sessionId || message.generation !== run.targetSnapshot.generation || message.body !== `[Routine: ${run.routineName}]\n${run.promptSnapshot}` || hash(message.resourceRefs ?? []) !== hash(run.targetSnapshot.resourceRefs) || hash(message.mediaRefs ?? []) !== hash(run.targetSnapshot.mediaRefs) || hash(message.attachments ?? []) !== hash(attachment ? [metadata] : [])) throw stale();
  }
  assertReceipt(id: string, link: { runtimeRunId: string } | { batchId: string }): void {
    const run = this.getRun(id), target = run.targetSnapshot.target, message = this.host.getUserMessage(run.clientNonce), origin = message.origin;
    this.assertMessage(id, message);
    if (origin?.kind !== "routine" || origin.routineRunId !== id || origin.routineId !== run.routineId || origin.rootClientNonce !== run.clientNonce || origin.fromSessionId !== target.sessionId || (run.botId ?? undefined) !== origin.fromBotId) throw stale();
    if ("runtimeRunId" in link) {
      const runtime = this.host.getRuntimeRun(link.runtimeRunId);
      if (runtime.clientNonce !== run.clientNonce || runtime.sessionId !== target.sessionId || target.kind === "bot" && runtime.executorBotId !== target.botId || target.kind === "room" && !target.targetBotIds.includes(runtime.executorBotId)) throw stale();
    }
    else {
      const batch = this.host.getRoomBatch(link.batchId);
      const actors = this.host.listRoomTurns(batch.id).filter(turn => turn.origin === "initial").map(turn => turn.memberBotId).sort();
      if (target.kind !== "room" || batch.clientNonce !== run.clientNonce || batch.sessionId !== target.sessionId || batch.roomId !== target.roomId || batch.routingMode !== target.routingMode || batch.membershipVersion !== run.targetSnapshot.membershipVersion || hash(actors) !== hash([...target.targetBotIds].sort())) throw stale();
    }
  }
  getRun(id: string): RoutineRun {
    return this.runDto(this.runRow(id));
  }
  getByTriggerKey(key: string): RoutineRun | null {
    const row = this.database.prepare("SELECT * FROM routine_runs WHERE trigger_key=?").get(key) as RunRow | undefined;
    return row ? this.runDto(row) : null;
  }
  listRuns(routineId?: string): RoutineRun[] {
    if (routineId) this.row(routineId);
    return (this.database.prepare(`SELECT * FROM routine_runs ${routineId ? "WHERE routine_id=?" : ""} ORDER BY scheduled_for DESC,id DESC LIMIT 500`).all(...(routineId ? [routineId] : [])) as RunRow[]).map(row => this.runDto(row));
  }
  pending(): RoutineRun[] {
    return (this.database.prepare("SELECT * FROM routine_runs WHERE state IN('queued','waiting','dispatching','running','cancel-requested') ORDER BY scheduled_for,id").all() as RunRow[]).map(row => this.runDto(row));
  }
  createRun(routine: Routine, trigger: RoutineRun["trigger"], triggerKey: string, scheduledFor: number, state: RoutineRun["state"] = "queued", requestDigest?: string, eventAttachment?: AttachmentDraft): RoutineRun {
    return this.transaction(() => {
      const existing = this.getByTriggerKey(triggerKey);
      if (existing) {
        if (requestDigest && this.runRow(existing.id).request_digest !== requestDigest) throw new AevorenBotError("MESSAGE_NONCE_CONFLICT");
        return existing;
      }
      const row = this.row(routine.id);
      if (row.version !== routine.version) throw this.conflict(row);
      if (active.has(state) && this.pending().some(run => run.routineId === routine.id)) throw new AevorenBotError("ROUTINE_BUSY");
      if (active.has(state)) this.assertRoutine(routine.id);
      const authority = JSON.parse(row.authority_json) as Authority, id = randomUUID(), at = new Date().toISOString();
      this.database.prepare("INSERT INTO routine_runs(id,routine_id,routine_name,bot_id,prompt_snapshot,schedule_snapshot_json,trigger,trigger_key,scheduled_for,state,client_nonce,target_snapshot_json,authority_json,request_digest,event_attachment_json,routine_version,created_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, routine.id, row.name, row.bot_id, row.prompt, row.schedule_json, trigger, triggerKey, scheduledFor, state, randomUUID(), canonical(authority.snapshot), row.authority_json, requestDigest ?? hash({ routineId: routine.id, expectedVersion: routine.version, triggerKey, trigger, scheduledFor }), eventAttachment ? canonical(eventAttachment) : null, routine.version, at, terminal.has(state) ? at : null);
      return this.getRun(id);
    });
  }
  createTrigger(input: RoutineTriggerInput, now: number, eventAttachment?: AttachmentDraft): RoutineRun {
    const parsed = routineTriggerSchema.parse(input), attachment = eventData(eventAttachment);
    if (attachment && (parsed.trigger ?? "event") !== "event") throw new AevorenBotError("INVALID_REQUEST");
    const digest = hash({ ...parsed, trigger: parsed.trigger ?? "event", scheduledFor: parsed.scheduledFor ?? null, eventAttachment: attachment ?? null }), existing = this.getByTriggerKey(parsed.triggerKey);
    if (existing) {
      if (this.runRow(existing.id).request_digest !== digest) throw new AevorenBotError("MESSAGE_NONCE_CONFLICT");
      return existing;
    }
    const routine = this.get(parsed.routineId);
    if (routine.version !== parsed.expectedVersion) throw this.conflict(this.row(routine.id));
    if ((parsed.trigger ?? "event") !== "manual" && !routine.enabled) throw new AevorenBotError("ROUTINE_RUN_STATE_INVALID", "自动任务已停用，未接收新的触发。");
    return this.createRun(routine, parsed.trigger ?? "event", parsed.triggerKey, parsed.scheduledFor ?? now, "queued", digest, attachment);
  }
  advanceDue(id: string, expectedNext: number, next: number | null, missed: boolean): RoutineRun | null {
    return this.transaction(() => {
      const routine = this.get(id);
      const changed = this.database.prepare("UPDATE routines SET next_run_at=?,enabled=CASE WHEN json_extract(schedule_json,'$.type')='once' THEN 0 ELSE enabled END,updated_at=? WHERE id=? AND enabled=1 AND next_run_at=?").run(next, new Date().toISOString(), id, expectedNext);
      if (!changed.changes) return null;
      let state: RoutineRun["state"] = missed ? "missed" : "queued", code: string | null = null;
      if (this.pending().some(run => run.routineId === id)) {
        state = "missed";
        code = "ROUTINE_BUSY";
      }
      if (state === "queued") try {
        this.assertRoutine(id);
      } catch (error) {
        state = "failed";
        code = error instanceof AevorenBotError ? error.code : "INTERNAL_ERROR";
      }
      const run = this.createRun(routine, "schedule", `${id}:schedule:${expectedNext}`, expectedNext, state);
      if (code) this.database.prepare("UPDATE routine_runs SET last_error_code=? WHERE id=?").run(code, run.id);
      return this.getRun(run.id);
    });
  }
  transition(id: string, state: RoutineRun["state"], error: string | null = null, expectedVersion?: number): RoutineRun {
    return this.transaction(() => {
      const row = this.runRow(id);
      if (expectedVersion !== undefined && row.version !== expectedVersion) throw new AevorenBotError("ROUTINE_VERSION_CONFLICT", undefined, undefined, { currentVersion: row.version });
      if (terminal.has(row.state)) {
        if (row.state === state) return this.runDto(row);
        throw new AevorenBotError("ROUTINE_RUN_STATE_INVALID");
      }
      this.database.prepare("UPDATE routine_runs SET state=?,last_error_code=?,version=version+1,finished_at=CASE WHEN ? THEN ? ELSE finished_at END WHERE id=? AND version=?").run(state, error, Number(terminal.has(state)), new Date().toISOString(), id, row.version);
      return this.getRun(id);
    });
  }
  claim(id: string): RoutineRun {
    const row = this.runRow(id);
    if (!["queued", "waiting"].includes(row.state)) throw new AevorenBotError("ROUTINE_RUN_STATE_INVALID");
    this.assertRun(id);
    return this.transition(id, "dispatching", null, row.version);
  }
  attach(id: string, link: { runtimeRunId: string } | { batchId: string }): RoutineRun {
    return this.transaction(() => {
      const row = this.runRow(id);
      if (!["queued", "waiting", "dispatching", "cancel-requested"].includes(row.state)) throw new AevorenBotError("ROUTINE_RUN_STATE_INVALID");
      this.assertReceipt(id, link);
      this.database.prepare("UPDATE routine_runs SET runtime_run_id=?,batch_id=?,state=CASE WHEN state='cancel-requested' THEN state ELSE 'running' END,version=version+1,started_at=COALESCE(started_at,?) WHERE id=? AND version=?").run("runtimeRunId" in link ? link.runtimeRunId : null, "batchId" in link ? link.batchId : null, new Date().toISOString(), id, row.version);
      return this.getRun(id);
    });
  }
  hasEnabled(): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM routines WHERE enabled=1 LIMIT 1").get());
  }

}
