import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { PromptManifest, Session } from "@shared/contracts";
import { AppRepository, MIGRATIONS } from "./database";

const repositories = new Set<AppRepository>();
const directories: string[] = [];

function databaseFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "aevoren-conversations-"));
  directories.push(directory);
  return join(directory, "app.sqlite");
}

function repository(filename = ":memory:"): AppRepository {
  const value = new AppRepository(filename);
  repositories.add(value);
  return value;
}

function close(value: AppRepository): void {
  value.close();
  repositories.delete(value);
}

function startRuntime(value: AppRepository, session: Session, botId: string, clientNonce: string) {
  const input = value.getUserMessage(clientNonce);
  const manifest: PromptManifest = {
    schemaVersion: 1, botId, profileVersion: value.getBot(botId).version,
    sessionId: session.id, generation: session.generation, inputSeq: input.seq, blocks: [], digest: "conversation-test",
  };
  const run = value.createRuntimeRun(clientNonce, "fake", manifest, { executorBotId: botId });
  value.transitionRuntimeRun(run.id, "dispatching");
  value.transitionRuntimeRun(run.id, "running", { providerRequestId: "conversation-test" });
  return run;
}

afterEach(() => {
  for (const value of repositories) value.close();
  repositories.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Conversation repository", () => {
  it("backs up and migrates v28 sidebar state without changing identities or transcript, then reopens idempotently", () => {
    const filename = databaseFile();
    const legacy = new DatabaseSync(filename);
    legacy.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const migration of MIGRATIONS.filter((item) => item.version <= 28)) {
      legacy.exec(migration.sql);
      legacy.prepare("INSERT INTO schema_migrations VALUES (?, '2026-01-01')").run(migration.version);
    }
    legacy.exec(`
      INSERT INTO projects(id, name, is_default, version, created_at, updated_at)
        VALUES ('project', 'Legacy project', 0, 1, '2026-01-01', '2026-01-01');
      INSERT INTO bots(id, project_id, name, label, description, instructions, version,
        pinned_at, hidden_at, has_unread, created_at, updated_at)
        VALUES ('bot', 'project', 'Legacy Bot', 'role', 'description', 'instructions', 7,
                '2026-01-02', '2026-01-03', 1, '2026-01-01', '2026-01-04');
      INSERT INTO rooms(id, project_id, name, description, version, membership_version,
        pinned_at, hidden_at, has_unread, created_at, updated_at)
        VALUES ('room', 'project', 'Legacy Room', '', 3, 2, '2026-01-05', NULL, 1, '2026-01-01', '2026-01-06');
      INSERT INTO sessions(id, bot_id, room_id, kind, generation, transcript_cursor, created_at, updated_at)
        VALUES ('direct', 'bot', NULL, 'MAIN', 2, 8, '2026-01-01', '2026-01-02'),
               ('group', NULL, 'room', 'MAIN', 1, 0, '2026-01-01', '2026-01-02');
      INSERT INTO transcript_entries(id, session_id, generation, seq, role, body, status, created_at, updated_at)
        VALUES ('old', 'direct', 1, 1, 'assistant', 'old generation', 'completed', '2026-01-09', '2026-01-09'),
               ('message', 'direct', 2, 1, 'assistant', 'Latest reply', 'completed', '2026-01-07', '2026-01-08'),
               ('placeholder', 'direct', 2, 2, 'assistant', '', 'streaming', '2026-01-09', '2026-01-09');
    `);
    const identities = legacy.prepare("SELECT * FROM bots").all();
    const transcript = legacy.prepare("SELECT * FROM transcript_entries ORDER BY id").all();
    legacy.close();

    const first = repository(filename);
    expect(first.getConversation("direct")).toEqual({
      sessionId: "direct", botId: "bot", roomId: null, projectId: "project", workspaceIds: [], pinnedAt: "2026-01-02",
      hiddenAt: "2026-01-03", hasUnread: true, lastMessage: "Latest reply", lastActivityAt: "2026-01-08", version: 1,
    });
    expect(first.getConversation("group")).toMatchObject({
      roomId: "room", projectId: "project", pinnedAt: "2026-01-05", hiddenAt: null,
      hasUnread: true, lastMessage: null, lastActivityAt: "2026-01-01",
    });
    const expected = first.listConversations();
    close(first);
    const reopened = repository(filename);
    expect(reopened.listConversations()).toEqual(expected);
    const inspected = new DatabaseSync(filename, { readOnly: true });
    expect(inspected.prepare("SELECT * FROM bots").all()).toEqual(identities);
    expect(inspected.prepare("SELECT * FROM transcript_entries ORDER BY id").all()).toEqual(transcript);
    expect(inspected.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    inspected.close();
    const backupDirectory = join(filename, "..", "Backups");
    const backups = readdirSync(backupDirectory);
    expect(backups.filter((name) => name.endsWith(".sqlite"))).toHaveLength(1);
    const backup = new DatabaseSync(join(backupDirectory, backups.find((name) => name.endsWith(".sqlite"))!), { readOnly: true });
    expect(backup.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 28 });
    expect(backup.prepare("SELECT * FROM transcript_entries ORDER BY id").all()).toEqual(transcript);
    backup.close();
  });

  it("creates metadata atomically for bots, duplicates, rooms and team templates", () => {
    const filename = databaseFile();
    const value = repository(filename);
    const bots = [value.createBot(), value.createBot()];
    const injector = new DatabaseSync(filename);
    injector.exec("CREATE TRIGGER reject_conversation BEFORE INSERT ON conversation_metadata BEGIN SELECT RAISE(ABORT, 'fixture'); END;");
    expect(() => value.createBot()).toThrow();
    expect(() => value.duplicateBot(bots[0]!.bot.id)).toThrow();
    expect(() => value.createRoom({ memberBotIds: bots.map(({ bot }) => bot.id) })).toThrow();
    expect(() => value.createContentTeamTemplate()).toThrow();
    expect(value.listBots()).toHaveLength(2);
    expect(value.listRooms()).toHaveLength(0);
    expect(value.listConversations()).toHaveLength(2);
    injector.exec("DROP TRIGGER reject_conversation");
    const duplicate = value.duplicateBot(bots[0]!.bot.id);
    const room = value.createRoom({ memberBotIds: bots.map(({ bot }) => bot.id) });
    const team = value.createContentTeamTemplate();
    expect(value.listConversations()).toHaveLength(10);
    for (const sessionId of [duplicate.session.id, room.session.id]) {
      expect(value.getConversation(sessionId)).toMatchObject({ projectId: null, lastMessage: null, version: 1 });
    }
    expect(value.getConversation(team.room.session.id)).toMatchObject({ projectId: null, lastMessage: null, version: 1 });
    expect(injector.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    injector.close();
  });

  it("lazily opens legacy contacts and rooms without MAIN sessions without duplicating their identities", () => {
    const filename = databaseFile();
    const value = repository(filename);
    const direct = value.createBot();
    const other = value.createBot();
    const room = value.createRoom({ memberBotIds: [direct.bot.id, other.bot.id] });
    const memory = value.createMemory(direct.bot.id, "Legacy memory");
    const injector = new DatabaseSync(filename);
    injector.exec("PRAGMA foreign_keys = ON");
    injector.prepare("DELETE FROM sessions WHERE id IN (?, ?)").run(direct.session.id, room.session.id);
    injector.prepare("UPDATE bots SET pinned_at = '2026-01-01', hidden_at = '2026-01-02', has_unread = 1 WHERE id = ?").run(direct.bot.id);
    const identities = injector.prepare("SELECT * FROM bots ORDER BY id").all();
    expect(value.listConversations()).toHaveLength(1);
    injector.exec("CREATE TRIGGER reject_legacy BEFORE INSERT ON conversation_metadata BEGIN SELECT RAISE(ABORT, 'fixture'); END;");
    expect(() => value.getMainSession(direct.bot.id)).toThrow();
    expect(injector.prepare("SELECT COUNT(*) AS count FROM sessions WHERE bot_id = ?").get(direct.bot.id)).toEqual({ count: 0 });
    injector.exec("DROP TRIGGER reject_legacy");
    const session = value.getMainSession(direct.bot.id);
    expect(value.getMainSession(direct.bot.id)).toEqual(session);
    expect(value.getConversation(session.id)).toMatchObject({ pinnedAt: "2026-01-01", hiddenAt: "2026-01-02", hasUnread: true });
    const roomSession = value.getRoomDetail(room.room.id).session;
    expect(value.getRoomMainSession(room.room.id)).toEqual(roomSession);
    expect(value.listConversations()).toHaveLength(3);
    expect(value.getMemory(memory.id)).toEqual(memory);
    expect(value.listRoomMembers(room.room.id).map((member) => member.botId)).toEqual([direct.bot.id, other.bot.id]);
    expect(injector.prepare("SELECT * FROM bots ORDER BY id").all()).toEqual(identities);
    expect(injector.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    injector.close();
  });

  it("projects legacy sidebar APIs from conversation state while keeping hidden contacts and room members", () => {
    const filename = databaseFile();
    const first = repository(filename);
    const direct = first.createBot();
    const second = first.createBot();
    const room = first.createRoom({ memberBotIds: [direct.bot.id, second.bot.id] });
    first.setBotPinned(direct.bot.id, true);
    first.setBotUnread(direct.bot.id, true);
    const hidden = first.setBotHidden(direct.bot.id, true);
    expect(hidden).toMatchObject({ hiddenAt: expect.any(String), pinnedAt: null, hasUnread: true, version: direct.bot.version });
    expect(first.listBots().map((bot) => bot.id)).toContain(direct.bot.id);
    expect(first.listRoomMembers(room.room.id)[0]!.bot).toMatchObject(hidden);
    first.setRoomHidden(room.room.id, true);
    expect(first.setRoomPinned(room.room.id, true)).toMatchObject({ hiddenAt: null, pinnedAt: expect.any(String), version: room.room.version });
    first.setRoomUnread(room.room.id, true);
    close(first);
    const reopened = repository(filename);
    expect(reopened.getBot(direct.bot.id)).toEqual(hidden);
    expect(reopened.getRoom(room.room.id)).toMatchObject({ hasUnread: true, membershipVersion: room.room.membershipVersion });
    expect(reopened.setConversationHidden(direct.session.id, false).hiddenAt).toBeNull();
    expect(reopened.getBot(direct.bot.id).hiddenAt).toBeNull();
    const inspected = new DatabaseSync(filename, { readOnly: true });
    expect(inspected.prepare("SELECT pinned_at, hidden_at, has_unread, version FROM bots WHERE id = ?").get(direct.bot.id))
      .toEqual({ pinned_at: null, hidden_at: null, has_unread: 0, version: direct.bot.version });
    inspected.close();
  });

  it("unhides on actual new messages, ignores empty placeholders and stale or status-only updates", () => {
    const value = repository();
    const { session } = value.createBot();
    value.setConversationHidden(session.id, true);
    const hidden = value.getConversation(session.id);
    const placeholder = value.createAssistantEntry(session.id);
    expect(value.getConversation(session.id)).toEqual(hidden);
    value.updateTranscriptEntry(placeholder.id, "Welcome", "completed");
    expect(value.getConversation(session.id)).toMatchObject({ hiddenAt: null, lastMessage: "Welcome" });
    const nonce = randomUUID();
    value.prepareMessage({ sessionId: session.id, clientNonce: nonce, text: "A real message" });
    value.setConversationHidden(session.id, true);
    const before = value.getConversation(session.id);
    value.updateTranscriptEntry(placeholder.id, "old edited response", "failed");
    value.setUserMessageStatus(nonce, "failed");
    expect(value.getConversation(session.id)).toEqual(before);
    value.prepareMessage({ sessionId: session.id, clientNonce: randomUUID(), text: "Open again" });
    expect(value.getConversation(session.id)).toMatchObject({ hiddenAt: null, lastMessage: "Open again" });
  });

  it("marks real assistant completions unread once and preserves manual reads until the next finished reply", () => {
    const filename = databaseFile();
    const value = repository(filename);
    const { bot, session } = value.createBot();
    const assistant = value.createAssistantEntry(session.id);
    value.updateTranscriptEntry(assistant.id, "First chunk", "streaming");
    expect(value.getConversation(session.id).hasUnread).toBe(false);
    value.updateTranscriptEntry(assistant.id, "Finished answer", "streaming");
    const before = value.getConversation(session.id);
    value.updateTranscriptEntry(assistant.id, "Finished answer", "completed");
    expect(value.getConversation(session.id)).toMatchObject({
      hasUnread: true, version: before.version + 1, lastActivityAt: before.lastActivityAt,
    });
    expect(value.getBot(bot.id).hasUnread).toBe(true);
    const read = value.setConversationUnread(session.id, false);
    value.updateTranscriptEntry(assistant.id, "Finished answer", "completed");
    expect(value.getConversation(session.id)).toEqual(read);
    value.updateTranscriptEntry(assistant.id, "Edited completed answer", "completed");
    expect(value.getConversation(session.id).hasUnread).toBe(false);
    const next = value.createAssistantEntry(session.id);
    value.updateTranscriptEntry(next.id, "Next answer", "streaming");
    expect(value.getConversation(session.id).hasUnread).toBe(false);
    value.updateTranscriptEntry(next.id, "Next answer", "completed");
    expect(value.getConversation(session.id).hasUnread).toBe(true);
    // User-shaped messages can be inserted by routines; only UI activation marks read.
    value.prepareMessage({ sessionId: session.id, clientNonce: randomUUID(), text: "Scheduled request" });
    expect(value.getConversation(session.id).hasUnread).toBe(true);
    close(value);
    const reopened = repository(filename);
    expect(reopened.getConversation(session.id).hasUnread).toBe(true);
    expect(reopened.setConversationUnread(session.id, false).hasUnread).toBe(false);
  });

  it("marks inserted terminal replies and empty failures unread, while ignoring empty completion or cancellation", () => {
    const filename = databaseFile();
    const value = repository(filename);
    const { session } = value.createBot();
    const injector = new DatabaseSync(filename);
    const insert = injector.prepare(
      `INSERT INTO transcript_entries(id, session_id, generation, seq, role, body, status, created_at, updated_at)
       VALUES (?, ?, 1, ?, 'assistant', ?, ?, '2026-01-01', '2026-01-01')`,
    );
    for (const [index, status] of ["completed", "failed", "cancelled"].entries()) {
      value.setConversationUnread(session.id, false);
      insert.run(randomUUID(), session.id, index + 1, "Reply content", status);
      expect(value.getConversation(session.id).hasUnread).toBe(true);
    }
    value.setConversationUnread(session.id, false);
    insert.run(randomUUID(), session.id, 4, "", "failed");
    expect(value.getConversation(session.id).hasUnread).toBe(true);
    for (const [index, status] of ["completed", "cancelled"].entries()) {
      const before = value.setConversationUnread(session.id, false);
      insert.run(randomUUID(), session.id, 10 + index * 2, "", status);
      expect(value.getConversation(session.id)).toEqual(before);
      const placeholder = value.createAssistantEntry(session.id);
      value.updateTranscriptEntry(placeholder.id, "", status as "completed" | "cancelled");
      expect(value.getConversation(session.id)).toEqual(before);
    }
    const failed = value.createAssistantEntry(session.id);
    const beforeFailure = value.getConversation(session.id);
    value.updateTranscriptEntry(failed.id, "", "failed");
    expect(value.getConversation(session.id)).toMatchObject({
      hasUnread: true, lastActivityAt: beforeFailure.lastActivityAt, version: beforeFailure.version + 1,
    });
    injector.close();
  });

  it("ignores late assistant insertion and completion from an older session generation", () => {
    const filename = databaseFile();
    const value = repository(filename);
    const { session } = value.createBot();
    value.clearConversation(session.id);
    const before = value.getConversation(session.id);
    const injector = new DatabaseSync(filename);
    const insert = injector.prepare(
      `INSERT INTO transcript_entries(id, session_id, generation, seq, role, body, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'assistant', ?, ?, '2026-01-01', '2026-01-01')`,
    );
    insert.run(randomUUID(), session.id, session.generation, 1, "Late completed reply", "completed");
    const late = randomUUID();
    insert.run(late, session.id, session.generation, 2, "", "streaming");
    value.updateTranscriptEntry(late, "Late failed reply", "failed");
    expect(value.getConversation(session.id)).toEqual(before);
    expect(value.getSession(session.id).generation).toBe(2);
    expect(injector.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    injector.close();
  });

  it("clears one direct session and attachment copies, retires old sends and preserves memory, files and other conversations", () => {
    const filename = databaseFile();
    const value = repository(filename);
    const direct = value.createBot();
    const other = value.createBot();
    const room = value.createRoom({ memberBotIds: [direct.bot.id, other.bot.id] });
    const userFile = join(filename, "..", "user-notes.txt");
    writeFileSync(userFile, "user owned", "utf8");
    const registered = value.registerWorkspaceRoot(join(filename, ".."), "User files");
    const workspace = registered.workspace;
    value.setConversationProject(direct.session.id, registered.project.id, value.getConversation(direct.session.id).version);
    const content = "attachment copy";
    const command = { sessionId: direct.session.id, clientNonce: randomUUID(), text: "Remember concise replies", attachments: [{
      id: randomUUID(), name: "notes.txt", mimeType: "text/plain", content, kind: "text" as const,
      size: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex"),
    }] };
    value.prepareMessage(command);
    value.prepareMessage({ sessionId: other.session.id, clientNonce: randomUUID(), text: "Keep this history" });
    const user = value.getUserMessage(command.clientNonce);
    const memory = value.createMemory(direct.bot.id, "Keep this memory", { sourceEntryId: user.id });
    const proposal = value.createMemoryProposal({ botId: direct.bot.id, scope: "bot", scopeKey: direct.bot.id,
      kind: "preference", content: "Pending preference", reason: "User preference", sourceEntryId: user.id })!;
    const run = startRuntime(value, direct.session, direct.bot.id, command.clientNonce);
    const tool = value.prepareToolInvocation({ runtimeRunId: run.id, toolCallId: "read", idempotencyKey: randomUUID(),
      tool: { kind: "workspace-read", workspaceId: workspace.id, path: "user-notes.txt", maxBytes: 100 } });
    value.resolveToolApproval(tool.approval.id, tool.approval.version, "deny");
    value.transitionRuntimeRun(run.id, "completed");
    value.setConversationPinned(direct.session.id, true);
    value.setConversationUnread(direct.session.id, true);
    const cursor = value.getTranscriptCursor(direct.session.id);
    const cleared = value.clearConversation(direct.session.id);
    expect(cleared).toMatchObject({ id: direct.session.id, botId: direct.bot.id, generation: 2 });
    expect(value.getTranscriptCursor(direct.session.id)).toBeGreaterThan(cursor);
    expect(value.listTranscript(direct.session.id)).toEqual([]);
    expect(value.getConversation(direct.session.id)).toMatchObject({ pinnedAt: expect.any(String), lastMessage: null, hasUnread: false });
    expect(value.getMemory(memory.id)).toMatchObject({ content: memory.content, sourceEntryId: null });
    expect(() => value.getMemoryProposal(proposal.id)).toThrow();
    expect(value.getBot(direct.bot.id)).toMatchObject({ name: direct.bot.name, instructions: direct.bot.instructions, version: direct.bot.version });
    expect(value.getRoom(room.room.id)).toEqual(room.room);
    expect(value.listRoomMembers(room.room.id).map((member) => member.botId)).toEqual(room.members.map((member) => member.botId));
    expect(value.listTranscript(other.session.id)).toHaveLength(1);
    expect(readFileSync(userFile, "utf8")).toBe("user owned");
    expect(value.getWorkspace(workspace.id)).toEqual(workspace);
    expect(() => value.prepareMessage(command)).toThrowError(expect.objectContaining({ code: "MESSAGE_RETRY_UNSAFE" }));
    expect(() => value.queueRetry(command.clientNonce)).toThrowError(expect.objectContaining({ code: "MESSAGE_RETRY_UNSAFE" }));
    const inspected = new DatabaseSync(filename, { readOnly: true });
    for (const table of ["runtime_runs", "tool_invocations", "approval_requests", "message_attachments"]) {
      expect(inspected.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    expect(inspected.prepare("SELECT state, retired_at FROM send_journal INNER JOIN retired_conversation_sends USING (client_nonce) WHERE client_nonce = ?").get(command.clientNonce))
      .toEqual({ state: "cancelled", retired_at: expect.any(String) });
    expect(inspected.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    inspected.close();
    close(value);
    const reopened = repository(filename);
    expect(reopened.getSession(direct.session.id).generation).toBe(2);
    const nextNonce = randomUUID();
    reopened.prepareMessage({ sessionId: direct.session.id, clientNonce: nextNonce, text: "Fresh start" });
    expect(reopened.listTranscript(direct.session.id)).toMatchObject([{ generation: 2, seq: 1, body: "Fresh start" }]);
    const nextRun = startRuntime(reopened, reopened.getSession(direct.session.id), direct.bot.id, nextNonce);
    expect(() => reopened.prepareToolInvocation({ runtimeRunId: nextRun.id, toolCallId: "replayed", idempotencyKey: tool.invocation.idempotencyKey,
      tool: { kind: "web-search", query: "changed command", maxResults: 1 } }))
      .toThrowError(expect.objectContaining({ code: "TOOL_IDEMPOTENCY_CONFLICT" }));
  });

  it("refuses active runtime, outstanding approval, queued send and routine work without changing history", () => {
    const value = repository();
    const direct = value.createBot();
    const command = { sessionId: direct.session.id, clientNonce: randomUUID(), text: "Read a file" };
    value.prepareMessage(command);
    const assertBusy = () => {
      const before = value.listTranscript(direct.session.id);
      expect(() => value.clearConversation(direct.session.id)).toThrowError(expect.objectContaining({ code: "CONVERSATION_BUSY" }));
      expect(value.listTranscript(direct.session.id)).toEqual(before);
      expect(value.getSession(direct.session.id).generation).toBe(1);
    };
    assertBusy();
    const run = startRuntime(value, direct.session, direct.bot.id, command.clientNonce);
    assertBusy();
    const tool = value.prepareToolInvocation({ runtimeRunId: run.id, toolCallId: "read", idempotencyKey: randomUUID(),
      tool: { kind: "web-search", query: "test", maxResults: 1 } });
    value.transitionRuntimeRun(run.id, "completed");
    assertBusy();
    value.resolveToolApproval(tool.approval.id, tool.approval.version, "deny");
    const routine = value.createRoutine({ name: "Scheduled", prompt: "Check", botId: direct.bot.id,
      schedule: { type: "interval", everyMinutes: 30, anchorAt: Date.now() }, enabled: true, nextRunAt: null });
    const pending = value.createRoutineRun(routine, "manual", randomUUID(), Date.now());
    assertBusy();
    value.transitionRoutineRun(pending.id, "cancelled");
    expect(value.clearConversation(direct.session.id).generation).toBe(2);
    expect(value.getRoutine(routine.id)).toEqual(routine);
  });

  it("clears a stopped room with parent turns and handoffs without deleting members or their direct history", () => {
    const filename = databaseFile();
    const value = repository(filename);
    const bots = [value.createBot(), value.createBot()];
    const room = value.createRoom({ memberBotIds: bots.map(({ bot }) => bot.id) });
    value.prepareMessage({ sessionId: bots[0]!.session.id, clientNonce: randomUUID(), text: "Direct remains" });
    const input = { roomId: room.room.id, sessionId: room.session.id, clientNonce: randomUUID(), text: "Coordinate",
      membershipVersion: room.room.membershipVersion, maxTurns: 8, maxHops: 3, maxTargetsPerTurn: 2,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(), initialTurns: [{ agentId: bots[0]!.bot.id, nonce: randomUUID() }] };
    const prepared = value.createRoomRunWithInitialTurns(input);
    expect(() => value.clearConversation(room.session.id)).toThrowError(expect.objectContaining({ code: "CONVERSATION_BUSY" }));
    value.transitionRoomRun(prepared.run.id, "running");
    value.transitionAgentTurn(prepared.turns[0]!.id, "running", { promptCutoffSeq: 1 });
    const handoff = value.createHandoff({ runId: prepared.run.id, fromTurnId: prepared.turns[0]!.id,
      toAgentId: bots[1]!.bot.id, task: "Review", contextRefs: [], visibility: "room", targetTurnNonce: randomUUID(),
      inputGeneration: 1, inputSeq: 1 });
    expect(handoff.targetTurn.parentTurnId).toBe(prepared.turns[0]!.id);
    value.transitionRoomRun(prepared.run.id, "cancelled");
    expect(() => value.clearConversation(room.session.id)).toThrowError(expect.objectContaining({ code: "CONVERSATION_BUSY" }));
    value.transitionAgentTurn(prepared.turns[0]!.id, "cancelled", { outcome: { kind: "cancelled" } });
    value.transitionHandoff(handoff.handoff.id, "dispatching", handoff.handoff.version);
    expect(() => value.clearConversation(room.session.id)).toThrowError(expect.objectContaining({ code: "CONVERSATION_BUSY" }));
    value.transitionHandoff(handoff.handoff.id, "cancelled");
    value.transitionAgentTurn(handoff.targetTurn.id, "cancelled", { outcome: { kind: "cancelled" } });
    const injector = new DatabaseSync(filename);
    injector.exec("CREATE TRIGGER reject_clear BEFORE DELETE ON transcript_entries BEGIN SELECT RAISE(ABORT, 'fixture'); END;");
    expect(() => value.clearConversation(room.session.id)).toThrow();
    expect(value.getSession(room.session.id).generation).toBe(1);
    expect(value.getRoomRun(prepared.run.id).state).toBe("cancelled");
    expect(value.getRoomTurn(handoff.targetTurn.id).parentTurnId).toBe(prepared.turns[0]!.id);
    expect(value.listTranscript(room.session.id)).toHaveLength(1);
    injector.exec("DROP TRIGGER reject_clear");
    injector.close();
    const cleared = value.clearConversation(room.session.id);
    expect(cleared.generation).toBe(2);
    expect(value.getRoom(room.room.id)).toEqual(room.room);
    expect(value.listRoomMembers(room.room.id)).toEqual(room.members);
    expect(value.listTranscript(bots[0]!.session.id)).toHaveLength(1);
    expect(value.listTranscript(room.session.id)).toEqual([]);
    expect(() => value.createRoomRunWithInitialTurns(input)).toThrowError(expect.objectContaining({ code: "MESSAGE_RETRY_UNSAFE" }));
    const inspected = new DatabaseSync(filename, { readOnly: true });
    for (const table of ["room_batches", "room_turns", "agent_handoffs", "handoff_rejections"]) {
      expect(inspected.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    expect(inspected.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    inspected.close();
  });
});
