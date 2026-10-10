import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_ID, type MemoryProposal, type Session, type ToolRequest } from "@shared/contracts";
import { AppRepository, MIGRATIONS } from "./database";

const repositories: AppRepository[] = [];
const directories: string[] = [];
function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "aevoren-session-scope-"));
  directories.push(root);
  return root;
}
function repository(filename = ":memory:"): AppRepository {
  const value = new AppRepository(filename);
  repositories.push(value);
  return value;
}
function workspace(value: AppRepository, name: string) {
  const root = join(folder(), name);
  mkdirSync(root);
  return value.registerWorkspaceRoot(root, name);
}
function message(value: AppRepository, sessionId: string, text = "Remember this") {
  const clientNonce = randomUUID();
  value.prepareMessage({ sessionId, clientNonce, text });
  return value.acknowledgeUserMessage(clientNonce);
}
function runtime(value: AppRepository, session: Session, botId: string, nonce = message(value, session.id).clientNonce!) {
  const input = value.getUserMessage(nonce);
  const run = value.createRuntimeRun(nonce, "fake", {
    schemaVersion: 1, botId, profileVersion: 1, sessionId: session.id, generation: session.generation,
    inputSeq: input.seq, blocks: [], digest: "session-scope-fixture",
  }, { executorBotId: botId });
  value.transitionRuntimeRun(run.id, "dispatching");
  value.transitionRuntimeRun(run.id, "running", { providerRequestId: "scope-test" });
  return run;
}
function setProject(value: AppRepository, sessionId: string, projectId: string | null) {
  return value.setConversationProject(sessionId, projectId, value.getConversation(sessionId).version);
}
function tool(value: AppRepository, runId: string, request: ToolRequest) {
  return value.prepareToolInvocation({ runtimeRunId: runId, toolCallId: randomUUID(), idempotencyKey: randomUUID(), tool: request });
}
function proposal(value: AppRepository, botId: string, sessionId: string, content: string, supersedesMemoryId?: string): MemoryProposal {
  return value.createMemoryProposal({ botId, scope: "bot", scopeKey: botId, kind: "preference", content,
    reason: "Explicit preference", sourceEntryId: message(value, sessionId).id, supersedesMemoryId })!;
}

function legacyFixture() {
  const filename = join(folder(), "legacy.sqlite");
  const db = new DatabaseSync(filename);
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  for (const migration of MIGRATIONS.filter((item) => item.version <= 29)) {
    const foreignKeysOff = "foreignKeysOff" in migration && migration.foreignKeysOff;
    if (foreignKeysOff) db.exec("PRAGMA foreign_keys = OFF");
    db.exec(migration.sql);
    db.prepare("INSERT INTO schema_migrations VALUES (?, '2026-01-01')").run(migration.version);
    if (foreignKeysOff) db.exec("PRAGMA foreign_keys = ON");
  }
  const ids = Object.fromEntries(["a", "b", "free", "lazy", "wa", "wb", "pa", "pb", "room", "sa", "sb", "sf", "sr", "memory", "lazyMemory"].map((name) => [name, randomUUID()])) as Record<string, string>;
  for (const key of ["a", "b"]) {
    const root = join(folder(), key);
    mkdirSync(root);
    db.prepare("INSERT INTO workspaces(id,name,canonical_root,canonical_root_digest,version,created_at,updated_at) VALUES (?,?,?,?,1,'t','t')")
      .run(ids[`w${key}`]!, key, root, "0".repeat(64));
    db.prepare("INSERT INTO projects(id,name,is_default,workspace_id,version,created_at,updated_at) VALUES (?,?,0,?,1,'t','t')")
      .run(ids[`p${key}`]!, key, ids[`w${key}`]!);
  }
  for (const key of ["a", "b", "free", "lazy"]) {
    db.prepare("INSERT INTO bots(id,project_id,name,label,description,instructions,version,created_at,updated_at) VALUES (?,?,?,'','','',1,'t','t')")
      .run(ids[key]!, key === "a" || key === "b" ? ids[`p${key}`]! : DEFAULT_PROJECT_ID, key);
  }
  db.prepare("INSERT INTO rooms(id,project_id,name,description,version,membership_version,created_at,updated_at) VALUES (?,?,'Old group','',1,1,'t','t')")
    .run(ids.room!, ids.pa!);
  for (const [position, key] of ["a", "b"].entries()) {
    db.prepare("INSERT INTO room_members(room_id,bot_id,position,created_at) VALUES (?,?,?,'t')").run(ids.room!, ids[key]!, position);
  }
  for (const key of ["a", "b", "free"]) {
    db.prepare("INSERT INTO sessions(id,bot_id,room_id,kind,generation,created_at,updated_at) VALUES (?,?,NULL,'MAIN',1,'t','t')")
      .run(ids[key === "free" ? "sf" : `s${key}`]!, ids[key]!);
  }
  db.prepare("INSERT INTO sessions(id,bot_id,room_id,kind,generation,created_at,updated_at) VALUES (?,NULL,?,'MAIN',1,'t','t')")
    .run(ids.sr!, ids.room!);
  for (const [botKey, memoryKey] of [["a", "memory"], ["lazy", "lazyMemory"]]) {
    const content = `Legacy ${botKey} memory`;
    db.prepare(`INSERT INTO memory_items(id,scope,scope_key,bot_id,content,content_digest,kind,source,version,created_at,updated_at)
      VALUES (?,'bot',?,?,?,?,'fact','manual-user',1,'t','t')`)
      .run(ids[memoryKey!]!, ids[botKey!]!, ids[botKey!]!, content, createHash("sha256").update(content).digest("hex"));
  }
  const memories = db.prepare("SELECT * FROM memory_items ORDER BY id").all();
  db.close();
  return { filename, ids, memories };
}

afterEach(() => {
  for (const value of repositories.splice(0)) value.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Session scope repository", () => {
  it("migrates finite folder and memory snapshots, including lazy legacy MAIN sessions, without changing old memories", () => {
    const { filename, ids, memories } = legacyFixture();
    const value = repository(filename);
    const readIds = (session: string, bot: string) => value.listSessionWorkspaces(session, bot).map((item) => item.id).toSorted();
    expect(readIds(ids.sa!, ids.a!)).toEqual([ids.wa!]);
    expect(readIds(ids.sr!, ids.b!)).toEqual([ids.wa!]);
    expect(readIds(ids.sf!, ids.free!)).toEqual([ids.wa!, ids.wb!].toSorted());
    workspace(value, "created after migration");
    expect(readIds(ids.sf!, ids.free!)).toEqual([ids.wa!, ids.wb!].toSorted());
    const lazy = value.getMainSession(ids.lazy!);
    expect(readIds(lazy.id, ids.lazy!)).toEqual([ids.wa!, ids.wb!].toSorted());
    expect(value.listRuntimeMemories(ids.lazy!, lazy.id).map((item) => item.id)).toEqual([ids.lazyMemory!]);
    expect(value.listRuntimeMemories(ids.a!, ids.sa!).map((item) => item.id)).toEqual([ids.memory!]);
    expect(value.listRuntimeMemories(ids.a!, ids.sr!).map((item) => item.id)).toEqual([ids.memory!]);
    const newRoom = value.createRoom({ memberBotIds: [ids.a!, ids.b!] });
    expect(value.listRuntimeMemories(ids.a!, newRoom.session.id)).toEqual([]);
    expect(value.listSessionWorkspaces(newRoom.session.id, ids.a!)).toEqual([]);
    const inspected = new DatabaseSync(filename, { readOnly: true });
    expect(inspected.prepare("SELECT * FROM memory_items ORDER BY id").all()).toEqual(memories);
    expect(inspected.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    inspected.close();
    const reopened = repository(filename);
    expect(reopened.listSessionWorkspaces(ids.sf!, ids.free!).map((item) => item.id).toSorted()).toEqual([ids.wa!, ids.wb!].toSorted());
    expect(reopened.listRuntimeMemories(ids.a!, newRoom.session.id)).toEqual([]);
  });

  it("keeps new and duplicated private chats empty and lets globally selected group members use only the group's explicit project", () => {
    const value = repository();
    const a = workspace(value, "A");
    const b = workspace(value, "B");
    const plain = value.createBot();
    const first = value.createBot(a.project.id);
    const second = value.createBot(b.project.id);
    const copy = value.duplicateBot(first.bot.id);
    for (const { bot, session } of [plain, copy]) {
      expect(value.getSessionProjectId(session.id)).toBeNull();
      expect(value.listSessionWorkspaces(session.id, bot.id)).toEqual([]);
    }
    expect(value.listSessionWorkspaces(first.session.id, first.bot.id).map((item) => item.id)).toEqual([a.workspace.id]);
    const noProject = value.createRoom({ memberBotIds: [first.bot.id, second.bot.id] });
    const group = value.createRoom({ memberBotIds: [first.bot.id, second.bot.id], projectId: b.project.id });
    expect(value.listSessionWorkspaces(noProject.session.id, first.bot.id)).toEqual([]);
    expect(value.listSessionWorkspaces(group.session.id, first.bot.id).map((item) => item.id)).toEqual([b.workspace.id]);
    expect(() => value.assertSessionWorkspaceAccess(group.session.id, first.bot.id, a.workspace.id)).toThrowError(expect.objectContaining({ code: "WORKSPACE_PATH_OUTSIDE_ROOT" }));
    expect(() => value.assertSessionExecutor(first.session.id, second.bot.id)).toThrow();
    const added = value.addRoomMember(group.room.id, plain.bot.id, group.room.membershipVersion);
    expect(value.listSessionWorkspaces(group.session.id, plain.bot.id).map((item) => item.id)).toEqual([b.workspace.id]);
    value.removeRoomMember(group.room.id, plain.bot.id, added.room.membershipVersion);
    expect(() => value.listSessionWorkspaces(group.session.id, plain.bot.id)).toThrow();
    value.setBotHidden(second.bot.id, true);
    expect(value.projectBotCatalog(first.bot.id, group.session.id).bots.map((bot) => bot.id)).toContain(second.bot.id);
  });

  it.each([undefined, DEFAULT_PROJECT_ID])("creates team directory grants only for an explicit project (%s) and preserves them on reuse", (projectId) => {
    const filename = join(folder(), "team.sqlite");
    const value = repository(filename);
    const root = folder();
    const registered = value.registerWorkspaceRoot(root, "Bound default project", DEFAULT_PROJECT_ID);
    const team = value.createContentTeamTemplate(projectId);
    expect(team.disposition).toBe("created");
    expect(team.room.room.projectId).toBe(DEFAULT_PROJECT_ID);
    const sessions = team.bots.map((bot) => ({ sessionId: value.getMainSession(bot.id).id, botId: bot.id }));
    sessions.push({ sessionId: team.room.session.id, botId: team.bots[0]!.id });
    for (const { sessionId, botId } of sessions) {
      expect(value.getSessionProjectId(sessionId)).toBe(projectId ?? null);
      expect(value.listSessionWorkspaces(sessionId, botId).map((item) => item.id))
        .toEqual(projectId ? [registered.workspace.id] : []);
    }
    const conversations = value.listConversations();
    // Preserve the existing default-template identity and its original grants;
    // opening it through either entry point is not a new authorization event.
    for (const entryProject of [undefined, DEFAULT_PROJECT_ID]) {
      const reused = value.createContentTeamTemplate(entryProject);
      expect(reused.disposition).toBe("existing");
      expect(reused.room.session.id).toBe(team.room.session.id);
      expect(reused.bots.map((bot) => bot.id)).toEqual(team.bots.map((bot) => bot.id));
      expect(value.listConversations()).toEqual(conversations);
      for (const { sessionId, botId } of sessions) {
        expect(value.listSessionWorkspaces(sessionId, botId).map((item) => item.id))
          .toEqual(projectId ? [registered.workspace.id] : []);
      }
    }
    const reopened = repository(filename);
    expect(reopened.createContentTeamTemplate().room.session.id).toBe(team.room.session.id);
    expect(reopened.listConversations()).toEqual(conversations);
  });

  it("replaces grants with CAS and only expands a legacy project when the user explicitly binds its folder", () => {
    const value = repository();
    const a = workspace(value, "A");
    const project = value.createProject("Unbound");
    const first = value.createBot(project.id);
    const plain = value.createBot();
    const initial = value.getConversation(first.session.id);
    expect(value.listSessionWorkspaces(first.session.id, first.bot.id)).toEqual([]);
    const bound = value.registerWorkspaceRoot(join(folder(), "bound"), "Bound", project.id);
    expect(value.listSessionWorkspaces(first.session.id, first.bot.id).map((item) => item.id)).toEqual([bound.workspace.id]);
    expect(value.listSessionWorkspaces(plain.session.id, plain.bot.id)).toEqual([]);
    expect(() => value.setConversationProject(first.session.id, a.project.id, initial.version))
      .toThrowError(expect.objectContaining({ code: "CONVERSATION_VERSION_CONFLICT" }));
    setProject(value, first.session.id, a.project.id);
    expect(value.listSessionWorkspaces(first.session.id, first.bot.id).map((item) => item.id)).toEqual([a.workspace.id]);
    setProject(value, first.session.id, null);
    expect(value.listSessionWorkspaces(first.session.id, first.bot.id)).toEqual([]);
    const nonce = randomUUID();
    value.prepareMessage({ sessionId: first.session.id, clientNonce: nonce, text: "Queued" });
    expect(() => setProject(value, first.session.id, a.project.id)).toThrowError(expect.objectContaining({ code: "CONVERSATION_BUSY" }));
    value.acknowledgeUserMessage(nonce);
    setProject(value, first.session.id, a.project.id);
    const run = runtime(value, first.session, first.bot.id);
    expect(() => setProject(value, first.session.id, null)).toThrowError(expect.objectContaining({ code: "CONVERSATION_BUSY" }));
    const prepared = tool(value, run.id, { kind: "workspace-read", workspaceId: a.workspace.id, path: "a.md", maxBytes: 100 });
    value.transitionRuntimeRun(run.id, "completed");
    expect(() => setProject(value, first.session.id, null)).toThrowError(expect.objectContaining({ code: "CONVERSATION_BUSY" }));
    value.resolveToolApproval(prepared.approval.id, prepared.approval.version, "deny");
    expect(setProject(value, first.session.id, null).projectId).toBeNull();
  });

  it("checks executor and current folder permissions at preparation, approval and dispatch", () => {
    const value = repository();
    const a = workspace(value, "A");
    const b = workspace(value, "B");
    const first = value.createBot(a.project.id);
    const outsider = value.createBot(b.project.id);
    const nonce = message(value, first.session.id).clientNonce!;
    expect(() => runtime(value, first.session, outsider.bot.id, nonce)).toThrow();
    const run = runtime(value, first.session, first.bot.id, nonce);
    expect(() => tool(value, run.id, { kind: "workspace-read", workspaceId: b.workspace.id, path: "b.md", maxBytes: 100 }))
      .toThrowError(expect.objectContaining({ code: "WORKSPACE_PATH_OUTSIDE_ROOT" }));
    const write = { kind: "workspace-write" as const, workspaceId: a.workspace.id, path: "a.md", content: "Hello" };
    expect(() => tool(value, run.id, write)).toThrowError(expect.objectContaining({ code: "WORKSPACE_WRITE_NOT_ENABLED" }));
    let current = value.updateWorkspacePermissions(a.workspace.id, a.workspace.version, { writeEnabled: true, automationEnabled: false });
    const pending = tool(value, run.id, write);
    current = value.updateWorkspacePermissions(a.workspace.id, current.version, { writeEnabled: false, automationEnabled: false });
    expect(() => value.resolveToolApproval(pending.approval.id, pending.approval.version, "allow-once"))
      .toThrowError(expect.objectContaining({ code: "WORKSPACE_WRITE_NOT_ENABLED" }));
    current = value.updateWorkspacePermissions(a.workspace.id, current.version, { writeEnabled: true, automationEnabled: false });
    value.resolveToolApproval(pending.approval.id, pending.approval.version, "allow-once");
    value.updateWorkspacePermissions(a.workspace.id, current.version, { writeEnabled: false, automationEnabled: false });
    expect(() => value.transitionToolInvocation(pending.invocation.id, "dispatching"))
      .toThrowError(expect.objectContaining({ code: "WORKSPACE_WRITE_NOT_ENABLED" }));
    expect(value.getToolInvocation(pending.invocation.id)).toMatchObject({ state: "approved", attemptCount: 0 });
    const pendingRead = tool(value, run.id, { kind: "workspace-read", workspaceId: a.workspace.id, path: "a.md", maxBytes: 100 });
    value.removeWorkspace(a.workspace.id, value.getWorkspace(a.workspace.id).version);
    expect(value.listSessionWorkspaces(first.session.id, first.bot.id)).toEqual([]);
    expect(() => value.resolveToolApproval(pendingRead.approval.id, pendingRead.approval.version, "allow-once"))
      .toThrowError(expect.objectContaining({ code: "WORKSPACE_NOT_FOUND" }));
    expect(value.resolveToolApproval(pendingRead.approval.id, pendingRead.approval.version, "deny").approval.state).toBe("denied");
  });

  it("blocks membership changes while a room has queued sends or unresolved tool work", () => {
    const value = repository();
    const bots = [value.createBot(), value.createBot(), value.createBot(), value.createBot()];
    const group = value.createRoom({ memberBotIds: bots.slice(0, 3).map(({ bot }) => bot.id) });
    const nonce = randomUUID();
    value.prepareMessage({ sessionId: group.session.id, clientNonce: nonce, text: "Queued in group" });
    const checkBusy = () => {
      expect(() => value.addRoomMember(group.room.id, bots[3]!.bot.id, group.room.membershipVersion))
        .toThrowError(expect.objectContaining({ code: "ROOM_BUSY" }));
      expect(() => value.removeRoomMember(group.room.id, bots[2]!.bot.id, group.room.membershipVersion))
        .toThrowError(expect.objectContaining({ code: "ROOM_BUSY" }));
    };
    checkBusy();
    value.acknowledgeUserMessage(nonce);
    const run = runtime(value, group.session, bots[0]!.bot.id, nonce);
    const pending = tool(value, run.id, { kind: "web-search", query: "scope fixture", maxResults: 1 });
    value.transitionRuntimeRun(run.id, "completed");
    checkBusy();
    value.resolveToolApproval(pending.approval.id, pending.approval.version, "allow-once");
    checkBusy();
    value.cancelToolInvocation(pending.invocation.id);
    expect(value.addRoomMember(group.room.id, bots[3]!.bot.id, group.room.membershipVersion).members).toHaveLength(4);
  });

  it("isolates Bot memories and proposal deduplication by source session and intersects workspace subscriptions with grants", () => {
    const value = repository();
    const a = workspace(value, "A");
    const b = workspace(value, "B");
    const first = value.createBot(a.project.id);
    const second = value.createBot();
    value.updateBot(first.bot.id, first.bot.version, { memoryWorkspaceIds: [a.workspace.id, b.workspace.id] });
    const groupA = value.createRoom({ memberBotIds: [first.bot.id, second.bot.id], projectId: a.project.id });
    const groupB = value.createRoom({ memberBotIds: [first.bot.id, second.bot.id], projectId: b.project.id });
    const manual = value.createMemory(first.bot.id, "Main only");
    const captured = value.createMemory(first.bot.id, "Group only", { source: "model-captured", sourceEntryId: message(value, groupA.session.id).id });
    const sharedUser = value.createScopedMemory({ scope: "user", scopeKey: "user" }, "Global preference");
    const memoryA = value.createScopedMemory({ scope: "workspace", scopeKey: a.workspace.id }, "A note");
    const memoryB = value.createScopedMemory({ scope: "workspace", scopeKey: b.workspace.id }, "B note");
    expect(value.listRuntimeMemories(first.bot.id).map((item) => item.id).toSorted()).toEqual([manual.id, sharedUser.id, memoryA.id].toSorted());
    expect(value.listRuntimeMemories(first.bot.id, groupA.session.id).map((item) => item.id).toSorted()).toEqual([captured.id, sharedUser.id, memoryA.id].toSorted());
    expect(value.listRuntimeMemories(first.bot.id, groupB.session.id).map((item) => item.id).toSorted()).toEqual([sharedUser.id, memoryB.id].toSorted());
    const pa = proposal(value, first.bot.id, groupA.session.id, "Same preference");
    expect(proposal(value, first.bot.id, groupA.session.id, "Same preference").id).toBe(pa.id);
    const pb = proposal(value, first.bot.id, groupB.session.id, "Same preference");
    expect(pb.id).not.toBe(pa.id);
    const acceptedA = value.acceptMemoryProposal(pa.id, pa.version).memory;
    const acceptedB = value.acceptMemoryProposal(pb.id, pb.version).memory;
    expect(acceptedA.id).not.toBe(acceptedB.id);
    expect(() => proposal(value, first.bot.id, groupB.session.id, "Replacement", captured.id)).toThrow();
    expect(() => value.createMemory(first.bot.id, "Wrong executor", { sourceEntryId: message(value, second.session.id).id })).toThrow();
    setProject(value, groupB.session.id, a.project.id);
    expect(value.getMemoryCaptureScopes(first.bot.id, groupB.session.id)).not.toContainEqual({ scope: "workspace", scopeKey: b.workspace.id });
    value.clearConversation(groupA.session.id);
    expect(value.listRuntimeMemories(first.bot.id, groupA.session.id).map((item) => item.id)).toContain(acceptedA.id);
    expect(value.listRuntimeMemories(first.bot.id, groupB.session.id).map((item) => item.id)).not.toContain(acceptedA.id);
  });

  it("replaces a shared legacy Bot memory only in the approving conversation", () => {
    const { filename, ids } = legacyFixture();
    const value = repository(filename);
    const proposed = proposal(value, ids.a!, ids.sr!, "Group-specific replacement", ids.memory!);
    const accepted = value.acceptMemoryProposal(proposed.id, proposed.version).memory;
    expect(value.getMemory(ids.memory!)).toMatchObject({ deletedAt: null, content: "Legacy a memory" });
    expect(value.listRuntimeMemories(ids.a!, ids.sa!).map((item) => item.id)).toEqual([ids.memory!]);
    expect(value.listRuntimeMemories(ids.a!, ids.sr!).map((item) => item.id)).toEqual([accepted.id]);
  });

  it("creates tools' resources in the invoking conversation context and never gives a new Bot implicit file access", () => {
    const value = repository();
    const a = workspace(value, "A");
    const b = workspace(value, "B");
    const first = value.createBot(a.project.id);
    const second = value.createBot();
    const group = value.createRoom({ memberBotIds: [first.bot.id, second.bot.id], projectId: b.project.id });
    const run = runtime(value, group.session, first.bot.id);
    const create = (request: ToolRequest) => {
      const prepared = tool(value, run.id, request);
      value.resolveToolApproval(prepared.approval.id, prepared.approval.version, "allow-once");
      value.transitionToolInvocation(prepared.invocation.id, "dispatching");
      value.transitionToolInvocation(prepared.invocation.id, "running");
      return value.executeProjectCreation(prepared.invocation.id);
    };
    const request = { kind: "bot-create" as const, name: "Scoped contact", label: "", description: "", instructions: "" };
    const created = create(request);
    const botId = String(created.invocation.resultMetadata?.resourceId);
    const session = value.getMainSession(botId);
    expect(created.invocation.resultMetadata?.projectId).toBe(b.project.id);
    expect(value.getSessionProjectId(session.id)).toBe(b.project.id);
    expect(value.listSessionWorkspaces(session.id, botId)).toEqual([]);
    expect(create(request).invocation.resultMetadata).toMatchObject({ resourceId: botId, reused: true });
    setProject(value, session.id, b.project.id);
    expect(value.listSessionWorkspaces(session.id, botId).map((item) => item.id)).toEqual([b.workspace.id]);
    const createdRoom = create({ kind: "room-create", name: "Mixed contacts", description: "", memberBotIds: [first.bot.id, botId] });
    const childRoom = value.getRoomDetail(String(createdRoom.invocation.resultMetadata?.resourceId));
    expect(value.listSessionWorkspaces(childRoom.session.id, first.bot.id).map((item) => item.id)).toEqual([b.workspace.id]);
    value.transitionRuntimeRun(run.id, "completed");
    setProject(value, group.session.id, a.project.id);
    expect(() => value.projectCreationResult(created.invocation.id)).toThrowError(expect.objectContaining({ code: "APPROVAL_SCOPE_INVALID" }));
  });

  it.each(["workspace-read", "workspace-write"] as const)("rejects %s evidence after project changes even when the original project is selected again", (kind) => {
    const value = repository();
    const a = workspace(value, "A");
    const b = workspace(value, "B");
    value.updateWorkspacePermissions(a.workspace.id, a.workspace.version, { writeEnabled: true, automationEnabled: false });
    const bots = [value.createBot(), value.createBot()];
    const room = value.createRoom({ memberBotIds: bots.map(({ bot }) => bot.id), projectId: a.project.id });
    const prepared = value.createRoomRunWithInitialTurns({ roomId: room.room.id, sessionId: room.session.id,
      clientNonce: randomUUID(), text: "Review project", membershipVersion: 1, maxTurns: 8, maxHops: 3, maxTargetsPerTurn: 2,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(), initialTurns: [{ agentId: bots[0]!.bot.id, nonce: randomUUID() }] });
    value.acknowledgeUserMessage(prepared.run.clientNonce);
    value.transitionRoomRun(prepared.run.id, "running");
    value.transitionRoomTurn(prepared.turns[0]!.id, "running", { promptCutoffSeq: 1 });
    const run = value.createRuntimeRun(prepared.run.clientNonce, "fake", {
      schemaVersion: 4, botId: bots[0]!.bot.id, profileVersion: 1, sessionId: room.session.id,
      generation: 1, inputSeq: 1, promptCutoffSeq: 1, roomId: room.room.id, roomMembershipVersion: 1,
      executorBotId: bots[0]!.bot.id, sourceTurnId: prepared.turns[0]!.id, blocks: [], digest: "scope-receipt-fixture",
    }, { executorBotId: bots[0]!.bot.id, executionKey: `${prepared.run.id}:${prepared.turns[0]!.logicalTurnId}` });
    value.attachRoomTurnRuntime(prepared.turns[0]!.id, run.id);
    value.transitionRuntimeRun(run.id, "dispatching");
    value.transitionRuntimeRun(run.id, "running", { providerRequestId: "scope-receipt-fixture" });
    const body = "Evidence fixture";
    const invocation = tool(value, run.id, kind === "workspace-read"
      ? { kind, workspaceId: a.workspace.id, path: "fixture.md", maxBytes: 100 }
      : { kind, workspaceId: a.workspace.id, path: "fixture.md", content: body });
    value.resolveToolApproval(invocation.approval.id, invocation.approval.version, "allow-once");
    value.transitionToolInvocation(invocation.invocation.id, "dispatching");
    value.transitionToolInvocation(invocation.invocation.id, "running");
    const sha256 = createHash("sha256").update(body).digest("hex");
    value.completeToolInvocation(invocation.invocation.id, sha256, { sha256, bytes: Buffer.byteLength(body) });
    const handoff = value.createHandoff({ runId: prepared.run.id, fromTurnId: prepared.turns[0]!.id,
      toAgentId: bots[1]!.bot.id, task: "Review", contextRefs: [], visibility: "room", targetTurnNonce: randomUUID(), inputGeneration: 1, inputSeq: 1 });
    const assistant = value.createAssistantEntry(room.session.id, { speakerBotId: bots[0]!.bot.id,
      speakerNameSnapshot: bots[0]!.bot.name, sourceTurnId: prepared.turns[0]!.id });
    value.attachAssistantEntry(run.id, assistant.id);
    value.updateTranscriptEntry(assistant.id, "Done", "completed");
    value.transitionRuntimeRun(run.id, "completed");
    value.transitionRoomTurn(prepared.turns[0]!.id, "completed", { outcome: { kind: "sent" } });
    const receipt = value.createExecutionEvidenceReceipt(handoff.targetTurn.id, run.id);
    expect(receipt.tools.map((item) => item.workspaceId)).toEqual([a.workspace.id]);
    value.transitionRoomTurn(handoff.targetTurn.id, "cancelled", { outcome: { kind: "cancelled" } });
    value.transitionRoomRun(prepared.run.id, "cancelled");
    setProject(value, room.session.id, b.project.id);
    expect(() => value.getExecutionEvidenceReceipt(handoff.targetTurn.id)).toThrowError(expect.objectContaining({ code: "HANDOFF_CONTEXT_INVALID" }));
    setProject(value, room.session.id, a.project.id);
    expect(() => value.getExecutionEvidenceReceipt(handoff.targetTurn.id)).toThrowError(expect.objectContaining({ code: "HANDOFF_CONTEXT_INVALID" }));
    if (kind === "workspace-write") expect(value.getCompletedWorkspaceArtifact(room.session.id, invocation.invocation.id)).toBeNull();
  });
});
