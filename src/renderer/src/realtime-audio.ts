import workletUrl from "./realtime-audio.worklet?worker&url";
import type { RenderedAudio } from "./realtime-pcm";

export function pcmBase64(bytes: Uint8Array): string { let text = ""; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text); }
export function pcmBytes(value: string): Uint8Array {
  const binary = atob(value); if (!binary.length || binary.length % 2 || binary.length > 524_288) throw new Error("实时音频帧无效。");
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

/** Local audio only. Credentials and the remote connection remain in Main. */
export class RealtimeAudio {
  private readonly context = new AudioContext();
  private readonly resumed = this.context.resume();
  private node: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private closed = false;
  private sequence = 0;
  private readonly requests = new Map<number, { resolve(value: RenderedAudio[]): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly prepared: Promise<void>;
  constructor(private readonly callbacks: { capture(bytes: Uint8Array): void; played(played: RenderedAudio[]): void; blocked(value: boolean): void; error(error: Error): void }) {
    this.context.onstatechange = () => { if (!this.closed) callbacks.blocked(this.context.state !== "running"); };
    this.prepared = this.context.audioWorklet.addModule(workletUrl).then(() => {
      if (this.closed) return;
      const node = new AudioWorkletNode(this.context, "aevoren-realtime-audio", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] }); this.node = node;
      node.port.onmessage = (event: MessageEvent<{ type: string; id?: number; bytes?: ArrayBuffer; played?: RenderedAudio[]; message?: string }>) => {
        if (this.closed) return;
        const message = event.data;
        if (message.type === "capture" && message.bytes) callbacks.capture(new Uint8Array(message.bytes));
        else if (message.type === "played") callbacks.played(message.played ?? []);
        else if (message.type === "committed" || message.type === "interrupted") { const request = this.requests.get(message.id!); if (request) { clearTimeout(request.timer); request.resolve(message.played ?? []); this.requests.delete(message.id!); } }
        else if (message.type === "error") callbacks.error(new Error(message.message ?? "实时音频处理失败。"));
      };
      node.onprocessorerror = () => { if (!this.closed) callbacks.error(new Error("实时音频处理器已停止。")); };
      node.connect(this.context.destination); callbacks.blocked(this.context.state !== "running");
    });
    void this.prepared.catch(failure => { if (!this.closed) callbacks.error(failure instanceof Error ? failure : new Error("无法加载实时音频处理器。")); });
    void this.resumed.catch(() => { if (!this.closed) callbacks.blocked(true); });
  }
  async prepareMicrophone(): Promise<void> {
    await this.prepared;
    if (this.closed) throw new Error("通话已停止。");
    if (this.stream) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    if (this.closed) { stream.getTracks().forEach(track => track.stop()); throw new Error("通话已停止。"); }
    this.stream = stream; this.source = this.context.createMediaStreamSource(stream);
    for (const track of stream.getTracks()) track.onended = () => { if (!this.closed) this.callbacks.error(new Error("麦克风已断开，通话已停止。")); };
  }
  async startMicrophone(): Promise<void> {
    await this.prepareMicrophone();
    if (this.context.state !== "running") throw new Error("请先点击启用音频，再开始说话。");
    this.node!.port.postMessage({ type: "capture" }); this.source!.connect(this.node!);
  }
  private stopMicrophone(): void { this.source?.disconnect(); this.source = null; this.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); }); this.stream = null; }
  private command(type: "commit" | "interrupt"): Promise<RenderedAudio[]> {
    if (this.closed || !this.node) return Promise.reject(new Error("通话音频已关闭。"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(id); reject(new Error("音频处理器未确认停止，通话已关闭。")); }, 2000);
      this.requests.set(id, { resolve, reject, timer }); this.node!.port.postMessage({ type, id });
    });
  }
  async commit(): Promise<void> { await this.command("commit"); this.stopMicrophone(); }
  interrupt(): Promise<RenderedAudio[]> { return this.command("interrupt"); }
  append(key: string, bytes: Uint8Array): void {
    if (this.closed || !this.node) return;
    const buffer = new Uint8Array(bytes).buffer; this.node.port.postMessage({ type: "append", key, bytes: buffer }, [buffer]);
  }
  async resume(): Promise<void> { await this.context.resume(); this.callbacks.blocked(this.context.state !== "running"); }
  close(): void {
    if (this.closed) return; this.closed = true; this.stopMicrophone();
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(new Error("通话已停止。")); } this.requests.clear();
    if (this.node) { this.node.port.postMessage({ type: "stop" }); this.node.port.onmessage = null; this.node.disconnect(); this.node = null; }
    this.context.onstatechange = null; void this.context.close();
  }
}
