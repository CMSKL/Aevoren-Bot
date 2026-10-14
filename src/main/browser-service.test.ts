import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRepository } from "./database";
import { BrowserService } from "./browser-service";
import { BrowserDockerDriver } from "./browser-docker-driver";
import { DockerDriver } from "./docker-driver";
import { EnvironmentService } from "./environment-service";
import { ExecutionWorkerClient } from "./execution-worker-client";
import type { BrowserPage, BrowserScope, BrowserSession, BrowserWorkerControl } from "@shared/browser-contracts";

type Fixture = { repository: AppRepository; service: BrowserService; environments: EnvironmentService; driver: BrowserDockerDriver; scope: BrowserScope; browser: BrowserSession; page: BrowserPage; control: BrowserWorkerControl;
  calls: Array<{ path: string; body: Record<string, unknown> }>; changed: ReturnType<typeof vi.fn>; root: string; server: Server; executionServers?: Server[]; readonly inputCount: number; holdFrame(fn: () => Promise<void>): void };
const fixtures: Fixture[] = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6iFAAAAAASUVORK5CYII=", "base64");
async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "aevoren-browser-host-boundary-")), repository = new AppRepository(join(root, "app.sqlite"));
  const actor = repository.createBot(), scope = { sessionId: actor.session.id, executorBotId: actor.bot.id };
  const env = repository.environments.ensure(scope, { workerVersion: "1.0.0", imageRef: "fixture", imageDigest: `sha256:${"a".repeat(64)}`, platform: "linux/arm64" });
  repository.environments.update(scope, env.version, { state: "running" });
  const browser = repository.browsers.ensure(scope, { environmentId: env.id });
  const bootId = randomUUID(), token = "b".repeat(64), control = { owner: "ai" as "ai" | "user", controlEpoch: 1, observedEpoch: null as number | null, connectionState: "disconnected" as const };
  const now = new Date().toISOString();
  const page = { id: randomUUID(), browserSessionId: browser.id, url: "https://fixture.test", title: "Transport fixture", documentVersion: 1, createdAt: now, updatedAt: now };
  const extraPages: BrowserPage[] = [];
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [], completed = new Map<string, unknown>();
  let inputCount = 0, timestamps = 0;
  let holdFrame: (() => Promise<void>) | undefined;
  const server = createServer(async (request, response) => {
    expect(request.headers.authorization).toBe(`Bearer ${token}`);
    const path = request.url!.split("?")[0]!;
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
    calls.push({ path, body }); response.setHeader("content-type", "application/json");
    const answer = (value: unknown): void => { response.end(JSON.stringify(value)); };
    if (path === "/v1/health") { answer({ environmentId: env.id, browserSessionId: browser.id, bootId, protocolVersion: 1, workerVersion: "1.0.0", capabilities: ["browser", "images"], control }); return; }
    if (path === "/v1/browser/pages") {
      if (request.method === "POST") { const created = { ...page, id: randomUUID(), url: String(body.url), createdAt: new Date().toISOString() }; extraPages.push(created); answer(created); }
      else answer([{ ...page, updatedAt: new Date(Date.now() + ++timestamps).toISOString() }, ...extraPages]);
      return;
    }
    if (path === "/v1/computer/takeover" || path === "/v1/computer/return") { control.owner = path.endsWith("return") ? "ai" : "user"; control.controlEpoch++; control.observedEpoch = null; answer(control); return; }
    if (path === "/v1/computer/screenshot") {
      await holdFrame?.();
      answer({ browserSessionId: browser.id, pageId: page.id, observationId: randomUUID(), controlEpoch: body.expectedEpoch, documentVersion: page.documentVersion,
        dataBase64: png.toString("base64"), mimeType: "image/png", size: png.length, sha256: createHash("sha256").update(png).digest("hex"), width: 1, height: 1, capturedAt: now }); return;
    }
    if (path.endsWith("/click")) {
      const id = String(body.operationId); if (completed.has(id)) { answer(completed.get(id)); return; }
      if (body.documentVersion !== page.documentVersion) { response.writeHead(409); answer({ error: { code: "BROWSER_OBSERVATION_STALE" } }); return; }
      inputCount++; page.documentVersion++; const result = { ...page }; completed.set(id, result); answer(result); return;
    }
    response.writeHead(404); answer({ error: { code: "BROWSER_ROUTE_NOT_FOUND" } });
  });
  await new Promise<void>(accept => server.listen(0, "127.0.0.1", accept));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture bind failed");
  repository.browsers.updateConnection(scope, { encryptedToken: token, workerPort: address.port, containerId: "fixture-container", workerVersion: "1.0.0", imageDigest: `sha256:${"c".repeat(64)}` });
  repository.browsers.syncControl(scope, control, bootId); repository.browsers.update(scope, repository.browsers.get(scope)!.version, { state: "running" });
  repository.browsers.upsertPage(scope, page, 1); repository.browsers.update(scope, repository.browsers.get(scope)!.version, { activePageId: page.id });
  const codec = { isAvailable: () => true, encrypt: (value: string) => value, decrypt: (value: string) => value }, driver = new BrowserDockerDriver(), changed = vi.fn();
  vi.spyOn(driver, "inspectBrowser").mockResolvedValue({ id: "fixture-container", name: "fixture", imageId: `sha256:${"c".repeat(64)}`, state: "running", workerPort: address.port, oomKilled: false });
  const environments = new EnvironmentService(repository.environments, codec, root);
  const service = new BrowserService(repository, codec, root, join(root, "media"), environments, changed, driver);
  const value = { repository, service, environments, driver, scope, browser, page, control, calls, changed, root, server, get inputCount() { return inputCount; }, holdFrame(fn: () => Promise<void>) { holdFrame = fn; } };
  fixtures.push(value); return value;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) { await f.service.shutdown(); for (const server of [f.server, ...f.executionServers ?? []]) { server.closeAllConnections(); await new Promise<void>(accept => server.close(() => accept())); } f.repository.close(); rmSync(f.root, { recursive: true, force: true }); }
  vi.restoreAllMocks();
});

async function executionTransport(f: Fixture) {
  const environment = f.repository.environments.get(f.scope)!, bootId = randomUUID(), token = "a".repeat(64);
  let port = 0, state = "running", gate: (() => Promise<void>) | undefined;
  const listen = async () => {
    const server = createServer(async (request, response) => {
      expect(request.headers.authorization).toBe(`Bearer ${token}`); response.setHeader("content-type", "application/json");
      if (request.url === "/v1/health") { await gate?.(); response.end(JSON.stringify({ environmentId: environment.id, bootId, protocolVersion: 1, workerVersion: "1.0.0", capabilities: ["execution", "files"] })); return; }
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString()) as { path: string; content: string };
      response.end(JSON.stringify({ path: input.path, size: Buffer.byteLength(input.content), sha256: createHash("sha256").update(input.content).digest("hex") }));
    });
    await new Promise<void>(accept => server.listen(0, "127.0.0.1", accept));
    port = (server.address() as { port: number }).port; (f.executionServers ??= []).push(server); return server;
  };
  const server = await listen();
  f.repository.environments.update(f.scope, environment.version, { containerId: "fixture-execution", encryptedToken: token, workerPort: port, bootId });
  const runner = vi.fn(async (args: string[]) => {
    if (args.join(" ") === "context show") return { stdout: "fixture-local", stderr: "" };
    if (args[0] === "context") return { stdout: JSON.stringify("unix:///fixture-docker.sock"), stderr: "" };
    if (args.includes("stop")) { state = "exited"; return { stdout: "", stderr: "" }; }
    expect(args).toContain(`aevoren-execution-${environment.id}`);
    return { stdout: JSON.stringify({ Id: "fixture-execution", Image: environment.imageDigest,
      Config: { Labels: { "io.aevoren.role": "execution-environment", "io.aevoren.environment": environment.id } },
      State: { Status: state, OOMKilled: false }, HostConfig: { ReadonlyRootfs: true, CapDrop: ["ALL"] },
      Mounts: [{ Type: "volume", Name: `aevoren-work-${environment.id}`, Destination: "/workspace" }, { Type: "volume", Name: `aevoren-state-${environment.id}`, Destination: "/var/lib/aevoren" }],
      NetworkSettings: { Ports: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: String(port) }] } } }), stderr: "" };
  });
  const codec = { isAvailable: () => true, encrypt: (value: string) => value, decrypt: (value: string) => value };
  const environments = new EnvironmentService(f.repository.environments, codec, f.root, () => undefined, new DockerDriver(runner));
  const service = new BrowserService(f.repository, codec, f.root, join(f.root, "media"), environments, () => undefined, f.driver);
  return { environments, service, server, listen, runner, token, environmentId: environment.id, get port() { return port; }, holdHealth(fn: () => Promise<void>) { gate = fn; } };
}

describe("host browser permission and pixel transport boundaries (controlled HTTP, not Chromium execution)", () => {
  it("stores actual bytes, gates the ephemeral image immediately on takeover and requires fresh AI input after return", async () => {
    const f = await fixture();
    const shot = await f.service.computerScreenshot({ ...f.scope, expectedEpoch: 1 }, { actor: "ai" });
    const attachment = await f.service.imageAttachment(f.scope, shot.media.id, 1);
    expect(Buffer.from(attachment.dataBase64, "base64")).toEqual(png); expect(attachment.isAuthorized()).toBe(true);
    const user = await f.service.takeover({ ...f.scope, clientNonce: randomUUID(), expectedEpoch: 1 });
    expect(user).toMatchObject({ owner: "user", epoch: 2 }); expect(attachment.isAuthorized()).toBe(false);
    const count = f.calls.length;
    await expect(f.service.computerScreenshot({ ...f.scope, expectedEpoch: 2 }, { actor: "ai" })).rejects.toMatchObject({ code: "COMPUTER_USER_CONTROLLED" });
    expect(f.calls).toHaveLength(count);
    const returned = await f.service.returnControl({ ...f.scope, clientNonce: randomUUID(), expectedEpoch: 2 });
    expect(returned).toMatchObject({ owner: "ai", epoch: 3, observedEpoch: null });
    await f.service.computerScreenshot({ ...f.scope, expectedEpoch: 3 });
    expect(f.repository.browsers.view(f.scope)?.observedEpoch).toBeNull();
    await expect(f.service.navigate({ ...f.scope, clientNonce: randomUUID(), expectedEpoch: 3, pageId: f.page.id, url: "https://fixture.test/changed" }, { actor: "ai" })).rejects.toMatchObject({ code: "BROWSER_OBSERVATION_REQUIRED" });
    await expect(f.service.takeover({ ...f.scope, clientNonce: randomUUID(), expectedEpoch: 3 }, { actor: "ai" })).rejects.toMatchObject({ code: "COMPUTER_USER_CONTROLLED" });
  });
  it("blocks a late screenshot return after takeover without publishing its media", async () => {
    const f = await fixture(); let ready!: () => void, release!: () => void;
    const entered = new Promise<void>(accept => { ready = accept; }), blocked = new Promise<void>(accept => { release = accept; });
    f.holdFrame(async () => { ready(); await blocked; });
    const pending = f.service.computerScreenshot({ ...f.scope, expectedEpoch: 1 }, { actor: "ai" }).catch(error => error as Error);
    await entered; await f.service.takeover({ ...f.scope, clientNonce: randomUUID(), expectedEpoch: 1 }); release();
    expect(await pending).toMatchObject({ code: "COMPUTER_CONTROL_CHANGED" });
  });
  it("reuses a completed nonce when the document already changed, without a second input", async () => {
    const f = await fixture(), shot = await f.service.computerScreenshot({ ...f.scope, expectedEpoch: 1 }, { actor: "ai" });
    const input = { ...f.scope, clientNonce: randomUUID(), expectedEpoch: 1, pageId: f.page.id, observationId: shot.frame.observationId, documentVersion: 1, ref: "element_fixture" };
    const first = await f.service.click(input, { actor: "ai" }), repeated = await f.service.click(input, { actor: "ai" });
    expect(repeated).toEqual(first); expect(f.inputCount).toBe(1);
    await expect(f.service.click({ ...input, clientNonce: randomUUID() }, { actor: "ai" })).rejects.toMatchObject({ code: "BROWSER_OBSERVATION_REQUIRED" });
    expect(f.calls.filter(call => call.path.endsWith("/click")).every(call => !["clientNonce", "sessionId", "executorBotId", "runtimeRunId"].some(key => key in call.body))).toBe(true);
  });
  it("does not increment versions or emit feedback events for repeated healthy getters and UI frames", async () => {
    const f = await fixture(), before = f.repository.browsers.get(f.scope)!.version;
    await f.service.get(f.scope); await f.service.get(f.scope);
    await f.service.computerScreenshot({ ...f.scope, expectedEpoch: 1 }); await f.service.computerScreenshot({ ...f.scope, expectedEpoch: 1 });
    expect(f.repository.browsers.get(f.scope)!.version).toBe(before); expect(f.changed).not.toHaveBeenCalled();
  });
  it("returns already-running metadata to AI without disturbing human ownership or requesting private pages", async () => {
    const f = await fixture(); await f.service.takeover({ ...f.scope, clientNonce: randomUUID(), expectedEpoch: 1 });
    vi.spyOn(f.environments, "reconcileBinding").mockResolvedValue(f.repository.environments.get(f.scope)!);
    const before = f.repository.browsers.get(f.scope), pages = f.calls.filter(call => call.path === "/v1/browser/pages").length;
    expect(await f.service.start({ ...f.scope, clientNonce: randomUUID() }, { actor: "ai" })).toEqual(before);
    expect(f.repository.browsers.view(f.scope)).toMatchObject({ owner: "user", epoch: 2 });
    expect(f.calls.filter(call => call.path === "/v1/browser/pages")).toHaveLength(pages);
    expect(f.repository.browsers.get(f.scope)?.state).toBe("running");
  });
  it("validates the desktop's actual scoped page rather than a stale UI-selected page id", async () => {
    const f = await fixture(), shot = await f.service.computerScreenshot({ ...f.scope, expectedEpoch: 1, pageId: randomUUID() });
    expect(shot.frame.pageId).toBe(f.page.id); expect(shot.media.pageId).toBe(f.page.id);
  });
  it("reuses the same preview intent and capability without creating another page or metadata row", async () => {
    const f = await fixture(); await f.service.computerScreenshot({ ...f.scope, expectedEpoch: 1 }, { actor: "ai" });
    const session = f.repository.environments.createSession(f.scope, null), job = f.repository.environments.createExecution(f.scope,
      { executionSessionId: session.id, clientNonce: randomUUID(), kind: "background", command: "preview metadata fixture only" }).execution;
    f.repository.environments.updateExecution(f.scope, job.id, job.version, { state: "running" });
    const port = f.repository.environments.upsertPort(f.scope, { processId: job.id, port: 8123, state: "listening" });
    vi.spyOn(f.environments, "listPorts").mockResolvedValue([port]);
    vi.spyOn(f.environments, "createPreview").mockImplementation(async (_scope, id, registeredPortId) => ({ id, registeredPortId, processId: job.id, port: port.port,
      host: `${"a".repeat(32)}.${"b".repeat(32)}.aevoren-preview-${job.environmentId}.internal`, expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    const input = { ...f.scope, expectedEpoch: 1, clientNonce: randomUUID(), registeredPortId: port.id };
    const first = await f.service.previewOpen(input, { actor: "ai" }), repeated = await f.service.previewOpen(input, { actor: "ai" });
    expect(repeated).toEqual(first); expect(f.repository.browsers.listPreviews(f.scope, 1)).toHaveLength(1);
    expect(f.calls.filter(call => call.path === "/v1/browser/pages" && "operationId" in call.body)).toHaveLength(1);
  });
  it("retains pinned configuration on sleep but clears it after an explicit remove/rebuild", async () => {
    const f = await fixture(); vi.spyOn(f.driver, "stopBrowser").mockResolvedValue();
    const original = f.repository.browsers.getInternal(f.scope)!;
    await f.service.release(f.scope, false); expect(f.repository.browsers.getInternal(f.scope)?.imageDigest).toBe(original.imageDigest);
    await f.service.release(f.scope, true);
    expect(f.repository.browsers.getInternal(f.scope)).toMatchObject({ id: original.id, imageDigest: null, imageRef: null, workerVersion: null, platform: null, workerPort: null, containerId: null, encryptedToken: original.encryptedToken });
  });
  it("never replays an old successful return after a new takeover", async () => {
    const f = await fixture(); await f.service.takeover({ ...f.scope, clientNonce: randomUUID(), expectedEpoch: 1 });
    const previous = { ...f.scope, clientNonce: randomUUID(), expectedEpoch: 2 };
    await f.service.returnControl(previous); await f.service.takeover({ ...f.scope, clientNonce: randomUUID(), expectedEpoch: 3 });
    const count = f.calls.filter(call => call.path === "/v1/computer/return").length;
    await expect(f.service.returnControl(previous)).rejects.toMatchObject({ code: "COMPUTER_CONTROL_CHANGED" });
    expect(f.calls.filter(call => call.path === "/v1/computer/return")).toHaveLength(count);
    expect(f.repository.browsers.view(f.scope)).toMatchObject({ owner: "user", epoch: 4 });
  });
  it("never replays an old successful takeover after an explicit return", async () => {
    const f = await fixture(), previous = { ...f.scope, clientNonce: randomUUID(), expectedEpoch: 1 };
    await f.service.takeover(previous); await f.service.returnControl({ ...f.scope, clientNonce: randomUUID(), expectedEpoch: 2 });
    const count = f.calls.filter(call => call.path === "/v1/computer/takeover").length;
    await expect(f.service.takeover(previous)).rejects.toMatchObject({ code: "COMPUTER_CONTROL_CHANGED" });
    expect(f.calls.filter(call => call.path === "/v1/computer/takeover")).toHaveLength(count);
    expect(f.repository.browsers.view(f.scope)).toMatchObject({ owner: "ai", epoch: 3 });
  });
  it("reconciles a Docker-verified remapped execution port before browser start succeeds, preserving background records and nonce replay", async () => {
    const f = await fixture(), transport = await executionTransport(f), oldPort = transport.port;
    await new ExecutionWorkerClient(oldPort, transport.token, transport.environmentId).health();
    const session = f.repository.environments.createSession(f.scope, null), nonce = randomUUID();
    const job = f.repository.environments.createExecution(f.scope, { executionSessionId: session.id, clientNonce: nonce, kind: "background", command: "background metadata fixture" }).execution;
    f.repository.environments.updateExecution(f.scope, job.id, job.version, { state: "running" });
    f.repository.environments.appendLogs(f.scope, job.id, [{ seq: 1, executionId: job.id, stream: "stdout", text: "original background log", at: new Date().toISOString() }]);
    const original = f.repository.environments.getExecution(f.scope, job.id), logs = f.repository.environments.logs(f.scope, job.id);
    f.repository.browsers.update(f.scope, f.repository.browsers.get(f.scope)!.version, { state: "stopped" });
    vi.mocked(f.driver.inspectBrowser).mockResolvedValueOnce(null);
    vi.spyOn(f.driver, "inspectBrowserImage").mockResolvedValue({ id: `sha256:${"c".repeat(64)}`, ref: "fixture", workerVersion: "1.0.0", platform: "linux/arm64", bundleSha256: "d".repeat(64) });
    const create = vi.spyOn(f.driver, "createBrowser").mockImplementation(async () => {
      await transport.listen(); transport.server.closeAllConnections(); await new Promise<void>(accept => transport.server.close(() => accept()));
      return (await f.driver.inspectBrowser(f.browser.id, transport.environmentId))!;
    });
    const input = { ...f.scope, clientNonce: randomUUID() };
    expect((await transport.service.start(input)).state).toBe("running");
    expect(transport.port).not.toBe(oldPort);
    expect(f.repository.environments.getInternal(f.scope)?.workerPort).toBe(transport.port);
    await expect(new ExecutionWorkerClient(oldPort, transport.token, transport.environmentId).health()).rejects.toMatchObject({ code: "WORKER_CONNECTION_FAILED" });
    await expect(transport.environments.writeFile({ ...f.scope, path: "after-attachment.txt", content: "actual controlled HTTP bytes" })).resolves.toMatchObject({ path: "after-attachment.txt" });
    const version = f.repository.environments.get(f.scope)!.version;
    await transport.service.start(input); expect(create).toHaveBeenCalledTimes(1);
    expect(f.repository.environments.get(f.scope)!.version).toBe(version);
    expect(f.repository.environments.findExecutionByNonce(f.scope, nonce)).toEqual(original);
    expect(f.repository.environments.logs(f.scope, job.id)).toEqual(logs);
    expect(transport.runner.mock.calls.every(([args]) => !["run", "start", "stop", "rm"].some(operation => args.includes(operation)))).toBe(true);
  });
  it("does not restore a stopped environment when its older reconciliation health response arrives", async () => {
    const f = await fixture(), transport = await executionTransport(f);
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(accept => { entered = accept; }), held = new Promise<void>(accept => { release = accept; });
    transport.holdHealth(async () => { entered(); await held; });
    const pending = transport.environments.reconcileBinding(f.scope).catch(error => error as Error);
    await waiting;
    try { await transport.environments.stop(f.scope); }
    finally { release(); }
    expect(await pending).toMatchObject({ code: "ENVIRONMENT_UNAVAILABLE" });
    expect(f.repository.environments.getInternal(f.scope)).toMatchObject({ state: "stopped", workerPort: null });
  });
});
