import { VOICE_AUDIO_MAX_BYTES, VOICE_TEXT_MAX_CHARACTERS, VOICE_TRANSCRIPT_MAX_CHARACTERS } from "@shared/voice-schemas";
import { AevorenBotError } from "./errors";

export type VoiceFetch = (url: URL, init: RequestInit) => Promise<Response>;
export class VoiceHttpError extends AevorenBotError {
  constructor(code: "VOICE_REQUEST_FAILED" | "VOICE_RESPONSE_INVALID" | "VOICE_TOO_LARGE", readonly unknownOutcome = false) { super(code); }
}
type Authorization = { apiKey: string; model: string; signal: AbortSignal; assertCurrent(): void };
const MAX_SSE_BYTES = 2 * 1_048_576;
const HTTP_TIMEOUT_MS = 120_000;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VoiceHttpError("VOICE_RESPONSE_INVALID", true);
  return value as Record<string, unknown>;
}
function validText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(value)) !== value)
    throw new VoiceHttpError("VOICE_RESPONSE_INVALID", true);
  return value;
}

export class VoiceHttpAdapter {
  constructor(private readonly fetchFn: VoiceFetch = (url, init) => fetch(url, init)) {}
  private async response(path: "/v1/audio/transcriptions" | "/v1/audio/speech", auth: Authorization, body: BodyInit, json = false): Promise<{ response: Response; check(): void }> {
    const signal = AbortSignal.any([auth.signal, AbortSignal.timeout(HTTP_TIMEOUT_MS)]);
    const check = (): void => { signal.throwIfAborted(); auth.assertCurrent(); };
    if (!auth.apiKey || /[\r\n\0]/u.test(auth.apiKey)) throw new AevorenBotError("VOICE_CONFIGURATION_REQUIRED");
    check(); let response: Response;
    try { response = await this.fetchFn(new URL(`https://api.openai.com${path}`), { method: "POST", redirect: "error", signal,
      headers: { authorization: `Bearer ${auth.apiKey}`, ...(json ? { "content-type": "application/json" } : {}) }, body }); }
    catch { check(); throw new VoiceHttpError("VOICE_REQUEST_FAILED", true); }
    try { check(); } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
    if (response.redirected || !response.ok) { await response.body?.cancel().catch(() => {}); throw new VoiceHttpError("VOICE_REQUEST_FAILED"); }
    return { response, check };
  }
  async transcribe(input: Authorization & { bytes: Uint8Array; mimeType: string; name: string; onDelta(delta: string): void }): Promise<string> {
    if (input.bytes.byteLength < 1 || input.bytes.byteLength > VOICE_AUDIO_MAX_BYTES) throw new VoiceHttpError("VOICE_TOO_LARGE");
    const form = new FormData(); form.set("model", input.model); form.set("stream", "true");
    form.set("file", new Blob([new Uint8Array(input.bytes)], { type: input.mimeType }), input.name);
    const { response, check } = await this.response("/v1/audio/transcriptions", input, form);
    if (!(response.headers.get("content-type") ?? "").toLowerCase().startsWith("text/event-stream")) { await response.body?.cancel(); throw new VoiceHttpError("VOICE_RESPONSE_INVALID", true); }
    const reader = response.body?.getReader(); if (!reader) throw new VoiceHttpError("VOICE_RESPONSE_INVALID", true);
    const decoder = new TextDecoder("utf-8", { fatal: true }); let buffered = "", totalBytes = 0, partial = "", final: string | undefined;
    const event = (raw: string): void => {
      const data = raw.split(/\r?\n/u).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      if (!data || data === "[DONE]") return;
      let value: Record<string, unknown>; try { value = object(JSON.parse(data)); } catch { throw new VoiceHttpError("VOICE_RESPONSE_INVALID", true); }
      if (value.type === "transcript.text.delta") {
        if (final !== undefined) throw new VoiceHttpError("VOICE_RESPONSE_INVALID", true);
        const delta = validText(value.delta, VOICE_TRANSCRIPT_MAX_CHARACTERS); partial += delta;
        if (partial.length > VOICE_TRANSCRIPT_MAX_CHARACTERS) throw new VoiceHttpError("VOICE_TOO_LARGE", true);
        check(); input.onDelta(delta); check();
      } else if (value.type === "transcript.text.done") {
        if (final !== undefined) throw new VoiceHttpError("VOICE_RESPONSE_INVALID", true);
        final = validText(value.text, VOICE_TRANSCRIPT_MAX_CHARACTERS);
      } else if (value.type === "error" || value.error) throw new VoiceHttpError("VOICE_REQUEST_FAILED", true);
    };
    try {
      while (true) {
        check(); const chunk = await reader.read(); check(); if (chunk.done) break;
        totalBytes += chunk.value.byteLength; if (totalBytes > MAX_SSE_BYTES) throw new VoiceHttpError("VOICE_TOO_LARGE", true);
        buffered += decoder.decode(chunk.value, { stream: true });
        let separator: RegExpExecArray | null;
        while ((separator = /\r?\n\r?\n/u.exec(buffered))) { event(buffered.slice(0, separator.index)); buffered = buffered.slice(separator.index + separator[0].length); }
        if (buffered.length > MAX_SSE_BYTES) throw new VoiceHttpError("VOICE_TOO_LARGE", true);
      }
      buffered += decoder.decode(); if (buffered.trim()) event(buffered); check();
      if (final === undefined) throw new VoiceHttpError("VOICE_RESPONSE_INVALID", true);
      return final;
    } catch (error) {
      await reader.cancel().catch(() => {}); check();
      if (error instanceof VoiceHttpError) throw error;
      throw new VoiceHttpError("VOICE_REQUEST_FAILED", true);
    } finally { reader.releaseLock(); }
  }
  async speak(input: Authorization & { text: string; voice: string }): Promise<Buffer> {
    if (!input.text || input.text.length > VOICE_TEXT_MAX_CHARACTERS) throw new VoiceHttpError("VOICE_TOO_LARGE");
    const { response, check } = await this.response("/v1/audio/speech", input, JSON.stringify({ model: input.model, voice: input.voice, input: input.text, response_format: "pcm", stream_format: "audio" }), true);
    const contentType=(response.headers.get("content-type")??"").split(";",1)[0]!.trim().toLowerCase();
    if(!["audio/pcm","audio/raw","application/octet-stream"].includes(contentType)){await response.body?.cancel();throw new VoiceHttpError("VOICE_RESPONSE_INVALID");}
    const maximum = VOICE_AUDIO_MAX_BYTES - 44, declared = response.headers.get("content-length");
    if (declared && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) { await response.body?.cancel(); throw new VoiceHttpError("VOICE_TOO_LARGE"); }
    const reader = response.body?.getReader(); if (!reader) throw new VoiceHttpError("VOICE_RESPONSE_INVALID");
    const parts: Uint8Array[] = []; let total = 0;
    try {
      while (true) { check(); const chunk = await reader.read(); check(); if (chunk.done) break;
        total += chunk.value.byteLength; if (total > maximum) throw new VoiceHttpError("VOICE_TOO_LARGE"); parts.push(chunk.value); }
      check(); return pcmToWav(Buffer.concat(parts, total));
    } catch (error) { await reader.cancel().catch(() => {}); check(); if (error instanceof VoiceHttpError) throw error; throw new VoiceHttpError("VOICE_REQUEST_FAILED", true); }
    finally { reader.releaseLock(); }
  }
}

/** The reference speech endpoint returns mono 24 kHz signed 16-bit little-endian PCM. */
export function pcmToWav(pcm: Uint8Array): Buffer {
  if (pcm.byteLength < 2 || pcm.byteLength % 2 || pcm.byteLength + 44 > VOICE_AUDIO_MAX_BYTES) throw new VoiceHttpError("VOICE_RESPONSE_INVALID");
  const wav = Buffer.alloc(pcm.byteLength + 44); wav.write("RIFF", 0); wav.writeUInt32LE(pcm.byteLength + 36, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24_000, 24); wav.writeUInt32LE(48_000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(pcm.byteLength, 40); wav.set(pcm, 44); return wav;
}
