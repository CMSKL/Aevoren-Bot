import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventHttpServer } from "./event-http-server";
import type { EventService } from "./event-service";

const owned: Server[] = [];
afterEach(async () => { for (const server of owned.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
describe("one owned application Webhook listener", () => {
  it("keeps the pending real listener owned until internal stop has awaited startup", async () => {
    const host = new EventHttpServer({} as EventService);
    const starting = host.start();
    void starting.catch(() => {});
    const socketServer = Reflect.get(host, "server") as Server;
    owned.push(socketServer);
    const stopping = host.stop();
    void stopping.catch(() => {});
    // A stop cannot orphan a listen still in progress. This reference owns the actual loopback Server.
    expect(Reflect.get(host, "server")).toBe(socketServer);
    await Promise.all([starting, stopping]);
    expect(host.snapshot().listening).toBe(false);
    expect(socketServer.listening).toBe(false);
  });
  it("fences UI and AI controls with one revision and a fixed stop port", async () => {
    const host = new EventHttpServer({} as EventService), first = host.snapshot();
    const starting = host.startControlled({ expectedRevision: first.revision, port: 0 });
    const socketServer = Reflect.get(host, "server") as Server; owned.push(socketServer);
    expect(host.snapshot()).toMatchObject({ busy: true, listening: false });
    expect(() => host.startControlled({ expectedRevision: host.snapshot().revision, port: 0 })).toThrowError(expect.objectContaining({ code: "EVENT_VERSION_CONFLICT" }));
    expect(() => host.stopControlled({ expectedRevision: host.snapshot().revision, port: 12345 })).toThrowError(expect.objectContaining({ code: "EVENT_VERSION_CONFLICT" }));
    const live = await starting;
    expect(live).toMatchObject({ busy: false, listening: true, host: "127.0.0.1" });
    expect(live.port).toBeGreaterThan(0); expect(live.revision).not.toBe(first.revision);
    expect(() => host.stopControlled({ expectedRevision: live.revision, port: live.port! === 65535 ? 65534 : live.port! + 1 })).toThrowError(expect.objectContaining({ code: "EVENT_VERSION_CONFLICT" }));
    const stopped = await host.stopControlled({ expectedRevision: live.revision, port: live.port! });
    expect(stopped).toMatchObject({ busy: false, listening: false, port: null });
    expect(() => host.startControlled({ expectedRevision: first.revision, port: live.port! })).toThrowError(expect.objectContaining({ code: "EVENT_VERSION_CONFLICT" }));
    expect(new EventHttpServer({} as EventService).snapshot().revision).not.toBe(stopped.revision);
  });

  it("rechecks the actor after real bind and closes only the newly owned listener on cancellation", async () => {
    const host = new EventHttpServer({} as EventService), controller = new AbortController(), guard = vi.fn();
    const start = host.startControlled({ expectedRevision: host.snapshot().revision, port: 0 }, { signal: controller.signal, assertCurrent: guard });
    const socketServer = Reflect.get(host, "server") as Server; owned.push(socketServer);
    socketServer.once("listening", () => controller.abort());
    await expect(start).rejects.toThrow();
    expect(guard).toHaveBeenCalledTimes(2);
    expect(socketServer.listening).toBe(false); expect(host.snapshot()).toMatchObject({ listening: false, busy: false, port: null });
    const revoked = new EventHttpServer({} as EventService); let allowed = true;
    const pending = revoked.startControlled({ expectedRevision: revoked.snapshot().revision, port: 0 }, { assertCurrent: () => { if (!allowed) throw Error("actor no longer admitted"); } });
    const second = Reflect.get(revoked, "server") as Server; owned.push(second); second.once("listening", () => { allowed = false; });
    await expect(pending).rejects.toThrow("actor no longer admitted"); expect(second.listening).toBe(false);
  });

  it("cleans up its owned start when publishing live state synchronously cancels the task", async () => {
    const controller = new AbortController();
    const host: EventHttpServer = new EventHttpServer({} as EventService, () => { if (host.snapshot().listening) controller.abort(); });
    const start = host.startControlled({ expectedRevision: host.snapshot().revision, port: 0 }, { signal: controller.signal, assertCurrent: () => {} });
    const server = Reflect.get(host, "server") as Server; owned.push(server);
    await expect(start).rejects.toThrow();
    expect(server.listening).toBe(false); expect(host.snapshot()).toMatchObject({ listening: false, busy: false });
  });

  it("cleans up a failed state notification before committing any result", async () => {
    const complete = vi.fn();
    const host: EventHttpServer = new EventHttpServer({} as EventService, () => { if (host.snapshot().listening) throw Error("controlled notification failure"); });
    const pending = host.startControlled({ expectedRevision: host.snapshot().revision, port: 0 }, undefined, complete);
    const server = Reflect.get(host, "server") as Server; owned.push(server);
    await expect(pending).rejects.toThrow("controlled notification failure"); expect(complete).not.toHaveBeenCalled(); expect(server.listening).toBe(false); expect(host.snapshot()).toMatchObject({ listening: false, busy: false });
  });

  it("does not close a foreign occupied port and consumes the rejected attempt revision", async () => {
    const foreign = new EventHttpServer({} as EventService), occupied = await foreign.start(); owned.push(Reflect.get(foreign, "server") as Server);
    const host = new EventHttpServer({} as EventService), initial = host.snapshot();
    await expect(host.startControlled({ expectedRevision: initial.revision, port: occupied.port! })).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(foreign.snapshot().listening).toBe(true); expect(host.snapshot()).toMatchObject({ listening: false, busy: false, port: null }); expect(host.snapshot().revision).not.toBe(initial.revision);
    expect(() => host.startControlled({ expectedRevision: initial.revision, port: occupied.port! })).toThrowError(expect.objectContaining({ code: "EVENT_VERSION_CONFLICT" }));
    await foreign.shutdown();
  });

  it("awaits pending startup during shutdown and never resurrects an unknown old revision", async () => {
    const host = new EventHttpServer({} as EventService), initial = host.snapshot();
    const start = host.startControlled({ expectedRevision: initial.revision, port: 0 });
    const socketServer = Reflect.get(host, "server") as Server; owned.push(socketServer);
    const closing = host.shutdown(); await Promise.all([start, closing]);
    expect(host.snapshot()).toMatchObject({ listening: false, busy: false }); expect(socketServer.listening).toBe(false);
    await expect(host.start()).rejects.toMatchObject({ code: "EVENT_STOPPED" });
    expect(() => host.startControlled({ expectedRevision: initial.revision, port: 12345 })).toThrowError(expect.objectContaining({ code: "EVENT_STOPPED" }));
  });

});
