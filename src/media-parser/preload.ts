import { contextBridge, ipcRenderer } from "electron";
import { MEDIA_PARSER_CHANNEL, MEDIA_PARSER_INPUT, PARSER_LIMITS, type ParserBridge, type ParserRequest, type ParserReply } from "../shared/media-parser-protocol";

let job: ParserRequest | undefined;
const keys = (value: object, allowed: string[]): boolean => Object.keys(value).every(key => allowed.includes(key));
const dimension = (value: unknown): boolean => value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= PARSER_LIMITS.pixels);
function bounded(value: ParserReply): boolean {
  if (!value || typeof value.nonce !== "string" || value.nonce.length !== 36 || !keys(value, ["nonce", "type", "sha256", "code", "result"])) return false;
  if (!("sha256" in value) || typeof value.sha256 !== "string" || value.sha256.length !== 64) return false;
  if (value.type === "error") return typeof value.code === "string" && value.code.length < 40;
  if (value.type !== "result" || !value.result) return false;
  const result = value.result;
  if (!dimension(result.width) || !dimension(result.height)) return false;
  if ("bytes" in result) return keys(result, ["bytes", "width", "height", "mimeType"]) && ["image/png", "image/jpeg"].includes(result.mimeType) && result.bytes instanceof Uint8Array && result.bytes.length <= PARSER_LIMITS.imageBytes;
  if (!keys(result, ["kind", "width", "height", "extraction", "parserName", "parserVersion"]) || !["image", "pdf", "docx"].includes(result.kind) || typeof result.parserName !== "string" || result.parserName.length > 100 || typeof result.parserVersion !== "string" || result.parserVersion.length > 200) return false;
  const extraction = result.extraction;
  return extraction === null || (keys(extraction, ["text", "spans", "warningCodes"]) && typeof extraction.text === "string" && extraction.text.length <= PARSER_LIMITS.textBytes && new TextEncoder().encode(extraction.text).length <= PARSER_LIMITS.textBytes
    && Array.isArray(extraction.spans) && extraction.spans.length <= PARSER_LIMITS.pages && extraction.spans.every(span => keys(span, ["kind", "index", "start", "end"]) && (span.kind === "page" || span.kind === "section") && [span.index, span.start, span.end].every(value => Number.isSafeInteger(value) && value >= 0 && value <= PARSER_LIMITS.textBytes))
    && Array.isArray(extraction.warningCodes) && extraction.warningCodes.length <= 2 && extraction.warningCodes.every(code => typeof code === "string" && code.length < 40));
}
const bridge: ParserBridge = {
  ready(nonce) { if (typeof nonce === "string" && nonce.length === 36) ipcRenderer.send(MEDIA_PARSER_CHANNEL, { type: "ready", nonce }); },
  onInput(callback) { ipcRenderer.once(MEDIA_PARSER_INPUT, (_event, value: ParserRequest) => { job = value; callback(value); }); },
  reply(value) {
    try { if (bounded(value)) { ipcRenderer.send(MEDIA_PARSER_CHANNEL, value.type === "result" && "bytes" in value.result ? { ...value, result: { ...value.result, bytes: new Uint8Array(value.result.bytes) } } : value); return; } } catch { /* A malformed sandbox reply cannot reach Main. */ }
    if (job) ipcRenderer.send(MEDIA_PARSER_CHANNEL, { type: "error", nonce: job.nonce, sha256: job.sha256, code: "MEDIA_CONTENT_INVALID" });
  },
};
contextBridge.exposeInMainWorld("mediaParser", bridge);
