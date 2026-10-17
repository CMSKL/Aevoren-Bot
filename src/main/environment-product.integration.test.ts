import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProductToolRequest, PromptManifest, RuntimeRun } from "@shared/contracts";
import type { Environment, EnvironmentScope, Execution } from "@shared/environment-contracts";
import { AppRepository } from "./database";
import { DockerDriver } from "./docker-driver";
import { EnvironmentService } from "./environment-service";
import { ExecutionWorkerClient } from "./execution-worker-client";
import { GeneralSettingsService } from "./settings";
import { WorkspaceService } from "./workspace-service";
import { WorkspaceToolExecutor } from "./workspace-tool-executor";
import { WorkspaceToolCoordinator } from "./workspace-tool-coordinator";
import { SendWorker } from "./send-worker";
import { RoomCoordinator } from "./room-coordinator";
import { ProductOperationService } from "./product-operation-service";
import type { ProductDependencies } from "./product-handlers";

vi.mock("electron", () => ({ clipboard: { writeText: vi.fn() } }));
const runDocker = promisify(execFile);
const call = (operation: string, input?: unknown): ProductToolRequest => ({ kind: "product-call", action: "execute", operation,
  ...(input === undefined ? {} : { input }) });
type Receipt<T> = { ok: boolean; status: string; operation: string; result: T; reused?: boolean };

// The Runtime records and authoritative approvals are real; no inference or
// installed-app profile is involved. Every command runs in a fixture container.
describe.skipIf(process.env.AEVOREN_DOCKER_INTEGRATION !== "1")("AI product gateway with real isolated Linux execution", () => {
  let root: string;
  let repository: AppRepository;
  let environmentService: EnvironmentService;
  let executor: WorkspaceToolExecutor;
  let product: ProductOperationService;
  let dependencies: ProductDependencies;
  const docker = new DockerDriver();
  const pickUpload = vi.fn(async () => null);

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "aevoren-environment-product-"));
    repository = new AppRepository(join(root, "app.sqlite"));
    environmentService = new EnvironmentService(repository.environments, { isAvailable: () => true,
      encrypt: value => Buffer.from(value).toString("base64"), decrypt: value => Buffer.from(value, "base64").toString() },
    join(process.cwd(), "out", "worker"), () => undefined, docker);
    expect((await environmentService.probe()).daemonReachable).toBe(true);
    await environmentService.initialize();
    const workspaceService = new WorkspaceService(repository);
    executor = new WorkspaceToolExecutor(repository, workspaceService);
    const coordinator = new WorkspaceToolCoordinator(repository, executor, () => {});
    const worker = new SendWorker(repository, null, { transcript: () => {}, sendState: () => {}, runtime: () => {} }, false, undefined, undefined, coordinator);
    dependencies = { repository, environmentService, workspaceService, workspaceToolCoordinator: coordinator, sendWorker: worker,
      roomCoordinator: new RoomCoordinator(repository, worker.executor, { transcript: () => {}, roomRuntime: () => {} }),
      generalSettings: new GeneralSettingsService(repository), providers: { list: async () => [], isSupported: () => true }, updateService: {},
      productChanged: vi.fn(), pickEnvironmentUpload: pickUpload } as unknown as ProductDependencies;
    product = new ProductOperationService(dependencies);
    executor.setProductOperations(product);
  }, 600_000);

  afterAll(async () => {
    if (!repository) return;
    await environmentService.shutdown();
    for (const environment of repository.environments.listInternal()) {
      await docker.stop(environment.id).catch(() => undefined);
      await docker.remove(environment.id).catch(() => undefined);
      await runDocker("docker", ["volume", "rm", `aevoren-work-${environment.id}`, `aevoren-state-${environment.id}`]).catch(() => undefined);
    }
    repository.close();
    rmSync(root, { recursive: true, force: true });
  }, 120_000);

  function privateRuntime(): RuntimeRun {
    const actor = repository.createBot();
    const nonce = randomUUID();
    repository.prepareMessage({ sessionId: actor.session.id, clientNonce: nonce, text: "运行本次明确选择的隔离命令与文件验收" });
    const runtime = repository.createRuntimeRun(nonce, "fake", { schemaVersion: 1, botId: actor.bot.id, profileVersion: 1,
      sessionId: actor.session.id, generation: 1, inputSeq: 1, blocks: [], digest: "actual-docker-gateway-fixture" });
    repository.transitionRuntimeRun(runtime.id, "dispatching");
    return repository.transitionRuntimeRun(runtime.id, "running", { providerRequestId: "fixture-runtime" });
  }

  function groupRuntimes(): RuntimeRun[] {
    const bots = Array.from({ length: 6 }, () => repository.createBot().bot);
    const detail = repository.createRoom({ name: "宿主 AI 并行工具链", memberBotIds: bots.map(bot => bot.id), leadBotId: null });
    const prepared = repository.createRoomRunWithInitialTurns({ roomId: detail.room.id, sessionId: detail.session.id, clientNonce: randomUUID(),
      text: "六位成员分别启动自己的隔离环境并执行同一命令", membershipVersion: detail.room.membershipVersion,
      maxTurns: 8, maxHops: 6, maxTargetsPerTurn: 2, deadlineAt: new Date(Date.now() + 300_000).toISOString(),
      initialTurns: bots.map(bot => ({ agentId: bot.id, nonce: randomUUID() })), routingMode: "everyone", orchestrationEnabled: false });
    repository.transitionRoomBatch(prepared.run.id, "running");
    return prepared.turns.map(original => {
      const turn = repository.transitionRoomTurn(original.id, "running", { promptCutoffSeq: original.inputSeq });
      const manifest: PromptManifest = { schemaVersion: 2, botId: turn.memberBotId, profileVersion: 1, sessionId: detail.session.id,
        generation: turn.inputGeneration, inputSeq: turn.inputSeq, promptCutoffSeq: turn.inputSeq, roomId: detail.room.id,
        roomMembershipVersion: prepared.run.membershipVersion, executorBotId: turn.memberBotId, sourceTurnId: turn.id, blocks: [], digest: "fixture-room-gateway" };
      const runtime = repository.createRuntimeRun(prepared.run.clientNonce, "fake", manifest, { executorBotId: turn.memberBotId,
        executionKey: `${prepared.run.id}:${turn.logicalTurnId}`, inputSeq: turn.inputSeq, promptCutoffSeq: turn.inputSeq });
      repository.attachRoomTurnRuntime(turn.id, runtime.id);
      repository.transitionRuntimeRun(runtime.id, "dispatching");
      return repository.transitionRuntimeRun(runtime.id, "running", { providerRequestId: `fixture-member-${turn.memberBotId}` });
    });
  }

  async function approved<T>(runtime: RuntimeRun, operation: string, input?: unknown): Promise<Receipt<T>> {
    const prepared = repository.prepareToolInvocation({ runtimeRunId: runtime.id, toolCallId: randomUUID(), idempotencyKey: randomUUID(), tool: call(operation, input) });
    await expect(executor.execute(prepared.invocation.id)).rejects.toMatchObject({ code: "TOOL_STATE_INVALID" });
    expect(repository.getApprovalRequest(prepared.approval.id).state).toBe("pending");
    repository.resolveToolApproval(prepared.approval.id, prepared.approval.version, "allow-once");
    const completed = await executor.execute(prepared.invocation.id);
    expect(completed.invocation.state).toBe("succeeded");
    expect(completed.invocation.resultDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(repository.getApprovalRequest(prepared.approval.id).state).toBe("allowed");
    return JSON.parse(completed.content) as Receipt<T>;
  }
  const scope = (runtime: RuntimeRun): EnvironmentScope => ({ sessionId: runtime.sessionId, executorBotId: runtime.executorBotId });

  it("keeps identical scope-free commands independent for all six members sharing one Room nonce", async () => {
    const runtimes = groupRuntimes();
    expect(new Set(runtimes.map(runtime => runtime.clientNonce)).size).toBe(1);
    expect(new Set(runtimes.map(runtime => runtime.executorBotId)).size).toBe(6);
    const start = vi.spyOn(environmentService, "start");
    const environments = await Promise.all(runtimes.map(runtime => approved<Environment>(runtime, "environments.start")));
    expect(start).toHaveBeenCalledTimes(6);
    expect(new Set(environments.map(receipt => receipt.result.id)).size).toBe(6);
    const run = vi.spyOn(environmentService, "run");
    const input = { command: "printf 'ACTUAL_AI_GATEWAY_START\\n'; sleep 30" };
    const receipts = await Promise.all(runtimes.map(runtime => approved<Execution>(runtime, "execution.run", input)));
    expect(run).toHaveBeenCalledTimes(6);
    expect(new Set(receipts.map(receipt => receipt.result.id)).size).toBe(6);
    expect(new Set(receipts.map(receipt => receipt.result.environmentId)).size).toBe(6);
    expect(receipts.every(receipt => receipt.status === "running" && receipt.result.state === "running")).toBe(true);
    for (const [index, runtime] of runtimes.entries()) {
      const execution = receipts[index]!.result;
      expect(repository.environments.getExecution(scope(runtime), execution.id)).toMatchObject({ environmentId: environments[index]!.result.id, runtimeRunId: runtime.id });
      await expect.poll(async () => (await environmentService.logs({ ...scope(runtime), id: execution.id })).logs.map(log => log.text).join("")).toContain("ACTUAL_AI_GATEWAY_START");
    }
    // Same arguments and shared nonce still return each actor's own durable receipt.
    const reused = await Promise.all(runtimes.map(runtime => approved<Execution>(runtime, "execution.run", input)));
    expect(run).toHaveBeenCalledTimes(6);
    expect(reused.map(receipt => receipt.result.id)).toEqual(receipts.map(receipt => receipt.result.id));
    expect(reused.every(receipt => receipt.reused === true)).toBe(true);
    await Promise.all(runtimes.map((runtime, index) => approved(runtime, "execution.cancel", { id: receipts[index]!.result.id })));
    start.mockRestore(); run.mockRestore();
  }, 120_000);

  it("accepts explicit file pagination and wait timeouts through the approved product gateway", async () => {
    const runtime = privateRuntime();
    await approved(runtime, "environments.start");
    await approved(runtime, "execution.writeFile", { path: "pagination.txt", content: "0123456789ABCDEFGHIJ" });
    const page = await approved<{ content: string; offset: number; nextOffset: number; fullLength: number; truncated: boolean }>(runtime,
      "execution.readFile", { path: "pagination.txt", offset: 5, maxCharacters: 4 });
    expect(page.result).toMatchObject({ content: "5678", offset: 5, nextOffset: 9, fullLength: 20, truncated: true });
    const launched = await approved<Execution>(runtime, "execution.run", { command: "sleep 30" });
    const waiting = await approved<Execution>(runtime, "execution.wait", { id: launched.result.id, timeoutMs: 30 });
    expect(waiting.result).toMatchObject({ id: launched.result.id, state: "running" });
    await approved(runtime, "execution.cancel", { id: launched.result.id });
    const ended = await approved<Execution>(runtime, "execution.wait", { id: launched.result.id, timeoutMs: 100 });
    expect(ended.result.state).toBe("cancelled");
  }, 120_000);

  it("does not rerun omitted versus explicit foreground defaults and retains a cancelled native picker receipt", async () => {
    const runtime = privateRuntime();
    await approved(runtime, "environments.start");
    const run = vi.spyOn(environmentService, "run");
    const first = await approved<Execution>(runtime, "execution.run", { command: "printf 'DEFAULT_NORMALIZED_ONCE'\n" });
    await expect.poll(async () => (await environmentService.getExecution({ ...scope(runtime), id: first.result.id })).state).toBe("completed");
    const second = await approved<Execution>(runtime, "execution.run", { command: "printf 'DEFAULT_NORMALIZED_ONCE'\n", cwd: ".", timeoutMs: 120_000 });
    expect(second.result.id).toBe(first.result.id);
    expect(second.reused).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(await environmentService.listExecutions(scope(runtime))).toHaveLength(1);
    const cancelled = await approved<null>(runtime, "execution.pickUpload");
    const repeated = await approved<null>(runtime, "execution.pickUpload");
    expect(cancelled).toMatchObject({ status: "cancelled", result: null });
    expect(repeated).toMatchObject({ status: "cancelled", result: null, reused: true });
    expect(pickUpload).toHaveBeenCalledTimes(1);
    run.mockRestore();
  }, 120_000);

  it("seals an aborted Runtime's unsent foreground request while preserving its background and a different Runtime in the same environment", async () => {
    const firstRuntime = privateRuntime();
    const owner = scope(firstRuntime);
    await approved(firstRuntime, "environments.start");
    const foreground = await approved<Execution>(firstRuntime, "execution.run", { command: "printf 'FIRST_RUNTIME_STARTED\\n'; sleep 60" });
    const background = await approved<Execution>(firstRuntime, "processes.start", { command: "python3 -m http.server 3113 --bind 0.0.0.0" });
    const pending = repository.environments.createExecution(owner, { executionSessionId: foreground.result.executionSessionId, clientNonce: randomUUID(),
      kind: "foreground", command: "printf 'MUST_NOT_START' > runtime-cancel-side-effect.txt", cwd: ".", timeoutMs: 120_000 }).execution;
    expect(pending.state).toBe("unknown");
    // A completed model turn can own a registered background service. A later
    // Runtime has a separate ExecutionSession even though the Docker Scope is shared.
    repository.transitionRuntimeRun(firstRuntime.id, "completed");
    const secondNonce = randomUUID();
    repository.prepareMessage({ sessionId: firstRuntime.sessionId, clientNonce: secondNonce, text: "新一轮独立前台命令" });
    const entry = repository.getUserMessage(secondNonce);
    const next = repository.createRuntimeRun(secondNonce, "fake", { schemaVersion: 1, botId: firstRuntime.executorBotId,
      profileVersion: repository.getBot(firstRuntime.executorBotId).version, sessionId: firstRuntime.sessionId,
      generation: entry.generation, inputSeq: entry.seq, blocks: [], digest: "second-runtime-same-environment" });
    repository.transitionRuntimeRun(next.id, "dispatching");
    const secondRuntime = repository.transitionRuntimeRun(next.id, "running", { providerRequestId: "second-fixture-runtime" });
    const sibling = await approved<Execution>(secondRuntime, "execution.run", { command: "printf 'SECOND_RUNTIME_STARTED\\n'; sleep 60" });
    expect(sibling.result.environmentId).toBe(foreground.result.environmentId);
    expect(sibling.result.executionSessionId).not.toBe(foreground.result.executionSessionId);
    await environmentService.cancelRuntime(firstRuntime.id);
    expect((await environmentService.getExecution({ ...owner, id: foreground.result.id })).state).toBe("cancelled");
    expect(repository.environments.getExecution(owner, pending.id)).toMatchObject({ state: "cancelled", errorCode: "EXECUTION_SESSION_CANCELLED" });
    expect((await environmentService.getExecution({ ...owner, id: background.result.id })).state).toBe("running");
    expect((await environmentService.getExecution({ ...owner, id: sibling.result.id })).state).toBe("running");
    const privateConnection = repository.environments.getInternal(owner)!;
    const client = new ExecutionWorkerClient(privateConnection.workerPort!, Buffer.from(privateConnection.encryptedToken!, "base64").toString(), privateConnection.id);
    await expect(client.request("/v1/executions", "POST", { id: pending.id, sessionId: pending.executionSessionId,
      runtimeRunId: firstRuntime.id, kind: "foreground", command: pending.command, cwd: pending.cwd, timeoutMs: 120_000 })).rejects.toMatchObject({ status: 409 });
    expect((await environmentService.listFiles(owner)).entries.some(file => file.path === "runtime-cancel-side-effect.txt")).toBe(false);
    await approved(secondRuntime, "execution.cancel", { id: sibling.result.id });
    await approved(secondRuntime, "processes.stop", { id: background.result.id });
  }, 120_000);
});
