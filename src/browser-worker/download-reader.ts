import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { BROWSER_DOWNLOAD_MAX_BYTES } from "@shared/browser-contracts";
import type { DownloadRecord } from "./state-store";
import { BrowserWorkerError } from "./worker-error";

/** Runs as the browser UID. The root supervisor never opens user-owned private directories. */
export async function readDownload(directory: string, record: DownloadRecord): Promise<Buffer> {
  const path = join(directory, z.string().uuid().parse(record.id));
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== record.size || stat.size > BROWSER_DOWNLOAD_MAX_BYTES) throw new BrowserWorkerError("BROWSER_DOWNLOAD_INVALID", 409);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const current = await file.stat();
    if (!current.isFile() || current.nlink !== 1 || current.size !== record.size) throw new BrowserWorkerError("BROWSER_DOWNLOAD_INVALID", 409);
    const buffer = Buffer.alloc(record.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await file.read(buffer, size, buffer.length - size, size);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    bytes = buffer.subarray(0, size);
  } finally { await file.close(); }
  if (bytes.length !== record.size || createHash("sha256").update(bytes).digest("hex") !== record.sha256) throw new BrowserWorkerError("BROWSER_DOWNLOAD_INVALID", 409);
  return bytes;
}
