import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskExecutorSelection } from "@shared/task-session-contracts";
import type { SearchExecutionContext, SearchSourceReference } from "@shared/search-contracts";
import { AppRepository, digestMessage } from "./database";
import { SearchRepository } from "./search-repository";
import { SearchService } from "./search-service";
import { mediaExtractionDigest, type StoredMediaImport } from "./media-repository";
import { VoiceService } from "./voice-service";
import { voiceDigest } from "./voice-repository";
import { captureRealtimeAdmission } from "./realtime-admission";

const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of close.splice(0).reverse()) await cleanup(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aevoren-search-")), repository = new AppRepository(join(root, "app.sqlite")), owner = repository.createBot();
  const voice = new VoiceService(repository, { isAvailable: () => true, encrypt: value => `sealed:${value}`, decrypt: value => value.slice(7) }, { readBinary: async () => { throw new Error("Search never reads raw audio bytes"); } }, join(root, "voice"), { fetch: async () => { throw new Error("Search never calls a cloud account"); } });
  const source = new SearchRepository((repository as unknown as { database: DatabaseSync }).database), search = new SearchService(repository, source, voice);
  close.push(async () => { await voice.shutdown(); repository.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, repository, owner, voice, search };
}
function message(repository: AppRepository, sessionId: string, text: string) {
  const nonce = randomUUID(); repository.prepareMessage({ sessionId, clientNonce: nonce, text }); return repository.acknowledgeUserMessage(nonce);
}
function selected(executorBotId: string, patch: Partial<TaskExecutorSelection> = {}): TaskExecutorSelection {
  return { executorBotId, memories: [], history: [], workspaces: [], mcp: [], resourceRefs: [], mediaRefs: [], productOperations: ["search.query", "search.open"], network: false, clipboard: false, ...patch };
}
function runtime(repository: AppRepository, sessionId: string, executorBotId: string): SearchExecutionContext {
  const entry = message(repository, sessionId, "Search this conversation");
  const run = repository.createRuntimeRun(entry.clientNonce!, "fake", { schemaVersion: 1, botId: executorBotId, profileVersion: 1, sessionId, generation: entry.generation, inputSeq: entry.seq, blocks: [], digest: "search-test" }, { executorBotId });
  repository.transitionRuntimeRun(run.id, "dispatching"); repository.transitionRuntimeRun(run.id, "running");
  return { sessionId, executorBotId, runtimeRunId: run.id };
}
function media(text: string): StoredMediaImport {
  const id = randomUUID(), sourceSha256 = createHash("sha256").update(text).digest("hex");
  const extraction = { sourceSha256, parserName: "controlled-parser", parserVersion: "1", text, spans: [{ kind: "page" as const, index: 0, start: 0, end: text.length }], warningCodes: [] };
  return { asset: { reference: { id, name: "file.pdf", size: 30, sha256: sourceSha256, mimeType: "application/pdf" }, kind: "pdf", width: null, height: null, durationMs: null }, extraction: { id: randomUUID(), mediaId: id, ...extraction, digest: mediaExtractionDigest(extraction) } };
}
function draft(f: ReturnType<typeof fixture>, body = "needle local draft") {
  const connection = f.repository.connectors.configure({ provider: "gmail", name: "Controlled account", clientId: "fixture.apps.googleusercontent.com" }, "PRIVATE_ENCRYPTED_CONFIG_NEVER_SEARCH");
  const auth = f.repository.connectors.beginAuthorization({ id: connection.id, expectedVersion: connection.version });
  const connected = f.repository.connectors.completeAuthorization(auth.id, auth.authVersion, { accountId: "fixture", displayName: "Fixture" }, ["read"], [], "PRIVATE_OAUTH_TOKEN_NEVER_SEARCH");
  const scope = { sessionId: f.owner.session.id, executorBotId: f.owner.bot.id }, binding = f.repository.connectors.bind({ ...scope, connectionId: connected.id, expectedAuthVersion: connected.authVersion });
  const content = { kind: "gmail-message" as const, to: ["fixture@invalid.test"], cc: [], subject: "Controlled draft", body };
  return { ...f.repository.connectors.createDraft({ ...scope, connectionId: connected.id, expectedAuthVersion: connected.authVersion, expectedBindingVersion: binding.version, content }), scope, connection: connected, binding, content };
}

describe("scoped all-resource search with actual SQLite sources", () => {
  it("finds Unicode literal messages and returns an exact original source without interpreting query syntax", () => {
    const f = fixture(), entry = message(f.repository, f.owner.session.id, "第一行 中文ＦＯＯ needle\n第二行 <script>literal</script>");
    const page = f.search.query({ query: "中文foo", kinds: ["message"], scope: { kind: "session", sessionId: f.owner.session.id } });
    expect(page.items).toHaveLength(1); expect(page.items[0]!.source).toMatchObject({ type: "message", id: entry.id, seq: entry.seq, generation: entry.generation });
    expect(f.search.open({ source: page.items[0]!.source }).source).toEqual(page.items[0]!.source);
    expect(f.search.query({ query: "' OR 1=1 --" }).items).toEqual([]);
    expect(f.search.query({ query: "<script>literal</script>" }).items[0]!.snippet).toContain("<script>literal</script>");
  });
  it("searches every resource category and real persisted STT/realtime transcript sources, without credentials", () => {
    const f = fixture(), { repository: repo, owner } = f;
    message(repo, owner.session.id, "needle message");
    repo.library.create({ sessionId: owner.session.id, kind: "document", name: "Document", body: "needle document" });
    repo.library.create({ sessionId: owner.session.id, kind: "skill", name: "Skill", body: "needle skill" });
    const imported = repo.media.publishImport(owner.session.id, [media("needle parsed PDF")])[0]!;
    repo.tasks.create({ parentSessionId: owner.session.id, expectedScopeVersion: 1, clientNonce: randomUUID(), title: "needle task", selections: [selected(owner.bot.id)] });
    repo.createRoutine({ botId: owner.bot.id, name: "Routine", prompt: "needle routine", enabled: false, nextRunAt: null, schedule: { type: "interval", everyMinutes: 60, anchorAt: 0 } });
    draft(f);
    const incarnation = repo.media.captureSendReferences(owner.session.id, [imported.reference])[0]!.incarnation;
    const prepared = repo.voice.prepare({ sessionId: owner.session.id, kind: "transcription", clientNonce: randomUUID(), intentDigest: voiceDigest("controlled-transcription"), source: { kind: "media", reference: imported.reference }, sourceIncarnation: incarnation, configuration: repo.voice.configuration("stt").configuration });
    repo.voice.dispatch(prepared.record.task.id, 1); repo.voice.complete(prepared.record.task.id, { transcript: "needle audio transcript" });
    const input = { sessionId: owner.session.id, executorBotId: owner.bot.id, expectedConfigVersion: 1, routingMode: "automatic" as const, targetBotIds: [] };
    const connection = repo.realtime.create(input, randomUUID(), repo.voice.configuration("realtime").configuration, captureRealtimeAdmission(repo, input));
    const turn = repo.realtime.beginTurn(connection.session.id); repo.realtime.setTurn(turn.id, "transcribing"); repo.realtime.finishTranscript(turn.id, "needle realtime transcript");
    const result = f.search.query({ query: "needle" });
    expect(new Set(result.items.map(item => item.kind))).toEqual(new Set(["message", "document", "skill", "media", "task", "routine", "local-draft"]));
    expect(result.items.some(item => item.source.type === "voice-transcript")).toBe(true); expect(result.items.some(item => item.source.type === "realtime-transcript")).toBe(true);
    for (const item of result.items) expect(f.search.open({ source: item.source }).source).toEqual(item.source);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_ENCRYPTED_CONFIG|PRIVATE_OAUTH_TOKEN|source_text|arguments_private|dataBase64/);
    expect(f.search.query({ query: "PRIVATE_OAUTH_TOKEN_NEVER_SEARCH" }).items).toEqual([]);
  });
  it("filters private chats and Task members before pagination and keeps an old Runtime's resource selection", () => {
    const f = fixture(), repo = f.repository, other = repo.createBot(), privateBot = repo.createBot();
    message(repo, privateBot.session.id, "needle PRIVATE_OTHER_CHAT");
    const room = repo.createRoom({ memberBotIds: [f.owner.bot.id, other.bot.id] });
    const a = repo.library.create({ sessionId: room.session.id, kind: "document", name: "A", body: "needle ORIGINAL_A" }), b = repo.library.create({ sessionId: room.session.id, kind: "document", name: "B", body: "needle PRIVATE_B" });
    const task = repo.tasks.create({ parentSessionId: room.session.id, expectedScopeVersion: 1, clientNonce: randomUUID(), title: "Selected", selections: [selected(f.owner.bot.id, { resourceRefs: [a.reference] }), selected(other.bot.id, { resourceRefs: [b.reference] })] });
    const context = runtime(repo, task.session.id, f.owner.bot.id);
    const changed = repo.library.update({ sessionId: room.session.id, id: a.resource.id, expectedVersion: 1, body: "needle UNSELECTED_A_V2" });
    repo.tasks.reviseSelection({ sessionId: task.session.id, expectedVersion: task.version, selections: [selected(f.owner.bot.id, { resourceRefs: [changed.reference] }), selected(other.bot.id, { resourceRefs: [b.reference] })] });
    const result = f.search.query({ query: "needle", limit: 1 }, context);
    expect(result.items).toHaveLength(1); expect(result.nextCursor).toBeNull(); expect(result.items[0]!.snippet).toContain("ORIGINAL_A");
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_B|PRIVATE_OTHER_CHAT|UNSELECTED_A_V2/);
    expect(f.search.open({ source: result.items[0]!.source }, context).source).toEqual(result.items[0]!.source);
    expect(() => f.search.query({ query: "needle", scope: { kind: "all" } }, context)).toThrowError(expect.objectContaining({ code: "RUNTIME_CONTROL_SCOPE_INVALID" }));
    expect(() => f.search.query({ query: "needle", scope: { kind: "session", sessionId: privateBot.session.id } }, context)).toThrowError();
  });
  it("searches only explicitly selected parent-history snapshots under the Task scope", () => {
    const f = fixture(), repo = f.repository, chosen = message(repo, f.owner.session.id, "needle SELECTED_HISTORY_QUOTE");
    message(repo, f.owner.session.id, "needle PRIVATE_UNSELECTED_PARENT_HISTORY");
    const task = repo.tasks.create({ parentSessionId: f.owner.session.id, expectedScopeVersion: 1, clientNonce: randomUUID(), title: "Quoted context", selections: [selected(f.owner.bot.id, { history: [{ entryId: chosen.id, generation: chosen.generation, digest: digestMessage(chosen.body) }] })] });
    const context = runtime(repo, task.session.id, f.owner.bot.id), result = f.search.query({ query: "needle", kinds: ["message"] }, context);
    expect(result.items).toHaveLength(1); expect(result.items[0]!.snippet).toContain("SELECTED_HISTORY_QUOTE");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_UNSELECTED_PARENT_HISTORY");
    expect(result.items[0]!.source).toMatchObject({ type: "message", sessionId: task.session.id, originSessionId: f.owner.session.id, id: chosen.id, seq: chosen.seq, generation: chosen.generation });
    expect(f.search.open({ source: result.items[0]!.source }, context).source).toEqual(result.items[0]!.source);
    expect(() => f.search.query({ query: "needle", scope: { kind: "session", sessionId: f.owner.session.id } }, context)).toThrowError();
  });
  it("does not open a cleared selected-history origin or replace it with identical new text", () => {
    const f = fixture(), repo = f.repository, chosen = message(repo, f.owner.session.id, "needle SELECTED_OLD_ORIGIN");
    const task = repo.tasks.create({ parentSessionId: f.owner.session.id, expectedScopeVersion: 1, clientNonce: randomUUID(), title: "Quoted context", selections: [selected(f.owner.bot.id, { history: [{ entryId: chosen.id, generation: chosen.generation, digest: digestMessage(chosen.body) }] })] });
    const context = runtime(repo, task.session.id, f.owner.bot.id), hit = f.search.query({ query: "needle", kinds: ["message"] }, context).items[0]!;
    repo.clearConversation(f.owner.session.id); message(repo, f.owner.session.id, "needle SELECTED_OLD_ORIGIN");
    expect(() => f.search.open({ source: hit.source }, context)).toThrowError();
    expect(f.search.query({ query: "needle", kinds: ["message"] }, context).items).toEqual([]);
  });
  it("does not admit a later selected document to an originally empty Task Runtime", () => {
    const f = fixture(), repo = f.repository, doc = repo.library.create({ sessionId: f.owner.session.id, kind: "document", name: "Doc", body: "needle LATER_SOURCE" });
    const task = repo.tasks.create({ parentSessionId: f.owner.session.id, expectedScopeVersion: 1, clientNonce: randomUUID(), title: "Empty", selections: [selected(f.owner.bot.id)] }), context = runtime(repo, task.session.id, f.owner.bot.id);
    repo.tasks.reviseSelection({ sessionId: task.session.id, expectedVersion: task.version, selections: [selected(f.owner.bot.id, { resourceRefs: [doc.reference] })] });
    expect(f.search.query({ query: "needle", kinds: ["document"] }, context).items).toEqual([]);
    expect(f.search.query({ query: "needle", kinds: ["document"] }, { sessionId: task.session.id, executorBotId: f.owner.bot.id }).items).toHaveLength(1);
  });
  it("uses stable pages, rejects changed queries/content/scopes, and ignores other chats' updates", () => {
    const f = fixture(), repo = f.repository;
    for (let index = 0; index < 3; index++) message(repo, f.owner.session.id, `needle ${index}`);
    const context = runtime(repo, f.owner.session.id, f.owner.bot.id), first = f.search.query({ query: "needle", kinds: ["message"], limit: 1 }, context);
    expect(first.nextCursor).not.toBeNull();
    const other = repo.createBot(); message(repo, other.session.id, "needle private later");
    const second = f.search.query({ query: "needle", kinds: ["message"], limit: 1, cursor: first.nextCursor! }, context);
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
    expect(() => f.search.query({ query: "different", kinds: ["message"], cursor: first.nextCursor! }, context)).toThrowError();
    expect(() => f.search.query({ query: "needle", kinds: ["message"], cursor: `!${first.nextCursor}` }, context)).toThrowError();
    const later = repo.createAssistantEntry(f.owner.session.id); repo.updateTranscriptEntry(later.id, "needle current later", "completed");
    expect(() => f.search.query({ query: "needle", kinds: ["message"], cursor: first.nextCursor! }, context)).toThrowError();
  });
  it("opens the exact historical document revision, but never a rebound grant or another matching document", () => {
    const f = fixture(), repo = f.repository, doc = repo.library.create({ sessionId: f.owner.session.id, kind: "document", name: "Doc", body: "needle original" });
    const hit = f.search.query({ query: "needle", kinds: ["document"] }).items[0]!;
    repo.library.update({ sessionId: f.owner.session.id, id: doc.resource.id, expectedVersion: 1, body: "new body" });
    expect(f.search.open({ source: hit.source }).source).toEqual(hit.source);
    repo.library.unbind({ sessionId: f.owner.session.id, id: doc.resource.id }); repo.library.bind({ sessionId: f.owner.session.id, id: doc.resource.id });
    repo.library.create({ sessionId: f.owner.session.id, kind: "document", name: "Alternative", body: "needle original" });
    expect(() => f.search.open({ source: hit.source })).toThrowError();
  });
  it("rejects stale message generations and forged locators instead of opening similar text", () => {
    const f = fixture(); message(f.repository, f.owner.session.id, "needle same text");
    const source = f.search.query({ query: "needle", kinds: ["message"] }).items[0]!.source;
    expect(() => f.search.open({ source: { ...source, seq: 999 } as SearchSourceReference })).toThrowError();
    f.repository.clearConversation(f.owner.session.id); message(f.repository, f.owner.session.id, "needle same text");
    expect(() => f.search.open({ source })).toThrowError();
  });
  it("keeps old local-draft revisions locatable and removes revoked connections from results", () => {
    const f = fixture(), value = draft(f), hit = f.search.query({ query: "needle", kinds: ["local-draft"] }).items[0]!;
    f.repository.connectors.updateDraft({ ...value.scope, id: value.draft.id, expectedVersion: 1, content: { ...value.content, body: "later edit" } });
    expect(f.search.open({ source: hit.source }).source).toEqual(hit.source);
    f.repository.connectors.revoke({ id: value.connection.id, expectedVersion: value.connection.version });
    expect(f.search.query({ query: "needle", kinds: ["local-draft"] }).items).toEqual([]); expect(() => f.search.open({ source: hit.source })).toThrowError();
  });
  it("retires media hits after unbind/rebind and returns no revoked extraction text", () => {
    const f = fixture(), item = f.repository.media.publishImport(f.owner.session.id, [media("needle PDF text")])[0]!, hit = f.search.query({ query: "needle", kinds: ["media"] }).items[0]!;
    f.repository.media.unbind({ sessionId: f.owner.session.id, id: item.asset.reference.id });
    expect(f.search.query({ query: "needle", kinds: ["media"] }).items).toEqual([]);
    f.repository.media.bind({ sessionId: f.owner.session.id, id: item.asset.reference.id });
    expect(() => f.search.open({ source: hit.source })).toThrowError();
  });
});
