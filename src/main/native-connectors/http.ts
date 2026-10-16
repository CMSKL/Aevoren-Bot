import { NativeConnectorError } from "./types";

export type NativeFetch = (url: URL, init: RequestInit) => Promise<Response>;
function permittedEndpoint(url: URL): boolean {
  if (url.hostname === "oauth2.googleapis.com") return url.pathname === "/token";
  if (url.hostname === "openidconnect.googleapis.com") return url.pathname === "/v1/userinfo";
  if (url.hostname === "gmail.googleapis.com") return /^\/gmail\/v1\/users\/me\/(?:profile|messages(?:\/[A-Za-z0-9_-]{1,256})?)$/u.test(url.pathname);
  if (url.hostname === "www.googleapis.com") return /^\/drive\/v3\/(?:about|files(?:\/generateIds|\/[A-Za-z0-9_-]{1,256}(?:\/export)?)?)$/u.test(url.pathname);
  if (url.hostname === "api.notion.com") return /^\/v1\/(?:users\/me|search|pages\/[A-Fa-f0-9-]{32,36}|blocks\/[A-Fa-f0-9-]{32,36}(?:\/children)?)$/u.test(url.pathname);
  return false;
}
const MAX_JSON_BYTES = 2 * 1_024 * 1_024;
export const MAX_NATIVE_FILE_BYTES = 4 * 1_024 * 1_024;

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NativeConnectorError("RESPONSE_INVALID");
  return value as Record<string, unknown>;
}
export function text(value: unknown, maximum = 16_384): string {
  if (typeof value !== "string" || value.length > maximum) throw new NativeConnectorError("RESPONSE_INVALID");
  return value;
}
export function optionalText(value: unknown, maximum = 16_384): string | undefined {
  return value === undefined || value === null ? undefined : text(value, maximum);
}
export function resourceId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,256}$/u.test(value)) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
  return value;
}
export function queryText(value: string): string {
  if (value.length > 2_000 || value.includes("\0")) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
  return value;
}
export function bearerToken(value: string): string {
  if (!value || value.length > 16_384 || /[\r\n\0]/u.test(value)) throw new NativeConnectorError("AUTH_INVALID");
  return `Bearer ${value}`;
}

export class NativeHttpClient {
  constructor(private readonly fetchFn: NativeFetch = fetch) {}

  async bytes(url: URL, init: RequestInit, maximum = MAX_NATIVE_FILE_BYTES, assertCurrent: () => void = () => {}): Promise<{ bytes: Uint8Array; contentType: string }> {
    const method = (init.method ?? "GET").toUpperCase();
    const isReadPost = url.hostname === "oauth2.googleapis.com" && url.pathname === "/token"
      || url.hostname === "api.notion.com" && url.pathname === "/v1/search";
    if (url.protocol !== "https:" || !permittedEndpoint(url) || url.port || url.username || url.password || url.hash
      || method !== (isReadPost ? "POST" : "GET")) {
      throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
    }
    const signal = AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(30_000)]);
    signal.throwIfAborted();
    assertCurrent();
    let response: Response;
    try {
      response = await this.fetchFn(url, { ...init, signal, redirect: "error" });
    } catch {
      signal.throwIfAborted();
      assertCurrent();
      throw new NativeConnectorError("REQUEST_FAILED");
    }
    try { signal.throwIfAborted(); assertCurrent(); } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
    if (response.redirected || response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) throw new NativeConnectorError("AUTH_REQUIRED", response.status);
      if (url.hostname === "oauth2.googleapis.com" && response.status === 400) throw new NativeConnectorError("AUTH_REQUIRED", response.status);
      if (response.status === 403) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED", response.status);
      throw new NativeConnectorError("REQUEST_FAILED", response.status);
    }
    const declared = response.headers.get("content-length");
    if (declared && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) {
      await response.body?.cancel();
      throw new NativeConnectorError("TOO_LARGE");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new NativeConnectorError("RESPONSE_INVALID");
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        assertCurrent();
        const result = await reader.read();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > maximum) throw new NativeConnectorError("TOO_LARGE");
        parts.push(result.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      signal.throwIfAborted();
      assertCurrent();
      if (error instanceof NativeConnectorError) throw error;
      throw new NativeConnectorError("REQUEST_FAILED");
    } finally {
      reader.releaseLock();
    }
    signal.throwIfAborted();
    assertCurrent();
    return { bytes: Buffer.concat(parts, size), contentType: (response.headers.get("content-type") ?? "application/octet-stream").split(";", 1)[0]!.trim().toLowerCase() };
  }

  async json(url: URL, init: RequestInit, assertCurrent?: () => void): Promise<Record<string, unknown>> {
    const result = await this.bytes(url, init, MAX_JSON_BYTES, assertCurrent);
    if (result.contentType !== "application/json" && !result.contentType.endsWith("+json")) throw new NativeConnectorError("RESPONSE_INVALID");
    try {
      return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.bytes)));
    } catch {
      throw new NativeConnectorError("RESPONSE_INVALID");
    }
  }
}
