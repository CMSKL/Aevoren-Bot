import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AppRepository } from "./database";
import { LibraryService } from "./library-service";
import { DemonstrationService } from "./demonstration-service";
import { addDemonstrationProductHandlers } from "./demonstration-product-handlers";
import { DEMONSTRATION_CHANNELS } from "@shared/demonstration-product";
import type { BrowserScope } from "@shared/browser-contracts";
import type { DemonstrationSnapshot } from "@shared/demonstration-contracts";
function snapshot(browserSessionId = randomUUID()): DemonstrationSnapshot { const now = new Date().toISOString(); return { id: randomUUID(), browserSessionId, epoch: 2, state: "interrupted", reason: "disconnect", events: [{ kind: "pointer", x: 23, y: 95, buttons: 1 }, { kind: "redacted-text" }, { kind: "key", key: "Enter", down: true }], eventCount: 3, createdAt: now, updatedAt: now }; }
function fixture() { const root = mkdtempSync(join(tmpdir(), "aevoren-demo-host-")), db = join(root, "app.sqlite"), repository = new AppRepository(db), actor = repository.createBot(), scope = { sessionId: actor.session.id, executorBotId: actor.bot.id }; const library = new LibraryService(repository, join(root, "blobs")); const bridge = vi.fn(async () => null as unknown); const service = new DemonstrationService(repository, { demonstrationRequest: bridge }, library); return { root, db, repository, actor, scope, library, bridge, service, close: () => { repository.close(); rmSync(root, { recursive: true, force: true }); } }; }
describe("reviewable demonstration drafts", () => {
  it("persists sanitized drafts and creates nothing in the library until explicit fixed-version publish", () => {
    const f = fixture(); try {
      const capture = snapshot(), draft = f.repository.demonstrations.create(f.scope, capture); expect(draft.body).toContain("USER INPUT REDACTED"); expect(f.repository.library.list({ sessionId: f.scope.sessionId })).toHaveLength(0);
      const edited = f.service.updateDraft({ ...f.scope, id: draft.id, expectedVersion: 1, name: "Reviewed skill", body: draft.body + "\nReviewed by user." });
      expect(() => f.service.publish({ ...f.scope, id: draft.id, expectedVersion: 1, expectedDigest: draft.digest })).toThrow(expect.objectContaining({ code: "DEMONSTRATION_VERSION_CONFLICT" }));
      expect(() => f.service.updateDraft({ ...f.scope, id: draft.id, expectedVersion: 1, name: "Lost edit", body: "do not overwrite" })).toThrow(expect.objectContaining({ code: "DEMONSTRATION_VERSION_CONFLICT" })); expect(f.service.readDraft({ ...f.scope, id: draft.id }).body).toContain("Reviewed by user");
      const input = { ...f.scope, id: edited.id, expectedVersion: edited.version, expectedDigest: edited.digest }; const result = f.service.publish(input); expect(result.resource.enabled).toBe(false); expect(result.resource.kind).toBe("skill"); expect(result.revision.body).toBe(edited.body); expect(f.repository.skillExecutions.list(f.scope)).toEqual([]); expect(f.service.publish(input).resource.id).toBe(result.resource.id);
      const reopened = new AppRepository(f.db); try { expect(reopened.demonstrations.read(f.scope, draft.id)).toMatchObject({ state: "published", publishedResourceId: result.resource.id, version: 2 }); expect(reopened.library.list({ sessionId: f.scope.sessionId, includeDisabled: true })).toHaveLength(1); } finally { reopened.close(); }
    } finally { f.close(); }
  });
  it("separates private, room and sibling drafts and permanently removes a departed member's drafts", () => {
    const f = fixture(); try {
      const peer = f.repository.createBot(), room = f.repository.createRoom({ memberBotIds: [f.actor.bot.id, peer.bot.id, f.repository.createBot().bot.id] }); const own = { sessionId: room.session.id, executorBotId: f.actor.bot.id }, sibling = { sessionId: room.session.id, executorBotId: peer.bot.id };
      const privateDraft = f.repository.demonstrations.create(f.scope, snapshot()), roomDraft = f.repository.demonstrations.create(own, snapshot()), siblingDraft = f.repository.demonstrations.create(sibling, snapshot());
      expect(() => f.repository.demonstrations.read(own, privateDraft.id)).toThrow(expect.objectContaining({ code: "DEMONSTRATION_NOT_FOUND" })); expect(() => f.repository.demonstrations.read(sibling, roomDraft.id)).toThrow(expect.objectContaining({ code: "DEMONSTRATION_NOT_FOUND" }));
      f.repository.removeRoomMember(room.room.id, f.actor.bot.id, f.repository.getRoom(room.room.id).membershipVersion); expect(() => f.repository.demonstrations.read(own, roomDraft.id)).toThrow(); expect(f.repository.demonstrations.read(sibling, siblingDraft.id).id).toBe(siblingDraft.id); expect(f.repository.demonstrations.read(f.scope, privateDraft.id).id).toBe(privateDraft.id);
      f.repository.addRoomMember(room.room.id, f.actor.bot.id, f.repository.getRoom(room.room.id).membershipVersion); expect(f.repository.demonstrations.list(own)).toEqual([]);
    } finally { f.close(); }
  });
  it("does not publish malformed Skill metadata or partially create a resource", () => {
    const f = fixture(); try { const draft = f.repository.demonstrations.create(f.scope, snapshot()), edited = f.service.updateDraft({ ...f.scope, id: draft.id, expectedVersion: 1, name: "Bad metadata", body: "---\nname: Invalid Name\ndescription: test\n---\nbody" }); expect(() => f.service.publish({ ...f.scope, id: edited.id, expectedVersion: edited.version, expectedDigest: edited.digest })).toThrow(expect.objectContaining({ code: "LIBRARY_IMPORT_INVALID" })); expect(f.repository.library.list({ sessionId: f.scope.sessionId })).toHaveLength(0); expect(f.service.readDraft({ ...f.scope, id: draft.id }).state).toBe("draft"); } finally { f.close(); }
  });
  it("AI start/stop/discard only request human action and never read accepted capture input", async () => {
    const f = fixture(); try {
      const nonce = randomUUID(); f.repository.prepareMessage({ sessionId: f.scope.sessionId, clientNonce: nonce, text: "learn demonstration" }); const runtime = f.repository.createRuntimeRun(nonce, "fake", { schemaVersion: 1, botId: f.actor.bot.id, profileVersion: 1, sessionId: f.scope.sessionId, generation: 1, inputSeq: 1, blocks: [], digest: "demo" }); f.repository.transitionRuntimeRun(runtime.id, "dispatching"); f.repository.transitionRuntimeRun(runtime.id, "running");
      const handlers = new Map<string, (input?: unknown) => unknown>(); addDemonstrationProductHandlers(handlers, { repository: f.repository, demonstrationService: f.service }, undefined, { ...f.scope, runtimeRunId: runtime.id, signal: new AbortController().signal });
      for (const channel of [DEMONSTRATION_CHANNELS.start, DEMONSTRATION_CHANNELS.stop, DEMONSTRATION_CHANNELS.discard]) expect(await handlers.get(channel)!({ expectedEpoch: 2, id: randomUUID() })).toMatchObject({ status: "waiting_user" }); expect(f.bridge).not.toHaveBeenCalled();
      const other: BrowserScope = { sessionId: f.scope.sessionId, executorBotId: randomUUID() }; await expect(Promise.resolve().then(() => handlers.get(DEMONSTRATION_CHANNELS.start)!({ ...other, expectedEpoch: 2, id: randomUUID() }))).rejects.toMatchObject({ code: "BROWSER_SCOPE_INVALID" });
      await expect(f.service.start({ ...f.scope, expectedEpoch: 2, id: randomUUID() }, { actor: "ai" })).rejects.toMatchObject({ code: "UNTRUSTED_RENDERER" });
    } finally { f.close(); }
  });
});
