import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, lstat, mkdir, open, realpath, rm, writeFile, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { resourceFileRefSchema } from "@shared/library-schemas";
import type { PreparedLibraryExport } from "./library-service";
import { AevorenBotError } from "./errors";

/** Publishes a fresh export only after all files and the current grant validate. */
export async function writeLibraryExport(snapshot: PreparedLibraryExport, target: string, signal: AbortSignal | undefined, validate: () => void): Promise<string> {
  const check = (): void => { signal?.throwIfAborted(); validate(); signal?.throwIfAborted(); };
  check();
  if (!snapshot.files.length || snapshot.kind === "document" && snapshot.files.length !== 1) throw new AevorenBotError("LIBRARY_FILE_INVALID");
  const paths = new Set<string>();
  for (const file of snapshot.files) {
    if (!resourceFileRefSchema.shape.relativePath.safeParse(file.relativePath).success || paths.has(file.relativePath) || !Buffer.isBuffer(file.bytes)) {
      throw new AevorenBotError("LIBRARY_FILE_INVALID");
    }
    paths.add(file.relativePath);
  }
  const parent = await realpath(dirname(target));
  check();
  const output = join(parent, basename(target));
  const staging = join(parent, `.aevoren-export-${randomUUID()}`);
  type Identity = { dev: bigint; ino: bigint; directory: boolean };
  let stagingIdentity: Identity | undefined;
  let outputIdentity: Identity | undefined;
  let completed = false;
  let rejected: { error: unknown } | undefined;
  const heldHandles = new Set<FileHandle>();
  const identify = async (path: string): Promise<Identity> => {
    const stat = await lstat(path, { bigint: true });
    if (stat.isSymbolicLink()) throw new AevorenBotError("LIBRARY_FILE_INVALID");
    return { dev: stat.dev, ino: stat.ino, directory: stat.isDirectory() };
  };
  const assertOwned = async (path: string, owned: Identity): Promise<void> => {
    const current = await identify(path);
    if (current.dev !== owned.dev || current.ino !== owned.ino || current.directory !== owned.directory) throw new AevorenBotError("LIBRARY_FILE_INVALID");
  };
  const pinDirectory = async (path: string): Promise<Identity> => {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    heldHandles.add(handle);
    const stat = await handle.stat({ bigint: true });
    const identity = { dev: stat.dev, ino: stat.ino, directory: stat.isDirectory() };
    if (!identity.directory) throw new AevorenBotError("LIBRARY_FILE_INVALID");
    await assertOwned(path, identity);
    return identity;
  };
  const removeOwned = async (path: string, owned: Identity): Promise<void> => {
    try {
      await assertOwned(path, owned);
      await rm(path, { recursive: owned.directory, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  // Open handles retain the original inode even after unlink/rmdir, preventing rapid id reuse.
  try {
    try {
      if (snapshot.kind === "document") {
        const handle = await open(staging, "wx", 0o600);
        heldHandles.add(handle);
        const stat = await handle.stat({ bigint: true });
        stagingIdentity = { dev: stat.dev, ino: stat.ino, directory: false };
        check();
        await handle.writeFile(snapshot.files[0]!.bytes);
        check();
        await link(staging, output);
        outputIdentity = { ...stagingIdentity };
        check();
      } else {
        await mkdir(staging, { mode: 0o700 });
        stagingIdentity = await pinDirectory(staging);
        for (const file of snapshot.files) {
          check();
          const filePath = join(staging, ...file.relativePath.split("/"));
          await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
          check();
          await writeFile(filePath, file.bytes, { flag: "wx", mode: 0o600, signal });
        }
        check();
        // Reserving a fresh directory and copying exclusively also works on Windows.
        await mkdir(output, { mode: 0o700 });
        outputIdentity = await pinDirectory(output);
        for (const file of snapshot.files) {
          check();
          await assertOwned(output, outputIdentity);
          const filePath = join(output, ...file.relativePath.split("/"));
          await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
          if (await realpath(dirname(filePath)) !== dirname(filePath)) throw new AevorenBotError("LIBRARY_FILE_INVALID");
          check();
          await copyFile(join(staging, ...file.relativePath.split("/")), filePath, constants.COPYFILE_EXCL);
          check();
        }
      }
      await assertOwned(output, outputIdentity);
      check();
      await removeOwned(staging, stagingIdentity);
      stagingIdentity = undefined;
      check();
      completed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST" || (error as NodeJS.ErrnoException).code === "ENOTEMPTY") {
        rejected = { error: new AevorenBotError("LIBRARY_EXPORT_CONFLICT") };
      } else rejected = { error };
    }
    const cleanup = await Promise.allSettled([
      ...(!completed && outputIdentity ? [removeOwned(output, outputIdentity)] : []),
      ...(stagingIdentity ? [removeOwned(staging, stagingIdentity)] : []),
    ]);
    const failure = cleanup.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    if (rejected) throw rejected.error;
    return output;
  } finally {
    await Promise.all([...heldHandles].map((handle) => handle.close()));
  }
}
