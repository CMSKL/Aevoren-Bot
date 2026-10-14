import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";
import { PreviewProxy, type PreviewTarget, type PreviewTicket } from "./preview-proxy";

async function request(url: string, headers: Record<string, string>, method = "GET", body?: string): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk))); response.once("end", () => resolve({ status: response.statusCode!, data: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("error", reject); request.end(body);
  });
}

async function fixture(callback: (f: { proxy: PreviewProxy; ticket: PreviewTicket; url: string; alive(value: boolean): void; count(): number; token: string }) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "aevoren-preview-proxy-"));
  let active = true, writes = 0;
  const application = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (request.method === "POST") writes++;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ path: request.url, method: request.method, headers: request.headers, body: Buffer.concat(chunks).toString("utf8") }));
  });
  const echo = new WebSocketServer({ server: application });
  echo.on("connection", socket => socket.on("message", (bytes, binary) => socket.send(bytes, { binary })));
  await new Promise<void>(resolve => application.listen(0, "127.0.0.1", resolve));
  const applicationAddress = application.address(); if (!applicationAddress || typeof applicationAddress === "string") throw new Error("Fixture bind failed");
  const target: PreviewTarget = { registeredPortId: randomUUID(), processId: randomUUID(), port: applicationAddress.port, uid: 1_010 }, token = "f".repeat(64);
  const proxy = new PreviewProxy(join(directory, "preview.sqlite"), randomUUID(), token, async id => { if (!active || id !== target.registeredPortId) throw new Error("Not the registered running job"); return target; });
  const server = createServer((request, response) => { if (proxy.handles(request)) void proxy.http(request, response); else response.writeHead(401).end(); });
  server.on("upgrade", (request, socket, head) => { void proxy.upgrade(request, socket as import("node:net").Socket, head); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture bind failed");
  try {
    const ticket = await proxy.open({ id: randomUUID(), registeredPortId: target.registeredPortId });
    await callback({ proxy, ticket, url: `http://127.0.0.1:${address.port}`, alive: value => { active = value; }, count: () => writes, token });
  } finally { proxy.close(); for (const socket of echo.clients) socket.terminate(); echo.close(); server.closeAllConnections(); application.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => application.close(() => resolve()))]); await rm(directory, { recursive: true, force: true }); }
}

describe("fixed registered application preview proxy", () => {
  it("forwards absolute application paths and write bodies once without Worker credentials or namespace headers", async () => {
    await fixture(async f => {
      const response = await request(`${f.url}/absolute/spa/path?q=fixture`, { host: `${f.ticket.host}:8080`, origin: `http://${f.ticket.host}:8080`, authorization: `Bearer ${f.token}`, "x-aevoren-session-id": "private-namespace", "x-forwarded-host": "other.invalid" }, "POST", "actual application bytes");
      expect(response.status).toBe(200);
      const result = JSON.parse(response.data) as { path: string; method: string; headers: Record<string, string>; body: string };
      expect(result.path).toBe("/absolute/spa/path?q=fixture"); expect(result.method).toBe("POST"); expect(result.body).toBe("actual application bytes"); expect(f.count()).toBe(1);
      expect(result.headers.authorization).toBeUndefined(); expect(result.headers["x-aevoren-session-id"]).toBeUndefined(); expect(result.headers["x-forwarded-host"]).toBeUndefined();
      expect(result.headers.host).toBe(`127.0.0.1:${f.ticket.port}`); expect(result.headers.origin).toBe(`http://127.0.0.1:${f.ticket.port}`);
      expect((await request(`${f.url}/v1/health`, { host: `${f.ticket.host}:8080` })).status).toBe(200);
      expect((await request(`${f.url}/absolute`, { host: `${f.ticket.host}:8080`, origin: "https://outside.invalid" })).status).toBe(403);
    });
  });

  it("coalesces concurrent same-id creation, rejects changed intent and never renews a revoked capability", async () => {
    await fixture(async f => {
      const input = { id: randomUUID(), registeredPortId: f.ticket.registeredPortId };
      const [first, second] = await Promise.all([f.proxy.open(input), f.proxy.open(input)]);
      expect(first).toEqual(second); expect(first.host).not.toBe(f.ticket.host);
      expect(first.host.split(".").every(label => label.length <= 63)).toBe(true);
      await expect(f.proxy.open({ ...input, registeredPortId: randomUUID() })).rejects.toThrow("WORKER_IDEMPOTENCY_CONFLICT");
      f.proxy.closeTicket(first.id);
      await expect(f.proxy.open(input)).rejects.toThrow("WORKER_PREVIEW_UNAVAILABLE");
      const never = randomUUID(); f.proxy.closeTicket(never);
      await expect(f.proxy.open({ ...input, id: never })).rejects.toThrow("WORKER_PREVIEW_UNAVAILABLE");
    });
  });

  it("relays real WebSocket messages and closes the old stream when ownership expires", async () => {
    await fixture(async f => {
      const socket = new WebSocket(f.url.replace("http:", "ws:") + "/absolute/websocket", { headers: { host: `${f.ticket.host}:8080`, origin: `http://${f.ticket.host}:8080` } });
      socket.on("error", () => undefined);
      try {
        await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
        const reply = new Promise<Buffer>(resolve => socket.once("message", data => resolve(Buffer.from(data as Buffer))));
        socket.send(Buffer.from([0, 255, 1, 128])); expect(await reply).toEqual(Buffer.from([0, 255, 1, 128]));
        f.alive(false);
        await expect.poll(() => socket.readyState).toBe(WebSocket.CLOSED);
        expect((await request(`${f.url}/any`, { host: `${f.ticket.host}:8080` })).status).toBe(503);
        f.alive(true);
        expect((await request(`${f.url}/any`, { host: `${f.ticket.host}:8080` })).status).toBe(503);
      } finally { socket.terminate(); }
    });
  });

  it("does not adopt an old capability after supervisor state is reopened", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aevoren-preview-restart-")), environmentId = randomUUID();
    const target: PreviewTarget = { registeredPortId: randomUUID(), processId: randomUUID(), port: 3_100, uid: 1_010 };
    let proxy = new PreviewProxy(join(directory, "preview.sqlite"), environmentId, "f".repeat(64), async () => target);
    try {
      const ticket = await proxy.open({ id: randomUUID(), registeredPortId: target.registeredPortId }); proxy.close();
      proxy = new PreviewProxy(join(directory, "preview.sqlite"), environmentId, "f".repeat(64), async () => target);
      expect((await proxy.get(ticket.id)).state).toBe("closed");
      await expect(proxy.open({ id: ticket.id, registeredPortId: target.registeredPortId })).rejects.toThrow("WORKER_PREVIEW_UNAVAILABLE");
    } finally { proxy.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
