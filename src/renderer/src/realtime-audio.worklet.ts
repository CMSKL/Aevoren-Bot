import { decodePcm16, encodePcm16, MicrophoneResampler, RealtimeOutputQueue } from "./realtime-pcm";

declare const sampleRate: number;
declare const AudioWorkletProcessor: { new(): { readonly port: MessagePort } };
declare function registerProcessor(name: string, processor: typeof RealtimeAudioProcessor): void;

class RealtimeAudioProcessor extends AudioWorkletProcessor {
  private capture: MicrophoneResampler | null = null;
  private pending: number[] = [];
  private output = new RealtimeOutputQueue(sampleRate);
  private rendered = 0;
  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<{ type: string; id?: number; key?: string; bytes?: ArrayBuffer }>) => {
      try {
        const message = event.data;
        if (message.type === "capture") { this.capture = new MicrophoneResampler(sampleRate); this.pending = []; }
        else if (message.type === "commit") {
          if (this.capture) this.sendCapture(this.capture.finish(), true);
          this.capture = null; this.port.postMessage({ type: "committed", id: message.id });
        } else if (message.type === "append" && message.key && message.bytes) this.output.append(message.key, decodePcm16(new Uint8Array(message.bytes)));
        else if (message.type === "interrupt") this.port.postMessage({ type: "interrupted", id: message.id, played: this.output.interrupt() });
        else if (message.type === "stop") { this.capture = null; this.pending = []; this.output.interrupt(); }
      } catch { this.port.postMessage({ type: "error", message: "实时音频处理失败，通话已停止。" }); this.capture = null; this.pending = []; this.output.interrupt(); }
    };
  }
  private sendCapture(samples: Float32Array, final = false): void {
    for (const sample of samples) this.pending.push(sample);
    while (this.pending.length >= 480 || final && this.pending.length) {
      const bytes = encodePcm16(Float32Array.from(this.pending.splice(0, 480)));
      this.port.postMessage({ type: "capture", bytes: bytes.buffer }, [bytes.buffer]);
    }
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.capture && inputs[0]?.length) this.sendCapture(this.capture.push(inputs[0]));
    const output = outputs[0]?.[0];
    if (output) {
      this.output.render(output); this.rendered += output.length;
      if (this.rendered >= sampleRate / 10) { this.rendered = 0; this.port.postMessage({ type: "played", played: this.output.acknowledgements() }); }
    }
    return true;
  }
}
registerProcessor("aevoren-realtime-audio", RealtimeAudioProcessor);
