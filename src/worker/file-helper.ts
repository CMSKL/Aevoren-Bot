import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, link, unlink } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ENV_FILE_MAX_BYTES, ENV_HTTP_BODY_MAX_BYTES } from "@shared/environment-contracts";
import type { EnvironmentFileContent, EnvironmentFileList, EnvironmentFileWriteResult } from "@shared/environment-contracts";
import { WorkerError } from "./worker-error";

const MIME: Record<string, string> = { ".md": "text/markdown", ".txt": "text/plain", ".json": "application/json", ".py": "text/x-python", ".js": "text/javascript", ".ts": "text/typescript", ".html": "text/html", ".csv": "text/csv", ".png": "image/png", ".jpg": "image/jpeg", ".pdf": "application/pdf" };
type FileOperation = { action: "read" | "write" | "list" | "directory" | "initialize"; path?: string; content?: string; encoding?: "utf8" | "base64"; expectedSha256?: string };
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function invalidPath(path: string, directory = false): boolean {
  return path.includes("\\") || /^[a-z]:/iu.test(path) || [...path].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || isAbsolute(path) ||
    (path !== "." || !directory) && path.split("/").some(part => !part || part === "." || part === "..");
}

async function targetPath(root: string, path: string, directory = false, createParents = false): Promise<string> {
  if (invalidPath(path, directory)) throw new WorkerError("WORKER_PATH_INVALID");
  const target = resolve(root, path);
  const offset = relative(root, target);
  if (offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw new WorkerError("WORKER_PATH_INVALID");
  const parent = directory ? target : dirname(target);
  if (createParents) {
    let current = root;
    for (const segment of relative(root, parent).split(sep).filter(Boolean)) {
      current = join(current, segment);
      await mkdir(current, { mode: 0o2770 }).catch(error => { if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error; });
      const identity = await lstat(current);
      if (!identity.isDirectory() || identity.isSymbolicLink() || await realpath(current) !== current) throw new WorkerError("WORKER_PATH_INVALID");
    }
  }
  if (await realpath(parent) !== parent || (await lstat(parent)).isSymbolicLink()) throw new WorkerError("WORKER_PATH_INVALID");
  return target;
}

async function readBytes(target: string): Promise<Buffer> {
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink()) throw new WorkerError("WORKER_PATH_INVALID");
  if (before.size > ENV_FILE_MAX_BYTES) throw new WorkerError("WORKER_FILE_TOO_LARGE", 413);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const identity = await handle.stat();
    if (identity.dev !== before.dev || identity.ino !== before.ino || identity.size !== before.size) throw new WorkerError("WORKER_FILE_CHANGED", 409);
    const bytes = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, size);
      size += read.bytesRead;
      if (!read.bytesRead) break;
    }
    const after = await handle.stat();
    const named = await lstat(target);
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || named.ino !== before.ino || named.dev !== before.dev) throw new WorkerError("WORKER_FILE_CHANGED", 409);
    return bytes.subarray(0, size);
  } finally { await handle.close(); }
}

export async function fileOperation(workspace: string, input: FileOperation): Promise<EnvironmentFileContent | EnvironmentFileList | EnvironmentFileWriteResult | { path: string }> {
  const root = await realpath(workspace);
  if ((await lstat(workspace)).isSymbolicLink()) throw new WorkerError("WORKER_PATH_INVALID");
  if (input.action === "initialize") { await chmod(root, 0o2770); return { path: "." }; }
  const path = input.path ?? ".";
  const target = await targetPath(root, path, input.action === "list" || input.action === "directory", input.action === "write");
  if (input.action === "directory") {
    const identity = await lstat(target);
    if (!identity.isDirectory() || identity.isSymbolicLink()) throw new WorkerError("WORKER_PATH_INVALID");
    return { path };
  }
  if (input.action === "list") {
    const identity = await lstat(target);
    if (!identity.isDirectory() || identity.isSymbolicLink()) throw new WorkerError("WORKER_PATH_INVALID");
    const entries = (await readdir(target, { withFileTypes: true })).toSorted((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const result: EnvironmentFileList = { path, entries: [], truncated: entries.length > 250 };
    for (const entry of entries.slice(0, 250)) {
      const source = join(target, entry.name);
      if (invalidPath(path === "." ? entry.name : `${path}/${entry.name}`)) { result.truncated = true; continue; }
      const stat = await lstat(source);
      if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) { result.truncated = true; continue; }
      result.entries.push({ path: path === "." ? entry.name : `${path}/${entry.name}`, type: stat.isFile() ? "file" : "directory", size: stat.size, modifiedAt: stat.mtime.toISOString() });
    }
    if (await realpath(target) !== target) throw new WorkerError("WORKER_PATH_INVALID");
    return result;
  }
  if (input.action === "read") {
    const bytes = await readBytes(target);
    let text: string | null = null;
    try { if (!bytes.includes(0)) text = new TextDecoder("utf8", { fatal: true }).decode(bytes); } catch { /* Binary bytes are returned without lossy decoding. */ }
    return { path, size: bytes.length, sha256: digest(bytes), mimeType: MIME[extname(path).toLowerCase()] ?? "application/octet-stream",
      encoding: text === null ? "base64" : "utf8", content: text ?? bytes.toString("base64") };
  }
  if (input.action !== "write" || typeof input.content !== "string") throw new WorkerError("WORKER_INVALID_REQUEST");
  if (input.encoding === "base64" && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(input.content)) throw new WorkerError("WORKER_INVALID_REQUEST");
  const bytes = Buffer.from(input.content, input.encoding === "base64" ? "base64" : "utf8");
  if (bytes.length > ENV_FILE_MAX_BYTES) throw new WorkerError("WORKER_FILE_TOO_LARGE", 413);
  const expected = input.expectedSha256;
  if (expected !== undefined && !/^[a-f0-9]{64}$/u.test(expected)) throw new WorkerError("WORKER_INVALID_REQUEST");
  if (expected !== undefined && digest(await readBytes(target)) !== expected) throw new WorkerError("WORKER_FILE_CONFLICT", 409);
  const temporary = join(dirname(target), `.aevoren-upload-${randomUUID()}`);
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    if (await realpath(dirname(target)) !== dirname(target)) throw new WorkerError("WORKER_PATH_INVALID");
    if (expected === undefined) await link(temporary, target);
    else {
      if (digest(await readBytes(target)) !== expected) throw new WorkerError("WORKER_FILE_CONFLICT", 409);
      await rename(temporary, target);
    }
    if (digest(await readBytes(target)) !== digest(bytes)) throw new WorkerError("WORKER_FILE_CHANGED", 409);
    await chmod(target, 0o660);
    return { path, size: bytes.length, sha256: digest(bytes) };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") throw new WorkerError("WORKER_FILE_CONFLICT", 409);
    throw error;
  } finally { await handle.close().catch(() => undefined); await unlink(temporary).catch(() => undefined); }
}

export async function fileHelperMain(): Promise<void> {
  process.umask(0o007);
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > ENV_HTTP_BODY_MAX_BYTES) throw new WorkerError("WORKER_FILE_TOO_LARGE", 413);
      chunks.push(chunk as Buffer);
    }
    const input = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks))) as FileOperation;
    const result = await fileOperation(process.env.AEVOREN_WORKSPACE_ROOT ?? "/workspace", input);
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (error) {
    const known = error instanceof WorkerError;
    process.stdout.write(JSON.stringify({ ok: false, error: { code: known ? error.code : "WORKER_FILE_ACCESS_DENIED", status: known ? error.status : 403 } }));
  }
}
