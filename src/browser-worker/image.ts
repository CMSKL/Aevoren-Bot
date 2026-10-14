import { BrowserWorkerError } from "./worker-error";

/** Dimensions come from the returned pixels, not the requested viewport. */
export function imageDimensions(bytes: Buffer, mimeType: "image/png" | "image/jpeg"): { width: number; height: number } {
  if (mimeType === "image/png" && bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.subarray(12, 16).toString("ascii") === "IHDR") {
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (width > 0 && height > 0 && width <= 8_192 && height <= 8_192) return { width, height };
  }
  if (mimeType === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++]!;
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      const size = bytes.readUInt16BE(offset);
      if (size < 2 || offset + size > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && size >= 8) {
        const height = bytes.readUInt16BE(offset + 3), width = bytes.readUInt16BE(offset + 5);
        if (width > 0 && height > 0 && width <= 8_192 && height <= 8_192) return { width, height };
        break;
      }
      offset += size;
    }
  }
  throw new BrowserWorkerError("BROWSER_IMAGE_INVALID", 502);
}
