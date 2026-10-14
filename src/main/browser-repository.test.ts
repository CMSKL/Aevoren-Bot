import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserObservation, BrowserScope, InternalScreenshotRecord } from "@shared/browser-contracts";
import { BROWSER_FRAME_MAX_BYTES } from "@shared/browser-contracts";
import { BROWSER_OPERATION_SCHEMAS, BROWSER_PRODUCT_OPERATIONS } from "@shared/browser-product";
import { browserNavigateSchema, browserWorkerFrameSchema, browserDownloadSchema } from "@shared/browser-schemas";
import { AppRepository } from "./database";

const repositories: AppRepository[] = [], directories: string[] = [];
const configuration = { workerVersion: "1.0.0", imageRef: "fixture-execution-worker:1.0.0", imageDigest: `sha256:${"a".repeat(64)}`, platform: "linux/arm64" as const };
function fixture(filename = ":memory:") {
  const repository = new AppRepository(filename); repositories.push(repository);
  const owner = repository.createBot(), scope = { sessionId: owner.session.id, executorBotId: owner.bot.id };
  return { repository, owner, scope, browser: repository.browsers };
}
function running(f: ReturnType<typeof fixture>, scope: BrowserScope = f.scope) {
  const environment = f.repository.environments.ensure(scope, configuration);
  f.browser.ensure(scope, { environmentId: environment.id });
  f.browser.syncControl(scope, { owner: "ai", controlEpoch: 1, observedEpoch: 1, connectionState: "connected" }, randomUUID());
  return f.browser.update(scope, f.browser.get(scope)!.version, { state: "running" });
}
function observe(f: ReturnType<typeof fixture>, scope: BrowserScope = f.scope, actor: "ai" | "user" = "ai", pageId: string = randomUUID()) {
  const browser = f.browser.get(scope)!, at = new Date().toISOString();
  const page = f.browser.upsertPage(scope, { id: pageId, browserSessionId: browser.id, url: "https://example.test/", title: "Actual metadata fixture", documentVersion: 1, createdAt: at, updatedAt: at }, browser.controlEpoch, actor);
  const observation: BrowserObservation = { id: randomUUID(), browserSessionId: browser.id, pageId: page.id, controlEpoch: browser.controlEpoch,
    documentVersion: page.documentVersion, url: page.url, title: page.title, text: "Fixture text", elements: [{ ref: "e1", role: "button", name: "Continue" }], truncated: false, observedAt: at };
  f.browser.recordObservation(scope, observation, actor);
  return { page, observation, proof: { pageId: page.id, expectedEpoch: browser.controlEpoch, observationId: observation.id, documentVersion: page.documentVersion } };
}
function frame(f: ReturnType<typeof fixture>, scope: BrowserScope = f.scope): InternalScreenshotRecord {
  const seen = observe(f, scope), directory = mkdtempSync(join(tmpdir(), "aevoren-browser-pixels-")); directories.push(directory);
  // Real PNG bytes for metadata/owned-path tests; visual transport is verified by the host/Worker suite.
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6iFAAAAAASUVORK5CYII=", "base64");
  const path = join(directory, "frame.png"); writeFileSync(path, bytes);
  return { id: randomUUID(), name: "frame.png", ...scope, browserSessionId: seen.page.browserSessionId, pageId: seen.page.id, observationId: randomUUID(),
    controlEpoch: seen.observation.controlEpoch, documentVersion: seen.page.documentVersion, size: bytes.length, mimeType: "image/png", sha256: createHash("sha256").update(bytes).digest("hex"),
    width: 1, height: 1, capturedAt: new Date().toISOString(), blobPath: path };
}
afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("scoped browser control in the shared SQLite database", () => {
  it("retains nullable user frames but refuses them as AI-authorized image references", () => {
    const f = fixture(); running(f); const capture = { ...frame(f), pageId: null, documentVersion: null };
    const observed = f.browser.view(f.scope)!.observedEpoch;
    f.browser.recordFrame(f.scope, capture, "user");
    expect(f.browser.assertFrame(f.scope, capture.id, 1, "user").pageId).toBeNull();
    expect(f.browser.view(f.scope)!.observedEpoch).toBe(observed);
    expect(() => f.browser.assertFrame(f.scope, capture.id, 1, "ai")).toThrowError(expect.objectContaining({ code: "BROWSER_OBSERVATION_REQUIRED" }));
  });
  it("projects public metadata without companion credentials, image internals or private blobs", () => {
    const f = fixture(); expect(f.browser.get(f.scope)).toBeNull(); running(f);
    f.browser.updateConnection(f.scope, { encryptedToken: "INDEPENDENT_BROWSER_CIPHERTEXT", containerId: "PRIVATE_COMPANION_CONTAINER", workerPort: 43001,
      imageRef: "companion:1.0.0", imageDigest: `sha256:${"b".repeat(64)}`, workerVersion: "1.0.0", platform: "linux/arm64" });
    const projected = JSON.stringify({ browser: f.browser.get(f.scope), view: f.browser.view(f.scope) });
    expect(projected).not.toMatch(/CIPHERTEXT|PRIVATE_|workerPort|imageDigest|encryptedToken/);
    expect(f.browser.getInternal(f.scope)?.encryptedToken).toBe("INDEPENDENT_BROWSER_CIPHERTEXT");
    expect(f.browser.listInternal()).toHaveLength(1);
  });
  it("requires the real environment to belong to the same session and executor", () => {
    const f = fixture(), peer = f.repository.createBot();
    const environment = f.repository.environments.ensure(f.scope, configuration);
    expect(() => f.browser.ensure({ sessionId: peer.session.id, executorBotId: peer.bot.id }, { environmentId: environment.id })).toThrowError(expect.objectContaining({ code: "BROWSER_SCOPE_INVALID" }));
    expect(() => f.browser.ensure({ sessionId: f.scope.sessionId, executorBotId: peer.bot.id }, { environmentId: environment.id })).toThrow();
  });
  it("keeps six group browser/control records independent from private sessions", () => {
    const f = fixture(), privateBrowser = running(f);
    const members = [f.owner.bot, ...Array.from({ length: 5 }, () => f.repository.createBot().bot)];
    const room = f.repository.createRoom({ memberBotIds: members.map(bot => bot.id) });
    const scopes = members.map(bot => ({ sessionId: room.session.id, executorBotId: bot.id }));
    const browsers = scopes.map(scope => running(f, scope));
    expect(new Set(browsers.map(browser => browser.id)).size).toBe(6);
    expect(browsers.map(browser => browser.id)).not.toContain(privateBrowser.id);
    f.browser.claimControl(scopes[0]!, { owner: "user", expectedEpoch: 1 });
    expect(scopes.slice(1).map(scope => f.browser.view(scope)?.owner)).toEqual(Array(5).fill("ai"));
    expect(f.browser.view(f.scope)?.owner).toBe("ai");
  });
  it("keeps same-value metadata versions stable and detects real version conflicts", () => {
    const f = fixture(), browser = running(f);
    expect(f.browser.update(f.scope, browser.version, { state: "running" })).toEqual(browser);
    const changed = f.browser.update(f.scope, browser.version, { state: "unknown" });
    expect(changed.version).toBe(browser.version + 1);
    expect(() => f.browser.update(f.scope, browser.version, { state: "running" })).toThrowError(expect.objectContaining({ code: "BROWSER_VERSION_CONFLICT" }));
  });
  it("does not accept Worker metadata as proof of actual AI observation", () => {
    const f = fixture(); running(f); expect(f.browser.view(f.scope)?.observedEpoch).toBeNull();
    expect(() => f.browser.assertFresh(f.scope, 1)).toThrowError(expect.objectContaining({ code: "BROWSER_OBSERVATION_REQUIRED" }));
    const at = new Date().toISOString(), browser = f.browser.get(f.scope)!;
    const page = f.browser.upsertPage(f.scope, { id: randomUUID(), browserSessionId: browser.id, url: "about:blank", title: "", documentVersion: 1, createdAt: at, updatedAt: at }, 1);
    expect(() => f.browser.assertInput(f.scope, { pageId: page.id, expectedEpoch: 1, observationId: randomUUID(), documentVersion: 1 })).toThrowError(expect.objectContaining({ code: "BROWSER_OBSERVATION_REQUIRED" }));
    observe(f); expect(f.browser.assertFresh(f.scope, 1).epoch).toBe(1);
  });
  it("pauses AI reads, screenshots and input throughout user ownership while preserving a sibling", () => {
    const f = fixture(); running(f); const seen = observe(f), captured = frame(f); f.browser.recordFrame(f.scope, captured);
    const peer = f.repository.createBot(), peerScope = { sessionId: peer.session.id, executorBotId: peer.bot.id }; running(f, peerScope);
    const user = f.browser.claimControl(f.scope, { owner: "user", expectedEpoch: 1 });
    expect(user).toMatchObject({ owner: "user", epoch: 2, observedEpoch: null, connectionState: "disconnected" });
    expect(() => f.browser.pages(f.scope, 2)).toThrowError(expect.objectContaining({ code: "COMPUTER_USER_CONTROLLED" }));
    expect(() => f.browser.getFrame(f.scope, captured.id, 2)).toThrowError(expect.objectContaining({ code: "COMPUTER_USER_CONTROLLED" }));
    expect(() => f.browser.recordObservation(f.scope, { ...seen.observation, id: randomUUID(), controlEpoch: 2 })).toThrowError(expect.objectContaining({ code: "COMPUTER_USER_CONTROLLED" }));
    expect(() => f.browser.assertInput(f.scope, { ...seen.proof, expectedEpoch: 2 })).toThrowError(expect.objectContaining({ code: "COMPUTER_USER_CONTROLLED" }));
    expect(f.browser.assertAccess(peerScope, 1).owner).toBe("ai");
    expect(f.browser.assertFresh(f.scope, 2, "user").owner).toBe("user");
    expect(() => f.browser.assertFresh(peerScope, 1, "user")).toThrowError(expect.objectContaining({ code: "COMPUTER_CONTROL_CHANGED" }));
  });
  it("requires a new AI observation after an explicit return and rejects old epoch/document proofs", () => {
    const f = fixture(); running(f); const first = observe(f);
    f.browser.claimControl(f.scope, { owner: "user", expectedEpoch: 1 });
    const returned = f.browser.claimControl(f.scope, { owner: "ai", expectedEpoch: 2 });
    expect(returned.observedEpoch).toBeNull();
    expect(() => f.browser.assertFresh(f.scope, 3)).toThrowError(expect.objectContaining({ code: "BROWSER_OBSERVATION_REQUIRED" }));
    expect(() => f.browser.assertInput(f.scope, { ...first.proof, expectedEpoch: 3 })).toThrowError(expect.objectContaining({ code: "BROWSER_OBSERVATION_REQUIRED" }));
    const fresh = observe(f, f.scope, "ai", first.page.id);
    expect(f.browser.assertInput(f.scope, fresh.proof).epoch).toBe(3);
    f.browser.upsertPage(f.scope, { ...fresh.page, documentVersion: 2 }, 3);
    expect(() => f.browser.assertInput(f.scope, fresh.proof)).toThrowError(expect.objectContaining({ code: "BROWSER_OBSERVATION_REQUIRED" }));
  });
  it("persists user ownership across disconnect and SQLite reopening, never silently handing back control", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-browser-restart-")); directories.push(directory);
    const filename = join(directory, "app.sqlite"), f = fixture(filename); running(f);
    f.browser.claimControl(f.scope, { owner: "user", expectedEpoch: 1 });
    const bootId = f.browser.get(f.scope)!.bootId!;
    f.browser.syncControl(f.scope, { owner: "user", controlEpoch: 2, observedEpoch: null, connectionState: "disconnected" }, bootId);
    const saved = f.browser.view(f.scope);
    f.repository.close(); repositories.splice(repositories.indexOf(f.repository), 1);
    const reopened = new AppRepository(filename); repositories.push(reopened);
    expect(reopened.browsers.view(f.scope)).toEqual(saved);
    expect(() => reopened.browsers.syncControl(f.scope, { owner: "ai", controlEpoch: 3, observedEpoch: 3, connectionState: "connected" }, randomUUID())).toThrowError(expect.objectContaining({ code: "COMPUTER_CONTROL_CHANGED" }));
    expect(reopened.browsers.view(f.scope)?.owner).toBe("user");
  });
  it("invalidates observations on a Worker boot change and refuses epochs that move backwards", () => {
    const f = fixture(); running(f); observe(f);
    expect(() => f.browser.syncControl(f.scope, { owner: "ai", controlEpoch: 1, observedEpoch: 1, connectionState: "connected" }, randomUUID())).toThrowError(expect.objectContaining({ code: "COMPUTER_CONTROL_CHANGED" }));
    f.browser.syncControl(f.scope, { owner: "ai", controlEpoch: 2, observedEpoch: 2, connectionState: "connected" }, randomUUID());
    expect(f.browser.view(f.scope)?.observedEpoch).toBeNull();
    expect(() => f.browser.assertAccess(f.scope, 1)).toThrowError(expect.objectContaining({ code: "COMPUTER_CONTROL_CHANGED" }));
  });
  it("stores immutable scoped screenshot references without exposing blob paths, then rechecks epoch at lookup", () => {
    const f = fixture(); running(f); const capture = frame(f), publicMedia = f.browser.recordFrame(f.scope, capture);
    expect(publicMedia).not.toHaveProperty("blobPath"); expect(publicMedia).not.toHaveProperty("dataBase64");
    expect(f.browser.recordFrame(f.scope, capture)).toEqual(publicMedia);
    expect(f.browser.assertFrame(f.scope, capture.id, 1)).toEqual(publicMedia);
    expect(f.browser.getFrame(f.scope, capture.id, 1).blobPath).toBe(capture.blobPath);
    expect(() => f.browser.recordFrame(f.scope, { ...capture, sha256: "f".repeat(64) })).toThrowError(expect.objectContaining({ code: "BROWSER_MEDIA_INVALID" }));
    f.browser.claimControl(f.scope, { owner: "user", expectedEpoch: 1 }); f.browser.claimControl(f.scope, { owner: "ai", expectedEpoch: 2 });
    expect(() => f.browser.getFrame(f.scope, capture.id, 3)).toThrowError(expect.objectContaining({ code: "COMPUTER_CONTROL_CHANGED" }));
  });
  it("cannot read another scope's pixels or download metadata", () => {
    const f = fixture(); running(f); const captured = frame(f); f.browser.recordFrame(f.scope, captured);
    const peer = f.repository.createBot(), scope = { sessionId: peer.session.id, executorBotId: peer.bot.id }; running(f, scope);
    expect(() => f.browser.getFrame(scope, captured.id, 1)).toThrowError(expect.objectContaining({ code: "BROWSER_MEDIA_NOT_FOUND" }));
    const item = { id: randomUUID(), browserSessionId: captured.browserSessionId, pageId: captured.pageId!, name: "result.bin", size: 1, mimeType: "application/octet-stream", sha256: "a".repeat(64), createdAt: new Date().toISOString() };
    f.browser.recordDownload(f.scope, item, "owned-digest-path", 1); f.browser.recordDownload(f.scope, item, "owned-digest-path", 1);
    expect(f.browser.downloads(f.scope, 1)).toEqual([item]);
    expect(f.browser.downloads(scope, 1)).toEqual([]);
    expect(() => f.browser.getDownload(scope, item.id, 1)).toThrowError(expect.objectContaining({ code: "BROWSER_MEDIA_NOT_FOUND" }));
  });
  it("rolls back local metadata changes within an existing host receipt transaction", () => {
    const f = fixture(); running(f);
    expect(() => f.browser.transaction(() => { f.browser.claimControl(f.scope, { owner: "user", expectedEpoch: 1 }); throw new Error("receipt refused"); })).toThrow("receipt refused");
    expect(f.browser.view(f.scope)).toMatchObject({ owner: "ai", epoch: 1 });
  });
  it("publishes a page snapshot atomically and rejects foreign pages without partial metadata", () => {
    const f = fixture(), browser = running(f), original = observe(f).page;
    const at = new Date().toISOString();
    const added = { id: randomUUID(), browserSessionId: browser.id, url: "about:blank", title: "new", documentVersion: 1, createdAt: at, updatedAt: at };
    const foreign = { ...added, id: randomUUID(), browserSessionId: randomUUID() };
    expect(() => f.browser.upsertPages(f.scope, [added, foreign], 1)).toThrowError(expect.objectContaining({ code: "BROWSER_SCOPE_INVALID" }));
    expect(f.browser.pages(f.scope, 1)).toEqual([original]);
  });
  it("registers preview metadata only against its own listening background-port record", () => {
    const f = fixture(), browser = running(f), seen = observe(f);
    function port(scope: BrowserScope) {
      const session = f.repository.environments.createSession(scope, null);
      const task = f.repository.environments.createExecution(scope, { executionSessionId: session.id, clientNonce: randomUUID(), kind: "background", command: "port metadata fixture; never executed" }).execution;
      f.repository.environments.updateExecution(scope, task.id, task.version, { state: "running" });
      return f.repository.environments.upsertPort(scope, { processId: task.id, port: 8123, state: "listening" });
    }
    const own = port(f.scope), peer = f.repository.createBot(), otherScope = { sessionId: peer.session.id, executorBotId: peer.bot.id };
    running(f, otherScope); const foreign = port(otherScope);
    const url = `http://aevoren-execution-${browser.environmentId}:8123/`;
    expect(() => f.browser.recordPreview(f.scope, { registeredPortId: foreign.id, pageId: seen.page.id, url }, 1)).toThrowError(expect.objectContaining({ code: "PREVIEW_UNAVAILABLE" }));
    const preview = f.browser.recordPreview(f.scope, { registeredPortId: own.id, pageId: seen.page.id, url }, 1);
    expect(f.browser.listPreviews(f.scope, 1)).toEqual([preview]);
    f.browser.removePage(f.scope, seen.page.id, 1);
    expect(f.browser.listPreviews(f.scope, 1)[0]?.state).toBe("closed");
  });
  it("cascades exact departed-member metadata while preserving private and group peers", () => {
    const f = fixture(); running(f); const privateBrowser = f.browser.get(f.scope)!;
    const peers = Array.from({ length: 2 }, () => f.repository.createBot());
    const room = f.repository.createRoom({ memberBotIds: [f.owner.bot.id, ...peers.map(peer => peer.bot.id)] });
    const ownScope = { sessionId: room.session.id, executorBotId: f.owner.bot.id }, peerScope = { sessionId: room.session.id, executorBotId: peers[0]!.bot.id };
    const departed = running(f, ownScope), sibling = running(f, peerScope); const capture = frame(f, ownScope); f.browser.recordFrame(ownScope, capture);
    f.repository.removeRoomMember(room.room.id, f.owner.bot.id, room.room.membershipVersion);
    expect(f.browser.listInternal().map(browser => browser.id)).not.toContain(departed.id);
    expect(() => f.browser.getFrame(ownScope, capture.id, 1)).toThrow();
    expect(f.browser.get(f.scope)).toEqual(privateBrowser); expect(f.browser.get(peerScope)).toEqual(sibling);
  });
});

describe("browser public/wire bounds", () => {
  it("requires UI nonces, excludes actor/runtime/nonce injection from model input and retains human-only descriptions", () => {
    const input = { sessionId: randomUUID(), executorBotId: randomUUID(), expectedEpoch: 1, pageId: randomUUID(), url: "https://example.test/" };
    expect(browserNavigateSchema.safeParse(input).success).toBe(false); expect(browserNavigateSchema.safeParse({ ...input, clientNonce: randomUUID() }).success).toBe(true);
    for (const field of ["clientNonce", "operationId", "runtimeRunId", "actor"]) expect(BROWSER_OPERATION_SCHEMAS["browser.navigate"]!.safeParse({ ...input, [field]: field === "actor" ? "user" : randomUUID() }).success).toBe(false);
    expect(BROWSER_PRODUCT_OPERATIONS.find(operation => operation.name === "computer.returnControl")?.description).toContain("waiting_user");
    expect(new Set(BROWSER_PRODUCT_OPERATIONS.map(operation => operation.channel)).size).toBe(27);
  });
  it("bounds decoded pixels/downloads and rejects a byte-count mismatch", () => {
    const frame = { browserSessionId: randomUUID(), pageId: randomUUID(), observationId: randomUUID(), controlEpoch: 1, documentVersion: 1,
      dataBase64: Buffer.from("pixels").toString("base64"), mimeType: "image/png", size: 6, sha256: "a".repeat(64), width: 1, height: 1, capturedAt: new Date().toISOString() };
    expect(browserWorkerFrameSchema.safeParse(frame).success).toBe(true);
    expect(browserWorkerFrameSchema.safeParse({ ...frame, size: 7 }).success).toBe(false);
    expect(browserWorkerFrameSchema.safeParse({ ...frame, size: BROWSER_FRAME_MAX_BYTES + 1 }).success).toBe(false);
    expect(browserDownloadSchema.safeParse({ id: randomUUID(), browserSessionId: frame.browserSessionId, pageId: frame.pageId, name: "too-large", mimeType: "application/octet-stream", size: 1_048_577, sha256: frame.sha256, createdAt: frame.capturedAt }).success).toBe(false);
  });
});
