import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AppRepository } from "./database";
import { LibraryBlobStore } from "./library-blob-store";

const fixtures: { repository: AppRepository; root: string }[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aevoren-library-delete-"));
  const repository = new AppRepository(join(root, "app.sqlite"));
  fixtures.push({ repository, root });
  const database = Reflect.get(repository, "database") as DatabaseSync;
  return { repository, database, blobs: new LibraryBlobStore(join(root, "owned")) };
}
function resourceSnapshot(database: DatabaseSync): unknown {
  return {
    resources: database.prepare("SELECT * FROM library_resources ORDER BY id").all(),
    revisions: database.prepare("SELECT * FROM library_revisions ORDER BY id").all(),
    search: database.prepare("SELECT * FROM library_fts ORDER BY resource_id").all(),
  };
}
afterEach(() => {
  for (const { repository, root } of fixtures.splice(0)) {
    repository.close();
    rmSync(root, { recursive: true, force: true });
  }
});

describe("deleting conversations with resource bindings", () => {
  it("deletes a Bot's active and revoked bindings while retaining shared versions, bytes and another private chat", async () => {
    const { repository, database, blobs } = fixture();
    const deleted = repository.createBot();
    const survivor = repository.createBot();
    const shared = repository.library.create({ sessionId: deleted.session.id, kind: "document", name: "Shared document", body: "original" });
    const edited = repository.library.update({ sessionId: deleted.session.id, id: shared.resource.id, expectedVersion: 1, body: "current" });
    repository.library.bind({ sessionId: survivor.session.id, id: shared.resource.id });
    const privateDocument = repository.library.create({ sessionId: deleted.session.id, kind: "document", name: "Detached private document", body: "retained private content" });
    repository.library.unbind({ sessionId: deleted.session.id, id: privateDocument.resource.id });
    const bytes = Buffer.from([0, 255, 80, 78, 71]);
    const sha256 = await blobs.put(bytes);
    const skill = repository.library.create({ sessionId: deleted.session.id, kind: "skill", name: "Shared package", body: "read references", files: [{ relativePath: "assets/source.png", size: bytes.length, mimeType: "image/png", sha256 }] });
    repository.library.bind({ sessionId: survivor.session.id, id: skill.resource.id });
    repository.prepareMessage({ sessionId: survivor.session.id, clientNonce: crypto.randomUUID(), text: "Other chat remains" });
    repository.createMemory(survivor.bot.id, "Other Bot memory remains");
    const unchanged = { bot: repository.getBot(survivor.bot.id), session: repository.getSession(survivor.session.id), entries: repository.listTranscript(survivor.session.id), memory: repository.listMemories(survivor.bot.id) };
    const resourcesBefore = resourceSnapshot(database);
    const survivorBindings = database.prepare("SELECT * FROM session_resource_bindings WHERE session_id = ? ORDER BY resource_id").all(survivor.session.id);
    expect(database.prepare("SELECT revoked_at FROM session_resource_bindings WHERE session_id = ? AND resource_id = ?").get(deleted.session.id, privateDocument.resource.id)).toMatchObject({ revoked_at: expect.any(String) });

    repository.deleteBot(deleted.bot.id);

    expect(() => repository.getSession(deleted.session.id)).toThrowError(expect.objectContaining({ code: "SESSION_NOT_FOUND" }));
    expect(database.prepare("SELECT * FROM session_resource_bindings WHERE session_id = ?").all(deleted.session.id)).toEqual([]);
    expect(database.prepare("SELECT * FROM session_resource_bindings WHERE session_id = ? ORDER BY resource_id").all(survivor.session.id)).toEqual(survivorBindings);
    expect(repository.library.read({ sessionId: survivor.session.id, id: shared.resource.id })).toEqual(edited);
    expect(repository.library.read({ sessionId: survivor.session.id, id: shared.resource.id, revisionId: shared.revision.id }).revision).toEqual(shared.revision);
    expect(repository.library.read({ sessionId: survivor.session.id, id: skill.resource.id }).revision.files).toEqual(skill.revision.files);
    expect(await blobs.read(sha256, bytes.length)).toEqual(bytes);
    expect(resourceSnapshot(database)).toEqual(resourcesBefore);
    expect({ bot: repository.getBot(survivor.bot.id), session: repository.getSession(survivor.session.id), entries: repository.listTranscript(survivor.session.id), memory: repository.listMemories(survivor.bot.id) }).toEqual(unchanged);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("deletes Room-session bindings without removing its members or another Room's grants", () => {
    const { repository, database } = fixture();
    const first = repository.createBot();
    const second = repository.createBot();
    const deleted = repository.createRoom({ memberBotIds: [first.bot.id, second.bot.id], name: "Delete this Room" });
    const survivor = repository.createRoom({ memberBotIds: [first.bot.id, second.bot.id], name: "Keep this Room" });
    const shared = repository.library.create({ sessionId: deleted.session.id, kind: "document", name: "Room document", body: "shared room content" });
    repository.library.bind({ sessionId: survivor.session.id, id: shared.resource.id });
    repository.library.bind({ sessionId: first.session.id, id: shared.resource.id });
    const detached = repository.library.create({ sessionId: deleted.session.id, kind: "document", name: "Detached Room document", body: "recoverable" });
    repository.library.unbind({ sessionId: deleted.session.id, id: detached.resource.id });
    repository.prepareMessage({ sessionId: survivor.session.id, clientNonce: crypto.randomUUID(), text: "Other Room history remains" });
    const unchanged = { bots: repository.listBots(), room: repository.getRoomDetail(survivor.room.id), entries: repository.listTranscript(survivor.session.id) };
    const otherBindings = database.prepare("SELECT * FROM session_resource_bindings WHERE session_id <> ? ORDER BY session_id, resource_id").all(deleted.session.id);
    const resourcesBefore = resourceSnapshot(database);

    repository.deleteRoom(deleted.room.id);

    expect(() => repository.getSession(deleted.session.id)).toThrowError(expect.objectContaining({ code: "SESSION_NOT_FOUND" }));
    expect(database.prepare("SELECT * FROM session_resource_bindings WHERE session_id = ?").all(deleted.session.id)).toEqual([]);
    expect(database.prepare("SELECT * FROM session_resource_bindings ORDER BY session_id, resource_id").all()).toEqual(otherBindings);
    expect(repository.library.read({ sessionId: survivor.session.id, id: shared.resource.id }, second.bot.id)).toEqual(shared);
    expect(repository.library.read({ sessionId: first.session.id, id: shared.resource.id }, first.bot.id)).toEqual(shared);
    expect(resourceSnapshot(database)).toEqual(resourcesBefore);
    expect({ bots: repository.listBots(), room: repository.getRoomDetail(survivor.room.id), entries: repository.listTranscript(survivor.session.id) }).toEqual(unchanged);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it.each(["Bot", "Room"])("rolls back %s binding cleanup if deleting its parent fails", (kind) => {
    const { repository, database } = fixture();
    const first = repository.createBot();
    const second = repository.createBot();
    const room = repository.createRoom({ memberBotIds: [first.bot.id, second.bot.id] });
    const sessionId = kind === "Bot" ? first.session.id : room.session.id;
    const content = repository.library.create({ sessionId, kind: "document", name: "Atomic binding", body: "preserve on failure" });
    const before = database.prepare("SELECT * FROM session_resource_bindings ORDER BY session_id, resource_id").all();
    database.exec("CREATE TRIGGER reject_parent_delete BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'parent delete rejected'); END;");

    expect(() => kind === "Bot" ? repository.deleteBot(first.bot.id) : repository.deleteRoom(room.room.id)).toThrow("parent delete rejected");

    expect(database.prepare("SELECT * FROM session_resource_bindings ORDER BY session_id, resource_id").all()).toEqual(before);
    expect(repository.library.read({ sessionId, id: content.resource.id })).toEqual(content);
    expect(repository.getBot(first.bot.id)).toEqual(first.bot);
    expect(repository.getRoomDetail(room.room.id)).toEqual(room);
  });
});
