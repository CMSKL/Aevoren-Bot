import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppRepository } from "./database";
import { EnvironmentService } from "./environment-service";
import { BrowserService } from "./browser-service";
import { BrowserDockerDriver } from "./browser-docker-driver";
import type { BrowserScope } from "@shared/browser-contracts";
import type { ProductToolRequest, RuntimeRun } from "@shared/contracts";
import { WorkspaceService } from "./workspace-service";
import { WorkspaceToolExecutor } from "./workspace-tool-executor";
import { WorkspaceToolCoordinator } from "./workspace-tool-coordinator";
import { SendWorker } from "./send-worker";
import { RoomCoordinator } from "./room-coordinator";
import { GeneralSettingsService } from "./settings";
import { ProductOperationService } from "./product-operation-service";
import type { ProductDependencies } from "./product-handlers";
import { imageAwareChatMessages } from "./model-image";
import { ExecutionWorkerClient } from "./execution-worker-client";

vi.mock("electron", () => ({ clipboard: { writeText: vi.fn() } }));

const dockerCommand = promisify(execFile), enabled = process.env.AEVOREN_BROWSER_DOCKER_TEST === "1";
describe.skipIf(!enabled)("host browser service with real local Docker and Chromium", () => {
  let root: string, repository: AppRepository, environments: EnvironmentService, browser: BrowserService;
  const driver = new BrowserDockerDriver(), changed: unknown[] = [];
  const startupTrace: { route: string; base: string; code: string }[] = [];
  beforeAll(async () => {
    if (process.env.AEVOREN_BROWSER_STARTUP_DIAGNOSTICS === "1") {
      const request = ExecutionWorkerClient.prototype.request;
      vi.spyOn(ExecutionWorkerClient.prototype, "request").mockImplementation(async function<T>(this: ExecutionWorkerClient, ...args: Parameters<ExecutionWorkerClient["request"]>): Promise<T> {
        const route = args[0].split("?")[0]!.replace(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/g, ":id"), base = (this as unknown as { base: string }).base;
        try { const result = await request.apply(this, args); startupTrace.push({ route, base, code: "OK" }); return result as T; }
        catch (error) {
          const code = (error as { code?: string }).code ?? (error as Error).name; startupTrace.push({ route, base, code });
          if (route === "/v1/files/content") {
            const saved = repository.environments.listInternal().find(item => item.workerPort === Number(new URL(base).port));
            const actual = saved ? await driver.inspect(saved.id).catch(() => null) : null;
            const health = async (port: number | null | undefined): Promise<string | null> => {
              if (!saved?.encryptedToken || !port) return null;
              try { await new ExecutionWorkerClient(port, Buffer.from(saved.encryptedToken, "base64").toString(), saved.id).health(); return "OK"; }
              catch (failure) { return (failure as { code?: string }).code ?? (failure as Error).name; }
            };
            const oldHealth = await health(saved?.workerPort), currentHealth = await health(actual?.workerPort);
            console.error("Execution connection diagnostic", JSON.stringify({ route, base, code, environmentId: saved?.id,
              savedPort: saved?.workerPort, inspectedPort: actual?.workerPort, oldHealth, currentHealth, containerState: actual?.state, oomKilled: actual?.oomKilled }));
          }
          throw error;
        }
        finally { if (startupTrace.length > 20) startupTrace.shift(); }
      });
    }
    root = mkdtempSync(join(tmpdir(), "aevoren-host-browser-docker-")); repository = new AppRepository(join(root, "app.sqlite"));
    const codec = { isAvailable: () => true, encrypt: (value: string) => Buffer.from(value).toString("base64"), decrypt: (value: string) => Buffer.from(value, "base64").toString() };
    environments = new EnvironmentService(repository.environments, codec, join(process.cwd(), "out", "worker")); await environments.initialize();
    browser = new BrowserService(repository, codec, join(process.cwd(), "out", "browser-worker"), join(root, "media"), environments, event => changed.push(event), driver);
  }, 900_000);
  afterAll(async () => {
    if (!repository) return;
    await browser.shutdown();
    for (const item of repository.browsers.listInternal()) {
      await driver.stopBrowser(item.id, item.environmentId, true).catch(() => undefined);
      await dockerCommand("docker", ["volume", "rm", ...["state", "profile", "downloads"].map(kind => `aevoren-browser-${kind}-${item.id}`)]).catch(() => undefined);
    }
    await environments.shutdown();
    for (const item of repository.environments.listInternal()) {
      await driver.stop(item.id).catch(() => undefined); await driver.remove(item.id).catch(() => undefined);
      await dockerCommand("docker", ["network", "rm", `aevoren-scope-${item.id}`]).catch(() => undefined);
      await dockerCommand("docker", ["volume", "rm", `aevoren-work-${item.id}`, `aevoren-state-${item.id}`]).catch(() => undefined);
    }
    repository.close(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks();
  }, 120_000);
  async function start(): Promise<BrowserScope> {
    const owner = repository.createBot(), scope = { sessionId: owner.session.id, executorBotId: owner.bot.id };
    await environments.start(scope);
    const before = repository.environments.getInternal(scope)!;
    try { await browser.start({ ...scope, clientNonce: randomUUID() }); }
    catch (error) {
      if (process.env.AEVOREN_BROWSER_STARTUP_DIAGNOSTICS === "1") {
        const record = repository.browsers.get(scope), container = record ? await driver.inspectBrowser(record.id, record.environmentId).catch(() => null) : null;
        console.error("Browser startup diagnostic", JSON.stringify({ trace: startupTrace, hostState: record?.state, containerState: container?.state, oomKilled: container?.oomKilled }));
      }
      throw error;
    }
    if (process.env.AEVOREN_BROWSER_STARTUP_DIAGNOSTICS === "1") {
      const actual = await driver.inspect(before.id);
      console.error("Execution binding after browser attachment", JSON.stringify({ environmentId: before.id, beforePort: before.workerPort,
        savedPort: repository.environments.getInternal(scope)?.workerPort, inspectedPort: actual?.workerPort, containerState: actual?.state, oomKilled: actual?.oomKilled }));
    }
    return scope;
  }
  const epoch = (scope: BrowserScope) => repository.browsers.get(scope)!.controlEpoch;
  async function observe(scope: BrowserScope) {
    const page = (await browser.tabs({ ...scope, expectedEpoch: epoch(scope) }, { actor: "ai" }))[0]!;
    return browser.observe({ ...scope, expectedEpoch: epoch(scope), pageId: page.id }, { actor: "ai" });
  }
  function gateway(scope: BrowserScope) {
    const nonce = randomUUID(); repository.prepareMessage({ sessionId: scope.sessionId, clientNonce: nonce, text: "controlled gateway image/approval fixture; no cloud inference" });
    const runtime = repository.createRuntimeRun(nonce, "openai-compatible", { schemaVersion: 1, botId: scope.executorBotId, profileVersion: 1, sessionId: scope.sessionId,
      generation: 1, inputSeq: 1, blocks: [], digest: "actual-browser-gateway" }, { providerInstanceId: "api.fixture", providerModelId: "image-transport-fixture" });
    repository.transitionRuntimeRun(runtime.id, "dispatching"); const running = repository.transitionRuntimeRun(runtime.id, "running", { providerRequestId: "transport-fixture" });
    const workspaceService = new WorkspaceService(repository), executor = new WorkspaceToolExecutor(repository, workspaceService);
    const coordinator = new WorkspaceToolCoordinator(repository, executor, () => undefined);
    const sender = new SendWorker(repository, null, { transcript: () => undefined, sendState: () => undefined, runtime: () => undefined }, false, undefined, undefined, coordinator);
    const dependencies = { repository, browserService: browser, environmentService: environments, workspaceService, workspaceToolCoordinator: coordinator, sendWorker: sender,
      roomCoordinator: new RoomCoordinator(repository, sender.executor, { transcript: () => undefined, roomRuntime: () => undefined }), generalSettings: new GeneralSettingsService(repository),
      providers: { list: async () => [], isSupported: () => true, getCapabilities: () => ({ toolImageInput: true }) }, updateService: {} } as unknown as ProductDependencies;
    const product = new ProductOperationService(dependencies); executor.setProductOperations(product);
    async function approved(run: RuntimeRun, operation: string, input?: unknown) {
      const tool: ProductToolRequest = { kind: "product-call", action: "execute", operation, ...(input === undefined ? {} : { input }) };
      const prepared = repository.prepareToolInvocation({ runtimeRunId: run.id, toolCallId: randomUUID(), idempotencyKey: randomUUID(), tool });
      await expect(executor.execute(prepared.invocation.id)).rejects.toMatchObject({ code: "TOOL_STATE_INVALID" });
      repository.resolveToolApproval(prepared.approval.id, prepared.approval.version, "allow-once");
      return { tool, result: await executor.execute(prepared.invocation.id) };
    }
    return { runtime: running, product, approved };
  }

  it("starts a real companion, transfers pixels, checks a registered service preview and preserves scope boundaries", async () => {
    const scope = await start(), peer = await start();
    expect(repository.browsers.get(scope)?.id).not.toBe(repository.browsers.get(peer)?.id);
    const seen = await observe(scope);
    await environments.writeFile({ ...scope, path: "preview-fixture.js", content: 'require("http").createServer((q,s)=>{s.setHeader("content-type","text/html");s.end("<title>REAL_HOST_PREVIEW</title><body style=background:skyblue><h1>REAL_HOST_PREVIEW</h1><button onclick=this.textContent=123>Press</button>")}).listen(8129,"0.0.0.0");\n' });
    const service = await environments.run({ ...scope, clientNonce: randomUUID(), command: "node preview-fixture.js" }, null, true);
    let port: Awaited<ReturnType<EnvironmentService["registerPort"]>> | undefined;
    await expect.poll(async () => { try { port = await environments.registerPort({ ...scope, processId: service.id, port: 8129, label: "actual preview fixture" }); return port.state; } catch { return "waiting"; } }).toBe("listening");
    const previewInput = { ...scope, expectedEpoch: seen.controlEpoch, registeredPortId: port!.id, clientNonce: randomUUID() };
    const preview = await browser.previewOpen(previewInput, { actor: "ai" });
    const pagesBeforeReplay = await browser.tabs({ ...scope, expectedEpoch: epoch(scope) }, { actor: "ai" });
    expect(await browser.previewOpen(previewInput, { actor: "ai" })).toEqual(preview);
    expect((await browser.tabs({ ...scope, expectedEpoch: epoch(scope) }, { actor: "ai" })).map(page => page.id).sort()).toEqual(pagesBeforeReplay.map(page => page.id).sort());
    const page = await browser.observe({ ...scope, expectedEpoch: epoch(scope), pageId: preview.pageId }, { actor: "ai" }); expect(page.text).toContain("REAL_HOST_PREVIEW");
    const shot = await browser.computerScreenshot({ ...scope, expectedEpoch: epoch(scope), pageId: preview.pageId }, { actor: "ai" });
    expect(shot.frame).toMatchObject({ width: 1280, height: 800, mimeType: "image/jpeg" });
    const image = await browser.imageAttachment(scope, shot.media.id, epoch(scope)); expect(image.dataBase64).toBe(shot.frame.dataBase64); expect(image.isAuthorized()).toBe(true);
    await expect(browser.imageAttachment(peer, shot.media.id, epoch(peer))).rejects.toMatchObject({ code: "BROWSER_MEDIA_NOT_FOUND" });
    const before = repository.browsers.get(scope)!.version, eventCount = changed.length;
    await browser.get(scope); await browser.get(scope); await browser.tabs({ ...scope, expectedEpoch: epoch(scope) }); await browser.tabs({ ...scope, expectedEpoch: epoch(scope) });
    expect(repository.browsers.get(scope)!.version).toBe(before); expect(changed).toHaveLength(eventCount);
    await browser.previewClose({ ...scope, expectedEpoch: epoch(scope), id: preview.id, clientNonce: randomUUID() }, { actor: "ai" });
    expect((await environments.getExecution({ ...scope, id: service.id })).state).toBe("running");
    await environments.cancel({ ...scope, id: service.id });
  }, 900_000);

  it("seals frames on takeover, keeps user ownership after disconnect, and observes afresh on return", async () => {
    const scope = await start(), first = await observe(scope);
    const shot = await browser.computerScreenshot({ ...scope, expectedEpoch: epoch(scope), pageId: first.pageId }, { actor: "ai" });
    const image = await browser.imageAttachment(scope, shot.media.id, epoch(scope));
    const taken = await browser.takeover({ ...scope, clientNonce: randomUUID(), expectedEpoch: epoch(scope) });
    expect(taken.owner).toBe("user"); expect(image.isAuthorized()).toBe(false);
    await expect(browser.observe({ ...scope, expectedEpoch: taken.epoch, pageId: first.pageId }, { actor: "ai" })).rejects.toMatchObject({ code: "COMPUTER_USER_CONTROLLED" });
    const nonce = randomUUID(), ticket = await browser.vncTicket({ ...scope, expectedEpoch: taken.epoch, clientNonce: nonce });
    expect(ticket.url).toMatch(/^ws:\/\/127\.0\.0\.1:/);
    expect(await browser.vncTicket({ ...scope, expectedEpoch: taken.epoch, clientNonce: nonce })).toEqual(ticket);
    expect((await browser.view(scope))?.owner).toBe("user");
    const returned = await browser.returnControl({ ...scope, clientNonce: randomUUID(), expectedEpoch: taken.epoch });
    expect(returned).toMatchObject({ owner: "ai", observedEpoch: null });
    await expect(browser.navigate({ ...scope, expectedEpoch: returned.epoch, clientNonce: randomUUID(), pageId: first.pageId, url: "https://example.test" }, { actor: "ai" })).rejects.toMatchObject({ code: "BROWSER_OBSERVATION_REQUIRED" });
    const fresh = await observe(scope); expect(fresh.controlEpoch).toBe(returned.epoch);
    const current = repository.browsers.get(scope)!;
    await browser.stop({ ...scope, clientNonce: randomUUID(), expectedVersion: current.version });
    await browser.start({ ...scope, clientNonce: randomUUID() }); expect(repository.browsers.get(scope)!.controlEpoch).toBeGreaterThan(returned.epoch);
  }, 180_000);
  it("cancels a real Runtime's pending click without late input, sibling page loss or background-service termination", async () => {
    const scope = await start(), initial = await observe(scope);
    const program = 'let count=0;require("http").createServer((q,s)=>{if(q.url==="/count"){s.end(String(count));return}if(q.url==="/clicked"){count++;s.end("counted");return}s.setHeader("content-type","text/html");s.end(`<title>CANCEL_ACTUAL_FIXTURE</title><button id="wait" style="pointer-events:none" onclick="fetch(\'/clicked\')">WAIT_FOR_CANCEL</button><script>setTimeout(()=>document.getElementById("wait").style.pointerEvents="auto",1500)</script>`)}).listen(8131,"0.0.0.0");\n';
    await environments.writeFile({ ...scope, path: "cancel-fixture.js", content: program });
    const background = await environments.run({ ...scope, clientNonce: randomUUID(), command: "node cancel-fixture.js" }, null, true);
    let registered: Awaited<ReturnType<EnvironmentService["registerPort"]>> | undefined;
    await expect.poll(async () => { try { registered = await environments.registerPort({ ...scope, processId: background.id, port: 8131 }); return registered.state; } catch { return "waiting"; } }).toBe("listening");
    const preview = await browser.previewOpen({ ...scope, expectedEpoch: initial.controlEpoch, registeredPortId: registered!.id, clientNonce: randomUUID() }, { actor: "ai" });
    const observed = await browser.observe({ ...scope, expectedEpoch: epoch(scope), pageId: preview.pageId }, { actor: "ai" });
    const sibling = await browser.newTab({ ...scope, expectedEpoch: epoch(scope), url: "about:blank", clientNonce: randomUUID() }, { actor: "ai" });
    const nonce = randomUUID(); repository.prepareMessage({ sessionId: scope.sessionId, clientNonce: nonce, text: "cancel actual controlled click" });
    const runtime = repository.createRuntimeRun(nonce, "fake", { schemaVersion: 1, botId: scope.executorBotId, profileVersion: 1, sessionId: scope.sessionId, generation: 1, inputSeq: 1, blocks: [], digest: "cancel-actual-fixture" });
    repository.transitionRuntimeRun(runtime.id, "dispatching"); repository.transitionRuntimeRun(runtime.id, "running", { providerRequestId: "controlled-fixture" });
    const pending = browser.click({ ...scope, clientNonce: randomUUID(), expectedEpoch: epoch(scope), pageId: observed.pageId, observationId: observed.id, documentVersion: observed.documentVersion,
      ref: observed.elements.find(element => element.name === "WAIT_FOR_CANCEL")!.ref }, { actor: "ai", runtimeRunId: runtime.id }).catch(error => error as Error);
    await new Promise<void>(accept => setTimeout(accept, 150)); await browser.cancelRuntime(runtime.id); expect(await pending).toBeInstanceOf(Error);
    expect((await browser.tabs({ ...scope, expectedEpoch: epoch(scope) }, { actor: "ai" })).some(page => page.id === sibling.id)).toBe(true);
    expect((await environments.getExecution({ ...scope, id: background.id })).state).toBe("running");
    await new Promise<void>(accept => setTimeout(accept, 1700));
    await environments.writeFile({ ...scope, path: "read-count.mjs", content: 'console.log(await (await fetch("http://127.0.0.1:8131/count")).text());\n' });
    const checked = await environments.run({ ...scope, clientNonce: randomUUID(), command: "node read-count.mjs" });
    await expect.poll(async () => (await environments.getExecution({ ...scope, id: checked.id })).state).toBe("completed");
    expect((await environments.logs({ ...scope, id: checked.id })).logs.filter(log => log.stream === "stdout").map(log => log.text).join("").trim()).toBe("0");
    await environments.cancel({ ...scope, id: background.id });
  }, 180_000);
  it("uses real Runtime approvals and transports actual ephemeral screenshot images without journal pixels or AI control capabilities", async () => {
    const owner = repository.createBot(), scope = { sessionId: owner.session.id, executorBotId: owner.bot.id }; await environments.start(scope);
    const g = gateway(scope);
    expect(repository.browsers.get(scope)).toBeNull();
    const started = await g.approved(g.runtime, "browser.start");
    expect(started.result.invocation.state).toBe("succeeded"); expect(repository.browsers.get(scope)?.state).toBe("running");
    const captured = await g.approved(g.runtime, "computer.screenshot", { expectedEpoch: epoch(scope) });
    const image = captured.result.images?.[0]; expect(image).toBeDefined(); expect(image!.isAuthorized()).toBe(true);
    expect(image!.dataBase64.length).toBeGreaterThan(1_000); expect(captured.result.content).not.toContain("dataBase64"); expect(captured.result.content).not.toContain(image!.dataBase64);
    expect(repository.findProductOperationResult(g.runtime.clientNonce, captured.tool, scope.executorBotId)).not.toContain(image!.dataBase64);
    const wire = imageAwareChatMessages([{ role: "tool", tool_call_id: "actual-browser-frame", content: captured.result.content, images: captured.result.images }]);
    expect(JSON.stringify(wire)).toContain(`data:${image!.reference.mimeType};base64,${image!.dataBase64}`);
    await environments.writeFile({ ...scope, path: "gateway-fixture.cjs", content: 'require("http").createServer((q,s)=>{s.setHeader("content-type","text/html");s.end(`<title>ACTUAL_GATEWAY_CLICK</title><button onclick="this.textContent=\'CLICK_COMPLETED\'">CLICK_GATEWAY_REAL</button>`)}).listen(8137,"0.0.0.0");\n' });
    const background = await environments.run({ ...scope, clientNonce: randomUUID(), command: "node gateway-fixture.cjs" }, null, true);
    let port: Awaited<ReturnType<EnvironmentService["registerPort"]>> | undefined;
    await expect.poll(async () => { try { port = await environments.registerPort({ ...scope, processId: background.id, port: 8137 }); return port.state; } catch { return "waiting"; } }).toBe("listening");
    const preview = await g.approved(g.runtime, "preview.open", { expectedEpoch: epoch(scope), registeredPortId: port!.id });
    const previewId = (JSON.parse(preview.result.content).result as { pageId: string }).pageId;
    const inspected = await g.approved(g.runtime, "browser.observe", { expectedEpoch: epoch(scope), pageId: previewId });
    const observation = JSON.parse(inspected.result.content).result as import("@shared/browser-contracts").BrowserObservation;
    const element = observation.elements.find(element => element.name === "CLICK_GATEWAY_REAL")!;
    const clicked = await g.approved(g.runtime, "browser.click", { expectedEpoch: epoch(scope), pageId: previewId, observationId: observation.id, documentVersion: observation.documentVersion, ref: element.ref });
    expect(clicked.result.invocation.state).toBe("succeeded");
    const replay = await g.product.execute(clicked.tool, clicked.result.invocation);
    expect(JSON.parse(replay.content)).toMatchObject({ status: "previously_completed", reused: true });
    expect((await browser.observe({ ...scope, expectedEpoch: epoch(scope), pageId: previewId }, { actor: "ai" })).text).toContain("CLICK_COMPLETED");
    for (const operation of ["computer.takeover", "computer.returnControl", "computer.vncTicket"]) {
      const attempt = await g.approved(g.runtime, operation, { expectedEpoch: epoch(scope) });
      expect(JSON.parse(attempt.result.content)).toMatchObject({ status: "waiting_user" });
      expect(attempt.result.content).not.toMatch(/ws:\/\/|Bearer|encryptedToken/); expect(repository.browsers.view(scope)?.owner).toBe("ai");
    }
    const old = epoch(scope); await browser.takeover({ ...scope, expectedEpoch: old, clientNonce: randomUUID() }); expect(image!.isAuthorized()).toBe(false);
    await expect(g.product.execute(captured.tool, captured.result.invocation)).rejects.toMatchObject({ code: "COMPUTER_CONTROL_CHANGED" });
    expect(JSON.stringify(imageAwareChatMessages([{ role: "tool", tool_call_id: "actual-browser-frame", content: captured.result.content, images: captured.result.images }]))).not.toContain(image!.dataBase64);
    await environments.cancel({ ...scope, id: background.id });
    repository.transitionRuntimeRun(g.runtime.id, "completed");
  }, 180_000);
});
