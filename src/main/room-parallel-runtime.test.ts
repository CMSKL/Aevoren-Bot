import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { PromptManifest, RoomTurn } from "@shared/contracts";
import { AppRepository } from "./database";

const repositories: AppRepository[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (repositories.length > 0) repositories.pop()?.close();
  while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

function fixture(routingMode: "everyone" | "explicit" = "everyone", orchestrationEnabled = false, filename = ":memory:") {
  const repository = new AppRepository(filename);
  repositories.push(repository);
  const bots = Array.from({ length: 6 }, () => repository.createBot().bot);
  const detail = repository.createRoom({ memberBotIds: bots.map((bot) => bot.id) });
  const created = repository.createRoomRunWithInitialTurns({
    roomId: detail.room.id,
    sessionId: detail.session.id,
    clientNonce: crypto.randomUUID(),
    text: "所有成员独立回答",
    membershipVersion: detail.room.membershipVersion,
    maxTurns: 8,
    maxHops: 6,
    maxTargetsPerTurn: 2,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    initialTurns: bots.map((bot) => ({ agentId: bot.id, nonce: crypto.randomUUID() })),
    routingMode,
    orchestrationEnabled,
  });
  repository.transitionRoomBatch(created.run.id, "running");
  return { repository, bots, detail, batch: created.run, turns: created.turns };
}

type Fixture = ReturnType<typeof fixture>;
type RuntimeOptions = NonNullable<Parameters<AppRepository["createRuntimeRun"]>[3]>;

function storedFixture() {
  const directory = mkdtempSync(join(tmpdir(), "aevoren-parallel-runtime-"));
  temporaryDirectories.push(directory);
  const filename = join(directory, "app.sqlite");
  return { ...fixture("everyone", false, filename), filename };
}

function runtimeInput(f: Fixture, original: RoomTurn, dispatch = true) {
  const turn = f.repository.getRoomTurn(original.id);
  if (dispatch && turn.state === "queued") f.repository.transitionRoomTurn(turn.id, "running", { promptCutoffSeq: turn.inputSeq });
  const manifest: PromptManifest = {
    schemaVersion: 2,
    botId: turn.memberBotId,
    profileVersion: f.repository.getBot(turn.memberBotId).version,
    sessionId: f.detail.session.id,
    generation: turn.inputGeneration,
    inputSeq: turn.inputSeq,
    promptCutoffSeq: turn.inputSeq,
    roomId: f.detail.room.id,
    roomMembershipVersion: f.batch.membershipVersion,
    executorBotId: turn.memberBotId,
    sourceTurnId: turn.id,
    blocks: [],
    digest: "fixture",
  };
  const options: RuntimeOptions = {
    executorBotId: turn.memberBotId,
    executionKey: `${f.batch.id}:${turn.logicalTurnId}`,
    inputSeq: turn.inputSeq,
    promptCutoffSeq: turn.inputSeq,
  };
  return { manifest, options };
}

function start(f: Fixture, turn: RoomTurn, attach = true) {
  const { manifest, options } = runtimeInput(f, turn);
  const runtime = f.repository.createRuntimeRun(f.batch.clientNonce, "fake", manifest, options);
  if (attach) f.repository.attachRoomTurnRuntime(turn.id, runtime.id);
  return runtime;
}

describe("independent everyone runtime admission", () => {
  it("admits six bound members of one everyone batch before any member finishes", () => {
    const f = fixture();
    const runs = f.turns.map((turn) => start(f, turn));
    expect(runs).toHaveLength(6);
    expect(f.repository.listRuntimeRuns(f.detail.session.id).every((run) => run.state === "created")).toBe(true);
    expect(new Set(runs.map((run) => run.executionKey)).size).toBe(6);
    expect(f.repository.listRoomTurns(f.batch.id).map((turn) => turn.runtimeRunId)).toEqual(runs.map((run) => run.id));
  });

  it.each([
    ["explicit", false],
    ["everyone", true],
  ] as const)("keeps %s orchestration=%s exclusive", (routingMode, coordinated) => {
    const f = fixture(routingMode, coordinated);
    start(f, f.turns[0]!);
    expect(() => start(f, f.turns[1]!)).toThrowError(expect.objectContaining({ code: "SESSION_BUSY" }));
    expect(f.repository.listRuntimeRuns(f.detail.session.id)).toHaveLength(1);
  });

  it("does not admit a sibling until the previous runtime is bound to its real turn", () => {
    const f = fixture();
    start(f, f.turns[0]!, false);
    expect(() => start(f, f.turns[1]!)).toThrowError(expect.objectContaining({ code: "SESSION_BUSY" }));
  });

  it("validates every active sibling instead of trusting the first bound runtime", () => {
    const f = fixture();
    start(f, f.turns[0]!);
    start(f, f.turns[1]!, false);
    expect(() => start(f, f.turns[2]!)).toThrowError(expect.objectContaining({ code: "SESSION_BUSY" }));
    expect(f.repository.listRuntimeRuns(f.detail.session.id)).toHaveLength(2);
  });

  it("keeps the same member and logical execution exclusive through cancellation drain", () => {
    const f = fixture();
    const runtime = start(f, f.turns[0]!);
    f.repository.transitionRuntimeRun(runtime.id, "cancel-requested");
    expect(() => start(f, f.turns[0]!)).toThrowError(expect.objectContaining({ code: "SESSION_BUSY" }));
    start(f, f.turns[1]!);
    f.repository.transitionRoomBatch(f.batch.id, "cancelled");
    expect(() => start(f, f.turns[2]!)).toThrow();
    expect(f.repository.listRuntimeRuns(f.detail.session.id)).toHaveLength(2);
  });

  it.each([
    ["sourceTurnId", crypto.randomUUID()],
    ["sourceTurnId", undefined],
    ["sessionId", crypto.randomUUID()],
    ["roomId", crypto.randomUUID()],
    ["botId", crypto.randomUUID()],
    ["executorBotId", crypto.randomUUID()],
    ["generation", 2],
    ["inputSeq", 2],
    ["promptCutoffSeq", 2],
    ["roomMembershipVersion", 2],
    ["handoff", { id: "forged", fromAgentId: "forged", taskDigest: "forged", contextRefs: [], visibility: "room" }],
  ])("rejects a forged first member manifest %s before persisting a runtime", (field, value) => {
    const f = fixture();
    const { manifest, options } = runtimeInput(f, f.turns[0]!);
    expect(() => f.repository.createRuntimeRun(f.batch.clientNonce, "fake", { ...manifest, [field]: value }, options)).toThrow();
    expect(f.repository.listRuntimeRuns(f.detail.session.id)).toEqual([]);
  });

  it.each([
    ["executionKey", crypto.randomUUID()],
    ["inputSeq", 2],
    ["promptCutoffSeq", 2],
    ["executorBotId", "other"],
  ])("rejects a forged first member option %s", (field, value) => {
    const f = fixture();
    const { manifest, options } = runtimeInput(f, f.turns[0]!);
    expect(() => f.repository.createRuntimeRun(f.batch.clientNonce, "fake", manifest, { ...options, [field]: value })).toThrow();
    expect(f.repository.listRuntimeRuns(f.detail.session.id)).toEqual([]);
  });

  it("rejects dispatch from a queued turn", () => {
    const f = fixture();
    const { manifest, options } = runtimeInput(f, f.turns[0]!, false);
    expect(() => f.repository.createRuntimeRun(f.batch.clientNonce, "fake", manifest, options)).toThrow();
    expect(f.repository.listRuntimeRuns(f.detail.session.id)).toEqual([]);
  });

  it("rejects dispatch from a winding-down batch", () => {
    const f = fixture();
    const { manifest, options } = runtimeInput(f, f.turns[0]!);
    f.repository.markRoomRunWindingDown(f.batch.id);
    expect(() => f.repository.createRuntimeRun(f.batch.clientNonce, "fake", manifest, options)).toThrow();
    expect(f.repository.listRuntimeRuns(f.detail.session.id)).toEqual([]);
  });

  it.each([
    ["dependency_logical_turn_id", "dependency"],
    ["parent_turn_id", "parent"],
    ["origin", "handoff"],
    ["hop", 1],
  ])("does not parallelize a persisted dependent turn with %s", (column, value) => {
    const f = storedFixture();
    start(f, f.turns[0]!);
    const inspected = new DatabaseSync(f.filename);
    const actual = value === "dependency" ? f.turns[0]!.logicalTurnId : value === "parent" ? f.turns[0]!.id : value;
    inspected.prepare(`UPDATE room_turns SET ${column} = ? WHERE id = ?`).run(actual, f.turns[1]!.id);
    inspected.close();
    expect(() => start(f, f.turns[1]!)).toThrow();
    expect(f.repository.listRuntimeRuns(f.detail.session.id)).toHaveLength(1);
  });

  it("does not accept a forged active runtime as a sibling of a real turn", () => {
    const f = storedFixture();
    const runtime = start(f, f.turns[0]!);
    const inspected = new DatabaseSync(f.filename);
    inspected.prepare("UPDATE runtime_runs SET prompt_manifest_json = json_set(prompt_manifest_json, '$.sourceTurnId', ?) WHERE id = ?")
      .run(f.turns[1]!.id, runtime.id);
    inspected.close();
    expect(() => start(f, f.turns[1]!)).toThrowError(expect.objectContaining({ code: "SESSION_BUSY" }));
    expect(f.repository.listRuntimeRuns(f.detail.session.id)).toHaveLength(1);
  });

  it("keeps a previous cancelled batch locked while its runtime drains", () => {
    const f = fixture();
    const runtime = start(f, f.turns[0]!);
    f.repository.transitionRuntimeRun(runtime.id, "cancel-requested");
    f.repository.transitionRoomBatch(f.batch.id, "cancelled");
    expect(() => f.repository.createRoomRunWithInitialTurns({
      roomId: f.batch.roomId, sessionId: f.batch.sessionId, clientNonce: crypto.randomUUID(), text: "下一条消息",
      membershipVersion: f.batch.membershipVersion, maxTurns: 8, maxHops: 6, maxTargetsPerTurn: 2,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      initialTurns: f.bots.map((bot) => ({ agentId: bot.id, nonce: crypto.randomUUID() })),
      routingMode: "everyone", orchestrationEnabled: false,
    })).toThrowError(expect.objectContaining({ code: "ROOM_BATCH_BUSY" }));
  });

  it("admits retries of independent root turns without changing their execution key or cutoff", () => {
    const f = fixture();
    const originals = f.turns.map((turn) => start(f, turn));
    for (const [index, runtime] of originals.entries()) {
      f.repository.transitionRuntimeRun(runtime.id, "failed");
      f.repository.transitionRoomTurn(f.turns[index]!.id, "failed");
    }
    f.repository.finishRoomBatchFromTurns(f.batch.id);
    const retry = f.repository.createRoomTurnRetry(f.turns[0]!.id);
    const runtime = start(f, retry);
    expect(runtime).toMatchObject({ attemptNo: 2, executionKey: originals[0]!.executionKey, promptCutoffSeq: originals[0]!.promptCutoffSeq });
    expect(() => start(f, f.turns[0]!)).toThrowError(expect.objectContaining({ code: "SESSION_BUSY" }));
  });

  it.each(["room-first", "runtime-first"] as const)("recovers all parallel members and retries only one with %s recovery", (order) => {
    const f = storedFixture();
    const originals = f.turns.map((turn, index) => {
      const runtime = start(f, turn);
      f.repository.transitionRuntimeRun(runtime.id, "dispatching");
      f.repository.transitionRuntimeRun(runtime.id, "running", { providerRequestId: `member-${index}` });
      const entry = f.repository.createAssistantEntry(f.detail.session.id, {
        speakerBotId: turn.memberBotId, speakerNameSnapshot: turn.memberNameSnapshot, sourceTurnId: turn.id,
      });
      f.repository.attachAssistantEntry(runtime.id, entry.id);
      f.repository.updateTranscriptEntry(entry.id, `MEMBER_${index}_RESULT`, index === 0 ? "completed" : "streaming");
      if (index === 0) {
        f.repository.transitionRuntimeRun(runtime.id, "completed");
        f.repository.transitionRoomTurn(turn.id, "completed");
      } else {
        f.repository.transitionRuntimeRun(runtime.id, "streaming");
      }
      return { runtime, entry: f.repository.getTranscriptEntry(entry.id) };
    });
    f.repository.close();
    repositories.pop();
    const recovered = new AppRepository(f.filename);
    repositories.push(recovered);
    if (order === "room-first") {
      expect(recovered.recoverInterruptedRooms()).toBe(1);
      expect(recovered.recoverInterruptedRuntimeRuns()).toBe(5);
    } else {
      expect(recovered.recoverInterruptedRuntimeRuns()).toBe(5);
      expect(recovered.recoverInterruptedRooms()).toBe(1);
    }
    expect(recovered.getRoomBatch(f.batch.id).state).toBe("partial");
    expect(recovered.listRoomTurns(f.batch.id).map((turn) => turn.state))
      .toEqual(["completed", "interrupted", "interrupted", "interrupted", "interrupted", "interrupted"]);
    expect(recovered.listRuntimeRuns(f.detail.session.id).map((run) => run.state))
      .toEqual(["completed", "interrupted", "interrupted", "interrupted", "interrupted", "interrupted"]);
    expect(recovered.getTranscriptEntry(originals[0]!.entry.id)).toEqual(originals[0]!.entry);
    expect(originals.slice(1).map(({ entry }) => recovered.getTranscriptEntry(entry.id)))
      .toEqual(originals.slice(1).map(({ entry }) => expect.objectContaining({ body: entry.body, status: "failed", sourceTurnId: entry.sourceTurnId })));
    expect(() => recovered.continueInterruptedRoomBatch(f.batch.id))
      .toThrowError(expect.objectContaining({ code: "ROOM_TURN_RETRY_UNSAFE", details: { reason: "no-remaining" } }));
    expect(recovered.listRuntimeRuns(f.detail.session.id)).toHaveLength(6);

    const retry = recovered.createRoomTurnRetry(f.turns[3]!.id);
    const retried = start({ ...f, repository: recovered }, retry);
    expect(retried).toMatchObject({
      attemptNo: 2, executionKey: originals[3]!.runtime.executionKey,
      inputSeq: originals[3]!.runtime.inputSeq, promptCutoffSeq: originals[3]!.runtime.promptCutoffSeq,
    });
    recovered.transitionRuntimeRun(retried.id, "dispatching");
    recovered.transitionRuntimeRun(retried.id, "running");
    recovered.transitionRuntimeRun(retried.id, "completed");
    recovered.transitionRoomTurn(retry.id, "completed");
    recovered.finishRoomBatchFromTurns(f.batch.id);
    const attempts = recovered.listRuntimeRuns(f.detail.session.id);
    expect(f.turns.map((turn) => attempts.filter((run) => run.executorBotId === turn.memberBotId).length))
      .toEqual([1, 1, 1, 2, 1, 1]);
    expect(recovered.getTranscriptEntry(originals[0]!.entry.id)).toEqual(originals[0]!.entry);
    expect(recovered.getRoomBatch(f.batch.id).state).toBe("partial");
  });

  it("migrates the v32 active index without altering existing runtime or turn records", () => {
    const f = storedFixture();
    start(f, f.turns[0]!);
    f.repository.close();
    repositories.pop();
    const legacy = new DatabaseSync(f.filename);
    legacy.exec(`
      DROP INDEX runtime_one_active_per_executor;
      CREATE UNIQUE INDEX runtime_one_active_per_session ON runtime_runs(session_id)
        WHERE state IN ('created', 'dispatching', 'running', 'streaming', 'cancel-requested');
      DELETE FROM schema_migrations WHERE version = 33;
    `);
    const before = legacy.prepare("SELECT * FROM runtime_runs ORDER BY id").all();
    const turns = legacy.prepare("SELECT * FROM room_turns ORDER BY id").all();
    legacy.close();
    const migrated = new AppRepository(f.filename);
    repositories.push(migrated);
    const inspected = new DatabaseSync(f.filename, { readOnly: true });
    expect(inspected.prepare("SELECT * FROM runtime_runs ORDER BY id").all()).toEqual(before);
    expect(inspected.prepare("SELECT * FROM room_turns ORDER BY id").all()).toEqual(turns);
    expect(inspected.prepare("PRAGMA index_info(runtime_one_active_per_executor)").all().map((row) => row.name))
      .toEqual(["session_id", "executor_bot_id"]);
    expect(inspected.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(inspected.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 33 });
    inspected.close();
    start({ ...f, repository: migrated }, f.turns[1]!);
  });

  it("preserves ordinary direct-session exclusivity", () => {
    const f = fixture();
    const { bot, session } = f.repository.createBot();
    const clientNonce = crypto.randomUUID();
    f.repository.prepareMessage({ sessionId: session.id, clientNonce, text: "私聊" });
    const manifest: PromptManifest = { schemaVersion: 1, botId: bot.id, profileVersion: bot.version,
      sessionId: session.id, generation: session.generation, inputSeq: 1, blocks: [], digest: "direct" };
    f.repository.createRuntimeRun(clientNonce, "fake", manifest);
    expect(() => f.repository.createRuntimeRun(clientNonce, "fake", manifest)).toThrowError(expect.objectContaining({ code: "SESSION_BUSY" }));
  });
});
