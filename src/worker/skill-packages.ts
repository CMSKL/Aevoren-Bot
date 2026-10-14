import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, chown, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ResourceFileRef } from "@shared/library-contracts";
import { skillPackageDescriptor, type WorkerSkillInstallRequest, type WorkerSkillPackage } from "@shared/skill-execution-contracts";
import { workerSkillInstallSchema } from "@shared/skill-execution-schemas";
import { WorkerError } from "./worker-error";

const hash = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const identifier = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
type PackageRow = { metadata_json: string; files_json: string };

/** Root-private cache. Jobs receive only their own immutable, read-only snapshot. */
export class SkillPackages {
  private database: DatabaseSync | null = null;
  private readonly installing = new Map<string, { digest: string; promise: Promise<WorkerSkillPackage> }>();
  private readonly owner = process.getuid?.() ?? -1;
  private readonly group = process.getgid?.() ?? -1;
  readonly cacheDirectory: string;
  constructor(stateDirectory: string, readonly snapshotBase = "/tmp/aevoren-skill-snapshots") {
    this.cacheDirectory = join(stateDirectory, "skill-packages");
  }

  private async ownedDirectory(path: string, mode: number): Promise<void> {
    let created = false;
    try { await mkdir(path, { mode }); created = true; }
    catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error; }
    if (created) await chmod(path, mode);
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.owner || stat.gid !== this.group || (stat.mode & 0o7777) !== mode) {
      throw new WorkerError("WORKER_SKILL_PRIVATE_DIRECTORY_INVALID", 503);
    }
  }

  async initialize(): Promise<void> {
    await this.ownedDirectory(this.cacheDirectory, 0o700);
    await this.ownedDirectory(this.snapshotBase, 0o711);
    this.database = new DatabaseSync(join(this.cacheDirectory, "packages.sqlite"));
    this.database.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS packages(id TEXT PRIMARY KEY,metadata_json TEXT NOT NULL,files_json TEXT NOT NULL);`);
    await chmod(join(this.cacheDirectory, "packages.sqlite"), 0o600);
  }

  async clearSnapshotsAfterBootCleanup(): Promise<void> {
    for (const name of await readdir(this.snapshotBase)) {
      if (!identifier.test(name) && !/^\.prepare-[a-f0-9-]{36}$/iu.test(name)) throw new WorkerError("WORKER_SKILL_SNAPSHOT_INVALID", 503);
      const path = join(this.snapshotBase, name), stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.owner) throw new WorkerError("WORKER_SKILL_SNAPSHOT_INVALID", 503);
      await this.removeOwnedTree(path);
    }
  }

  get(id: string, expectedDigest?: string): WorkerSkillPackage {
    const row = this.database!.prepare("SELECT metadata_json FROM packages WHERE id=?").get(id) as PackageRow | undefined;
    if (!row) throw new WorkerError("WORKER_SKILL_PACKAGE_NOT_FOUND", 404);
    const result = JSON.parse(row.metadata_json) as WorkerSkillPackage;
    if (expectedDigest !== undefined && result.packageDigest !== expectedDigest) throw new WorkerError("WORKER_IDEMPOTENCY_CONFLICT", 409);
    return result;
  }

  private files(id: string): ResourceFileRef[] {
    const row = this.database!.prepare("SELECT files_json FROM packages WHERE id=?").get(id) as PackageRow | undefined;
    if (!row) throw new WorkerError("WORKER_SKILL_PACKAGE_NOT_FOUND", 404);
    return JSON.parse(row.files_json) as ResourceFileRef[];
  }

  async install(raw: WorkerSkillInstallRequest): Promise<WorkerSkillPackage> {
    const input = workerSkillInstallSchema.parse(raw);
    const paths = new Set(input.files.map(file => file.relativePath));
    const bytes = new Map<string, Buffer>();
    for (const file of input.files) {
      const parts = file.relativePath.split("/");
      for (let length = 1; length < parts.length; length++) {
        if (paths.has(parts.slice(0, length).join("/"))) throw new WorkerError("WORKER_SKILL_PACKAGE_INVALID");
      }
      const content = Buffer.from(file.dataBase64, "base64");
      if (content.length !== file.size || hash(content) !== file.sha256) throw new WorkerError("WORKER_SKILL_PACKAGE_INVALID");
      bytes.set(file.relativePath, content);
    }
    const packageDigest = hash(skillPackageDescriptor(input));
    const pending = this.installing.get(input.id);
    if (pending) {
      if (pending.digest !== packageDigest) throw new WorkerError("WORKER_IDEMPOTENCY_CONFLICT", 409);
      return pending.promise;
    }
    const row = this.database!.prepare("SELECT metadata_json FROM packages WHERE id=?").get(input.id);
    if (row) return this.get(input.id, packageDigest);
    const promise = this.publish(input, bytes, packageDigest);
    this.installing.set(input.id, { digest: packageDigest, promise });
    try { return await promise; }
    finally { this.installing.delete(input.id); }
  }

  private async publish(input: WorkerSkillInstallRequest, bytes: Map<string, Buffer>, packageDigest: string): Promise<WorkerSkillPackage> {
    const temporary = join(this.cacheDirectory, `.prepare-${randomUUID()}`), destination = join(this.cacheDirectory, packageDigest);
    const files = input.files.map(({ relativePath, size, mimeType, sha256 }) => ({ relativePath, size, mimeType, sha256 }))
      .sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);
    try {
      await mkdir(temporary, { mode: 0o700 });
      for (const file of files) {
        const path = join(temporary, file.relativePath);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(bytes.get(file.relativePath)!); await handle.sync(); }
        finally { await handle.close(); }
        await chmod(path, 0o400);
      }
      try { await rename(temporary, destination); }
      catch (error) {
        if (!(error && typeof error === "object" && "code" in error && ["EEXIST", "ENOTEMPTY"].includes(String(error.code)))) throw error;
        await this.verifyCache(destination, files);
      }
      const result: WorkerSkillPackage = { id: input.id, reference: input.reference, packageDigest, fileCount: files.length,
        size: files.reduce((size, file) => size + file.size, 0) };
      this.database!.prepare("INSERT INTO packages(id,metadata_json,files_json) VALUES(?,?,?)")
        .run(input.id, JSON.stringify(result), JSON.stringify(files));
      return result;
    } finally { await this.removeOwnedTree(temporary); }
  }

  private async readCacheFile(directory: string, file: ResourceFileRef): Promise<Buffer> {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.owner || (stat.mode & 0o777) !== 0o700) {
      throw new WorkerError("WORKER_SKILL_PACKAGE_INVALID", 409);
    }
    let parent = directory;
    for (const segment of file.relativePath.split("/").slice(0, -1)) {
      parent = join(parent, segment);
      const part = await lstat(parent);
      if (!part.isDirectory() || part.isSymbolicLink() || part.uid !== this.owner || (part.mode & 0o777) !== 0o700) {
        throw new WorkerError("WORKER_SKILL_PACKAGE_INVALID", 409);
      }
    }
    const handle = await open(join(directory, file.relativePath), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const entry = await handle.stat();
      if (!entry.isFile() || entry.uid !== this.owner || entry.size !== file.size || (entry.mode & 0o777) !== 0o400) throw new WorkerError("WORKER_SKILL_PACKAGE_INVALID", 409);
      const bytes = await handle.readFile();
      if (bytes.length !== file.size || hash(bytes) !== file.sha256) throw new WorkerError("WORKER_SKILL_PACKAGE_INVALID", 409);
      return bytes;
    } finally { await handle.close(); }
  }

  private async verifyCache(directory: string, files: ResourceFileRef[]): Promise<void> {
    for (const file of files) await this.readCacheFile(directory, file);
  }

  async snapshot(jobId: string, uid: number, packageId: string, packageDigest: string, entryPath: string): Promise<string> {
    if (!identifier.test(jobId)) throw new WorkerError("WORKER_INVALID_REQUEST");
    this.get(packageId, packageDigest);
    const files = this.files(packageId);
    if (!files.some(file => file.relativePath === entryPath)) throw new WorkerError("WORKER_SKILL_ENTRY_NOT_FOUND", 404);
    const temporary = join(this.snapshotBase, `.prepare-${randomUUID()}`), destination = join(this.snapshotBase, jobId);
    const directories = new Set([temporary]);
    try {
      await mkdir(temporary, { mode: 0o700 });
      for (const file of files) {
        const bytes = await this.readCacheFile(join(this.cacheDirectory, packageDigest), file);
        const path = join(temporary, file.relativePath);
        let parent = temporary;
        for (const segment of file.relativePath.split("/").slice(0, -1)) {
          parent = join(parent, segment); directories.add(parent);
        }
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); }
        finally { await handle.close(); }
        await chown(path, this.owner, uid); await chmod(path, 0o440);
      }
      for (const path of [...directories].sort((a, b) => b.length - a.length)) {
        await chown(path, this.owner, uid); await chmod(path, 0o550);
      }
      await rename(temporary, destination);
      return join(destination, entryPath);
    } finally { await this.removeOwnedTree(temporary); }
  }

  async removeSnapshot(jobId: string): Promise<void> {
    if (!identifier.test(jobId)) throw new WorkerError("WORKER_INVALID_REQUEST");
    await this.removeOwnedTree(join(this.snapshotBase, jobId));
  }

  private async removeOwnedTree(path: string): Promise<void> {
    const writable = async (directory: string): Promise<void> => {
      let stat;
      try { stat = await lstat(directory); }
      catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return; throw error; }
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.owner) throw new WorkerError("WORKER_SKILL_SNAPSHOT_INVALID", 503);
      // CAP_DAC_OVERRIDE is deliberately absent. The owning supervisor restores
      // its own write permission only after job descendants have been stopped.
      await chmod(directory, 0o700);
      for (const name of await readdir(directory)) {
        const child = join(directory, name), entry = await lstat(child);
        if (entry.uid !== this.owner) throw new WorkerError("WORKER_SKILL_SNAPSHOT_INVALID", 503);
        if (entry.isDirectory() && !entry.isSymbolicLink()) await writable(child);
      }
    };
    await writable(path);
    await rm(path, { recursive: true, force: true });
  }
  async close(): Promise<void> {
    await Promise.allSettled([...this.installing.values()].map(entry => entry.promise));
    this.database?.close(); this.database = null;
  }
}
