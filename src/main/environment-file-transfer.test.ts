import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_FILE_MAX_BYTES } from "@shared/environment-contracts";
import { readEnvironmentUpload, writeEnvironmentDownload } from "./environment-file-transfer";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aevoren-env-transfer-")); roots.push(root); return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("native environment transfers", () => {
  it("preserves binary bytes and refuses an existing download target", async () => {
    const root = await fixture(), path = join(root, "bytes.bin"), bytes = Buffer.from([0, 255, 137, 80]);
    await writeFile(path, bytes);
    expect(await readEnvironmentUpload(path)).toEqual(bytes);
    await expect(writeEnvironmentDownload(path, Buffer.from("replace"), () => undefined)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(path)).toEqual(bytes);
    expect(await readdir(root)).toEqual(["bytes.bin"]);
  });
  it("rejects oversized files and symlinks without publishing output", async () => {
    const root = await fixture(), path = join(root, "large.bin");
    await writeFile(path, Buffer.alloc(ENV_FILE_MAX_BYTES + 1));
    await expect(readEnvironmentUpload(path)).rejects.toMatchObject({ code: "ENVIRONMENT_FILE_INVALID" });
    if (process.platform !== "win32") {
      const alias = join(root, "alias"); await symlink(path, alias);
      await expect(readEnvironmentUpload(alias)).rejects.toMatchObject({ code: "ENVIRONMENT_FILE_INVALID" });
    }
  });
  it("cancellation after staging leaves neither output nor staging data", async () => {
    const root = await fixture(), controller = new AbortController(); let checks = 0;
    await expect(writeEnvironmentDownload(join(root, "cancelled.bin"), Buffer.from("bytes"), () => {
      if (++checks === 2) controller.abort();
    }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(await readdir(root)).toEqual([]);
  });
  it("revocation after publish removes its own output", async () => {
    const root = await fixture(); let checks = 0;
    await expect(writeEnvironmentDownload(join(root, "revoked.bin"), Buffer.from("bytes"), () => {
      if (++checks === 3) throw new Error("scope revoked");
    })).rejects.toThrow("scope revoked");
    expect(await readdir(root)).toEqual([]);
  });
  it("cleanup never removes a replacement written by another owner", async () => {
    const root = await fixture(), path = join(root, "output.bin"); let checks = 0;
    // Replacement happens at the post-publish authorization boundary, before rollback.
    await expect(writeEnvironmentDownload(path, Buffer.from("owned"), () => {
      if (++checks === 3) {
        unlinkSync(path); writeFileSync(path, "other owner");
        throw new Error("scope revoked");
      }
    })).rejects.toThrow("scope revoked");
    expect(await readFile(path, "utf8")).toBe("other owner");
    expect(await readdir(root)).toEqual(["output.bin"]);
  });
});
