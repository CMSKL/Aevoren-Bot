/** Byte-only preflight before browser decoding; this does not claim a valid image. */
export function imageDimensions(bytes: Uint8Array, mimeType: string): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mimeType === "image/png") {
    if (bytes.length < 33 || [137, 80, 78, 71, 13, 10, 26, 10].some((value, i) => bytes[i] !== value)
      || view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) throw new Error("MEDIA_CONTENT_INVALID");
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (mimeType !== "image/jpeg" || bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216
    || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw new Error("MEDIA_CONTENT_INVALID");
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 255) throw new Error("MEDIA_CONTENT_INVALID");
    while (bytes[offset] === 255) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0 || marker === 218 || marker === 217) break;
    if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
    if (offset + 2 > bytes.length) break;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      if (length < 8) break;
      return { height: view.getUint16(offset + 3), width: view.getUint16(offset + 5) };
    }
    offset += length;
  }
  throw new Error("MEDIA_CONTENT_INVALID");
}
