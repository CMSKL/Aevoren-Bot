import { Buffer } from "node:buffer";
/** Own synthetic PCM; never records a microphone or reads external media. */
export function wavFixture(durationMs = 250, format = 1): Buffer {
  const rate = 8_000, samples = Math.ceil(rate * durationMs / 1_000), data = Buffer.alloc(samples * 2), header = Buffer.alloc(44);
  for (let index = 0; index < samples; index++) data.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 440 / rate) * 4_000), index * 2);
  header.write("RIFF"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(format, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
/** Structural MP4 admission fixture only; codec proof is supplied by controlled unit parser. */
export function mp4TrackFixture(kind: "soun" | "vide"): Buffer {
  const box = (name: string, body: Buffer): Buffer => { const header = Buffer.alloc(8); header.writeUInt32BE(body.length + 8); header.write(name, 4); return Buffer.concat([header, body]); };
  const handler = Buffer.alloc(12); handler.write(kind, 8);
  return Buffer.concat([box("ftyp", Buffer.from("isom0000")), box("moov", box("trak", box("mdia", box("hdlr", handler))))]);
}
