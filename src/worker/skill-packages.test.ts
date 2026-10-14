import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, chmod, symlink, unlink, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { skillPackageDescriptor, SKILL_PACKAGE_MAX_BYTES } from "@shared/skill-execution-contracts";
import { ENV_HTTP_BODY_MAX_BYTES } from "@shared/environment-contracts";
import { workerSkillInstallSchema } from "@shared/skill-execution-schemas";
import { SkillPackages } from "./skill-packages";
import { skillFixtureFile as file, skillFixturePackage as input, maximumSkillPackage } from "./skill-package-fixture";

const sha = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
describe("immutable Skill install wire bounds", () => {
  it("fits 251 real files totaling 4 MiB and maximum-width UTF-8 paths/MIME in the unchanged HTTP bound", () => {
    const value = maximumSkillPackage();
    expect(value.files.slice(1).every(file => file.relativePath.length === 500)).toBe(true);
    expect(value.files.reduce((size, file) => size + file.size, 0)).toBe(SKILL_PACKAGE_MAX_BYTES);
    expect(workerSkillInstallSchema.parse(value)).toEqual(value);
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(ENV_HTTP_BODY_MAX_BYTES);
  });
  it("rejects unstable UTF-8 paths before their JSON escape width can enlarge the body", () => {
    const value = input(); value.files[1]!.relativePath = `scripts/${"\ud800".repeat(490)}`;
    expect(workerSkillInstallSchema.safeParse(value).success).toBe(false);
  });
});

async function fixture(callback: (packages: SkillPackages, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "aevoren-skill-cache-"));
  const packages = new SkillPackages(root, join(root, "snapshots"));
  try { await packages.initialize(); await callback(packages, root); }
  finally { await packages.close(); await rm(root, { recursive: true, force: true }); }
}

// The production Worker uses Linux UID/GID/mode isolation. These filesystem
// checks run on POSIX hosts; actual job permissions are tested inside Docker.
describe.skipIf(process.platform === "win32")("Skill cache on real private files and SQLite", () => {
  it("retains exact binary bytes and package identity after reopening its real ledger", async () => fixture(async (packages, root) => {
    const request = input(), installed = await packages.install(request);
    expect(installed.packageDigest).toBe(sha(skillPackageDescriptor(request)));
    expect(await readFile(join(packages.cacheDirectory, installed.packageDigest, "assets/raw.bin"))).toEqual(Buffer.from([0, 255, 1, 128]));
    await packages.close();
    const reopened = new SkillPackages(root, join(root, "snapshots"));
    try { await reopened.initialize(); expect(reopened.get(request.id)).toEqual(installed); }
    finally { await reopened.close(); }
  }));
  it("joins concurrent identical installs and rejects changed intent for the same ID", async () => fixture(async packages => {
    const request = input(), results = await Promise.all([packages.install(request), packages.install({ ...request, files: [...request.files].reverse() })]);
    expect(results[1]).toEqual(results[0]);
    await expect(packages.install({ ...request, reference: { ...request.reference, revisionId: randomUUID() } })).rejects.toMatchObject({ code: "WORKER_IDEMPOTENCY_CONFLICT" });
    expect((await readdir(packages.cacheDirectory)).filter(name => /^[a-f0-9]{64}$/u.test(name))).toEqual([results[0]!.packageDigest]);
  }));
  it("rejects wrong byte size/SHA and file-directory collisions without publishing a package", async () => fixture(async packages => {
    for (const change of ["size", "sha", "tree"] as const) {
      const request = input();
      if (change === "size") request.files[1]!.size++;
      else if (change === "sha") request.files[1]!.sha256 = "0".repeat(64);
      else request.files.push(file("scripts", Buffer.from("conflicting parent file")));
      await expect(packages.install(request)).rejects.toMatchObject({ code: "WORKER_SKILL_PACKAGE_INVALID" });
      expect(() => packages.get(request.id)).toThrow("WORKER_SKILL_PACKAGE_NOT_FOUND");
    }
    expect((await readdir(packages.cacheDirectory)).filter(name => !name.startsWith("packages.sqlite"))).toEqual([]);
  }));
  it("does not publish a package ID when the actual SQLite commit fails", async () => fixture(async packages => {
    const request = input(), db = new DatabaseSync(join(packages.cacheDirectory, "packages.sqlite"));
    try { db.exec("CREATE TRIGGER reject_install BEFORE INSERT ON packages BEGIN SELECT RAISE(ABORT,'fixture commit failure'); END;"); }
    finally { db.close(); }
    await expect(packages.install(request)).rejects.toThrow("fixture commit failure");
    expect(() => packages.get(request.id)).toThrow("WORKER_SKILL_PACKAGE_NOT_FOUND");
    expect((await readdir(packages.cacheDirectory)).some(name => name.startsWith(".prepare-"))).toBe(false);
  }));
  it("creates read-only snapshots from verified cache bytes and removes them before reuse", async () => fixture(async packages => {
    const request = input(), installed = await packages.install(request), id = randomUUID();
    const entry = await packages.snapshot(id, process.getgid!(), request.id, installed.packageDigest, "scripts/main.js");
    expect((await lstat(entry)).mode & 0o777).toBe(0o440);
    expect((await lstat(dirname(entry))).mode & 0o777).toBe(0o550);
    expect(await readFile(join(packages.snapshotBase, id, "assets/raw.bin"))).toEqual(Buffer.from([0, 255, 1, 128]));
    await packages.removeSnapshot(id); expect(await readdir(packages.snapshotBase)).toEqual([]);
  }));
  it("refuses a cache symlink and does not copy the external target into a snapshot", async () => fixture(async (packages, root) => {
    const request = input(), installed = await packages.install(request), path = join(packages.cacheDirectory, installed.packageDigest, "scripts/main.js");
    const outside = join(root, "outside-secret"); await writeFile(outside, "owned negative-control secret");
    await unlink(path); await symlink(outside, path);
    await expect(packages.snapshot(randomUUID(), process.getgid!(), request.id, installed.packageDigest, "scripts/main.js")).rejects.toThrow();
    expect(await readdir(packages.snapshotBase)).toEqual([]);
  }));
  it("rejects a replaced private base before accepting work", async () => fixture(async (packages, root) => {
    await packages.close(); await chmod(packages.snapshotBase, 0o777);
    const reopened = new SkillPackages(root, packages.snapshotBase);
    try { await expect(reopened.initialize()).rejects.toMatchObject({ code: "WORKER_SKILL_PRIVATE_DIRECTORY_INVALID" }); }
    finally { await reopened.close(); }
  }));
});
