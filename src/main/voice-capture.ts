import { REALTIME_CAPTURE_MAX_DURATION_MS } from "@shared/realtime-channels";
import { VOICE_CAPTURE_MAX_DURATION_MS } from "@shared/voice-channels";
import { randomUUID } from "node:crypto";
import type { MessageMediaReference } from "@shared/media-contracts";
import type { VoiceCaptureBegin, VoiceCaptureCommit, VoiceCaptureIntent, VoiceScope } from "@shared/voice-contracts";
import { VOICE_AUDIO_MAX_BYTES, voiceCaptureBeginSchema, voiceCaptureCancelSchema, voiceCaptureCommitSchema } from "@shared/voice-schemas";
import type { AppRepository } from "./database";
import { AevorenBotError } from "./errors";

export type VoiceDocumentIdentity = { webContentsId: number; processId: number; routingId: number; url: string; epoch: number };
export type VoiceCaptureDependencies = {
  identity(): VoiceDocumentIdentity;
  hasUserActivation(): Promise<boolean>;
  requestMicrophone(): Promise<boolean>;
  publish(input: { sessionId: string; bytes: Uint8Array; mimeType: string; name: string }, context: { signal: AbortSignal; assertCurrent(): void }): Promise<MessageMediaReference>;
  now?(): number;
};
type Capture = { intent: VoiceCaptureIntent; document: VoiceDocumentIdentity; generation: number; deadline: number;
  realtime: boolean; stage: "requesting" | "issued" | "publishing"; controller: AbortController; timer?: ReturnType<typeof setTimeout> };
const permissionWindowMs = 30_000;

/** One user-initiated audio capture, tied to one exact main document. */
export class VoiceCaptureGate {
  private capture: Capture | null = null;
  private closed = false;
  private readonly pending = new Set<Promise<unknown>>();
  constructor(private readonly repository: AppRepository, private readonly dependencies: VoiceCaptureDependencies) {}
  private now(): number { return this.dependencies.now?.() ?? Date.now(); }
  private sameDocument(document: VoiceDocumentIdentity): boolean {
    const current = this.dependencies.identity();
    return current.webContentsId === document.webContentsId && current.processId === document.processId && current.routingId === document.routingId
      && current.url === document.url && current.epoch === document.epoch;
  }
  private check(capture: Capture): void {
    if (this.closed || this.capture !== capture || capture.controller.signal.aborted || !this.sameDocument(capture.document)
      || this.now() > capture.deadline) throw new AevorenBotError("VOICE_CAPTURE_INVALID");
    const session = this.repository.getSession(capture.intent.sessionId);
    if (session.generation !== capture.generation || session.roomId && this.repository.getRoom(session.roomId).archivedAt) throw new AevorenBotError("VOICE_CAPTURE_INVALID");
  }
  private async wait<T>(work: Promise<T>, capture: Capture): Promise<T> {
    const { signal } = capture.controller;
    let abort!: () => void;
    try {
      return await Promise.race([work, new Promise<never>((_resolve, reject) => {
        abort = () => reject(new AevorenBotError("VOICE_CAPTURE_INVALID"));
        signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
      })]);
    } finally { signal.removeEventListener("abort", abort); }
  }
  async begin(input: VoiceCaptureBegin): Promise<VoiceCaptureIntent> { return this.issue(input, false); }
  async beginRealtime(sessionId: string): Promise<VoiceCaptureIntent> {
    return this.issue({ sessionId, draftVersion: 0, baseDigest: "0".repeat(64) }, true);
  }
  realtimeLease(sessionId: string, captureId: string): { captureId: string; signal: AbortSignal; assertCurrent(): void } {
    const capture = this.capture;
    if (!capture?.realtime || capture.stage !== "issued" || capture.intent.sessionId !== sessionId || capture.intent.captureId !== captureId) throw new AevorenBotError("VOICE_CAPTURE_INVALID");
    this.check(capture);
    return { captureId, signal: capture.controller.signal, assertCurrent: () => this.check(capture) };
  }
  private async issue(input: VoiceCaptureBegin, realtime: boolean): Promise<VoiceCaptureIntent> {
    const parsed = voiceCaptureBeginSchema.parse(input);
    if (this.closed) throw new AevorenBotError("VOICE_CAPTURE_INVALID");
    const session = this.repository.getSession(parsed.sessionId);
    if (session.roomId && this.repository.getRoom(session.roomId).archivedAt) throw new AevorenBotError("ROOM_ARCHIVED");
    this.invalidate();
    const capture: Capture = { intent: { ...parsed, captureId: randomUUID(), expiresAt: new Date(this.now() + permissionWindowMs).toISOString() },
      document: this.dependencies.identity(), generation: session.generation, deadline: this.now() + 150_000,
      realtime, stage: "requesting", controller: new AbortController() };
    this.capture = capture;
    try {
      if (!await this.wait(this.dependencies.hasUserActivation(), capture)) throw new AevorenBotError("VOICE_CAPTURE_INVALID");
      this.check(capture);
      if (!await this.wait(this.dependencies.requestMicrophone(), capture)) throw new AevorenBotError("VOICE_PERMISSION_DENIED");
      this.check(capture);
      capture.intent.expiresAt = new Date(this.now() + permissionWindowMs).toISOString();
      const duration = realtime ? REALTIME_CAPTURE_MAX_DURATION_MS : VOICE_CAPTURE_MAX_DURATION_MS;
      capture.deadline = this.now() + duration + permissionWindowMs;
      capture.stage = "issued";
      capture.timer = setTimeout(() => { if (this.capture === capture) this.invalidate(); }, duration + permissionWindowMs);
      return { ...capture.intent };
    } catch (error) { if (this.capture === capture) this.invalidate(); throw error; }
  }
  allows(webContentsId: number | null, permission: string, details: { isMainFrame?: boolean; requestingUrl?: string; mediaType?: string; mediaTypes?: string[] }): boolean {
    const capture = this.capture;
    if (!capture || capture.stage !== "issued" || permission !== "media" || details.isMainFrame !== true
      || details.requestingUrl !== capture.document.url || webContentsId !== capture.document.webContentsId
      || this.now() > Date.parse(capture.intent.expiresAt)) return false;
    const audio = details.mediaTypes ? details.mediaTypes.length === 1 && details.mediaTypes[0] === "audio" : details.mediaType === "audio";
    if (!audio) return false;
    try { this.check(capture); return true; } catch { return false; }
  }
  async commit(input: VoiceCaptureCommit): Promise<MessageMediaReference> {
    const parsed = voiceCaptureCommitSchema.parse(input), capture = this.capture;
    if (!capture || capture.realtime || capture.stage !== "issued" || parsed.sessionId !== capture.intent.sessionId || parsed.captureId !== capture.intent.captureId
      || parsed.baseDigest !== capture.intent.baseDigest || parsed.draftVersion !== capture.intent.draftVersion) throw new AevorenBotError("VOICE_CAPTURE_INVALID");
    this.check(capture);
    const mimeType = parsed.mimeType.toLowerCase().split(";")[0]!.trim();
    const extension = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/wav": "wav", "audio/mpeg": "mp3" }[mimeType];
    if (!extension) throw new AevorenBotError("VOICE_UNSUPPORTED");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(parsed.dataBase64)) throw new AevorenBotError("VOICE_RESPONSE_INVALID");
    const bytes = Buffer.from(parsed.dataBase64, "base64");
    if (!bytes.length || bytes.length > VOICE_AUDIO_MAX_BYTES) throw new AevorenBotError("VOICE_TOO_LARGE");
    capture.stage = "publishing";
    const work = this.dependencies.publish({ sessionId: parsed.sessionId, bytes, mimeType, name: `recording-${capture.intent.captureId}.${extension}` },
      { signal: capture.controller.signal, assertCurrent: () => this.check(capture) });
    this.pending.add(work);
    try { const reference = await work; this.check(capture); return reference; }
    finally { this.pending.delete(work); if (this.capture === capture) this.invalidate(); }
  }
  cancel(input: VoiceScope & { captureId: string }): void {
    const parsed = voiceCaptureCancelSchema.parse(input), capture = this.capture;
    if (capture && parsed.captureId === capture.intent.captureId && parsed.sessionId === capture.intent.sessionId) this.invalidate();
  }
  cancelSession(sessionId: string): void { if (this.capture?.intent.sessionId === sessionId) this.invalidate(); }
  invalidate(): void {
    const capture = this.capture; this.capture = null;
    if (capture) { clearTimeout(capture.timer); capture.controller.abort(); }
  }
  async shutdown(): Promise<void> { this.closed = true; this.invalidate(); await Promise.allSettled([...this.pending]); }
}
