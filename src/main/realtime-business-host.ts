import type { VoiceMessageOrigin } from "@shared/contracts";
import type { RealtimeTaskLink } from "@shared/realtime-contracts";
import type { AppRepository } from "./database";
import { assertRealtimeAdmission, type RealtimeAdmission } from "./realtime-admission";
import type { SendWorker } from "./send-worker";
import type { RoomCoordinator } from "./room-coordinator";
import { AevorenBotError } from "./errors";
import { voiceDigest } from "./voice-repository";

export type RealtimeDispatchRequest = {
  voiceSessionId: string; turnId: string; callId: string; sessionId: string; executorBotId: string;
  inputGeneration: number; clientNonce: string; text: string; admission: RealtimeAdmission;
};
/** The only voice-to-business bridge. Model call arguments never become human input. */
export class RealtimeBusinessHost {
  private readonly listeners = new Set<() => void>();
  constructor(private readonly repository: AppRepository, private readonly worker: SendWorker, private readonly rooms: RoomCoordinator) {}
  changed(): void { for (const listener of this.listeners) listener(); }
  async dispatch(request: RealtimeDispatchRequest, signal: AbortSignal): Promise<RealtimeTaskLink> {
    const check = (): void => {
      signal.throwIfAborted(); assertRealtimeAdmission(this.repository, request.admission);
      if (request.admission.input.sessionId !== request.sessionId || request.admission.input.executorBotId !== request.executorBotId
        || request.admission.generation !== request.inputGeneration) throw new AevorenBotError("VOICE_NOT_GRANTED");
    };
    check();
    const origin: VoiceMessageOrigin = { kind: "voice-input", voiceSessionId: request.voiceSessionId, turnId: request.turnId,
      callId: request.callId, transcriptDigest: voiceDigest(request.text) };
    const { input, roomId } = request.admission;
    const command = { sessionId: request.sessionId, clientNonce: request.clientNonce, text: request.text,
      resourceRefs: input.resourceRefs, mediaRefs: input.mediaRefs };
    check();
    if (roomId) {
      const result = await this.rooms.routeAndSend({ ...command, roomId, routingMode: input.routingMode, targetBotIds: input.targetBotIds }, { origin, assertCurrent: check });
      return { kind: "room", id: result.batchId };
    }
    return { kind: "runtime", id: this.worker.send(command, origin).runId };
  }
  lookup(request: Pick<RealtimeDispatchRequest, "sessionId" | "clientNonce">): RealtimeTaskLink | null {
    const journal = this.repository.getSend(request.clientNonce);
    if (!journal || journal.sessionId !== request.sessionId) return null;
    const batch = this.repository.getRoomBatchByNonce(request.clientNonce);
    if (batch) return { kind: "room", id: batch.id };
    const runtime = this.repository.getLatestRuntimeRun(request.clientNonce);
    return runtime ? { kind: "runtime", id: runtime.id } : null;
  }
  private result(link: RealtimeTaskLink): { state: string; text: string } | null {
    if (link.kind === "runtime") {
      const run = this.repository.getRuntimeRun(link.id);
      if (["created", "dispatching", "running", "streaming", "cancel-requested"].includes(run.state)) return null;
      return { state: run.state, text: run.assistantEntryId ? this.repository.getTranscriptEntry(run.assistantEntryId).body.slice(0, 32_000) : "" };
    }
    const batch = this.repository.getRoomBatch(link.id);
    if (["queued", "running"].includes(batch.state)) return null;
    const text = this.repository.listRoomTurns(link.id).map(turn => {
      const run = turn.runtimeRunId ? this.repository.getRuntimeRun(turn.runtimeRunId) : null;
      return run?.assistantEntryId ? this.repository.getTranscriptEntry(run.assistantEntryId).body : "";
    }).filter(Boolean).join("\n\n").slice(0, 32_000);
    return { state: batch.state, text };
  }
  wait(link: RealtimeTaskLink, signal: AbortSignal): Promise<{ state: string; text: string }> {
    return new Promise((resolve, reject) => {
      const finish = (): void => { clearTimeout(timer); this.listeners.delete(check); signal.removeEventListener("abort", aborted); };
      const aborted = (): void => { finish(); reject(new AevorenBotError("TOOL_EXECUTION_CANCELLED")); };
      const check = (): void => { try { const result = this.result(link); if (result) { finish(); resolve(result); } } catch (error) { finish(); reject(error); } };
      const timer = setTimeout(() => { finish(); reject(new AevorenBotError("VOICE_REQUEST_UNKNOWN")); }, 15 * 60_000);
      this.listeners.add(check); signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted(); else check();
    });
  }
  cancel(link: RealtimeTaskLink): void {
    if (link.kind === "room") this.rooms.cancel(link.id);
    else this.worker.executor.cancelRun(link.id);
  }
}
