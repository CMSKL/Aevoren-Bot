const PCM_RATE = 24_000;

/** A small streaming windowed-sinc resampler. Its history survives render blocks. */
export class MicrophoneResampler {
  private samples: number[] = [];
  private base = 0;
  private received = 0;
  private emitted = 0;
  private first = 0;
  private last = 0;
  private ended = false;
  private readonly radius = 12;
  constructor(readonly inputRate: number) {
    if (!Number.isFinite(inputRate) || inputRate < 8_000 || inputRate > 192_000) throw new Error("Unsupported microphone sample rate");
  }
  push(channels: readonly Float32Array[]): Float32Array {
    if (this.ended) throw new Error("Microphone turn already ended");
    const length = channels[0]?.length ?? 0;
    if (channels.some(channel => channel.length !== length)) throw new Error("Mismatched microphone channels");
    for (let index = 0; index < length; index++) {
      let value = 0; for (const channel of channels) value += channel[index]! / channels.length;
      value = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
      if (!this.received) this.first = value;
      this.last = value; this.samples.push(value); this.received += 1;
    }
    return this.drain(false);
  }
  finish(): Float32Array { if (this.ended) return new Float32Array(); this.ended = true; return this.drain(true); }
  private drain(final: boolean): Float32Array {
    const output: number[] = [], ratio = this.inputRate / PCM_RATE, cutoff = Math.min(1, PCM_RATE / this.inputRate) * 0.94;
    const maximum = Math.floor(this.received / ratio);
    while (this.emitted < maximum) {
      const position = this.emitted * ratio;
      if (!final && position + this.radius >= this.received) break;
      const center = Math.floor(position); let value = 0, normalization = 0;
      for (let index = center - this.radius + 1; index <= center + this.radius; index++) {
        const distance = index - position;
        const sinc = distance === 0 ? cutoff : Math.sin(Math.PI * cutoff * distance) / (Math.PI * distance);
        const weight = sinc * (0.5 + 0.5 * Math.cos(Math.PI * distance / this.radius));
        const sample = index < 0 ? this.first : index >= this.received ? this.last : this.samples[index - this.base]!;
        value += sample * weight; normalization += weight;
      }
      output.push(value / normalization); this.emitted += 1;
    }
    const retain = Math.max(this.base, Math.floor(this.emitted * ratio) - this.radius);
    this.samples.splice(0, retain - this.base); this.base = retain;
    return Float32Array.from(output);
  }
}

export function encodePcm16(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2), view = new DataView(bytes.buffer);
  samples.forEach((value, index) => { const bounded = Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0)); view.setInt16(index * 2, Math.round(bounded * (bounded < 0 ? 32768 : 32767)), true); });
  return bytes;
}
export function decodePcm16(bytes: Uint8Array): Float32Array {
  if (!bytes.length || bytes.length % 2) throw new Error("Invalid PCM16 audio");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), output = new Float32Array(bytes.length / 2);
  for (let index = 0; index < output.length; index++) { const value = view.getInt16(index * 2, true); output[index] = value / (value < 0 ? 32768 : 32767); }
  return output;
}

export type RenderedAudio = { key: string; playedSamples: number };
type Chunk = { key: string; samples: Float32Array; offset: number };
/** Counts source samples only after their output duration was actually rendered. */
export class RealtimeOutputQueue {
  private readonly chunks: Chunk[] = [];
  private readonly played = new Map<string, number>();
  private fraction = 0;
  private queued = 0;
  private lastKey: string | null = null;
  constructor(readonly outputRate: number) { if (!Number.isFinite(outputRate) || outputRate < 8_000 || outputRate > 192_000) throw new Error("Unsupported output sample rate"); }
  append(key: string, samples: Float32Array): void {
    if (this.queued + samples.length > PCM_RATE * 30) throw new Error("Realtime playback exceeded 30 seconds of queued audio");
    if (samples.length) { this.chunks.push({ key, samples, offset: 0 }); this.queued += samples.length; }
  }
  render(output: Float32Array): void {
    output.fill(0);
    for (let frame = 0; frame < output.length; frame++) {
      const chunk = this.chunks[0]; if (!chunk) break;
      if (this.lastKey !== chunk.key) { this.lastKey = chunk.key; this.fraction = 0; }
      const current = chunk.samples[chunk.offset]!;
      const nextChunk = this.chunks[1];
      const next = chunk.offset + 1 < chunk.samples.length ? chunk.samples[chunk.offset + 1]! : nextChunk?.key === chunk.key ? nextChunk.samples[nextChunk.offset]! : current;
      output[frame] = current + (next - current) * (this.fraction / this.outputRate);
      this.fraction += PCM_RATE;
      while (this.fraction >= this.outputRate && this.chunks[0]?.key === chunk.key) {
        this.fraction -= this.outputRate; const consumed = this.chunks[0]!; consumed.offset += 1; this.queued -= 1;
        this.played.set(chunk.key, (this.played.get(chunk.key) ?? 0) + 1);
        if (consumed.offset === consumed.samples.length) this.chunks.shift();
      }
    }
  }
  acknowledgements(): RenderedAudio[] { return [...this.played].map(([key, playedSamples]) => ({ key, playedSamples })); }
  interrupt(): RenderedAudio[] { const result = this.acknowledgements(); this.chunks.length = 0; this.played.clear(); this.queued = 0; this.fraction = 0; this.lastKey = null; return result; }
}
