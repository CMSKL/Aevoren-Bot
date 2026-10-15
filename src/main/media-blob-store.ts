import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { MEDIA_PDF_MAX_BYTES } from "@shared/media-schemas";
import { AevorenBotError } from "./errors";

export function mediaBytesDigest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
export function assertMediaNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AevorenBotError("TOOL_EXECUTION_CANCELLED");
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

/** Reads a trusted picker/resolved Workspace path without following its final link. */
export async function readMediaSource(path: string, check: () => void): Promise<Buffer> {
  let handle;
  try {
    check();
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw new AevorenBotError("MEDIA_CONTENT_INVALID");
    if (before.size < 1n || before.size > BigInt(MEDIA_PDF_MAX_BYTES)) throw new AevorenBotError("MEDIA_IMPORT_TOO_LARGE");
    if (await realpath(dirname(path)) !== dirname(path)) throw new AevorenBotError("MEDIA_CONTENT_INVALID");
    check();
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(before, opened)) throw new AevorenBotError("MEDIA_CONTENT_INVALID");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      check();
      const result = await handle.read(bytes, length, bytes.length - length, length);
      length += result.bytesRead;
      if (!result.bytesRead) break;
    }
    const after = await handle.stat({ bigint: true }), current = await lstat(path, { bigint: true });
    check();
    if (length !== Number(before.size) || !sameFile(opened, after) || !sameFile(after, current)
      || await realpath(dirname(path)) !== dirname(path)) throw new AevorenBotError("MEDIA_CONTENT_INVALID");
    check();
    return bytes.subarray(0, length);
  } catch (error) {
    check();
    if (error instanceof AevorenBotError) throw error;
    throw new AevorenBotError("MEDIA_CONTENT_INVALID");
  } finally { await handle?.close(); }
}

/** Application-owned CAS; blob deduplication never grants access to another record. */
export class MediaBlobStore {
  constructor(private readonly root: string) {
    if (resolve(root) === parse(resolve(root)).root) throw new AevorenBotError("MEDIA_CONTENT_INVALID");
  }
  private async directory(sha256: string, signal?: AbortSignal): Promise<string> {
    assertMediaNotCancelled(signal);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink()) throw new AevorenBotError("MEDIA_CONTENT_INVALID");
    const root = await realpath(this.root), directory = join(root, sha256.slice(0, 2));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const identity = await lstat(directory);
    assertMediaNotCancelled(signal);
    if (!identity.isDirectory() || identity.isSymbolicLink() || await realpath(directory) !== directory)
      throw new AevorenBotError("MEDIA_CONTENT_INVALID");
    return directory;
  }
  async put(bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
    if (bytes.byteLength < 1 || bytes.byteLength > MEDIA_PDF_MAX_BYTES) throw new AevorenBotError("MEDIA_IMPORT_TOO_LARGE");
    const sha256 = mediaBytesDigest(bytes), directory = await this.directory(sha256, signal);
    const temporary = join(directory, `.import-${randomUUID()}`), target = join(directory, sha256);
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(bytes, { signal });
      await handle.sync();
      assertMediaNotCancelled(signal);
      if (await realpath(directory) !== directory || (await lstat(directory)).isSymbolicLink()) throw new AevorenBotError("MEDIA_CONTENT_INVALID");
      try { await link(temporary, target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      await this.read(sha256, bytes.byteLength, signal);
      return sha256;
    } finally { await handle.close(); await unlink(temporary).catch(() => undefined); }
  }
  async read(sha256: string, size: number, signal?: AbortSignal): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/u.test(sha256) || !Number.isSafeInteger(size) || size < 1 || size > MEDIA_PDF_MAX_BYTES)
      throw new AevorenBotError("MEDIA_CONTENT_INVALID");
    assertMediaNotCancelled(signal);
    try {
      const root = await realpath(this.root);
      if ((await lstat(this.root)).isSymbolicLink()) throw new AevorenBotError("MEDIA_CONTENT_INVALID");
      const bytes = await readMediaSource(join(root, sha256.slice(0, 2), sha256), () => assertMediaNotCancelled(signal));
      if (bytes.length !== size || mediaBytesDigest(bytes) !== sha256) throw new AevorenBotError("MEDIA_CONTENT_INVALID");
      return bytes;
    } catch (error) {
      assertMediaNotCancelled(signal);
      if (error instanceof AevorenBotError) throw error;
      throw new AevorenBotError("MEDIA_CONTENT_INVALID");
    }
  }
}
