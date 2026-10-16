import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { wavFixture } from "../../tests/fixtures/media-av-data";
import { avMime, inspectAvHeader, normalizedMediaMime, sameAvFamily } from "../shared/media-av-format";

describe("A/V container preflight", () => {
  it("recognizes bounded PCM, normalizes recorder hints and keeps structural recognition separate from codec support", () => {
    const header = inspectAvHeader(wavFixture())!;
    expect(header).toEqual({ family: "wav", audio: true, video: false }); expect(avMime(header, "audio")).toBe("audio/wav");
    expect(inspectAvHeader(wavFixture(250, 65535))).toEqual(header);
    expect(normalizedMediaMime("audio/webm;codecs=opus")).toBe("audio/webm");
    expect(normalizedMediaMime("audio/x-wav")).toBe("audio/wav");
    expect(sameAvFamily("audio/mp4", { family: "mp4", audio: true, video: false })).toBe(true);
    expect(() => normalizedMediaMime("audio/webm\nunsafe")).toThrow();
  });
  it("rejects truncated chunks, inflated RIFF sizes and unknown arbitrary bytes", () => {
    const bytes = wavFixture(); expect(() => inspectAvHeader(bytes.subarray(0, -1))).toThrow();
    bytes.writeUInt32LE(0xffffffff, 16); expect(() => inspectAvHeader(bytes)).toThrow();
    expect(inspectAvHeader(Buffer.from("not media"))).toBe(null);
  });
  it("bounds nested MP4 boxes and requires actual track handlers before browser decoding", () => {
    const box = (kind: string, body: Buffer): Buffer => { const head = Buffer.alloc(8); head.writeUInt32BE(8 + body.length); head.write(kind, 4); return Buffer.concat([head, body]); };
    const handler = Buffer.alloc(12); handler.write("soun", 8);
    const bytes = Buffer.concat([box("ftyp", Buffer.from("isom0000")), box("moov", box("trak", box("mdia", box("hdlr", handler))))]);
    expect(inspectAvHeader(bytes)).toEqual({ family: "mp4", audio: true, video: false });
    expect(() => inspectAvHeader(bytes.subarray(0, -1))).toThrow();
    expect(() => inspectAvHeader(box("ftyp", Buffer.from("isom0000")))).toThrow();
  });
});
