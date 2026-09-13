import type {
  AppError,
  RoomBatch,
  RoomHandoffView,
  RoomRuntimeEvent,
  RoomRuntimeSnapshot,
  RoomSendCommand,
  RoomSendResult,
  RoomTurn,
  RoomTurnState,
  RoomRoutingMode,
} from "@shared/contracts";
import { digestRoomCommand, type AppRepository } from "./database";
import { asAppError, MsBotError } from "./errors";
import type { ModelEvent } from "./model";
import type { RuntimeExecutor, RuntimeExecutionResult } from "./runtime-executor";

type RoomCoordinatorEvents = {
  roomRuntime(event: RoomRuntimeEvent): void;
  transcript: (event: { sessionId: string; entry: ReturnType<AppRepository["getUserMessage"]> }) => void;
};

const SHUTDOWN_DRAIN_MS = 2_000;
const DEFAULT_MAX_TURNS = 8;
const DEFAULT_MAX_HOPS = 6;
const DEFAULT_MAX_TARGETS_PER_TURN = 2;
const DEFAULT_ROOT_DEADLINE_MS = 5 * 60_000;
const ROOM_ROUTER_TIMEOUT_MS = 30_000;

export type CoordinatedRoomPolicy = {
  maxTurns?: number;
  maxHops?: number;
  maxTargetsPerTurn?: number;
  deadlineMs?: number;
};

const EXPECTED_HANDOFF_REJECTIONS = new Set([
  "INVALID_REQUEST",
  "BOT_NOT_FOUND",
  "ROOM_ARCHIVED",
  "ROOM_MEMBERSHIP_CONFLICT",
  "ROOM_MEMBER_INVALID",
  "ROOM_RUN_LIMIT_EXCEEDED",
  "AGENT_TURN_CONFLICT",
  "HANDOFF_TARGET_CONFLICT",
  "HANDOFF_CYCLE",
  "HANDOFF_CONTEXT_INVALID",
  "RUNTIME_STATE_INVALID",
]);

function publicHandoffs(repository: AppRepository, runId: string): RoomHandoffView[] {
  return repository.listHandoffs(runId)
    .filter((handoff) => handoff.visibility === "room")
    .map(({ id, runId: handoffRunId, fromTurnId, toAgentId, targetTurnId, task, state, version, createdAt, updatedAt, finishedAt }) => ({
      id,
      runId: handoffRunId,
      fromTurnId,
      toAgentId,
      targetTurnId,
      task,
      state,
      version,
      createdAt,
      updatedAt,
      finishedAt,
    }));
}

export class RoomCoordinator {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly routingInFlight = new Map<string, { digest: string; promise: Promise<RoomSendResult> }>();
  private readonly routingControllers = new Set<AbortController>();
  private readonly deadlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private shuttingDown = false;

  constructor(
    private readonly repository: AppRepository,
    private readonly executor: RuntimeExecutor,
    private readonly events: RoomCoordinatorEvents,
  ) {}

  getSnapshot(roomId: string): RoomRuntimeSnapshot {
    const detail = this.repository.getRoomDetail(roomId);
    const batches = this.repository.listRoomBatches(roomId);
    return {
      detail,
      transcriptCursor: this.repository.getTranscriptCursor(detail.session.id),
      entries: this.repository.listTranscript(detail.session.id),
      runs: this.repository.listRuntimeRuns(detail.session.id),
      batches,
      turns: this.repository.listRoomTurnsForRoom(roomId),
      handoffs: batches.flatMap((batch) => publicHandoffs(this.repository, batch.id)),
      liveState: this.executor.getLiveState(detail.session.id),
    };
  }

  send(command: Omit<RoomSendCommand, "routingMode">): RoomSendResult {
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

  /** Internal M2 entry point. It is deliberately not exposed through preload or IPC. */
  sendCoordinated(command: RoomSendCommand, policy: CoordinatedRoomPolicy = {}): RoomSendResult {
    if (this.shuttingDown) throw new MsBotError("APP_INTERRUPTED");
    const routingMode = command.routingMode;
    if (routingMode === "automatic") throw new MsBotError("INVALID_REQUEST");
    this.assertRouteShape(command, routingMode);
    const deadlineMs = policy.deadlineMs ?? DEFAULT_ROOT_DEADLINE_MS;
    const existing = this.repository.getRoomBatchByNonce(command.clientNonce);
    if (!existing && (!Number.isFinite(deadlineMs) || deadlineMs <= 0)) throw new MsBotError("INVALID_REQUEST");
    if (!existing) this.assertLiveRoute(command, routingMode);
    const prepared = existing
      ? this.prepareExactDuplicate(command, existing)
      : this.repository.createRoomRunWithInitialTurns({
          roomId: command.roomId,
          sessionId: command.sessionId,
          clientNonce: command.clientNonce,
          text: command.text,
          membershipVersion: this.repository.getRoom(command.roomId).membershipVersion,
          maxTurns: policy.maxTurns ?? DEFAULT_MAX_TURNS,
          maxHops: policy.maxHops ?? DEFAULT_MAX_HOPS,
          maxTargetsPerTurn: policy.maxTargetsPerTurn ?? DEFAULT_MAX_TARGETS_PER_TURN,
          deadlineAt: new Date(Date.now() + deadlineMs).toISOString(),
          initialTurns: command.targetBotIds.map((agentId) => ({
            agentId,
            nonce: `initial:${command.clientNonce}:${agentId}`,
          })),
          routingMode,
          routingReason: null,
        });
    if (prepared.disposition === "duplicate") {
      return {
        clientNonce: command.clientNonce,
        batchId: prepared.run.id,
        disposition: "duplicate",
        state: prepared.run.state,
      };
    }
    this.events.transcript({ sessionId: command.sessionId, entry: this.repository.getUserMessage(command.clientNonce) });
    const run = this.repository.transitionRoomRun(prepared.run.id, "running");
    this.emit(run);
    this.armDeadline(run.id, run.deadlineAt);
    this.startProcessing(run.id, undefined, true);
    return { clientNonce: command.clientNonce, batchId: run.id, disposition: "accepted", state: run.state };
  }

  async routeAndSend(command: RoomSendCommand, policy: CoordinatedRoomPolicy = {}): Promise<RoomSendResult> {
    if (this.shuttingDown) throw new MsBotError("APP_INTERRUPTED");
    const routingMode = command.routingMode;
    this.assertRouteShape(command, routingMode);
    const commandDigest = digestRoomCommand(
      command.roomId,
      command.sessionId,
      command.text,
      command.targetBotIds,
      routingMode,
    );
    const pending = this.routingInFlight.get(command.clientNonce);
    if (pending) {
      if (pending.digest !== commandDigest) throw new MsBotError("MESSAGE_NONCE_CONFLICT");
      return pending.promise;
    }
    const existing = this.repository.getRoomBatchByNonce(command.clientNonce);
    if (existing) return this.duplicateResult(command, existing);
    const existingJournal = this.repository.getSend(command.clientNonce);
    if (existingJournal) {
      if (existingJournal.bodyDigest !== commandDigest) throw new MsBotError("MESSAGE_NONCE_CONFLICT");
      throw new MsBotError("ROOM_BATCH_NOT_FOUND");
    }
    if (routingMode !== "automatic") return this.sendCoordinated(command, policy);

    const promise = this.selectAndSend(command, policy).finally(() => {
      const current = this.routingInFlight.get(command.clientNonce);
      if (current?.promise === promise) this.routingInFlight.delete(command.clientNonce);
    });
    this.routingInFlight.set(command.clientNonce, { digest: commandDigest, promise });
    return promise;
  }

  cancel(batchId: string): RoomBatch {
    const batch = this.repository.getRoomBatch(batchId);
    if (!["queued", "running"].includes(batch.state)) return batch;
    if (this.isCoordinated(batchId) && (batch.windingDown || Date.parse(batch.deadlineAt) <= Date.now())) {
      if (!batch.windingDown) {
        this.stopCoordinatedRun(
          batchId,
          new MsBotError("ROOM_RUN_LIMIT_EXCEEDED", undefined, undefined, { reason: "deadline" }).toAppError(),
        );
      }
      return this.repository.getRoomBatch(batchId);
    }
    const turns = this.repository.listRoomTurns(batchId);
    this.repository.cancelOpenHandoffs(batchId);
    for (const turn of turns) {
      if (turn.state === "queued") this.repository.transitionRoomTurn(turn.id, "cancelled");
      if (turn.state === "running" && turn.runtimeRunId) this.executor.cancelRun(turn.runtimeRunId);
    }
    const cancelled = this.repository.transitionRoomBatch(batchId, "cancelled");
    this.clearDeadline(batchId);
    this.emit(cancelled);
    return cancelled;
  }

  retryTurn(turnId: string): RoomTurn {
    if (this.shuttingDown) throw new MsBotError("APP_INTERRUPTED");
    const turn = this.repository.createRoomTurnRetry(turnId);
    const run = this.repository.getRoomRun(turn.batchId);
    const coordinated = this.isCoordinated(turn.batchId);
    this.emit(run);
    if (coordinated) this.armDeadline(run.id, run.deadlineAt);
    this.startProcessing(turn.batchId, new Set([turn.id]), coordinated);
    return turn;
  }

  continue(batchId: string): RoomBatch {
    if (this.shuttingDown) throw new MsBotError("APP_INTERRUPTED");
    const turns = this.repository.continueInterruptedRoomBatch(batchId);
    const batch = this.repository.getRoomBatch(batchId);
    const coordinated = this.isCoordinated(batchId);
    this.emit(batch);
    if (coordinated) this.armDeadline(batch.id, batch.deadlineAt);
    this.startProcessing(batchId, new Set(turns.map((turn) => turn.id)), coordinated);
    return batch;
  }

  beginShutdown(): void {
    this.shuttingDown = true;
    for (const controller of this.routingControllers) controller.abort("app-shutdown");
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const controller of this.routingControllers) controller.abort("app-shutdown");
    for (const timer of this.deadlineTimers.values()) clearTimeout(timer);
    this.deadlineTimers.clear();
    const pending = [...this.inFlight.values()];
    if (pending.length > 0) {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_MS)),
      ]);
    }
    this.repository.recoverInterruptedRooms();
  }

  private startProcessing(batchId: string, onlyTurnIds?: Set<string>, coordinated = false): void {
    if (this.inFlight.has(batchId)) return;
    const task = this.process(batchId, onlyTurnIds, coordinated).finally(() => this.inFlight.delete(batchId));
    this.inFlight.set(batchId, task);
  }

  private async process(batchId: string, onlyTurnIds?: Set<string>, coordinated = false): Promise<void> {
    const batch = this.repository.getRoomBatch(batchId);
    const room = this.repository.getRoom(batch.roomId);
    const roomRoster = coordinated
      ? this.repository.listRoomMembers(room.id).map((member) => ({
          id: member.botId,
          name: member.bot.name,
          label: member.bot.label,
          description: member.bot.description,
        }))
      : undefined;
    while (true) {
      if (this.shuttingDown || this.repository.getRoomBatch(batchId).state !== "running") break;
      const pending = this.repository
        .listRoomTurns(batchId)
        .find((turn) => turn.state === "queued" && this.isInFrontier(turn, onlyTurnIds));
      if (!pending) break;
      if (coordinated) {
        try {
          if (this.repository.getIncomingHandoff(pending.id)?.visibility === "direct") {
            throw new MsBotError("INVALID_REQUEST");
          }
          this.repository.assertRoomTurnDispatchable(pending.id);
        } catch (error) {
          this.stopCoordinatedRun(batchId, asAppError(error));
          break;
        }
      }
      const promptCutoffSeq = pending.promptCutoffSeq
        ?? (pending.origin === "handoff" ? pending.inputSeq : this.repository.getTranscriptHighWater(batch.sessionId));
      const incomingBeforeDispatch = this.repository.getIncomingHandoff(pending.id);
      let turn: RoomTurn;
      try {
        if (incomingBeforeDispatch?.state === "queued") {
          this.repository.transitionHandoff(incomingBeforeDispatch.id, "dispatching", incomingBeforeDispatch.version);
        }
        turn = this.repository.transitionRoomTurn(pending.id, "running", { promptCutoffSeq });
      } catch (error) {
        this.settleHandoffFailure(pending.id, false);
        const appError = asAppError(error);
        this.stopCoordinatedRun(batchId, appError);
        break;
      }
      this.emit(this.repository.getRoomBatch(batchId));
      try {
        const incoming = this.repository.getIncomingHandoff(turn.id);
        const source = incoming ? this.repository.getRoomTurn(incoming.fromTurnId) : null;
        const started = this.executor.start({
          clientNonce: batch.clientNonce,
          executorBotId: turn.memberBotId,
          executionKey: `${batch.id}:${turn.logicalTurnId}`,
          inputSeq: turn.inputSeq,
          promptCutoffSeq,
          attribution: {
            speakerBotId: turn.memberBotId,
            speakerNameSnapshot: turn.memberNameSnapshot,
            sourceTurnId: turn.id,
          },
          room: {
            id: room.id,
            membershipVersion: batch.membershipVersion,
            sourceTurnId: turn.id,
            ...(roomRoster ? { roster: roomRoster } : {}),
          },
          ...(incoming && source
            ? {
                incomingHandoff: {
                  id: incoming.id,
                  fromAgentId: source.agentId,
                  task: incoming.task,
                  contextRefs: incoming.contextRefs,
                  visibility: incoming.visibility,
                  createdAt: incoming.createdAt,
                },
              }
            : {}),
          ...(coordinated
            ? { onHandoff: (event: Extract<ModelEvent, { type: "handoff" }>) => this.acceptHandoff(batchId, turn.id, event) }
            : {}),
          onRunCreated: (run) => {
            turn = this.repository.attachRoomTurnRuntime(turn.id, run.id);
          },
          ...(incoming
            ? {
                onProviderStarted: () => {
                  const handoff = this.repository.getHandoff(incoming.id);
                  if (handoff.state === "dispatching") {
                    this.repository.transitionHandoff(handoff.id, "accepted", handoff.version);
                    this.emit(this.repository.getRoomRun(batchId));
                  }
                },
              }
            : {}),
        });
        this.emit(this.repository.getRoomBatch(batchId));
        const result = await started.completion;
        this.settleTurn(turn.id, result);
        this.settleHandoff(turn.id, result);
      } catch (error) {
        const appError = asAppError(error);
        const current = this.repository.getRoomTurn(turn.id);
        if (current.state === "running") {
          this.repository.transitionRoomTurn(turn.id, "failed", {
            errorCode: appError.code,
            outcome: { kind: "error", errorCode: appError.code },
          });
        }
        this.settleHandoffFailure(turn.id, appError.code === "MESSAGE_CANCELLED");
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
    if (!["queued", "running"].includes(this.repository.getRoomBatch(batchId).state)) this.clearDeadline(batchId);
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
    this.repository.transitionRoomTurn(turnId, state, {
      errorCode: result.error?.code ?? null,
      outcome: state === "completed"
        ? { kind: "sent" }
        : state === "cancelled"
          ? { kind: "cancelled", ...(result.error ? { errorCode: result.error.code } : {}) }
          : result.error?.code === "MODEL_RUN_TIMEOUT"
            ? { kind: "timeout", errorCode: result.error.code }
            : { kind: "error", ...(result.error ? { errorCode: result.error.code } : {}) },
    });
    this.emit(this.repository.getRoomBatch(turn.batchId), result.error);
  }

  private emit(batch: RoomBatch, error?: AppError): void {
    this.events.roomRuntime({
      roomId: batch.roomId,
      sessionId: batch.sessionId,
      batch,
      turns: this.repository.listRoomTurns(batch.id),
      handoffs: publicHandoffs(this.repository, batch.id),
      ...(error ? { error } : {}),
    });
  }

  private prepareExactDuplicate(command: RoomSendCommand, existing: RoomBatch): ReturnType<AppRepository["createRoomRunWithInitialTurns"]> {
    const routingMode = command.routingMode;
    const journal = this.repository.getSendOrThrow(command.clientNonce);
    if (journal.bodyDigest !== digestRoomCommand(command.roomId, command.sessionId, command.text, command.targetBotIds, routingMode)) {
      throw new MsBotError("MESSAGE_NONCE_CONFLICT");
    }
    if (existing.routingMode !== routingMode) throw new MsBotError("MESSAGE_NONCE_CONFLICT");
    const initialTurns = this.repository.listRoomTurns(existing.id).filter((turn) => turn.origin === "initial");
    return this.repository.createRoomRunWithInitialTurns({
      roomId: existing.roomId,
      sessionId: existing.sessionId,
      clientNonce: command.clientNonce,
      text: command.text,
      membershipVersion: existing.membershipVersion,
      maxTurns: existing.maxTurns,
      maxHops: existing.maxHops,
      maxTargetsPerTurn: existing.maxTargetsPerTurn,
      deadlineAt: existing.deadlineAt,
      initialTurns: initialTurns.map((turn) => ({ agentId: turn.agentId, nonce: turn.nonce })),
      routingMode: existing.routingMode,
      routingReason: existing.routingReason,
    });
  }

  private duplicateResult(command: RoomSendCommand, existing: RoomBatch): RoomSendResult {
    const prepared = this.prepareExactDuplicate(command, existing);
    return {
      clientNonce: command.clientNonce,
      batchId: prepared.run.id,
      disposition: "duplicate",
      state: prepared.run.state,
    };
  }

  private assertRouteShape(command: RoomSendCommand, routingMode: Exclude<RoomRoutingMode, "legacy">): void {
    if (!["automatic", "explicit", "everyone"].includes(routingMode)) throw new MsBotError("INVALID_REQUEST");
    const uniqueTargets = new Set(command.targetBotIds);
    if (uniqueTargets.size !== command.targetBotIds.length || command.targetBotIds.length > 6) {
      throw new MsBotError("INVALID_REQUEST");
    }
    if (routingMode === "automatic") {
      if (command.targetBotIds.length !== 0) throw new MsBotError("INVALID_REQUEST");
      return;
    }
    if (command.targetBotIds.length === 0) throw new MsBotError("INVALID_REQUEST");
  }

  private assertLiveRoute(command: RoomSendCommand, routingMode: "explicit" | "everyone"): void {
    const detail = this.repository.getRoomDetail(command.roomId);
    if (detail.session.id !== command.sessionId) throw new MsBotError("SESSION_NOT_FOUND");
    const memberIds = detail.members.map((member) => member.botId);
    const uniqueTargets = new Set(command.targetBotIds);
    if (command.targetBotIds.some((id) => !memberIds.includes(id))) throw new MsBotError("ROOM_MEMBER_INVALID");
    if (routingMode === "everyone" && (
      command.targetBotIds.length !== memberIds.length || memberIds.some((id) => !uniqueTargets.has(id))
    )) {
      throw new MsBotError("ROOM_MEMBER_INVALID");
    }
  }

  private async selectAndSend(command: RoomSendCommand, policy: CoordinatedRoomPolicy): Promise<RoomSendResult> {
    const deadlineMs = policy.deadlineMs ?? DEFAULT_ROOT_DEADLINE_MS;
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new MsBotError("INVALID_REQUEST");
    const detail = this.repository.getRoomDetail(command.roomId);
    if (detail.session.id !== command.sessionId) throw new MsBotError("SESSION_NOT_FOUND");
    if (detail.room.archivedAt) throw new MsBotError("ROOM_ARCHIVED");
    if (this.repository.getActiveRoomBatch(detail.session.id) || this.repository.getActiveRuntimeRun(detail.session.id)) {
      throw new MsBotError("ROOM_BATCH_BUSY");
    }
    const roster = detail.members.map((member) => ({
      id: member.botId,
      name: member.bot.name,
      label: member.bot.label,
      description: member.bot.description,
    }));
    const controller = new AbortController();
    this.routingControllers.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort("router-timeout");
    }, ROOM_ROUTER_TIMEOUT_MS);
    try {
      const abortGate = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => {
          reject(new MsBotError(timedOut ? "MODEL_ROUTER_TIMEOUT" : "APP_INTERRUPTED"));
        }, { once: true });
      });
      const selectionPromise = this.executor.selectRoomOwner(command.text, roster, controller.signal);
      // Promise.race installs rejection handlers on both inputs. A provider that
      // ignores Abort can settle late, but it can no longer reach persistence.
      const selection: unknown = await Promise.race([selectionPromise, abortGate]);
      if (timedOut) throw new MsBotError("MODEL_ROUTER_TIMEOUT");
      if (this.shuttingDown || controller.signal.aborted) throw new MsBotError("APP_INTERRUPTED");
      if (!selection || typeof selection !== "object" || Array.isArray(selection)) throw new MsBotError("MODEL_ROUTER_INVALID");
      const values = selection as Record<string, unknown>;
      if (
        Object.keys(values).toSorted().join("\0") !== ["ownerAgentId", "reason"].toSorted().join("\0") ||
        typeof values.ownerAgentId !== "string" || typeof values.reason !== "string"
      ) {
        throw new MsBotError("MODEL_ROUTER_INVALID");
      }
      if (!roster.some((peer) => peer.id === values.ownerAgentId)) throw new MsBotError("MODEL_ROUTER_INVALID");
      const reason = values.reason.trim();
      if (!reason || reason.length > 240) throw new MsBotError("MODEL_ROUTER_INVALID");
      const prepared = this.repository.createRoomRunWithInitialTurns({
        roomId: command.roomId,
        sessionId: command.sessionId,
        clientNonce: command.clientNonce,
        text: command.text,
        membershipVersion: detail.room.membershipVersion,
        maxTurns: policy.maxTurns ?? DEFAULT_MAX_TURNS,
        maxHops: policy.maxHops ?? DEFAULT_MAX_HOPS,
        maxTargetsPerTurn: policy.maxTargetsPerTurn ?? DEFAULT_MAX_TARGETS_PER_TURN,
        deadlineAt: new Date(Date.now() + deadlineMs).toISOString(),
        initialTurns: [{ agentId: values.ownerAgentId, nonce: `initial:${command.clientNonce}:${values.ownerAgentId}` }],
        routingMode: "automatic",
        routingReason: reason,
      });
      if (prepared.disposition === "duplicate") return this.duplicateResult(command, prepared.run);
      this.events.transcript({ sessionId: command.sessionId, entry: this.repository.getUserMessage(command.clientNonce) });
      const run = this.repository.transitionRoomRun(prepared.run.id, "running");
      this.emit(run);
      this.armDeadline(run.id, run.deadlineAt);
      this.startProcessing(run.id, undefined, true);
      return { clientNonce: command.clientNonce, batchId: run.id, disposition: "accepted", state: run.state };
    } finally {
      clearTimeout(timer);
      this.routingControllers.delete(controller);
    }
  }

  private acceptHandoff(
    runId: string,
    fromTurnId: string,
    event: Extract<ModelEvent, { type: "handoff" }>,
  ): void {
    try {
      if (
        typeof event.toolCallId !== "string" ||
        typeof event.toAgentId !== "string" ||
        typeof event.task !== "string" ||
        !Array.isArray(event.contextRefs) ||
        event.contextRefs.some((reference) => typeof reference !== "string") ||
        !event.toolCallId.trim()
      ) {
        throw new MsBotError("INVALID_REQUEST");
      }
      if (event.visibility !== "room") throw new MsBotError("INVALID_REQUEST");
      const source = this.repository.getRoomTurn(fromTurnId);
      const created = this.repository.createHandoff({
        runId,
        fromTurnId,
        toAgentId: event.toAgentId,
        task: event.task,
        contextRefs: event.contextRefs,
        visibility: event.visibility,
        targetTurnNonce: event.toolCallId,
        inputGeneration: source.inputGeneration,
        inputSeq: source.promptCutoffSeq ?? source.inputSeq,
      });
      if (created.disposition === "duplicate") return;
      this.emit(this.repository.getRoomRun(runId));
    } catch (error) {
      if (error instanceof MsBotError && EXPECTED_HANDOFF_REJECTIONS.has(error.code)) {
        this.emit(this.repository.getRoomRun(runId), error.toAppError());
        return;
      }
      throw error;
    }
  }

  private armDeadline(runId: string, deadlineAt: string): void {
    this.clearDeadline(runId);
    const delay = Math.max(0, Date.parse(deadlineAt) - Date.now());
    const timer = setTimeout(() => {
      this.deadlineTimers.delete(runId);
      this.stopCoordinatedRun(
        runId,
        new MsBotError("ROOM_RUN_LIMIT_EXCEEDED", undefined, undefined, { reason: "deadline" }).toAppError(),
      );
    }, delay);
    this.deadlineTimers.set(runId, timer);
  }

  private clearDeadline(runId: string): void {
    const timer = this.deadlineTimers.get(runId);
    if (timer) clearTimeout(timer);
    this.deadlineTimers.delete(runId);
  }

  private stopCoordinatedRun(runId: string, error: AppError): void {
    const current = this.repository.getRoomRun(runId);
    if (!["queued", "running"].includes(current.state)) return;
    if (!current.windingDown) this.repository.markRoomRunWindingDown(runId);
    this.repository.cancelOpenHandoffs(runId);
    for (const turn of this.repository.listAgentTurns(runId)) {
      if (turn.state === "queued") {
        this.repository.transitionAgentTurn(turn.id, "cancelled", {
          errorCode: error.code,
          outcome: { kind: "cancelled", errorCode: error.code },
        });
      } else if (turn.state === "running" && turn.runtimeRunId) {
        const deadline = error.code === "ROOM_RUN_LIMIT_EXCEEDED" && error.details?.reason === "deadline";
        this.executor.cancelRun(turn.runtimeRunId, deadline ? "deadline" : "user");
      }
    }
    const after = this.repository.getRoomRun(runId);
    if (after.state === "running" && !this.repository.listAgentTurns(runId).some((turn) => turn.state === "running")) {
      this.repository.finishRoomBatchFromTurns(runId);
    }
    this.emit(this.repository.getRoomRun(runId), error);
  }

  private settleHandoff(turnId: string, result: RuntimeExecutionResult): void {
    const handoff = this.repository.getIncomingHandoff(turnId);
    if (!handoff || handoff.state !== "dispatching") return;
    this.repository.transitionHandoff(
      handoff.id,
      result.run.state === "cancelled" ? "cancelled" : "failed",
      handoff.version,
    );
  }

  private settleHandoffFailure(turnId: string, cancelled: boolean): void {
    const handoff = this.repository.getIncomingHandoff(turnId);
    if (!handoff || handoff.state !== "dispatching") return;
    this.repository.transitionHandoff(handoff.id, cancelled ? "cancelled" : "failed", handoff.version);
  }

  private isInFrontier(turn: RoomTurn, onlyTurnIds?: Set<string>): boolean {
    if (!onlyTurnIds) return true;
    let current: RoomTurn | null = turn;
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      if (onlyTurnIds.has(current.id)) return true;
      visited.add(current.id);
      current = current.parentTurnId ? this.repository.getRoomTurn(current.parentTurnId) : null;
    }
    return false;
  }

  private isCoordinated(runId: string): boolean {
    return this.repository.isCoordinatedRoomRun(runId);
  }
}
