import { describe, expect, it, vi } from "vitest";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { createOAuthCallback, McpOAuthProvider, oauthState, parseMcpOAuthRecord, type McpOAuthRecord } from "./mcp-oauth";

describe("MCP OAuth", () => {
  it("persists only validated SDK credential shapes and keeps the PKCE verifier in memory", async () => {
    let record: McpOAuthRecord = {};
    const opened = vi.fn(async () => {});
    const provider = new McpOAuthProvider({
      appVersion: "1.2.3",
      redirectUrl: new URL("http://127.0.0.1:43210/oauth/callback"),
      state: "state-value",
      interactive: true,
      allowLoopbackAuthorization: true,
      store: { read: () => record, write: (next) => { record = next; } },
      openAuthorization: opened,
    });
    expect(provider.clientMetadata).toMatchObject({
      redirect_uris: ["http://127.0.0.1:43210/oauth/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    provider.saveCodeVerifier("verifier-secret");
    expect(provider.codeVerifier()).toBe("verifier-secret");
    provider.saveClientInformation({ client_id: "client-id", client_secret: "client-secret" });
    provider.saveTokens({ access_token: "access-secret", refresh_token: "refresh-secret", token_type: "Bearer" });
    expect(parseMcpOAuthRecord(JSON.stringify(record))).toMatchObject({
      clientInformation: { client_id: "client-id", client_secret: "client-secret" },
      tokens: { access_token: "access-secret", refresh_token: "refresh-secret", token_type: "Bearer" },
    });
    await provider.redirectToAuthorization(new URL("http://127.0.0.1:45678/authorize"));
    expect(opened).toHaveBeenCalledOnce();
    const nonInteractive = new McpOAuthProvider({
      appVersion: "1.2.3",
      redirectUrl: provider.redirectUrl,
      state: "unused",
      interactive: false,
      allowLoopbackAuthorization: true,
      store: { read: () => record, write: (next) => { record = next; } },
      openAuthorization: opened,
    });
    await expect(nonInteractive.redirectToAuthorization(new URL("http://127.0.0.1:45678/authorize")))
      .rejects.toMatchObject({ code: "MCP_AUTH_REQUIRED" });
  });

  it("accepts one exact state-bound loopback callback and rejects a mismatched state", async () => {
    const state = oauthState();
    const callback = await createOAuthCallback(state, 2_000);
    const acceptedUrl = new URL(callback.redirectUrl);
    acceptedUrl.search = new URLSearchParams({ state, code: "authorization-code" }).toString();
    await expect(fetch(acceptedUrl)).resolves.toMatchObject({ status: 200 });
    await expect(callback.result).resolves.toBe("authorization-code");

    const rejected = await createOAuthCallback("expected", 2_000);
    const rejection = expect(rejected.result).rejects.toMatchObject({ code: "MCP_AUTH_INVALID" });
    const rejectedUrl = new URL(rejected.redirectUrl);
    rejectedUrl.search = new URLSearchParams({ state: "wrong", code: "attacker-code" }).toString();
    await expect(fetch(rejectedUrl)).resolves.toMatchObject({ status: 400 });
    await rejection;
  });

  it("cancels a pending callback without accepting a later response", async () => {
    const callback = await createOAuthCallback("state", 2_000);
    const rejection = expect(callback.result).rejects.toMatchObject({ code: "MCP_AUTH_CANCELLED" });
    callback.cancel();
    await rejection;
    await expect(fetch(callback.redirectUrl)).rejects.toBeTruthy();
  });

  it("rejects malformed encrypted records before returning credentials", () => {
    expect(() => parseMcpOAuthRecord("not-json")).toThrowError(expect.objectContaining({ code: "MCP_AUTH_STORAGE_INVALID" }));
    expect(() => parseMcpOAuthRecord(JSON.stringify({ tokens: { access_token: 42 } })))
      .toThrowError(expect.objectContaining({ code: "MCP_AUTH_STORAGE_INVALID" }));
  });

  it("refreshes an expired access token without reopening the browser", async () => {
    const authorizationServerUrl = "https://auth.example.test";
    let record: McpOAuthRecord = {
      clientInformation: { client_id: "client-id" },
      tokens: { access_token: "expired", refresh_token: "refresh-token", token_type: "Bearer" },
      discoveryState: {
        authorizationServerUrl,
        authorizationServerMetadata: {
          issuer: authorizationServerUrl,
          authorization_endpoint: `${authorizationServerUrl}/authorize`,
          token_endpoint: `${authorizationServerUrl}/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
        },
      },
    };
    const opened = vi.fn(async () => {});
    const provider = new McpOAuthProvider({
      appVersion: "1.0.0",
      redirectUrl: new URL("http://127.0.0.1:43210/oauth/callback"),
      state: "unused",
      interactive: false,
      allowLoopbackAuthorization: false,
      store: { read: () => record, write: (next) => { record = next; } },
      openAuthorization: opened,
    });
    const fetchFn = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const params = new URLSearchParams(String(init?.body ?? ""));
      expect(params.get("grant_type")).toBe("refresh_token");
      expect(params.get("refresh_token")).toBe("refresh-token");
      return new Response(JSON.stringify({ access_token: "refreshed", token_type: "Bearer", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    await expect(auth(provider, { serverUrl: "https://mcp.example.test/mcp", fetchFn })).resolves.toBe("AUTHORIZED");
    expect(record.tokens).toMatchObject({ access_token: "refreshed", refresh_token: "refresh-token" });
    expect(opened).not.toHaveBeenCalled();
  });
});
