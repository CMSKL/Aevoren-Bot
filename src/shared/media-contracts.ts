import type { ApiResult } from "./contracts";
import type { MediaRef } from "./library-contracts";

export type MediaKind = "image" | "pdf" | "docx";
export type SupportedMediaMime = "image/png" | "image/jpeg" | "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export type MessageMediaReference = { mediaId: string; sha256: string; extraction?: { id: string; digest: string } };
export type MediaSpan = { kind: "page" | "section"; index: number; start: number; end: number };
export type MediaAsset = {
  reference: MediaRef;
  kind: MediaKind;
  version: number;
  enabled: boolean;
  width: number | null;
  height: number | null;
  deletedAt: string | null;
  createdAt: string;
};
export type MediaExtraction = {
  id: string; mediaId: string; sourceSha256: string; parserName: string; parserVersion: string;
  digest: string; text: string; spans: MediaSpan[]; warningCodes: string[]; createdAt: string;
};
export type MediaExtractionSummary = Omit<MediaExtraction, "text" | "spans"> & { totalCharacters: number; spanCount: number };
export type MediaItem = { asset: MediaAsset; reference: MessageMediaReference; extraction: MediaExtractionSummary | null };
export type MediaBinding = { sessionId: string; mediaId: string; version: number; createdAt: string; revokedAt: string | null };
export type MediaScope = { sessionId: string };
export type MediaListInput = MediaScope & { query?: string; includeDisabled?: boolean; includeDeleted?: boolean };
export type MediaAvailableInput = Omit<MediaListInput, "sessionId">;
export type MediaReadInput = MediaScope & { id: string; reference?: MessageMediaReference; offset?: number; maxCharacters?: number };
export type MediaReadMetadata = {
  item: MediaItem; offset: number; nextOffset: number | null; totalCharacters: number; spans: MediaSpan[];
};
/** Trusted UI response. Model text travels through a separate, revocable host attachment. */
export type MediaTextPage = MediaReadMetadata & { text: string };
export type MediaPreviewInput = MediaScope & { id: string; reference?: MessageMediaReference; pageIndex?: number };
export type MediaPreviewMetadata = { sourceReference: MessageMediaReference; image: MediaRef; width: number; height: number; pageIndex: number | null };
/** Pixels are returned only by the scoped trusted UI operation, never persisted in tool receipts. */
export type MediaPreview = MediaPreviewMetadata & { dataBase64: string };
export type MediaMutationInput = MediaScope & { id: string; expectedVersion: number };
export type MediaBindingInput = MediaScope & { id: string };
export type MediaImportPathInput = MediaScope & { workspaceId: string; path: string };
export type MediaImportResult = { imported: MediaItem[]; failed: { name: string; code: string; reason: string }[] };
export type MediaChangedEvent = { sessionId: string; mediaId: string; action: "created" | "bound" | "unbound" | "enabled" | "deleted" | "restored" };
export type MediaApi = {
  list(input: MediaListInput): Promise<ApiResult<MediaItem[]>>;
  available(input?: MediaAvailableInput): Promise<ApiResult<MediaItem[]>>;
  metadata(input: MediaScope & { id: string }): Promise<ApiResult<MediaItem>>;
  read(input: MediaReadInput): Promise<ApiResult<MediaTextPage>>;
  preview(input: MediaPreviewInput): Promise<ApiResult<MediaPreview>>;
  pickImport(input: MediaScope): Promise<ApiResult<MediaImportResult | null>>;
  importPath(input: MediaImportPathInput): Promise<ApiResult<MediaImportResult>>;
  bind(input: MediaBindingInput): Promise<ApiResult<MediaBinding>>;
  unbind(input: MediaBindingInput): Promise<ApiResult<boolean>>;
  setEnabled(input: MediaMutationInput & { enabled: boolean }): Promise<ApiResult<MediaAsset>>;
  delete(input: MediaMutationInput): Promise<ApiResult<MediaAsset>>;
  restore(input: MediaMutationInput): Promise<ApiResult<MediaAsset>>;
  onChanged(listener: (event: MediaChangedEvent) => void): () => void;
};
