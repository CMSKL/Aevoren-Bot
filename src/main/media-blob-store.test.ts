import { mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MEDIA_PDF_MAX_BYTES } from "@shared/media-schemas";
import { MediaBlobStore, mediaBytesDigest, readMediaSource } from "./media-blob-store";
import { LibraryBlobStore, MAX_LIBRARY_TEXT_BYTES } from "./library-blob-store";

const directories: string[] = [];
function fixture() { const root = realpathSync(mkdtempSync(join(tmpdir(), "aevoren-media-blobs-"))); directories.push(root); return root; }
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
describe("owned media CAS", () => {
  it("stores bytes above the independent Skill ceiling and deduplicates without changing bytes", async () => {
    const root = fixture(), bytes = Buffer.alloc(MAX_LIBRARY_TEXT_BYTES + 1, 65), store = new MediaBlobStore(join(root, "media"));
    await expect(new LibraryBlobStore(join(root, "library")).put(bytes)).rejects.toMatchObject({ code: "LIBRARY_IMPORT_TOO_LARGE" });
    const sha = await store.put(bytes);
    expect(sha).toBe(mediaBytesDigest(bytes)); expect(await store.put(bytes)).toBe(sha);
    expect(await store.read(sha, bytes.length)).toEqual(bytes);
    expect(readdirSync(join(root, "media", sha.slice(0, 2)))).toEqual([sha]);
    await expect(store.put(Buffer.alloc(MEDIA_PDF_MAX_BYTES + 1))).rejects.toMatchObject({ code: "MEDIA_IMPORT_TOO_LARGE" });
  });
  it("rejects corrupt and replaced blob bytes instead of returning a matching path", async () => {
    const root = fixture(), store = new MediaBlobStore(join(root, "media")), original = Buffer.from("verified binary");
    const sha = await store.put(original); writeFileSync(join(root, "media", sha.slice(0, 2), sha), Buffer.alloc(original.length, 66));
    await expect(store.read(sha, original.length)).rejects.toMatchObject({ code: "MEDIA_CONTENT_INVALID" });
    await expect(store.read("../outside", 1)).rejects.toMatchObject({ code: "MEDIA_CONTENT_INVALID" });
  });
  it("rejects a changed file identity across the actual fd read and respects cancellation", async () => {
    const root = fixture(), path = join(root, "input.pdf"); writeFileSync(path, "%PDF-1.7\noriginal");
    let checks = 0;
    await expect(readMediaSource(path, () => { if (++checks === 3) writeFileSync(path, "%PDF-1.7\nmodified"); })).rejects.toMatchObject({ code: "MEDIA_CONTENT_INVALID" });
    const controller = new AbortController(); controller.abort();
    await expect(new MediaBlobStore(join(root, "media")).put(Buffer.from("no publication"), controller.signal)).rejects.toMatchObject({ code: "TOOL_EXECUTION_CANCELLED" });
  });
  it.skipIf(process.platform === "win32")("does not follow source or CAS symlinks", async () => {
    const root = fixture(), outside = join(root, "outside.pdf"), alias = join(root, "alias.pdf"); writeFileSync(outside, "%PDF-1.7\nprivate"); symlinkSync(outside, alias);
    await expect(readMediaSource(alias, () => {})).rejects.toMatchObject({ code: "MEDIA_CONTENT_INVALID" });
    const cas = join(root, "cas"); symlinkSync(root, cas);
    await expect(new MediaBlobStore(cas).put(Buffer.from("private"))).rejects.toMatchObject({ code: "MEDIA_CONTENT_INVALID" });
  });
});
