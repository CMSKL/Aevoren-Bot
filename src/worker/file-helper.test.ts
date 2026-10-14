import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EnvironmentFileContent, EnvironmentFileWriteResult } from "@shared/environment-contracts";
import { fileOperation } from "./file-helper";

const roots: string[] = [];
function fixture() { const root = mkdtempSync(join(tmpdir(), "aevoren-worker-files-")); roots.push(root); const workspace = join(root, "workspace"); mkdirSync(workspace); return { root, workspace }; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("unprivileged Worker file operations", () => {
  it("writes a nested binary file, verifies its digest and requires a matching digest before replacement", async () => {
    const f = fixture(); const bytes = Buffer.from([0, 255, 128, 42]);
    const first = await fileOperation(f.workspace, { action: "write", path: "nested/data.bin", content: bytes.toString("base64"), encoding: "base64" }) as EnvironmentFileWriteResult;
    const read = await fileOperation(f.workspace, { action: "read", path: first.path }) as EnvironmentFileContent;
    expect(Buffer.from(read.content, "base64")).toEqual(bytes);
    expect(read.sha256).toBe(first.sha256);
    await expect(fileOperation(f.workspace, { action: "write", path: first.path, content: "different" })).rejects.toMatchObject({ code: "WORKER_FILE_CONFLICT" });
    await expect(fileOperation(f.workspace, { action: "write", path: first.path, content: "different", expectedSha256: "a".repeat(64) })).rejects.toMatchObject({ code: "WORKER_FILE_CONFLICT" });
    await fileOperation(f.workspace, { action: "write", path: first.path, content: "different", expectedSha256: first.sha256 });
    expect((await fileOperation(f.workspace, { action: "read", path: first.path }) as EnvironmentFileContent).content).toBe("different");
  });
  it.each(["../private", "/etc/passwd", "..\\private", "C:/private", "."])("rejects unsafe file path %s", async path => {
    const f = fixture(); await expect(fileOperation(f.workspace, { action: "read", path })).rejects.toMatchObject({ code: "WORKER_PATH_INVALID" });
  });
  it("bounds real file bytes and rejects malformed base64", async () => {
    const f = fixture(); writeFileSync(join(f.workspace, "large.bin"), Buffer.alloc(1_048_577));
    await expect(fileOperation(f.workspace, { action: "read", path: "large.bin" })).rejects.toMatchObject({ code: "WORKER_FILE_TOO_LARGE" });
    await expect(fileOperation(f.workspace, { action: "write", path: "bad.bin", content: "bad!", encoding: "base64" })).rejects.toMatchObject({ code: "WORKER_INVALID_REQUEST" });
  });
  it.skipIf(process.platform === "win32")("rejects direct and ancestor symlinks without reading external bytes", async () => {
    const f = fixture(); writeFileSync(join(f.root, "private"), "PRIVATE_FIXTURE");
    symlinkSync(join(f.root, "private"), join(f.workspace, "link.txt"));
    symlinkSync(f.root, join(f.workspace, "linked-directory"));
    await expect(fileOperation(f.workspace, { action: "read", path: "link.txt" })).rejects.toMatchObject({ code: "WORKER_PATH_INVALID" });
    await expect(fileOperation(f.workspace, { action: "read", path: "linked-directory/private" })).rejects.toMatchObject({ code: "WORKER_PATH_INVALID" });
    await expect(fileOperation(f.workspace, { action: "write", path: "linked-directory/other.txt", content: "must not write" })).rejects.toMatchObject({ code: "WORKER_PATH_INVALID" });
  });
});
