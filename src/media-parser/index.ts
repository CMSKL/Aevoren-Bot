import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import type { MediaParseResult, MediaPreviewPixels } from "../main/media-parser-types";
import { MEDIA_PARSER_NAME, MEDIA_PARSER_VERSION, PARSER_ERROR_CODES, PARSER_LIMITS, type ParserBridge, type ParserRequest } from "../shared/media-parser-protocol";
import { imageDimensions } from "./image-headers";
import { extractDocx } from "./docx";

declare global { interface Window { mediaParser: ParserBridge } }
function fail(code = "MEDIA_CONTENT_INVALID"): never { throw new Error(code); }
function textBudget(text: string): void { const encoded = new TextEncoder().encode(text); if (new TextDecoder("utf-8", { fatal: true }).decode(encoded) !== text || encoded.length > PARSER_LIMITS.textBytes) fail("MEDIA_IMPORT_TOO_LARGE"); }
function pixelBudget(width: number, height: number): void { if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > PARSER_LIMITS.pixels) fail("MEDIA_IMPORT_TOO_LARGE"); }
const result = (kind: MediaParseResult["kind"], extraction: MediaParseResult["extraction"], width: number | null = null, height: number | null = null): MediaParseResult => ({ kind, width, height, extraction, parserName: MEDIA_PARSER_NAME, parserVersion: MEDIA_PARSER_VERSION });

async function pdf(request: ParserRequest): Promise<MediaParseResult | MediaPreviewPixels> {
  if (new TextDecoder().decode(request.bytes.subarray(0, 5)) !== "%PDF-") fail();
  const base = new URL("./pdfjs/", location.href);
  const worker = new Worker(new URL("pdf.worker.mjs", base), { type: "module" });
  GlobalWorkerOptions.workerPort = worker;
  const loading = getDocument({ data: new Uint8Array(request.bytes), stopAtErrors: true, enableXfa: false, useWorkerFetch: true,
    cMapUrl: new URL("cmaps/", base).href, cMapPacked: true, standardFontDataUrl: new URL("standard_fonts/", base).href,
    wasmUrl: new URL("wasm/", base).href, iccUrl: new URL("iccs/", base).href,
    maxImageSize: PARSER_LIMITS.pixels, canvasMaxAreaInBytes: PARSER_LIMITS.pixels * 4, useSystemFonts: false });
  try {
    const document = await loading.promise;
    if (document.numPages < 1 || document.numPages > PARSER_LIMITS.pages) fail("MEDIA_IMPORT_TOO_LARGE");
    if (request.operation === "pdf-preview") {
      const index = request.pageIndex;
      if (index === undefined || !Number.isInteger(index) || index < 0 || index >= document.numPages) fail();
      const page = await document.getPage(index + 1), original = page.getViewport({ scale: 1 });
      if (!Number.isFinite(original.width) || !Number.isFinite(original.height) || original.width <= 0 || original.height <= 0) fail();
      const scale = Math.min(2, 1600 / Math.max(original.width, original.height), Math.sqrt(PARSER_LIMITS.pixels / (original.width * original.height)));
      const viewport = page.getViewport({ scale });
      const canvas = documentCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvas, viewport, background: "rgb(255,255,255)" }).promise;
      let blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
      if (!blob) fail("MEDIA_PARSE_FAILED");
      if (blob.size > PARSER_LIMITS.imageBytes) blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.8));
      if (!blob || blob.size > PARSER_LIMITS.imageBytes) fail("MEDIA_IMPORT_TOO_LARGE");
      return { bytes: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height, mimeType: blob.type === "image/jpeg" ? "image/jpeg" : "image/png" };
    }
    let text = "", textBytes = 0;
    const append = (part: string): void => { textBytes += new TextEncoder().encode(part).length; if (textBytes > PARSER_LIMITS.textBytes) fail("MEDIA_IMPORT_TOO_LARGE"); text += part; };
    const spans: NonNullable<MediaParseResult["extraction"]>["spans"] = [];
    for (let index = 0; index < document.numPages; index += 1) {
      const page = await document.getPage(index + 1), reader = page.streamTextContent().getReader();
      if (index) append("\n\n");
      const start = text.length;
      try { while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        for (const item of chunk.value.items) if ("str" in item) { const word = item as TextItem; append(word.str + (word.hasEOL ? "\n" : " ")); }
      } } finally { await reader.cancel().catch(() => {}); }
      spans.push({ kind: "page", index, start, end: text.length });
      textBudget(text); page.cleanup();
    }
    return result("pdf", { text, spans, warningCodes: text.trim() ? ["PDF_NO_OCR"] : ["PDF_NO_TEXT", "PDF_NO_OCR"] });
  } catch (error) { if (error instanceof Error && error.name === "PasswordException") fail("MEDIA_ENCRYPTED"); throw error; }
  finally { try { await loading.destroy(); } finally { worker.terminate(); GlobalWorkerOptions.workerPort = null; } }
}
function documentCanvas(width: number, height: number): HTMLCanvasElement { pixelBudget(width, height); const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height; return canvas; }
async function parse(request: ParserRequest): Promise<MediaParseResult | MediaPreviewPixels> {
  const digest = await crypto.subtle.digest("SHA-256", request.bytes as BufferSource);
  if ([...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("") !== request.sha256) fail();
  if (request.mimeType === "application/pdf") return pdf(request);
  if (request.operation !== "parse") fail();
  if (request.mimeType === "image/png" || request.mimeType === "image/jpeg") {
    if (request.bytes.length > PARSER_LIMITS.imageBytes) fail("MEDIA_IMPORT_TOO_LARGE");
    const declared = imageDimensions(request.bytes, request.mimeType); pixelBudget(declared.width, declared.height);
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(request.bytes)], { type: request.mimeType }));
    try { pixelBudget(bitmap.width, bitmap.height); return result("image", null, bitmap.width, bitmap.height); } finally { bitmap.close(); }
  }
  if (request.mimeType !== "application/vnd.openxmlformats-officedocument.wordprocessingml.document") fail("MEDIA_UNSUPPORTED");
  const text = await extractDocx(request.bytes); textBudget(text);
  return result("docx", { text, spans: [{ kind: "section", index: 0, start: 0, end: text.length }], warningCodes: [] });
}
window.mediaParser.onInput(request => {
  void parse(request).then(value => window.mediaParser.reply({ type: "result", nonce: request.nonce, sha256: request.sha256, result: value })).catch(error => {
    const message = error instanceof Error ? error.message : "";
    const code = PARSER_ERROR_CODES.find(code => code === message) ?? "MEDIA_PARSE_FAILED";
    window.mediaParser.reply({ type: "error", nonce: request.nonce, sha256: request.sha256, code });
  });
});
window.mediaParser.ready(location.hostname);
