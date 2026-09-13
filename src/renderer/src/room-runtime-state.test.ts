import { describe, expect, it } from "vitest";
import type { RoomBatch, RoomHandoffView, RoomRuntimeEvent, RoomTurn } from "@shared/contracts";
import { initialRoomRouteAgentIds, latestRoomTurnsByLogicalTurn, mergeRoomRuntimeEvents } from "./room-runtime-state";

function handoff(version: number, state: RoomHandoffView["state"]): RoomHandoffView {
  return {
    id: "handoff-1",
    runId: "run-1",
    fromTurnId: "turn-a",
    toAgentId: "bot-b",
    targetTurnId: "turn-b",
    task: "复核",
    state,
    version,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: `2026-01-01T00:00:0${version}.000Z`,
    finishedAt: state === "accepted" ? "2026-01-01T00:00:03.000Z" : null,
  };
}

function event(value: RoomHandoffView): RoomRuntimeEvent {
  return {
    roomId: "room-1",
    sessionId: "session-1",
    batch: { id: "run-1", version: value.version, createdAt: value.createdAt } as RoomBatch,
    turns: [],
    handoffs: [value],
  };
}

describe("mergeRoomRuntimeEvents", () => {
  it("merges a buffered newer Handoff over a snapshot and ignores a later stale event", () => {
    const buffered = mergeRoomRuntimeEvents([], [], [handoff(1, "queued")], [event(handoff(2, "dispatching"))]);
    expect(buffered.handoffs).toMatchObject([{ version: 2, state: "dispatching" }]);

    const stale = mergeRoomRuntimeEvents(buffered.batches, buffered.turns, buffered.handoffs, [event(handoff(1, "queued"))]);
    expect(stale.handoffs).toMatchObject([{ version: 2, state: "dispatching" }]);

    const terminal = mergeRoomRuntimeEvents(stale.batches, stale.turns, stale.handoffs, [event(handoff(3, "accepted"))]);
    expect(terminal.handoffs).toMatchObject([{ version: 3, state: "accepted" }]);
    expect(terminal.handoffs).toHaveLength(1);
  });

  it("keeps user routing limited to initial mentions and preserves an A-to-B-to-A logical return", () => {
    const turn = (
      id: string,
      agentId: string,
      logicalTurnId: string,
      origin: RoomTurn["origin"],
      position: number,
      attemptNo = 1,
    ): RoomTurn => ({ id, batchId: "run-1", runId: "run-1", memberBotId: agentId, agentId, logicalTurnId, origin, position, attemptNo } as RoomTurn);
    const turns = [
      turn("a-root", "agent-a", "logical-a-root", "initial", 0),
      turn("b", "agent-b", "logical-b", "handoff", 1),
      turn("a-return", "agent-a", "logical-a-return", "handoff", 2),
      turn("a-return-retry", "agent-a", "logical-a-return", "retry", 3, 2),
    ];

    expect(initialRoomRouteAgentIds(turns, "run-1")).toEqual(["agent-a"]);
    expect(latestRoomTurnsByLogicalTurn(turns, "run-1").map((item) => item.id)).toEqual([
      "a-root",
      "b",
      "a-return-retry",
    ]);
  });
});
