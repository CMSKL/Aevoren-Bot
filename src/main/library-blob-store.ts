import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { AevorenBotError } from "./errors";

export const MAX_LIBRARY_TEXT_BYTES = 1_048_576;
export const MAX_LIBRARY_IMPORT_BYTES = 4 * MAX_LIBRARY_TEXT_BYTES;
export const MAX_LIBRARY_FILES = 250;

export function assertLibraryNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AevorenBotError("TOOL_EXECUTION_CANCELLED");
}

export function libraryBytesDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class LibraryBlobStore {
  constructor(private readonly root: string) {
    if (parse(resolve(root)).root === resolve(root)) throw new AevorenBotError("INVALID_REQUEST");
  }

  private async directory(shard: string, signal?: AbortSignal): Promise<string> {
    assertLibraryNotCancelled(signal);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    assertLibraryNotCancelled(signal);
    if ((await lstat(this.root)).isSymbolicLink()) throw new AevorenBotError("LIBRARY_FILE_INVALID");
    const root = await realpath(this.root);
    const directory = join(root, shard);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    assertLibraryNotCancelled(signal);
    const identity = await lstat(directory);
    if (!identity.isDirectory() || identity.isSymbolicLink() || await realpath(directory) !== directory) {
      throw new AevorenBotError("LIBRARY_FILE_INVALID");
    }
    return directory;
  }

  async put(bytes: Buffer, signal?: AbortSignal): Promise<string> {
    if (bytes.length > MAX_LIBRARY_TEXT_BYTES) throw new AevorenBotError("LIBRARY_IMPORT_TOO_LARGE");
    const sha256 = libraryBytesDigest(bytes);
    const directory = await this.directory(sha256.slice(0, 2), signal);
    const target = join(directory, sha256);
    try {
      await lstat(target);
      await this.read(sha256, bytes.length, signal);
      return sha256;
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
    }
    const temporary = join(directory, `.import-${randomUUID()}`);
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      assertLibraryNotCancelled(signal);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      assertLibraryNotCancelled(signal);
      if (await realpath(directory) !== directory || (await lstat(directory)).isSymbolicLink()) throw new AevorenBotError("LIBRARY_FILE_INVALID");
      await rename(temporary, target);
      assertLibraryNotCancelled(signal);
      await this.read(sha256, bytes.length, signal);
      return sha256;
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }

  async read(sha256: string, size: number, signal?: AbortSignal): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/u.test(sha256) || !Number.isSafeInteger(size) || size < 0 || size > MAX_LIBRARY_TEXT_BYTES) {
      throw new AevorenBotError("LIBRARY_FILE_INVALID");
    }
    assertLibraryNotCancelled(signal);
    let handle;
    try {
      const root = await realpath(this.root);
      if ((await lstat(this.root)).isSymbolicLink()) throw new AevorenBotError("LIBRARY_FILE_INVALID");
      const target = join(root, sha256.slice(0, 2), sha256);
      if (await realpath(dirname(target)) !== dirname(target) || (await lstat(dirname(target))).isSymbolicLink()) {
        throw new AevorenBotError("LIBRARY_FILE_INVALID");
      }
      const before = await lstat(target);
      if (!before.isFile() || before.isSymbolicLink() || before.size !== size) throw new AevorenBotError("LIBRARY_FILE_INVALID");
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== size) throw new AevorenBotError("LIBRARY_FILE_INVALID");
      assertLibraryNotCancelled(signal);
      const bytes = Buffer.alloc(size + 1);
      let length = 0;
      while (length < bytes.length) {
        assertLibraryNotCancelled(signal);
        const read = await handle.read(bytes, length, bytes.length - length, length);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      const after = await handle.stat();
      assertLibraryNotCancelled(signal);
      if (length !== size || after.size !== size || after.mtimeMs !== opened.mtimeMs || libraryBytesDigest(bytes.subarray(0, length)) !== sha256) {
        throw new AevorenBotError("LIBRARY_FILE_INVALID");
      }
      return bytes.subarray(0, length);
    } catch (error) {
      assertLibraryNotCancelled(signal);
      if (error instanceof AevorenBotError) throw error;
      throw new AevorenBotError("LIBRARY_FILE_NOT_FOUND");
    } finally {
      await handle?.close();
    }
  }
}
