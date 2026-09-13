import type {
  AppError,
  RoomBatch,
  RoomRuntimeEvent,
  RoomRuntimeSnapshot,
  RoomSendCommand,
  RoomSendResult,
  RoomTurn,
  RoomTurnState,
} from "@shared/contracts";
import type { AppRepository } from "./database";
import { asAppError, MsBotError } from "./errors";
import type { RuntimeExecutor, RuntimeExecutionResult } from "./runtime-executor";

type RoomCoordinatorEvents = {
  roomRuntime(event: RoomRuntimeEvent): void;
  transcript: (event: { sessionId: string; entry: ReturnType<AppRepository["getUserMessage"]> }) => void;
};

const SHUTDOWN_DRAIN_MS = 2_000;

export class RoomCoordinator {
  private readonly inFlight = new Map<string, Promise<void>>();
  private shuttingDown = false;

  constructor(
    private readonly repository: AppRepository,
    private readonly executor: RuntimeExecutor,
    private readonly events: RoomCoordinatorEvents,
  ) {}

  getSnapshot(roomId: string): RoomRuntimeSnapshot {
    const detail = this.repository.getRoomDetail(roomId);
    return {
      detail,
      transcriptCursor: this.repository.getTranscriptCursor(detail.session.id),
      entries: this.repository.listTranscript(detail.session.id),
      runs: this.repository.listRuntimeRuns(detail.session.id),
      batches: this.repository.listRoomBatches(roomId),
      turns: this.repository.listRoomTurnsForRoom(roomId),
      liveState: this.executor.getLiveState(detail.session.id),
    };
  }

  send(command: RoomSendCommand): RoomSendResult {
    if (this.shuttingDown) throw new MsBotError("APP_INTERRUPTED");
    const prepared = this.repository.prepareRoomMessage(command);
    if (prepared.disposition === "duplicate") {
      return {
        clientNonce: command.clientNonce,
        batchId: prepared.batch.id,
        disposition: "duplicate",
        state: prepared.batch.state,
      };
    }
    this.events.transcript({ sessionId: command.sessionId, entry: this.repository.getUserMessage(command.clientNonce) });
    const batch = this.repository.transitionRoomBatch(prepared.batch.id, "running");
    this.emit(batch);
    this.startProcessing(batch.id);
    return { clientNonce: command.clientNonce, batchId: batch.id, disposition: "accepted", state: batch.state };
  }

  cancel(batchId: string): RoomBatch {
    const batch = this.repository.getRoomBatch(batchId);
    if (!["queued", "running"].includes(batch.state)) return batch;
    const turns = this.repository.listRoomTurns(batchId);
    for (const turn of turns) {
      if (turn.state === "queued") this.repository.transitionRoomTurn(turn.id, "cancelled");
      if (turn.state === "running" && turn.runtimeRunId) this.executor.cancelRun(turn.runtimeRunId);
    }
    const cancelled = this.repository.transitionRoomBatch(batchId, "cancelled");
    this.emit(cancelled);
    return cancelled;
  }

  retryTurn(turnId: string): RoomTurn {
    if (this.shuttingDown) throw new MsBotError("APP_INTERRUPTED");
    const turn = this.repository.createRoomTurnRetry(turnId);
    this.emit(this.repository.getRoomBatch(turn.batchId));
    this.startProcessing(turn.batchId, new Set([turn.id]));
    return turn;
  }

  continue(batchId: string): RoomBatch {
    if (this.shuttingDown) throw new MsBotError("APP_INTERRUPTED");
    const turns = this.repository.continueInterruptedRoomBatch(batchId);
    const batch = this.repository.getRoomBatch(batchId);
    this.emit(batch);
    this.startProcessing(batchId, new Set(turns.map((turn) => turn.id)));
    return batch;
  }

  beginShutdown(): void {
    this.shuttingDown = true;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const pending = [...this.inFlight.values()];
    if (pending.length > 0) {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_MS)),
      ]);
    }
    this.repository.recoverInterruptedRooms();
  }

  private startProcessing(batchId: string, onlyTurnIds?: Set<string>): void {
    const task = this.process(batchId, onlyTurnIds).finally(() => this.inFlight.delete(batchId));
    this.inFlight.set(batchId, task);
  }

  private async process(batchId: string, onlyTurnIds?: Set<string>): Promise<void> {
    const batch = this.repository.getRoomBatch(batchId);
    const room = this.repository.getRoom(batch.roomId);
    const user = this.repository.getUserMessage(batch.clientNonce);
    const turns = this.repository
      .listRoomTurns(batchId)
      .filter((turn) => turn.state === "queued" && (!onlyTurnIds || onlyTurnIds.has(turn.id)));

    for (const pending of turns) {
      if (this.shuttingDown || this.repository.getRoomBatch(batchId).state !== "running") break;
      const promptCutoffSeq = pending.promptCutoffSeq ?? this.repository.getTranscriptHighWater(batch.sessionId);
      let turn = this.repository.transitionRoomTurn(pending.id, "running", { promptCutoffSeq });
      this.emit(this.repository.getRoomBatch(batchId));
      try {
        const started = this.executor.start({
          clientNonce: batch.clientNonce,
          executorBotId: turn.memberBotId,
          executionKey: `${batch.id}:${turn.logicalTurnId}`,
          inputSeq: user.seq,
          promptCutoffSeq,
          attribution: {
            speakerBotId: turn.memberBotId,
            speakerNameSnapshot: turn.memberNameSnapshot,
            sourceTurnId: turn.id,
          },
          room: { id: room.id, membershipVersion: batch.membershipVersion, sourceTurnId: turn.id },
          onRunCreated: (run) => {
            turn = this.repository.attachRoomTurnRuntime(turn.id, run.id);
          },
        });
        this.emit(this.repository.getRoomBatch(batchId));
        const result = await started.completion;
        this.settleTurn(turn.id, result);
      } catch (error) {
        const appError = asAppError(error);
        const current = this.repository.getRoomTurn(turn.id);
        if (current.state === "running") {
          this.repository.transitionRoomTurn(turn.id, "failed", { errorCode: appError.code });
        }
        this.emit(this.repository.getRoomBatch(batchId), appError);
      }
      if (this.shuttingDown || this.repository.getRoomBatch(batchId).state !== "running") break;
    }

    const current = this.repository.getRoomBatch(batchId);
    if (this.shuttingDown && ["queued", "running"].includes(current.state)) {
      this.repository.recoverInterruptedRooms();
    } else if (current.state === "running") {
      this.emit(this.repository.finishRoomBatchFromTurns(batchId));
    }
  }

  private settleTurn(turnId: string, result: RuntimeExecutionResult): void {
    const turn = this.repository.getRoomTurn(turnId);
    if (turn.state !== "running") return;
    const state: RoomTurnState = result.run.state === "completed"
      ? "completed"
      : result.run.state === "cancelled"
        ? "cancelled"
        : result.run.state === "interrupted"
          ? "interrupted"
          : "failed";
    this.repository.transitionRoomTurn(turnId, state, { errorCode: result.error?.code ?? null });
    this.emit(this.repository.getRoomBatch(turn.batchId), result.error);
  }

  private emit(batch: RoomBatch, error?: AppError): void {
    this.events.roomRuntime({
      roomId: batch.roomId,
      sessionId: batch.sessionId,
      batch,
      turns: this.repository.listRoomTurns(batch.id),
      ...(error ? { error } : {}),
    });
  }
}
