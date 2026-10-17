import { inflateSync } from "node:zlib";
import { z } from "zod";
import type { UserProfile } from "@shared/contracts";
import type { AppRepository } from "./database";
import { AevorenBotError } from "./errors";

export const MAX_USER_AVATAR_DATA_URL_LENGTH = 512 * 1_024;
const USER_PROFILE_SETTING = "ui.userProfile";
const PNG_PREFIX = "data:image/png;base64,";
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const profileSchema = z.object({ name: z.string(), avatarUrl: z.string().max(MAX_USER_AVATAR_DATA_URL_LENGTH).nullable() }).strict();
const crcTable = Uint32Array.from({ length: 256 }, (_, initial) => {
  let value = initial;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function invalidAvatar(): never {
  throw new AevorenBotError("INVALID_REQUEST", "头像无法读取，请重新选择 PNG、JPEG 或 WebP 图片。");
}

/** Only the small PNG produced by the local canvas may cross the IPC boundary. */
function validateAvatar(avatarUrl: string): void {
  if (!avatarUrl.startsWith(PNG_PREFIX)) invalidAvatar();
  const encoded = avatarUrl.slice(PNG_PREFIX.length);
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) invalidAvatar();
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) invalidAvatar();
  let offset = 8;
  let bytesPerPixel = 0;
  let ended = false;
  const imageChunks: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) invalidAvatar();
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const content = bytes.subarray(offset + 8, end - 4);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) invalidAvatar();
    if (offset === 8 && type !== "IHDR") invalidAvatar();
    if (type === "IHDR") {
      if (offset !== 8 || length !== 13 || content.readUInt32BE(0) !== 256 || content.readUInt32BE(4) !== 256
        || content[8] !== 8 || (content[9] !== 2 && content[9] !== 6)
        || content[10] !== 0 || content[11] !== 0 || content[12] !== 0) invalidAvatar();
      bytesPerPixel = content[9] === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      imageChunks.push(content);
    } else if (type === "IEND") {
      if (length !== 0 || end !== bytes.length) invalidAvatar();
      ended = true;
      break;
    } else if (!["sRGB", "gAMA", "cHRM", "pHYs"].includes(type)) invalidAvatar();
    offset = end;
  }
  if (!ended || !bytesPerPixel || imageChunks.length === 0) invalidAvatar();
  const rowLength = 256 * bytesPerPixel + 1;
  let pixels: Buffer;
  try {
    pixels = inflateSync(Buffer.concat(imageChunks), { maxOutputLength: rowLength * 256 });
  } catch {
    invalidAvatar();
  }
  if (pixels.length !== rowLength * 256) invalidAvatar();
  for (let row = 0; row < 256; row += 1) if (pixels[row * rowLength]! > 4) invalidAvatar();
}

function parseProfile(input: unknown): UserProfile {
  const parsed = profileSchema.parse(input);
  const name = parsed.name.trim();
  if (!name || name.length > 80 || /\p{Cc}/u.test(parsed.name)) {
    throw new AevorenBotError("INVALID_REQUEST", "昵称需为 1～80 个字符。");
  }
  if (parsed.avatarUrl !== null) validateAvatar(parsed.avatarUrl);
  return { name, avatarUrl: parsed.avatarUrl };
}

export class UserProfileService {
  constructor(private readonly repository: AppRepository) {}

  get(): UserProfile {
    const stored = this.repository.getSetting(USER_PROFILE_SETTING);
    if (stored) {
      try { return parseProfile(JSON.parse(stored.value)); } catch { /* Fall back for older or invalid UI preferences. */ }
    }
    return { name: "我", avatarUrl: null };
  }

  update(input: unknown): UserProfile {
    const profile = parseProfile(input);
    this.repository.setSetting(USER_PROFILE_SETTING, JSON.stringify(profile), false);
    return profile;
  }
}
