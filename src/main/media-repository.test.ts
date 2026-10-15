import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { MessageMediaReference } from "@shared/media-contracts";
import type { PromptManifest } from "@shared/contracts";
import { AppRepository, digestMessage, digestRoomCommand, MIGRATIONS } from "./database";
import { mediaExtractionDigest, type StoredMediaImport } from "./media-repository";

const repositories: AppRepository[] = [], directories: string[] = [];
function fixture(filename = ":memory:") { const repository = new AppRepository(filename); repositories.push(repository); return { repository, ...repository.createBot() }; }
function content(text = "PRIVATE_EXTRACTION"): StoredMediaImport {
  const id = randomUUID(), sourceSha256 = createHash("sha256").update(text).digest("hex"), parsed = { sourceSha256, parserName: "fixture", parserVersion: "1", text,
    spans: [{ kind: "page" as const, index: 0, start: 0, end: text.length }], warningCodes: [] };
  return { asset: { reference: { id, name: "document.pdf", mimeType: "application/pdf", sha256: sourceSha256, size: 30 }, kind: "pdf", width: null, height: null },
    extraction: { id: randomUUID(), mediaId: id, ...parsed, digest: mediaExtractionDigest(parsed) } };
}
function start(f: ReturnType<typeof fixture>, refs: MessageMediaReference[] = [], nonce: string = randomUUID()) {
  f.repository.prepareMessage({ sessionId: f.session.id, clientNonce: nonce, text: refs.length ? "" : "Task", mediaRefs: refs });
  const input = f.repository.getUserMessage(nonce), manifest: PromptManifest = { schemaVersion: 1, botId: f.bot.id, profileVersion: 1, sessionId: f.session.id,
    generation: input.generation, inputSeq: input.seq, blocks: [], digest: "media-fixture" };
  const runtime = f.repository.createRuntimeRun(nonce, "fake", manifest);
  return { runtime, scope: { sessionId: f.session.id, executorBotId: f.bot.id, runtimeRunId: runtime.id } };
}
afterEach(() => { for (const repository of repositories.splice(0)) repository.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("media records and fixed Runtime admissions in real SQLite", () => {
  it("keeps metadata reusable while text, bytes and binding incarnations remain private and scoped", () => {
    const f = fixture(), other = f.repository.createBot(), imported = f.repository.media.publishImport(f.session.id, [content()])[0]!;
    expect(f.repository.media.available()).toEqual([imported]);
    expect(JSON.stringify(f.repository.media.available())).not.toContain("PRIVATE_EXTRACTION");
    expect(JSON.stringify(f.repository.media.available())).not.toContain("incarnation");
    expect(() => f.repository.media.captureUiLease({ sessionId: other.session.id, id: imported.asset.reference.id })).toThrowError(expect.objectContaining({ code: "MEDIA_NOT_GRANTED" }));
    const lease = f.repository.media.captureUiLease({ sessionId: f.session.id, id: imported.asset.reference.id });
    expect(f.repository.media.resolveUiLease(lease).extraction?.text).toBe("PRIVATE_EXTRACTION");
    f.repository.media.bind({ sessionId: other.session.id, id: imported.asset.reference.id });
    expect(f.repository.media.metadata({ sessionId: other.session.id, id: imported.asset.reference.id })).toEqual(imported);
  });
  it("records an empty snapshot once and binding existing media cannot admit it to that Runtime", () => {
    const f = fixture(), active = start(f), existing = f.repository.media.publishImport(f.session.id, [content()])[0]!;
    f.repository.media.unbind({ sessionId: f.session.id, id: existing.asset.reference.id });
    f.repository.media.bind({ sessionId: f.session.id, id: existing.asset.reference.id });
    expect(f.repository.media.listRuntimeItems(active.scope)).toEqual([]);
    expect(() => f.repository.media.resolveRuntimeRead(active.scope, existing.asset.reference.id)).toThrowError(expect.objectContaining({ code: "MEDIA_NOT_GRANTED" }));
    const newlyImported = f.repository.media.publishImport(f.session.id, [content("NEW_APPROVED_IMPORT")], f.bot.id, active.runtime.id)[0]!;
    expect(f.repository.media.resolveRuntimeRead(active.scope, newlyImported.asset.reference.id).extraction?.text).toBe("NEW_APPROVED_IMPORT");
    expect(f.repository.media.listRuntimeItems(active.scope).map(item => item.asset.reference.id)).toEqual([newlyImported.asset.reference.id]);
  });
  it("pins original send admissions on retry even after unbind/rebind and detects changed references for one nonce", () => {
    const f = fixture(), item = f.repository.media.publishImport(f.session.id, [content()])[0]!, original = start(f, [item.reference]);
    expect(() => f.repository.media.resolveRuntimeRead(original.scope, item.asset.reference.id, { mediaId: item.reference.mediaId, sha256: item.reference.sha256 })).toThrowError(expect.objectContaining({ code: "MEDIA_REFERENCE_INVALID" }));
    expect(f.repository.getUserMessage(original.runtime.clientNonce).mediaRefs).toEqual([item.reference]);
    expect(f.repository.listPromptEntries(f.session.id).at(-1)?.mediaRefs).toEqual([item.reference]);
    expect(f.repository.getConversation(f.session.id).lastMessage).toBe("[媒体]");
    expect(() => f.repository.prepareMessage({ sessionId: f.session.id, clientNonce: original.runtime.clientNonce, text: "", mediaRefs: [{ ...item.reference, extraction: { ...item.reference.extraction!, digest: "f".repeat(64) } }] }))
      .toThrowError(expect.objectContaining({ code: "MESSAGE_NONCE_CONFLICT" }));
    f.repository.media.unbind({ sessionId: f.session.id, id: item.asset.reference.id });
    f.repository.media.bind({ sessionId: f.session.id, id: item.asset.reference.id });
    expect(() => f.repository.media.resolveRuntimeRead(original.scope, item.asset.reference.id)).toThrowError(expect.objectContaining({ code: "MEDIA_NOT_GRANTED" }));
    f.repository.transitionRuntimeRun(original.runtime.id, "failed");
    const retry = start(f, [item.reference], original.runtime.clientNonce);
    expect(() => f.repository.media.resolveRuntimeRead(retry.scope, item.asset.reference.id)).toThrowError(expect.objectContaining({ code: "MEDIA_NOT_GRANTED" }));
    expect(digestMessage("legacy")).toBe(createHash("sha256").update("legacy").digest("hex"));
    expect(digestMessage("legacy", [], [])).toBe(digestMessage("legacy", [], [], []));
    expect(digestRoomCommand("room", "session", "legacy", ["b", "a"])).toBe(digestRoomCommand("room", "session", "legacy", ["b", "a"], "legacy", [], [], []));
  });
  it("rotates authorization across disable/enable and delete/restore without rewriting immutable extraction", () => {
    const f = fixture(), item = f.repository.media.publishImport(f.session.id, [content()])[0]!, lease = f.repository.media.captureUiLease({ sessionId: f.session.id, id: item.asset.reference.id });
    let current = f.repository.media.mutate({ sessionId: f.session.id, id: item.asset.reference.id, expectedVersion: 1 }, "enabled", false);
    expect(() => f.repository.media.mutate({ sessionId: f.session.id, id: current.reference.id, expectedVersion: 1 }, "enabled", true)).toThrowError(expect.objectContaining({ code: "MEDIA_VERSION_CONFLICT" }));
    current = f.repository.media.mutate({ sessionId: f.session.id, id: current.reference.id, expectedVersion: current.version }, "enabled", true);
    expect(() => f.repository.media.resolveUiLease(lease)).toThrowError(expect.objectContaining({ code: "MEDIA_NOT_GRANTED" }));
    const second = f.repository.media.captureUiLease({ sessionId: f.session.id, id: current.reference.id });
    current = f.repository.media.mutate({ sessionId: f.session.id, id: current.reference.id, expectedVersion: current.version }, "deleted");
    current = f.repository.media.mutate({ sessionId: f.session.id, id: current.reference.id, expectedVersion: current.version }, "restored");
    expect(() => f.repository.media.resolveUiLease(second)).toThrowError(expect.objectContaining({ code: "MEDIA_NOT_GRANTED" }));
    const fresh = f.repository.media.captureUiLease({ sessionId: f.session.id, id: current.reference.id });
    expect(f.repository.media.resolveUiLease(fresh).item.reference).toEqual(item.reference);
  });
  it("does not revive a removed member's in-memory lease after re-add or revoke another member's lease", () => {
    const f = fixture(), others = Array.from({ length: 2 }, () => f.repository.createBot()), detail = f.repository.createRoom({ memberBotIds: [f.bot.id, ...others.map(value => value.bot.id)] });
    const item = f.repository.media.publishImport(detail.session.id, [content("MEMBER_SCOPE")])[0]!, input = { sessionId: detail.session.id, id: item.asset.reference.id };
    const retired = f.repository.media.captureUiLease(input, f.bot.id), sibling = f.repository.media.captureUiLease(input, others[0]!.bot.id);
    const removed = f.repository.removeRoomMember(detail.room.id, f.bot.id, detail.room.membershipVersion);
    f.repository.addRoomMember(detail.room.id, f.bot.id, removed.room.membershipVersion);
    expect(() => f.repository.media.resolveUiLease(retired)).toThrowError(expect.objectContaining({ code: "MEDIA_NOT_GRANTED" }));
    expect(f.repository.media.resolveUiLease(sibling).extraction?.text).toBe("MEMBER_SCOPE");
    expect(f.repository.media.resolveUiLease(f.repository.media.captureUiLease(input, f.bot.id)).item.reference).toEqual(item.reference);
  });
  it("publishes one set atomically and does not reuse an existing record for approved import admission", () => {
    const f = fixture(), active = start(f), old = content(), original = f.repository.media.publishImport(f.session.id, [old])[0]!, next = content("PENDING_VALID");
    expect(() => f.repository.media.publishImport(f.session.id, [next, old], f.bot.id, active.runtime.id)).toThrow();
    expect(f.repository.media.available()).toEqual([original]); expect(f.repository.media.listRuntimeItems(active.scope)).toEqual([]);
  });
  it("admits six independent everyone Runtimes from the root message and cancels only one", () => {
    const f = fixture(), members = [f.bot, ...Array.from({ length: 5 }, () => f.repository.createBot().bot)];
    const detail = f.repository.createRoom({ memberBotIds: members.map(bot => bot.id) }), item = f.repository.media.publishImport(detail.session.id, [content("GROUP_ONLY")])[0]!;
    const nonce = randomUUID(), prepared = f.repository.createRoomRunWithInitialTurns({ roomId: detail.room.id, sessionId: detail.session.id, clientNonce: nonce, text: "", mediaRefs: [item.reference],
      membershipVersion: detail.room.membershipVersion, maxTurns: 6, maxHops: 0, maxTargetsPerTurn: 6, deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      initialTurns: members.map(bot => ({ agentId: bot.id, nonce: randomUUID() })), routingMode: "everyone", orchestrationEnabled: false });
    f.repository.transitionRoomBatch(prepared.run.id, "running");
    const scopes = prepared.turns.map(original => {
      const turn = f.repository.transitionRoomTurn(original.id, "running", { promptCutoffSeq: original.inputSeq });
      const manifest: PromptManifest = { schemaVersion: 2, botId: turn.memberBotId, profileVersion: 1, sessionId: detail.session.id, generation: turn.inputGeneration,
        inputSeq: turn.inputSeq, promptCutoffSeq: turn.inputSeq, roomId: detail.room.id, roomMembershipVersion: prepared.run.membershipVersion, executorBotId: turn.memberBotId, sourceTurnId: turn.id, blocks: [], digest: "media-six" };
      const runtime = f.repository.createRuntimeRun(nonce, "fake", manifest, { executorBotId: turn.memberBotId, executionKey: `${prepared.run.id}:${turn.logicalTurnId}` });
      f.repository.attachRoomTurnRuntime(turn.id, runtime.id); return { sessionId: detail.session.id, executorBotId: turn.memberBotId, runtimeRunId: runtime.id };
    });
    expect(scopes).toHaveLength(6);
    for (const scope of scopes) expect(f.repository.media.resolveRuntimeRead(scope, item.asset.reference.id).extraction?.text).toBe("GROUP_ONLY");
    f.repository.transitionRuntimeRun(scopes[0]!.runtimeRunId, "cancel-requested");
    expect(() => f.repository.media.resolveRuntimeRead(scopes[0]!, item.asset.reference.id)).toThrow();
    for (const scope of scopes.slice(1)) expect(f.repository.media.resolveRuntimeRead(scope, item.asset.reference.id).item.reference).toEqual(item.reference);
    expect(f.repository.media.list({ sessionId: f.session.id })).toEqual([]);
  });
  it("upgrades a real v41 database with content, Memory, attachments and Runtime intact and backs it up", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-media-migration-")); directories.push(directory);
    const filename = join(directory, "old.sqlite"), seed = fixture(), nonce = randomUUID(), body = "old attachment";
    seed.repository.prepareMessage({ sessionId: seed.session.id, clientNonce: nonce, text: "OLD_MESSAGE", attachments: [{ id: randomUUID(), name: "old.txt", size: Buffer.byteLength(body), mimeType: "text/plain", sha256: createHash("sha256").update(body).digest("hex"), kind: "text", content: body }] });
    seed.repository.createMemory(seed.bot.id, "OLD_MEMORY");
    seed.repository.library.create({ sessionId: seed.session.id, kind: "document", name: "old", body: "OLD_LIBRARY" });
    seed.repository.createRuntimeRun(nonce, "fake", { schemaVersion: 1, botId: seed.bot.id, profileVersion: 1, sessionId: seed.session.id, generation: 1, inputSeq: 1, blocks: [], digest: "old" });
    const raw = new DatabaseSync(filename); raw.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)");
    for (const migration of MIGRATIONS.filter(value => value.version <= 41)) {
      raw.exec("BEGIN"); raw.exec(migration.sql); raw.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(migration.version, "2026-10-01T00:00:00Z"); raw.exec("COMMIT");
    }
    const source = Reflect.get(seed.repository, "database") as DatabaseSync;
    const tables = ["bots", "sessions", "conversation_metadata", "conversation_scope_versions", "send_journal", "transcript_entries", "message_attachments", "memory_items", "runtime_runs", "library_resources", "library_revisions", "session_resource_bindings"];
    const columns = new Map(tables.map(table => [table, (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(value => value.name)]));
    raw.exec("BEGIN; PRAGMA defer_foreign_keys=ON");
    for (const table of tables) { const names = columns.get(table)!; for (const row of source.prepare(`SELECT ${names.join(",")} FROM ${table}`).all())
      raw.prepare(`INSERT OR REPLACE INTO ${table}(${names.join(",")}) VALUES(${names.map(() => "?").join(",")})`).run(...names.map(name => row[name]!)); }
    const snapshot = (db: DatabaseSync) => JSON.stringify(tables.map(table => db.prepare(`SELECT ${columns.get(table)!.join(",")} FROM ${table} ORDER BY rowid`).all()));
    raw.exec("COMMIT");
    const before = snapshot(raw); raw.close();
    const upgraded = new AppRepository(filename); repositories.push(upgraded);
    const db = Reflect.get(upgraded, "database") as DatabaseSync;
    expect(snapshot(db)).toBe(before); expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version=42").get()).toMatchObject({ version: 42 });
    expect(db.prepare("SELECT * FROM runtime_media_snapshots").all()).toEqual([]);
    expect(upgraded.media.available()).toEqual([]);
    const item = upgraded.media.publishImport(seed.session.id, [content("AFTER_UPGRADE")])[0]!;
    const legacyRun = upgraded.listRuntimeRuns(seed.session.id)[0]!;
    expect(() => upgraded.media.resolveRuntimeRead({ sessionId: seed.session.id, executorBotId: seed.bot.id, runtimeRunId: legacyRun.id }, item.asset.reference.id)).toThrowError(expect.objectContaining({ code: "MEDIA_NOT_GRANTED" }));
    expect(readdirSync(join(directory, "Backups")).some(name => name.endsWith(".sqlite"))).toBe(true);
  });
});
