import { once } from "node:events";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";
import { BrowserViewServer } from "./browser-view-server";

describe("native loopback VNC capability gateway", () => {
  it("keeps the Worker token private and closes input immediately when scope/epoch permission changes", async () => {
    const server = createServer(), worker = new WebSocketServer({ server }), gateway = new BrowserViewServer(60_000), token = "a".repeat(64);
    let authorized = true, forwarded = 0;
    worker.on("connection", (socket, request) => {
      expect(request.headers.authorization).toBe(`Bearer ${token}`); expect(request.headers.origin).toBeUndefined();
      socket.on("message", bytes => { forwarded++; socket.send(bytes); });
    });
    await new Promise<void>(accept => server.listen(0, "127.0.0.1", accept));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture bind failed");
    const ticket = await gateway.ticket({ scope: { sessionId: randomUUID(), executorBotId: randomUUID() }, browserSessionId: randomUUID(), epoch: 2,
      port: address.port, token, isAuthorized: () => authorized });
    expect(ticket.url).not.toContain(token); expect(ticket.url).not.toContain("/v1/");
    const client = new WebSocket(ticket.url); client.on("error", () => undefined);
    try {
      await once(client, "open");
      await new Promise<void>(accept => setTimeout(accept, 30));
      const received = once(client, "message"); client.send(Buffer.from("controlled RFB fixture")); expect((await received)[0].toString()).toBe("controlled RFB fixture");
      expect(forwarded).toBe(1); authorized = false;
      const closed = once(client, "close"); client.send(Buffer.from("blocked after control change")); await closed; expect(forwarded).toBe(1);
    } finally { client.terminate(); await gateway.shutdown(); for (const socket of worker.clients) socket.terminate(); await new Promise<void>(accept => worker.close(() => accept())); await new Promise<void>(accept => server.close(() => accept())); }
  });
});
