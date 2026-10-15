import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BROWSER_WORKER_VERSION } from "@shared/browser-contracts";
import { AppRepository } from "./database";
import { BrowserService } from "./browser-service";
import { EnvironmentService } from "./environment-service";
import { DemonstrationService } from "./demonstration-service";
import { LibraryService } from "./library-service";
async function fixture(work: (value: { service: DemonstrationService; browser: BrowserService; repository: AppRepository; scope: { sessionId: string; executorBotId: string }; setWorkerVersion(value: string): void; holdStatus(): Promise<void>; releaseStatus(): void; calls: string[] }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "aevoren-demo-bridge-")), repository = new AppRepository(join(root, "app.sqlite")), actor = repository.createBot(), scope = { sessionId: actor.session.id, executorBotId: actor.bot.id };
  const env = repository.environments.ensure(scope, { workerVersion: "1.2.0", imageDigest: `sha256:${"b".repeat(64)}`, imageRef: "fixture", platform: "linux/arm64" }), session = repository.browsers.ensure(scope, { environmentId: env.id }); const token = "a".repeat(64), bootId = randomUUID(), calls: string[] = [];
  let version = BROWSER_WORKER_VERSION, hold = false, entered!: () => void, released!: () => void; const barrier = new Promise<void>(resolve => { entered = resolve; }); let pending = Promise.resolve();
  const server = createServer(async (request, response) => {
    expect(request.headers.authorization).toBe(`Bearer ${token}`); calls.push(request.url!); response.setHeader("content-type", "application/json");
    if (request.url === "/v1/health") { response.end(JSON.stringify({ environmentId: env.id, browserSessionId: session.id, bootId, protocolVersion: 1, workerVersion: version, capabilities: version === BROWSER_WORKER_VERSION ? ["demonstration"] : ["browser"], control: { owner: "user", controlEpoch: 2, observedEpoch: null, connectionState: "connected" } })); return; }
    if (request.url === "/v1/demonstrations/status") { if (hold) { entered(); await pending; } response.end("null"); return; } response.writeHead(404).end();
  }); server.listen(0, "127.0.0.1"); await once(server, "listening"); repository.browsers.updateConnection(scope, { workerPort: (server.address() as { port: number }).port, encryptedToken: token, workerVersion: version });
  const codec = { isAvailable: () => true, encrypt: (v: string) => v, decrypt: (v: string) => v }, environment = new EnvironmentService(repository.environments, codec, root), browser = new BrowserService(repository, codec, root, join(root, "media"), environment), service = new DemonstrationService(repository, browser, new LibraryService(repository, join(root, "blobs")));
  try { await work({ service, browser, repository, scope, calls, setWorkerVersion(value) { version = value; repository.browsers.updateConnection(scope, { workerVersion: value }); }, holdStatus() { hold = true; pending = new Promise<void>(resolve => { released = resolve; }); return barrier; }, releaseStatus() { released?.(); } }); }
  finally { released?.(); await browser.shutdown(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); repository.close(); rmSync(root, { recursive: true, force: true }); }
}
describe("authenticated demonstration host bridge", () => {
  it("uses the bound local resource and reports an old image without starting or rebuilding it", async () => fixture(async f => { expect(await f.service.status(f.scope)).toBe(null); f.setWorkerVersion("1.0.0"); await expect(f.service.status(f.scope)).rejects.toMatchObject({ code: "DEMONSTRATION_UNSUPPORTED" }); expect(f.calls.filter(path => path.startsWith("/v1/demonstrations"))).toHaveLength(1); }));
  it("aborts and drains pending capture metadata before shutdown closes host SQLite", async () => fixture(async f => {
    const entered = f.holdStatus(), pending = f.service.status(f.scope); const rejected = expect(pending).rejects.toBeDefined(); await entered; await f.browser.shutdown(); await rejected; f.releaseStatus(); await expect(f.service.status(f.scope)).rejects.toMatchObject({ code: "BROWSER_UNAVAILABLE" }); expect(f.repository.demonstrations.list(f.scope)).toEqual([]);
  }));
});
