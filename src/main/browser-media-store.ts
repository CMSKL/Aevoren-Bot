import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BrowserWorkerFrame } from "@shared/browser-contracts";
import { BROWSER_FRAME_MAX_BYTES } from "@shared/browser-contracts";
import { browserWorkerFrameSchema } from "@shared/browser-schemas";
import { imageDimensions } from "../browser-worker/image";
import { AevorenBotError } from "./errors";

export function verifiedFrame(value: unknown): { frame: BrowserWorkerFrame; bytes: Buffer } {
  const frame = browserWorkerFrameSchema.parse(value), bytes = Buffer.from(frame.dataBase64, "base64");
  if (createHash("sha256").update(bytes).digest("hex") !== frame.sha256) throw new AevorenBotError("BROWSER_MEDIA_INVALID");
  try {
    const dimensions = imageDimensions(bytes, frame.mimeType);
    if (dimensions.width !== frame.width || dimensions.height !== frame.height || frame.mimeType === "image/jpeg" && (bytes.at(-2) !== 255 || bytes.at(-1) !== 217)) throw new Error("Invalid pixels");
  } catch { throw new AevorenBotError("BROWSER_MEDIA_INVALID"); }
  return { frame, bytes };
}

/** Bytes are application-owned and content addressed; scope remains in the shared SQLite records. */
export class BrowserMediaStore {
  constructor(private readonly root: string) {}
  private async directory(): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink()) throw new AevorenBotError("BROWSER_MEDIA_INVALID");
    return realpath(this.root);
  }
  async put(bytes: Buffer, sha256: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (bytes.length > BROWSER_FRAME_MAX_BYTES || !/^[a-f0-9]{64}$/.test(sha256) || createHash("sha256").update(bytes).digest("hex") !== sha256) throw new AevorenBotError("BROWSER_MEDIA_INVALID");
    const root = await this.directory(), output = join(root, sha256), temporary = join(root, `.staging-${randomUUID()}`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes, { signal }); signal?.throwIfAborted();
      try { await link(temporary, output); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      await this.read(output, sha256, bytes.length, signal); return output;
    } finally { await handle.close(); await unlink(temporary).catch(() => undefined); }
  }
  async read(path: string, sha256: string, size: number, signal?: AbortSignal): Promise<Buffer> {
    signal?.throwIfAborted(); const root = await this.directory();
    if (!/^[a-f0-9]{64}$/.test(sha256) || resolve(path) !== join(root, sha256) || size < 0 || size > BROWSER_FRAME_MAX_BYTES || (await lstat(path)).isSymbolicLink()) throw new AevorenBotError("BROWSER_MEDIA_INVALID");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size !== BigInt(size)) throw new AevorenBotError("BROWSER_MEDIA_INVALID");
      const bytes = await handle.readFile({ signal }), after = await handle.stat({ bigint: true });
      if (bytes.length !== size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || createHash("sha256").update(bytes).digest("hex") !== sha256) throw new AevorenBotError("BROWSER_MEDIA_INVALID");
      signal?.throwIfAborted(); return bytes;
    } finally { await handle.close(); }
  }
}
