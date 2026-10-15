import { describe, expect, it } from "vitest";
import { decodePcm16, encodePcm16, MicrophoneResampler, RealtimeOutputQueue } from "./realtime-pcm";

function resample(rate: number, channels: Float32Array[], blocks: number[]): Float32Array {
  const encoder = new MicrophoneResampler(rate), parts: Float32Array[] = []; let offset = 0;
  for (const block of blocks) { parts.push(encoder.push(channels.map(channel => channel.slice(offset, offset + block)))); offset += block; }
  if (offset < channels[0]!.length) parts.push(encoder.push(channels.map(channel => channel.slice(offset))));
  parts.push(encoder.finish()); return Float32Array.from(parts.flatMap(part => [...part]));
}
describe("realtime microphone PCM", () => {
  it.each([44_100, 48_000, 96_000, 16_000])("resamples actual %i Hz without gaps across irregular render blocks", rate => {
    const input = Float32Array.from({ length: rate }, (_, index) => Math.sin(2 * Math.PI * 440 * index / rate) * 0.4);
    const split = resample(rate, [input], [128, 5, 777, 511, 3, 999]);
    const whole = resample(rate, [input], [rate]);
    expect(split).toHaveLength(24_000); expect(split).toEqual(whole);
    expect(split.every(Number.isFinite)).toBe(true);
  });
  it("downmixes stereo before encoding, rather than selecting the left channel", () => {
    const left = new Float32Array(480).fill(0.75), right = new Float32Array(480).fill(-0.25);
    const result = resample(48_000, [left, right], [128, 128]); expect(result).toHaveLength(240);
    expect([...result].every(value => Math.abs(value - 0.25) < 0.000001)).toBe(true);
  });
  it("attenuates frequencies above the 24 kHz output Nyquist limit", () => {
    const high = Float32Array.from({ length: 4800 }, (_, index) => Math.sin(2 * Math.PI * 20_000 * index / 48_000));
    const result = resample(48_000, [high], [128]); const middle = result.slice(100, -100);
    expect(Math.sqrt(middle.reduce((sum, value) => sum + value * value, 0) / middle.length)).toBeLessThan(0.03);
  });
  it("encodes signed little-endian PCM16 and clamps invalid/out-of-range samples", () => {
    const bytes = encodePcm16(Float32Array.from([-2, -1, 0, 0.5, 1, 2, NaN]));
    expect([...bytes]).toEqual([0, 128, 0, 128, 0, 0, 0, 64, 255, 127, 255, 127, 0, 0]);
    const decoded = decodePcm16(bytes); expect(decoded[0]).toBe(-1); expect(decoded[4]).toBe(1);
    expect(() => decodePcm16(new Uint8Array(3))).toThrow("Invalid PCM16");
  });
});
describe("realtime rendered output accounting", () => {
  it.each([44_100, 48_000])("counts samples rendered at %i Hz, including silence, instead of received bytes", rate => {
    const output = new RealtimeOutputQueue(rate); output.append("item-1", new Float32Array(24_000));
    expect(output.acknowledgements()).toEqual([]); output.render(new Float32Array(rate / 10));
    expect(output.acknowledgements()).toEqual([{ key: "item-1", playedSamples: 2400 }]);
    output.render(new Float32Array(rate - rate / 10)); expect(output.interrupt()).toEqual([{ key: "item-1", playedSamples: 24_000 }]);
  });
  it("preserves playback across chunk boundaries and clears unplayed data on interrupt", () => {
    const output = new RealtimeOutputQueue(48_000); output.append("first", Float32Array.from([0.2, 0.4])); output.append("first", Float32Array.from([0.6, 0.8])); output.append("next", new Float32Array(100).fill(1));
    const samples = new Float32Array(5); output.render(samples);
    expect([...samples]).toEqual([...Float32Array.from([0.2, 0.3, 0.4, 0.5, 0.6])]);
    expect(output.interrupt()).toEqual([{ key: "first", playedSamples: 2 }]);
    const after = new Float32Array(100); output.render(after); expect([...after].every(value => value === 0)).toBe(true); expect(output.acknowledgements()).toEqual([]);
  });
  it("keeps identities separate when the following item was received before the first finished", () => {
    const output = new RealtimeOutputQueue(48_000); output.append("old", new Float32Array(2)); output.append("new", new Float32Array(4));
    output.render(new Float32Array(6)); expect(output.acknowledgements()).toEqual([{ key: "old", playedSamples: 2 }, { key: "new", playedSamples: 1 }]);
  });
  it("bounds queued output and never counts underrun silence as model audio", () => {
    const output = new RealtimeOutputQueue(48_000); output.render(new Float32Array(1024)); expect(output.acknowledgements()).toEqual([]);
    expect(() => output.append("too-large", new Float32Array(24_000 * 30 + 1))).toThrow("30 seconds");
  });
});
