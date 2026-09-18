import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import type { Routine, RoutineRun, RoutineSchedule } from "@shared/contracts";
import type { AppRepository } from "./database";
import { AevorenBotError } from "./errors";
import type { SendWorker } from "./send-worker";

const TICK_MS = Math.max(100, Number(process.env.AEVOREN_BOT_ROUTINE_TICK_MS ?? 15_000));
const MISSED_AFTER_MS = 12 * 60 * 60_000;

function nextRun(schedule: RoutineSchedule, after: number): number | null {
  if (schedule.type === "once") return schedule.at > after ? schedule.at : null;
  if (schedule.type === "interval") {
    const step = schedule.everyMinutes * 60_000;
    if (schedule.anchorAt > after) return schedule.anchorAt;
    return schedule.anchorAt + (Math.floor((after - schedule.anchorAt) / step) + 1) * step;
  }
  try {
    const cron = new Cron(schedule.expression, { timezone: schedule.timeZone, mode: "5-part", paused: true });
    return cron.nextRun(new Date(after))?.getTime() ?? null;
  } catch {
    throw new AevorenBotError("ROUTINE_SCHEDULE_INVALID");
  }
}

export class RoutineService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    private readonly repository: AppRepository,
    private readonly sendWorker: SendWorker,
    private readonly notify: (run: RoutineRun) => void,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  list(): Routine[] {
    return this.repository.listRoutines();
  }

  listRuns(routineId?: string): RoutineRun[] {
    return this.repository.listRoutineRuns(routineId);
  }

  create(input: { name: string; prompt: string; botId: string; schedule: RoutineSchedule; enabled?: boolean }): Routine {
    const enabled = input.enabled ?? false;
    const nextRunAt = enabled ? nextRun(input.schedule, this.clock() - 1) : null;
    if (enabled && nextRunAt === null) throw new AevorenBotError("ROUTINE_SCHEDULE_INVALID");
    return this.repository.createRoutine({ ...input, enabled, nextRunAt });
  }

  update(id: string, expectedVersion: number, patch: Partial<Pick<Routine, "name" | "prompt" | "schedule">>): Routine {
    const current = this.repository.getRoutine(id);
    const schedule = patch.schedule ?? current.schedule;
    const nextRunAt = current.enabled ? nextRun(schedule, this.clock() - 1) : null;
    if (current.enabled && nextRunAt === null) throw new AevorenBotError("ROUTINE_SCHEDULE_INVALID");
    return this.repository.updateRoutine(id, expectedVersion, patch, nextRunAt);
  }

  setEnabled(id: string, expectedVersion: number, enabled: boolean): Routine {
    const current = this.repository.getRoutine(id);
    const nextRunAt = enabled ? nextRun(current.schedule, this.clock() - 1) : null;
    if (enabled && nextRunAt === null) throw new AevorenBotError("ROUTINE_SCHEDULE_INVALID");
    return this.repository.setRoutineEnabled(id, expectedVersion, enabled, nextRunAt);
  }

  async runNow(id: string): Promise<RoutineRun> {
    const routine = this.repository.getRoutine(id);
    if (this.repository.listPendingRoutineRuns().some((run) => run.routineId === id)) throw new AevorenBotError("ROUTINE_BUSY");
    const run = this.repository.createRoutineRun(routine, "manual", `${routine.id}:manual:${randomUUID()}`, this.clock());
    await this.dispatch(run);
    return this.repository.getRoutineRun(run.id);
  }

  delete(id: string, expectedVersion: number): void {
    this.repository.deleteRoutine(id, expectedVersion);
  }

  hasEnabled(): boolean {
    return this.repository.hasEnabledRoutines();
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.reconcile();
      const now = this.clock();
      for (const routine of this.repository.listRoutines()) {
        if (!routine.enabled || routine.nextRunAt === null || routine.nextRunAt > now) continue;
        const scheduledFor = routine.nextRunAt;
        const following = nextRun(routine.schedule, scheduledFor);
        const run = this.repository.advanceRoutineAndCreateRun(
          routine.id,
          scheduledFor,
          following,
          now - scheduledFor > MISSED_AFTER_MS,
        );
        if (run?.state === "missed") this.notify(run);
      }
      for (const run of this.repository.listPendingRoutineRuns().filter((candidate) => candidate.state !== "running")) {
        await this.dispatch(run);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async dispatch(run: RoutineRun): Promise<void> {
    const session = this.repository.getMainSession(run.botId);
    if (this.repository.getActiveRuntimeRun(session.id)) {
      if (run.state !== "waiting") this.repository.transitionRoutineRun(run.id, "waiting");
      return;
    }
    try {
      const sent = this.sendWorker.send({
        sessionId: session.id,
        clientNonce: run.clientNonce,
        text: `[Routine: ${run.routineName}]\n${run.promptSnapshot}`,
      });
      this.repository.attachRoutineRuntime(run.id, sent.runId);
    } catch (error) {
      const code = error instanceof AevorenBotError ? error.code : "INTERNAL_ERROR";
      const failed = this.repository.transitionRoutineRun(run.id, "failed", code);
      this.notify(failed);
    }
  }

  private async reconcile(): Promise<void> {
    for (const run of this.repository.listPendingRoutineRuns()) {
      if (run.state !== "running" || !run.runtimeRunId) continue;
      const runtime = this.repository.getRuntimeRun(run.runtimeRunId);
      if (!["completed", "failed", "cancelled", "interrupted"].includes(runtime.state)) continue;
      const state = runtime.state === "completed" ? "completed" : runtime.state === "cancelled" ? "cancelled" : "failed";
      const settled = this.repository.transitionRoutineRun(run.id, state, runtime.lastErrorCode);
      this.notify(settled);
    }
  }
}
