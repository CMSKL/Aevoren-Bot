import { setTimeout as delay } from "node:timers/promises";
import { ENV_HTTP_BODY_MAX_BYTES } from "@shared/environment-contracts";

export class ExecutionWorkerError extends Error {
  constructor(readonly code: string, readonly status?: number, readonly firstSeq?: number) { super(code); }
}

type WorkerHealth = { protocolVersion: number; workerVersion: string; environmentId: string; bootId: string; capabilities: string[] };
const RESPONSE_LIMIT = ENV_HTTP_BODY_MAX_BYTES;

async function readText(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "", bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) return text + decoder.decode();
      bytes += item.value.byteLength;
      if (bytes > limit) throw new ExecutionWorkerError("WORKER_RESPONSE_TOO_LARGE");
      text += decoder.decode(item.value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** This client cannot address external URLs or follow redirects with the control credential. */
export class ExecutionWorkerClient {
  private readonly base: string;
  constructor(port: number, private readonly token: string, private readonly environmentId: string, private readonly fetcher: typeof fetch = fetch) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535 || !/^[a-f0-9]{64}$/.test(token)) throw new ExecutionWorkerError("WORKER_CONNECTION_INVALID");
    this.base = `http://127.0.0.1:${port}`;
  }

  private async response(path: string, method: "GET" | "POST" | "PUT", input: unknown, signal?: AbortSignal, timeoutMs = 15_000): Promise<Response> {
    if (!path.startsWith("/v1/") || path.startsWith("//") || /[\r\n\0]/.test(path)) throw new ExecutionWorkerError("WORKER_REQUEST_INVALID");
    const combined = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    try {
      return await this.fetcher(`${this.base}${path}`, { method, redirect: "error", headers: {
        authorization: `Bearer ${this.token}`, ...(input === undefined ? {} : { "content-type": "application/json" }),
      }, ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: combined });
    } catch {
      signal?.throwIfAborted();
      throw new ExecutionWorkerError("WORKER_CONNECTION_FAILED");
    }
  }

  async request<T>(path: string, method: "GET" | "POST" | "PUT" = "GET", input?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.response(path, method, input, signal);
    const text = await readText(response, RESPONSE_LIMIT);
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new ExecutionWorkerError("WORKER_RESPONSE_INVALID", response.status); }
    if (!response.ok) {
      const value = body as { error?: { code?: unknown; firstSeq?: unknown } };
      throw new ExecutionWorkerError(typeof value.error?.code === "string" && /^[A-Z0-9_]{1,100}$/.test(value.error.code) ? value.error.code : "WORKER_REQUEST_FAILED", response.status,
        typeof value.error?.firstSeq === "number" && Number.isSafeInteger(value.error.firstSeq) && value.error.firstSeq > 0 ? value.error.firstSeq : undefined);
    }
    return body as T;
  }

  async health(signal?: AbortSignal): Promise<WorkerHealth> {
    const health = await this.request<WorkerHealth>("/v1/health", "GET", undefined, signal);
    if (health.protocolVersion !== 1 || health.environmentId !== this.environmentId || typeof health.workerVersion !== "string" || typeof health.bootId !== "string" || !Array.isArray(health.capabilities)) throw new ExecutionWorkerError("WORKER_IDENTITY_INVALID");
    return health;
  }

  async waitHealthy(signal?: AbortSignal, timeoutMs = 20_000): Promise<WorkerHealth> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      signal?.throwIfAborted();
      try { return await this.health(signal); } catch (error) {
        if (error instanceof ExecutionWorkerError && error.code === "WORKER_IDENTITY_INVALID") throw error;
        if (Date.now() >= deadline) throw error;
        await delay(250, undefined, { signal });
      }
    }
  }

  async events(path: string, onEvent: (event: string, value: unknown) => void, signal: AbortSignal): Promise<void> {
    const response = await this.response(path, "GET", undefined, signal, 600_000);
    if (!response.ok || !response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) throw new ExecutionWorkerError("WORKER_EVENT_STREAM_INVALID", response.status);
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "";
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        if (buffer.length > RESPONSE_LIMIT) throw new ExecutionWorkerError("WORKER_RESPONSE_TOO_LARGE");
        for (;;) {
          const boundary = /\r?\n\r?\n/.exec(buffer);
          if (!boundary) break;
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          let event = "message";
          const data: string[] = [];
          for (const line of frame.split(/\r?\n/)) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          }
          if (data.length) {
            let value: unknown;
            try { value = JSON.parse(data.join("\n")); } catch { throw new ExecutionWorkerError("WORKER_EVENT_STREAM_INVALID"); }
            onEvent(event, value);
          }
        }
      }
      if (buffer.trim()) throw new ExecutionWorkerError("WORKER_EVENT_STREAM_TRUNCATED");
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
}
