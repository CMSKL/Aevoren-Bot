import type { SupportedMediaMime } from "./media-contracts";

export type AvHeader = { family: "wav" | "mpeg" | "ogg" | "webm" | "mp4"; audio: boolean; video: boolean };
function invalid(): never { throw new Error("MEDIA_CONTENT_INVALID"); }
const ascii = (bytes: Uint8Array, start: number, length: number): string => String.fromCharCode(...bytes.subarray(start, start + length));
export const isAvMime = (mime: string): boolean => mime.startsWith("audio/") || mime.startsWith("video/");
export function avMime(header: AvHeader, kind: "audio" | "video"): SupportedMediaMime {
  if (header.family === "wav") return "audio/wav";
  if (header.family === "mpeg") return "audio/mpeg";
  return `${kind}/${header.family}`;
}
export function normalizedMediaMime(value: string): string {
  if (typeof value !== "string" || value.length > 200 || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) invalid();
  const base = value.split(";", 1)[0]!.trim().toLowerCase();
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(base)) invalid();
  return ({ "audio/x-wav": "audio/wav", "audio/wave": "audio/wav", "audio/mp3": "audio/mpeg", "application/ogg": "audio/ogg" } as Record<string, string>)[base] ?? base;
}
export function sameAvFamily(mime: string, header: AvHeader): boolean {
  return header.family === "mpeg" ? mime === "audio/mpeg" : header.family === "wav" ? mime === "audio/wav" : mime === `audio/${header.family}` || mime === `video/${header.family}`;
}

/** Structural preflight only; a header never substitutes for Chromium decoding. */
export function inspectAvHeader(bytes: Uint8Array): AvHeader | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), size = bytes.length;
  if (size >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") {
    if (view.getUint32(4, true) + 8 !== size) invalid();
    let format = false, data = false;
    for (let offset = 12; offset < size;) {
      if (offset + 8 > size) invalid(); const length = view.getUint32(offset + 4, true), end = offset + 8 + length;
      if (end + (length & 1) > size) invalid();
      const id = ascii(bytes, offset, 4);
      if (id === "fmt ") { if (format || length < 16 || !view.getUint16(offset + 10, true) || !view.getUint32(offset + 12, true)) invalid(); format = true; }
      if (id === "data") { if (data || !length) invalid(); data = true; }
      offset = end + (length & 1);
    }
    if (!format || !data) invalid(); return { family: "wav", audio: true, video: false };
  }
  let mp3Start = 0;
  if (size >= 10 && ascii(bytes, 0, 3) === "ID3") {
    if (![2, 3, 4].includes(bytes[3]!) || bytes.subarray(6, 10).some(value => value > 127)) invalid();
    mp3Start = 10 + bytes.subarray(6, 10).reduce((value, byte) => value * 128 + byte, 0) + (bytes[3] === 4 && (bytes[5]! & 16) ? 10 : 0);
    if (mp3Start >= size) invalid();
  }
  if (mp3Start || bytes[0] === 255) for (let offset = mp3Start; offset + 4 <= Math.min(size, mp3Start + 4096); offset++) if (bytes[offset] === 255 && (bytes[offset + 1]! & 224) === 224
    && (bytes[offset + 1]! & 24) !== 8 && (bytes[offset + 1]! & 6) === 2 && (bytes[offset + 2]! & 240) !== 240 && (bytes[offset + 2]! & 12) !== 12) return { family: "mpeg", audio: true, video: false };
  if (mp3Start) invalid();
  if (size >= 4 && ascii(bytes, 0, 4) === "OggS") {
    let audio = false, video = false, pages = 0; const serials = new Set<number>();
    for (let offset = 0; offset < size;) {
      if (++pages > 100_000 || offset + 27 > size || ascii(bytes, offset, 4) !== "OggS" || bytes[offset + 4] !== 0) invalid();
      const count = bytes[offset + 26]!, start = offset + 27 + count;
      if (start > size) invalid();
      const length = bytes.subarray(offset + 27, start).reduce((sum, byte) => sum + byte, 0);
      if (start + length > size) invalid();
      if (bytes[offset + 5]! & 2) {
        const serial = view.getUint32(offset + 14, true); if (serials.has(serial) || serials.size >= 8) invalid(); serials.add(serial);
        const codec = ascii(bytes, start, Math.min(length, 8));
        if (codec.startsWith("OpusHead") || codec.startsWith("\u0001vorbis") || codec.startsWith("\u007fFLAC")) audio = true;
        else if (codec.startsWith("\u0080theora")) video = true;
        else invalid();
      }
      offset = start + length;
    }
    if (!audio && !video) invalid(); return { family: "ogg", audio, video };
  }
  if (size >= 8 && ascii(bytes, 4, 4) === "ftyp") {
    let audio = false, video = false, count = 0;
    const walk = (start: number, end: number, depth: number): void => {
      if (depth > 5) invalid();
      for (let offset = start; offset < end;) {
        if (++count > 100_000 || offset + 8 > end) invalid();
        let length = view.getUint32(offset), header = 8;
        if (length === 1) { if (offset + 16 > end) invalid(); const big = view.getBigUint64(offset + 8); if (big > BigInt(size)) invalid(); length = Number(big); header = 16; }
        else if (!length) length = end - offset;
        if (length < header || offset + length > end) invalid();
        const type = ascii(bytes, offset + 4, 4), payload = offset + header;
        if (["moov", "trak", "mdia"].includes(type)) walk(payload, offset + length, depth + 1);
        else if (type === "hdlr") { if (payload + 12 > offset + length) invalid(); const handler = ascii(bytes, payload + 8, 4); if (handler === "soun") audio = true; if (handler === "vide") video = true; }
        offset += length;
      }
    };
    walk(0, size, 0); if (!audio && !video) invalid(); return { family: "mp4", audio, video };
  }
  if (size >= 4 && view.getUint32(0) === 0x1a45dfa3) {
    let count = 0, webm = false, audio = false, video = false;
    const read = (offset: number, end: number): { id: number; start: number; end: number; unknown: boolean } => {
      if (++count > 100_000 || offset >= end || !bytes[offset]) invalid();
      let idLength = 1; while (!(bytes[offset]! & (128 >> (idLength - 1)))) if (++idLength > 4) invalid();
      let id = 0; for (let i = 0; i < idLength; i++) { if (offset + i >= end) invalid(); id = id * 256 + bytes[offset + i]!; }
      offset += idLength; if (offset >= end || !bytes[offset]) invalid();
      let lengthSize = 1; while (!(bytes[offset]! & (128 >> (lengthSize - 1)))) if (++lengthSize > 8) invalid();
      if (offset + lengthSize > end) invalid();
      let length = BigInt(bytes[offset]! & ((128 >> (lengthSize - 1)) - 1));
      for (let i = 1; i < lengthSize; i++) length = length * 256n + BigInt(bytes[offset + i]!);
      const unknown = length === (1n << BigInt(lengthSize * 7)) - 1n, start = offset + lengthSize;
      if (!unknown && length > BigInt(end - start)) invalid();
      if (unknown && id !== 0x18538067 && id !== 0x1f43b675) invalid();
      return { id, start, end: unknown ? end : start + Number(length), unknown };
    };
    const segmentChildren = new Set([0x1f43b675, 0x1654ae6b, 0x1549a966, 0x114d9b74, 0x1c53bb6b, 0x1254c367, 0x1043a770, 0x1941a469]);
    const walk = (start: number, end: number, parent: number, depth: number, unknown = false): number => {
      if (depth > 8) invalid();
      for (let offset = start; offset < end;) {
        const element = read(offset, end);
        if (unknown && parent === 0x1f43b675 && segmentChildren.has(element.id)) return offset;
        if (element.id === 0x4282 && parent === 0x1a45dfa3) { if (webm || element.end - element.start !== 4 || ascii(bytes, element.start, 4) !== "webm") invalid(); webm = true; }
        if (element.id === 0x83 && parent === 0xae) { if (element.end - element.start !== 1) invalid(); if (bytes[element.start] === 1) video = true; else if (bytes[element.start] === 2) audio = true; else invalid(); }
        if ([0x1a45dfa3, 0x18538067, 0x1654ae6b, 0xae].includes(element.id) || (element.id === 0x1f43b675 && element.unknown)) offset = walk(element.start, element.end, element.id, depth + 1, element.unknown);
        else offset = element.end;
        if (offset < element.start) invalid();
      }
      return end;
    };
    walk(0, size, 0, 0); if (!webm || (!audio && !video)) invalid(); return { family: "webm", audio, video };
  }
  return null;
}
