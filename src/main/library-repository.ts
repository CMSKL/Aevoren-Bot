import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type {
  LibraryAvailableInput, LibraryBindingInput, LibraryContent, LibraryCreateInput,
  LibraryListInput, LibraryMutationInput, LibraryReadInput, LibraryResource, LibraryResourceKind,
  LibraryRestoreVersionInput, LibraryUpdateInput, LibraryVersionsInput,
  ResourceFileRef, ResourceReference, ResourceRevision, ResourceRevisionSummary, SessionResourceBinding,
} from "@shared/library-contracts";
import {
  LIBRARY_IMPORT_MAX_BYTES, libraryAvailableSchema, libraryBindingSchema, libraryBodySchema,
  libraryCreateSchema, libraryListSchema, libraryMutationSchema, libraryReadSchema,
  libraryRestoreVersionSchema, librarySetEnabledSchema, libraryUpdateSchema, libraryVersionsSchema,
  resourceFilesSchema, resourceReferencesSchema,
} from "@shared/library-schemas";
import { AevorenBotError } from "./errors";

export const RESOURCE_LIBRARY_MIGRATION = {
  version: 34,
  sql: `
    CREATE TABLE library_resources (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('document','skill')),
      name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL CHECK(version > 0),
      current_revision_id TEXT NOT NULL REFERENCES library_revisions(id) DEFERRABLE INITIALLY DEFERRED,
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), deleted_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE library_revisions (
      id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES library_resources(id),
      number INTEGER NOT NULL CHECK(number > 0), name TEXT NOT NULL, description TEXT NOT NULL,
      body TEXT NOT NULL, digest TEXT NOT NULL, files_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
      UNIQUE(resource_id, number)
    );
    CREATE TABLE session_resource_bindings (
      session_id TEXT NOT NULL REFERENCES sessions(id), resource_id TEXT NOT NULL REFERENCES library_resources(id),
      version INTEGER NOT NULL CHECK(version > 0), created_at TEXT NOT NULL, revoked_at TEXT,
      PRIMARY KEY(session_id, resource_id)
    );
    CREATE INDEX session_resource_bindings_resource ON session_resource_bindings(resource_id, session_id);
    CREATE VIRTUAL TABLE library_fts USING fts5(resource_id UNINDEXED, name, description, body, tokenize='unicode61');
    ALTER TABLE transcript_entries ADD COLUMN resource_references_json TEXT NOT NULL DEFAULT '[]';
  `,
} as const;

type ResourceRow = {
  id: string; kind: LibraryResourceKind; name: string; description: string; version: number;
  current_revision_id: string; enabled: number; deleted_at: string | null; created_at: string; updated_at: string;
};
type RevisionRow = {
  id: string; resource_id: string; number: number; name: string; description: string;
  body: string; digest: string; files_json: string; created_at: string;
};
type BindingRow = { session_id: string; resource_id: string; version: number; created_at: string };
type StoredCreateInput = LibraryCreateInput & { files?: ResourceFileRef[] };
type StoredUpdateInput = LibraryUpdateInput & { files?: ResourceFileRef[] };
const storedUpdateSchema = z.object({ ...libraryUpdateSchema.shape, files: resourceFilesSchema.optional() }).strict()
  .refine((input) => input.name !== undefined || input.description !== undefined || input.body !== undefined || input.files !== undefined, "At least one field is required");

function resource(row: ResourceRow): LibraryResource {
  return {
    id: row.id, kind: row.kind, name: row.name, description: row.description, version: row.version,
    currentRevisionId: row.current_revision_id, enabled: Boolean(row.enabled), deletedAt: row.deleted_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function binding(row: BindingRow): SessionResourceBinding {
  return { sessionId: row.session_id, resourceId: row.resource_id, version: row.version, createdAt: row.created_at };
}

function normalizedFiles(files: ResourceFileRef[]): ResourceFileRef[] {
  return resourceFilesSchema.parse(files).toSorted((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);
}

/** Includes immutable display metadata so a pinned reference never changes its title. */
export function libraryRevisionDigest(kind: LibraryResourceKind, name: string, description: string, body: string, files: ResourceFileRef[]): string {
  return createHash("sha256").update(JSON.stringify({ kind, name, description, body, files: normalizedFiles(files) })).digest("hex");
}

function assertContentSize(body: string, files: ResourceFileRef[]): void {
  libraryBodySchema.parse(body);
  if (Buffer.byteLength(body, "utf8") + files.reduce((size, file) => size + file.size, 0) > LIBRARY_IMPORT_MAX_BYTES) {
    throw new AevorenBotError("INVALID_REQUEST");
  }
}

export class LibraryRepository {
  private savepointSequence = 0;

  constructor(private readonly database: DatabaseSync, private readonly assertSession: (sessionId: string, executorBotId?: string) => void) {}

  /** SAVEPOINT works both standalone and inside the host's product-receipt transaction. */
  transaction<T>(operation: () => T): T {
    const savepoint = `aevoren_library_${++this.savepointSequence}`;
    this.database.exec(`SAVEPOINT ${savepoint};`);
    try {
      const result = operation();
      this.database.exec(`RELEASE SAVEPOINT ${savepoint};`);
      return result;
    } catch (error) {
      this.database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint};`);
      throw error;
    }
  }

  list(input: LibraryListInput, executorBotId?: string): LibraryResource[] {
    const parsed = libraryListSchema.parse(input);
    this.assertSession(parsed.sessionId, executorBotId);
    const rows = this.database.prepare(`SELECT library_resources.* FROM library_resources
      JOIN session_resource_bindings ON session_resource_bindings.resource_id = library_resources.id
      WHERE session_resource_bindings.session_id = ? AND session_resource_bindings.revoked_at IS NULL
      ORDER BY library_resources.updated_at DESC, library_resources.id`).all(parsed.sessionId) as ResourceRow[];
    return this.filterRows(rows, parsed, true);
  }

  /** User reuse directory contains metadata only, with no resource body or file bytes. */
  available(input: LibraryAvailableInput = {}): LibraryResource[] {
    const parsed = libraryAvailableSchema.parse(input);
    const rows = this.database.prepare("SELECT * FROM library_resources ORDER BY updated_at DESC, id").all() as ResourceRow[];
    return this.filterRows(rows, parsed, false);
  }

  private filterRows(rows: ResourceRow[], input: LibraryAvailableInput, searchBody: boolean): LibraryResource[] {
    let matches: Set<string> | undefined;
    const query = input.query?.trim();
    if (query && searchBody) {
      const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
      const fts = tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(" AND ");
      matches = new Set(fts ? (this.database.prepare("SELECT resource_id FROM library_fts WHERE library_fts MATCH ?")
        .all(fts) as { resource_id: string }[]).map((row) => row.resource_id) : []);
      // unicode61 does not segment CJK words; literal matching keeps Chinese substring search useful.
      const literal = this.database.prepare(`SELECT resource_id FROM library_fts
        WHERE instr(lower(name), lower(?)) > 0 OR instr(lower(description), lower(?)) > 0 OR instr(lower(body), lower(?)) > 0`)
        .all(query, query, query) as { resource_id: string }[];
      for (const row of literal) matches.add(row.resource_id);
    }
    return rows.filter((row) => (!input.kind || row.kind === input.kind)
      && (input.includeDeleted || row.deleted_at === null)
      && (input.includeDisabled || Boolean(row.enabled))
      && (!query || (matches ? matches.has(row.id) : `${row.name}\n${row.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))))
      .slice(0, 500).map(resource);
  }

  read(input: LibraryReadInput, executorBotId?: string): LibraryContent {
    const parsed = libraryReadSchema.parse(input);
    const current = this.scopedResource(parsed.sessionId, parsed.id, executorBotId);
    this.assertVisible(current, parsed);
    return this.content(current, parsed.revisionId ?? current.currentRevisionId);
  }

  create(input: StoredCreateInput, executorBotId?: string): LibraryContent {
    const { files: rawFiles = [], ...fields } = input;
    const parsed = libraryCreateSchema.parse(fields);
    const files = normalizedFiles(rawFiles);
    assertContentSize(parsed.body, files);
    return this.transaction(() => {
      this.assertSession(parsed.sessionId, executorBotId);
      const id = randomUUID();
      const revisionId = randomUUID();
      const timestamp = new Date().toISOString();
      this.database.prepare(`INSERT INTO library_resources
        (id,kind,name,description,version,current_revision_id,enabled,deleted_at,created_at,updated_at)
        VALUES(?,?,?,?,1,?,1,NULL,?,?)`).run(id, parsed.kind, parsed.name, parsed.description ?? "", revisionId, timestamp, timestamp);
      this.insertRevision({ id: revisionId, resourceId: id, number: 1, name: parsed.name, description: parsed.description ?? "",
        body: parsed.body, digest: libraryRevisionDigest(parsed.kind, parsed.name, parsed.description ?? "", parsed.body, files), files, createdAt: timestamp });
      this.bind({ sessionId: parsed.sessionId, id }, executorBotId);
      return this.read({ sessionId: parsed.sessionId, id }, executorBotId);
    });
  }

  createMany(inputs: StoredCreateInput[], executorBotId?: string): LibraryContent[] {
    if (inputs.length === 0 || inputs.length > 250) throw new AevorenBotError("INVALID_REQUEST");
    return this.transaction(() => inputs.map((input) => this.create(input, executorBotId)));
  }

  update(input: StoredUpdateInput, executorBotId?: string): LibraryContent {
    const parsed = storedUpdateSchema.parse(input);
    const files = parsed.files === undefined ? undefined : normalizedFiles(parsed.files);
    return this.transaction(() => {
      const current = this.scopedResource(parsed.sessionId, parsed.id, executorBotId);
      this.assertVisible(current, { includeDisabled: true });
      this.assertVersion(current, parsed.expectedVersion);
      const previous = this.content(current, current.currentRevisionId).revision;
      return this.replaceRevision(current, {
        name: parsed.name ?? previous.name, description: parsed.description ?? previous.description,
        body: parsed.body ?? previous.body, files: files ?? previous.files,
      });
    });
  }

  setEnabled(input: LibraryMutationInput & { enabled: boolean }, executorBotId?: string): LibraryResource {
    const parsed = librarySetEnabledSchema.parse(input);
    return this.changeResource(parsed, executorBotId, (current, timestamp) => {
      this.assertVisible(current, { includeDisabled: true });
      this.database.prepare("UPDATE library_resources SET enabled=?,version=version+1,updated_at=? WHERE id=?")
        .run(Number(parsed.enabled), timestamp, current.id);
    });
  }

  delete(input: LibraryMutationInput, executorBotId?: string): LibraryResource {
    const parsed = libraryMutationSchema.parse(input);
    return this.changeResource(parsed, executorBotId, (current, timestamp) => {
      if (current.deletedAt) return;
      this.database.prepare("UPDATE library_resources SET deleted_at=?,version=version+1,updated_at=? WHERE id=?")
        .run(timestamp, timestamp, current.id);
    });
  }

  restore(input: LibraryMutationInput, executorBotId?: string): LibraryResource {
    const parsed = libraryMutationSchema.parse(input);
    return this.changeResource(parsed, executorBotId, (current, timestamp) => {
      if (!current.deletedAt) return;
      this.database.prepare("UPDATE library_resources SET deleted_at=NULL,version=version+1,updated_at=? WHERE id=?")
        .run(timestamp, current.id);
    });
  }

  private changeResource(input: LibraryMutationInput, executorBotId: string | undefined, apply: (current: LibraryResource, timestamp: string) => void): LibraryResource {
    return this.transaction(() => {
      const current = this.scopedResource(input.sessionId, input.id, executorBotId);
      this.assertVersion(current, input.expectedVersion);
      apply(current, new Date().toISOString());
      return this.getResource(current.id);
    });
  }

  versions(input: LibraryVersionsInput, executorBotId?: string): ResourceRevisionSummary[] {
    const parsed = libraryVersionsSchema.parse(input);
    const current = this.scopedResource(parsed.sessionId, parsed.id, executorBotId);
    this.assertVisible(current, parsed);
    return (this.database.prepare(`SELECT id,resource_id,number,name,description,digest,created_at,
      json_array_length(files_json) AS file_count FROM library_revisions WHERE resource_id=? ORDER BY number DESC LIMIT 50`)
      .all(current.id) as (Omit<RevisionRow, "body" | "files_json"> & { file_count: number })[]).map((row) => ({
      id: row.id, resourceId: row.resource_id, number: row.number, name: row.name, description: row.description,
      digest: row.digest, createdAt: row.created_at, fileCount: row.file_count,
    }));
  }

  restoreVersion(input: LibraryRestoreVersionInput, executorBotId?: string): LibraryContent {
    const parsed = libraryRestoreVersionSchema.parse(input);
    return this.transaction(() => {
      const current = this.scopedResource(parsed.sessionId, parsed.id, executorBotId);
      this.assertVisible(current, { includeDisabled: true });
      this.assertVersion(current, parsed.expectedVersion);
      const previous = this.content(current, parsed.revisionId).revision;
      return this.replaceRevision(current, previous);
    });
  }

  private replaceRevision(current: LibraryResource, value: Pick<ResourceRevision, "name" | "description" | "body" | "files">): LibraryContent {
    assertContentSize(value.body, value.files);
    const revisionId = randomUUID();
    const timestamp = new Date().toISOString();
    const last = this.database.prepare("SELECT MAX(number) AS number FROM library_revisions WHERE resource_id=?").get(current.id) as { number: number };
    this.insertRevision({ ...value, id: revisionId, resourceId: current.id, number: last.number + 1,
      digest: libraryRevisionDigest(current.kind, value.name, value.description, value.body, value.files), createdAt: timestamp });
    this.database.prepare("UPDATE library_resources SET name=?,description=?,current_revision_id=?,version=version+1,updated_at=? WHERE id=?")
      .run(value.name, value.description, revisionId, timestamp, current.id);
    return this.content(this.getResource(current.id), revisionId);
  }

  bind(input: LibraryBindingInput, executorBotId?: string): SessionResourceBinding {
    const parsed = libraryBindingSchema.parse(input);
    return this.transaction(() => {
      this.assertSession(parsed.sessionId, executorBotId);
      // A trusted user can rebind an inactive resource to recover it. AI cannot grant itself that access.
      this.assertVisible(this.getResource(parsed.id), { includeDisabled: !executorBotId, includeDeleted: !executorBotId });
      const existing = this.database.prepare("SELECT * FROM session_resource_bindings WHERE session_id=? AND resource_id=? AND revoked_at IS NULL")
        .get(parsed.sessionId, parsed.id) as BindingRow | undefined;
      if (existing) return binding(existing);
      const timestamp = new Date().toISOString();
      this.database.prepare(`INSERT INTO session_resource_bindings(session_id,resource_id,version,created_at,revoked_at)
        VALUES(?,?,1,?,NULL) ON CONFLICT(session_id,resource_id) DO UPDATE SET
        version=session_resource_bindings.version+1,created_at=excluded.created_at,revoked_at=NULL`).run(parsed.sessionId, parsed.id, timestamp);
      return binding(this.database.prepare("SELECT * FROM session_resource_bindings WHERE session_id=? AND resource_id=?")
        .get(parsed.sessionId, parsed.id) as BindingRow);
    });
  }

  unbind(input: LibraryBindingInput, executorBotId?: string): boolean {
    const parsed = libraryBindingSchema.parse(input);
    return this.transaction(() => {
      this.assertSession(parsed.sessionId, executorBotId);
      return this.database.prepare(`UPDATE session_resource_bindings SET revoked_at=?,version=version+1
        WHERE session_id=? AND resource_id=? AND revoked_at IS NULL`).run(new Date().toISOString(), parsed.sessionId, parsed.id).changes > 0;
    });
  }

  resolveReferences(sessionId: string, references: ResourceReference[], executorBotId?: string): LibraryContent[] {
    libraryListSchema.parse({ sessionId });
    const parsed = resourceReferencesSchema.parse(references);
    this.assertSession(sessionId, executorBotId);
    return parsed.map((reference) => {
      const content = this.read({ sessionId, id: reference.resourceId, revisionId: reference.revisionId }, executorBotId);
      if (content.reference.digest !== reference.digest) throw new AevorenBotError("LIBRARY_REFERENCE_INVALID");
      return content;
    });
  }

  assertReferences(sessionId: string, references: ResourceReference[], executorBotId?: string): void {
    this.resolveReferences(sessionId, references, executorBotId);
  }

  private scopedResource(sessionId: string, id: string, executorBotId?: string): LibraryResource {
    this.assertSession(sessionId, executorBotId);
    if (!this.database.prepare("SELECT 1 FROM session_resource_bindings WHERE session_id=? AND resource_id=? AND revoked_at IS NULL").get(sessionId, id)) {
      throw new AevorenBotError("LIBRARY_NOT_BOUND");
    }
    return this.getResource(id);
  }

  private getResource(id: string): LibraryResource {
    const row = this.database.prepare("SELECT * FROM library_resources WHERE id=?").get(id) as ResourceRow | undefined;
    if (!row) throw new AevorenBotError("LIBRARY_NOT_FOUND");
    return resource(row);
  }

  private assertVisible(current: LibraryResource, input: { includeDisabled?: boolean; includeDeleted?: boolean }): void {
    if (current.deletedAt && !input.includeDeleted) throw new AevorenBotError("LIBRARY_NOT_FOUND");
    if (!current.enabled && !input.includeDisabled) throw new AevorenBotError("LIBRARY_DISABLED");
  }

  private assertVersion(current: LibraryResource, expectedVersion: number): void {
    if (current.version !== expectedVersion) throw new AevorenBotError("LIBRARY_VERSION_CONFLICT", undefined, undefined, { currentVersion: current.version });
  }

  private content(current: LibraryResource, revisionId: string): LibraryContent {
    const row = this.database.prepare("SELECT * FROM library_revisions WHERE resource_id=? AND id=?").get(current.id, revisionId) as RevisionRow | undefined;
    if (!row) throw new AevorenBotError("LIBRARY_REFERENCE_INVALID");
    const files = normalizedFiles(JSON.parse(row.files_json));
    assertContentSize(row.body, files);
    if (libraryRevisionDigest(current.kind, row.name, row.description, row.body, files) !== row.digest) {
      throw new AevorenBotError("LIBRARY_REFERENCE_INVALID");
    }
    const revision: ResourceRevision = { id: row.id, resourceId: row.resource_id, number: row.number, name: row.name,
      description: row.description, body: row.body, digest: row.digest, files, createdAt: row.created_at };
    return { resource: current, revision, reference: { resourceId: current.id, revisionId: row.id, digest: row.digest } };
  }

  private insertRevision(value: ResourceRevision): void {
    this.database.prepare(`INSERT INTO library_revisions(id,resource_id,number,name,description,body,digest,files_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(value.id, value.resourceId, value.number, value.name, value.description,
      value.body, value.digest, JSON.stringify(value.files), value.createdAt);
    this.database.prepare("DELETE FROM library_fts WHERE resource_id=?").run(value.resourceId);
    this.database.prepare("INSERT INTO library_fts(resource_id,name,description,body) VALUES(?,?,?,?)")
      .run(value.resourceId, value.name, value.description, value.body);
  }
}
