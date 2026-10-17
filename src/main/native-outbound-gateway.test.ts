import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductToolRequest } from "@shared/contracts";
import { IPC } from "@shared/channels";
import { AppRepository } from "./database";
import { NativeConnectorService } from "./native-connector-service";
import { NativeOutboundService } from "./native-outbound-service";
import { outboundTargetDigest, type NativeOutboundAdapter } from "./native-connectors/outbound";
import type { NativeOutboundRequest, NativeWriteAuthorization, NativeWriteOutcome } from "./native-connectors/types";
import { ProductOperationService } from "./product-operation-service";
import type { ProductDependencies } from "./product-handlers";
import { WorkspaceService } from "./workspace-service";
import { WorkspaceToolExecutor } from "./workspace-tool-executor";
import { WorkspaceToolCoordinator } from "./workspace-tool-coordinator";

vi.mock("electron", () => ({ clipboard: { writeText: vi.fn() } }));
const fixtures: { repository: AppRepository; native: NativeConnectorService; outbound: NativeOutboundService }[] = [];
afterEach(async () => {
  for (const item of fixtures.splice(0)) { await item.outbound.shutdown(); await item.native.shutdown(); item.repository.close(); }
});
const call = (operation: string, input?: unknown): ProductToolRequest => ({ kind: "product-call", action: "execute", operation, input });

// SQLite, host Runtime, approvals, coordinator and gateway are production code.
// The external provider adapter is controlled; no real account is used here.
async function fixture(execute?: (auth: NativeWriteAuthorization, request: NativeOutboundRequest) => Promise<NativeWriteOutcome>) {
  const repository = new AppRepository(":memory:");
  const native = new NativeConnectorService(repository, { isAvailable: () => true, encrypt: value => `sealed:${value}`, decrypt: value => value.slice(7) }, {
    openExternal: vi.fn(), oauth: {
      authorize: vi.fn(async () => ({ credentials: { kind: "google" as const, provider: "gmail" as const, clientId: "test.apps.googleusercontent.com",
        accessToken: "PRIVATE_TOKEN_NEVER_PUBLIC", expiresAt: Date.now() + 3600000,
        scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"] },
        identity: { accountId: "account", displayName: "Tester", email: "test@example.com" }, selectedFileIds: [] })),
      refresh: vi.fn(), identity: vi.fn(),
    },
  });
  const config = native.configure({ provider: "gmail", name: "Gmail", clientId: "test.apps.googleusercontent.com" });
  const connection = await native.authorize({ id: config.id, expectedVersion: config.version });
  const adapter = { execute: vi.fn(execute ?? (async (auth, request) => {
    await auth.dispatchBoundary({ operation: request.operation, draftDigest: request.draftDigest,
      targetDigest: outboundTargetDigest(auth, request), wireDigest: "f".repeat(64) });
    return { state: "confirmed" as const, resourceId: `mail_${request.identity.intentId}`, proofDigest: "e".repeat(64) };
  })), reconcile: vi.fn(async () => ({ state: "unknown" as const, reason: "not-proven" as const })), reserveDriveId: vi.fn(), observeDriveVersion: vi.fn() };
  const outbound = new NativeOutboundService(repository, native, adapter as unknown as NativeOutboundAdapter);
  fixtures.push({ repository, native, outbound });
  const executor = new WorkspaceToolExecutor(repository, new WorkspaceService(repository));
  const coordinator = new WorkspaceToolCoordinator(repository, executor, () => {});
  const product = new ProductOperationService({ repository, nativeConnectorService: native, nativeOutboundService: outbound } as unknown as ProductDependencies);
  executor.setProductOperations(product);
  async function intentFor(sessionId: string, botId: string) {
    const scope = { sessionId, executorBotId: botId };
    const binding = native.bind({ ...scope, connectionId: connection.id, expectedAuthVersion: connection.authVersion });
    const grant = outbound.grantWrite({ ...scope, connectionId: connection.id, expectedAuthVersion: connection.authVersion,
      operation: "gmail-send", targetIds: ["receiver@example.com"] });
    const draft = native.createDraft({ ...scope, connectionId: connection.id, expectedAuthVersion: connection.authVersion, expectedBindingVersion: binding.version,
      content: { kind: "gmail-message", to: ["receiver@example.com"], cc: [], subject: "Review", body: "FIXED_APPROVED_BODY" } });
    const intent = await outbound.prepare({ ...scope, draftId: draft.draft.id, revisionId: draft.revision.id, expectedDraftVersion: 1, grantId: grant.id, expectedGrantVersion: grant.version });
    return { scope, draft, intent, grant, binding };
  }
  return { repository, native, outbound, adapter, product, coordinator, connection, intentFor };
}

describe("native outbound host gateway", () => {
  it("persists the exact executable review, dispatches through approval once, and returns a current receipt for old input", async () => {
    const f = await fixture(), owner = f.repository.createBot(), value = await f.intentFor(owner.session.id, owner.bot.id);
    const prepared = await f.outbound.requestApproval({ ...value.scope, id: value.intent.id, expectedVersion: 1 }, f.coordinator);
    expect(f.adapter.execute).not.toHaveBeenCalled();
    const review = await f.product.handlers.get(IPC.approvalsReview)!({ ...value.scope, id: prepared.approval.id, expectedVersion: prepared.approval.version });
    expect(review).toMatchObject({ executable: true, snapshot: { kind: "external-draft", content: { body: "FIXED_APPROVED_BODY" } } });
    expect(JSON.stringify(review)).not.toContain("PRIVATE_TOKEN_NEVER_PUBLIC");
    const resolved = await f.coordinator.resolve(value.scope.sessionId, prepared.approval.id, prepared.approval.version, "allow-once");
    expect(resolved.invocation.state).toBe("succeeded");
    expect(f.repository.getRuntimeRun(prepared.approval.runtimeRunId).route).toBe("host-outbound");
    await vi.waitFor(() => expect(f.repository.getRuntimeRun(prepared.approval.runtimeRunId).state).toBe("completed"));
    expect(f.adapter.execute).toHaveBeenCalledOnce();
    const nonce = randomUUID();
    f.repository.prepareMessage({ sessionId: value.scope.sessionId, clientNonce: nonce, text: "Query previous intent" });
    const runtime = f.repository.createRuntimeRun(nonce, "fake", { schemaVersion: 1, botId: owner.bot.id, profileVersion: 1, sessionId: value.scope.sessionId,
      generation: 1, inputSeq: f.repository.getUserMessage(nonce).seq, blocks: [], digest: "receipt-query" });
    f.repository.transitionRuntimeRun(runtime.id, "dispatching"); f.repository.transitionRuntimeRun(runtime.id, "running");
    const replay = call("outbound.send", { id: value.intent.id, expectedVersion: 1 });
    expect(f.product.requiresApproval(replay)).toBe(true);
    expect(f.product.requiresApproval(replay, runtime.id)).toBe(false);
    const pendingCount = f.repository.listPendingApprovalRequests(value.scope.sessionId).length;
    const content = await f.coordinator.requestAndWait(runtime.id, randomUUID(), replay, new AbortController().signal);
    expect(JSON.parse(content.content)).toMatchObject({ status: "confirmed", result: { state: "confirmed", version: 3 } });
    expect(f.repository.listPendingApprovalRequests(value.scope.sessionId)).toHaveLength(pendingCount);
    expect(f.adapter.execute).toHaveBeenCalledOnce();
  });

  it("draft edits invalidate approval without changing its snapshot or calling the provider", async () => {
    const f = await fixture(), owner = f.repository.createBot(), value = await f.intentFor(owner.session.id, owner.bot.id);
    const prepared = await f.outbound.requestApproval({ ...value.scope, id: value.intent.id, expectedVersion: 1 }, f.coordinator);
    f.native.updateDraft({ ...value.scope, id: value.draft.draft.id, expectedVersion: 1,
      content: { kind: "gmail-message", to: ["receiver@example.com"], cc: [], subject: "User edit", body: "CHANGED_BODY" } });
    const review = await f.product.handlers.get(IPC.approvalsReview)!({ ...value.scope, id: prepared.approval.id, expectedVersion: prepared.approval.version });
    expect(review).toMatchObject({ executable: false, snapshot: { content: { body: "FIXED_APPROVED_BODY" } } });
    await f.coordinator.resolve(value.scope.sessionId, prepared.approval.id, prepared.approval.version, "allow-once");
    expect(f.adapter.execute).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.repository.getRuntimeRun(prepared.approval.runtimeRunId).state).toBe("completed"));
  });

  it("returns an unknown terminal receipt through the same gateway without a second external dispatch", async () => {
    const f = await fixture(async (auth, request) => {
      await auth.dispatchBoundary({ operation: request.operation, draftDigest: request.draftDigest, targetDigest: outboundTargetDigest(auth, request), wireDigest: "f".repeat(64) });
      throw new Error("controlled response loss after provider dispatch");
    }), owner = f.repository.createBot(), value = await f.intentFor(owner.session.id, owner.bot.id);
    const prepared = await f.outbound.requestApproval({ ...value.scope, id: value.intent.id, expectedVersion: 1 }, f.coordinator);
    const result = await f.coordinator.resolve(value.scope.sessionId, prepared.approval.id, prepared.approval.version, "allow-once");
    expect(result.invocation.state).toBe("interrupted-unknown");
    await vi.waitFor(() => expect(f.repository.getRuntimeRun(prepared.approval.runtimeRunId).state).toBe("completed"));
    const nonce = randomUUID(); f.repository.prepareMessage({ sessionId: value.scope.sessionId, clientNonce: nonce, text: "Read uncertain receipt" });
    const runtime = f.repository.createRuntimeRun(nonce, "fake", { schemaVersion: 1, botId: owner.bot.id, profileVersion: 1, sessionId: value.scope.sessionId,
      generation: 1, inputSeq: f.repository.getUserMessage(nonce).seq, blocks: [], digest: "unknown-query" });
    f.repository.transitionRuntimeRun(runtime.id, "dispatching"); f.repository.transitionRuntimeRun(runtime.id, "running");
    const pendingCount = f.repository.listPendingApprovalRequests(value.scope.sessionId).length;
    const receipt = await f.coordinator.requestAndWait(runtime.id, randomUUID(), call("outbound.send", { id: value.intent.id, expectedVersion: 1 }), new AbortController().signal);
    expect(JSON.parse(receipt.content)).toMatchObject({ status: "interrupted_unknown", result: { state: "unknown", version: 3 } });
    expect(f.repository.listPendingApprovalRequests(value.scope.sessionId)).toHaveLength(pendingCount);
    expect(f.adapter.execute).toHaveBeenCalledOnce();
  });

  it("six real host Runtime approvals start before any result and one cancelled member leaves five provider calls running", async () => {
    let started = 0;
    const f = await fixture(async (auth, request) => {
      await auth.dispatchBoundary({ operation: request.operation, draftDigest: request.draftDigest, targetDigest: outboundTargetDigest(auth, request), wireDigest: "f".repeat(64) });
      started++;
      return new Promise((resolve, reject) => {
        auth.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        finishes.set(request.identity.intentId, () => resolve({ state: "confirmed", resourceId: `mail_${request.identity.intentId}`, proofDigest: "e".repeat(64) }));
      });
    });
    const finishes = new Map<string, () => void>();
    const bots = Array.from({ length: 6 }, () => f.repository.createBot().bot), room = f.repository.createRoom({ memberBotIds: bots.map(bot => bot.id) });
    const values = await Promise.all(bots.map(bot => f.intentFor(room.session.id, bot.id)));
    const prepared = await Promise.all(values.map(value => f.outbound.requestApproval({ ...value.scope, id: value.intent.id, expectedVersion: 1 }, f.coordinator)));
    expect(prepared.map(value => f.repository.getRuntimeRun(value.approval.runtimeRunId))).toHaveLength(6);
    expect(prepared.every(value => f.repository.getRuntimeRun(value.approval.runtimeRunId).route === "host-outbound")).toBe(true);
    const allowed = prepared.map(value => f.coordinator.resolve(room.session.id, value.approval.id, value.approval.version, "allow-once"));
    await vi.waitFor(() => expect(started).toBe(6));
    expect(values.every(value => f.outbound.list(value.scope)[0]?.state === "dispatching")).toBe(true);
    const stopped = await f.product.handlers.get(IPC.runtimeCancel)!(prepared[0]!.approval.runtimeRunId);
    expect(stopped).toMatchObject({ id: prepared[0]!.approval.runtimeRunId, state: "cancelled", route: "host-outbound" });
    await allowed[0];
    expect(f.outbound.list(values[0]!.scope)[0]?.state).toBe("unknown");
    expect(values.slice(1).every(value => f.outbound.list(value.scope)[0]?.state === "dispatching")).toBe(true);
    for (const value of values.slice(1)) finishes.get(value.intent.id)!();
    await Promise.all(allowed.slice(1));
    expect(values.slice(1).every(value => f.outbound.list(value.scope)[0]?.state === "confirmed")).toBe(true);
  });

  it("seals a host Runtime after synchronous approval preparation failure and leaves the draft retryable", async () => {
    const f = await fixture(), owner = f.repository.createBot(), value = await f.intentFor(owner.session.id, owner.bot.id);
    vi.spyOn(f.product, "validate").mockImplementationOnce(() => { throw new Error("controlled validator failure"); });
    await expect(f.outbound.requestApproval({ ...value.scope, id: value.intent.id, expectedVersion: 1 }, f.coordinator)).rejects.toThrow("controlled validator failure");
    expect(f.adapter.execute).not.toHaveBeenCalled();
    expect(f.outbound.list(value.scope)[0]?.state).toBe("prepared");
    const prepared = await f.outbound.requestApproval({ ...value.scope, id: value.intent.id, expectedVersion: 1 }, f.coordinator);
    expect(f.repository.getRuntimeRun(prepared.approval.runtimeRunId).state).toBe("running");
    const stopped = await f.product.handlers.get(IPC.runtimeCancel)!(prepared.approval.runtimeRunId);
    expect(stopped).toMatchObject({ state: "cancelled", route: "host-outbound" });
    expect(f.adapter.execute).not.toHaveBeenCalled();
  });

  it("member removal irreversibly retires only that member's old intent content while preserving internal receipts", async () => {
    const f = await fixture(), first = f.repository.createBot(), second = f.repository.createBot();
    const room = f.repository.createRoom({ memberBotIds: [first.bot.id, second.bot.id, f.repository.createBot().bot.id] });
    const own = await f.intentFor(room.session.id, first.bot.id), sibling = await f.intentFor(room.session.id, second.bot.id), privateIntent = await f.intentFor(first.session.id, first.bot.id);
    const removed = f.repository.removeRoomMember(room.room.id, first.bot.id, room.room.membershipVersion);
    f.repository.addRoomMember(room.room.id, first.bot.id, removed.room.membershipVersion);
    expect(f.outbound.list(own.scope)).toEqual([]);
    expect(() => f.outbound.get({ ...own.scope, id: own.intent.id, expectedVersion: 1 })).toThrow();
    expect(() => f.repository.outbound.current(own.scope, own.intent.id)).toThrow();
    expect(f.repository.outbound.byRevision(own.scope, own.intent.revisionId)).toBeNull();
    expect(f.outbound.list(sibling.scope)[0]?.review.content).toMatchObject({ body: "FIXED_APPROVED_BODY" });
    expect(f.outbound.list(privateIntent.scope)[0]?.id).toBe(privateIntent.intent.id);
    expect(f.repository.outbound.listInternal(own.intent.id).review.content).toMatchObject({ body: "FIXED_APPROVED_BODY" });
  });

  it("rejects foreign and retired intent queries before Coordinator preparation", async () => {
    const f = await fixture(), owner = f.repository.createBot(), other = f.repository.createBot(), third = f.repository.createBot();
    const room = f.repository.createRoom({ memberBotIds: [owner.bot.id, other.bot.id, third.bot.id] });
    const value = await f.intentFor(room.session.id, owner.bot.id);
    f.repository.outbound.settle(value.intent.id, "rejected", { code: "USER_CANCELLED" });
    const removed = f.repository.removeRoomMember(room.room.id, owner.bot.id, room.room.membershipVersion);
    f.repository.addRoomMember(room.room.id, owner.bot.id, removed.room.membershipVersion);
    for (const scope of [{ sessionId: other.session.id, executorBotId: other.bot.id }, value.scope]) {
      const nonce = randomUUID(); f.repository.prepareMessage({ sessionId: scope.sessionId, clientNonce: nonce, text: "Read terminal receipt" });
      const runtime = f.repository.createRuntimeRun(nonce, "fake", { schemaVersion: 1, botId: scope.executorBotId, profileVersion: 1, sessionId: scope.sessionId,
        generation: 1, inputSeq: f.repository.getUserMessage(nonce).seq, blocks: [], digest: "denied-query" }, { executorBotId: scope.executorBotId });
      f.repository.transitionRuntimeRun(runtime.id, "dispatching"); f.repository.transitionRuntimeRun(runtime.id, "running");
      expect(() => f.coordinator.requestAndWait(runtime.id, randomUUID(), call("outbound.send", { id: value.intent.id, expectedVersion: 1 }), new AbortController().signal)).toThrow();
      expect(f.repository.listToolInvocations(scope.sessionId)).toHaveLength(0);
      expect(f.repository.listPendingApprovalRequests(scope.sessionId)).toHaveLength(0);
    }
    expect(f.adapter.execute).not.toHaveBeenCalled();
  });
});
