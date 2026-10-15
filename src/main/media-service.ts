import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { MediaAsset, MediaAvailableInput, MediaBindingInput, MediaChangedEvent, MediaImportPathInput, MediaImportResult,
  MediaItem, MediaListInput, MediaMutationInput, MediaPreview, MediaPreviewInput, MediaPreviewMetadata, MediaReadInput,
  MediaReadMetadata, MediaScope, MediaTextPage, SupportedMediaMime } from "@shared/media-contracts";
import { MEDIA_DOCX_MAX_BYTES, MEDIA_IMAGE_MAX_BYTES, MEDIA_IMPORT_MAX_BYTES, MEDIA_MAX_FILES, MEDIA_MAX_IMAGE_PIXELS,
  MEDIA_MAX_PDF_PAGES, MEDIA_PARSE_TIMEOUT_MS, MEDIA_TEXT_MAX_BYTES, mediaImportPathSchema, mediaPreviewSchema, mediaReadSchema, mediaSpanSchema, mediaTextSchema } from "@shared/media-schemas";
import type { AppRepository } from "./database";
import { AevorenBotError } from "./errors";
import { assertMediaNotCancelled, MediaBlobStore, readMediaSource } from "./media-blob-store";
import type { MediaParseResult, MediaParserAdapter } from "./media-parser-types";
import { mediaExtractionDigest, type MediaReadLease, type MediaRuntimeScope, type StoredMediaImport } from "./media-repository";
import type { ModelImageAttachment, ModelTextAttachment } from "./model-image";
import type { WorkspaceService } from "./workspace-service";

export type MediaExecutionContext = { executorBotId?: string; runtimeRunId?: string; signal?: AbortSignal; assertCurrent?: () => void };
export type MediaServiceOptions = { workspaceService?: WorkspaceService;
  authorizeWorkspacePath?: (input: MediaImportPathInput, executorBotId: string) => Promise<string>;
  onChanged?: (event: MediaChangedEvent) => void };
export type PreparedMediaImport = Readonly<{ sessionId: string; accepted: { name: string; mimeType: string; size: number; sha256: string }[]; failed: MediaImportResult["failed"] }>;
export type MediaModelRead = { metadata: MediaReadMetadata; modelText?: ModelTextAttachment; images: ModelImageAttachment[] };
type Prepared = { sessionId: string; values: StoredMediaImport[]; failed: MediaImportResult["failed"]; context: MediaExecutionContext; checkAccess?: () => void };
type ReadAccess = { current(): ReturnType<AppRepository["media"]["resolveUiLease"]>; authorized(): boolean };

function nameFor(path: string): string { return Array.from(basename(path)).filter(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127).join("").slice(0, 120) || "media"; }
function mimeFor(bytes: Buffer): SupportedMediaMime {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217) return "image/jpeg";
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  throw new AevorenBotError("MEDIA_UNSUPPORTED");
}
function dimensions(width: number | null, height: number | null): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width! < 1 || height! < 1 || width! * height! > MEDIA_MAX_IMAGE_PIXELS)
    throw new AevorenBotError("MEDIA_IMPORT_TOO_LARGE");
}
function validateParsed(result: MediaParseResult, mimeType: SupportedMediaMime): void {
  if (!result.parserName || result.parserName.length > 100 || !result.parserVersion || result.parserVersion.length > 100
    || result.kind !== (mimeType.startsWith("image/") ? "image" : mimeType === "application/pdf" ? "pdf" : "docx")) throw new AevorenBotError("MEDIA_CONTENT_INVALID");
  if (result.kind === "image") { dimensions(result.width, result.height); if (result.extraction) throw new AevorenBotError("MEDIA_CONTENT_INVALID"); return; }
  if (result.width !== null || result.height !== null || !result.extraction) throw new AevorenBotError("MEDIA_CONTENT_INVALID");
  const e = result.extraction;
  if (Buffer.byteLength(e.text, "utf8") > MEDIA_TEXT_MAX_BYTES) throw new AevorenBotError("MEDIA_IMPORT_TOO_LARGE");
  if (!mediaTextSchema.safeParse(e.text).success) throw new AevorenBotError("MEDIA_CONTENT_INVALID");
  if (e.spans.length < 1 || (result.kind === "pdf" && e.spans.length > MEDIA_MAX_PDF_PAGES) || e.spans.length > 2_000
    || e.warningCodes.length > 50 || e.warningCodes.some(code => !/^[A-Z0-9_]{1,80}$/u.test(code))) throw new AevorenBotError("MEDIA_CONTENT_INVALID");
  let previous = 0;
  for (const [index, raw] of e.spans.entries()) {
    const span = mediaSpanSchema.parse(raw);
    if (span.kind !== (result.kind === "pdf" ? "page" : "section") || span.index !== index || span.start < previous || span.end > e.text.length)
      throw new AevorenBotError("MEDIA_CONTENT_INVALID");
    previous = span.end;
  }
}

export class MediaService {
  private readonly blobs: MediaBlobStore;
  private readonly prepared = new WeakMap<PreparedMediaImport, Prepared>();
  private readonly lifetime = new AbortController();
  private readonly jobs = new Set<{ sessionId: string; mediaId?: string; controller: AbortController; promise: Promise<unknown> }>();
  private closing: Promise<void> | undefined;
  constructor(private readonly repository: AppRepository, blobRoot: string, private readonly parser: MediaParserAdapter, private readonly options: MediaServiceOptions = {}) {
    this.blobs = new MediaBlobStore(blobRoot);
  }
  private check(sessionId: string, context: MediaExecutionContext): void {
    assertMediaNotCancelled(this.lifetime.signal); assertMediaNotCancelled(context.signal); context.assertCurrent?.();
    const session = this.repository.getSession(sessionId);
    if (session.roomId && this.repository.getRoom(session.roomId).archivedAt) throw new AevorenBotError("ROOM_ARCHIVED");
    if (context.executorBotId) this.repository.assertSessionExecutor(sessionId, context.executorBotId);
    if (context.runtimeRunId) {
      if (!context.executorBotId) throw new AevorenBotError("MEDIA_NOT_GRANTED");
      this.repository.media.assertRuntime({ sessionId, executorBotId: context.executorBotId, runtimeRunId: context.runtimeRunId });
    }
  }
  private track<T>(sessionId: string, mediaId: string | undefined, context: MediaExecutionContext, work: (context: MediaExecutionContext) => Promise<T>): Promise<T> {
    this.check(sessionId, context);
    const controller = new AbortController(), signal = AbortSignal.any([this.lifetime.signal, controller.signal, ...(context.signal ? [context.signal] : [])]);
    const current = { ...context, signal };
    const promise = Promise.resolve().then(() => work(current)).catch(error => { this.check(sessionId, current); throw error; });
    const job = { sessionId, mediaId, controller, promise };
    this.jobs.add(job);
    void promise.finally(() => this.jobs.delete(job)).catch(() => undefined);
    return promise;
  }
  private async parseJob<T>(context: MediaExecutionContext, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController(), signal = AbortSignal.any([context.signal!, controller.signal]);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, MEDIA_PARSE_TIMEOUT_MS);
    try { const result = await work(signal); if (timedOut) throw new AevorenBotError("MEDIA_PARSE_TIMEOUT"); return result; }
    catch (error) { if (timedOut) throw new AevorenBotError("MEDIA_PARSE_TIMEOUT"); throw error; }
    finally { clearTimeout(timer); }
  }
  private changed(sessionId: string, mediaId: string, action: MediaChangedEvent["action"], cancel = false, allSessions = false): void {
    if (cancel) for (const job of this.jobs) if (job.mediaId === mediaId && (allSessions || job.sessionId === sessionId)) job.controller.abort();
    this.options.onChanged?.({ sessionId, mediaId, action });
  }
  list(input: MediaListInput, context: MediaExecutionContext = {}): MediaItem[] {
    this.check(input.sessionId, context);
    return context.runtimeRunId ? this.repository.media.listRuntimeItems({ sessionId: input.sessionId, executorBotId: context.executorBotId!, runtimeRunId: context.runtimeRunId }, input)
      : this.repository.media.list(input, context.executorBotId);
  }
  available(input: MediaAvailableInput = {}): MediaItem[] { assertMediaNotCancelled(this.lifetime.signal); return this.repository.media.available(input); }
  metadata(input: MediaScope & { id: string }, context: MediaExecutionContext = {}): MediaItem {
    this.check(input.sessionId, context);
    if (context.runtimeRunId) return this.repository.media.resolveRuntimeRead({ sessionId: input.sessionId, executorBotId: context.executorBotId!, runtimeRunId: context.runtimeRunId }, input.id).item;
    return this.repository.media.metadata(input, context.executorBotId);
  }
  bind(input: MediaBindingInput, context: MediaExecutionContext = {}) {
    this.check(input.sessionId, context); const result = this.repository.media.bind(input, context.executorBotId);
    this.changed(input.sessionId, input.id, "bound"); return result;
  }
  unbind(input: MediaBindingInput, context: MediaExecutionContext = {}): boolean {
    this.check(input.sessionId, context); const result = this.repository.media.unbind(input, context.executorBotId);
    if (result) this.changed(input.sessionId, input.id, "unbound", true); return result;
  }
  private mutate(input: MediaMutationInput, action: "enabled" | "deleted" | "restored", context: MediaExecutionContext, enabled?: boolean): MediaAsset {
    this.check(input.sessionId, context); const result = this.repository.media.mutate(input, action, enabled, context.executorBotId);
    this.changed(input.sessionId, input.id, action, true, true); return result;
  }
  setEnabled(input: MediaMutationInput & { enabled: boolean }, context: MediaExecutionContext = {}): MediaAsset {
    const { enabled, ...mutation } = input; return this.mutate(mutation, "enabled", context, enabled);
  }
  delete(input: MediaMutationInput, context: MediaExecutionContext = {}): MediaAsset { return this.mutate(input, "deleted", context); }
  restore(input: MediaMutationInput, context: MediaExecutionContext = {}): MediaAsset { return this.mutate(input, "restored", context); }

  /** Host-only: caller supplies picker paths, or paths resolved by WorkspaceService. */
  prepareImportPaths(sessionId: string, paths: readonly string[], context: MediaExecutionContext = {}, checkAccess?: () => void): Promise<PreparedMediaImport> {
    return this.track(sessionId, undefined, context, async current => {
      const check = (): void => { this.check(sessionId, current); checkAccess?.(); };
      if (!paths.length || paths.length > MEDIA_MAX_FILES) throw new AevorenBotError("MEDIA_IMPORT_TOO_LARGE");
      const values: StoredMediaImport[] = [], failed: MediaImportResult["failed"] = [];
      let total = 0;
      for (const supplied of paths) {
        check(); const name = nameFor(supplied);
        try {
          const path = resolve(supplied);
          // WorkspaceService already returned a contained canonical target. Do
          // not follow a parent link swapped after that authorization check.
          const canonical = checkAccess ? path : join(await realpath(dirname(path)), basename(path)); check();
          const bytes = await readMediaSource(canonical, check); check();
          total += bytes.length;
          const mimeType = mimeFor(bytes);
          if (total > MEDIA_IMPORT_MAX_BYTES || (mimeType.startsWith("image/") && bytes.length > MEDIA_IMAGE_MAX_BYTES)
            || (mimeType.includes("wordprocessingml") && bytes.length > MEDIA_DOCX_MAX_BYTES)) throw new AevorenBotError("MEDIA_IMPORT_TOO_LARGE");
          const sha256 = await this.blobs.put(bytes, current.signal); check();
          const parsed = await this.parseJob(current, signal => this.parser.parse({ bytes, mimeType, sha256 }, signal));
          check(); validateParsed(parsed, mimeType);
          const id = randomUUID(), e = parsed.extraction;
          const extraction = e ? { id: randomUUID(), mediaId: id, sourceSha256: sha256, parserName: parsed.parserName, parserVersion: parsed.parserVersion,
            ...structuredClone(e), digest: mediaExtractionDigest({ sourceSha256: sha256, parserName: parsed.parserName, parserVersion: parsed.parserVersion, ...e }) } : null;
          values.push({ asset: { reference: { id, name, size: bytes.length, mimeType, sha256 }, kind: parsed.kind, width: parsed.width, height: parsed.height }, extraction });
        } catch (error) {
          check();
          if (error instanceof AevorenBotError && !error.code.startsWith("MEDIA_")) throw error;
          const safe = error instanceof AevorenBotError ? error : new AevorenBotError("MEDIA_PARSE_FAILED");
          failed.push({ name, code: safe.code, reason: new AevorenBotError(safe.code).message });
        }
      }
      check();
      const token: PreparedMediaImport = Object.freeze({ sessionId, accepted: values.map(value => ({ name: value.asset.reference.name,
        mimeType: value.asset.reference.mimeType, size: value.asset.reference.size, sha256: value.asset.reference.sha256 })), failed: structuredClone(failed) });
      this.prepared.set(token, { sessionId, values, failed, context, checkAccess }); return token;
    });
  }
  async prepareImportPath(input: MediaImportPathInput, context: MediaExecutionContext = {}): Promise<PreparedMediaImport> {
    const parsed = mediaImportPathSchema.parse(input); this.check(parsed.sessionId, context);
    const session = this.repository.getSession(parsed.sessionId), executorBotId = context.executorBotId ?? session.botId
      ?? (session.roomId ? this.repository.getRoomDetail(session.roomId).members[0]?.botId : undefined);
    if (!executorBotId) throw new AevorenBotError("MEDIA_NOT_GRANTED");
    const check = (): void => { this.check(parsed.sessionId, context); this.repository.assertSessionWorkspaceAccess(parsed.sessionId, executorBotId, parsed.workspaceId); };
    check();
    const path = this.options.authorizeWorkspacePath ? await this.options.authorizeWorkspacePath(parsed, executorBotId)
      : this.options.workspaceService ? (await this.options.workspaceService.resolveExistingTarget(parsed.workspaceId, parsed.path, "file")).canonicalPath
        : (() => { throw new AevorenBotError("WORKSPACE_NOT_FOUND"); })();
    check(); return this.prepareImportPaths(parsed.sessionId, [path], context, check);
  }
  commitImport(token: PreparedMediaImport, context: MediaExecutionContext = {}): MediaImportResult {
    const value = this.prepared.get(token);
    if (!value || value.context.executorBotId !== context.executorBotId || value.context.runtimeRunId !== context.runtimeRunId) throw new AevorenBotError("MEDIA_CONTENT_INVALID");
    this.prepared.delete(token);
    this.check(value.sessionId, value.context); this.check(value.sessionId, context); value.checkAccess?.();
    const imported = this.repository.media.publishImport(value.sessionId, value.values, context.executorBotId, context.runtimeRunId);
    for (const item of imported) this.changed(value.sessionId, item.asset.reference.id, "created");
    return { imported, failed: value.failed };
  }
  async importPaths(sessionId: string, paths: readonly string[], context: MediaExecutionContext = {}): Promise<MediaImportResult> {
    return this.commitImport(await this.prepareImportPaths(sessionId, paths, context), context);
  }
  async importPath(input: MediaImportPathInput, context: MediaExecutionContext = {}): Promise<MediaImportResult> {
    return this.commitImport(await this.prepareImportPath(input, context), context);
  }
  private access(input: MediaScope & { id: string; reference?: MediaReadInput["reference"] }, context: MediaExecutionContext): ReadAccess {
    this.check(input.sessionId, context);
    const scope: MediaRuntimeScope | null = context.runtimeRunId ? { sessionId: input.sessionId, executorBotId: context.executorBotId!, runtimeRunId: context.runtimeRunId } : null;
    const lease: MediaReadLease | null = scope ? null : this.repository.media.captureUiLease(input, context.executorBotId);
    const current = (): ReturnType<AppRepository["media"]["resolveUiLease"]> => {
      this.check(input.sessionId, context);
      return scope ? this.repository.media.resolveRuntimeRead(scope, input.id, input.reference) : this.repository.media.resolveUiLease(lease!);
    };
    current(); return { current, authorized: () => { try { current(); return true; } catch { return false; } } };
  }
  private textPage(input: MediaReadInput, access: ReadAccess): MediaTextPage {
    const { item, extraction } = access.current(), text = extraction?.text ?? "", offset = Math.min(input.offset ?? 0, text.length);
    const end = Math.min(text.length, offset + (input.maxCharacters ?? 12_000));
    return { item, offset, nextOffset: end < text.length ? end : null, totalCharacters: text.length,
      spans: extraction?.spans.filter(span => span.end >= offset && span.start <= end) ?? [], text: text.slice(offset, end) };
  }
  async read(input: MediaReadInput, context: MediaExecutionContext = {}): Promise<MediaModelRead> {
    const parsed = mediaReadSchema.parse(input);
    return this.track(parsed.sessionId, parsed.id, context, async current => {
      const access = this.access(parsed, current), { text, ...metadata } = this.textPage(parsed, access);
      const images: ModelImageAttachment[] = [];
      if (metadata.item.asset.kind === "image") {
        const reference = metadata.item.asset.reference, bytes = await this.blobs.read(reference.sha256, reference.size, current.signal); access.current();
        images.push({ origin: "media", reference, dataBase64: bytes.toString("base64"), isAuthorized: access.authorized });
      }
      access.current(); return { metadata, ...(metadata.item.extraction ? { modelText: { text, isAuthorized: access.authorized } } : {}), images };
    });
  }
  async readForUi(input: MediaReadInput, context: MediaExecutionContext = {}): Promise<MediaTextPage> {
    const parsed = mediaReadSchema.parse(input); const access = this.access(parsed, context); return this.textPage(parsed, access);
  }
  private async previewPixels(input: MediaPreviewInput, context: MediaExecutionContext): Promise<{ metadata: MediaPreviewMetadata; image: ModelImageAttachment }> {
    const access = this.access(input, context), { item } = access.current(), source = item.asset.reference;
    if (item.asset.kind === "docx") throw new AevorenBotError("MEDIA_UNSUPPORTED");
    const bytes = await this.blobs.read(source.sha256, source.size, context.signal); access.current();
    if (item.asset.kind === "image") return { metadata: { sourceReference: item.reference, image: source, width: item.asset.width!, height: item.asset.height!, pageIndex: null },
      image: { origin: "media", reference: source, dataBase64: bytes.toString("base64"), isAuthorized: access.authorized } };
    const pageIndex = input.pageIndex ?? 0;
    if (pageIndex >= (item.extraction?.spanCount ?? 0)) throw new AevorenBotError("MEDIA_REFERENCE_INVALID");
    const pixels = await this.parseJob(context, signal => this.parser.renderPdfPage({ bytes, mimeType: "application/pdf", sha256: source.sha256, pageIndex }, signal)); access.current();
    dimensions(pixels.width, pixels.height);
    const imageBytes = Buffer.from(pixels.bytes);
    if (imageBytes.length > MEDIA_IMAGE_MAX_BYTES || mimeFor(imageBytes) !== pixels.mimeType) throw new AevorenBotError("MEDIA_CONTENT_INVALID");
    const sha256 = await this.blobs.put(imageBytes, context.signal); access.current();
    const image = { id: randomUUID(), name: `${source.name.slice(0, 90)}.page-${pageIndex + 1}.${pixels.mimeType === "image/png" ? "png" : "jpg"}`,
      mimeType: pixels.mimeType, size: imageBytes.length, sha256 };
    return { metadata: { sourceReference: item.reference, image, width: pixels.width, height: pixels.height, pageIndex },
      image: { origin: "media", reference: image, dataBase64: imageBytes.toString("base64"), isAuthorized: access.authorized } };
  }
  preview(input: MediaPreviewInput, context: MediaExecutionContext = {}): Promise<{ metadata: MediaPreviewMetadata; images: ModelImageAttachment[] }> {
    const parsed = mediaPreviewSchema.parse(input);
    return this.track(parsed.sessionId, parsed.id, context, async current => { const result = await this.previewPixels(parsed, current); return { metadata: result.metadata, images: [result.image] }; });
  }
  previewForUi(input: MediaPreviewInput, context: MediaExecutionContext = {}): Promise<MediaPreview> {
    const parsed = mediaPreviewSchema.parse(input);
    return this.track(parsed.sessionId, parsed.id, context, async current => { const result = await this.previewPixels(parsed, current); return { ...result.metadata, dataBase64: result.image.dataBase64 }; });
  }
  shutdown(): Promise<void> {
    if (!this.closing) {
      this.lifetime.abort(); for (const job of this.jobs) job.controller.abort();
      this.closing = (async () => { try { await this.parser.shutdown(); } finally { await Promise.allSettled([...this.jobs].map(job => job.promise)); } })();
    }
    return this.closing;
  }
}
