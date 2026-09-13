import type { RoomBatch, RoomHandoffView, RoomRuntimeEvent, RoomTurn } from "@shared/contracts";

export function latestRoomTurnsByLogicalTurn(turns: RoomTurn[], batchId: string): RoomTurn[] {
  const latest = new Map<string, RoomTurn>();
  for (const turn of turns.filter((item) => item.batchId === batchId)) {
    const current = latest.get(turn.logicalTurnId);
    if (!current || current.attemptNo < turn.attemptNo) latest.set(turn.logicalTurnId, turn);
  }
  return [...latest.values()].toSorted((left, right) => left.position - right.position);
}

export function initialRoomRouteAgentIds(turns: RoomTurn[], batchId: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const turn of turns
    .filter((item) => item.batchId === batchId && item.origin === "initial")
    .toSorted((left, right) => left.position - right.position || left.attemptNo - right.attemptNo)) {
    if (seen.has(turn.memberBotId)) continue;
    seen.add(turn.memberBotId);
    result.push(turn.memberBotId);
  }
  return result;
}

export function mergeRoomRuntimeEvents(
  batches: RoomBatch[],
  turns: RoomTurn[],
  handoffs: RoomHandoffView[],
  events: RoomRuntimeEvent[],
): { batches: RoomBatch[]; turns: RoomTurn[]; handoffs: RoomHandoffView[] } {
  const batchMap = new Map(batches.map((batch) => [batch.id, batch]));
  const turnMap = new Map(turns.map((turn) => [turn.id, turn]));
  const handoffMap = new Map(handoffs.map((handoff) => [handoff.id, handoff]));
  for (const event of events) {
    const existingBatch = batchMap.get(event.batch.id);
    if (!existingBatch || existingBatch.version < event.batch.version) batchMap.set(event.batch.id, event.batch);
    for (const turn of event.turns) {
      const existingTurn = turnMap.get(turn.id);
      if (!existingTurn || existingTurn.version < turn.version) turnMap.set(turn.id, turn);
    }
    for (const handoff of event.handoffs) {
      const existingHandoff = handoffMap.get(handoff.id);
      if (!existingHandoff || existingHandoff.version < handoff.version) handoffMap.set(handoff.id, handoff);
    }
  }
  return {
    batches: [...batchMap.values()].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
    turns: [...turnMap.values()].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt) || left.position - right.position),
    handoffs: [...handoffMap.values()].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
  };
}
