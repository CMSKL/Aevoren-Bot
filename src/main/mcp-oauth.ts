import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthTokensSchema,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { AevorenBotError } from "./errors";
import { assertSafeNetworkUrl } from "./network-security";

export type McpOAuthRecord = {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  discoveryState?: OAuthDiscoveryState;
  redirectUri?: string;
};

type OAuthRecordStore = {
  read(): McpOAuthRecord;
  write(record: McpOAuthRecord): void;
};

type OAuthProviderOptions = {
  appVersion: string;
  redirectUrl: URL;
  state: string;
  interactive: boolean;
  allowLoopbackAuthorization: boolean;
  store: OAuthRecordStore;
  openAuthorization(url: URL): Promise<void>;
};

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

export function parseMcpOAuthRecord(value: string): McpOAuthRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new AevorenBotError("MCP_AUTH_STORAGE_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AevorenBotError("MCP_AUTH_STORAGE_INVALID");
  const source = parsed as Record<string, unknown>;
  const record: McpOAuthRecord = {};
  if (source.tokens !== undefined) {
    const tokens = OAuthTokensSchema.safeParse(source.tokens);
    if (!tokens.success) throw new AevorenBotError("MCP_AUTH_STORAGE_INVALID");
    record.tokens = tokens.data;
  }
  if (source.clientInformation !== undefined) {
    const full = OAuthClientInformationFullSchema.safeParse(source.clientInformation);
    const compact = OAuthClientInformationSchema.safeParse(source.clientInformation);
    if (!full.success && !compact.success) throw new AevorenBotError("MCP_AUTH_STORAGE_INVALID");
    record.clientInformation = full.success ? full.data : compact.data;
  }
  if (source.discoveryState !== undefined) {
    if (!source.discoveryState || typeof source.discoveryState !== "object" || Array.isArray(source.discoveryState)) {
      throw new AevorenBotError("MCP_AUTH_STORAGE_INVALID");
    }
    record.discoveryState = source.discoveryState as OAuthDiscoveryState;
  }
  if (source.redirectUri !== undefined) {
    if (typeof source.redirectUri !== "string" || source.redirectUri.length > 2_048) {
      throw new AevorenBotError("MCP_AUTH_STORAGE_INVALID");
    }
    record.redirectUri = source.redirectUri;
  }
  return record;
}

export class McpOAuthProvider implements OAuthClientProvider {
  private verifier: string | null = null;

  constructor(private readonly options: OAuthProviderOptions) {}

  get redirectUrl(): URL {
    return this.options.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.options.redirectUrl.toString()],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "Aevoren Bot",
      software_id: "com.cmskl.aevorenbot",
      software_version: this.options.appVersion,
    };
  }

  state(): string {
    return this.options.state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.options.store.read().clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.options.store.write({ ...this.options.store.read(), clientInformation });
  }

  tokens(): OAuthTokens | undefined {
    return this.options.store.read().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.options.store.write({ ...this.options.store.read(), tokens });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.options.interactive) throw new AevorenBotError("MCP_AUTH_REQUIRED");
    await assertSafeNetworkUrl(authorizationUrl.toString(), this.options.allowLoopbackAuthorization);
    await this.options.openAuthorization(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new AevorenBotError("MCP_AUTH_INVALID");
    return this.verifier;
  }

  saveDiscoveryState(discoveryState: OAuthDiscoveryState): void {
    this.options.store.write({ ...this.options.store.read(), discoveryState });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.options.store.read().discoveryState;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "verifier") {
      this.verifier = null;
      return;
    }
    const current = this.options.store.read();
    if (scope === "all") this.options.store.write({ redirectUri: current.redirectUri });
    else if (scope === "client") this.options.store.write({ ...current, clientInformation: undefined });
    else if (scope === "tokens") this.options.store.write({ ...current, tokens: undefined });
    else this.options.store.write({ ...current, discoveryState: undefined });
  }
}

export type OAuthCallback = {
  redirectUrl: URL;
  result: Promise<string>;
  cancel(): void;
};

export async function createOAuthCallback(expectedState: string, timeoutMs = 180_000): Promise<OAuthCallback> {
  let server: Server | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  let resolveResult!: (code: string) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<string>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const finish = (error?: Error, code?: string): void => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    server?.close();
    if (error) rejectResult(error);
    else resolveResult(code!);
  };
  server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || requestUrl.pathname !== "/oauth/callback") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" }).end("Not found");
      return;
    }
    const state = requestUrl.searchParams.get("state") ?? "";
    const code = requestUrl.searchParams.get("code") ?? "";
    const oauthError = requestUrl.searchParams.get("error");
    const validState = safeEqual(state, expectedState);
    const validCode = code.length > 0 && code.length <= 4_096;
    const accepted = !oauthError && validState && validCode;
    response.writeHead(accepted ? 200 : 400, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    }).end(accepted
      ? "<!doctype html><meta charset=utf-8><title>Aevoren Bot</title><p>授权完成，可以关闭此页面并返回 Aevoren Bot。</p>"
      : "<!doctype html><meta charset=utf-8><title>Aevoren Bot</title><p>授权未完成，请返回 Aevoren Bot 重试。</p>");
    if (oauthError) finish(new AevorenBotError("MCP_AUTH_CANCELLED"));
    else if (!validState || !validCode) finish(new AevorenBotError("MCP_AUTH_INVALID"));
    else finish(undefined, code);
  });
  server.on("error", () => finish(new AevorenBotError("MCP_AUTH_CALLBACK_FAILED")));
  await new Promise<void>((resolve, reject) => {
    server!.once("listening", resolve);
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1");
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new AevorenBotError("MCP_AUTH_CALLBACK_FAILED");
  }
  timer = setTimeout(() => finish(new AevorenBotError("MCP_AUTH_TIMEOUT")), timeoutMs);
  timer.unref?.();
  return {
    redirectUrl: new URL(`http://127.0.0.1:${address.port}/oauth/callback`),
    result,
    cancel: () => finish(new AevorenBotError("MCP_AUTH_CANCELLED")),
  };
}

export function oauthState(): string {
  return randomBytes(32).toString("base64url");
}
