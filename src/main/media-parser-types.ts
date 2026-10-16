import type { MediaKind, MediaSpan, SupportedMediaMime } from "@shared/media-contracts";

export type MediaParserInput = { sha256: string; mimeType: SupportedMediaMime; bytes: Uint8Array };
export type MediaParseResult = {
  kind: MediaKind;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  extraction: { text: string; spans: MediaSpan[]; warningCodes: string[] } | null;
  /** Supplied by the trusted host manifest, never trusted from a parser reply. */
  parserName: string;
  parserVersion: string;
};
export type MediaPreviewPixels = { bytes: Uint8Array; width: number; height: number; mimeType: "image/png" | "image/jpeg" };
export interface MediaParserAdapter {
  parse(input: MediaParserInput, signal: AbortSignal): Promise<MediaParseResult>;
  renderPdfPage(input: MediaParserInput & { pageIndex: number }, signal: AbortSignal): Promise<MediaPreviewPixels>;
  shutdown(): Promise<void>;
}
