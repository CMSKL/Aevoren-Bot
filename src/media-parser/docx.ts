import mammoth from "mammoth";
import { configure, ZipReader, ZipWriter, Uint8ArrayReader, Uint8ArrayWriter, type Entry } from "@zip.js/zip.js/lib/zip-core-custom.js";
import { PARSER_LIMITS } from "../shared/media-parser-protocol";

configure({ useWebWorkers: false, useCompressionStream: true, CompressionStream: globalThis.CompressionStream, DecompressionStream: globalThis.DecompressionStream });
function fail(code = "MEDIA_CONTENT_INVALID"): never { throw new Error(code); }

function xml(bytes: Uint8Array): { bytes: Uint8Array; document: Document } {
  let encoding = "utf-8";
  if ((bytes[0] === 255 && bytes[1] === 254) || (bytes[0] === 60 && bytes[1] === 0)) encoding = "utf-16le";
  else if ((bytes[0] === 254 && bytes[1] === 255) || (bytes[0] === 0 && bytes[1] === 60)) encoding = "utf-16be";
  let text: string;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); } catch { return fail(); }
  const declaration = /^\s*<\?xml\s[^>]*encoding\s*=\s*(['"])([^'"]+)\1/iu.exec(text)?.[2]?.toLowerCase();
  if (declaration && (encoding === "utf-8" ? !["utf-8", "utf8"].includes(declaration) : ![encoding, "utf-16", "utf16"].includes(declaration))) fail();
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(text)) fail();
  const document = new DOMParser().parseFromString(text, "application/xml");
  if (document.doctype || document.querySelector("parsererror") || !document.documentElement) fail();
  return { bytes: new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(document)}`), document };
}
function safeName(entry: Entry): string {
  const name = entry.filename;
  if (!name || name.length > 500 || /[\\:]/u.test(name) || [...name].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || name.startsWith("/") || entry.symlink) fail();
  const parts = name.replace(/\/$/u, "").split("/");
  if (parts.some(part => !part || part === "." || part === ".." || /[. ]$/u.test(part))) fail();
  return name.normalize("NFC").replace(/\/$/u, "").toLowerCase();
}

/** Rebuild only a fully checked, bounded, unique-name OOXML archive for Mammoth's second ZIP parser. */
export async function extractDocx(bytes: Uint8Array): Promise<string> {
  try { new DecompressionStream("deflate-raw"); } catch { fail("MEDIA_PARSE_FAILED"); }
  const reader = new ZipReader(new Uint8ArrayReader(bytes), { strictness: "strict", filenameValidation: "strict" });
  const controller = new AbortController();
  const entries: Entry[] = [], names = new Set<string>();
  let declaredTotal = 0;
  try {
    for await (const entry of reader.getEntriesGenerator()) {
      if (entries.length >= PARSER_LIMITS.zipEntries) fail("MEDIA_IMPORT_TOO_LARGE");
      const canonical = safeName(entry);
      if (names.has(canonical)) fail(); names.add(canonical);
      if (entry.encrypted) fail("MEDIA_ENCRYPTED");
      if (![0, 8].includes(entry.compressionMethod) || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0) fail();
      declaredTotal += entry.uncompressedSize;
      if (entry.uncompressedSize > PARSER_LIMITS.zipEntryBytes || declaredTotal > PARSER_LIMITS.zipTotalBytes) fail("MEDIA_IMPORT_TOO_LARGE");
      if (/(?:^|\/)vbaproject\b/iu.test(entry.filename)) fail();
      entries.push(entry);
    }
    if (!entries.some(entry => entry.filename === "[Content_Types].xml") || !entries.some(entry => entry.filename === "word/document.xml")) fail();
    let actualTotal = 0;
    const writer = new ZipWriter(new Uint8ArrayWriter(), { level: 0, useWebWorkers: false, useCompressionStream: true });
    for (const entry of entries) {
      if (entry.directory) { await writer.add(entry.filename, undefined, { directory: true, level: 0 }); continue; }
      const chunks: Uint8Array[] = []; let size = 0;
      await entry.getData(new WritableStream<Uint8Array>({ write(chunk) {
        if (!(chunk instanceof Uint8Array)) fail();
        size += chunk.byteLength; actualTotal += chunk.byteLength;
        if (size > PARSER_LIMITS.zipEntryBytes || actualTotal > PARSER_LIMITS.zipTotalBytes || size > entry.uncompressedSize) { controller.abort(); fail("MEDIA_IMPORT_TOO_LARGE"); }
        chunks.push(new Uint8Array(chunk));
      } }), { signal: controller.signal, checkCrc32: true, checkOverlappingEntry: true, checkLocalDirectory: true, checkLocalFilename: true });
      if (size !== entry.uncompressedSize) fail();
      let content: Uint8Array = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { content.set(chunk, offset); offset += chunk.length; }
      if (entry.filename.endsWith(".xml") || entry.filename.endsWith(".rels")) {
        const normalized = xml(content); content = normalized.bytes;
        if (entry.filename === "[Content_Types].xml") {
          if (normalized.document.documentElement.localName !== "Types" || normalized.document.documentElement.namespaceURI !== "http://schemas.openxmlformats.org/package/2006/content-types") fail();
          const overrides = [...normalized.document.getElementsByTagNameNS("*", "Override")];
          const parts = overrides.map(element => element.getAttribute("PartName"));
          if (parts.some(part => !part) || new Set(parts).size !== parts.length) fail();
          if (!overrides.some(element => element.getAttribute("PartName") === "/word/document.xml" && element.getAttribute("ContentType") === "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml")) fail();
          for (const element of [...normalized.document.getElementsByTagNameNS("*", "*")]) if (/macroenabled|vbaproject/iu.test(element.getAttribute("ContentType") ?? "")) fail();
        }
        if (entry.filename === "word/document.xml" && (normalized.document.documentElement.localName !== "document" || !["http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main"].includes(normalized.document.documentElement.namespaceURI ?? ""))) fail();
        if (entry.filename.endsWith(".rels")) for (const relationship of [...normalized.document.getElementsByTagNameNS("*", "Relationship")]) {
          if (relationship.getAttribute("TargetMode") === "External" && !relationship.getAttribute("Type")?.endsWith("/hyperlink")) fail();
        }
      }
      await writer.add(entry.filename, new Uint8ArrayReader(content), { level: 0, useWebWorkers: false });
    }
    const normalized = await writer.close();
    if (normalized.length > PARSER_LIMITS.zipTotalBytes + 2_097_152) fail("MEDIA_IMPORT_TOO_LARGE");
    const result = await mammoth.extractRawText({ arrayBuffer: normalized.buffer as ArrayBuffer });
    return result.value;
  } catch (error) {
    controller.abort();
    if (error instanceof Error && /^MEDIA_/u.test(error.message)) throw error;
    fail();
  } finally { await reader.close(); }
}
