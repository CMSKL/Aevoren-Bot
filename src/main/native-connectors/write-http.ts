import { type NativeFetch, object } from "./http";
import { type NativeDispatchProof, type NativeReconcileHint, type NativeWriteAuthorization, NativeConnectorError } from "./types";

export type NativeWriteResponse = { status: number; data: Record<string, unknown> } | { unknown: "transport" | "timeout" | "cancelled" | "response-invalid" };
function safeEndpoint(url: URL, method: string): boolean {
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash) return false;
  if (url.hostname === "gmail.googleapis.com") return method === "POST" && url.pathname === "/gmail/v1/users/me/messages/send";
  if (url.hostname === "www.googleapis.com") return method === "POST" && url.pathname === "/upload/drive/v3/files"
    || method === "PATCH" && /^\/upload\/drive\/v3\/files\/[A-Za-z0-9_-]{1,256}$/u.test(url.pathname);
  return url.hostname === "api.notion.com" && method === "POST" && url.pathname === "/v1/pages";
}
export function safeCommittedHint(data: Record<string, unknown>): NativeReconcileHint | undefined {
  const additional = data.additional_data;
  if (!additional || typeof additional !== "object" || Array.isArray(additional)) return undefined;
  const value = additional as Record<string, unknown>, hint: NativeReconcileHint = {};
  if (typeof value.committed_resource_id === "string" && /^[a-fA-F0-9-]{32,36}$/u.test(value.committed_resource_id)) hint.resourceId = value.committed_resource_id;
  if (Array.isArray(value.committed_child_ids) && value.committed_child_ids.length <= 100
    && value.committed_child_ids.every(id => typeof id === "string" && /^[a-fA-F0-9-]{32,36}$/u.test(id))) hint.childIds = value.committed_child_ids as string[];
  if (typeof value.retry_guidance === "string" && /^[A-Za-z0-9_-]{1,100}$/u.test(value.retry_guidance)) hint.retryGuidance = value.retry_guidance;
  return Object.keys(hint).length ? hint : undefined;
}

export class NativeWriteHttpClient {
  private readonly attempted = new Set<string>();
  constructor(private readonly fetchFn: NativeFetch = fetch) {}

  async once(auth: NativeWriteAuthorization, attemptId: string, proof: NativeDispatchProof, url: URL, init: RequestInit): Promise<NativeWriteResponse> {
    const method = (init.method ?? "POST").toUpperCase();
    if (!safeEndpoint(url, method) || typeof init.body !== "string" || Buffer.byteLength(init.body) > 2 * 1_024 * 1_024) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
    auth.signal?.throwIfAborted(); auth.assertCurrent();
    if (this.attempted.has(attemptId) || this.attempted.size >= 10_000) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
    this.attempted.add(attemptId);
    try { await auth.dispatchBoundary(proof); } catch (error) { this.attempted.delete(attemptId); throw error; }
    const signal = AbortSignal.any([...(auth.signal ? [auth.signal] : []), AbortSignal.timeout(30_000)]);
    let response: Response | undefined;
    try {
      signal.throwIfAborted(); auth.assertCurrent();
      response = await this.fetchFn(url, { ...init, method, signal, redirect: "error" });
      if (response.redirected || response.status >= 300 && response.status < 400) { await response.body?.cancel(); return { unknown: "response-invalid" }; }
      const declared = response.headers.get("content-length"), type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (declared && (!/^\d+$/u.test(declared) || Number(declared) > 256_000) || type !== "application/json") { await response.body?.cancel(); return { unknown: "response-invalid" }; }
      const reader = response.body?.getReader();
      if (!reader) return { unknown: "response-invalid" };
      const parts: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 256_000) { await reader.cancel(); return { unknown: "response-invalid" }; }
          parts.push(next.value);
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      } finally { reader.releaseLock(); }
      try { return { status: response.status, data: object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts, size)))) }; }
      catch { return { unknown: "response-invalid" }; }
    } catch {
      await response?.body?.cancel().catch(() => {});
      return { unknown: signal.aborted ? auth.signal?.aborted ? "cancelled" : "timeout" : "transport" };
    }
  }
}
