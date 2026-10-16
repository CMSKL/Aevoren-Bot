import { randomUUID } from "node:crypto";
import { WebSocket, type ClientOptions } from "ws";
import { AevorenBotError } from "./errors";
import { parseRealtimeEvent, REALTIME_MAX_MESSAGE_BYTES, realtimeSessionUpdate, type RealtimeWireEvent } from "./realtime-protocol";

export type RealtimeSocketFactory = (url: URL, options: ClientOptions) => WebSocket;
export type RealtimeSocketOptions = { model: string; voice: string; apiKey: string; signal: AbortSignal; assertCurrent(): void;
  onEvent(event: RealtimeWireEvent): void; onClosed(code: "VOICE_REQUEST_UNKNOWN" | "VOICE_RESPONSE_INVALID"): void };

/** Host-owned socket. No retry, redirect, alternate endpoint or Renderer credential handoff. */
export class RealtimeSocketAdapter {
  private socket: WebSocket | undefined;
  private configured = false;
  private stopped = false;
  private abort: (() => void) | undefined;
  private closePromise: Promise<void> | undefined;
  constructor(private readonly options: RealtimeSocketOptions, private readonly factory: RealtimeSocketFactory = (url, settings) => new WebSocket(url, settings)) {}
  open(): Promise<void> {
    this.options.signal.throwIfAborted(); this.options.assertCurrent();
    if (this.socket || this.stopped) throw new AevorenBotError("VOICE_RESPONSE_INVALID");
    const url = new URL("wss://api.openai.com/v1/realtime"); url.searchParams.set("model", this.options.model);
    return new Promise<void>((resolve, reject) => {
      let settled = false, updateSent = false;
      const finish = (error?: Error): void => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(); };
      const fail = (code: "VOICE_REQUEST_UNKNOWN" | "VOICE_RESPONSE_INVALID"): void => {
        if (this.stopped) return; finish(new AevorenBotError(code)); this.options.onClosed(code); void this.close();
      };
      const timer = setTimeout(() => fail("VOICE_REQUEST_UNKNOWN"), 10_000);
      try {
        const socket = this.factory(url, { headers: { Authorization: `Bearer ${this.options.apiKey}` }, maxPayload: REALTIME_MAX_MESSAGE_BYTES,
          handshakeTimeout: 10_000, followRedirects: false, perMessageDeflate: false });
        this.socket = socket;
        this.abort = () => { finish(new AevorenBotError("TOOL_EXECUTION_CANCELLED")); void this.close(); };
        this.options.signal.addEventListener("abort", this.abort, { once: true });
        if (this.options.signal.aborted) this.abort();
        socket.on("message", (data, binary) => {
          if (this.stopped) return;
          try {
            this.options.signal.throwIfAborted(); this.options.assertCurrent();
            if (binary) throw new AevorenBotError("VOICE_RESPONSE_INVALID");
            const raw = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data;
            const event = parseRealtimeEvent(raw);
            if (event.type === "session.created") {
              if (updateSent) throw new AevorenBotError("VOICE_RESPONSE_INVALID");
              updateSent = true; this.sendRaw(realtimeSessionUpdate(this.options.model, this.options.voice));
            } else if (event.type === "session.updated") {
              if (!updateSent || !event.configured || event.model !== this.options.model || event.voice !== this.options.voice) throw new AevorenBotError("VOICE_RESPONSE_INVALID");
              this.configured = true; finish();
            } else if (!this.configured && event.type !== "ignored") throw new AevorenBotError("VOICE_RESPONSE_INVALID");
            this.options.onEvent(event);
          } catch { fail("VOICE_RESPONSE_INVALID"); }
        });
        socket.on("error", () => fail("VOICE_REQUEST_UNKNOWN"));
        socket.on("close", () => { if (!this.stopped) fail("VOICE_REQUEST_UNKNOWN"); });
      } catch { clearTimeout(timer); finish(new AevorenBotError("VOICE_REQUEST_FAILED")); void this.close(); }
    });
  }
  private sendRaw(event: Record<string, unknown>): void {
    this.options.signal.throwIfAborted(); this.options.assertCurrent();
    if (this.stopped || this.socket?.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > 262_144) throw new AevorenBotError("VOICE_REQUEST_UNKNOWN");
    const text = JSON.stringify(event); if (Buffer.byteLength(text) > REALTIME_MAX_MESSAGE_BYTES) throw new AevorenBotError("VOICE_TOO_LARGE");
    this.socket.send(text, error => { if (error && !this.stopped) { this.options.onClosed("VOICE_REQUEST_UNKNOWN"); void this.close(); } });
  }
  send(event: Record<string, unknown>): string {
    if (!this.configured) throw new AevorenBotError("VOICE_RESPONSE_INVALID");
    const eventId = randomUUID(); this.sendRaw({ ...event, event_id: eventId }); return eventId;
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.stopped = true; this.configured = false;
    if (this.abort) this.options.signal.removeEventListener("abort", this.abort);
    const socket = this.socket;
    this.closePromise = !socket || socket.readyState === WebSocket.CLOSED ? Promise.resolve() : new Promise<void>(resolve => {
      const timer = setTimeout(() => { socket.terminate(); resolve(); }, 250);
      socket.once("close", () => { clearTimeout(timer); resolve(); });
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate(); else socket.close();
    });
    return this.closePromise;
  }
}
