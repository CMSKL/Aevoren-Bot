import { createHash, randomUUID, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BrowserWorker } from "./browser-worker";
import { createBrowserServer } from "./server";
import type { EngineAction } from "./engine-protocol";
import { BrowserWorkerError } from "./worker-error";
import { readDownload } from "./download-reader";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(ready => { resolve = ready; });
  return { promise, resolve };
};
async function fixture(callback: (worker: BrowserWorker, directory: string) => Promise<void>, request: <T>(action: EngineAction, payload: object) => Promise<T>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "aevoren-browser-test-"));
  const worker = new BrowserWorker({ environmentId: randomUUID(), browserSessionId: randomUUID(), stateDirectory: directory, downloadsDirectory: directory }, { request, close: async () => undefined });
  worker.acknowledgeControl();
  try { await callback(worker, directory); }
  finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
}

describe("browser host lease boundary", () => {
  it("seals ownership before quiescence and rejects late frame bytes", async () => {
    const capture = deferred<unknown>(), drain = deferred<unknown>();
    await fixture(async worker => {
      let closed = 0;
      worker.setViewerCloser(() => closed++);
      const old = worker.perform("frame", { actor: "ai", expectedEpoch: 1 });
      const takeover = worker.changeControl("user", { actor: "user", expectedEpoch: 1, operationId: randomUUID() });
      expect(worker.control()).toMatchObject({ owner: "user", controlEpoch: 2 });
      expect(closed).toBe(1);
      expect(worker.canConnectViewer(2)).toBe(false);
      capture.resolve({ forbiddenPixels: "late" });
      await expect(old).rejects.toThrow("BROWSER_USER_CONTROL");
      drain.resolve(null);
      expect(await takeover).toMatchObject({ owner: "user", controlEpoch: 2 });
      expect(worker.canConnectViewer(2)).toBe(true);
      worker.viewerConnected(); worker.viewerDisconnected();
      expect(worker.control()).toMatchObject({ owner: "user", connectionState: "disconnected" });
      await expect(worker.perform("pages", { actor: "ai", expectedEpoch: 2 })).rejects.toThrow("BROWSER_USER_CONTROL");
    }, async <T>(action: EngineAction) => (action === "control" ? drain.promise : capture.promise) as Promise<T>);
  });

  it("does not enable a viewer or AI operations when engine quiescence fails", async () => {
    await fixture(async worker => {
      await expect(worker.changeControl("user", { actor: "user", expectedEpoch: 1, operationId: randomUUID() })).rejects.toThrow("BROWSER_OPERATION_TIMEOUT");
      expect(worker.control()).toMatchObject({ owner: "user", controlEpoch: 2 });
      expect(worker.canConnectViewer(2)).toBe(false);
    }, async () => { throw new BrowserWorkerError("BROWSER_OPERATION_TIMEOUT", 504); });
  });

  it("reuses a completed mutation but never repeats unknown work or accepts changed arguments", async () => {
    let called = 0;
    await fixture(async worker => {
      const input = { actor: "user", expectedEpoch: 1, operationId: randomUUID(), pageId: randomUUID() };
      expect(await worker.perform("close-page", input, true)).toEqual({ closed: true });
      expect(await worker.perform("close-page", input, true)).toEqual({ closed: true });
      expect(called).toBe(1);
      await expect(worker.perform("close-page", { ...input, pageId: randomUUID() }, true)).rejects.toThrow("BROWSER_OPERATION_CONFLICT");
      const failed = { ...input, operationId: randomUUID(), fail: true };
      await expect(worker.perform("close-page", failed, true)).rejects.toThrow("fixture stopped");
      await expect(worker.perform("close-page", failed, true)).rejects.toThrow("BROWSER_OPERATION_UNKNOWN");
      expect(called).toBe(2);
    }, async <T>(_action: EngineAction, input: object) => { called++; if ("fail" in input) throw new Error("fixture stopped"); return { closed: true } as T; });
  });

  it("reads only verified owned download bytes and rejects tampering and symlinks", async () => {
    await fixture(async (worker, directory) => {
      const id = randomUUID(), pageId = randomUUID(), bytes = Buffer.from([0, 1, 255, 10]);
      worker.store.addDownload({ id, pageId, name: "fixture.bin", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), createdAt: new Date().toISOString() });
      await writeFile(join(directory, id), bytes);
      expect(Buffer.from((await readDownload(directory, worker.store.download(id))).toString("base64"), "base64")).toEqual(bytes);
      await writeFile(join(directory, id), Buffer.from([0, 1, 254, 10]));
      await expect(readDownload(directory, worker.store.download(id))).rejects.toThrow("BROWSER_DOWNLOAD_INVALID");
      await rm(join(directory, id));
      await writeFile(join(directory, "private-fixture"), bytes);
      await symlink(join(directory, "private-fixture"), join(directory, id));
      await expect(readDownload(directory, worker.store.download(id))).rejects.toThrow("BROWSER_DOWNLOAD_INVALID");
      await expect(readDownload(directory, { ...worker.store.download(id), id: "../private-fixture" })).rejects.toThrow();
    }, async <T>() => null as T);
  });

  it("requires host authentication and strips no unrecognized scope or actor fields", async () => {
    await fixture(async worker => {
      const token = randomBytes(32).toString("hex"), server = createBrowserServer(worker, token);
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fixture bind failed");
      const url = `http://127.0.0.1:${address.port}`;
      try {
        expect((await fetch(`${url}/v1/health`)).status).toBe(401);
        const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
        expect((await fetch(`${url}/v1/health`, { headers: { ...headers, origin: "https://untrusted.invalid" } })).status).toBe(401);
        const health = await (await fetch(`${url}/v1/health`, { headers })).json();
        expect(JSON.stringify(health)).not.toContain("url");
        const response = await fetch(`${url}/v1/browser/pages`, { method: "POST", headers, body: JSON.stringify({ actor: "user", expectedEpoch: 1, operationId: randomUUID(), sessionId: randomUUID() }) });
        expect(response.status).toBe(400);
        expect((await response.json() as { error: { code: string } }).error.code).toBe("BROWSER_INVALID_REQUEST");
      } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    }, async <T>() => [] as T);
  });
});
