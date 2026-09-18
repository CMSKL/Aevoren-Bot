import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { CreateHandoffInput, CreateRoomRunInput, PromptManifest, RoomDetail } from "@shared/contracts";
import { AppRepository, MIGRATIONS } from "./database";

const repositories: AppRepository[] = [];
const temporaryDirectories: string[] = [];

function repository(filename = ":memory:"): AppRepository {
  const value = new AppRepository(filename);
  repositories.push(value);
  return value;
}

function createBots(value: AppRepository, count: number) {
  return Array.from({ length: count }, (_, index) => {
    const created = value.createBot();
    return value.updateBot(created.bot.id, created.bot.version, { name: `Agent ${index + 1}` });
  });
}

function prepareRunInput(
  value: AppRepository,
  detail: RoomDetail,
  agentIds: string[],
): CreateRoomRunInput {
  const clientNonce = randomUUID();
  return {
    roomId: detail.room.id,
    sessionId: detail.session.id,
    clientNonce,
    text: "coordinate this task",
    membershipVersion: detail.room.membershipVersion,
    maxTurns: 8,
    maxHops: 3,
    maxTargetsPerTurn: 2,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    initialTurns: agentIds.map((agentId) => ({ agentId, nonce: randomUUID() })),
  };
}

function createRunFixture(value: AppRepository, initialCount = 1) {
  const bots = createBots(value, 3);
  const detail = value.createRoom({ memberBotIds: bots.slice(0, 2).map((bot) => bot.id) });
  const input = prepareRunInput(value, detail, bots.slice(0, initialCount).map((bot) => bot.id));
  const created = value.createRoomRunWithInitialTurns(input);
  return { bots, detail, input, ...created };
}

function startSourceTurn(value: AppRepository, runId: string, turnId: string): void {
  const run = value.getRoomRun(runId);
  if (run.state === "queued") value.transitionRoomRun(run.id, "running");
  const turn = value.getRoomTurn(turnId);
  if (turn.state === "queued") value.transitionAgentTurn(turn.id, "running", { promptCutoffSeq: turn.inputSeq });
}

function handoffInput(
  runId: string,
  fromTurnId: string,
  toAgentId: string,
  contextRef: string,
): CreateHandoffInput {
  return {
    runId,
    fromTurnId,
    toAgentId,
    task: "Review the proposed requirement",
    contextRefs: [contextRef],
    visibility: "room",
    targetTurnNonce: randomUUID(),
    inputGeneration: 1,
    inputSeq: 1,
  };
}

function createPopulatedV3Database(filename: string): void {
  const database = new DatabaseSync(filename);
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
  database.exec(MIGRATIONS[0].sql);
  database.prepare("INSERT INTO schema_migrations VALUES(1, 't')").run();
  database.exec(MIGRATIONS[1].sql);
  database.prepare("INSERT INTO schema_migrations VALUES(2, 't')").run();
  database.exec("PRAGMA foreign_keys = OFF;");
  database.exec(MIGRATIONS[2].sql);
  database.prepare("INSERT INTO schema_migrations VALUES(3, 't')").run();
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(`
    INSERT INTO bots VALUES('a','Agent A','','','','1','t','t');
    INSERT INTO bots VALUES('b','Agent B','','','','1','t','t');
    INSERT INTO rooms VALUES('room','Legacy room','kept',1,1,NULL,'t','t');
    INSERT INTO room_members VALUES('room','a',0,'t');
    INSERT INTO room_members VALUES('room','b',1,'t');
    INSERT INTO sessions VALUES('session',NULL,'room','MAIN',1,1,'t','t');
    INSERT INTO send_journal VALUES('nonce','session','digest','acked',0,NULL,NULL,'t','t');
    INSERT INTO transcript_entries VALUES(
      'message','session',1,1,'nonce','user','legacy body','completed',1,NULL,NULL,NULL,'t','t'
    );
    INSERT INTO room_batches VALUES('run','room','session','nonce','targets','completed',1,2,'t','t','t');
    INSERT INTO app_settings VALUES('legacy.setting','kept',0,'t');
  `);
  const manifest = JSON.stringify({
    schemaVersion: 2,
    botId: "a",
    profileVersion: 1,
    sessionId: "session",
    generation: 1,
    inputSeq: 1,
    promptCutoffSeq: 1,
    roomId: "room",
    roomMembershipVersion: 1,
    executorBotId: "a",
    sourceTurnId: "turn",
    blocks: [],
    digest: "legacy",
  });
  const insertRun = database.prepare(
    `INSERT INTO runtime_runs(
       id, session_id, client_nonce, execution_key, executor_bot_id, attempt_no, state, route,
       input_generation, input_seq, prompt_cutoff_seq, assistant_entry_id, provider_request_id,
       prompt_manifest_json, version, last_error_code, created_at, accepted_at, last_activity_at, finished_at
     ) VALUES (?, 'session', 'nonce', 'run:a', 'a', ?, 'completed', 'fake', 1, 1, 1,
       NULL, NULL, ?, 1, NULL, 't', 't', 't', 't')`,
  );
  insertRun.run("legacy-runtime-1", 1, manifest);
  insertRun.run("legacy-runtime-2", 2, manifest.replace('"sourceTurnId":"turn"', '"sourceTurnId":"turn-retry"'));
  database.exec(`
    INSERT INTO room_turns VALUES('turn','run','a','Agent A',0,1,3,'completed','legacy-runtime-1',1,NULL,'t','t','t');
    INSERT INTO room_turns VALUES('turn-retry','run','a','Agent A',0,2,1,'completed','legacy-runtime-2',1,NULL,'t','t','t');
  `);
  database.close();
}

function migrateFixtureThroughV4(filename: string): void {
  createPopulatedV3Database(filename);
  const database = new DatabaseSync(filename);
  database.exec("PRAGMA foreign_keys = OFF;");
  database.exec(MIGRATIONS[3].sql);
  database.prepare("INSERT INTO schema_migrations VALUES(4, 't')").run();
  database.exec("PRAGMA foreign_keys = ON;");
  database.close();
}

function migrateFixtureThroughV5(filename: string): void {
  migrateFixtureThroughV4(filename);
  const database = new DatabaseSync(filename);
  database.exec("PRAGMA foreign_keys = OFF;");
  database.exec(MIGRATIONS[4].sql);
  database.prepare("INSERT INTO schema_migrations VALUES(5, 't')").run();
  database.exec("PRAGMA foreign_keys = ON;");
  database.close();
}

function logicalV5Hash(database: DatabaseSync): string {
  const tables = [
    "bots", "sessions", "transcript_entries", "send_journal", "app_settings", "runtime_runs",
    "rooms", "room_members", "room_batches", "room_turns", "agent_handoffs",
  ];
  const snapshot = Object.fromEntries(tables.map((table) => {
    const columns = table === "bots"
      ? "id, name, label, description, instructions, version, created_at, updated_at"
      : table === "runtime_runs"
        ? "id, session_id, client_nonce, execution_key, executor_bot_id, attempt_no, state, route, input_generation, input_seq, prompt_cutoff_seq, assistant_entry_id, provider_request_id, prompt_manifest_json, version, last_error_code, created_at, accepted_at, last_activity_at, finished_at"
      : table === "rooms"
        ? "id, name, description, version, membership_version, archived_at, created_at, updated_at"
        : "*";
    const where = table === "app_settings" ? " WHERE key NOT LIKE 'provider.%'" : "";
    return [table, database.prepare(`SELECT ${columns} FROM ${table}${where} ORDER BY rowid`).all()];
  }));
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

afterEach(() => {
  while (repositories.length > 0) repositories.pop()?.close();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("multi-agent RoomRun journal", () => {
  it("migrates a populated v5 database to v6 without changing existing logical data", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-v6-rejection-migration-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    migrateFixtureThroughV5(filename);
    const before = new DatabaseSync(filename, { readOnly: true });
    const beforeHash = logicalV5Hash(before);
    before.close();

    const first = repository(filename);
    first.close();
    repositories.pop();
    const reopened = repository(filename);
    expect(reopened.listHandoffRejections("run")).toEqual([]);

    const inspected = new DatabaseSync(filename, { readOnly: true });
    expect(logicalV5Hash(inspected)).toBe(beforeHash);
    expect(inspected.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual(
      MIGRATIONS.map((migration) => ({ version: migration.version })),
    );
    expect(inspected.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(inspected.prepare("PRAGMA table_info(handoff_rejections)").all().map((column) => (
      column as { name: string }
    ).name)).toEqual([
      "id", "run_id", "from_turn_id", "attempted_to_agent_id", "tool_call_key", "error_code", "created_at",
    ]);
    inspected.close();
  });

  it("rolls back v6 atomically when the rejection audit table already exists", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-v6-rejection-rollback-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    migrateFixtureThroughV5(filename);
    const blocker = new DatabaseSync(filename);
    const beforeHash = logicalV5Hash(blocker);
    blocker.exec("CREATE TABLE handoff_rejections(id TEXT PRIMARY KEY);");
    blocker.close();

    expect(() => new AppRepository(filename)).toThrow();
    const inspected = new DatabaseSync(filename, { readOnly: true });
    expect(logicalV5Hash(inspected)).toBe(beforeHash);
    expect(inspected.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 },
    ]);
    expect(inspected.prepare("PRAGMA table_info(handoff_rejections)").all().map((column) => (
      column as { name: string }
    ).name)).toEqual(["id"]);
    expect(inspected.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    inspected.close();
  });

  it("migrates populated v3 data once and preserves it across repeated opens", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-v4-migration-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    createPopulatedV3Database(filename);

    const first = repository(filename);
    expect(first.getRoom("room")).toMatchObject({ name: "Legacy room", description: "kept" });
    expect(first.getTranscriptEntry("message").body).toBe("legacy body");
    expect(first.getSetting("legacy.setting")).toEqual({ value: "kept", encrypted: false });
    expect(first.getRoomRun("run")).toMatchObject({
      triggerMessageId: "message",
      membershipVersion: 1,
      usedTurns: 1,
      windingDown: false,
      routingMode: "legacy",
      routingReason: null,
    });
    expect(first.getRoomTurn("turn")).toMatchObject({
      logicalTurnId: "turn",
      parentTurnId: null,
      nonce: "turn",
      hop: 0,
      origin: "initial",
      inputGeneration: 1,
      inputSeq: 1,
    });
    expect(first.getRoomTurn("turn-retry")).toMatchObject({
      logicalTurnId: "turn",
      parentTurnId: null,
      nonce: "turn-retry",
      origin: "retry",
      attemptNo: 2,
    });
    expect(first.getRuntimeRun("legacy-runtime-1").executionKey).toBe("run:turn");
    expect(first.getRuntimeRun("legacy-runtime-2").executionKey).toBe("run:turn");
    first.close();
    repositories.pop();

    const reopened = repository(filename);
    expect(reopened.getRoomRun("run").triggerMessageId).toBe("message");
    const inspected = new DatabaseSync(filename, { readOnly: true });
    expect(inspected.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual(
      MIGRATIONS.map((migration) => ({ version: migration.version })),
    );
    expect(inspected.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    inspected.close();
  });

  it("rolls back the complete v4 migration when its final table creation fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-v4-rollback-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    createPopulatedV3Database(filename);
    const blocker = new DatabaseSync(filename);
    blocker.exec("CREATE TABLE agent_handoffs(id TEXT PRIMARY KEY);");
    blocker.close();

    expect(() => new AppRepository(filename)).toThrow();
    const inspected = new DatabaseSync(filename, { readOnly: true });
    expect(inspected.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 1 }, { version: 2 }, { version: 3 },
    ]);
    expect(inspected.prepare("SELECT body FROM transcript_entries WHERE id = 'message'").get()).toEqual({ body: "legacy body" });
    expect(inspected.prepare("SELECT state FROM room_batches WHERE id = 'run'").get()).toEqual({ state: "completed" });
    expect(inspected.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE '%_v4'").get()).toEqual({ count: 0 });
    inspected.close();
  });

  it("rolls back the v5 shadow migration and keeps legacy routing truthful", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-v5-rollback-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    migrateFixtureThroughV4(filename);
    const blocker = new DatabaseSync(filename);
    blocker.exec("CREATE TABLE room_batches_v5(id TEXT PRIMARY KEY);");
    blocker.close();

    expect(() => new AppRepository(filename)).toThrow();
    const inspected = new DatabaseSync(filename, { readOnly: true });
    expect(inspected.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 1 }, { version: 2 }, { version: 3 }, { version: 4 },
    ]);
    expect(inspected.prepare("SELECT target_digest, state FROM room_batches WHERE id = 'run'").get()).toEqual({
      target_digest: "targets",
      state: "completed",
    });
    expect(inspected.prepare("PRAGMA table_info(room_batches)").all().some((column) => (
      (column as { name: string }).name === "routing_mode"
    ))).toBe(false);
    inspected.close();
  });

  it("enforces routing mode and reason consistency in SQLite", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-v5-routing-check-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    const value = repository(filename);
    const bots = createBots(value, 2);
    const detail = value.createRoom({ memberBotIds: bots.map((bot) => bot.id) });
    const automatic = value.createRoomRunWithInitialTurns({
      ...prepareRunInput(value, detail, [bots[0]!.id]),
      routingMode: "automatic",
      routingReason: "确定性选择",
    });
    value.close();
    repositories.pop();

    const database = new DatabaseSync(filename);
    expect(() => database.prepare("UPDATE room_batches SET routing_reason = NULL WHERE id = ?").run(automatic.run.id)).toThrow();
    expect(() => database.prepare("UPDATE room_batches SET routing_mode = 'explicit' WHERE id = ?").run(automatic.run.id)).toThrow();
    expect(() => database.prepare("UPDATE room_batches SET routing_reason = ? WHERE id = ?").run("x".repeat(241), automatic.run.id)).toThrow();
    expect(database.prepare("SELECT routing_mode, routing_reason FROM room_batches WHERE id = ?").get(automatic.run.id)).toEqual({
      routing_mode: "automatic",
      routing_reason: "确定性选择",
    });
    database.close();
  });

  it("fails closed and rolls back v4 when legacy Turns share one Runtime", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-v4-runtime-duplicate-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    createPopulatedV3Database(filename);
    const legacy = new DatabaseSync(filename);
    legacy.prepare("UPDATE room_turns SET runtime_run_id = 'legacy-runtime-1'").run();
    legacy.close();

    expect(() => new AppRepository(filename)).toThrow();
    const inspected = new DatabaseSync(filename, { readOnly: true });
    expect(inspected.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 1 }, { version: 2 }, { version: 3 },
    ]);
    expect(inspected.prepare("SELECT runtime_run_id FROM room_turns ORDER BY attempt_no").all()).toEqual([
      { runtime_run_id: "legacy-runtime-1" },
      { runtime_run_id: "legacy-runtime-1" },
    ]);
    expect(inspected.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE '%_v4'").get()).toEqual({ count: 0 });
    inspected.close();
  });

  it("creates one root per trigger and deduplicates an identical root contract", () => {
    const value = repository();
    const fixture = createRunFixture(value, 2);
    expect(fixture.disposition).toBe("created");
    expect(fixture.run).toMatchObject({
      roomId: fixture.detail.room.id,
      triggerMessageId: fixture.run.triggerMessageId,
      membershipVersion: fixture.detail.room.membershipVersion,
      maxTurns: 8,
      usedTurns: 2,
      maxHops: 3,
      maxTargetsPerTurn: 2,
    });
    const duplicate = value.createRoomRunWithInitialTurns(fixture.input);
    expect(duplicate).toMatchObject({ disposition: "duplicate", run: { id: fixture.run.id } });
    expect(duplicate.turns.map((turn) => turn.id)).toEqual(fixture.turns.map((turn) => turn.id));
    expect(() => value.createRoomRunWithInitialTurns({ ...fixture.input, maxTurns: 9 })).toThrowError(
      expect.objectContaining({ code: "ROOM_RUN_CONFLICT" }),
    );
    expect(value.listRoomBatches(fixture.detail.room.id)).toHaveLength(1);
    expect(value.getSendOrThrow(fixture.input.clientNonce).state).toBe("acked");
    expect(value.getUserMessage(fixture.input.clientNonce)).toMatchObject({
      id: fixture.run.triggerMessageId,
      body: fixture.input.text,
      status: "completed",
    });
  });

  it("rejects an already-expired new root atomically but returns an existing duplicate first", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-root-deadline-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    const value = repository(filename);
    const bots = createBots(value, 2);
    const detail = value.createRoom({ memberBotIds: bots.map((bot) => bot.id) });
    const input = prepareRunInput(value, detail, [bots[0]!.id]);
    const expiredAt = "2000-01-01T00:00:00.000Z";
    expect(() => value.createRoomRunWithInitialTurns({ ...input, deadlineAt: expiredAt })).toThrowError(
      expect.objectContaining({ code: "ROOM_RUN_LIMIT_EXCEEDED", details: { reason: "deadline" } }),
    );
    expect(value.getSend(input.clientNonce)).toBeNull();
    expect(value.listTranscript(detail.session.id)).toHaveLength(0);
    expect(value.listRoomBatches(detail.room.id)).toHaveLength(0);

    const created = value.createRoomRunWithInitialTurns(input);
    const injector = new DatabaseSync(filename);
    injector.prepare("UPDATE room_batches SET deadline_at = ? WHERE id = ?").run(expiredAt, created.run.id);
    injector.close();
    expect(value.createRoomRunWithInitialTurns({ ...input, deadlineAt: expiredAt })).toMatchObject({
      disposition: "duplicate",
      run: { id: created.run.id },
    });
  });

  it("atomically journals and deduplicates a Handoff with its target AgentTurn", () => {
    const value = repository();
    const fixture = createRunFixture(value);
    const input = handoffInput(
      fixture.run.id,
      fixture.turns[0]!.id,
      fixture.bots[1]!.id,
      fixture.run.triggerMessageId,
    );
    startSourceTurn(value, fixture.run.id, fixture.turns[0]!.id);
    const created = value.createHandoff(input);
    expect(created).toMatchObject({
      disposition: "created",
      handoff: {
        runId: fixture.run.id,
        fromTurnId: fixture.turns[0]!.id,
        fromLogicalTurnId: fixture.turns[0]!.logicalTurnId,
        toAgentId: fixture.bots[1]!.id,
        targetTurnId: created.targetTurn.id,
        visibility: "room",
        state: "queued",
      },
      targetTurn: {
        runId: fixture.run.id,
        agentId: fixture.bots[1]!.id,
        parentTurnId: fixture.turns[0]!.id,
        nonce: input.targetTurnNonce,
        hop: 1,
        origin: "handoff",
      },
    });
    const duplicate = value.createHandoff(input);
    expect(duplicate).toMatchObject({
      disposition: "duplicate",
      handoff: { id: created.handoff.id },
      targetTurn: { id: created.targetTurn.id },
    });
    expect(value.listHandoffs(fixture.run.id)).toHaveLength(1);
    expect(value.listAgentTurns(fixture.run.id)).toHaveLength(2);

    expect(() => value.createHandoff({ ...input, task: "Different task with a reused target nonce" })).toThrowError(
      expect.objectContaining({ code: "HANDOFF_TARGET_CONFLICT" }),
    );
    expect(() => value.createHandoff({
      ...input,
      visibility: "direct",
      targetTurnNonce: randomUUID(),
    })).toThrowError(expect.objectContaining({ code: "HANDOFF_TARGET_CONFLICT" }));

    expect(() => value.createHandoff({ ...input, task: "Other", toAgentId: "missing" })).toThrowError(
      expect.objectContaining({ code: "BOT_NOT_FOUND" }),
    );
    expect(() => value.createHandoff({ ...input, task: "Other", toAgentId: fixture.bots[2]!.id })).toThrowError(
      expect.objectContaining({ code: "ROOM_MEMBER_INVALID" }),
    );
  });

  it("journals a Handoff rejection idempotently without storing provider task or raw tool-call content", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-handoff-rejection-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    const value = repository(filename);
    const fixture = createRunFixture(value);
    const input = {
      runId: fixture.run.id,
      fromTurnId: fixture.turns[0]!.id,
      attemptedToAgentId: fixture.bots[1]!.id,
      toolCallId: "RAW_TOOL_CALL_SECRET",
      errorCode: "HANDOFF_CYCLE",
    };
    const first = value.recordHandoffRejection(input);
    const duplicate = value.recordHandoffRejection(input);

    expect(first).toMatchObject({
      disposition: "created",
      rejection: {
        runId: fixture.run.id,
        fromTurnId: fixture.turns[0]!.id,
        attemptedToAgentId: fixture.bots[1]!.id,
        errorCode: "HANDOFF_CYCLE",
        toolCallKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(duplicate).toMatchObject({ disposition: "duplicate", rejection: { id: first.rejection.id } });
    expect(value.listHandoffRejections(fixture.run.id)).toHaveLength(1);
    expect(JSON.stringify(value.listHandoffRejections(fixture.run.id))).not.toContain("RAW_TOOL_CALL_SECRET");

    value.close();
    repositories.pop();
    const reopened = repository(filename);
    expect(reopened.listHandoffRejections(fixture.run.id)).toEqual([first.rejection]);
    const database = new DatabaseSync(filename, { readOnly: true });
    expect(JSON.stringify(database.prepare("SELECT * FROM handoff_rejections").all())).not.toContain("RAW_TOOL_CALL_SECRET");
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  });

  it("enforces normalized Handoff task and context reference limits before writing", () => {
    const createCase = (fileBacked = false) => {
      let filename = ":memory:";
      if (fileBacked) {
        const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-handoff-input-limits-"));
        temporaryDirectories.push(directory);
        filename = join(directory, "app.sqlite");
      }
      const value = repository(filename);
      const fixture = createRunFixture(value);
      startSourceTurn(value, fixture.run.id, fixture.turns[0]!.id);
      return { filename, value, fixture };
    };
    const counts = (value: AppRepository, runId: string) => ({
      handoffs: value.listHandoffs(runId).length,
      turns: value.listAgentTurns(runId).length,
    });
    const expectInvalidWithoutWrites = (
      value: AppRepository,
      input: CreateHandoffInput,
    ) => {
      const before = counts(value, input.runId);
      expect(() => value.createHandoff(input)).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
      expect(counts(value, input.runId)).toEqual(before);
    };
    const createCompletedContextEntries = (value: AppRepository, sessionId: string, count: number) => (
      Array.from({ length: count }, (_, index) => {
        const entry = value.createAssistantEntry(sessionId);
        return value.updateTranscriptEntry(entry.id, `context ${index + 1}`, "completed");
      })
    );

    const maxTaskCase = createCase();
    const maxTask = "t".repeat(20_000);
    const maxTaskInput = {
      ...handoffInput(
        maxTaskCase.fixture.run.id,
        maxTaskCase.fixture.turns[0]!.id,
        maxTaskCase.fixture.bots[1]!.id,
        maxTaskCase.fixture.run.triggerMessageId,
      ),
      task: ` ${maxTask} `,
    };
    expect(maxTaskCase.value.createHandoff(maxTaskInput)).toMatchObject({
      disposition: "created",
      handoff: { task: maxTask },
    });

    const oversizedTaskCase = createCase();
    expectInvalidWithoutWrites(oversizedTaskCase.value, {
      ...handoffInput(
        oversizedTaskCase.fixture.run.id,
        oversizedTaskCase.fixture.turns[0]!.id,
        oversizedTaskCase.fixture.bots[1]!.id,
        oversizedTaskCase.fixture.run.triggerMessageId,
      ),
      task: ` ${"t".repeat(20_001)} `,
    });

    const maxRefsCase = createCase();
    const maxRefs = [
      maxRefsCase.fixture.run.triggerMessageId,
      ...createCompletedContextEntries(maxRefsCase.value, maxRefsCase.fixture.detail.session.id, 63).map((entry) => entry.id),
    ];
    expect(maxRefsCase.value.createHandoff({
      ...handoffInput(
        maxRefsCase.fixture.run.id,
        maxRefsCase.fixture.turns[0]!.id,
        maxRefsCase.fixture.bots[1]!.id,
        maxRefsCase.fixture.run.triggerMessageId,
      ),
      contextRefs: maxRefs,
      inputSeq: 64,
    })).toMatchObject({ disposition: "created", handoff: { contextRefs: maxRefs.toSorted() } });

    const oversizedRefsCase = createCase();
    const oversizedRefs = [
      oversizedRefsCase.fixture.run.triggerMessageId,
      ...createCompletedContextEntries(oversizedRefsCase.value, oversizedRefsCase.fixture.detail.session.id, 64).map((entry) => entry.id),
    ];
    expectInvalidWithoutWrites(oversizedRefsCase.value, {
      ...handoffInput(
        oversizedRefsCase.fixture.run.id,
        oversizedRefsCase.fixture.turns[0]!.id,
        oversizedRefsCase.fixture.bots[1]!.id,
        oversizedRefsCase.fixture.run.triggerMessageId,
      ),
      contextRefs: oversizedRefs,
      inputSeq: 65,
    });

    for (const length of [200, 201]) {
      const longRefCase = createCase(true);
      const created = longRefCase.value.createAssistantEntry(longRefCase.fixture.detail.session.id);
      longRefCase.value.updateTranscriptEntry(created.id, "long reference", "completed");
      const longRef = "r".repeat(length);
      const injector = new DatabaseSync(longRefCase.filename);
      injector.prepare("UPDATE transcript_entries SET id = ? WHERE id = ?").run(longRef, created.id);
      injector.close();
      const input = {
        ...handoffInput(
          longRefCase.fixture.run.id,
          longRefCase.fixture.turns[0]!.id,
          longRefCase.fixture.bots[1]!.id,
          longRefCase.fixture.run.triggerMessageId,
        ),
        contextRefs: [` ${longRef} `],
        inputSeq: 2,
      };
      if (length === 200) {
        expect(longRefCase.value.createHandoff(input)).toMatchObject({
          disposition: "created",
          handoff: { contextRefs: [longRef] },
        });
      } else {
        expectInvalidWithoutWrites(longRefCase.value, input);
      }
    }

    const duplicateAfterTrimCase = createCase();
    const duplicateRef = duplicateAfterTrimCase.fixture.run.triggerMessageId;
    expectInvalidWithoutWrites(duplicateAfterTrimCase.value, {
      ...handoffInput(
        duplicateAfterTrimCase.fixture.run.id,
        duplicateAfterTrimCase.fixture.turns[0]!.id,
        duplicateAfterTrimCase.fixture.bots[1]!.id,
        duplicateRef,
      ),
      contextRefs: [duplicateRef, ` ${duplicateRef} `],
    });
    expectInvalidWithoutWrites(duplicateAfterTrimCase.value, {
      ...handoffInput(
        duplicateAfterTrimCase.fixture.run.id,
        duplicateAfterTrimCase.fixture.turns[0]!.id,
        duplicateAfterTrimCase.fixture.bots[1]!.id,
        duplicateRef,
      ),
      contextRefs: [1] as unknown as string[],
    });
  });

  it("deduplicates and conflicts by logical source when the source Turn is retried", () => {
    const value = repository();
    const fixture = createRunFixture(value);
    startSourceTurn(value, fixture.run.id, fixture.turns[0]!.id);
    const input = handoffInput(
      fixture.run.id,
      fixture.turns[0]!.id,
      fixture.bots[1]!.id,
      fixture.run.triggerMessageId,
    );
    const original = value.createHandoff(input);
    value.transitionAgentTurn(fixture.turns[0]!.id, "failed", { outcome: { kind: "error" } });
    value.transitionAgentTurn(original.targetTurn.id, "cancelled", { outcome: { kind: "cancelled" } });
    value.transitionRoomRun(fixture.run.id, "partial");
    const retry = value.createRoomTurnRetry(fixture.turns[0]!.id);
    value.transitionAgentTurn(retry.id, "running", { promptCutoffSeq: 1 });

    const replay = { ...input, fromTurnId: retry.id, targetTurnNonce: randomUUID() };
    expect(value.createHandoff(replay)).toMatchObject({
      disposition: "duplicate",
      handoff: { id: original.handoff.id, fromTurnId: fixture.turns[0]!.id, fromLogicalTurnId: retry.logicalTurnId },
      targetTurn: { id: original.targetTurn.id },
    });
    expect(() => value.createHandoff({ ...replay, task: "Different task from source retry" })).toThrowError(
      expect.objectContaining({ code: "HANDOFF_TARGET_CONFLICT" }),
    );
    expect(value.listHandoffs(fixture.run.id)).toHaveLength(1);
    expect(value.listAgentTurns(fixture.run.id)).toHaveLength(3);
  });

  it("returns an existing Handoff idempotently but rejects new work from inactive or terminal Turns", () => {
    const value = repository();
    const fixture = createRunFixture(value);
    const input = handoffInput(
      fixture.run.id,
      fixture.turns[0]!.id,
      fixture.bots[1]!.id,
      fixture.run.triggerMessageId,
    );
    expect(() => value.createHandoff(input)).toThrowError(expect.objectContaining({ code: "RUNTIME_STATE_INVALID" }));
    expect(value.listHandoffs(fixture.run.id)).toHaveLength(0);

    startSourceTurn(value, fixture.run.id, fixture.turns[0]!.id);
    const created = value.createHandoff(input);
    value.transitionAgentTurn(fixture.turns[0]!.id, "completed", { outcome: { kind: "sent" } });
    expect(value.createHandoff({ ...input, targetTurnNonce: "", inputSeq: 0 })).toMatchObject({
      disposition: "duplicate",
      handoff: { id: created.handoff.id },
    });
    expect(() => value.createHandoff({
      ...input,
      task: "Late new task",
      toAgentId: fixture.bots[2]!.id,
      visibility: "direct",
      targetTurnNonce: randomUUID(),
    })).toThrowError(expect.objectContaining({ code: "RUNTIME_STATE_INVALID" }));
    expect(value.listHandoffs(fixture.run.id)).toHaveLength(1);
  });

  it("deletes a completed Handoff Room alone or inside a Room batch without violating the parent-turn foreign key", () => {
    const value = repository();
    const fixture = createRunFixture(value);
    const ordinary = value.createRoom({
      memberBotIds: fixture.bots.slice(0, 2).map((bot) => bot.id),
      name: "Ordinary room",
    });
    startSourceTurn(value, fixture.run.id, fixture.turns[0]!.id);
    const handoff = value.createHandoff(handoffInput(
      fixture.run.id,
      fixture.turns[0]!.id,
      fixture.bots[1]!.id,
      fixture.run.triggerMessageId,
    ));
    value.transitionAgentTurn(fixture.turns[0]!.id, "completed", { outcome: { kind: "sent" } });
    value.transitionAgentTurn(handoff.targetTurn.id, "cancelled", { outcome: { kind: "cancelled" } });
    value.transitionRoomRun(fixture.run.id, "completed");

    expect(value.deleteConversations({
      botIds: [],
      roomIds: [ordinary.room.id, fixture.detail.room.id],
    })).toEqual({
      bots: [],
      rooms: [{ id: ordinary.room.id }, { id: fixture.detail.room.id }],
    });
    expect(value.listRooms(true)).toEqual([]);
    expect(() => value.getRoom(fixture.detail.room.id)).toThrowError(expect.objectContaining({ code: "ROOM_NOT_FOUND" }));
  });

  it("rejects self Handoffs and same-digest cycles across retry and visibility changes", () => {
    const value = repository();
    const fixture = createRunFixture(value);
    startSourceTurn(value, fixture.run.id, fixture.turns[0]!.id);
    const base = handoffInput(
      fixture.run.id,
      fixture.turns[0]!.id,
      fixture.bots[1]!.id,
      fixture.run.triggerMessageId,
    );
    expect(() => value.createHandoff({ ...base, toAgentId: fixture.bots[0]!.id })).toThrowError(
      expect.objectContaining({ code: "HANDOFF_CYCLE" }),
    );
    const forward = value.createHandoff(base);
    value.transitionHandoff(forward.handoff.id, "dispatching");
    value.transitionHandoff(forward.handoff.id, "accepted");
    value.transitionAgentTurn(fixture.turns[0]!.id, "completed", { outcome: { kind: "sent" } });
    value.transitionAgentTurn(forward.targetTurn.id, "running", { promptCutoffSeq: 1 });
    value.transitionAgentTurn(forward.targetTurn.id, "failed", { outcome: { kind: "error" } });
    value.transitionRoomRun(fixture.run.id, "partial");
    const retry = value.createRoomTurnRetry(forward.targetTurn.id);
    value.transitionAgentTurn(retry.id, "running", { promptCutoffSeq: 1 });
    expect(() => value.createHandoff({
      ...base,
      fromTurnId: retry.id,
      toAgentId: fixture.bots[0]!.id,
      visibility: "direct",
      targetTurnNonce: randomUUID(),
    })).toThrowError(expect.objectContaining({ code: "HANDOFF_CYCLE" }));

    const back = value.createHandoff({
      ...base,
      fromTurnId: retry.id,
      toAgentId: fixture.bots[0]!.id,
      task: "A distinct follow-up task",
      visibility: "direct",
      targetTurnNonce: randomUUID(),
    });
    expect(back).toMatchObject({ disposition: "created", targetTurn: { agentId: fixture.bots[0]!.id, hop: 2 } });
    expect(value.listHandoffs(fixture.run.id)).toHaveLength(2);
  });

  it("rejects room-visible Handoffs after membership changes without falling back to another Agent", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-handoff-membership-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    const value = repository(filename);
    const fixture = createRunFixture(value);
    startSourceTurn(value, fixture.run.id, fixture.turns[0]!.id);
    const originalInput = handoffInput(
      fixture.run.id,
      fixture.turns[0]!.id,
      fixture.bots[1]!.id,
      fixture.run.triggerMessageId,
    );
    const original = value.createHandoff(originalInput);
    const injector = new DatabaseSync(filename);
    injector.prepare("DELETE FROM room_members WHERE room_id = ? AND bot_id = ?").run(
      fixture.detail.room.id,
      fixture.bots[1]!.id,
    );
    injector.prepare("UPDATE rooms SET membership_version = membership_version + 1 WHERE id = ?").run(fixture.detail.room.id);
    injector.close();

    expect(value.createHandoff(originalInput)).toMatchObject({
      disposition: "duplicate",
      handoff: { id: original.handoff.id },
    });
    expect(() => value.createHandoff(handoffInput(
      fixture.run.id,
      fixture.turns[0]!.id,
      fixture.bots[2]!.id,
      fixture.run.triggerMessageId,
    ))).toThrowError(expect.objectContaining({
      code: "ROOM_MEMBERSHIP_CONFLICT",
      details: { currentVersion: fixture.run.membershipVersion + 1 },
    }));
    const direct = value.createHandoff({
      ...handoffInput(
        fixture.run.id,
        fixture.turns[0]!.id,
        fixture.bots[2]!.id,
        fixture.run.triggerMessageId,
      ),
      visibility: "direct",
    });
    expect(direct).toMatchObject({ disposition: "created", targetTurn: { agentId: fixture.bots[2]!.id } });
    expect(value.listHandoffs(fixture.run.id)).toHaveLength(2);
    expect(value.listAgentTurns(fixture.run.id)).toHaveLength(3);
  });

  it("accepts only completed authority entries from the current Room cursor as Handoff context", () => {
    const value = repository();
    const fixture = createRunFixture(value);
    startSourceTurn(value, fixture.run.id, fixture.turns[0]!.id);
    const base = handoffInput(
      fixture.run.id,
      fixture.turns[0]!.id,
      fixture.bots[1]!.id,
      fixture.run.triggerMessageId,
    );

    const otherBot = value.createBot();
    const otherBotNonce = randomUUID();
    value.prepareMessage({ sessionId: otherBot.session.id, clientNonce: otherBotNonce, text: "private context" });
    value.acknowledgeUserMessage(otherBotNonce);
    expect(() => value.createHandoff({
      ...base,
      contextRefs: [value.getUserMessage(otherBotNonce).id],
    })).toThrowError(expect.objectContaining({ code: "HANDOFF_CONTEXT_INVALID" }));

    const otherRoomBots = createBots(value, 2);
    const otherRoom = value.createRoom({ memberBotIds: otherRoomBots.map((bot) => bot.id) });
    const otherRoot = value.createRoomRunWithInitialTurns(prepareRunInput(value, otherRoom, [otherRoomBots[0]!.id]));
    expect(() => value.createHandoff({
      ...base,
      contextRefs: [otherRoot.run.triggerMessageId],
    })).toThrowError(expect.objectContaining({ code: "HANDOFF_CONTEXT_INVALID" }));

    const pendingNonce = randomUUID();
    value.prepareMessage({ sessionId: fixture.detail.session.id, clientNonce: pendingNonce, text: "not authoritative yet" });
    const pending = value.getUserMessage(pendingNonce);
    expect(() => value.createHandoff({
      ...base,
      contextRefs: [],
      inputSeq: pending.seq,
    })).toThrowError(expect.objectContaining({ code: "HANDOFF_CONTEXT_INVALID" }));
    value.acknowledgeUserMessage(pendingNonce);
    expect(() => value.createHandoff({
      ...base,
      contextRefs: [pending.id],
      inputSeq: 1,
    })).toThrowError(expect.objectContaining({ code: "HANDOFF_CONTEXT_INVALID" }));

    expect(value.createHandoff({ ...base, contextRefs: [] })).toMatchObject({ disposition: "created" });
  });

  it("rejects cross-run Handoff sources without writing a target turn", () => {
    const value = repository();
    const first = createRunFixture(value);
    const otherBots = createBots(value, 2);
    const otherRoom = value.createRoom({ memberBotIds: otherBots.map((bot) => bot.id) });
    const otherInput = prepareRunInput(value, otherRoom, [otherBots[0]!.id]);
    const other = value.createRoomRunWithInitialTurns(otherInput);
    const before = value.listAgentTurns(first.run.id).length;
    expect(() => value.createHandoff({
      ...handoffInput(first.run.id, other.turns[0]!.id, first.bots[1]!.id, first.run.triggerMessageId),
      visibility: "direct",
    })).toThrowError(expect.objectContaining({ code: "AGENT_TURN_CONFLICT" }));
    expect(value.listAgentTurns(first.run.id)).toHaveLength(before);
    expect(value.listHandoffs(first.run.id)).toHaveLength(0);
  });

  it("keeps terminal RoomRun, AgentTurn and Handoff states immutable", () => {
    const value = repository();
    const fixture = createRunFixture(value);
    startSourceTurn(value, fixture.run.id, fixture.turns[0]!.id);
    const handoff = value.createHandoff(handoffInput(
      fixture.run.id,
      fixture.turns[0]!.id,
      fixture.bots[1]!.id,
      fixture.run.triggerMessageId,
    ));
    value.transitionHandoff(handoff.handoff.id, "dispatching");
    value.transitionHandoff(handoff.handoff.id, "accepted");
    expect(value.getHandoff(handoff.handoff.id)).toMatchObject({ state: "accepted" });
    expect(value.getHandoff(handoff.handoff.id).finishedAt).not.toBeNull();
    expect(() => value.transitionHandoff(handoff.handoff.id, "failed")).toThrowError(
      expect.objectContaining({ code: "RUNTIME_STATE_INVALID" }),
    );

    const terminalTurn = value.transitionAgentTurn(fixture.turns[0]!.id, "completed", {
      outcome: { kind: "pass", summary: "No Room message needed" },
    });
    expect(terminalTurn.outcome).toEqual({ kind: "pass", summary: "No Room message needed" });
    expect(value.getRoomRun(fixture.run.id).usedTurns).toBe(2);
    expect(() => value.transitionAgentTurn(fixture.turns[0]!.id, "failed", { outcome: { kind: "error" } })).toThrowError(
      expect.objectContaining({ code: "RUNTIME_STATE_INVALID" }),
    );

    value.transitionAgentTurn(handoff.targetTurn.id, "cancelled", { outcome: { kind: "cancelled" } });
    value.transitionRoomRun(fixture.run.id, "completed");
    expect(() => value.transitionRoomRun(fixture.run.id, "running")).toThrowError(
      expect.objectContaining({ code: "RUNTIME_STATE_INVALID" }),
    );
  });

  it("uses version CAS and enforces AgentTurn outcome-to-state mapping", () => {
    const value = repository();
    const fixture = createRunFixture(value);
    const runningRun = value.transitionRoomRun(fixture.run.id, "running", fixture.run.version);
    const runningTurn = value.transitionAgentTurn(fixture.turns[0]!.id, "running", {
      promptCutoffSeq: 1,
      expectedVersion: fixture.turns[0]!.version,
    });
    const handoff = value.createHandoff(handoffInput(
      fixture.run.id,
      fixture.turns[0]!.id,
      fixture.bots[1]!.id,
      fixture.run.triggerMessageId,
    ));

    expect(() => value.transitionAgentTurn(runningTurn.id, "completed", {
      outcome: { kind: "error" },
      expectedVersion: runningTurn.version,
    })).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(value.getRoomTurn(runningTurn.id)).toMatchObject({ state: "running", version: runningTurn.version });
    expect(() => value.transitionAgentTurn(runningTurn.id, "completed", {
      outcome: { kind: "sent" },
      expectedVersion: fixture.turns[0]!.version,
    })).toThrowError(expect.objectContaining({ code: "RUNTIME_STATE_INVALID" }));
    const completedTurn = value.transitionAgentTurn(runningTurn.id, "completed", {
      outcome: { kind: "sent" },
      expectedVersion: runningTurn.version,
    });
    expect(completedTurn.outcome).toEqual({ kind: "sent" });

    const dispatching = value.transitionHandoff(handoff.handoff.id, "dispatching", handoff.handoff.version);
    expect(() => value.transitionHandoff(handoff.handoff.id, "accepted", handoff.handoff.version)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_STATE_INVALID" }),
    );
    const accepted = value.transitionHandoff(handoff.handoff.id, "accepted", dispatching.version);
    expect(() => value.transitionHandoff(handoff.handoff.id, "failed", accepted.version)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_STATE_INVALID" }),
    );

    expect(() => value.transitionRoomRun(fixture.run.id, "completed", fixture.run.version)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_STATE_INVALID" }),
    );
    expect(value.transitionRoomRun(fixture.run.id, "completed", runningRun.version).state).toBe("completed");
  });

  it("enforces deadline, hop, turn and fan-out limits before writing a Handoff", () => {
    const limitValue = repository();
    const turnBots = createBots(limitValue, 2);
    const turnRoom = limitValue.createRoom({ memberBotIds: turnBots.map((bot) => bot.id) });
    const turnInput = { ...prepareRunInput(limitValue, turnRoom, [turnBots[0]!.id]), maxTurns: 1 };
    const turnLimited = limitValue.createRoomRunWithInitialTurns(turnInput);
    startSourceTurn(limitValue, turnLimited.run.id, turnLimited.turns[0]!.id);
    expect(() => limitValue.createHandoff(handoffInput(
      turnLimited.run.id,
      turnLimited.turns[0]!.id,
      turnBots[1]!.id,
      turnLimited.run.triggerMessageId,
    ))).toThrowError(expect.objectContaining({ code: "ROOM_RUN_LIMIT_EXCEEDED", details: { reason: "max-turns" } }));

    const hopBots = createBots(limitValue, 2);
    const hopRoom = limitValue.createRoom({ memberBotIds: hopBots.map((bot) => bot.id) });
    const hopInput = { ...prepareRunInput(limitValue, hopRoom, [hopBots[0]!.id]), maxHops: 0 };
    const hopLimited = limitValue.createRoomRunWithInitialTurns(hopInput);
    startSourceTurn(limitValue, hopLimited.run.id, hopLimited.turns[0]!.id);
    expect(() => limitValue.createHandoff(handoffInput(
      hopLimited.run.id,
      hopLimited.turns[0]!.id,
      hopBots[1]!.id,
      hopLimited.run.triggerMessageId,
    ))).toThrowError(expect.objectContaining({ code: "ROOM_RUN_LIMIT_EXCEEDED", details: { reason: "max-hops" } }));

    const fanoutValue = repository();
    const fanout = createRunFixture(fanoutValue);
    startSourceTurn(fanoutValue, fanout.run.id, fanout.turns[0]!.id);
    fanoutValue.createHandoff(handoffInput(
      fanout.run.id,
      fanout.turns[0]!.id,
      fanout.bots[1]!.id,
      fanout.run.triggerMessageId,
    ));
    const outside = fanout.bots[2]!;
    const thirdOutside = createBots(fanoutValue, 1)[0]!;
    const secondInput = {
      ...handoffInput(fanout.run.id, fanout.turns[0]!.id, outside.id, fanout.run.triggerMessageId),
      visibility: "direct" as const,
      task: "Independent check",
    };
    expect(fanoutValue.createHandoff(secondInput).disposition).toBe("created");
    expect(() => fanoutValue.createHandoff({
      ...secondInput,
      targetTurnNonce: randomUUID(),
      task: "A third target",
      toAgentId: thirdOutside.id,
    })).toThrowError(expect.objectContaining({ code: "ROOM_RUN_LIMIT_EXCEEDED", details: { reason: "max-targets-per-turn" } }));

    const deadlineDirectory = mkdtempSync(join(tmpdir(), "aevoren-bot-deadline-limit-"));
    temporaryDirectories.push(deadlineDirectory);
    const deadlineFilename = join(deadlineDirectory, "app.sqlite");
    const deadlineValue = repository(deadlineFilename);
    const deadlineBots = createBots(deadlineValue, 2);
    const deadlineRoom = deadlineValue.createRoom({ memberBotIds: deadlineBots.map((bot) => bot.id) });
    const deadlineInput = prepareRunInput(deadlineValue, deadlineRoom, [deadlineBots[0]!.id]);
    const expired = deadlineValue.createRoomRunWithInitialTurns(deadlineInput);
    startSourceTurn(deadlineValue, expired.run.id, expired.turns[0]!.id);
    const deadlineInjector = new DatabaseSync(deadlineFilename);
    deadlineInjector.prepare("UPDATE room_batches SET deadline_at = ? WHERE id = ?").run(
      "2000-01-01T00:00:00.000Z",
      expired.run.id,
    );
    deadlineInjector.close();
    expect(() => deadlineValue.createHandoff(handoffInput(
      expired.run.id,
      expired.turns[0]!.id,
      deadlineBots[1]!.id,
      expired.run.triggerMessageId,
    ))).toThrowError(expect.objectContaining({ code: "ROOM_RUN_LIMIT_EXCEEDED", details: { reason: "deadline" } }));

    const windingRoom = deadlineValue.createRoom({ memberBotIds: deadlineBots.map((bot) => bot.id), name: "Winding" });
    const windingInput = prepareRunInput(deadlineValue, windingRoom, [deadlineBots[0]!.id]);
    const winding = deadlineValue.createRoomRunWithInitialTurns(windingInput);
    startSourceTurn(deadlineValue, winding.run.id, winding.turns[0]!.id);
    const runningWinding = deadlineValue.getRoomRun(winding.run.id);
    expect(() => deadlineValue.markRoomRunWindingDown(winding.run.id, winding.run.version)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_STATE_INVALID" }),
    );
    const marked = deadlineValue.markRoomRunWindingDown(winding.run.id, runningWinding.version);
    expect(marked.windingDown).toBe(true);
    expect(deadlineValue.markRoomRunWindingDown(winding.run.id, winding.run.version).version).toBe(marked.version);
    expect(() => deadlineValue.createHandoff(handoffInput(
      winding.run.id,
      winding.turns[0]!.id,
      deadlineBots[1]!.id,
      winding.run.triggerMessageId,
    ))).toThrowError(expect.objectContaining({ code: "ROOM_RUN_LIMIT_EXCEEDED", details: { reason: "winding-down" } }));
  });

  it("preserves a logical AgentTurn across retries while assigning a fresh nonce", () => {
    const value = repository();
    const bots = createBots(value, 2);
    const detail = value.createRoom({ memberBotIds: bots.map((bot) => bot.id) });
    const prepared = value.prepareRoomMessage({
      roomId: detail.room.id,
      sessionId: detail.session.id,
      clientNonce: randomUUID(),
      text: "retry one logical turn",
      targetBotIds: bots.map((bot) => bot.id),
    });
    value.transitionRoomBatch(prepared.batch.id, "running");
    const turns = value.listRoomTurns(prepared.batch.id);
    value.transitionRoomTurn(turns[0]!.id, "running", { promptCutoffSeq: 1 });
    value.transitionRoomTurn(turns[0]!.id, "failed", { outcome: { kind: "error" } });
    value.transitionRoomTurn(turns[1]!.id, "cancelled", { outcome: { kind: "cancelled" } });
    value.finishRoomBatchFromTurns(prepared.batch.id);

    const retried = value.createRoomTurnRetry(turns[0]!.id);
    expect(retried).toMatchObject({ logicalTurnId: turns[0]!.logicalTurnId, attemptNo: 2, origin: "retry" });
    expect(retried.nonce).not.toBe(turns[0]!.nonce);
    expect(value.listAgentTurns(prepared.batch.id).filter((turn) => turn.logicalTurnId === turns[0]!.logicalTurnId)).toHaveLength(2);
    expect(value.getRoomRun(prepared.batch.id).usedTurns).toBe(2);
  });

  it("blocks retry and interrupted continuation after winding-down or deadline", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-hard-stop-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    const value = repository(filename);
    const windingBots = createBots(value, 2);
    const windingRoom = value.createRoom({ memberBotIds: windingBots.map((bot) => bot.id) });
    const windingInput = prepareRunInput(value, windingRoom, [windingBots[0]!.id]);
    const winding = value.createRoomRunWithInitialTurns(windingInput);
    startSourceTurn(value, winding.run.id, winding.turns[0]!.id);
    value.markRoomRunWindingDown(winding.run.id, value.getRoomRun(winding.run.id).version);
    value.transitionAgentTurn(winding.turns[0]!.id, "failed", { outcome: { kind: "error" } });
    value.transitionRoomRun(winding.run.id, "partial");
    expect(() => value.createRoomTurnRetry(winding.turns[0]!.id)).toThrowError(
      expect.objectContaining({ code: "ROOM_RUN_LIMIT_EXCEEDED", details: { reason: "winding-down" } }),
    );

    const expiredBots = createBots(value, 2);
    const expiredRoom = value.createRoom({ memberBotIds: expiredBots.map((bot) => bot.id) });
    const expiredInput = prepareRunInput(value, expiredRoom, [expiredBots[0]!.id]);
    const expired = value.createRoomRunWithInitialTurns(expiredInput);
    value.transitionRoomRun(expired.run.id, "running");
    value.transitionAgentTurn(expired.turns[0]!.id, "interrupted");
    value.transitionRoomRun(expired.run.id, "interrupted");
    const injector = new DatabaseSync(filename);
    injector.prepare("UPDATE room_batches SET deadline_at = ? WHERE id = ?").run(
      "2000-01-01T00:00:00.000Z",
      expired.run.id,
    );
    injector.close();
    expect(() => value.continueInterruptedRoomBatch(expired.run.id)).toThrowError(
      expect.objectContaining({ code: "ROOM_RUN_LIMIT_EXCEEDED", details: { reason: "deadline" } }),
    );
    expect(value.listAgentTurns(expired.run.id)).toHaveLength(1);
  });

  it("applies frozen membership to initial/room retries but preserves direct retry semantics atomically", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-retry-membership-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    const value = repository(filename);

    const changedBots = createBots(value, 3);
    const changedRoom = value.createRoom({ memberBotIds: changedBots.map((bot) => bot.id) });
    const changedInput = prepareRunInput(value, changedRoom, [changedBots[0]!.id]);
    const changed = value.createRoomRunWithInitialTurns(changedInput);
    startSourceTurn(value, changed.run.id, changed.turns[0]!.id);
    value.transitionAgentTurn(changed.turns[0]!.id, "failed", { outcome: { kind: "error" } });
    value.transitionRoomRun(changed.run.id, "partial");
    const changeInjector = new DatabaseSync(filename);
    changeInjector.prepare("DELETE FROM room_members WHERE room_id = ? AND bot_id = ?").run(
      changedRoom.room.id,
      changedBots[2]!.id,
    );
    changeInjector.prepare("UPDATE rooms SET membership_version = membership_version + 1 WHERE id = ?").run(changedRoom.room.id);
    changeInjector.close();
    expect(() => value.createRoomTurnRetry(changed.turns[0]!.id)).toThrowError(
      expect.objectContaining({ code: "ROOM_MEMBERSHIP_CONFLICT" }),
    );
    expect(value.listAgentTurns(changed.run.id)).toHaveLength(1);

    const directBots = createBots(value, 3);
    const directRoom = value.createRoom({ memberBotIds: directBots.slice(0, 2).map((bot) => bot.id) });
    const directInput = prepareRunInput(value, directRoom, [directBots[0]!.id]);
    const directRun = value.createRoomRunWithInitialTurns(directInput);
    startSourceTurn(value, directRun.run.id, directRun.turns[0]!.id);
    const direct = value.createHandoff({
      ...handoffInput(
        directRun.run.id,
        directRun.turns[0]!.id,
        directBots[2]!.id,
        directRun.run.triggerMessageId,
      ),
      visibility: "direct",
    });
    value.transitionAgentTurn(directRun.turns[0]!.id, "completed", { outcome: { kind: "sent" } });
    value.transitionAgentTurn(direct.targetTurn.id, "running", { promptCutoffSeq: 1 });
    value.transitionAgentTurn(direct.targetTurn.id, "failed", { outcome: { kind: "error" } });
    value.transitionRoomRun(directRun.run.id, "partial");
    const directInjector = new DatabaseSync(filename);
    directInjector.prepare("UPDATE rooms SET membership_version = membership_version + 1 WHERE id = ?").run(directRoom.room.id);
    directInjector.close();
    const directRetry = value.createRoomTurnRetry(direct.targetTurn.id);
    expect(directRetry).toMatchObject({ agentId: directBots[2]!.id, origin: "retry", logicalTurnId: direct.targetTurn.logicalTurnId });

    const atomicBots = createBots(value, 3);
    const atomicRoom = value.createRoom({ memberBotIds: atomicBots.slice(0, 2).map((bot) => bot.id) });
    const atomicInput = prepareRunInput(value, atomicRoom, [atomicBots[0]!.id]);
    const atomic = value.createRoomRunWithInitialTurns(atomicInput);
    startSourceTurn(value, atomic.run.id, atomic.turns[0]!.id);
    const roomTarget = value.createHandoff(handoffInput(
      atomic.run.id,
      atomic.turns[0]!.id,
      atomicBots[1]!.id,
      atomic.run.triggerMessageId,
    ));
    const directTarget = value.createHandoff({
      ...handoffInput(
        atomic.run.id,
        atomic.turns[0]!.id,
        atomicBots[2]!.id,
        atomic.run.triggerMessageId,
      ),
      task: "Direct parallel task",
      visibility: "direct",
    });
    value.transitionAgentTurn(atomic.turns[0]!.id, "completed", { outcome: { kind: "sent" } });
    value.transitionAgentTurn(roomTarget.targetTurn.id, "interrupted");
    value.transitionAgentTurn(directTarget.targetTurn.id, "interrupted");
    value.transitionRoomRun(atomic.run.id, "interrupted");
    const atomicInjector = new DatabaseSync(filename);
    atomicInjector.prepare("DELETE FROM room_members WHERE room_id = ? AND bot_id = ?").run(
      atomicRoom.room.id,
      atomicBots[1]!.id,
    );
    atomicInjector.prepare("UPDATE rooms SET membership_version = membership_version + 1 WHERE id = ?").run(atomicRoom.room.id);
    atomicInjector.close();
    const before = value.listAgentTurns(atomic.run.id).length;
    expect(() => value.continueInterruptedRoomBatch(atomic.run.id)).toThrowError(
      expect.objectContaining({ code: "ROOM_MEMBERSHIP_CONFLICT" }),
    );
    expect(value.listAgentTurns(atomic.run.id)).toHaveLength(before);
  });

  it("rejects a Runtime attachment outside the AgentTurn identity and execution scope", () => {
    const value = repository();
    const fixture = createRunFixture(value);
    const turn = fixture.turns[0]!;
    startSourceTurn(value, fixture.run.id, turn.id);
    const manifest: PromptManifest = {
      schemaVersion: 2,
      botId: turn.agentId,
      profileVersion: 1,
      sessionId: fixture.detail.session.id,
      generation: 1,
      inputSeq: 1,
      promptCutoffSeq: 1,
      roomId: fixture.detail.room.id,
      roomMembershipVersion: fixture.detail.room.membershipVersion,
      executorBotId: turn.agentId,
      sourceTurnId: turn.id,
      blocks: [],
      digest: "attach-scope",
    };
    const wrong = value.createRuntimeRun(fixture.run.clientNonce, "fake", manifest, {
      executorBotId: turn.agentId,
      executionKey: `${fixture.run.id}:wrong-logical-turn`,
      promptCutoffSeq: 1,
    });
    expect(() => value.attachRoomTurnRuntime(turn.id, wrong.id)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_STATE_INVALID" }),
    );
    value.transitionRuntimeRun(wrong.id, "failed");

    const wrongSource = value.createRuntimeRun(fixture.run.clientNonce, "fake", {
      ...manifest,
      sourceTurnId: "another-turn",
    }, {
      executorBotId: turn.agentId,
      executionKey: `${fixture.run.id}:${turn.logicalTurnId}`,
      promptCutoffSeq: 1,
    });
    expect(() => value.attachRoomTurnRuntime(turn.id, wrongSource.id)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_STATE_INVALID" }),
    );
    value.transitionRuntimeRun(wrongSource.id, "failed");

    const wrongScope = value.createRuntimeRun(fixture.run.clientNonce, "fake", {
      ...manifest,
      roomMembershipVersion: fixture.run.membershipVersion + 1,
    }, {
      executorBotId: turn.agentId,
      executionKey: `${fixture.run.id}:${turn.logicalTurnId}`,
      promptCutoffSeq: 1,
    });
    expect(() => value.attachRoomTurnRuntime(turn.id, wrongScope.id)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_STATE_INVALID" }),
    );
    value.transitionRuntimeRun(wrongScope.id, "failed");

    const wrongBot = value.createRuntimeRun(fixture.run.clientNonce, "fake", {
      ...manifest,
      botId: fixture.bots[1]!.id,
    }, {
      executorBotId: turn.agentId,
      executionKey: `${fixture.run.id}:${turn.logicalTurnId}`,
      promptCutoffSeq: 1,
    });
    expect(() => value.attachRoomTurnRuntime(turn.id, wrongBot.id)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_STATE_INVALID" }),
    );
    value.transitionRuntimeRun(wrongBot.id, "failed");

    const wrongCursor = value.createRuntimeRun(fixture.run.clientNonce, "fake", {
      ...manifest,
      promptCutoffSeq: 2,
    }, {
      executorBotId: turn.agentId,
      executionKey: `${fixture.run.id}:${turn.logicalTurnId}`,
      promptCutoffSeq: 2,
    });
    expect(() => value.attachRoomTurnRuntime(turn.id, wrongCursor.id)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_STATE_INVALID" }),
    );
    value.transitionRuntimeRun(wrongCursor.id, "failed");

    const other = createRunFixture(value);
    startSourceTurn(value, other.run.id, other.turns[0]!.id);
    const otherTurn = other.turns[0]!;
    const crossSession = value.createRuntimeRun(other.run.clientNonce, "fake", {
      ...manifest,
      botId: otherTurn.agentId,
      sessionId: other.detail.session.id,
      roomId: other.detail.room.id,
      roomMembershipVersion: other.run.membershipVersion,
      executorBotId: otherTurn.agentId,
      sourceTurnId: otherTurn.id,
    }, {
      executorBotId: otherTurn.agentId,
      executionKey: `${other.run.id}:${otherTurn.logicalTurnId}`,
      promptCutoffSeq: 1,
    });
    expect(() => value.attachRoomTurnRuntime(turn.id, crossSession.id)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_STATE_INVALID" }),
    );
    value.transitionRuntimeRun(crossSession.id, "failed");

    const terminal = value.createRuntimeRun(fixture.run.clientNonce, "fake", manifest, {
      executorBotId: turn.agentId,
      executionKey: `${fixture.run.id}:${turn.logicalTurnId}`,
      promptCutoffSeq: 1,
    });
    value.transitionRuntimeRun(terminal.id, "failed");
    expect(() => value.attachRoomTurnRuntime(turn.id, terminal.id)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_STATE_INVALID" }),
    );

    const valid = value.createRuntimeRun(fixture.run.clientNonce, "fake", manifest, {
      executorBotId: turn.agentId,
      executionKey: `${fixture.run.id}:${turn.logicalTurnId}`,
      promptCutoffSeq: 1,
    });
    expect(value.attachRoomTurnRuntime(turn.id, valid.id).runtimeRunId).toBe(valid.id);
    expect(value.attachRoomTurnRuntime(turn.id, valid.id).runtimeRunId).toBe(valid.id);
    value.transitionRuntimeRun(valid.id, "failed");
    const replacement = value.createRuntimeRun(fixture.run.clientNonce, "fake", manifest, {
      executorBotId: turn.agentId,
      executionKey: `${fixture.run.id}:${turn.logicalTurnId}`,
      promptCutoffSeq: 1,
    });
    expect(() => value.attachRoomTurnRuntime(turn.id, replacement.id)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_STATE_INVALID" }),
    );
  });

  it("enforces one AgentTurn per Runtime at the database boundary", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-runtime-unique-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    const value = repository(filename);
    const fixture = createRunFixture(value, 2);
    value.transitionRoomRun(fixture.run.id, "running");
    const first = value.transitionAgentTurn(fixture.turns[0]!.id, "running", { promptCutoffSeq: 1 });
    const second = value.transitionAgentTurn(fixture.turns[1]!.id, "running", { promptCutoffSeq: 1 });
    const manifest: PromptManifest = {
      schemaVersion: 2,
      botId: first.agentId,
      profileVersion: 1,
      sessionId: fixture.detail.session.id,
      generation: 1,
      inputSeq: 1,
      promptCutoffSeq: 1,
      roomId: fixture.detail.room.id,
      roomMembershipVersion: fixture.run.membershipVersion,
      executorBotId: first.agentId,
      sourceTurnId: first.id,
      blocks: [],
      digest: "runtime-unique",
    };
    const runtime = value.createRuntimeRun(fixture.run.clientNonce, "fake", manifest, {
      executorBotId: first.agentId,
      executionKey: `${fixture.run.id}:${first.logicalTurnId}`,
      promptCutoffSeq: 1,
    });
    value.attachRoomTurnRuntime(first.id, runtime.id);

    const injector = new DatabaseSync(filename);
    expect(() => injector.prepare("UPDATE room_turns SET runtime_run_id = ? WHERE id = ?").run(runtime.id, second.id)).toThrow();
    injector.close();
    expect(value.getRoomTurn(first.id).runtimeRunId).toBe(runtime.id);
    expect(value.getRoomTurn(second.id).runtimeRunId).toBeNull();
  });

  it("rolls back every initial AgentTurn when root creation fails midway", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-room-run-rollback-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    const value = repository(filename);
    const bots = createBots(value, 2);
    const detail = value.createRoom({ memberBotIds: bots.map((bot) => bot.id) });
    const input = prepareRunInput(value, detail, bots.map((bot) => bot.id));
    const injector = new DatabaseSync(filename);
    injector.exec(`
      CREATE TRIGGER reject_second_initial BEFORE INSERT ON room_turns
      WHEN (SELECT COUNT(*) FROM room_turns WHERE batch_id = NEW.batch_id) > 0
      BEGIN SELECT RAISE(ABORT, 'test'); END;
    `);
    injector.close();

    expect(() => value.createRoomRunWithInitialTurns(input)).toThrow();
    const inspected = new DatabaseSync(filename, { readOnly: true });
    expect(inspected.prepare("SELECT COUNT(*) AS count FROM send_journal WHERE client_nonce = ?").get(input.clientNonce)).toEqual({ count: 0 });
    expect(inspected.prepare("SELECT COUNT(*) AS count FROM transcript_entries WHERE client_nonce = ?").get(input.clientNonce)).toEqual({ count: 0 });
    expect(inspected.prepare("SELECT COUNT(*) AS count FROM room_batches").get()).toEqual({ count: 0 });
    expect(inspected.prepare("SELECT COUNT(*) AS count FROM room_turns").get()).toEqual({ count: 0 });
    inspected.close();
  });

  it("rolls back the target AgentTurn when Handoff journaling fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-handoff-rollback-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    const value = repository(filename);
    const fixture = createRunFixture(value);
    const input = handoffInput(
      fixture.run.id,
      fixture.turns[0]!.id,
      fixture.bots[1]!.id,
      fixture.run.triggerMessageId,
    );
    startSourceTurn(value, fixture.run.id, fixture.turns[0]!.id);
    const injector = new DatabaseSync(filename);
    injector.exec("CREATE TRIGGER reject_handoff BEFORE INSERT ON agent_handoffs BEGIN SELECT RAISE(ABORT, 'test'); END;");
    injector.close();

    expect(() => value.createHandoff(input)).toThrow();
    expect(value.listAgentTurns(fixture.run.id)).toHaveLength(1);
    expect(value.listHandoffs(fixture.run.id)).toHaveLength(0);
  });

  it("restores the complete RoomRun, AgentTurn and Handoff journal after reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-journal-reopen-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    const value = repository(filename);
    const fixture = createRunFixture(value);
    startSourceTurn(value, fixture.run.id, fixture.turns[0]!.id);
    const handoff = value.createHandoff(handoffInput(
      fixture.run.id,
      fixture.turns[0]!.id,
      fixture.bots[1]!.id,
      fixture.run.triggerMessageId,
    ));
    value.transitionHandoff(handoff.handoff.id, "dispatching");
    value.close();
    repositories.pop();

    const reopened = repository(filename);
    expect(reopened.getRoomRun(fixture.run.id)).toMatchObject({ state: "running", usedTurns: 2 });
    expect(reopened.getRoomTurn(fixture.turns[0]!.id)).toMatchObject({ state: "running", logicalTurnId: fixture.turns[0]!.id });
    expect(reopened.getRoomTurn(handoff.targetTurn.id)).toMatchObject({ parentTurnId: fixture.turns[0]!.id, state: "queued" });
    expect(reopened.getHandoff(handoff.handoff.id)).toMatchObject({ state: "dispatching", targetTurnId: handoff.targetTurn.id });
  });
});
