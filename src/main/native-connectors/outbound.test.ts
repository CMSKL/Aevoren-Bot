import { describe, expect, it, vi } from "vitest";
import { NativeHttpClient, type NativeFetch } from "./http";
import { DRIVE_FILE_SCOPE, GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE, GoogleNativeOAuth } from "./google-oauth";
import { NativeOutboundAdapter, nativeContentDigest, outboundTargetDigest } from "./outbound";
import { NativeWriteHttpClient, safeCommittedHint } from "./write-http";
import { type NativeOutboundRequest, type NativeWriteAuthorization } from "./types";

const CLIENT = "fixture.apps.googleusercontent.com", PAGE = "11111111-1111-1111-1111-111111111111", CREATED = "22222222-2222-2222-2222-222222222222";
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
function auth(provider: "gmail" | "drive" | "notion" = "gmail"): NativeWriteAuthorization {
  return { credentials: provider === "notion" ? { kind: "notion", token: "notion-secret" }
    : { kind: "google", provider, clientId: CLIENT, accessToken: "access-secret", expiresAt: Date.now() + 3_600_000,
      scopes: provider === "gmail" ? ["openid", "email", GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE] : [DRIVE_FILE_SCOPE] },
    assertCurrent: vi.fn(), accountId: provider === "gmail" ? "gmail-account" : provider === "drive" ? "drive-account" : PAGE,
    accountEmail: "fixture@example.invalid", authVersion: 2, writeGrantVersion: 3, allowedResourceIds: ["selected", PAGE, "recipient@example.invalid"], dispatchBoundary: vi.fn(async () => {}) };
}
function request(operation: NativeOutboundRequest["operation"] = "gmail-send"): NativeOutboundRequest {
  return { operation, draftDigest: "a".repeat(64), identity: { intentId: "intent", dispatchAttemptId: "attempt", messageId: "<aevoren.intent@example.invalid>", reservedResourceId: "reserved" },
    content: operation === "gmail-send" ? { kind: "gmail-message", to: ["recipient@example.invalid"], cc: [], subject: "审批正文", body: "line1\nline2" }
      : operation === "notion-create-page" ? { kind: "notion-page", parentPageId: PAGE, title: "Page title", text: "Paragraph content" }
        : { kind: "drive-text", targetFileId: operation === "drive-update-text" ? "selected" : null, title: "fixture.txt", text: "Frozen file" }, observedDriveVersion: "7" };
}
function readTransport(handler?: NativeFetch): NativeFetch {
  return async (url, init) => {
    if (url.hostname === "openidconnect.googleapis.com") return json({ sub: "gmail-account", email: "fixture@example.invalid", email_verified: true });
    if (url.pathname.endsWith("/profile")) return json({ emailAddress: "fixture@example.invalid" });
    if (url.pathname.endsWith("/about")) return json({ user: { permissionId: "drive-account", emailAddress: "fixture@example.invalid" } });
    if (url.pathname.endsWith("/users/me")) return json({ type: "bot", id: PAGE, bot: { workspace_name: "Fixture" } });
    if (handler) return handler(url, init);
    throw new Error("Unexpected controlled request");
  };
}

describe("outbound adapters (controlled HTTP; no live account writes)", () => {
  it("persists the exact boundary before one Gmail POST and freezes a CRLF-safe MIME message", async () => {
    const scope = auth(), draft = request(), order: string[] = []; let raw = "";
    scope.dispatchBoundary = async proof => { order.push("persist"); expect(proof).toMatchObject({ operation: "gmail-send", draftDigest: draft.draftDigest, targetDigest: outboundTargetDigest(scope, draft) });
      expect(proof.wireDigest).toMatch(/^[a-f0-9]{64}$/u); draft.content = { kind: "gmail-message", to: ["attacker@example.invalid"], cc: [], subject: "Changed", body: "changed" }; };
    const post = vi.fn<NativeFetch>(async (url, init) => {
      order.push("post"); expect(url.toString()).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send"); expect(init.method).toBe("POST"); expect(init.redirect).toBe("error");
      raw = Buffer.from(JSON.parse(String(init.body)).raw, "base64url").toString(); return json({ id: "sent-id" });
    });
    const adapter = new NativeOutboundAdapter(new NativeHttpClient(readTransport()), new NativeWriteHttpClient(post));
    expect(await adapter.execute(scope, draft)).toMatchObject({ state: "confirmed", resourceId: "sent-id" }); expect(order).toEqual(["persist", "post"]);
    expect(raw).toContain("To: recipient@example.invalid\r\n"); expect(raw).toContain("Message-ID: <aevoren.intent@example.invalid>"); expect(raw).not.toContain("attacker");
    await expect(adapter.execute(scope, request())).rejects.toMatchObject({ code: "RESOURCE_NOT_ALLOWED" }); expect(post).toHaveBeenCalledOnce();
  });

  it("rejects injection and account mismatch before boundary and propagates failed durable persistence", async () => {
    const post = vi.fn<NativeFetch>(async () => json({ id: "sent" })), scope = auth(), draft = request();
    if (draft.content.kind === "gmail-message") draft.content.subject = "Hello\r\nBcc: injected@example.invalid";
    const adapter = new NativeOutboundAdapter(new NativeHttpClient(readTransport()), new NativeWriteHttpClient(post));
    await expect(adapter.execute(scope, draft)).rejects.toMatchObject({ code: "RESOURCE_NOT_ALLOWED" }); expect(scope.dispatchBoundary).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
    scope.accountId = "different";
    await expect(adapter.execute(scope, request())).rejects.toMatchObject({ code: "AUTH_INVALID" }); expect(scope.dispatchBoundary).not.toHaveBeenCalled();
    scope.accountId = "gmail-account"; scope.dispatchBoundary = async () => { throw new Error("SQLite rollback"); };
    await expect(adapter.execute(scope, request())).rejects.toThrow("SQLite rollback"); expect(post).not.toHaveBeenCalled();
    scope.allowedResourceIds = [];
    await expect(adapter.execute(scope, request())).rejects.toMatchObject({ code: "RESOURCE_NOT_ALLOWED" }); expect(post).not.toHaveBeenCalled();
  });

  it("never repeats an unknown write and treats post-boundary cancel/transport/invalid responses as unknown", async () => {
    for (const response of [async () => { throw new Error("secret provider error"); }, async () => json({ id: "../bad" }), async () => new Response("invalid", { headers: { "content-type": "text/plain" } })]) {
      const scope = auth(), post = vi.fn<NativeFetch>(response), adapter = new NativeOutboundAdapter(new NativeHttpClient(readTransport()), new NativeWriteHttpClient(post));
      expect(await adapter.execute(scope, request())).toMatchObject({ state: "unknown" });
      await expect(adapter.execute(scope, request())).rejects.toMatchObject({ code: "RESOURCE_NOT_ALLOWED" }); expect(post).toHaveBeenCalledOnce();
    }
    const scope = auth(), controller = new AbortController(); scope.signal = controller.signal; scope.dispatchBoundary = async () => { controller.abort(); };
    const post = vi.fn<NativeFetch>(async () => json({ id: "sent" }));
    expect(await new NativeOutboundAdapter(new NativeHttpClient(readTransport()), new NativeWriteHttpClient(post)).execute(scope, request())).toMatchObject({ state: "unknown", reason: "cancelled" }); expect(post).not.toHaveBeenCalled();
  });

  it("preserves a complete confirmed receipt if cancellation happens after the provider responds", async () => {
    const scope = auth(), controller = new AbortController(); scope.signal = controller.signal;
    const post = vi.fn<NativeFetch>(async () => { controller.abort(); return json({ id: "provider-confirmed" }); });
    const result = await new NativeOutboundAdapter(new NativeHttpClient(readTransport()), new NativeWriteHttpClient(post)).execute(scope, request());
    expect(result).toMatchObject({ state: "confirmed", resourceId: "provider-confirmed" }); expect(post).toHaveBeenCalledOnce();
  });

  it("classifies an aborted incomplete response as unknown and cancels its actual stream", async () => {
    const scope = auth(), controller = new AbortController(); scope.signal = controller.signal;
    const cancel = vi.fn(), post = vi.fn<NativeFetch>(async () => new Response(new ReadableStream({
      pull(stream) { controller.abort(); stream.error(controller.signal.reason); }, cancel,
    }), { headers: { "content-type": "application/json" } }));
    const adapter = new NativeOutboundAdapter(new NativeHttpClient(readTransport()), new NativeWriteHttpClient(post));
    expect(await adapter.execute(scope, request())).toMatchObject({ state: "unknown", reason: "cancelled" });
    expect(post).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled(); // errored streams are already closed
  });

  it("rejects wrong write endpoints, excludes provider secrets from committed hints and never calls the boundary", async () => {
    const scope = auth(), fn = vi.fn<NativeFetch>(async () => json({})), http = new NativeWriteHttpClient(fn);
    await expect(http.once(scope, "attempt", { operation: "gmail-send", draftDigest: "a".repeat(64), targetDigest: "b".repeat(64), wireDigest: "c".repeat(64) },
      new URL("https://gmail.googleapis.com/gmail/v1/users/other/messages/send"), { method: "POST", body: "{}" })).rejects.toMatchObject({ code: "RESOURCE_NOT_ALLOWED" });
    expect(scope.dispatchBoundary).not.toHaveBeenCalled(); expect(fn).not.toHaveBeenCalled();
    expect(safeCommittedHint({ additional_data: { committed_resource_id: CREATED, committed_child_ids: [PAGE], retry_guidance: "read_resource",
      secret: "provider-private", url: "https://token.invalid", message: "secret" } })).toEqual({ resourceId: CREATED, childIds: [PAGE], retryGuidance: "read_resource" });
    expect(safeCommittedHint({ additional_data: { committed_resource_id: "https://private.invalid", committed_child_ids: ["wrong"], retry_guidance: "private\nsecret" } })).toBeUndefined();
  });

  it("reconciles Gmail only from one exact SENT message with matching MIME content, never resends", async () => {
    const scope = auth(), draft = request(); let mime = "";
    const post = vi.fn<NativeFetch>(async (_url, init) => { mime = Buffer.from(JSON.parse(String(init.body)).raw, "base64url").toString(); throw new Error("unknown send result"); });
    let mode: "exact" | "empty" | "body" = "exact";
    const read = readTransport(async url => {
      if (url.pathname.endsWith("/messages")) { expect(url.searchParams.get("q")).toBe("rfc822msgid:<aevoren.intent@example.invalid>"); expect(url.searchParams.get("labelIds")).toBe("SENT"); return json({ messages: mode === "empty" ? [] : [{ id: "sent-id" }] }); }
      expect(url.searchParams.get("format")).toBe("raw");
      return json({ id: "sent-id", labelIds: ["SENT"], raw: Buffer.from(mode === "body" ? mime.replace("bGluZTEKbGluZTI=", "d3Jvbmc=") : mime).toString("base64url") });
    });
    const adapter = new NativeOutboundAdapter(new NativeHttpClient(read), new NativeWriteHttpClient(post)); expect(await adapter.execute(scope, draft)).toMatchObject({ state: "unknown" });
    expect(await adapter.reconcile(scope, draft)).toMatchObject({ state: "confirmed", resourceId: "sent-id" });
    mode = "empty"; expect(await adapter.reconcile(scope, draft)).toMatchObject({ state: "unknown", reason: "not-proven" });
    mode = "body"; expect(await adapter.reconcile(scope, draft)).toMatchObject({ state: "unknown" }); expect(post).toHaveBeenCalledOnce();
  });

  it("reserves a Drive ID read-only and creates the frozen UTF-8 text once using that ID", async () => {
    const scope = auth("drive"), draft = request("drive-create-text"), reads: string[] = [];
    const read = readTransport(async url => { reads.push(url.pathname); expect(url.searchParams.get("count")).toBe("1"); return json({ ids: ["reserved"] }); });
    const post = vi.fn<NativeFetch>(async (url, init) => { expect(url.pathname).toBe("/upload/drive/v3/files"); expect(url.searchParams.get("uploadType")).toBe("multipart");
      expect(String(init.body)).toContain('"id":"reserved"'); expect(String(init.body)).toContain("Frozen file"); expect(String(init.body)).not.toContain("Content-Transfer-Encoding"); return json({ id: "reserved" }); });
    const adapter = new NativeOutboundAdapter(new NativeHttpClient(read), new NativeWriteHttpClient(post));
    expect(await adapter.reserveDriveId(scope)).toBe("reserved"); expect(scope.dispatchBoundary).not.toHaveBeenCalled();
    expect(await adapter.execute(scope, draft)).toMatchObject({ state: "confirmed", resourceId: "reserved" }); expect(reads).toEqual(["/drive/v3/files/generateIds"]);
  });

  it("does not update an unselected or changed Drive target, and reconcile409 requires exact checksum and intent proof", async () => {
    const scope = auth("drive"), update = request("drive-update-text"), post = vi.fn<NativeFetch>(async () => json({ error: {} }, 409));
    const adapter = new NativeOutboundAdapter(new NativeHttpClient(readTransport(async () => json({ id: "selected", mimeType: "text/plain", version: "8" }))), new NativeWriteHttpClient(post));
    expect(await adapter.execute(scope, update)).toEqual({ state: "rejected", code: "TARGET_CHANGED" }); expect(scope.dispatchBoundary).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
    scope.allowedResourceIds = [];
    await expect(adapter.execute(scope, update)).rejects.toMatchObject({ code: "RESOURCE_NOT_ALLOWED" });
    const create = request("drive-create-text"), createScope = auth("drive");
    const reconcile = new NativeOutboundAdapter(new NativeHttpClient(readTransport(async () => json({ id: "reserved", name: "fixture.txt", mimeType: "text/plain", sha256Checksum: nativeContentDigest("Frozen file"), appProperties: { aevorenIntentId: "intent" } }))), new NativeWriteHttpClient(post));
    expect(await reconcile.execute(createScope, create)).toMatchObject({ state: "unknown", reason: "provider-ambiguous" });
    expect(await reconcile.reconcile(createScope, create)).toMatchObject({ state: "confirmed", resourceId: "reserved" }); expect(post).toHaveBeenCalledOnce();
  });

  it("creates a bounded Notion page, retains safe503 committed hints and confirms only matching parent/title/content", async () => {
    const scope = auth("notion"), draft = request("notion-create-page"), post = vi.fn<NativeFetch>(async (_url, init) => {
      expect(init.headers).toMatchObject({ "Notion-Version": "2026-03-11" }); const body = JSON.parse(String(init.body));
      expect(body.parent).toEqual({ type: "page_id", page_id: PAGE }); expect(body.children[0].paragraph.rich_text[0].text.content).toBe("Paragraph content");
      return json({ code: "service_unavailable", additional_data: { committed_resource_id: CREATED, retry_guidance: "retrieve_resource", irrelevant_secret: "secret" } }, 503);
    });
    const adapter = new NativeOutboundAdapter(new NativeHttpClient(readTransport(async url => url.pathname.includes("/pages/")
      ? json({ id: CREATED, object: "page", parent: { type: "page_id", page_id: PAGE }, properties: { title: { type: "title", title: [{ plain_text: "Page title" }] } } })
      : json({ results: [{ id: "33333333-3333-3333-3333-333333333333", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Paragraph content" }] } }], has_more: false }))), new NativeWriteHttpClient(post));
    const result = await adapter.execute(scope, draft); expect(result).toEqual({ state: "unknown", reason: "provider-ambiguous", hint: { resourceId: CREATED, retryGuidance: "retrieve_resource" } });
    expect(await adapter.reconcile(scope, draft, { resourceId: CREATED })).toMatchObject({ state: "confirmed", resourceId: CREATED }); expect(post).toHaveBeenCalledOnce();
    expect(await adapter.reconcile(scope, draft)).toEqual({ state: "unknown", reason: "not-proven" });
  });
});

describe("send permission OAuth (real loopback, controlled token/identity)", () => {
  it("requests full read/send consent and retains same account identity; refresh never increases permissions", async () => {
    const http = new NativeHttpClient(readTransport(async (url, init) => {
      if (url.hostname !== "oauth2.googleapis.com") throw new Error("Unexpected");
      expect(new URLSearchParams(String(init.body)).get("grant_type")).toBe("authorization_code");
      return json({ access_token: "new-secret", refresh_token: "refresh-secret", token_type: "Bearer", expires_in: 3_600, scope: `openid email ${GMAIL_READ_SCOPE} ${GMAIL_SEND_SCOPE}` });
    }));
    const result = await new GoogleNativeOAuth(http).authorizeSend({ clientId: CLIENT, expectedAccountId: "gmail-account", openExternal: async source => {
      const url = new URL(source); expect(url.searchParams.get("scope")).toBe(`openid email ${GMAIL_READ_SCOPE} ${GMAIL_SEND_SCOPE}`); expect(url.searchParams.get("include_granted_scopes")).toBeNull();
      const callback = new URL(url.searchParams.get("redirect_uri")!); callback.search = new URLSearchParams({ state: url.searchParams.get("state")!, code: "code" }).toString(); await fetch(callback);
    } });
    expect(result.identity.accountId).toBe("gmail-account"); expect(result.credentials.scopes).toContain(GMAIL_SEND_SCOPE);
    const readOnly = { ...result.credentials, scopes: result.credentials.scopes.filter(scope => scope !== GMAIL_SEND_SCOPE) };
    const expanded = new GoogleNativeOAuth(new NativeHttpClient(async () => json({ access_token: "expanded", token_type: "Bearer", expires_in: 3_600, scope: result.credentials.scopes.join(" ") })));
    await expect(expanded.refresh(readOnly)).rejects.toMatchObject({ code: "AUTH_INVALID" });
  });

  it("rejects a different account or missing send consent after the full flow", async () => {
    for (const [account, scope] of [["other-account", `openid email ${GMAIL_READ_SCOPE} ${GMAIL_SEND_SCOPE}`], ["gmail-account", `openid email ${GMAIL_READ_SCOPE}`]]) {
      const http = new NativeHttpClient(async url => url.hostname === "oauth2.googleapis.com"
        ? json({ access_token: "token", token_type: "Bearer", expires_in: 3_600, scope })
        : url.hostname === "openidconnect.googleapis.com" ? json({ sub: account, email: "fixture@example.invalid", email_verified: true }) : json({ emailAddress: "fixture@example.invalid" }));
      await expect(new GoogleNativeOAuth(http).authorizeSend({ clientId: CLIENT, expectedAccountId: "gmail-account", openExternal: async source => {
        const url = new URL(source), callback = new URL(url.searchParams.get("redirect_uri")!); callback.search = new URLSearchParams({ state: url.searchParams.get("state")!, code: "code" }).toString(); await fetch(callback);
      } })).rejects.toMatchObject({ code: "AUTH_INVALID" });
    }
  });
});
