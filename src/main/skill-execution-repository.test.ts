import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { EnvironmentScope } from "@shared/environment-contracts";
import type { SkillScriptReviewSnapshot, SkillGrantInput } from "@shared/skill-execution-contracts";
import { AppRepository } from "./database";

const roots: string[] = [], repositories: AppRepository[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aevoren-skill-repo-")); roots.push(root);
  const path = join(root, "app.sqlite"), repository = new AppRepository(path); repositories.push(repository);
  const owner = repository.createBot(), scope = { sessionId: owner.session.id, executorBotId: owner.bot.id };
  const configuration = { workerVersion: "1.2.0", imageRef: "aevoren-execution-worker:1.2.0", imageDigest: `sha256:${"a".repeat(64)}`, platform: "linux/arm64" as const };
  const initial = repository.environments.ensure(scope, configuration);
  const environment = repository.environments.update(scope, initial.version, { state: "running" });
  const content = repository.library.create({ sessionId: scope.sessionId, kind: "skill", name: "Immutable Skill", body: "ORIGINAL_BODY",
    files: [{ relativePath: "scripts/task.py", size: 4, mimeType: "text/x-python", sha256: "b".repeat(64) }] });
  const input: SkillGrantInput = { ...scope, environmentId: environment.id, expectedImageDigest: environment.imageDigest, expectedWorkerVersion: environment.workerVersion,
    reference: content.reference, entryPath: "scripts/task.py", interpreter: "python" };
  return { root, path, repository, owner, scope, configuration, environment, content, input };
}
function review(f: ReturnType<typeof fixture>): SkillScriptReviewSnapshot {
  const grant = f.repository.skillExecutions.grant(f.input, "b".repeat(64));
  return { kind: "skill-script", resourceName: f.content.revision.name, revisionNumber: 1, target: { grantId: grant.id, grantVersion: grant.version,
    environmentId: grant.environmentId, imageDigest: grant.imageDigest, workerVersion: grant.workerVersion, reference: grant.reference,
    entryPath: grant.entryPath, entrySha256: grant.entrySha256, interpreter: grant.interpreter, args: ["FIXED_ARG"], cwd: ".", timeoutMs: 120_000 } };
}
function runtime(f: ReturnType<typeof fixture>) {
  const clientNonce = randomUUID(); f.repository.prepareMessage({ sessionId: f.scope.sessionId, clientNonce, text: "Script review fixture" });
  const run = f.repository.createRuntimeRun(clientNonce, "fake", { schemaVersion: 1, botId: f.scope.executorBotId, profileVersion: 1,
    sessionId: f.scope.sessionId, generation: 1, inputSeq: 1, blocks: [], digest: "review-fixture" });
  f.repository.transitionRuntimeRun(run.id, "dispatching"); return f.repository.transitionRuntimeRun(run.id, "running", { providerRequestId: "fixture" });
}
afterEach(() => { repositories.splice(0).forEach(repository => repository.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

describe("precise script grant and review ledger with real SQLite", () => {
  it("preserves an exact older revision after edits and rejects revoked, disabled, unbound or changed-image targets", () => {
    const f = fixture(), first = f.repository.skillExecutions.grant(f.input, "b".repeat(64));
    expect(f.repository.skillExecutions.grant(f.input, "b".repeat(64))).toEqual(first);
    const updated = f.repository.library.update({ sessionId: f.scope.sessionId, id: f.content.resource.id, expectedVersion: 1, body: "NEW_BODY", name: "New name" });
    expect(f.repository.skillExecutions.assertGranted(f.scope, first.id, 1).content.revision.body).toBe("ORIGINAL_BODY");
    f.repository.library.setEnabled({ sessionId: f.scope.sessionId, id: updated.resource.id, expectedVersion: 2, enabled: false });
    expect(() => f.repository.skillExecutions.assertGranted(f.scope, first.id, 1)).toThrowError(expect.objectContaining({ code: "LIBRARY_DISABLED" }));
    f.repository.library.setEnabled({ sessionId: f.scope.sessionId, id: updated.resource.id, expectedVersion: 3, enabled: true });
    f.repository.library.unbind({ sessionId: f.scope.sessionId, id: updated.resource.id });
    expect(() => f.repository.skillExecutions.assertGranted(f.scope, first.id, 1)).toThrowError(expect.objectContaining({ code: "LIBRARY_NOT_BOUND" }));
    f.repository.library.bind({ sessionId: f.scope.sessionId, id: updated.resource.id });
    const revoked = f.repository.skillExecutions.revoke({ ...f.scope, id: first.id, expectedVersion: 1 });
    expect(revoked.version).toBe(2);
    expect(() => f.repository.skillExecutions.assertGranted(f.scope, first.id, 1)).toThrowError(expect.objectContaining({ code: "SKILL_GRANT_REVOKED" }));
    expect(() => f.repository.skillExecutions.grant(f.input, "b".repeat(64))).toThrowError(expect.objectContaining({ code: "SKILL_GRANT_VERSION_CONFLICT" }));
    const restored = f.repository.skillExecutions.grant({ ...f.input, expectedVersion: 2 }, "b".repeat(64));
    expect(restored.version).toBe(3);
    expect(() => f.repository.skillExecutions.assertGranted(f.scope, restored.id, 1)).toThrowError(expect.objectContaining({ code: "SKILL_GRANT_VERSION_CONFLICT" }));
    f.repository.environments.update(f.scope, f.environment.version, { imageDigest: `sha256:${"c".repeat(64)}` });
    expect(() => f.repository.skillExecutions.assertGranted(f.scope, restored.id, 3)).toThrowError(expect.objectContaining({ code: "SKILL_ENVIRONMENT_CHANGED" }));
  });

  it("does not inherit a private grant and independently authorizes six explicitly bound Room members", () => {
    const f = fixture(), peer = f.repository.createBot(), privateGrant = f.repository.skillExecutions.grant(f.input, "b".repeat(64));
    const members = [f.owner, peer, ...Array.from({ length: 4 }, () => f.repository.createBot())];
    const room = f.repository.createRoom({ memberBotIds: members.map(member => member.bot.id) });
    const scopes: EnvironmentScope[] = members.map(member => ({ sessionId: room.session.id, executorBotId: member.bot.id }));
    scopes.forEach(scope => f.repository.environments.ensure(scope, f.configuration));
    expect(() => f.repository.skillExecutions.get(scopes[0]!, privateGrant.id)).toThrowError(expect.objectContaining({ code: "SKILL_GRANT_NOT_FOUND" }));
    expect(() => f.repository.skillExecutions.grant({ ...f.input, ...scopes[0]!, environmentId: f.repository.environments.get(scopes[0]!)!.id }, "b".repeat(64)))
      .toThrowError(expect.objectContaining({ code: "LIBRARY_NOT_BOUND" }));
    f.repository.library.bind({ sessionId: room.session.id, id: f.content.resource.id });
    const grants = scopes.map(scope => f.repository.skillExecutions.grant({ ...f.input, ...scope, environmentId: f.repository.environments.get(scope)!.id }, "b".repeat(64)));
    expect(new Set(grants.map(grant => grant.id)).size).toBe(6);
    f.repository.removeRoomMember(room.room.id, scopes[0]!.executorBotId, room.room.membershipVersion);
    expect(f.repository.skillExecutions.get(f.scope, privateGrant.id)).toEqual(privateGrant);
    scopes.slice(1).forEach((scope, index) => expect(f.repository.skillExecutions.get(scope, grants[index + 1]!.id)).toEqual(grants[index + 1]));
    const database = new DatabaseSync(f.path); expect(database.prepare("SELECT id FROM skill_execution_grants WHERE id=?").get(grants[0]!.id)).toBeUndefined(); database.close();
  });

  it("stores a frozen review, validates approval Scope/version/state and rejects replacement JSON", () => {
    const f = fixture(), snapshot = review(f), run = runtime(f);
    const command = { runtimeRunId: run.id, toolCallId: randomUUID(), idempotencyKey: randomUUID(),
      tool: { kind: "product-call" as const, action: "execute" as const, operation: "skills.runScript", input: { grantId: snapshot.target.grantId,
        expectedGrantVersion: 1, args: snapshot.target.args } } };
    const prepared = f.repository.prepareToolInvocation(command, undefined, "Fixed script", snapshot);
    const query = { ...f.scope, id: prepared.approval.id, expectedVersion: 1 };
    f.repository.library.update({ sessionId: f.scope.sessionId, id: f.content.resource.id, expectedVersion: 1, name: "LATEST_NAME", body: "LATEST_BODY" });
    expect(f.repository.getApprovalReview(query)).toEqual({ snapshot, executable: true });
    const other = f.repository.createBot();
    expect(() => f.repository.getApprovalReview({ ...query, sessionId: other.session.id, executorBotId: other.bot.id })).toThrowError(expect.objectContaining({ code: "APPROVAL_SCOPE_INVALID" }));
    expect(() => f.repository.getApprovalReview({ ...query, expectedVersion: 2 })).toThrowError(expect.objectContaining({ code: "APPROVAL_VERSION_CONFLICT" }));
    f.repository.resolveToolApproval(prepared.approval.id, 1, "deny");
    expect(f.repository.getApprovalReview({ ...query, expectedVersion: 2 })).toMatchObject({ snapshot, executable: false });
    const database = new DatabaseSync(f.path);
    database.prepare("UPDATE approval_requests SET review_snapshot_json=? WHERE id=?").run(JSON.stringify({ ...snapshot, target: { ...snapshot.target, args: ["REPLACED"] } }), prepared.approval.id); database.close();
    expect(() => f.repository.getApprovalReview({ ...query, expectedVersion: 2 })).toThrowError(expect.objectContaining({ code: "APPROVAL_REVIEW_INVALID" }));
  });

  it("requires a matching review and keeps expired or finished Runtime approvals non-executable", () => {
    const f = fixture(), snapshot = review(f), run = runtime(f);
    const command = { runtimeRunId: run.id, toolCallId: randomUUID(), idempotencyKey: randomUUID(), tool: { kind: "product-call" as const, action: "execute" as const,
      operation: "skills.runScript", input: { grantId: snapshot.target.grantId, expectedGrantVersion: 1, args: ["DIFFERENT"] } } };
    expect(() => f.repository.prepareToolInvocation(command, undefined, undefined, snapshot)).toThrowError(expect.objectContaining({ code: "APPROVAL_REVIEW_INVALID" }));
    expect(() => f.repository.prepareToolInvocation(command)).toThrowError(expect.objectContaining({ code: "APPROVAL_REVIEW_INVALID" }));
    const legacy = f.repository.prepareToolInvocation({ ...command, toolCallId: randomUUID(), idempotencyKey: randomUUID(), tool: { kind: "text-measure", text: "Legacy" } }, new Date(Date.now() - 1000).toISOString());
    expect(f.repository.getApprovalReview({ ...f.scope, id: legacy.approval.id, expectedVersion: 1 })).toMatchObject({ snapshot: null, executable: false });
    const prepared = f.repository.prepareToolInvocation({ ...command, toolCallId: randomUUID(), idempotencyKey: randomUUID(), tool: { ...command.tool, input: { ...command.tool.input, args: snapshot.target.args } } }, undefined, undefined, snapshot);
    f.repository.transitionRuntimeRun(run.id, "completed");
    expect(f.repository.getApprovalReview({ ...f.scope, id: prepared.approval.id, expectedVersion: 1 })).toMatchObject({ snapshot, executable: false });
  });

  it("keeps script execution provenance through clearConversation without a Runtime foreign key", () => {
    const f = fixture(), snapshot = review(f), run = runtime(f);
    const session = f.repository.environments.createSession(f.scope, run.id);
    const execution = f.repository.environments.createExecution(f.scope, { executionSessionId: session.id, clientNonce: randomUUID(), kind: "foreground", command: "script ledger fixture" }).execution;
    f.repository.skillExecutions.recordExecution(f.scope, execution, snapshot);
    const completed = f.repository.environments.updateExecution(f.scope, execution.id, execution.version, { state: "completed", endedAt: new Date().toISOString(), exitCode: 0 });
    f.repository.transitionRuntimeRun(run.id, "completed");
    f.repository.clearConversation(f.scope.sessionId);
    expect(() => f.repository.getRuntimeRun(run.id)).toThrow();
    expect(f.repository.environments.getExecution(f.scope, execution.id).runtimeRunId).toBe(run.id);
    expect(f.repository.skillExecutions.execution(f.scope, completed)).toMatchObject({ reference: f.content.reference, execution: { id: execution.id, runtimeRunId: run.id } });
    expect(f.repository.skillExecutions.get(f.scope, snapshot.target.grantId).version).toBe(1);
  });

  it("cascades grants and mappings for Bot, Room and exact member deletion while preserving sibling scopes", () => {
    const f = fixture(), snapshot = review(f), peer = f.repository.createBot(), third = f.repository.createBot();
    function record(scope: EnvironmentScope, input: SkillGrantInput) {
      const initial = f.repository.environments.ensure(scope, f.configuration);
      if (initial.state !== "running") f.repository.environments.update(scope, initial.version, { state: "running" });
      const env = f.repository.environments.get(scope)!;
      const grant = f.repository.skillExecutions.grant({ ...input, ...scope, environmentId: env.id }, "b".repeat(64));
      const session = f.repository.environments.createSession(scope, null);
      const execution = f.repository.environments.createExecution(scope, { executionSessionId: session.id, clientNonce: randomUUID(), kind: "foreground", command: "hard-delete ledger fixture" }).execution;
      const review = { ...snapshot, target: { ...snapshot.target, grantId: grant.id, environmentId: env.id } };
      f.repository.skillExecutions.recordExecution(scope, execution, review); return { grant, execution };
    }
    const privateRecord = record(f.scope, f.input);
    f.repository.library.bind({ sessionId: peer.session.id, id: f.content.resource.id });
    const siblingScope = { sessionId: peer.session.id, executorBotId: peer.bot.id }, sibling = record(siblingScope, f.input);
    const room = f.repository.createRoom({ memberBotIds: [f.owner.bot.id, peer.bot.id, third.bot.id] });
    f.repository.library.bind({ sessionId: room.session.id, id: f.content.resource.id });
    const memberScope = { sessionId: room.session.id, executorBotId: third.bot.id }, member = record(memberScope, f.input);
    const peerRoomScope = { sessionId: room.session.id, executorBotId: peer.bot.id }, peerRoom = record(peerRoomScope, f.input);
    f.repository.removeRoomMember(room.room.id, third.bot.id, room.room.membershipVersion);
    const database = new DatabaseSync(f.path);
    const missing = (id: string) => expect(database.prepare("SELECT execution_id FROM skill_script_executions WHERE execution_id=?").get(id)).toBeUndefined();
    missing(member.execution.id);
    expect(f.repository.skillExecutions.get(peerRoomScope, peerRoom.grant.id)).toEqual(peerRoom.grant);
    f.repository.deleteRoom(room.room.id); missing(peerRoom.execution.id);
    f.repository.deleteBot(f.owner.bot.id); missing(privateRecord.execution.id);
    expect(f.repository.skillExecutions.execution(siblingScope, sibling.execution).reference).toEqual(f.content.reference);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]); database.close();
  });
});
