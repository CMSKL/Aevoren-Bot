import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { NativeHttpClient, type NativeFetch } from "./http";
import { createGoogleCallback, DRIVE_FILE_SCOPE, GMAIL_READ_SCOPE, GoogleNativeOAuth } from "./google-oauth";
import { GmailNativeAdapter } from "./gmail";
import { DriveNativeAdapter } from "./drive";
import { NotionNativeAdapter, NOTION_API_VERSION } from "./notion";
import { NativeConnectorError, type GoogleCredentials, type NativeAuthorization } from "./types";

const CLIENT = "test-client.apps.googleusercontent.com";
function json(data: unknown, status = 200): Response { return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }); }
function credential(provider: "gmail" | "drive" = "gmail"): GoogleCredentials {
  return { kind: "google", provider, clientId: CLIENT, accessToken: "access-secret", refreshToken: "refresh-secret", expiresAt: Date.now() + 3_600_000,
    scopes: provider === "gmail" ? ["openid", "email", GMAIL_READ_SCOPE] : [DRIVE_FILE_SCOPE] };
}
function authorization(provider: "gmail" | "drive" = "gmail"): NativeAuthorization { return { credentials: credential(provider), assertCurrent: vi.fn() }; }
function callbackUrl(source: string, fields: Record<string, string>): URL {
  const authUrl = new URL(source), callback = new URL(authUrl.searchParams.get("redirect_uri")!);
  callback.search = new URLSearchParams({ state: authUrl.searchParams.get("state")!, ...fields }).toString();
  return callback;
}

describe("native connector HTTP (controlled transport, no third-party account)", () => {
  it("refuses arbitrary origins, credentials in URLs and redirects before releasing credentials", async () => {
    const fetchFn = vi.fn<NativeFetch>(async () => json({ ok: true })), http = new NativeHttpClient(fetchFn);
    for (const url of ["http://gmail.googleapis.com/gmail/v1/users/me/messages", "https://attacker.invalid/a", "https://x@gmail.googleapis.com/gmail/v1/users/me/messages", "https://gmail.googleapis.com:444/gmail/v1/users/me/messages", "https://www.googleapis.com/calendar/v3/calendars", "https://api.notion.com/v1/blocks/any/children"]) {
      await expect(http.json(new URL(url), {})).rejects.toMatchObject({ code: "RESOURCE_NOT_ALLOWED" });
    }
    expect(fetchFn).not.toHaveBeenCalled();
    const redirect = new NativeHttpClient(async (_url, init) => { expect(init.redirect).toBe("error"); return new Response("", { status: 302, headers: { location: "https://attacker.invalid" } }); });
    await expect(redirect.json(new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages"), {})).rejects.toMatchObject({ code: "RESOURCE_NOT_ALLOWED" });
  });

  it("bounds streaming bodies without trusting content-length and hides provider errors", async () => {
    const large = new NativeHttpClient(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(6)); controller.enqueue(new Uint8Array(6)); controller.close(); } })));
    await expect(large.bytes(new URL("https://www.googleapis.com/drive/v3/files"), {}, 10)).rejects.toMatchObject({ code: "TOO_LARGE" });
    const denied = new NativeHttpClient(async () => new Response("token=private-third-party-body", { status: 401 }));
    await expect(denied.json(new URL("https://www.googleapis.com/drive/v3/files"), {})).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    const wrongType = new NativeHttpClient(async () => new Response('{"accessToken":"secret"}', { headers: { "content-type": "text/plain" } }));
    await expect(wrongType.json(new URL("https://www.googleapis.com/drive/v3/files"), {})).rejects.toMatchObject({ code: "RESPONSE_INVALID" });
  });

  it("rejects write methods and cancels a revoked response body before consuming it", async () => {
    const cancel = vi.fn(), fn = vi.fn<NativeFetch>(async () => new Response(new ReadableStream({ cancel })));
    const http = new NativeHttpClient(fn);
    await expect(http.json(new URL("https://www.googleapis.com/drive/v3/files"), { method: "POST" })).rejects.toMatchObject({ code: "RESOURCE_NOT_ALLOWED" });
    expect(fn).not.toHaveBeenCalled();
    let checks = 0;
    await expect(http.json(new URL("https://www.googleapis.com/drive/v3/files"), {}, () => { if (++checks === 2) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED"); }))
      .rejects.toMatchObject({ code: "RESOURCE_NOT_ALLOWED" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rechecks authorization after each awaited response and streamed chunk", async () => {
    let revoked = false;
    const guard = (): void => { if (revoked) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED"); };
    const http = new NativeHttpClient(async () => { revoked = true; return json({ text: "must not escape" }); });
    await expect(http.json(new URL("https://api.notion.com/v1/search"), { method: "POST" }, guard)).rejects.toMatchObject({ code: "RESOURCE_NOT_ALLOWED" });
    revoked = false;
    const streaming = new NativeHttpClient(async () => new Response(new ReadableStream({ pull(controller) { revoked = true; controller.enqueue(new Uint8Array([1])); controller.close(); } })));
    await expect(streaming.bytes(new URL("https://api.notion.com/v1/search"), { method: "POST" }, 100, guard)).rejects.toMatchObject({ code: "RESOURCE_NOT_ALLOWED" });
  });
});

describe("Google OAuth (real loopback, controlled token and identity responses)", () => {
  it("ignores the wrong state, accepts one bounded picker result and closes its listener", async () => {
    const callback = await createGoogleCallback("expected", "drive", 2_000);
    try {
      const wrong = new URL(callback.redirectUrl); wrong.search = "state=wrong&error=access_denied";
      expect((await fetch(wrong)).status).toBe(400);
      const accepted = new URL(callback.redirectUrl); accepted.search = "state=expected&code=code&picked_file_ids=one,two,one";
      expect((await fetch(accepted)).status).toBe(200);
      await expect(callback.result).resolves.toEqual({ code: "code", selectedFileIds: ["one", "two"] });
      await expect(fetch(accepted)).rejects.toBeTruthy();
    } finally { callback.cancel(); }
  });

  it("closes the callback on cancellation, expiry and duplicate state", async () => {
    const cancelled = await createGoogleCallback("state", "gmail", 2_000);
    cancelled.cancel();
    await expect(cancelled.result).rejects.toMatchObject({ code: "AUTH_CANCELLED" });
    await expect(fetch(cancelled.redirectUrl)).rejects.toBeTruthy();
    const expired = await createGoogleCallback("state", "gmail", 20);
    await expect(expired.result).rejects.toMatchObject({ code: "AUTH_TIMEOUT" });
    await expect(fetch(expired.redirectUrl)).rejects.toBeTruthy();
    const duplicate = await createGoogleCallback("state", "gmail", 2_000);
    try {
      const url = new URL(duplicate.redirectUrl); url.search = "state=state&state=state&code=a";
      expect((await fetch(url)).status).toBe(400);
      duplicate.cancel(); await expect(duplicate.result).rejects.toMatchObject({ code: "AUTH_CANCELLED" });
    } finally { duplicate.cancel(); }
  });

  it("rejects callback path traversal and cancellation never exchanges a token", async () => {
    const callback = await createGoogleCallback("expected", "drive", 2_000);
    const invalid = new URL(callback.redirectUrl); invalid.search = "state=expected&code=code&picked_file_ids=../private";
    expect((await fetch(invalid)).status).toBe(400); await expect(callback.result).rejects.toMatchObject({ code: "AUTH_INVALID" });
    const fn = vi.fn<NativeFetch>(async () => json({})), controller = new AbortController();
    let redirect: URL | undefined;
    const flow = new GoogleNativeOAuth(new NativeHttpClient(fn)).authorize({ provider: "gmail", clientId: CLIENT, signal: controller.signal,
      openExternal: async source => { redirect = new URL(new URL(source).searchParams.get("redirect_uri")!); controller.abort(); } });
    await expect(flow).rejects.toMatchObject({ code: "AUTH_CANCELLED" });
    expect(fn).not.toHaveBeenCalled(); await expect(fetch(redirect!)).rejects.toBeTruthy();
  });

  it("uses Gmail PKCE, verified userinfo and exact read scopes without leaking a client secret to the browser", async () => {
    let challenge = "";
    const http = new NativeHttpClient(async (url, init) => {
      expect(init.redirect).toBe("error");
      if (url.hostname === "oauth2.googleapis.com") {
        const body = new URLSearchParams(String(init.body));
        expect(body.get("grant_type")).toBe("authorization_code"); expect(body.get("client_secret")).toBe("desktop-secret");
        expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(challenge);
        return json({ access_token: "access-secret", refresh_token: "refresh-secret", token_type: "Bearer", expires_in: 3_600,
          scope: `openid https://www.googleapis.com/auth/userinfo.email ${GMAIL_READ_SCOPE}` });
      }
      expect(init.headers).toEqual({ authorization: "Bearer access-secret" });
      if (url.hostname === "gmail.googleapis.com") return json({ emailAddress: "fixture@example.invalid" });
      expect(url.toString()).toBe("https://openidconnect.googleapis.com/v1/userinfo");
      return json({ sub: "subject-id", email: "fixture@example.invalid", email_verified: true });
    });
    const result = await new GoogleNativeOAuth(http, () => 1_000).authorize({ provider: "gmail", clientId: CLIENT, clientSecret: "desktop-secret",
      openExternal: async source => {
        const url = new URL(source); expect(url.origin).toBe("https://accounts.google.com");
        expect(url.searchParams.get("scope")).toBe(`openid email ${GMAIL_READ_SCOPE}`);
        expect(url.searchParams.get("code_challenge_method")).toBe("S256"); expect(url.searchParams.get("include_granted_scopes")).toBeNull();
        expect(source).not.toContain("desktop-secret"); expect(url.searchParams.get("trigger_onepick")).toBeNull();
        challenge = url.searchParams.get("code_challenge")!;
        expect((await fetch(callbackUrl(source, { code: "fixture-code" }))).status).toBe(200);
      } });
    expect(result.identity).toEqual({ accountId: "subject-id", displayName: "fixture@example.invalid", email: "fixture@example.invalid" });
    expect(result.credentials.expiresAt).toBe(3_601_000); expect(result.selectedFileIds).toEqual([]);
    expect(JSON.stringify(result.identity)).not.toMatch(/access-secret|refresh-secret|desktop-secret/u);
  });

  it("keeps Drive picker scopes independent and identifies the permissionId rather than Google sub", async () => {
    const http = new NativeHttpClient(async (url, init) => {
      if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "drive-token", token_type: "Bearer", expires_in: 3_600, scope: DRIVE_FILE_SCOPE });
      expect(url.pathname).toBe("/drive/v3/about"); expect(url.searchParams.get("fields")).toBe("user(permissionId,emailAddress,displayName)");
      expect(init.headers).toEqual({ authorization: "Bearer drive-token" });
      return json({ user: { permissionId: "drive-permission", displayName: "Fixture Drive", emailAddress: "fixture@example.invalid" } });
    });
    const result = await new GoogleNativeOAuth(http).authorize({ provider: "drive", clientId: CLIENT, openExternal: async source => {
      const url = new URL(source); expect(url.searchParams.get("scope")).toBe(DRIVE_FILE_SCOPE);
      expect(url.searchParams.get("prompt")).toBe("consent"); expect(url.searchParams.get("trigger_onepick")).toBe("true");
      await fetch(callbackUrl(source, { code: "fixture-code", picked_file_ids: "picked-file" }));
    } });
    expect(result.identity.accountId).toBe("drive-permission"); expect(result.selectedFileIds).toEqual(["picked-file"]);
  });

  it("rejects missing or expanded initial scopes, unverified identity and cancellation during token response", async () => {
    for (const scope of [undefined, `${GMAIL_READ_SCOPE} openid email https://www.googleapis.com/auth/gmail.send`]) {
      const oauth = new GoogleNativeOAuth(new NativeHttpClient(async () => json({ access_token: "secret", token_type: "Bearer", expires_in: 3_600, ...(scope ? { scope } : {}) })));
      await expect(oauth.authorize({ provider: "gmail", clientId: CLIENT, openExternal: async source => { await fetch(callbackUrl(source, { code: "code" })); } }))
        .rejects.toMatchObject({ code: scope ? "AUTH_INVALID" : "RESPONSE_INVALID" });
    }
    const oauth = new GoogleNativeOAuth(new NativeHttpClient(async () => json({ sub: "subject", email: "x@y.invalid", email_verified: false })));
    await expect(oauth.identity(credential())).rejects.toMatchObject({ code: "AUTH_INVALID" });
    const controller = new AbortController();
    const cancelled = new GoogleNativeOAuth(new NativeHttpClient(async () => { controller.abort(); return json({ access_token: "secret" }); }));
    await expect(cancelled.authorize({ provider: "gmail", clientId: CLIENT, signal: controller.signal,
      openExternal: async source => { await fetch(callbackUrl(source, { code: "code" })); } })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("refreshes only the original scopes, preserves the refresh token and refuses expansion", async () => {
    const oauth = new GoogleNativeOAuth(new NativeHttpClient(async (_url, init) => {
      expect(new URLSearchParams(String(init.body)).get("grant_type")).toBe("refresh_token");
      return json({ access_token: "refreshed", token_type: "Bearer", expires_in: 1_800 });
    }));
    const original = credential(); expect(await oauth.refresh(original)).toMatchObject({ accessToken: "refreshed", refreshToken: "refresh-secret", scopes: original.scopes });
    const expanded = new GoogleNativeOAuth(new NativeHttpClient(async () => json({ access_token: "new", token_type: "Bearer", expires_in: 1_800,
      scope: `${DRIVE_FILE_SCOPE} openid` })));
    await expect(expanded.refresh(credential("drive"))).rejects.toMatchObject({ code: "AUTH_INVALID" });
    const invalidGrant = new GoogleNativeOAuth(new NativeHttpClient(async () => json({ error: "invalid_grant", error_description: "private provider detail" }, 400)));
    await expect(invalidGrant.refresh(original)).rejects.toMatchObject({ code: "AUTH_REQUIRED", status: 400 });
  });

  it("rejects mismatched Gmail account identity and malformed persisted bearer tokens", async () => {
    const fn = vi.fn<NativeFetch>(async url => url.hostname === "gmail.googleapis.com"
      ? json({ emailAddress: "other@example.invalid" }) : json({ sub: "subject", email: "fixture@example.invalid", email_verified: true }));
    await expect(new GoogleNativeOAuth(new NativeHttpClient(fn)).identity(credential())).rejects.toMatchObject({ code: "AUTH_INVALID" });
    fn.mockClear();
    await expect(new GmailNativeAdapter(new NativeHttpClient(fn)).read({ credentials: { ...credential(), accessToken: "secret\r\nX: injected" }, assertCurrent: () => {} }, "mail"))
      .rejects.toMatchObject({ code: "AUTH_INVALID" });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("Gmail read adapter (controlled HTTP)", () => {
  it("searches and reads bounded plain text plus attachment metadata without fetching attachments", async () => {
    const calls: string[] = [];
    const adapter = new GmailNativeAdapter(new NativeHttpClient(async (url, init) => {
      calls.push(url.toString()); expect(init.headers).toEqual({ authorization: "Bearer access-secret" });
      if (url.pathname.endsWith("/messages")) { expect(url.searchParams.get("q")).toBe("from:fixture"); return json({ messages: [{ id: "a", threadId: "t" }], nextPageToken: "next" }); }
      expect(url.searchParams.get("format")).toBe("full");
      return json({ id: "a", threadId: "t", snippet: "snippet", payload: { mimeType: "multipart/mixed", headers: [{ name: "Subject", value: "Title" }, { name: "X-Secret", value: "ignored" }],
        parts: [{ mimeType: "text/plain", body: { data: Buffer.from("Actual fixture text").toString("base64url") } },
          { mimeType: "text/html", body: { data: Buffer.from("<p>HTML</p>").toString("base64url") } },
          { mimeType: "application/pdf", filename: "fixture.pdf", body: { attachmentId: "attachment-a", size: 42 } }] } });
    }));
    const auth = authorization(); expect((await adapter.search(auth, "from:fixture")).nextCursor).toBe("next");
    const result = await adapter.read(auth, "a"); expect(result).toMatchObject({ title: "Title", text: "Actual fixture text", mimeType: "text/plain",
      attachments: [{ id: "attachment-a", filename: "fixture.pdf", mimeType: "application/pdf", size: 42 }] });
    expect(JSON.stringify(result)).not.toMatch(/X-Secret|access-secret|refresh-secret/u); expect(calls).toHaveLength(2);
    expect(auth.assertCurrent).toHaveBeenCalled();
  });

  it("rejects provider mismatch, path injection and an oversized result list", async () => {
    const fn = vi.fn<NativeFetch>(async () => json({ messages: Array.from({ length: 26 }, () => ({ id: "a" })) }));
    const adapter = new GmailNativeAdapter(new NativeHttpClient(fn));
    await expect(adapter.read(authorization("drive"), "a")).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    await expect(adapter.read(authorization(), "../send")).rejects.toMatchObject({ code: "RESOURCE_NOT_ALLOWED" });
    expect(fn).not.toHaveBeenCalled();
    await expect(adapter.search(authorization(), "q")).rejects.toMatchObject({ code: "RESPONSE_INVALID" });
  });

  it("keeps text/plain when HTML comes first and marks a truncated body", async () => {
    const adapter = new GmailNativeAdapter(new NativeHttpClient(async () => json({ id: "mail", payload: { mimeType: "multipart/alternative", parts: [
      { mimeType: "text/html", body: { data: Buffer.from("h".repeat(128_000)).toString("base64url") } },
      { mimeType: "text/plain", body: { data: Buffer.from("p".repeat(128_001)).toString("base64url") } },
    ] } })));
    const result = await adapter.read(authorization(), "mail"); expect(result.mimeType).toBe("text/plain");
    expect(result.text).toBe("p".repeat(128_000)); expect(result.truncated).toBe(true);
  });
});

describe("Drive read adapter (controlled HTTP)", () => {
  it("filters search to explicit targets and rejects reads outside the same allow-list", async () => {
    const fn = vi.fn<NativeFetch>(async url => { expect(url.searchParams.get("q")).toBe("trashed = false and name contains 'a\\'b'");
      return json({ files: [{ id: "selected", name: "Chosen", mimeType: "text/plain" }, { id: "other", name: "Other", mimeType: "text/plain" }], nextPageToken: "more" }); });
    const adapter = new DriveNativeAdapter(new NativeHttpClient(fn));
    const result = await adapter.search(authorization("drive"), "a'b", ["selected"]); expect(result.items.map(item => item.id)).toEqual(["selected"]); expect(result.nextCursor).toBe("more");
    await expect(adapter.read(authorization("drive"), "other", ["selected"])).rejects.toMatchObject({ code: "RESOURCE_NOT_ALLOWED" }); expect(fn).toHaveBeenCalledOnce();
  });

  it("exports a selected Google document as text and returns owned binary bytes only to the host", async () => {
    const adapter = new DriveNativeAdapter(new NativeHttpClient(async url => {
      if (url.pathname.endsWith("/export")) { expect(url.searchParams.get("mimeType")).toBe("text/plain"); return new Response("fixture document", { headers: { "content-type": "text/plain" } }); }
      return json({ id: "selected", name: "Chosen", mimeType: "application/vnd.google-apps.document" });
    }));
    const result = await adapter.read(authorization("drive"), "selected", ["selected"]);
    expect(result.text).toBe("fixture document"); expect(Buffer.from(result.bytes!).toString()).toBe("fixture document");
  });

  it("does not follow shortcuts, oversized declared files or revoked permission during download", async () => {
    for (const details of [{ mimeType: "application/vnd.google-apps.shortcut" }, { mimeType: "text/plain", size: "4194305" }]) {
      const fn = vi.fn<NativeFetch>(async () => json({ id: "selected", name: "Chosen", ...details }));
      const adapter = new DriveNativeAdapter(new NativeHttpClient(fn));
      await expect(adapter.read(authorization("drive"), "selected", ["selected"])).rejects.toMatchObject({ code: details.size ? "TOO_LARGE" : "RESOURCE_NOT_ALLOWED" });
      expect(fn).toHaveBeenCalledOnce();
    }
    let revoked = false;
    const auth = authorization("drive"); auth.assertCurrent = () => { if (revoked) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED"); };
    const adapter = new DriveNativeAdapter(new NativeHttpClient(async url => {
      if (url.searchParams.has("alt")) { revoked = true; return new Response("secret file"); }
      return json({ id: "selected", name: "Chosen", mimeType: "text/plain" });
    }));
    await expect(adapter.read(auth, "selected", ["selected"])).rejects.toMatchObject({ code: "RESOURCE_NOT_ALLOWED" });
  });
});

describe("Notion read adapter (controlled HTTP)", () => {
  const PAGE = "11111111-1111-1111-1111-111111111111", CHILD = "22222222-2222-2222-2222-222222222222";
  const auth = (): NativeAuthorization => ({ credentials: { kind: "notion", token: "notion-secret" }, assertCurrent: vi.fn() });
  const page = () => ({ object: "page", id: PAGE, properties: { Name: { type: "title", title: [{ plain_text: "Fixture page" }] } }, last_edited_time: "2026-10-14T00:00:00Z", in_trash: false });
  it("uses pinned API version, bot identity and title-only search semantics", async () => {
    const adapter = new NotionNativeAdapter(new NativeHttpClient(async (url, init) => {
      expect(init.headers).toMatchObject({ authorization: "Bearer notion-secret", "Notion-Version": NOTION_API_VERSION });
      if (url.pathname.endsWith("/users/me")) return json({ type: "bot", id: CHILD, name: "Fixture", bot: { workspace_name: "Fixture workspace" } });
      expect(init.method).toBe("POST"); expect(JSON.parse(String(init.body))).toEqual({ query: "title", filter: { value: "page", property: "object" }, page_size: 25 });
      return json({ results: [page()], has_more: false, next_cursor: null });
    }));
    expect(await adapter.identity(auth())).toEqual({ accountId: CHILD, displayName: "Fixture workspace" });
    const result = await adapter.search(auth(), "title"); expect(result.items[0]?.title).toBe("Fixture page"); expect(result.scopeNotice).toContain("标题");
    expect(JSON.stringify(result)).not.toContain("notion-secret");
  });

  it("reads real fixture hierarchy with bounded recursion and excludes signed resource URLs", async () => {
    const calls: string[] = [];
    const adapter = new NotionNativeAdapter(new NativeHttpClient(async url => {
      calls.push(url.pathname);
      if (url.pathname.includes("/pages/")) return json(page());
      if (url.pathname.includes(CHILD)) return json({ results: [{ id: "33333333-3333-3333-3333-333333333333", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Nested content" }] } }], has_more: false });
      return json({ results: [{ id: CHILD, type: "toggle", has_children: true, toggle: { rich_text: [{ plain_text: "Parent content" }] } },
        { id: "44444444-4444-4444-4444-444444444444", type: "image", image: { file: { url: "https://private.signed.invalid/token" } } }], has_more: false });
    }));
    const result = await adapter.read(auth(), PAGE); expect(result.text).toBe("Parent content\nNested content\n[image]");
    expect(result.metadata).toMatchObject({ blockCount: 3, unsupportedBlocks: 1, apiVersion: "2026-03-11" }); expect(calls).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain("private.signed");
  });

  it("bounds cyclic or endless pagination without claiming a complete page", async () => {
    let requests = 0;
    const adapter = new NotionNativeAdapter(new NativeHttpClient(async url => {
      if (url.pathname.includes("/pages/")) return json(page());
      requests++; return json({ results: [], has_more: true, next_cursor: `cursor-${requests}` });
    }));
    const result = await adapter.read(auth(), PAGE); expect(requests).toBe(32); expect(result.truncated).toBe(true);
  });

  it("does not emit removed pages and stops on a revocation between parent and child reads", async () => {
    const removed = new NotionNativeAdapter(new NativeHttpClient(async () => json({ ...page(), in_trash: true })));
    await expect(removed.read(auth(), PAGE)).rejects.toMatchObject({ code: "RESOURCE_NOT_ALLOWED" });
    let revoked = false;
    const scope = auth(); scope.assertCurrent = () => { if (revoked) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED"); };
    const adapter = new NotionNativeAdapter(new NativeHttpClient(async url => {
      if (url.pathname.includes("/pages/")) return json(page());
      revoked = true; return json({ results: [], has_more: false });
    }));
    await expect(adapter.read(scope, PAGE)).rejects.toMatchObject({ code: "RESOURCE_NOT_ALLOWED" });
  });
});
