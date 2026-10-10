import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { AppRepository } from "./database";
import { MAX_USER_AVATAR_DATA_URL_LENGTH, UserProfileService } from "./user-profile-service";

const repositories: AppRepository[] = [];
const temporaryDirectories: string[] = [];
const settingKey = "ui.userProfile";
const defaultProfile = { name: "我", avatarUrl: null };
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function repository(filename = ":memory:"): AppRepository {
  const value = new AppRepository(filename);
  repositories.push(value);
  return value;
}

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, payload: Buffer): Buffer {
  const chunk = Buffer.alloc(payload.length + 12);
  chunk.writeUInt32BE(payload.length, 0);
  chunk.write(type, 4, "ascii");
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

function png(options: {
  width?: number;
  height?: number;
  bitDepth?: number;
  colorType?: number;
  compression?: number;
  filter?: number;
  interlace?: number;
  scanlines?: Buffer;
  compressed?: Buffer;
} = {}): Buffer {
  const width = options.width ?? 256;
  const height = options.height ?? 256;
  const colorType = options.colorType ?? 6;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = options.bitDepth ?? 8;
  header[9] = colorType;
  header[10] = options.compression ?? 0;
  header[11] = options.filter ?? 0;
  header[12] = options.interlace ?? 0;
  const scanlines = options.scanlines ?? Buffer.alloc(height * (1 + width * (colorType === 2 ? 3 : 4)));
  return Buffer.concat([
    pngSignature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", options.compressed ?? deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function dataUrl(bytes: Buffer): string {
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

const validAvatar = dataUrl(png());
const corruptChecksum = png();
corruptChecksum[32] = corruptChecksum[32]! ^ 1;
const invalidScanlines = Buffer.alloc(256 * (1 + 256 * 4));
invalidScanlines[0] = 5;
const avatarScanlines = Buffer.alloc(256 * (1 + 256 * 4));
const uncompressedImage = deflateSync(avatarScanlines, { level: 0 });
// Empty stored DEFLATE blocks keep the image valid while exceeding the URL bound.
const oversizedCompressedImage = Buffer.concat([
  uncompressedImage.subarray(0, 2),
  Buffer.alloc(200_000, Buffer.from([0, 0, 0, 255, 255])),
  uncompressedImage.subarray(2),
]);
const oversizedPng = png({ compressed: oversizedCompressedImage });

afterEach(() => {
  while (repositories.length > 0) repositories.pop()?.close();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("UserProfileService", () => {
  it("returns the local default before a profile has been saved", () => {
    const value = repository();
    expect(new UserProfileService(value).get()).toEqual(defaultProfile);
    expect(value.getSetting(settingKey)).toBeNull();
  });

  it.each([2, 6])("persists a valid RGB/RGBA PNG (color type %i) across database restarts", (colorType) => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-user-profile-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    const value = repository(filename);
    const profile = { name: "小明", avatarUrl: dataUrl(png({ colorType })) };
    expect(new UserProfileService(value).update(profile)).toEqual(profile);
    expect(value.getSetting(settingKey)).toEqual({ value: JSON.stringify(profile), encrypted: false });
    repositories.pop()?.close();

    const reopened = repository(filename);
    const service = new UserProfileService(reopened);
    expect(service.get()).toEqual(profile);
    expect(service.update({ name: "小明", avatarUrl: null })).toEqual({ name: "小明", avatarUrl: null });
    repositories.pop()?.close();
    expect(new UserProfileService(repository(filename)).get()).toEqual({ name: "小明", avatarUrl: null });
  });

  it("accepts a name at the 80-character limit", () => {
    const profile = { name: "名".repeat(80), avatarUrl: null };
    expect(new UserProfileService(repository()).update(profile)).toEqual(profile);
  });

  it.each([
    ["empty", ""],
    ["only whitespace", "   "],
    ["too long", "名".repeat(81)],
    ["newline", "小\n明"],
    ["tab", "小\t明"],
    ["NUL", "小\u0000明"],
    ["DEL", "小\u007f明"],
    ["non-string", 123],
  ])("rejects an invalid name (%s) without overwriting the saved profile", (_label, name) => {
    const value = repository();
    const service = new UserProfileService(value);
    const existing = { name: "小明", avatarUrl: validAvatar };
    service.update(existing);
    expect(() => service.update({ name, avatarUrl: null })).toThrow();
    expect(service.get()).toEqual(existing);
    expect(value.getSetting(settingKey)?.value).toBe(JSON.stringify(existing));
  });

  it.each([
    ["remote URL", "https://example.com/avatar.png"],
    ["file URL", "file:///tmp/avatar.png"],
    ["SVG", "data:image/svg+xml;base64,PHN2Zy8+"],
    ["wrong MIME", validAvatar.replace("image/png", "image/jpeg")],
    ["noncanonical MIME", validAvatar.replace("image/png", "IMAGE/PNG")],
    ["base64 whitespace", `${validAvatar}\n`],
    ["extra base64 padding", `${validAvatar}=`],
    ["signature only", dataUrl(pngSignature)],
    ["forged signature", dataUrl(Buffer.concat([pngSignature, Buffer.from("not a PNG")]))],
    ["bad chunk CRC", dataUrl(corruptChecksum)],
    ["invalid compressed image", dataUrl(png({ compressed: Buffer.from("not zlib") }))],
    ["missing scanlines", dataUrl(png({ scanlines: Buffer.alloc(0) }))],
    ["invalid scanline filter", dataUrl(png({ scanlines: invalidScanlines }))],
    ["truncated PNG", dataUrl(png().subarray(0, -12))],
    ["wrong width", dataUrl(png({ width: 255 }))],
    ["wrong height", dataUrl(png({ height: 255 }))],
    ["unsupported bit depth", dataUrl(png({ bitDepth: 16 }))],
    ["unsupported color type", dataUrl(png({ colorType: 3 }))],
    ["unsupported compression", dataUrl(png({ compression: 1 }))],
    ["unsupported filter method", dataUrl(png({ filter: 1 }))],
    ["interlaced PNG", dataUrl(png({ interlace: 1 }))],
    ["too large", dataUrl(oversizedPng)],
    ["non-string", 123],
  ])("rejects an invalid avatar (%s) without changing the existing profile", (_label, avatarUrl) => {
    const value = repository();
    const service = new UserProfileService(value);
    service.update(defaultProfile);
    expect(() => service.update({ name: "新名字", avatarUrl })).toThrow();
    expect(service.get()).toEqual(defaultProfile);
    expect(value.getSetting(settingKey)?.value).toBe(JSON.stringify(defaultProfile));
  });

  it("keeps the oversized fixture above the 512 KiB avatar bound", () => {
    expect(MAX_USER_AVATAR_DATA_URL_LENGTH).toBe(512 * 1024);
    expect(dataUrl(oversizedPng).length).toBeGreaterThan(MAX_USER_AVATAR_DATA_URL_LENGTH);
    expect(inflateSync(oversizedCompressedImage)).toEqual(avatarScanlines);
  });

  it.each([null, [], "name", {}, { name: "小明" }, { avatarUrl: null }])("rejects an incomplete profile %j", (input) => {
    const value = repository();
    expect(() => new UserProfileService(value).update(input)).toThrow();
    expect(value.getSetting(settingKey)).toBeNull();
  });

  it.each([
    "not JSON",
    "null",
    "[]",
    JSON.stringify({ name: "", avatarUrl: null }),
    JSON.stringify({ name: "小明", avatarUrl: "https://example.com/avatar.png" }),
    JSON.stringify({ name: "小明", avatarUrl: dataUrl(corruptChecksum) }),
  ])("falls back to the default when stored profile data is malformed (%s)", (stored) => {
    const value = repository();
    value.setSetting(settingKey, stored, false);
    expect(new UserProfileService(value).get()).toEqual(defaultProfile);
  });
});
