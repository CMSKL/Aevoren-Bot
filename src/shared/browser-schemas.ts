import { z } from "zod";
import { BROWSER_DOWNLOAD_MAX_BYTES, BROWSER_FRAME_MAX_BYTES, BROWSER_PROTOCOL_VERSION, BROWSER_TEXT_MAX_CHARACTERS } from "./browser-contracts";
import { environmentContentBytes, environmentScopeSchema } from "./environment-schemas";

const id = z.string().uuid();
const epoch = z.number().int().positive();
const timestamp = z.string().datetime({ offset: true });
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().max(BROWSER_TEXT_MAX_CHARACTERS);
const button = z.enum(["left", "middle", "right"]).default("left");
const key = z.string().min(1).max(80).regex(/^[A-Za-z0-9+ _-]+$/);
const ref = z.string().min(1).max(120).regex(/^[A-Za-z0-9_-]+$/);
export const browserUrlSchema = z.string().min(1).max(8_192).refine(value => {
  if (value === "about:blank") return true;
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}, "Use an HTTP(S) URL without embedded credentials or about:blank");
export const browserScopeSchema = environmentScopeSchema;
export const browserEpochSchema = browserScopeSchema.extend({ expectedEpoch: epoch });
export const browserMutationSchema = browserScopeSchema.extend({ clientNonce: id, expectedVersion: epoch.optional() });
export const browserPageInputSchema = browserEpochSchema.extend({ pageId: id });
export const browserPageMutationSchema = browserPageInputSchema.extend({ clientNonce: id });
export const browserNavigateSchema = browserPageMutationSchema.extend({ url: browserUrlSchema });
export const browserObserveSchema = browserPageInputSchema.extend({ maxCharacters: z.number().int().min(1).max(BROWSER_TEXT_MAX_CHARACTERS).default(18_000) });
export const browserReadSchema = browserObserveSchema.extend({ offset: z.number().int().min(0).max(10_000_000).default(0) });
export const browserActionSchema = browserPageMutationSchema.extend({ observationId: id, documentVersion: epoch });
export const browserClickSchema = browserActionSchema.extend({ ref, button });
export const browserTypeSchema = browserActionSchema.extend({ ref, text, replace: z.boolean().default(false) });
export const browserKeySchema = browserActionSchema.extend({ key });
export const browserScrollSchema = browserActionSchema.extend({ deltaX: z.number().int().min(-10_000).max(10_000), deltaY: z.number().int().min(-10_000).max(10_000) });
export const browserNewTabSchema = browserEpochSchema.extend({ clientNonce: id, url: browserUrlSchema.default("about:blank") });
export const browserDownloadInputSchema = browserEpochSchema.extend({ clientNonce: id, id });
export const computerControlSchema = browserEpochSchema.extend({ clientNonce: id, expectedVersion: epoch.optional() });
export const computerVncTicketSchema = browserEpochSchema.extend({ clientNonce: id });
export const computerScreenshotSchema = browserEpochSchema.extend({ pageId: id.optional() });
export const computerClickSchema = browserActionSchema.extend({ x: z.number().int().min(0).max(16_384), y: z.number().int().min(0).max(16_384), button });
export const computerTypeSchema = browserActionSchema.extend({ text });
export const computerScrollSchema = browserScrollSchema.extend({ x: z.number().int().min(0).max(16_384).optional(), y: z.number().int().min(0).max(16_384).optional() });
export const previewOpenSchema = browserEpochSchema.extend({ clientNonce: id, registeredPortId: id });
export const previewCloseSchema = browserEpochSchema.extend({ clientNonce: id, id });

export const browserSessionSchema = browserScopeSchema.extend({ id, environmentId: id, state: z.enum(["starting", "running", "stopped", "error", "unknown"]),
  version: epoch, bootId: id.nullable(), controlEpoch: epoch, activePageId: id.nullable(), createdAt: timestamp, updatedAt: timestamp });
export const browserPageSchema = z.object({ id, browserSessionId: id, url: z.string().max(8_192), title: z.string().max(2_000), documentVersion: epoch,
  createdAt: timestamp, updatedAt: timestamp }).strict();
export const computerViewSchema = browserScopeSchema.extend({ browserSessionId: id, owner: z.enum(["ai", "user"]), epoch, version: epoch,
  connectionState: z.enum(["connected", "disconnected"]), observedEpoch: epoch.nullable(), updatedAt: timestamp });
export const browserObservationSchema = z.object({ id, browserSessionId: id, pageId: id, controlEpoch: epoch, documentVersion: epoch,
  url: z.string().max(8_192), title: z.string().max(2_000), text, elements: z.array(z.object({ ref, role: z.string().max(120), name: z.string().max(2_000) }).strict()).max(500),
  truncated: z.boolean(), observedAt: timestamp }).strict();
export const screenshotMediaSchema = browserScopeSchema.extend({ id, name: z.string().min(1).max(200), size: z.number().int().positive().max(BROWSER_FRAME_MAX_BYTES),
  mimeType: z.enum(["image/png", "image/jpeg"]), sha256, browserSessionId: id, pageId: id.nullable(), observationId: id,
  controlEpoch: epoch, documentVersion: epoch.nullable(), width: z.number().int().positive().max(16_384), height: z.number().int().positive().max(16_384), capturedAt: timestamp });
export const browserWorkerFrameSchema = screenshotMediaSchema.omit({ sessionId: true, executorBotId: true, id: true, name: true }).extend({
  dataBase64: z.string().max(Math.ceil(BROWSER_FRAME_MAX_BYTES / 3) * 4).refine(value => environmentContentBytes(value, "base64") <= BROWSER_FRAME_MAX_BYTES),
}).refine(value => environmentContentBytes(value.dataBase64, "base64") === value.size, "Pixel byte count must match frame metadata");
export const browserDownloadSchema = z.object({ id, name: z.string().min(1).max(200), size: z.number().int().min(0).max(BROWSER_DOWNLOAD_MAX_BYTES),
  mimeType: z.string().min(1).max(120), sha256, browserSessionId: id, pageId: id, createdAt: timestamp }).strict();
export const browserDownloadFailureSchema = z.object({ id, pageId: id, name: z.string().max(200), errorCode: z.string().min(1).max(120), createdAt: timestamp }).strict();
export const browserDownloadsPageSchema = z.object({ items: z.array(browserDownloadSchema).max(250), errors: z.array(browserDownloadFailureSchema).max(250) }).strict();
export const browserWorkerDownloadSchema = browserDownloadSchema.extend({ dataBase64: z.string().max(Math.ceil(BROWSER_DOWNLOAD_MAX_BYTES / 3) * 4)
  .refine(value => environmentContentBytes(value, "base64") <= BROWSER_DOWNLOAD_MAX_BYTES) }).refine(value => environmentContentBytes(value.dataBase64, "base64") === value.size);
export const servicePreviewSchema = z.object({ id, environmentId: id, registeredPortId: id, browserSessionId: id, pageId: id, url: browserUrlSchema,
  state: z.enum(["open", "closed", "unknown"]), createdAt: timestamp, updatedAt: timestamp }).strict();
export const executionPreviewTicketSchema = z.object({ id, registeredPortId: id, processId: id, port: z.number().int().min(1).max(65_535),
  host: z.string().regex(/^[a-f0-9]{32}\.[a-f0-9]{32}\.aevoren-preview-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.internal$/), expiresAt: timestamp }).strict();
export const browserWorkerControlSchema = z.object({ owner: z.enum(["ai", "user"]), controlEpoch: epoch, observedEpoch: epoch.nullable(),
  connectionState: z.enum(["connected", "disconnected"]) }).strict();
export const browserWorkerHealthSchema = z.object({ environmentId: id, browserSessionId: id, bootId: id, protocolVersion: z.literal(BROWSER_PROTOCOL_VERSION),
  workerVersion: z.string().max(80).regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/), capabilities: z.array(z.string().min(1).max(80)).max(32), control: browserWorkerControlSchema }).strict();
export const browserWorkerAccessSchema = z.object({ actor: z.enum(["ai", "user"]), expectedEpoch: epoch }).strict();
export const browserWorkerMutationAccessSchema = browserWorkerAccessSchema.extend({ operationId: id });
export const browserWorkerCancelAckSchema = z.object({ operationId: id, state: z.enum(["cancelled", "unknown", "completed"]) }).strict();
