import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ConnectorAccessInput, ConnectorDraftContent } from "@shared/native-connector-contracts";
import { AppRepository, MIGRATIONS } from "./database";

const repositories: AppRepository[] = [], directories: string[] = [];
function repository(filename = ":memory:"): AppRepository { const value = new AppRepository(filename); repositories.push(value); return value; }
function connected(value: AppRepository, provider: "gmail" | "drive" | "notion" = "gmail", selected: string[] = []) {
  const configured = value.connectors.configure(provider === "notion" ? { provider, name: "Test", token: "private-token" } : { provider, name: "Test", clientId: "test.apps.googleusercontent.com" }, "encrypted-config");
  const auth = value.connectors.beginAuthorization({ id: configured.id, expectedVersion: configured.version });
  return value.connectors.completeAuthorization(auth.id, auth.authVersion, { accountId: "account-1", displayName: "Tester", email: "test@example.com" }, ["read"], selected, "encrypted-token");
}
function granted(value: AppRepository, provider: "gmail" | "drive" | "notion" = "gmail") {
  const bot = value.createBot(), connection = connected(value, provider, ["file_A", "file_B"]);
  const scope = { sessionId: bot.session.id, executorBotId: bot.bot.id }, binding = value.connectors.bind({ ...scope, connectionId: connection.id, expectedAuthVersion: connection.authVersion, ...(provider === "drive" ? { allowedResourceIds: ["file_A"] } : {}) });
  const access: ConnectorAccessInput = { ...scope, connectionId: connection.id, expectedAuthVersion: connection.authVersion, expectedBindingVersion: binding.version };
  return { bot, connection, scope, binding, access };
}
const mail: ConnectorDraftContent = { kind: "gmail-message", to: ["receiver@example.com"], cc: [], subject: "Subject", body: "Draft body" };
afterEach(() => { for (const value of repositories.splice(0)) value.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("native connector scope and immutable drafts", () => {
  it("configuration and validated identity do not automatically grant any session", () => {
    const value = repository(), bot = value.createBot(), connection = connected(value);
    const access = { sessionId: bot.session.id, executorBotId: bot.bot.id, connectionId: connection.id, expectedAuthVersion: connection.authVersion, expectedBindingVersion: 1 };
    expect(() => value.connectors.access(access)).toThrowError(expect.objectContaining({ code: "CONNECTOR_NOT_GRANTED" }));
    expect(value.connectors.list()).toEqual([connection]);
    expect(JSON.stringify(connection)).not.toMatch(/private-token|encrypted|clientId|clientSecret|refreshToken/u);
  });
  it("private grants never follow a Bot into a group or another Bot into the private chat", () => {
    const value = repository(), first = granted(value), second = value.createBot(), room = value.createRoom({ memberBotIds: [first.bot.bot.id, second.bot.id] });
    expect(value.connectors.access({ ...first.access, resourceId: "ignored" } as ConnectorAccessInput).binding.id).toBe(first.binding.id);
    expect(() => value.connectors.access({ ...first.access, sessionId: room.session.id })).toThrowError(expect.objectContaining({ code: "CONNECTOR_NOT_GRANTED" }));
    expect(() => value.connectors.access({ ...first.access, executorBotId: second.bot.id })).toThrow();
    expect(value.connectors.bindings({ sessionId: room.session.id, executorBotId: second.bot.id })).toEqual([]);
  });
  it("removing and readding a Room member permanently invalidates only that member's old grant", () => {
    const value = repository(), members = Array.from({ length: 3 }, () => value.createBot()), connection = connected(value);
    const room = value.createRoom({ memberBotIds: members.map(member => member.bot.id) });
    const scopes = members.map(member => ({ sessionId: room.session.id, executorBotId: member.bot.id }));
    const grants = scopes.map(scope => value.connectors.bind({ ...scope, connectionId: connection.id, expectedAuthVersion: connection.authVersion }));
    const accesses = scopes.map((scope, index) => ({ ...scope, connectionId: connection.id, expectedAuthVersion: connection.authVersion, expectedBindingVersion: grants[index]!.version }));
    const oldDraft = value.connectors.createDraft({ ...accesses[0]!, content: mail });
    const siblingDraft = value.connectors.createDraft({ ...accesses[1]!, content: mail });
    const removed = value.removeRoomMember(room.room.id, members[0]!.bot.id, room.room.membershipVersion);
    value.addRoomMember(room.room.id, members[0]!.bot.id, removed.room.membershipVersion);
    expect(() => value.connectors.access(accesses[0]!)).toThrowError(expect.objectContaining({ code: "CONNECTOR_NOT_GRANTED" }));
    expect(value.connectors.access(accesses[1]!).binding.id).toBe(grants[1]!.id);
    expect(() => value.connectors.readDraft({ ...scopes[0]!, id: oldDraft.draft.id })).toThrow();
    expect(value.connectors.readDraft({ ...scopes[1]!, id: siblingDraft.draft.id }).authorized).toBe(true);
    const revoked = value.connectors.bindings({ ...scopes[0]!, includeRevoked: true })[0]!;
    expect(revoked.revokedAt).not.toBeNull();
    const regrant = value.connectors.bind({ ...scopes[0]!, connectionId: connection.id, expectedAuthVersion: connection.authVersion, expectedVersion: revoked.version });
    expect(value.connectors.access({ ...accesses[0]!, expectedBindingVersion: regrant.version }).binding.revokedAt).toBeNull();
  });
  it("Drive bindings permit only a chosen subset and cannot expand Gmail grants via IDs", () => {
    const value = repository(), first = granted(value, "drive");
    expect(first.binding.allowedResourceIds).toEqual(["file_A"]);
    expect(() => value.connectors.bind({ ...first.scope, connectionId: first.connection.id, expectedAuthVersion: first.connection.authVersion, expectedVersion: 1, allowedResourceIds: ["outside"] }))
      .toThrowError(expect.objectContaining({ code: "RESOURCE_NOT_ALLOWED" }));
    const gmail = connected(value);
    expect(() => value.connectors.bind({ ...first.scope, connectionId: gmail.id, expectedAuthVersion: gmail.authVersion, allowedResourceIds: ["file_A"] }))
      .toThrowError(expect.objectContaining({ code: "RESOURCE_NOT_ALLOWED" }));
  });
  it("credential refresh does not advance auth version; revoke invalidates old bindings", () => {
    const value = repository(), first = granted(value);
    value.connectors.refreshCredentials(first.connection.id, first.connection.authVersion, "new-ciphertext");
    expect(value.connectors.get(first.connection.id)).toEqual(first.connection);
    expect(value.connectors.access(first.access).binding).toEqual(first.binding);
    const revoked = value.connectors.revoke({ id: first.connection.id, expectedVersion: first.connection.version });
    expect(revoked.authVersion).toBe(first.connection.authVersion + 1);
    expect(value.connectors.secrets(first.connection.id).credentials).toBeNull();
    expect(() => value.connectors.access(first.access)).toThrowError(expect.objectContaining({ code: "CONNECTOR_AUTH_CHANGED" }));
  });
  it("cancelled authorization cannot publish late credentials or repeat completion", () => {
    const value = repository(), first = granted(value), auth = value.connectors.beginAuthorization({ id: first.connection.id, expectedVersion: first.connection.version });
    expect(() => value.connectors.access(first.access)).toThrow();
    value.connectors.endAuthorization(auth.id, auth.authVersion);
    expect(() => value.connectors.completeAuthorization(auth.id, auth.authVersion, { accountId: "late", displayName: "Late" }, [], [], "late-ciphertext"))
      .toThrowError(expect.objectContaining({ code: "CONNECTOR_AUTH_CHANGED" }));
    const next = value.connectors.beginAuthorization({ id: auth.id, expectedVersion: value.connectors.get(auth.id).version });
    value.connectors.completeAuthorization(next.id, next.authVersion, { accountId: "new", displayName: "New" }, [], [], "new-ciphertext");
    expect(() => value.connectors.completeAuthorization(next.id, next.authVersion, { accountId: "duplicate", displayName: "Other" }, [], [], "duplicate"))
      .toThrowError(expect.objectContaining({ code: "CONNECTOR_AUTH_CHANGED" }));
  });
  it("draft edits pin the account, preserve old revisions and keep a conflicting caller draft intact", () => {
    const value = repository(), first = granted(value), draft = value.connectors.createDraft({ ...first.access, content: mail });
    const changed = value.connectors.updateDraft({ ...first.scope, id: draft.draft.id, expectedVersion: 1, content: { ...mail, body: "New body" } });
    expect(changed.draft.version).toBe(2); expect(changed.revision.digest).not.toBe(draft.revision.digest);
    expect(value.connectors.readDraft({ ...first.scope, id: draft.draft.id, revisionId: draft.revision.id }).revision).toEqual(draft.revision);
    const conflicting = { ...first.scope, id: draft.draft.id, expectedVersion: 1, content: { ...mail, body: "Unsaved user's draft" } };
    expect(() => value.connectors.updateDraft(conflicting)).toThrowError(expect.objectContaining({ code: "CONNECTOR_DRAFT_VERSION_CONFLICT", currentVersion: 2 }));
    expect(conflicting.content.body).toBe("Unsaved user's draft"); expect(value.connectors.draftVersions({ ...first.scope, id: draft.draft.id })).toHaveLength(2);
    expect(value.connectors.draftVersions({ ...first.scope, id: draft.draft.id })[0]).not.toHaveProperty("content");
    expect(changed.draft.state).toBe("local-draft");
  });
  it("same draft nonce reuses original revision and conflicting payload cannot duplicate it", () => {
    const value = repository(), first = granted(value), clientNonce = randomUUID();
    const original = value.connectors.createDraft({ ...first.access, content: mail, clientNonce });
    const repeated = value.connectors.createDraft({ ...first.access, content: mail, clientNonce });
    expect(repeated).toEqual(original); expect(value.connectors.listDrafts(first.scope)).toHaveLength(1);
    expect(() => value.connectors.createDraft({ ...first.access, content: { ...mail, body: "Different" }, clientNonce }))
      .toThrowError(expect.objectContaining({ code: "CONNECTOR_DRAFT_CONFLICT" }));
    value.connectors.updateDraft({ ...first.scope, id: original.draft.id, expectedVersion: 1, content: { ...mail, body: "Later edit" } });
    expect(value.connectors.createDraft({ ...first.access, content: mail, clientNonce }).revision).toEqual(original.revision);
    value.connectors.deleteDraft({ ...first.scope, id: original.draft.id, expectedVersion: 2 });
    expect(() => value.connectors.createDraft({ ...first.access, content: mail, clientNonce })).toThrowError(expect.objectContaining({ code: "CONNECTOR_DRAFT_CONFLICT" }));
  });
  it("revoked drafts stay readable for review but cannot silently adopt a replacement account", () => {
    const value = repository(), first = granted(value), draft = value.connectors.createDraft({ ...first.access, content: mail });
    value.connectors.revoke({ id: first.connection.id, expectedVersion: first.connection.version });
    expect(value.connectors.readDraft({ ...first.scope, id: draft.draft.id }).authorized).toBe(false);
    const edited = value.connectors.updateDraft({ ...first.scope, id: draft.draft.id, expectedVersion: 1, content: { ...mail, body: "Review after revoke" } });
    expect(edited.authorized).toBe(false); expect(edited.draft.accountId).toBe("account-1");
    const auth = value.connectors.beginAuthorization({ id: first.connection.id, expectedVersion: value.connectors.get(first.connection.id).version });
    const replacement = value.connectors.completeAuthorization(auth.id, auth.authVersion, { accountId: "new-account", displayName: "Replacement" }, [], [], "new-token");
    value.connectors.bind({ ...first.scope, connectionId: replacement.id, expectedAuthVersion: replacement.authVersion, expectedVersion: 1 });
    expect(value.connectors.readDraft({ ...first.scope, id: draft.draft.id }).draft.accountId).toBe("account-1");
    expect(value.connectors.readDraft({ ...first.scope, id: draft.draft.id }).authorized).toBe(false);
  });
  it("draft target validation and scope checks reject cross-account, cross-resource and cross-Bot access", () => {
    const value = repository(), first = granted(value, "drive");
    expect(() => value.connectors.createDraft({ ...first.access, content: mail })).toThrowError(expect.objectContaining({ code: "RESOURCE_NOT_ALLOWED" }));
    expect(() => value.connectors.createDraft({ ...first.access, content: { kind: "drive-text", targetFileId: "file_B", title: "B", text: "B" } })).toThrow();
    const draft = value.connectors.createDraft({ ...first.access, content: { kind: "drive-text", targetFileId: "file_A", title: "A", text: "A" } }), other = value.createBot();
    expect(() => value.connectors.readDraft({ sessionId: other.session.id, executorBotId: other.bot.id, id: draft.draft.id })).toThrow();
    expect(() => value.connectors.readDraft({ ...first.scope, id: draft.draft.id, revisionId: randomUUID() })).toThrow();
  });
  it("hard deletion cascades only the selected Bot or Room connector state without touching global credentials", () => {
    const value = repository(), first = granted(value), second = value.createBot(), room = value.createRoom({ memberBotIds: [first.bot.bot.id, second.bot.id] });
    const privateDraft = value.connectors.createDraft({ ...first.access, content: mail });
    const roomScope = { sessionId: room.session.id, executorBotId: second.bot.id };
    const roomGrant = value.connectors.bind({ ...roomScope, connectionId: first.connection.id, expectedAuthVersion: first.connection.authVersion });
    const roomDraft = value.connectors.createDraft({ ...roomScope, connectionId: first.connection.id, expectedAuthVersion: first.connection.authVersion, expectedBindingVersion: roomGrant.version, content: mail });
    value.deleteRoom(room.room.id);
    expect(() => value.connectors.readDraft({ ...roomScope, id: roomDraft.draft.id })).toThrow();
    expect(value.connectors.readDraft({ ...first.scope, id: privateDraft.draft.id }).revision.content).toEqual(mail);
    value.deleteBot(first.bot.bot.id);
    expect(() => value.connectors.readDraft({ ...first.scope, id: privateDraft.draft.id })).toThrow();
    expect(value.connectors.get(first.connection.id).account?.accountId).toBe("account-1");
  });
  it("SQLite migration and restart preserve old chats and encrypted records while interrupting pending OAuth", () => {
    const started = performance.now(), phases: { phase: string; elapsedMs: number }[] = [];
    const mark = (phase: string) => phases.push({ phase, elapsedMs: Math.round(performance.now() - started) });
    try {
      const directory = mkdtempSync(join(tmpdir(), "aevoren-connector-migration-")); directories.push(directory); const path = join(directory, "test.sqlite");
      mark("legacy-start");
      const db = new DatabaseSync(path);
      try {
        db.exec("PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)");
        for (const migration of MIGRATIONS.filter(item => item.version <= 37)) {
          const foreignKeysOff = "foreignKeysOff" in migration && migration.foreignKeysOff;
          if (foreignKeysOff) db.exec("PRAGMA foreign_keys=OFF");
          try {
            db.exec("BEGIN IMMEDIATE");
            try {
              expect(db.isTransaction).toBe(true);
              db.exec(migration.sql);
              if (foreignKeysOff) expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
              db.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(migration.version, "2026-10-14T00:00:00Z");
              db.exec("COMMIT");
            } catch (error) {
              db.exec("ROLLBACK");
              throw error;
            }
          } finally {
            if (foreignKeysOff) db.exec("PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON");
          }
        }
      } finally { db.close(); }
      mark("legacy-complete"); mark("upgrade-open-start");
      let value = repository(path);
      mark("upgrade-open-complete");
      const first = granted(value), draft = value.connectors.createDraft({ ...first.access, content: mail });
      value.connectors.beginAuthorization({ id: first.connection.id, expectedVersion: first.connection.version });
      value.close(); repositories.splice(repositories.indexOf(value), 1);
      mark("restart-open-start"); value = repository(path); mark("restart-open-complete");
      expect(value.getSession(first.scope.sessionId).id).toBe(first.scope.sessionId);
      expect(value.connectors.readDraft({ ...first.scope, id: draft.draft.id }).revision.content).toEqual(mail);
      value.connectors.recoverAuthorizations();
      expect(value.connectors.get(first.connection.id).state).toBe("auth-required"); expect(value.connectors.secrets(first.connection.id).credentials).toBeNull();
      mark("assertions-complete");
    } finally { console.info("native-connector-migration-phases", JSON.stringify(phases)); }
  });
});
