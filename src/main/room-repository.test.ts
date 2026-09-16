import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { PromptManifest, RoomDetail, RoomTurn, RuntimeRun } from "@shared/contracts";
import { AppRepository } from "./database";

const repositories: AppRepository[] = [];
const temporaryDirectories: string[] = [];

function repository(): AppRepository {
  const value = new AppRepository(":memory:");
  repositories.push(value);
  return value;
}

function createBots(value: AppRepository, count: number) {
  return Array.from({ length: count }, (_, index) => {
    const created = value.createBot();
    const bot = value.updateBot(created.bot.id, created.bot.version, { name: `Bot ${index + 1}` });
    return { ...created, bot };
  });
}

function createCompletedRoomRun(
  value: AppRepository,
  detail: RoomDetail,
  turn: RoomTurn,
  clientNonce: string,
): { run: RuntimeRun; assistantId: string } {
  const input = value.getUserMessage(clientNonce);
  const promptCutoffSeq = turn.promptCutoffSeq ?? input.seq;
  const manifest: PromptManifest = {
    schemaVersion: 2,
    botId: turn.memberBotId,
    profileVersion: 1,
    sessionId: detail.session.id,
    generation: detail.session.generation,
    inputSeq: input.seq,
    promptCutoffSeq,
    roomId: detail.room.id,
    roomMembershipVersion: detail.room.membershipVersion,
    executorBotId: turn.memberBotId,
    sourceTurnId: turn.id,
    blocks: [],
    digest: "room-recovery-test",
  };
  const run = value.createRuntimeRun(clientNonce, "fake", manifest, {
    executorBotId: turn.memberBotId,
    executionKey: `${turn.batchId}:${turn.logicalTurnId}`,
    promptCutoffSeq,
  });
  value.attachRoomTurnRuntime(turn.id, run.id);
  value.transitionRuntimeRun(run.id, "dispatching");
  value.transitionRuntimeRun(run.id, "running", { providerRequestId: `request-${turn.memberBotId}` });
  const assistant = value.createAssistantEntry(detail.session.id, {
    speakerBotId: turn.memberBotId,
    speakerNameSnapshot: turn.memberNameSnapshot,
    sourceTurnId: turn.id,
  });
  value.attachAssistantEntry(run.id, assistant.id);
  value.updateTranscriptEntry(assistant.id, `reply-${turn.memberBotId}`, "completed");
  value.transitionRuntimeRun(run.id, "completed");
  return { run: value.getRuntimeRun(run.id), assistantId: assistant.id };
}

afterEach(() => {
  while (repositories.length > 0) repositories.pop()?.close();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("Room repository", () => {
  it("enforces the 2 to 6 unique member boundary", () => {
    const value = repository();
    const bots = createBots(value, 7);
    expect(value.createRoom({ memberBotIds: bots.slice(0, 2).map(({ bot }) => bot.id) }).members).toHaveLength(2);
    expect(value.createRoom({ memberBotIds: bots.slice(0, 6).map(({ bot }) => bot.id) }).members).toHaveLength(6);
    expect(() => value.createRoom({ memberBotIds: [bots[0]!.bot.id] })).toThrowError(expect.objectContaining({ code: "ROOM_MEMBER_INVALID" }));
    expect(() => value.createRoom({ memberBotIds: bots.map(({ bot }) => bot.id) })).toThrowError(expect.objectContaining({ code: "ROOM_MEMBER_INVALID" }));
    expect(() => value.createRoom({ memberBotIds: [bots[0]!.bot.id, bots[0]!.bot.id] })).toThrowError(expect.objectContaining({ code: "ROOM_MEMBER_INVALID" }));
  });

  it("rolls back Room, members and MAIN session as one transaction", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-room-rollback-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    const value = new AppRepository(filename);
    repositories.push(value);
    const bots = createBots(value, 2);
    const injector = new DatabaseSync(filename);
    injector.exec("CREATE TRIGGER reject_room_session BEFORE INSERT ON sessions WHEN NEW.room_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'test'); END;");
    injector.close();

    expect(() => value.createRoom({ memberBotIds: bots.map(({ bot }) => bot.id) })).toThrow();
    expect(value.listRooms(true)).toHaveLength(0);
    const inspected = new DatabaseSync(filename, { readOnly: true });
    expect(inspected.prepare("SELECT COUNT(*) AS count FROM room_members").get()).toEqual({ count: 0 });
    expect(inspected.prepare("SELECT COUNT(*) AS count FROM sessions WHERE room_id IS NOT NULL").get()).toEqual({ count: 0 });
    inspected.close();
  });

  it("uses membership CAS, preserves order and prevents changes while active", () => {
    const value = repository();
    const bots = createBots(value, 4);
    const created = value.createRoom({ memberBotIds: bots.slice(0, 3).map(({ bot }) => bot.id) });
    const removed = value.removeRoomMember(created.room.id, bots[1]!.bot.id, created.room.membershipVersion);
    expect(removed.members.map((member) => member.botId)).toEqual([bots[0]!.bot.id, bots[2]!.bot.id]);
    expect(removed.members.map((member) => member.position)).toEqual([0, 1]);
    expect(() => value.addRoomMember(created.room.id, bots[3]!.bot.id, created.room.membershipVersion)).toThrowError(
      expect.objectContaining({ code: "ROOM_MEMBERSHIP_CONFLICT" }),
    );
    const added = value.addRoomMember(created.room.id, bots[3]!.bot.id, removed.room.membershipVersion);
    const nonce = crypto.randomUUID();
    value.prepareRoomMessage({
      roomId: added.room.id,
      sessionId: added.session.id,
      clientNonce: nonce,
      text: "busy",
      targetBotIds: [bots[0]!.bot.id],
    });
    expect(() => value.archiveRoom(added.room.id, true)).toThrowError(expect.objectContaining({ code: "ROOM_BUSY" }));
    expect(() => value.removeRoomMember(added.room.id, bots[3]!.bot.id, added.room.membershipVersion)).toThrowError(
      expect.objectContaining({ code: "ROOM_BUSY" }),
    );
  });

  it("uses profile CAS and never applies a stale Room update", () => {
    const value = repository();
    const bots = createBots(value, 2);
    const detail = value.createRoom({ memberBotIds: bots.map(({ bot }) => bot.id) });
    const updated = value.updateRoom(detail.room.id, detail.room.version, { description: "new" });
    expect(updated.version).toBe(2);
    expect(() => value.updateRoom(detail.room.id, detail.room.version, { description: "stale" })).toThrowError(
      expect.objectContaining({ code: "ROOM_VERSION_CONFLICT" }),
    );
    expect(value.getRoom(detail.room.id).description).toBe("new");
  });

  it("persists Room pin and unread state without changing profile or membership versions", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-room-sidebar-state-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    const first = new AppRepository(filename);
    const bots = createBots(first, 2);
    const detail = first.createRoom({ memberBotIds: bots.map(({ bot }) => bot.id) });
    const pinned = first.setRoomPinned(detail.room.id, true);
    const unread = first.setRoomUnread(detail.room.id, true);
    expect(pinned.version).toBe(detail.room.version);
    expect(unread.version).toBe(detail.room.version);
    expect(unread.membershipVersion).toBe(detail.room.membershipVersion);
    first.close();

    const reopened = new AppRepository(filename);
    repositories.push(reopened);
    expect(reopened.getRoom(detail.room.id)).toMatchObject({ pinnedAt: expect.any(String), hasUnread: true });
    expect(reopened.setRoomPinned(detail.room.id, false).pinnedAt).toBeNull();
    expect(reopened.setRoomUnread(detail.room.id, false).hasUnread).toBe(false);
  });

  it("hides a Room recoverably without archiving or changing its conversation", () => {
    const value = repository();
    const bots = createBots(value, 2);
    const detail = value.createRoom({ memberBotIds: bots.map(({ bot }) => bot.id), name: "Hidden later" });
    value.setRoomPinned(detail.room.id, true);
    const hidden = value.setRoomHidden(detail.room.id, true);
    expect(hidden).toMatchObject({ hiddenAt: expect.any(String), pinnedAt: null, archivedAt: null });
    expect(value.getRoomMainSession(detail.room.id).id).toBe(detail.session.id);
    expect(value.listRoomMembers(detail.room.id)).toHaveLength(2);
    expect(value.setRoomHidden(detail.room.id, false).hiddenAt).toBeNull();
  });

  it("permanently deletes one Room conversation while preserving every member Bot", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-room-delete-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    const value = new AppRepository(filename);
    repositories.push(value);
    const bots = createBots(value, 2);
    const detail = value.createRoom({ memberBotIds: bots.map(({ bot }) => bot.id), name: "Delete me" });
    const prepared = value.prepareRoomMessage({
      roomId: detail.room.id,
      sessionId: detail.session.id,
      clientNonce: crypto.randomUUID(),
      text: "persisted history",
      targetBotIds: [bots[0]!.bot.id],
    });
    expect(() => value.deleteRoom(detail.room.id)).toThrowError(expect.objectContaining({ code: "ROOM_DELETE_BUSY" }));
    value.transitionRoomBatch(prepared.batch.id, "cancelled");
    expect(value.deleteRoom(detail.room.id)).toEqual({ id: detail.room.id });
    expect(() => value.getRoom(detail.room.id)).toThrowError(expect.objectContaining({ code: "ROOM_NOT_FOUND" }));
    expect(value.listBots()).toHaveLength(2);

    const inspected = new DatabaseSync(filename, { readOnly: true });
    expect(inspected.prepare("SELECT COUNT(*) AS count FROM rooms").get()).toEqual({ count: 0 });
    expect(inspected.prepare("SELECT COUNT(*) AS count FROM room_members").get()).toEqual({ count: 0 });
    expect(inspected.prepare("SELECT COUNT(*) AS count FROM sessions WHERE room_id IS NOT NULL").get()).toEqual({ count: 0 });
    expect(inspected.prepare("SELECT COUNT(*) AS count FROM transcript_entries").get()).toEqual({ count: 0 });
    expect(inspected.prepare("SELECT COUNT(*) AS count FROM room_batches").get()).toEqual({ count: 0 });
    expect(inspected.prepare("SELECT COUNT(*) AS count FROM room_turns").get()).toEqual({ count: 0 });
    expect(inspected.prepare("SELECT COUNT(*) AS count FROM bots WHERE deleted_at IS NULL").get()).toEqual({ count: 2 });
    expect(inspected.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    inspected.close();
  });

  it("canonicalizes targets for duplicate detection and rejects changed commands", () => {
    const value = repository();
    const bots = createBots(value, 3);
    const detail = value.createRoom({ memberBotIds: bots.map(({ bot }) => bot.id) });
    const command = {
      roomId: detail.room.id,
      sessionId: detail.session.id,
      clientNonce: crypto.randomUUID(),
      text: "compare",
      targetBotIds: [bots[2]!.bot.id, bots[0]!.bot.id],
    };
    expect(value.prepareRoomMessage(command).disposition).toBe("prepared");
    expect(value.prepareRoomMessage({ ...command, targetBotIds: [bots[0]!.bot.id, bots[2]!.bot.id] }).disposition).toBe("duplicate");
    expect(() => value.prepareRoomMessage({ ...command, text: "changed" })).toThrowError(
      expect.objectContaining({ code: "MESSAGE_NONCE_CONFLICT" }),
    );
    expect(() => value.prepareRoomMessage({ ...command, targetBotIds: [bots[1]!.bot.id] })).toThrowError(
      expect.objectContaining({ code: "MESSAGE_NONCE_CONFLICT" }),
    );
    expect(value.listTranscript(detail.session.id).filter((entry) => entry.role === "user")).toHaveLength(1);
    expect(value.listRoomBatches(detail.room.id)).toHaveLength(1);
    expect(value.listRoomTurns(value.listRoomBatches(detail.room.id)[0]!.id)).toHaveLength(2);

    const otherRoom = value.createRoom({ memberBotIds: bots.map(({ bot }) => bot.id), name: "Other" });
    expect(() => value.prepareRoomMessage({ ...command, roomId: otherRoom.room.id, sessionId: otherRoom.session.id })).toThrowError(
      expect.objectContaining({ code: "MESSAGE_NONCE_CONFLICT" }),
    );
    const batch = value.getRoomBatchByNonce(command.clientNonce)!;
    value.transitionRoomBatch(batch.id, "cancelled");
    value.archiveRoom(detail.room.id, true);
    expect(value.prepareRoomMessage(command)).toMatchObject({ disposition: "duplicate", batch: { id: batch.id } });
    value.archiveRoom(detail.room.id, false);
    const current = value.getRoom(detail.room.id);
    value.removeRoomMember(detail.room.id, bots[2]!.bot.id, current.membershipVersion);
    expect(value.prepareRoomMessage(command)).toMatchObject({ disposition: "duplicate", batch: { id: batch.id } });
  });

  it("settles a cancelled Batch across Turn, RuntimeRun and Assistant during crash recovery", () => {
    const value = repository();
    const bots = createBots(value, 2);
    const detail = value.createRoom({ memberBotIds: bots.map(({ bot }) => bot.id) });
    const clientNonce = crypto.randomUUID();
    const prepared = value.prepareRoomMessage({
      roomId: detail.room.id,
      sessionId: detail.session.id,
      clientNonce,
      text: "cancel then crash",
      targetBotIds: bots.map(({ bot }) => bot.id),
    });
    value.transitionRoomBatch(prepared.batch.id, "running");
    const turns = value.listRoomTurns(prepared.batch.id);
    const runningTurn = value.transitionRoomTurn(turns[0]!.id, "running", { promptCutoffSeq: 1 });
    const input = value.getUserMessage(clientNonce);
    const manifest: PromptManifest = {
      schemaVersion: 2,
      botId: runningTurn.memberBotId,
      profileVersion: 1,
      sessionId: detail.session.id,
      generation: detail.session.generation,
      inputSeq: input.seq,
      promptCutoffSeq: input.seq,
      roomId: detail.room.id,
      roomMembershipVersion: detail.room.membershipVersion,
      executorBotId: runningTurn.memberBotId,
      sourceTurnId: runningTurn.id,
      blocks: [],
      digest: "cancel-recovery-test",
    };
    const run = value.createRuntimeRun(clientNonce, "fake", manifest, {
      executorBotId: runningTurn.memberBotId,
      executionKey: `${prepared.batch.id}:${runningTurn.logicalTurnId}`,
      promptCutoffSeq: input.seq,
    });
    value.attachRoomTurnRuntime(runningTurn.id, run.id);
    value.transitionRuntimeRun(run.id, "dispatching");
    value.transitionRuntimeRun(run.id, "running", { providerRequestId: "cancel-request" });
    const assistant = value.createAssistantEntry(detail.session.id, {
      speakerBotId: runningTurn.memberBotId,
      speakerNameSnapshot: runningTurn.memberNameSnapshot,
      sourceTurnId: runningTurn.id,
    });
    value.attachAssistantEntry(run.id, assistant.id);
    value.updateTranscriptEntry(assistant.id, "partial", "streaming");
    value.transitionRuntimeRun(run.id, "cancel-requested");
    value.transitionRoomTurn(turns[1]!.id, "cancelled");
    value.transitionRoomBatch(prepared.batch.id, "cancelled");

    expect(value.recoverInterruptedRooms()).toBe(1);
    expect(value.recoverInterruptedRuntimeRuns()).toBe(0);
    expect(value.getRoomBatch(prepared.batch.id).state).toBe("cancelled");
    expect(value.listRoomTurns(prepared.batch.id).map((turn) => turn.state)).toEqual(["cancelled", "cancelled"]);
    expect(value.getRuntimeRun(run.id).state).toBe("cancelled");
    expect(value.getTranscriptEntry(assistant.id)).toMatchObject({ body: "partial", status: "cancelled" });
  });

  it("reconciles a completed Runtime before interrupting the remaining Room Turns", () => {
    const value = repository();
    const bots = createBots(value, 2);
    const detail = value.createRoom({ memberBotIds: bots.map(({ bot }) => bot.id) });
    const clientNonce = crypto.randomUUID();
    const prepared = value.prepareRoomMessage({
      roomId: detail.room.id,
      sessionId: detail.session.id,
      clientNonce,
      text: "completed before Turn settlement",
      targetBotIds: bots.map(({ bot }) => bot.id),
    });
    value.transitionRoomBatch(prepared.batch.id, "running");
    const turns = value.listRoomTurns(prepared.batch.id);
    const running = value.transitionRoomTurn(turns[0]!.id, "running", { promptCutoffSeq: 1 });
    const completed = createCompletedRoomRun(value, detail, running, clientNonce);

    expect(value.recoverInterruptedRooms()).toBe(1);
    expect(value.recoverInterruptedRuntimeRuns()).toBe(0);
    expect(value.getRuntimeRun(completed.run.id).state).toBe("completed");
    expect(value.getTranscriptEntry(completed.assistantId).status).toBe("completed");
    expect(value.listRoomTurns(prepared.batch.id).map((turn) => turn.state)).toEqual(["completed", "interrupted"]);
    expect(value.getRoomBatch(prepared.batch.id).state).toBe("partial");
    expect(() => value.createRoomTurnRetry(running.id)).toThrowError(expect.objectContaining({ code: "ROOM_TURN_RETRY_UNSAFE" }));
    const continued = value.continueInterruptedRoomBatch(prepared.batch.id);
    expect(continued).toHaveLength(1);
    expect(continued[0]).toMatchObject({ memberBotId: turns[1]!.memberBotId, attemptNo: 2, state: "queued" });
  });

  it("recomputes an active Batch as completed when every latest Turn already completed", () => {
    const value = repository();
    const bots = createBots(value, 2);
    const detail = value.createRoom({ memberBotIds: bots.map(({ bot }) => bot.id) });
    const clientNonce = crypto.randomUUID();
    const prepared = value.prepareRoomMessage({
      roomId: detail.room.id,
      sessionId: detail.session.id,
      clientNonce,
      text: "all completed before Batch settlement",
      targetBotIds: bots.map(({ bot }) => bot.id),
    });
    value.transitionRoomBatch(prepared.batch.id, "running");
    for (const pending of value.listRoomTurns(prepared.batch.id)) {
      const running = value.transitionRoomTurn(pending.id, "running", { promptCutoffSeq: value.getTranscriptHighWater(detail.session.id) });
      createCompletedRoomRun(value, detail, running, clientNonce);
      value.transitionRoomTurn(running.id, "completed");
    }

    expect(value.getRoomBatch(prepared.batch.id).state).toBe("running");
    expect(value.recoverInterruptedRooms()).toBe(1);
    expect(value.getRoomBatch(prepared.batch.id).state).toBe("completed");
    expect(value.listRoomTurns(prepared.batch.id).map((turn) => turn.state)).toEqual(["completed", "completed"]);
  });

  it("keeps Room and Bot MAIN transcripts isolated and archives recoverably", () => {
    const value = repository();
    const bots = createBots(value, 2);
    const first = value.createRoom({ memberBotIds: bots.map(({ bot }) => bot.id, ), name: "First" });
    const second = value.createRoom({ memberBotIds: bots.map(({ bot }) => bot.id), name: "Second" });
    value.prepareRoomMessage({
      roomId: first.room.id,
      sessionId: first.session.id,
      clientNonce: crypto.randomUUID(),
      text: "Room only",
      targetBotIds: [bots[0]!.bot.id],
    });
    expect(value.listTranscript(first.session.id)).toHaveLength(1);
    expect(value.listTranscript(second.session.id)).toHaveLength(0);
    expect(value.listTranscript(bots[0]!.session.id)).toHaveLength(0);
    expect(value.archiveRoom(second.room.id, true).archivedAt).not.toBeNull();
    expect(value.listRooms()).toHaveLength(1);
    expect(value.archiveRoom(second.room.id, false).archivedAt).toBeNull();
    expect(value.listRooms()).toHaveLength(2);
  });
});
