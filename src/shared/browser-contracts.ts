import type { ApiResult } from "./contracts";
import type { EnvironmentPlatform, EnvironmentScope } from "./environment-contracts";
import type { MediaRef } from "./library-contracts";

export const BROWSER_WORKER_VERSION = "1.0.0";
export const BROWSER_PROTOCOL_VERSION = 1;
export const BROWSER_FRAME_MAX_BYTES = 2_097_152;
export const BROWSER_DOWNLOAD_MAX_BYTES = 1_048_576;
export const BROWSER_TEXT_MAX_CHARACTERS = 64_000;
export type BrowserScope = EnvironmentScope;
export type BrowserState = "starting" | "running" | "stopped" | "error" | "unknown";
export type ComputerOwner = "ai" | "user";
export type ComputerConnectionState = "connected" | "disconnected";
export type BrowserSession = BrowserScope & { id: string; environmentId: string; state: BrowserState; version: number;
  bootId: string | null; controlEpoch: number; activePageId: string | null; createdAt: string; updatedAt: string };
/** Host-private companion connection; independent of the execution container's credential. */
export type InternalBrowserRecord = BrowserSession & { encryptedToken: string | null; containerId: string | null; workerPort: number | null;
  imageRef: string | null; imageDigest: string | null; workerVersion: string | null; platform: EnvironmentPlatform | null };
export type BrowserPage = { id: string; browserSessionId: string; url: string; title: string; documentVersion: number; createdAt: string; updatedAt: string };
export type ComputerView = BrowserScope & { browserSessionId: string; owner: ComputerOwner; epoch: number; version: number;
  connectionState: ComputerConnectionState; observedEpoch: number | null; updatedAt: string };
export type BrowserElement = { ref: string; role: string; name: string };
export type BrowserObservation = { id: string; browserSessionId: string; pageId: string; controlEpoch: number; documentVersion: number;
  url: string; title: string; text: string; elements: BrowserElement[]; truncated: boolean; observedAt: string };
export type BrowserEpochInput = BrowserScope & { expectedEpoch: number };
export type BrowserPageInput = BrowserEpochInput & { pageId: string };
export type BrowserPageMutationInput = BrowserPageInput & { clientNonce: string };
export type BrowserNavigateInput = BrowserPageMutationInput & { url: string };
export type BrowserObserveInput = BrowserPageInput & { maxCharacters?: number };
export type BrowserReadInput = BrowserObserveInput & { offset?: number };
export type BrowserInputProof = { observationId: string; documentVersion: number };
export type BrowserActionInput = BrowserPageMutationInput & BrowserInputProof;
export type BrowserClickInput = BrowserActionInput & { ref: string; button?: "left" | "middle" | "right" };
export type BrowserTypeInput = BrowserActionInput & { ref: string; text: string; replace?: boolean };
export type BrowserKeyInput = BrowserActionInput & { key: string };
export type BrowserScrollInput = BrowserActionInput & { deltaX: number; deltaY: number };
export type BrowserNewTabInput = BrowserEpochInput & { clientNonce: string; url?: string };
export type BrowserMutationInput = BrowserScope & { clientNonce: string; expectedVersion?: number };
export type ComputerControlInput = BrowserEpochInput & { clientNonce: string; expectedVersion?: number };
export type ComputerScreenshotInput = BrowserEpochInput & { pageId?: string };
export type ComputerClickInput = BrowserActionInput & { x: number; y: number; button?: "left" | "middle" | "right" };
export type ComputerTypeInput = BrowserActionInput & { text: string };
export type ComputerKeyInput = BrowserKeyInput;
export type ComputerScrollInput = BrowserScrollInput & { x?: number; y?: number };
export type ScreenshotMedia = MediaRef & BrowserScope & { browserSessionId: string; pageId: string | null; observationId: string;
  controlEpoch: number; documentVersion: number | null; width: number; height: number; mimeType: "image/png" | "image/jpeg"; capturedAt: string };
export type InternalScreenshotRecord = ScreenshotMedia & { blobPath: string };
/** Real pixel transport only. Host-owned media records never persist this base64 field. */
export type BrowserWorkerFrame = { browserSessionId: string; pageId: string | null; observationId: string; controlEpoch: number;
  documentVersion: number | null; dataBase64: string; mimeType: "image/png" | "image/jpeg"; size: number; sha256: string;
  width: number; height: number; capturedAt: string };
export type ComputerScreenshot = { media: ScreenshotMedia; frame: BrowserWorkerFrame };
/** Trusted UI capability; never included in the AI operation catalog or public view metadata. */
export type ComputerVncTicket = { id: string; browserSessionId: string; epoch: number; expiresAt: string; url: string };
export type BrowserDownload = MediaRef & { browserSessionId: string; pageId: string; createdAt: string };
export type BrowserDownloadFailure = { id: string; pageId: string; name: string; errorCode: string; createdAt: string };
export type BrowserDownloadsPage = { items: BrowserDownload[]; errors: BrowserDownloadFailure[] };
export type BrowserDownloadInput = BrowserEpochInput & { clientNonce: string; id: string };
export type BrowserDownloadResult = { path: string; name: string; size: number };
export type BrowserWorkerDownload = BrowserDownload & { dataBase64: string };
export type ServicePreview = { id: string; environmentId: string; registeredPortId: string; browserSessionId: string; pageId: string;
  url: string; state: "open" | "closed" | "unknown"; createdAt: string; updatedAt: string };
export type PreviewOpenInput = BrowserEpochInput & { clientNonce: string; registeredPortId: string };
export type PreviewCloseInput = BrowserEpochInput & { clientNonce: string; id: string };
/** A separate app-preview capability; never the execution or browser administration credential. */
export type ExecutionPreviewTicket = { id: string; registeredPortId: string; processId: string; port: number; host: string; expiresAt: string };
export type BrowserChangedEvent = BrowserScope & { type: "browser" | "pages" | "control" | "download" | "preview";
  browserSessionId: string; controlEpoch: number };

export type BrowserApi = {
  get(input: BrowserScope): Promise<ApiResult<BrowserSession | null>>;
  start(input: BrowserMutationInput): Promise<ApiResult<BrowserSession>>;
  stop(input: BrowserMutationInput): Promise<ApiResult<BrowserSession>>;
  tabs(input: BrowserEpochInput): Promise<ApiResult<BrowserPage[]>>;
  newTab(input: BrowserNewTabInput): Promise<ApiResult<BrowserPage>>;
  closeTab(input: BrowserPageMutationInput): Promise<ApiResult<BrowserSession>>;
  navigate(input: BrowserNavigateInput): Promise<ApiResult<BrowserPage>>;
  read(input: BrowserReadInput): Promise<ApiResult<BrowserObservation>>;
  observe(input: BrowserObserveInput): Promise<ApiResult<BrowserObservation>>;
  click(input: BrowserClickInput): Promise<ApiResult<BrowserPage>>;
  type(input: BrowserTypeInput): Promise<ApiResult<BrowserPage>>;
  key(input: BrowserKeyInput): Promise<ApiResult<BrowserPage>>;
  scroll(input: BrowserScrollInput): Promise<ApiResult<BrowserPage>>;
  downloads(input: BrowserEpochInput): Promise<ApiResult<BrowserDownloadsPage>>;
  download(input: BrowserDownloadInput): Promise<ApiResult<BrowserDownloadResult | null>>;
  onChanged(listener: (event: BrowserChangedEvent) => void): () => void;
};
export type ComputerApi = {
  view(input: BrowserScope): Promise<ApiResult<ComputerView | null>>;
  screenshot(input: ComputerScreenshotInput): Promise<ApiResult<ComputerScreenshot>>;
  click(input: ComputerClickInput): Promise<ApiResult<BrowserPage>>;
  type(input: ComputerTypeInput): Promise<ApiResult<BrowserPage>>;
  key(input: ComputerKeyInput): Promise<ApiResult<BrowserPage>>;
  scroll(input: ComputerScrollInput): Promise<ApiResult<BrowserPage>>;
  takeover(input: ComputerControlInput): Promise<ApiResult<ComputerView>>;
  returnControl(input: ComputerControlInput): Promise<ApiResult<ComputerView>>;
  vncTicket(input: BrowserEpochInput & { clientNonce: string }): Promise<ApiResult<ComputerVncTicket>>;
  onChanged(listener: (event: BrowserChangedEvent) => void): () => void;
};
export type PreviewApi = {
  list(input: BrowserEpochInput): Promise<ApiResult<ServicePreview[]>>;
  open(input: PreviewOpenInput): Promise<ApiResult<ServicePreview>>;
  close(input: PreviewCloseInput): Promise<ApiResult<ServicePreview>>;
  onChanged(listener: (event: BrowserChangedEvent) => void): () => void;
};

export type BrowserWorkerControl = { owner: ComputerOwner; controlEpoch: number; observedEpoch: number | null; connectionState: ComputerConnectionState };
export type BrowserWorkerHealth = { environmentId: string; browserSessionId: string; bootId: string; protocolVersion: number;
  workerVersion: string; capabilities: string[]; control: BrowserWorkerControl };
/** actor is supplied exclusively by the authenticated host, never by model/public arguments. */
export type BrowserWorkerAccess = { actor: ComputerOwner; expectedEpoch: number };
export type BrowserWorkerMutationAccess = BrowserWorkerAccess & { operationId: string };
export type BrowserWorkerCancelAck = { operationId: string; state: "cancelled" | "unknown" | "completed" };
