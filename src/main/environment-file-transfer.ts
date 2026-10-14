import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ENV_FILE_MAX_BYTES } from "@shared/environment-contracts";
import { AevorenBotError } from "./errors";

export async function readEnvironmentUpload(path: string, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  if ((await lstat(path)).isSymbolicLink()) throw new AevorenBotError("ENVIRONMENT_FILE_INVALID");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(ENV_FILE_MAX_BYTES)) throw new AevorenBotError("ENVIRONMENT_FILE_INVALID");
    const content = await handle.readFile({ signal });
    const after = await handle.stat({ bigint: true });
    if (content.length > ENV_FILE_MAX_BYTES || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new AevorenBotError("ENVIRONMENT_FILE_INVALID");
    signal?.throwIfAborted(); return content;
  } finally { await handle.close(); }
}

/** Fresh files only; the retained staging inode proves which output cleanup may remove. */
export async function writeEnvironmentDownload(path: string, bytes: Buffer, validate: () => void, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted(); validate();
  const parent = await realpath(dirname(path)), output = join(parent, basename(path));
  const staging = join(parent, `.aevoren-download-${randomUUID()}`);
  const handle = await open(staging, "wx", 0o600);
  let published = false, succeeded = false;
  try {
    await handle.writeFile(bytes, { signal });
    signal?.throwIfAborted(); validate();
    await link(staging, output); published = true;
    signal?.throwIfAborted(); validate();
    succeeded = true;
    return output;
  } finally {
    try {
      if (published && !succeeded) {
        const original = await handle.stat({ bigint: true });
        const current = await lstat(output, { bigint: true }).catch(() => null);
        if (current && !current.isSymbolicLink() && current.ino === original.ino && current.dev === original.dev) await unlink(output);
      }
      const original = await handle.stat({ bigint: true });
      const current = await lstat(staging, { bigint: true }).catch(() => null);
      if (current && !current.isSymbolicLink() && current.ino === original.ino && current.dev === original.dev) await unlink(staging);
    } finally { await handle.close(); }
  }
}
