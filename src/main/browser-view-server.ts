import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { BrowserScope, ComputerVncTicket } from "@shared/browser-contracts";
import { AevorenBotError } from "./errors";

type ViewerBinding = { scope: BrowserScope; browserSessionId: string; epoch: number; port: number; token: string; isAuthorized(): boolean };
type Ticket = { binding: ViewerBinding; expires: number; used: boolean; sockets: Set<WebSocket> };
/** The Renderer receives only a short-lived loopback capability, never a Worker control token. */
export class BrowserViewServer {
  private readonly server = createServer((_request, response) => { response.writeHead(404); response.end(); });
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 65_536 });
  private readonly tickets = new Map<string, Ticket>();
  private listening?: Promise<number>;
  private readonly origins = new Set(["null", "file://"]);
  constructor(private readonly leaseMs = 600_000) {
    const developmentUrl = process.env.ELECTRON_RENDERER_URL;
    if (developmentUrl) { const url = new URL(developmentUrl); if (["localhost", "127.0.0.1"].includes(url.hostname)) this.origins.add(url.origin); }
    this.server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1"), entry = this.tickets.get(url.pathname.slice(1));
      const allowed = (): boolean => Boolean(entry && Date.now() < entry.expires && entry.binding.isAuthorized());
      if (!entry || entry.used || !allowed() || request.headers.origin && !this.origins.has(request.headers.origin)) { socket.destroy(); return; }
      entry.used = true;
      this.sockets.handleUpgrade(request, socket, head, viewer => {
        const worker = new WebSocket(`ws://127.0.0.1:${entry.binding.port}/v1/computer/vnc?epoch=${entry.binding.epoch}`, { headers: { authorization: `Bearer ${entry.binding.token}` }, handshakeTimeout: 10_000, maxPayload: 1_048_576 });
        entry.sockets.add(viewer); entry.sockets.add(worker);
        const close = (): void => { viewer.terminate(); worker.terminate(); entry.sockets.clear(); };
        const timer = setTimeout(close, Math.max(1, entry.expires - Date.now())); timer.unref();
        worker.on("message", (bytes, binary) => { if (!allowed() || viewer.readyState !== WebSocket.OPEN || viewer.bufferedAmount > 1_048_576) { close(); return; } viewer.send(bytes, { binary }); });
        viewer.on("message", (bytes, binary) => { if (!binary || !allowed() || worker.readyState !== WebSocket.OPEN || worker.bufferedAmount > 1_048_576) { close(); return; } worker.send(bytes, { binary: true }); });
        worker.on("error", close); viewer.on("error", close);
        worker.once("close", close); viewer.once("close", () => { clearTimeout(timer); close(); });
      });
    });
  }
  private listen(): Promise<number> {
    return this.listening ??= new Promise((accept, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => { const address = this.server.address(); if (!address || typeof address === "string") reject(new AevorenBotError("BROWSER_UNAVAILABLE")); else accept(address.port); });
    });
  }
  async ticket(binding: ViewerBinding): Promise<ComputerVncTicket> {
    if (!binding.isAuthorized()) throw new AevorenBotError("COMPUTER_CONTROL_CHANGED");
    const port = await this.listen(); if (!binding.isAuthorized()) throw new AevorenBotError("COMPUTER_CONTROL_CHANGED");
    const id = randomUUID(), expires = Date.now() + this.leaseMs;
    this.tickets.set(id, { binding, expires, used: false, sockets: new Set() });
    return { id, browserSessionId: binding.browserSessionId, epoch: binding.epoch, expiresAt: new Date(expires).toISOString(), url: `ws://127.0.0.1:${port}/${id}` };
  }
  revoke(scope: BrowserScope): void {
    for (const [id, entry] of this.tickets) if (entry.binding.scope.sessionId === scope.sessionId && entry.binding.scope.executorBotId === scope.executorBotId) {
      for (const socket of entry.sockets) socket.terminate(); this.tickets.delete(id);
    }
  }
  async shutdown(): Promise<void> {
    for (const entry of this.tickets.values()) for (const socket of entry.sockets) socket.terminate(); this.tickets.clear();
    this.sockets.close(); if (this.server.listening) await new Promise<void>(accept => this.server.close(() => accept()));
  }
}
