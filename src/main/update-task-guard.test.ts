import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeState } from "@shared/contracts";
import { AppRepository } from "./database";

// Repository-state regression tests use real isolated SQLite records and public
// repository methods. They do not invoke a model or claim Agent execution.
const repositories: AppRepository[] = [];
const directories: string[] = [];

function createRepository(): { repository: AppRepository; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "aevoren-update-task-guard-"));
  directories.push(directory);
  const path = join(directory, "app.sqlite");
  const repository = new AppRepository(path);
  repositories.push(repository);
  return { repository, path };
}

afterEach(() => {
  while (repositories.length) repositories.pop()?.close();
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

function createRuntime(repository: AppRepository) {
  const { bot, session } = repository.createBot();
  const clientNonce = randomUUID();
  repository.prepareMessage({ sessionId: session.id, clientNonce, text: "检查更新时保留正在执行的任务" });
  const input = repository.getUserMessage(clientNonce);
  return repository.createRuntimeRun(clientNonce, "openai-compatible", {
    schemaVersion: 1,
    botId: bot.id,
    profileVersion: bot.version,
    sessionId: session.id,
    generation: session.generation,
    inputSeq: input.seq,
    blocks: [],
    digest: createHash("sha256").update("[]").digest("hex"),
  });
}

const runtimePaths: Record<RuntimeState, RuntimeState[]> = {
  created: [],
  dispatching: ["dispatching"],
  running: ["dispatching", "running"],
  streaming: ["dispatching", "running", "streaming"],
  "cancel-requested": ["cancel-requested"],
  completed: ["dispatching", "running", "completed"],
  failed: ["failed"],
  cancelled: ["cancel-requested", "cancelled"],
  interrupted: ["interrupted"],
};

describe("global update task guard", () => {
  it("allows restart when all conversations are idle", () => {
    const { repository } = createRepository();
    repository.createBot();
    expect(repository.hasActiveTasks()).toBe(false);
  });

  it.each(["created", "dispatching", "running", "streaming", "cancel-requested"] as const)("blocks restart for a %s runtime even when another conversation is idle", (state) => {
    const { repository } = createRepository();
    const idle = repository.createBot();
    let run = createRuntime(repository);
    for (const next of runtimePaths[state]) run = repository.transitionRuntimeRun(run.id, next);
    expect(repository.getActiveRuntimeRun(idle.session.id)).toBeNull();
    expect(run.state).toBe(state);
    expect(repository.hasActiveTasks()).toBe(true);
    expect(repository.getRuntimeRun(run.id)).toEqual(run);
  });

  it.each(["completed", "failed", "cancelled", "interrupted"] as const)("does not block restart for a terminal %s runtime", (state) => {
    const { repository } = createRepository();
    let run = createRuntime(repository);
    for (const next of runtimePaths[state]) run = repository.transitionRuntimeRun(run.id, next);
    expect(run.state).toBe(state);
    expect(repository.hasActiveTasks()).toBe(false);
    expect(repository.getRuntimeRun(run.id)).toEqual(run);
  });

  it.each(["completed", "partial", "cancelled", "interrupted"] as const)("blocks queued and running room batches, then allows restart after %s", (terminal) => {
    const { repository } = createRepository();
    const first = repository.createBot();
    const second = repository.createBot();
    const room = repository.createRoom({ memberBotIds: [first.bot.id, second.bot.id] });
    const { batch } = repository.prepareRoomMessage({
      roomId: room.room.id,
      sessionId: room.session.id,
      clientNonce: randomUUID(),
      text: "群聊尚未启动工具时也不能被更新打断",
      targetBotIds: [first.bot.id, second.bot.id],
    });
    expect(batch.state).toBe("queued");
    expect(repository.listRuntimeRuns(room.session.id)).toEqual([]);
    expect(repository.hasActiveTasks()).toBe(true);
    repository.transitionRoomBatch(batch.id, "running");
    expect(repository.hasActiveTasks()).toBe(true);
    const finished = repository.transitionRoomBatch(batch.id, terminal);
    expect(repository.hasActiveTasks()).toBe(false);
    expect(repository.getRoomBatch(batch.id)).toEqual(finished);
  });

  it.each(["completed", "failed", "cancelled", "missed"] as const)("blocks running routines, then allows restart after %s", (terminal) => {
    const { repository } = createRepository();
    const { bot } = repository.createBot();
    const scheduledFor = Date.now() + 60_000;
    const routine = repository.createRoutine({
      name: "更新保护检查",
      prompt: "保留后台主动服务任务",
      botId: bot.id,
      schedule: { type: "once", at: scheduledFor },
      enabled: true,
      nextRunAt: scheduledFor,
    });
    const run = repository.createRoutineRun(routine, "manual", randomUUID(), scheduledFor);
    expect(repository.hasActiveTasks()).toBe(false);
    repository.transitionRoutineRun(run.id, "waiting");
    expect(repository.hasActiveTasks()).toBe(false);
    repository.transitionRoutineRun(run.id, "running");
    expect(repository.hasActiveTasks()).toBe(true);
    const finished = repository.transitionRoutineRun(run.id, terminal);
    expect(repository.hasActiveTasks()).toBe(false);
    expect(repository.getRoutineRun(run.id)).toEqual(finished);
  });

  it("reads persisted active tasks after reopening the same real database", () => {
    const { repository, path } = createRepository();
    const run = createRuntime(repository);
    repositories.pop()!.close();
    const reopened = new AppRepository(path);
    repositories.push(reopened);
    expect(reopened.getRuntimeRun(run.id)).toEqual(run);
    expect(reopened.hasActiveTasks()).toBe(true);
    reopened.transitionRuntimeRun(run.id, "interrupted");
    expect(reopened.hasActiveTasks()).toBe(false);
  });

  it("keeps blocking until the final active conversation has finished", () => {
    const { repository } = createRepository();
    const first = createRuntime(repository);
    const second = createRuntime(repository);
    repository.transitionRuntimeRun(first.id, "interrupted");
    expect(repository.hasActiveTasks()).toBe(true);
    repository.transitionRuntimeRun(second.id, "interrupted");
    expect(repository.hasActiveTasks()).toBe(false);
  });
});
