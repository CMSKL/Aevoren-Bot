import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { bearerToken, NativeHttpClient, object, optionalText, resourceId, text } from "./http";
import { NativeConnectorError, type GoogleCredentials, type NativeIdentity } from "./types";

export const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const GOOGLE_EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";
const GMAIL_SCOPES = ["openid", "email", GMAIL_READ_SCOPE];

type GoogleCallbackResult = { code: string; selectedFileIds: string[] };
type GoogleCallback = { redirectUrl: URL; result: Promise<GoogleCallbackResult>; cancel(): void };
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

export async function createGoogleCallback(expectedState: string, provider: "gmail" | "drive", timeoutMs = 180_000): Promise<GoogleCallback> {
  let settled = false;
  let resolveResult!: (value: GoogleCallbackResult) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<GoogleCallbackResult>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  // The consumer attaches after binding the ephemeral port. A cancellation or
  // bind failure must never produce an unhandled credential-flow rejection.
  void result.catch(() => {});
  const finish = (error?: Error, value?: GoogleCallbackResult): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    server.close();
    if (error) rejectResult(error); else resolveResult(value!);
  };
  const server = createServer({ maxHeaderSize: 16_384 }, (request, response) => {
    const reply = (status: number): void => { response.writeHead(status, {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
      "content-security-policy": "default-src 'none'", "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    }).end("<!doctype html><meta charset=utf-8><title>Aevoren Bot</title><p>请返回 Aevoren Bot 查看授权结果。</p>"); };
    if (settled || request.method !== "GET" || (request.url?.length ?? 0) > 16_384) { reply(404); return; }
    let url: URL;
    try { url = new URL(request.url ?? "/", "http://127.0.0.1"); } catch { reply(400); return; }
    if (url.pathname !== "/oauth/callback") { reply(404); return; }
    // A request from an unrelated tab must not cancel an in-progress flow.
    if (url.searchParams.getAll("state").length !== 1 || !safeEqual(url.searchParams.get("state") ?? "", expectedState)) { reply(400); return; }
    if (url.searchParams.has("error")) { reply(400); finish(new NativeConnectorError("AUTH_CANCELLED")); return; }
    const code = url.searchParams.get("code");
    if (url.searchParams.getAll("code").length !== 1 || !code || code.length > 4_096) { reply(400); finish(new NativeConnectorError("AUTH_INVALID")); return; }
    try {
      const raw = url.searchParams.get("picked_file_ids") ?? "";
      if (url.searchParams.getAll("picked_file_ids").length > 1 || raw.length > 12_800 || provider === "gmail" && raw) throw new NativeConnectorError("AUTH_INVALID");
      const selectedFileIds = raw ? [...new Set(raw.split(",").map(resourceId))] : [];
      if (selectedFileIds.length > 100) throw new NativeConnectorError("AUTH_INVALID");
      reply(200); finish(undefined, { code, selectedFileIds });
    } catch { reply(400); finish(new NativeConnectorError("AUTH_INVALID")); }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
      server.listen(0, "127.0.0.1");
    });
  } catch {
    server.close();
    throw new NativeConnectorError("AUTH_INVALID");
  }
  server.on("error", () => finish(new NativeConnectorError("AUTH_INVALID")));
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new NativeConnectorError("AUTH_INVALID"); }
  const timer = setTimeout(() => finish(new NativeConnectorError("AUTH_TIMEOUT")), timeoutMs);
  timer.unref();
  return { redirectUrl: new URL(`http://127.0.0.1:${address.port}/oauth/callback`), result, cancel: () => finish(new NativeConnectorError("AUTH_CANCELLED")) };
}

function validateClient(clientId: string, clientSecret?: string): void {
  if (!/^[A-Za-z0-9_-]{1,256}\.apps\.googleusercontent\.com$/u.test(clientId)
    || clientSecret !== undefined && (!clientSecret || clientSecret.length > 1_024 || /[\r\n\0]/u.test(clientSecret))) {
    throw new NativeConnectorError("AUTH_INVALID");
  }
}
function normalizedScopes(value: string): string[] {
  return [...new Set(value.split(/\s+/u).filter(Boolean).map(scope => scope === GOOGLE_EMAIL_SCOPE ? "email" : scope))].sort();
}
function validateScopes(provider: "gmail" | "drive", scopes: string[]): void {
  const expected = provider === "gmail" ? GMAIL_SCOPES : [DRIVE_FILE_SCOPE];
  if (expected.length !== scopes.length || !expected.every(scope => scopes.includes(scope))) throw new NativeConnectorError("AUTH_INVALID");
}
function tokenCredentials(body: Record<string, unknown>, previous: Pick<GoogleCredentials, "provider" | "clientId" | "clientSecret"> & Partial<GoogleCredentials>, now: number): GoogleCredentials {
  const accessToken = text(body.access_token, 16_384);
  if (!accessToken || /[\r\n\0]/u.test(accessToken) || text(body.token_type, 16).toLowerCase() !== "bearer") throw new NativeConnectorError("AUTH_INVALID");
  const expiresIn = body.expires_in;
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 86_400) throw new NativeConnectorError("AUTH_INVALID");
  const scopes = body.scope === undefined && previous.scopes ? previous.scopes : normalizedScopes(text(body.scope, 4_096));
  validateScopes(previous.provider, scopes);
  const refreshToken = optionalText(body.refresh_token, 16_384) ?? previous.refreshToken;
  if (refreshToken !== undefined && (!refreshToken || /[\r\n\0]/u.test(refreshToken))) throw new NativeConnectorError("AUTH_INVALID");
  return { kind: "google", provider: previous.provider, clientId: previous.clientId, clientSecret: previous.clientSecret, accessToken, refreshToken,
    expiresAt: now + expiresIn * 1_000, scopes };
}

export class GoogleNativeOAuth {
  constructor(private readonly http = new NativeHttpClient(), private readonly now: () => number = Date.now) {}

  async authorize(options: { provider: "gmail" | "drive"; clientId: string; clientSecret?: string; openExternal(url: string): Promise<void>; signal?: AbortSignal }): Promise<{ credentials: GoogleCredentials; identity: NativeIdentity; selectedFileIds: string[] }> {
    validateClient(options.clientId, options.clientSecret);
    options.signal?.throwIfAborted();
    const state = randomBytes(32).toString("base64url"), verifier = randomBytes(64).toString("base64url");
    const callback = await createGoogleCallback(state, options.provider);
    const onAbort = (): void => callback.cancel();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) callback.cancel();
    try {
      options.signal?.throwIfAborted();
      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.search = new URLSearchParams({ client_id: options.clientId, redirect_uri: callback.redirectUrl.toString(), response_type: "code",
        scope: (options.provider === "gmail" ? GMAIL_SCOPES : [DRIVE_FILE_SCOPE]).join(" "), access_type: "offline", prompt: "consent", state,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
        ...(options.provider === "drive" ? { trigger_onepick: "true", allow_multiple: "true" } : {}) }).toString();
      await options.openExternal(authUrl.toString());
      const result = await callback.result;
      options.signal?.throwIfAborted();
      const form = new URLSearchParams({ client_id: options.clientId, code: result.code, code_verifier: verifier,
        redirect_uri: callback.redirectUrl.toString(), grant_type: "authorization_code", ...(options.clientSecret ? { client_secret: options.clientSecret } : {}) });
      const body = await this.http.json(new URL("https://oauth2.googleapis.com/token"), {
        method: "POST", signal: options.signal, headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
      const credentials = tokenCredentials(body, options, this.now());
      const identity = await this.identity(credentials, options.signal);
      options.signal?.throwIfAborted();
      return { credentials, identity, selectedFileIds: result.selectedFileIds };
    } catch (error) {
      if (error instanceof NativeConnectorError) throw error;
      options.signal?.throwIfAborted();
      throw new NativeConnectorError("AUTH_INVALID");
    } finally { options.signal?.removeEventListener("abort", onAbort); callback.cancel(); }
  }

  async refresh(credentials: GoogleCredentials, signal?: AbortSignal): Promise<GoogleCredentials> {
    validateClient(credentials.clientId, credentials.clientSecret);
    validateScopes(credentials.provider, credentials.scopes);
    if (!credentials.refreshToken) throw new NativeConnectorError("AUTH_REQUIRED");
    bearerToken(credentials.refreshToken);
    const form = new URLSearchParams({ client_id: credentials.clientId, refresh_token: credentials.refreshToken, grant_type: "refresh_token",
      ...(credentials.clientSecret ? { client_secret: credentials.clientSecret } : {}) });
    const body = await this.http.json(new URL("https://oauth2.googleapis.com/token"), { method: "POST", signal,
      headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
    return tokenCredentials(body, credentials, this.now());
  }

  async identity(credentials: GoogleCredentials, signal?: AbortSignal, assertCurrent?: () => void): Promise<NativeIdentity> {
    validateScopes(credentials.provider, credentials.scopes);
    const headers = { authorization: bearerToken(credentials.accessToken) };
    if (credentials.provider === "gmail") {
      const result = await this.http.json(new URL("https://openidconnect.googleapis.com/v1/userinfo"), { headers, signal }, assertCurrent);
      const accountId = text(result.sub, 256), email = text(result.email, 320);
      if (!accountId || !email || result.email_verified !== true) throw new NativeConnectorError("AUTH_INVALID");
      const profile = await this.http.json(new URL("https://gmail.googleapis.com/gmail/v1/users/me/profile"), { headers, signal }, assertCurrent);
      if (text(profile.emailAddress, 320).toLowerCase() !== email.toLowerCase()) throw new NativeConnectorError("AUTH_INVALID");
      return { accountId, displayName: optionalText(result.name, 512) ?? email, email };
    }
    const url = new URL("https://www.googleapis.com/drive/v3/about");
    url.search = new URLSearchParams({ fields: "user(permissionId,emailAddress,displayName)" }).toString();
    const user = object((await this.http.json(url, { headers, signal }, assertCurrent)).user);
    const accountId = text(user.permissionId, 256), email = optionalText(user.emailAddress, 320);
    if (!accountId) throw new NativeConnectorError("AUTH_INVALID");
    return { accountId, displayName: optionalText(user.displayName, 512) ?? email ?? accountId, ...(email ? { email } : {}) };
  }
}
