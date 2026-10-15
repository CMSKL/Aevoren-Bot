import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NATIVE_CONNECTOR_CHANNELS, CONNECTOR_DRAFT_CHANNELS } from "@shared/native-connector-channels";
import { NATIVE_CONNECTOR_PRODUCT_OPERATIONS, NATIVE_CONNECTOR_OPERATION_SCHEMAS } from "@shared/native-connector-product";
import { AppRepository } from "./database";
import { NativeConnectorService } from "./native-connector-service";
import { addNativeConnectorProductHandlers } from "./native-connector-product-handlers";
import { GMAIL_READ_SCOPE } from "./native-connectors/google-oauth";
const repositories: AppRepository[] = [], services: NativeConnectorService[] = [];
function setup() {
  const repository = new AppRepository(":memory:"); repositories.push(repository);
  const service = new NativeConnectorService(repository, { isAvailable: () => true, encrypt: value => `cipher:${value}`, decrypt: value => value.slice(7) }, {
    openExternal: vi.fn(), oauth: { authorize: vi.fn(async () => ({ credentials: { kind: "google" as const, provider: "gmail" as const,
      clientId: "test.apps.googleusercontent.com", accessToken: "PRIVATE", expiresAt: Date.now() + 3600_000, scopes: ["openid", "email", GMAIL_READ_SCOPE] },
      identity: { accountId: "account", displayName: "Test" }, selectedFileIds: [] })), refresh: vi.fn(), identity: vi.fn() },
    gmail: { search: vi.fn(async () => ({ items: [{ id: "mail_A", title: "Mail", kind: "email" }], nextCursor: null, scopeNotice: "read" })), read: vi.fn() },
  }); services.push(service);
  const actor = repository.createBot(), nonce = randomUUID(); repository.prepareMessage({ sessionId: actor.session.id, clientNonce: nonce, text: "Read selected test mail" });
  const run = repository.createRuntimeRun(nonce, "fake", { schemaVersion: 1, botId: actor.bot.id, profileVersion: 1, sessionId: actor.session.id, generation: 1, inputSeq: 1, blocks: [], digest: "native-gateway-fixture" });
  repository.transitionRuntimeRun(run.id, "dispatching"); repository.transitionRuntimeRun(run.id, "running", { providerRequestId: "fixture" });
  const context = { sessionId: actor.session.id, executorBotId: actor.bot.id, runtimeRunId: run.id };
  const handlers = new Map<string, (input?: unknown) => unknown>(); addNativeConnectorProductHandlers(handlers, { repository, nativeConnectorService: service }, undefined, context);
  return { repository, service, actor, run, context, handlers };
}
async function grant(value: ReturnType<typeof setup>) {
  const config = value.service.configure({ provider: "gmail", name: "Test", clientId: "test.apps.googleusercontent.com" });
  const connection = await value.service.authorize({ id: config.id, expectedVersion: config.version });
  const binding = value.service.bind({ sessionId: value.actor.session.id, executorBotId: value.actor.bot.id, connectionId: connection.id, expectedAuthVersion: connection.authVersion });
  return { connectionId: connection.id, expectedAuthVersion: connection.authVersion, expectedBindingVersion: binding.version };
}
afterEach(() => { for (const service of services.splice(0)) service.dispose(); for (const repository of repositories.splice(0)) repository.close(); });
describe("native shared product handlers", () => {
  it("credential setup has no catalog schema or product handler", () => {
    const value = setup(); expect(value.handlers.has(NATIVE_CONNECTOR_CHANNELS.configure)).toBe(false);
    expect(NATIVE_CONNECTOR_PRODUCT_OPERATIONS.some(item => item.name === "connectors.configure")).toBe(false);
    expect(NATIVE_CONNECTOR_OPERATION_SCHEMAS["connectors.configure"]).toBeUndefined();
    expect(() => NATIVE_CONNECTOR_OPERATION_SCHEMAS["connectors.authorize"]!.parse({ id: randomUUID(), expectedVersion: 1, token: "SECRET" })).toThrow();
  });
  it("injects exactly the live session and executing Bot and rejects model scope overrides", async () => {
    const value = setup(), access = await grant(value);
    expect(await value.handlers.get(NATIVE_CONNECTOR_CHANNELS.search)!({ ...access, query: "" })).toMatchObject({ items: [{ id: "mail_A" }] });
    await expect(value.handlers.get(NATIVE_CONNECTOR_CHANNELS.search)!({ ...access, query: "", sessionId: randomUUID() })).rejects.toThrow();
    await expect(value.handlers.get(NATIVE_CONNECTOR_CHANNELS.search)!({ ...access, query: "", executorBotId: randomUUID() })).rejects.toThrow();
  });
  it("AI draft replay reuses immutable original revision without allowing a model chosen nonce", async () => {
    const value = setup(), access = await grant(value), input = { ...access, content: { kind: "gmail-message", to: ["test@example.com"], cc: [], subject: "Local", body: "Draft" } };
    const first = await value.handlers.get(CONNECTOR_DRAFT_CHANNELS.create)!(input), repeated = await value.handlers.get(CONNECTOR_DRAFT_CHANNELS.create)!(input);
    expect(repeated).toEqual(first); expect(value.service.listDrafts({ sessionId: value.actor.session.id, executorBotId: value.actor.bot.id })).toHaveLength(1);
    await expect(value.handlers.get(CONNECTOR_DRAFT_CHANNELS.create)!({ ...input, clientNonce: randomUUID() })).rejects.toThrow();
  });
  it("persisted session-scope version changes invalidate a cached Runtime even when the Bot tuple is unchanged", async () => {
    const value = setup(), access = await grant(value);
    const database = (value.repository as unknown as { database: import("node:sqlite").DatabaseSync }).database;
    database.prepare("UPDATE conversation_scope_versions SET version=version+1 WHERE session_id=?").run(value.actor.session.id);
    await expect(value.handlers.get(NATIVE_CONNECTOR_CHANNELS.search)!({ ...access, query: "" })).rejects.toMatchObject({ code: "CONNECTOR_NOT_GRANTED" });
  });
  it("a completed Runtime cannot dispatch new operations", async () => {
    const value = setup(), access = await grant(value); value.repository.transitionRuntimeRun(value.run.id, "completed");
    await expect(value.handlers.get(NATIVE_CONNECTOR_CHANNELS.search)!({ ...access, query: "" })).rejects.toThrow();
  });
});
