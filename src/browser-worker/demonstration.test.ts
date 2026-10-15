import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import WebSocket from "ws";
import { describe, expect, it } from "vitest";
import { BrowserWorker } from "./browser-worker";
import { createBrowserServer } from "./server";
async function fixture(work: (worker: BrowserWorker, directory: string) => Promise<void>) { const directory = await mkdtemp(join(tmpdir(), "aevoren-demo-worker-")); const worker = new BrowserWorker({ environmentId: randomUUID(), browserSessionId: randomUUID(), stateDirectory: directory, downloadsDirectory: directory }, { request: async <T>() => null as T, close: async () => undefined }); worker.acknowledgeControl(); try { await work(worker, directory); } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); } }
describe("demonstration viewer recording boundary", () => {
  it("requires human control and an actual viewer; records only forwarded current epoch traffic", async () => fixture(async worker => {
    const user = await worker.changeControl("user", { actor: "user", expectedEpoch: 1, operationId: randomUUID() }), id = randomUUID();
    expect(() => worker.demonstration({ action: "start", actor: "user", expectedEpoch: user.controlEpoch, id })).toThrow("DEMONSTRATION_VIEWER_REQUIRED");
    const received: Buffer[] = []; const tcp = createServer(socket => socket.on("data", bytes => received.push(Buffer.from(bytes)))); tcp.listen(0, "127.0.0.1"); await once(tcp, "listening");
    const token = "c".repeat(64), server = createBrowserServer(worker, token, (tcp.address() as { port: number }).port); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/v1/computer/vnc?epoch=${user.controlEpoch}`, { headers: { authorization: `Bearer ${token}` } });
    try {
      await once(ws, "open"); worker.demonstration({ action: "start", actor: "user", expectedEpoch: user.controlEpoch, id });
      const header = Buffer.from("RFB 003.008\n\x01\x01"), click = Buffer.from([5, 1, 0, 40, 0, 90]), text = Buffer.from([4, 1, 0, 0, 0, 0, 0, 115]);
      ws.send(header.subarray(0, 5)); ws.send(Buffer.concat([header.subarray(5), click, text]));
      await expect.poll(() => worker.demonstrations.status()?.eventCount).toBe(2); expect(Buffer.concat(received)).toEqual(Buffer.concat([header, click, text]));
      await expect(worker.perform("pages", { actor: "ai", expectedEpoch: user.controlEpoch })).rejects.toThrow("BROWSER_USER_CONTROL");
      ws.close(); await once(ws, "close"); await expect.poll(() => worker.demonstrations.status()?.state).toBe("interrupted");
      expect(worker.control().owner).toBe("user"); const snapshot = worker.demonstration({ action: "stop", actor: "user", expectedEpoch: user.controlEpoch, id }) as { events: unknown[] }; expect(snapshot.events).toEqual([{ kind: "pointer", x: 40, y: 90, buttons: 1 }, { kind: "redacted-text" }]);
    } finally { ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); await new Promise<void>(resolve => tcp.close(() => resolve())); }
  }));
  it("rejects starting on an unsupported viewer and requires a fresh connection", async () => fixture(async worker => {
    await worker.changeControl("user", { actor: "user", expectedEpoch: 1, operationId: randomUUID() }); worker.viewerConnected(); worker.viewerInputUnsupported();
    expect(() => worker.demonstration({ action: "start", actor: "user", expectedEpoch: 2, id: randomUUID() })).toThrow("DEMONSTRATION_INPUT_UNSUPPORTED");
    worker.viewerDisconnected(); worker.viewerConnected(); const id = randomUUID(); worker.demonstration({ action: "start", actor: "user", expectedEpoch: 2, id }); worker.viewerInputUnsupported();
    expect(worker.demonstrations.status()).toMatchObject({ state: "interrupted", reason: "unsupported-input" }); expect(worker.control().owner).toBe("user");
  }));
  it("seals epoch change and restart without restoring AI control, and caps capture events", async () => fixture(async (worker, directory) => {
    await worker.changeControl("user", { actor: "user", expectedEpoch: 1, operationId: randomUUID() }); worker.viewerConnected(); const id = randomUUID(); worker.demonstration({ action: "start", actor: "user", expectedEpoch: 2, id });
    for (let i = 0; i < 510; i++) worker.acceptedViewerInput(2, { kind: "pointer", x: i, y: 0, buttons: i % 2 }); expect(worker.demonstrations.status()).toMatchObject({ state: "interrupted", reason: "limit", eventCount: 500 });
    worker.demonstration({ action: "discard", actor: "user", expectedEpoch: 2, id }); const next = randomUUID(); worker.demonstration({ action: "start", actor: "user", expectedEpoch: 2, id: next });
    const returned = await worker.changeControl("ai", { actor: "user", expectedEpoch: 2, operationId: randomUUID() }); worker.acceptedViewerInput(2, { kind: "redacted-text" }); expect(worker.demonstrations.status()).toMatchObject({ state: "interrupted", reason: "control-changed", eventCount: 0 });
    worker.demonstration({ action: "stop", actor: "user", expectedEpoch: returned.controlEpoch, id: next });
    await worker.changeControl("user", { actor: "user", expectedEpoch: 3, operationId: randomUUID() }); worker.viewerConnected(); worker.demonstration({ action: "start", actor: "user", expectedEpoch: 4, id: randomUUID() });
    const reopened = new BrowserWorker({ ...worker.options, stateDirectory: directory }, { request: async <T>() => null as T, close: async () => undefined });
    try { expect(reopened.control().owner).toBe("user"); expect(reopened.demonstrations.status()).toMatchObject({ state: "interrupted", reason: "restart" }); } finally { await reopened.close(); }
  }));
});
