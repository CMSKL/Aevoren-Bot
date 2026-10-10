import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateRoomRunInput, RoomTurn } from "@shared/contracts";
import { AppRepository, MIGRATIONS } from "./database";

const repositories: AppRepository[] = [];
const directories: string[] = [];
function repository(filename = ":memory:") {
  const value = new AppRepository(filename);
  repositories.push(value);
  return value;
}
function fixture(overrides: Partial<CreateRoomRunInput> = {}, value = repository(), memberCount = 3) {
  const bots = Array.from({ length: memberCount }, () => value.createBot().bot);
  const detail = value.createRoom({ memberBotIds: bots.map((bot) => bot.id), leadBotId: bots[0]!.id });
  const input: CreateRoomRunInput = {
    roomId: detail.room.id, sessionId: detail.session.id, clientNonce: randomUUID(), text: "Read, then review the result",
    membershipVersion: detail.room.membershipVersion, routingMode: "automatic", routingReason: "fixed lead",
    maxTurns: 4, maxHops: 3, maxTargetsPerTurn: 2, deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    initialTurns: [{ agentId: bots[0]!.id, nonce: randomUUID() }], ...overrides,
  };
  const created = value.createRoomRunWithInitialTurns(input);
  value.transitionRoomRun(created.run.id, "running");
  const source = value.transitionRoomTurn(created.turns[0]!.id, "running", { promptCutoffSeq: created.turns[0]!.inputSeq });
  return { value, bots, detail, input, run: value.getRoomRun(created.run.id), source };
}
function plan(f: ReturnType<typeof fixture>, dependent = false) {
  return [
    { toAgentId: f.bots[1]!.id, task: "Read input", dependsOnPrevious: false },
    { toAgentId: f.bots[2]!.id, task: "Review output", dependsOnPrevious: dependent },
  ];
}
function accept(value: AppRepository, turn: RoomTurn) {
  const incoming = value.getIncomingHandoff(turn.id)!;
  value.transitionHandoff(incoming.id, "dispatching");
  value.transitionHandoff(incoming.id, "accepted");
}
function complete(value: AppRepository, turn: RoomTurn) {
  const current = value.getRoomTurn(turn.id);
  if (current.state === "queued") value.transitionRoomTurn(turn.id, "running", { promptCutoffSeq: current.inputSeq });
  return value.transitionRoomTurn(turn.id, "completed", { outcome: { kind: "sent" } });
}
function runtime(value: AppRepository, turn: RoomTurn, accepted = true) {
  const batch = value.getRoomRun(turn.runId);
  if (turn.state === "queued") value.transitionRoomTurn(turn.id, "running", { promptCutoffSeq: turn.inputSeq });
  const run = value.createRuntimeRun(batch.clientNonce, "fake", {
    schemaVersion: 4, botId: turn.agentId, profileVersion: 1, sessionId: batch.sessionId,
    generation: turn.inputGeneration, inputSeq: turn.inputSeq, promptCutoffSeq: turn.inputSeq,
    roomId: batch.roomId, roomMembershipVersion: batch.membershipVersion, executorBotId: turn.agentId,
    sourceTurnId: turn.id, blocks: [], digest: "lead-summary-fixture",
  }, { executorBotId: turn.agentId, executionKey: `${batch.id}:${turn.logicalTurnId}`, promptCutoffSeq: turn.inputSeq });
  value.attachRoomTurnRuntime(turn.id, run.id);
  value.transitionRuntimeRun(run.id, "dispatching");
  if (accepted) value.transitionRuntimeRun(run.id, "running", { providerRequestId: randomUUID() });
  const assistant = value.createAssistantEntry(batch.sessionId, {
    speakerBotId: turn.agentId, speakerNameSnapshot: turn.memberNameSnapshot, sourceTurnId: turn.id,
  });
  value.attachAssistantEntry(run.id, assistant.id);
  return {
    run, assistant,
    complete(body: string) {
      value.updateTranscriptEntry(assistant.id, body, "completed");
      value.transitionRuntimeRun(run.id, "completed");
      complete(value, turn);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const value of repositories.splice(0)) value.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("fixed lead room repository", () => {
  it("sets and clears unmet task requirements without changing another coordination error", () => {
    const f = fixture();
    const failed = f.value.setRoomTaskRequirementsMet(f.run.id, false);
    expect(failed.coordinationErrorCode).toBe("TASK_REQUIREMENTS_UNMET");
    expect(f.value.setRoomTaskRequirementsMet(f.run.id, false).version).toBe(failed.version);
    expect(f.value.setRoomTaskRequirementsMet(f.run.id, true).coordinationErrorCode).toBeNull();
    f.value.markRoomCoordinationFailed(f.run.id, "ROOM_LEAD_PLAN_INVALID");
    expect(f.value.setRoomTaskRequirementsMet(f.run.id, false).coordinationErrorCode).toBe("ROOM_LEAD_PLAN_INVALID");
    expect(f.value.setRoomTaskRequirementsMet(f.run.id, true).coordinationErrorCode).toBe("ROOM_LEAD_PLAN_INVALID");
  });

  it("migrates existing automatic runs and rooms without assigning a lead or changing old turns", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-lead-migration-"));
    directories.push(directory);
    const filename = join(directory, "app.sqlite");
    const legacy = new DatabaseSync(filename);
    legacy.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const migration of MIGRATIONS.filter((item) => item.version <= 30)) {
      const foreignKeysOff = "foreignKeysOff" in migration && migration.foreignKeysOff;
      if (foreignKeysOff) legacy.exec("PRAGMA foreign_keys = OFF");
      legacy.exec(migration.sql);
      legacy.prepare("INSERT INTO schema_migrations VALUES (?, 't')").run(migration.version);
      if (foreignKeysOff) legacy.exec("PRAGMA foreign_keys = ON");
    }
    legacy.exec(`
      INSERT INTO bots(id,name,label,description,instructions,version,created_at,updated_at)
        VALUES ('a','A','','','',1,'t','t'),('b','B','','','',1,'t','t');
      INSERT INTO rooms(id,name,description,version,membership_version,created_at,updated_at)
        VALUES ('room','Old','Original',1,1,'t','t');
      INSERT INTO room_members VALUES ('room','a',0,'t'),('room','b',1,'t');
      INSERT INTO sessions(id,bot_id,room_id,kind,generation,transcript_cursor,created_at,updated_at)
        VALUES ('session',NULL,'room','MAIN',1,1,'t','t');
      INSERT INTO send_journal VALUES ('nonce','session','digest','acked',0,NULL,NULL,'t','t');
      INSERT INTO transcript_entries(id,session_id,generation,seq,client_nonce,role,body,status,updated_seq,created_at,updated_at)
        VALUES ('message','session',1,1,'nonce','user','Original request','completed',1,'t','t');
      INSERT INTO room_batches(id,room_id,session_id,client_nonce,trigger_message_id,target_digest,routing_mode,routing_reason,
        state,membership_version,max_turns,max_hops,max_targets_per_turn,deadline_at,version,created_at,updated_at)
        VALUES ('run','room','session','nonce','message','digest','automatic','Old router','completed',1,8,3,2,'2099-01-01',1,'t','t');
      INSERT INTO room_turns(id,batch_id,member_bot_id,member_name_snapshot,logical_turn_id,nonce,hop,origin,
        input_generation,input_seq,position,attempt_no,version,state,created_at,updated_at)
        VALUES ('turn','run','a','A','turn','turn-nonce',0,'initial',1,1,0,1,1,'completed','t','t');
    `);
    legacy.close();
    const value = repository(filename);
    expect(value.getRoom("room")).toMatchObject({ leadBotId: null, description: "Original" });
    expect(value.getRoomRun("run")).toMatchObject({ leadBotId: null, summaryState: "not-required", routingMode: "automatic", state: "completed" });
    expect(value.getRoomTurn("turn")).toMatchObject({ turnPurpose: "work", dependencyLogicalTurnId: null, logicalTurnId: "turn" });
    expect(value.ensureLeadSummaryTurn("run")).toBeNull();
    expect(value.getTranscriptEntry("message").body).toBe("Original request");
  });

  it("validates lead membership, prevents busy changes, clears a removed lead and preserves run snapshots", () => {
    const f = fixture();
    expect(f.run).toMatchObject({ leadBotId: f.bots[0]!.id, summaryState: "pending" });
    expect(f.source.turnPurpose).toBe("coordinate");
    expect(() => f.value.updateRoom(f.detail.room.id, f.detail.room.version, { leadBotId: f.bots[1]!.id }))
      .toThrowError(expect.objectContaining({ code: "ROOM_BUSY" }));
    complete(f.value, f.source);
    complete(f.value, f.value.ensureLeadSummaryTurn(f.run.id)!);
    f.value.finishRoomBatchFromTurns(f.run.id);
    const outsider = f.value.createBot().bot;
    expect(() => f.value.updateRoom(f.detail.room.id, f.detail.room.version, { leadBotId: outsider.id }))
      .toThrowError(expect.objectContaining({ code: "ROOM_MEMBER_INVALID" }));
    expect(f.value.removeRoomMember(f.detail.room.id, f.bots[0]!.id, f.detail.room.membershipVersion).room.leadBotId).toBeNull();
    expect(f.value.getRoomRun(f.run.id).leadBotId).toBe(f.bots[0]!.id);
    expect(f.value.createRoomRunWithInitialTurns(f.input).disposition).toBe("duplicate");
  });

  it.each(["explicit", "everyone", "legacy"] as const)("keeps %s runs on work mode with no summary", (routingMode) => {
    const f = fixture({ routingMode, routingReason: undefined });
    expect(f.run).toMatchObject({ leadBotId: null, summaryState: "not-required" });
    expect(f.source.turnPurpose).toBe("work");
    complete(f.value, f.source);
    expect(f.value.ensureLeadSummaryTurn(f.run.id)).toBeNull();
    expect(f.value.finishRoomBatchFromTurns(f.run.id).state).toBe("completed");
  });

  it("clears a deleted contact's lead configuration", () => {
    const value = repository();
    const bots = Array.from({ length: 3 }, () => value.createBot().bot);
    const detail = value.createRoom({ memberBotIds: bots.map((bot) => bot.id), leadBotId: bots[0]!.id });
    value.deleteBot(bots[0]!.id);
    expect(value.getRoom(detail.room.id).leadBotId).toBeNull();
    expect(() => value.createRoom({ memberBotIds: bots.slice(1).map((bot) => bot.id), leadBotId: bots[0]!.id }))
      .toThrowError(expect.objectContaining({ code: "ROOM_MEMBER_INVALID" }));
  });

  it("creates an atomic bounded plan with stable nonces, exact retry deduplication and dependency checks", () => {
    const f = fixture();
    const assignments = plan(f, true);
    const turns = f.value.createLeadAssignments(f.run.id, f.source.id, assignments);
    expect(turns.map((turn) => turn.nonce)).toEqual([`lead-plan:${f.source.logicalTurnId}:0`, `lead-plan:${f.source.logicalTurnId}:1`]);
    expect(turns[1]!.dependencyLogicalTurnId).toBe(turns[0]!.logicalTurnId);
    expect(f.value.createLeadAssignments(f.run.id, f.source.id, assignments).map((turn) => turn.id)).toEqual(turns.map((turn) => turn.id));
    expect(() => f.value.createLeadAssignments(f.run.id, f.source.id, assignments.slice(0, 1)))
      .toThrowError(expect.objectContaining({ code: "AGENT_TURN_CONFLICT" }));
    expect(() => f.value.assertRoomTurnDispatchable(turns[1]!.id)).toThrowError(expect.objectContaining({ code: "ROOM_DEPENDENCY_FAILED" }));
    complete(f.value, turns[0]!);
    expect(f.value.assertRoomTurnDispatchable(turns[1]!.id).id).toBe(turns[1]!.id);
  });

  it("rolls back a partly valid plan, reserves the final budget slot, and rejects invalid dependency heads", () => {
    const f = fixture({ maxTurns: 3 });
    expect(() => f.value.createLeadAssignments(f.run.id, f.source.id, plan(f)))
      .toThrowError(expect.objectContaining({ code: "ROOM_RUN_LIMIT_EXCEEDED" }));
    expect(f.value.listRoomTurns(f.run.id)).toHaveLength(1);
    expect(f.value.listHandoffs(f.run.id)).toHaveLength(0);
    expect(() => f.value.createLeadAssignments(f.run.id, f.source.id, [{ ...plan(f)[0]!, dependsOnPrevious: true }]))
      .toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(f.value.createLeadAssignments(f.run.id, f.source.id, plan(f).slice(0, 1))).toHaveLength(1);
  });

  it("rejects a lead budget without room for summary and persists deadline skips", () => {
    expect(() => fixture({ maxTurns: 1 })).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    const f = fixture();
    complete(f.value, f.source);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(f.run.deadlineAt) + 1);
    expect(f.value.ensureLeadSummaryTurn(f.run.id)).toBeNull();
    expect(f.value.finishRoomBatchFromTurns(f.run.id)).toMatchObject({ state: "partial", summaryState: "skipped", summarySkipReason: "deadline" });
  });

  it("retains dependency failure as partial even when its final summary completes", () => {
    const f = fixture();
    const workers = f.value.createLeadAssignments(f.run.id, f.source.id, plan(f, true));
    complete(f.value, f.source);
    workers.forEach((turn) => accept(f.value, turn));
    f.value.transitionRoomTurn(workers[0]!.id, "running");
    f.value.transitionRoomTurn(workers[0]!.id, "failed", { errorCode: "MODEL_FAILED" });
    f.value.transitionRoomTurn(workers[1]!.id, "cancelled", { errorCode: "ROOM_DEPENDENCY_FAILED", outcome: { kind: "skipped", errorCode: "ROOM_DEPENDENCY_FAILED" } });
    complete(f.value, f.value.ensureLeadSummaryTurn(f.run.id)!);
    expect(f.value.finishRoomBatchFromTurns(f.run.id).state).toBe("partial");
    expect(f.value.getRoomRunSummary(f.run.id).results[2]).toMatchObject({ state: "cancelled", outcome: { kind: "skipped" }, errorCode: "ROOM_DEPENDENCY_FAILED" });
  });

  it("records an empty plan as a direct answer and rejects replacing it with another plan", () => {
    const f = fixture({ maxTurns: 2 });
    expect(f.value.createLeadAssignments(f.run.id, f.source.id, [])).toEqual([]);
    expect(() => f.value.createLeadAssignments(f.run.id, f.source.id, plan(f).slice(0, 1)))
      .toThrowError(expect.objectContaining({ code: "AGENT_TURN_CONFLICT" }));
    expect(f.value.getRoomRun(f.run.id)).toMatchObject({ leadBotId: f.bots[0]!.id, summaryState: "not-required" });
    complete(f.value, f.source);
    expect(f.value.ensureLeadSummaryTurn(f.run.id)).toBeNull();
    expect(f.value.finishRoomBatchFromTurns(f.run.id)).toMatchObject({ state: "completed", summaryState: "not-required", usedTurns: 1 });
    expect(f.value.listRoomTurns(f.run.id)).toHaveLength(1);
  });

  it("keeps an unplanned coordinate reply awaiting summary and an incomplete empty plan partial", () => {
    const unplanned = fixture();
    complete(unplanned.value, unplanned.source);
    expect(unplanned.value.finishRoomBatchFromTurns(unplanned.run.id).state).toBe("running");
    expect(unplanned.value.ensureLeadSummaryTurn(unplanned.run.id)!.turnPurpose).toBe("summary");
    const incomplete = fixture();
    incomplete.value.createLeadAssignments(incomplete.run.id, incomplete.source.id, []);
    incomplete.value.markRoomCoordinationFailed(incomplete.run.id, "ROOM_LEAD_PLAN_INVALID");
    complete(incomplete.value, incomplete.source);
    expect(incomplete.value.ensureLeadSummaryTurn(incomplete.run.id)).toBeNull();
    expect(incomplete.value.finishRoomBatchFromTurns(incomplete.run.id).state).toBe("partial");
  });

  it("restores pending on coordinate retry and reaccepts the immutable empty plan", () => {
    const f = fixture();
    f.value.createLeadAssignments(f.run.id, f.source.id, []);
    f.value.transitionRoomTurn(f.source.id, "failed", { errorCode: "MODEL_FAILED" });
    expect(f.value.finishRoomBatchFromTurns(f.run.id).state).toBe("partial");
    const retry = f.value.createRoomTurnRetry(f.source.id);
    expect(f.value.getRoomRun(f.run.id).summaryState).toBe("pending");
    f.value.transitionRoomTurn(retry.id, "running");
    expect(f.value.createLeadAssignments(f.run.id, retry.id, [])).toEqual([]);
    complete(f.value, retry);
    expect(f.value.ensureLeadSummaryTurn(f.run.id)).toBeNull();
    expect(f.value.finishRoomBatchFromTurns(f.run.id)).toMatchObject({ state: "completed", usedTurns: 1, summaryState: "not-required" });
  });

  it("recovers a completed direct answer without manufacturing a missing summary", () => {
    const f = fixture();
    f.value.createLeadAssignments(f.run.id, f.source.id, []);
    complete(f.value, f.source);
    f.value.recoverInterruptedRooms();
    expect(f.value.getRoomRun(f.run.id)).toMatchObject({ state: "completed", summaryState: "not-required" });
    expect(f.value.listRoomTurns(f.run.id)).toHaveLength(1);
  });

  it.each(["cancelled", "interrupted"] as const)("restores an identical plan's unstarted tasks after coordinate %s", (state) => {
    const f = fixture();
    const assignments = plan(f, true);
    const original = f.value.createLeadAssignments(f.run.id, f.source.id, assignments);
    if (state === "cancelled") {
      f.value.cancelOpenHandoffs(f.run.id);
      for (const turn of [f.source, ...original]) f.value.transitionRoomTurn(turn.id, "cancelled");
      f.value.transitionRoomRun(f.run.id, "cancelled");
    } else f.value.recoverInterruptedRooms();
    const sourceRetry = f.value.createRoomTurnRetry(f.source.id);
    f.value.transitionRoomTurn(sourceRetry.id, "running");
    expect(() => f.value.createLeadAssignments(f.run.id, f.source.id, assignments))
      .toThrowError(expect.objectContaining({ code: "RUNTIME_STATE_INVALID" }));
    const restored = f.value.createLeadAssignments(f.run.id, sourceRetry.id, assignments);
    expect(restored.map((turn) => turn.logicalTurnId)).toEqual(original.map((turn) => turn.logicalTurnId));
    expect(restored.map((turn) => [turn.state, turn.attemptNo, turn.runtimeRunId])).toEqual([["queued", 2, null], ["queued", 2, null]]);
    expect(restored[1]!.dependencyLogicalTurnId).toBe(original[0]!.logicalTurnId);
    expect(restored.map((turn) => turn.position)).toEqual(original.map((turn) => turn.position));
    expect(f.value.listHandoffs(f.run.id).every((handoff) => handoff.state === "cancelled")).toBe(true);
    expect(f.value.getIncomingHandoff(restored[1]!.id)!.task).toBe(assignments[1]!.task);
    expect(f.value.createLeadAssignments(f.run.id, sourceRetry.id, assignments).map((turn) => turn.id))
      .toEqual(restored.map((turn) => turn.id));
    expect(f.value.getRoomRun(f.run.id).usedTurns).toBe(3);
    complete(f.value, sourceRetry);
    for (const turn of restored) complete(f.value, turn);
    complete(f.value, f.value.ensureLeadSummaryTurn(f.run.id)!);
    expect(f.value.finishRoomBatchFromTurns(f.run.id)).toMatchObject({ state: "completed", usedTurns: 4 });
    expect(f.value.listRoomTurns(f.run.id).filter((turn) => turn.turnPurpose === "work" && turn.state === "completed")).toHaveLength(2);
  });

  it.each(["completed", "cancelled"] as const)("does not replay a %s worker that already had a runtime when restoring the plan", (state) => {
    const f = fixture();
    const assignments = plan(f);
    const original = f.value.createLeadAssignments(f.run.id, f.source.id, assignments);
    const attempted = runtime(f.value, original[0]!);
    if (state === "completed") attempted.complete("Already executed");
    else {
      f.value.transitionRuntimeRun(attempted.run.id, "cancel-requested");
      f.value.transitionRuntimeRun(attempted.run.id, "cancelled");
      f.value.updateTranscriptEntry(attempted.assistant.id, "", "cancelled");
      f.value.transitionRoomTurn(original[0]!.id, "cancelled");
    }
    f.value.recoverInterruptedRooms();
    const retry = f.value.createRoomTurnRetry(f.source.id);
    f.value.transitionRoomTurn(retry.id, "running");
    const restored = f.value.createLeadAssignments(f.run.id, retry.id, assignments);
    expect(restored[0]).toMatchObject({ id: original[0]!.id, state, runtimeRunId: attempted.run.id, attemptNo: 1 });
    expect(restored[1]).toMatchObject({ logicalTurnId: original[1]!.logicalTurnId, state: "queued", runtimeRunId: null, attemptNo: 2 });
    expect(f.value.listRoomTurns(f.run.id).filter((turn) => turn.logicalTurnId === original[0]!.logicalTurnId)).toHaveLength(1);
  });

  it("accepts a complete five-worker plan while keeping one target per source and reserving summary", () => {
    const f = fixture({ maxTurns: 8, maxHops: 6, maxTargetsPerTurn: 1 }, repository(), 6);
    const assignments = f.bots.slice(1).map((bot, index) => ({ toAgentId: bot.id, task: `Task ${index}`, dependsOnPrevious: false }));
    const workers = f.value.createLeadAssignments(f.run.id, f.source.id, assignments);
    expect(workers).toHaveLength(5);
    expect(workers.map((turn) => turn.hop)).toEqual([1, 2, 3, 4, 5]);
    expect(workers.map((turn) => turn.parentTurnId)).toEqual([f.source.id, ...workers.slice(0, -1).map((turn) => turn.id)]);
    expect(workers.every((turn) => turn.dependencyLogicalTurnId === null)).toBe(true);
    complete(f.value, f.source);
    workers.forEach((turn) => { accept(f.value, turn); complete(f.value, turn); });
    complete(f.value, f.value.ensureLeadSummaryTurn(f.run.id)!);
    expect(f.value.finishRoomBatchFromTurns(f.run.id)).toMatchObject({ state: "completed", usedTurns: 7 });
  });

  it("rejects an oversized complete plan atomically and restricts queued handoff sources to Host plans", () => {
    const f = fixture({ maxTurns: 8, maxHops: 1, maxTargetsPerTurn: 1 });
    expect(() => f.value.createLeadAssignments(f.run.id, f.source.id, plan(f)))
      .toThrowError(expect.objectContaining({ code: "ROOM_RUN_LIMIT_EXCEEDED" }));
    expect(f.value.listRoomTurns(f.run.id)).toHaveLength(1);
    const worker = f.value.createLeadAssignments(f.run.id, f.source.id, plan(f).slice(0, 1))[0]!;
    expect(() => f.value.createHandoff({ runId: f.run.id, fromTurnId: worker.id, toAgentId: f.bots[2]!.id,
      task: "Untrusted queued followup", contextRefs: [], visibility: "room", targetTurnNonce: randomUUID(), inputGeneration: 1, inputSeq: 1 }))
      .toThrowError(expect.objectContaining({ code: "RUNTIME_STATE_INVALID" }));
  });

  it("waits for all work and handoff journals before creating the only summary", () => {
    const f = fixture();
    const workers = f.value.createLeadAssignments(f.run.id, f.source.id, plan(f));
    complete(f.value, f.source);
    expect(f.value.ensureLeadSummaryTurn(f.run.id)).toBeNull();
    complete(f.value, workers[0]!);
    complete(f.value, workers[1]!);
    expect(f.value.ensureLeadSummaryTurn(f.run.id)).toBeNull();
    workers.forEach((turn) => accept(f.value, turn));
    const summary = f.value.ensureLeadSummaryTurn(f.run.id)!;
    expect(f.value.getRoomRun(f.run.id).usedTurns).toBe(4);
    expect(() => f.value.createHandoff({ runId: f.run.id, fromTurnId: summary.id, toAgentId: f.bots[1]!.id,
      task: "unexpected", contextRefs: [], visibility: "room", targetTurnNonce: randomUUID(), inputGeneration: 1, inputSeq: 1 }))
      .toThrowError(expect.objectContaining({ code: "HANDOFF_TARGET_CONFLICT" }));
    complete(f.value, summary);
    expect(f.value.finishRoomBatchFromTurns(f.run.id).state).toBe("completed");
  });

  it("prevents ordinary worker handoffs back to the lead", () => {
    const f = fixture();
    const worker = f.value.createLeadAssignments(f.run.id, f.source.id, plan(f).slice(0, 1))[0]!;
    complete(f.value, f.source);
    f.value.transitionRoomTurn(worker.id, "running");
    expect(() => f.value.createHandoff({ runId: f.run.id, fromTurnId: worker.id, toAgentId: f.bots[0]!.id,
      task: "summarize early", contextRefs: [], visibility: "room", targetTurnNonce: randomUUID(), inputGeneration: 1, inputSeq: 1 }))
      .toThrowError(expect.objectContaining({ code: "HANDOFF_TARGET_CONFLICT" }));
  });

  it("keeps coordination or member failures partial even after a successful summary", () => {
    const f = fixture();
    const workers = f.value.createLeadAssignments(f.run.id, f.source.id, plan(f));
    complete(f.value, f.source);
    workers.forEach((turn) => accept(f.value, turn));
    complete(f.value, workers[0]!);
    f.value.transitionRoomTurn(workers[1]!.id, "running");
    f.value.transitionRoomTurn(workers[1]!.id, "failed", { errorCode: "MODEL_FAILED" });
    const summary = f.value.ensureLeadSummaryTurn(f.run.id)!;
    complete(f.value, summary);
    expect(f.value.finishRoomBatchFromTurns(f.run.id).state).toBe("partial");
    expect(f.value.getRoomRunSummary(f.run.id).results[2]).toMatchObject({ state: "failed", errorCode: "MODEL_FAILED", body: "" });
    const second = fixture();
    complete(second.value, second.source);
    second.value.markRoomCoordinationFailed(second.run.id, "ROOM_LEAD_PLAN_INVALID");
    complete(second.value, second.value.ensureLeadSummaryTurn(second.run.id)!);
    expect(second.value.finishRoomBatchFromTurns(second.run.id).state).toBe("partial");
  });

  it("skips a failed coordinator and never launches summary after cancellation or winding down", () => {
    const failed = fixture();
    failed.value.transitionRoomTurn(failed.source.id, "failed", { errorCode: "MODEL_FAILED" });
    expect(failed.value.ensureLeadSummaryTurn(failed.run.id)).toBeNull();
    expect(failed.value.finishRoomBatchFromTurns(failed.run.id)).toMatchObject({ state: "partial", summaryState: "skipped", summarySkipReason: "coordination-failed" });
    const cancelled = fixture();
    cancelled.value.transitionRoomRun(cancelled.run.id, "cancelled");
    expect(cancelled.value.ensureLeadSummaryTurn(cancelled.run.id)).toBeNull();
    expect(cancelled.value.getRoomRun(cancelled.run.id)).toMatchObject({ state: "cancelled", summaryState: "skipped", summarySkipReason: "cancelled" });
    const stopped = fixture();
    complete(stopped.value, stopped.source);
    stopped.value.markRoomRunWindingDown(stopped.run.id);
    expect(stopped.value.ensureLeadSummaryTurn(stopped.run.id)).toBeNull();
    expect(stopped.value.finishRoomBatchFromTurns(stopped.run.id)).toMatchObject({ state: "partial", summarySkipReason: "winding-down" });
  });

  it("persists interrupted summary state and retries the same logical summary", () => {
    const f = fixture();
    complete(f.value, f.source);
    const summary = f.value.ensureLeadSummaryTurn(f.run.id)!;
    f.value.transitionRoomTurn(summary.id, "running", { promptCutoffSeq: summary.promptCutoffSeq! });
    f.value.recoverInterruptedRooms();
    expect(f.value.getRoomRun(f.run.id)).toMatchObject({ summaryState: "interrupted", state: "partial" });
    const retry = f.value.createRoomTurnRetry(summary.id);
    expect(retry).toMatchObject({ logicalTurnId: summary.logicalTurnId, turnPurpose: "summary", attemptNo: 2 });
    expect(f.value.getRoomRun(f.run.id)).toMatchObject({ summaryState: "queued", summaryTurnId: retry.id, usedTurns: 2 });
    complete(f.value, retry);
    expect(f.value.finishRoomBatchFromTurns(f.run.id).state).toBe("completed");
  });

  it("invalidates a completed summary after worker retry without spending another logical turn", () => {
    const f = fixture();
    const worker = f.value.createLeadAssignments(f.run.id, f.source.id, plan(f).slice(0, 1))[0]!;
    complete(f.value, f.source);
    accept(f.value, worker);
    f.value.transitionRoomTurn(worker.id, "running");
    f.value.transitionRoomTurn(worker.id, "failed");
    const summary = f.value.ensureLeadSummaryTurn(f.run.id)!;
    complete(f.value, summary);
    f.value.finishRoomBatchFromTurns(f.run.id);
    const workerRetry = f.value.createRoomTurnRetry(worker.id);
    expect(workerRetry.turnPurpose).toBe("work");
    expect(f.value.ensureLeadSummaryTurn(f.run.id)).toBeNull();
    complete(f.value, workerRetry);
    const refreshed = f.value.ensureLeadSummaryTurn(f.run.id)!;
    expect(refreshed).toMatchObject({ logicalTurnId: summary.logicalTurnId, attemptNo: 2 });
    expect(f.value.getRoomRun(f.run.id).usedTurns).toBe(3);
    complete(f.value, refreshed);
    expect(f.value.finishRoomBatchFromTurns(f.run.id).state).toBe("completed");
  });

  it.each(["manual-stop", "started-before-skip", "completed"] as const)("does not resurrect a %s node or its skipped descendants during another worker's retry", (state) => {
    const f = fixture({ maxTurns: 5 }, repository(), 4);
    const workers = f.value.createLeadAssignments(f.run.id, f.source.id, f.bots.slice(1).map((bot, index) => ({
      toAgentId: bot.id, task: `Task ${index + 1}`, dependsOnPrevious: index > 0,
    })));
    complete(f.value, f.source);
    accept(f.value, workers[0]!);
    f.value.transitionRoomTurn(workers[0]!.id, "running");
    f.value.transitionRoomTurn(workers[0]!.id, "failed");
    if (state === "completed") {
      accept(f.value, workers[1]!);
      complete(f.value, workers[1]!);
    } else {
      if (state === "started-before-skip") {
        accept(f.value, workers[1]!);
        const started = runtime(f.value, workers[1]!);
        f.value.transitionRuntimeRun(started.run.id, "failed");
      } else {
        f.value.transitionHandoff(f.value.getIncomingHandoff(workers[1]!.id)!.id, "cancelled");
      }
      f.value.transitionRoomTurn(workers[1]!.id, "cancelled", state === "manual-stop"
        ? { errorCode: "MESSAGE_CANCELLED", outcome: { kind: "cancelled" } }
        : { errorCode: "ROOM_DEPENDENCY_FAILED", outcome: { kind: "skipped", errorCode: "ROOM_DEPENDENCY_FAILED" } });
    }
    f.value.transitionRoomTurn(workers[2]!.id, "cancelled", {
      errorCode: "ROOM_DEPENDENCY_FAILED", outcome: { kind: "skipped", errorCode: "ROOM_DEPENDENCY_FAILED" },
    });
    f.value.transitionHandoff(f.value.getIncomingHandoff(workers[2]!.id)!.id, "cancelled");
    const summary = f.value.ensureLeadSummaryTurn(f.run.id)!;
    complete(f.value, summary);
    expect(f.value.finishRoomBatchFromTurns(f.run.id).state).toBe("partial");
    const original = workers.slice(1).map((turn) => f.value.getRoomTurn(turn.id));
    f.value.createRoomTurnRetry(workers[0]!.id);
    for (const prior of original) {
      expect(f.value.getRoomTurn(prior.id)).toEqual(prior);
      expect(f.value.listRoomTurns(f.run.id).filter((turn) => turn.logicalTurnId === prior.logicalTurnId)).toHaveLength(1);
    }
    expect(f.value.listRoomTurns(f.run.id).filter((turn) => turn.state === "queued")).toHaveLength(1);
  });

  it("does not automatically restore dependency-skipped work after the whole run was cancelled", () => {
    const f = fixture();
    const workers = f.value.createLeadAssignments(f.run.id, f.source.id, plan(f, true));
    complete(f.value, f.source);
    accept(f.value, workers[0]!);
    f.value.transitionRoomTurn(workers[0]!.id, "running");
    f.value.transitionRoomTurn(workers[0]!.id, "failed");
    f.value.transitionRoomTurn(workers[1]!.id, "cancelled", {
      errorCode: "ROOM_DEPENDENCY_FAILED", outcome: { kind: "skipped", errorCode: "ROOM_DEPENDENCY_FAILED" },
    });
    f.value.transitionHandoff(f.value.getIncomingHandoff(workers[1]!.id)!.id, "cancelled");
    f.value.transitionRoomRun(f.run.id, "cancelled");
    f.value.createRoomTurnRetry(workers[0]!.id);
    expect(f.value.listRoomTurns(f.run.id).filter((turn) => turn.logicalTurnId === workers[1]!.logicalTurnId)).toHaveLength(1);
    expect(f.value.getRoomTurn(workers[1]!.id).state).toBe("cancelled");
  });

  it.each(["accepted", "accepted-execution-failed", "failed-before-acceptance"] as const)("projects retry delivery %s from durable Runtime acceptance without rewriting the original cancellation", (outcome) => {
    const filename = join(mkdtempSync(join(tmpdir(), "aevoren-handoff-delivery-")), "app.sqlite");
    directories.push(join(filename, ".."));
    const f = fixture({}, repository(filename));
    const workers = f.value.createLeadAssignments(f.run.id, f.source.id, plan(f, true));
    complete(f.value, f.source);
    accept(f.value, workers[0]!);
    f.value.transitionRoomTurn(workers[0]!.id, "running");
    f.value.transitionRoomTurn(workers[0]!.id, "failed");
    f.value.transitionRoomTurn(workers[1]!.id, "cancelled", {
      errorCode: "ROOM_DEPENDENCY_FAILED", outcome: { kind: "skipped", errorCode: "ROOM_DEPENDENCY_FAILED" },
    });
    const original = f.value.transitionHandoff(f.value.getIncomingHandoff(workers[1]!.id)!.id, "cancelled");
    expect(f.value.getHandoffDeliveryAttempt(original.id)).toBeUndefined();
    complete(f.value, f.value.ensureLeadSummaryTurn(f.run.id)!);
    f.value.finishRoomBatchFromTurns(f.run.id);
    const firstRetry = f.value.createRoomTurnRetry(workers[0]!.id);
    complete(f.value, firstRetry);
    const dependent = f.value.listRoomTurns(f.run.id).find((turn) => turn.logicalTurnId === workers[1]!.logicalTurnId && turn.attemptNo === 2)!;
    expect(f.value.getHandoffDeliveryAttempt(original.id)).toMatchObject({
      attemptNo: 2, turnId: dependent.id, state: "queued", acceptedAt: null,
    });
    const active = runtime(f.value, dependent, outcome !== "failed-before-acceptance");
    const acceptedAt = f.value.getRuntimeRun(active.run.id).acceptedAt;
    if (outcome === "accepted") active.complete("任务已完成。");
    else {
      f.value.updateTranscriptEntry(active.assistant.id, "我声称已经接收并完成。", "failed");
      f.value.transitionRuntimeRun(active.run.id, "failed");
      f.value.transitionRoomTurn(dependent.id, "failed");
    }
    const projection = f.value.getHandoffDeliveryAttempt(original.id);
    expect(projection).toMatchObject({ attemptNo: 2, turnId: dependent.id,
      state: outcome === "failed-before-acceptance" ? "failed" : "accepted", acceptedAt });
    expect(acceptedAt === null).toBe(outcome === "failed-before-acceptance");
    expect(f.value.getHandoff(original.id)).toEqual(original);
    const reopened = repository(filename);
    expect(reopened.getHandoffDeliveryAttempt(original.id)).toEqual(projection);
    expect(reopened.getHandoff(original.id)).toEqual(original);
  });

  it("recovers a run awaiting summary as incomplete without making a model request", () => {
    const f = fixture();
    complete(f.value, f.source);
    f.value.recoverInterruptedRooms();
    expect(f.value.getRoomRun(f.run.id)).toMatchObject({ state: "partial", summaryState: "skipped", summarySkipReason: "interrupted" });
    expect(f.value.listRoomTurns(f.run.id)).toHaveLength(1);
  });

  it.each([false, true])("includes successful artifacts from failed=%s runtimes and suppresses revoked evidence", (failed) => {
    const value = repository();
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "aevoren-lead-summary-")));
    directories.push(directory);
    const workspace = value.registerWorkspaceRoot(directory, "Summary context");
    value.updateWorkspacePermissions(workspace.workspace.id, workspace.workspace.version, { writeEnabled: true, automationEnabled: false });
    const bots = Array.from({ length: 2 }, () => value.createBot().bot);
    const room = value.createRoom({ memberBotIds: bots.map((bot) => bot.id), leadBotId: bots[0]!.id, projectId: workspace.project.id });
    const created = value.createRoomRunWithInitialTurns({ roomId: room.room.id, sessionId: room.session.id, clientNonce: randomUUID(),
      text: "Write the result", membershipVersion: 1, routingMode: "automatic", routingReason: "fixed lead",
      maxTurns: 3, maxHops: 2, maxTargetsPerTurn: 1, deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      initialTurns: [{ agentId: bots[0]!.id, nonce: randomUUID() }] });
    value.transitionRoomRun(created.run.id, "running");
    const source = value.transitionRoomTurn(created.turns[0]!.id, "running", { promptCutoffSeq: 1 });
    const worker = value.createLeadAssignments(created.run.id, source.id, [{ toAgentId: bots[1]!.id, task: "Write", dependsOnPrevious: false }])[0]!;
    complete(value, source);
    accept(value, worker);
    const active = runtime(value, worker);
    const content = "verified report";
    const prepared = value.prepareToolInvocation({ runtimeRunId: active.run.id, toolCallId: randomUUID(), idempotencyKey: randomUUID(),
      tool: { kind: "workspace-write", workspaceId: workspace.workspace.id, path: "report.md", content } });
    value.resolveToolApproval(prepared.approval.id, prepared.approval.version, "allow-once");
    value.transitionToolInvocation(prepared.invocation.id, "dispatching");
    value.transitionToolInvocation(prepared.invocation.id, "running");
    const sha256 = createHash("sha256").update(content).digest("hex");
    value.completeToolInvocation(prepared.invocation.id, sha256, { sha256, bytes: Buffer.byteLength(content) });
    if (failed) {
      value.updateTranscriptEntry(active.assistant.id, "unfinished and untrusted", "failed");
      value.transitionRuntimeRun(active.run.id, "failed", { errorCode: "MODEL_FAILED" });
      value.transitionRoomTurn(worker.id, "failed", { errorCode: "MODEL_FAILED" });
    } else active.complete("Wrote verified report");
    const snapshot = value.getRoomRunSummary(created.run.id);
    expect(snapshot.results[1]).toMatchObject({ body: failed ? "" : "Wrote verified report", assistantEntryId: failed ? null : active.assistant.id,
      tools: [{ kind: "workspace-write", resultDigest: sha256 }], artifacts: [{ path: "report.md", sha256 }] });
    const summary = value.ensureLeadSummaryTurn(created.run.id)!;
    expect(value.getExecutionEvidenceReceipt(summary.id)).toBeNull();
    complete(value, summary);
    value.finishRoomBatchFromTurns(created.run.id);
    value.setConversationProject(room.session.id, null, value.getConversation(room.session.id).version);
    expect(value.getRoomRunSummary(created.run.id).results[1]).toMatchObject({ body: "", assistantEntryId: null, artifacts: [], tools: [] });
  });
});
