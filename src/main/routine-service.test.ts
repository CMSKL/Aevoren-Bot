import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ModelEvent, ModelProvider } from "./model";
import { AppRepository } from "./database";
import { RoutineService } from "./routine-service";
import { SendWorker } from "./send-worker";

const repositories: AppRepository[] = [];

afterEach(() => {
  while (repositories.length > 0) repositories.pop()?.close();
});

function setup(now: number, provider?: ModelProvider) {
  const repository = new AppRepository(":memory:");
  repositories.push(repository);
  const created = repository.createBot();
  const model: ModelProvider = provider ?? {
    async *run(messages: ChatMessage[]): AsyncIterable<ModelEvent> {
      yield { type: "started", requestId: "routine-provider" };
      yield { type: "delta", text: `ROUTINE_DONE:${messages.at(-1)?.content}` };
      yield { type: "completed", finishReason: "stop" };
    },
    testConnection: async () => {},
  };
  const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, model);
  let clock = now;
  const notifications = vi.fn();
  const service = new RoutineService(repository, worker, notifications, () => clock);
  return { repository, created, worker, service, notifications, setClock: (value: number) => { clock = value; } };
}

describe("RoutineService", () => {
  it("fires one due schedule exactly once, snapshots its definition, and settles from Runtime", async () => {
    const base = Date.parse("2026-09-17T08:00:00.000Z");
    const value = setup(base);
    const routine = value.service.create({
      name: "日报",
      prompt: "生成日报",
      botId: value.created.bot.id,
      schedule: { type: "once", at: base + 1_000 },
      enabled: true,
    });
    value.setClock(base + 1_000);
    await value.service.tick();
    await vi.waitFor(() => expect(value.repository.listRuntimeRuns(value.created.session.id)).toHaveLength(1));
    await vi.waitFor(() => expect(value.repository.listRuntimeRuns(value.created.session.id)[0]?.state).toBe("completed"));
    await value.service.tick();

    const runs = value.service.listRuns(routine.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      routineName: "日报",
      promptSnapshot: "生成日报",
      trigger: "schedule",
      scheduledFor: base + 1_000,
      state: "completed",
      runtimeRunId: expect.any(String),
    });
    expect(value.service.list()[0]).toMatchObject({ enabled: false, nextRunAt: null });
    await value.service.tick();
    expect(value.service.listRuns(routine.id)).toHaveLength(1);
    expect(value.notifications).toHaveBeenCalledWith(expect.objectContaining({ state: "completed" }));
  });

  it("keeps an interval run waiting while the Bot is busy and runs it after the active turn completes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const provider: ModelProvider = {
      async *run(): AsyncIterable<ModelEvent> {
        calls += 1;
        yield { type: "started", requestId: `call-${calls}` };
        if (calls === 1) await gate;
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const base = Date.parse("2026-09-17T08:00:00.000Z");
    const value = setup(base, provider);
    const manual = value.worker.send({ sessionId: value.created.session.id, clientNonce: crypto.randomUUID(), text: "busy" });
    await vi.waitFor(() => expect(value.repository.getRuntimeRun(manual.runId).state).toBe("running"));
    const routine = value.service.create({
      name: "巡检",
      prompt: "检查状态",
      botId: value.created.bot.id,
      schedule: { type: "interval", everyMinutes: 5, anchorAt: base + 1_000 },
      enabled: true,
    });
    value.setClock(base + 1_000);
    await value.service.tick();
    expect(value.service.listRuns(routine.id)[0]).toMatchObject({ state: "waiting", runtimeRunId: null });

    release();
    await vi.waitFor(() => expect(value.repository.getRuntimeRun(manual.runId).state).toBe("completed"));
    await value.service.tick();
    await vi.waitFor(() => expect(value.service.listRuns(routine.id)[0]?.runtimeRunId).toEqual(expect.any(String)));
    expect(calls).toBe(2);
  });

  it("validates cron schedules and snapshots manual runs independently of later edits", async () => {
    const base = Date.parse("2026-09-17T08:00:00.000Z");
    const value = setup(base);
    const routine = value.service.create({
      name: "周报",
      prompt: "初始提示",
      botId: value.created.bot.id,
      schedule: { type: "cron", expression: "0 9 * * 1", timeZone: "Asia/Shanghai" },
      enabled: false,
    });
    const run = await value.service.runNow(routine.id);
    const updated = value.service.update(routine.id, routine.version, { prompt: "新提示" });
    expect(run.promptSnapshot).toBe("初始提示");
    expect(updated.prompt).toBe("新提示");
    expect(() => value.service.create({
      name: "错误",
      prompt: "错误",
      botId: value.created.bot.id,
      schedule: { type: "cron", expression: "bad value", timeZone: "Asia/Shanghai" },
      enabled: true,
    })).toThrowError(expect.objectContaining({ code: "ROUTINE_SCHEDULE_INVALID" }));
  });
});
