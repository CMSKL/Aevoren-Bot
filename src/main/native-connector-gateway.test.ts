import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductToolRequest } from "@shared/contracts";
import { AppRepository } from "./database";
import { NativeConnectorService } from "./native-connector-service";
import { ProductOperationService } from "./product-operation-service";
import type { ProductDependencies } from "./product-handlers";
import { WorkspaceService } from "./workspace-service";
import { WorkspaceToolExecutor } from "./workspace-tool-executor";
import { WorkspaceToolCoordinator } from "./workspace-tool-coordinator";

vi.mock("electron", () => ({ clipboard: { writeText: vi.fn() } }));
const fixtures: { repository: AppRepository; service: NativeConnectorService }[] = [];
afterEach(async () => {
  for (const item of fixtures.splice(0)) { await item.service.shutdown(); item.repository.close(); }
});
const call = (operation: string, input?: unknown): ProductToolRequest => ({ kind: "product-call", action: "execute", operation, input });

// The database, Runtime, approvals and product handlers are real. Only the
// provider is controlled; these tests make no third-party-account claim.
async function fixture() {
  const repository = new AppRepository(":memory:"), actor = repository.createBot(), nonce = randomUUID();
  const scope = { sessionId: actor.session.id, executorBotId: actor.bot.id };
  repository.prepareMessage({ sessionId: scope.sessionId, clientNonce: nonce, text: "读取授权页面并保存本地草稿" });
  const initial = repository.createRuntimeRun(nonce, "fake", { schemaVersion: 1, botId: actor.bot.id, profileVersion: 1, sessionId: scope.sessionId,
    generation: 1, inputSeq: 1, blocks: [], digest: "native-gateway-fixture" });
  repository.transitionRuntimeRun(initial.id, "dispatching");
  const runtime = repository.transitionRuntimeRun(initial.id, "running", { providerRequestId: "fixture" });
  let body = "FIRST_PRIVATE_BODY";
  const read = vi.fn(async () => ({ id: "123456781234123412341234567890ab", title: "Fixture", mimeType: "text/plain", text: body, truncated: false, metadata: {} }));
  const service = new NativeConnectorService(repository, { isAvailable: () => true, encrypt: value => `sealed:${value}`, decrypt: value => value.slice(7) }, {
    openExternal: async () => { throw new Error("No browser in controlled fixture"); },
    notion: { identity: async () => ({ accountId: "fixture-account", displayName: "Fixture" }),
      search: async () => ({ items: [], nextCursor: null, scopeNotice: "shared" }), read },
  });
  fixtures.push({ repository, service });
  const configured = service.configure({ provider: "notion", name: "Fixture", token: "PRIVATE_TOKEN_NEVER_PUBLIC" });
  const connection = await service.authorize({ id: configured.id, expectedVersion: configured.version });
  const executor = new WorkspaceToolExecutor(repository, new WorkspaceService(repository));
  const coordinator = new WorkspaceToolCoordinator(repository, executor, () => {});
  const product = new ProductOperationService({ repository, nativeConnectorService: service } as unknown as ProductDependencies);
  executor.setProductOperations(product);
  const bind = () => service.bind({ ...scope, connectionId: connection.id, expectedAuthVersion: connection.authVersion });
  const request = (tool: ProductToolRequest) => coordinator.requestAndWait(runtime.id, randomUUID(), tool, new AbortController().signal);
  return { repository, scope, runtime, connection, service, product, coordinator, read, bind, request, setBody: (value: string) => { body = value; } };
}

describe("native connection product gateway", () => {
  it("requires a scope grant, makes every authorized read fresh, and never returns credentials", async () => {
    const f = await fixture();
    const tool = call("connectors.read", { connectionId: f.connection.id, expectedAuthVersion: f.connection.authVersion,
      expectedBindingVersion: 1, resourceId: "123456781234123412341234567890ab" });
    expect(() => f.product.validate(tool, f.runtime.id)).toThrow();
    const binding = f.bind();
    expect(binding.version).toBe(1);
    expect(f.product.requiresApproval(tool)).toBe(false);
    const first = await f.request(tool);
    expect(first.content).toContain("FIRST_PRIVATE_BODY");
    expect(first.content).not.toContain("PRIVATE_TOKEN_NEVER_PUBLIC");
    f.setBody("SECOND_PRIVATE_BODY");
    expect((await f.request(tool)).content).toContain("SECOND_PRIVATE_BODY");
    expect(f.read).toHaveBeenCalledTimes(2);
    f.service.unbind({ ...f.scope, id: binding.id, expectedVersion: binding.version });
    expect(() => f.product.validate(tool, f.runtime.id)).toThrow();
    expect(f.read).toHaveBeenCalledTimes(2);
  });

  it("discards a late provider body after unbinding instead of publishing it to the Runtime", async () => {
    const f = await fixture(), binding = f.bind();
    let finish!: (value: Awaited<ReturnType<typeof f.read>>) => void;
    f.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const outcome = f.request(call("connectors.read", { connectionId: f.connection.id, expectedAuthVersion: f.connection.authVersion,
      expectedBindingVersion: binding.version, resourceId: "123456781234123412341234567890ab" }));
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce());
    f.service.unbind({ ...f.scope, id: binding.id, expectedVersion: binding.version });
    finish({ id: "123456781234123412341234567890ab", title: "Fixture", mimeType: "text/plain", text: "LATE_PRIVATE_BODY", truncated: false, metadata: {} });
    expect(JSON.parse((await outcome).content)).toMatchObject({ ok: false, error: { code: "TOOL_EXECUTION_CANCELLED" } });
    expect(f.repository.listToolInvocations(f.scope.sessionId).at(-1)?.state).toBe("cancelled");
    expect(JSON.stringify(f.repository.listToolInvocations(f.scope.sessionId))).not.toContain("LATE_PRIVATE_BODY");
  });

  it("reuses the original local draft revision while recomputing authorization after revoke", async () => {
    const f = await fixture(), binding = f.bind();
    const tool = call("drafts.create", { connectionId: f.connection.id, expectedAuthVersion: f.connection.authVersion, expectedBindingVersion: binding.version,
      content: { kind: "notion-page", parentPageId: "12345678-1234-1234-1234-1234567890ab", title: "Local only", text: "Original draft" } });
    const approve = async () => {
      const outcome = f.request(tool);
      const approval = f.repository.listPendingApprovalRequests(f.scope.sessionId).at(-1)!;
      expect(approval).toBeDefined();
      await f.coordinator.resolve(f.scope.sessionId, approval.id, approval.version, "allow-once");
      return JSON.parse((await outcome).content) as { result: import("@shared/native-connector-contracts").ConnectorDraftResult; reused?: boolean };
    };
    const first = await approve();
    expect(first.result).toMatchObject({ authorized: true, draft: { state: "local-draft" } });
    f.service.updateDraft({ ...f.scope, id: first.result.draft.id, expectedVersion: first.result.draft.version,
      content: { kind: "notion-page", parentPageId: "12345678-1234-1234-1234-1234567890ab", title: "User edit", text: "Changed locally" } });
    f.service.revoke({ id: f.connection.id, expectedVersion: f.connection.version });
    const retried = await approve();
    expect(retried).toMatchObject({ reused: true, result: { authorized: false, revision: { id: first.result.revision.id, content: { text: "Original draft" } } } });
    expect(f.service.listDrafts(f.scope)).toHaveLength(1);
    expect(f.service.readDraft({ ...f.scope, id: first.result.draft.id }).revision.content).toMatchObject({ text: "Changed locally" });
    expect(f.read).not.toHaveBeenCalled();
  });
});
