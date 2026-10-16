import type { MediaParserInput, MediaParseResult, MediaPreviewPixels } from "../main/media-parser-types";

export const MEDIA_PARSER_SCHEME = "aevoren-media-parser";
export const MEDIA_PARSER_CHANNEL = "media-parser:reply";
export const MEDIA_PARSER_INPUT = "media-parser:input";
export const MEDIA_PARSER_NAME = "aevoren-browser-media";
export const MEDIA_PARSER_VERSION = "1.1.0/pdfjs-6.4.299/mammoth-1.13.0/zip-2.23.0/fonts-2.1.5";
export const PARSER_LIMITS = {
  imageBytes: 2_097_152, pdfBytes: 16_777_216, docxBytes: 8_388_608,
  pixels: 16_000_000, pages: 200, textBytes: 524_288, timeoutMs: 30_000,
  zipEntries: 2_000, zipEntryBytes: 16_777_216, zipTotalBytes: 67_108_864,
  avBytes: 16_777_216, durationMs: 600_000,
} as const;
export const PARSER_ERROR_CODES = ["MEDIA_UNSUPPORTED", "MEDIA_IMPORT_TOO_LARGE", "MEDIA_CONTENT_INVALID", "MEDIA_PARSE_FAILED", "MEDIA_ENCRYPTED", "MEDIA_CODEC_UNSUPPORTED"] as const;
export type ParserErrorCode = typeof PARSER_ERROR_CODES[number];
export type ParserRequest = MediaParserInput & { nonce: string; operation: "parse" | "pdf-preview"; pageIndex?: number };
export type ParserReply = { nonce: string } & (
  | { type: "ready" }
  | { type: "result"; sha256: string; result: MediaParseResult | MediaPreviewPixels }
  | { type: "error"; sha256: string; code: ParserErrorCode }
);
export type ParserBridge = { ready(nonce: string): void; onInput(callback: (value: ParserRequest) => void): void; reply(value: ParserReply): void };
export type ParserAsset = { path: string; route: string | null; mimeType: string; size: number; sha256: string };
export type ParserManifest = {
  protocolVersion: 1; parserName: string; parserVersion: string; applicationVersion: string;
  entry: string; preload: string; files: ParserAsset[];
};
