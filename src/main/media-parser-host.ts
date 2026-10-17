import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { BrowserWindow, ipcMain, protocol, session, type IpcMainEvent } from "electron";
import { z } from "zod";
import { mediaSpanSchema, mediaTextSchema, supportedMediaMimeSchema } from "@shared/media-schemas";
import { MEDIA_PARSER_CHANNEL, MEDIA_PARSER_INPUT, MEDIA_PARSER_NAME, MEDIA_PARSER_SCHEME, MEDIA_PARSER_VERSION, PARSER_ERROR_CODES, PARSER_LIMITS, type ParserAsset, type ParserManifest } from "@shared/media-parser-protocol";
import { imageDimensions } from "../media-parser/image-headers";
import type { MediaParserAdapter, MediaParserInput, MediaParseResult, MediaPreviewPixels } from "./media-parser-types";
import { AevorenBotError } from "./errors";

let registered = false;
export function registerMediaParserScheme(): void {
  if (registered) return;
  protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_PARSER_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
  registered = true;
}
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const dimension = z.number().int().min(1).max(PARSER_LIMITS.pixels);
const extractionSchema = z.object({ text: mediaTextSchema, spans: z.array(mediaSpanSchema).min(1).max(PARSER_LIMITS.pages), warningCodes: z.array(z.enum(["PDF_NO_TEXT", "PDF_NO_OCR"])).max(2) }).strict();
const resultSchema = z.object({ kind: z.enum(["image", "pdf", "docx"]), width: dimension.nullable(), height: dimension.nullable(), extraction: extractionSchema.nullable(), parserName: z.string().max(100), parserVersion: z.string().max(200) }).strict();
const manifestSchema = z.object({ protocolVersion: z.literal(1), parserName: z.literal(MEDIA_PARSER_NAME), parserVersion: z.literal(MEDIA_PARSER_VERSION), applicationVersion: z.string().min(1).max(100), entry: z.literal("index.html"), preload: z.literal("private/preload.cjs"), files: z.array(z.object({ path: z.string().min(1).max(250), route: z.string().min(1).max(250).nullable(), mimeType: z.string().min(1).max(100), size: z.number().int().min(1).max(16_777_216), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()).min(1).max(400) }).strict();
const csp = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src blob:; font-src 'self' blob:; style-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** One fresh, unprivileged Renderer/session per job. No business permission or CAS paths enter it. */
export class MediaParserHost implements MediaParserAdapter {
  private closed = false;
  private readonly jobs = new Set<{ controller: AbortController; done: Promise<unknown> }>();
  constructor(private readonly options: { directory: string }) {}

  parse(input: MediaParserInput, signal: AbortSignal): Promise<MediaParseResult> {
    return this.start(input, signal, "parse") as Promise<MediaParseResult>;
  }
  renderPdfPage(input: MediaParserInput & { pageIndex: number }, signal: AbortSignal): Promise<MediaPreviewPixels> {
    if (input.mimeType !== "application/pdf" || !Number.isInteger(input.pageIndex) || input.pageIndex < 0 || input.pageIndex >= PARSER_LIMITS.pages) return Promise.reject(new AevorenBotError("MEDIA_CONTENT_INVALID"));
    return this.start(input, signal, "pdf-preview", input.pageIndex) as Promise<MediaPreviewPixels>;
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    const jobs = [...this.jobs];
    for (const job of jobs) job.controller.abort();
    await Promise.allSettled(jobs.map(job => job.done));
  }
  private start(input: MediaParserInput, external: AbortSignal, operation: "parse" | "pdf-preview", pageIndex?: number): Promise<MediaParseResult | MediaPreviewPixels> {
    if (this.closed) return Promise.reject(new AevorenBotError("MEDIA_PARSER_UNAVAILABLE"));
    if (!(input.bytes instanceof Uint8Array)) return Promise.reject(new AevorenBotError("MEDIA_CONTENT_INVALID"));
    const owned = { mimeType: input.mimeType, sha256: input.sha256, bytes: new Uint8Array(input.bytes) };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new AevorenBotError("MEDIA_PARSE_TIMEOUT")), PARSER_LIMITS.timeoutMs);
    const cancel = (): void => controller.abort();
    external.addEventListener("abort", cancel, { once: true });
    if (external.aborted) controller.abort();
    const job = { controller, done: Promise.resolve() as Promise<unknown> };
    job.done = this.run(owned, controller.signal, operation, pageIndex).finally(() => { clearTimeout(timeout); external.removeEventListener("abort", cancel); this.jobs.delete(job); });
    this.jobs.add(job);
    return job.done as Promise<MediaParseResult | MediaPreviewPixels>;
  }
  private async asset(manifest: ParserManifest, asset: ParserAsset, signal?: AbortSignal): Promise<Uint8Array> {
    const root = await realpath(this.options.directory);
    if (!/^[A-Za-z0-9_./-]+$/u.test(asset.path) || asset.path.split("/").some(part => !part || part === "." || part === "..")) throw new AevorenBotError("MEDIA_PARSER_UNAVAILABLE");
    const target = resolve(root, asset.path);
    const stat = await lstat(target);
    if (!target.startsWith(`${root}${sep}`) || !stat.isFile() || stat.isSymbolicLink() || stat.size !== asset.size || await realpath(target) !== target) throw new AevorenBotError("MEDIA_PARSER_UNAVAILABLE");
    const bytes = await readFile(target, { signal });
    if (bytes.length !== asset.size || sha256(bytes) !== asset.sha256 || manifest.parserVersion !== MEDIA_PARSER_VERSION) throw new AevorenBotError("MEDIA_PARSER_UNAVAILABLE");
    return bytes;
  }
  private validate(input: MediaParserInput): void {
    supportedMediaMimeSchema.parse(input.mimeType);
    if (!(input.bytes instanceof Uint8Array) || !input.bytes.length || sha256(input.bytes) !== input.sha256) throw new AevorenBotError("MEDIA_CONTENT_INVALID");
    const max = input.mimeType === "application/pdf" ? PARSER_LIMITS.pdfBytes : input.mimeType.startsWith("image/") ? PARSER_LIMITS.imageBytes : PARSER_LIMITS.docxBytes;
    if (input.bytes.length > max) throw new AevorenBotError("MEDIA_IMPORT_TOO_LARGE");
  }
  private async run(input: MediaParserInput, signal: AbortSignal, operation: "parse" | "pdf-preview", pageIndex?: number): Promise<MediaParseResult | MediaPreviewPixels> {
    signal.throwIfAborted(); this.validate(input);
    let manifest: ParserManifest;
    try {
      const manifestPath = join(this.options.directory, "manifest.json"), stat = await lstat(manifestPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262_144) throw new Error("manifest budget");
      const bytes = await readFile(manifestPath, { signal });
      if (bytes.length > 262_144) throw new Error("manifest budget");
      manifest = manifestSchema.parse(JSON.parse(bytes.toString("utf8")));
      if (new Set(manifest.files.map(file => file.path)).size !== manifest.files.length || new Set(manifest.files.filter(file => file.route).map(file => file.route)).size !== manifest.files.filter(file => file.route).length) throw new Error("duplicate asset");
      await Promise.all(manifest.files.map(file => this.asset(manifest, file, signal)));
    } catch { signal.throwIfAborted(); throw new AevorenBotError("MEDIA_PARSER_UNAVAILABLE"); }
    signal.throwIfAborted();
    const nonce = randomUUID(), origin = `${MEDIA_PARSER_SCHEME}://${nonce}`, url = `${origin}/${manifest.entry}`;
    const publicAssets = new Map(manifest.files.filter(file => file.route !== null && file.path === `public/${file.route}`).map(file => [`${origin}/${file.route}`, file]));
    const preload = manifest.files.find(file => file.path === manifest.preload && file.route === null);
    if (!preload || !publicAssets.has(url)) throw new AevorenBotError("MEDIA_PARSER_UNAVAILABLE");
    const ownedSession = session.fromPartition(`media-parser-${nonce}`, { cache: false });
    const allowed = (value: string): boolean => publicAssets.has(value);
    ownedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ownedSession.setPermissionCheckHandler(() => false);
    ownedSession.setDevicePermissionHandler(() => false);
    ownedSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    ownedSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => callback({ cancel: !allowed(details.url) }));
    ownedSession.on("will-download", event => event.preventDefault());
    await ownedSession.protocol.handle(MEDIA_PARSER_SCHEME, async request => {
      const asset = publicAssets.get(request.url);
      if (request.method !== "GET" || !asset) return new Response(null, { status: 403 });
      try { return new Response(await this.asset(manifest, asset, signal) as BodyInit, { headers: { "Content-Type": asset.mimeType, "Content-Security-Policy": csp, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" } }); }
      catch { return new Response(null, { status: 503 }); }
    });
    const window = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { session: ownedSession, preload: join(this.options.directory, manifest.preload), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, backgroundThrottling: false, spellcheck: false } });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", event => event.preventDefault());
    window.webContents.on("will-frame-navigate", event => event.preventDefault());
    window.webContents.on("will-attach-webview", event => event.preventDefault());
    let listener: ((event: IpcMainEvent, packet: unknown) => void) | undefined;
    let abort: (() => void) | undefined;
    try {
      return await new Promise<MediaParseResult | MediaPreviewPixels>((resolveResult, reject) => {
        let settled = false, sent = false;
        const fail = (error: unknown): void => { if (!settled) { settled = true; reject(error); } };
        abort = () => fail(signal.reason ?? new DOMException("Media parsing cancelled", "AbortError"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) { abort(); return; }
        window.webContents.once("render-process-gone", () => fail(new AevorenBotError("MEDIA_PARSE_FAILED")));
        window.once("closed", () => fail(new AevorenBotError("MEDIA_PARSE_FAILED")));
        listener = (event, value) => {
          if (settled || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== url) return;
          if (!value || typeof value !== "object" || !("nonce" in value) || value.nonce !== nonce || !("type" in value)) { fail(new AevorenBotError("MEDIA_CONTENT_INVALID")); return; }
          if (value.type === "ready" && !sent) { sent = true; window.webContents.send(MEDIA_PARSER_INPUT, { ...input, bytes: new Uint8Array(input.bytes), nonce, operation, ...(pageIndex !== undefined ? { pageIndex } : {}) }); return; }
          if (!sent || !("sha256" in value) || value.sha256 !== input.sha256) { fail(new AevorenBotError("MEDIA_CONTENT_INVALID")); return; }
          if (value.type === "error" && "code" in value && PARSER_ERROR_CODES.includes(value.code as typeof PARSER_ERROR_CODES[number])) { fail(new AevorenBotError(value.code as typeof PARSER_ERROR_CODES[number])); return; }
          if (value.type !== "result" || !("result" in value)) { fail(new AevorenBotError("MEDIA_CONTENT_INVALID")); return; }
          try {
            const result = operation === "parse" ? this.checkedResult(input, value.result) : this.checkedPixels(value.result);
            settled = true; resolveResult(result);
          } catch { fail(new AevorenBotError("MEDIA_CONTENT_INVALID")); }
        };
        ipcMain.on(MEDIA_PARSER_CHANNEL, listener);
        void window.loadURL(url).catch(() => fail(new AevorenBotError("MEDIA_PARSER_UNAVAILABLE")));
      });
    } finally {
      if (listener) ipcMain.removeListener(MEDIA_PARSER_CHANNEL, listener);
      if (abort) signal.removeEventListener("abort", abort);
      if (!window.isDestroyed()) window.destroy();
      ownedSession.protocol.unhandle(MEDIA_PARSER_SCHEME);
      await ownedSession.closeAllConnections();
      await ownedSession.clearStorageData();
    }
  }
  private checkedResult(input: MediaParserInput, value: unknown): MediaParseResult {
    const result = resultSchema.parse(value), kind = input.mimeType === "application/pdf" ? "pdf" : input.mimeType.startsWith("image/") ? "image" : "docx";
    if (result.kind !== kind) throw new Error("kind");
    if (kind === "image") {
      const expected = imageDimensions(input.bytes, input.mimeType);
      if (!result.width || !result.height || result.width * result.height > PARSER_LIMITS.pixels || result.extraction !== null
        || !((result.width === expected.width && result.height === expected.height) || (result.width === expected.height && result.height === expected.width))) throw new Error("dimensions");
    } else {
      if (result.width !== null || result.height !== null || !result.extraction) throw new Error("extraction");
      let end = 0;
      for (const [index, span] of result.extraction.spans.entries()) {
        if (span.index !== index || span.kind !== (kind === "pdf" ? "page" : "section") || span.start < end || span.end > result.extraction.text.length) throw new Error("spans");
        end = span.end;
      }
    }
    return { ...result, parserName: MEDIA_PARSER_NAME, parserVersion: MEDIA_PARSER_VERSION };
  }
  private checkedPixels(value: unknown): MediaPreviewPixels {
    const result = z.object({ bytes: z.instanceof(Uint8Array), width: dimension, height: dimension, mimeType: z.enum(["image/png", "image/jpeg"]) }).strict().parse(value);
    const actual = imageDimensions(result.bytes, result.mimeType);
    if (!result.bytes.length || result.bytes.length > PARSER_LIMITS.imageBytes || result.width * result.height > PARSER_LIMITS.pixels || actual.width !== result.width || actual.height !== result.height) throw new Error("pixels");
    return result;
  }
}
