import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { resourceFilesSchema, resourceReferencesSchema } from "@shared/library-schemas";
import { AppRepository, MIGRATIONS } from "./database";
import { AevorenBotError } from "./errors";
import { libraryRevisionDigest } from "./library-repository";

const repositories: AppRepository[] = [];
const directories: string[] = [];
function repository(filename = ":memory:"): AppRepository {
  const value = new AppRepository(filename);
  repositories.push(value);
  return value;
}
function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "aevoren-library-repository-"));
  directories.push(directory);
  return join(directory, "test.sqlite");
}
function close(value: AppRepository): void {
  value.close();
  repositories.splice(repositories.indexOf(value), 1);
}
function expectCode(operation: () => unknown, code: string): void {
  expect(operation).toThrowError(expect.objectContaining({ code }));
}

afterEach(() => {
  for (const value of repositories.splice(0)) value.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("persistent conversation resource library", () => {
  it("requires explicit bindings across private chats and Room sessions", () => {
    const value = repository();
    const first = value.createBot();
    const second = value.createBot();
    const room = value.createRoom({ memberBotIds: [first.bot.id, second.bot.id] });
    const document = value.library.create({ sessionId: first.session.id, kind: "document", name: "Private brief", body: "PRIVATE_MARKER" }, first.bot.id);
    expect(value.library.list({ sessionId: second.session.id })).toEqual([]);
    expect(value.library.list({ sessionId: room.session.id })).toEqual([]);
    expectCode(() => value.library.read({ sessionId: second.session.id, id: document.resource.id }), "LIBRARY_NOT_BOUND");
    expectCode(() => value.library.resolveReferences(room.session.id, [document.reference], first.bot.id), "LIBRARY_NOT_BOUND");
    expect(value.library.available()).toEqual([document.resource]);
    expect(value.library.available()[0]).not.toHaveProperty("body");
    const grant = value.library.bind({ sessionId: room.session.id, id: document.resource.id });
    expect(grant.sessionId).toBe(room.session.id);
    expect(value.library.read({ sessionId: room.session.id, id: document.resource.id }, second.bot.id).revision.body).toBe("PRIVATE_MARKER");
    expectCode(() => value.library.read({ sessionId: first.session.id, id: document.resource.id }, second.bot.id), "INVALID_REQUEST");
  });

  it("lets all six current members read an explicit Room binding without private grant inheritance", () => {
    const value = repository();
    const members = Array.from({ length: 6 }, () => value.createBot());
    const room = value.createRoom({ memberBotIds: members.map((member) => member.bot.id) });
    const document = value.library.create({ sessionId: room.session.id, kind: "document", name: "Shared brief", body: "ROOM_SHARED" });
    const results = members.map((member) => value.library.resolveReferences(room.session.id, [document.reference], member.bot.id));
    expect(results).toHaveLength(6);
    for (const contents of results) expect(contents[0]?.reference).toEqual(document.reference);
    for (const member of members) expect(value.library.list({ sessionId: member.session.id })).toEqual([]);
    const outsider = value.createBot();
    expectCode(() => value.library.read({ sessionId: room.session.id, id: document.resource.id }, outsider.bot.id), "INVALID_REQUEST");
  });

  it("pins display metadata, body and file manifests while edits create new revisions", () => {
    const value = repository();
    const { session } = value.createBot();
    const file = { relativePath: "references/source.txt", size: 12, mimeType: "text/plain", sha256: "a".repeat(64) };
    const first = value.library.create({ sessionId: session.id, kind: "skill", name: "Original", description: "v1", body: "BODY_V1", files: [file] });
    const second = value.library.update({ sessionId: session.id, id: first.resource.id, expectedVersion: 1, name: "Renamed", description: "v2", body: "BODY_V2" });
    expect(second.resource.version).toBe(2);
    expect(second.revision.number).toBe(2);
    expect(second.reference.digest).not.toBe(first.reference.digest);
    const pinned = value.library.resolveReferences(session.id, [first.reference])[0];
    expect(pinned?.revision).toEqual(first.revision);
    expect(pinned?.resource.name).toBe("Renamed");
    expect(second.revision.files).toEqual([file]);
    const summaries = value.library.versions({ sessionId: session.id, id: first.resource.id });
    expect(summaries.map((item) => item.number)).toEqual([2, 1]);
    expect(summaries[0]).not.toHaveProperty("body");
    expect(summaries[0]).not.toHaveProperty("files");
    expect(summaries[0]?.fileCount).toBe(1);
  });

  it("rejects stale saves and preserves both current content and the caller's draft", () => {
    const value = repository();
    const { session } = value.createBot();
    const first = value.library.create({ sessionId: session.id, kind: "document", name: "Notes", body: "Original" });
    const saved = value.library.update({ sessionId: session.id, id: first.resource.id, expectedVersion: 1, body: "Other editor" });
    const draft = { sessionId: session.id, id: first.resource.id, expectedVersion: 1, body: "My unsaved draft" };
    expectCode(() => value.library.update(draft), "LIBRARY_VERSION_CONFLICT");
    expect(draft.body).toBe("My unsaved draft");
    expect(value.library.read({ sessionId: session.id, id: first.resource.id })).toEqual(saved);
    try { value.library.update(draft); } catch (error) {
      expect((error as AevorenBotError).toAppError().details).toEqual({ currentVersion: 2 });
    }
  });

  it("restores a prior version by making another immutable revision", () => {
    const value = repository();
    const { session } = value.createBot();
    const first = value.library.create({ sessionId: session.id, kind: "document", name: "First", body: "version 1" });
    const second = value.library.update({ sessionId: session.id, id: first.resource.id, expectedVersion: 1, body: "version 2", name: "Second" });
    const restored = value.library.restoreVersion({ sessionId: session.id, id: first.resource.id, expectedVersion: second.resource.version, revisionId: first.revision.id });
    expect(restored.revision).toMatchObject({ name: "First", body: "version 1", number: 3, digest: first.revision.digest });
    expect(restored.revision.id).not.toBe(first.revision.id);
    expect(value.library.read({ sessionId: session.id, id: first.resource.id, revisionId: second.revision.id }).revision.body).toBe("version 2");
  });

  it("immediately blocks loads when disabled, deleted or unbound and retains old revisions for recovery", () => {
    const value = repository();
    const { session } = value.createBot();
    const document = value.library.create({ sessionId: session.id, kind: "skill", name: "Writer", body: "SKILL_BODY" });
    const disabled = value.library.setEnabled({ sessionId: session.id, id: document.resource.id, expectedVersion: 1, enabled: false });
    expect(value.library.list({ sessionId: session.id })).toEqual([]);
    expectCode(() => value.library.resolveReferences(session.id, [document.reference]), "LIBRARY_DISABLED");
    expect(value.library.read({ sessionId: session.id, id: document.resource.id, includeDisabled: true }).revision).toEqual(document.revision);
    const enabled = value.library.setEnabled({ sessionId: session.id, id: document.resource.id, expectedVersion: disabled.version, enabled: true });
    const deleted = value.library.delete({ sessionId: session.id, id: document.resource.id, expectedVersion: enabled.version });
    expectCode(() => value.library.resolveReferences(session.id, [document.reference]), "LIBRARY_NOT_FOUND");
    expect(value.library.list({ sessionId: session.id, includeDeleted: true })[0]?.deletedAt).toBeTruthy();
    const restored = value.library.restore({ sessionId: session.id, id: document.resource.id, expectedVersion: deleted.version });
    expect(restored.currentRevisionId).toBe(document.revision.id);
    expect(value.library.resolveReferences(session.id, [document.reference])[0]?.revision.body).toBe("SKILL_BODY");
    expect(value.library.unbind({ sessionId: session.id, id: document.resource.id })).toBe(true);
    expect(value.library.unbind({ sessionId: session.id, id: document.resource.id })).toBe(false);
    expectCode(() => value.library.read({ sessionId: session.id, id: document.resource.id }), "LIBRARY_NOT_BOUND");
    const rebound = value.library.bind({ sessionId: session.id, id: document.resource.id });
    expect(rebound.version).toBeGreaterThan(1);
    expect(value.library.resolveReferences(session.id, [document.reference])).toHaveLength(1);
  });

  it("rejects another resource's revision and incomplete or forged reference digests", () => {
    const value = repository();
    const { session } = value.createBot();
    const first = value.library.create({ sessionId: session.id, kind: "document", name: "First", body: "A" });
    const second = value.library.create({ sessionId: session.id, kind: "document", name: "Second", body: "B" });
    expectCode(() => value.library.resolveReferences(session.id, [{ ...first.reference, revisionId: second.revision.id }]), "LIBRARY_REFERENCE_INVALID");
    expectCode(() => value.library.resolveReferences(session.id, [{ ...first.reference, digest: "b".repeat(64) }]), "LIBRARY_REFERENCE_INVALID");
    expect(resourceReferencesSchema.safeParse([{ ...first.reference, digest: first.reference.digest.slice(0, 12) }]).success).toBe(false);
    expect(resourceReferencesSchema.safeParse([first.reference, first.reference]).success).toBe(false);
    expect(resourceReferencesSchema.safeParse(Array.from({ length: 21 }, () => ({ ...first.reference, resourceId: randomUUID() }))).success).toBe(false);
  });

  it("lets the user rebind inactive resources for recovery while denying AI binding and default reads", () => {
    const value = repository();
    const first = value.createBot();
    const second = value.createBot();
    const disabled = value.library.create({ sessionId: first.session.id, kind: "skill", name: "Disabled", body: "instructions" });
    const inactive = value.library.setEnabled({ sessionId: first.session.id, id: disabled.resource.id, expectedVersion: 1, enabled: false });
    value.library.unbind({ sessionId: first.session.id, id: inactive.id });
    expectCode(() => value.library.bind({ sessionId: second.session.id, id: inactive.id }, second.bot.id), "LIBRARY_DISABLED");
    value.library.bind({ sessionId: second.session.id, id: inactive.id });
    expectCode(() => value.library.read({ sessionId: second.session.id, id: inactive.id }), "LIBRARY_DISABLED");
    expect(value.library.read({ sessionId: second.session.id, id: inactive.id, includeDisabled: true }).revision.body).toBe("instructions");
    const enabled = value.library.setEnabled({ sessionId: second.session.id, id: inactive.id, expectedVersion: inactive.version, enabled: true });
    const deleted = value.library.delete({ sessionId: second.session.id, id: inactive.id, expectedVersion: enabled.version });
    value.library.unbind({ sessionId: second.session.id, id: inactive.id });
    expectCode(() => value.library.bind({ sessionId: first.session.id, id: inactive.id }, first.bot.id), "LIBRARY_NOT_FOUND");
    value.library.bind({ sessionId: first.session.id, id: inactive.id });
    expectCode(() => value.library.read({ sessionId: first.session.id, id: inactive.id }), "LIBRARY_NOT_FOUND");
    expect(value.library.read({ sessionId: first.session.id, id: inactive.id, includeDeleted: true }).resource.deletedAt).toBeTruthy();
    value.library.restore({ sessionId: first.session.id, id: inactive.id, expectedVersion: deleted.version });
    expect(value.library.resolveReferences(first.session.id, [disabled.reference])[0]?.revision.body).toBe("instructions");
  });

  it("searches current bound text in English and Chinese without exposing other chats' bodies", () => {
    const value = repository();
    const first = value.createBot();
    const second = value.createBot();
    const own = value.library.create({ sessionId: first.session.id, kind: "document", name: "Brief", body: "English keywords and 自媒体选题策略" });
    value.library.create({ sessionId: second.session.id, kind: "document", name: "Other", body: "English PRIVATE_CANARY" });
    expect(value.library.list({ sessionId: first.session.id, query: "keyword" }).map((item) => item.id)).toEqual([own.resource.id]);
    expect(value.library.list({ sessionId: first.session.id, query: "选题" }).map((item) => item.id)).toEqual([own.resource.id]);
    expect(value.library.list({ sessionId: first.session.id, query: "PRIVATE_CANARY" })).toEqual([]);
    expect(value.library.available({ query: "PRIVATE_CANARY" })).toEqual([]);
    value.library.update({ sessionId: first.session.id, id: own.resource.id, expectedVersion: 1, body: "Replacement" });
    expect(value.library.list({ sessionId: first.session.id, query: "keywords" })).toEqual([]);
    expect(value.library.list({ sessionId: first.session.id, query: '" OR * NOT (' })).toEqual([]);
  });

  it("rolls back the entire import and joins an outer receipt transaction without committing it", () => {
    const value = repository();
    const { session } = value.createBot();
    expect(() => value.library.createMany([
      { sessionId: session.id, kind: "document", name: "Good", body: "valid" },
      { sessionId: session.id, kind: "document", name: "", body: "invalid" },
    ])).toThrow();
    expect(value.library.available()).toEqual([]);
    expect(() => value.library.transaction(() => {
      value.library.createMany([{ sessionId: session.id, kind: "document", name: "Receipt rollback", body: "valid" }]);
      throw new Error("receipt persistence rejected");
    })).toThrow("receipt persistence rejected");
    expect(value.library.available()).toEqual([]);
    expect(value.library.createMany([
      { sessionId: session.id, kind: "document", name: "One", body: "one" },
      { sessionId: session.id, kind: "document", name: "Two", body: "two" },
    ])).toHaveLength(2);
  });

  it("persists revisions and bindings through a real SQLite close and reopen", () => {
    const filename = temporaryDatabase();
    const first = repository(filename);
    const { session } = first.createBot();
    const original = first.library.create({ sessionId: session.id, kind: "document", name: "Persistent", body: "disk content" });
    const edited = first.library.update({ sessionId: session.id, id: original.resource.id, expectedVersion: 1, body: "disk updated" });
    close(first);
    const reopened = repository(filename);
    expect(reopened.library.read({ sessionId: session.id, id: original.resource.id })).toEqual(edited);
    expect(reopened.library.resolveReferences(session.id, [original.reference])[0]?.revision).toEqual(original.revision);
  });

  it("detects persisted content tampering instead of trusting a stored digest", () => {
    const filename = temporaryDatabase();
    const value = repository(filename);
    const { session } = value.createBot();
    const document = value.library.create({ sessionId: session.id, kind: "document", name: "Checked", body: "untampered" });
    close(value);
    const raw = new DatabaseSync(filename);
    raw.prepare("UPDATE library_revisions SET body=? WHERE id=?").run("tampered", document.revision.id);
    raw.close();
    const reopened = repository(filename);
    expectCode(() => reopened.library.read({ sessionId: session.id, id: document.resource.id }), "LIBRARY_REFERENCE_INVALID");
  });

  it("upgrades v33 without altering old chats or attachments and adds no inherited bindings", () => {
    const filename = temporaryDatabase();
    const seed = repository();
    const created = seed.createBot();
    const nonce = randomUUID();
    const attachmentBody = "# Existing attachment";
    seed.prepareMessage({ sessionId: created.session.id, clientNonce: nonce, text: "Old conversation", attachments: [{
      id: randomUUID(), name: "old.md", mimeType: "text/markdown", kind: "text", content: attachmentBody,
      size: Buffer.byteLength(attachmentBody), sha256: createHash("sha256").update(attachmentBody).digest("hex"),
    }] });
    seed.createMemory(created.bot.id, "Existing memory");
    seed.createRuntimeRun(nonce, "fake", { schemaVersion: 1, botId: created.bot.id, profileVersion: 1,
      sessionId: created.session.id, generation: 1, inputSeq: 1, blocks: [], digest: "old-prompt" });
    const source = Reflect.get(seed, "database") as DatabaseSync;
    const raw = new DatabaseSync(filename);
    raw.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
    for (const migration of MIGRATIONS.filter((candidate) => candidate.version <= 33)) {
      raw.exec(migration.sql);
      raw.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(migration.version, "2026-10-01T00:00:00.000Z");
    }
    const tables = ["bots", "sessions", "conversation_metadata", "conversation_scope_versions", "transcript_entries", "send_journal", "message_attachments", "memory_items", "runtime_runs"];
    for (const table of tables) {
      const columns = (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name);
      for (const row of source.prepare(`SELECT ${columns.join(",")} FROM ${table}`).all() as Record<string, string | number | null>[]) {
        raw.prepare(`INSERT OR REPLACE INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...columns.map((column) => row[column]!));
      }
    }
    const snapshot = (database: DatabaseSync): string => JSON.stringify(Object.fromEntries(tables.map((table) => {
      const info = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string; pk: number }[];
      const columns = info.map((column) => column.name).filter((name) => name !== "resource_references_json");
      const keys = info.filter((column) => column.pk).toSorted((a, b) => a.pk - b.pk).map((column) => column.name);
      return [table, database.prepare(`SELECT ${columns.join(",")} FROM ${table} ORDER BY ${keys.join(",")}`).all()];
    })));
    const before = createHash("sha256").update(snapshot(raw)).digest("hex");
    raw.close();
    const value = repository(filename);
    expect(value.library.available()).toEqual([]);
    close(value);
    const verified = new DatabaseSync(filename);
    const after = createHash("sha256").update(snapshot(verified)).digest("hex");
    expect(after).toBe(before);
    expect(verified.prepare("SELECT version FROM schema_migrations WHERE version = 34").get()).toEqual({ version: 34 });
    expect(verified.prepare("SELECT * FROM session_resource_bindings").all()).toEqual([]);
    expect((verified.prepare("PRAGMA table_info(transcript_entries)").all() as { name: string }[]).some((column) => column.name === "resource_references_json")).toBe(true);
    verified.close();
  });
});

describe("library file and reference validation", () => {
  it("computes one digest regardless of file enumeration order", () => {
    const a = { relativePath: "references/a.txt", size: 1, mimeType: "text/plain", sha256: "a".repeat(64) };
    const b = { relativePath: "assets/b.png", size: 2, mimeType: "image/png", sha256: "b".repeat(64) };
    expect(libraryRevisionDigest("skill", "Skill", "", "Instructions", [a, b]))
      .toBe(libraryRevisionDigest("skill", "Skill", "", "Instructions", [b, a]));
    expect(libraryRevisionDigest("skill", "Changed", "", "Instructions", [a, b]))
      .not.toBe(libraryRevisionDigest("skill", "Skill", "", "Instructions", [a, b]));
  });

  it.each(["../secret", "/etc/passwd", "a/../b", "C:/secret", "a\\b", "a//b", "./b", "a\u0000b", "a/file:stream", "assets/CON.txt", "a/trailing."])("rejects unsafe stored path %s", (relativePath) => {
    expect(resourceFilesSchema.safeParse([{ relativePath, size: 1, mimeType: "text/plain", sha256: "a".repeat(64) }]).success).toBe(false);
  });

  it("rejects duplicate manifests and text exceeding the UTF-8 byte bound", () => {
    const file = { relativePath: "a.txt", size: 1, mimeType: "text/plain", sha256: "a".repeat(64) };
    expect(resourceFilesSchema.safeParse([file, file]).success).toBe(false);
    const value = repository();
    const { session } = value.createBot();
    expect(() => value.library.create({ sessionId: session.id, kind: "document", name: "Too large", body: "字".repeat(350_000) })).toThrow();
    expect(value.library.available()).toEqual([]);
  });
});
