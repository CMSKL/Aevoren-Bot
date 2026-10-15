import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  MediaAsset, MediaAvailableInput, MediaBinding, MediaExtraction, MediaItem, MediaListInput,
  MediaMutationInput, MediaSpan, MessageMediaReference,
} from "@shared/media-contracts";
import { mediaAvailableSchema, mediaListSchema, mediaMutationSchema, messageMediaReferencesSchema } from "@shared/media-schemas";
import { AevorenBotError } from "./errors";

export const MEDIA_MIGRATION = { version: 42, sql: `
  CREATE TABLE media_assets (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER NOT NULL CHECK(size > 0), mime_type TEXT NOT NULL,
    sha256 TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('image','pdf','docx')),
    version INTEGER NOT NULL CHECK(version > 0), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    width INTEGER, height INTEGER, deleted_at TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE media_extractions (
    id TEXT PRIMARY KEY, media_id TEXT NOT NULL REFERENCES media_assets(id), source_sha256 TEXT NOT NULL,
    parser_name TEXT NOT NULL, parser_version TEXT NOT NULL, digest TEXT NOT NULL,
    body TEXT NOT NULL, spans_json TEXT NOT NULL, warning_codes_json TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX media_extractions_asset ON media_extractions(media_id, created_at, id);
  CREATE TABLE session_media_bindings (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    media_id TEXT NOT NULL REFERENCES media_assets(id), version INTEGER NOT NULL CHECK(version > 0),
    incarnation TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT,
    PRIMARY KEY(session_id, media_id)
  );
  CREATE TABLE send_media_admissions (
    transcript_entry_id TEXT NOT NULL REFERENCES transcript_entries(id) ON DELETE CASCADE,
    media_id TEXT NOT NULL REFERENCES media_assets(id), incarnation TEXT NOT NULL, reference_json TEXT NOT NULL,
    PRIMARY KEY(transcript_entry_id, media_id)
  );
  CREATE TABLE runtime_media_snapshots (
    runtime_run_id TEXT PRIMARY KEY REFERENCES runtime_runs(id) ON DELETE CASCADE
  );
  CREATE TABLE runtime_media_admissions (
    runtime_run_id TEXT NOT NULL REFERENCES runtime_runs(id) ON DELETE CASCADE,
    media_id TEXT NOT NULL REFERENCES media_assets(id), incarnation TEXT NOT NULL, reference_json TEXT NOT NULL,
    PRIMARY KEY(runtime_run_id, media_id)
  );
  ALTER TABLE transcript_entries ADD COLUMN media_references_json TEXT NOT NULL DEFAULT '[]';
  CREATE TRIGGER capture_runtime_media AFTER INSERT ON runtime_runs BEGIN
    INSERT INTO runtime_media_snapshots(runtime_run_id) VALUES (NEW.id);
    INSERT INTO runtime_media_admissions(runtime_run_id,media_id,incarnation,reference_json)
      SELECT NEW.id,b.media_id,b.incarnation,
        CASE WHEN e.id IS NULL THEN json_object('mediaId',a.id,'sha256',a.sha256)
          ELSE json_object('mediaId',a.id,'sha256',a.sha256,'extraction',json_object('id',e.id,'digest',e.digest)) END
      FROM session_media_bindings b JOIN media_assets a ON a.id=b.media_id
      LEFT JOIN media_extractions e ON e.id=(SELECT id FROM media_extractions WHERE media_id=a.id ORDER BY created_at DESC,id DESC LIMIT 1)
      WHERE b.session_id=NEW.session_id AND b.revoked_at IS NULL AND a.enabled=1 AND a.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM send_media_admissions s JOIN transcript_entries t ON t.id=s.transcript_entry_id
          WHERE t.client_nonce=NEW.client_nonce AND t.role='user' AND s.media_id=b.media_id);
    INSERT INTO runtime_media_admissions(runtime_run_id,media_id,incarnation,reference_json)
      SELECT NEW.id,s.media_id,s.incarnation,s.reference_json FROM send_media_admissions s JOIN transcript_entries t ON t.id=s.transcript_entry_id
      WHERE t.client_nonce=NEW.client_nonce AND t.session_id=NEW.session_id AND t.role='user';
  END;
  CREATE TRIGGER revoke_removed_member_media AFTER DELETE ON room_members BEGIN
    DELETE FROM runtime_media_admissions WHERE runtime_run_id IN (
      SELECT r.id FROM runtime_runs r JOIN sessions s ON s.id=r.session_id
      WHERE s.room_id=OLD.room_id AND r.executor_bot_id=OLD.bot_id);
  END;
  DROP TRIGGER conversation_message_inserted;
  CREATE TRIGGER conversation_message_inserted AFTER INSERT ON transcript_entries
    WHEN NEW.generation=(SELECT generation FROM sessions WHERE id=NEW.session_id)
      AND (NEW.role='user' OR length(trim(NEW.body))>0 OR NEW.media_references_json<>'[]')
    BEGIN UPDATE conversation_metadata SET hidden_at=NULL,last_activity_at=NEW.created_at,version=version+1 WHERE session_id=NEW.session_id; END;
  DROP TRIGGER conversation_message_updated;
  CREATE TRIGGER conversation_message_updated AFTER UPDATE OF body,media_references_json ON transcript_entries
    WHEN (NEW.body<>OLD.body OR NEW.media_references_json<>OLD.media_references_json)
      AND (length(trim(NEW.body))>0 OR NEW.media_references_json<>'[]')
      AND NEW.generation=(SELECT generation FROM sessions WHERE id=NEW.session_id)
      AND NEW.seq=(SELECT MAX(seq) FROM transcript_entries WHERE session_id=NEW.session_id AND generation=NEW.generation)
    BEGIN UPDATE conversation_metadata SET hidden_at=NULL,last_activity_at=NEW.updated_at,version=version+1 WHERE session_id=NEW.session_id; END;
` } as const;

type AssetRow = { id: string; name: string; size: number; mime_type: string; sha256: string; kind: MediaAsset["kind"];
  version: number; enabled: number; width: number | null; height: number | null; duration_ms: number | null; deleted_at: string | null; created_at: string };
type ExtractionRow = { id: string; media_id: string; source_sha256: string; parser_name: string; parser_version: string;
  digest: string; body: string; spans_json: string; warning_codes_json: string; created_at: string };
type BindingRow = { session_id: string; media_id: string; version: number; incarnation: string; created_at: string; revoked_at: string | null };
export type MediaRuntimeScope = { sessionId: string; executorBotId: string; runtimeRunId: string };
export type MediaReadLease = Readonly<{ sessionId: string; mediaId: string; incarnation: string; executorBotId?: string;
  executorIncarnation?: string; reference: MessageMediaReference }>;
export type CapturedMediaReference = { reference: MessageMediaReference; incarnation: string };
export type StoredMediaImport = { asset: Omit<MediaAsset, "version" | "enabled" | "deletedAt" | "createdAt">;
  extraction: Omit<MediaExtraction, "createdAt"> | null };

export function mediaExtractionDigest(input: { sourceSha256: string; parserName: string; parserVersion: string; text: string; spans: MediaSpan[]; warningCodes: string[] }): string {
  return createHash("sha256").update(JSON.stringify({ sourceSha256: input.sourceSha256, parserName: input.parserName,
    parserVersion: input.parserVersion, text: input.text, spans: input.spans, warningCodes: input.warningCodes })).digest("hex");
}
function asset(row: AssetRow): MediaAsset {
  return { reference: { id: row.id, name: row.name, size: row.size, mimeType: row.mime_type, sha256: row.sha256 }, kind: row.kind,
    version: row.version, enabled: Boolean(row.enabled), width: row.width, height: row.height, durationMs: row.duration_ms ?? null, deletedAt: row.deleted_at, createdAt: row.created_at };
}
function extraction(row: ExtractionRow): MediaExtraction {
  return { id: row.id, mediaId: row.media_id, sourceSha256: row.source_sha256, parserName: row.parser_name, parserVersion: row.parser_version,
    digest: row.digest, text: row.body, spans: JSON.parse(row.spans_json), warningCodes: JSON.parse(row.warning_codes_json), createdAt: row.created_at };
}
function binding(row: BindingRow): MediaBinding {
  return { sessionId: row.session_id, mediaId: row.media_id, version: row.version, createdAt: row.created_at, revokedAt: row.revoked_at };
}

export class MediaRepository {
  private sequence = 0;
  private readonly leases = new WeakSet<MediaReadLease>();
  private readonly executorIncarnations = new Map<string, string>();
  constructor(private readonly database: DatabaseSync, private readonly assertScope: (sessionId: string, executorBotId?: string) => void) {}
  transaction<T>(work: () => T): T {
    const name = `aevoren_media_${++this.sequence}`;
    this.database.exec(`SAVEPOINT ${name}`);
    try { const result = work(); this.database.exec(`RELEASE SAVEPOINT ${name}`); return result; }
    catch (error) { this.database.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`); throw error; }
  }
  private row(id: string): AssetRow {
    const row = this.database.prepare("SELECT * FROM media_assets WHERE id=?").get(id) as AssetRow | undefined;
    if (!row) throw new AevorenBotError("MEDIA_NOT_FOUND");
    return row;
  }
  private bound(sessionId: string, id: string, executorBotId?: string): BindingRow {
    this.assertScope(sessionId, executorBotId);
    const row = this.database.prepare("SELECT * FROM session_media_bindings WHERE session_id=? AND media_id=? AND revoked_at IS NULL").get(sessionId, id) as BindingRow | undefined;
    if (!row) throw new AevorenBotError("MEDIA_NOT_GRANTED");
    return row;
  }
  private item(row: AssetRow, fixed?: MessageMediaReference): MediaItem {
    const result = fixed?.extraction
      ? this.database.prepare("SELECT * FROM media_extractions WHERE id=? AND media_id=?").get(fixed.extraction.id, row.id) as ExtractionRow | undefined
      : this.database.prepare("SELECT * FROM media_extractions WHERE media_id=? ORDER BY created_at DESC,id DESC LIMIT 1").get(row.id) as ExtractionRow | undefined;
    if (fixed && (fixed.mediaId !== row.id || fixed.sha256 !== row.sha256 || fixed.extraction && (!result || result.digest !== fixed.extraction.digest || result.source_sha256 !== row.sha256)))
      throw new AevorenBotError("MEDIA_REFERENCE_INVALID");
    const parsed = result ? extraction(result) : null;
    return { asset: asset(row), reference: fixed ?? { mediaId: row.id, sha256: row.sha256,
      ...(parsed ? { extraction: { id: parsed.id, digest: parsed.digest } } : {}) }, extraction: parsed ? {
      id: parsed.id, mediaId: parsed.mediaId, sourceSha256: parsed.sourceSha256, parserName: parsed.parserName, parserVersion: parsed.parserVersion,
      digest: parsed.digest, warningCodes: parsed.warningCodes, createdAt: parsed.createdAt, totalCharacters: parsed.text.length, spanCount: parsed.spans.length,
    } : null };
  }
  private readable(row: AssetRow): void {
    if (!row.enabled || row.deleted_at) throw new AevorenBotError("MEDIA_NOT_GRANTED");
  }
  metadata(input: { sessionId: string; id: string }, executorBotId?: string): MediaItem {
    this.bound(input.sessionId, input.id, executorBotId);
    return this.item(this.row(input.id));
  }
  list(input: MediaListInput, executorBotId?: string): MediaItem[] {
    const parsed = mediaListSchema.parse(input); this.assertScope(parsed.sessionId, executorBotId);
    const rows = this.database.prepare("SELECT a.* FROM media_assets a JOIN session_media_bindings b ON b.media_id=a.id WHERE b.session_id=? AND b.revoked_at IS NULL ORDER BY a.created_at DESC,a.id").all(parsed.sessionId) as AssetRow[];
    return this.filter(rows, parsed).map(row => this.item(row));
  }
  available(input: MediaAvailableInput = {}): MediaItem[] {
    const parsed = mediaAvailableSchema.parse(input);
    return this.filter(this.database.prepare("SELECT * FROM media_assets ORDER BY created_at DESC,id").all() as AssetRow[], parsed).map(row => this.item(row));
  }
  private filter(rows: AssetRow[], input: MediaAvailableInput): AssetRow[] {
    return rows.filter(row => (input.includeDisabled || Boolean(row.enabled)) && (input.includeDeleted || !row.deleted_at)
      && (!input.query || row.name.toLocaleLowerCase().includes(input.query.toLocaleLowerCase()))).slice(0, 500);
  }
  captureUiLease(input: { sessionId: string; id: string; reference?: MessageMediaReference }, executorBotId?: string): MediaReadLease {
    const bound = this.bound(input.sessionId, input.id, executorBotId), row = this.row(input.id); this.readable(row);
    const key = `${input.sessionId}:${executorBotId}`;
    if (executorBotId && !this.executorIncarnations.has(key)) this.executorIncarnations.set(key, randomUUID());
    const lease: MediaReadLease = Object.freeze({ sessionId: input.sessionId, mediaId: input.id, incarnation: bound.incarnation,
      ...(executorBotId ? { executorBotId } : {}), ...(executorBotId ? { executorIncarnation: this.executorIncarnations.get(key)! } : {}), reference: structuredClone(this.item(row, input.reference).reference) });
    this.leases.add(lease); return lease;
  }
  resolveUiLease(lease: MediaReadLease): { item: MediaItem; extraction: MediaExtraction | null } {
    if (!this.leases.has(lease)) throw new AevorenBotError("MEDIA_NOT_GRANTED");
    const current = this.bound(lease.sessionId, lease.mediaId, lease.executorBotId), row = this.row(lease.mediaId); this.readable(row);
    if (current.incarnation !== lease.incarnation) throw new AevorenBotError("MEDIA_NOT_GRANTED");
    if (lease.executorBotId && this.executorIncarnations.get(`${lease.sessionId}:${lease.executorBotId}`) !== lease.executorIncarnation)
      throw new AevorenBotError("MEDIA_NOT_GRANTED");
    return this.content(row, lease.reference);
  }
  private content(row: AssetRow, reference: MessageMediaReference): { item: MediaItem; extraction: MediaExtraction | null } {
    const item = this.item(row, reference), parsed = reference.extraction ? this.database.prepare("SELECT * FROM media_extractions WHERE id=?").get(reference.extraction.id) as ExtractionRow : undefined;
    return { item, extraction: parsed ? extraction(parsed) : null };
  }
  captureSendReferences(sessionId: string, refs: readonly MessageMediaReference[], executorBotId?: string): CapturedMediaReference[] {
    return messageMediaReferencesSchema.parse(refs).map(reference => {
      const lease = this.captureUiLease({ sessionId, id: reference.mediaId, reference }, executorBotId);
      return { reference: structuredClone(reference), incarnation: lease.incarnation };
    });
  }
  /** Host callback on real membership removal; ephemeral UI leases never survive a re-add. */
  revokeExecutor(sessionId: string, executorBotId: string): void { this.executorIncarnations.delete(`${sessionId}:${executorBotId}`); }
  storeSendAdmissions(entryId: string, captured: CapturedMediaReference[]): void {
    for (const entry of captured) this.database.prepare("INSERT INTO send_media_admissions(transcript_entry_id,media_id,incarnation,reference_json) VALUES (?,?,?,?)")
      .run(entryId, entry.reference.mediaId, entry.incarnation, JSON.stringify(entry.reference));
  }
  assertRuntime(scope: MediaRuntimeScope): void {
    this.assertScope(scope.sessionId, scope.executorBotId);
    const current = this.database.prepare("SELECT r.state,r.input_generation,s.generation FROM runtime_runs r JOIN sessions s ON s.id=r.session_id JOIN runtime_media_snapshots m ON m.runtime_run_id=r.id WHERE r.id=? AND r.session_id=? AND r.executor_bot_id=?")
      .get(scope.runtimeRunId, scope.sessionId, scope.executorBotId) as { state: string; input_generation: number; generation: number } | undefined;
    if (!current || !["created", "dispatching", "running", "streaming"].includes(current.state) || current.input_generation !== current.generation)
      throw new AevorenBotError("MEDIA_NOT_GRANTED");
  }
  resolveRuntimeRead(scope: MediaRuntimeScope, id: string, fixed?: MessageMediaReference): { item: MediaItem; extraction: MediaExtraction | null } {
    this.assertRuntime(scope);
    const admission = this.database.prepare("SELECT incarnation,reference_json FROM runtime_media_admissions WHERE runtime_run_id=? AND media_id=?").get(scope.runtimeRunId, id) as { incarnation: string; reference_json: string } | undefined;
    const current = this.bound(scope.sessionId, id, scope.executorBotId), row = this.row(id); this.readable(row);
    if (!admission || current.incarnation !== admission.incarnation) throw new AevorenBotError("MEDIA_NOT_GRANTED");
    const original = messageMediaReferencesSchema.parse([JSON.parse(admission.reference_json)])[0]!;
    if (fixed && (fixed.mediaId !== original.mediaId || fixed.sha256 !== original.sha256
      || fixed.extraction?.id !== original.extraction?.id || fixed.extraction?.digest !== original.extraction?.digest)) throw new AevorenBotError("MEDIA_REFERENCE_INVALID");
    return this.content(row, original);
  }
  listRuntimeItems(scope: MediaRuntimeScope, input: MediaAvailableInput = {}): MediaItem[] {
    this.assertRuntime(scope);
    return this.list({ ...input, sessionId: scope.sessionId }, scope.executorBotId).flatMap(item => {
      try { return [this.resolveRuntimeRead(scope, item.asset.reference.id).item]; } catch (error) { if (error instanceof AevorenBotError && error.code === "MEDIA_NOT_GRANTED") return []; throw error; }
    });
  }
  publishImport(sessionId: string, values: StoredMediaImport[], executorBotId?: string, runtimeRunId?: string): MediaItem[] {
    return this.transaction(() => {
      this.assertScope(sessionId, executorBotId);
      if (runtimeRunId) { if (!executorBotId) throw new AevorenBotError("MEDIA_NOT_GRANTED"); this.assertRuntime({ sessionId, executorBotId, runtimeRunId }); }
      const at = new Date().toISOString();
      return values.map(value => {
        const a = value.asset, r = a.reference;
        this.database.prepare("INSERT INTO media_assets(id,name,size,mime_type,sha256,kind,version,enabled,width,height,duration_ms,deleted_at,created_at) VALUES (?,?,?,?,?,?,1,1,?,?,?,NULL,?)")
          .run(r.id, r.name, r.size, r.mimeType, r.sha256, a.kind, a.width, a.height, a.durationMs, at);
        if (value.extraction) { const e = value.extraction;
          this.database.prepare("INSERT INTO media_extractions(id,media_id,source_sha256,parser_name,parser_version,digest,body,spans_json,warning_codes_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
            .run(e.id, r.id, r.sha256, e.parserName, e.parserVersion, e.digest, e.text, JSON.stringify(e.spans), JSON.stringify(e.warningCodes), at);
        }
        const bound = this.bind({ sessionId, id: r.id }, executorBotId);
        if (runtimeRunId) {
          const privateBinding = this.bound(sessionId, r.id, executorBotId);
          this.database.prepare("INSERT INTO runtime_media_admissions(runtime_run_id,media_id,incarnation,reference_json) VALUES (?,?,?,?)").run(runtimeRunId, bound.mediaId, privateBinding.incarnation, JSON.stringify(this.item(this.row(r.id)).reference));
        }
        return this.item(this.row(r.id));
      });
    });
  }
  bind(input: { sessionId: string; id: string }, executorBotId?: string): MediaBinding {
    this.assertScope(input.sessionId, executorBotId); this.row(input.id);
    const row = this.database.prepare("SELECT * FROM session_media_bindings WHERE session_id=? AND media_id=?").get(input.sessionId, input.id) as BindingRow | undefined;
    if (row && !row.revoked_at) return binding(row);
    const at = new Date().toISOString();
    this.database.prepare("INSERT INTO session_media_bindings(session_id,media_id,version,incarnation,created_at,revoked_at) VALUES (?,?,1,?,?,NULL) ON CONFLICT(session_id,media_id) DO UPDATE SET version=version+1,incarnation=excluded.incarnation,created_at=excluded.created_at,revoked_at=NULL")
      .run(input.sessionId, input.id, randomUUID(), at);
    return binding(this.bound(input.sessionId, input.id, executorBotId));
  }
  unbind(input: { sessionId: string; id: string }, executorBotId?: string): boolean {
    this.assertScope(input.sessionId, executorBotId);
    return Number(this.database.prepare("UPDATE session_media_bindings SET revoked_at=?,incarnation=?,version=version+1 WHERE session_id=? AND media_id=? AND revoked_at IS NULL")
      .run(new Date().toISOString(), randomUUID(), input.sessionId, input.id).changes) > 0;
  }
  mutate(input: MediaMutationInput, action: "enabled" | "deleted" | "restored", enabled?: boolean, executorBotId?: string): MediaAsset {
    const parsed = mediaMutationSchema.parse(input);
    return this.transaction(() => {
      this.bound(parsed.sessionId, parsed.id, executorBotId); const row = this.row(parsed.id);
      if (row.version !== parsed.expectedVersion) throw new AevorenBotError("MEDIA_VERSION_CONFLICT");
      if (action === "enabled") this.database.prepare("UPDATE media_assets SET enabled=?,version=version+1 WHERE id=?").run(enabled ? 1 : 0, parsed.id);
      else this.database.prepare("UPDATE media_assets SET deleted_at=?,version=version+1 WHERE id=?").run(action === "deleted" ? new Date().toISOString() : null, parsed.id);
      const bindings = this.database.prepare("SELECT session_id FROM session_media_bindings WHERE media_id=?").all(parsed.id) as { session_id: string }[];
      for (const value of bindings) this.database.prepare("UPDATE session_media_bindings SET incarnation=?,version=version+1 WHERE session_id=? AND media_id=?").run(randomUUID(), value.session_id, parsed.id);
      return asset(this.row(parsed.id));
    });
  }
}
