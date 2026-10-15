import { realpath } from "node:fs/promises";
import { linkSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MEDIA_PDF_MAX_BYTES } from "@shared/media-schemas";
import { MediaBlobStore, mediaBytesDigest, readMediaSource } from "./media-blob-store";
import { LibraryBlobStore, MAX_LIBRARY_TEXT_BYTES } from "./library-blob-store";

const directories: string[] = [];
async function fixture() { const root = await realpath(mkdtempSync(join(tmpdir(), "aevoren-media-blobs-"))); directories.push(root); return root; }
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
describe("owned media CAS", () => {
  it("stores bytes above the independent Skill ceiling and deduplicates without changing bytes", async () => {
    const root = await fixture(), bytes = Buffer.alloc(MAX_LIBRARY_TEXT_BYTES + 1, 65), store = new MediaBlobStore(join(root, "media"));
    await expect(new LibraryBlobStore(join(root, "library")).put(bytes)).rejects.toMatchObject({ code: "LIBRARY_IMPORT_TOO_LARGE" });
    const sha = await store.put(bytes);
    expect(sha).toBe(mediaBytesDigest(bytes)); expect(await store.put(bytes)).toBe(sha);
    expect(await store.read(sha, bytes.length)).toEqual(bytes);
    expect(readdirSync(join(root, "media", sha.slice(0, 2)))).toEqual([sha]);
    await expect(store.put(Buffer.alloc(MEDIA_PDF_MAX_BYTES + 1))).rejects.toMatchObject({ code: "MEDIA_IMPORT_TOO_LARGE" });
  });
  it("rejects corrupt and replaced blob bytes instead of returning a matching path", async () => {
    const root = await fixture(), store = new MediaBlobStore(join(root, "media")), original = Buffer.from("verified binary");
    const sha = await store.put(original); writeFileSync(join(root, "media", sha.slice(0, 2), sha), Buffer.alloc(original.length, 66));
    await expect(store.read(sha, original.length)).rejects.toMatchObject({ code: "MEDIA_CONTENT_INVALID" });
    await expect(store.read("../outside", 1)).rejects.toMatchObject({ code: "MEDIA_CONTENT_INVALID" });
  });
  it("rejects a changed file identity across the actual fd read and respects cancellation", async () => {
    const root = await fixture(), path = join(root, "input.pdf"); writeFileSync(path, "%PDF-1.7\noriginal");
    let checks = 0;
    await expect(readMediaSource(path, () => { if (++checks === 3) writeFileSync(path, "%PDF-1.7\nmodified"); })).rejects.toMatchObject({ code: "MEDIA_CONTENT_INVALID" });
    const controller = new AbortController(); controller.abort();
    await expect(new MediaBlobStore(join(root, "media")).put(Buffer.from("no publication"), controller.signal)).rejects.toMatchObject({ code: "TOOL_EXECUTION_CANCELLED" });
  });
  it("accepts CAS staging hardlink cleanup during an open fd read only with the known content digest", async () => {
    const root = await fixture(), store = new MediaBlobStore(join(root, "media")), bytes = Buffer.from("same verified content");
    const sha = await store.put(bytes), path = join(await realpath(join(root, "media", sha.slice(0, 2))), sha), temporary = join(root, "staging-link");
    linkSync(path, temporary); const before = statSync(path, { bigint: true }); let checks = 0, changed = false;
    const read = await readMediaSource(path, () => {
      if (++checks === 3) { unlinkSync(temporary); changed = statSync(path, { bigint: true }).ctimeNs !== before.ctimeNs; }
    }, sha);
    expect(changed).toBe(true); expect(read).toEqual(bytes); expect(statSync(path).nlink).toBe(1);
  });
  it("keeps ctime validation for raw sources and rejects final digest tampering inside the CAS reader", async () => {
    const root = await fixture(), path = join(root, "source.pdf"), temporary = join(root, "source-link"); writeFileSync(path, "%PDF-1.7 original"); linkSync(path, temporary);
    let checks = 0;
    await expect(readMediaSource(path, () => { if (++checks === 3) unlinkSync(temporary); })).rejects.toMatchObject({ code: "MEDIA_CONTENT_INVALID" });
    const expected = mediaBytesDigest(Buffer.from("original")); writeFileSync(path, "tampered");
    await expect(readMediaSource(path, () => {}, expected)).rejects.toMatchObject({ code: "MEDIA_CONTENT_INVALID" });
  });
  it("publishes equal blobs concurrently without rejecting a sibling's valid content", async () => {
    const root = await fixture(), store = new MediaBlobStore(join(root, "media")), bytes = Buffer.alloc(1_048_576, 87);
    const values = await Promise.all(Array.from({ length: 6 }, () => store.put(bytes)));
    expect(new Set(values)).toEqual(new Set([mediaBytesDigest(bytes)])); expect(await store.read(values[0]!, bytes.length)).toEqual(bytes);
  });
  it.skipIf(process.platform === "win32")("does not follow source or CAS symlinks", async () => {
    const root = await fixture(), outside = join(root, "outside.pdf"), alias = join(root, "alias.pdf"); writeFileSync(outside, "%PDF-1.7\nprivate"); symlinkSync(outside, alias);
    await expect(readMediaSource(alias, () => {})).rejects.toMatchObject({ code: "MEDIA_CONTENT_INVALID" });
    const cas = join(root, "cas"); symlinkSync(root, cas);
    await expect(new MediaBlobStore(cas).put(Buffer.from("private"))).rejects.toMatchObject({ code: "MEDIA_CONTENT_INVALID" });
  });
});
