import type { RuntimeRun } from "@shared/contracts";
import type { AppRepository } from "./database";
import type { EventService } from "./event-service";

/** Only host-verified opaque metadata crosses this bridge, including from private TASK sessions. */
export async function emitAutomationRuntime(repository: AppRepository, service: EventService, run: RuntimeRun): Promise<void> {
  if (run.state !== "completed" && run.state !== "failed") return;
  const actual = repository.getRuntimeRun(run.id);
  if (actual.state !== run.state || actual.sessionId !== run.sessionId || actual.version !== run.version) return;
  let nonce = actual.promptManifest.sourceTurnId ? repository.getRoomBatch(repository.getRoomTurn(actual.promptManifest.sourceTurnId).batchId).clientNonce : actual.clientNonce;
  let originRoutineRunId: string | undefined;
  const visited = new Set<string>();
  for (let hop = 0; hop < 8 && !visited.has(nonce); hop++) {
    visited.add(nonce);
    const origin = repository.getUserMessage(nonce).origin;
    if (origin?.kind === "routine") {
      const saved = repository.getRoutineRun(origin.routineRunId);
      if (saved.clientNonce === nonce && saved.routineId === origin.routineId) originRoutineRunId = saved.id;
      break;
    }
    if (!origin?.rootClientNonce || origin.rootClientNonce === nonce) break;
    nonce = origin.rootClientNonce;
  }
  await service.emitRuntime({ eventId: `runtime:${actual.id}:${actual.state}`, sessionId: actual.sessionId, runtimeRunId: actual.id, state: actual.state, ...(originRoutineRunId ? { originRoutineRunId } : {}) });
}
