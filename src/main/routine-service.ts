import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import type { AttachmentDraft, Routine, RoutineRun, RoutineSchedule, RoutineMessageOrigin } from "@shared/contracts";
import type { RoutineCreateInput, RoutineRunCancelInput, RoutineTriggerInput, RoutineUpdatePatch, RoutineContext, RoutineRunNowInput } from "@shared/routine-contracts";
import { routineRunCancelSchema, routineRunNowIpcSchema } from "@shared/routine-schemas";
import type { AppRepository } from "./database";
import { AevorenBotError } from "./errors";
import type { SendWorker } from "./send-worker";
import type { RoomCoordinator } from "./room-coordinator";

const TICK_MS = Math.max(100, Number(process.env.AEVOREN_BOT_ROUTINE_TICK_MS ?? 15_000));
const MISSED_AFTER_MS = 12 * 60 * 60_000;
const terminal = (state: RoutineRun["state"]) => ["completed", "failed", "cancelled", "missed", "unknown"].includes(state);
function nextRun(schedule: RoutineSchedule, after: number): number | null {
  if (schedule.type === "once") return schedule.at > after ? schedule.at : null;
  if (schedule.type === "interval") {
    const step = schedule.everyMinutes * 60_000;
    return schedule.anchorAt > after ? schedule.anchorAt : schedule.anchorAt + (Math.floor((after - schedule.anchorAt) / step) + 1) * step;
  }
  try {
    return new Cron(schedule.expression, { timezone: schedule.timeZone, mode: "5-part", paused: true }).nextRun(new Date(after))?.getTime() ?? null;
  }
  catch {
    throw new AevorenBotError("ROUTINE_SCHEDULE_INVALID");
  }

}

export class RoutineService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private closing = false;
  private readonly dispatches = new Map<string, Promise<void>>();
  constructor(private readonly repository: AppRepository, private readonly sendWorker: SendWorker, private readonly notify: (run: RoutineRun) => void,
    private readonly clock: () => number = () => Date.now(), private readonly rooms?: RoomCoordinator) { }
  start(): void {
    if (this.timer || this.closing) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
    void this.tick();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    this.stop();
    await Promise.allSettled(this.dispatches.values());
  }
  /** Host terminal-event bridge: settle receipts before admitting dependent events, without advancing schedules. */
  async reconcileCompletedRuns(): Promise<void> {
    for (const run of this.repository.listPendingRoutineRuns()) await this.reconcileOne(run);
  }
  assertOperationScope(operation: string, input: unknown, context?: RoutineContext): void {
    if (!context) return;
    const session = this.repository.getSession(context.sessionId);
    this.repository.assertSessionExecutor(session.id, context.executorBotId);
    if (session.kind !== "MAIN") throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");
    if (context.runtimeRunId) {
      const runtime = this.repository.getRuntimeRun(context.runtimeRunId);
      if (runtime.sessionId !== session.id || runtime.executorBotId !== context.executorBotId || runtime.inputGeneration !== session.generation || !["running", "streaming"].includes(runtime.state)) throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");
    }
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    let targetSessionId: string | undefined;
    if (operation === "routines.create") {
      const value = input as RoutineCreateInput;
      if (value.target) targetSessionId = value.target.sessionId;
      else if (value.botId !== session.botId) throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");
    } else if (operation === "routines.cancelRun") targetSessionId = this.repository.getRoutineRun(record.runId as string).targetSnapshot.target.sessionId;
    else if (operation !== "routines.list" && !(operation === "routines.listRuns" && input === undefined)) {
      const id = typeof input === "string" ? input : record.id as string;
      targetSessionId = this.repository.getRoutine(id).target.sessionId;
    }
    if (targetSessionId && targetSessionId !== session.id) throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");
    if (operation === "routines.update") {
      const target = (record.patch as RoutineUpdatePatch).target;
      if (target && target.sessionId !== session.id) throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");
    }
  }
  list(context?: RoutineContext): Routine[] {
    this.assertOperationScope("routines.list", undefined, context);
    return this.repository.listRoutines().filter(value => !context || value.target.sessionId === context.sessionId);
  }
  listRuns(id?: string, context?: RoutineContext): RoutineRun[] {
    this.assertOperationScope("routines.listRuns", id, context);
    return this.repository.listRoutineRuns(id).filter(value => !context || value.targetSnapshot.target.sessionId === context.sessionId);
  }
  getByTriggerKey(key: string): RoutineRun | null {
    return this.repository.routineTargets.getByTriggerKey(key);
  }
  create(input: RoutineCreateInput, context?: RoutineContext): Routine {
    this.assertOperationScope("routines.create", input, context);
    const enabled = input.enabled ?? false, nextRunAt = enabled ? nextRun(input.schedule, this.clock() - 1) : null;
    if (enabled && nextRunAt === null) throw new AevorenBotError("ROUTINE_SCHEDULE_INVALID");
    return this.repository.createRoutine({ ...input, enabled, nextRunAt });
  }
  update(id: string, expectedVersion: number, patch: RoutineUpdatePatch, context?: RoutineContext): Routine {
    this.assertOperationScope("routines.update", { id, patch }, context);
    const current = this.repository.getRoutine(id), schedule = patch.schedule ?? current.schedule, nextRunAt = current.enabled ? nextRun(schedule, this.clock() - 1) : null;
    if (current.enabled && nextRunAt === null) throw new AevorenBotError("ROUTINE_SCHEDULE_INVALID");
    return this.repository.updateRoutine(id, expectedVersion, patch, nextRunAt);
  }
  setEnabled(id: string, expectedVersion: number, enabled: boolean, context?: RoutineContext): Routine {
    this.assertOperationScope("routines.setEnabled", { id }, context);
    const current = this.repository.getRoutine(id), nextRunAt = enabled ? nextRun(current.schedule, this.clock() - 1) : null;
    if (enabled && nextRunAt === null) throw new AevorenBotError("ROUTINE_SCHEDULE_INVALID");
    return this.repository.setRoutineEnabled(id, expectedVersion, enabled, nextRunAt);
  }
  delete(id: string, expectedVersion: number, context?: RoutineContext): void {
    this.assertOperationScope("routines.delete", { id }, context);
    this.repository.deleteRoutine(id, expectedVersion);
  }
  hasEnabled(): boolean {
    return this.repository.hasEnabledRoutines();
  }
  async runNow(input: RoutineRunNowInput, context?: RoutineContext): Promise<RoutineRun> {
    const parsed = routineRunNowIpcSchema.parse(input);
    if (context && typeof parsed === "string") throw new AevorenBotError("INVALID_REQUEST");
    this.assertOperationScope("routines.runNow", parsed, context);
    const id = typeof parsed === "string" ? parsed : parsed.id, routine = this.repository.getRoutine(id);
    const triggerKey = context?.runtimeRunId ? `${id}:model:${this.repository.getRuntimeRun(context.runtimeRunId).clientNonce}:${context.executorBotId}` : `${id}:manual:${randomUUID()}`;
    const result = await this.createTriggerRun({ routineId: id, expectedVersion: typeof parsed === "string" ? routine.version : parsed.expectedVersion, triggerKey, trigger: "manual" });
    this.assertOperationScope("routines.runNow", parsed, context);
    return result;
  }
  /** eventAttachment is host-only untrusted data, never part of the public trigger schema. */
  async createTriggerRun(input: RoutineTriggerInput, eventAttachment?: AttachmentDraft): Promise<RoutineRun> {
    if (this.closing) throw new AevorenBotError("APP_INTERRUPTED");
    const run = this.repository.routineTargets.createTrigger(input, this.clock(), eventAttachment);
    if (["queued", "waiting"].includes(run.state)) await this.dispatch(run);
    return this.repository.getRoutineRun(run.id);
  }
  async cancelRun(input: RoutineRunCancelInput, context?: RoutineContext): Promise<RoutineRun> {
    this.assertOperationScope("routines.cancelRun", input, context);
    const parsed = routineRunCancelSchema.parse(input), run = this.repository.getRoutineRun(parsed.runId);
    if (run.version !== parsed.expectedVersion) throw new AevorenBotError("ROUTINE_VERSION_CONFLICT", undefined, undefined, { currentVersion: run.version });
    if (terminal(run.state)) return run;
    const cancelling = this.repository.routineTargets.transition(run.id, ["queued", "waiting"].includes(run.state) ? "cancelled" : "cancel-requested", null, run.version);
    await this.stopOwned(cancelling);
    return this.repository.getRoutineRun(run.id);
  }
  private async stopOwned(run: RoutineRun): Promise<void> {
    if (run.runtimeRunId) {
      const runtime = this.repository.getRuntimeRun(run.runtimeRunId);
      if (["created", "dispatching", "running", "streaming", "cancel-requested"].includes(runtime.state)) this.sendWorker.executor.cancelRun(runtime.id);
    }
    if (run.batchId) {
      const batch = this.repository.getRoomBatch(run.batchId);
      if (["queued", "running"].includes(batch.state)) this.rooms?.cancel(batch.id);
    }
    await this.reconcileOne(this.repository.getRoutineRun(run.id));
  }
  async tick(): Promise<void> {
    if (this.ticking || this.closing) return;
    this.ticking = true;
    try {
      for (const run of this.repository.listPendingRoutineRuns()) await this.reconcileOne(run);
      const now = this.clock();
      for (const routine of this.repository.listRoutines()) {
        if (!routine.enabled || routine.nextRunAt === null || routine.nextRunAt > now) continue;
        const scheduledFor = routine.nextRunAt, run = this.repository.advanceRoutineAndCreateRun(routine.id, scheduledFor, nextRun(routine.schedule, scheduledFor), now - scheduledFor > MISSED_AFTER_MS);
        if (run && terminal(run.state)) this.notify(run);
      }
      for (const run of this.repository.listPendingRoutineRuns()) if (["queued", "waiting"].includes(run.state)) await this.dispatch(run);
    } finally {
      this.ticking = false;
    }
  }
  private dispatch(run: RoutineRun): Promise<void> {
    const existing = this.dispatches.get(run.id);
    if (existing) return existing;
    const promise = this.dispatchOnce(run.id).finally(() => this.dispatches.delete(run.id));
    this.dispatches.set(run.id, promise);
    return promise;
  }
  private async dispatchOnce(id: string): Promise<void> {
    let run = this.repository.getRoutineRun(id);
    if (!["queued", "waiting"].includes(run.state) || this.closing) return;
    const target = run.targetSnapshot.target, sessionId = target.sessionId;
    if (this.repository.getActiveRuntimeRun(sessionId) || target.kind === "room" && this.repository.getActiveRoomBatch(sessionId)) {
      if (run.state !== "waiting") this.repository.transitionRoutineRun(id, "waiting");
      return;
    }
    try {
      run = this.repository.routineTargets.claim(id);
      const assertCurrent = () => {
        if (this.closing) throw new AevorenBotError("APP_INTERRUPTED");
        this.repository.routineTargets.assertRun(id);
      };
      const origin: RoutineMessageOrigin = { kind: "routine", routineId: run.routineId, routineRunId: run.id, fromBotNameSnapshot: run.routineName, ...(target.kind === "bot" ? { fromBotId: target.botId } : {}), fromSessionId: sessionId, fromRuntimeRunId: "", rootClientNonce: run.clientNonce, depth: 0 };
      const attachment = this.repository.routineTargets.eventAttachment(id);
      const command = { sessionId, clientNonce: run.clientNonce, text: `[Routine: ${run.routineName}]\n${run.promptSnapshot}`, attachments: attachment ? [attachment] : [], resourceRefs: run.targetSnapshot.resourceRefs, mediaRefs: run.targetSnapshot.mediaRefs };
      assertCurrent();
      if (target.kind === "bot") {
        const accepted = this.sendWorker.send(command, origin);
        run = this.repository.routineTargets.attach(id, { runtimeRunId: accepted.runId });
      }
      else {
        if (!this.rooms) throw new AevorenBotError("ROUTINE_RUN_STATE_INVALID", "群聊自动任务尚未连接调度器。");
        const accepted = await this.rooms.routeAndSend({ ...command, roomId: target.roomId, routingMode: target.routingMode, targetBotIds: target.targetBotIds }, { origin, assertCurrent });
        run = this.repository.routineTargets.attach(id, { batchId: accepted.batchId });
      }
      if (run.state === "cancel-requested") await this.stopOwned(run);
    } catch (error) {
      const current = this.repository.getRoutineRun(id);
      if (terminal(current.state)) return;
      // Runtime/Room acceptance is durable under the original nonce. An error
      // after acceptance never manufactures another message or dispatch.
      let recovered: { runtimeRunId: string } | { batchId: string } | null;
      try {
        recovered = this.accepted(current);
      } catch {
        const unknown = this.repository.transitionRoutineRun(id, "unknown", "MESSAGE_NONCE_CONFLICT");
        this.notify(unknown);
        return;
      }
      if (recovered) {
        run = this.repository.routineTargets.attach(id, recovered);
        if (run.state === "cancel-requested") await this.stopOwned(run);
        return;
      }
      const failed = this.repository.transitionRoutineRun(id, current.state === "cancel-requested" ? "cancelled" : "failed", error instanceof AevorenBotError ? error.code : "INTERNAL_ERROR");
      this.notify(failed);
    }
  }
  private accepted(run: RoutineRun): { runtimeRunId: string } | { batchId: string } | null {
    const target = run.targetSnapshot.target;
    const link = target.kind === "room" ? this.repository.getRoomBatchByNonce(run.clientNonce) : this.repository.getLatestRuntimeRun(run.clientNonce);
    if (!link) return null;
    const result = target.kind === "room" ? { batchId: link.id } : { runtimeRunId: link.id };
    this.repository.routineTargets.assertReceipt(run.id, result);
    return result;
  }
  private async reconcileOne(run: RoutineRun): Promise<void> {
    if (terminal(run.state)) return;
    if (run.state === "dispatching" && !this.dispatches.has(run.id)) {
      let accepted: { runtimeRunId: string } | { batchId: string } | null;
      try {
        accepted = this.accepted(run);
      } catch {
        const unknown = this.repository.transitionRoutineRun(run.id, "unknown", "MESSAGE_NONCE_CONFLICT");
        this.notify(unknown);
        return;
      }
      if (accepted) {
        this.repository.routineTargets.attach(run.id, accepted);
        return this.reconcileOne(this.repository.getRoutineRun(run.id));
      }
      const unknown = this.repository.transitionRoutineRun(run.id, "unknown", "ROUTINE_RUN_STATE_INVALID");
      this.notify(unknown);
      return;
    }
    if (!run.runtimeRunId && !run.batchId) {
      if (run.state === "cancel-requested" && !this.dispatches.has(run.id)) this.repository.transitionRoutineRun(run.id, "cancelled");
      return;
    }
    const owned = run.runtimeRunId ? this.repository.getRuntimeRun(run.runtimeRunId) : this.repository.getRoomBatch(run.batchId!);
    if (["completed", "partial", "failed", "cancelled", "interrupted"].includes(owned.state)) {
      const state = run.state === "cancel-requested" ? (run.lastErrorCode ? "failed" : "cancelled") : owned.state === "completed" ? "completed" : owned.state === "cancelled" ? "cancelled" : "failed";
      const result = this.repository.transitionRoutineRun(run.id, state, run.lastErrorCode ?? ("lastErrorCode" in owned ? owned.lastErrorCode : null));
      this.notify(result);
      return;
    }
    if (run.state === "cancel-requested") return;
    try {
      this.repository.routineTargets.assertRun(run.id);
    } catch (error) {
      const stopping = this.repository.routineTargets.transition(run.id, "cancel-requested", error instanceof AevorenBotError ? error.code : "INTERNAL_ERROR");
      if (stopping.runtimeRunId) this.sendWorker.executor.cancelRun(stopping.runtimeRunId);
      if (stopping.batchId) this.rooms?.cancel(stopping.batchId);
    }
  }

}
