import type { RoomBatch, RoomHandoffRejectionView, RoomHandoffView, RoomRuntimeEvent, RoomTurn } from "@shared/contracts";

export type RoomHandoffProgress = {
  deliveryLabel: string;
  executionLabel: string | null;
  tone: "neutral" | "success" | "warning" | "danger";
};

export function roomHandoffProgress(handoff: RoomHandoffView, targetTurn?: RoomTurn): RoomHandoffProgress {
  const delivery = handoff.state === "queued"
    ? { label: "待发送", tone: "neutral" as const }
    : handoff.state === "dispatching"
      ? { label: "发送中", tone: "neutral" as const }
      : handoff.state === "accepted"
        ? { label: "已接收", tone: "neutral" as const }
        : handoff.state === "failed"
          ? { label: "失败", tone: "danger" as const }
          : { label: "已取消", tone: "warning" as const };
  if (!targetTurn) return { deliveryLabel: delivery.label, executionLabel: null, tone: delivery.tone };
  const execution = targetTurn.state === "queued"
    ? { label: "等待执行", tone: "neutral" as const }
    : targetTurn.state === "running"
      ? { label: "处理中", tone: "neutral" as const }
      : targetTurn.state === "completed"
        ? { label: "已完成", tone: "success" as const }
        : targetTurn.state === "failed"
          ? { label: "执行失败", tone: "danger" as const }
          : targetTurn.state === "cancelled"
            ? { label: "执行已取消", tone: "warning" as const }
            : { label: "执行已中断", tone: "warning" as const };
  return {
    deliveryLabel: delivery.label,
    executionLabel: execution.label,
    tone: execution.tone === "neutral" ? delivery.tone : execution.tone,
  };
}

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
  rejections: RoomHandoffRejectionView[],
  events: RoomRuntimeEvent[],
): { batches: RoomBatch[]; turns: RoomTurn[]; handoffs: RoomHandoffView[]; rejections: RoomHandoffRejectionView[] } {
  const batchMap = new Map(batches.map((batch) => [batch.id, batch]));
  const turnMap = new Map(turns.map((turn) => [turn.id, turn]));
  const handoffMap = new Map(handoffs.map((handoff) => [handoff.id, handoff]));
  const rejectionMap = new Map((rejections ?? []).map((rejection) => [rejection.id, rejection]));
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
    for (const rejection of event.rejections ?? []) rejectionMap.set(rejection.id, rejection);
  }
  return {
    batches: [...batchMap.values()].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
    turns: [...turnMap.values()].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt) || left.position - right.position),
    handoffs: [...handoffMap.values()].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
    rejections: [...rejectionMap.values()].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
  };
}
