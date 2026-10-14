import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { WorkerError } from "./worker-error";

export type PreviewTarget = { registeredPortId: string; processId: string; port: number; uid: number };
export type PreviewTicket = { id: string; registeredPortId: string; processId: string; port: number; host: string; expiresAt: string };
type TicketRow = { id: string; registered_port_id: string; process_id: string; port: number; uid: number; token: string; expires: number; revoked: number };
const inputSchema = z.object({ id: z.string().uuid(), registeredPortId: z.string().uuid() }).strict();
const blocked = new Set(["host", "connection", "upgrade", "keep-alive", "proxy-authorization", "proxy-authenticate", "te", "trailer", "transfer-encoding", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-for"]);

/** A bearer hostname authorizes one registered job only, never the Worker control namespace. */
export class PreviewProxy {
  private readonly database: DatabaseSync;
  private readonly suffix: string;
  private readonly connections = new Map<string, Set<Socket | WebSocket>>();
  private readonly opening = new Map<string, { registeredPortId: string; promise: Promise<PreviewTicket> }>();
  private readonly protocols = new WeakMap<IncomingMessage, string>();
  private readonly webSockets = new WebSocketServer({ noServer: true, maxPayload: 1_048_576, perMessageDeflate: false,
    handleProtocols: (_protocols, request) => this.protocols.get(request) || false });
  private readonly timer: ReturnType<typeof setInterval>;
  private polling = false;
  private closed = false;

  constructor(path: string, readonly environmentId: string, private readonly controlToken: string,
    private readonly resolveTarget: (registeredPortId: string) => Promise<PreviewTarget>, private readonly leaseMs = 3_600_000) {
    z.string().uuid().parse(environmentId);
    this.suffix = `.aevoren-preview-${environmentId}.internal`;
    this.database = new DatabaseSync(path);
    this.database.exec("CREATE TABLE IF NOT EXISTS previews(id TEXT PRIMARY KEY,registered_port_id TEXT NOT NULL,process_id TEXT NOT NULL,port INTEGER NOT NULL,uid INTEGER NOT NULL,token TEXT UNIQUE NOT NULL,expires INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS preview_identity(id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS closed_previews(id TEXT PRIMARY KEY);");
    const identity = this.database.prepare("SELECT id FROM preview_identity").get() as { id: string } | undefined;
    if (identity && identity.id !== environmentId) { this.database.close(); throw new WorkerError("WORKER_STATE_SCOPE_INVALID", 503); }
    if (!identity) this.database.prepare("INSERT INTO preview_identity VALUES(?)").run(environmentId);
    // A supervisor restart interrupts the old processes; it does not silently adopt or renew tickets.
    this.database.exec("UPDATE previews SET revoked=1");
    this.timer = setInterval(() => { void this.poll(); }, 200); this.timer.unref();
  }

  private ticket(row: TicketRow): PreviewTicket {
    return { id: row.id, registeredPortId: row.registered_port_id, processId: row.process_id, port: row.port,
      host: `${row.token.slice(0, 32)}.${row.token.slice(32)}${this.suffix}`, expiresAt: new Date(row.expires).toISOString() };
  }
  private row(id: string): TicketRow {
    z.string().uuid().parse(id);
    const row = this.database.prepare("SELECT * FROM previews WHERE id=?").get(id) as TicketRow | undefined;
    if (!row) throw new WorkerError("WORKER_PREVIEW_NOT_FOUND", 404);
    return row;
  }
  private host(request: IncomingMessage): string { return String(request.headers.host ?? "").toLowerCase().replace(/:\d+$/u, ""); }
  handles(request: IncomingMessage): boolean { return this.host(request).endsWith(this.suffix); }
  private fromRequest(request: IncomingMessage): TicketRow {
    const host = this.host(request), prefix = host.slice(0, -this.suffix.length);
    if (!host.endsWith(this.suffix) || !/^[a-f0-9]{32}\.[a-f0-9]{32}$/u.test(prefix)) throw new WorkerError("WORKER_PREVIEW_UNAVAILABLE", 503);
    const row = this.database.prepare("SELECT * FROM previews WHERE token=?").get(prefix.replace(".", "")) as TicketRow | undefined;
    if (!row) throw new WorkerError("WORKER_PREVIEW_UNAVAILABLE", 503);
    const origin = request.headers.origin;
    if (origin && origin !== `http://${request.headers.host}`) throw new WorkerError("WORKER_PREVIEW_ORIGIN_INVALID", 403);
    return row;
  }
  private track(row: TicketRow, socket: Socket | WebSocket): void {
    const current = this.connections.get(row.id) ?? new Set(); current.add(socket); this.connections.set(row.id, current);
    socket.once("close", () => { current.delete(socket); if (!current.size) this.connections.delete(row.id); });
  }
  private revoke(row: TicketRow): void {
    if (!this.closed) this.database.prepare("UPDATE previews SET revoked=1 WHERE id=?").run(row.id);
    for (const socket of this.connections.get(row.id) ?? []) { if (socket instanceof WebSocket) socket.terminate(); else socket.destroy(); }
    this.connections.delete(row.id);
  }
  private async valid(row: TicketRow): Promise<boolean> {
    if (this.closed || row.revoked || row.expires <= Date.now() || this.isClosed(row.id)) { this.revoke(row); return false; }
    try {
      const target = await this.resolveTarget(row.registered_port_id);
      if (this.closed || this.isClosed(row.id) || target.processId !== row.process_id || target.port !== row.port || target.uid !== row.uid) { this.revoke(row); return false; }
      return true;
    } catch { this.revoke(row); return false; }
  }
  async open(input: unknown): Promise<PreviewTicket> {
    const parsed = inputSchema.parse(input);
    const pending = this.opening.get(parsed.id);
    if (pending) { if (pending.registeredPortId !== parsed.registeredPortId) throw new WorkerError("WORKER_IDEMPOTENCY_CONFLICT", 409); return pending.promise; }
    const promise = this.openOnce(parsed).finally(() => this.opening.delete(parsed.id));
    this.opening.set(parsed.id, { registeredPortId: parsed.registeredPortId, promise });
    return promise;
  }
  private async openOnce(parsed: z.infer<typeof inputSchema>): Promise<PreviewTicket> {
    if (this.isClosed(parsed.id)) throw new WorkerError("WORKER_PREVIEW_UNAVAILABLE", 503);
    const existing = this.database.prepare("SELECT * FROM previews WHERE id=?").get(parsed.id) as TicketRow | undefined;
    if (existing) {
      if (existing.registered_port_id !== parsed.registeredPortId) throw new WorkerError("WORKER_IDEMPOTENCY_CONFLICT", 409);
      if (!await this.valid(existing)) throw new WorkerError("WORKER_PREVIEW_UNAVAILABLE", 503);
      return this.ticket(existing);
    }
    const target = await this.resolveTarget(parsed.registeredPortId);
    const row: TicketRow = { id: parsed.id, registered_port_id: target.registeredPortId, process_id: target.processId, port: target.port, uid: target.uid,
      token: randomBytes(32).toString("hex"), expires: Date.now() + this.leaseMs, revoked: 0 };
    if (!await this.valid(row)) throw new WorkerError("WORKER_PREVIEW_UNAVAILABLE", 503);
    this.database.prepare("INSERT INTO previews VALUES(?,?,?,?,?,?,?,0)").run(row.id, row.registered_port_id, row.process_id, row.port, row.uid, row.token, row.expires);
    return this.ticket(row);
  }
  async get(id: string): Promise<{ ticket: PreviewTicket; state: "open" | "closed" }> { const row = this.row(id); return { ticket: this.ticket(row), state: await this.valid(row) ? "open" : "closed" }; }
  private isClosed(id: string): boolean { return Boolean(this.database.prepare("SELECT 1 FROM closed_previews WHERE id=?").get(id)) || Boolean((this.database.prepare("SELECT revoked FROM previews WHERE id=?").get(id) as { revoked: number } | undefined)?.revoked); }
  closeTicket(id: string): { id: string; state: "closed" } {
    z.string().uuid().parse(id); this.database.prepare("INSERT INTO closed_previews VALUES(?) ON CONFLICT(id) DO NOTHING").run(id);
    const row = this.database.prepare("SELECT * FROM previews WHERE id=?").get(id) as TicketRow | undefined;
    if (row) this.revoke(row); return { id, state: "closed" };
  }

  private async targetSocket(row: TicketRow): Promise<Socket> {
    if (!await this.valid(row)) throw new WorkerError("WORKER_PREVIEW_UNAVAILABLE", 503);
    const socket = await new Promise<Socket>((resolve, reject) => {
      const socket = connect(row.port, "127.0.0.1");
      const timer = setTimeout(() => { socket.destroy(); reject(new WorkerError("WORKER_PREVIEW_UNAVAILABLE", 503)); }, 5_000);
      socket.once("connect", () => { clearTimeout(timer); resolve(socket); });
      socket.once("error", () => { clearTimeout(timer); reject(new WorkerError("WORKER_PREVIEW_UNAVAILABLE", 503)); });
    });
    this.track(row, socket);
    // Validate after connecting and before writing request bytes, avoiding a reused-port race.
    if (!await this.valid(row)) { socket.destroy(); throw new WorkerError("WORKER_PREVIEW_UNAVAILABLE", 503); }
    return socket;
  }
  private path(request: IncomingMessage): string {
    const origin = `http://${request.headers.host}`, url = new URL(request.url ?? "/", origin);
    if (url.origin !== origin) throw new WorkerError("WORKER_PREVIEW_REQUEST_INVALID", 400);
    return `${url.pathname}${url.search}`;
  }
  private headers(request: IncomingMessage, row: TicketRow): Record<string, string | string[]> {
    const forbidden = new Set([...blocked, ...String(request.headers.connection ?? "").toLowerCase().split(",").map(value => value.trim())]);
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || forbidden.has(name) || name.startsWith("sec-websocket-") || /^x-(?:aevoren|codex|claude|graph-namespace)(?:-|$)/u.test(name)
        || name === "authorization" && value === `Bearer ${this.controlToken}`) continue;
      headers[name] = value;
    }
    headers.host = `127.0.0.1:${row.port}`;
    const ownOrigin = `http://${request.headers.host}`, upstreamOrigin = `http://127.0.0.1:${row.port}`;
    if (headers.origin === ownOrigin) headers.origin = upstreamOrigin;
    if (typeof headers.referer === "string" && headers.referer.startsWith(`${ownOrigin}/`)) headers.referer = `${upstreamOrigin}${headers.referer.slice(ownOrigin.length)}`;
    return headers;
  }
  async http(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method === "CONNECT") throw new WorkerError("WORKER_PREVIEW_REQUEST_INVALID", 400);
      const row = this.fromRequest(request), path = this.path(request), socket = await this.targetSocket(row);
      if (request.destroyed || response.destroyed) { socket.destroy(); return; }
      const upstream = httpRequest({ hostname: "127.0.0.1", port: row.port, path, method: request.method, headers: this.headers(request, row), createConnection: () => socket }, reply => {
        const headers = { ...reply.headers };
        for (const name of blocked) delete headers[name];
        const location = headers.location;
        if (location) { try { const target = new URL(location, `http://127.0.0.1:${row.port}`); if (["localhost", "127.0.0.1"].includes(target.hostname) && Number(target.port || 80) === row.port) headers.location = `http://${request.headers.host}${target.pathname}${target.search}${target.hash}`; } catch { /* Preserve an application-relative redirect. */ } }
        if (headers["set-cookie"]) headers["set-cookie"] = headers["set-cookie"].map(value => value.replace(/;\s*Domain=(?:localhost|127\.0\.0\.1)(?=;|$)/giu, ""));
        response.writeHead(reply.statusCode ?? 502, headers); reply.pipe(response);
      });
      upstream.on("error", () => { if (!response.headersSent) response.writeHead(503); response.end(); });
      response.once("close", () => upstream.destroy()); request.once("aborted", () => upstream.destroy());
      request.pipe(upstream);
    } catch (error) { if (!response.headersSent) response.writeHead(error instanceof WorkerError ? error.status : 503, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify({ error: { code: error instanceof WorkerError ? error.code : "WORKER_PREVIEW_UNAVAILABLE" } })); }
  }
  async upgrade(request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    let upstream: WebSocket | null = null;
    try {
      const row = this.fromRequest(request), path = this.path(request), target = await this.targetSocket(row);
      if (socket.destroyed) { target.destroy(); return; }
      const offered = String(request.headers["sec-websocket-protocol"] ?? "").split(",").map(value => value.trim()).filter(Boolean);
      if (offered.length > 16 || offered.some(value => value.length > 256)) throw new WorkerError("WORKER_PREVIEW_REQUEST_INVALID", 400);
      upstream = new WebSocket(`ws://127.0.0.1:${row.port}${path}`, offered, { headers: this.headers(request, row), createConnection: () => target,
        handshakeTimeout: 5_000, maxPayload: 1_048_576, perMessageDeflate: false });
      const remote = upstream; this.track(row, remote);
      remote.on("error", () => { socket.destroy(); remote.terminate(); });
      remote.once("open", () => {
        void this.valid(row).then(valid => {
          if (!valid || socket.destroyed) { remote.terminate(); socket.destroy(); return; }
          this.protocols.set(request, remote.protocol);
          this.webSockets.handleUpgrade(request, socket, head, viewer => {
            this.track(row, viewer);
            const close = (): void => { viewer.terminate(); remote.terminate(); };
            viewer.on("error", close); viewer.once("close", close); remote.once("close", close);
            viewer.on("message", (bytes, binary) => { if (remote.readyState !== WebSocket.OPEN || remote.bufferedAmount > 1_048_576) close(); else remote.send(bytes, { binary }); });
            remote.on("message", (bytes, binary) => { if (viewer.readyState !== WebSocket.OPEN || viewer.bufferedAmount > 1_048_576) close(); else viewer.send(bytes, { binary }); });
          });
        }).catch(() => { remote.terminate(); socket.destroy(); });
      });
      socket.once("close", () => remote.terminate());
    } catch { upstream?.terminate(); if (!socket.destroyed) socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"); }
  }
  private async poll(): Promise<void> {
    if (this.polling || this.closed) return; this.polling = true;
    try { for (const id of [...this.connections.keys()]) { if (this.closed) break; await this.valid(this.row(id)); } }
    finally { this.polling = false; }
  }
  close(): void { if (this.closed) return; clearInterval(this.timer); for (const id of [...this.connections.keys()]) this.revoke(this.row(id)); this.closed = true; this.webSockets.close(); this.database.close(); }
}
