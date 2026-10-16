import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
type OutputMessage = { type: string; id?: number; bytes?: ArrayBuffer; played?: { key: string; playedSamples: number }[] };
type Port = { onmessage: ((event: { data: object }) => void) | null; postMessage(message: OutputMessage): void; messages: OutputMessage[] };
type Processor = { port: Port; process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean };
let ProcessorType: new() => Processor;
beforeAll(async () => {
  vi.stubGlobal("sampleRate", 48_000);
  vi.stubGlobal("AudioWorkletProcessor", class { port: Port = { onmessage: null, messages: [], postMessage(message) { this.messages.push(message); } }; });
  vi.stubGlobal("registerProcessor", (name: string, type: new() => Processor) => { expect(name).toBe("aevoren-realtime-audio"); ProcessorType = type; });
  await import("./realtime-audio.worklet");
});
afterAll(() => vi.unstubAllGlobals());
function command(processor: Processor, data: object): void { processor.port.onmessage?.({ data }); }
describe("realtime AudioWorklet processor", () => {
  it("never emits microphone data until a manual capture command and flushes before the commit acknowledgement", () => {
    const processor = new ProcessorType(), block = [new Float32Array(128).fill(0.5), new Float32Array(128).fill(-0.5)];
    processor.process([block], [[new Float32Array(128)]]); expect(processor.port.messages.filter(message => message.type === "capture")).toEqual([]);
    command(processor, { type: "capture" });
    for (let index = 0; index < 64; index++) processor.process([block], [[new Float32Array(128)]]);
    command(processor, { type: "commit", id: 7 });
    const captured = processor.port.messages.filter(message => message.type === "capture");
    expect(captured.reduce((total, message) => total + message.bytes!.byteLength, 0)).toBe(4096 * 2);
    expect(captured.every(message => new Uint8Array(message.bytes!).every(byte => byte === 0))).toBe(true);
    expect(processor.port.messages.at(-1)).toMatchObject({ type: "committed", id: 7 });
    const count = captured.length; processor.process([block], [[new Float32Array(128)]]);
    expect(processor.port.messages.filter(message => message.type === "capture")).toHaveLength(count);
  });
  it("acknowledges only actually rendered source samples and purges queued audio before final interrupt ack", () => {
    const processor = new ProcessorType(), bytes = new Uint8Array(48_000);
    command(processor, { type: "append", key: "epoch1-item", bytes: bytes.buffer });
    const output = new Float32Array(128); processor.process([], [[output]]);
    command(processor, { type: "interrupt", id: 8 });
    expect(processor.port.messages.at(-1)).toEqual({ type: "interrupted", id: 8, played: [{ key: "epoch1-item", playedSamples: 64 }] });
    output.fill(1); processor.process([], [[output]]); expect([...output].every(value => value === 0)).toBe(true);
  });
  it("emits an error and clears output when a PCM chunk is malformed", () => {
    const processor = new ProcessorType(); command(processor, { type: "append", key: "bad", bytes: new Uint8Array(3).buffer });
    expect(processor.port.messages.at(-1)).toMatchObject({ type: "error" });
    const output = new Float32Array(128).fill(1); processor.process([], [[output]]); expect([...output].every(value => value === 0)).toBe(true);
  });
});
