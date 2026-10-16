import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { EventListenerControl, EventListenerState } from "@shared/event-contracts";
import { eventIdempotencySchema, eventListenerSchema } from "@shared/event-schemas";
import { AevorenBotError } from "./errors";
import { EventStateError } from "./event-repository";
import type { EventService } from "./event-service";

class HttpEventError extends Error { constructor(readonly status: number) { super(`HTTP ${status}`); } }
function body(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    const cleanup = () => { request.off("data", data); request.off("end", end); request.off("error", error); request.off("aborted", aborted); request.setTimeout(0); };
    const fail = (reason: Error) => { cleanup(); request.pause(); reject(reason); };
    const data = (chunk: Buffer) => { size += chunk.length; if (size > 65_536) fail(new HttpEventError(413)); else chunks.push(chunk); };
    const end = () => {
      cleanup();
      try { const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); resolve(JSON.parse(text)); }
      catch { reject(new HttpEventError(400)); }
    };
    const error = () => fail(new HttpEventError(400)), aborted = () => fail(new HttpEventError(400));
    request.on("data", data); request.once("end", end); request.once("error", error); request.once("aborted", aborted);
    request.setTimeout(5_000, () => fail(new HttpEventError(408)));
  });
}
/** Explicitly started local ingress. It never binds an external interface or enables itself at construction. */
export class EventHttpServer {
  private server: Server | null = null;
  private state: EventListenerState = { listening: false, host: "127.0.0.1", port: null, revision: randomUUID(), busy: false };
  private pending: Promise<EventListenerState> | null = null;
  private closing = false;
  constructor(private readonly events: EventService, private readonly changed: () => void = () => {}) {}
  snapshot(): EventListenerState { return { ...this.state }; }
  assertControl(action: "start" | "stop", input: EventListenerControl): void {
    if (this.closing) throw new AevorenBotError("EVENT_STOPPED");
    if (this.pending || this.state.busy || input.expectedRevision !== this.state.revision
      || action === "start" && this.state.listening
      || action === "stop" && (!this.state.listening || input.port !== this.state.port)) throw new AevorenBotError("EVENT_VERSION_CONFLICT");
  }
  startControlled(input: EventListenerControl, context?: { signal?: AbortSignal; assertCurrent(): void }, complete?: (value: EventListenerState) => unknown): Promise<EventListenerState> {
    context?.signal?.throwIfAborted(); context?.assertCurrent(); this.assertControl("start", input);
    return this.start({ port: input.port }, context, complete);
  }
  stopControlled(input: EventListenerControl, context?: { signal?: AbortSignal; assertCurrent(): void }, complete?: (value: EventListenerState) => unknown): Promise<EventListenerState> {
    context?.signal?.throwIfAborted(); context?.assertCurrent(); this.assertControl("stop", input);
    return this.stop(context, complete);
  }
  private track(work: Promise<EventListenerState>): Promise<EventListenerState> {
    this.pending = work;
    void work.then(() => { if (this.pending === work) this.pending = null; }, () => { if (this.pending === work) this.pending = null; });
    return work;
  }
  private async closeServer(server: Server): Promise<void> {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
  /** Trusted setup and shutdown use the same ownership lock as reviewed controls. */
  start(input: { port?: number } = {}, context?: { signal?: AbortSignal; assertCurrent(): void }, complete?: (value: EventListenerState) => unknown): Promise<EventListenerState> {
    const parsed = eventListenerSchema.parse(input);
    if (this.closing) return Promise.reject(new AevorenBotError("EVENT_STOPPED"));
    if (this.pending) return Promise.reject(new AevorenBotError("EVENT_VERSION_CONFLICT"));
    if (this.server) return Promise.resolve(this.snapshot());
    context?.signal?.throwIfAborted(); context?.assertCurrent();
    const server = createServer((request, response) => { void this.handle(request, response); });
    server.requestTimeout = 5_000; server.headersTimeout = 5_000; server.keepAliveTimeout = 1_000; server.maxConnections = 32; server.maxRequestsPerSocket = 20;
    this.server = server;
    this.state = { ...this.state, busy: true, revision: randomUUID() };
    const work = this.track((async () => {
      try {
        await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(parsed.port ?? 0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
        context?.signal?.throwIfAborted(); context?.assertCurrent();
        const address = server.address();
        if (!address || typeof address === "string" || address.address !== "127.0.0.1") throw new EventStateError("EVENT_INVALID");
        this.state = { listening: true, host: "127.0.0.1", port: address.port, revision: randomUUID(), busy: false };
        this.changed(); context?.signal?.throwIfAborted(); context?.assertCurrent();
        const result = this.snapshot(); complete?.(result); return result;
      } catch (error) {
        await this.closeServer(server); this.server = null;
        this.state = { listening: false, host: "127.0.0.1", port: null, revision: randomUUID(), busy: false };
        this.changed(); throw error;
      }
    })());
    return work;
  }
  stop(context?: { signal?: AbortSignal; assertCurrent(): void }, complete?: (value: EventListenerState) => unknown): Promise<EventListenerState> {
    const pending = this.pending;
    if (pending) return pending.then(() => this.stop(context, complete), () => this.stop(context, complete));
    context?.signal?.throwIfAborted(); context?.assertCurrent();
    const server = this.server;
    if (!server) return Promise.resolve(this.snapshot());
    this.state = { ...this.state, listening: false, busy: true, revision: randomUUID() };
    const work = this.track((async () => {
      await this.closeServer(server); this.server = null;
      this.state = { listening: false, host: "127.0.0.1", port: null, revision: randomUUID(), busy: false };
      this.changed(); context?.signal?.throwIfAborted(); context?.assertCurrent();
      const result = this.snapshot(); complete?.(result); return result;
    })());
    return work;
  }
  async shutdown(): Promise<void> { this.closing = true; await this.stop(); }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let status: number;
    try {
      if (!this.state.listening || request.socket.remoteAddress !== "127.0.0.1") throw new HttpEventError(503);
      if (request.method !== "POST") throw new HttpEventError(405);
      if (request.headers.host !== `127.0.0.1:${this.state.port}` || request.headers.origin !== undefined) throw new HttpEventError(403);
      const path = /^\/hooks\/([0-9a-f-]{36})\/([1-9][0-9]*)$/.exec(request.url ?? "");
      if (!path || !Number.isSafeInteger(Number(path[2]))) throw new HttpEventError(404);
      const auth = request.headers.authorization;
      if (typeof auth !== "string" || !auth.startsWith("Bearer ") || request.headersDistinct.authorization?.length !== 1) throw new HttpEventError(401);
      const id = path[1]!, version = Number(path[2]), bearer = auth.slice(7);
      // Authenticate before reading, allocating or parsing the body, then recheck on acceptance.
      this.events.authenticate(id, version, bearer);
      if (request.headers["content-type"] !== "application/json" || request.headers["content-encoding"] !== undefined || request.headersDistinct["content-type"]?.length !== 1) throw new HttpEventError(415);
      const length = request.headers["content-length"];
      if (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > 65_536)) throw new HttpEventError(413);
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || request.headersDistinct["idempotency-key"]?.length !== 1 || !eventIdempotencySchema.safeParse(key).success) throw new HttpEventError(400);
      const payload = await body(request), receipt = await this.events.receiveWebhook({ id, version, bearer, eventId: key, payload });
      status = 202;
      response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Connection": "close" });
      response.end(JSON.stringify(receipt)); return;
    } catch (error) {
      status = error instanceof HttpEventError ? error.status : error instanceof EventStateError ? error.code === "EVENT_UNAUTHORIZED" ? 401 : error.code === "EVENT_VERSION_CONFLICT" ? 409 : error.code === "EVENT_LIMIT" ? 429 : 400 : 400;
    }
    if (!response.destroyed) {
      const socket = request.socket;
      if (!request.complete) {
        // Discard without buffering/parsing. A destructive close here can reset an early 413 before the peer receives it.
        request.resume();
        const closeDeadline = setTimeout(() => socket.destroy(), 5_000);
        closeDeadline.unref();
        socket.once("close", () => clearTimeout(closeDeadline));
      }
      response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Connection": "close" });
      response.end(JSON.stringify({ error: status }), () => { if (!request.complete) socket.end(); });
    }
  }
}
