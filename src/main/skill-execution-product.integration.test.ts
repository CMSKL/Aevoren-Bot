import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductToolRequest, PromptManifest, RuntimeRun } from "@shared/contracts";
import type { EnvironmentScope } from "@shared/environment-contracts";
import type { ApprovalReviewSnapshot, SkillScriptExecution } from "@shared/skill-execution-contracts";
import { AppRepository } from "./database";
import { AevorenBotError } from "./errors";
import type { ProductDependencies } from "./product-handlers";
import { ProductOperationService } from "./product-operation-service";
import { WorkspaceService } from "./workspace-service";
import { WorkspaceToolExecutor } from "./workspace-tool-executor";
import { WorkspaceToolCoordinator } from "./workspace-tool-coordinator";

vi.mock("electron", () => ({ clipboard: { writeText: vi.fn() } }));
const fixtures: { repository: AppRepository; root: string }[] = [];
afterEach(() => {
  for (const { repository, root } of fixtures.splice(0)) {
    repository.close(); rmSync(root, { recursive: true, force: true });
  }
});
const call = (operation: string, input?: unknown): ProductToolRequest => ({ kind: "product-call", action: "execute", operation, input });
const scope = (run: RuntimeRun): EnvironmentScope => ({ sessionId: run.sessionId, executorBotId: run.executorBotId });

// SQLite, Runtime approvals and the product gateway are real. The adapter is
// controlled here; separate Worker/Host Docker suites verify actual execution.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aevoren-script-gateway-"));
  const repository = new AppRepository(join(root, "app.sqlite"));
  fixtures.push({ repository, root });
  const executor = new WorkspaceToolExecutor(repository, new WorkspaceService(repository));
  const coordinator = new WorkspaceToolCoordinator(repository, executor, () => {});
  const grants = new Map<string, ApprovalReviewSnapshot>();
  let revoked = false;
  const adapter = {
    approvalReview: (_input: unknown, selection: EnvironmentScope) => {
      if (revoked) throw new AevorenBotError("SKILL_GRANT_REVOKED");
      return grants.get(selection.executorBotId)!;
    },
    assertApprovalReview: (_snapshot: ApprovalReviewSnapshot, _scope: EnvironmentScope) => {
      if (revoked) throw new AevorenBotError("SKILL_GRANT_REVOKED");
    },
    runScript: vi.fn(), scriptExecution: vi.fn(),
  };
  const service = new ProductOperationService({ repository, skillExecutionService: adapter } as unknown as ProductDependencies);
  executor.setProductOperations(service);
  const bots = Array.from({ length: 6 }, () => repository.createBot().bot);
  const room = repository.createRoom({ name: "Script gateway scopes", memberBotIds: bots.map(bot => bot.id), leadBotId: null });
  const batch = repository.createRoomRunWithInitialTurns({ roomId: room.room.id, sessionId: room.session.id, clientNonce: randomUUID(),
    text: "@所有人 各自执行已经批准的脚本", membershipVersion: room.room.membershipVersion, maxTurns: 8, maxHops: 6,
    maxTargetsPerTurn: 2, deadlineAt: new Date(Date.now() + 300_000).toISOString(),
    initialTurns: bots.map(bot => ({ agentId: bot.id, nonce: randomUUID() })), routingMode: "everyone", orchestrationEnabled: false });
  repository.transitionRoomBatch(batch.run.id, "running");
  const runs = batch.turns.map(initial => {
    const turn = repository.transitionRoomTurn(initial.id, "running", { promptCutoffSeq: initial.inputSeq });
    const manifest: PromptManifest = { schemaVersion: 2, botId: turn.memberBotId, profileVersion: 1, sessionId: room.session.id,
      generation: turn.inputGeneration, inputSeq: turn.inputSeq, promptCutoffSeq: turn.inputSeq, roomId: room.room.id,
      roomMembershipVersion: batch.run.membershipVersion, executorBotId: turn.memberBotId, sourceTurnId: turn.id, blocks: [], digest: "script-fixture" };
    const run = repository.createRuntimeRun(batch.run.clientNonce, "fake", manifest, { executorBotId: turn.memberBotId,
      executionKey: `${batch.run.id}:${turn.logicalTurnId}`, inputSeq: turn.inputSeq, promptCutoffSeq: turn.inputSeq });
    repository.attachRoomTurnRuntime(turn.id, run.id);
    repository.transitionRuntimeRun(run.id, "dispatching");
    const running = repository.transitionRuntimeRun(run.id, "running", { providerRequestId: "script-fixture" });
    const selected = scope(running);
    const content = repository.library.create({ sessionId: running.sessionId, kind: "skill", name: "Original Skill", body: "# Instructions",
      files: [{ relativePath: "scripts/run.sh", size: 1, sha256: "c".repeat(64), mimeType: "application/x-sh" }] }, running.executorBotId);
    const environment = repository.environments.ensure(selected, { workerVersion: "1.2.0", imageRef: "fixture-script-image", imageDigest: `sha256:${"a".repeat(64)}`, platform: "linux/arm64" });
    repository.environments.update(selected, environment.version, { state: "running" });
    const grant = repository.skillExecutions.grant({ ...selected, environmentId: environment.id, expectedImageDigest: environment.imageDigest,
      expectedWorkerVersion: environment.workerVersion, reference: content.reference, entryPath: "scripts/run.sh", interpreter: "bash" }, "c".repeat(64));
    grants.set(running.executorBotId, { kind: "skill-script", resourceName: "Original Skill", revisionNumber: 1, target: {
      grantId: grant.id, grantVersion: 1, environmentId: environment.id, imageDigest: `sha256:${"a".repeat(64)}`, workerVersion: "1.2.0",
      reference: content.reference, entryPath: "scripts/run.sh",
      entrySha256: "c".repeat(64), interpreter: "bash", args: [], cwd: ".", timeoutMs: 120_000,
    } });
    return running;
  });
  return { repository, service, executor, coordinator, adapter, grants, runs, revoke: () => { revoked = true; } };
}

describe("script Skill product approval gateway", () => {
  it("persists the host review before asking, keeps its content fixed, and rejects revoked execution", async () => {
    const f = fixture(), run = f.runs[0]!;
    const tool = call("skills.runScript", { grantId: f.grants.get(run.executorBotId)!.target.grantId, expectedGrantVersion: 1 });
    const outcome = f.coordinator.requestAndWait(run.id, "run-script", tool, new AbortController().signal);
    const approval = f.repository.listPendingApprovalRequests(run.sessionId).find(item => item.executorBotId === run.executorBotId)!;
    expect(approval.state).toBe("pending");
    expect(f.adapter.runScript).not.toHaveBeenCalled();
    const original = f.repository.getApprovalReview({ ...scope(run), id: approval.id, expectedVersion: approval.version });
    expect(original.snapshot?.resourceName).toBe("Original Skill");
    f.grants.get(run.executorBotId)!.resourceName = "Changed adapter name";
    expect(f.repository.getApprovalReview({ ...scope(run), id: approval.id, expectedVersion: approval.version }).snapshot).toEqual(original.snapshot);
    const other = f.runs[1]!;
    expect(() => f.repository.getApprovalReview({ ...scope(other), id: approval.id, expectedVersion: approval.version })).toThrow();
    f.revoke();
    const visible = await f.service.handlers.get("approvals:review")!({ ...scope(run), id: approval.id, expectedVersion: approval.version });
    expect(visible).toMatchObject({ snapshot: original.snapshot, executable: false });
    await f.coordinator.resolve(run.sessionId, approval.id, approval.version, "allow-once");
    expect(JSON.parse((await outcome).content)).toMatchObject({ ok: false, error: { code: "SKILL_GRANT_REVOKED" } });
    expect(f.adapter.runScript).not.toHaveBeenCalled();
  });

  it("starts all six scoped calls before the first result and keeps their shared message nonce independent", async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.adapter.runScript.mockImplementation(async (input: EnvironmentScope, runtimeRunId: string) => {
      await gate;
      return { execution: { id: runtimeRunId, state: "running" }, ...input } as unknown as SkillScriptExecution;
    });
    const pending = f.runs.map(run => {
      const tool = call("skills.runScript", { grantId: f.grants.get(run.executorBotId)!.target.grantId, expectedGrantVersion: 1 });
      const prepared = f.repository.prepareToolInvocation({ runtimeRunId: run.id, toolCallId: randomUUID(), idempotencyKey: randomUUID(), tool },
        undefined, undefined, f.service.approvalReview(tool, run.id));
      f.repository.resolveToolApproval(prepared.approval.id, prepared.approval.version, "allow-once");
      return f.executor.execute(prepared.invocation.id);
    });
    await vi.waitFor(() => expect(f.adapter.runScript).toHaveBeenCalledTimes(6));
    expect(new Set(f.adapter.runScript.mock.calls.map(args => (args[0] as EnvironmentScope).executorBotId)).size).toBe(6);
    release();
    const results = await Promise.all(pending);
    expect(results.every(result => result.invocation.state === "succeeded")).toBe(true);
  });

  it("rejects a supplied sibling scope before preparing an approval", () => {
    const f = fixture(), run = f.runs[0]!;
    const tool = call("skills.runScript", { executorBotId: f.runs[1]!.executorBotId, grantId: randomUUID(), expectedGrantVersion: 1 });
    expect(() => f.service.validate(tool, run.id)).toThrow(expect.objectContaining({ code: "ENVIRONMENT_SCOPE_INVALID" }));
    expect(f.repository.listPendingApprovalRequests(run.sessionId)).toEqual([]);
  });

  it("requeries a prior execution instead of replaying the script and blocks a revoked cached result", async () => {
    const f = fixture(), run = f.runs[0]!;
    const tool = call("skills.runScript", { grantId: f.grants.get(run.executorBotId)!.target.grantId, expectedGrantVersion: 1 });
    const executionId = randomUUID();
    f.adapter.runScript.mockResolvedValue({ execution: { id: executionId, state: "running" } });
    f.adapter.scriptExecution.mockResolvedValue({ execution: { id: executionId, state: "completed", exitCode: 0 } });
    const prepare = () => {
      const pending = f.repository.prepareToolInvocation({ runtimeRunId: run.id, toolCallId: randomUUID(), idempotencyKey: randomUUID(), tool },
        undefined, undefined, f.service.approvalReview(tool, run.id));
      f.repository.resolveToolApproval(pending.approval.id, pending.approval.version, "allow-once");
      return pending.invocation;
    };
    await f.executor.execute(prepare().id);
    const receipt = JSON.parse((await f.executor.execute(prepare().id)).content);
    expect(receipt).toMatchObject({ reused: true, result: { execution: { id: executionId, state: "completed", exitCode: 0 } } });
    expect(f.adapter.runScript).toHaveBeenCalledTimes(1);
    expect(f.adapter.scriptExecution).toHaveBeenCalledWith({ ...scope(run), id: executionId });
    const pending = prepare();
    f.revoke();
    await expect(f.executor.execute(pending.id)).rejects.toMatchObject({ code: "SKILL_GRANT_REVOKED" });
    expect(f.adapter.runScript).toHaveBeenCalledTimes(1);
    expect(f.adapter.scriptExecution).toHaveBeenCalledTimes(1);
  });
});
