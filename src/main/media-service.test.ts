import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaChangedEvent } from "@shared/media-contracts";
import { MEDIA_TEXT_MAX_BYTES } from "@shared/media-schemas";
import { AppRepository } from "./database";
import type { MediaParseResult, MediaParserAdapter, MediaParserInput } from "./media-parser-types";
import { MediaService } from "./media-service";
import { WorkspaceService } from "./workspace-service";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6YJ0AAAAASUVORK5CYII=", "base64");
const fixtures: { repository: AppRepository; service: MediaService; root: string }[] = [];
function parsed(input: MediaParserInput): MediaParseResult {
  return input.mimeType.startsWith("image/") ? { kind: "image", durationMs: null, width: 1, height: 1, extraction: null, parserName: "controlled-unit-parser", parserVersion: "1" }
    : { durationMs: null, kind: input.mimeType === "application/pdf" ? "pdf" : "docx", width: null, height: null, parserName: "controlled-unit-parser", parserVersion: "1",
      extraction: { text: "IMMUTABLE_PRIVATE_TEXT", spans: [{ kind: input.mimeType === "application/pdf" ? "page" : "section", index: 0, start: 0, end: 22 }], warningCodes: [] } };
}
function fixture(overrides: Partial<MediaParserAdapter> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aevoren-media-service-"))), filename = join(root, "app.sqlite"), repository = new AppRepository(filename);
  const parser: MediaParserAdapter = { parse: vi.fn(async input => parsed(input)), renderPdfPage: vi.fn(async () => ({ bytes: png, width: 1, height: 1, mimeType: "image/png" as const })), shutdown: vi.fn(async () => {}), ...overrides };
  const events: MediaChangedEvent[] = [], service = new MediaService(repository, join(root, "owned"), parser, { workspaceService: new WorkspaceService(repository), onChanged: event => events.push(event) });
  fixtures.push({ repository, service, root }); const owner = repository.createBot();
  const source = (name = "document.pdf", bytes = Buffer.from("%PDF-1.7\ncontrolled fixture")) => { const path = join(root, name); writeFileSync(path, bytes); return path; };
  return { root, filename, repository, parser, service, events, ...owner, source };
}
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.service.shutdown(); f.repository.close(); rmSync(f.root, { recursive: true, force: true }); } });

describe("media staging, reads and owned parsing jobs", () => {
  it("publishes accepted files once with explicit failures and survives source movement and database reopen", async () => {
    const f = fixture(), source = f.source(), invalid = f.source("unsupported.bin", Buffer.from("not a supported file"));
    const prepared = await f.service.prepareImportPaths(f.session.id, [source, invalid]);
    expect(f.service.list({ sessionId: f.session.id })).toEqual([]); renameSync(source, join(f.root, "moved.pdf"));
    const result = f.service.commitImport(prepared), item = result.imported[0]!;
    expect(result.imported).toHaveLength(1); expect(result.failed).toEqual([{ name: "unsupported.bin", code: "MEDIA_UNSUPPORTED", reason: expect.any(String) }]);
    expect(JSON.stringify(result)).not.toContain(f.root); expect(JSON.stringify(result)).not.toContain("IMMUTABLE_PRIVATE_TEXT");
    expect(() => f.service.commitImport(prepared)).toThrow();
    const read = await f.service.read({ sessionId: f.session.id, id: item.asset.reference.id, maxCharacters: 9 });
    expect(read.modelText?.text).toBe("IMMUTABLE"); expect(read.metadata.nextOffset).toBe(9);
    expect(JSON.stringify(read.metadata)).not.toContain("IMMUTABLE_PRIVATE_TEXT");
    const reopened = new AppRepository(f.filename);
    try { const service = new MediaService(reopened, join(f.root, "owned"), f.parser); expect((await service.readForUi({ sessionId: f.session.id, id: item.asset.reference.id })).text).toBe("IMMUTABLE_PRIVATE_TEXT"); await service.shutdown(); }
    finally { reopened.close(); }
    expect(f.events).toEqual([{ sessionId: f.session.id, mediaId: item.asset.reference.id, action: "created" }]);
  });
  it("cancelling during a later parser job publishes none of the already prepared accepted set", async () => {
    let entered!: () => void, release!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
    const f = fixture({ parse: async input => { if (++calls === 2) { entered(); await gate; } return parsed(input); } }), controller = new AbortController();
    const work = f.service.prepareImportPaths(f.session.id, [f.source("first.pdf"), f.source("second.pdf")], { signal: controller.signal });
    await started; controller.abort(); release(); await expect(work).rejects.toMatchObject({ code: "TOOL_EXECUTION_CANCELLED" });
    expect(f.repository.media.available()).toEqual([]); expect(f.events).toEqual([]);
  });
  it("keeps a completed prepared set unpublished when cancellation occurs before commit", async () => {
    const f = fixture(), controller = new AbortController(), context = { signal: controller.signal };
    const token = await f.service.prepareImportPaths(f.session.id, [f.source()], context); controller.abort();
    expect(() => f.service.commitImport(token, context)).toThrowError(expect.objectContaining({ code: "TOOL_EXECUTION_CANCELLED" }));
    expect(f.service.available()).toEqual([]);
  });
  it("does not silently publish oversized text, wrong PDF spans or a failing sibling file", async () => {
    let calls = 0; const f = fixture({ parse: async input => { const value = parsed(input); calls += 1;
      if (calls === 1) value.extraction!.text = "x".repeat(MEDIA_TEXT_MAX_BYTES + 1);
      if (calls === 2) value.extraction!.spans[0]!.kind = "section";
      return value; } });
    const result = await f.service.importPaths(f.session.id, [f.source("large.pdf"), f.source("wrong-page.pdf"), f.source("valid.pdf")]);
    expect(result.imported).toHaveLength(1); expect(result.failed).toHaveLength(2);
    expect(result.imported[0]!.asset.reference.name).toBe("valid.pdf"); expect(f.service.available()).toHaveLength(1);
  });
  it("returns actual owned image bytes with a dispatch guard that never revives after rebind", async () => {
    const f = fixture(), item = (await f.service.importPaths(f.session.id, [f.source("image.png", png)])).imported[0]!;
    rmSync(join(f.root, "image.png"));
    const read = await f.service.read({ sessionId: f.session.id, id: item.asset.reference.id });
    expect(Buffer.from(read.images[0]!.dataBase64, "base64")).toEqual(png); expect(read.images[0]!.isAuthorized()).toBe(true);
    f.service.unbind({ sessionId: f.session.id, id: item.asset.reference.id }); f.service.bind({ sessionId: f.session.id, id: item.asset.reference.id });
    expect(read.images[0]!.isAuthorized()).toBe(false);
    expect((await f.service.read({ sessionId: f.session.id, id: item.asset.reference.id })).images[0]!.isAuthorized()).toBe(true);
  });
  it("a text read loses its ephemeral body authorization after disable and re-enable", async () => {
    const f = fixture(), item = (await f.service.importPaths(f.session.id, [f.source()])).imported[0]!, read = await f.service.read({ sessionId: f.session.id, id: item.asset.reference.id });
    let asset = f.service.setEnabled({ sessionId: f.session.id, id: item.asset.reference.id, expectedVersion: 1, enabled: false });
    asset = f.service.setEnabled({ sessionId: f.session.id, id: item.asset.reference.id, expectedVersion: asset.version, enabled: true });
    expect(asset.enabled).toBe(true); expect(read.modelText?.isAuthorized()).toBe(false);
  });
  it("preview uses a new derived image digest and revoking one preview does not cancel its sibling", async () => {
    const pending: { sha256: string; signal: AbortSignal; release(): void }[] = []; const f = fixture({ renderPdfPage: async (input, signal) => {
      await new Promise<void>((resolve, reject) => { pending.push({ sha256: input.sha256, signal, release: resolve }); signal.addEventListener("abort", () => reject(new Error("cancelled owned parser")), { once: true }); });
      return { bytes: png, width: 1, height: 1, mimeType: "image/png" as const };
    } });
    const [first, second] = (await f.service.importPaths(f.session.id, [f.source("one.pdf", Buffer.from("%PDF-1.7\none")), f.source("two.pdf", Buffer.from("%PDF-1.7\ntwo"))])).imported;
    const one = f.service.preview({ sessionId: f.session.id, id: first!.asset.reference.id }), two = f.service.preview({ sessionId: f.session.id, id: second!.asset.reference.id });
    const rejected = expect(one).rejects.toThrow(); await vi.waitFor(() => expect(pending).toHaveLength(2));
    f.service.unbind({ sessionId: f.session.id, id: first!.asset.reference.id }); await rejected;
    const sibling = pending.find(job => job.sha256 === second!.reference.sha256)!;
    expect(sibling.signal.aborted).toBe(false); sibling.release();
    const preview = await two; expect(preview.metadata.sourceReference).toEqual(second!.reference);
    expect("image" in preview.metadata && preview.metadata.image.sha256).not.toBe(second!.reference.sha256); expect(Buffer.from(preview.images[0]!.dataBase64, "base64")).toEqual(png);
  });
  it("approved import admits only newly created IDs to its current Runtime and cannot revive an old binding", async () => {
    const f = fixture(), item = (await f.service.importPaths(f.session.id, [f.source()])).imported[0]!, nonce = randomUUID();
    f.repository.prepareMessage({ sessionId: f.session.id, clientNonce: nonce, text: "task" });
    const runtime = f.repository.createRuntimeRun(nonce, "fake", { schemaVersion: 1, botId: f.bot.id, profileVersion: 1, sessionId: f.session.id, generation: 1, inputSeq: 1, blocks: [], digest: "service-import" });
    const context = { executorBotId: f.bot.id, runtimeRunId: runtime.id };
    f.service.unbind({ sessionId: f.session.id, id: item.asset.reference.id }, context); f.service.bind({ sessionId: f.session.id, id: item.asset.reference.id }, context);
    await expect(f.service.read({ sessionId: f.session.id, id: item.asset.reference.id }, context)).rejects.toMatchObject({ code: "MEDIA_NOT_GRANTED" });
    const next = (await f.service.importPaths(f.session.id, [f.source("new.pdf")], context)).imported[0]!;
    expect(next.asset.reference.id).not.toBe(item.asset.reference.id); expect(next.reference.sha256).toBe(item.reference.sha256);
    expect((await f.service.read({ sessionId: f.session.id, id: next.asset.reference.id }, context)).modelText?.isAuthorized()).toBe(true);
  });
  it("rejects a Workspace parent replaced by an outside link after target resolution", async () => {
    const f = fixture(), sourceRoot = join(f.root, "authorized"), outside = join(f.root, "outside");
    mkdirSync(sourceRoot); mkdirSync(outside);
    writeFileSync(join(sourceRoot, "brief.pdf"), "%PDF-1.7 authorized");
    writeFileSync(join(outside, "brief.pdf"), "%PDF-1.7 outside grant");
    const workspaceService = new WorkspaceService(f.repository);
    const project = f.repository.createProject("Parent identity"), registration = await workspaceService.registerRoot(sourceRoot, project.id);
    f.repository.setConversationProject(f.session.id, project.id, f.repository.getConversation(f.session.id).version);
    const original = workspaceService.resolveExistingTarget.bind(workspaceService);
    vi.spyOn(workspaceService, "resolveExistingTarget").mockImplementation(async (...args) => {
      const target = await original(...args);
      renameSync(sourceRoot, `${sourceRoot}-moved`); symlinkSync(outside, sourceRoot, process.platform === "win32" ? "junction" : "dir");
      return target;
    });
    const service = new MediaService(f.repository, join(f.root, "guard-owned"), f.parser, { workspaceService });
    try {
      const result = await service.importPath({ sessionId: f.session.id, workspaceId: registration.workspace.id, path: "brief.pdf" });
      expect(result.imported).toEqual([]); expect(result.failed).toMatchObject([{ code: "MEDIA_CONTENT_INVALID" }]);
      expect(f.parser.parse).not.toHaveBeenCalled(); expect(service.list({ sessionId: f.session.id })).toEqual([]);
    } finally { await service.shutdown(); }
  });
  it("rechecks the actual Workspace grant at commit and rejects path traversal", async () => {
    const f = fixture(), sourceRoot = join(f.root, "project"); mkdirSync(sourceRoot); writeFileSync(join(sourceRoot, "brief.pdf"), "%PDF-1.7\nfixture");
    const project = f.repository.createProject("Media project"), workspace = await new WorkspaceService(f.repository).registerRoot(sourceRoot, project.id);
    f.repository.setConversationProject(f.session.id, project.id, f.repository.getConversation(f.session.id).version);
    const input = { sessionId: f.session.id, workspaceId: workspace.workspace.id, path: "brief.pdf" }, context = { executorBotId: f.bot.id };
    const prepared = await f.service.prepareImportPath(input, context);
    f.repository.setConversationProject(f.session.id, null, f.repository.getConversation(f.session.id).version);
    expect(() => f.service.commitImport(prepared, context)).toThrow(); expect(f.service.available()).toEqual([]);
    await expect(f.service.prepareImportPath({ ...input, path: "../app.sqlite" }, context)).rejects.toThrow();
  });
});

describe("private A/V admission and revocable voice bytes", () => {
  it("clones capture bytes before async work, persists duration and exposes raw bytes only to UI/private adapters", async () => {
    const { wavFixture } = await import("../../tests/fixtures/media-av-data");
    const f = fixture({ parse: async () => ({ kind: "audio", durationMs: 250, width: null, height: null, extraction: null, parserName: "controlled-codec", parserVersion: "1" }) });
    const bytes = wavFixture(), original = Buffer.from(bytes);
    const work = f.service.importBytes({ sessionId: f.session.id, bytes, mimeType: "audio/x-wav", name: "recording.wav", requiredKind: "audio" }); bytes.fill(0);
    const result = await work; expect(result.failed).toEqual([]); const item = result.imported[0]!;
    expect(item.asset).toMatchObject({ kind: "audio", durationMs: 250, reference: { mimeType: "audio/wav" } });
    const reopened = new AppRepository(f.filename);
    try { expect(reopened.media.metadata({ sessionId: f.session.id, id: item.asset.reference.id }).asset.durationMs).toBe(250); } finally { reopened.close(); }
    const input = { sessionId: f.session.id, id: item.asset.reference.id, reference: item.reference };
    const binary = await f.service.readBinary(input); expect(Buffer.from(binary.bytes)).toEqual(original); expect(binary.isAuthorized()).toBe(true);
    expect(Buffer.from((await f.service.previewForUi(input)).dataBase64, "base64")).toEqual(original);
    const modelRead = await f.service.read(input), modelPreview = await f.service.preview(input);
    expect(modelRead.images).toEqual([]); expect(modelRead.modelText).toBeUndefined(); expect(modelPreview.images).toEqual([]);
    expect(JSON.stringify(modelPreview)).not.toContain(original.toString("base64"));
    f.service.unbind(input); f.service.bind(input); expect(binary.isAuthorized()).toBe(false);
    const other = f.repository.createBot(); await expect(f.service.readBinary({ ...input, sessionId: other.session.id })).rejects.toMatchObject({ code: "MEDIA_NOT_GRANTED" });
  });
  it("starts six scoped captures before any parser returns and cancellation leaves five isolated publications", async () => {
    const { wavFixture } = await import("../../tests/fixtures/media-av-data");
    let started!: () => void, release!: () => void, entered = 0;
    const allStarted = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const f = fixture({ parse: async () => { if (++entered === 6) started(); await gate; return { kind: "audio", durationMs: 250, width: null, height: null, extraction: null, parserName: "controlled-codec", parserVersion: "1" }; } });
    const owners = Array.from({ length: 6 }, () => f.repository.createBot()), controllers = owners.map(() => new AbortController());
    const jobs = owners.map((owner, index) => f.service.importBytes({ sessionId: owner.session.id, bytes: wavFixture(), mimeType: "audio/wav", name: "own.wav", requiredKind: "audio" }, { signal: controllers[index]!.signal }));
    const cancelled = expect(jobs[2]).rejects.toMatchObject({ code: "TOOL_EXECUTION_CANCELLED" });
    await allStarted; controllers[2]!.abort(); release(); await cancelled;
    const results = await Promise.allSettled(jobs); expect(results.filter(result => result.status === "fulfilled")).toHaveLength(5);
    expect(owners.map(owner => f.service.list({ sessionId: owner.session.id }).length)).toEqual([1, 1, 0, 1, 1, 1]);
  });
  it("normalizes audio-only MP4 and rejects a valid video result before the required-audio capture publishes", async () => {
    const { mp4TrackFixture } = await import("../../tests/fixtures/media-av-data");
    const f = fixture({ parse: async input => ({ kind: input.bytes.at(-1) === 110 ? "audio" : "video", durationMs: 250, width: input.bytes.at(-1) === 110 ? null : 2, height: input.bytes.at(-1) === 110 ? null : 2, extraction: null, parserName: "controlled-codec", parserVersion: "1" }) });
    const input = { sessionId: f.session.id, bytes: mp4TrackFixture("vide"), mimeType: "video/mp4", name: "capture.mp4", requiredKind: "audio" as const };
    expect((await f.service.importBytes(input)).failed).toMatchObject([{ code: "MEDIA_CONTENT_INVALID" }]); expect(f.service.available()).toEqual([]);
    const item = (await f.service.importBytes({ ...input, bytes: mp4TrackFixture("soun") })).imported[0]!;
    expect(item.asset).toMatchObject({ kind: "audio", durationMs: 250, reference: { mimeType: "audio/mp4" } });
  });
  it("cancels a pending capture parser before atomic publish", async () => {
    const { wavFixture } = await import("../../tests/fixtures/media-av-data");
    let entered!: () => void, release!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const f = fixture({ parse: async () => { entered(); await gate; return { kind: "audio", durationMs: 250, width: null, height: null, extraction: null, parserName: "controlled-codec", parserVersion: "1" }; } }), controller = new AbortController();
    const work = f.service.importBytes({ sessionId: f.session.id, bytes: wavFixture(), mimeType: "audio/wav", name: "capture.wav", requiredKind: "audio" }, { signal: controller.signal });
    await started; controller.abort(); release(); await expect(work).rejects.toMatchObject({ code: "TOOL_EXECUTION_CANCELLED" }); expect(f.service.available()).toEqual([]);
  });
  it("rejects capture kind mismatch, duration/size/mime errors and cancellation before any publication", async () => {
    const { wavFixture } = await import("../../tests/fixtures/media-av-data");
    const f = fixture({ parse: async () => ({ kind: "video", durationMs: 250, width: 2, height: 2, extraction: null, parserName: "controlled-codec", parserVersion: "1" }) });
    const input = { sessionId: f.session.id, bytes: wavFixture(), mimeType: "audio/wav", name: "recording.wav", requiredKind: "audio" as const };
    expect((await f.service.importBytes(input)).failed).toMatchObject([{ code: "MEDIA_CONTENT_INVALID" }]);
    await expect(f.service.importBytes({ ...input, bytes: new Uint8Array(16_777_217) })).rejects.toMatchObject({ code: "MEDIA_IMPORT_TOO_LARGE" });
    await expect(f.service.importBytes({ ...input, mimeType: "audio/wav\n" })).rejects.toMatchObject({ code: "MEDIA_CONTENT_INVALID" });
    const controller = new AbortController(); controller.abort(); expect(() => f.service.importBytes(input, { signal: controller.signal })).toThrow();
    expect(f.service.available()).toEqual([]); expect(f.events).toEqual([]);
  });
});
