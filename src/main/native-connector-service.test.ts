import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectorAccessInput } from "@shared/native-connector-contracts";
import { AppRepository } from "./database";
import { NativeConnectorService, type NativeConnectorDependencies } from "./native-connector-service";
import { DRIVE_FILE_SCOPE, GMAIL_READ_SCOPE } from "./native-connectors/google-oauth";
import { NativeConnectorError, type GoogleCredentials, type NativeAuthorization, type NativeReadResult } from "./native-connectors/types";
const repositories: AppRepository[] = [], services: NativeConnectorService[] = [];
const codec = { isAvailable: () => true, encrypt: (value: string) => `sealed:${Buffer.from(value).toString("base64")}`, decrypt: (value: string) => Buffer.from(value.slice(7), "base64").toString() };
const identity = { accountId: "account-1", displayName: "Test", email: "test@example.com" };
const credentials = (provider: "gmail" | "drive" = "gmail", expiresAt = Date.now() + 3600_000): GoogleCredentials => ({ kind: "google", provider,
  clientId: "test.apps.googleusercontent.com", accessToken: "ACCESS_PRIVATE", refreshToken: "REFRESH_PRIVATE", expiresAt,
  scopes: provider === "gmail" ? ["openid", "email", GMAIL_READ_SCOPE] : [DRIVE_FILE_SCOPE] });
const document: NativeReadResult = { id: "file_A", title: "Test", mimeType: "text/plain", text: "UNTRUSTED_CONTENT", truncated: false, metadata: {} };
function setup(overrides: Partial<NativeConnectorDependencies> = {}) {
  const repository = new AppRepository(":memory:"); repositories.push(repository);
  const oauth = { authorize: vi.fn(async (input: { provider: "gmail" | "drive" }) => ({ credentials: credentials(input.provider), identity, selectedFileIds: ["file_A", "file_B"] })),
    refresh: vi.fn(async (input: GoogleCredentials) => ({ ...input, accessToken: "NEW_ACCESS", expiresAt: Date.now() + 3600_000 })), identity: vi.fn(async () => identity) };
  const gmail = { search: vi.fn(async () => ({ items: [{ id: "mail_A", title: "Mail", kind: "email" }], nextCursor: null, scopeNotice: "readonly" })), read: vi.fn(async () => document) };
  const drive = { search: vi.fn(async () => ({ items: [{ id: "file_A", title: "A", kind: "text" }], nextCursor: null, scopeNotice: "selected" })), read: vi.fn(async () => document) };
  const notion = { identity: vi.fn(async () => identity), search: gmail.search, read: gmail.read }, openExternal = vi.fn(async () => {});
  const service = new NativeConnectorService(repository, codec, { oauth, gmail, drive, notion, openExternal, ...overrides }); services.push(service);
  const bot = repository.createBot(), scope = { sessionId: bot.session.id, executorBotId: bot.bot.id };
  return { repository, service, oauth, gmail, drive, notion, openExternal, bot, scope };
}
async function grant(value: ReturnType<typeof setup>, provider: "gmail" | "drive" | "notion" = "gmail") {
  const configured = value.service.configure(provider === "notion" ? { provider, name: "Notion", token: "NOTION_PRIVATE" } : { provider, name: provider, clientId: "test.apps.googleusercontent.com", clientSecret: "CLIENT_PRIVATE" });
  const connected = await value.service.authorize({ id: configured.id, expectedVersion: configured.version });
  const binding = value.service.bind({ ...value.scope, connectionId: connected.id, expectedAuthVersion: connected.authVersion, ...(provider === "drive" ? { allowedResourceIds: ["file_A"] } : {}) });
  const access: ConnectorAccessInput = { ...value.scope, connectionId: connected.id, expectedAuthVersion: connected.authVersion, expectedBindingVersion: binding.version };
  return { configured, connected, binding, access };
}
afterEach(() => { for (const service of services.splice(0)) service.dispose(); for (const repository of repositories.splice(0)) repository.close(); });

describe("native connector service authorization and dispatch", () => {
  it("stores only encrypted credentials and publicly exposes the real authorized account without secrets", async () => {
    const value = setup(), first = await grant(value);
    expect(value.oauth.authorize).toHaveBeenCalledOnce();
    expect(JSON.stringify(value.service.list())).not.toMatch(/ACCESS_PRIVATE|REFRESH_PRIVATE|CLIENT_PRIVATE|clientSecret|clientId/u);
    expect(value.repository.connectors.secrets(first.connected.id).credentials).toMatch(/^sealed:/u);
    const text = JSON.stringify(value.repository.connectors.secrets(first.connected.id));
    expect(text).not.toMatch(/ACCESS_PRIVATE|REFRESH_PRIVATE|CLIENT_PRIVATE/u);
    expect(first.connected.account).toEqual(identity);
  });
  it("missing or foreign session grant prevents any provider HTTP dispatch", async () => {
    const value = setup(), first = await grant(value), other = value.repository.createBot();
    await expect(value.service.read({ ...first.access, sessionId: other.session.id, executorBotId: other.bot.id, resourceId: "mail_A" })).rejects.toMatchObject({ code: "CONNECTOR_NOT_GRANTED" });
    expect(value.gmail.read).not.toHaveBeenCalled();
    value.service.unbind({ ...value.scope, id: first.binding.id, expectedVersion: first.binding.version });
    await expect(value.service.search({ ...first.access, query: "" })).rejects.toMatchObject({ code: "CONNECTOR_NOT_GRANTED" });
    expect(value.gmail.search).not.toHaveBeenCalled();
  });
  it("positive scoped read passes a live authorization and strips binary bytes", async () => {
    const read = vi.fn(async (auth: NativeAuthorization) => { auth.assertCurrent(); return { ...document, mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) }; });
    const value = setup({ gmail: { search: vi.fn(), read } }), first = await grant(value);
    const result = await value.service.read({ ...first.access, resourceId: "mail_A" });
    expect(read).toHaveBeenCalledOnce(); expect(result.binaryContentAvailable).toBe(false); expect(result).not.toHaveProperty("bytes");
    expect(result.metadata.binaryBytesRead).toBe(3);
    expect(result.text).toBe("UNTRUSTED_CONTENT");
  });
  it("Drive service passes exactly the explicitly selected binding IDs to the adapter", async () => {
    const value = setup(), first = await grant(value, "drive");
    await value.service.search({ ...first.access, query: "A" });
    expect(value.drive.search).toHaveBeenCalledWith(expect.any(Object), "A", ["file_A"], undefined, undefined);
    await value.service.read({ ...first.access, resourceId: "file_A" });
    expect(value.drive.read).toHaveBeenCalledWith(expect.any(Object), "file_A", ["file_A"]);
  });
  it("normal token refresh preserves grant versions and checks account before persistence", async () => {
    const value = setup(), first = await grant(value);
    value.repository.connectors.refreshCredentials(first.connected.id, first.connected.authVersion, codec.encrypt(JSON.stringify(credentials("gmail", 0))));
    await value.service.read({ ...first.access, resourceId: "mail_A" });
    expect(value.oauth.refresh).toHaveBeenCalledOnce(); expect(value.oauth.identity).toHaveBeenCalledOnce();
    expect(value.service.list()[0]!.authVersion).toBe(first.connected.authVersion); expect(value.service.bindings(value.scope)[0]!.version).toBe(first.binding.version);
    expect(codec.decrypt(value.repository.connectors.secrets(first.connected.id).credentials!)).toContain("NEW_ACCESS");
  });
  it("refresh cannot silently expand permissions or change accounts", async () => {
    const refresh = vi.fn(async () => ({ ...credentials(), scopes: [GMAIL_READ_SCOPE, "send"] }));
    const value = setup({ oauth: { authorize: vi.fn(async () => ({ credentials: credentials("gmail", 0), identity, selectedFileIds: [] })), refresh, identity: vi.fn(async () => identity) } }), first = await grant(value);
    await expect(value.service.read({ ...first.access, resourceId: "mail_A" })).rejects.toMatchObject({ code: "AUTH_INVALID" });
    expect(value.gmail.read).not.toHaveBeenCalled(); expect(value.service.list()[0]!.state).toBe("auth-required");
    const changed = setup({ oauth: { authorize: vi.fn(async () => ({ credentials: credentials("gmail", 0), identity, selectedFileIds: [] })), refresh: vi.fn(async () => credentials()), identity: vi.fn(async () => ({ ...identity, accountId: "changed" })) } }), second = await grant(changed);
    await expect(changed.service.read({ ...second.access, resourceId: "mail_A" })).rejects.toMatchObject({ code: "AUTH_INVALID" }); expect(changed.gmail.read).not.toHaveBeenCalled();
  });
  it("revocation aborts the matching reader and blocks a late adapter response while siblings continue", async () => {
    let release!: (value: NativeReadResult) => void, capturedSignal: AbortSignal | undefined;
    const read = vi.fn((auth: NativeAuthorization) => { capturedSignal = auth.signal; return new Promise<NativeReadResult>(resolve => { release = resolve; }); });
    const value = setup({ gmail: { search: vi.fn(), read } }), first = await grant(value), sibling = await grant(value, "drive");
    const pending = value.service.read({ ...first.access, resourceId: "mail_A" });
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    value.service.revoke({ id: first.connected.id, expectedVersion: first.connected.version });
    expect(capturedSignal?.aborted).toBe(true); release(document);
    await expect(pending).rejects.toThrow();
    expect((await value.service.read({ ...sibling.access, resourceId: "file_A" })).id).toBe("file_A");
  });
  it("unbinding one member aborts only that scope's reader", async () => {
    const pending = new Map<string, { signal?: AbortSignal; resolve(value: NativeReadResult): void }>();
    const read = vi.fn((auth: NativeAuthorization, id: string) => new Promise<NativeReadResult>(resolve => { pending.set(id, { signal: auth.signal, resolve }); }));
    const value = setup({ gmail: { search: vi.fn(), read } }), first = await grant(value), secondBot = value.repository.createBot();
    const secondScope = { sessionId: secondBot.session.id, executorBotId: secondBot.bot.id }, binding = value.service.bind({ ...secondScope, connectionId: first.connected.id, expectedAuthVersion: first.connected.authVersion });
    const firstRead = value.service.read({ ...first.access, resourceId: "first" }), secondRead = value.service.read({ ...first.access, ...secondScope, expectedBindingVersion: binding.version, resourceId: "second" });
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    value.service.unbind({ ...value.scope, id: first.binding.id, expectedVersion: first.binding.version });
    expect(pending.get("first")!.signal!.aborted).toBe(true); expect(pending.get("second")!.signal!.aborted).toBe(false);
    pending.get("first")!.resolve(document); pending.get("second")!.resolve(document);
    await expect(firstRead).rejects.toThrow(); expect((await secondRead).id).toBe("file_A");
  });
  it("late authorization after cancellation never overwrites state or saves credentials", async () => {
    let resolve!: (result: { credentials: GoogleCredentials; identity: typeof identity; selectedFileIds: string[] }) => void;
    const authorize = vi.fn(() => new Promise<{ credentials: GoogleCredentials; identity: typeof identity; selectedFileIds: string[] }>(complete => { resolve = complete; }));
    const value = setup({ oauth: { authorize, refresh: vi.fn(), identity: vi.fn() } });
    const configured = value.service.configure({ provider: "gmail", name: "Gmail", clientId: "test.apps.googleusercontent.com" });
    const result = value.service.authorize({ id: configured.id, expectedVersion: configured.version });
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
    const during = value.service.list()[0]!;
    await expect(value.service.authorize({ id: during.id, expectedVersion: during.version })).rejects.toMatchObject({ code: "CONNECTOR_VERSION_CONFLICT" });
    value.service.cancelAuthorization({ id: during.id, expectedVersion: during.version });
    resolve({ credentials: credentials(), identity, selectedFileIds: [] }); await expect(result).rejects.toThrow();
    expect(value.service.list()[0]!.state).toBe("auth-required"); expect(value.repository.connectors.secrets(configured.id).credentials).toBeNull();
    expect(authorize).toHaveBeenCalledOnce();
  });
  it("runtime currentness is rechecked after network IO before any content release", async () => {
    let current = true, release!: (value: NativeReadResult) => void;
    const read = vi.fn(() => new Promise<NativeReadResult>(resolve => { release = resolve; }));
    const value = setup({ gmail: { search: vi.fn(), read } }), first = await grant(value);
    const result = value.service.read({ ...first.access, resourceId: "mail_A" }, { assertCurrent: () => { if (!current) throw new Error("runtime ended"); } });
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce()); current = false; release(document); await expect(result).rejects.toThrow("runtime ended");
  });
  it("Notion validates actual identity before grant and never uses a network send path", async () => {
    const value = setup(), first = await grant(value, "notion");
    expect(value.notion.identity).toHaveBeenCalledOnce(); expect(first.connected.scopes).toEqual(["shared-pages-read"]);
    const draft = value.service.createDraft({ ...first.access, content: { kind: "notion-page", parentPageId: "11111111-1111-1111-1111-111111111111", title: "Draft", text: "local" } });
    expect(draft.draft.state).toBe("local-draft"); expect(value.notion.read).not.toHaveBeenCalled(); expect(value.openExternal).not.toHaveBeenCalled();
  });
  it("dispose cancels authorization and active reads before the database closes", async () => {
    let resolve!: (result: NativeReadResult) => void, signal: AbortSignal | undefined;
    const read = vi.fn((auth: NativeAuthorization) => { signal = auth.signal; return new Promise<NativeReadResult>(complete => { resolve = complete; }); });
    const value = setup({ gmail: { search: vi.fn(), read } }), first = await grant(value);
    const result = value.service.read({ ...first.access, resourceId: "mail_A" }); await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    value.service.dispose(); expect(signal!.aborted).toBe(true); resolve(document); await expect(result).rejects.toThrow();
  });
  it("shutdown drains the aborted reader before permitting SQLite close", async () => {
    let resolve!: (result: NativeReadResult) => void;
    const read = vi.fn(() => new Promise<NativeReadResult>(complete => { resolve = complete; }));
    const value = setup({ gmail: { search: vi.fn(), read } }), first = await grant(value);
    const request = value.service.read({ ...first.access, resourceId: "mail_A" });
    const settled = request.then(() => "success", () => "aborted");
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    let done = false; const shutdown = value.service.shutdown().then(() => { done = true; });
    await Promise.resolve(); expect(done).toBe(false);
    resolve(document); expect(await settled).toBe("aborted"); await shutdown; expect(done).toBe(true);
    await expect(value.service.authorize({ id: first.connected.id, expectedVersion: first.connected.version })).rejects.toMatchObject({ code: "AUTH_CANCELLED" });
  });
  it("authentication failure invalidates existing authorization without storing provider error bodies", async () => {
    const value = setup({ gmail: { search: vi.fn(), read: vi.fn(async () => { throw new NativeConnectorError("REQUEST_FAILED", 401); }) } }), first = await grant(value);
    await expect(value.service.read({ ...first.access, resourceId: "mail_A" })).rejects.toMatchObject({ code: "REQUEST_FAILED", status: 401 });
    expect(value.service.list()[0]!.authVersion).toBe(first.connected.authVersion + 1); expect(value.service.list()[0]!.state).toBe("auth-required");
    const connection = value.service.list()[0]!;
    expect(value.repository.connectors.secrets(connection.id).credentials).toBeNull();
  });
});
