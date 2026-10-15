import { describe, expect, it, vi } from "vitest";
import type { ApiResult, ToolInvocation } from "@shared/contracts";
import type { ApprovalReviewInput, ApprovalReviewResult, SkillScriptApprovalReviewSnapshot } from "@shared/skill-execution-contracts";
import { isScriptRun, loadScriptApprovalReview, scriptReviewMatches } from "./script-approval-review";

const invocation: ToolInvocation = { id: "tool-a", runtimeRunId: "run-a", sessionId: "private-a", executorBotId: "bot-a", toolCallId: "call-a", idempotencyKey: "nonce-a", commandDigest: "digest-a", toolKind: "product-call", effectClass: "irreversible", workspaceId: null, targetPath: "scripts/main.py", arguments: { kind: "product-call", action: "execute", operation: "skills.runScript", input: { grantId: "grant-a", expectedGrantVersion: 3, args: ["--literal", "$(leave-me); value"], cwd: ".", timeoutMs: 120000 } }, state: "awaiting-approval", attemptCount: 0, approvalRequestId: "approval-a", resultDigest: null, resultMetadata: null, lastErrorCode: null, version: 1, createdAt: "2026-10-14T00:00:00.000Z", updatedAt: "2026-10-14T00:00:00.000Z", startedAt: null, finishedAt: null };
const review: ApprovalReviewResult & { snapshot: SkillScriptApprovalReviewSnapshot } = { executable: true, snapshot: { kind: "skill-script", resourceName: "固定 Skill", revisionNumber: 2, target: { grantId: "grant-a", grantVersion: 3, environmentId: "environment-a", imageDigest: `sha256:${"1".repeat(64)}`, workerVersion: "1.2.0", reference: { resourceId: "resource-a", revisionId: "revision-a", digest: "2".repeat(64) }, entryPath: "scripts/main.py", entrySha256: "3".repeat(64), interpreter: "python", args: ["--literal", "$(leave-me); value"], cwd: ".", timeoutMs: 120000 } } };

describe("immutable script approval review", () => {
  it("requires the same frozen grant version and literal argument array as the pending invocation", () => {
    expect(isScriptRun(invocation)).toBe(true);
    expect(scriptReviewMatches(invocation, review)).toBe(true);
    for (const change of [{ grantVersion: 4 }, { args: ["--different"] }, { cwd: "other" }, { timeoutMs: 5000 }]) {
      expect(scriptReviewMatches(invocation, { ...review, snapshot: { ...review.snapshot!, target: { ...review.snapshot!.target, ...change } } })).toBe(false);
    }
  });
  it("blocks a missing or revoked script review while leaving legacy operations available", () => {
    expect(scriptReviewMatches(invocation, { executable: true, snapshot: null })).toBe(false);
    expect(scriptReviewMatches(invocation, { ...review, executable: false, reason: "授权已撤销" })).toBe(false);
    const legacy = { ...invocation, arguments: { kind: "time-now" as const } };
    expect(isScriptRun(legacy)).toBe(false);
    expect(scriptReviewMatches(legacy, { executable: true, snapshot: null })).toBe(true);
  });
  it("does not publish a delayed old-scope review after its dialog was replaced", async () => {
    let resolveOld!: (result: ApiResult<ApprovalReviewResult>) => void;
    const oldRead = vi.fn<(input: ApprovalReviewInput) => Promise<ApiResult<ApprovalReviewResult>>>(() => new Promise(resolve => { resolveOld = resolve; }));
    const oldReceive = vi.fn();
    const disposeOld = loadScriptApprovalReview({ sessionId: "private-a", executorBotId: "bot-a", id: "approval-a", expectedVersion: 1 }, oldRead, oldReceive);
    disposeOld();
    const nextReceive = vi.fn();
    const disposeNext = loadScriptApprovalReview({ sessionId: "group-b", executorBotId: "bot-b", id: "approval-b", expectedVersion: 2 }, async () => ({ ok: true, data: { ...review, executable: false, reason: "权限已撤销" } }), nextReceive);
    await Promise.resolve();
    expect(nextReceive).toHaveBeenCalledWith({ status: "ready", result: { ...review, executable: false, reason: "权限已撤销" } });
    resolveOld({ ok: true, data: review }); await Promise.resolve();
    expect(oldReceive).not.toHaveBeenCalled();
    expect(oldRead).toHaveBeenCalledTimes(1);
    disposeNext();
  });
  it("reports a missing real review without synthesizing an executable snapshot", async () => {
    const receive = vi.fn();
    const dispose = loadScriptApprovalReview({ sessionId: "private-a", executorBotId: "bot-a", id: "approval-a", expectedVersion: 1 }, async () => { throw new Error("disconnected"); }, receive);
    await Promise.resolve(); await Promise.resolve();
    expect(receive).toHaveBeenCalledWith({ status: "unavailable", reason: "无法读取本次审批的保存快照，请重试。" });
    dispose();
  });
});
